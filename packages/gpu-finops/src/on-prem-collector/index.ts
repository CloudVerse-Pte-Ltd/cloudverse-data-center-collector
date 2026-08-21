import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { redactCollectorError } from './redaction.js';

export interface CollectorQueueConfig {
  directory: string;
  encryptionKey: Buffer;
  previousEncryptionKeys?: Buffer[];
  maxBytes: number;
  maxItems: number;
  acceptedSchemaVersions: string[];
  now?: () => Date;
}
export interface CollectorTransportConfig {
  endpoint: string;
  allowedHosts: string[];
  privateAddressAllowedHosts?: string[];
  bearerToken?: string;
  proxyUrl?: string;
  proxyAllowedHosts?: string[];
  privateProxyAddressAllowedHosts?: string[];
}
export interface QueuedBundle {
  queueId: string; bundleId: string; schemaVersion: string; createdAt: string; attempts: number;
  nextAttemptAt: string; payload: Buffer; lastError?: string;
}
type Resolver = (host: string) => Promise<string[]>;
type Sender = (endpoint: URL, init: Parameters<typeof undiciFetch>[1]) => ReturnType<typeof undiciFetch>;

const privateAddress = (address: string) => {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) return privateAddress(normalized.slice(7))
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  return octets.some((value) => value < 0 || value > 255) || octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && [0, 2, 168].includes(octets[1])) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51)) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) || octets[0] >= 224;
};
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);
const QUEUED_ITEM_MUTATION_RESERVE_BYTES = 4096

export async function validateCollectorEndpoint(
  endpoint: string,
  allowedHosts: string[],
  privateAddressAllowedHosts: string[] = [],
  resolver: Resolver = defaultResolver,
) {
  return (await resolveCollectorEndpoint(endpoint, allowedHosts, privateAddressAllowedHosts, resolver)).url
}

async function resolveCollectorEndpoint(
  endpoint: string,
  allowedHosts: string[],
  privateAddressAllowedHosts: string[] = [],
  resolver: Resolver = defaultResolver,
) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Collector endpoint must be credential-free HTTPS');
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.map((item) => item.toLowerCase()).includes(host)) throw new Error('Collector endpoint host is not allowlisted');
  const addresses = await resolver(host);
  if (!addresses.length) throw new Error('Collector endpoint did not resolve');
  if (addresses.some(privateAddress) && !privateAddressAllowedHosts.map((item) => item.toLowerCase()).includes(host)) {
    throw new Error('Collector endpoint resolves to a prohibited private or link-local address');
  }
  return { url, addresses };
}

export const createPinnedCollectorLookup = (addresses: string[]) => (_hostname: string, options: any, callback: (...args: any[]) => void) => {
  const records = addresses.map((address) => ({ address, family: isIP(address) }))
  if (options?.all) callback(null, records)
  else callback(null, records[0].address, records[0].family)
}

