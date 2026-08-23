import { describe, expect, it, vi } from 'vitest';
import { canonicalManagementPlaneUid, deliverTerminalFailure } from '../../src/on-prem-collector/runtime-contract.js';

describe('collector runtime contract', () => {
  it('requires immutable OpenShift identity before a run can start', () => {
    expect(() => canonicalManagementPlaneUid('OPENSHIFT_VIRTUALIZATION', undefined))
      .toThrow(/canonical cluster identity is unavailable/);
    expect(canonicalManagementPlaneUid('OPENSHIFT_VIRTUALIZATION', 'infra-UID'))
      .toBe('openshift:infra-UID');
  });

  it('normalizes vCenter UUID identity without accepting an empty value', () => {
    expect(canonicalManagementPlaneUid('VSPHERE', 'ABC-DEF')).toBe('vcenter:abc-def');
    expect(() => canonicalManagementPlaneUid('VCENTER', ' ')).toThrow(/service identity is unavailable/);
  });

  it('delivers connected signed failure evidence before terminating', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    await expect(deliverTerminalFailure('FAILED', 'CONNECTED', flush))
      .rejects.toThrow(/delivered to the control plane/);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('retains offline failure evidence without invoking transport', async () => {
    const flush = vi.fn();
    await expect(deliverTerminalFailure('FAILED', 'OFFLINE', flush))
      .rejects.toThrow(/offline spool/);
    expect(flush).not.toHaveBeenCalled();
  });

  it('does nothing for non-failed terminal outcomes', async () => {
    const flush = vi.fn();
    await expect(deliverTerminalFailure('PARTIAL', 'CONNECTED', flush)).resolves.toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });
});
