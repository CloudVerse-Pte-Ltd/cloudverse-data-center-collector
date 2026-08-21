import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedCollectorLookup, EncryptedBundleQueue, OnPremCollectorWorker, redactCollectorError, validateCollectorEndpoint } from '../../src/on-prem-collector/index.js';

const directories: string[] = [];
const key = Buffer.alloc(32, 7);
async function queue(overrides: Partial<ConstructorParameters<typeof EncryptedBundleQueue>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cv-collector-')); directories.push(directory);
  const value = new EncryptedBundleQueue({ directory, encryptionKey: key, maxBytes: 1_000_000, maxItems: 10, acceptedSchemaVersions: ['1.0', '0.9'], now: () => new Date('2026-08-21T00:00:00Z'), ...overrides });
  await value.initialize(); return { value, directory };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('on-prem collector distribution runtime', () => {
  it('encrypts payload and metadata at rest with restrictive permissions', async () => {
    const { value, directory } = await queue();
    await value.enqueue('bundle-secret-id', '1.0', Buffer.from('customer inventory secret'));
    const [name] = await readdir(directory); const bytes = await readFile(join(directory, name));
    expect(bytes.toString()).not.toContain('bundle-secret-id');
    expect(bytes.toString()).not.toContain('customer inventory secret');
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect((await value.list())[0].payload.toString()).toBe('customer inventory secret');
  });

  it('fails authentication when a queued ciphertext is tampered', async () => {
    const { value, directory } = await queue(); await value.enqueue('bundle-1', '1.0', Buffer.from('payload'));
    const [name] = await readdir(directory); const path = join(directory, name); const wrapper = JSON.parse((await readFile(path)).toString());
    wrapper.ciphertext = `${wrapper.ciphertext.slice(0, -2)}AA`; await writeFile(path, JSON.stringify(wrapper));
    await expect(value.list()).rejects.toThrow();
  });

  it('rotates queued evidence atomically from an explicitly retained previous key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cv-collector-')); directories.push(directory);
    const oldKey = Buffer.alloc(32, 3); const newKey = Buffer.alloc(32, 4);
    const oldQueue = new EncryptedBundleQueue({ directory, encryptionKey: oldKey, maxBytes: 1_000_000, maxItems: 10, acceptedSchemaVersions: ['1.0', '0.9'] });
    await oldQueue.enqueue('bundle-before-rotation', '1.0', Buffer.from('signed-envelope'));
    const rotatingQueue = new EncryptedBundleQueue({ directory, encryptionKey: newKey, previousEncryptionKeys: [oldKey], maxBytes: 1_000_000, maxItems: 10, acceptedSchemaVersions: ['1.0', '0.9'] });
    await expect(rotatingQueue.rotateToPrimaryKey()).resolves.toEqual({ rotated: 1 });
    const primaryOnly = new EncryptedBundleQueue({ directory, encryptionKey: newKey, maxBytes: 1_000_000, maxItems: 10, acceptedSchemaVersions: ['1.0', '0.9'] });
    await expect(primaryOnly.list()).resolves.toEqual([expect.objectContaining({ bundleId: 'bundle-before-rotation', payload: Buffer.from('signed-envelope') })]);
    const oldOnly = new EncryptedBundleQueue({ directory, encryptionKey: oldKey, maxBytes: 1_000_000, maxItems: 10, acceptedSchemaVersions: ['1.0', '0.9'] });
    await expect(oldOnly.list()).rejects.toThrow('authentication failed');
  });

  it('applies hard item/byte backpressure instead of deleting old evidence', async () => {
    const { value } = await queue({ maxItems: 1 }); await value.enqueue('bundle-1', '1.0', Buffer.from('one'));
    await expect(value.enqueue('bundle-2', '1.0', Buffer.from('two'))).rejects.toThrow('COLLECTOR_SPOOL_BACKPRESSURE');
    expect(await value.usage()).toMatchObject({ items: 1 });
  });

  it('measures encrypted bytes and serializes concurrent admission at the hard bound', async () => {
    const { value } = await queue({ maxItems: 1, maxBytes: 20_000 });
    const settled = await Promise.allSettled([
      value.enqueue('bundle-1', '1.0', Buffer.alloc(2_000, 1)),
      value.enqueue('bundle-2', '1.0', Buffer.alloc(2_000, 2)),
    ]);
    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await value.usage()).toMatchObject({ items: 1 });

    const { value: byteBounded } = await queue({ maxBytes: 2_100 });
    await expect(byteBounded.enqueue('bundle-large', '1.0', Buffer.alloc(2_000))).rejects.toThrow('COLLECTOR_SPOOL_BACKPRESSURE');
    expect(await byteBounded.usage()).toEqual({ items: 0, bytes: 0 });
  });

  it('keeps retry metadata updates inside the hard encrypted-byte ceiling', async () => {
    const { value } = await queue({ maxBytes: 10_000 });
    await value.enqueue('bundle-1', '1.0', Buffer.alloc(1_000));
    const [item] = await value.list(); item.attempts = 4096; item.lastError = 'x'.repeat(1024);
    await value.update(item);
    expect((await value.usage()).bytes).toBeLessThanOrEqual(10_000);
  });

  it('rejects non-HTTPS, non-allowlisted and private-resolution endpoints', async () => {
    const publicResolver = vi.fn(async () => ['8.8.8.8']);
    await expect(validateCollectorEndpoint('http://ingest.example.com', ['ingest.example.com'], [], publicResolver)).rejects.toThrow('HTTPS');
    await expect(validateCollectorEndpoint('https://evil.example.com', ['ingest.example.com'], [], publicResolver)).rejects.toThrow('allowlisted');
    await expect(validateCollectorEndpoint('https://ingest.example.com', ['ingest.example.com'], [], async () => ['127.0.0.1'])).rejects.toThrow('private');
    await expect(validateCollectorEndpoint('https://ingest.example.com', ['ingest.example.com'], [], async () => ['::ffff:127.0.0.1'])).rejects.toThrow('private');
    await expect(validateCollectorEndpoint('https://ingest.example.com', ['ingest.example.com'], [], async () => ['100.64.0.1'])).rejects.toThrow('private');
    await expect(validateCollectorEndpoint('https://ingest.example.com', ['ingest.example.com'], [], async () => ['ff02::1'])).rejects.toThrow('private');
    await expect(validateCollectorEndpoint('https://ingest.example.com', ['ingest.example.com'], ['ingest.example.com'], async () => ['10.0.0.5'])).resolves.toBeInstanceOf(URL);
  });

  it('uploads identical signed bytes outbound and removes only acknowledged items', async () => {
    const { value } = await queue(); const payload = Buffer.from('signed-bundle-bytes');
    await value.enqueue('bundle-1', '1.0', payload);
    const sender = vi.fn(async (_url: URL, init: any) => ({ ok: true, status: 202 }));
    const worker = new OnPremCollectorWorker(value, { endpoint: 'https://ingest.example.com/bundles', allowedHosts: ['ingest.example.com'] }, async () => ['8.8.8.8'], sender as any);
    await expect(worker.flushOnce(new Date('2026-08-21T00:00:00Z'))).resolves.toMatchObject({ examined: 1, sent: 1 });
    expect(Buffer.from(sender.mock.calls[0][1].body).equals(payload)).toBe(true);
    expect(sender.mock.calls[0][1].headers).toMatchObject({ 'content-type': 'application/json', 'x-bundle-id': 'bundle-1', 'x-bundle-schema-version': '1.0' });
    expect(await value.usage()).toMatchObject({ items: 0 });
  });

  it('pins the approved DNS result into the transport dispatcher to prevent rebinding', async () => {
    const { value } = await queue(); await value.enqueue('bundle-1', '1.0', Buffer.from('signed-bundle'));
    const sender = vi.fn(async (_url: URL, init: any) => {
      const dispatcher = init.dispatcher as any;
      expect(dispatcher).toBeDefined();
      expect(dispatcher.constructor.name).toBe('Agent');
      return { ok: true, status: 202 };
    });
    const resolver = vi.fn(async () => ['8.8.8.8']);
    const worker = new OnPremCollectorWorker(value, { endpoint: 'https://ingest.example.com', allowedHosts: ['ingest.example.com'] }, resolver, sender as any);
    await worker.flushOnce();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledTimes(1);
    const lookup = createPinnedCollectorLookup(['8.8.8.8', '2606:4700:4700::1111']);
    await expect(new Promise((resolve, reject) => lookup('rebound.example', { all: true }, (error: Error | null, records: unknown) => error ? reject(error) : resolve(records))))
      .resolves.toEqual([{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  });

  it('retains outages with bounded exponential retry and redacted health', async () => {
    const { value } = await queue(); await value.enqueue('bundle-1', '1.0', Buffer.from('payload'));
    const sender = vi.fn(async () => { throw new Error('proxy-authorization: Basic-secret password=hunter2'); });
    const worker = new OnPremCollectorWorker(value, { endpoint: 'https://ingest.example.com', allowedHosts: ['ingest.example.com'] }, async () => ['8.8.8.8'], sender as any);
    const now = new Date('2026-08-21T00:00:00Z'); await worker.flushOnce(now);
    const [item] = await value.list();
    expect(item).toMatchObject({ attempts: 1, nextAttemptAt: '2026-08-21T00:00:02.000Z' });
    expect(item.lastError).not.toContain('Basic-secret'); expect(item.lastError).not.toContain('hunter2');
    expect(await worker.health()).toMatchObject({ healthy: false, queue: { items: 1 }, incompatible: 0 });
  });

  it('records DNS/endpoint outages as unhealthy and recovers without losing the queued bundle', async () => {
    const { value } = await queue(); await value.enqueue('bundle-1', '1.0', Buffer.from('payload'));
    let outage = true;
    const resolver = vi.fn(async () => { if (outage) throw new Error('DNS token=resolver-secret'); return ['8.8.8.8']; });
    const sender = vi.fn(async () => ({ ok: true, status: 202 }));
    const worker = new OnPremCollectorWorker(value, { endpoint: 'https://ingest.example.com', allowedHosts: ['ingest.example.com'] }, resolver, sender as any);
    const start = new Date('2026-08-21T00:00:00Z');
    await expect(worker.flushOnce(start)).resolves.toMatchObject({ examined: 1, sent: 0 });
    expect(await worker.health()).toMatchObject({ healthy: false, queue: { items: 1 }, lastError: expect.stringContaining('[REDACTED]') });
    expect((await value.list())[0]).toMatchObject({ attempts: 1, nextAttemptAt: '2026-08-21T00:00:02.000Z' });
    outage = false;
    await expect(worker.flushOnce(new Date('2026-08-21T00:00:01Z'))).resolves.toMatchObject({ deferred: 1, sent: 0 });
    await expect(worker.flushOnce(new Date('2026-08-21T00:00:02Z'))).resolves.toMatchObject({ sent: 1 });
    expect(await worker.health()).toMatchObject({ healthy: true, queue: { items: 0 }, lastError: null });
  });

  it('keeps incompatible future bundles encrypted while current and N-1 remain exportable', async () => {
    const { value } = await queue();
    await value.enqueue('current', '1.0', Buffer.from('current')); await value.enqueue('previous', '0.9', Buffer.from('previous')); await value.enqueue('future', '2.0', Buffer.from('future'));
    const sender = vi.fn(async () => ({ ok: true, status: 202 }));
    const worker = new OnPremCollectorWorker(value, { endpoint: 'https://ingest.example.com', allowedHosts: ['ingest.example.com'] }, async () => ['8.8.8.8'], sender as any);
    await expect(worker.flushOnce()).resolves.toMatchObject({ sent: 2, incompatible: 1 });
    expect((await worker.exportOffline()).map((item) => item.bundleId)).toEqual(['future']);
    expect(await worker.health()).toMatchObject({ healthy: false, incompatible: 1 });
  });

  it('redacts URL and header-style credentials', () => {
    expect(redactCollectorError('https://user:pass@proxy.local token=abc secret:xyz')).toBe('https://[REDACTED]@proxy.local token=[REDACTED] secret=[REDACTED]');
  });
});
