export type GpuDeploymentMode =
  | 'SAAS_DIRECT'
  | 'SAAS_WITH_COLLECTOR'
  | 'PRIVATE_DEPLOYMENT'
  | 'OFFLINE_IMPORT';

export type GpuProvider = 'on_prem' | 'aws' | 'azure' | 'gcp' | 'oci' | 'hybrid';

export type GpuSourceSystem =
  | 'opencost'
  | 'prometheus'
  | 'dcgm'
  | 'kubernetes'
  | 'openshift'
  | 'slurm'
  | 'vcenter'
  | 'cmdb'
  | 'finance'
  | 'billing_export'
  | 'collector'
  | 'offline_import'
  | 'cloud_api';

export type GpuConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'ESTIMATED' | 'UNKNOWN';

export type GpuWorkloadKind =
  | 'kubernetes_pod'
  | 'kubernetes_job'
  | 'openshift_workload'
  | 'slurm_job'
  | 'vm'
  | 'cloud_resource'
  | 'aix_runtime'
  | 'unknown';

export type GpuPartitionType = 'mig' | 'vgpu' | 'time_slice' | 'mps' | 'passthrough';

export type GpuOptimizationSignalStatus = 'open' | 'accepted' | 'dismissed' | 'superseded';

export type GpuValidationSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface GpuTimeWindow {
  start: string;
  end: string;
}

export interface GpuRawSourceReference {
  externalId?: string;
  endpoint?: string;
  queryId?: string;
  queryHash?: string;
  query?: string;
  importFileName?: string;
  rowNumber?: number;
  objectKind?: string;
  objectName?: string;
  namespace?: string;
  clusterName?: string;
  metadata?: Record<string, unknown>;
}

export interface GpuProvenance {
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  connectorVersion: string;
  deploymentMode: GpuDeploymentMode;
  collectedAt: string;
  receivedAt?: string;
  sourceAccountOrClusterId?: string;
  sourceResourceId?: string;
  rawSourceReference?: GpuRawSourceReference;
  ingestionBatchId?: string;
  collectorId?: string;
  metadata?: Record<string, unknown>;
}

export interface GpuConfidence {
  level: GpuConfidenceLevel;
  score: number;
  reasons: string[];
}

