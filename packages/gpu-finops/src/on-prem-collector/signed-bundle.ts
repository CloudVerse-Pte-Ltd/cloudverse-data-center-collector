import { createPrivateKey, randomUUID, sign } from 'node:crypto';

export interface SignedDataCenterBundle {
  schemaVersion: '1.0';
  bundleId: string;
  nonce: string;
  orgId: number;
  collectorId: string;
  collectionRunId: string;
  createdAt: string;
  signatureKeyId: string;
  payload: unknown;
  signature: string;
}

const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 200_000;

export function canonicalBundleJson(value: unknown): string {
  const state = { nodes: 0 };
  const encode = (item: unknown, depth: number): string => {
    state.nodes += 1;
    if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) throw new Error('Bundle payload exceeds canonical structure bounds');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Bundle payload contains an unsupported value');
    const record = item as Record<string, unknown>;
    if (Object.values(record).some((entry) => entry === undefined)) throw new Error('Bundle payload contains undefined');
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(',')}}`;
  };
  return encode(value, 0);
}

export class DataCenterBundleSigner {
  private readonly privateKey;

  constructor(
    privateKeyPem: string,
    private readonly identity: { orgId: number; collectorId: string; signatureKeyId: string },
  ) {
    if (!Number.isSafeInteger(identity.orgId) || identity.orgId <= 0 || !identity.collectorId.trim() || !identity.signatureKeyId.trim()) {
      throw new Error('Collector signing identity is invalid');
    }
    this.privateKey = createPrivateKey(privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Collector signing key must be Ed25519');
  }

  create(collectionRunId: string, payload: unknown, now = new Date()): SignedDataCenterBundle {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(collectionRunId) || !Number.isFinite(now.valueOf())) {
      throw new Error('Collector run identity or clock is invalid');
    }
    const unsigned = {
      schemaVersion: '1.0' as const,
      bundleId: randomUUID(),
      nonce: randomUUID(),
      orgId: this.identity.orgId,
      collectorId: this.identity.collectorId,
      collectionRunId,
      createdAt: now.toISOString(),
      signatureKeyId: this.identity.signatureKeyId,
      payload,
    };
    const signature = sign(null, Buffer.from(canonicalBundleJson(unsigned), 'utf8'), this.privateKey).toString('base64');
    return { ...unsigned, signature };
  }
}
