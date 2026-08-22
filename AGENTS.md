# Repository Agent Rules

This file is the repository-wide instruction authority for development agents.
It applies to every task and directory in this repository. A more specific
child `AGENTS.md` may strengthen these rules but must not weaken them.

## Deployment Script Boundary

Before changing any deployment entry point, stage catalog, stage script,
activation path, upgrade path, deployment verification controller, optional
external startup entry point, or optional target script, read and follow
`tools/server-scripts/README.md`.

Deployment scripts must close only Meshrix.js Core platform capabilities.
Optional plugins, independent services, external providers, Agent or client
products, and optional integration scenarios must remain separately invoked
and must not block, promote, or alter a Core deployment result.

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
