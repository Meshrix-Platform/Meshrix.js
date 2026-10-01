# Architecture

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

Meshrix.js is an open-source TypeScript and Node.js framework for governed
HTTP and MCP services. Its server runtime composes protocol, authorization,
storage, and optional capability modules behind explicit package and API
boundaries; the Vue.js Console is a separate workspace connected through
versioned HTTP APIs.

## Target Module Map

The table below is the required ownership, direction, and public-boundary map
for the maintained modules. It states target constraints, not observed
completion: engineering closure additionally requires the actual entry points,
producer/consumer types, composition wiring, state and transaction owners, and
resource lifecycles to match it, with focused evidence. The machine-checkable
portion lives in the registries and graph verifier listed under
[Where The Facts Live](#where-the-facts-live); a rule document, one verifier
pass, or an ADR does not by itself establish architectural completion.

| Module | Roots | Responsibility | Required boundary |
| --- | --- | --- | --- |
| Contracts | `packages/contracts` | Dependency-free workspace contracts, DTOs, operation and module facts, and pure validation. No storage, service locator, domain execution, or infrastructure imports. | No workspace dependency. Foundation may depend on Contracts, never the reverse. Internal generation helpers stay private. |
| Foundation | `packages/foundation` | Reusable security, storage, state-machine, config, and observability primitives. Resource implementations own their connection, key, and transaction cleanup; product decisions stay in their domain owner. | Contracts only. Private backend details and keys stay private; a narrow server-env export exists only for actual callers. No upward dependency into domains, runtime, apps, or tools. |
| Gateway kernel | `packages/gateway` | Protocol-neutral request pipeline, admission, final route and authority checks, bounded schema isolation, and public result classification. | Contracts only; policy, credentials, and upstreams arrive through injected ports. Worker and pipeline internals stay private. One request context owns cancellation and settlement. |
| Agents and Capabilities | `packages/agents`, `packages/capabilities` | Agents owns service publishing, registry snapshots, sessions, and domain application lifetimes. Capabilities owns Operation Permission and governance decisions plus capability implementations. | Contracts, Foundation, and deliberate Protocols surfaces; inter-domain capabilities are injected by server-runtime. Neither reaches into the other or the kernel; private maps, caches, flights, and stores are never mutable external authority. |
| Protocols | `packages/protocols` | HTTP and MCP parsing, serialization, protocol sessions, and transport projections. Business, persistence, and security decisions are ports. | Contracts and Foundation only. Expose the registered protocol/controller facade; keep helper modules private. |
| Server runtime | `packages/server-runtime` | Composition binds actual implementations and lifecycle order. Feature modules own jobs, persistence, and coordination; the materialization feature splits model, transactional store, and runtime. | May depend on the domain packages and Gateway. Composition adapters do not absorb DDL, state machines, recovery loops, or queue ownership. |
| Applications and Console | `apps/server`, `apps/console`, `packages/ui-console` | The server application owns process and HTTP startup and shutdown. The Console owns presentation, local drafts, and observer lifetimes, never backend publication facts. | Consume deliberate public surfaces and browser-safe contracts; shared HTTP DTOs belong to Contracts. No runtime stateful backend factory in UI code. |
| Standalone Gateway app | `apps/mcp-gateway-installer` | A narrow private application composition root owns its configuration migration. The CLI and the maintained repository command enter the same component. | Exact public package dependencies, including the Capabilities policy binding. Production code does not import tools, and config migration is not a supported external export. |
| Extensions and skills | `plugins`, `skills` | Optional verified plugins contribute capabilities through narrow Core-owned Host ports with separate installation, activation, and authorization. Skills route owned development and operations workflows. | Core never imports a plugin implementation; plugins never read cross-component private implementation; no runtime-to-skill dependency. |
| Repository and release tooling | `tools` | Owned white-box verifiers and generators inspect implementation. Shipped startup entry closures are production consumers. Prepare, verify, and publish commands depend downward on pure release metadata. | Tooling may depend on the layers it inspects. Actual product runtime closures obey reusable-package facades; no production-to-tool implementation dependency and no cross-command release cycle. |

Optional operator skill packages live under `skills/` as the `skill-tools`
dependency layer. They are executable operator helpers and local skill
contracts, not Core runtime. Repository tooling may import them for tests.
Core, runtime, and protocol packages must not depend on skill tools, and skill
tools must not import private Core internals.

## Edge And Semantic Gateway Layers

Meshrix.js separates deployment-edge networking from governed application
forwarding.

An operator may place Nginx, Caddy, Envoy, or another independently admitted
reverse proxy in front of Meshrix.js for TLS termination, HTTP-version
negotiation, connection handling, coarse-grained rate limiting, load
balancing, and other edge concerns. The baseline Meshrix.js runtime remains
self-contained and does not require an external proxy. An edge proxy is never
an identity, policy, credential, Operation Permission, approval, or audit
authority, and forwarded metadata cannot replace authenticated Meshrix.js
principal or process identity.

The Node.js runtime is the embedded deployment profile and current semantic
gateway implementation. It owns MCP and RPC interpretation, operation
resolution, governed permit preparation and consumption, policy and approval
coordination, credential application, protocol sessions, upstream forwarding,
and redacted governance evidence. These responsibilities remain inside
Meshrix.js when an external edge is present; they are not delegated to a generic
reverse proxy.

## Source File Organization

Source files are organized by stable responsibility, ownership, dependency direction, and state or lifecycle boundary. Repository gates do not impose a numeric line-count ceiling. File length and other size metrics may prompt review, but they cannot by themselves require a split or block acceptance.

Use the smallest boundary that reduces coupling:

- Keep declarations together when they share one invariant, state owner, lifecycle, change reason, and test boundary.
- Extract a private sibling module inside the current feature root when a responsibility can be named, changed, and tested independently but remains under the same package owner and public API.
- Use a private component directory with a deliberate facade when several sibling modules form one component and their internal imports must remain encapsulated.
- Add a top-level feature root or workspace package only for an independently owned and tested capability with a stable public contract, lifecycle, build setting, or dependency boundary. Update the package manifest, module and public API registries, and executable test ownership in the same change.

Separation is required when one file would otherwise own code from different registered packages or layers, reverse a registered dependency direction, or combine independently changing state and lifecycle owners. In particular:

- Application bootstrap and `server-runtime` composition bind components; they do not absorb domain, protocol, storage, security, or provider implementations.
- Protocol adapters own transport parsing, serialization, and protocol state. Authorization, policy, persistence, and domain behavior remain behind registered operations or explicit ports bound by composition.
- The component that creates mutable state owns its writes. Other components use explicit commands, queries, events, or read-only contracts instead of sharing writable internals.
- Cross-package consumers use registered public facades. Private helpers remain private, and facades expose only deliberate contracts rather than broad implementation re-exports.
- Production modules do not import tests or fixtures. Tests are organized by current behavior or contract, not by implementation stage or numeric shard.
- Console route views retain route-level orchestration and capability data binding. Reusable controls use independent component files and the common component registry; API clients and shared normalization remain in the console library boundary.

A review must resolve, by a cohesive split or a written cohesion explanation, any file that contains responsibilities with different callers, tests, failure policy, lifecycle, state ownership, or independent reasons to change. A split is not complete when it creates circular dependencies, shared mutable state, pass-through fragments, a wider public API, duplicated facts, or modules that must still be edited as one implementation.

Files are not split merely because they are long. A single algorithm, transaction, state machine, cryptographic or protocol invariant, generated projection, declarative registry, schema, table-driven mapping, Vue component, or scenario-focused end-to-end verifier may remain together when it has one owner and one behavioral boundary. Size- or stage-based names such as `part-1`, `chunk-2`, `more`, or `final` are not architectural boundaries; generic names such as `helpers` or `utils` require a narrower responsibility name when they hide ownership.

Refactoring must not add repeated traversal, allocation, serialization, dynamic loading, scheduling hops, or shared-state synchronization merely to shorten a file. Changes to a runtime hot path require representative benchmark, trace, complexity, or memory evidence when the performance effect is not already covered by a current verifier.

Automated gates continue to enforce objective structure: registered dependency direction, feature ownership, public facades, runnable entrypoint ownership, semantic current-boundary names, type safety, tests, and defined performance contracts. File length, function length, export count, complexity, dependency fan-in or fan-out, and change frequency remain review signals rather than standalone acceptance criteria.

`npm run verify:repo-organization` records this policy in `build/reports/repo-organization.json`. The report explicitly marks the numeric line-count gate as disabled and includes a non-blocking TypeScript AST advisory. That advisory may identify independent exported declaration components as review candidates and shared-state or module-initialization coupling as mechanical-split cautions. It does not prove that a file must or cannot be split, and its findings never determine the Functional Release Gate result.

Every completed split migrates callers, exports, configuration, registries, tests, fixtures, generated projections, and documentation to the new boundary, then removes the superseded path and compatibility artifacts.

## State, Lifetime And Composition Ownership

One component owns each mutable state and resource lifetime. Other components
use explicit commands, queries, events, or read-only contracts; they never share
writable internals. Composition binds concrete implementations to typed ports
and never absorbs a domain, storage, or protocol implementation. There is no
generic dependency-injection framework: composition constructs the real
objects, passes explicit ports, and registers close actions.

| State or resource | Sole owner | Wiring and teardown |
| --- | --- | --- |
| Gateway request, admission, and worker lifetime | Gateway kernel request and admission instance (`packages/gateway/src/gateway.ts`, `packages/gateway/src/admission/index.ts`) | The transport supplies the caller signal; `gateway-composition` supplies authority, credential, egress, and upstream ports. One request context settles once. Cancellation is observed before every admission execution branch, so an already-cancelled task is never invoked. Close releases queued waiters, listeners, and worker resources exactly once. |
| Upstream registry, route snapshots, sessions, flights, and caches | Agents upstream registry and session manager (`packages/agents/src/upstream-gateway/`) | One commit authority publishes the durable manifest and immutable snapshot; the registry maintains derived routes and publication facts. Console and protocols query or propose through registered operations and never mutate stored maps. server-runtime injects the schema capability and security ports. The registry owns created lifetimes, cancels pending work on close, and does not close an injected resource. |
| Publishing durable authority and terminal facts | Agents publishing application plus its durable writer and snapshot reader (`packages/agents/src/upstream-gateway/publishing-application.ts`) | The server owns one closed command, durable publication, and terminal facts. Shared command/result DTOs live in Contracts. The Console owns only its observation: a slow, stopped, or interrupted observation is not a server failure and never cancels accepted work. |
| Materialization durable rows, fences, and queue | The materialization feature under `packages/server-runtime/src/jobs/upload-workspace-materialization/` | The feature owns the explicit state model (`model.ts`), the SQLite schema and transactional store (`schema.ts`, `transaction-store.ts`), and runtime admission/reconcile/settle (`runtime.ts`). `composition/upload-workspace-materialization-provider.ts` only asserts the root-owned workspace port and returns the runtime. One owner controls each database transaction and the queue; recovery is ordered before new admission; no DDL, row hydration, state transition, or reconcile loop lives in composition. |
| Publication observation in the Console | The selected Console view observer (`apps/console/lib/upstream-service-publish-client.ts`, `apps/console/views/admin/UpstreamServicePublishView.vue`) | One observer per selected publication owns its GET requests and timer, and cancels or replaces them on unmount, selection change, or explicit stop. Resume queries the same accepted service id and revision. Stale completion from a previous selection is ignored. |
| Process and composition resource lifetime | Server composition root (`packages/server-runtime/src/composition/composition-root.ts`) | Creating a resource registers its close action in `resourceClosers`; shutdown runs closers in reverse registration order, retains a failed closer for retry, and never closes an externally injected resource. `apps/server` owns the process and HTTP lifecycle; `tools/server-scripts/start-server.ts` is a thin production entry into the same composition. |

## Public Surfaces, Private Siblings And Edge Kinds

- **Public surfaces.** A workspace package exposes only its declared
  `package.json` `exports` subpaths. Cross-package production consumers under
  `apps/**`, `packages/**`, `plugins/**`, and the shipped startup closure import
  those public subpaths, never a relative path into another package's source.
  Private siblings remain unexported; sharing a helper inside one package is not
  an API. Adding an export is a contract decision, not a refactor convenience.
- **Application privacy.** `apps/**` packages are `private: true`.
  `apps/mcp-gateway-installer` is a deliberate private composition layer; its
  configuration-migration module is not a published API, and the maintained
  repository command is a thin entry into the same application-owned component.
- **Type-only versus runtime edges.** Layer allow/deny rules apply to every
  resolvable import and re-export. Static runtime imports and re-exports
  additionally form the runtime graph whose strongly connected components are
  checked for cycles. `import type` and named type specifiers are removed only
  from that runtime-cycle computation; they remain subject to layering and
  public/private rules. Dynamic imports are classified separately and never
  become static runtime edges. Console type-only and lazy-route relations are
  therefore not runtime cycles.
- **Contracts independence.** Contracts has no workspace dependency, and
  Foundation may depend on Contracts, never the reverse. Where an existing
  policy allowance or fixture still records a wider direction, aligning it with
  this rule is architecture-guard work; it is not a reason to add a runtime
  import or a broad exception.
- **Tooling versus production entries.** `tools/**` is owned repository tooling
  that may read implementation white-box for verification, generation, and
  release preparation. White-box inspection does not create a supported API.
  Production runtime closures must not import tools; the standalone application
  owns its migration implementation and tooling delegates inward.
- **Plugin and skill isolation.** Core never imports a plugin implementation.
  Verified plugins use narrow Core-owned Host ports, and installation,
  activation, and authorization remain separate admissions. Skills route owned
  development and operations workflows and are not a runtime dependency.

## Where The Facts Live

| Fact | Owner and executable surface |
| --- | --- |
| Layer dependency direction, edge kinds, runtime cycles, and public facades | `tools/registry/dependency-rules.registry.json`; verifier `tools/verifiers/architecture-graph.ts` (`npm run server:verify:architecture-graph`) |
| Module ownership and facts | `tools/registry/modules.registry.json` and the owned `manifest.module.json` files under `packages/**` |
| Public exports and aliases | `packages/*/package.json` `exports`, `tools/registry/public-api.registry.json` |
| Repository and source layout | `tools/registry/repo-layout.registry.json`, `tools/registry/architecture-layout-*.ts`, `npm run verify:repo-organization` |
| Test ownership and suites | `tools/registry/tests.registry.json` |
| Release definition and acceptance facts | `tools/registry/release-definition.registry.json`, `tools/registry/release-acceptance-standards.registry.json` |
| Fact source authority | `tools/registry/fact-source-authority.registry.json` |
| Normative behavior | [Governed Execution And Minimum Evidence](GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) for the permit invariant; [gateway.md](gateway.md), [SERVER-RUNTIME](../functionality/SERVER-RUNTIME.md), [GATEWAY](../functionality/GATEWAY.md), and [STATE-MACHINES.md](STATE-MACHINES.md) for their owned behavior. |

## Core Flow

1. A subject enters through console, HTTP, RPC, MCP, or a maintenance command.
2. The request resolves to a registered operation.
3. Authorization, Operation Permission, tag policy, risk policy, and approval rules produce a decision.
4. The runtime executes the operation or returns a denial.
5. Audit, metrics, and trace references are emitted with redaction.

## Governed Execution Maintenance Invariant

The complete inherited policy, evidence classes, capacity semantics, and
acceptance matrix are defined in [Governed Execution And Minimum
Evidence](GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md).

The non-negotiable maintenance rule is: **no governed permit, no protected
access, no side effect**. A successful decision becomes one immutable,
short-lived, audience-bound execution permit for the exact principal,
operation, resource digest, determining revisions, approval, request digest,
deadline, and effect class. The first credential, private-data, network,
process, plugin Host, queue, artifact, or durable-write sink validates and
consumes that permit. Ingress authentication and controller preflight remain
defense in depth; they do not replace enforcement at the protected sink.

Buffered, streaming, asynchronous, maintenance, plugin, HTTP, RPC, MCP, and
console adapters may specialize transport and backpressure, but they use one
governance preparation and settlement lifecycle. A wait, lock, queue, retry,
approval, recovery, or target-materialization boundary requires current-fact
revalidation before the first protected action.

The lifecycle keeps the minimum proof required for accountability and recovery.
An immutable proof profile may commit a bounded Intent and Outcome; a mutable
store may prepare and settle one row. Ordinary success logs, routine denials,
traces, and metrics are aggregated, sampled, or shed and do not duplicate that
proof. A path without sink-bound permit validation or bounded mandatory proof
is non-converged and fails the Functional Release Gate. This paragraph
is an acceptance invariant, not a blanket claim that every current path has
completed the migration.

## Core Capabilities

- Upstream service gateway for authenticated developer publishing, hardened manifest compilation, no-restart snapshot replacement, Operation Permission projection, scoped audience invalidation, and protocol-side catalog delivery.
- Downstream MCP access for authorized agents.
- Operation Permission and universal tag policy.
- A core execution-sandbox boundary for agent-controlled and untrusted workloads. Empty configuration remains non-executable; an explicitly configured provider is selectable only with a current trusted conformance receipt for the exact governed profile.
- Verified external plugin packages contributing operations, routes, MCP tools, precompiled console assets, and state machines.
- An operation-scoped external-service Host for explicitly configured HTTP and MCP integrations.
- Storage, jobs, checkpoint, audit, approval, observability, and console administration.

## Agent Workspace Governance Boundary

An **Agent Workspace** is the sole product and persistence identity for one governed body of agent work. It is keyed by `workspaceId`; no `AgentProject`, `projectId`, or project-to-workspace alias exists in the protocol, storage model, or product surface.

An Agent Workspace is not a host path, a code-hosting workspace, a complete skill library, or a plugin container. Core owns workspace identity, configuration, activity, managed content, authorization references, and evidence. Optional plugins contribute provider-specific capabilities through registered operations and minimum-authority Host ports. They do not become Core implementation dependencies.

```text
Agent Workspace (canonical identity: workspaceId)
├── Identity and lifecycle [Core]
│   ├── title and objective
│   ├── status and generation
│   ├── owner and bounded metadata
│   └── explicit authorized create, configure, share, and delete lifecycle
├── Hierarchy and access [Core]
│   ├── parent workspace and resolved inheritance chain
│   ├── owned source references
│   ├── accessible workspace references
│   └── share and unshare grants
├── Agent configuration [Core references]
│   ├── context profile reference
│   ├── model alias
│   ├── tool grant reference
│   └── gateway or operation scope
├── Managed project content [Core]
│   ├── workspace-owned files
│   ├── uploaded and generated artifacts
│   ├── opaque asset, revision, projection, and receipt references
│   └── contribution, submission, issue, and decision records
├── Activity [Core]
│   ├── agent sessions and session events
│   ├── runs, branches, and derived context
│   ├── locks and concurrent-operation state
│   └── operation and usage history
├── Evidence and recovery [Core]
│   ├── audit and Operation Permission evidence
│   ├── content-addressed state commits
│   ├── checkpoint trees and restore previews
│   └── compensation and rollback receipts
└── Optional plugin relationships [not embedded workspace fields]
    ├── Shared Space [workspace-bound Core sidecar]
    │   ├── workspace-bound mountRef
    │   ├── controlled external-directory reads and mutations
    │   ├── synchronization plan and apply
    │   └── immutable snapshots and governed output promotion
    └── Skill Hub [plugin-owned workspace relation]
        ├── source contribution and canonical skill asset reference
        ├── target-workspace adoption record
        ├── permission request, grant, and Host receipt
        └── usage, execution, review, revocation, and rollback evidence
```

### Ownership rules

| Concern | Owner | Architectural rule |
| --- | --- | --- |
| Workspace identity, hierarchy, configuration, sessions, managed files, assets, and recovery evidence | Core | These remain available with an empty plugin selection and use `workspaceId` as the protocol boundary. Empty storage remains empty until an authorized create operation. |
| Existing external local directories | Shared Space plugin | The external directory remains externally owned. Core exposes only a controlled, workspace-bound Host capability; public projections never contain the real source path. |
| Skill contribution, review, publication, adoption, and permission-aware use | Independent Skill Hub service | Meshrix reaches the service through a governed adapter and operator-published HTTP binding. A project adopts published skills by reference. |
| Authorization, approval, audit, execution admission, and proof | Core | Plugin selection, project attachment, skill adoption, or directory connection never bypasses Core policy or enables execution by itself. |

Core-managed project files provide bounded storage, asset custody, checkpoints, and recovery inside the project boundary. A Shared Space connects an existing external directory. These content surfaces have different owners and identifiers and must not be collapsed into a single path abstraction.

### Capability relationship and reference model

Plugin relationships are not copied ownership trees, and they do not all have the same persistence model:

- A Shared Space is identified by `mountRef` plus a normalized relative path. Its Core-owned sidecar is bound to `workspaceId`, while the source directory remains outside Core ownership. Connecting it does not submit an asset, copy its files, or publish its path.
- A Core project asset is identified by `assetRef`; revisions, projections, receipts, and lineage are separate evidence records. Materialized bytes remain in Core-managed custody or an explicitly governed target.
- A Skill Hub item is identified by its contribution identity. The independently deployed service owns the registry, source workspace, target-workspace adoption, asset reference, and permission evidence. Meshrix stores no second registry. The current `install` operation means adoption of a published revision; it does not unpack the skill package into the project directory.

Project sharing grants another project governed access to the source project boundary. It does not reveal a Shared Space source path, duplicate a Skill Hub registry, or implicitly grant plugin operations. Each referenced capability rechecks its own scopes, project authority, lifecycle state, and current Host admission.

### Dependency direction

The dependency direction is fixed:

```text
Console / HTTP / MCP
        │
        ▼
registered operation + Core authorization
        │
        ├──► Core Agent Workspace services
        │
        └──► verified plugin contribution
                  │
                  ▼
          minimum-authority Host port
```

Core publishes contracts and narrow Host capabilities. Plugins depend on those contracts. Core does not import Shared Space or Skill Hub implementations, and a project record does not discover a plugin artifact or activate a plugin. Plugin installation, runtime selection, lifecycle activation, any workspace-bound relation explicitly defined by a capability, and operation authorization remain distinct admissions. Agent or request `pluginList` selection is a runtime tool choice, not project ownership.

Both plugin product lines are absent from the ordinary runtime path unless their verified artifacts are installed, explicitly selected, lifecycle-active, and authorized for the requested operation. The ownership tree is a capability topology; it does not imply automatic enablement, common persistence, or a shared parent-child lifecycle.

### Current implementation status

| Area | Current status |
| --- | --- |
| Core workspace identity, hierarchy, Profile references, sharing, sessions, managed files, assets, checkpoints, audit, and rollback | Implemented as Core workspace capabilities. Platform startup never invents a workspace; creation requires the registered authorized operation. The console currently exposes only part of the complete operation surface. |
| Shared Space project integration | Implemented by plugin `shared-space` and feature `local-sharedspace` as the optional `workspace.local-directory` console slot and workspace-bound operations when the verified plugin is selected and active. |
| Skill Hub project relation | Implemented by the independent `services/skill-hub` HTTP service and the stateless `skill-hub` adapter. The service is the sole owner of contributions, adoption, package custody, permissions, and evidence; Meshrix retains authorization and controlled-execution authority. |
| Unified project capability assembly UI | Not yet implemented. Current plugin consoles and workspace slots remain separate surfaces. Documentation must not describe them as one completed project-detail workflow. |

The detailed Core asset custody, filesystem, checkpoint, and Host-capability rules are defined in [Workspace Assets](../functionality/WORKSPACE-ASSETS.md). Plugin artifact selection and activation remain governed by the runtime rules in [Server Runtime](../functionality/SERVER-RUNTIME.md).

## Execution Sandbox Boundary

The Execution Sandbox is a Core platform boundary, not a plugin implementation detail. It separates admission and authorization from enforceable filesystem, process, network, secret, resource, output, and tenant isolation. Empty configuration remains empty and non-executable; the runtime cannot select a backend, image, policy, or host-process fallback on the operator's behalf.

Every runtime path that interprets, loads, or launches code influenced by an agent, user, skill, package, or plugin request must enter through the same narrow core port. Skill publication, adoption, plugin enablement, an Operation Permission grant, or one approval never enables execution by itself. A backend failure or an unenforceable restriction fails closed without falling back to a shell or unrestricted local process.

The runtime implements the closed Core port, default-deny policy compiler, bounded broker, trusted-provider resolver, narrow plugin Host port, opaque input custody, quarantined output validation, and a governed OCI Node profile. Provider observation does not become user configuration. Admission requires explicit configuration and a current operator-provisioned conformance receipt; missing, stale, revoked, or unenforceable facts deny without a host-process fallback. Each consuming plugin must produce its own integration receipt. Storage-only custody and file-safety checks remain current provenance facts. Production plugin entrypoints run in Host-created per-plugin child processes with structured Host-port RPC and no in-process fallback; this is a fault and module-state boundary for trusted deployment code, separate from the adversarial execution-sandbox boundary. The detailed contract, lifecycle, and verification boundary are defined in [EXECUTION-SANDBOX.md](EXECUTION-SANDBOX.md).

## Upstream Service Publishing Boundary

The final publishing authority is a developer control-plane application service, not the console view, gateway registry, protocol adapter, or caller-provided configuration text. It authenticates the maintainer, validates one closed command, and passes a fresh canonical descriptor to a dedicated manifest-writer port. Filenames and directories come only from server-owned identifiers; manifests hold typed certificate and credential references, never material.

The server runtime observes the dedicated manifest root through a read-only gateway identity. It validates a complete candidate set, builds immutable service and operation indexes, and atomically swaps one snapshot. Operation Permission then compiles and commits the corresponding operation catalog revision. Tag and grant projection computes affected visibility partitions, and the downstream gateway exposes scoped revision invalidation, authenticated pull, acknowledgement, disconnect, and reconnect-fence semantics through the published protocol. Discovery and execution use the same current policy; downstream state is never an authorization authority.

The production runtime implements this boundary through the public publishing routes, canonical manifest store, immutable snapshot commit, Operation Permission publication, audience projection, and MCP catalog-delivery contract. `server_published` is the terminal server state. The required report is reduced from detailed production-path facts and contains no client adoption input.

## Server-client protocol boundary

Server and client implementations are completely decoupled behind published communication protocols. Core may depend only on protocol-owned schemas, negotiated capabilities, wire state machines, and declared ports. Core source, runtime composition, plans, tests, release gates, and acceptance reducers must not import, discover, execute, or wait for a client repository, client implementation, client build, client plan, client test, client report, or client receipt.

Server verification uses neutral protocol peers, generated fixtures, and frozen
wire corpora to prove authentication, authorization, scoped notification,
catalog pull, acknowledgement, disconnect, timeout, and reconnect-fence
behavior. Client adoption and client product evidence remain remaining
compatibility work. Real-machine platform lifecycle evidence remains remaining
required work on the named Real-Machine Verification Workflow. Neither category
can block or promote server implementation, publication, or the Functional
Release Gate.

## Communication Service

`communication-service` belongs to the capability layer and records stable core protocol-facing services used by downstream clients. It declares **MCP Server** as `mcp-server-side`.

The service provider keeps the MCP route target, protocol versions, and module path aligned with `downstream-client-aspect` and `packages/protocols/mcp/modern-downstream/index.ts`. Optional protocol capabilities enter the runtime only through verified package contributions; the Core communication-service provider does not import or register product implementations.

## MCP Native Installer

MCP user-device installation uses platform-native launchers. macOS and Linux use `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh`; Windows uses `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.ps1`. Windows `.cmd` entrypoints are not part of the release surface.

The launchers validate security-sensitive arguments and delegate to the connector shipped in a verified portable release. The connector is the single implementation of signed hub discovery, local agent search, grants, batch and interactive install, device hub registration, client configuration, and uninstall. Shell and PowerShell must not duplicate those protocols.

See [MCP-NATIVE-INSTALLER.md](MCP-NATIVE-INSTALLER.md).

## Deployment Boundary

The baseline deployment is self-contained. Optional middleware integrations provide deployment-specific production characteristics through explicit code, configuration, documentation, and verifier coverage.

## Runtime Refactor Convergence

The runtime performance and maintainability refactor converged on one owner per invariant, with no dual readers, writers, or fallback paths.

- Bounded Gateway runtime aggregate owner: `packages/agents/src/upstream-gateway/registry-runtime.ts`. Routine outcomes update bounded in-memory buckets, flush only dirty buckets in bounded batches through the WAL-backed primitive, recover committed buckets at startup, and never synchronously read, merge, sort, serialize, or atomically rewrite the complete runtime state on the request path.
- Incremental Workspace checkpoints: `packages/agents/src/agent-workspace/agent-workspace-file-state.ts`. Ordinary mutations record changed paths and canonical Merkle or CAS references; full enumeration and content materialization occur only for explicit snapshot or export operations.
- Revisioned authorization compiler: `packages/foundation/src/security/authorization/authorization-engine.ts`. Immutable normalized facts compile once per exact bounded revision key; dynamic facts, current revision checks, decision persistence, and final sink enforcement stay outside the cache.
- Unified routing and visible-tool snapshots: `packages/server-runtime/src/routing/operation-route-index.ts`. Dispatch and tool calls use required map indexes, rebuild only on revision change, and re-resolve the current operation before the protected sink.
- Canonical governed proof and audit lifecycle: `packages/server-runtime/src/operations/dispatch-operation-proof-lifecycle.ts`. One execution has one prepared proof, one unique authorization decision, one terminal settlement, and reference-bound audit projections without duplicated durable request or outcome copies.
- Explicit module boundaries: strict Node TypeScript (`tsconfig.node.json`) with deliberate exact package subpath imports and an acyclic lock-manager contract (`packages/foundation/src/concurrency/lock-manager-contract.ts`).
- Typed Console shell: `apps/console/composables/useServerConsoleShell.ts`. Providers and consumers share one readonly compile-time contract with no flat any-typed facade.
- Focused verifier: `npm run verify:runtime-refactor-convergence` proves stable behavior, lossless canonical migration, absence of legacy paths, safe-write forwarding with zero request-path full-state rewrites, bounded work, and privacy-safe clean-run observations. Its report is projection-only and never certifies capacity.

## Verification

These commands cover different scopes. A passing run establishes only its
declared scope and current revision; it does not close architecture work that
still requires production wiring, exports, producer/consumer types, and
state/lifecycle evidence.

```bash
npm run server:verify:architecture-graph   # writes build/reports/architecture-graph.json
npm test -- --suite architecture.import-graph --continue-on-failure
npm test -- --suite domains.manifest
npm run verify:repo-organization
npm run typecheck
npm run verify:core-platform-surface-convergence
npm run verify:private-deployment-internal-platform-e2e
```

The graph verifier classifies every resolved edge as static runtime, type-only,
or dynamic, then proves resolvable dependency direction, public package
facades for production consumers and declared `package.json` `bin` entry
closures, and acyclic static runtime imports within its declared scanner
roots. Type-only and dynamic edges are excluded only from the runtime cycle
computation; layer and facade rules still apply to them. Ownership, lifecycle,
and cohesion that static imports cannot prove remain a continuous review
responsibility. Record an ADR only after implemented structures and checks
substantiate it.
