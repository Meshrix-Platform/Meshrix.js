---
name: meshrix-js-strategy-management
description: Guide Meshrix.js deterministic policy preview for workflows, agents, routes, queues, and tools. Use for strategy preview, explanation, policy revision binding, dry-run boundaries, or strategy-management verification.
---

# Meshrix.js Strategy Management

This skill covers the currently implemented policy-preview capability line. Do not describe future rollout or rollback work as present behavior. Read `docs/functionality/STRATEGY-MANAGEMENT.md`.

## Canonical transaction

1. Admit the caller through the shared HTTP, RPC, console, or governed-operation boundary.
2. Authorize `console:read`, validate the closed input schema, strategy kind, and target context.
3. Load the current policy source and the version or provenance facts that the implementation actually exposes.
4. Evaluate the workflow, agent, route, queue, or tool request deterministically.
5. Return the implemented effect and reason-code projection with a safe explanation. Do not promise a policy revision, input digest, or trace reference unless the executable contract provides it.
6. Write metadata-only audit evidence.
7. If the caller later executes the operation, enter Operation Permission again. A preview result is never an execution credential.

## Boundaries and failure semantics

- Current `strategy.*` operations are read-only: no model call, enqueue, workflow mutation, traffic forwarding, or tool execution.
- Strategy preview explains a domain policy; Operation Permission dry-run previews whether a governed operation may proceed. Keep their contracts distinct.
- Invalid input or an unauthorized subject fails closed and produces no side effect. If revision binding is later added, stale revisions must also fail closed.
- Explanations must not disclose private policy fields, subject data, prompts, or runtime context.

## Ownership and routing

Strategy Management owns deterministic preview and explanation. Route execution authorization to `$meshrix-js-operation-permission` and sensitive-data policy to `$meshrix-js-security-authorization`.

## Verification

Run `npm test` for the current baseline. Prove all current strategy operations, cross-surface parity, deterministic decision semantics for normalized equivalent input, invalid-input denial, authorization denial, zero side effects, and mandatory reauthorization after an allowed preview. Random decision identifiers and timestamps are not part of deterministic equality. Until a catalog-backed strategy task proves the full set, capability-line readiness remains remaining required work. Use `$meshrix-js-regression-planner` for available evidence.
