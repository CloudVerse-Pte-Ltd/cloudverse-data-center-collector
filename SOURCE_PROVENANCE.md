# Source provenance

The collector runtime and its vSphere/OpenShift connector dependency closure
were vendored from `CloudVerse-Pte-Ltd/GPU-Integrations` commit
`83c54a35` on 2026-08-22.

`GPU-Integrations` remains the authoritative shared connector SDK. This public
repository is the auditable distribution boundary: its release workflow builds
only the source committed here and records repository-native SBOM, provenance
and Sigstore evidence. A collector release must update this provenance record
when the vendored connector source changes.

The unrelated `autonomous-kubernetes-optimization` repository was inspected
only to confirm the established source-plus-workflow publishing layout. No
files, branches, settings or releases in that repository are modified by this
distribution.
