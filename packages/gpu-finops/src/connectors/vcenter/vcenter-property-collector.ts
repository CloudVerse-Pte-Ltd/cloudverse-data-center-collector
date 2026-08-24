import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { VCenterConnectorError } from './errors.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (name) => ['objects', 'propSet', 'perfCounter', 'PerfCounterInfo', 'historicalInterval', 'PerfInterval'].includes(name),
});
const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!);
const envelope = (body: string) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

export interface PropertyCollectorObject {
  type: string;
  value: string;
  properties: Record<string, unknown>;
}
export interface VCenterPropertyCollectorResult { objects: PropertyCollectorObject[]; pages: number }

export type VCenterInventoryResourceKind =
  | 'DATACENTER'
  | 'FOLDER'
  | 'CLUSTER'
  | 'RESOURCE_POOL'
  | 'HOST'
  | 'VIRTUAL_MACHINE'
  | 'TEMPLATE'
  | 'DATASTORE'
  | 'NETWORK';

export interface VCenterInventoryResource {
  id: string;
  kind: VCenterInventoryResourceKind;
  sourceUid: string;
  name: string;
  attributes: Record<string, unknown>;
}

export interface VCenterInventoryRelationship {
  from: string;
  to: string;
  type: 'MEMBER_OF' | 'RUNS_ON' | 'USES_DATASTORE';
}

export interface VCenterInventoryEnvelope {
  type: 'VSPHERE_INVENTORY';
  integrationId: number;
  managementPlaneUid: string;
  collectedAt: string;
  pages: number;
  resources: VCenterInventoryResource[];
  relationships: VCenterInventoryRelationship[];
}

export interface VCenterPerformanceCounter {
  key: number;
  groupKey: string;
  nameKey: string;
  rollupType: string;
  statsType: string;
  unitKey: string;
  level: number;
  perDeviceLevel: number;
  /** Stable semantic key used by the metric registry, for example cpu.usage.average. */
  semantic: string;
}

export interface VCenterHistoricalInterval {
  key: number;
  name: string;
  samplingPeriodSeconds: number;
  lengthSeconds: number;
  level: number;
  enabled: boolean;
}

export interface VCenterPerformanceProbeResult {
  performanceManagerUid: string;
  counters: VCenterPerformanceCounter[];
  intervals: VCenterHistoricalInterval[];
  counterCount: number;
  maxQueryMetrics?: number;
  capability: {
    capability: 'PROBE_COUNTERS';
    status: 'READY' | 'BLOCKED';
    diagnostics: Record<string, unknown>;
  };
}

export interface VCenterPerformanceEntity { type: 'VirtualMachine' | 'HostSystem'; value: string; assetId: string }
export interface VCenterPerformanceFact { assetId: string; entity: VCenterPerformanceEntity; semantic: string; counterId: number; observedAt: string; intervalSeconds: number; value: string; unit: string; aggregation: string }
export interface VCenterPerformanceGap { assetId: string; entity: VCenterPerformanceEntity; semantic: string; reason: string; evidence: Record<string, unknown> }
export interface VCenterPerformanceCollectionResult { facts: VCenterPerformanceFact[]; gaps: VCenterPerformanceGap[]; requests: number; points: number }

export interface VCenterServiceIdentity {
  instanceUuid: string;
  productLineId: string;
  version: string;
  build: string;
  apiType: string;
}

