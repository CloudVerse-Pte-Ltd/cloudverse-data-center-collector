import type { GpuConnectorResult, GpuTelemetryFact, GpuValidationFinding } from '../../interfaces/index.js';
import {
  type PrometheusDcgmCollectionContext,
  type PrometheusDcgmCollectionRequest,
  type PrometheusDcgmConnectorConfig,
  validatePrometheusDcgmConfig,
} from './config.js';
import {
  type DcgmQueryDefinition,
  getDefaultDcgmQueryDefinitions,
} from './dcgm-query-definitions.js';
import { PrometheusDcgmConnectorError, toConnectorError } from './errors.js';
import { createPrometheusDcgmClient, type PrometheusDcgmClient } from './prometheus-client.js';
import { normalizePrometheusDcgmResponse } from './prometheus-response-normalizer.js';

export interface CollectPrometheusDcgmTelemetryOptions {
  config: PrometheusDcgmConnectorConfig;
  context: PrometheusDcgmCollectionContext;
  request: PrometheusDcgmCollectionRequest;
  queryDefinitions?: DcgmQueryDefinition[];
  client?: PrometheusDcgmClient;
}

export interface PrometheusDcgmTelemetryCollectionResult extends GpuConnectorResult<GpuTelemetryFact> {
  findings: GpuValidationFinding[];
}

function toConnectorContext(context: PrometheusDcgmCollectionContext, request: PrometheusDcgmCollectionRequest) {
  const collectionWindow =
    request.mode === 'range'
      ? { start: request.start, end: request.end }
      : { start: request.time ?? context.collectedAt, end: request.time ?? context.collectedAt };

  return {
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    connectorId: context.connectorId,
    connectorVersion: context.connectorVersion,
    sourceSystem: 'dcgm' as const,
    clusterId: context.clusterId,
    collectionWindow,
  };
}

function filterDefinitions(
  definitions: DcgmQueryDefinition[],
  queryNames?: string[],
): DcgmQueryDefinition[] {
  if (!queryNames?.length) {
    return definitions;
  }
  const selected = new Set(queryNames);
  return definitions.filter((definition) => selected.has(definition.name));
}

export function createConnectorErrorFromFinding(finding: GpuValidationFinding) {
  return {
    code: finding.code,
    message: finding.message,
    retryable: false,
    sourceSystem: 'dcgm' as const,
    details: finding.metadata,
  };
}

export async function collectPrometheusDcgmTelemetry(
  options: CollectPrometheusDcgmTelemetryOptions,
): Promise<PrometheusDcgmTelemetryCollectionResult> {
  const validation = validatePrometheusDcgmConfig(options.config);
  if (!validation.valid) {
    return {
      connectorId: options.context.connectorId,
      sourceSystem: 'dcgm',
      collectedAt: options.context.collectedAt,
      facts: [],
      errors: validation.findings.filter((finding) => finding.severity === 'ERROR').map(createConnectorErrorFromFinding),
      findings: validation.findings,
      health: {
        healthy: false,
        stale: false,
        checkedAt: options.context.collectedAt,
        message: 'Prometheus/DCGM connector config is invalid.',
      },
    };
  }

  const client = options.client ?? createPrometheusDcgmClient(options.config);
  const definitions = filterDefinitions(options.queryDefinitions ?? getDefaultDcgmQueryDefinitions(), options.request.queryNames);
  const facts: GpuTelemetryFact[] = [];
  const findings: GpuValidationFinding[] = validation.findings;
  const errors: PrometheusDcgmTelemetryCollectionResult['errors'] = [];
  const context = toConnectorContext(options.context, options.request);

  for (const definition of definitions) {
    try {
      const response =
        options.request.mode === 'range'
          ? await client.queryRange({
              query: definition.promql,
              start: options.request.start,
              end: options.request.end,
              step: options.request.step,
            })
          : await client.query({
              query: definition.promql,
              time: options.request.time,
            });

      const normalized = normalizePrometheusDcgmResponse({
        response,
        queryDefinition: definition,
        query: definition.promql,
        baseUrl: options.config.baseUrl,
        context,
        collectedAt: options.context.collectedAt,
        staleAfterSeconds: options.config.staleAfterSeconds,
      });

      facts.push(...normalized.facts);
      findings.push(...normalized.findings);
    } catch (error) {
      const connectorError = toConnectorError(error);
      errors.push(connectorError);
      findings.push({
        code: connectorError.code,
        severity: 'ERROR',
        message: connectorError.message,
        source: definition.name,
        metadata: connectorError.details,
      });
      if (definition.required && error instanceof PrometheusDcgmConnectorError && !error.retryable) {
        continue;
      }
    }
  }

  return {
    connectorId: options.context.connectorId,
    sourceSystem: 'dcgm',
    collectedAt: options.context.collectedAt,
    facts,
    errors,
    findings,
    health: {
      healthy: errors.length === 0,
      stale: facts.some((fact) => fact.stale),
      checkedAt: options.context.collectedAt,
      message: errors.length ? 'One or more Prometheus/DCGM queries failed.' : undefined,
    },
  };
}

export * from './config.js';
export * from './dcgm-query-definitions.js';
export * from './errors.js';
export * from './prometheus-client.js';
export * from './prometheus-response-normalizer.js';
