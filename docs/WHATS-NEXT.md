# What's Next: Functional Convergence

The only current Meshrix.js outcome is one **enterprise single-node functional
candidate combining efficient optional Workspace-backed Agent MCP application
processing with one mandatory downstream-Gateway and upstream-Gateway
pipeline, Workspace-free direct transit through that same pipeline, a
standalone Model Gateway HTTP Service, a default-disabled stateless Meshrix
adapter, Console-controlled per-direction Gateway selection, a bidirectional
External Gateway Runtime Plugin, a one-way local Agent self-maintenance plugin,
and plugin confinement**. The maintenance plugin is a separately started
client-peer artifact controlled only by one local configuration file. It calls
Model Gateway directly and Meshrix only through existing ordinary governed
operations; Meshrix cannot call, observe, configure, schedule, cancel, start,
stop, or restart it.
Delivery-quality additions on that same Plan are reproducible
acceptance-gate provenance, security-critical typing, and faster verification.
They are not a new product direction. The thin substrate blocked GATE-CONTRACT;
the remainder joined GATE-FINAL. The machine-readable local Plan in
`docs/plans/` owns execution detail. GATE-FINAL is the completed terminal
candidate decision, its accepted receipt is recorded, and the Functional
Convergence Plan is closed. Native Linux, client, cloud, recovery,
publication, and hosted-operation work is tracked separately. It does not
gate or reopen this Plan.

## Primary objectives

### Efficient Workspace application collaboration

For `workspace_application` traffic, Meshrix.js will make Agent interaction
with a Workspace-backed application service behave more like a person editing
a shared document:

1. open a governed Service Working Set once;
2. keep a private authorization-partitioned local view;
3. read and edit locally without repeating unchanged catalogs, schemas, or
   Resources;
4. submit at most one bounded Change Set per dirty Agent turn;
5. receive a compact acknowledgement and changed Resource identities;
6. subscribe to relevant deltas; and
7. rebase typed changes or resume from a Cursor or authorized Snapshot.

Core-managed state may use atomic Change Sets and deterministic conflict
handling. Arbitrary external or irreversible effects remain explicit governed
Commands. They are never silently retried or treated as mergeable document
edits.

The named future warm-profile targets are zero unchanged schema bytes, zero
remote reads for valid cache hits, zero apply calls for clean turns, at most one
Change Set call for dirty turns, at least 60% fewer model-visible calls, and at
least 70% fewer model-context and wire bytes than the equivalent frozen legacy
scenario. Named-profile thresholds are recorded in the efficiency profile
report.

These reductions apply only to the optional Workspace application stage. They
do not describe direct-transit or Gateway throughput, latency, production
controls, caching, or state. Application traffic must still traverse both
mandatory Gateway stages.

### Mandatory dual-Gateway pipeline, optional application stage, standalone Model Gateway, and local Agent self-maintenance

The embedded Agent Gateway, unconditional MCP Workspace resolution,
and nested External Gateway ownership are replaced by seven separated
authorities:

1. an immutable operation-descriptor classification with exactly
   `trafficModel: workspace_application | gateway_transit`. The caller cannot
   supply or override it. Missing, conflicting, or unknown classification
   fails before Gateway admission, Workspace resolution, credential access, or
   network egress. This value selects only the optional middle stage and never
   bypasses either Gateway;
2. a mandatory downstream Gateway stage that normalizes every admitted MCP
   call into `DownstreamGatewayEnvelope` and sends it through exactly one
   selected built-in or External Gateway channel before any application work;
3. an optional Workspace application stage for `workspace_application` that
   provides Meshrix capabilities to downstream Agents through authorized
   Workspace context, Working Set, Working View, bounded Change Set, Resource
   delta, cache, checkpoint, materialization, and conflict behavior. For
   `gateway_transit`, this middle stage is bypassed with zero Workspace work;
4. a mandatory upstream Gateway stage that normalizes both modes into
   `UpstreamGatewayEnvelope` and sends them through exactly one selected
   built-in or External Gateway channel before the upstream Service. Responses
   mirror the pinned upstream Gateway, optional application-response stage,
   and downstream Gateway;
5. a Workspace-free direct-transit rule: `gateway_transit` never
   resolves, creates, reads, mutates, materializes, caches, checkpoints, or
   otherwise touches Workspace state, but it still traverses both Gateway
   stages and cannot fall back to the application model;
