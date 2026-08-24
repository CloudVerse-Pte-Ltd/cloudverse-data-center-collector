import type { ConnectorCapabilityResult, ConnectorCollectionContext, ConnectorResult, DataCenterConnector } from '../../connector-sdk/index.js';
import type { VCenterConnectorConfig } from './config.js';
import {
  collectWithPropertyCollector,
  collectVCenterPerformance,
  discoverVCenterServiceIdentity,
  probeVCenterPerformanceCounters,
  toVCenterInventoryEnvelope,
  toVCenterTelemetryEnvelope,
  VCENTER_CANONICAL_SEMANTIC,
  type VCenterInventoryEnvelope,
  type VCenterTelemetryEnvelope,
} from './vcenter-property-collector.js';

export interface VCenterInEstateAdapterConfig extends VCenterConnectorConfig {
  baseUrl: string;
  auth: { basic: { username: string; password: string } };
  propertyPageSize?: number;
  performance?: {
    /** Source semantic counters to request after probing this estate. */
    semantics?: string[];
    /** Historical PerfInterval key. Its samplingPeriod, not this key, is sent to QueryPerf. */
    intervalKey?: number;
  };
}

export class VCenterInEstateAdapter implements DataCenterConnector<VCenterInEstateAdapterConfig, VCenterInventoryEnvelope | VCenterTelemetryEnvelope> {
  readonly id = 'vcenter-property-collector';
  readonly version = '1.0.0';
  readonly capabilities = ['AUTHENTICATE', 'DESCRIBE_PLATFORM', 'DISCOVER_PLANES', 'DISCOVER_INVENTORY', 'PROBE_COUNTERS', 'COLLECT_UTILISATION'] as const;

  constructor(private readonly fetchImpl?: typeof fetch) {}

  async validateConfig(config: VCenterInEstateAdapterConfig): Promise<void> {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('vCenter collector endpoint must be credential-free HTTPS');
    if (!config.auth?.basic?.username?.trim() || !config.auth.basic.password) throw new Error('vCenter collector requires a read-only basic-auth secret reference');
    if (config.propertyPageSize !== undefined && (!Number.isSafeInteger(config.propertyPageSize) || config.propertyPageSize < 1 || config.propertyPageSize > 5_000)) {
      throw new Error('vCenter PropertyCollector page size must be between 1 and 5000');
    }
    if (config.performance?.intervalKey !== undefined && (!Number.isSafeInteger(config.performance.intervalKey) || config.performance.intervalKey < 1)) {
      throw new Error('vCenter performance interval key must be a positive integer');
    }
    if (config.performance?.semantics && (config.performance.semantics.length < 1 || config.performance.semantics.length > 100 || config.performance.semantics.some((semantic) => !semantic.trim() || !(semantic in VCENTER_CANONICAL_SEMANTIC)))) {
      throw new Error('vCenter performance semantics must use the supported canonical mapping');
    }
  }

