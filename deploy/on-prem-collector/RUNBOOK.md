# On-prem collector operations runbook

This runbook applies to the CloudVerse collector image and the C06 CPD signed-bundle endpoints. Replace manifest placeholders with approved exact values and retain command output in the integration's operational evidence record. Never copy secrets into tickets, logs, command history or evidence.

## Ownership and severity

- Customer/partner operator owns the in-network runtime, source reachability and encrypted spool volume.
- CloudVerse integration operations owns Test/SaaS ingestion health and bundle receipt/quarantine evidence.
- CloudVerse security owns signature failures, suspected key disclosure and unexpected network destinations.
- Page security immediately for a valid collector identity producing invalid signatures, repeated tenant mismatch, unexpected outbound traffic, or loss of spool-key custody. Treat spool backpressure or ingestion outage as operational unless accompanied by those indicators.

## Routine health

Read `COLLECTOR_HEALTH_FILE` from the mounted run volume. Healthy means `healthy=true`, no incompatible bundle, no last error, and queue growth consistent with the collection schedule. Alert on:

- any incompatible schema immediately;
- backpressure immediately;
- no successful upload for two expected collection intervals in connected mode;
- oldest queued bundle exceeding the agreed recovery objective;
- projected spool exhaustion before the next support response window.

Never mark health restored from an empty queue alone. Confirm CPD receipt records for the same bundle IDs and collection-run IDs.

## SaaS or network outage

1. Confirm source collection continues and queue item/byte counts remain below both configured hard bounds.
2. Confirm endpoint and proxy DNS resolve only to approved addresses. Do not bypass TLS or widen the allowlist.
3. If capacity will exhaust, stop the producer before backpressure; preserve the spool and key mounts. Never delete oldest bundles to make room.
4. After connectivity returns, let bounded retry drain the queue. Confirm identical CPD receipts and no quarantine rows.
5. Record outage start/end, maximum queue usage, first/last replayed bundle, CPD receipt evidence and any gap ledger entries.

## Offline export and import

1. Stop the producer or take a storage-consistent snapshot of the spool.
2. Start the collector once with `COLLECTOR_MODE=OFFLINE` and a new empty operator-controlled `COLLECTOR_OFFLINE_EXPORT_DIRECTORY` mount.
3. Verify exported files are mode `0600`; compute and record SHA-256 digests. The export does not delete the encrypted spool.
4. Transfer using approved encrypted media. Submit each JSON envelope to CPD `offline-import` under its envelope `orgId`.
5. Match CPD receipt digest, bundle ID, collection-run ID and `OFFLINE_IMPORT` provenance. Identical replay must return the original receipt; collision, nonce replay, tenant mismatch or signature failure must quarantine and stop the batch.
6. Reconcile every exported digest. Securely retire transfer media under customer policy; do not delete the source spool until retention authority is recorded.

## Spool-key rotation

1. Create a new independent 32-byte key and mount it as `COLLECTOR_SPOOL_KEY_FILE`. Retain at most two explicitly approved old key files in `COLLECTOR_PREVIOUS_SPOOL_KEY_FILES`.
2. Set `COLLECTOR_ROTATE_SPOOL_ON_START=true` for one controlled start. A crash may leave mixed ciphertext; all configured keys keep it recoverable.
3. Confirm the reported rotated count equals queue count and verify health/export using only the new primary key.
4. Restart without the rotation flag and previous-key list. Revoke and remove old keys only after the primary-only verification succeeds.
5. Record key IDs/fingerprints—not key bytes—operator, timestamps, rotated count and revocation evidence.

## Signature, tamper or credential incident

1. Stop the producer and collector egress; preserve the encrypted spool read-only and snapshot relevant CPD receipt/quarantine/audit rows.
2. Revoke the bearer credential and collector signing-key registration. Do not destroy keys or evidence until security authorizes it.
3. Compare image digest/signature, deployment manifest, endpoint allowlist, bundle digests and collection-run identity with the last known-good record.
4. Security determines whether to rotate transport, signing and spool keys and whether queued bundles may be replayed or must remain quarantined.
5. Resume only with a signed approved image digest, newly validated credentials and an explicit incident decision. Reconcile the first successful receipt and resulting metric gaps.

## Disaster recovery

1. Restore the encrypted spool snapshot, its matching primary/previous key set and the exact accepted schema configuration into an isolated replacement worker.
2. Start in offline mode first and prove queue authentication and bundle digest reconciliation without network access.
3. Validate the signed image digest and exact egress manifest, then enable connected mode or perform controlled offline import.
4. CPD idempotency makes already-received identical bundles safe to replay. Any bundle-ID collision or nonce conflict is an investigation, not an override condition.
5. Recovery is complete only when exported/queued bundle IDs reconcile to CPD receipts or durable quarantine outcomes and collection gaps are recorded.

## Upgrade and rollback

1. Before upgrade, capture queue usage, current/N-1 schema configuration, image digest, health and last CPD receipt.
2. Use `Recreate`; never run two workers against the same writable spool. Verify the new worker can read the existing queue before enabling its producer.
3. An unsupported future schema remains encrypted and unhealthy. Stop and upgrade the compatible worker; never rewrite or discard it.
4. To roll back, stop the worker and deploy the previous signed digest with a key set capable of reading the spool. Do not alter queued payload bytes.
5. Reconcile queue drain and CPD receipts after either upgrade or rollback.

## Offboarding

Do not improvise retention. The ratified P0-D06 decision must provide the data-class action and authority. Then execute the CPD offboarding state machine: stop schedules/producers, revoke credential references and external secrets, disable collector egress, tombstone live inventory, and apply the authorized retain/delete action independently to bundles, observations, telemetry, derived facts, financial lineage, findings and audit evidence. Retry must be idempotent. Completion requires auditable outcomes for every class and proof that no usable credential or future collection remains.
