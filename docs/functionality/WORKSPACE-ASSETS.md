# Workspace Assets

Core workspace assets cover uploaded files, generated artifacts, checkpoints, session bundles, and contribution records. Optional plugins use only the generic, minimum-authority workspace Host capabilities published by Core.

## Responsibilities

- Store workspace assets and metadata.
- Expose authorized workspace operations through opaque asset identifiers and Host capabilities.
- Support upload, download, history, checkpoint, restore, and governed sharing.
- Keep agent and plugin file access inside the authorized workspace boundary.
- Record audit and operation history for file changes.
- Emit Core workspace access receipts with protocol `v0.0.1:agent-workspace:access-receipt-1`.
- Keep asset identifiers and Host-facing handles opaque; plugins do not receive the server data root or a real local path.

## Safety Requirements

- Reject path traversal and workspace escape attempts.
- Reject symbolic links, hard links, devices, sockets, and other unsupported filesystem artifacts at Host boundaries.
- Revalidate authorization, object identity, revision, and expected digest immediately before mutation.
- Capture a bounded preimage and checkpoint before a reversible mutation.
- Keep untrusted executable content in opaque custody until controlled execution admits it.
- Fail closed when a workspace share has no applicable configured governance policy.
- Compensate a persisted grant if the ACL mutation fails and bind policy evaluation to the authenticated subject rather than caller-supplied identity fields.

## Workspace Binding

Every operation that writes workspace files, unified asset state, asset policy,
proof state, registry records, or backfill results requires an explicit
non-empty `workspaceId`. Write paths do not infer that binding from
`workspace`, `workspaceRef`, or a `default` workspace. The protocol boundary
rejects an invalid binding before execution; the managed-write boundary repeats
the check before proof creation or a downstream effect; the owning registry or
policy provider validates it again before persistence. Read-only catalog
queries may omit a workspace filter.

Core workspace contribution submission, scanning, preview, review, publication,
rejection, change requests, revocation, permission changes, and adoption are all
managed workspace writes. Each requires the source `workspaceId`. Adoption and
permission request or grant also require an explicit `targetWorkspaceId`; they
never infer the target from the source contribution. Both bindings are checked
before proof creation and again by the contribution registry or asset
materializer before durable state changes. Unfiltered contribution catalog,
statistics, report, leaderboard, and materialized-asset reads remain available.

Workspace governance policy updates and evaluations require an explicit source
`workspaceId`. Creating a share Grant additionally requires an explicit
`targetWorkspaceId`; it never treats the source workspace as its own sharing
target. The protocol executor rejects invalid bindings before it reaches the
governance provider, and the registry validates them again before policy,
audit, Grant, revocation, or incomplete-unshare state is persisted. The global
governance overview remains available without a workspace filter, and absent
organization or project configuration remains empty rather than being
fabricated.

## Durability Boundary

Core object bytes are synchronized before publication, and the primary asset
metadata database uses SQLite WAL with `synchronous=FULL`. A successful metadata
transaction is therefore not acknowledged until SQLite has synchronized the WAL
commit record. This favors confirmed-write durability over peak mutation
throughput and prevents a power interruption from silently rolling back an
already acknowledged object registration. Auxiliary databases own their own
durability policy and are not implicitly covered by this storage authority.

## Execution Boundary

Workspace filesystem governance covers path containment, mutation preview, checkpoint, compensation, and rollback. It is distinct from process, network, credential, resource, and tenant execution isolation and cannot satisfy an execution-sandbox admission decision.

A workspace Host capability supplies a content-addressed immutable snapshot or an opaque read-only handle, never a live host path. An admitted workload receives read-only inputs and writes only to run-specific quarantine. Returned changes remain proposals and require Host-side preview, proposal-bound approval, revalidation, commit, and cleanup. The consumer cannot select or launch a backend and has no Host-process fallback.

Batch restore validates opaque handles sequentially and reads each changed file
only at its mutation point. It retains content-addressed preimage references
rather than all preimage buffers, restores one preimage block at a time during
compensation, and rejects a handle whose declared byte count or SHA-256 digest
does not match the bytes it supplies.

Production execution remains denied until explicit configuration, current authorization and admission facts, and the exact current Controlled Execution receipt are present.

## Verification

Workspace listing and mutation entry points include `workspace.file.list` and related Host operations.

```bash
npm test -- --suite workspace.core-file-ops
npm run verify:controlled-execution-sandbox
npm test
```
