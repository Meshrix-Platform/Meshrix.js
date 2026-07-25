# Server Runtime

The server runtime owns process startup, settings, HTTP lifecycle, operation dispatch, jobs, upload sessions, provider composition, feature manifests, operational boundaries, and local runtime state.

## Responsibilities

- Load settings and runtime modules.
- Start HTTP and protocol entry points.
- Attach storage, job, upload, audit, metrics, and capability providers.
- Dispatch registered operations through the governed runtime path.
- Emit health and diagnostic information with private runtime data redaction.

## Runtime Data

Runtime data includes SQLite metadata, raw objects, job records, upload sessions, settings, audit records, metrics, and checkpoint state. Public responses use redaction for server absolute paths, local user identity, raw tokens, and private payloads.

File-backed state mutations use a per-key serialized lane. If a task exceeds
the state-mutation deadline, its cooperative signal is aborted and callers
queued behind it fail immediately with `STATE_MUTATION_QUEUE_FENCED`. The lane
remains fenced until the original task settles, so a late write cannot overlap
a retry. Atomic state files are published from private temporary files that are
synchronized before rename; the parent directory is synchronized afterward so
successful replacement is power-loss durable. Unsupported directory sync is
tolerated only for the bounded Windows error set. Checkpoint tree projections serialize their complete
read-modify-write cycle through the Pactium durable write lock; concurrent node,
tree-index, finish, restore, and delete mutations therefore have one canonical
order. Server composition owns one persistent Pactium runtime and closes its
SQLite or selected auto-storage port through an idempotent asynchronous barrier.
Standalone checkpoint calls close the runtime they create on both success and
failure, while an injected Pactium runtime remains caller-owned.
Durable checkpoint and Merkle state commits run only on Pactium SQLite. They
enter one per-data-directory lane and one reentrant compound Pactium
transaction, so projection roots, event records, proof evidence, and receipts
are committed together and are rolled back together on failure. The JSON
backend is not presented as an ACID substitute for these capabilities.

### Operation Proof Persistence

The operation contract selects one proof profile. Write-capable operations use
`full`: an Intent is committed before the side effect and one Outcome is
committed afterward. Read-only operations use one terminal `receipt` unless a
contract opts into `on-change`; that profile accepts only a named,
privacy-reviewed stable digest projection and lets Pactium compare the digest
atomically against the published claim. An unchanged projection or idempotent
replay performs no block or protocol-object writes. `excluded` is limited to
explicitly reasoned health, bootstrap, discovery, or public-catalog surfaces.
Denied and failed operations still produce terminal receipt evidence even when
successful audit persistence is disabled.

Meshrix stores domain-separated request, result, subject, policy, and effect
commitments rather than raw request bodies, responses, policy objects, runtime
URLs, user/session values, filesystem paths, or settings. Pactium ledger and
envelope locators are the authoritative projection; there is no second entry,
intent, or index shadow store. Acceptance and final-plan anchors each append one
receipt fact and are verified by recomputing the expected commitment.

### Governed execution maintenance boundary

This boundary specializes the project-wide [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) policy.

Operation proof is evidence, not authorization. Release acceptance additionally
requires a canonical, short-lived execution permit whose provenance and exact
principal, operation, resource, revision, approval, audience, request, deadline,
and effect bindings are revalidated by the final protected sink. Locks, queues,
approval, retries, recovery, streaming target resolution, and plugin generation
changes fence stale permits before the first protected action.

The proof profile is the mandatory compact lifecycle record. Runtime logging
must not duplicate its request, decision, Intent, Outcome, or result as verbose
per-request events. Routine success and ordinary denial telemetry is aggregated
or sampled and may be shed under pressure. If mandatory Intent cannot be
committed and verified, the runtime denies before the protected boundary. If
Outcome settlement fails after an external effect, the lifecycle remains
`in_doubt` and blind retry is fenced.

This is a maintenance and readiness invariant. A current dispatcher, protocol,
streaming, queue, maintenance, or plugin path that cannot present the same
permit to its final sink remains non-converged and cannot support a readiness
claim.

The queue application port owns durable queue admission, scheduling, state
transitions, recovery, and inspection. The job manager owns job execution and
persisted job metadata; it does not maintain a second queue state, heartbeat
ledger, watchdog recovery path, or inferred queue position. Operations consume
`workQueueObservation`, a bounded read-only projection of the registered job
workflow provider. The projection exposes canonical work item state and timing
fields without owner references, payload references, leases, journals, raw
errors, or storage paths. Its idempotent close barrier rejects new job admission,
preserves active workers for recovery, and waits for tracked execution work
before reporting completion. A failed close attempt keeps admission closed but
releases the failed close promise so the same manager can retry its recovery
barrier after the persistence condition is repaired.
Persisted job metadata is identity-bound to its governed directory. Missing,
unreadable, malformed, or mismatched metadata fails recovery and listing instead
of hiding a job. A malformed active-job payload is retained as a visible failed
job with recovery diagnostics; an unreadable payload fails recovery without
overwriting the original metadata.

