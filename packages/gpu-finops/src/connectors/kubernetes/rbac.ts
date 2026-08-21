export function getRecommendedKubernetesReadOnlyRbac(namespace = 'cloudverse-gpu-finops'): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cloudverse-gpu-finops-readonly
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch"]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cloudverse-gpu-finops
  namespace: ${namespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cloudverse-gpu-finops-readonly
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cloudverse-gpu-finops-readonly
subjects:
  - kind: ServiceAccount
    name: cloudverse-gpu-finops
    namespace: ${namespace}
`;
}
