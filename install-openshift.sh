#!/bin/sh
set -eu
CONTROL_PLANE_URL=""; ORG_ID=""; INTEGRATION_ID=""; SCALE_CLASS=""; ENROLLMENT_TOKEN=""
IMAGE="${COLLECTOR_IMAGE:-ghcr.io/cloudverse-pte-ltd/cloudverse-data-center-collector@sha256:612f6ae6e2158048bf3cd5a90363aecd296c526a67ee6ee5b67e8ba6931ca85c}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --org-id) ORG_ID="$2"; shift 2 ;;
    --integration-id) INTEGRATION_ID="$2"; shift 2 ;;
    --scale-class) SCALE_CLASS="$2"; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="$2"; shift 2 ;;
    *) exit 2 ;;
  esac
done
if [ -z "$CONTROL_PLANE_URL" ] || [ -z "$ORG_ID" ] ||
  [ -z "$INTEGRATION_ID" ] || [ -z "$SCALE_CLASS" ] || [ -z "$ENROLLMENT_TOKEN" ]; then
  exit 2
fi
case "$SCALE_CLASS" in
  S) SPOOL_SIZE=10Gi ;;
  M) SPOOL_SIZE=50Gi ;;
  L) SPOOL_SIZE=200Gi ;;
  XL) SPOOL_SIZE=500Gi ;;
  *) exit 2 ;;
esac
case "$IMAGE" in *@sha256:*) ;; *) [ "${COLLECTOR_ALLOW_MUTABLE_IMAGE:-false}" = "true" ] || { echo "Collector image must be digest-pinned" >&2; exit 1; } ;; esac
command -v oc >/dev/null 2>&1 || { echo "oc is required" >&2; exit 1; }
API_HOST="$(printf '%s' "$CONTROL_PLANE_URL" | sed -E 's#^https://([^/]+).*$#\1#')"

if ! oc auth can-i create clusterroles.rbac.authorization.k8s.io >/dev/null 2>&1 ||
  ! oc auth can-i create clusterrolebindings.rbac.authorization.k8s.io >/dev/null 2>&1; then
  echo "CloudVerse OpenShift discovery requires an installer identity that can create the read-only cluster RBAC used for canonical cluster identity and inventory." >&2
  exit 1
fi
if ! oc get namespace cloudverse-system >/dev/null 2>&1; then
  oc create namespace cloudverse-system >/dev/null
fi
oc create secret generic cloudverse-collector-bootstrap --from-literal=enrollment-token="$ENROLLMENT_TOKEN" --dry-run=client -o yaml | oc apply -f -
unset ENROLLMENT_TOKEN
oc create configmap cloudverse-collector-config --from-literal=provider.json='{"kubernetes":{"baseUrl":"https://kubernetes.default.svc","platformHint":"OPENSHIFT","auth":{"serviceAccountTokenFile":"/var/run/secrets/kubernetes.io/serviceaccount/token"}}}' --dry-run=client -o yaml | oc apply -f -
cat <<EOF | oc apply -f -
apiVersion: v1
kind: ServiceAccount
metadata: {name: cloudverse-data-center-collector, namespace: cloudverse-system}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: cloudverse-data-center-collector-read}
rules:
- apiGroups: [""]
  resources: [nodes,namespaces,persistentvolumeclaims]
  verbs: [get,list,watch]
- apiGroups: [kubevirt.io]
  resources: [virtualmachines,virtualmachineinstances,virtualmachineinstancemigrations]
  verbs: [get,list,watch]
- apiGroups: [instancetype.kubevirt.io]
  resources: [virtualmachineclusterinstancetypes,virtualmachineinstancetypes]
  verbs: [get,list,watch]
- apiGroups: [cdi.kubevirt.io]
  resources: [datavolumes]
  verbs: [get,list,watch]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses]
  verbs: [get,list,watch]
- apiGroups: [snapshot.storage.k8s.io,snapshot.kubevirt.io]
  resources: [volumesnapshots,virtualmachinesnapshots]
  verbs: [get,list,watch]
- apiGroups: [config.openshift.io]
  resources: [infrastructures,clusteroperators]
  verbs: [get,list]
- apiGroups: [authorization.k8s.io]
  resources: [selfsubjectrulesreviews]
  verbs: [create]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: cloudverse-data-center-collector-read}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cloudverse-data-center-collector-read}
subjects:
- {kind: ServiceAccount, name: cloudverse-data-center-collector, namespace: cloudverse-system}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: cloudverse-data-center-collector-state, namespace: cloudverse-system}
spec:
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: $SPOOL_SIZE}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: cloudverse-data-center-collector, namespace: cloudverse-system}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: cloudverse-data-center-collector}}
  template:
    metadata: {labels: {app: cloudverse-data-center-collector}}
    spec:
      serviceAccountName: cloudverse-data-center-collector
      securityContext: {runAsNonRoot: true, fsGroup: 65532, seccompProfile: {type: RuntimeDefault}}
      containers:
      - name: collector
        image: $IMAGE
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        env:
        - {name: COLLECTOR_CONTROL_PLANE_URL, value: "$CONTROL_PLANE_URL"}
        - {name: COLLECTOR_ORG_ID, value: "$ORG_ID"}
        - {name: COLLECTOR_INTEGRATION_ID, value: "$INTEGRATION_ID"}
        - {name: COLLECTOR_PROVIDER, value: OPENSHIFT_VIRTUALIZATION}
        - {name: COLLECTOR_SCALE_CLASS, value: "$SCALE_CLASS"}
        - {name: COLLECTOR_ENROLLMENT_TOKEN_FILE, value: /bootstrap/enrollment-token}
        - {name: COLLECTOR_PROVIDER_CONFIG_FILE, value: /config/provider.json}
        - {name: COLLECTOR_ALLOWED_HOSTS, value: "$API_HOST"}
        - {name: NODE_EXTRA_CA_CERTS, value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt}
        volumeMounts:
        - {name: state, mountPath: /var/lib/cloudverse}
        - {name: run, mountPath: /var/run/cloudverse}
        - {name: config, mountPath: /config, readOnly: true}
        - {name: bootstrap, mountPath: /bootstrap}
      volumes:
      - {name: state, persistentVolumeClaim: {claimName: cloudverse-data-center-collector-state}}
      - {name: run, emptyDir: {}}
      - {name: config, configMap: {name: cloudverse-collector-config}}
      - {name: bootstrap, secret: {secretName: cloudverse-collector-bootstrap}}
EOF
oc rollout status deployment/cloudverse-data-center-collector -n cloudverse-system --timeout=180s
ENROLLED=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if oc exec deployment/cloudverse-data-center-collector -n cloudverse-system -- test -s /var/lib/cloudverse/identity/identity.json >/dev/null 2>&1; then
    ENROLLED=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$ENROLLED" != "true" ]; then
  echo "Collector did not enroll within 120 seconds; bootstrap Secret retained for a safe retry." >&2
  exit 1
fi
oc set env deployment/cloudverse-data-center-collector -n cloudverse-system COLLECTOR_ENROLLMENT_TOKEN_FILE-
oc set volume deployment/cloudverse-data-center-collector -n cloudverse-system --remove --name=bootstrap
oc delete secret cloudverse-collector-bootstrap -n cloudverse-system
oc rollout status deployment/cloudverse-data-center-collector -n cloudverse-system --timeout=180s
echo "Collector enrolled; the one-time bootstrap Secret and volume reference were removed."
