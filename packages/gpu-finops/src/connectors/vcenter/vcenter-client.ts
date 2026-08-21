import type { VCenterConnectorConfig } from './config.js';
import { VCenterConnectorError } from './errors.js';
import { discoverVCenterServiceIdentity } from './vcenter-property-collector.js';

export interface VCenterPlatformDiscovery {
  managementPlaneUid: string;
  apiOrigin: string;
  version: Record<string, unknown>;
  deploymentType: unknown;
  privileges: unknown[];
  datacenterCount: number;
  capabilities: Array<{ capability: string; status: 'READY' | 'BLOCKED' | 'ERROR'; diagnostics?: Record<string, unknown> }>;
}
export interface VCenterNativeInventory {
  datacenters: unknown[];
  folders: unknown[];
  clusters: unknown[];
  resourcePools: unknown[];
  hosts: unknown[];
  vms: unknown[];
  pages: number;
}
export interface VCenterStorageTopology {
  datastores: unknown[];
  networks: unknown[];
  disks: Array<{ vm: string; devices: unknown[] }>;
  snapshots: Array<{ vm: string; snapshots: unknown[] }>;
  nics: Array<{ vm: string; devices: unknown[] }>;
  tags: unknown[];
  tagAssociations: unknown[];
  capabilities: Array<{ capability: string; status: 'READY' | 'BLOCKED'; diagnostics?: Record<string, unknown> }>;
}

export interface VCenterClient {
  inventory(): Promise<unknown>;
  discoverPlatform(): Promise<VCenterPlatformDiscovery>;
  nativeInventory(): Promise<VCenterNativeInventory>;
  storageTopology(vmIds?: string[]): Promise<VCenterStorageTopology>;
}

function sanitizedUrl(baseUrl: string): URL {
  const base = new URL(baseUrl);
  base.username = '';
  base.password = '';
  return base;
}