## Default Deployment

The default deployment is self-contained and uses repository-owned runtime services plus local storage. Optional middleware integrations require explicit configuration and verifier coverage.

## Upstream Publishing Lifecycle

The server composition binds the authenticated publishing application, dedicated manifest writer, validated observer-to-snapshot transaction, Operation Permission catalog replacement, scoped audience publication, and protocol-delivery session state without absorbing their domain logic. Deployment configuration supplies distinct manifest and mutable runtime-state roots. A control-plane writer publishes canonical manifests; the gateway runtime reads them through a read-only identity. Filesystem events only mark the manifest set dirty. A bounded scheduler validates a complete candidate revision, builds an immutable snapshot away from request handling, and swaps one reference after validation. Shutdown stops admission, observer scheduling, candidate builds, publication events, and protocol-delivery tracking in dependency order.

Operation Permission, tag projection, downstream invalidation, and protocol acknowledgement state each retain their own revision authority. Composition coordinates only server-owned revision state and exposes redacted lag or failure facts; it does not share mutable registries between those owners or depend on a client implementation. An invalid candidate or failed server protocol stage preserves the documented last-known-good or fail-closed state and cannot expose a partial revision. Client adoption remains an independent compatibility fact and cannot block or promote the server runtime receipt.

## Plugin Runtime

The Host plugin artifact authority discovers only immutable installed artifact snapshots. It validates each bounded deterministic inventory against the explicitly configured public Ed25519 keys in `runtime.pluginArtifactTrustedPublicKeys`; an absent or empty trust object trusts no artifact. Production runtime loading never scans `plugins/`, resolves a repository-relative entry, searches package roots, or installs an artifact automatically. A deployment selects verified installed plugins through the explicit array-valued `runtime.enabledPlugins` field. Per-plugin settings are supplied only through the object-valued `runtime.pluginConfigurations` field, and an optional lowercase `runtime.deploymentProfileId` binds the enabled ids, configured ids, exact manifest identities and digests, and deterministic dependency order into one immutable deployment profile. No profile is synthesized when the field is absent. Missing fields remain empty, and a configuration for an unknown or disabled plugin fails before listening. The packaged `server:start` command has no string, CLI, environment, or legacy aliases for those fields. The Compose deployment forwards `MESHRIX_RUNTIME_CONFIG` only as the path of a runtime-config JSON already available inside the container. Manifest metadata, feature flags, and `defaultEnabled` cannot enable a plugin. Invalid ids, duplicates, unknown plugins, missing dependencies, ledger mismatch, and profile drift fail closed. Changing the selection, configuration, trust set, or profile requires a controlled restart.

An executable plugin manifest declares one normalized `.mjs` entry inside its signed artifact. The loader rejects path traversal, symbolic-link entries, unknown manifest fields, missing dependencies, dependency cycles, duplicate claims, mount conflicts, route conflicts, and routes to unavailable mounts. Dependencies activate before dependents. The fixed `activatePlugin` export must return the exact manifest-declared mounts, an exact executable contribution map, and a `close` function. Contribution maps cover operations, routes, MCP tools, console entries, and state machines; omitted or invented ids fail activation. Verifier contracts are manifest data, but executable verifier hooks are assembled by the Host from the verified artifact snapshot and cannot be supplied as plugin functions. Core composition snapshots and recursively freezes contribution declarations once, then exposes read-only maps instead of mutable plugin-owned registries. Startup failure closes registered plugin resources and previously activated plugins in reverse order; normal runtime shutdown uses the same reverse-order lifecycle. A disabled plugin artifact is not imported and contributes no registration.

Each selected plugin receives an opaque `pluginData` capability, not a data-root path. Its bounded file operations validate relative segments, reject symbolic links and boundary escape, restrict created directories and files, and translate filesystem failures into fixed plugin-data error codes. Plugins that need workspace content receive a separate read/write workspace capability with the same path-opacity rule; they never receive the server workspace root. Per-plugin configuration is recursively snapshotted and frozen, while host capabilities are projected through fixed method facades rather than exposing the mutable host context.

### Host capability composition

