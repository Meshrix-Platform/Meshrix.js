# Meshrix Documentation

This directory contains the formal technical documentation for installing,
running, operating, integrating, and verifying Meshrix as a
private-deployable open platform.

Documentation must be serious, calm, pragmatic, and accurate. It records verified technical facts, current capability status, configuration, protocol boundaries, decision records, and executable verification commands.

## Maintenance Invariants

The canonical policy is [Governed Execution And Minimum
Evidence](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md). It applies
transitively to every maintainer-facing document, plan, workflow contract, and
generated documentation projection under `docs/`, whether or not a child page
repeats it. More specific documents may strengthen the policy but cannot
weaken it. Generated projections inherit the rule from their canonical source
and must not be hand-edited merely to duplicate this notice.

A protected-resource or side-effect path is acceptable only when the canonical
governance authority admits the exact principal, operation, resource, policy,
approval, audience, and effect, and the protected sink consumes that bound
permit. A transport, controller preflight, internal caller, or approval record
is not independent authority. A path that has not converged on this boundary
must not support a release-readiness claim.

Governance evidence and ordinary telemetry have different value. Protected
access and side effects require the minimum bounded lifecycle proof. Routine
success, ordinary denials, logs, metrics, and traces are aggregated, sampled,
or shed under fixed budgets and never retain payload copies. The canonical
architecture, security, Operation Permission, gateway, observability, runtime,
protocol, and runbook documents below own the detailed maintenance rules.

Dependency admission for private deployment is governed by
[Private-Deployment Dependency Admission](RUNBOOK.md#private-deployment-dependency-admission).
It is fail-closed: a direct, transitive, bundled, optional, example, image, or
deployment dependency is rejected whenever its licensing, redistribution,
production-use, maintenance-continuity, or project-governance risk cannot be
resolved from primary evidence. A customer must never be required to absorb a
third-party commercial risk in order to deploy or operate Meshrix privately.
License compliance alone is not admission: a production dependency must also
pass the Runbook's authority, maturity, multi-organization adoption, security
maintenance, operational evidence, and workload-conformance gates.

## Project Documents

| Topic | Document |
| --- | --- |
| Product definition | [../PRODUCT.md](../PRODUCT.md) |
| Contribution process | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Code of conduct | [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| Security policy | [../SECURITY.md](../SECURITY.md) |
| Changelog | [../CHANGELOG.md](../CHANGELOG.md) |
| License | [../LICENSE](../LICENSE) |

## Core Documents

| Topic | Document |
| --- | --- |
| Runtime operation | [RUNBOOK.md](RUNBOOK.md) |
| Architecture | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| Generated system architecture | [architecture/MESHRIX-SYSTEM-ARCHITECTURE.html](architecture/MESHRIX-SYSTEM-ARCHITECTURE.html) |
| Generated service capability architecture | [architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html](architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html) |
| Governed execution and minimum evidence | [architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) |
| Execution sandbox architecture | [architecture/EXECUTION-SANDBOX.md](architecture/EXECUTION-SANDBOX.md) |
| MCP native installer architecture | [architecture/MCP-NATIVE-INSTALLER.md](architecture/MCP-NATIVE-INSTALLER.md) |
| Generated state machines | [architecture/STATE-MACHINES.md](architecture/STATE-MACHINES.md) |
| Protocols | [protocols/PROTOCOLS.md](protocols/PROTOCOLS.md) |
| Plugin package format and loading | [protocols/PLUGIN-PACKAGE-AND-LOADING.md](protocols/PLUGIN-PACKAGE-AND-LOADING.md) |
| Entity configuration | [ENTITY-CONFIG-LAYOUT.md](ENTITY-CONFIG-LAYOUT.md) |
| Compatibility | [COMPATIBILITY.md](COMPATIBILITY.md) |
| Examples | [examples/README.md](examples/README.md) |
| Implemented decisions | [adrs/README.md](adrs/README.md) |

The state-machine document is generated from
`tools/registry/state-machines/state-machine-integrity.registry.json` by
`node tools/generators/generate-state-machine-docs.mjs`. Do not edit the
projection manually. The architecture HTML diagrams are projections of
`packages/contracts/src/modules/manifest.mjs`; update their digest markers with
`node tools/generators/generate-architecture-diagram-digests.mjs`.

## External Maintenance Framework

Reusable maintenance skills, delivery procedures, workflow definitions,
contract templates, examples, and helper scripts are owned by the external
`lico-dev` repository. They are not copied into this product repository.

Use `$lico-feature-reassembly` and the `lico-dev reassembly` commands for a
source split, package extraction, ownership move, protocol separation, or
multi-surface feature closure. Use `lico-dev workflow plan changed` for the
path-selected verification closure and `lico-dev workflow plan reassembly` for
the Core structural closure.

This documentation remains a factual input to that framework:

- [Architecture](architecture/ARCHITECTURE.md) owns current package, layer,
  composition, state, and protocol boundaries.
- [Runbook](RUNBOOK.md) owns current repository commands and runtime
  verification facts.
- Capability and protocol documents own only their implemented public
  behavior and objective limits.

## Capability Documents

| Capability | Document |
| --- | --- |
| Server runtime | [SERVER-RUNTIME.md](functionality/SERVER-RUNTIME.md) |
| Upstream gateway | [GATEWAY.md](functionality/GATEWAY.md) |
| Ingestion and jobs | [INGESTION-JOBS.md](functionality/INGESTION-JOBS.md) |
| Strategy Management | [STRATEGY-MANAGEMENT.md](functionality/STRATEGY-MANAGEMENT.md) |
| Agent Gateway and Model Routing | [AGENT-GATEWAY.md](functionality/AGENT-GATEWAY.md) |
| Maintenance Agent | [MAINTENANCE-AGENT.md](functionality/MAINTENANCE-AGENT.md) |
| Agent workspace governance | [ARCHITECTURE.md — Agent Workspace Governance Boundary](architecture/ARCHITECTURE.md#agent-workspace-governance-boundary) |
| Workspace assets | [WORKSPACE-ASSETS.md](functionality/WORKSPACE-ASSETS.md) |
| Agent collaboration | [AGENT-COLLABORATION.md](functionality/AGENT-COLLABORATION.md) |
| Operation Permission | [OPERATION-PERMISSION.md](functionality/OPERATION-PERMISSION.md) |
| Security and authorization | [SECURITY-AUTHORIZATION.md](functionality/SECURITY-AUTHORIZATION.md) (`docs/functionality/SECURITY-AUTHORIZATION.md`) |
| Operations and observability | [OPERATIONS-OBSERVABILITY.md](functionality/OPERATIONS-OBSERVABILITY.md) |

## Verification

After documentation changes, run:

```bash
npm run verify:docs
npm test
npm run verify:core-platform-surface-convergence
git diff --check
```
