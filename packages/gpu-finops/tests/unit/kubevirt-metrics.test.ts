import { describe, expect, it, vi } from 'vitest';
import { collectKubeVirtMetrics, discoverKubeVirtMetrics, toKubeVirtTelemetryEnvelope } from '../../src/index.js';

const config = { baseUrl: 'https://prometheus.example', auth: { bearerToken: 'secret' } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('C31 KubeVirt Prometheus/Thanos metrics', () => {
  it('discovers Prometheus retention and KubeVirt metric availability without defaults', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer secret');
      const url = new URL(String(input));
      if (url.pathname.endsWith('/status/buildinfo')) return response({ status: 'success', data: { version: '3.5.0' } });
      if (url.pathname.endsWith('/status/runtimeinfo')) return response({ status: 'success', data: { storageRetention: '15d' } });
      if (url.searchParams.get('query') === 'thanos_build_info') return response({ status: 'success', data: { result: [] } });
      return response({ status: 'success', data: { result: [{ value: [1, '2'] }] } });
    });
    await expect(discoverKubeVirtMetrics(config, fetchImpl)).resolves.toMatchObject({ backend: 'PROMETHEUS', version: '3.5.0', kubeVirtMetricsPresent: true, retention: '15d', retentionStatus: 'READY' });
  });

  it('reports unknown retention as blocked rather than inventing a duration', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/status/runtimeinfo')) return response({ status: 'success', data: {} });
      return response({ status: 'success', data: { result: [] } });
    });
    const result = await discoverKubeVirtMetrics(config, fetchImpl);
    expect(result.retention).toBeUndefined();
    expect(result.retentionStatus).toBe('BLOCKED');
  });

  it('maps metric labels through VMI and owning VM immutable UIDs', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const query = new URL(String(input)).searchParams.get('query');
      return response({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { namespace: 'finance', name: 'finance-vm', __name__: query }, values: [[1_777_000_000, '10'], [1_777_000_060, '20']] }] } });
    });
    const result = await collectKubeVirtMetrics({ config, identities: [{ namespace: 'finance', name: 'finance-vm', vmiUid: 'vmi-uid', vmUid: 'vm-uid' }], start: '2026-04-24T00:00:00Z', end: '2026-04-24T01:00:00Z', step: '60s', fetchImpl });
    expect(result.facts).toHaveLength(8);
    expect(result.facts.every((fact) => fact.vmiUid === 'vmi-uid' && fact.vmUid === 'vm-uid')).toBe(true);
    expect(new Set(result.facts.map((fact) => fact.semanticMetric))).toEqual(new Set(['guest.cpu.usage.seconds', 'guest.cpu.contention.seconds', 'guest.memory.used.bytes', 'guest.memory.available.bytes']));
    expect(result.gaps).toEqual([]);
  });

  it('records missing, ambiguous and ownerless UID mappings without emitting telemetry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ status: 'success', data: { result: [{ metric: { namespace: 'finance', name: 'vm' }, values: [[1_777_000_000, '1']] }] } }));
    const missing = await collectKubeVirtMetrics({ config, identities: [], start: '2026-04-24T00:00:00Z', end: '2026-04-24T01:00:00Z', step: '60s', fetchImpl });
    expect(missing.facts).toEqual([]); expect(missing.gaps.every((gap) => gap.code === 'VMI_UID_MAPPING_MISSING')).toBe(true);
    const ambiguous = await collectKubeVirtMetrics({ config, identities: [{ namespace: 'finance', name: 'vm', vmiUid: 'a', vmUid: 'vm-a' }, { namespace: 'finance', name: 'vm', vmiUid: 'b', vmUid: 'vm-b' }], start: '2026-04-24T00:00:00Z', end: '2026-04-24T01:00:00Z', step: '60s', fetchImpl });
    expect(ambiguous.gaps.every((gap) => gap.code === 'AMBIGUOUS_VMI_UID_MAPPING')).toBe(true);
    const ownerless = await collectKubeVirtMetrics({ config, identities: [{ namespace: 'finance', name: 'vm', vmiUid: 'a' }], start: '2026-04-24T00:00:00Z', end: '2026-04-24T01:00:00Z', step: '60s', fetchImpl });
    expect(ownerless.gaps.every((gap) => gap.code === 'VM_OWNER_UID_MISSING')).toBe(true);
  });

  it('builds a CPD metric envelope from owning VM UIDs and preserves explicit gaps', () => {
    const envelope = toKubeVirtTelemetryEnvelope({ integrationId: 7, managementPlaneUid: 'openshift:infra-uid', collectedAt: '2026-04-24T01:00:00Z', intervalSeconds: 60, expectedStart: '2026-04-24T00:00:00Z', expectedEnd: '2026-04-24T01:00:00Z', facts: [{ vmiUid: 'vmi-uid', vmUid: 'vm-uid', namespace: 'finance', name: 'vm', nativeMetric: 'kubevirt_vmi_memory_used_bytes', semanticMetric: 'guest.memory.used.bytes', observedAt: '2026-04-24T00:01:00Z', value: 1024, unit: 'bytes', aggregation: 'GAUGE', labels: {} }], gaps: [{ code: 'METRIC_QUERY_FAILED', nativeMetric: 'kubevirt_vmi_cpu_usage_seconds_total' }] });
    expect(envelope.metrics[0]).toMatchObject({ assetKind: 'VIRTUAL_MACHINE', sourceUid: 'vm-uid', value: '1024', retentionDays: 90 });
    expect(envelope.gaps[0]).toMatchObject({ semanticMetric: 'guest.cpu.usage.seconds', retryable: true, state: 'OPEN' });
  });
});
