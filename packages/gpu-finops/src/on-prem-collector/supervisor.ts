import { assertConnectorResult, type ConnectorCapabilityResult, type ConnectorCollectionContext, type ConnectorError, type ConnectorResult } from '../connector-sdk/index.js';
import type { EncryptedBundleQueue } from './index.js';
import { DataCenterBundleSigner, type SignedDataCenterBundle } from './signed-bundle.js';
import { redactCollectorError } from './redaction.js';

export interface CollectorRunAssignment {
  orgId: number;
  integrationId: number;
  collectionRunId: string;
  managementPlaneUid: string;
  scaleClass: 'S' | 'M' | 'L' | 'XL';
  requestedWindow?: { start: string; end: string };
}

export interface InEstateCollectorAdapter<TConfig = unknown, TRecord = unknown> {
  id: string;
  version: string;
  validateConfig(config: TConfig): Promise<void>;
  collect(config: TConfig, context: ConnectorCollectionContext): Promise<ConnectorResult<TRecord>>;
}

export interface CollectorSupervisorResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  pages: number;
  records: number;
  errors: number;
  bundles: Array<Pick<SignedDataCenterBundle, 'bundleId' | 'nonce'>>;
}

const MAX_PAGES = 10_000;
const MAX_RECORDS = 1_000_000;

function telemetryCounts(records: unknown[]) {
  let metrics = 0;
  let gaps = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || (record as { type?: unknown }).type !== 'DATA_CENTER_METRICS') continue;
    const telemetry = record as { metrics?: unknown; gaps?: unknown };
    metrics += Array.isArray(telemetry.metrics) ? telemetry.metrics.length : 0;
    gaps += Array.isArray(telemetry.gaps) ? telemetry.gaps.length : 0;
  }
  return { metrics, gaps };
}

/** Runs native adapters inside the estate and emits only signed canonical bundles. */
export class InEstateCollectorSupervisor {
  constructor(
    private readonly queue: EncryptedBundleQueue,
    private readonly signer: DataCenterBundleSigner,
  ) {}

  async run<TConfig, TRecord>(assignment: CollectorRunAssignment, adapter: InEstateCollectorAdapter<TConfig, TRecord>, config: TConfig): Promise<CollectorSupervisorResult> {
    if (!Number.isSafeInteger(assignment.orgId) || assignment.orgId <= 0 || !Number.isSafeInteger(assignment.integrationId) || assignment.integrationId <= 0 || !assignment.managementPlaneUid.trim() || !['S', 'M', 'L', 'XL'].includes(assignment.scaleClass)) {
      throw new Error('Collector run assignment is invalid');
    }
    let cursor: string | undefined;
    let pages = 0;
    let records = 0;
    let metrics = 0;
    let gaps = 0;
    const errors: ConnectorError[] = [];
    const capabilities: ConnectorCapabilityResult[] = [];
    const bundles: Array<Pick<SignedDataCenterBundle, 'bundleId' | 'nonce'>> = [];
    const seenCursors = new Set<string>();
    try {
      await adapter.validateConfig(config);
      do {
        if (pages >= MAX_PAGES) throw new Error('Collector run exceeds the page safety limit');
        const result = assertConnectorResult(await adapter.collect(config, {
          tenantId: String(assignment.orgId),
          orgId: String(assignment.orgId),
          integrationId: String(assignment.integrationId),
          collectionRunId: assignment.collectionRunId,
          managementPlaneUid: assignment.managementPlaneUid,
          requestedWindow: assignment.requestedWindow,
          cursor,
        }));
        if (result.provenance.connectorId !== adapter.id || result.provenance.connectorVersion !== adapter.version || result.provenance.collectionRunId !== assignment.collectionRunId || result.provenance.managementPlaneUid !== assignment.managementPlaneUid) {
          throw new Error('Adapter provenance does not match the assigned connector run');
        }
        if (records + result.records.length > MAX_RECORDS) throw new Error('Collector run exceeds the record safety limit');
        const pageBundle = this.signer.create(assignment.collectionRunId, {
          records: result.records,
          capabilities: result.capabilities ?? [],
        });
        await this.queue.enqueue(pageBundle.bundleId, pageBundle.schemaVersion, Buffer.from(JSON.stringify(pageBundle)));
        bundles.push({ bundleId: pageBundle.bundleId, nonce: pageBundle.nonce });
        pages += 1;
        records += result.records.length;
        const telemetry = telemetryCounts(result.records);
        metrics += telemetry.metrics;
        gaps += telemetry.gaps;
        errors.push(...result.errors);
        capabilities.push(...(result.capabilities ?? []));
        cursor = result.page.complete ? undefined : result.page.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new Error('Collector adapter cursor cycle detected');
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      const status = errors.length ? 'PARTIAL' as const : 'SUCCEEDED' as const;
      const inventoryCapability = [...capabilities].reverse().find((result) => result.capability === 'DISCOVER_INVENTORY');
      const terminal = this.signer.create(assignment.collectionRunId, {
        records: [],
        completion: {
          status,
          recordCounts: { pages, records, metrics, gaps, errors: errors.length, capabilities: capabilities.length, scaleClass: assignment.scaleClass },
          errors,
          coverage: { requestedWindow: assignment.requestedWindow ?? null, inventoryCapabilityStatus: inventoryCapability?.status ?? null },
        },
      });
      await this.queue.enqueue(terminal.bundleId, terminal.schemaVersion, Buffer.from(JSON.stringify(terminal)));
      bundles.push({ bundleId: terminal.bundleId, nonce: terminal.nonce });
      return { status, pages, records, errors: errors.length, bundles };
    } catch (error) {
      const terminal = this.signer.create(assignment.collectionRunId, {
        records: [],
        completion: {
          status: 'FAILED',
          recordCounts: { pages, records, metrics, gaps, errors: errors.length + 1, capabilities: capabilities.length, scaleClass: assignment.scaleClass },
          errors: [...errors, { code: 'collector_run_failed', message: redactCollectorError(error), retryable: false }],
          coverage: { requestedWindow: assignment.requestedWindow ?? null },
        },
      });
      await this.queue.enqueue(terminal.bundleId, terminal.schemaVersion, Buffer.from(JSON.stringify(terminal)));
      bundles.push({ bundleId: terminal.bundleId, nonce: terminal.nonce });
      return { status: 'FAILED', pages, records, errors: errors.length + 1, bundles };
    }
  }
}
