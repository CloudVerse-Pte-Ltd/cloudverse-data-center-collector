import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalBundleJson,
  DataCenterBundleSigner,
  EncryptedBundleQueue,
  InEstateCollectorSupervisor,
} from '../../src/index.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cv-supervisor-'));
  directories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const queue = new EncryptedBundleQueue({
    directory,
    encryptionKey: Buffer.alloc(32, 7),
    maxBytes: 4 * 1024 * 1024,
    maxItems: 20,
    acceptedSchemaVersions: ['1.0'],
  });
  const signer = new DataCenterBundleSigner(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    { orgId: 9, collectorId: 'collector-1', signatureKeyId: 'key-1' },
  );
  return { queue, supervisor: new InEstateCollectorSupervisor(queue, signer), publicKey };
}

const assignment = {
  orgId: 9,
  integrationId: 7,
  collectionRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  managementPlaneUid: 'vcenter:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  scaleClass: 'S' as const,
};

describe('InEstateCollectorSupervisor', () => {
  it('pages a native adapter, signs each payload and queues terminal completion', async () => {
    const { queue, supervisor, publicKey } = await fixture();
    const adapter = {
      id: 'vcenter', version: '1.0.0',
      async validateConfig() {},
      async collect(_config: {}, context: any) {
        const second = context.cursor === 'next';
        const records: unknown[] = second
          ? [{ type: 'VSPHERE_INVENTORY', page: 2 }]
          : [{ type: 'DATA_CENTER_METRICS', metrics: [{ value: '1' }, { value: '2' }], gaps: [{ reasonClass: 'NO_SAMPLE' }] }];
        return {
          records,
          errors: [],
          page: { receivedCount: 1, complete: second, ...(second ? {} : { nextCursor: 'next' }) },
          health: { status: 'HEALTHY' as const, checkedAt: '2026-08-22T00:00:00Z', stale: false },
          provenance: { connectorId: 'vcenter', connectorVersion: '1.0.0', collectedAt: '2026-08-22T00:00:00Z', managementPlaneUid: assignment.managementPlaneUid, collectionRunId: assignment.collectionRunId, source: {} },
          capabilities: [{ capability: 'DISCOVER_INVENTORY' as const, status: 'READY' as const, evidenceEligibleAt: '2026-08-22T00:00:00Z', provenance: { connectorId: 'vcenter', connectorVersion: '1.0.0', collectedAt: '2026-08-22T00:00:00Z', managementPlaneUid: assignment.managementPlaneUid, collectionRunId: assignment.collectionRunId, source: {} } }],
        };
      },
    };
    await expect(supervisor.run(assignment, adapter, {})).resolves.toMatchObject({ status: 'SUCCEEDED', pages: 2, records: 2, errors: 0 });
    const queued = await queue.list();
    expect(queued).toHaveLength(3);
    const envelopes = queued.map((item) => JSON.parse(item.payload.toString()));
    for (const envelope of envelopes) {
      const { signature, ...unsigned } = envelope;
      expect(verify(null, Buffer.from(canonicalBundleJson(unsigned)), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    }
    expect(envelopes[2].payload.completion).toMatchObject({ status: 'SUCCEEDED', recordCounts: { pages: 2, records: 2, metrics: 2, gaps: 1 } });
    expect(envelopes[2].payload.completion.coverage).toMatchObject({ inventoryCapabilityStatus: 'READY' });
  });

  it('queues a signed FAILED completion when collection fails', async () => {
    const { queue, supervisor } = await fixture();
    const result = await supervisor.run(assignment, {
      id: 'vcenter', version: '1.0.0',
      async validateConfig() {},
      async collect() { throw new Error('source unavailable password=do-not-leak'); },
    }, {});
    expect(result).toMatchObject({ status: 'FAILED', pages: 0, records: 0, errors: 1 });
    const queued = await queue.list();
    const completion = JSON.parse(queued[0].payload.toString()).payload.completion;
    expect(completion.status).toBe('FAILED');
    expect(completion.errors[0].message).not.toContain('do-not-leak');
  });
});
