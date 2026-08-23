export type LinuxCollectorProvider = 'VCENTER' | 'VSPHERE' | 'OPENSHIFT_VIRTUALIZATION';

export function canonicalManagementPlaneUid(
  provider: LinuxCollectorProvider,
  discoveredIdentity: string | undefined,
): string {
  const identity = discoveredIdentity?.trim();
  if (!identity) {
    throw new Error(provider === 'OPENSHIFT_VIRTUALIZATION'
      ? 'OpenShift canonical cluster identity is unavailable; verify read access to config.openshift.io/infrastructures/cluster'
      : 'vCenter canonical service identity is unavailable');
  }
  return provider === 'OPENSHIFT_VIRTUALIZATION' ? `openshift:${identity}` : `vcenter:${identity.toLowerCase()}`;
}

export async function deliverTerminalFailure(
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  mode: 'CONNECTED' | 'STORE_FORWARD' | 'OFFLINE',
  flushOnce?: () => Promise<unknown>,
): Promise<void> {
  if (status !== 'FAILED') return;
  if (mode !== 'OFFLINE') {
    if (!flushOnce) throw new Error('Connected collector failure delivery worker is unavailable');
    await flushOnce();
  }
  throw new Error(mode === 'OFFLINE'
    ? 'Provider collection failed; signed failure evidence remains in the offline spool'
    : 'Provider collection failed; signed failure evidence was delivered to the control plane');
}