const text = (value: unknown): string => {
  if (value && typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text']);
  return value === undefined || value === null ? '' : String(value);
};
const integer = (value: unknown): number => {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};
const boolean = (value: unknown): boolean => text(value).toLowerCase() === 'true';

function counterFromSoap(value: any): VCenterPerformanceCounter {
  const groupKey = text(value?.groupInfo?.key);
  const nameKey = text(value?.nameInfo?.key);
  const rollupType = text(value?.rollupType);
  return {
    key: integer(value?.key),
    groupKey,
    nameKey,
    rollupType,
    statsType: text(value?.statsType),
    unitKey: text(value?.unitInfo?.key),
    level: integer(value?.level),
    perDeviceLevel: integer(value?.perDeviceLevel),
    semantic: [groupKey, nameKey, rollupType].filter(Boolean).join('.'),
  };
}

function intervalFromSoap(value: any): VCenterHistoricalInterval {
  return {
    key: integer(value?.key),
    name: text(value?.name),
    samplingPeriodSeconds: integer(value?.samplingPeriod),
    lengthSeconds: integer(value?.length),
    level: integer(value?.level),
    enabled: boolean(value?.enabled),
  };
}

/** Reads the vCenter ServiceInstance identity and authenticates the SOAP plane. */
export async function discoverVCenterServiceIdentity(input: {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<VCenterServiceIdentity> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL('/sdk', input.baseUrl);
  let cookie = '';
  const call = async (body: string): Promise<string> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'urn:vim25/8.0.3',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: envelope(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const xml = await response.text();
    if (!response.ok) throw new VCenterConnectorError('vcenter_soap_failed', `vCenter SOAP request failed with HTTP ${response.status}.`, response.status >= 500);
    return xml;
  };
  const document = parser.parse(await call(
    '<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>',
  ));
  const service = document?.Envelope?.Body?.RetrieveServiceContentResponse?.returnval;
  const sessionManager = text(service?.sessionManager);
  const instanceUuid = text(service?.about?.instanceUuid);
  if (!sessionManager || !instanceUuid) {
    throw new VCenterConnectorError('vcenter_immutable_identity_missing', 'vCenter did not expose ServiceInstance about.instanceUuid.', false);
  }
  await call(`<vim25:Login><vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this><vim25:userName>${escapeXml(input.username)}</vim25:userName><vim25:password>${escapeXml(input.password)}</vim25:password></vim25:Login>`);
  return {
    instanceUuid,
    productLineId: text(service?.about?.productLineId),
    version: text(service?.about?.version),
    build: text(service?.about?.build),
    apiType: text(service?.about?.apiType),
  };
}

function readResult(xml: string): { objects: PropertyCollectorObject[]; token?: string } {
  const parsed = parser.parse(xml);
  const body = parsed?.Envelope?.Body;
  if (body?.Fault) throw new VCenterConnectorError('vcenter_soap_fault', body.Fault?.faultstring ?? 'vCenter SOAP fault.', false);
  const result = body?.RetrievePropertiesExResponse?.returnval ?? body?.ContinueRetrievePropertiesExResponse?.returnval;
  const rawObjects = result?.objects;
  const objects = (Array.isArray(rawObjects) ? rawObjects : rawObjects ? [rawObjects] : []).map((entry: any) => ({
    type: String(entry?.obj?.['@_type'] ?? ''), value: String(entry?.obj?.['#text'] ?? entry?.obj ?? ''),
    properties: Object.fromEntries((Array.isArray(entry?.propSet) ? entry.propSet : entry?.propSet ? [entry.propSet] : []).map((prop: any) => [String(prop?.name), prop?.val])),
  }));
  const tokenValue = result?.token;
  const token = String(tokenValue?.['#text'] ?? tokenValue ?? '').trim();
  return { objects, token: token || undefined };
}

function propertySpec(): string {
  const specs: Record<string, string[]> = {
    Datacenter: ['name', 'parent', 'datastoreFolder', 'hostFolder', 'networkFolder', 'vmFolder'], Folder: ['name', 'parent'],
    ClusterComputeResource: ['name', 'parent', 'host', 'resourcePool'],
    ResourcePool: ['name', 'parent', 'resourcePool', 'vm'],
    HostSystem: ['name', 'parent', 'hardware.systemInfo.uuid', 'hardware.cpuInfo', 'hardware.memorySize', 'datastore', 'vm'],
    VirtualMachine: ['name', 'parent', 'config.instanceUuid', 'config.uuid', 'config.template', 'config.hardware', 'config.hardware.device', 'config.annotation', 'config.extraConfig', 'runtime.host', 'resourcePool', 'datastore', 'snapshot.rootSnapshotList', 'availableField', 'customValue'],
    Datastore: ['name', 'parent', 'summary.url', 'summary.type', 'summary.capacity', 'summary.freeSpace', 'host', 'vm'],
    Network: ['name', 'parent', 'summary', 'host', 'vm'],
    DistributedVirtualPortgroup: ['name', 'parent', 'summary', 'host', 'vm', 'config.key', 'config.distributedVirtualSwitch'],
  };
  return Object.entries(specs).map(([type, paths]) => `<vim25:propSet><vim25:type>${type}</vim25:type><vim25:all>false</vim25:all>${paths.map((path) => `<vim25:pathSet>${path}</vim25:pathSet>`).join('')}</vim25:propSet>`).join('');
}

const containerViewTraversal = (view: string) => `<vim25:objectSet><vim25:obj type="ContainerView">${escapeXml(view)}</vim25:obj><vim25:skip>true</vim25:skip><vim25:selectSet xsi:type="vim25:TraversalSpec" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><vim25:name>containerViewToObjects</vim25:name><vim25:type>ContainerView</vim25:type><vim25:path>view</vim25:path><vim25:skip>false</vim25:skip></vim25:selectSet></vim25:objectSet>`;

export async function collectWithPropertyCollector(input: {
  baseUrl: string; username: string; password: string; fetchImpl?: typeof fetch; pageSize?: number;
}): Promise<VCenterPropertyCollectorResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL('/sdk', input.baseUrl);
  let cookie = '';
  const call = async (body: string): Promise<string> => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:vim25/8.0.3', ...(cookie ? { Cookie: cookie } : {}) }, body: envelope(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const xml = await response.text();
    if (!response.ok) throw new VCenterConnectorError('vcenter_soap_failed', `vCenter SOAP request failed with HTTP ${response.status}.`, response.status >= 500);
    return xml;
  };
  const content = parser.parse(await call('<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>'));
  const service = content?.Envelope?.Body?.RetrieveServiceContentResponse?.returnval;
  const sessionManager = String(service?.sessionManager?.['#text'] ?? service?.sessionManager);
  const propertyCollector = String(service?.propertyCollector?.['#text'] ?? service?.propertyCollector);
  const rootFolder = String(service?.rootFolder?.['#text'] ?? service?.rootFolder);
  const viewManager = String(service?.viewManager?.['#text'] ?? service?.viewManager);
  if (!sessionManager || !propertyCollector || !rootFolder || !viewManager) throw new VCenterConnectorError('vcenter_inventory_managers_unavailable', 'vCenter did not expose the required session, property, root-folder, and view managers.', false);
  await call(`<vim25:Login><vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this><vim25:userName>${escapeXml(input.username)}</vim25:userName><vim25:password>${escapeXml(input.password)}</vim25:password></vim25:Login>`);
  const types = ['Folder', 'Datacenter', 'ClusterComputeResource', 'ResourcePool', 'HostSystem', 'VirtualMachine', 'Datastore', 'Network', 'DistributedVirtualPortgroup'];
  const objects: PropertyCollectorObject[] = [];
  let pages = 0;
  for (const type of types) {
    const viewResponse = parser.parse(await call(`<vim25:CreateContainerView><vim25:_this type="ViewManager">${escapeXml(viewManager)}</vim25:_this><vim25:container type="Folder">${escapeXml(rootFolder)}</vim25:container><vim25:type>${type}</vim25:type><vim25:recursive>true</vim25:recursive></vim25:CreateContainerView>`));
    const viewValue = viewResponse?.Envelope?.Body?.CreateContainerViewResponse?.returnval;
    const view = String(viewValue?.['#text'] ?? viewValue ?? '');
    if (!view) throw new VCenterConnectorError('vcenter_container_view_unavailable', `vCenter did not create the recursive ${type} ContainerView.`, false);
    try {
      const first = await call(`<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this><vim25:specSet>${propertySpec()}${containerViewTraversal(view)}</vim25:specSet><vim25:options><vim25:maxObjects>${input.pageSize ?? 500}</vim25:maxObjects></vim25:options></vim25:RetrievePropertiesEx>`);
      let page = readResult(first); pages += 1; objects.push(...page.objects);
      const tokens = new Set<string>();
      while (page.token) {
        if (pages >= 10_000 || tokens.has(page.token)) throw new VCenterConnectorError('vcenter_cursor_cycle', 'PropertyCollector token limit/cycle detected.', false);
        tokens.add(page.token);
        page = readResult(await call(`<vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this><vim25:token>${escapeXml(page.token)}</vim25:token></vim25:ContinueRetrievePropertiesEx>`));
        objects.push(...page.objects); pages += 1;
      }
    } finally {
      await call(`<vim25:DestroyView><vim25:_this type="ContainerView">${escapeXml(view)}</vim25:_this></vim25:DestroyView>`).catch(() => undefined);
    }
  }
  const uniqueObjects = [...new Map(objects.map((object) => [`${object.type}:${object.value}`, object])).values()];
  return { objects: uniqueObjects, pages };
}

