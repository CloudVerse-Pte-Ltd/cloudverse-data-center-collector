import type { ConnectorCollectionContext, ConnectorResult, DataCenterConnector } from '../../connector-sdk/index.js';
import type { VCenterConnectorConfig } from './config.js';
import {
  collectWithPropertyCollector,
  discoverVCenterServiceIdentity,
  toVCenterInventoryEnvelope,
  type VCenterInventoryEnvelope,
} from './vcenter-property-collector.js';

export interface VCenterInEstateAdapterConfig extends VCenterConnectorConfig {
  baseUrl: string;
  auth: { basic: { username: string; password: string } };
  propertyPageSize?: number;
}

export class VCenterInEstateAdapter implements DataCenterConnector<VCenterInEstateAdapterConfig, VCenterInventoryEnvelope> {
  readonly id = 'vcenter-property-collector';
  readonly version = '1.0.0';
  readonly capabilities = ['AUTHENTICATE', 'DESCRIBE_PLATFORM', 'DISCOVER_PLANES', 'DISCOVER_INVENTORY'] as const;

  constructor(private readonly fetchImpl?: typeof fetch) {}

  async validateConfig(config: VCenterInEstateAdapterConfig): Promise<void> {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('vCenter collector endpoint must be credential-free HTTPS');
    if (!config.auth?.basic?.username?.trim() || !config.auth.basic.password) throw new Error('vCenter collector requires a read-only basic-auth secret reference');
    if (config.propertyPageSize !== undefined && (!Number.isSafeInteger(config.propertyPageSize) || config.propertyPageSize < 1 || config.propertyPageSize > 5_000)) {
      throw new Error('vCenter PropertyCollector page size must be between 1 and 5000');
    }
  }

  async collect(config: VCenterInEstateAdapterConfig, context: ConnectorCollectionContext): Promise<ConnectorResult<VCenterInventoryEnvelope>> {
    await this.validateConfig(config);
    if (context.cursor) throw new Error('vCenter PropertyCollector performs source-native paging inside one collection');
    const collectedAt = new Date().toISOString();
    const credentials = config.auth.basic;
    const identity = await discoverVCenterServiceIdentity({ baseUrl: config.baseUrl, ...credentials, fetchImpl: this.fetchImpl });
    const managementPlaneUid = `vcenter:${identity.instanceUuid.toLowerCase()}`;
    if (managementPlaneUid !== context.managementPlaneUid.toLowerCase()) throw new Error('vCenter immutable ServiceInstance identity does not match the assigned integration');
    const inventory = await collectWithPropertyCollector({ baseUrl: config.baseUrl, ...credentials, fetchImpl: this.fetchImpl, pageSize: config.propertyPageSize });
    const envelope = toVCenterInventoryEnvelope({ integrationId: Number(context.integrationId), identity, collectedAt, result: inventory });
    const provenance = {
      connectorId: this.id,
      connectorVersion: this.version,
      collectedAt,
      managementPlaneUid,
      collectionRunId: context.collectionRunId,
      source: { sourceObjectType: 'PropertyCollector', metadata: { pages: inventory.pages, version: identity.version, build: identity.build, apiType: identity.apiType } },
    };
    return {
      records: [envelope],
      errors: [],
      page: { receivedCount: 1, complete: true, sourcePageSize: config.propertyPageSize },
      health: { status: 'HEALTHY', checkedAt: collectedAt, stale: false },
      provenance,
      capabilities: this.capabilities.map((capability) => ({
        capability,
        status: 'READY',
        evidenceEligibleAt: collectedAt,
        provenance,
        diagnostics: capability === 'DISCOVER_INVENTORY'
          ? { pages: inventory.pages, resources: envelope.resources.length, relationships: envelope.relationships.length }
          : { version: identity.version, build: identity.build },
      })),
    };
  }
}
