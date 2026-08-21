import type { GpuConnectorResult, GpuInventorySnapshot, GpuValidationFinding } from '../../interfaces/index.js';
import {
  type KubernetesCollectionContext,
  type KubernetesConnectorConfig,
  validateKubernetesConnectorConfig,
} from './config.js';
import { createKubernetesInventoryClient, type KubernetesInventoryClient } from './kubernetes-client.js';
import { normalizeKubernetesInventoryResponse } from './kubernetes-response-normalizer.js';
import { toKubernetesConnectorError } from './errors.js';

type KubernetesRawList = { items: Record<string, unknown>[] };

export interface CollectKubernetesGpuInventoryOptions {
  config: KubernetesConnectorConfig;
  context: KubernetesCollectionContext;
  client?: KubernetesInventoryClient;
}

export interface KubernetesGpuInventoryCollectionResult extends GpuConnectorResult<GpuInventorySnapshot> {
  findings: GpuValidationFinding[];
  inventory?: GpuInventorySnapshot;
}

function asRawList(value: { items: unknown[] }): KubernetesRawList {
  return { items: value.items as Record<string, unknown>[] };
}

function toConnectorContext(context: KubernetesCollectionContext, sourceSystem: 'kubernetes' | 'openshift') {
  return {
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    connectorId: context.connectorId,
    connectorVersion: context.connectorVersion,
    sourceSystem,
    clusterId: context.clusterId,
    collectionWindow: { start: context.collectedAt, end: context.collectedAt },
  };
}

function validationError(finding: { code: string; message: string }) {
  return {
    code: finding.code,
    message: finding.message,
    retryable: false,
    sourceSystem: 'kubernetes' as const,
  };
}

export async function collectKubernetesGpuInventory(
  options: CollectKubernetesGpuInventoryOptions,
): Promise<KubernetesGpuInventoryCollectionResult> {
  const validation = validateKubernetesConnectorConfig(options.config);
  if (!validation.valid) {
    return {
      connectorId: options.context.connectorId,
      sourceSystem: 'kubernetes',
      collectedAt: options.context.collectedAt,
      facts: [],
      errors: validation.findings.filter((finding) => finding.severity === 'ERROR').map(validationError),
      findings: validation.findings,
      health: { healthy: false, stale: false, checkedAt: options.context.collectedAt, message: 'Kubernetes config is invalid.' },
    };
  }

  const platformHint = options.config.platformHint ?? 'UNKNOWN';
  const sourceSystem = platformHint === 'OPENSHIFT' ? 'openshift' : 'kubernetes';
  const client = options.client ?? createKubernetesInventoryClient(options.config);

  try {
    const [nodes, namespaces, pods, deployments, jobs] = await Promise.all([
      client.listNodes(),
      client.listNamespaces(),
      client.listPods(),
      client.listDeployments(),
      client.listJobs(),
    ]);
    const inventory = normalizeKubernetesInventoryResponse(
      {
        nodes: asRawList(nodes),
        namespaces: asRawList(namespaces),
        pods: asRawList(pods),
        deployments: asRawList(deployments),
        jobs: asRawList(jobs),
      },
      toConnectorContext(options.context, sourceSystem),
      platformHint,
    );

    return {
      connectorId: options.context.connectorId,
      sourceSystem,
      collectedAt: options.context.collectedAt,
      facts: [inventory],
      inventory,
      errors: [],
      findings: [...validation.findings, ...inventory.findings],
      health: { healthy: true, stale: false, checkedAt: options.context.collectedAt },
    };
  } catch (error) {
    const connectorError = toKubernetesConnectorError(error);
    return {
      connectorId: options.context.connectorId,
      sourceSystem,
      collectedAt: options.context.collectedAt,
      facts: [],
      errors: [connectorError],
      findings: [
        {
          code: connectorError.code,
          severity: 'ERROR',
          message: connectorError.message,
          metadata: connectorError.details,
        },
      ],
      health: { healthy: false, stale: false, checkedAt: options.context.collectedAt, message: connectorError.message },
    };
  }
}

export * from './config.js';
export * from './errors.js';
export * from './kubernetes-client.js';
export * from './kubernetes-response-normalizer.js';
export * from './rbac.js';
