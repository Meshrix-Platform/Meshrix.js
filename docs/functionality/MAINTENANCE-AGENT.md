# Maintenance Agent

Maintenance Agent is an explicit runbook automation feature for server operators. It plans and runs bounded maintenance checks through the current operation dispatcher and records run/audit evidence under the server data root.

## Current Boundary

- `maintenance-agent-runbooks` is default-disabled and must be explicitly enabled.
- `maintenance_agent.config.get`, `maintenance_agent.runs.list`, and `maintenance_agent.runs.get` require `maintenance:read` and are read-only.
- `maintenance_agent.config.set` requires `maintenance:admin` and is `repair_write`.
- `maintenance_agent.chat`, `maintenance_agent.runs.create`, and `maintenance_agent.runs.cancel` require `maintenance:run` and are `safe_write`.
- `maintenance_agent.runs.approve` requires `maintenance:approve` and is `repair_write`.
- `maintenance_agent.chat` uses metadata-only input audit/log policy because planner prompts may contain operator intent and runtime context.
- The fixed runbook planner is verified without model-provider credentials. Gateway planner mode remains governed by the Agent Gateway model-call boundary and uses `maintenance-agent-runbooks` from the shared model-usage contract as its module profile source.
- Maintenance runs use the canonical durable work queue definition `queue.maintenance.runs`. The Maintenance Agent owns run and approval state; the work queue owns pending, lease, retry, cancellation, and recovery state.
- The scheduling adapter registers only when `maintenance-agent-runbooks` is selected and requires an injected queue application port. It does not construct a queue store, scheduler, recovery writer, or optional relay.
- The embedded server scheduler and the external maintenance worker are mutually exclusive cadence owners. Both submit due runs through the same work-queue port; neither owns an in-memory execution queue or parallel observation state.
- In external-worker mode the server registers a producer-only maintenance queue facet; only the maintenance worker registers the consumer.
- Scheduler cadence remains unconfigured when `scheduler.tickSeconds` is empty or zero. No scheduler timer starts until the feature, cadence, and at least one schedule are explicitly configured.
- A due schedule occurrence advances only after durable run admission. Failed admission retains the same due timestamp for retry, and the schedule ID plus occurrence timestamp derive one deterministic run identity so restart replay cannot create a second run.

## Operation Surface

| Operation | Purpose |
| --- | --- |
| `maintenance_agent.config.get` | Read Maintenance Agent configuration. |
| `maintenance_agent.config.set` | Save scheduler, planner mode, and runbook policy configuration. |
| `maintenance_agent.chat` | Ask the planner to produce and optionally run a maintenance plan. |
| `maintenance_agent.runs.create` | Create a fixed runbook maintenance run. |
| `maintenance_agent.runs.list` | List maintenance runs. |
| `maintenance_agent.runs.get` | Read one maintenance run. |
| `maintenance_agent.runs.approve` | Approve a pending repair-write maintenance run. |
| `maintenance_agent.runs.cancel` | Cancel a queued or running maintenance run, or return a completed run unchanged. |

## Tool Boundary

The fixed runbook executor dispatches existing server operations through the current operation registry. The verified `health_smoke` runbook uses `system.health`, `runtime.info`, `storage.summary`, and `jobs.list`.

Repair-write tools remain approval-gated by the run policy. Destructive tools are rejected by policy.

Queued-run submission, cancellation, resume, recovery, and observation go through one injected queue-scoped facet. Admission accepts only a bounded opaque run context reference and a digest of the immutable plan, approval, assignment, permission, and adapter-policy facts; it derives stable work-item and idempotency identities and stores no planner context, tool payload, or operator identity in queue metadata. Before dispatch, the adapter reloads the durable run and rejects work when the governance digest no longer matches. Observations expose only the opaque work-item reference, canonical state, attempt bounds, and scheduling timestamps. Worker failures are isolated to the leased item and follow canonical retry policy; independent pending runs remain dispatchable.

## Verification

```bash
npm run server:verify:maintenance-agent
npm test -- --suite maintenance-agent.runtime
```

`tools/server-scripts/verify-maintenance-agent.ts` verifies source/generated registry parity, generated capability projection, Operation Permission catalog projection, default-disabled feature behavior, explicit activation behavior, fixed-runbook dispatch through the canonical work queue and stub controllers, context-runtime compaction into planner input, gateway-planner JSON normalization with tool input schemas, `moduleAgentProfiles["maintenance-agent-runbooks"]` injection from the shared model-usage contract, missing-profile non-injection, scheduler failure isolation, stale `planHash` approval rejection, local run/audit persistence, operation-permission execution/metric recording, and metadata-only chat audit policy. Focused Vitest coverage verifies durable recovery, queue failure isolation, cancellation, lifecycle ordering, and composition unwind.
