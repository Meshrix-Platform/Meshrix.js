# Architecture

LicoMesh is an open, private-deployable gateway platform for agent access and governed service forwarding.

## Runtime Shape

| Layer | Roots | Responsibility |
| --- | --- | --- |
| Apps | `apps/server/`, `apps/console/` | Runtime entry points and console UI. |
| Contracts | `packages/contracts/` | Operation registry, module facts, generated contract data. |
| Foundation | `packages/foundation/` | Security, authorization, redaction, state machines, storage primitives, config, observability. |
| Server Runtime | `packages/server-runtime/` | Composition, HTTP lifecycle, settings, jobs, upload state, providers. |
| Capabilities | `packages/capabilities/` | Operation Permission, capability providers, audit, metrics. |
| Agents | `packages/agents/` | Agent gateway, workspace files, sessions, contributions, maintenance runtime. |
| Protocols | `packages/protocols/` | HTTP, MCP, pubsub, storage, checkpoint, console protocol facades, and native MCP installer scripts. |
| Console | `apps/console/`, `packages/ui-console/` | Operator administration workflows. |

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

`npm run verify:repo-organization` records this policy in `build/reports/repo-organization.json`. The report explicitly marks the numeric line-count gate as disabled and includes a non-blocking TypeScript AST advisory. That advisory may identify independent exported declaration components as review candidates and shared-state or module-initialization coupling as mechanical-split cautions. It does not prove that a file must or cannot be split, and its findings never determine release readiness.

Every completed split migrates callers, exports, configuration, registries, tests, fixtures, generated projections, and documentation to the new boundary, then removes the superseded path and compatibility artifacts.

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
is non-converged and cannot support a release-readiness claim. This paragraph
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
    ├── Codespace provider (product surface: Code Space)
    │   [runtime capability; no first-class project binding]
    │   ├── provider manifest and repository reference
    │   ├── repository status, tree, file, and diff reads
    │   ├── prepared and uploaded changes
    │   └── review comment, request-changes, approval, and status sync
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
| Code-host and provider-specific coding operations | Codespace provider plugin | Core does not encode GitHub, another code host, repository credentials, review APIs, or provider-specific mutation behavior. |
| Existing external local directories | Shared Space plugin | The external directory remains externally owned. Core exposes only a controlled, workspace-bound Host capability; public projections never contain the real source path. |
| Skill contribution, review, publication, adoption, and permission-aware use | Skill Hub plugin | A project adopts published skills by reference. It does not contain or copy the complete shared library. |
| Authorization, approval, audit, execution admission, and proof | Core | Plugin selection, project attachment, skill adoption, or directory connection never bypasses Core policy or enables execution by itself. |

Core-managed project files are not a Code Space. They provide bounded storage, asset custody, checkpoints, and recovery inside the project boundary. The current GitHub Codespace provider adds governed remote-repository operations; it does not create, start, stop, or persist a GitHub Codespaces cloud instance. A Shared Space connects an existing external directory. These three content surfaces have different owners and identifiers and must not be collapsed into a single path abstraction.

### Capability relationship and reference model

Plugin relationships are not copied ownership trees, and they do not all have the same persistence model:

- The current Codespace provider operation surface accepts plugin-owned provider identity, provider-owned repository coordinates, and revision references at operation time. Provider credentials remain behind the external-service Host boundary. Core does not currently persist a workspace-to-repository or workspace-to-Codespace binding.
- A Shared Space is identified by `mountRef` plus a normalized relative path. Its Core-owned sidecar is bound to `workspaceId`, while the source directory remains outside Core ownership. Connecting it does not submit an asset, copy its files, or publish its path.
- A Core project asset is identified by `assetRef`; revisions, projections, receipts, and lineage are separate evidence records. Materialized bytes remain in Core-managed custody or an explicitly governed target.
- A Skill Hub item is identified by its contribution identity. The plugin-owned registry records a source workspace, target-workspace adoption, asset reference, and permission evidence. Core does not embed `skills[]`, a shared library, or a workspace-skill binding in the workspace row. The current `install` operation means adoption of a published revision; it does not unpack the skill package into the project directory.

Project sharing grants another project governed access to the source project boundary. It does not reveal a Shared Space source path, copy a Code Space repository, duplicate a Skill Hub registry, or implicitly grant plugin operations. Each referenced capability rechecks its own scopes, project authority, lifecycle state, and current Host admission.

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

Core publishes contracts and narrow Host capabilities. Plugins depend on those contracts. Core does not import Codespace provider, Shared Space, or Skill Hub implementations, and a project record does not discover a plugin artifact or activate a plugin. Plugin installation, runtime selection, lifecycle activation, any workspace-bound relation explicitly defined by a capability, and operation authorization remain distinct admissions. Agent or request `pluginList` selection is a runtime tool choice, not project ownership.

All three plugin product lines are absent from the ordinary runtime path unless their verified artifacts are installed, explicitly selected, lifecycle-active, and authorized for the requested operation. The ownership tree is a capability topology; it does not imply automatic enablement, common persistence, or a shared parent-child lifecycle.

### Current implementation status

