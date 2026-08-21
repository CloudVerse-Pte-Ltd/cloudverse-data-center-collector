/** Platform-neutral contracts shared by data-centre connectors and GPU enrichers. */
export type ConnectorCapability =
  | 'AUTHENTICATE'
  | 'DESCRIBE_PLATFORM'
  | 'DISCOVER_PLANES'
  | 'DISCOVER_INVENTORY'
  | 'DESCRIBE_CAPACITY'
  | 'PROBE_COUNTERS'
  | 'COLLECT_UTILISATION';

export type ConnectorCapabilityStatus = 'READY' | 'BLOCKED' | 'NOT_APPLICABLE' | 'ERROR';
export type ConnectorErrorCategory =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'CONNECTIVITY'
  | 'RATE_LIMIT'
  | 'SOURCE_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_VERSION'
  | 'INTERNAL';

export interface ConnectorSourceReference {
  sourceObjectId?: string;
  sourceObjectType?: string;
  endpoint?: string;
  queryId?: string;
  pageTokenHash?: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectorProvenance {
  connectorId: string;
  connectorVersion: string;
  collectedAt: string;
  managementPlaneUid: string;
  collectionRunId: string;
  source: ConnectorSourceReference;
}

export interface ConnectorError {
  code: string;
  category: ConnectorErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  source?: ConnectorSourceReference;
  details?: Record<string, unknown>;
}

export interface ConnectorPage {
  /** Opaque source cursor; never an array offset synthesized by the adapter. */
  nextCursor?: string;
  sourcePageSize?: number;
  receivedCount: number;
  complete: boolean;
}

export interface ConnectorHealth {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  checkedAt: string;
  stale: boolean;
  message?: string;
}

export interface ConnectorCapabilityResult {
  capability: ConnectorCapability;
  status: ConnectorCapabilityStatus;
  evidenceEligibleAt?: string;
  diagnostics?: Record<string, unknown>;
  provenance: ConnectorProvenance;
}

export interface ConnectorResult<TRecord> {
  records: TRecord[];
  errors: ConnectorError[];
  page: ConnectorPage;
  health: ConnectorHealth;
  provenance: ConnectorProvenance;
  capabilities?: ConnectorCapabilityResult[];
}

export interface ConnectorCollectionContext {
  tenantId: string;
  orgId: string;
  integrationId: string;
  collectionRunId: string;
  managementPlaneUid: string;
  requestedWindow?: { start: string; end: string };
  cursor?: string;
  abortSignal?: AbortSignal;
}

export interface DataCenterConnector<TConfig, TRecord> {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly ConnectorCapability[];
  validateConfig(config: TConfig): Promise<void>;
  collect(config: TConfig, context: ConnectorCollectionContext): Promise<ConnectorResult<TRecord>>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export function retryDelayMs(policy: RetryPolicy, attempt: number, random = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jitter = exponential * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

export function assertConnectorResult<T>(result: ConnectorResult<T>): ConnectorResult<T> {
  if (result.page.complete === Boolean(result.page.nextCursor)) {
    throw new Error('complete pages must not have a cursor; incomplete pages must have one');
  }
  if (result.page.receivedCount !== result.records.length) {
    throw new Error('receivedCount must equal records.length');
  }
  if (!result.provenance.collectionRunId || !result.provenance.managementPlaneUid) {
    throw new Error('connector provenance must identify the run and management plane');
  }
  return result;
}
