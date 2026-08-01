# Strategy Management

Strategy Management is the read-only policy evaluation surface used to explain workflow, agent, route, queue, and tool-invocation decisions before runtime work is executed.

## Current Boundary

- Server operations are exposed as `strategy.*` over HTTP/RPC and Operation Permission catalog tools under `meshrix.strategy.*`.
- The core edition includes Strategy Management by default.
- All current strategy operations are read-only previews. They do not call model providers, enqueue work, mutate workflow state, forward upstream traffic, or execute tools.
- Strategy operations require `console:read` through the normal Operation Permission path when exposed as catalog-backed tools.
- Audit output stays metadata-oriented; policy preview inputs are not treated as execution proof or as a substitute for the final governed operation.

## Operation Surface

| Operation | Purpose |
| --- | --- |
| `strategy.describe` | Report protocol version and supported strategy capabilities. |
| `strategy.workflow_policy.evaluate` | Preview workflow allow, deny, or confirmation decisions. |
| `strategy.agent_policy.evaluate` | Preview agent invocation policy without calling a model. |
| `strategy.route_policy.evaluate` | Preview aspect route allow/deny decisions without forwarding traffic. |
| `strategy.queue_policy.evaluate` | Preview queue scheduling priority, attempts, and backpressure strategy. |
| `strategy.tool_policy.preview` | Preview tool policy decisions without executing a tool. |

## Verification

```bash
npm run server:verify:strategy-management
npm run verify:platform-audit
npm run verify:core-platform-surface-convergence
```

`tools/server-scripts/verify-strategy-management.ts` verifies source/generated registry parity, generated capability projection, Operation Permission catalog projection, dispatch routing through the HTTP controller and console-domain executor, provider behavior for every current strategy operation, and core feature activation.