| Area | Current status |
| --- | --- |
| Core workspace identity, hierarchy, Profile references, sharing, sessions, managed files, assets, checkpoints, audit, and rollback | Implemented as Core workspace capabilities. Platform startup never invents a workspace; creation requires the registered authorized operation. The console currently exposes only part of the complete operation surface. |
| Shared Space project integration | Implemented by plugin `shared-space` and feature `local-sharedspace` as the optional `workspace.local-directory` console slot and workspace-bound operations when the verified plugin is selected and active. |
| Skill Hub project relation | Implemented by plugin and feature `skill-hub` as workspace-partitioned source contributions, target-workspace adoption, asset references, permissions, and evidence. The project does not own the complete Hub catalog or an unpacked `skills[]` collection. |
| Codespace provider capability | Implemented by provider plugins such as `coding/github`. Provider operations exist, but Core does not yet store a first-class repository or Codespace attachment on the project record. |
| Unified project capability assembly UI | Not yet implemented. Current plugin consoles and workspace slots remain separate surfaces. Documentation must not describe them as one completed project-detail workflow. |

The detailed Core asset custody, filesystem, checkpoint, and Host-capability rules are defined in [Workspace Assets](../functionality/WORKSPACE-ASSETS.md). Plugin artifact selection and activation remain governed by the runtime rules in [Server Runtime](../functionality/SERVER-RUNTIME.md).

## Execution Sandbox Boundary

The Execution Sandbox is a Core platform boundary, not a plugin implementation detail. It separates admission and authorization from enforceable filesystem, process, network, secret, resource, output, and tenant isolation. Empty configuration remains empty and non-executable; the runtime cannot select a backend, image, policy, or host-process fallback on the operator's behalf.

Every runtime path that interprets, loads, or launches code influenced by an agent, user, skill, package, or plugin request must enter through the same narrow core port. Skill publication, adoption, plugin enablement, an Operation Permission grant, or one approval never enables execution by itself. A backend failure or an unenforceable restriction fails closed without falling back to a shell or unrestricted local process.

The runtime implements the closed Core port, default-deny policy compiler, bounded broker, trusted-provider resolver, narrow plugin Host port, opaque input custody, quarantined output validation, and a governed OCI Node profile. Provider observation does not become user configuration. Admission requires explicit configuration and a current operator-provisioned conformance receipt; missing, stale, revoked, or unenforceable facts deny without a host-process fallback. Each consuming plugin must produce its own integration receipt; storage-only custody, file-safety checks, and privileged in-process plugin loading are not execution-isolation evidence. The detailed contract, lifecycle, and verification boundary are defined in [EXECUTION-SANDBOX.md](EXECUTION-SANDBOX.md).

## Upstream Service Publishing Boundary

The final publishing authority is a developer control-plane application service, not the console view, gateway registry, protocol adapter, or caller-provided configuration text. It authenticates the maintainer, validates one closed command, and passes a fresh canonical descriptor to a dedicated manifest-writer port. Filenames and directories come only from server-owned identifiers; manifests hold typed certificate and credential references, never material.

The server runtime observes the dedicated manifest root through a read-only gateway identity. It validates a complete candidate set, builds immutable service and operation indexes, and atomically swaps one snapshot. Operation Permission then compiles and commits the corresponding operation catalog revision. Tag and grant projection computes affected visibility partitions, and the downstream gateway exposes scoped revision invalidation, authenticated pull, acknowledgement, disconnect, and reconnect-fence semantics through the published protocol. Discovery and execution use the same current policy; downstream state is never an authorization authority.

The production runtime implements this boundary through the public publishing routes, canonical manifest store, immutable snapshot commit, Operation Permission publication, audience projection, and MCP catalog-delivery contract. `server_published` is the terminal server state. The required report is reduced from detailed production-path facts and contains no client adoption input.

## Server-client protocol boundary

Server and client implementations are completely decoupled behind published communication protocols. Core may depend only on protocol-owned schemas, negotiated capabilities, wire state machines, and declared ports. Core source, runtime composition, plans, tests, release gates, and acceptance reducers must not import, discover, execute, or wait for a client repository, client implementation, client build, client plan, client test, client report, or client receipt.

Server verification uses neutral protocol peers, generated fixtures, and frozen wire corpora to prove authentication, authorization, scoped notification, catalog pull, acknowledgement, disconnect, timeout, and reconnect-fence behavior. Client adoption, cache replacement, UI observation, platform lifecycle, packaging, and product evidence are separate compatibility facts. They cannot block or promote server implementation, server publication, or server release readiness.

## Communication Service

`communication-service` belongs to the capability layer and records stable core protocol-facing services used by downstream clients. It declares **MCP Server** as `mcp-server-side`.

The service provider keeps the MCP route target, protocol versions, and module path aligned with `downstream-client-aspect` and `packages/protocols/mcp/adapter/http-mcp-adapter.mjs`. Optional protocol capabilities enter the runtime only through verified package contributions; the Core communication-service provider does not import or register product implementations.

## MCP Native Installer

MCP user-device installation uses platform-native launchers. macOS and Linux use `packages/protocols/mcp/adapter/native-installer/lico-mcp-install.sh`; Windows uses `packages/protocols/mcp/adapter/native-installer/lico-mcp-install.ps1`. Windows `.cmd` entrypoints are not part of the release surface.

The launchers validate security-sensitive arguments and delegate to the connector shipped in a verified portable release. The connector is the single implementation of signed hub discovery, local agent search, grants, batch and interactive install, device hub registration, client configuration, and uninstall. Shell and PowerShell must not duplicate those protocols.

See [MCP-NATIVE-INSTALLER.md](MCP-NATIVE-INSTALLER.md).

## Deployment Boundary

The baseline deployment is self-contained. Optional middleware integrations provide deployment-specific production characteristics through explicit code, configuration, documentation, and verifier coverage.

## Verification

```bash
npm run typecheck
npm test -- --suite domains.manifest
npm test
npm run verify:core-platform-surface-convergence
npm run verify:private-deployment-open-platform-e2e
```
