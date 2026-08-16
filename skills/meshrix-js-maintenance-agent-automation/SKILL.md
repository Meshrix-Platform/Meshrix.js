---
name: meshrix-js-maintenance-agent-automation
description: Guide the Meshrix.js maintenance-agent capability flow from explicit enablement and planning through governed approval, execution, cancellation, and audit. Use for maintenance chat, fixed runbooks, scheduled maintenance, repair approval, or maintenance-worker behavior.
---

# Meshrix.js Maintenance Agent Automation

Read `docs/functionality/MAINTENANCE-AGENT.md` before changing this default-disabled capability line.

## Canonical transaction

1. Require an administrator to enable `maintenance-agent-runbooks`. Preserve empty scheduler, planner, and model configuration as empty.
2. Accept a maintenance intent from chat, a fixed runbook, or an explicitly configured schedule.
3. Produce a closed plan bound to agent identity, operator, workspace, allowed context, tool set, policy revision, resource budget, and `planHash`.
4. Resolve every proposed tool to an existing Operation Permission operation.
5. Schedule permitted read-only and safe-write steps. Put repair-write steps into an approval-wait state; reject destructive steps.
6. On approval, validate approver authority, current policy, and the exact `planHash`, then dispatch the approved operation.
7. Execute with bounded concurrency, cancellation, resource locks, failure isolation, and shutdown barriers.
8. Persist lifecycle state and metadata-only audit evidence through the implemented terminal results, including completed, completed-with-errors, failed, cancelled, or rejected.

## Boundaries and failure semantics

- The fixed planner requires no model credential. The gateway planner must use Agent Gateway and the configured maintenance module profile.
- A missing module profile never triggers an inferred model or fallback.
- The planner proposes operations; it never owns their implementation or bypasses approval.
- The current dispatcher path uses a synthetic maintenance actor and skips a second Grant authorization. Current-Grant reauthorization and a plan-hash TTL remain remaining required GATE work.
- A failed scheduled run must not terminate the background worker or unlock unrelated resources.
- Do not retain chat bodies, tool payloads, credentials, or raw results in evidence.

## Ownership and routing

Maintenance owns intent, plan, scheduling, and lifecycle state. Route model planning to `$meshrix-js-agent-gateway-model-routing`, governed tool execution to `$meshrix-js-operation-permission`, and identity/audit policy to `$meshrix-js-security-authorization`.

## Verification

Run `npm test` for the current baseline. Default-disabled behavior, explicit enablement, fixed and gateway planners, missing profiles, invalid tools, repair approval, hash mismatch, cancellation, scheduler isolation, persistence recovery, bounded execution, and metadata-only audit remain acceptance requirements. A catalog-backed maintenance task plus current-Grant reauthorization and plan-hash expiry are required before declaring the capability line complete. Use `$meshrix-js-regression-planner` for available evidence.
