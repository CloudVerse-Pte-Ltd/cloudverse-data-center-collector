import { describe, expect, it } from 'vitest';
import { startCollectorRun } from '../../src/on-prem-collector/control-plane-client.js';

describe('collector control-plane client', () => {
  it('uses the transport token and validates the assigned management plane', async () => {
    let request: any;
    const assignment = await startCollectorRun({
      controlPlaneUrl: 'https://api.example.test/data-center-collector',
      bearerToken: 't'.repeat(43),
      orgId: 42,
      integrationId: 91,
      collectorId: 'dc-1',
      signatureKeyId: 'key-1',
      managementPlaneUid: 'vcenter:1234',
      adapterName: 'vcenter-property-collector',
      adapterVersion: '1.0.0',
      scaleClass: 'S',
    }, async (url, init) => {
      request = { url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: '018f0d8e-7b23-7000-8000-000000000001', managementPlaneUid: 'vcenter:1234' }), { status: 201 });
    });
    expect(request.url).toBe('https://api.example.test/data-center-collector/runs/start');
    expect(request.headers.authorization).toBe(`Bearer ${'t'.repeat(43)}`);
    expect(request.body.integrationId).toBe(91);
    expect(assignment.collectionRunId).toBe('018f0d8e-7b23-7000-8000-000000000001');
  });

  it('rejects a cross-plane assignment response', async () => {
    await expect(startCollectorRun({
      controlPlaneUrl: 'https://api.example.test',
      bearerToken: 't'.repeat(43),
      orgId: 1,
      integrationId: 2,
      collectorId: 'dc-1',
      signatureKeyId: 'key-1',
      managementPlaneUid: 'vcenter:expected',
      adapterName: 'vcenter-property-collector',
      adapterVersion: '1.0.0',
      scaleClass: 'S',
    }, async () => new Response(JSON.stringify({
      id: '018f0d8e-7b23-7000-8000-000000000001',
      managementPlaneUid: 'vcenter:other',
    }), { status: 201 }))).rejects.toThrow('assignment response is invalid');
  });
});
