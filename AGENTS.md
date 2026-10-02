# Repository Agent Rules

This file is the repository-wide instruction authority for development agents.
It applies to every task and directory in this repository. A more specific
child `AGENTS.md` may strengthen these rules but must not weaken them.

## Short-Term And Long-Term Planning

Use the current Better Plan skill for all repository delivery planning, from a
small scoped change to the long-term product programme. Use the existing local
planning workspace; do not create a competing roadmap or copy private execution
state into public source. When that workspace is unavailable, report the missing
context before creating a replacement.

- `Programme.json` owns delivery identities, milestone outlines and dependencies.
  Future milestones remain outlines until investigation establishes executable work.
- `Requirements.json` owns cross-delivery requirements. Trees and Tasks reference
  those identities instead of maintaining duplicate requirement lists.
- Each active delivery uses the current split layout: `Tree.json`,
  `tasks/<id>.json` and `nodes/<id>.json`. A Task has an integration owner and maps
  to one independently deliverable Draft PR; a Node owns one coherent change and
  its commit. Record absent commit or PR references honestly.
- Keep shared requirements at Tree or Task scope. Record real checks and evidence
  at their owning scope. User-journey observations and final review are delivery
  lifecycle work; create source Nodes only for concrete implementation,
  documentation or configuration changes, not empty audit commits.
- Use the current skill's tool for plan operations and exports. Archive supplied
  conversation context and superseded plans through its history commands before
  replacement. Preserve prior outcomes and evidence without relabeling them as
  current verification. Do not maintain an older tool dialect as the active path.
- Markdown reports are navigation or generated views of Better Plan state, never
  a second editable plan. Product status remains in `docs/STATUS.md`; it describes
  verified product facts rather than dispatch instructions.

Plan status never grants execution authority. Preserve the user's selected model,
live-acceptance ownership, deployment and publication boundaries. A blocker pauses
only dependent work. Ordinary authorized scoped repairs continue without another
general approval request. Record Task and Tree delivery conclusions separately
from Node progress; completed Nodes alone do not establish accepted delivery.

## Functional Availability Before Benchmarking And Optimization

Meshrix development must first establish that the actual service is usable.
The required order is: functional implementation and focused checks; real
frontend/backend usability; benchmark validation and performance optimization;
then the declared final regression and review. Do not postpone frontend/backend
verification until after performance work.

Before any benchmark implementation/validation, load or capacity experiment,
profiling, or performance optimization, obtain current evidence for the same
candidate and relevant runtime/configuration:

1. The real backend starts through its supported entry point, becomes ready,
   and completes a representative authorized operation.
2. The real Console/frontend opens and renders in a browser; required assets
   and authentication work, and a representative UI action reaches that backend
   and presents the correct result. A page HTTP 200 or CLI-only run is not enough.
3. A standard MCP client completes the required real Meshrix-to-upstream request
   and receives the correct result. Controlled external upstream fixtures are
   allowed; substituting a Mock gateway, backend or frontend is not.
4. The exercised services settle and shut down normally. Record the candidate,
   environment/configuration, checks, observed results and privacy-safe evidence
   references, with explicit passed/failed/not_run/blocked status.

Build/typecheck success, unit tests, Mock tests, benchmark-tool self-tests,
package checks, image builds and health checks alone cannot satisfy this
prerequisite. A separate tool repository or "fixture" label cannot bypass it.
Do not run performance work in parallel with the functional work it depends on.
Missing/failed/stale evidence blocks that performance work; report the gap and
continue only authorized functional diagnosis or repair. Changes affecting
startup, frontend/backend integration, protocol behavior or relevant configuration
require fresh affected functional evidence before performance resumes.

Use existing functional checks and evidence records; this is not a requirement
to rerun the whole regression at every step, create a second gate framework,
deploy to production, or weaken the deployment boundary below. Repair original
script defects in the original owner under Report And Repair Repository Scripts
below; a wrapper or a second gate is never the repair vehicle.

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

## Automatic Tool And Script Registration

When an agent adds or changes a package script, verifier command, or other
tool that belongs in the canonical registries, the agent completes that
registration in the same change. Do not ask the maintainer for per-entry
permission, and do not leave a new `package.json` script unclassified.

Registration means an accurate explicit catalog entry (or the existing
allowlist only when the script is a documented composite alias), with real
inputs, outputs, tier, and side-effect metadata. Keep the current
classification gates. Do not invent a second registration path, classify every
matching prefix automatically, or treat a prefix pattern as a substitute for
an explicit entry. This is standing repository-maintenance authorization. It
does not change live MCP capability authorization or allow new external side
effects.

## Deployment Script Boundary

Before changing any deployment entry point, stage catalog, stage script,
activation path, upgrade path, deployment verification controller, optional
external startup entry point, or optional target script, read and follow
`tools/server-scripts/README.md`.

