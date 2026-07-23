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

## Execution Boundary

Workspace filesystem governance covers path containment, mutation preview, checkpoint, compensation, and rollback. It is distinct from process, network, credential, resource, and tenant execution isolation and cannot satisfy an execution-sandbox admission decision.

A workspace Host capability supplies a content-addressed immutable snapshot or an opaque read-only handle, never a live host path. An admitted workload receives read-only inputs and writes only to run-specific quarantine. Returned changes remain proposals and require Host-side preview, proposal-bound approval, revalidation, commit, and cleanup. The consumer cannot select or launch a backend and has no Host-process fallback.

Production execution remains denied until explicit configuration, current authorization and admission facts, and the exact current Controlled Execution receipt are present.

## Verification

```bash
npm test -- --suite workspace.core-file-ops
npm run verify:controlled-execution-sandbox
npm test
```
