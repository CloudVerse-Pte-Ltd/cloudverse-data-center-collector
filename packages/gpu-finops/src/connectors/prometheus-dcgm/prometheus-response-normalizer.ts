import { createHash } from 'node:crypto';
import type { GpuConnectorContext, GpuTelemetryFact, GpuValidationFinding, GpuWorkloadRef } from '../../interfaces/index.js';
import { createGpuProvenance } from '../../provenance/index.js';
import { sanitizedPrometheusBaseUrlHost } from './config.js';
import type { DcgmQueryDefinition } from './dcgm-query-definitions.js';
import type { PrometheusApiResponse, PrometheusApiSample } from './prometheus-client.js';

export interface PrometheusDcgmNormalizationInput {
  response: PrometheusApiResponse;
  queryDefinition: DcgmQueryDefinition;
  query: string;
  baseUrl: string;
  context: GpuConnectorContext;
  collectedAt: string;
  staleAfterSeconds?: number;
  responseStatus?: number;
}

export interface PrometheusDcgmNormalizationResult {
  facts: GpuTelemetryFact[];
  findings: GpuValidationFinding[];
}

function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

function firstLabel(metric: Record<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    const value = metric[label];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function metricName(metric: Record<string, string>, fallback: string): string {
  return metric.__name__ ?? metric.metric ?? fallback;
}

function labelWorkloadRef(
  metric: Record<string, string>,
  context: GpuConnectorContext,
  nodeName?: string,
): GpuWorkloadRef | undefined {
  const namespace = firstLabel(metric, ['namespace', 'exported_namespace']);
  const pod = firstLabel(metric, ['pod', 'pod_name', 'exported_pod']);
  const container = firstLabel(metric, ['container', 'container_name']);
  if (!namespace || !pod) {
    return undefined;
  }

  return {
    workloadRefId: `${context.clusterId ?? 'cluster'}:pod:${namespace}:${pod}:${container ?? 'unknown'}`,
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    sourceSystem: 'kubernetes',
    connectorId: 'prometheus-dcgm-labels',
    kind: 'kubernetes_pod',
    naturalKey: `${context.clusterId ?? 'cluster'}:${namespace}:${pod}:${container ?? 'unknown'}`,
    name: pod,
    namespace,
    container,
    nodeName,
    provenance: createGpuProvenance(context, {
      externalId: `${namespace}/${pod}/${container ?? 'unknown'}`,
      objectKind: 'prometheus_label_workload_ref',
      objectName: pod,
      namespace,
    }),
    confidence: { level: 'HIGH', score: 0.9, reasons: ['dcgm_pod_labels_present'] },
  };
}

function finding(code: string, message: string, source: string, severity: GpuValidationFinding['severity'] = 'WARNING'): GpuValidationFinding {
  return { code, severity, message, source };
}

function samplePairs(sample: PrometheusApiSample): Array<[number, number]> {
  const rawSamples = sample.values ?? (sample.value ? [sample.value] : []);
  return rawSamples
    .map(([timestamp, value]) => [timestamp, Number(value)] as [number, number])
    .filter(([, value]) => Number.isFinite(value));
}

function aggregateValues(values: number[]): {
  avg: number;
  min: number;
  max: number;
  latest: number;
  sampleCount: number;
} {
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    latest: values[values.length - 1],
    sampleCount: values.length,
  };
}

function applyMetricValue(fact: GpuTelemetryFact, queryDefinition: DcgmQueryDefinition, avg: number, max: number, latest: number): void {
  fact.metricValueAvg = avg;
  fact.metricValueMax = max;
  fact.metricValueLatest = latest;

  switch (queryDefinition.valueKind) {
    case 'gpu_utilization_pct':
      fact.gpuUtilizationPctAvg = avg;
      fact.gpuUtilizationPctMax = max;
      break;
    case 'memory_copy_utilization_pct':
      fact.memoryUtilizationPctAvg = avg;
      fact.memoryUtilizationPctMax = max;
      break;
    case 'framebuffer_used_mib':
      fact.framebufferUsedMibAvg = avg;
      fact.framebufferUsedMibMax = max;
      break;
    case 'power_usage_watts':
      fact.powerWattsAvg = latest;
      break;
    case 'temperature_celsius':
      fact.temperatureCelsiusMax = max;
      break;
    case 'xid_errors':
      fact.xidErrorCount = latest;
      break;
    case 'ecc_errors':
      fact.eccErrorCount = latest;
      break;
    case 'nvlink_bandwidth':
      fact.nvlinkBytes = latest;
      break;
    default:
      break;
  }
}

