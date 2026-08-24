import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('public installer contract', () => {
  it('carries the selected scale class into the Linux runtime without shell patch artifacts', async () => {
    const source = await readFile('install.sh', 'utf8');
    expect(source).toContain('--scale-class) SCALE_CLASS="$2"')
    expect(source).toContain('-e COLLECTOR_PROVIDER=VSPHERE -e COLLECTOR_SCALE_CLASS="$SCALE_CLASS"')
    expect(source).not.toMatch(/(?:^|\s)\+(?:\s|$)/m)
    expect(source).toContain("'{baseUrl:$baseUrl,auth:{basic:{username:$username,password:$password}},propertyPageSize:500}'")
  });

  it('sizes the OpenShift spool and publishes the same scale-class evidence', async () => {
    const source = await readFile('install-openshift.sh', 'utf8');
    for (const [scaleClass, size] of [['S', '10Gi'], ['M', '50Gi'], ['L', '200Gi'], ['XL', '500Gi']]) {
      expect(source).toContain(`${scaleClass}) SPOOL_SIZE=${size}`)
    }
    expect(source).toContain('storage: $SPOOL_SIZE')
    expect(source).toContain('COLLECTOR_SCALE_CLASS, value: "$SCALE_CLASS"')
    expect(source).toContain('strategy: {type: Recreate}')
    expect(source).toContain('NODE_EXTRA_CA_CERTS, value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
    expect(source).toContain('oc auth can-i create clusterroles.rbac.authorization.k8s.io')
    expect(source).toContain('name: cloudverse-data-center-collector-monitoring-view')
    expect(source).toContain('name: cluster-monitoring-view')
    expect(source).toContain('bearerTokenFile')
    expect(source).toContain('thanos-querier')
    expect(source).not.toContain('oc new-project cloudverse-system')
  });
});