6. an independently deployable Model Gateway HTTP Service that owns its own
   direct-client authentication, models, providers, credentials, routing,
   persistence, request, token, concurrency, cost admission, pricing revisions,
   usage, settlement, health, and lifecycle without importing or discovering
   Meshrix, plus a default-disabled stateless Meshrix adapter that contains no
   model state,
   endpoint, credential, ledger, or Service lifecycle control and exposes
   `model_gateway.call` plus `models.*` only after local Operation Permission
   and independent Service authorization. Its descriptor is `gateway_transit`,
   so it bypasses only the optional application stage; and
7. two independent plugins: a default-disabled External Gateway Runtime Plugin
   contributes optional upstream and downstream Caddy/Nginx/direct channels
   for both traffic models, while the separately started local Agent
   self-maintenance plugin runs under a different non-privileged OS identity.
   External Gateway receives no Workspace or application-stage port and cannot
   select traffic.
   Maintenance uses one fixed, closed-schema, atomically replaced configuration
   file as its only behavior-control input. It owns its scheduler, queue,
   cancellation, recovery, evidence, storage, credentials, process, and
   lifecycle. It listens on no port and exposes no HTTP, RPC, MCP, CLI, argv,
   environment override, stdin, Console, Host port, callback, runtime
   contribution, status, or lifecycle interface.

The Model Gateway Service is an independently operated upstream model service.
Both `workspace_application` and `gateway_transit` use the mandatory downstream
and upstream Gateway stages before reaching Model Gateway or another upstream
service. Meshrix Core owns one selected generation per direction. Only an
explicit governed administrator action from Meshrix Console changes the named
direction and target gateway. Switching downstream does not implicitly switch
upstream, and plugin activation never switches either. In-flight calls remain
pinned to both admitted generations; failed selections leave state unchanged,
and a selected plugin-channel failure does not fall back to built-in, another
channel, Workspace, or a different application mode.

Both Gateway stages must apply production transport controls to both traffic
models: bounded load distribution, rate and concurrency admission, health and
circuit handling, overload shedding, timeout, cancellation, streaming and
backpressure. These controls may return stable transport degradation but may
not reinterpret the Meshrix operation or insert, skip or replace the optional
application stage.

The Service exposes a versioned language-neutral HTTP and JSON contract for
direct clients. Its direct calls do not inherit Meshrix governance. Meshrix
never sends an Operation Permission permit as Service authority and never
starts, stops, migrates, recovers, upgrades, bundles, or monitors the Service.
The Service never accesses Meshrix processes, addresses, storage,
configuration, secrets, ledgers, caches, locks, event buses, or lifecycle.
With the adapter disabled or removed, Meshrix performs no Service discovery,
network access, credential resolution, retry, timer, listener, subscription,
child-process launch, or Service-driven durable mutation; startup, readiness,
and non-model operations remain available.

The maintenance plugin calls the standalone Model Gateway Service directly
with its own client identity; it never depends on Meshrix's Model Gateway
adapter. It calls Meshrix only as an independent external service principal
through existing ordinary operations. Model output remains an untrusted
proposal. Every protected Meshrix effect must consume a current Operation
Permission permit at the sink. That permission authorizes only Meshrix's own
effect: it cannot call, observe, configure, schedule, cancel, start, stop, or
restart the plugin. Meshrix owns no maintenance scheduler, queue, state,
configuration, credential, PID, socket, status, process handle, or run
observation. The same cutover removes the retired embedded model-call and Core
maintenance control surfaces together with all compatibility paths, without
migrating retired data.

## Required closures

