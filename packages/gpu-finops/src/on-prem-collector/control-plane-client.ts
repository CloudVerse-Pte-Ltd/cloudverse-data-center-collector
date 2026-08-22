import type { CollectorRunAssignment } from './supervisor.js';

export interface StartCollectorRunInput {
  controlPlaneUrl: string;
  bearerToken: string;
  orgId: number;
  integrationId: number;
  collectorId: string;
  signatureKeyId: string;
  managementPlaneUid: string;
  adapterName: string;
  adapterVersion: string;
  scaleClass: 'S' | 'M' | 'L' | 'XL';
  requestedWindow?: { start: string; end: string };
}

export async function startCollectorRun(
  input: StartCollectorRunInput,
  transport: typeof fetch = fetch,
): Promise<CollectorRunAssignment> {
  const endpoint = new URL(input.controlPlaneUrl);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('collector control-plane requests require HTTPS');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/runs/start`;
  const response = await transport(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      orgId: input.orgId,
      integrationId: input.integrationId,
      collectorId: input.collectorId,
      signatureKeyId: input.signatureKeyId,
      managementPlaneUid: input.managementPlaneUid,
      adapterName: input.adapterName,
      adapterVersion: input.adapterVersion,
      scaleClass: input.scaleClass,
      requestedWindowStart: input.requestedWindow?.start,
      requestedWindowEnd: input.requestedWindow?.end,
    }),
  });
  if (!response.ok) throw new Error(`collector run creation failed with HTTP ${response.status}`);
  const run = await response.json() as { id?: unknown; managementPlaneUid?: unknown };
  if (typeof run.id !== 'string' || typeof run.managementPlaneUid !== 'string' || run.managementPlaneUid !== input.managementPlaneUid) {
    throw new Error('collector run assignment response is invalid');
  }
  return {
    orgId: input.orgId,
    integrationId: input.integrationId,
    collectionRunId: run.id,
    managementPlaneUid: run.managementPlaneUid,
    scaleClass: input.scaleClass,
    requestedWindow: input.requestedWindow,
  };
}
