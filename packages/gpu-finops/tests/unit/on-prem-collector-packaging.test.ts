import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), 'utf8');

describe('on-prem collector packaging controls', () => {
  it('runs as non-root with a read-only root filesystem and no service-account token', async () => {
    const deployment = await read('deploy/on-prem-collector/kubernetes.yaml');
    expect(deployment).toContain('automountServiceAccountToken: false');
    expect(deployment).toContain('runAsNonRoot: true');
    expect(deployment).toContain('readOnlyRootFilesystem: true');
    expect(deployment).toContain('allowPrivilegeEscalation: false');
    expect(deployment).toContain('drop: ["ALL"]');
    expect(deployment).not.toMatch(/kind:\s*(Service|Ingress)\b/);
    expect(deployment).toContain('startupProbe:');
    expect(deployment).toContain('livenessProbe:');
    expect(deployment).toContain('readinessProbe:');
    expect(deployment).toContain('--healthcheck');
    expect(deployment).toContain('--readiness-check');
  });

  it('pins the maintained multi-architecture base image by immutable digest', async () => {
    const dockerfile = await read('deploy/on-prem-collector/Dockerfile');
    expect(dockerfile).toMatch(/ARG NODE_BASE=node:22-alpine3\.22@sha256:[0-9a-f]{64}/);
    expect(dockerfile.match(/FROM \$\{NODE_BASE\}/g)).toHaveLength(2);
  });

  it('uses file-mounted credentials and an exact DNS-aware egress placeholder', async () => {
    const deployment = await read('deploy/on-prem-collector/kubernetes.yaml');
    expect(deployment).toContain('COLLECTOR_BEARER_TOKEN_FILE');
    expect(deployment).not.toContain('name: COLLECTOR_BEARER_TOKEN,');
    expect(deployment).toContain('toFQDNs:');
    expect(deployment).not.toContain('0.0.0.0/0');
  });

  it('builds multi-architecture images and signs and attests their digest', async () => {
    const workflow = await read('.github/workflows/release-image.yml');
    expect(workflow).toContain('--platform linux/amd64,linux/arm64');
    expect(workflow).toMatch(/actions\/attest-sbom@[0-9a-f]{40}/);
    expect(workflow).toContain('cosign sign --yes');
    expect(workflow).toContain('@${{ steps.image.outputs.digest }}');
  });

  it('ships recovery, rotation, incident, upgrade and policy-gated offboarding procedures', async () => {
    const runbook = await read('deploy/on-prem-collector/RUNBOOK.md');
    for (const section of ['SaaS or network outage', 'Offline export and import', 'Spool-key rotation', 'Signature, tamper or credential incident', 'Disaster recovery', 'Upgrade and rollback', 'Offboarding']) {
      expect(runbook).toContain(`## ${section}`);
    }
    expect(runbook).toContain('ratified P0-D06');
    expect(runbook).toContain('Do not improvise retention');
  });
});
