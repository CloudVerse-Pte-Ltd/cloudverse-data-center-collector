import type { GpuConnectorResult, GpuInventorySnapshot, GpuSourceCostFact, GpuValidationFinding } from '../../interfaces/index.js';
import {
  type VCenterCollectionContext,
  type VCenterConnectorConfig,
  validateVCenterConnectorConfig,
} from './config.js';
import { createVCenterClient, type VCenterClient } from './vcenter-client.js';
import { normalizeVCenterInventoryResponse } from './vcenter-response-normalizer.js';
import { toVCenterConnectorError } from './errors.js';

export interface CollectVCenterInventoryEvidenceOptions {
  config: VCenterConnectorConfig;
  context: VCenterCollectionContext;
  client?: VCenterClient;
  response?: unknown;
}

export interface VCenterInventoryEvidenceCollectionResult extends GpuConnectorResult<GpuInventorySnapshot | GpuSourceCostFact> {
  inventory?: GpuInventorySnapshot;
  sourceCostFacts: GpuSourceCostFact[];
  findings: GpuValidationFinding[];
}

function toConnectorContext(context: VCenterCollectionContext) {
  return {
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    connectorId: context.connectorId,
    connectorVersion: context.connectorVersion,
    sourceSystem: 'vcenter' as const,
    clusterId: context.clusterId,
    collectionWindow: {
      start: context.collectedAt,
      end: context.collectedAt,
    },
  };
}

function validationError(finding: { code: string; message: string }) {
  return {
    code: finding.code,
    message: finding.message,
    retryable: false,
    sourceSystem: 'vcenter' as const,
  };
}

export async function collectVCenterInventoryEvidence(
  options: CollectVCenterInventoryEvidenceOptions,
): Promise<VCenterInventoryEvidenceCollectionResult> {
  const validation = validateVCenterConnectorConfig(options.config);
  if (!validation.valid) {
    return {
      connectorId: options.context.connectorId,
      sourceSystem: 'vcenter',
      collectedAt: options.context.collectedAt,
      facts: [],
      sourceCostFacts: [],
      errors: validation.findings.filter((finding) => finding.severity === 'ERROR').map(validationError),
      findings: validation.findings,
      health: { healthy: false, stale: false, checkedAt: options.context.collectedAt, message: 'vCenter connector config is invalid.' },
    };
  }

  try {
    const response = options.response ?? (await (options.client ?? createVCenterClient(options.config)).inventory());
    const normalized = normalizeVCenterInventoryResponse(response, toConnectorContext(options.context));

    return {
      connectorId: options.context.connectorId,
      sourceSystem: 'vcenter',
      collectedAt: options.context.collectedAt,
      facts: [normalized.inventory, ...normalized.sourceCostFacts],
      inventory: normalized.inventory,
      sourceCostFacts: normalized.sourceCostFacts,
      errors: [],
      findings: [...validation.findings, ...normalized.findings],
      health: { healthy: true, stale: false, checkedAt: options.context.collectedAt },
    };
  } catch (error) {
    const connectorError = toVCenterConnectorError(error);
    return {
      connectorId: options.context.connectorId,
      sourceSystem: 'vcenter',
      collectedAt: options.context.collectedAt,
      facts: [],
      sourceCostFacts: [],
      errors: [connectorError],
      findings: [{ code: connectorError.code, severity: 'ERROR', message: connectorError.message, metadata: connectorError.details }],
      health: { healthy: false, stale: false, checkedAt: options.context.collectedAt, message: connectorError.message },
    };
  }
}

export * from './config.js';
export * from './errors.js';
export * from './vcenter-client.js';
export * from './vcenter-response-normalizer.js';
export * from './vcenter-property-collector.js';
export * from './in-estate-adapter.js';