const propertyText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text'] ?? '');
  return '';
};

const propertyRefs = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(propertyRefs);
  if (!value || typeof value !== 'object') return propertyText(value) ? [propertyText(value)] : [];
  const record = value as Record<string, unknown>;
  const direct = propertyText(value);
  if (direct) return [direct];
  return Object.entries(record)
    .filter(([key]) => !key.startsWith('@_'))
    .flatMap(([, nested]) => propertyRefs(nested));
};

const stableHash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

const normalizedUuid = (value: unknown): string | undefined => {
  const candidate = propertyText(value).trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : undefined;
};

/**
 * Converts a complete, paged PropertyCollector result into the canonical
 * topology envelope consumed by CPD. MOR values are used only as local graph
 * references. Canonical identities prefer source UUIDs and otherwise use a
 * management-plane-scoped digest, so duplicate names cannot merge assets.
 */
export function toVCenterInventoryEnvelope(input: {
  integrationId: number;
  identity: VCenterServiceIdentity;
  collectedAt: string;
  result: VCenterPropertyCollectorResult;
}): VCenterInventoryEnvelope {
  if (!Number.isSafeInteger(input.integrationId) || input.integrationId <= 0) {
    throw new VCenterConnectorError('vcenter_inventory_scope_invalid', 'vCenter integrationId must be a positive integer.', false);
  }
  const collectedAt = new Date(input.collectedAt);
  const instanceUuid = normalizedUuid(input.identity.instanceUuid);
  if (!instanceUuid || !Number.isFinite(collectedAt.valueOf()) || !Number.isSafeInteger(input.result.pages) || input.result.pages < 1) {
    throw new VCenterConnectorError('vcenter_inventory_scope_invalid', 'vCenter inventory identity, time, or paging evidence is invalid.', false);
  }
  const managementPlaneUid = `vcenter:${instanceUuid}`;
  const byMor = new Map(input.result.objects.map((object) => [`${object.type}:${object.value}`, object]));
  const resourceId = (object: PropertyCollectorObject) => `${object.type}:${object.value}`;
  const sourceUid = (object: PropertyCollectorObject) => {
    if (object.type === 'VirtualMachine') {
      return normalizedUuid(object.properties['config.instanceUuid'])
        ?? normalizedUuid(object.properties['config.uuid'])
        ?? stableHash(managementPlaneUid, object.type, object.value);
    }
    if (object.type === 'HostSystem') {
      return normalizedUuid(object.properties['hardware.systemInfo.uuid'])
        ?? stableHash(managementPlaneUid, object.type, object.value);
    }
    if (object.type === 'Datastore') {
      const url = propertyText(object.properties['summary.url']).trim();
      return stableHash(managementPlaneUid, object.type, url || object.value);
    }
    return stableHash(managementPlaneUid, object.type, object.value);
  };
  const kind = (object: PropertyCollectorObject): VCenterInventoryResourceKind | undefined => {
    if (object.type === 'Datacenter') return 'DATACENTER';
    if (object.type === 'Folder') return 'FOLDER';
    if (object.type === 'ClusterComputeResource') return 'CLUSTER';
    if (object.type === 'ResourcePool') return 'RESOURCE_POOL';
    if (object.type === 'HostSystem') return 'HOST';
    if (object.type === 'VirtualMachine') return propertyText(object.properties['config.template']).toLowerCase() === 'true' ? 'TEMPLATE' : 'VIRTUAL_MACHINE';
    if (object.type === 'Datastore') return 'DATASTORE';
    if (object.type === 'Network' || object.type === 'DistributedVirtualPortgroup') return 'NETWORK';
    return undefined;
  };
  const resources = input.result.objects.flatMap((object): VCenterInventoryResource[] => {
    const resourceKind = kind(object);
    if (!resourceKind || !object.value.trim()) return [];
    const name = propertyText(object.properties.name).trim();
    if (!name) throw new VCenterConnectorError('vcenter_inventory_name_missing', `${object.type} ${object.value} has no source name.`, false);
    return [{
      id: resourceId(object),
      kind: resourceKind,
      sourceUid: sourceUid(object),
      name,
      attributes: {
        sourceObjectType: object.type,
        sourceManagedObjectReference: object.value,
        ...(normalizedUuid(object.properties['config.instanceUuid']) ? { instanceUuid: normalizedUuid(object.properties['config.instanceUuid']) } : {}),
        ...(normalizedUuid(object.properties['config.uuid']) ? { biosUuid: normalizedUuid(object.properties['config.uuid']) } : {}),
        template: resourceKind === 'TEMPLATE',
        ...(propertyText(object.properties['summary.url']) ? { datastoreUrl: propertyText(object.properties['summary.url']) } : {}),
        ...(propertyText(object.properties['summary.type']) ? { datastoreType: propertyText(object.properties['summary.type']) } : {}),
        ...(propertyText(object.properties['summary.capacity']) ? { capacityBytes: propertyText(object.properties['summary.capacity']) } : {}),
        ...(propertyText(object.properties['summary.freeSpace']) ? { freeSpaceBytes: propertyText(object.properties['summary.freeSpace']) } : {}),
        ...(propertyText(object.properties['config.annotation']) ? { annotation: propertyText(object.properties['config.annotation']) } : {}),
        ...(propertyText(object.properties['config.key']) ? { distributedPortgroupKey: propertyText(object.properties['config.key']) } : {}),
        ...(propertyText(object.properties['config.distributedVirtualSwitch']) ? { distributedVirtualSwitchMor: propertyText(object.properties['config.distributedVirtualSwitch']) } : {}),
      },
    }];
  });
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const relationships: VCenterInventoryRelationship[] = [];
  const add = (from: string, targetMor: string, targetTypes: string[], type: VCenterInventoryRelationship['type']) => {
    const target = targetTypes.map((candidate) => `${candidate}:${targetMor}`).find((candidate) => byMor.has(candidate) && resourceIds.has(candidate));
    if (resourceIds.has(from) && target) relationships.push({ from, to: target, type });
  };
  for (const object of input.result.objects) {
    const from = resourceId(object);
    const parent = propertyText(object.properties.parent);
    if (parent) add(from, parent, ['Folder', 'Datacenter', 'ClusterComputeResource', 'ResourcePool'], 'MEMBER_OF');
    const host = propertyText(object.properties['runtime.host']);
    if (host) add(from, host, ['HostSystem'], 'RUNS_ON');
    const pool = propertyText(object.properties.resourcePool);
    if (pool) add(from, pool, ['ResourcePool'], 'MEMBER_OF');
    for (const datastore of propertyRefs(object.properties.datastore)) add(from, datastore, ['Datastore'], 'USES_DATASTORE');
  }
  const uniqueRelationships = [...new Map(relationships.map((relationship) => [`${relationship.from}|${relationship.to}|${relationship.type}`, relationship])).values()];
  return {
    type: 'VSPHERE_INVENTORY',
    integrationId: input.integrationId,
    managementPlaneUid,
    collectedAt: collectedAt.toISOString(),
    pages: input.result.pages,
    resources,
    relationships: uniqueRelationships,
  };
}

