# Agent Gateway And Model Routing

Agent Gateway is the standard-edition model-call surface for invoking configured model agents through the server runtime. Model Routing records local routing policy, circuit-breaker state, and cost-ledger evidence for routed calls. Agent Management is an explicit optional feature for maintaining model-library entries.

## Current Boundary

- `agent_gateway.call` is exposed over HTTP/RPC and as `meshrix.agentGateway.call` in the Operation Permission catalog.
- `agent_gateway.call` requires `model:call` and is `safe_write` because it can send user-provided prompts to a configured model provider through an allowlisted egress source.
- `model_routing.health` is exposed as `meshrix.agentGateway.modelRouting.health`, requires `console:read`, and reads local routing state plus recent cost-ledger entries.
- `agent-management` is default-disabled. When enabled, `agents.list/create/update/delete` maintain local model-library entries through `meshrix.agentManagement.*` catalog tools.
- `agents.create`, `agents.update`, and `agents.delete` require `runtime:admin`, use `repair_write`, share the `agent_management.model_library` concurrency group, and redact configured token fields in audit projections.
- Runtime configuration ownership remains with `settings.*` and `agents.*`. The stale `agent_gateway.config.*` surface is retired.

Model-library records and encrypted credential references are owned by the agent config registry, not `settings.json`. Registry replacement stages and validates an immutable generation, then atomically switches `agent-configs/current.json` under a cross-process lock and explicit revision compare-and-swap. A process termination before the pointer switch leaves the previous generation active; termination after the switch leaves a complete new generation active.

Settings saves coordinate `settings.json`, `operation-permission/execution.json`, and the registry generation pointer with a private durable transaction journal. A prepared journal rolls all documents back to the previous snapshot, while a committed journal rolls them forward to the committed snapshot. The next settings load or save reclaims an abandoned writer lock and completes recovery before exposing state. While the journal exists, unrelated registry mutations are rejected instead of bypassing the cross-document transaction.

## Operation Surface

| Operation | Feature | Purpose |
| --- | --- | --- |
| `agent_gateway.call` | `agent-gateway` | Invoke a configured model agent through the server proxy. |
| `model_routing.health` | `agent-gateway` | Read local model-routing health, circuit state, and ledger summary. |
| `agents.list` | `agent-management` | List configured model-library agent entries. |
| `agents.create` | `agent-management` | Create a model-library agent entry. |
| `agents.update` | `agent-management` | Update a model-library agent entry. |
| `agents.delete` | `agent-management` | Delete a model-library agent entry. |

## Edition Behavior

`agent-gateway` is included in the standard edition. The core edition keeps the model-call surface inactive by default.

`agent-management` is an explicit feature because it changes runtime model-provider configuration. Enabling it activates `agents.*` only after the `agent-gateway` and Operation Permission dependencies are active.

## Verification

```bash
npm run server:verify:agent-gateway
npm run server:verify:model-routing
npm run server:verify:agent-management
npm test -- --suite agent-gateway.runtime
npm test -- --suite model-routing.runtime
npm test -- --suite agent-management.runtime
npm test -- --suite agents.model-provider-runtime
```

`tools/server-scripts/verify-agent-gateway.mjs` verifies source/generated registry parity, generated capability projection, Operation Permission catalog projection, standard-edition activation, core-edition exclusion, executor dispatch, and controlled failure when no provider URL is configured.

`tools/server-scripts/verify-model-routing.mjs` verifies source/generated registry parity, generated capability projection, Operation Permission catalog projection, routed call ledger creation, circuit-state inspection, and console-domain health dispatch.

`tools/server-scripts/verify-agent-management.mjs` verifies source/generated registry parity, generated capability projection, Operation Permission catalog projection, default-disabled feature behavior, explicit activation behavior, local model-library create/list/update/delete, and token redaction support.
