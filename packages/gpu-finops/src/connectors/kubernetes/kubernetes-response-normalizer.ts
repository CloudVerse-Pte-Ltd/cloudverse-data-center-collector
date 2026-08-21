import type {
  GpuCluster,
  GpuConnectorContext,
  GpuDevice,
  GpuInventorySnapshot,
  GpuNode,
  GpuPartition,
  GpuValidationFinding,
  GpuWorkloadRef,
} from '../../interfaces/index.js';
import { createGpuProvenance } from '../../provenance/index.js';
import type { KubernetesPlatformHint } from './config.js';

type KubeMap = Record<string, unknown>;

export interface KubernetesInventoryResponses {
  nodes: { items: KubeMap[] };
  namespaces: { items: KubeMap[] };
  pods: { items: KubeMap[] };
  deployments?: { items: KubeMap[] };
  jobs?: { items: KubeMap[] };
}

export interface KubernetesGpuResourceClaim {
  resourceName: string;
  vendor?: string;
  quantity: number;
  isMig: boolean;
  migProfile?: string;
  isRequest: boolean;
  isLimit: boolean;
}

function metadata(object: KubeMap): KubeMap {
  return (object.metadata as KubeMap | undefined) ?? {};
}

function spec(object: KubeMap): KubeMap {
  return (object.spec as KubeMap | undefined) ?? {};
}

function status(object: KubeMap): KubeMap {
  return (object.status as KubeMap | undefined) ?? {};
}

function labels(object: KubeMap): Record<string, string> {
  return ((metadata(object).labels as Record<string, string> | undefined) ?? {});
}

function annotations(object: KubeMap): Record<string, string> {
  return ((metadata(object).annotations as Record<string, string> | undefined) ?? {});
}

function name(object: KubeMap): string {
  return String(metadata(object).name ?? 'unknown');
}

function namespace(object: KubeMap): string | undefined {
  const value = metadata(object).namespace;
  return value ? String(value) : undefined;
}

function uid(object: KubeMap): string {
  return String(metadata(object).uid ?? name(object));
}

function parseQuantity(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function vendorFromResource(resourceName: string): string | undefined {
  if (resourceName.startsWith('nvidia.com/')) return 'nvidia';
  if (resourceName.startsWith('amd.com/')) return 'amd';
  if (resourceName.startsWith('intel.com/')) return 'intel';
  const prefix = resourceName.split('/')[0];
  return prefix && prefix !== resourceName ? prefix : undefined;
}

export function detectKubernetesGpuResources(
  resources: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } = {},
): KubernetesGpuResourceClaim[] {
  const claims: KubernetesGpuResourceClaim[] = [];

  for (const [kind, values] of Object.entries({ requests: resources.requests, limits: resources.limits })) {
    for (const [resourceName, quantity] of Object.entries(values ?? {})) {
      const lower = resourceName.toLowerCase();
      const isMig = lower.includes('mig');
      const isGpu =
        resourceName === 'nvidia.com/gpu' ||
        resourceName.startsWith('nvidia.com/mig-') ||
        resourceName === 'amd.com/gpu' ||
        resourceName === 'intel.com/gpu' ||
        lower.includes('gpu') ||
        isMig;

      if (!isGpu) continue;

      claims.push({
        resourceName,
        vendor: vendorFromResource(resourceName),
        quantity: parseQuantity(quantity),
        isMig,
        migProfile: resourceName.match(/mig-([A-Za-z0-9.]+)$/)?.[1],
        isRequest: kind === 'requests',
        isLimit: kind === 'limits',
      });
    }
  }

  return claims;
}

function finding(code: string, message: string, source: string): GpuValidationFinding {
  return { code, severity: 'WARNING', message, source };
}

function firstLabel(source: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (source[key]) return source[key];
  }
  return undefined;
}

function controllerForPod(pod: KubeMap, deployments: KubeMap[], jobs: KubeMap[]): string | undefined {
  const owners = (metadata(pod).ownerReferences as Array<Record<string, unknown>> | undefined) ?? [];
  const direct = owners[0];
  if (direct?.kind === 'Job') return String(direct.name);
  if (direct?.kind === 'ReplicaSet') {
    const podLabels = labels(pod);
    const deployment = deployments.find((candidate) => {
      const matchLabels = ((spec(candidate).selector as KubeMap | undefined)?.matchLabels as Record<string, string> | undefined) ?? {};
      return Object.entries(matchLabels).every(([key, value]) => podLabels[key] === value);
    });
    return deployment ? name(deployment) : String(direct.name);
  }
  if (direct?.kind) return String(direct.name ?? direct.kind);

  const podLabels = labels(pod);
  const job = jobs.find((candidate) => firstLabel(labels(candidate), ['job-name']) === podLabels['job-name']);
  return job ? name(job) : undefined;
}

