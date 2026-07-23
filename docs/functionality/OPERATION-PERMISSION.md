# Operation Permission

Operation Permission is the governed boundary for operation visibility and execution.

## Permission Primitive

The permission primitive is an operation. MCP tools, console actions, upstream service calls, plugin actions, document access, workspace file actions, and maintenance actions are projections of governed operations.

## Responsibilities

- Publish operation catalog entries.
- Resolve operation groups, scopes, risk, grants, tags, and approval requirements.
- Evaluate deny and allow decisions before execution.
- Issue, rotate, revoke, and audit grants.
- Execute authorized operations through one mediated path.
- Emit audit, metrics, and trace references with redaction.
- Expose grant lifecycle/security events separately from execution audit records.

## Governed Execution Acceptance Rule

This boundary specializes the project-wide [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) policy.

Operation Permission is the catalog and policy authority, but a Grant,
approval, discovery result, or controller preflight is not reusable execution
authority. An allowed request must produce one short-lived permit bound to the
current subject, registered operation, concrete protected resource, grant and
policy revisions, approval, audience, request digest, deadline, and effect
class. The dispatcher and final protected sink must validate that exact permit
before a private read or side effect.

The corresponding evidence is one bounded logical lifecycle: a required
prepared intent and terminal outcome for write or external effects, or one
terminal receipt for a protected read when its operation contract permits that
profile. Grant lifecycle events remain separate. Routine success, routine
denial, metrics, and traces are aggregated or sampled and do not become
parallel per-request audit logs. Failure to prepare mandatory proof denies
before the protected boundary; failure after an external effect leaves a
recoverable `in_doubt` state and does not authorize blind retry.

This is a maintenance and release-acceptance rule. An execution surface that
does not yet present the same permit to its final sink remains non-converged
even when it performs an earlier authorization check.

## Tag Policy

Tags are a universal governance abstraction for roles, skills, operations, documents, agents, upstream services, workspaces, and organizations. Deny tags take precedence over allow tags.

The shared evaluator lives in `packages/foundation/src/security/authorization/universal-tag-policy.mjs` and is invoked by the Security Permissions Provider when an Operation Permission policy supplies `tagPolicy`. It evaluates active direct and inherited tags from the TagStoreProvider port, applies deny-tag precedence, required-tag checks, allow-tag admission, stale revision handling, and records the tag policy decision in the effective policy snapshot.

## Upstream Publishing Projection

Developer-published upstream operations are projected by the current upstream snapshot compiler. It creates exactly one deterministic primary operation and capability identity per enabled service operation, including protocol and route identity, scopes, toolsets, risk, approval, typed certificate and credential bindings, request and response schemas, traffic and response policy, audience policy reference, and the originating manifest-set revision.

Operation Permission builds that catalog off-path and atomically replaces it only when the source gateway revision is identifiable and complete. The committed catalog event is an invalidation signal; modules, plugins, tag projection, and the downstream gateway pull from the owning catalog instead of importing gateway state. Discovery and execution evaluate the same grant and tag decision with deny precedence, and a denied operation exposes no name or schema and reaches no sensitive-reference or upstream side-effect boundary.

The production publishing gate proves revision agreement, affected-audience invalidation, and protocol-side delivery through a neutral protocol peer. Client adoption is independently owned and cannot block or promote Operation Permission or server release support.

## Runtime Storage

`operation-permission-core` is the current platform implementation path. Startup opens `operation-permission/operation-permission.sqlite`; no retired pre-Operation-Permission database path is accepted as a runtime input. Universal tag policy uses the shared evaluator described above, and product E2E coverage verifies discovery refresh and tag-policy changes.

Every bearer authorization reloads the current grant policy before execution. Toolsets, tool allow/deny rules, scopes, resource restrictions, expiry, origin/CIDR rules, and risk limits therefore apply to already-issued credentials immediately after a policy update. Persisted policy JSON is type-checked by SQLite write triggers and by the read projection; malformed policy state disables authorization instead of becoming an empty, unrestricted list. `maxUses` is consumed with one conditional SQLite update bound to the current credential and policy revision, so concurrent requests cannot exceed the configured limit.

