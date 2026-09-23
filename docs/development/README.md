# Developer Guide

## Development setup

Use a Node.js version supported by `package.json` and install the locked dependencies:

```bash
npm ci
npm run dev
```

This starts the source API server. To build and serve the Web Console from the same origin:

```bash
npm run build
npm run server:start -- --with-ui --strict-port
```

The default local origin is `http://127.0.0.1:7228`. See [local startup](../RUNBOOK.md#local-startup) for instance reuse, start/stop commands, and separate development-console ports. Deployment configuration, environment variables, secret custody, proxy configuration, backup mounts, and diagnostics belong to the [runbook](../RUNBOOK.md), not the repository landing page.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `apps/` | Server and console application entry points. |
| `packages/` | Shared contracts, foundation, agents, capabilities, protocols, server runtime, and console UI. |
| `services/` | Repository-local service implementations. |
| `plugins/` | Runtime plugins, client adapters, manifests, and schemas. |
| `tools/` | Server scripts, verifiers, generators, and registry tooling. |
| `docs/` | Usage, operation, integration, architecture, and maintenance references. |
| `tests/` | Repository verification suites. |

The console uses Vue.js and the server uses Node.js. They are separate workspaces with a versioned HTTP boundary. Package dependencies and execution ownership are defined in [Architecture](../architecture/ARCHITECTURE.md).

![Architecture overview](../architecture-overview.svg)

## Documentation conventions

English is the normative language of the repository's technical documentation. The [Chinese README](../../README.zh-CN.md) is a localized user entry point. Resolve conflicting technical statements against their owning English reference and update both user entry points when user-visible facts change. Language precedence is a contributor convention, not homepage copy.

### Repository entry points

`README.md` and `README.zh-CN.md` serve people deciding whether to try Meshrix.js. Each sentence should help a reader understand what it does, recognize a useful capability, see the product, start it, or find the next instruction.

- Describe user actions and outcomes rather than internal module names. Explain what permissions let an operator do; put grant, scope, permit, and execution-pipeline definitions in their owning reference.
- Keep one local path that opens the Web Console. Link to deployment alternatives and detailed client configuration rather than reproducing their manuals.
- Keep concise, decision-relevant facts such as runtime requirements, pre-release status, and the license. Do not repeat readiness claims, test counts, evidence vocabulary, document-authority notices, or release procedures.
- Use reviewed screenshots of the actual Web Console with synthetic data. Do not substitute an architecture diagram or a generated mockup for the running product. Store approved images under `docs/images/`, use descriptive alternative text, and show only services, permissions, or activity needed to explain the product. Exclude credentials, private hosts, personal information, and unredacted payloads.
- Keep the two entry points equivalent in user-facing meaning. Do not translate internal jargon mechanically into the Chinese introduction.

### Technical documentation

Documentation must be serious, calm, pragmatic, and accurate. It records verified technical facts, current capability status, configuration, protocol boundaries, decision records, executable verification commands, and gaps with an explicit owner and scope. A gap blocks the current task only when its accepted outcome requires that capability. Other gaps belong to their owning roadmap or workflow; neither an unverified capability nor a permanent refusal may be invented from a current limitation. Explicit product exclusions remain exclusions until a new decision changes them.

Repository-local source, registries, documentation, and verification commands are the maintenance authority:

- [Architecture](../architecture/ARCHITECTURE.md) owns package, layer, composition, state, and protocol boundaries.
- [Runbook](../RUNBOOK.md) owns repository commands, runtime operation, deployment, and release procedures.
- Capability and protocol documents own their implemented public behavior and objective limits.

The [state-machine document](../architecture/STATE-MACHINES.md) is generated from `tools/registry/state-machines/state-machine-integrity.registry.json` by `node tools/generators/generate-state-machine-docs.ts`. Do not edit the projection manually. The architecture HTML diagrams are projections of `packages/contracts/src/modules/manifest.ts`; update their digest markers with `node tools/generators/generate-architecture-diagram-digests.ts`.

## Validation

After documentation changes, validate the changed facts, referenced paths, and commands:

```bash
npm run verify:docs
git diff --check
```

Add `npm run verify:core-platform-surface-convergence` only when the affected Core surface contract requires it. Skill changes use `npm run verify:skills`. Source behavior changes follow the regression planner; do not run the entire Core test profile merely to select checks for a documentation edit. Complete all changes, source review, repairs, and focused checks before the single final regression selected for the task. Final-regression failures require the developer's repair and rerun decision.

For source changes, select the relevant checks described in [Contributing](../../CONTRIBUTING.md#validation) and the [runbook](../RUNBOOK.md). Common commands include:

```bash
npm run typecheck
npm run build
npm test
```

These commands check different scopes; a successful documentation check is not functional acceptance or deployment evidence.

## Maintenance invariants

The canonical policy is [Governed Execution And Minimum Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md). It applies transitively to every maintainer-facing document, plan, workflow contract, and generated documentation projection under `docs/`, whether or not a child page repeats it. More specific documents may strengthen the policy but cannot weaken it. Generated projections inherit the rule from their canonical source and must not be hand-edited merely to duplicate this notice.

Meshrix.js trusted-forwarding requirements are verifiable identity, non-amplifying authority, content integrity, and end-to-end traceability. The canonical policy owns their normative meaning.

A protected-resource or side-effect path is acceptable only when the canonical governance authority admits the exact principal, operation, resource, policy, approval, audience, and effect, and the protected sink consumes that bound permit. A transport, controller preflight, internal caller, or approval record is not independent authority. A path that has not converged on this boundary fails the Functional Release Gate.

### Release and environment qualification

The [Runbook release contract](../RUNBOOK.md#release-definition-and-publication) separates the mandatory Functional Release Gate and mandatory Release Deployment Verification from remaining Real-Machine Verification Workflows and their Environment Support Claims. `npm run verify:acceptance` is the Functional Release Gate and must pass before publication. An accepted immutable candidate may then be exercised by `npm run verify:real-machine -- ...` for one exact system or deployment.

Functional acceptance is a prerequisite for the exact-candidate runtime-ui deployment on `ubuntu-24.04` and for every real-machine workflow. A real-machine receipt never blocks, promotes, or changes functional acceptance. Offline delivery may run on Linux inside a virtual machine; Ubuntu is preferred and Debian is accepted. That evidence does not establish native Linux, Ubuntu, or Debian qualification, which remains owned by the named Real-Machine Verification Workflow.

### Evidence and telemetry

Governance evidence and ordinary telemetry have different value. Protected access and side effects require the minimum bounded lifecycle proof. Routine success, ordinary denials, logs, metrics, and traces are aggregated, sampled, or shed under fixed budgets and never retain payload copies. The canonical architecture, security, Operation Permission, gateway, observability, runtime, protocol, and runbook documents below own the detailed maintenance rules.

### Dependency admission

Dependency admission for private deployment is governed by [Private-Deployment Dependency Admission](../RUNBOOK.md#private-deployment-dependency-admission). It is fail-closed: a direct, transitive, bundled, optional, example, image, or deployment dependency is rejected whenever its licensing, redistribution, production-use, maintenance-continuity, or project-governance risk cannot be resolved from primary evidence. A customer must never be required to absorb a third-party commercial risk in order to deploy or operate Meshrix.js privately. License compliance alone is not admission: a production dependency must also pass the Runbook's authority, maturity, multi-organization adoption, security maintenance, operational evidence, and workload-conformance gates.

### Plans and current status

Temporary planning workspaces are execution aids, not durable product authorities. Delete them after their outcome is implemented and verified. Current product state belongs in [Status](../STATUS.md); executable acceptance, deployment, production-closure, and publication facts belong to their owning commands and candidate-bound reports.

## Technical references

### Product and architecture

| Topic | Reference |
| --- | --- |
| Product definition | [PRODUCT.md](../../PRODUCT.md) |
| Domain language | [CONTEXT.md](../../CONTEXT.md) |
| Current status | [STATUS.md](../STATUS.md) |
| Interactive regression snapshot | [Regression](../verification/regression.html) |
| Architecture | [Architecture](../architecture/ARCHITECTURE.md) |
| System architecture diagram | [System architecture](../architecture/MESHRIX-SYSTEM-ARCHITECTURE.html) |
| Service capability architecture diagram | [Service architecture](../architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html) |
| Execution sandbox | [Execution sandbox](../architecture/EXECUTION-SANDBOX.md) |
| MCP native installer | [MCP native installer](../architecture/MCP-NATIVE-INSTALLER.md) |
| State machines | [State machines](../architecture/STATE-MACHINES.md) |
| Implemented decisions | [Decision records](../adrs/README.md) |
| Release status and procedures | [Releases](../releases/README.md), [release contract](../RUNBOOK.md#release-definition-and-publication) |

### Protocols and capabilities

| Topic | Reference |
| --- | --- |
| Protocols | [MCP and HTTP](../protocols/PROTOCOLS.md) |
| Plugin package format | [Plugin packages](../protocols/PLUGIN-PACKAGE-AND-LOADING.md) |
| Repository-local plugin contract | [Plugin implementation](../protocols/PLUGIN-IMPLEMENTATION-CONTRACT.md) |
| Format conversion API | [Conversion API](../protocols/convert-api.md) |
| Entity configuration | [Configuration layout](../ENTITY-CONFIG-LAYOUT.md) |
| Compatibility | [Compatibility reference](../COMPATIBILITY.md) |
| Examples | [Examples](../examples/README.md) |
| Server runtime | [Server runtime](../functionality/SERVER-RUNTIME.md) |
| Upstream gateway and pipeline | [Gateway](../functionality/GATEWAY.md) |
| Ingestion and jobs | [Ingestion and jobs](../functionality/INGESTION-JOBS.md) |
| Strategy Management | [Strategy Management](../functionality/STRATEGY-MANAGEMENT.md) |
| Standalone Model Gateway Service | [Model Gateway](../../services/model-gateway/README.md) |
| Agent workspace governance | [Workspace governance](../architecture/ARCHITECTURE.md#agent-workspace-governance-boundary) |
| Workspace assets | [Workspace assets](../functionality/WORKSPACE-ASSETS.md) |
| Agent collaboration | [Agent collaboration](../functionality/AGENT-COLLABORATION.md) |
| Operation Permission | [Operation Permission](../functionality/OPERATION-PERMISSION.md) |
| Security and authorization | [Security and authorization](../functionality/SECURITY-AUTHORIZATION.md) |
| Operations and observability | [Operations and observability](../functionality/OPERATIONS-OBSERVABILITY.md) |
| Format conversion | [Format conversion](../functionality/format-convert.md) |
