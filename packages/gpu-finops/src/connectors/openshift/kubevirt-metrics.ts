import type { PrometheusDcgmConnectorConfig } from '../prometheus-dcgm/config.js';

type JsonMap = Record<string, unknown>;
const map = (value: unknown): JsonMap => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};

export const KUBEVIRT_METRIC_REGISTRY = Object.freeze({
  kubevirt_vmi_cpu_usage_seconds_total: { semanticMetric: 'guest.cpu.usage.seconds', unit: 'seconds', aggregation: 'COUNTER' },
  kubevirt_vmi_vcpu_wait_seconds_total: { semanticMetric: 'guest.cpu.contention.seconds', unit: 'seconds', aggregation: 'COUNTER' },
  kubevirt_vmi_memory_used_bytes: { semanticMetric: 'guest.memory.used.bytes', unit: 'bytes', aggregation: 'GAUGE' },
  kubevirt_vmi_memory_available_bytes: { semanticMetric: 'guest.memory.available.bytes', unit: 'bytes', aggregation: 'GAUGE' },
} as const);

export interface KubeVirtMetricIdentity { namespace: string; name: string; vmiUid: string; vmUid?: string }
export interface KubeVirtMetricFact { vmiUid: string; vmUid?: string; namespace: string; name: string; nativeMetric: keyof typeof KUBEVIRT_METRIC_REGISTRY; semanticMetric: string; observedAt: string; value: number; unit: string; aggregation: string; labels: Record<string, string> }
export interface KubeVirtMetricGap { code: string; nativeMetric?: string; namespace?: string; name?: string; details?: Record<string, unknown> }
export interface KubeVirtTelemetryEnvelope {
  type: 'DATA_CENTER_METRICS'; integrationId: number; managementPlaneUid: string; collectedAt: string; platform: 'OPENSHIFT_VIRTUALIZATION'; metricSet: 'openshift.kubevirt.vm.performance';
  metrics: Array<{ assetKind: 'VIRTUAL_MACHINE'; sourceUid: string; semanticMetric: string; nativeMetric: string; observedAt: string; intervalSeconds: number; value: string; unit: string; aggregation: string; retentionClass: 'TELEMETRY'; retentionDays: 90; provenance: Record<string, unknown> }>;
  gaps: Array<{ semanticMetric: string; expectedStart: string; expectedEnd: string; reasonClass: string; retryable: boolean; state: 'OPEN'; evidence: Record<string, unknown> }>;
}

function url(baseUrl: string, path: string, query?: Record<string, string>) {
  const value = new URL(baseUrl); value.pathname = `${value.pathname.replace(/\/$/, '')}${path}`; value.search = ''; value.username = ''; value.password = '';
  for (const [key, item] of Object.entries(query ?? {})) value.searchParams.set(key, item);
  return value;
}
function headers(config: PrometheusDcgmConnectorConfig) {
  const authorization = config.auth?.bearerToken ? `Bearer ${config.auth.bearerToken}` : config.auth?.basic ? `Basic ${Buffer.from(`${config.auth.basic.username}:${config.auth.basic.password}`).toString('base64')}` : undefined;
  return new Headers({ Accept: 'application/json', ...(config.headers ?? {}), ...(authorization ? { Authorization: authorization } : {}) });
}

async function request(config: PrometheusDcgmConnectorConfig, fetchImpl: typeof fetch, path: string, query?: Record<string, string>) {
  const response = await fetchImpl(url(config.baseUrl, path, query), { method: 'GET', headers: headers(config) });
  if (!response.ok) throw Object.assign(new Error(`Prometheus API returned HTTP ${response.status}`), { status: response.status });
  const body = map(await response.json());
  if (body.status === 'error') throw new Error(String(body.error ?? 'Prometheus API error'));
  return body;
}

export async function discoverKubeVirtMetrics(config: PrometheusDcgmConnectorConfig, fetchImpl: typeof fetch = globalThis.fetch) {
  const [build, runtime, thanos, kubevirt] = await Promise.allSettled([
    request(config, fetchImpl, '/api/v1/status/buildinfo'), request(config, fetchImpl, '/api/v1/status/runtimeinfo'),
    request(config, fetchImpl, '/api/v1/query', { query: 'thanos_build_info' }), request(config, fetchImpl, '/api/v1/query', { query: 'count(kubevirt_vmi_phase_count)' }),
  ]);
  const buildData = build.status === 'fulfilled' ? map(build.value.data) : {};
  const runtimeData = runtime.status === 'fulfilled' ? map(runtime.value.data) : {};
  const thanosResult = thanos.status === 'fulfilled' ? map(thanos.value.data).result : undefined;
  const kubevirtResult = kubevirt.status === 'fulfilled' ? map(kubevirt.value.data).result : undefined;
  const backend = Array.isArray(thanosResult) && thanosResult.length ? 'THANOS' : build.status === 'fulfilled' ? 'PROMETHEUS' : 'UNKNOWN';
  const retention = typeof runtimeData.storageRetention === 'string' && runtimeData.storageRetention.trim() ? runtimeData.storageRetention.trim() : undefined;
  return {
    backend, version: typeof buildData.version === 'string' ? buildData.version : undefined,
    kubeVirtMetricsPresent: kubevirt.status === 'fulfilled' && Array.isArray(kubevirtResult),
    retention, retentionStatus: retention ? 'READY' as const : 'BLOCKED' as const,
    diagnostics: { buildStatus: build.status, runtimeStatus: runtime.status, thanosStatus: thanos.status, kubevirtStatus: kubevirt.status },
  };
}

