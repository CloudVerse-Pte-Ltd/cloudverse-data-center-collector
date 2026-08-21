import { describe, expect, it, vi } from 'vitest';
import { collectVCenterPerformance, collectWithPropertyCollector, probeVCenterPerformanceCounters, toVCenterInventoryEnvelope, toVCenterTelemetryEnvelope } from '../../src/index.js';

const soap = (body: string) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
const response = (body: string, headers?: HeadersInit) => new Response(soap(body), { status: 200, headers });

describe('vCenter PropertyCollector paging', () => {
  it('logs in and consumes RetrievePropertiesEx continuation tokens without truncation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><rootFolder type="Folder">group-root-42</rootFolder></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session=abc; Path=/; Secure' });
      if (body.includes('<vim25:Login>')) return response('<LoginResponse><returnval><key>session-key</key></returnval></LoginResponse>');
      if (body.includes('ContinueRetrievePropertiesEx')) return response('<ContinueRetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-2</obj><propSet><name>name</name><val>ordinary-vm-2</val></propSet></objects></returnval></ContinueRetrievePropertiesExResponse>');
      return response('<RetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val>ordinary-vm-1</val></propSet></objects><token>next-page</token></returnval></RetrievePropertiesExResponse>');
    });
    const result = await collectWithPropertyCollector({ baseUrl: 'https://vcenter.example.test', username: 'reader', password: 'secret', fetchImpl, pageSize: 1 });
    expect(result.pages).toBe(2);
    expect(result.objects.map((object) => object.value)).toEqual(['vm-1', 'vm-2']);
    expect(result.objects[0].properties.name).toBe('ordinary-vm-1');
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('<vim25:maxObjects>1</vim25:maxObjects>');
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('group-root-42');
    expect((fetchImpl.mock.calls[2][1]?.headers as Record<string, string>).Cookie).toBe('vmware_soap_session=abc');
  });

  it('normalizes full VM, host, cluster and datastore topology with immutable source identities', () => {
    const envelope = toVCenterInventoryEnvelope({
      integrationId: 7,
      identity: { instanceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', productLineId: 'vpx', version: '8.0.3', build: '24091160', apiType: 'VirtualCenter' },
      collectedAt: '2026-08-21T00:00:00Z',
      result: { pages: 2, objects: [
        { type: 'Datacenter', value: 'datacenter-1', properties: { name: 'DC1' } },
        { type: 'Folder', value: 'group-h1', properties: { name: 'Hosts', parent: { '#text': 'datacenter-1', '@_type': 'Datacenter' } } },
        { type: 'ClusterComputeResource', value: 'domain-c1', properties: { name: 'Cluster 1', parent: { '#text': 'group-h1', '@_type': 'Folder' } } },
        { type: 'HostSystem', value: 'host-1', properties: { name: 'esx-1', parent: { '#text': 'domain-c1', '@_type': 'ClusterComputeResource' }, 'hardware.systemInfo.uuid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
        { type: 'Datastore', value: 'datastore-1', properties: { name: 'vsanDatastore', 'summary.url': 'ds:///vmfs/volumes/vsan:abc/' } },
        { type: 'VirtualMachine', value: 'vm-42', properties: { name: 'app-01', 'config.instanceUuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'runtime.host': { '#text': 'host-1', '@_type': 'HostSystem' }, datastore: [{ '#text': 'datastore-1', '@_type': 'Datastore' }] } },
      ] },
    });
    expect(envelope).toMatchObject({ type: 'VSPHERE_INVENTORY', managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pages: 2 });
    expect(envelope.resources.find((resource) => resource.id === 'VirtualMachine:vm-42')).toMatchObject({ kind: 'VIRTUAL_MACHINE', sourceUid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'app-01' });
    expect(envelope.resources.find((resource) => resource.id === 'HostSystem:host-1')).toMatchObject({ kind: 'HOST', sourceUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(envelope.relationships).toEqual(expect.arrayContaining([
      { from: 'VirtualMachine:vm-42', to: 'HostSystem:host-1', type: 'RUNS_ON' },
      { from: 'VirtualMachine:vm-42', to: 'Datastore:datastore-1', type: 'USES_DATASTORE' },
      { from: 'HostSystem:host-1', to: 'ClusterComputeResource:domain-c1', type: 'MEMBER_OF' },
    ]));
  });
});

describe('vCenter PerformanceManager probing', () => {
  it('discovers source counter semantics, historical intervals, and query caps before collection', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) {
        return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><perfManager type="PerformanceManager">PerfMgr</perfManager><setting type="OptionManager">VpxSettings</setting></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session=perf; Path=/; Secure' });
      }
      if (body.includes('<vim25:Login>')) return response('<LoginResponse><returnval><key>session-key</key></returnval></LoginResponse>');
      if (body.includes('<vim25:QueryOptions>')) {
        return response('<QueryOptionsResponse><returnval><key>config.vpxd.stats.maxQueryMetrics</key><value>64</value></returnval></QueryOptionsResponse>');
      }
      return response('<RetrievePropertiesExResponse><returnval><objects><obj type="PerformanceManager">PerfMgr</obj><propSet><name>perfCounter</name><val><perfCounter><key>2</key><nameInfo><key>usage</key></nameInfo><groupInfo><key>cpu</key></groupInfo><unitInfo><key>percent</key></unitInfo><rollupType>average</rollupType><statsType>rate</statsType><level>1</level><perDeviceLevel>3</perDeviceLevel></perfCounter><perfCounter><key>33</key><nameInfo><key>usage</key></nameInfo><groupInfo><key>mem</key></groupInfo><unitInfo><key>percent</key></unitInfo><rollupType>average</rollupType><statsType>absolute</statsType><level>1</level><perDeviceLevel>3</perDeviceLevel></perfCounter></val></propSet><propSet><name>historicalInterval</name><val><historicalInterval><key>1</key><name>Past day</name><samplingPeriod>300</samplingPeriod><length>86400</length><level>1</level><enabled>true</enabled></historicalInterval></val></propSet></objects></returnval></RetrievePropertiesExResponse>');
    });

    const result = await probeVCenterPerformanceCounters({
      baseUrl: 'https://vcenter.example.test',
      username: 'reader',
      password: 'secret',
      fetchImpl,
    });

    expect(result.performanceManagerUid).toBe('PerfMgr');
    expect(result.counterCount).toBe(2);
    expect(result.counters.map((counter) => counter.semantic)).toEqual(['cpu.usage.average', 'mem.usage.average']);
    expect(result.intervals).toEqual([expect.objectContaining({ samplingPeriodSeconds: 300, lengthSeconds: 86400, enabled: true })]);
    expect(result.maxQueryMetrics).toBe(64);
    expect(result.capability).toEqual(expect.objectContaining({ capability: 'PROBE_COUNTERS', status: 'READY' }));
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('<vim25:pathSet>perfCounter</vim25:pathSet>');
    expect((fetchImpl.mock.calls[2][1]?.headers as Record<string, string>).Cookie).toBe('vmware_soap_session=perf');
  });

  it('blocks telemetry when vCenter exposes no counters and falls back to a conservative local cap', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><perfManager type="PerformanceManager">PerfMgr</perfManager></returnval></RetrieveServiceContentResponse>');
      if (body.includes('<vim25:Login>')) return response('<LoginResponse/>');
      return response('<RetrievePropertiesExResponse><returnval><objects><obj type="PerformanceManager">PerfMgr</obj><propSet><name>perfCounter</name><val/></propSet></objects></returnval></RetrievePropertiesExResponse>');
    });

    const result = await probeVCenterPerformanceCounters({ baseUrl: 'https://vcenter.example.test', username: 'reader', password: 'secret', fetchImpl });
    expect(result.counterCount).toBe(0);
    expect(result.maxQueryMetrics).toBeUndefined();
    expect(result.capability.status).toBe('BLOCKED');
    expect(result.capability.diagnostics.maxQueryMetricsSource).toBe('collector_conservative_default');
  });
});

