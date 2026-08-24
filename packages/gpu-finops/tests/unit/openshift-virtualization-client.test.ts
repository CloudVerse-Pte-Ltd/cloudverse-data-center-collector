import { describe, expect, it, vi } from 'vitest';
import { collectOpenShiftVirtualizationGraph, createOpenShiftVirtualizationClient, normalizeOpenShiftVirtualizationInventory } from '../../src/index.js';

const config = { baseUrl: 'https://api.openshift.example:6443', auth: { bearerToken: 'secret-token' } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OpenShift Virtualization connector', () => {
  it('never exceeds the selected scale-class source concurrency across discovery fan-out', async () => {
    let active = 0; let peak = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const path = new URL(String(input)).pathname;
      if (path === '/version') return response({ gitVersion: 'v1.31.4' });
      if (path === '/apis') return response({ groups: [{ name: 'kubevirt.io' }] });
      if (path.endsWith('/infrastructures/cluster')) return response({ metadata: { uid: 'infra-uid' }, status: { infrastructureName: 'payments-ocp' } });
      return response({});
    });
    await createOpenShiftVirtualizationClient(config, { fetchImpl, sourceConcurrency: 2 }).discover();
    expect(peak).toBe(2);
  });

  it('discovers OpenShift, KubeVirt API capability and effective read permissions', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/version') return response({ gitVersion: 'v1.31.4' });
      if (path === '/apis') return response({ groups: [{ name: 'kubevirt.io' }, { name: 'cdi.kubevirt.io' }, { name: 'config.openshift.io' }] });
      if (path === '/apis/subresources.kubevirt.io/v1') return response({ groupVersion: 'subresources.kubevirt.io/v1', resources: [{ name: 'virtualmachineinstances/console', kind: 'VirtualMachineInstance', namespaced: true, verbs: ['get'] }] });
      if (path.endsWith('/clusteroperators/version')) return response({ status: { history: [{ version: '4.18.2', state: 'Completed' }] } });
      if (path.endsWith('/selfsubjectrulesreviews')) return response({ status: { resourceRules: [{ resources: ['virtualmachines', 'virtualmachineinstances', 'virtualmachineinstancemigrations', 'datavolumes', 'persistentvolumeclaims'], verbs: ['get', 'list', 'watch'] }] } });
      if (path.endsWith('/infrastructures/cluster')) return response({ metadata: { uid: 'infra-uid' }, status: { infrastructureName: 'payments-ocp' } });
      return response({}, 404);
    });
    const discovered = await createOpenShiftVirtualizationClient(config, { fetchImpl }).discover();
    expect(discovered).toMatchObject({ platform: 'OPENSHIFT', kubernetesVersion: 'v1.31.4', openshiftVersion: '4.18.2', managementPlaneUid: 'infra-uid', clusterName: 'payments-ocp', identityStatus: 'READY', kubeVirt: { present: true, version: 'subresources.kubevirt.io/v1' } });
    expect(discovered.permissionChecks.every((check) => check.allowed)).toBe(true);
    expect(JSON.stringify(discovered)).not.toContain('secret-token');
  });

  it('reports KubeVirt absent without synthesizing capability', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/version') return response({ gitVersion: 'v1.30.0' });
      if (path === '/apis') return response({ groups: [{ name: 'config.openshift.io' }] });
      return path.endsWith('/selfsubjectrulesreviews') ? response({ resourceRules: [] }) : response({}, 404);
    });
    expect((await createOpenShiftVirtualizationClient(config, { fetchImpl }).discover()).kubeVirt.present).toBe(false);
  });

  it('follows bounded Kubernetes continuation tokens for every inventory kind', async () => {
    const calls = new Map<string, number>();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer secret-token');
      const url = new URL(String(input)); const count = calls.get(url.pathname) ?? 0; calls.set(url.pathname, count + 1);
      if (!url.searchParams.get('continue')) return response({ items: [{ metadata: { uid: `${url.pathname}:1`, name: 'first' } }], metadata: { continue: 'next' } });
      return response({ items: [{ metadata: { uid: `${url.pathname}:2`, name: 'second' } }], metadata: {} });
    });
    const result = await createOpenShiftVirtualizationClient(config, { fetchImpl, pageLimit: 1 }).collectInventory();
    expect(result.inventory.virtualMachines).toHaveLength(2);
    expect(result.inventory.dataVolumes).toHaveLength(2);
    expect(result.inventory.virtualMachineSnapshots).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(calls.size).toBe(12);
    expect([...calls.values()].every((count) => count === 2)).toBe(true);
  });

  it('fails closed on repeated continuation tokens', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ items: [], metadata: { continue: 'cycle' } }));
    const result = await createOpenShiftVirtualizationClient(config, { fetchImpl }).collectInventory();
    expect(result.failures).toHaveLength(12);
    expect(result.failures.every((failure) => failure.code === 'openshift_paging_cycle')).toBe(true);
  });

  it('collects accessible namespace inventory without requesting cluster-scoped resources', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/namespaces/chand-d-dev/')) return response({ items: [{ metadata: { uid: 'vm-1', name: 'sandbox-vm', namespace: 'chand-d-dev' } }], metadata: {} });
      if (url.pathname === '/api/v1/namespaces/chand-d-dev') return response({ metadata: { uid: 'ns-1', name: 'chand-d-dev' } });
      return response({ message: 'forbidden' }, 403);
    });
    const result = await createOpenShiftVirtualizationClient(config, { fetchImpl, namespaces: ['chand-d-dev'] }).collectInventory();
    expect(result.coverage).toEqual({ scope: 'NAMESPACES', namespaces: ['chand-d-dev'] });
    expect(result.inventory.virtualMachines).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.inventory.nodes).toEqual([]);
    expect(result.inventory.storageClasses).toEqual([]);
    expect(result.inventory.virtualMachineClusterInstanceTypes).toEqual([]);
  });

  it('uses the immutable KubeVirt control-plane UID when namespace access cannot read Infrastructure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/version') return response({ gitVersion: 'v1.31.4' });
      if (path === '/apis') return response({ groups: [{ name: 'kubevirt.io' }] });
      if (path.endsWith('/infrastructures/cluster')) return response({ message: 'forbidden' }, 403);
      if (path.endsWith('/namespaces/openshift-cnv/kubevirts')) return response({ items: [{ metadata: { uid: 'kubevirt-control-plane-uid', name: 'kubevirt-kubevirt-hyperconverged' } }], metadata: {} });
      return response({});
    });
    const discovered = await createOpenShiftVirtualizationClient(config, { fetchImpl, namespaces: ['chand-d-dev'] }).discover();
    expect(discovered).toMatchObject({
      managementPlaneUid: 'kubevirt-control-plane-uid',
      managementPlaneIdentitySource: 'KUBEVIRT_CONTROL_PLANE',
      identityStatus: 'READY',
    });
  });

  it('preserves VM identity while relating restarted/migrated VMIs and the complete storage graph', () => {
    const normalized = normalizeOpenShiftVirtualizationInventory({
      virtualMachines: [{ metadata: { uid: 'vm-uid', name: 'finance-vm', namespace: 'finance' }, spec: { instancetype: { name: 'u1.medium' }, template: { spec: { volumes: [{ dataVolume: { name: 'finance-root' } }] } } } }],
      virtualMachineInstances: [
        { metadata: { uid: 'vmi-old', name: 'finance-vm', namespace: 'finance', ownerReferences: [{ kind: 'VirtualMachine', name: 'finance-vm', uid: 'vm-uid' }] }, status: { phase: 'Succeeded', nodeName: 'worker-a' } },
        { metadata: { uid: 'vmi-new', name: 'finance-vm', namespace: 'finance', ownerReferences: [{ kind: 'VirtualMachine', name: 'finance-vm', uid: 'vm-uid' }] }, status: { phase: 'Running', nodeName: 'worker-b', migrationState: { completed: true } } },
      ],
      virtualMachineInstanceMigrations: [{ metadata: { uid: 'migration-1', name: 'move-finance', namespace: 'finance' }, spec: { vmiName: 'finance-vm' }, status: { phase: 'Succeeded' } }],
      virtualMachineClusterInstanceTypes: [], virtualMachineInstanceTypes: [],
      dataVolumes: [{ metadata: { uid: 'dv-1', name: 'finance-root', namespace: 'finance', ownerReferences: [{ kind: 'VirtualMachine', name: 'finance-vm' }] }, status: { phase: 'Succeeded' } }],
      persistentVolumeClaims: [{ metadata: { uid: 'pvc-1', name: 'finance-root', namespace: 'finance' }, spec: { storageClassName: 'fast' }, status: { capacity: { storage: '100Gi' } } }],
      storageClasses: [{ metadata: { uid: 'sc-1', name: 'fast' }, provisioner: 'csi.example' }],
      volumeSnapshots: [{ metadata: { uid: 'vs-1', name: 'finance-root-snap', namespace: 'finance' }, spec: { source: { persistentVolumeClaimName: 'finance-root' } }, status: { readyToUse: true } }],
      virtualMachineSnapshots: [{ metadata: { uid: 'vms-1', name: 'finance-vm-snap', namespace: 'finance' }, spec: { source: { name: 'finance-vm' } }, status: { phase: 'Succeeded' } }],
      nodes: [{ metadata: { uid: 'node-a', name: 'worker-a' } }, { metadata: { uid: 'node-b', name: 'worker-b' } }], namespaces: [{ metadata: { uid: 'ns-finance', name: 'finance' } }],
    });
    const vmis = normalized.resources.filter((item) => item.kind === 'VirtualMachineInstance');
    expect(vmis.map((item) => item.uid)).toEqual(['vmi-old', 'vmi-new']);
    expect(vmis.every((item) => item.attributes.vmOwnerUid === 'vm-uid')).toBe(true);
    expect(normalized.relationships).toEqual(expect.arrayContaining([
      { from: 'finance/VirtualMachine/finance-vm', to: 'finance/DataVolume/finance-root', type: 'USES_VOLUME' },
      { from: 'finance/DataVolume/finance-root', to: 'finance/PersistentVolumeClaim/finance-root', type: 'MATERIALIZES_AS' },
      { from: 'finance/PersistentVolumeClaim/finance-root', to: '_cluster/StorageClass/fast', type: 'USES_STORAGE_CLASS' },
      { from: 'finance/VolumeSnapshot/finance-root-snap', to: 'finance/PersistentVolumeClaim/finance-root', type: 'SNAPSHOT_OF' },
      { from: 'finance/VirtualMachineSnapshot/finance-vm-snap', to: 'finance/VirtualMachine/finance-vm', type: 'SNAPSHOT_OF' },
    ]));
  });

  it('emits the CPD graph envelope only after immutable management-plane identity matches', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/version') return response({ gitVersion: 'v1.31.4' });
      if (path === '/apis') return response({ groups: [{ name: 'kubevirt.io' }] });
      if (path === '/apis/subresources.kubevirt.io/v1') return response({ groupVersion: 'subresources.kubevirt.io/v1', resources: [] });
      if (path.endsWith('/infrastructures/cluster')) return response({ metadata: { uid: 'infra-uid' } });
      if (path.endsWith('/selfsubjectrulesreviews')) return response({ status: { resourceRules: [] } });
      if (path.endsWith('/clusteroperators/version')) return response({ status: { history: [{ version: '4.18.2' }] } });
      return response({ items: [], metadata: {} });
    });
    const context = { integrationId: '3', collectionRunId: 'run-1', managementPlaneUid: 'openshift:infra-uid', collectedAt: '2026-08-21T04:00:00.000Z' };
    const result = await collectOpenShiftVirtualizationGraph(config, context, { fetchImpl });
    expect(result.errors).toEqual([]);
    expect(result.records[0]).toMatchObject({ type: 'OPENSHIFT_VIRTUALIZATION_GRAPH', integrationId: 3, managementPlaneUid: 'openshift:infra-uid' });
    expect(result.records[0].resources[0]).toMatchObject({
      id: '_cluster/Cluster/infra-uid', uid: 'infra-uid', kind: 'Cluster',
      attributes: { kubernetesVersion: 'v1.31.4', openshiftVersion: '4.18.2' },
    });
    expect(result.capabilities.find((capability) => capability.capability === 'DISCOVER_INVENTORY')?.status).toBe('READY');

    const mismatch = await collectOpenShiftVirtualizationGraph(config, { ...context, managementPlaneUid: 'openshift:wrong' }, { fetchImpl });
    expect(mismatch.records).toEqual([]);
    expect(mismatch.errors[0]?.code).toBe('openshift_identity_unavailable');
  });
});
