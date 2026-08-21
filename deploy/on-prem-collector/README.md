# CloudVerse on-prem collector deployment

This image has no inbound listener. It reads signed bundle bytes from the encrypted local spool and sends the identical bytes to the one configured HTTPS ingestion endpoint, or retains them for offline export.

Required mounts/configuration: a 32-byte base64 spool key in a read-only secret file; an exact ingestion host allowlist; signed image digest; bounded PVC; and current/N-1 bundle versions. Proxy URLs and proxy hosts must be explicit. TLS verification cannot be disabled.

Spool-key rotation is crash-safe: mount the new primary key, retain the old key file in `COLLECTOR_PREVIOUS_SPOOL_KEY_FILES`, and set `COLLECTOR_ROTATE_SPOOL_ON_START=true` for one controlled start. Verify healthy queue/export operation, then restart without the previous key or rotation flag and revoke the old secret. A mixed-key spool remains readable if the process stops during rotation.

Replace every placeholder in `kubernetes.yaml`. The supplied egress policy uses Cilium FQDN enforcement; on a non-Cilium cluster, install an equivalent DNS-aware policy before the collector. Do not weaken it to unrestricted TCP/443. Generate the customer endpoint/permission manifest from the selected platform adapter and retain it with the deployment record.

Offline mode sets `COLLECTOR_MODE=OFFLINE` and `COLLECTOR_OFFLINE_EXPORT_DIRECTORY` to a separate operator-controlled mount. The one-shot process performs no network calls, writes the original signed bytes with mode `0600`, never deletes the encrypted spool, and exits. Removing an integration must stop its producer and follow the ratified retention decision before deleting its spool.