describe('C30 bounded vCenter PerformanceManager collection', () => {
  const probe = {
    performanceManagerUid: 'PerfMgr', counterCount: 1, maxQueryMetrics: 1,
    counters: [{ key: 2, groupKey: 'cpu', nameKey: 'usage', rollupType: 'average', statsType: 'rate', unitKey: 'percent', level: 1, perDeviceLevel: 3, semantic: 'cpu.usage.average' }],
    intervals: [{ key: 1, name: 'Past day', samplingPeriodSeconds: 300, lengthSeconds: 86400, level: 1, enabled: true }],
    capability: { capability: 'PROBE_COUNTERS' as const, status: 'READY' as const, diagnostics: {} },
  };
  it('queries discovered counter IDs in bounded batches and maps facts to canonical asset IDs', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><perfManager type="PerformanceManager">PerfMgr</perfManager></returnval></RetrieveServiceContentResponse>');
      if (body.includes('<vim25:Login>')) return response('<LoginResponse/>');
      const vm = body.includes('vm-2') ? 'vm-2' : 'vm-1';
      return response(`<QueryPerfResponse><returnval><entity type="VirtualMachine">${vm}</entity><sampleInfoCSV>300,2026-08-21T00:00:00Z,300,2026-08-21T00:05:00Z</sampleInfoCSV><value><id><counterId>2</counterId><instance></instance></id><value>12.5,14</value></value></returnval></QueryPerfResponse>`);
    });
    const result = await collectVCenterPerformance({ baseUrl: 'https://vcenter.test', username: 'reader', password: 'secret', probe, entities: [
      { type: 'VirtualMachine', value: 'vm-1', assetId: 'asset-1' }, { type: 'VirtualMachine', value: 'vm-2', assetId: 'asset-2' },
    ], semantics: ['cpu.usage.average'], startTime: '2026-08-21T00:00:00Z', endTime: '2026-08-21T01:00:00Z', intervalId: 1, fetchImpl });
    expect(result).toMatchObject({ requests: 2, points: 4, gaps: [] });
    expect(result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: 'asset-1', counterId: 2, intervalSeconds: 300, semantic: 'cpu.usage.average' })]));
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('<vim25:counterId>2</vim25:counterId>');
  });

  it('fails closed on unprobed counters, disabled intervals and unsafe windows', async () => {
    const base = { baseUrl: 'https://vcenter.test', username: 'reader', password: 'secret', probe, entities: [{ type: 'VirtualMachine' as const, value: 'vm-1', assetId: 'asset-1' }], startTime: '2026-08-21T00:00:00Z', endTime: '2026-08-21T01:00:00Z', intervalId: 1 };
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.synthetic.average'] })).rejects.toThrow('not discovered');
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.usage.average'], intervalId: 99 })).rejects.toThrow('interval');
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.usage.average'], endTime: '2026-10-21T00:00:00Z' })).rejects.toThrow('31 days');
  });

  it('maps vCenter MoRefs and discovered counter semantics into the signed CPD metric contract', () => {
    const envelope = toVCenterTelemetryEnvelope({ integrationId: 7, managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metricSet: 'vsphere.vm.performance', expectedStart: '2026-08-21T00:00:00Z', expectedEnd: '2026-08-21T01:00:00Z', facts: [{ assetId: 'ignored-canonical-id', entity: { type: 'VirtualMachine', value: 'vm-42', assetId: 'ignored-canonical-id' }, semantic: 'cpu.usage.average', counterId: 2, observedAt: '2026-08-21T00:05:00Z', intervalSeconds: 300, value: '12.5', unit: 'percent', aggregation: 'average' }], gaps: [] });
    expect(envelope.metrics[0]).toMatchObject({ assetKind: 'VIRTUAL_MACHINE', sourceUid: 'vm-42', semanticMetric: 'guest.cpu.usage.percent', nativeMetric: 'cpu.usage.average', retentionDays: 90 });
  });
});
