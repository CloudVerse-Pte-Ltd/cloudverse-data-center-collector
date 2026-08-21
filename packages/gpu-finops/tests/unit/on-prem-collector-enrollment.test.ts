import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectorStatePaths, enrollCollector } from '../../src/on-prem-collector/enrollment.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('collector enrollment', () => {
  it('generates local secrets and sends only public enrollment material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cv-enroll-'));
    directories.push(directory);
    let request: any;
    const identity = await enrollCollector({
      controlPlaneUrl: 'https://api.example.test/data-center-collector',
      orgId: 42,
      integrationId: 91,
      provider: 'VSPHERE',
      enrollmentToken: 'e'.repeat(43),
      stateDirectory: directory,
    }, async (url, init) => {
      request = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response('{}', { status: 201 });
    });

    expect(request.url).toBe('https://api.example.test/data-center-collector/enroll');
    expect(request.body.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(request.body).not.toHaveProperty('privateKeyPem');
    expect(request.body).not.toHaveProperty('transportToken');
    expect(request.body.transportTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const paths = collectorStatePaths(directory);
    expect(await readFile(paths.signingPrivateKey, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(await readFile(paths.transportToken, 'utf8')).toHaveLength(43);
    expect(JSON.parse(await readFile(paths.identity, 'utf8')).collectorId).toBe(identity.collectorId);
  });

  it('refuses plaintext remote enrollment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cv-enroll-'));
    directories.push(directory);
    await expect(enrollCollector({
      controlPlaneUrl: 'http://api.example.test',
      orgId: 1,
      integrationId: 2,
      provider: 'HYPERV',
      enrollmentToken: 'e'.repeat(43),
      stateDirectory: directory,
    })).rejects.toThrow('requires HTTPS');
  });
});
