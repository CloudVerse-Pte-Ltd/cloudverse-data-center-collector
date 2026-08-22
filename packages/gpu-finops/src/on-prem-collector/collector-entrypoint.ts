import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenShiftVirtualizationClient, OpenShiftVirtualizationInEstateAdapter } from '../connectors/openshift/index.js';
import { discoverVCenterServiceIdentity, VCenterInEstateAdapter } from '../connectors/vcenter/index.js';
import { collectorStatePaths, DataCenterBundleSigner, destroyEnrollmentTokenFile, EncryptedBundleQueue, enrollCollector, InEstateCollectorSupervisor, OnPremCollectorWorker, startCollectorRun } from './index.js';
import { collectorSpoolBudget } from './scale-budget.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const list = (name: string) => String(process.env[name] ?? '').split(',').map((item) => item.trim()).filter(Boolean);

async function main() {
  const stateDirectory = process.env.COLLECTOR_STATE_DIRECTORY ?? '/var/lib/cloudverse/identity';
  const statePaths = collectorStatePaths(stateDirectory);
  const enrollmentTokenFile = process.env.COLLECTOR_ENROLLMENT_TOKEN_FILE?.trim();
  const enrollmentToken = process.env.COLLECTOR_ENROLLMENT_TOKEN?.trim() ||
    (enrollmentTokenFile ? (await readFile(enrollmentTokenFile, 'utf8')).trim() : undefined);
  if (enrollmentToken) {
    const identity = await enrollCollector({
      controlPlaneUrl: required('COLLECTOR_CONTROL_PLANE_URL'),
      orgId: positive('COLLECTOR_ORG_ID', 0),
      integrationId: positive('COLLECTOR_INTEGRATION_ID', 0),
      provider: required('COLLECTOR_PROVIDER').toUpperCase() as 'VSPHERE' | 'OPENSHIFT_VIRTUALIZATION' | 'HYPERV',
      enrollmentToken,
      stateDirectory,
    });
    process.env.COLLECTOR_ID = identity.collectorId;
    process.env.COLLECTOR_SIGNATURE_KEY_ID = identity.keyId;
    await destroyEnrollmentTokenFile(enrollmentTokenFile);
    delete process.env.COLLECTOR_ENROLLMENT_TOKEN;
  }
  const identity = JSON.parse(await readFile(statePaths.identity, 'utf8')) as {
    collectorId: string;
    keyId: string;
    orgId: number;
    integrationId: number;
    provider: 'VSPHERE' | 'OPENSHIFT_VIRTUALIZATION' | 'HYPERV';
  };
  process.env.COLLECTOR_ID ||= identity.collectorId;
  process.env.COLLECTOR_SIGNATURE_KEY_ID ||= identity.keyId;
  const mode = String(process.env.COLLECTOR_MODE ?? 'CONNECTED').toUpperCase();
  if (!['CONNECTED', 'STORE_FORWARD', 'OFFLINE'].includes(mode)) throw new Error('COLLECTOR_MODE must be CONNECTED, STORE_FORWARD or OFFLINE');
  const key = Buffer.from((await readFile(process.env.COLLECTOR_SPOOL_KEY_FILE ?? statePaths.spoolKey, 'utf8')).trim(), 'base64');
  const spoolBudget = collectorSpoolBudget();
  const previousKeys = await Promise.all(list('COLLECTOR_PREVIOUS_SPOOL_KEY_FILES').map(async (path) => Buffer.from((await readFile(path, 'utf8')).trim(), 'base64')))
  const queue = new EncryptedBundleQueue({
    directory: process.env.COLLECTOR_SPOOL_DIRECTORY ?? '/var/lib/cloudverse/spool', encryptionKey: key, previousEncryptionKeys: previousKeys,
    maxBytes: spoolBudget.maxBytes, maxItems: positive('COLLECTOR_SPOOL_MAX_ITEMS', 10000),
    acceptedSchemaVersions: list('COLLECTOR_ACCEPTED_SCHEMA_VERSIONS').length ? list('COLLECTOR_ACCEPTED_SCHEMA_VERSIONS') : ['1.0', '0.9'],
  });
  await queue.initialize();
  if (String(process.env.COLLECTOR_ROTATE_SPOOL_ON_START ?? 'false').toLowerCase() === 'true') await queue.rotateToPrimaryKey()
  const tokenFile = process.env.COLLECTOR_BEARER_TOKEN_FILE?.trim() || statePaths.transportToken;
  const bearerToken = (await readFile(tokenFile, 'utf8')).trim();
  const providerConfigFile = process.env.COLLECTOR_PROVIDER_CONFIG_FILE?.trim();
  const assignmentFile = process.env.COLLECTOR_RUN_ASSIGNMENT_FILE?.trim();
  if (providerConfigFile && String(process.env.COLLECTOR_COLLECT_ON_START ?? 'true').toLowerCase() === 'true') {
    const providerConfig = JSON.parse(await readFile(providerConfigFile, 'utf8'));
    const provider = required('COLLECTOR_PROVIDER').toUpperCase();
    let assignment;
    if (assignmentFile) {
      assignment = JSON.parse(await readFile(assignmentFile, 'utf8'));
    } else {
      const managementPlaneUid = provider === 'VSPHERE' || provider === 'VCENTER'
        ? `vcenter:${(await discoverVCenterServiceIdentity({
          baseUrl: providerConfig.baseUrl,
          ...providerConfig.auth.basic,
        })).instanceUuid.toLowerCase()}`
        : provider === 'OPENSHIFT_VIRTUALIZATION'
          ? `openshift:${(await createOpenShiftVirtualizationClient(
            providerConfig.kubernetes,
            { namespaces: providerConfig.namespaces },
          ).discover()).managementPlaneUid}`
          : (() => { throw new Error('The Linux collector supports VSPHERE and OPENSHIFT_VIRTUALIZATION'); })();
      assignment = await startCollectorRun({
        controlPlaneUrl: required('COLLECTOR_CONTROL_PLANE_URL'),
        bearerToken,
        orgId: identity.orgId,
        integrationId: identity.integrationId,
        collectorId: identity.collectorId,
        signatureKeyId: identity.keyId,
        managementPlaneUid,
        adapterName: provider === 'OPENSHIFT_VIRTUALIZATION' ? 'openshift-virtualization' : 'vcenter-property-collector',
        adapterVersion: '1.0.0',
        scaleClass: spoolBudget.scaleClass,
      });
    }
    const privateKeyPem = await readFile(process.env.COLLECTOR_SIGNING_PRIVATE_KEY_FILE ?? statePaths.signingPrivateKey, 'utf8');
    const signer = new DataCenterBundleSigner(privateKeyPem, {
      orgId: Number(assignment.orgId),
      collectorId: required('COLLECTOR_ID'),
      signatureKeyId: required('COLLECTOR_SIGNATURE_KEY_ID'),
    });
    const supervisor = new InEstateCollectorSupervisor(queue, signer);
    const result = provider === 'VCENTER' || provider === 'VSPHERE'
      ? await supervisor.run(assignment, new VCenterInEstateAdapter(), providerConfig)
      : provider === 'OPENSHIFT_VIRTUALIZATION'
        ? await supervisor.run(assignment, new OpenShiftVirtualizationInEstateAdapter(spoolBudget.sourceConcurrency), providerConfig)
        : (() => { throw new Error('COLLECTOR_PROVIDER must be VCENTER or OPENSHIFT_VIRTUALIZATION for this runtime'); })();
    if (result.status === 'FAILED') throw new Error('Provider collection failed; signed failure evidence remains in the spool');
  }
  const worker = mode === 'OFFLINE' ? null : new OnPremCollectorWorker(queue, {
    endpoint: process.env.COLLECTOR_INGESTION_ENDPOINT ?? `${required('COLLECTOR_CONTROL_PLANE_URL').replace(/\/$/, '')}/bundles/push`, allowedHosts: list('COLLECTOR_ALLOWED_HOSTS'),
    privateAddressAllowedHosts: list('COLLECTOR_PRIVATE_ADDRESS_ALLOWED_HOSTS'),
    bearerToken,
    proxyUrl: process.env.COLLECTOR_PROXY_URL, proxyAllowedHosts: list('COLLECTOR_PROXY_ALLOWED_HOSTS'),
    privateProxyAddressAllowedHosts: list('COLLECTOR_PRIVATE_PROXY_ADDRESS_ALLOWED_HOSTS'),
  });
  if (mode === 'OFFLINE' && process.env.COLLECTOR_OFFLINE_EXPORT_DIRECTORY) {
    const exportDirectory = process.env.COLLECTOR_OFFLINE_EXPORT_DIRECTORY;
    await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
    for (const item of await queue.list()) {
      const safeBundleId = item.bundleId.replace(/[^a-zA-Z0-9._-]/g, '_');
      await writeFile(join(exportDirectory, `${item.queueId}.${safeBundleId}.${item.schemaVersion}.bundle`), item.payload, { mode: 0o600, flag: 'wx' });
    }
    return;
  }
  const healthPath = process.env.COLLECTOR_HEALTH_FILE ?? '/var/run/cloudverse/health.json';
  let stopping = false; process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
  do {
    if (worker) await worker.flushOnce().catch(() => undefined);
    const health = worker ? await worker.health() : { healthy: true, mode: 'OFFLINE', queue: await queue.usage() };
    await writeFile(healthPath, JSON.stringify({ ...health, mode, checkedAt: new Date().toISOString() }), { mode: 0o600 });
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, positive('COLLECTOR_FLUSH_INTERVAL_SECONDS', 30) * 1000));
  } while (!stopping);
}

async function healthcheck(requireHealthy: boolean) {
  const healthPath = process.env.COLLECTOR_HEALTH_FILE ?? '/var/run/cloudverse/health.json';
  const health = JSON.parse(await readFile(healthPath, 'utf8')) as { healthy?: boolean; checkedAt?: string };
  const checkedAt = new Date(health.checkedAt ?? '').valueOf();
  const maximumAge = positive('COLLECTOR_HEALTH_MAX_AGE_SECONDS', 120) * 1000;
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > maximumAge) throw new Error('collector health is stale');
  if (requireHealthy && health.healthy !== true) throw new Error('collector health reports unhealthy');
}

const probe = process.argv.find((argument) => argument === '--healthcheck' || argument === '--readiness-check');
(probe ? healthcheck(probe === '--readiness-check') : main())
  .catch((error) => { process.stderr.write(`collector startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
