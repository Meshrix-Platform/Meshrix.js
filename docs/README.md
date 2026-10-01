# Meshrix.js Documentation

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

This directory contains technical references for Meshrix.js architecture,
protocols, capabilities, installation, operation, and verification. Documents
describe behavior implemented by the current source and distinguish it from
support established for an exact release artifact or environment.

## Technical and maintenance boundaries

- [Governed Execution And Minimum Evidence](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
  defines the common authorization, protected-sink, and bounded-evidence model.
- [Architecture](architecture/ARCHITECTURE.md) owns package layers, module
  ownership, composition, state, and public boundaries.
- [Contributing](../CONTRIBUTING.md) owns the common engineering workflow;
  [AGENTS.md](../AGENTS.md) owns execution authority, privacy, and release
  boundaries.
- [Runbook](RUNBOOK.md) owns executable repository commands and runtime
  procedures. Dependency license, security, and maintenance review is described
  in [Dependency Admission](RUNBOOK.md#dependency-admission).
- [Status](STATUS.md) records candidate-bound implementation and verification
  facts. [Compatibility](COMPATIBILITY.md) describes protocol, runtime, and
  environment targets without extending a support claim beyond its evidence.

Protected access and side effects require the canonical authority to admit the
exact principal, operation, resource, policy, audience, and effect; the
protected sink consumes the bound permit. Routine telemetry is aggregated,
sampled, or shed under fixed budgets and does not retain payload copies. The
owning security, operation, gateway, observability, runtime, and protocol
documents specify the detailed behavior.

## Project Documents

| Topic | Document |
| --- | --- |
| Framework scope | [../PRODUCT.md](../PRODUCT.md) |
| Domain language | [../CONTEXT.md](../CONTEXT.md) |
| Current five-dimension status | [STATUS.md](STATUS.md) |
| Contribution process | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Code of conduct | [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| Security policy | [../SECURITY.md](../SECURITY.md) |
| Changelog | [../CHANGELOG.md](../CHANGELOG.md) |
| Governed release status | [releases/README.md](releases/README.md) |
| License | [../LICENSE](../LICENSE) |

## Meshrix.js Technical Documents

| Topic | Document |
| --- | --- |
| Current status | [STATUS.md](STATUS.md) |
| Release definition and publication | [RUNBOOK.md#release-definition-and-publication](RUNBOOK.md#release-definition-and-publication) |
| Runtime operation | [RUNBOOK.md](RUNBOOK.md) |
| Architecture | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| Generated system architecture | [architecture/MESHRIX-SYSTEM-ARCHITECTURE.html](architecture/MESHRIX-SYSTEM-ARCHITECTURE.html) |
| Generated service capability architecture | [architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html](architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html) |
| Governed execution and minimum evidence | [architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) |
| Execution sandbox architecture | [architecture/EXECUTION-SANDBOX.md](architecture/EXECUTION-SANDBOX.md) |
| MCP native installer architecture | [architecture/MCP-NATIVE-INSTALLER.md](architecture/MCP-NATIVE-INSTALLER.md) |
| Generated state machines | [architecture/STATE-MACHINES.md](architecture/STATE-MACHINES.md) |
| Protocols | [protocols/PROTOCOLS.md](protocols/PROTOCOLS.md) |
| Gateway kernel architecture | [architecture/gateway.md](architecture/gateway.md) |
| Gateway protocol boundary | [protocols/gateway.md](protocols/gateway.md) |
| Plugin package format and loading | [protocols/PLUGIN-PACKAGE-AND-LOADING.md](protocols/PLUGIN-PACKAGE-AND-LOADING.md) |
| Repository-local plugin implementation contract | [protocols/PLUGIN-IMPLEMENTATION-CONTRACT.md](protocols/PLUGIN-IMPLEMENTATION-CONTRACT.md) |
| Format conversion API | [protocols/convert-api.md](protocols/convert-api.md) |
| Entity configuration | [ENTITY-CONFIG-LAYOUT.md](ENTITY-CONFIG-LAYOUT.md) |
| Compatibility reference (informational, not a deployment gate) | [COMPATIBILITY.md](COMPATIBILITY.md) |
| Examples | [examples/README.md](examples/README.md) |
| Implemented decisions | [adrs/README.md](adrs/README.md) |

The state-machine document is generated from
`tools/registry/state-machines/state-machine-integrity.registry.json` by
`node tools/generators/generate-state-machine-docs.ts`. Do not edit the
projection manually. The architecture HTML diagrams are projections of
`packages/contracts/src/modules/manifest.ts`; update their digest markers with
`node tools/generators/generate-architecture-diagram-digests.ts`.

## Capability Documents

| Capability | Document |
| --- | --- |
| Server runtime | [SERVER-RUNTIME.md](functionality/SERVER-RUNTIME.md) |
| Upstream gateway | [GATEWAY.md](functionality/GATEWAY.md) |
| Ingestion and jobs | [INGESTION-JOBS.md](functionality/INGESTION-JOBS.md) |
| Strategy Management | [STRATEGY-MANAGEMENT.md](functionality/STRATEGY-MANAGEMENT.md) |
| Mandatory gateway pipeline | [GATEWAY.md](functionality/GATEWAY.md) |
| Standalone Model Gateway Service | [README.md](../services/model-gateway/README.md) |
| Agent workspace governance | [ARCHITECTURE.md — Agent Workspace Governance Boundary](architecture/ARCHITECTURE.md#agent-workspace-governance-boundary) |
| Workspace assets | [WORKSPACE-ASSETS.md](functionality/WORKSPACE-ASSETS.md) |
| Agent collaboration | [AGENT-COLLABORATION.md](functionality/AGENT-COLLABORATION.md) |
| Operation Permission | [OPERATION-PERMISSION.md](functionality/OPERATION-PERMISSION.md) |
| Security and authorization | [SECURITY-AUTHORIZATION.md](functionality/SECURITY-AUTHORIZATION.md) (`docs/functionality/SECURITY-AUTHORIZATION.md`) |
| Operations and observability | [OPERATIONS-OBSERVABILITY.md](functionality/OPERATIONS-OBSERVABILITY.md) |
| Format conversion | [format-convert.md](functionality/format-convert.md) |

## Verification

After documentation changes, validate the changed facts, referenced paths, and
commands. For this documentation surface, use:

```bash
npm run verify:docs
git diff --check
```

Add `npm run verify:core-platform-surface-convergence` only when the affected
Core surface contract requires it. Skill changes use `npm run verify:skills`.
Source behavior changes follow the regression planner; documentation-only
edits do not require the Core runtime test profile. Follow
[Contributing](../CONTRIBUTING.md) for review and repair of any findings.