export class EncryptedBundleQueue {
  private mutationTail: Promise<void> = Promise.resolve();
  constructor(private readonly config: CollectorQueueConfig) {
    if (config.encryptionKey.length !== 32) throw new Error('Collector spool key must be exactly 32 bytes');
    if ((config.previousEncryptionKeys?.length ?? 0) > 2) throw new Error('At most two previous collector spool keys are allowed');
    if (config.previousEncryptionKeys?.some((key) => key.length !== 32)) throw new Error('Previous collector spool keys must be exactly 32 bytes');
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0 || !Number.isSafeInteger(config.maxItems) || config.maxItems <= 0) throw new Error('Positive queue bounds are required');
  }
  async initialize() { await mkdir(this.config.directory, { recursive: true, mode: 0o700 }); await chmod(this.config.directory, 0o700); }
  async enqueue(bundleId: string, schemaVersion: string, payload: Buffer) {
    if (!bundleId || !schemaVersion || !payload.length) throw new Error('Bundle identity, schema version and payload are required');
    return this.exclusive(async () => {
      await this.initialize(); const usage = await this.usage();
      const now = this.config.now?.() ?? new Date();
      if (!Number.isFinite(now.valueOf())) throw new Error('Collector queue clock returned an invalid date');
      const queueId = `${now.valueOf().toString().padStart(13, '0')}-${randomUUID()}`;
      const item: QueuedBundle = { queueId, bundleId, schemaVersion, createdAt: now.toISOString(), attempts: 0, nextAttemptAt: now.toISOString(), payload };
      const wrapper = this.encrypt(item);
      const reservedAfterAdmission = (usage.items + 1) * QUEUED_ITEM_MUTATION_RESERVE_BYTES
      if (usage.items >= this.config.maxItems || usage.bytes + wrapper.length + reservedAfterAdmission > this.config.maxBytes) throw new Error('COLLECTOR_SPOOL_BACKPRESSURE');
      await this.writeBytes(queueId, wrapper); return { queueId, bundleId };
    });
  }
  async list(): Promise<QueuedBundle[]> {
    await this.initialize(); const names = (await readdir(this.config.directory)).filter((name) => name.endsWith('.bundle')).sort();
    const items: QueuedBundle[] = [];
    for (const name of names) items.push(await this.decrypt(await readFile(join(this.config.directory, name))));
    return items;
  }
  async update(item: QueuedBundle) {
    return this.exclusive(async () => {
      const wrapper = this.encrypt(item); const usage = await this.usage()
      const existing = await stat(this.path(item.queueId))
      if (usage.bytes - existing.size + wrapper.length > this.config.maxBytes) throw new Error('COLLECTOR_SPOOL_BACKPRESSURE')
      await this.writeBytes(item.queueId, wrapper)
    })
  }
  async rotateToPrimaryKey() {
    return this.exclusive(async () => {
      const items = await this.list()
      for (const item of items) await this.write(item)
      return { rotated: items.length }
    })
  }
  async remove(queueId: string) { if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(queueId)) throw new Error('Invalid queue ID'); await unlink(this.path(queueId)); }
  async usage() {
    await this.initialize(); const names = (await readdir(this.config.directory)).filter((name) => name.endsWith('.bundle'));
    let bytes = 0; for (const name of names) bytes += (await stat(join(this.config.directory, name))).size;
    return { items: names.length, bytes };
  }
  accepts(schemaVersion: string) { return this.config.acceptedSchemaVersions.includes(schemaVersion); }
  private async write(item: QueuedBundle) {
    await this.writeBytes(item.queueId, this.encrypt(item));
  }
  private encrypt(item: QueuedBundle) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    const plain = Buffer.from(JSON.stringify({ ...item, payload: item.payload.toString('base64') }));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]); const tag = cipher.getAuthTag();
    return Buffer.from(JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') }));
  }
  private async writeBytes(queueId: string, wrapper: Buffer) {
    const target = this.path(queueId); const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(wrapper); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target); await chmod(target, 0o600);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail; let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private decrypt(wrapperBytes: Buffer): QueuedBundle {
    const wrapper = JSON.parse(wrapperBytes.toString()) as { v: number; iv: string; tag: string; ciphertext: string };
    if (wrapper.v !== 1) throw new Error('Unsupported encrypted spool envelope');
    for (const key of [this.config.encryptionKey, ...(this.config.previousEncryptionKeys ?? [])]) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapper.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(wrapper.tag, 'base64'));
        const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(wrapper.ciphertext, 'base64')), decipher.final()]).toString());
        return { ...decoded, payload: Buffer.from(decoded.payload, 'base64') };
      } catch { /* Try the bounded, explicitly configured previous-key set. */ }
    }
    throw new Error('Collector spool authentication failed for every configured key')
  }
  private path(queueId: string) { return join(this.config.directory, `${queueId}.bundle`); }
}