/**
 * Probes PerformanceManager before any utilisation collection is enabled.
 * The probe deliberately returns the source counter catalogue and historical
 * intervals instead of assuming counter IDs or retention from another estate.
 */
export async function probeVCenterPerformanceCounters(input: {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<VCenterPerformanceProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL('/sdk', input.baseUrl);
  let cookie = '';
  const call = async (body: string): Promise<string> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'urn:vim25/8.0.3',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: envelope(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const xml = await response.text();
    if (!response.ok) {
      throw new VCenterConnectorError(
        'vcenter_soap_failed',
        `vCenter SOAP request failed with HTTP ${response.status}.`,
        response.status >= 500,
      );
    }
    return xml;
  };

  const serviceContent = parser.parse(await call(
    '<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>',
  ));
  const service = serviceContent?.Envelope?.Body?.RetrieveServiceContentResponse?.returnval;
  const sessionManager = text(service?.sessionManager);
  const propertyCollector = text(service?.propertyCollector);
  const performanceManager = text(service?.perfManager);
  const optionManager = text(service?.setting);
  if (!sessionManager || !propertyCollector || !performanceManager) {
    throw new VCenterConnectorError(
      'vcenter_performance_manager_unavailable',
      'vCenter did not expose the required session, property, and performance managers.',
      false,
    );
  }

  await call(`<vim25:Login><vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this><vim25:userName>${escapeXml(input.username)}</vim25:userName><vim25:password>${escapeXml(input.password)}</vim25:password></vim25:Login>`);
  const propertiesXml = await call(
    `<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this><vim25:specSet><vim25:propSet><vim25:type>PerformanceManager</vim25:type><vim25:all>false</vim25:all><vim25:pathSet>perfCounter</vim25:pathSet><vim25:pathSet>historicalInterval</vim25:pathSet></vim25:propSet><vim25:objectSet><vim25:obj type="PerformanceManager">${escapeXml(performanceManager)}</vim25:obj><vim25:skip>false</vim25:skip></vim25:objectSet></vim25:specSet><vim25:options/></vim25:RetrievePropertiesEx>`,
  );
  const propertiesDocument = parser.parse(propertiesXml);
  const returnValue = propertiesDocument?.Envelope?.Body?.RetrievePropertiesExResponse?.returnval;
  const object = Array.isArray(returnValue?.objects) ? returnValue.objects[0] : returnValue?.objects;
  const properties = Object.fromEntries(
    (Array.isArray(object?.propSet) ? object.propSet : []).map((property: any) => [text(property?.name), property?.val]),
  ) as Record<string, any>;
  const counterValues = properties.perfCounter?.perfCounter ?? properties.perfCounter?.PerfCounterInfo ?? properties.perfCounter;
  const intervalValues = properties.historicalInterval?.historicalInterval ?? properties.historicalInterval?.PerfInterval ?? properties.historicalInterval;
  const counters = (Array.isArray(counterValues) ? counterValues : counterValues ? [counterValues] : []).map(counterFromSoap);
  const intervals = (Array.isArray(intervalValues) ? intervalValues : intervalValues ? [intervalValues] : []).map(intervalFromSoap);

  let maxQueryMetrics: number | undefined;
  if (optionManager) {
    try {
      const optionsDocument = parser.parse(await call(
        `<vim25:QueryOptions><vim25:_this type="OptionManager">${escapeXml(optionManager)}</vim25:_this><vim25:name>config.vpxd.stats.maxQueryMetrics</vim25:name></vim25:QueryOptions>`,
      ));
      const values = optionsDocument?.Envelope?.Body?.QueryOptionsResponse?.returnval;
      const rows = Array.isArray(values) ? values : values ? [values] : [];
      const match = rows.find((row: any) => text(row?.key) === 'config.vpxd.stats.maxQueryMetrics');
      const parsed = integer(match?.value);
      if (parsed > 0) maxQueryMetrics = parsed;
    } catch {
      // Advanced-setting visibility is optional. Counter/interval discovery is
      // still useful, but the collector must apply its conservative local cap.
    }
  }

  const diagnostics = {
    counterCount: counters.length,
    enabledIntervalCount: intervals.filter((interval) => interval.enabled).length,
    maxQueryMetrics: maxQueryMetrics ?? null,
    maxQueryMetricsSource: maxQueryMetrics ? 'vcenter_advanced_setting' : 'collector_conservative_default',
  };
  return {
    performanceManagerUid: performanceManager,
    counters,
    intervals,
    counterCount: counters.length,
    maxQueryMetrics,
    capability: {
      capability: 'PROBE_COUNTERS',
      status: counters.length > 0 ? 'READY' : 'BLOCKED',
      diagnostics,
    },
  };
}

/** Bounded QueryPerf collection using only counters discovered by the live probe. */
export async function collectVCenterPerformance(input: {
  baseUrl: string; username: string; password: string; probe: VCenterPerformanceProbeResult;
  entities: VCenterPerformanceEntity[]; semantics: string[]; startTime: string; endTime: string;
  intervalId: number; fetchImpl?: typeof fetch; conservativeMetricCap?: number;
}): Promise<VCenterPerformanceCollectionResult> {
  if (input.probe.capability.status !== 'READY') throw new VCenterConnectorError('vcenter_counter_probe_blocked', 'Performance collection requires a READY counter probe.', false);
  if (!input.entities.length || input.entities.length > 256 || new Set(input.entities.map((item) => `${item.type}:${item.value}`)).size !== input.entities.length) throw new VCenterConnectorError('vcenter_performance_entity_bound', 'Performance collection requires 1..256 unique entities.', false);
  const start = new Date(input.startTime); const end = new Date(input.endTime);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end <= start || end.valueOf() - start.valueOf() > 31 * 86_400_000) throw new VCenterConnectorError('vcenter_performance_window_invalid', 'Performance window must be positive and no longer than 31 days.', false);
  const interval = input.probe.intervals.find((item) => item.key === input.intervalId && item.enabled);
  if (!interval) throw new VCenterConnectorError('vcenter_performance_interval_unavailable', 'Requested performance interval was not discovered as enabled.', false);
  const bySemantic = new Map(input.probe.counters.map((counter) => [counter.semantic, counter]));
  const counters = [...new Set(input.semantics)].map((semantic) => bySemantic.get(semantic)).filter((item): item is VCenterPerformanceCounter => Boolean(item));
  if (counters.length !== new Set(input.semantics).size) throw new VCenterConnectorError('vcenter_performance_counter_unavailable', 'A requested semantic counter was not discovered by the live probe.', false);
  const cap = Math.max(1, Math.min(input.probe.maxQueryMetrics ?? input.conservativeMetricCap ?? 64, 256));
  const entityBatchSize = Math.max(1, Math.floor(cap / counters.length));
  const fetchImpl = input.fetchImpl ?? fetch; const url = new URL('/sdk', input.baseUrl); let cookie = '';
  const call = async (body: string) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:vim25/8.0.3', ...(cookie ? { Cookie: cookie } : {}) }, body: envelope(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const xml = await response.text();
    if (!response.ok) {
      const fault = parser.parse(xml)?.Envelope?.Body?.Fault;
      const detail = text(fault?.faultstring).trim();
      throw new VCenterConnectorError('vcenter_soap_failed', `vCenter SOAP request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`, response.status >= 500);
    }
    return xml;
  };
  const content = parser.parse(await call('<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>'));
  const service = content?.Envelope?.Body?.RetrieveServiceContentResponse?.returnval; const sessionManager = text(service?.sessionManager); const perfManager = text(service?.perfManager);
  if (!sessionManager || !perfManager) throw new VCenterConnectorError('vcenter_performance_manager_unavailable', 'vCenter did not expose the performance manager.', false);
  await call(`<vim25:Login><vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this><vim25:userName>${escapeXml(input.username)}</vim25:userName><vim25:password>${escapeXml(input.password)}</vim25:password></vim25:Login>`);
  const facts: VCenterPerformanceFact[] = []; const gaps: VCenterPerformanceGap[] = []; let requests = 0;
  for (let offset = 0; offset < input.entities.length; offset += entityBatchSize) {
    const batch = input.entities.slice(offset, offset + entityBatchSize);
    const specs = batch.map((entity) => `<vim25:querySpec><vim25:entity type="${entity.type}">${escapeXml(entity.value)}</vim25:entity><vim25:startTime>${start.toISOString()}</vim25:startTime><vim25:endTime>${end.toISOString()}</vim25:endTime>${counters.map((counter) => `<vim25:metricId><vim25:counterId>${counter.key}</vim25:counterId><vim25:instance></vim25:instance></vim25:metricId>`).join('')}<vim25:intervalId>${interval.samplingPeriodSeconds}</vim25:intervalId><vim25:format>csv</vim25:format></vim25:querySpec>`).join('');
    const parsed = parser.parse(await call(`<vim25:QueryPerf><vim25:_this type="PerformanceManager">${escapeXml(perfManager)}</vim25:_this>${specs}</vim25:QueryPerf>`)); requests += 1;
    const rawRows = parsed?.Envelope?.Body?.QueryPerfResponse?.returnval; const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
    const returned = new Set<string>();
    for (const row of rows) {
      const ref = text(row?.entity); const entity = batch.find((item) => item.value === ref); if (!entity) continue;
      const sampleTokens = text(row?.sampleInfoCSV).split(',').map((item) => item.trim()).filter(Boolean);
      const timestamps = sampleTokens.filter((item) => /^\d{4}-\d{2}-\d{2}T/.test(item));
      const series = Array.isArray(row?.value) ? row.value : row?.value ? [row.value] : [];
      for (const value of series) {
        const counterId = integer(value?.id?.counterId); const counter = counters.find((item) => item.key === counterId); if (!counter) continue;
        returned.add(`${entity.value}:${counter.semantic}`); const values = text(value?.value).split(',').map((item) => item.trim());
        for (let index = 0; index < Math.min(values.length, timestamps.length); index += 1) {
          if (!/^-?\d+(\.\d+)?$/.test(values[index]) || values[index] === '-1') { gaps.push({ assetId: entity.assetId, entity, semantic: counter.semantic, reason: 'MISSING_SAMPLE', evidence: { timestamp: timestamps[index], sourceValue: values[index] } }); continue; }
          facts.push({ assetId: entity.assetId, entity, semantic: counter.semantic, counterId, observedAt: new Date(timestamps[index]).toISOString(), intervalSeconds: interval.samplingPeriodSeconds, value: values[index], unit: counter.unitKey, aggregation: counter.rollupType });
          if (facts.length > 1_000_000) throw new VCenterConnectorError('vcenter_performance_point_bound', 'Performance response exceeded the 1,000,000-point safety bound.', false);
        }
      }
    }
    for (const entity of batch) for (const counter of counters) if (!returned.has(`${entity.value}:${counter.semantic}`)) gaps.push({ assetId: entity.assetId, entity, semantic: counter.semantic, reason: 'SERIES_NOT_RETURNED', evidence: { startTime: start.toISOString(), endTime: end.toISOString(), intervalKey: input.intervalId, samplingPeriodSeconds: interval.samplingPeriodSeconds } });
  }
  return { facts, gaps, requests, points: facts.length };
}