Pending operations store approval requirements and approval layers as a redacted projection of the current Security Authorization/Governance decision. They are a projection of the approval policy source. `requiredApproval` is the approval fact source; `approvalLayers` is only the stored projection and must match `requiredApproval.approvalLayers` before runtime approval can proceed. The write path derives the stored projection only from `requiredApproval.approvalLayers`; caller-supplied `approvalLayers` is ignored for approval requirement derivation. Static console route authorization such as `runtime:admin` only admits a user to the pending-resolution endpoint; layer eligibility still comes from the same governance model. Before recording a governance approval, the runtime checks the current session user against the required user, team, department, or agent-binding facts, then verifies the original grant is still available. When a governance decision returns `needsApproval`, Operation Permission creates a pending operation with the contract-provided `requiredApproval` shape; approving it records the matching governance approval layer and replays the request through the same authorization evaluator, which either advances to the next required layer or allows execution.

## Current External Execution Boundary

Operation Permission v1 is the current external execution boundary. External agent clients call `/api/operation-permission/v1/execute`, `/api/operation-permission/v1/dry-run`, or `/api/operation-permission/v1/batch` with a grant token in `Authorization: Bearer <token>` or `x-lico-tool-token`; token policy handles grant state, scope, and binding decisions. MCP clients use the `/mcp` outlet projection for the same governed operations.

This is an authorization and operation-mediation boundary, not operating-system execution isolation. A governed executable workload additionally requires the target [Execution Sandbox](../architecture/EXECUTION-SANDBOX.md), which enforces the effective filesystem, process, network, secret, resource, output, and tenant restrictions. Missing sandbox enablement, backend configuration, an enforceable policy, or a current per-run grant keeps that workload denied; Operation Permission does not authorize a host-process fallback.

`/api/operation-permission/v1/events` returns grant event records from `tool_grant_events`, with `limit`, `grantId`, and `eventType` filters. Execution records remain under `/api/operation-permission/v1/audit`.

## Delegated MCP Child Grants

An enabled plugin may request a short-lived `delegated-mcp-child` grant only through the restricted `delegatedMcpGrantBroker` host port. The broker exposes `createDelegatedMcpGrant` and `revokeDelegatedMcpGrant`; it does not expose the grant store or the rest of the Operation Permission provider.

Grant creation requires a verified parent Operation Permission grant and a complete `delegation` binding containing `issuer`, `binding`, `sessionId`, `turnId`, `subjectId`, `targetId`, `parentOperationId`, `workspaceId`, and `traceId`. The broker reloads the parent from the canonical store and requires the authorized projection fingerprint and policy snapshot to match that record. Requests outside the parent scopes, toolsets, allow-list, capabilities, dynamic capabilities, workspace/resource boundaries, service/secret bindings, egress, origin, or CIDR constraints are rejected; parent and requested deny rules are combined. Expiry is capped by both the delegated-grant maximum TTL and the parent grant expiry. Reuse requires every binding field and the parent grant id to match. Parent update, rotation, revocation, or deletion revokes descendant credentials; authorization also rechecks the active parent on every child execution.

The grant metadata stores one `delegatedMcp` object. Bearer credentials are returned only to the requesting plugin and are not persisted in plugin session metadata, execution summaries, audit projections, or public telemetry. Execution audit uses the generic `delegatedChildOperation` context; public Operation Permission responses redact its grant, session, turn, subject, target, workspace, parent-operation, and trace identifiers.

## Verification

```bash
node tools/server-scripts/verify-tag-management.mjs
node tools/server-scripts/verify-operation-permission-tag-governance-audit.mjs
node tools/server-scripts/verify-operation-permission-universal-tag-policy.mjs
node tools/server-scripts/verify-operation-permission-domain-model.mjs
node tools/server-scripts/verify-operation-permission-external-http-boundary.mjs
npx vitest run tests/vitest/server/operation-permission-grant-security.test.mjs tests/vitest/server/delegated-mcp-parent-authority.test.mjs
npm run verify:operation-permission-tag-governed-e2e
npm test -- --suite domains.manifest
npm test
```