export class OnPremCollectorWorker {
  private lastSuccessAt?: string; private lastError?: string;
  constructor(private readonly queue: EncryptedBundleQueue, private readonly config: CollectorTransportConfig, private readonly resolver: Resolver = defaultResolver, private readonly sender: Sender = undiciFetch) {}
  async flushOnce(now = new Date()) {
    const items = await this.queue.list(); let sent = 0; let incompatible = 0; let deferred = 0;
    let endpoint: URL; let endpointAddresses: string[]; let proxyAddresses: string[] | undefined
    try {
      const resolved = await resolveCollectorEndpoint(this.config.endpoint, this.config.allowedHosts, this.config.privateAddressAllowedHosts, this.resolver)
      endpoint = resolved.url; endpointAddresses = resolved.addresses
      if (this.config.proxyUrl) {
        const proxy = new URL(this.config.proxyUrl);
        if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Collector proxy must use HTTP or HTTPS');
        const resolvedProxy = await resolveCollectorEndpoint(
          `https://${proxy.hostname}`,
          this.config.proxyAllowedHosts ?? [],
          this.config.privateProxyAddressAllowedHosts,
          this.resolver,
        );
        proxyAddresses = resolvedProxy.addresses
      }
    } catch (error) {
      const message = redactCollectorError(error)
      for (const item of items) {
        if (!this.queue.accepts(item.schemaVersion)) { incompatible += 1; continue }
        if (new Date(item.nextAttemptAt) > now) { deferred += 1; continue }
        await this.defer(item, now, message)
      }
      this.lastError = message
      return { examined: items.length, sent, incompatible, deferred }
    }
    const dispatcher = this.config.proxyUrl
      ? new ProxyAgent({ uri: this.config.proxyUrl, proxyTls: { lookup: createPinnedCollectorLookup(proxyAddresses!) } })
      : new Agent({ connect: { lookup: createPinnedCollectorLookup(endpointAddresses) } })
    try { for (const item of items) {
      if (!this.queue.accepts(item.schemaVersion)) { incompatible += 1; continue; }
      if (new Date(item.nextAttemptAt) > now) { deferred += 1; continue; }
      try {
        const response = await this.sender(endpoint, {
          method: 'POST', dispatcher,
          headers: { 'content-type': 'application/json', 'x-bundle-id': item.bundleId, 'x-bundle-schema-version': item.schemaVersion, ...(this.config.bearerToken ? { authorization: `Bearer ${this.config.bearerToken}` } : {}) },
          body: item.payload,
        });
        if (!response.ok) throw new Error(`Collector upload returned HTTP ${response.status}`);
        await this.queue.remove(item.queueId); sent += 1; this.lastSuccessAt = now.toISOString(); this.lastError = undefined;
      } catch (error) {
        await this.defer(item, now, redactCollectorError(error)); this.lastError = item.lastError;
      }
    } } finally { await dispatcher.close() }
    return { examined: items.length, sent, incompatible, deferred };
  }
  async health() {
    const usage = await this.queue.usage(); const items = await this.queue.list();
    return { healthy: !this.lastError && items.every((item) => this.queue.accepts(item.schemaVersion)), queue: usage, oldestQueuedAt: items[0]?.createdAt ?? null, incompatible: items.filter((item) => !this.queue.accepts(item.schemaVersion)).length, lastSuccessAt: this.lastSuccessAt ?? null, lastError: this.lastError ?? null };
  }
  async exportOffline(): Promise<Array<{ bundleId: string; schemaVersion: string; payload: Buffer }>> {
    return (await this.queue.list()).map(({ bundleId, schemaVersion, payload }) => ({ bundleId, schemaVersion, payload }));
  }
  private async defer(item: QueuedBundle, now: Date, message: string) {
    item.attempts += 1; item.lastError = message
    item.nextAttemptAt = new Date(now.valueOf() + Math.min(3_600_000, 1000 * 2 ** Math.min(item.attempts, 12))).toISOString()
    await this.queue.update(item)
  }
}

export * from './signed-bundle.js';
export * from './supervisor.js';
export * from './enrollment.js';
export * from './control-plane-client.js';
export * from './redaction.js';
