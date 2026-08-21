# CloudVerse Data Center Collector

Source and audited installers for the CloudVerse in-estate collector. The collector makes
outbound HTTPS connections only. Provider endpoints and credentials remain in
the customer estate and are never submitted to the CloudVerse UI or API.

## Supported installation modes

- VMware vSphere: rootless container on a Linux management host with network
  access to vCenter.
- OpenShift Virtualization: namespaced Deployment using a dedicated service
  account and read-only RBAC.
- Hyper-V/SCVMM: signed Windows collector package (published separately by the
  Windows release workflow).

Generate the one-time command from **Settings → Integrations → Data Center**.
The enrollment token expires after 30 minutes and is deleted after successful
registration.

Images are multi-architecture, SBOM-attested, and signed with Sigstore. The
installer refuses mutable image references unless explicitly overridden.

## Build from source

The Linux collector source is under `packages/gpu-finops/src`; the retained
directory layout preserves the shared connector SDK boundaries used by the
vSphere and OpenShift Virtualization adapters. Build and test it with:

```sh
npm ci
npm run typecheck
npm run build
npm test
```

Release images are built directly from this repository's `Dockerfile`; no
private source checkout or prebuilt application layer is used.

## Security model

- Ed25519 signing keys and transport tokens are generated inside the estate.
- Only public-key material and a SHA-256 transport-token verifier are enrolled.
- Provider credentials are stored in a root-owned local configuration file or
  Kubernetes Secret.
- Inventory and telemetry are signed before entering an encrypted local spool.
- Tenant, integration, collector, run, and immutable management-plane identity
  are verified by the CloudVerse control plane.

Copyright © CloudVerse Pte. Ltd. All rights reserved.