The mount manager grants Host capabilities only when both the verified signed manifest and explicit runtime configuration authorize them. Missing configuration grants none. The generic Host-owned `ArtifactSignerPort` uses the same intersection for signing purposes and returns only public verification facts, a context-bound signature, and a minimum receipt. Plugin configuration and plugin results never contain signing key material. Owner-scoped capabilities bind the verified artifact digest and numeric generation to the lifecycle ledger and recheck active state on each business admission. Process identity and controlled execution also require a short-lived, request-bound, audience-single-use Host invocation authorization; plugin-supplied identity or governance fields cannot replace its claims.

Opaque payload custody is bounded by record count, total bytes, per-payload bytes, and a fixed TTL. Each record is bound to the exact owner generation, tenant, session, and turn scope, supports digest-checked idempotency, and is cleared when the consuming plugin generation closes. It is temporary custody, not durable plugin state.

Server composition creates Host-owned capabilities before plugin activation. Each port accepts only declared purposes, binds records to an authenticated owner generation and caller-supplied digest, enforces bounded time, record, and byte capacity, and keeps secret material behind Core custody. A Host-injected port remains owned by its injector; otherwise server composition closes the port on startup rollback and normal shutdown.

Controlled execution adapters are created only from explicit Host configuration. Every execution target supplies its own target reference, configured sandbox workload kind, output contract, capability set, and resource limits. The runtime does not infer a target, workload, policy, command, or host executable. Empty or incomplete configuration produces no production adapter and a requesting plugin fails closed. Lifecycle-safe bindings use existing Core process-identity and sandbox owners; they do not add another identity store or execution path.

Selected plugin modules are privileged in-process deployment code, not a sandbox boundary. Signed immutable artifacts and entry-path checks provide provenance, integrity, and declared-loading enforcement; they do not make hostile JavaScript safe. Operators must review, sign, trust, and explicitly select the artifacts they deploy.

The [Execution Sandbox architecture](../architecture/EXECUTION-SANDBOX.md) isolates agent-controlled or otherwise untrusted workloads requested by trusted platform and plugin code; it does not isolate the plugin module itself. A plugin requests governed execution only through the narrow Host port and cannot receive a container socket, virtualization handle, host process API, raw credential, or host path. Empty or unavailable sandbox configuration denies execution, and the runtime has no host-process fallback. Manifest verifier contracts identify only verifier modules within the signed artifact and dedicated `plugin_verifier.*` workload kinds. The Host resolves the module from the verified snapshot, executes it only through the controlled sandbox, and accepts only a terminal receipt bound to the plugin, input digest, successful terminal state, and completed destruction.

The repository builds no product plugin implementation. Core composition consumes only dynamic contributions from verified installed packages selected by explicit deployment configuration; it does not copy plugin operations into the static Core registry or provide a parallel compatibility registration. With an empty plugin selection, no plugin operations, routes, MCP outlets, console entries, state machines, or verifier hooks are active, while generic Core workspace and context operations remain available.

Server bootstrap constructs the Core `agent-workspace-core` provider but never creates product data. An empty workspace store remains empty until an authenticated, authorized `agent_workspaces.create` operation succeeds. This keeps ownership, naming, audit evidence, and lifecycle intent explicit and avoids startup side effects.

External single-plugin bundles use the closed package protocol in [Plugin Package and Loading](../protocols/PLUGIN-PACKAGE-AND-LOADING.md): source-neutral acquisition, payload and archive digests, verified custody, and a fenced lifecycle that stages only verified packages before atomic contribution publication. GitHub Release acquisition resolves one explicit repository, release, and prebuilt asset through the Release API under host, redirect, byte, time, retry, and cancellation budgets; it stops at content-addressed acquired bytes and never clones, builds, configures, stages, or enables a plugin. Offline local-package acquisition imports one explicit file under a configured import root with the same acquired-byte boundary, without network access, symlink following, path disclosure, or enablement side effects. `node tools/server-scripts/verify-plugin-bundle-protocol.mjs` verifies the bundle cut. `npm run verify:plugin-runtime` verifies the installed-artifact manifest/runtime contract, installed-artifact independence, deployment-profile binding, default-off behavior, invalid selections, dependency ordering, removal recovery, rollback, retryable cleanup, path-opaque capabilities, Host-controlled verifier hooks, and packaged-source closure.

## Operation Routing

