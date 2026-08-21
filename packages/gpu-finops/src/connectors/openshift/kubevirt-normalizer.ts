import type { KubeVirtInventoryRaw } from './kubevirt-client.js';

type JsonMap = Record<string, unknown>;
const map = (value: unknown): JsonMap => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const meta = (value: JsonMap) => map(value.metadata);
const ref = (namespace: string, kind: string, name: string) => `${namespace || '_cluster'}/${kind}/${name}`;

export interface KubeVirtResourceNode {
  id: string;
  uid: string;
  kind: string;
  namespace?: string;
  name: string;
  ownerIds: string[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
  attributes: Record<string, unknown>;
}

export interface KubeVirtRelationship { from: string; to: string; type: string }
export interface OpenShiftVirtualizationInventory { resources: KubeVirtResourceNode[]; relationships: KubeVirtRelationship[] }

function node(object: JsonMap, kind: string, attributes: Record<string, unknown> = {}): KubeVirtResourceNode {
  const metadata = meta(object); const namespace = String(metadata.namespace ?? ''); const name = String(metadata.name ?? 'unknown');
  const owners = array(metadata.ownerReferences).map(map).map((owner) => ref(namespace, String(owner.kind ?? 'Unknown'), String(owner.name ?? 'unknown')));
  return { id: ref(namespace, kind, name), uid: String(metadata.uid ?? ref(namespace, kind, name)), kind, namespace: namespace || undefined, name, ownerIds: owners,
    labels: map(metadata.labels) as Record<string, string>, annotations: map(metadata.annotations) as Record<string, string>, attributes };
}

export function normalizeOpenShiftVirtualizationInventory(raw: KubeVirtInventoryRaw): OpenShiftVirtualizationInventory {
  const resources: KubeVirtResourceNode[] = [];
  const relationships: KubeVirtRelationship[] = [];
  const add = (object: JsonMap, kind: string, attributes: Record<string, unknown> = {}) => { const resource = node(object, kind, attributes); resources.push(resource); for (const owner of resource.ownerIds) relationships.push({ from: resource.id, to: owner, type: 'OWNED_BY' }); return resource; };
  for (const vm of raw.virtualMachines) {
    const specification = map(vm.spec); const templateSpec = map(map(specification.template).spec); const resource = add(vm, 'VirtualMachine', {
      running: specification.running, runStrategy: specification.runStrategy,
      instanceType: map(specification.instancetype).name, preference: map(specification.preference).name,
    });
    for (const volume of array(templateSpec.volumes).map(map)) {
      const source = map(volume.dataVolume).name ? ref(resource.namespace ?? '', 'DataVolume', String(map(volume.dataVolume).name))
        : map(volume.persistentVolumeClaim).claimName ? ref(resource.namespace ?? '', 'PersistentVolumeClaim', String(map(volume.persistentVolumeClaim).claimName)) : undefined;
      if (source) relationships.push({ from: resource.id, to: source, type: 'USES_VOLUME' });
    }
  }
  for (const vmi of raw.virtualMachineInstances) {
    const specification = map(vmi.spec); const status = map(vmi.status); const ownerUid = String(array(meta(vmi).ownerReferences).map(map)[0]?.uid ?? '');
    const resource = add(vmi, 'VirtualMachineInstance', { phase: status.phase, nodeName: status.nodeName, vmOwnerUid: ownerUid, migrationState: status.migrationState });
    // VMI UID is an execution identity; VM owner UID remains the stable cost/inventory identity.
    if (ownerUid && resource.ownerIds[0]) relationships.push({ from: resource.id, to: resource.ownerIds[0], type: 'INSTANCE_OF_VM' });
    if (status.nodeName) relationships.push({ from: resource.id, to: ref('', 'Node', String(status.nodeName)), type: 'RUNS_ON' });
    void specification;
  }
  for (const migration of raw.virtualMachineInstanceMigrations) add(migration, 'VirtualMachineInstanceMigration', { vmiName: map(migration.spec).vmiName, phase: map(migration.status).phase });
  for (const item of raw.virtualMachineClusterInstanceTypes) add(item, 'VirtualMachineClusterInstancetype', { cpu: map(item.spec).cpu, memory: map(item.spec).memory });
  for (const item of raw.virtualMachineInstanceTypes) add(item, 'VirtualMachineInstancetype', { cpu: map(item.spec).cpu, memory: map(item.spec).memory });
  for (const dv of raw.dataVolumes) { const spec = map(dv.spec); const resource = add(dv, 'DataVolume', { source: spec.source, storage: spec.storage, phase: map(dv.status).phase }); const claimName = String(meta(dv).name ?? ''); if (claimName) relationships.push({ from: resource.id, to: ref(resource.namespace ?? '', 'PersistentVolumeClaim', claimName), type: 'MATERIALIZES_AS' }); }
  for (const pvc of raw.persistentVolumeClaims) { const spec = map(pvc.spec); const resource = add(pvc, 'PersistentVolumeClaim', { storageClassName: spec.storageClassName, volumeName: spec.volumeName, capacity: map(map(pvc.status).capacity).storage }); if (spec.storageClassName) relationships.push({ from: resource.id, to: ref('', 'StorageClass', String(spec.storageClassName)), type: 'USES_STORAGE_CLASS' }); }
  for (const storageClass of raw.storageClasses) add(storageClass, 'StorageClass', { provisioner: storageClass.provisioner, reclaimPolicy: storageClass.reclaimPolicy, volumeBindingMode: storageClass.volumeBindingMode });
  for (const snapshot of raw.volumeSnapshots) { const spec = map(snapshot.spec); const resource = add(snapshot, 'VolumeSnapshot', { readyToUse: map(snapshot.status).readyToUse }); const claim = map(spec.source).persistentVolumeClaimName; if (claim) relationships.push({ from: resource.id, to: ref(resource.namespace ?? '', 'PersistentVolumeClaim', String(claim)), type: 'SNAPSHOT_OF' }); }
  for (const snapshot of raw.virtualMachineSnapshots) { const resource = add(snapshot, 'VirtualMachineSnapshot', { phase: map(snapshot.status).phase }); const vmName = map(map(snapshot.spec).source).name; if (vmName) relationships.push({ from: resource.id, to: ref(resource.namespace ?? '', 'VirtualMachine', String(vmName)), type: 'SNAPSHOT_OF' }); }
  for (const item of raw.nodes) add(item, 'Node');
  for (const item of raw.namespaces) add(item, 'Namespace');
  const resourceIds = new Set(resources.map((resource) => resource.id));
  return { resources, relationships: relationships.filter((edge) => resourceIds.has(edge.from) && resourceIds.has(edge.to)) };
}
