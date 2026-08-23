import { describe, expect, it, vi } from 'vitest';
import { collectVCenterPerformance, collectWithPropertyCollector, probeVCenterPerformanceCounters, toVCenterInventoryEnvelope, toVCenterTelemetryEnvelope, VCenterInEstateAdapter } from '../../src/index.js';

const soap = (body: string) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
const response = (body: string, headers?: HeadersInit) => new Response(soap(body), { status: 200, headers });

describe('vCenter PropertyCollector paging', () => {
  it('logs in and consumes RetrievePropertiesEx continuation tokens without truncation', async () => {
    let activeType = '';
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><rootFolder type="Folder">group-root-42</rootFolder><viewManager type="ViewManager">ViewManager</viewManager></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session=abc; Path=/; Secure' });
      if (body.includes('<vim25:Login>')) return response('<LoginResponse><returnval><key>session-key</key></returnval></LoginResponse>');
      if (body.includes('<vim25:CreateContainerView>')) {
        activeType = body.match(/<vim25:type>([^<]+)<\/vim25:type>/)?.[1] ?? '';
        return response(`<CreateContainerViewResponse><returnval type="ContainerView">session-view-${activeType}</returnval></CreateContainerViewResponse>`);
      }
      if (body.includes('<vim25:DestroyView>')) return response('<DestroyViewResponse/>');
      if (body.includes('ContinueRetrievePropertiesEx') && activeType === 'VirtualMachine') return response('<ContinueRetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-2</obj><propSet><name>name</name><val>ordinary-vm-2</val></propSet></objects></returnval></ContinueRetrievePropertiesExResponse>');
      if (activeType === 'Network' || activeType === 'DistributedVirtualPortgroup') return response('<RetrievePropertiesExResponse><returnval><objects><obj type="DistributedVirtualPortgroup">dvportgroup-42</obj><propSet><name>name</name><val>production-dvpg</val></propSet></objects></returnval></RetrievePropertiesExResponse>');
      if (activeType !== 'VirtualMachine') return response('<RetrievePropertiesExResponse><returnval/></RetrievePropertiesExResponse>');
      return response('<RetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val>ordinary-vm-1</val></propSet></objects><token>next-page</token></returnval></RetrievePropertiesExResponse>');
    });
    const result = await collectWithPropertyCollector({ baseUrl: 'https://vcenter.example.test', username: 'reader', password: 'secret', fetchImpl, pageSize: 1 });
    expect(result.pages).toBe(10);
    expect(result.objects.map((object) => object.value)).toEqual(['vm-1', 'vm-2', 'dvportgroup-42']);
    expect(result.objects.filter((object) => object.value === 'dvportgroup-42')).toHaveLength(1);
    expect(result.objects[0].properties.name).toBe('ordinary-vm-1');
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('<vim25:recursive>true</vim25:recursive>');
    const retrieveCall = fetchImpl.mock.calls.find(([, init]) => String(init?.body).includes('<vim25:maxObjects>1</vim25:maxObjects>'))!;
    expect(String(retrieveCall[1]?.body)).toContain('session-view-Folder');
    expect(String(retrieveCall[1]?.body)).toContain('<vim25:type>DistributedVirtualPortgroup</vim25:type>');
    expect(String(retrieveCall[1]?.body)).toContain('<vim25:pathSet>config.distributedVirtualSwitch</vim25:pathSet>');
    expect(String(retrieveCall[1]?.body)).toContain('<vim25:type>ContainerView</vim25:type><vim25:path>view</vim25:path>');
    expect((retrieveCall[1]?.headers as Record<string, string>).Cookie).toBe('vmware_soap_session=abc');
    expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('<vim25:DestroyView>'))).toBe(true);
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
        { type: 'Folder', value: 'group-n1', properties: { name: 'Networks', parent: { '#text': 'datacenter-1', '@_type': 'Datacenter' } } },
        { type: 'DistributedVirtualPortgroup', value: 'dvportgroup-42', properties: { name: 'Application DVPG', parent: { '#text': 'group-n1', '@_type': 'Folder' }, 'config.key': 'dvportgroup-42', 'config.distributedVirtualSwitch': { '#text': 'dvs-1', '@_type': 'VmwareDistributedVirtualSwitch' } } },
        { type: 'VirtualMachine', value: 'vm-42', properties: { name: 'app-01', 'config.instanceUuid': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'runtime.host': { '#text': 'host-1', '@_type': 'HostSystem' }, datastore: [{ '#text': 'datastore-1', '@_type': 'Datastore' }] } },
      ] },
    });
    expect(envelope).toMatchObject({ type: 'VSPHERE_INVENTORY', managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pages: 2 });
    expect(envelope.resources.find((resource) => resource.id === 'VirtualMachine:vm-42')).toMatchObject({ kind: 'VIRTUAL_MACHINE', sourceUid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'app-01' });
    expect(envelope.resources.find((resource) => resource.id === 'HostSystem:host-1')).toMatchObject({ kind: 'HOST', sourceUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(envelope.resources.find((resource) => resource.id === 'DistributedVirtualPortgroup:dvportgroup-42')).toMatchObject({
      kind: 'NETWORK',
      name: 'Application DVPG',
      attributes: { sourceObjectType: 'DistributedVirtualPortgroup', distributedPortgroupKey: 'dvportgroup-42', distributedVirtualSwitchMor: 'dvs-1' },
    });
    expect(envelope.relationships).toEqual(expect.arrayContaining([
      { from: 'VirtualMachine:vm-42', to: 'HostSystem:host-1', type: 'RUNS_ON' },
      { from: 'VirtualMachine:vm-42', to: 'Datastore:datastore-1', type: 'USES_DATASTORE' },
      { from: 'HostSystem:host-1', to: 'ClusterComputeResource:domain-c1', type: 'MEMBER_OF' },
      { from: 'DistributedVirtualPortgroup:dvportgroup-42', to: 'Folder:group-n1', type: 'MEMBER_OF' },
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
    const queryBody = String(fetchImpl.mock.calls[2][1]?.body);
    expect(queryBody).toContain('<vim25:counterId>2</vim25:counterId>');
    expect(queryBody).toContain('<vim25:intervalId>300</vim25:intervalId>');
    expect(queryBody.indexOf('<vim25:startTime>')).toBeLessThan(queryBody.indexOf('<vim25:metricId>'));
    expect(queryBody.indexOf('<vim25:endTime>')).toBeLessThan(queryBody.indexOf('<vim25:metricId>'));
  });

  it('fails closed on unprobed counters, disabled intervals and unsafe windows', async () => {
    const base = { baseUrl: 'https://vcenter.test', username: 'reader', password: 'secret', probe, entities: [{ type: 'VirtualMachine' as const, value: 'vm-1', assetId: 'asset-1' }], startTime: '2026-08-21T00:00:00Z', endTime: '2026-08-21T01:00:00Z', intervalId: 1 };
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.synthetic.average'] })).rejects.toThrow('not discovered');
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.usage.average'], intervalId: 99 })).rejects.toThrow('interval');
    await expect(collectVCenterPerformance({ ...base, semantics: ['cpu.usage.average'], endTime: '2026-10-21T00:00:00Z' })).rejects.toThrow('31 days');
  });

  it('maps vCenter MoRefs and discovered counter semantics into the signed CPD metric contract', () => {
    const sourceUid = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    const envelope = toVCenterTelemetryEnvelope({ integrationId: 7, managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metricSet: 'vsphere.vm.performance', expectedStart: '2026-08-21T00:00:00Z', expectedEnd: '2026-08-21T01:00:00Z', facts: [{ assetId: sourceUid, entity: { type: 'VirtualMachine', value: 'vm-42', assetId: sourceUid }, semantic: 'cpu.usage.average', counterId: 2, observedAt: '2026-08-21T00:05:00Z', intervalSeconds: 300, value: '12.5', unit: 'percent', aggregation: 'average' }], gaps: [] });
    expect(envelope.metrics[0]).toMatchObject({ assetKind: 'VIRTUAL_MACHINE', sourceUid: sourceUid.toLowerCase(), semanticMetric: 'guest.cpu.usage.percent', nativeMetric: 'cpu.usage.average', retentionDays: 90, provenance: { sourceManagedObjectReference: 'vm-42' } });
  });

  it('fails closed rather than publishing telemetry without its canonical inventory identity', () => {
    expect(() => toVCenterTelemetryEnvelope({ integrationId: 7, managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metricSet: 'vsphere.vm.performance', expectedStart: '2026-08-21T00:00:00Z', expectedEnd: '2026-08-21T01:00:00Z', facts: [{ assetId: ' ', entity: { type: 'VirtualMachine', value: 'vm-42', assetId: ' ' }, semantic: 'cpu.usage.average', counterId: 2, observedAt: '2026-08-21T00:05:00Z', intervalSeconds: 300, value: '12.5', unit: 'percent', aggregation: 'average' }], gaps: [] })).toThrow('canonical inventory source UID');
  });
});

describe('vCenter released in-estate adapter golden path', () => {
  it('emits inventory and requested telemetry joined by the same immutable source UID', async () => {
    let activeType = '';
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes('RetrieveServiceContent')) return response('<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><rootFolder type="Folder">group-root</rootFolder><viewManager type="ViewManager">ViewManager</viewManager><perfManager type="PerformanceManager">PerfMgr</perfManager><setting type="OptionManager">VpxSettings</setting><about><instanceUuid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</instanceUuid><productLineId>vpx</productLineId><version>9.0.0.0</version><build>24734770</build><apiType>VirtualCenter</apiType></about></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session=adapter; Path=/; Secure' });
      if (body.includes('<vim25:Login>')) return response('<LoginResponse/>');
      if (body.includes('<vim25:CreateContainerView>')) {
        activeType = body.match(/<vim25:type>([^<]+)<\/vim25:type>/)?.[1] ?? '';
        return response(`<CreateContainerViewResponse><returnval type="ContainerView">session-view-${activeType}</returnval></CreateContainerViewResponse>`);
      }
      if (body.includes('<vim25:DestroyView>')) return response('<DestroyViewResponse/>');
      if (body.includes('<vim25:QueryOptions>')) return response('<QueryOptionsResponse><returnval><key>config.vpxd.stats.maxQueryMetrics</key><value>64</value></returnval></QueryOptionsResponse>');
      if (body.includes('<vim25:QueryPerf>')) return response('<QueryPerfResponse><returnval><entity type="VirtualMachine">vm-42</entity><sampleInfoCSV>300,2026-08-21T00:05:00Z</sampleInfoCSV><value><id><counterId>2</counterId><instance></instance></id><value>12.5</value></value></returnval></QueryPerfResponse>');
      if (body.includes('<vim25:obj type="PerformanceManager">')) return response('<RetrievePropertiesExResponse><returnval><objects><obj type="PerformanceManager">PerfMgr</obj><propSet><name>perfCounter</name><val><perfCounter><key>2</key><nameInfo><key>usage</key></nameInfo><groupInfo><key>cpu</key></groupInfo><unitInfo><key>percent</key></unitInfo><rollupType>average</rollupType><statsType>rate</statsType><level>1</level><perDeviceLevel>3</perDeviceLevel></perfCounter></val></propSet><propSet><name>historicalInterval</name><val><historicalInterval><key>1</key><name>Past day</name><samplingPeriod>300</samplingPeriod><length>86400</length><level>1</level><enabled>true</enabled></historicalInterval></val></propSet></objects></returnval></RetrievePropertiesExResponse>');
      if (activeType !== 'VirtualMachine') return response('<RetrievePropertiesExResponse><returnval/></RetrievePropertiesExResponse>');
      return response('<RetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-42</obj><propSet><name>name</name><val>app-01</val></propSet><propSet><name>config.instanceUuid</name><val>cccccccc-cccc-4ccc-8ccc-cccccccccccc</val></propSet></objects></returnval></RetrievePropertiesExResponse>');
    });
    const adapter = new VCenterInEstateAdapter(fetchImpl);
    const result = await adapter.collect({ baseUrl: 'https://vcenter.test', auth: { basic: { username: 'reader', password: 'secret' } }, performance: { semantics: ['cpu.usage.average'] } }, {
      tenantId: '1', orgId: '1', integrationId: '7', collectionRunId: 'run-1', managementPlaneUid: 'vcenter:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestedWindow: { start: '2026-08-21T00:00:00Z', end: '2026-08-21T01:00:00Z' },
    });
    expect(result.records.map((record) => record.type)).toEqual(['VSPHERE_INVENTORY', 'DATA_CENTER_METRICS']);
    const metrics = result.records[1] as ReturnType<typeof toVCenterTelemetryEnvelope>;
    expect(metrics.metrics[0]).toMatchObject({ sourceUid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', provenance: { sourceManagedObjectReference: 'vm-42' } });
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'PROBE_COUNTERS', status: 'READY' }),
      expect.objectContaining({ capability: 'COLLECT_UTILISATION', status: 'READY', diagnostics: expect.objectContaining({ points: 1, samplingPeriodSeconds: 300 }) }),
    ]));
    expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('<vim25:intervalId>300</vim25:intervalId>'))).toBe(true);
  });
});