export const VCENTER_CANONICAL_SEMANTIC: Readonly<Record<string, string>> = {
  'cpu.usage.average': 'guest.cpu.usage.percent',
  'cpu.ready.summation': 'guest.cpu.contention.milliseconds',
  'mem.usage.average': 'guest.memory.consumed.percent',
  'mem.active.average': 'guest.memory.active.bytes',
};

export type VCenterTelemetryEnvelope = ReturnType<typeof toVCenterTelemetryEnvelope>;

export function toVCenterTelemetryEnvelope(input: { integrationId: number; managementPlaneUid: string; metricSet: string; expectedStart: string; expectedEnd: string; facts: VCenterPerformanceFact[]; gaps: VCenterPerformanceGap[] }) {
  if (!Number.isSafeInteger(input.integrationId) || input.integrationId <= 0 || !/^vcenter:[0-9a-f-]{36}$/i.test(input.managementPlaneUid) || !input.metricSet.trim() || !Number.isFinite(Date.parse(input.expectedStart)) || !Number.isFinite(Date.parse(input.expectedEnd)) || new Date(input.expectedEnd) <= new Date(input.expectedStart)) throw new VCenterConnectorError('vcenter_metric_envelope_invalid', 'vCenter metric envelope scope or window is invalid.', false);
  const assetKind = (entity: VCenterPerformanceEntity) => entity.type === 'VirtualMachine' ? 'VIRTUAL_MACHINE' as const : 'HOST' as const;
  const canonicalSourceUid = (assetId: string) => {
    const value = assetId.trim().toLowerCase();
    if (!value) throw new VCenterConnectorError('vcenter_metric_asset_identity_missing', 'vCenter metric entity has no canonical inventory source UID.', false);
    return value;
  };
  return {
    type: 'DATA_CENTER_METRICS' as const, integrationId: input.integrationId, managementPlaneUid: input.managementPlaneUid, collectedAt: new Date(input.expectedEnd).toISOString(), platform: 'VCENTER' as const, metricSet: input.metricSet,
    metrics: input.facts.map((fact) => {
      const semanticMetric = VCENTER_CANONICAL_SEMANTIC[fact.semantic]; if (!semanticMetric) throw new VCenterConnectorError('vcenter_metric_semantic_unmapped', `vCenter semantic ${fact.semantic} is not mapped to the canonical registry.`, false);
      return { assetKind: assetKind(fact.entity), sourceUid: canonicalSourceUid(fact.assetId), semanticMetric, nativeMetric: fact.semantic, observedAt: fact.observedAt, intervalSeconds: fact.intervalSeconds, value: fact.value, unit: fact.unit, aggregation: fact.aggregation.toUpperCase(), retentionClass: 'TELEMETRY' as const, retentionDays: 90, provenance: { counterId: fact.counterId, entityType: fact.entity.type, sourceManagedObjectReference: fact.entity.value } };
    }),
    gaps: input.gaps.map((gap) => ({ assetKind: assetKind(gap.entity), sourceUid: canonicalSourceUid(gap.assetId), semanticMetric: VCENTER_CANONICAL_SEMANTIC[gap.semantic] ?? gap.semantic, expectedStart: new Date(input.expectedStart).toISOString(), expectedEnd: new Date(input.expectedEnd).toISOString(), reasonClass: gap.reason, retryable: gap.reason === 'SERIES_NOT_RETURNED', state: 'OPEN' as const, evidence: { ...gap.evidence, sourceManagedObjectReference: gap.entity.value } })),
  };
}