export async function collectKubeVirtMetrics(input: {
  config: PrometheusDcgmConnectorConfig; identities: KubeVirtMetricIdentity[]; start: string; end: string; step: string; fetchImpl?: typeof fetch
}) {
  if (!Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end)) || new Date(input.end) <= new Date(input.start)) throw new Error('KubeVirt metric window is invalid');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch; const facts: KubeVirtMetricFact[] = []; const gaps: KubeVirtMetricGap[] = [];
  const identities = new Map<string, KubeVirtMetricIdentity[]>();
  for (const identity of input.identities) { const key = `${identity.namespace}/${identity.name}`; identities.set(key, [...(identities.get(key) ?? []), identity]); }
  for (const [nativeMetric, registry] of Object.entries(KUBEVIRT_METRIC_REGISTRY) as Array<[keyof typeof KUBEVIRT_METRIC_REGISTRY, (typeof KUBEVIRT_METRIC_REGISTRY)[keyof typeof KUBEVIRT_METRIC_REGISTRY]]>) {
    try {
      const body = await request(input.config, fetchImpl, '/api/v1/query_range', { query: nativeMetric, start: input.start, end: input.end, step: input.step });
      const result = map(body.data).result;
      if (!Array.isArray(result)) throw new Error('Prometheus matrix result is invalid');
      for (const seriesValue of result) {
        const series = map(seriesValue); const labels = map(series.metric) as Record<string, string>;
        const namespace = String(labels.namespace ?? labels.exported_namespace ?? ''); const name = String(labels.name ?? labels.vmi ?? labels.domain ?? '');
        const matches = identities.get(`${namespace}/${name}`) ?? [];
        if (matches.length !== 1 || !matches[0]?.vmUid) { gaps.push({ code: matches.length > 1 ? 'AMBIGUOUS_VMI_UID_MAPPING' : matches.length === 0 ? 'VMI_UID_MAPPING_MISSING' : 'VM_OWNER_UID_MISSING', nativeMetric, namespace, name, details: { matchCount: matches.length } }); continue; }
        for (const pair of Array.isArray(series.values) ? series.values : []) {
          if (!Array.isArray(pair) || pair.length !== 2) continue; const timestamp = Number(pair[0]); const value = Number(pair[1]);
          if (!Number.isFinite(timestamp) || !Number.isFinite(value)) { gaps.push({ code: 'INVALID_METRIC_SAMPLE', nativeMetric, namespace, name }); continue; }
          facts.push({ vmiUid: matches[0].vmiUid, vmUid: matches[0].vmUid, namespace, name, nativeMetric, semanticMetric: registry.semanticMetric, observedAt: new Date(timestamp * 1000).toISOString(), value, unit: registry.unit, aggregation: registry.aggregation, labels });
        }
      }
    } catch (error) { gaps.push({ code: 'METRIC_QUERY_FAILED', nativeMetric, details: { message: error instanceof Error ? error.message : String(error) } }); }
  }
  return { facts, gaps, coverage: { requestedStart: input.start, requestedEnd: input.end, metricCount: Object.keys(KUBEVIRT_METRIC_REGISTRY).length } };
}

export function toKubeVirtTelemetryEnvelope(input: { integrationId: number; managementPlaneUid: string; collectedAt: string; intervalSeconds: number; expectedStart: string; expectedEnd: string; facts: KubeVirtMetricFact[]; gaps: KubeVirtMetricGap[] }): KubeVirtTelemetryEnvelope {
  if (!Number.isSafeInteger(input.integrationId) || input.integrationId <= 0 || !input.managementPlaneUid.startsWith('openshift:') || !Number.isFinite(Date.parse(input.collectedAt)) || !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds <= 0 || !Number.isFinite(Date.parse(input.expectedStart)) || !Number.isFinite(Date.parse(input.expectedEnd)) || new Date(input.expectedEnd) <= new Date(input.expectedStart)) throw new Error('KubeVirt telemetry envelope scope or window is invalid');
  return {
    type: 'DATA_CENTER_METRICS', integrationId: input.integrationId, managementPlaneUid: input.managementPlaneUid, collectedAt: new Date(input.collectedAt).toISOString(), platform: 'OPENSHIFT_VIRTUALIZATION', metricSet: 'openshift.kubevirt.vm.performance',
    metrics: input.facts.map((fact) => {
      if (!fact.vmUid) throw new Error('KubeVirt metric fact lacks owning VM immutable UID');
      return { assetKind: 'VIRTUAL_MACHINE', sourceUid: fact.vmUid, semanticMetric: fact.semanticMetric, nativeMetric: fact.nativeMetric, observedAt: fact.observedAt, intervalSeconds: input.intervalSeconds, value: String(fact.value), unit: fact.unit, aggregation: fact.aggregation, retentionClass: 'TELEMETRY', retentionDays: 90, provenance: { vmiUid: fact.vmiUid, namespace: fact.namespace, name: fact.name, labels: fact.labels } };
    }),
    gaps: input.gaps.map((gap) => ({ semanticMetric: gap.nativeMetric && gap.nativeMetric in KUBEVIRT_METRIC_REGISTRY ? KUBEVIRT_METRIC_REGISTRY[gap.nativeMetric as keyof typeof KUBEVIRT_METRIC_REGISTRY].semanticMetric : 'openshift.kubevirt.vm.performance', expectedStart: new Date(input.expectedStart).toISOString(), expectedEnd: new Date(input.expectedEnd).toISOString(), reasonClass: gap.code, retryable: gap.code === 'METRIC_QUERY_FAILED', state: 'OPEN', evidence: { nativeMetric: gap.nativeMetric, namespace: gap.namespace, name: gap.name, ...gap.details } })),
  };
}
