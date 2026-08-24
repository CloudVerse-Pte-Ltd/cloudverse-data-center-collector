import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectKubeVirtResourceMetrics } from '../../src/connectors/openshift/kubevirt-resource-metrics.js';

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('KubeVirt Kubernetes resource metrics fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('joins virt-launcher compute usage to the immutable owning VM UID without calling it guest telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input).includes('metrics.k8s.io')
      ? response({ items: [{ metadata: { name: 'virt-launcher-finance-x' }, timestamp: '2026-08-24T06:00:00Z', window: '15.4s', containers: [{ name: 'compute', usage: { cpu: '12500000n', memory: '1536Mi' } }] }] })
      : response({ items: [{ metadata: { name: 'virt-launcher-finance-x', uid: 'pod-uid', labels: { 'vm.kubevirt.io/name': 'finance' } } }] })));
    const result = await collectKubeVirtResourceMetrics({ baseUrl: 'https://api.example', auth: { bearerToken: 'token' } }, [{ namespace: 'finance', name: 'finance', vmiUid: 'vmi-uid', vmUid: 'vm-uid' }]);
    expect(result.gaps).toEqual([]);
    expect(result.facts).toEqual([
      expect.objectContaining({ vmUid: 'vm-uid', vmiUid: 'vmi-uid', podUid: 'pod-uid', semanticMetric: 'host.vm.process.cpu.usage.cores', value: 0.0125, unit: 'cores', intervalSeconds: 16 }),
      expect.objectContaining({ vmUid: 'vm-uid', semanticMetric: 'host.vm.process.memory.working_set.bytes', value: 1610612736, unit: 'bytes' }),
    ]);
  });
});