Each assembled operation array is compiled once into method-specific segment
tries plus constant-time RPC-method and operation-id maps. HTTP matching is
independent of registry size and resolves siblings in static, parameter, then
terminal-wildcard order. Route parameter names remain local to the matched
operation, encoded values are decoded only after a parameter or wildcard path
is selected, and malformed encoding or control characters do not dispatch an
operation. The contribution registry retains one immutable decorated operation
catalog for each active contribution revision and invalidates it on replacement,
rollback, or deactivation. The core provider keys compiled route indexes by
that immutable catalog identity, so repeated HTTP and RPC dispatch does not
redecorate, deep-freeze, or recompile an unchanged catalog. A different
explicit operation array receives a separate identity-bound index even when
its operation ids match, preventing stale route or contract reuse. Parameter
segments are bounded to 1,024 bytes and wildcard tails to
8,192 bytes. Query
fields remain under the operation's declared HTTP query contract and are not
implicitly merged by the route matcher. Duplicate operation ids, HTTP route
shapes, and RPC methods fail index compilation before dispatch.

## Operation Concurrency

`createServerRuntime` owns one operation `LockManager` for its full lifecycle. The self-contained runtime uses the SQLite backend on the runtime storage database. Embedders may inject another conforming manager through `createServerRuntime`, `createServerCompositionRoot`, `startHttpServer`, or `bootstrapServer`; the runtime still destroys the injected manager before closing storage. An explicit operation concurrency scope is stable across processes; otherwise the PostgreSQL manager namespace or the constant `server` scope is used. Local filesystem paths are not part of distributed lock identity.

The executable server does not currently construct a PostgreSQL manager from environment or persisted settings. A distributed deployment therefore requires programmatic manager injection, including its secret-bearing pool configuration. Publication of a declarative PostgreSQL lock-backend configuration remains blocked until a secret-reference contract and live PostgreSQL integration verifier exist.

Registered operations with `concurrencySafe: true` execute without a dispatcher lock. Every other operation acquires a lock for its scoped `concurrencyGroup` before the side-effect boundary. The dispatcher renews the lease while the controller is running, rejects an acquisition or heartbeat failure without exposing backend details, and releases the handle in `finally`.

The Operation Permission `execute`, `batch`, and `dry_run` operations are concurrency-safe orchestration boundaries. They are not projected back into the executable tool catalog. Their selected target operation re-enters the canonical dispatcher and owns the applicable concurrency-group lock; this avoids recursive self-locking and does not serialize unrelated tool groups behind the wrapper route.

Locked controllers receive an `operationLock` context with `lockKey`, `fencingToken`, `acquiredAt`, `expiresAt`, `signal`, and `assertActive()`. A heartbeat or backend-session failure aborts `signal`; controllers that perform multi-step work should call `assertActive()` immediately before each irreversible side effect. The fencing token is opaque and has no generic lexical-order contract. A durable store that requires stale-writer rejection must define its own atomic fencing comparison before accepting writes. The current generic controller and storage layers do not provide that atomic comparison. The dispatcher therefore claims mutual exclusion only while the lease is active; it does not claim exactly-once effects for a controller that ignores lease loss.

Operation Permission and maintenance timeouts abort queued acquisition and wait for the dispatch task to settle before returning an error, so a timed-out waiter cannot execute later. The HTTP request signal is passed through concurrency-safe controllers and merged with the Operation Permission timeout signal for both Operation Permission HTTP and MCP tool entry points. A disconnected request therefore cancels nested acquisition or execution without reporting completion before the nested task settles.

HTTP request admission starts closed. The listener returns `503` until discovery activation and every startup lifecycle task complete, then the composition root opens admission once before returning the server handle. Shutdown permanently seals admission, drains requests, then aborts remaining operation signals and waits again. If an active task or task-owner close barrier still cannot settle, shutdown fails with the runtime lock and storage dependencies left open for a retry instead of closing them underneath running work. The maintenance worker accepts the same injected lock manager through the background-worker registry, waits for its active run before closing the Operation Permission store, and closes job, runtime, and event-bus dependencies only after task owners settle. Runtime, composition, maintenance-worker, and listen failures unwind initialized resources in reverse dependency order. SQLite-backed constructor failures close any database handle opened before schema or prepared-statement initialization failed.

Startup event publication reads its five fixed platform projections through the
Core-owned Startup Snapshot port. The port exposes named read methods only; it
does not accept an operation identifier, actor, alternate registry, or generic
internal dispatch request. Non-public operation dispatch without an explicit
authorization path remains denied.

## Verification

```bash
npm run typecheck
npm run verify:plugin-bundle-protocol
npm run verify:plugin-runtime
npm test -- --suite runtime.operation-routing
node tests/run.mjs --suite runtime.operation-dispatch-lock
npm run server:verify:architecture-graph
npm test -- --suite domains.manifest
npm test
npm run server:doctor
```
