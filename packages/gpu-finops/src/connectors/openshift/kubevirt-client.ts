import { readFile } from 'node:fs/promises';
import type { KubernetesConnectorConfig } from '../kubernetes/config.js';
import { validateKubernetesConnectorConfig } from '../kubernetes/config.js';
import { KubernetesConnectorError } from '../kubernetes/errors.js';

type JsonMap = Record<string, unknown>;

export interface KubeVirtApiResource {
  name: string;
  kind: string;
  namespaced: boolean;
  verbs: string[];
}

export interface OpenShiftVirtualizationCapability {
  platform: 'OPENSHIFT';
  kubernetesVersion: string;
  openshiftVersion?: string;
  apiGroups: string[];
  kubeVirt: {
    present: boolean;
    version?: string;
    resources: KubeVirtApiResource[];
  };
  permissionChecks: Array<{ resource: string; verb: 'get' | 'list' | 'watch'; allowed: boolean }>;
  managementPlaneUid?: string;
  clusterName?: string;
  identityStatus: 'READY' | 'BLOCKED';
}

export interface KubeVirtInventoryRaw {
  virtualMachines: JsonMap[];
  virtualMachineInstances: JsonMap[];
  virtualMachineInstanceMigrations: JsonMap[];
  virtualMachineClusterInstanceTypes: JsonMap[];
  virtualMachineInstanceTypes: JsonMap[];
  dataVolumes: JsonMap[];
  persistentVolumeClaims: JsonMap[];
  storageClasses: JsonMap[];
  volumeSnapshots: JsonMap[];
  virtualMachineSnapshots: JsonMap[];
  nodes: JsonMap[];
  namespaces: JsonMap[];
}

export interface KubeVirtInventoryFailure { resource: string; path: string; code: string; message: string; status?: number }
export interface KubeVirtInventoryCollection { inventory: KubeVirtInventoryRaw; failures: KubeVirtInventoryFailure[]; coverage: { scope: 'CLUSTER' | 'NAMESPACES'; namespaces: string[] } }

export interface OpenShiftVirtualizationClient {
  discover(): Promise<OpenShiftVirtualizationCapability>;
  collectInventory(): Promise<KubeVirtInventoryCollection>;
}

export interface OpenShiftVirtualizationClientOptions {
  fetchImpl?: typeof fetch;
  pageLimit?: number;
  maxPages?: number;
  namespaces?: string[];
  sourceConcurrency?: number;
}