Deployment scripts must close only Meshrix.js Core platform capabilities.
Optional plugins, independent services, external providers, Agent or client
products, and optional integration scenarios must remain separately invoked
and must not block, promote, or alter a Core deployment result.

## Common Engineering Workflow

Meshrix.js is a cross-platform Node.js framework. Verification is one automated
toolchain with one normal entry point, `npm run ci:local`. The development agent
starts it automatically as part of the authorized task; do not ask the user to
launch it, select environments or assemble commands. That entry owns
environment discovery, test selection, execution, cleanup and result reporting;
the user must not have to manually chain these tools or choose targets after reading
a discovery report. The internal discovery tool observes the current device's
operating system, CPU architecture, runtime and available local tools; never
hard-code an operator's machine inventory or substitute manual probing.
The entry automatically runs each applicable native-host and local Docker
workflow, either concurrently or sequentially. Discovery must not connect to
Tailscale peers or other remote devices. With an available local Docker engine,
use its observed capabilities for compatible Linux container checks. Without
Docker, verify the native host without requiring virtualization or installing
another hypervisor. Any genuinely necessary manual step must identify the exact
operator action, why it cannot be automated and the input needed to continue.
Implement portable tool and runtime logic in Node.js. When Node.js can perform
an operation across supported systems, do not implement it in OS-specific sh,
Bash or PowerShell scripts, inline workflow shell programs, or hard-coded host
branches. Use Node APIs for files, process lifecycle and orchestration, and
argument-based invocation for necessary external tools. Isolate unavoidable
operating-system integration behind a narrow adapter; it must not become the
basic execution model of the product or verification toolchain. Migrate callers,
tests and documentation with each replacement and remove the superseded path.
Run a check only in an environment that satisfies its actual prerequisites.
When those prerequisites are absent, record the check as not run and continue
the applicable work; do not repeatedly execute it under an unsuitable emulator
or change safety limits to accommodate that environment.

An npm release may be qualified on one or two available platforms. Do not make
exhaustive operating-system or architecture coverage, native Ubuntu, a virtual
machine, Docker, or container-image qualification a universal npm publication
prerequisite. Select representative checks for the actual change and preserve
required functional and security verification on the selected platforms. Keep
unmeasured platforms explicit without claiming they passed or treating their
absence as a failure of the qualified npm candidate. Optional container and
deployment artifacts retain their own applicable validation requirements.

`CONTRIBUTING.md` owns the common engineering workflow: identify the module and
integration owner, decide only consequential architecture or published-support
changes, migrate producers/consumers/tests/documents together, run targeted
evidence, integrate once, and maintain version, deprecation, and release facts.
This file owns Agent execution authority, privacy, live/performance ordering,
and Better Plan lifecycle. Specialist skills and handbooks route to
`CONTRIBUTING.md` and the owning architecture or runbook source instead of
restating that workflow.

Before pushing or promoting a candidate, complete the applicable engineering
checks locally using the same maintained entry points, test selection, build
order, dependency installation policy, and supported runtime versions as hosted
CI. Follow [Local And Hosted CI](CONTRIBUTING.md#local-and-hosted-ci).
Do not use repeated pushes to discover ordinary build, test, installation, or
packaging failures. Repair missing local orchestration for an applicable check
in its canonical workflow before continuing. An unavailable platform is recorded
as not run; a hosted pass does not repair a missing local implementation of an
applicable check.
Keep real registry publication and hosted identity checks in their explicitly
authorized release stage, and never describe them as locally verified.

Iterate release preparation through the same local entry until its applicable
scope passes: correct the workflow, rerun it, diagnose the retained results and
repair the owning implementation. Reuse still-valid successful results. Move
deterministic artifact review into that workflow and remove redundant or
inapplicable artifact restrictions; do not add publication gates merely to
preserve an earlier tooling assumption. Required functional and security checks
and truthful evidence remain part of the selected release scope.

## Report And Repair Repository Scripts

When an agent finds a defect or limitation in the repository's own scripts or
automation, the agent reports the root cause, the affected module boundary, and
the repair, and fixes the defect in the original script. Do not silently bypass
it with a separate script, wrapper, or one-off replacement that leaves the
original script unfixed. A temporary diagnostic script may gather evidence but
is never the repair vehicle. Ordinary authorized scoped repairs continue
without renewed permission; obtain maintainer direction only when the repair
changes actual scope, published support, authority, or risk, or requires an
irreversible action.

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
   rerun the maintained workflow for the complete selected scope, reusing valid
   results. If it exposes another scoped implementation or workflow defect,
   repair that owner and continue the same local cycle until it passes.
   Promotion or release requires that successful integrated result.

If continuing after failure would create unsafe, destructive, or external side
effects, stop before repair, report the undiscovered scope and the required
authority, and obtain a maintainer decision.
