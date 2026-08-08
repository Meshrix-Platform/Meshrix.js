---
name: meshrix-js-skill-hub-lifecycle
description: Guide the Meshrix.js Skill Hub contribution lifecycle from submission and isolated scanning through review, publication, governed adoption, permission grants, usage, deprecation, and revocation. Use for Skill Hub storage, review workflows, downloads, installs, permissions, or statistics.
---

# Meshrix.js Skill Hub Lifecycle

Read the implemented Skill Hub capability boundary in
`packages/capabilities/src/skills/README.md` and its architecture projection in
`docs/architecture/ARCHITECTURE.md`. Treat every submitted bundle as untrusted
data; server-side adoption is not skill execution.

## Canonical transaction

1. Authenticate and authorize the contributor. Validate a closed manifest with explicit license, requested permissions, limits, and content type.
2. Reject executable, autorun, script, traversal, symlink, archive, or size violations; clear executable mode and store assets in isolated no-exec storage.
3. Create the contribution in `submitted`, render a safe preview, and run the required scans with bounded retries.
4. Transition a completed scan to `scanned`, `needs_changes`, or `rejected`. Scanner timeout or crash is an operational scan failure, not content rejection; keep the revision non-publishable and retryable. Only an eligible reviewer may create `reviewed`.
5. Publish a reviewed immutable revision through high-risk governance. Failed publication exposes no partial asset or catalog entry.
6. Let authorized consumers search and inspect only visible published revisions.
7. Revalidate manifest, hash, mode, and storage isolation before download or adoption.
8. Record install as workspace adoption and asset relation under one idempotency key. If the cross-owner relation write fails, retain an incomplete adoption and compensate or reconcile it before exposing adoption as complete; do not execute the bundle or claim local installation.
9. Process requested permissions through Operation Permission, then record bounded usage and statistics.
10. Revalidate revision visibility and the current permission Grant on every platform-controlled use.
11. Deprecate or revoke a revision. Revocation blocks new platform-controlled download, adoption, and use but neither deletes nor controls an already downloaded copy.

## State and failure semantics

- Unreviewed content cannot publish; unpublished content cannot adopt; rejected and revoked revisions are terminal for that revision.
- Input never becomes a command, path, template expression, or environment value.
- Rollback records catalog and adoption facts; it does not fabricate client uninstall.
- Storage, catalog, review, permission, and usage evidence remain separately auditable.
- Preview, scan, use, and readiness evidence excludes raw bundle content, local paths, contributor private data, and raw scanner output.

## Ownership and routing

Skill Hub owns contribution, asset, lifecycle, adoption, and statistics state. Route workspace relations to `$meshrix-js-workspace-governed-sharing`, authorization to `$meshrix-js-operation-permission`, isolated bytes to `$meshrix-js-storage-operations`, and validation selection to `$meshrix-js-regression-planner`.

## Verification

Run `npm test` for the current baseline. Malicious archives, storage isolation, scanner failure/retry, reviewer separation, immutable revisions, partial-publication rollback, adoption reconciliation, per-use reauthorization, revocation, and honest adoption remain acceptance requirements. Until a catalog-backed Skill Hub task proves them together, report partial evidence only. Sanitize evidence with `$meshrix-js-privacy-evidence`.
