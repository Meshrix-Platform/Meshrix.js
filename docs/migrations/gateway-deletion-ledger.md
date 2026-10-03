# Gateway deletion ledger

The new composition path is the only TASK-001 gateway candidate path that
invokes the public gateway port. The old MCP protocol profiles remain only as
explicit versioned edge adapters; the existing upstream-publishing provider is
retained as a separately owned legacy platform service until its full-platform
consumers can be migrated under a complete regression gate.

| Ledger | Candidate action | Evidence |
| --- | --- | --- |
| D-01 | External tool schemas use the standard 2020-12 validator; closed validators remain only for internal configuration. | `packages/gateway/src/schema/` |
| D-02/D-03 | Business fields and metadata use ownership/slot tables. | `packages/gateway/src/payload/` |
| D-04/D-14 | Results are decoded at one tagged public boundary. | `packages/gateway/src/results/` |
| D-05/D-06 | Modern request semantics and explicit legacy stateful semantics are separate adapters. | `packages/protocols/mcp/modern-upstream/`, `legacy/` |
| D-07/D-08 | Lost business contexts are terminal and do not consume active capacity. | `packages/gateway/src/context/` |
| D-09 | Admission is per upstream with a bounded FIFO. | `packages/gateway/src/admission/` |
| D-10/D-12 | Risk approval and method validation are policy/config concerns, not string-name guesses. | `packages/capabilities/src/gateway-policy/`, `packages/gateway/src/config/` |
| D-11 | Standard URL default ports are accepted. | `packages/gateway/src/config/` |
| D-13 | Service events are generic; collaboration constants stay in the contracts extension. | `packages/agents/src/service-events/` |
| D-15 | Historical tests are not the focused acceptance oracle. | `tests/vitest/gateway/baseline/` |

This ledger is a one-time migration record, not a permanent compatibility
gate. The focused tests verify the new boundary and do not import the
independent interoperability task.
It records convergence decisions, residual compatibility inventory, and the
one-time migration evidence for the gateway boundary and its migrations.
