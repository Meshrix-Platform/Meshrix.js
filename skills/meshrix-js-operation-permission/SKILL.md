---
name: meshrix-js-operation-permission
description: Maintain Meshrix.js Operation Permission catalogs, operation groups, grants, risk policy, audit, metrics, bearer authorization, and the /api/operation-permission/v1 contract. Use for governed operation discovery, permission evaluation, or operation execution changes.
---

# Meshrix.js Operation Permission

Use this skill as the capability-line guide for discovering, authorizing, approving, executing, and auditing governed operations. Read `docs/functionality/OPERATION-PERMISSION.md` before changing the flow.

## Canonical transaction

1. Build one operation catalog from the authoritative operation registry. Project only enabled, permitted operations into HTTP, RPC, MCP, and console surfaces.
2. Authenticate the caller and load the current Grant. Bind subject, operation, target resource, scope, toolset, tags, feature state, and risk policy before revealing an operation or its schema.
3. Use the same policy result for discovery and execution. A denied operation is absent from discovery and cannot be invoked through another protocol.
4. Treat `dry-run` as a non-mutating policy preview. It must not call tools, external services, queues, or storage mutation paths.
5. When approval is required, create a pending operation with a controlled policy projection. Validate each approver against the current approval policy and the still-valid originating Grant.
6. After approval, reload the current Grant and re-run the same authorization path. Approval never bypasses authorization.
7. Prepare the mandatory compact lifecycle receipt, mint one short-lived and
   bound execution permit, and require the single operation dispatcher and
   final protected sink to consume it before access or side effect.
8. Settle the same lifecycle receipt to a terminal or `in_doubt` outcome.
   Keep Grant lifecycle facts separate; aggregate routine metrics and denials,
   sample traces, and do not persist per-request success logs.
9. Make Grant rotation, update, revocation, expiry, use limits, and parent-Grant changes effective for every subsequent request.
10. For batch execution, bind one authorization snapshot per item, reserve atomic use-limit consumption before dispatch, and return an ordered per-item result. Do not silently roll back successful external side effects; record partial failure and expose only safe retry metadata.

## Invariants and failure semantics

- `/api/operation-permission/v1` is the only external execution boundary. MCP is a projection of the same catalog, not a second permission model.
- `requiredApproval` is the approval fact; persisted approval layers are its controlled projection.
- Consume concurrent `maxUses` and equivalent limits atomically.
- A delegated child Grant cannot exceed its parent. Parent restriction or revocation cascades fail-closed.
- Reject missing, stale, ambiguous, replayed, or conflicting bindings before dispatch. A failed approval or execution must not partially consume unrelated state.
- Batch audit records the batch identifier and per-item decision/result categories without raw payloads. Retry requires item-level idempotency and a fresh authorization evaluation.
- Never include bearer values, secrets, ciphertext, raw request bodies, prompts, or runtime results in reports.
- Failure to prepare mandatory receipt evidence denies before dispatch. Failure
  to settle after an external effect preserves `in_doubt` and fences blind
  retry; optional telemetry loss never rewrites the operation outcome.

## Ownership and routing

Keep catalogs, Grants, approvals, policy, audit, and metrics in the bounded Operation Permission domain. Route identity, credential materialization, redaction policy, and fail-closed process boundaries to `$meshrix-js-security-authorization`. Route protocol projection changes to `$meshrix-js-protocol-gateway`.

## Verification

Start with `npm run verify:operation-permission-protocol-consistency` for protocol consistency. Discovery denial, zero-side-effect dry-run, multi-layer approval, replay rejection, immediate Grant changes, atomic use limits, parent-child revocation, batch partial failure, HTTP/MCP parity, and audit redaction remain broader acceptance requirements. Until catalog-backed tasks prove the full matrix, capability-line readiness remains remaining required work. Use `$meshrix-js-regression-planner` for available closure and `$meshrix-js-privacy-evidence` before sharing evidence.
