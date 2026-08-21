import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface CollectorEnrollmentConfig {
  controlPlaneUrl: string;
  orgId: number;
  integrationId: number;
  provider: 'VSPHERE' | 'OPENSHIFT_VIRTUALIZATION' | 'HYPERV';
  enrollmentToken: string;
  stateDirectory: string;
}

export interface CollectorIdentity {
  collectorId: string;
  keyId: string;
  orgId: number;
  integrationId: number;
  provider: CollectorEnrollmentConfig['provider'];
  enrolledAt: string;
}

const atomicWrite = async (path: string, value: string, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode, flag: 'wx' });
  await rename(temporary, path);
};

export const collectorStatePaths = (directory: string) => ({
  identity: join(directory, 'identity.json'),
  signingPrivateKey: join(directory, 'signing-private.pem'),
  signingPublicKey: join(directory, 'signing-public.pem'),
  transportToken: join(directory, 'transport-token'),
  spoolKey: join(directory, 'spool-key'),
});

export async function enrollCollector(
  config: CollectorEnrollmentConfig,
  transport: typeof fetch = fetch,
): Promise<CollectorIdentity> {
  if (!Number.isSafeInteger(config.orgId) || config.orgId <= 0) throw new Error('orgId must be a positive integer');
  if (!Number.isSafeInteger(config.integrationId) || config.integrationId <= 0) throw new Error('integrationId must be a positive integer');
  const endpoint = new URL(config.controlPlaneUrl);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('collector enrollment requires HTTPS');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/enroll`;
  const paths = collectorStatePaths(config.stateDirectory);
  try {
    return JSON.parse(await readFile(paths.identity, 'utf8')) as CollectorIdentity;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const collectorId = `dc-${randomUUID()}`;
  const keyId = `key-${randomUUID()}`;
  const transportToken = randomBytes(32).toString('base64url');
  const transportTokenHash = createHash('sha256').update(transportToken).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  await atomicWrite(paths.signingPrivateKey, privateKeyPem);
  await atomicWrite(paths.signingPublicKey, publicKeyPem, 0o644);
  await atomicWrite(paths.transportToken, transportToken);
  await atomicWrite(paths.spoolKey, randomBytes(32).toString('base64'));

  const response = await transport(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orgId: config.orgId,
      integrationId: config.integrationId,
      enrollmentToken: config.enrollmentToken,
      collectorId,
      keyId,
      publicKeyPem,
      transportTokenHash,
    }),
  });
  if (!response.ok) {
    throw new Error(`collector enrollment failed with HTTP ${response.status}`);
  }
  const identity: CollectorIdentity = {
    collectorId,
    keyId,
    orgId: config.orgId,
    integrationId: config.integrationId,
    provider: config.provider,
    enrolledAt: new Date().toISOString(),
  };
  await atomicWrite(paths.identity, JSON.stringify(identity));
  return identity;
}

export async function destroyEnrollmentTokenFile(path?: string): Promise<void> {
  if (!path) return;
  await unlink(path).catch((error: any) => {
    // Kubernetes Secret volumes are immutable/read-only. The installer removes
    // the bootstrap Secret and volume reference after enrollment.
    if (error?.code !== 'ENOENT' && error?.code !== 'EROFS') throw error;
  });
}