export interface GpuValidationFinding {
  code: string;
  severity: GpuValidationSeverity;
  message: string;
  factId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface GpuFactEnvelope<TPayload> {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  provider: GpuProvider;
  clusterId?: string;
  timeWindow?: GpuTimeWindow;
  timestamp: string;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
  payload: TPayload;
}

export interface GpuConnectorContext {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  connectorId: string;
  connectorVersion: string;
  sourceSystem: GpuSourceSystem;
  clusterId?: string;
  collectionWindow: GpuTimeWindow;
}

export interface GpuConnectorError {
  code: string;
  message: string;
  retryable: boolean;
  sourceSystem: GpuSourceSystem;
  rawSourceReference?: GpuRawSourceReference;
  details?: Record<string, unknown>;
}

export interface GpuConnectorResult<TFact = GpuNormalizedFact> {
  connectorId: string;
  sourceSystem: GpuSourceSystem;
  collectedAt: string;
  facts: TFact[];
  errors: GpuConnectorError[];
  nextCursor?: string;
  health: {
    healthy: boolean;
    stale: boolean;
    checkedAt: string;
    message?: string;
  };
}

export interface GpuConnector<TConfig, TFact = GpuNormalizedFact> {
  readonly id: string;
  readonly sourceSystem: GpuSourceSystem;
  readonly version: string;
  validateConfig(config: TConfig): Promise<void>;
  collect(config: TConfig, context: GpuConnectorContext): Promise<GpuConnectorResult<TFact>>;
}

export interface GpuCluster {
  gpuClusterId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  naturalKey: string;
  name: string;
  clusterType: 'kubernetes' | 'openshift' | 'slurm' | 'vcenter' | 'cloud' | 'imported';
  regionOrSite?: string;
  environment?: string;
  sourceLabels?: Record<string, string>;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuNode {
  gpuNodeId: string;
  gpuClusterId: string;
  naturalKey: string;
  nodeName: string;
  instanceType?: string;
  machineType?: string;
  rack?: string;
  datacenter?: string;
  gpuDeviceCount?: number;
  allocatableGpuResourceCount?: number;
  timeSlicingEnabled?: boolean;
  sourceLabels?: Record<string, string>;
  sourceAnnotations?: Record<string, string>;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuDevice {
  gpuDeviceId: string;
  gpuNodeId: string;
  naturalKey: string;
  gpuUuid?: string;
  gpuIndex?: string;
  pciBusId?: string;
  vendor?: string;
  model?: string;
  architecture?: string;
  memoryMib?: number;
  migCapable?: boolean;
  vgpuCapable?: boolean;
  partitioned?: boolean;
  migProfile?: string;
  healthStatus?: string;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuPartition {
  gpuPartitionId: string;
  gpuDeviceId: string;
  naturalKey: string;
  partitionType: GpuPartitionType;
  profile?: string;
  memoryMib?: number;
  replicaCount?: number;
  sourcePartitionId?: string;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuWorkloadRef {
  workloadRefId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  kind: GpuWorkloadKind;
  naturalKey: string;
  name?: string;
  namespace?: string;
  container?: string;
  controller?: string;
  nodeName?: string;
  podUid?: string;
  slurmJobId?: string;
  slurmStepId?: string;
  vmId?: string;
  cloudResourceId?: string;
  requestedGpuCount?: number;
  requestedGpuResource?: string;
  gpuResources?: Array<{
    resourceName: string;
    vendor?: string;
    quantity: number;
    isMig: boolean;
    migProfile?: string;
    isRequest: boolean;
    isLimit: boolean;
  }>;
  partitioned?: boolean;
  migProfile?: string;
  timeSlicingEnabled?: boolean;
  sourceLabels?: Record<string, string>;
  sourceAnnotations?: Record<string, string>;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuTechnicalAttributionFact {
  gpuTechnicalAttributionFactId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  gpuClusterId?: string;
  gpuNodeId?: string;
  gpuDeviceId?: string;
  gpuPartitionId?: string;
  workloadRef?: GpuWorkloadRef;
  timeWindow: GpuTimeWindow;
  attributionMethod:
    | 'direct_workload_metric'
    | 'source_allocation'
    | 'node_time_overlap'
    | 'vm_mapping'
    | 'owner_label'
    | 'proportional_estimate'
    | 'unknown';
  requestedGpuCount?: number;
  allocatedGpuCount?: number;
  partitioned?: boolean;
  migProfile?: string;
  findings?: GpuValidationFinding[];
  sourceLabels?: Record<string, string>;
  sourceAnnotations?: Record<string, string>;
  evidenceIds?: string[];
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuUsageFact {
  gpuUsageFactId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  gpuClusterId?: string;
  gpuNodeId?: string;
  gpuDeviceId?: string;
  gpuPartitionId?: string;
  workloadRef?: GpuWorkloadRef;
  timeWindow: GpuTimeWindow;
  allocatedGpuHours?: number;
  utilizedGpuHours?: number;
  idleAllocatedGpuHours?: number;
  memoryGbHours?: number;
  powerKwh?: number;
  requestedGpuCount?: number;
  allocatedGpuCount?: number;
  partitioned?: boolean;
  migProfile?: string;
  findings?: GpuValidationFinding[];
  sourceCostEvidenceIds?: string[];
  sourceAllocationEvidenceIds?: string[];
  sourceLabels?: Record<string, string>;
  sourceAnnotations?: Record<string, string>;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuTelemetryFact {
  gpuTelemetryFactId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  gpuClusterId?: string;
  gpuNodeId?: string;
  gpuDeviceId?: string;
  gpuPartitionId?: string;
  workloadRef?: GpuWorkloadRef;
  timeWindow: GpuTimeWindow;
  gpuUtilizationPctAvg?: number;
  gpuUtilizationPctMax?: number;
  memoryUtilizationPctAvg?: number;
  memoryUtilizationPctMax?: number;
  framebufferUsedMibAvg?: number;
  framebufferUsedMibMax?: number;
  powerWattsAvg?: number;
  energyMillijoules?: number;
  temperatureCelsiusMax?: number;
  xidErrorCount?: number;
  eccErrorCount?: number;
  nvlinkBytes?: number;
  metricName?: string;
  metricLabels?: Record<string, string>;
  stale?: boolean;
  partitioned?: boolean;
  migProfile?: string;
  sampleCount?: number;
  metricValueAvg?: number;
  metricValueMin?: number;
  metricValueMax?: number;
  metricValueLatest?: number;
  findings?: GpuValidationFinding[];
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuInventorySnapshot {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  cluster: GpuCluster;
  nodes: GpuNode[];
  devices: GpuDevice[];
  partitions: GpuPartition[];
  workloads: GpuWorkloadRef[];
  namespaces: string[];
  namespaceMetadata?: Array<{
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  }>;
  collectedAt: string;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
  findings: GpuValidationFinding[];
}

export interface GpuSourceCostFact {
  gpuSourceCostFactId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  gpuClusterId?: string;
  gpuNodeId?: string;
  gpuDeviceId?: string;
  gpuPartitionId?: string;
  workloadRef?: GpuWorkloadRef;
  timeWindow?: GpuTimeWindow;
  costAmount: number;
  currency: string;
  costCategory:
    | 'cloud_billing'
    | 'opencost_gpu_cost'
    | 'hardware'
    | 'depreciation'
    | 'support'
    | 'power_cooling'
    | 'license'
    | 'operations'
    | 'uplift'
    | 'unknown';
  quantity?: number;
  unit?: string;
  sourceLabels?: Record<string, string>;
  findings?: GpuValidationFinding[];
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuSourceAllocationEvidence {
  gpuSourceAllocationEvidenceId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  evidenceType: 'opencost_allocation' | 'slurm_accounting' | 'kubernetes_request' | 'vcenter_vm_mapping' | 'cloud_billing_allocation' | 'offline_import';
  workloadRef?: GpuWorkloadRef;
  gpuClusterId?: string;
  gpuNodeId?: string;
  gpuDeviceId?: string;
  gpuPartitionId?: string;
  timeWindow: GpuTimeWindow;
  allocatedGpuCount?: number;
  gpuHours?: number;
  sourceCostAmount?: number;
  sourceCurrency?: string;
  sourceAggregation?: string;
  sourceLabels?: Record<string, string>;
  sourceAnnotations?: Record<string, string>;
  findings?: GpuValidationFinding[];
  rawSourceReference?: GpuRawSourceReference;
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuOptimizationSignal {
  gpuOptimizationSignalId: string;
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  sourceSystem: GpuSourceSystem;
  connectorId: string;
  signalType:
    | 'idle_gpu'
    | 'low_utilization'
    | 'overallocated_workload'
    | 'memory_underused'
    | 'expensive_model_mismatch'
    | 'mig_fragmentation'
    | 'vgpu_fragmentation'
    | 'slurm_queue_pressure'
    | 'failed_long_running_job'
    | 'cloud_burst_candidate'
    | 'onprem_reclaim_candidate'
    | 'breakeven_candidate'
    | 'capacity_risk'
    | 'missing_labels'
    | 'missing_owner'
    | 'missing_telemetry'
    | 'stale_dcgm'
    | 'high_cost_aix_candidate';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  status: GpuOptimizationSignalStatus;
  targetEntityType: string;
  targetEntityId: string;
  timeWindow?: GpuTimeWindow;
  estimatedSavingsAmount?: number;
  currency?: string;
  riskScore?: number;
  evidence: Record<string, unknown>;
  requiredAction: string;
  automationMode: 'advise_only' | 'approval_required' | 'automatable_by_consumer';
  provenance: GpuProvenance;
  confidence: GpuConfidence;
}

export interface GpuCoreEvent {
  eventId: string;
  eventType:
    | 'gpu.inventory.updated'
    | 'gpu.usage_fact.created'
    | 'gpu.telemetry_fact.created'
    | 'gpu.source_cost_fact.created'
    | 'gpu.source_allocation_evidence.created'
    | 'gpu.optimization_signal.created';
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  occurredAt: string;
  factIds: string[];
  payload?: Record<string, unknown>;
}

export interface GpuAixEvent {
  eventId: string;
  eventType:
    | 'gpu.aix.workload_observed'
    | 'gpu.aix.usage_fact.available'
    | 'gpu.aix.source_cost_evidence.available'
    | 'gpu.aix.optimization_signal.available';
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  occurredAt: string;
  workloadRef?: GpuWorkloadRef;
  aixRefs?: {
    aixRunId?: string;
    agentId?: string;
    workflowId?: string;
    modelId?: string;
    modelEndpointId?: string;
    approvalId?: string;
    projectId?: string;
  };
  factIds: string[];
  payload?: Record<string, unknown>;
}

export type GpuNormalizedFact =
  | GpuFactEnvelope<GpuCluster>
  | GpuFactEnvelope<GpuNode>
  | GpuFactEnvelope<GpuDevice>
  | GpuFactEnvelope<GpuPartition>
  | GpuFactEnvelope<GpuWorkloadRef>
  | GpuFactEnvelope<GpuTechnicalAttributionFact>
  | GpuFactEnvelope<GpuUsageFact>
  | GpuFactEnvelope<GpuTelemetryFact>
  | GpuFactEnvelope<GpuInventorySnapshot>
  | GpuFactEnvelope<GpuSourceCostFact>
  | GpuFactEnvelope<GpuSourceAllocationEvidence>
  | GpuFactEnvelope<GpuOptimizationSignal>
  | GpuFactEnvelope<GpuCoreEvent>
  | GpuFactEnvelope<GpuAixEvent>;
