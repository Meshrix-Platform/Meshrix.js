# Repository Agent Rules

This file is the repository-wide instruction authority for development agents.
It applies to every task and directory in this repository. A more specific
child `AGENTS.md` may strengthen these rules but must not weaken them.

## Upstream Service Custom Fields

Meshrix.js upstream service publishing supports optional custom fields for
declarative service configuration (for example request context headers on a
remote MCP service). This is a standing capability target: never regress it,
and extend it the same way new custom-field needs appear. See
[docs/adrs/0001-upstream-service-custom-fields.md](docs/adrs/0001-upstream-service-custom-fields.md)
for the decision, the bounded security exemption, and the required
verification before claiming a new field is supported.

## Standard MCP Clients Are First-Class

Meshrix.js MCP ingress speaks the standard MCP protocol. Any conforming MCP
client must be able to connect and use published tools without being listed
in a hard-coded client catalog. Do not hard-code a downstream client list
(agent product names, connector package ids) as a gate for MCP access; a
client-declared optional identity header may be validated when present, but
its absence must never block a standard client. Capability authorization
(protocol, toolsets, scopes, risk, dynamic capabilities) is the gate, not
which product the caller happens to be.

## Deployment Script Boundary

Before changing any deployment entry point, stage catalog, stage script,
activation path, upgrade path, deployment verification controller, optional
external startup entry point, or optional target script, read and follow
`tools/server-scripts/README.md`.

Deployment scripts must close only Meshrix.js Core platform capabilities.
Optional plugins, independent services, external providers, Agent or client
products, and optional integration scenarios must remain separately invoked
and must not block, promote, or alter a Core deployment result.

## Report Before Replace

When an agent finds a defect or limitation in the repository's own scripts or
automation, the agent must report the original script's exact problem and the
proposed repair to the maintainer. The agent must not silently work around the
defect by substituting a separate script, wrapper, or one-off replacement that
leaves the original script unfixed. A temporary diagnostic script may be used
to gather evidence, but it must not become the vehicle for applying the
intended fix; the fix belongs in the original repository script. Report the
root cause, the affected module boundary, and the proposed change, and obtain
maintainer direction before applying it.

## Discover All Failures Before Repair

When a test profile, audit, acceptance workflow, release gate, or other bounded
verification scope reports a failure, do not begin repairing the first failure
from an early-stop run.

1. Complete one diagnostic discovery pass across the entire selected scope and
   collect every failure. Use the runner's continue-after-failure mode when it
   is safe; for the unified test runner, use `--continue-on-failure`.
2. Treat an early-stop result as partial evidence. Report the unexecuted suites
   explicitly and never claim that the first observed failure is the only
   failure.
3. Group the complete failure inventory by root cause, then repair one root
   cause at a time with the narrowest owning verification.
4. Do not rerun the complete profile or full regression between individual
   repairs.
5. After every known failure is repaired and every focused verification passes,
   run the complete regression exactly once. Promotion or release may proceed
   only from that successful final run.

If continuing after failure would create unsafe, destructive, or external side
effects, stop before repair, report the undiscovered scope and the required
authority, and obtain a maintainer decision.