function authHeaders(config: VCenterConnectorConfig): Record<string, string> {
  if (config.auth?.bearerToken) {
    return { Authorization: `Bearer ${config.auth.bearerToken}` };
  }
  if (config.auth?.basic) {
    const encoded = Buffer.from(`${config.auth.basic.username}:${config.auth.basic.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new VCenterConnectorError('vcenter_query_timeout', 'vCenter query timed out.', true, { timeoutMs });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createVCenterClient(config: VCenterConnectorConfig, options?: { fetchImpl?: typeof fetch }): VCenterClient {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxRetries = config.maxRetries ?? 1;
  const inventoryPath = config.inventoryPath ?? '/api/vcenter/inventory';

  if (!config.baseUrl) {
    throw new VCenterConnectorError('vcenter_base_url_required', 'vCenter baseUrl is required for REST collection.', false);
  }

  const base = sanitizedUrl(config.baseUrl!);
  const origin = base.origin;
  const request = async (path: string, init: RequestInit = {}, sessionId?: string): Promise<unknown> => {
    const url = new URL(path.replace(/^\//, ''), `${origin}/`);
    const headers = new Headers({
      Accept: 'application/json', ...(config.headers ?? {}),
      ...(sessionId ? { 'vmware-api-session-id': sessionId } : authHeaders(config)),
    });
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetchWithTimeout(fetchImpl, url, { ...init, headers }, timeoutMs);
    if (!response.ok) throw new VCenterConnectorError('vcenter_query_failed', `vCenter query failed with HTTP ${response.status}.`, response.status >= 500, { status: response.status, path });
    if (response.status === 204) return null;
    return response.json();
  };
  const session = async (): Promise<string> => {
    if (config.auth?.bearerToken) return config.auth.bearerToken;
    if (!config.auth?.basic) throw new VCenterConnectorError('vcenter_auth_required', 'vCenter basic credentials or session token are required.', false);
    const token = await request('/api/session', { method: 'POST' });
    if (typeof token !== 'string' || !token) throw new VCenterConnectorError('vcenter_session_invalid', 'vCenter returned an invalid session.', false);
    return token;
  };
  const listAll = async (path: string, sessionId: string): Promise<{ items: unknown[]; pages: number }> => {
    const items: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages >= 1_000) throw new VCenterConnectorError('vcenter_page_limit', `vCenter paging exceeded the 1000-page safety limit for ${path}.`, false);
      const separator = path.includes('?') ? '&' : '?';
      const response = await request(cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path, {}, sessionId);
      const pageItems = Array.isArray(response)
        ? response
        : response && typeof response === 'object' && Array.isArray((response as { items?: unknown[] }).items)
          ? (response as { items: unknown[] }).items : null;
      if (!pageItems) throw new VCenterConnectorError('vcenter_response_invalid', `vCenter list response for ${path} is not an array/page.`, false);
      const documentedRestLimit = path === '/api/vcenter/vm' ? 4_000 : path === '/api/vcenter/datastore' ? 2_500 : undefined;
      if (Array.isArray(response) && documentedRestLimit && pageItems.length >= documentedRestLimit) {
        throw new VCenterConnectorError(
          'vcenter_rest_result_limit',
          `vCenter REST result for ${path} reached its documented ${documentedRestLimit}-record limit; use PropertyCollector paging.`,
          false,
          { path, documentedRestLimit },
        );
      }
      items.push(...pageItems);
      if (items.length > 1_000_000) throw new VCenterConnectorError('vcenter_record_limit', `vCenter inventory exceeded the record safety limit for ${path}.`, false);
      const next = !Array.isArray(response) && response && typeof response === 'object'
        ? (response as { next_cursor?: unknown; nextCursor?: unknown }).next_cursor ?? (response as { nextCursor?: unknown }).nextCursor
        : undefined;
      cursor = typeof next === 'string' && next ? next : undefined;
      if (cursor && cursors.has(cursor)) throw new VCenterConnectorError('vcenter_cursor_cycle', `vCenter repeated a cursor for ${path}.`, false);
      if (cursor) cursors.add(cursor);
      pages += 1;
    } while (cursor);
    return { items, pages };
  };

  return {
    async inventory() {
      const base = sanitizedUrl(config.baseUrl!);
      const path = inventoryPath.startsWith('/') ? inventoryPath.slice(1) : inventoryPath;
      const url = new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);
      const headers = new Headers({ Accept: 'application/json', ...(config.headers ?? {}), ...authHeaders(config) });

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers }, timeoutMs);
          if (!response.ok) {
            throw new VCenterConnectorError('vcenter_query_failed', `vCenter query failed with HTTP ${response.status}.`, response.status >= 500, {
              status: response.status,
            });
          }
          return await response.json();
        } catch (error) {
          lastError = error;
          const retryable = error instanceof VCenterConnectorError ? error.retryable : false;
          if (!retryable || attempt === maxRetries) {
            throw error;
          }
        }
      }
      throw lastError;
    },
    async discoverPlatform() {
      const sessionId = await session();
      const serviceIdentity = config.auth?.basic
        ? await discoverVCenterServiceIdentity({
          baseUrl: origin,
          username: config.auth.basic.username,
          password: config.auth.basic.password,
          fetchImpl,
        })
        : config.managementPlaneUid
          ? { instanceUuid: config.managementPlaneUid.replace(/^vcenter:/i, '') }
          : null;
      if (!serviceIdentity?.instanceUuid) {
        throw new VCenterConnectorError(
          'vcenter_immutable_identity_required',
          'Session-token discovery requires the immutable vCenter ServiceInstance UUID captured during credential validation.',
          false,
        );
      }
      const probes = await Promise.allSettled([
        request('/api/appliance/system/version', {}, sessionId),
        request('/api/vcenter/system-config/deployment-type', {}, sessionId),
        request('/api/vcenter/authorization/privilege', {}, sessionId),
        request('/api/vcenter/datacenter', {}, sessionId),
      ]);
      const [version, deployment, privileges, datacenters] = probes;
      if (version.status === 'rejected' || deployment.status === 'rejected') {
        throw version.status === 'rejected' ? version.reason : (deployment as PromiseRejectedResult).reason;
      }
      const privilegeValues = privileges.status === 'fulfilled' && Array.isArray(privileges.value) ? privileges.value : [];
      const datacenterValues = datacenters.status === 'fulfilled' && Array.isArray(datacenters.value) ? datacenters.value : [];
      return {
        managementPlaneUid: `vcenter:${serviceIdentity.instanceUuid.toLowerCase()}`,
        apiOrigin: origin,
        version: (version.value && typeof version.value === 'object' ? version.value : { value: version.value }) as Record<string, unknown>,
        deploymentType: deployment.value,
        privileges: privilegeValues,
        datacenterCount: datacenterValues.length,
        capabilities: [
          { capability: 'AUTHENTICATE', status: 'READY' },
          { capability: 'DESCRIBE_PLATFORM', status: 'READY' },
          { capability: 'DISCOVER_PLANES', status: 'READY', diagnostics: { datacenterCount: datacenterValues.length } },
          privileges.status === 'fulfilled'
            ? { capability: 'DISCOVER_INVENTORY', status: 'READY', diagnostics: { privilegeCount: privilegeValues.length } }
            : { capability: 'DISCOVER_INVENTORY', status: 'BLOCKED', diagnostics: { reason: 'privilege_probe_failed' } },
        ],
      };
    },
    async nativeInventory() {
      const sessionId = await session();
      const paths = [
        '/api/vcenter/datacenter', '/api/vcenter/folder', '/api/vcenter/cluster',
        '/api/vcenter/resource-pool', '/api/vcenter/host', '/api/vcenter/vm',
      ] as const;
      const results = await Promise.all(paths.map((path) => listAll(path, sessionId)));
      return {
        datacenters: results[0].items, folders: results[1].items, clusters: results[2].items,
        resourcePools: results[3].items, hosts: results[4].items, vms: results[5].items,
        pages: results.reduce((sum, result) => sum + result.pages, 0),
      };
    },
    async storageTopology(vmIds) {
      const sessionId = await session();
      const [datastores, networks, vmPage] = await Promise.all([
        listAll('/api/vcenter/datastore', sessionId),
        listAll('/api/vcenter/network', sessionId),
        vmIds ? Promise.resolve({ items: vmIds.map((vm) => ({ vm })), pages: 0 }) : listAll('/api/vcenter/vm', sessionId),
      ]);
      const ids = vmPage.items.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') return String((entry as { vm?: unknown }).vm ?? '');
        return '';
      }).filter(Boolean);
      const disks: Array<{ vm: string; devices: unknown[] }> = [];
      const snapshots: Array<{ vm: string; snapshots: unknown[] }> = [];
      const nics: Array<{ vm: string; devices: unknown[] }> = [];
      let snapshotBlocked = false;
      for (let offset = 0; offset < ids.length; offset += 8) {
        await Promise.all(ids.slice(offset, offset + 8).map(async (vm) => {
          const encoded = encodeURIComponent(vm);
          const [diskResult, snapshotResult, nicResult] = await Promise.allSettled([
            request(`/api/vcenter/vm/${encoded}/hardware/disk`, {}, sessionId),
            request(`/api/vcenter/vm/${encoded}/snapshots`, {}, sessionId),
            request(`/api/vcenter/vm/${encoded}/hardware/ethernet`, {}, sessionId),
          ]);
          if (diskResult.status === 'rejected') throw diskResult.reason;
          if (nicResult.status === 'rejected') throw nicResult.reason;
          disks.push({ vm, devices: Array.isArray(diskResult.value) ? diskResult.value : [] });
          nics.push({ vm, devices: Array.isArray(nicResult.value) ? nicResult.value : [] });
          if (snapshotResult.status === 'fulfilled') snapshots.push({ vm, snapshots: Array.isArray(snapshotResult.value) ? snapshotResult.value : [] });
          else snapshotBlocked = true;
        }));
      }
      const tagList = await Promise.resolve(request('/api/cis/tagging/tag', {}, sessionId)).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );
      const tagIds = tagList.status === 'fulfilled' && Array.isArray(tagList.value) ? tagList.value.filter((value): value is string => typeof value === 'string') : [];
      const tagAssociations = tagList.status === 'fulfilled'
        ? await Promise.resolve(request('/api/cis/tagging/tag-association?action=list-attached-objects-on-tags', { method: 'POST', body: JSON.stringify({ tag_ids: tagIds }) }, sessionId)).catch(() => [])
        : [];
      return {
        datastores: datastores.items, networks: networks.items, disks, snapshots, nics,
        tags: tagList.status === 'fulfilled' && Array.isArray(tagList.value) ? tagList.value : [],
        tagAssociations: Array.isArray(tagAssociations) ? tagAssociations : [],
        capabilities: [
          { capability: 'DESCRIBE_CAPACITY', status: 'READY', diagnostics: { datastoreCount: datastores.items.length, diskCount: disks.reduce((sum, entry) => sum + entry.devices.length, 0) } },
          { capability: 'SNAPSHOTS', status: snapshotBlocked ? 'BLOCKED' : 'READY' },
          { capability: 'TAGS', status: tagList.status === 'fulfilled' ? 'READY' : 'BLOCKED' },
        ],
      };
    },
  };
}
