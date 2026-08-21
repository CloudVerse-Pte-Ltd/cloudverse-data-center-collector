#!/bin/sh
set -eu

IMAGE_DEFAULT="ghcr.io/cloudverse-pte-ltd/on-prem-collector:latest"
CONTROL_PLANE_URL=""
ORG_ID=""
INTEGRATION_ID=""
PROVIDER=""
ENROLLMENT_TOKEN=""
IMAGE="${COLLECTOR_IMAGE:-$IMAGE_DEFAULT}"
STATE_ROOT="${COLLECTOR_STATE_ROOT:-/var/lib/cloudverse-data-center-collector}"

usage() {
  echo "Usage: $0 --control-plane-url URL --org-id ID --integration-id ID --provider VSPHERE|OPENSHIFT_VIRTUALIZATION --enrollment-token TOKEN" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --org-id) ORG_ID="$2"; shift 2 ;;
    --integration-id) INTEGRATION_ID="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [ -z "$CONTROL_PLANE_URL" ] || [ -z "$ORG_ID" ] ||
  [ -z "$INTEGRATION_ID" ] || [ -z "$PROVIDER" ] ||
  [ -z "$ENROLLMENT_TOKEN" ]; then
  usage
fi
case "$CONTROL_PLANE_URL" in https://*) ;; *) echo "Control plane must use HTTPS" >&2; exit 1 ;; esac
case "$PROVIDER" in
  VSPHERE) ;;
  OPENSHIFT_VIRTUALIZATION)
    OPENSHIFT_INSTALLER="$(dirname "$0")/install-openshift.sh"
    if [ ! -f "$OPENSHIFT_INSTALLER" ]; then
      OPENSHIFT_INSTALLER="/tmp/cloudverse-install-openshift.sh"
      curl -fsSL "${COLLECTOR_RELEASE_BASE_URL:-https://github.com/CloudVerse-Pte-Ltd/cloudverse-data-center-collector/releases/latest/download}/install-openshift.sh" -o "$OPENSHIFT_INSTALLER"
      chmod 0700 "$OPENSHIFT_INSTALLER"
    fi
    exec "$OPENSHIFT_INSTALLER" --control-plane-url "$CONTROL_PLANE_URL" --org-id "$ORG_ID" --integration-id "$INTEGRATION_ID" --enrollment-token "$ENROLLMENT_TOKEN"
    ;;
  *) usage ;;
esac
command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run the installer as root" >&2; exit 1; }

printf "vCenter HTTPS URL: "
read -r VCENTER_URL
case "$VCENTER_URL" in https://*) ;; *) echo "vCenter must use HTTPS" >&2; exit 1 ;; esac
printf "vCenter read-only username: "
read -r VCENTER_USERNAME
printf "vCenter password: "
stty -echo
read -r VCENTER_PASSWORD
stty echo
printf "\nPEM CA certificate path (required): "
read -r VCENTER_CA
[ -f "$VCENTER_CA" ] || { echo "CA certificate not found" >&2; exit 1; }

install -d -m 0700 -o 65532 -g 65532 "$STATE_ROOT/identity" "$STATE_ROOT/spool" "$STATE_ROOT/config" "$STATE_ROOT/run"
printf '%s' "$ENROLLMENT_TOKEN" > "$STATE_ROOT/identity/enrollment-token"
jq -n --arg baseUrl "$VCENTER_URL" --arg username "$VCENTER_USERNAME" --arg password "$VCENTER_PASSWORD" +  '{baseUrl:$baseUrl,auth:{basic:{username:$username,password:$password}},propertyPageSize:500}' +  > "$STATE_ROOT/config/provider.json"
unset VCENTER_PASSWORD ENROLLMENT_TOKEN
install -m 0644 "$VCENTER_CA" "$STATE_ROOT/config/provider-ca.pem"
chown -R 65532:65532 "$STATE_ROOT"
chmod 0600 "$STATE_ROOT/identity/enrollment-token" "$STATE_ROOT/config/provider.json"

API_HOST="$(printf '%s' "$CONTROL_PLANE_URL" | sed -E 's#^https://([^/]+).*$#\1#')"
docker pull "$IMAGE"
docker rm -f cloudverse-data-center-collector >/dev/null 2>&1 || true
docker run -d --name cloudverse-data-center-collector --restart unless-stopped +  --read-only --cap-drop ALL --security-opt no-new-privileges +  -e COLLECTOR_CONTROL_PLANE_URL="$CONTROL_PLANE_URL" +  -e COLLECTOR_ORG_ID="$ORG_ID" -e COLLECTOR_INTEGRATION_ID="$INTEGRATION_ID" +  -e COLLECTOR_PROVIDER=VSPHERE +  -e COLLECTOR_ENROLLMENT_TOKEN_FILE=/var/lib/cloudverse/identity/enrollment-token +  -e COLLECTOR_PROVIDER_CONFIG_FILE=/var/lib/cloudverse/config/provider.json +  -e COLLECTOR_ALLOWED_HOSTS="$API_HOST" +  -e NODE_EXTRA_CA_CERTS=/var/lib/cloudverse/config/provider-ca.pem +  -v "$STATE_ROOT/identity:/var/lib/cloudverse/identity" +  -v "$STATE_ROOT/spool:/var/lib/cloudverse/spool" +  -v "$STATE_ROOT/config:/var/lib/cloudverse/config:ro" +  -v "$STATE_ROOT/run:/var/run/cloudverse" +  "$IMAGE"

echo "Collector installed. Check: docker logs cloudverse-data-center-collector"