export function normalizePrometheusDcgmResponse(input: PrometheusDcgmNormalizationInput): PrometheusDcgmNormalizationResult {
  const findings: GpuValidationFinding[] = [];
  const facts: GpuTelemetryFact[] = [];
  const response = input.response;

  if (response.status !== 'success' || !response.data) {
    return {
      facts,
      findings: [
        finding(
          'prometheus_query_failed',
          response.error ?? `Prometheus query ${input.queryDefinition.name} did not return success.`,
          input.queryDefinition.name,
          'ERROR',
        ),
      ],
    };
  }

  if (response.data.resultType !== 'vector' && response.data.resultType !== 'matrix') {
    return {
      facts,
      findings: [
        finding(
          'unsupported_result_type',
          `Unsupported Prometheus result type ${response.data.resultType}.`,
          input.queryDefinition.name,
          'ERROR',
        ),
      ],
    };
  }

  if (response.warnings?.length) {
    findings.push(finding('prometheus_partial_response', response.warnings.join('; '), input.queryDefinition.name));
  }

  if (response.data.result.length === 0 && !input.queryDefinition.required) {
    findings.push(finding('dcgm_metric_missing', `Optional DCGM metric ${input.queryDefinition.metricName} returned no samples.`, input.queryDefinition.name, 'INFO'));
    return { facts, findings };
  }

  const nowMs = new Date(input.collectedAt).getTime();
  const staleAfterSeconds = input.staleAfterSeconds ?? 900;
  const queryHash = hashQuery(input.query);
  const sourceHost = sanitizedPrometheusBaseUrlHost(input.baseUrl);

  for (const sample of response.data.result) {
    const pairs = samplePairs(sample);
    if (pairs.length === 0) {
      findings.push(finding('invalid_metric_value', `Metric ${input.queryDefinition.metricName} has no valid numeric samples.`, input.queryDefinition.name));
      continue;
    }

    const values = pairs.map(([, value]) => value);
    const timestamps = pairs.map(([timestamp]) => timestamp);
    const aggregation = aggregateValues(values);
    const firstTimestamp = Math.min(...timestamps);
    const latestTimestamp = timestamps[timestamps.length - 1];
    const sampleStart = new Date(firstTimestamp * 1000).toISOString();
    const sampleEnd = new Date(latestTimestamp * 1000).toISOString();
    const stale = nowMs - latestTimestamp * 1000 > staleAfterSeconds * 1000;
    const metric = sample.metric;
    const name = metricName(metric, input.queryDefinition.metricName);
    const nodeName = firstLabel(metric, ['node', 'hostname', 'Hostname', 'instance']);
    const gpuUuid = firstLabel(metric, ['gpu_uuid', 'UUID', 'uuid']);
    const gpuIndex = firstLabel(metric, ['gpu_index', 'gpu', 'GPU', 'device', 'minor_number']);
    const gpuModel = firstLabel(metric, ['modelName', 'gpu_name', 'model', 'name']);
    const partitioned = Boolean(metric.GPU_I_ID || metric.gpu_instance_id || metric.mig_profile || metric.GPU_I_PROFILE);
    const migProfile = firstLabel(metric, ['GPU_I_PROFILE', 'gpu_i_profile', 'mig_profile', 'profile']);
    const factFindings: GpuValidationFinding[] = [];

    if (!gpuUuid) {
      factFindings.push(finding('missing_gpu_uuid', 'GPU UUID label is missing; using lower-confidence GPU index/device matching.', input.queryDefinition.name));
    }
    if (!nodeName) {
      factFindings.push(finding('missing_node_label', 'Node/hostname/instance label is missing.', input.queryDefinition.name));
    }
    if (!metric.pod && !metric.pod_name && !metric.exported_pod) {
      factFindings.push(finding('missing_pod_label', 'Pod label is missing; telemetry fact is device/node-level only.', input.queryDefinition.name, 'INFO'));
    }
    if (stale) {
      factFindings.push(finding('stale_telemetry', 'Latest telemetry sample is stale.', input.queryDefinition.name));
    }

    const allFindings = [...factFindings];
    findings.push(...factFindings);

    const fact: GpuTelemetryFact = {
      gpuTelemetryFactId: `${input.context.clusterId ?? 'cluster'}:prometheus-dcgm:${input.queryDefinition.name}:${nodeName ?? 'unknown'}:${gpuUuid ?? gpuIndex ?? 'unknown'}:${latestTimestamp}`,
      tenantId: input.context.tenantId,
      orgId: input.context.orgId,
      deploymentMode: input.context.deploymentMode,
      provider: input.context.provider,
      sourceSystem: input.context.sourceSystem,
      connectorId: input.context.connectorId,
      gpuClusterId: input.context.clusterId,
      gpuNodeId: nodeName && input.context.clusterId ? `${input.context.clusterId}:node:${nodeName}` : undefined,
      gpuDeviceId:
        nodeName && input.context.clusterId ? `${input.context.clusterId}:node:${nodeName}:gpu:${gpuUuid ?? gpuIndex ?? 'unknown'}` : undefined,
      workloadRef: labelWorkloadRef(metric, input.context, nodeName),
      timeWindow: { start: sampleStart, end: sampleEnd },
      metricName: name,
      metricLabels: { ...metric, ...(gpuModel ? { normalized_gpu_model: gpuModel } : {}) },
      stale,
      partitioned,
      migProfile,
      sampleCount: aggregation.sampleCount,
      metricValueMin: aggregation.min,
      findings: allFindings,
      provenance: createGpuProvenance(
        input.context,
        {
          externalId: `${input.queryDefinition.name}:${nodeName ?? 'unknown'}:${gpuUuid ?? gpuIndex ?? 'unknown'}:${latestTimestamp}`,
          objectKind: 'prometheus_metric_sample',
          objectName: input.queryDefinition.name,
          queryId: input.queryDefinition.name,
          queryHash,
          query: input.query,
          clusterName: input.context.clusterId,
          metadata: {
            sourceHost,
            responseStatus: input.responseStatus ?? 200,
            warnings: response.warnings,
          },
        },
        {
          sourceHost,
          queryName: input.queryDefinition.name,
          queryHash,
          responseStatus: input.responseStatus ?? 200,
          warnings: response.warnings,
        },
      ),
      confidence: {
        level: stale ? 'UNKNOWN' : gpuUuid ? 'HIGH' : 'MEDIUM',
        score: stale ? 0.1 : gpuUuid ? 0.9 : 0.65,
        reasons: stale ? ['stale_telemetry'] : gpuUuid ? ['gpu_uuid_present'] : ['gpu_index_fallback'],
      },
    };

    applyMetricValue(fact, input.queryDefinition, aggregation.avg, aggregation.max, aggregation.latest);
    facts.push(fact);
  }

  return { facts, findings };
}
