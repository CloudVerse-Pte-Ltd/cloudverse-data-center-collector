#!/bin/sh
set -eu
command -v oc >/dev/null 2>&1 || { echo "oc is required" >&2; exit 1; }
NAMESPACE="${CLOUDVERSE_NAMESPACE:-cloudverse-system}"
oc set env deployment/cloudverse-data-center-collector -n "$NAMESPACE" COLLECTOR_ENROLLMENT_TOKEN_FILE-
oc set volume deployment/cloudverse-data-center-collector -n "$NAMESPACE" --remove --name=bootstrap
oc delete secret cloudverse-collector-bootstrap -n "$NAMESPACE" --ignore-not-found
oc rollout status deployment/cloudverse-data-center-collector -n "$NAMESPACE" --timeout=180s
echo "Bootstrap token and deployment reference removed."