  async collect(config: VCenterInEstateAdapterConfig, context: ConnectorCollectionContext): Promise<ConnectorResult<VCenterInventoryEnvelope | VCenterTelemetryEnvelope>> {
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
      source: { sourceObjectType: 'PropertyCollector', metadata: {
        pages: inventory.pages,
        ...(identity.version ? { version: identity.version } : {}),
        ...(identity.build ? { build: identity.build } : {}),
        ...(identity.apiType ? { apiType: identity.apiType } : {}),
      } },
    };
    const records: Array<VCenterInventoryEnvelope | VCenterTelemetryEnvelope> = [envelope];
    const capabilities: ConnectorCapabilityResult[] = this.capabilities.slice(0, 4).map((capability) => ({
      capability,
      status: 'READY' as const,
      evidenceEligibleAt: collectedAt,
      provenance,
      diagnostics: capability === 'DISCOVER_INVENTORY'
        ? { pages: inventory.pages, resources: envelope.resources.length, relationships: envelope.relationships.length }
        : { version: identity.version, build: identity.build },
    }));
    if (context.requestedWindow) {
      const probe = await probeVCenterPerformanceCounters({ baseUrl: config.baseUrl, ...credentials, fetchImpl: this.fetchImpl });
      capabilities.push({ capability: 'PROBE_COUNTERS', status: probe.capability.status, evidenceEligibleAt: collectedAt, provenance, diagnostics: probe.capability.diagnostics });
      const windowSeconds = (Date.parse(context.requestedWindow.end) - Date.parse(context.requestedWindow.start)) / 1_000;
      const configuredInterval = config.performance?.intervalKey === undefined ? undefined : probe.intervals.find((interval) => interval.key === config.performance?.intervalKey);
      const interval = configuredInterval ?? probe.intervals
        .filter((candidate) => candidate.enabled && candidate.lengthSeconds >= windowSeconds)
        .sort((left, right) => left.samplingPeriodSeconds - right.samplingPeriodSeconds)[0];
      const desiredSemantics = config.performance?.semantics ?? Object.keys(VCENTER_CANONICAL_SEMANTIC);
      const semantics = interval ? desiredSemantics.filter((semantic) => probe.counters.some((counter) => counter.semantic === semantic && counter.level <= interval.level)) : [];
      if (probe.capability.status !== 'READY' || !interval?.enabled || !Number.isFinite(windowSeconds) || windowSeconds <= 0 || interval.lengthSeconds < windowSeconds || !semantics.length) {
        capabilities.push({ capability: 'COLLECT_UTILISATION', status: 'BLOCKED', evidenceEligibleAt: collectedAt, provenance, diagnostics: { reason: probe.capability.status !== 'READY' ? 'counter_catalogue_unavailable' : !interval?.enabled || !Number.isFinite(windowSeconds) || windowSeconds <= 0 || interval.lengthSeconds < windowSeconds ? 'historical_interval_unavailable' : 'mapped_counters_unavailable_at_interval_level', requestedWindow: context.requestedWindow, desiredSemantics, availableSemantics: semantics } });
      } else {
        const resourceById = new Map(envelope.resources.map((resource) => [resource.id, resource]));
        const entities = inventory.objects.flatMap((object) => {
          if (object.type !== 'VirtualMachine' && object.type !== 'HostSystem') return [];
          const resource = resourceById.get(`${object.type}:${object.value}`);
          if (!resource || resource.kind === 'TEMPLATE') return [];
          return [{ type: object.type as 'VirtualMachine' | 'HostSystem', value: object.value, assetId: resource.sourceUid }];
        });
        const performance = await collectVCenterPerformance({
          baseUrl: config.baseUrl,
          ...credentials,
          fetchImpl: this.fetchImpl,
          probe,
          entities,
          semantics,
          startTime: context.requestedWindow.start,
          endTime: context.requestedWindow.end,
          intervalId: interval.key,
        });
        records.push(toVCenterTelemetryEnvelope({ integrationId: Number(context.integrationId), managementPlaneUid, metricSet: 'vsphere.performance', expectedStart: context.requestedWindow.start, expectedEnd: context.requestedWindow.end, facts: performance.facts, gaps: performance.gaps }));
        capabilities.push({ capability: 'COLLECT_UTILISATION', status: 'READY', evidenceEligibleAt: collectedAt, provenance, diagnostics: { entities: entities.length, requests: performance.requests, points: performance.points, gaps: performance.gaps.length, intervalKey: interval.key, samplingPeriodSeconds: interval.samplingPeriodSeconds } });
      }
    }
    return {
      records,
      errors: [],
      page: { receivedCount: records.length, complete: true, ...(config.propertyPageSize === undefined ? {} : { sourcePageSize: config.propertyPageSize }) },
      health: { status: 'HEALTHY', checkedAt: collectedAt, stale: false },
      provenance,
      capabilities,
    };
  }
}