function requestLimiter(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
    throw new KubernetesConnectorError('invalid_source_concurrency', 'OpenShift source concurrency must be between 1 and 16.', false);
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => {
    if (active < limit) { active += 1; return Promise.resolve(); }
    return new Promise<void>((resolve) => waiting.push(() => { active += 1; resolve(); }));
  };
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try { return await operation(); } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function endpoint(baseUrl: string, path: string, query?: Record<string, string>): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function headers(config: KubernetesConnectorConfig): Promise<Headers> {
  const fileToken = config.auth?.serviceAccountTokenFile
    ? (await readFile(config.auth.serviceAccountTokenFile, 'utf8')).trim()
    : undefined;
  const token = config.auth?.bearerToken ?? fileToken;
  return new Headers({ Accept: 'application/json', ...(config.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) });
}

function map(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function createOpenShiftVirtualizationClient(
  config: KubernetesConnectorConfig,
  options: OpenShiftVirtualizationClientOptions = {},
): OpenShiftVirtualizationClient {
  const validation = validateKubernetesConnectorConfig(config);
  if (!validation.valid) throw new KubernetesConnectorError('invalid_openshift_config', 'OpenShift connector config is invalid.', false, { findings: validation.findings });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new KubernetesConnectorError('fetch_unavailable', 'Global fetch is unavailable in this Node runtime.', false);
  const pageLimit = options.pageLimit ?? 500;
  const maxPages = options.maxPages ?? 10_000;
  const limited = requestLimiter(options.sourceConcurrency ?? 4);

  async function get(path: string, query?: Record<string, string>): Promise<JsonMap> {
    const response = await limited(async () => fetchImpl(endpoint(config.baseUrl, path, query), { method: 'GET', headers: await headers(config) }));
    if (!response.ok) throw new KubernetesConnectorError('openshift_api_error', `OpenShift API returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500, { status: response.status, path });
    return map(await response.json());
  }

  async function post(path: string, body: JsonMap): Promise<JsonMap> {
    const requestHeaders = await headers(config); requestHeaders.set('Content-Type', 'application/json');
    const response = await limited(() => fetchImpl(endpoint(config.baseUrl, path), { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) }));
    if (!response.ok) throw new KubernetesConnectorError('openshift_api_error', `OpenShift API returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500, { status: response.status, path });
    return map(await response.json());
  }

  async function list(path: string): Promise<JsonMap[]> {
    const items: JsonMap[] = [];
    let continuation = '';
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const body = await get(path, { limit: String(pageLimit), ...(continuation ? { continue: continuation } : {}) });
      items.push(...(Array.isArray(body.items) ? body.items.map(map) : []));
      const next = String(map(body.metadata).continue ?? '');
      if (!next) return items;
      if (seen.has(next)) throw new KubernetesConnectorError('openshift_paging_cycle', 'OpenShift API repeated a continuation token.', false, { path });
      seen.add(next);
      continuation = next;
    }
    throw new KubernetesConnectorError('openshift_page_limit_exceeded', 'OpenShift inventory exceeded the configured maximum page count.', false, { path, maxPages });
  }

  return {
    async discover() {
      const [version, groups, kubevirt, openshift, access, infrastructure] = await Promise.all([
        get('/version'), get('/apis'),
        get('/apis/subresources.kubevirt.io/v1').catch((): JsonMap => ({})),
        get('/apis/config.openshift.io/v1/clusteroperators/version').catch((): JsonMap => ({})),
        post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
          apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: options.namespaces?.[0] ?? '' },
        }).catch((): JsonMap => ({})),
        get('/apis/config.openshift.io/v1/infrastructures/cluster').catch((): JsonMap => ({})),
      ]);
      const groupNames = (Array.isArray(groups.groups) ? groups.groups : []).map((group) => String(map(group).name ?? '')).filter(Boolean);
      const resources = (Array.isArray(kubevirt.resources) ? kubevirt.resources : []).map((resource) => ({
        name: String(map(resource).name ?? ''), kind: String(map(resource).kind ?? ''),
        namespaced: Boolean(map(resource).namespaced), verbs: strings(map(resource).verbs),
      })).filter((resource) => resource.name);
      const accessStatus = map(access.status);
      const rules = Array.isArray(accessStatus.resourceRules) ? accessStatus.resourceRules.map(map) : [];
      const allowed = (resource: string, verb: 'get' | 'list' | 'watch') => rules.some((rule) => strings(rule.resources).includes(resource) && strings(rule.verbs).some((candidate) => candidate === verb || candidate === '*'));
      const checks = ['virtualmachines', 'virtualmachineinstances', 'virtualmachineinstancemigrations', 'datavolumes', 'persistentvolumeclaims'].flatMap((resource) =>
        (['get', 'list', 'watch'] as const).map((verb) => ({ resource, verb, allowed: allowed(resource, verb) })),
      );
      const history = Array.isArray(map(openshift.status).history) ? map(openshift.status).history as JsonMap[] : [];
      return {
        platform: 'OPENSHIFT', kubernetesVersion: String(version.gitVersion ?? version.gitVersionString ?? 'unknown'),
        openshiftVersion: history.length ? String(map(history[0]).version ?? '') || undefined : undefined,
        apiGroups: groupNames,
        kubeVirt: { present: groupNames.includes('kubevirt.io'), version: String(kubevirt.groupVersion ?? '') || undefined, resources },
        permissionChecks: checks,
        managementPlaneUid: typeof map(infrastructure.metadata).uid === 'string' ? String(map(infrastructure.metadata).uid) : undefined,
        clusterName: typeof map(infrastructure.status).infrastructureName === 'string'
          ? String(map(infrastructure.status).infrastructureName)
          : typeof map(infrastructure.metadata).name === 'string'
            ? String(map(infrastructure.metadata).name)
            : undefined,
        identityStatus: typeof map(infrastructure.metadata).uid === 'string' ? 'READY' : 'BLOCKED',
      };
    },
    async collectInventory() {
      const failures: KubeVirtInventoryFailure[] = [];
      const scopedNamespaces = [...new Set((options.namespaces ?? []).map((value) => value.trim()).filter(Boolean))];
      const safe = async (resource: string, path: string) => {
        try { return await list(path); } catch (error) {
          const details = error instanceof KubernetesConnectorError ? error.details : undefined;
          failures.push({ resource, path, code: error instanceof KubernetesConnectorError ? error.code : 'openshift_api_error', message: error instanceof Error ? error.message : 'Unknown OpenShift API error', status: typeof details?.status === 'number' ? details.status : undefined });
          return [];
        }
      };
      const scoped = async (resource: string, groupPath: string) => scopedNamespaces.length
        ? (await Promise.all(scopedNamespaces.map((namespace) => safe(resource, `${groupPath}/namespaces/${encodeURIComponent(namespace)}/${resource}`)))).flat()
        : safe(resource, `${groupPath}/${resource}`);
      const entries = await Promise.all([
        scoped('virtualmachines', '/apis/kubevirt.io/v1'), scoped('virtualmachineinstances', '/apis/kubevirt.io/v1'),
        scoped('virtualmachineinstancemigrations', '/apis/kubevirt.io/v1'), safe('virtualmachineclusterinstancetypes', '/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes'),
        scoped('virtualmachineinstancetypes', '/apis/instancetype.kubevirt.io/v1beta1'), scoped('datavolumes', '/apis/cdi.kubevirt.io/v1beta1'),
        scoped('persistentvolumeclaims', '/api/v1'), safe('storageclasses', '/apis/storage.k8s.io/v1/storageclasses'),
        scoped('volumesnapshots', '/apis/snapshot.storage.k8s.io/v1'), scoped('virtualmachinesnapshots', '/apis/snapshot.kubevirt.io/v1beta1'),
        safe('nodes', '/api/v1/nodes'), scopedNamespaces.length
          ? Promise.all(scopedNamespaces.map((namespace) => safe('namespaces', `/api/v1/namespaces/${encodeURIComponent(namespace)}`))).then((values) => values.flat())
          : safe('namespaces', '/api/v1/namespaces'),
      ]);
      return { inventory: {
        virtualMachines: entries[0], virtualMachineInstances: entries[1], virtualMachineInstanceMigrations: entries[2],
        virtualMachineClusterInstanceTypes: entries[3], virtualMachineInstanceTypes: entries[4], dataVolumes: entries[5],
        persistentVolumeClaims: entries[6], storageClasses: entries[7], volumeSnapshots: entries[8], virtualMachineSnapshots: entries[9],
        nodes: entries[10], namespaces: entries[11],
      }, failures, coverage: { scope: scopedNamespaces.length ? 'NAMESPACES' : 'CLUSTER', namespaces: scopedNamespaces } };
    },
  };
}
