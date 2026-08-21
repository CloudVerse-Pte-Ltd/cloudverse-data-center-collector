import type {
  GpuCluster,
  GpuConnectorContext,
  GpuDevice,
  GpuInventorySnapshot,
  GpuNode,
  GpuPartition,
  GpuSourceCostFact,
  GpuValidationFinding,
  GpuWorkloadRef,
} from '../../interfaces/index.js';
import { createGpuProvenance } from '../../provenance/index.js';

export interface VCenterInventoryNormalizationResult {
  inventory: GpuInventorySnapshot;
  sourceCostFacts: GpuSourceCostFact[];
  findings: GpuValidationFinding[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function objectStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .map(([key, item]) => [key, stringValue(item)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function finding(code: string, message: string, source: string, severity: GpuValidationFinding['severity'] = 'WARNING'): GpuValidationFinding {
  return { code, severity, message, source };
}

function confidence(level: 'MEDIUM' | 'LOW', reasons: string[]) {
  return {
    level,
    score: level === 'MEDIUM' ? 0.62 : 0.42,
    reasons,
  };
}

export function normalizeVCenterInventoryResponse(response: unknown, context: GpuConnectorContext): VCenterInventoryNormalizationResult {
  const record = asRecord(response);
  const datacenters = arrayValue(record.datacenters ?? record.dataCenters);
  const clusters = arrayValue(record.clusters);
  const hosts = arrayValue(record.hosts);
  const vms = arrayValue(record.vms ?? record.virtualMachines);
  const collectedAt = context.collectionWindow.end;
  const findings: GpuValidationFinding[] = [];
  const sourceCostFacts: GpuSourceCostFact[] = [];
  if (clusters.length !== 1) {
    throw new Error(`Legacy vCenter GPU projection requires exactly one cluster; received ${clusters.length}. Use the canonical native inventory path for multi-cluster estates.`);
  }
  const sourceClusterId = stringValue(clusters[0]?.id, clusters[0]?.cluster, clusters[0]?.clusterId);
  const clusterName = stringValue(clusters[0]?.name);
  if (!sourceClusterId || !clusterName) throw new Error('vCenter cluster is missing immutable source ID or display name.');
  const clusterId = `vcenter:${sourceClusterId}`;
  const baseProvenance = createGpuProvenance(context, {
    externalId: clusterId,
    objectKind: 'vcenter_inventory',
    objectName: clusterName,
  });
  const sharedConfidence = confidence('LOW', ['vcenter_only_visibility']);

  const cluster: GpuCluster = {
    gpuClusterId: clusterId,
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    sourceSystem: 'vcenter',
    connectorId: context.connectorId,
    naturalKey: clusterId,
    name: clusterName,
    clusterType: 'vcenter',
    regionOrSite: stringValue(datacenters[0]?.name, datacenters[0]?.datacenter),
    provenance: baseProvenance,
    confidence: sharedConfidence,
  };

  const nodes: GpuNode[] = hosts.map((host) => {
    const hostId = stringValue(host.id, host.host, host.hostId);
    const hostName = stringValue(host.name);
    if (!hostId || !hostName) throw new Error('vCenter host is missing immutable source ID or display name.');
    return {
      gpuNodeId: `${clusterId}:host:${hostId}`,
      gpuClusterId: clusterId,
      naturalKey: `${clusterId}:host:${hostId}`,
      nodeName: hostName,
      datacenter: stringValue(host.datacenter, datacenters[0]?.name),
      gpuDeviceCount: arrayValue(host.gpus).length || numberValue(host.gpu_count, host.gpuCount),
      sourceLabels: objectStringMap(host.labels ?? host.tags),
      sourceAnnotations: objectStringMap(host.annotations),
      provenance: createGpuProvenance(context, { externalId: hostId, objectKind: 'vcenter_host', objectName: hostName }),
      confidence: sharedConfidence,
    };
  });

  const devices: GpuDevice[] = hosts.flatMap((host) => {
    const hostId = stringValue(host.id, host.host, host.hostId);
    const hostName = stringValue(host.name);
    if (!hostId || !hostName) throw new Error('vCenter host is missing immutable source ID or display name.');
    return arrayValue(host.gpus).map((gpu, index) => {
      const uuid = stringValue(gpu.uuid, gpu.gpuUuid, gpu.id);
      if (!uuid) {
        findings.push(finding('missing_gpu_uuid', 'vCenter GPU device is missing GPU UUID.', `${hostName}:gpu:${index}`));
      }
      return {
        gpuDeviceId: `${clusterId}:host:${hostId}:gpu:${uuid ?? index}`,
        gpuNodeId: `${clusterId}:host:${hostId}`,
        naturalKey: `${hostId}:gpu:${uuid ?? index}`,
        gpuUuid: uuid,
        pciBusId: stringValue(gpu.pciBusId, gpu.pci_bus_id),
        vendor: stringValue(gpu.vendor, 'nvidia'),
        model: stringValue(gpu.model, gpu.name),
        memoryMib: numberValue(gpu.memoryMib, gpu.memory_mib),
        vgpuCapable: Boolean(gpu.vgpuCapable ?? gpu.vgpu_capable),
        partitioned: Boolean(gpu.vgpuProfile ?? gpu.vgpu_profile),
        provenance: createGpuProvenance(context, {
          externalId: uuid ?? `${hostName}:gpu:${index}`,
          objectKind: 'vcenter_gpu_device',
          objectName: stringValue(gpu.model, gpu.name, uuid) ?? `${hostName}:gpu:${index}`,
        }),
        confidence: uuid ? sharedConfidence : confidence('LOW', ['vcenter_only_visibility', 'missing_gpu_uuid']),
      } satisfies GpuDevice;
    });
  });

  const partitions: GpuPartition[] = [];
  const workloads: GpuWorkloadRef[] = vms.map((vm) => {
      const vmId = stringValue(vm.id, vm.vm, vm.vmId);
      const vmName = stringValue(vm.name, vm.vmName);
      if (!vmId || !vmName) throw new Error('vCenter VM is missing immutable source ID or display name.');
      const hostName = stringValue(vm.host, vm.hostName);
      const labels = objectStringMap(vm.labels ?? vm.tags);
      const owner = stringValue(vm.owner, labels?.owner, labels?.team);
      const gpuRefs = arrayValue(vm.gpus);
      if (!owner) {
        findings.push(finding('missing_vm_owner', 'vCenter VM GPU evidence is missing VM owner metadata.', vmId));
      }
      findings.push(finding('vcenter_only_visibility', 'vCenter visibility does not prove guest workload ownership.', vmId, 'INFO'));
      findings.push(finding('workload_unknown', 'vCenter VM evidence cannot identify guest workload without another source.', vmId));

      const workloadConfidence = owner ? confidence('MEDIUM', ['vcenter_vm_gpu_mapping']) : confidence('LOW', ['vcenter_only_visibility', 'missing_vm_owner']);
      const vgpuProfile = stringValue(gpuRefs[0]?.vgpuProfile, gpuRefs[0]?.vgpu_profile, vm.vgpuProfile, vm.vgpu_profile);
      const passthrough = Boolean(gpuRefs[0]?.passthrough ?? vm.passthrough);
      return {
        workloadRefId: `${clusterId}:vm:${vmId}`,
        tenantId: context.tenantId,
        orgId: context.orgId,
        deploymentMode: context.deploymentMode,
        provider: context.provider,
        sourceSystem: 'vcenter',
        connectorId: context.connectorId,
        kind: 'vm',
        naturalKey: `${clusterId}:vm:${vmId}`,
        name: vmName,
        nodeName: hostName,
        vmId,
        requestedGpuCount: gpuRefs.length || numberValue(vm.gpu_count, vm.gpuCount),
        partitioned: Boolean(vgpuProfile),
        migProfile: vgpuProfile,
        sourceLabels: {
          ...(labels ?? {}),
          ...(owner ? { owner } : {}),
          ...(vgpuProfile ? { vgpu_profile: vgpuProfile } : {}),
          ...(passthrough ? { gpu_mapping: 'passthrough' } : {}),
        },
        provenance: createGpuProvenance(context, { externalId: vmId, objectKind: 'vcenter_vm', objectName: vmName }),
        confidence: workloadConfidence,
      } satisfies GpuWorkloadRef;
    });

  for (const vm of vms) {
    const costAmount = numberValue(vm.gpuCost, vm.gpu_cost, vm.costAmount);
    if (costAmount !== undefined) {
      const vmId = stringValue(vm.id, vm.vm, vm.vmId);
      if (!vmId) throw new Error('vCenter VM cost hint is missing immutable source ID.');
      const currency = stringValue(vm.currency);
      if (!currency) {
        findings.push(finding('unresolved_cost_currency', 'vCenter VM cost hint was rejected because currency is unresolved.', vmId, 'ERROR'));
        continue;
      }
      sourceCostFacts.push({
        gpuSourceCostFactId: `${clusterId}:vm:${vmId}:source-cost`,
        tenantId: context.tenantId,
        orgId: context.orgId,
        deploymentMode: context.deploymentMode,
        provider: context.provider,
        sourceSystem: 'vcenter',
        connectorId: context.connectorId,
        gpuClusterId: clusterId,
        workloadRef: workloads.find((workload) => workload.vmId === vmId),
        timeWindow: context.collectionWindow,
        costAmount,
        currency,
        costCategory: 'unknown',
        sourceLabels: objectStringMap(vm.labels ?? vm.tags),
        provenance: createGpuProvenance(context, { externalId: vmId, objectKind: 'vcenter_vm_cost_hint', objectName: stringValue(vm.name, vmId) }),
        confidence: confidence('LOW', ['vcenter_source_cost_hint_not_rate_card']),
      });
    }
  }

  const inventory: GpuInventorySnapshot = {
    tenantId: context.tenantId,
    orgId: context.orgId,
    deploymentMode: context.deploymentMode,
    provider: context.provider,
    sourceSystem: 'vcenter',
    connectorId: context.connectorId,
    cluster,
    nodes,
    devices,
    partitions,
    workloads,
    namespaces: [],
    collectedAt,
    provenance: baseProvenance,
    confidence: sharedConfidence,
    findings,
  };

  return { inventory, sourceCostFacts, findings };
}
