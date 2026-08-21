import type { GpuConnectorContext, GpuProvenance, GpuRawSourceReference } from '../interfaces/index.js';

export function createGpuProvenance(
  context: GpuConnectorContext,
  rawSourceReference: GpuRawSourceReference,
  metadata?: Record<string, unknown>,
): GpuProvenance {
  return {
    sourceSystem: context.sourceSystem,
    connectorId: context.connectorId,
    connectorVersion: context.connectorVersion,
    deploymentMode: context.deploymentMode,
    collectedAt: context.collectionWindow.end,
    sourceAccountOrClusterId: context.clusterId,
    sourceResourceId: rawSourceReference.externalId ?? rawSourceReference.objectName,
    rawSourceReference,
    metadata,
  };
}