| Closure | Required result |
| --- | --- |
| Workspace application interaction baseline | For the optional `workspace_application` stage only: equivalent cold, warm, dirty-turn, reconnect, conflict, revocation, and side-effect workloads with privacy-safe counters. It makes no Gateway performance claim and does not permit either mandatory Gateway stage to be skipped. |
| Workspace application collaboration contract | Standards-compatible MCP Resources, private cache policy, subscriptions, stable identities, Change Sets, Cursors, Snapshots, conflicts, and current authorization. These authorities are unavailable to `gateway_transit`. |
| Connector Working View | For `workspace_application` only: confirmed and optimistic state, bounded cache, Inbox and Outbox, invalidation, acknowledgement, backpressure, and resynchronization. |
| Core application state and effects | For `workspace_application`: one Change Set authority for Core-managed state and separate explicit Effect Commands for external side effects. Gateway transit neither reads nor writes these authorities. |
| Workspace reference migration | Shared Workspace editing uses the optional application stage and removes per-file model loops and former online writers. Direct forwarding uses `gateway_transit`, not a synthetic Workspace; both use the same mandatory Gateway layers. |
| Workspace application efficiency evidence | The exact named application profile either passes every reduction, privacy, safety, and recovery threshold or remains non-certifying with a finite reason. Direct transit has separate zero-Workspace evidence, while both modes have Gateway stage-order and production-control evidence. |
| Thin delivery-quality substrate | Completed before GATE-CONTRACT: provenance, security-critical typing, and faster verification. The thin substrate blocked GATE-CONTRACT. |
| Agent MCP and Gateway architecture contract | Frozen descriptor-owned `trafficModel` as an optional-middle-stage selector, immutable `DownstreamGatewayEnvelope`, `WorkspaceApplicationEnvelope`, and `UpstreamGatewayEnvelope`, the fixed stage order, production-control semantics, the standalone Service HTTP and JSON contract, Meshrix client and adapter ports, built-in and plugin channel interfaces in both directions for both traffic models, plugin-lifecycle-as-availability-only, explicit Console direction-and-target selection, the maintenance plugin's closed local configuration and outbound-client contracts, import directions, and mutually exclusive write sets. |
| Model Gateway Service | One independently startable Service with direct clients, its own models, providers, credentials, routing, persistence, request/token/concurrency/cost admission, pricing-revision-bound usage settlement, metadata-only accounting, health, restart recovery, and separate OCI artifact. It imports no Meshrix runtime and has no Agent/tool authority. |
| External Gateway Runtime Plugin | `plugins/external-gateway` as a default-disabled native Runtime Plugin contributing optional downstream and upstream Caddy/Nginx/direct channels for both traffic models; it receives no Workspace or application-stage port, both channels preserve the immutable Gateway contracts and fixed stage order, and plugin lifecycle cannot select, redirect, authorize, reinterpret traffic, or skip a stage. |
| Local Agent self-maintenance plugin | One separately started client-peer artifact controlled only by an atomically replaced local configuration file; direct Model Gateway client; ordinary governed Meshrix operation client; local bounded scheduler, queue, cancellation and recovery; no listener, Host port, runtime contribution, backend handle, Console, status, or lifecycle interface. |
| Real parallel frontier | The standalone Model Gateway Service, Agent self-maintenance, and External Gateway Runtime Plugin compile and pass focused tests independently from frozen contracts without importing one another or editing shared composition authorities. |
| Canonical cutover | One necessary join migrated every downstream operation descriptor to exactly one `trafficModel`; installed `AgentMcpGatewayPipeline`, mandatory downstream and upstream Gateway stages, retained optional Workspace application processing, direct Workspace-free middle-stage bypass, Core per-direction selection generations, `gatewayChannels` contribution plumbing, explicit Console switching, and the default-disabled stateless Model Gateway adapter; kept maintenance outside Meshrix composition; removed unconditional Workspace resolution, every Gateway-bypassing path, and every retired Gateway/profile/Core-maintenance authority; completed confinement; and discarded one residue audit. |
| Delivery-quality remainder | Remainder typing, acceptance-gate provenance, and suite merge/cache/shard joined GATE-FINAL. Project-level `npm run verify:acceptance` remains the Functional Release Gate when a functional-complete claim is required. |
| Gateway and maintenance acceptance | GATE-FINAL completed and recorded the accepted sequential dual-Gateway, detachment, and one-way maintenance candidate. The oracle is an in-process fixture. |

Implemented capacity and concurrency changes are substrate for this Plan, not a
separate current Plan. Historical Plans and receipts do not promote the current
candidate.

## Non-gating follow-up outside the closed Plan

The items below may establish separate release, publication, operation, or
environment-support claims. They are not Functional Convergence closure
conditions and do not change the completed GATE-FINAL decision.

- Native Linux host qualification for named amd64 and arm64 systems.
- macOS, Windows, and other client-platform qualification.
- Public-cloud and independent clean-host recovery qualification.
- Multi-node availability, forwarding, federation, hosted operation, and
  concrete third-party provider support.
- Public npm publication of the `0.0.1` release set (`meshrix.js`, the
  `@meshrix/*` workspace packages, and `meshrix-mcp-connector`) on
  `https://registry.npmjs.org/`. The installability gate is a lock-backed
  offline simulation of packed tarballs and is not a substitute for that
  publication.
