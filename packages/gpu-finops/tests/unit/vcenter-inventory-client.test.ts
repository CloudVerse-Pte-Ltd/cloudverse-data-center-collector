import { describe, expect, it, vi } from 'vitest';
import {
  collectVCenterInventoryEvidence,
  createVCenterClient,
  validateVCenterConnectorConfig,
  type VCenterCollectionContext,
  type VCenterConnectorConfig,
} from '../../src/index.js';

const config: VCenterConnectorConfig = {
  baseUrl: 'https://vcenter-boundary.example.internal',
  timeoutMs: 500,
  maxRetries: 0,
  auth: { bearerToken: 'mock-vcenter-bearer' },
};

const context: VCenterCollectionContext = {
  tenantId: 'tenant-vcenter',
  orgId: 'org-vcenter',
  deploymentMode: 'PRIVATE_DEPLOYMENT',
  provider: 'on_prem',
  connectorId: 'vcenter-test',
  connectorVersion: '0.1.0',
  clusterId: 'cluster-vcenter',
  collectedAt: '2026-06-25T02:00:00.000Z',
};

function inventoryResponse() {
  return {
    datacenters: [{ id: 'dc-1', name: 'dc-sg-1' }],
    clusters: [{ id: 'cluster-1', name: 'gpu-cluster-a' }],
    hosts: [
      {
        id: 'host-1',
        name: 'esxi-gpu-1',
        datacenter: 'dc-sg-1',
        gpus: [
          {
            uuid: 'GPU-VCENTER-1',
            model: 'NVIDIA A100',
            memoryMib: 40960,
            vgpuCapable: true,
          },
        ],
      },
      {
        id: 'host-2',
        name: 'esxi-gpu-2',
        gpus: [{ model: 'NVIDIA L40S' }],
      },
    ],
    vms: [
      {
        id: 'vm-1',
        name: 'training-vm',
        host: 'esxi-gpu-1',
        owner: 'team-ml',
        tags: { app: 'trainer', environment: 'prod' },
        gpus: [{ uuid: 'GPU-VCENTER-1', vgpuProfile: 'grid_a100-4q' }],
        gpuCost: 10,
        currency: 'USD',
      },
      {
        id: 'vm-2',
        name: 'unknown-owner-vm',
        host: 'esxi-gpu-2',
        gpus: [{ passthrough: true }],
      },
      { id: 'vm-3', name: 'ordinary-non-gpu-vm', host: 'esxi-gpu-2', owner: 'team-app' },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('vCenter GPU inventory evidence connector', () => {
  it('authenticates natively and discovers version, plane identity, privileges, and datacenters', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/sdk') {
        const body = String(init?.body);
        return new Response(body.includes('<vim25:Login>')
          ? '<?xml version="1.0"?><Envelope><Body><LoginResponse/></Body></Envelope>'
          : '<?xml version="1.0"?><Envelope><Body><RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><about><instanceUuid>5b30d520-b27f-48ea-b454-89e4eb352a8d</instanceUuid><version>8.0.3</version><build>24091160</build><productLineId>vpx</productLineId><apiType>VirtualCenter</apiType></about></returnval></RetrieveServiceContentResponse></Body></Envelope>',
          { status: 200, headers: { 'set-cookie': 'vmware_soap_session=identity; Path=/; Secure' } });
      }
      if (path === '/api/session') return jsonResponse('session-1');
      if (path === '/api/appliance/system/version') return jsonResponse({ version: '8.0.3', build: '24022515' });
      if (path === '/api/vcenter/system-config/deployment-type') return jsonResponse({ type: 'VCENTER_SERVER' });
      if (path === '/api/vcenter/authorization/privilege') return jsonResponse(['System.Read', 'VirtualMachine.Config.CPUCount']);
      if (path === '/api/vcenter/datacenter') return jsonResponse([{ datacenter: 'datacenter-1' }]);
      return jsonResponse({}, 404);
    });
    const client = createVCenterClient({ ...config, auth: { basic: { username: 'reader', password: 'secret' } } }, { fetchImpl });
    const discovery = await client.discoverPlatform();

    expect(discovery).toMatchObject({ apiOrigin: 'https://vcenter-boundary.example.internal', datacenterCount: 1, version: { version: '8.0.3' } });
    expect(discovery.managementPlaneUid).toBe('vcenter:5b30d520-b27f-48ea-b454-89e4eb352a8d');
    expect(discovery.capabilities).toContainEqual(expect.objectContaining({ capability: 'DISCOVER_INVENTORY', status: 'READY' }));
    const authenticatedRestCall = fetchImpl.mock.calls.find(([input]) => new URL(String(input)).pathname === '/api/appliance/system/version');
    const postSessionHeaders = authenticatedRestCall?.[1]?.headers as Headers;
    expect(postSessionHeaders.get('vmware-api-session-id')).toBe('session-1');
    expect(postSessionHeaders.get('Authorization')).toBeNull();
  });

  it('collects the full native hierarchy with bounded cursor paging and non-GPU VMs', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session') return jsonResponse('session-native');
      if (url.pathname === '/api/vcenter/vm' && !url.searchParams.has('cursor')) {
        return jsonResponse({ items: [{ vm: 'vm-1', name: 'ordinary-vm', cpu_count: 2 }], next_cursor: 'vm-page-2' });
      }
      if (url.pathname === '/api/vcenter/vm') return jsonResponse({ items: [{ vm: 'vm-2', name: 'gpu-vm', cpu_count: 8 }] });
      const singular = url.pathname.split('/').pop()!;
      return jsonResponse([{ [singular]: `${singular}-1`, name: `${singular}-one` }]);
    });
    const client = createVCenterClient({ ...config, auth: { basic: { username: 'reader', password: 'secret' } } }, { fetchImpl });
    const inventory = await client.nativeInventory();

    expect(inventory.datacenters).toHaveLength(1);
    expect(inventory.folders).toHaveLength(1);
    expect(inventory.clusters).toHaveLength(1);
    expect(inventory.resourcePools).toHaveLength(1);
    expect(inventory.hosts).toHaveLength(1);
    expect(inventory.vms).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ordinary-vm' }), expect.objectContaining({ name: 'gpu-vm' })]));
    expect(inventory.pages).toBe(7);
    expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).searchParams.get('cursor') === 'vm-page-2')).toBe(true);
  });

  it('does not truncate a 10,000-VM paged reference estate', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session') return jsonResponse('session-load');
      if (url.pathname !== '/api/vcenter/vm') return jsonResponse([]);
      const page = Number(url.searchParams.get('cursor') ?? 0);
      const items = Array.from({ length: 1_000 }, (_, index) => ({ vm: `vm-${page * 1_000 + index}` }));
      return jsonResponse({ items, ...(page < 9 ? { next_cursor: String(page + 1) } : {}) });
    });
    const client = createVCenterClient({ ...config, auth: { basic: { username: 'reader', password: 'secret' } } }, { fetchImpl });
    const inventory = await client.nativeInventory();
    expect(inventory.vms).toHaveLength(10_000);
    expect(new Set(inventory.vms.map((vm: any) => vm.vm)).size).toBe(10_000);
    expect(inventory.pages).toBe(15);
  });

  it('collects datastore, disk, snapshot, network, tag, and VM relationship topology', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session') return jsonResponse('session-storage');
      if (url.pathname === '/api/vcenter/datastore') return jsonResponse([{ datastore: 'ds-1', capacity: 1000, free_space: 400 }]);
      if (url.pathname === '/api/vcenter/network') return jsonResponse([{ network: 'net-1', name: 'prod' }]);
      if (url.pathname.endsWith('/hardware/disk')) return jsonResponse([{ disk: '2000', backing: { vmdk_file: '[ds-1] vm/vm.vmdk' }, capacity: 100 }]);
      if (url.pathname.endsWith('/snapshots')) return jsonResponse([{ snapshot: 'snap-1', name: 'before-upgrade' }]);
      if (url.pathname.endsWith('/hardware/ethernet')) return jsonResponse([{ nic: '4000', backing: { network: 'net-1' } }]);
      if (url.pathname === '/api/cis/tagging/tag') return jsonResponse(['tag-1']);
      if (url.pathname === '/api/cis/tagging/tag-association') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ tag_ids: ['tag-1'] });
        return jsonResponse([{ tag_id: 'tag-1', object_id: { type: 'VirtualMachine', id: 'vm-1' } }]);
      }
      return jsonResponse({}, 404);
    });
    const client = createVCenterClient({ ...config, auth: { basic: { username: 'reader', password: 'secret' } } }, { fetchImpl });
    const topology = await client.storageTopology(['vm-1']);
    expect(topology.datastores).toEqual([expect.objectContaining({ datastore: 'ds-1' })]);
    expect(topology.disks[0]).toMatchObject({ vm: 'vm-1', devices: [expect.objectContaining({ disk: '2000' })] });
    expect(topology.snapshots[0]).toMatchObject({ vm: 'vm-1', snapshots: [expect.objectContaining({ snapshot: 'snap-1' })] });
    expect(topology.nics[0]).toMatchObject({ vm: 'vm-1', devices: [expect.objectContaining({ nic: '4000' })] });
    expect(topology.tagAssociations).toHaveLength(1);
    expect(topology.capabilities).toContainEqual(expect.objectContaining({ capability: 'DESCRIBE_CAPACITY', status: 'READY' }));
  });

  it('normalizes datacenter, host, GPU device, VM, vGPU, passthrough, and source cost hints', async () => {
    const result = await collectVCenterInventoryEvidence({
      config: {},
      context,
      response: inventoryResponse(),
    });

    expect(result.errors).toHaveLength(0);
    expect(result.inventory?.cluster).toMatchObject({
      clusterType: 'vcenter',
      regionOrSite: 'dc-sg-1',
    });
    expect(result.inventory?.nodes).toHaveLength(2);
    expect(result.inventory?.devices[0]).toMatchObject({
      gpuUuid: 'GPU-VCENTER-1',
      model: 'NVIDIA A100',
      vgpuCapable: true,
    });
    expect(result.inventory?.workloads[0]).toMatchObject({
      kind: 'vm',
      vmId: 'vm-1',
      requestedGpuCount: 1,
      partitioned: true,
      migProfile: 'grid_a100-4q',
      confidence: { level: 'MEDIUM' },
    });
    expect(result.inventory?.workloads).toHaveLength(3);
    expect(result.inventory?.workloads).toContainEqual(expect.objectContaining({ vmId: 'vm-3', requestedGpuCount: undefined }));
    expect(result.sourceCostFacts[0]).toMatchObject({
      costAmount: 10,
      costCategory: 'unknown',
      confidence: { level: 'LOW' },
    });
  });

  it('emits vCenter-only, workload unknown, missing owner, and missing GPU UUID findings', async () => {
    const result = await collectVCenterInventoryEvidence({
      config: {},
      context,
      response: inventoryResponse(),
    });

    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['missing_gpu_uuid', 'vcenter_only_visibility', 'workload_unknown', 'missing_vm_owner']));
  });

  it('fails closed instead of selecting a first cluster or using names as identity', async () => {
    for (const response of [
      { ...inventoryResponse(), clusters: [] },
      { ...inventoryResponse(), clusters: [{ id: 'cluster-1', name: 'a' }, { id: 'cluster-2', name: 'b' }] },
      { ...inventoryResponse(), hosts: [{ name: 'name-only-host' }] },
      { ...inventoryResponse(), vms: [{ name: 'name-only-vm' }] },
    ]) {
      const result = await collectVCenterInventoryEvidence({ config: {}, context, response });
      expect(result.health.healthy).toBe(false);
      expect(result.facts).toHaveLength(0);
    }
  });

  it('rejects a cost hint with unresolved currency instead of silently defaulting USD', async () => {
    const response = inventoryResponse();
    response.vms[0] = { ...response.vms[0], currency: undefined } as typeof response.vms[number];
    const result = await collectVCenterInventoryEvidence({ config: {}, context, response });
    expect(result.sourceCostFacts).toHaveLength(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unresolved_cost_currency', severity: 'ERROR' }));
  });

  it('queries a vCenter boundary endpoint with auth but does not leak tokens into facts', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(inventoryResponse()));
    const result = await collectVCenterInventoryEvidence({
      config,
      context,
      client: createVCenterClient(config, { fetchImpl }),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://vcenter-boundary.example.internal/api/vcenter/inventory');
    expect(((fetchImpl.mock.calls[0][1] as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer mock-vcenter-bearer');
    expect(JSON.stringify(result.facts)).not.toContain('mock-vcenter-bearer');
  });

  it('validates base URL and mixed auth configuration', () => {
    expect(validateVCenterConnectorConfig({ baseUrl: 'not a url' }).valid).toBe(false);
    expect(
      validateVCenterConnectorConfig({
        ...config,
        auth: { bearerToken: 'a', basic: { username: 'u', password: 'p' } },
      }).findings.map((finding) => finding.code),
    ).toContain('connector_auth_config_invalid');
    expect(validateVCenterConnectorConfig({ managementPlaneUid: 'derived-from-hostname' }).valid).toBe(false);
  });

  it('returns structured errors for API failures and timeouts', async () => {
    const failedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'down' }, 503));
    const failed = await collectVCenterInventoryEvidence({
      config,
      context,
      client: createVCenterClient(config, { fetchImpl: failedFetch }),
    });

    expect(failed.errors[0]).toMatchObject({ code: 'vcenter_query_failed', sourceSystem: 'vcenter' });

    const timeoutFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const timedOut = await collectVCenterInventoryEvidence({
      config: { ...config, timeoutMs: 1 },
      context,
      client: createVCenterClient({ ...config, timeoutMs: 1 }, { fetchImpl: timeoutFetch }),
    });

    expect(timedOut.errors[0]).toMatchObject({ code: 'vcenter_query_timeout', retryable: true });
  });
});
