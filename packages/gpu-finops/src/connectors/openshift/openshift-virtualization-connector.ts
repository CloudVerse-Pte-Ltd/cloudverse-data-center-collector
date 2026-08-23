import type { KubernetesConnectorConfig } from '../kubernetes/config.js';
import { validateKubernetesConnectorConfig } from '../kubernetes/config.js';
import type { ConnectorCapabilityResult, ConnectorCollectionContext, ConnectorResult, DataCenterConnector } from '../../connector-sdk/index.js';
import { createOpenShiftVirtualizationClient, type OpenShiftVirtualizationClientOptions } from './kubevirt-client.js';
import { normalizeOpenShiftVirtualizationInventory } from './kubevirt-normalizer.js';

export interface OpenShiftCollectionContext {
  integrationId: string;
  collectionRunId: string;
  managementPlaneUid: string;
  collectedAt: string;
}

export interface OpenShiftVirtualizationGraphEnvelope {
  type: 'OPENSHIFT_VIRTUALIZATION_GRAPH';
  integrationId: number;
  managementPlaneUid: string;
  collectedAt: string;
  coverage: { scope: 'CLUSTER' | 'NAMESPACES'; namespaces: string[] };
  resources: Array<ReturnType<typeof normalizeOpenShiftVirtualizationInventory>['resources'][number] | {
    id: string; uid: string; kind: 'Cluster'; name: string; namespace: ''; ownerIds: string[];
    labels: Record<string, never>; annotations: Record<string, never>;
    attributes: Record<string, unknown>;
  }>;
  relationships: ReturnType<typeof normalizeOpenShiftVirtualizationInventory>['relationships'];
}

export async function collectOpenShiftVirtualizationGraph(
  config: KubernetesConnectorConfig,
  context: OpenShiftCollectionContext,
  options: OpenShiftVirtualizationClientOptions = {},
) {
  const connectorId = 'openshift-virtualization'; const connectorVersion = '1.0.0';
  const provenance = { connectorId, connectorVersion, collectedAt: context.collectedAt, managementPlaneUid: context.managementPlaneUid, collectionRunId: context.collectionRunId, source: { metadata: { platform: 'OPENSHIFT_VIRTUALIZATION', coverage: options.namespaces?.length ? 'NAMESPACES' : 'CLUSTER' } } };
  const client = createOpenShiftVirtualizationClient(config, options);
  const discovered = await client.discover();
  const expectedUid = discovered.managementPlaneUid ? `openshift:${discovered.managementPlaneUid}` : undefined;
  const identityReady = Boolean(expectedUid && expectedUid === context.managementPlaneUid);
  const capabilities: ConnectorCapabilityResult[] = [
    { capability: 'AUTHENTICATE', status: 'READY', evidenceEligibleAt: context.collectedAt, provenance },
    { capability: 'DESCRIBE_PLATFORM', status: discovered.kubeVirt.present ? 'READY' : 'BLOCKED', evidenceEligibleAt: context.collectedAt, diagnostics: { ...discovered, permissionChecks: discovered.permissionChecks }, provenance },
    { capability: 'DISCOVER_PLANES', status: identityReady ? 'READY' : 'BLOCKED', evidenceEligibleAt: context.collectedAt, diagnostics: { identityStatus: discovered.identityStatus, expectedManagementPlaneUid: expectedUid }, provenance },
  ];
  if (!identityReady || !discovered.kubeVirt.present) {
    return { records: [], errors: [{ code: !identityReady ? 'openshift_identity_unavailable' : 'kubevirt_absent', message: !identityReady ? 'Immutable OpenShift Infrastructure UID is unavailable or does not match the collection context.' : 'OpenShift Virtualization is not installed.', retryable: false }], page: { receivedCount: 0, complete: true }, provenance, capabilities };
  }
  const collected = await client.collectInventory();
  const graph = normalizeOpenShiftVirtualizationInventory(collected.inventory);
  const integrationId = Number(context.integrationId);
  if (!Number.isSafeInteger(integrationId) || integrationId <= 0) throw new Error('OpenShift integrationId must be a positive integer');
  const clusterUid = discovered.managementPlaneUid!;
  const clusterName = discovered.clusterName || `openshift-${clusterUid.slice(0, 12)}`;
  const cluster = {
    id: `_cluster/Cluster/${clusterUid}`,
    uid: clusterUid,
    kind: 'Cluster' as const,
    name: clusterName,
    namespace: '' as const,
    ownerIds: [],
    labels: {},
    annotations: {},
    attributes: {
      kubernetesVersion: discovered.kubernetesVersion,
      openshiftVersion: discovered.openshiftVersion,
      kubeVirtVersion: discovered.kubeVirt.version,
    },
  };
  const envelope: OpenShiftVirtualizationGraphEnvelope = { type: 'OPENSHIFT_VIRTUALIZATION_GRAPH', integrationId, managementPlaneUid: context.managementPlaneUid, collectedAt: context.collectedAt, coverage: collected.coverage, resources: [cluster, ...graph.resources], relationships: graph.relationships };
  return {
    records: [envelope],
    errors: collected.failures.map((failure) => ({ code: failure.code, message: failure.message, retryable: false, details: { resource: failure.resource, path: failure.path, status: failure.status } })),
    page: { receivedCount: 1, complete: true }, provenance,
    capabilities: [...capabilities, { capability: 'DISCOVER_INVENTORY', status: collected.failures.length ? 'BLOCKED' : 'READY', evidenceEligibleAt: context.collectedAt, diagnostics: { coverage: collected.coverage, failures: collected.failures }, provenance } satisfies ConnectorCapabilityResult],
  };
}