function nodeGpuClaims(node: KubeMap): KubernetesGpuResourceClaim[] {
  return detectKubernetesGpuResources({
    requests: (status(node).capacity as Record<string, unknown> | undefined) ?? {},
    limits: (status(node).allocatable as Record<string, unknown> | undefined) ?? {},
  });
}

export function normalizeKubernetesInventoryResponse(
  responses: KubernetesInventoryResponses,
  context: GpuConnectorContext,
  platformHint: KubernetesPlatformHint = 'UNKNOWN',
): GpuInventorySnapshot {
  const clusterName = context.clusterId ?? 'kubernetes-cluster';
  const clusterProvenance = createGpuProvenance(context, {
    externalId: context.clusterId,
    objectKind: 'cluster',
    objectName: clusterName,
  });
  const cluster: GpuCluster = {
    gpuClusterId: context.clusterId ?? clusterName,
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    sourceSystem: platformHint === 'OPENSHIFT' ? 'openshift' : 'kubernetes',
    connectorId: context.connectorId,
    naturalKey: `${context.tenantId}:${context.provider}:${context.clusterId ?? clusterName}`,
    name: clusterName,
    clusterType: platformHint === 'OPENSHIFT' ? 'openshift' : 'kubernetes',
    provenance: clusterProvenance,
    confidence: { level: 'HIGH', score: 0.9, reasons: ['kubernetes_api_inventory'] },
  };

  const findings: GpuValidationFinding[] = [];
  const nodes: GpuNode[] = responses.nodes.items.map((node) => {
    const nodeLabels = labels(node);
    const claims = nodeGpuClaims(node);
    return {
      gpuNodeId: `${cluster.gpuClusterId}:node:${name(node)}`,
      gpuClusterId: cluster.gpuClusterId,
      naturalKey: `${cluster.gpuClusterId}:${name(node)}`,
      nodeName: name(node),
      instanceType: firstLabel(nodeLabels, ['node.kubernetes.io/instance-type', 'beta.kubernetes.io/instance-type']),
      machineType: firstLabel(nodeLabels, ['node.kubernetes.io/instance-type', 'beta.kubernetes.io/instance-type']),
      gpuDeviceCount: claims.reduce((sum, claim) => sum + claim.quantity, 0),
      allocatableGpuResourceCount: claims.filter((claim) => claim.isLimit).reduce((sum, claim) => sum + claim.quantity, 0),
      timeSlicingEnabled: Boolean(nodeLabels['nvidia.com/gpu.sharing-strategy'] === 'time-slicing'),
      sourceLabels: nodeLabels,
      sourceAnnotations: {
        ...annotations(node),
        providerID: String(spec(node).providerID ?? ''),
        zone: firstLabel(nodeLabels, ['topology.kubernetes.io/zone', 'failure-domain.beta.kubernetes.io/zone']) ?? '',
        region: firstLabel(nodeLabels, ['topology.kubernetes.io/region', 'failure-domain.beta.kubernetes.io/region']) ?? '',
        nodePool: firstLabel(nodeLabels, ['cloud.google.com/gke-nodepool', 'eks.amazonaws.com/nodegroup', 'kubernetes.azure.com/agentpool']) ?? '',
      },
      provenance: createGpuProvenance(context, {
        externalId: uid(node),
        objectKind: 'node',
        objectName: name(node),
        clusterName,
      }),
      confidence: { level: claims.length ? 'HIGH' : 'LOW', score: claims.length ? 0.9 : 0.45, reasons: claims.length ? ['node_gpu_inventory'] : ['node_inventory_without_gpu_capacity'] },
    };
  });

  const devices: GpuDevice[] = responses.nodes.items.flatMap((node) => {
    const claims = nodeGpuClaims(node).filter((claim) => claim.quantity > 0);
    return claims.flatMap((claim) =>
      Array.from({ length: Math.max(1, Math.floor(claim.quantity)) }, (_, index) => ({
        gpuDeviceId: `${cluster.gpuClusterId}:node:${name(node)}:gpu:${claim.resourceName}:${index}`,
        gpuNodeId: `${cluster.gpuClusterId}:node:${name(node)}`,
        naturalKey: `${name(node)}:${claim.resourceName}:${index}`,
        gpuIndex: String(index),
        vendor: claim.vendor,
        partitioned: claim.isMig,
        migProfile: claim.migProfile,
        provenance: createGpuProvenance(context, {
          externalId: `${uid(node)}:${claim.resourceName}:${index}`,
          objectKind: 'gpu_device_hint',
          objectName: `${name(node)}/${claim.resourceName}/${index}`,
          clusterName,
        }),
        confidence: { level: 'MEDIUM', score: 0.65, reasons: ['device_hint_from_node_capacity'] },
      })),
    );
  });

  const partitions: GpuPartition[] = devices
    .filter((device) => device.partitioned && device.migProfile)
    .map((device) => ({
      gpuPartitionId: `${device.gpuDeviceId}:mig:${device.migProfile}`,
      gpuDeviceId: device.gpuDeviceId,
      naturalKey: `${device.naturalKey}:mig:${device.migProfile}`,
      partitionType: 'mig',
      profile: device.migProfile,
      provenance: device.provenance,
      confidence: device.confidence,
    }));

  const deployments = responses.deployments?.items ?? [];
  const jobs = responses.jobs?.items ?? [];
  const workloads: GpuWorkloadRef[] = [];
  for (const pod of responses.pods.items) {
    const podSpec = spec(pod);
    const podLabels = labels(pod);
    const podAnnotations = annotations(pod);
    const containers = (podSpec.containers as KubeMap[] | undefined) ?? [];
    for (const container of containers) {
      const containerName = String(container.name ?? 'unknown');
      const gpuResources = detectKubernetesGpuResources((container.resources as { requests?: Record<string, unknown>; limits?: Record<string, unknown> } | undefined) ?? {});
      const requests = gpuResources.filter((resource) => resource.isRequest);
      if (!gpuResources.length) continue;
      const source = `${namespace(pod) ?? 'default'}/${name(pod)}/${containerName}`;
      if (!firstLabel(podLabels, ['owner', 'team'])) findings.push(finding('missing_owner_label', 'GPU workload is missing owner/team label.', source));
      if (!firstLabel(podLabels, ['cost-center', 'cost_center', 'cloudverse.ai/cost-center'])) findings.push(finding('missing_cost_center_label', 'GPU workload is missing cost-center label.', source));
      if (!firstLabel(podLabels, ['app', 'app.kubernetes.io/name'])) findings.push(finding('missing_application_label', 'GPU workload is missing application label.', source));
      if (!podSpec.nodeName) findings.push(finding('no_matching_node', 'GPU workload is not scheduled to a node.', source));
      workloads.push({
        workloadRefId: `${cluster.gpuClusterId}:pod:${uid(pod)}:container:${containerName}`,
        tenantId: context.tenantId,
        orgId: context.orgId,
        deploymentMode: context.deploymentMode,
        provider: context.provider,
        sourceSystem: cluster.sourceSystem,
        connectorId: context.connectorId,
        kind: 'kubernetes_pod',
        naturalKey: `${cluster.gpuClusterId}:${namespace(pod) ?? 'default'}:${uid(pod)}:${containerName}`,
        name: name(pod),
        namespace: namespace(pod),
        container: containerName,
        controller: controllerForPod(pod, deployments, jobs),
        nodeName: podSpec.nodeName ? String(podSpec.nodeName) : undefined,
        podUid: uid(pod),
        requestedGpuCount: requests.reduce((sum, request) => sum + request.quantity, 0),
        requestedGpuResource: requests[0]?.resourceName,
        gpuResources,
        partitioned: gpuResources.some((resource) => resource.isMig),
        migProfile: gpuResources.find((resource) => resource.migProfile)?.migProfile,
        timeSlicingEnabled: gpuResources.some((resource) => resource.resourceName.endsWith('.shared')),
        sourceLabels: podLabels,
        sourceAnnotations: {
          ...podAnnotations,
          phase: String(status(pod).phase ?? ''),
          serviceAccountName: String(podSpec.serviceAccountName ?? ''),
          app: firstLabel(podLabels, ['app', 'app.kubernetes.io/name']) ?? '',
          owner: firstLabel(podLabels, ['owner', 'team']) ?? '',
          environment: firstLabel(podLabels, ['environment', 'env']) ?? '',
          project: firstLabel(podLabels, ['project']) ?? '',
          model: firstLabel(podLabels, ['model', 'cloudverse.ai/model-id']) ?? '',
          aixRunId: firstLabel({ ...podLabels, ...podAnnotations }, ['aix-run-id', 'cloudverse.ai/run-id', 'aix.workflow/id']) ?? '',
        },
        provenance: createGpuProvenance(context, {
          externalId: uid(pod),
          objectKind: 'pod',
          objectName: name(pod),
          namespace: namespace(pod),
          clusterName,
        }),
        confidence: {
          level: podSpec.nodeName ? 'HIGH' : 'MEDIUM',
          score: podSpec.nodeName ? 0.9 : 0.65,
          reasons: podSpec.nodeName ? ['kubernetes_pod_gpu_request_with_node'] : ['kubernetes_pod_gpu_request_without_node'],
        },
      });
    }
  }

  const namespaceMetadata = responses.namespaces.items.map((item) => ({
    name: name(item),
    labels: labels(item),
    annotations: annotations(item),
  }));

  return {
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    sourceSystem: cluster.sourceSystem,
    connectorId: context.connectorId,
    cluster,
    nodes,
    devices,
    partitions,
    workloads,
    namespaces: namespaceMetadata.map((item) => item.name),
    namespaceMetadata,
    collectedAt: context.collectionWindow.end,
    provenance: clusterProvenance,
    confidence: { level: 'HIGH', score: 0.9, reasons: ['kubernetes_inventory_normalized'] },
    findings,
  };
}
