import { readFile } from 'node:fs/promises';
import type { KubernetesConnectorConfig } from '../kubernetes/config.js';

type JsonMap = Record<string, unknown>;
const map = (value: unknown): JsonMap => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};

export interface KubeVirtResourceMetricIdentity { namespace: string; name: string; vmiUid: string; vmUid?: string }
export interface KubeVirtResourceMetricFact {
  vmUid: string; vmiUid: string; namespace: string; name: string; podUid: string; podName: string;
  observedAt: string; intervalSeconds: number; semanticMetric: 'host.vm.process.cpu.usage.cores' | 'host.vm.process.memory.working_set.bytes';
  nativeMetric: string; value: number; unit: 'cores' | 'bytes';
}

function endpoint(baseUrl: string, path: string) {
  const value = new URL(baseUrl); value.pathname = `${value.pathname.replace(/\/$/, '')}${path}`; value.search = ''; value.username = ''; value.password = ''; return value;
}

async function request(config: KubernetesConnectorConfig, path: string): Promise<JsonMap> {
  const fileToken = config.auth?.serviceAccountTokenFile ? (await readFile(config.auth.serviceAccountTokenFile, 'utf8')).trim() : undefined;
  const token = config.auth?.bearerToken ?? fileToken;
  const response = await fetch(endpoint(config.baseUrl, path), { headers: { Accept: 'application/json', ...(config.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw Object.assign(new Error(`Kubernetes Metrics API returned HTTP ${response.status}`), { status: response.status, path });
  return map(await response.json());
}

function cpuCores(quantity: string): number {
  const match = quantity.match(/^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/); if (!match) throw new Error(`Unsupported Kubernetes CPU quantity: ${quantity}`);
  const value = Number(match[1]); return value * (match[2] === 'n' ? 1e-9 : match[2] === 'u' ? 1e-6 : match[2] === 'm' ? 1e-3 : 1);
}

function memoryBytes(quantity: string): number {
  const match = quantity.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/); if (!match) throw new Error(`Unsupported Kubernetes memory quantity: ${quantity}`);
  const powers: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(match[1]) * (powers[match[2] ?? ''] ?? 1);
}

export async function collectKubeVirtResourceMetrics(config: KubernetesConnectorConfig, identities: KubeVirtResourceMetricIdentity[]) {
  const facts: KubeVirtResourceMetricFact[] = []; const gaps: Array<{ code: string; namespace?: string; name?: string; details?: Record<string, unknown> }> = [];
  const byVm = new Map(identities.map((identity) => [`${identity.namespace}/${identity.name}`, identity]));
  const namespaces = [...new Set(identities.map((identity) => identity.namespace).filter(Boolean))];
  for (const namespace of namespaces) {
    try {
      const [podsBody, metricsBody] = await Promise.all([
        request(config, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`),
        request(config, `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`),
      ]);
      const pods = new Map((Array.isArray(podsBody.items) ? podsBody.items : []).map(map).map((pod) => [String(map(pod.metadata).name ?? ''), pod]));
      for (const metricValue of Array.isArray(metricsBody.items) ? metricsBody.items : []) {
        const metric = map(metricValue); const metadata = map(metric.metadata); const podName = String(metadata.name ?? ''); const pod = pods.get(podName); if (!pod) continue;
        const podMetadata = map(pod.metadata); const labels = map(podMetadata.labels); const vmName = String(labels['vm.kubevirt.io/name'] ?? labels['kubevirt.io/domain'] ?? '');
        const identity = byVm.get(`${namespace}/${vmName}`); if (!identity?.vmUid) continue;
        const compute = (Array.isArray(metric.containers) ? metric.containers : []).map(map).find((container) => container.name === 'compute');
        if (!compute) { gaps.push({ code: 'VIRT_LAUNCHER_COMPUTE_METRICS_MISSING', namespace, name: vmName, details: { podName } }); continue; }
        const usage = map(compute.usage); const observedAt = new Date(String(metric.timestamp)).toISOString(); const windowSeconds = Math.max(1, Math.ceil(Number.parseFloat(String(metric.window ?? '60s'))));
        const common = { vmUid: identity.vmUid, vmiUid: identity.vmiUid, namespace, name: vmName, podUid: String(podMetadata.uid ?? ''), podName, observedAt, intervalSeconds: windowSeconds };
        if (typeof usage.cpu === 'string') facts.push({ ...common, semanticMetric: 'host.vm.process.cpu.usage.cores', nativeMetric: 'metrics.k8s.io/virt-launcher/compute/cpu', value: cpuCores(usage.cpu), unit: 'cores' });
        if (typeof usage.memory === 'string') facts.push({ ...common, semanticMetric: 'host.vm.process.memory.working_set.bytes', nativeMetric: 'metrics.k8s.io/virt-launcher/compute/memory', value: memoryBytes(usage.memory), unit: 'bytes' });
      }
    } catch (error) { gaps.push({ code: 'KUBERNETES_RESOURCE_METRICS_FAILED', namespace, details: { message: error instanceof Error ? error.message : String(error) } }); }
  }
  return { facts, gaps };
}