export interface OpenShiftInEstateAdapterConfig {
  kubernetes: KubernetesConnectorConfig;
  namespaces?: string[];
}

export class OpenShiftVirtualizationInEstateAdapter implements DataCenterConnector<OpenShiftInEstateAdapterConfig, OpenShiftVirtualizationGraphEnvelope> {
  readonly id = 'openshift-virtualization';
  readonly version = '1.0.0';
  readonly capabilities = ['AUTHENTICATE', 'DESCRIBE_PLATFORM', 'DISCOVER_PLANES', 'DISCOVER_INVENTORY'] as const;

  constructor(private readonly sourceConcurrency = 4) {
    if (!Number.isSafeInteger(sourceConcurrency) || sourceConcurrency < 1 || sourceConcurrency > 16) throw new Error('OpenShift source concurrency must be between 1 and 16');
  }

  async validateConfig(config: OpenShiftInEstateAdapterConfig): Promise<void> {
    const validation = validateKubernetesConnectorConfig(config.kubernetes);
    const error = validation.findings.find((finding) => finding.severity === 'ERROR');
    if (error) throw new Error(error.message);
    if (config.kubernetes.platformHint !== 'OPENSHIFT') throw new Error('OpenShift Virtualization adapter requires platformHint OPENSHIFT');
    if (config.namespaces && (config.namespaces.length > 1_000 || config.namespaces.some((namespace) => !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)))) {
      throw new Error('OpenShift namespace allowlist is invalid');
    }
  }

  async collect(config: OpenShiftInEstateAdapterConfig, context: ConnectorCollectionContext): Promise<ConnectorResult<OpenShiftVirtualizationGraphEnvelope>> {
    await this.validateConfig(config);
    if (context.cursor) throw new Error('OpenShift Virtualization client performs bounded API paging internally');
    const result = await collectOpenShiftVirtualizationGraph(config.kubernetes, {
      integrationId: context.integrationId,
      collectionRunId: context.collectionRunId,
      managementPlaneUid: context.managementPlaneUid,
      collectedAt: new Date().toISOString(),
    }, { namespaces: config.namespaces, sourceConcurrency: this.sourceConcurrency });
    return {
      ...result,
      errors: result.errors.map((error) => ({ ...error, category: error.code.includes('permission') ? 'AUTHORIZATION' as const : 'SOURCE_UNAVAILABLE' as const })),
      health: {
        status: result.errors.length ? 'DEGRADED' : 'HEALTHY',
        checkedAt: result.provenance.collectedAt,
        stale: false,
      },
    };
  }
}
