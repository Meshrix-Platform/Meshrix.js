# Execution Sandbox Architecture

## Current Status

This document defines the platform boundary for executing agent-controlled or otherwise untrusted workloads. The core runtime provides a closed request contract, default-deny policy compiler, one product-facing `SandboxExecutionPort`, a bounded canonical queue, a durable broker, narrow plugin host ports, deterministic trusted-provider resolution, and truthful public availability projection. The resolver accepts only core-injected fixed-location Podman and Docker adapters, refreshes provider facts before admission, selects only a candidate with a current trusted conformance receipt, and invalidates selection after generation or cleanup uncertainty. Persisted user configuration cannot provide provider executable paths, sockets, probe commands, or backend definitions. The hardened OCI backend, operator-controlled conformance receipt provisioning and revocation, quarantined output validation, restart recovery, and authenticated opaque-envelope custody are implemented.

An absent sandbox configuration remains absent. Its effective runtime state is non-executable and its public projection is `sandboxAvailable: false`. Provider resolution records observed capability separately and does not synthesize a user provider mode, allowed provider class, selection, image, policy profile, network grant, filesystem grant, or compatibility fallback. A trusted receipt is stored only after the operator runs the real OCI conformance verifier for the exact provider, runtime profile, policy revision, and required sandbox receipt; failed verification revokes the candidate receipt. Plugin package custody uses the Core opaque-custody boundary, while workspace file-safety evidence remains distinct from execution-isolation evidence.

The contract verifier combines admission, lifecycle, opaque-custody,
launcher-boundary, and trusted OCI simulation facts. Current functional
convergence is accepted only when `controlled-execution-sandbox` owns all four
leaf reports and the `controlled-execution-convergence-final` reducer accepts
their matching source provenance plus the exact canonical release candidate. That
reducer emits only `controlledExecutionConvergenceReady`. External-provider
environment qualification remains remaining required work on the named
Real-Machine Verification Workflow.

## Scope And Trust Boundary

A governed executable workload is runtime work in which non-platform input can select or influence interpreted, compiled, spawned, or loaded code. This includes:

- plugin-provided executable artifacts and package hooks;
- agent-generated commands, scripts, programs, and delegated CLI tasks;
- plugin-requested child processes and executable adapters;
- scanners, renderers, converters, or build steps that process untrusted content through executable tooling;
- scheduled, queued, MCP, HTTP, console, or maintenance requests that reach any of those paths.

Every governed executable workload must enter through the execution-sandbox port. A typed in-process operation that does not evaluate, load, or launch caller-controlled content remains an ordinary platform operation governed by the existing dispatcher and Operation Permission. If that operation later launches a governed executable workload, the launch is inside this boundary.

Developer test commands and release tooling that are not reachable from a product runtime operation are outside this product boundary. They must not be exposed indirectly as runtime tools.

Selected plugin modules remain privileged, reviewed deployment code loaded in the server process. The execution sandbox isolates workloads requested by those modules. Process-isolated plugin confinement remains remaining GATE work so a hostile `activatePlugin` implementation cannot penetrate Core. Until that confinement lands, an untrusted plugin implementation must not be loaded by the privileged in-process plugin runtime.

## Architectural Invariants

1. **Execution is disabled by absence.** Empty configuration, missing configuration, and an explicit disabled state all deny before execution-input staging or backend creation. Storage-only opaque custody is a separate operation and does not authorize execution.
2. **Enablement is not authorization.** Platform enablement only makes admission possible. Every run still requires current identity, Operation Permission, risk, approval, resource, artifact, and capability decisions.
3. **Authorization is not isolation.** Operation Permission decides whether a run may be attempted and which capabilities may be requested. The sandbox backend and brokers enforce what the workload can actually access.
4. **No host fallback exists.** Backend absence, health failure, unsupported policy, incomplete cleanup, or policy-compilation failure denies the run. The runtime never falls back to `child_process`, a shell, or an unrestricted local process.
5. **Caller content is data.** Caller input never becomes a shell command string, executable path, image path, environment-variable name, mount path, policy expression, or secret value.
6. **Artifacts are immutable.** Admission binds one verified content digest and one declared entry point. Mutable tags, package names, or current-directory lookups are not execution identities.
7. **Capabilities are intersected.** Effective authority is the intersection of artifact declarations, publication review, platform policy, tenant and workspace policy, the current grant, approval, and the per-run budget.
8. **Inputs are staged and outputs are quarantined.** Untrusted code never receives a writable live workspace mount. Runtime success is reported as `output_quarantined`, not operation success. Output cannot become platform state until host-side validation and the owning transaction commits it.
9. **Isolation is per trust domain.** A sandbox instance, writable layer, process tree, credential, cache, and temporary output are not reused across tenants or workspaces.
10. **Cleanup is part of completion.** A run is not complete while its process tree, virtual machine, writable layer, network lease, or short-lived credential remains active.

## Ownership

The core platform owns the execution boundary:

```text
Plugin immutable artifact -------+
                                 +--> Admission and policy compiler
Workspace immutable snapshot ----+              |
                                                v
                                      Sandbox execution broker
                                      /          |          \
                               WASI backend  OCI backend  microVM backend
                                      \          |          /
                                                v
                                      Quarantined output
                                                |
                                                v
                            Owning operation preview, approval, and commit
```

- `packages/foundation/` owns the backend-neutral request, capability, denial, receipt, and provider-port contracts.
- `packages/server-runtime/` owns composition, backend registration, health, admission closure, cancellation, and shutdown ordering.
- Operation Permission and Security Authorization own identity, grants, risk, approvals, secret references, and revocation decisions.
- Storage and workspace owners create immutable inputs and commit accepted outputs.
- Plugins receive only a narrow sandbox host port. They do not receive backend handles, container sockets, virtualization devices, host process APIs, raw credentials, or host paths.
- Observability owns redacted health, audit, metric, trace, and resource projections; it does not own execution policy.

## Default-Deny Admission

The persisted user configuration is optional and has no code-supplied value. When it is empty, runtime status reports the sandbox as unconfigured and execution remains denied. A deployment that intends to execute workloads must explicitly enable the sandbox and configure its governing policy. Backend discovery and selection may then resolve a production-conforming local provider, but observed capability remains separate from persisted user configuration and never supplies an image, grant, or policy default.

Admission requires all of the following facts to agree:

- explicit platform enablement;
- a healthy production-conforming provider selected through the trusted resolver or explicitly bound by stable deployment configuration;
- an immutable workload digest and a closed manifest;
- an authenticated subject and resolved tenant or workspace;
- a current Operation Permission grant and any required approval bound to the exact authorization context, source, request, policy revision, expiry, and one-time audience;
- a complete capability request that can be narrowed into an enforceable backend policy;
- explicit input objects, an isolated output destination, a deadline, and finite resource budgets;
- an idempotency key and audit correlation reference.

Missing, malformed, stale, revoked, unsupported, or contradictory facts produce a fixed denial before execution input is copied or a backend is started. Publishing, reviewing, downloading, installing, adopting, enabling a plugin, or granting one permission cannot by itself enable execution. A storage-only upload may still enter opaque custody without becoming an execution input.

## Execution Contract

The execution request is a closed, evolvable contract whose compatibility rules do not weaken current policy. Its semantic fields include:

| Field | Required meaning |
| --- | --- |
| Principal | Authenticated actor, tenant, workspace, and originating operation references. |
| Artifact | Immutable digest, content type, declared runtime kind, and platform-validated entry point. |
| Invocation | Structured argument values and an optional logical working directory inside the sandbox. |
| Inputs | Opaque snapshot or object handles with explicit read rights; never host absolute paths. |
| Outputs | One isolated staging handle, output schema, count and byte limits, and allowed file types. |
| Capabilities | Filesystem, network, tool, secret-reference, clock, randomness, and subprocess rights. |
| Resources | Wall time, CPU, memory, process, file-descriptor, disk, inode, log, network, and host-call budgets. |
| Governance | Grant, approval, risk decision, policy digest, idempotency key, and cancellation reference. |

The contract does not accept raw shell strings, unrestricted environment maps, caller-selected host executables, arbitrary container images, kernel paths, device paths, host IPC handles, or plaintext secrets. Structured arguments are schema-validated and passed without shell expansion. A backend may support fewer capabilities than the contract describes; it may not weaken or omit a requested restriction.

## Isolation Requirements

### Filesystem

- Start with no host filesystem visibility.
- Materialize verified inputs into a run-specific read-only layer.
- Provide separate bounded scratch and output layers.
- Reject traversal, symbolic-link and hard-link escape, special files, devices, sockets, unsafe ownership or modes, archive expansion overflow, and executable output unless the closed policy explicitly permits that output type.
- Never mount live workspace paths as writable sandbox paths.
- Resolve all platform objects by opaque handles and revalidate identity and revision immediately before host-side commit.

### Process And Runtime

- Run as a non-privileged identity with no inherited host capabilities, session, user profile, terminal, or process namespace.
- Deny host PID, IPC, device, virtualization, container-control, and service-manager access.
- Bound subprocess creation explicitly. A missing subprocess capability means no child process.
- The current hardened OCI adapter accepts only its governed Node runtime profile. It starts Node with the stable permission model, omits child-process, worker, native-addon, WASI, FFI, inspector, and network grants, and combines those runtime denials with OCI namespaces, dropped capabilities, the default seccomp profile, cgroup limits, and read-only mounts. A non-Node command or non-zero subprocess request is unsupported and fails before container creation; the adapter does not approximate a positive subprocess count with a PID limit.
- Kill and reap the complete process tree or virtual-machine instance on success, failure, timeout, cancellation, broker loss, or shutdown.
- Do not acknowledge completion while background work remains possible.

### Network

- Provide no network interface, DNS, or raw socket by default.
- Route an explicitly granted outbound request through a sandbox-external egress broker.
- Bind grants to protocol, method, destination, port, path policy, redirects, request and response bytes, connection count, and deadline where applicable.
- Revalidate resolved addresses and redirects; block loopback, link-local, host, private control-plane, and deployment metadata destinations unless a narrower platform-owned integration explicitly requires and verifies them.
- Environment proxy variables are not an enforcement boundary. Backend-level network isolation must prevent bypass by direct sockets.

### Secrets And Tools

- Keep credentials behind opaque secret references and outside artifacts, environment dumps, writable layers, snapshots, logs, and receipts.
- Prefer a host-side broker that performs the authorized remote or tool action without revealing the credential to the workload.
- If a workload must receive a credential, issue a run-bound, short-lived, minimum-scope value and revoke it during cleanup.
- Route platform tools through Operation Permission again at use time. A sandbox grant does not bypass current tool authorization or revocation.

### Resource And Availability Controls

- Enforce finite CPU, memory, wall-time, process, file-descriptor, disk, inode, file-count, output, log, network, and tool-call budgets outside the workload.
- Use backend-native hard limits and a supervisor capable of terminating non-cooperative work.
- Treat cooperative cancellation as a notification, not the enforcement mechanism.
- Quarantine a worker after incomplete cleanup or isolation-health loss; do not admit another trust domain to it.

### Output

- Stop the workload before inspecting output and destroy its ability to mutate the staging area.
- Validate count, size, digest, type, path, links, modes, ownership, archive shape, and the declared output schema.
- Treat output as a proposal. The owning operation performs conflict checks, approval, checkpoint or preimage capture, atomic commit, compensation, and receipt publication.
- A failed validation, approval, commit, or compensation step exposes no partial result as current platform state.

## Lifecycle And Receipts

Admission, runtime, and output are separate state dimensions:

```text
admission: requested -> denied | admitted
runtime:   admitted -> provisioning -> running
           running -> succeeded | failed | timed_out | cancelled
           terminal runtime state -> destroying -> destroyed
output:    none | quarantined -> committed | rejected
```

Only the canonical queue may schedule a product run, and only an admitted run may provision a backend. The broker persists provisioning before input staging, persists bounded lifecycle receipts atomically, and reconciles interrupted provisioning, running, disposition, and quarantined-output state during restart. Output remains quarantined until the runtime is terminal and can no longer mutate it. Every admitted run must reach a durable destroyed or cleanup-failed fact. Cleanup failure prevents worker reuse and prevents a successful execution receipt.

The final receipt records controlled identifiers and digests for the actor, workspace, artifact, policy, grant, approval, backend, inputs, outputs, start and finish times, terminal reason, denied capability attempts, bounded resource totals, cleanup result, and owning operation result. It contains fixed reason codes and redacted summaries, never raw prompts, file content, stdout or stderr beyond the bounded redacted policy, local paths, addresses, or credentials.

## Backend Portability And Selection

The core contract supports replaceable backend classes and one deterministic resolver:

- a WASI-capable backend for capability-oriented portable components;
- a hardened OCI backend for the explicitly governed Node runtime profile, with other language runtimes requiring their own conforming adapter and receipt;
- a microVM backend for hostile native workloads and stronger tenant isolation.

Discovery evaluates only core-trusted adapters and fixed installation or service locations. It does not accept caller-controlled executable paths, sockets, endpoints, probe commands, images, or provider identifiers. The stable preference is Podman, Docker, then explicitly registered container or virtual-machine providers; rootless operation is preferred within each provider class. A candidate is selectable only when its health and current conformance receipt prove that it can enforce the complete effective policy. A higher-ranked non-conforming candidate is skipped rather than weakening a restriction.

The resolver caches only bounded redacted capability facts and invalidates selection when provider identity, service identity, health, policy revision, or conformance receipt changes. The public projection exposes only `sandboxAvailable`; it is true only for the ready state. An administrative projection may expose a redacted state, provider class, isolation class, enforceable capabilities, policy revision, and receipt reference, but never host paths, sockets, addresses, raw probe output, or machine identity.

External runtimes remain deployment integrations rather than execution
fallbacks. An unrestricted local-process adapter may exist only for explicitly
trusted development diagnostics; it is not a conforming production sandbox,
is never selected for governed execution, and cannot satisfy the sandbox
Functional Release Gate criteria.

## Opaque Custody When Execution Is Unavailable

When `sandboxAvailable` is false, an executable artifact may be accepted only through the core storage-only custody contract. Ingestion performs no archive expansion, parsing, scanning, executable review, build, publication as executable, or execution. It streams bytes into a closed authenticated envelope with bounded encrypted chunks, original-content and envelope digests, byte and chunk counts, media-type metadata, and an opaque custody-key reference. Plaintext is not persisted, caller-controlled filenames and executable modes are not storage identities, and plugins or ordinary storage code receive neither a decryption key nor a plaintext path.

Server-side envelope encryption prevents stored representation from being directly runnable and separates decryption from ordinary request handling. A fully trusted server administrator can currently recover plaintext. Cryptographic inability of the server to recover plaintext remains remaining required work for deployments that need it; those deployments must use a client-held key or an independently controlled key broker until that work lands. Base64, archive wrapping, compression, filename changes, executable-bit removal, `noexec`, and reversible obfuscation are not security boundaries.

Opaque artifacts support governed status, encrypted-envelope download, retention, and deletion only. The registered custody port does not expose plaintext promotion. A closure-private promotion authority is held only by the sandbox broker, after current provider resolution and admission; plugins and ordinary platform consumers cannot present a self-authored provider receipt to obtain plaintext. Provider recovery causes no scan, publication, or execution. Promotion is a new explicit request: current admission binds the exact envelope and content digests, authorization, approval, policy, and ready sandbox receipt before the custody broker streams plaintext directly into run-specific read-only input. A failed promotion leaves the original envelope unchanged and non-executable.

## Consumer Integration Boundaries

### Plugin Packages

Plugin storage remains no-run custody. Package validation, installation, permission grant, and contribution publication do not execute an untrusted artifact. With a ready sandbox, direct upload still enters content-addressed immutable custody rather than an executable location. Without a ready sandbox, executable artifacts use only the opaque-custody contract and cannot be parsed, scanned, built, reviewed, or promoted automatically. A run resolves one immutable verified revision, revalidates current status and permission state, and submits it to the Core sandbox as a new governed transaction. Scanning or building a bundle with executable tooling is itself a sandboxed workload.

### Workspace Assets

Core workspace Host capabilities supply an immutable, authorized snapshot rather than a host path. Sandbox-bound artifacts received without a ready provider use opaque custody and are not parsed, transformed, mounted as plaintext, or promoted automatically. Ordinary non-executable collaboration remains governed by the workspace contract. An admitted workload receives read-only inputs and writes only to run-specific staging. Returned changes pass through mutation preview, approval, preimage, checkpoint, compensation, rollback, and receipt publication. Workspace file-boundary verification is not evidence of opaque custody or process, network, and resource isolation.

### Agent And Maintenance Execution

Maintenance automation, delegated CLI work, scanners, plugin adapters, and any
other runtime child-process path must use the same port before the functional
release can claim complete execution isolation. A second plugin-local launcher,
compatibility shell, or direct host-process path is a bypass and fails the
Functional Release Gate.

## Failure Semantics

- Backend unavailable, unhealthy, or disconnected: deny or terminate; never run locally.
- Policy cannot be compiled without loss: deny.
- Grant, approval, artifact, workspace, or input revision changes before start: deny and discard staging.
- Authorization is revoked during a run: cancel, terminate, quarantine output, and revoke run credentials.
- Deadline, resource limit, or output limit exceeded: terminate the complete workload and reject output.
- Receipt persistence fails: do not report success or commit output.
- Cleanup cannot be proved: quarantine the worker and report cleanup failure.
- Platform shutdown: close admission first, terminate or drain admitted runs within policy, destroy isolation state, then close dependent stores and brokers.

## Required Verification

Functional acceptance requires catalog-owned tests and redacted reports that
prove the product path, including:

- empty configuration and explicit disabled-state denial with zero backend side effects;
- trusted Podman, Docker, and registered-provider discovery, deterministic conforming selection, stale-cache invalidation, truthful `sandboxAvailable`, and redacted administrative status;
- unavailable-provider authenticated envelope creation, chunk tamper and replay denial, no-plaintext persistence, custody-key separation, storage-only operations, and explicit digest-bound promotion without automatic execution;
- rejection of encoding, archive wrapping, compression, executable-bit removal, `noexec`, or reversible obfuscation as substitute isolation;
- no fallback when the selected backend is missing, unhealthy, or unable to enforce one restriction;
- grant, approval, risk, artifact-digest, revision, and revocation enforcement on every run;
- traversal, symbolic-link, hard-link, special-file, host-directory, process, device, and container-control denial;
- raw socket, DNS rebinding, redirect, private-address, metadata-address, and network-byte-limit denial;
- secret, environment, credential, log, receipt, and output redaction;
- CPU, memory, process, file-descriptor, disk, inode, file-count, output, log, deadline, and tool-call exhaustion;
- non-cooperative process termination, cancellation, background-process cleanup, and broker-loss cleanup;
- cross-tenant filesystem, process, credential, cache, snapshot, and worker-reuse isolation;
- output quarantine, validation, conflict detection, approval, atomic commit, compensation, and rollback;
- physical removal or disablement of each optional backend and each consuming plugin without exposing a bypass;
- a source audit showing that every product runtime launcher for governed executable workloads enters through the core port.

Run `npm run verify:controlled-execution-sandbox` for the contract, lifecycle,
custody, launcher-boundary, and trusted-backend leaf checks. Then run
`npm run verify:controlled-execution-convergence` to reduce the exact current
leaf-report set for one clean release candidate. These development-environment checks contribute to
the Functional Release Gate. Environment qualification for each optional
plugin or provider remains remaining required work; a passing Core report is
not that receipt. Each remaining Real-Machine Verification Workflow validates
its own exact integration receipt without changing functional acceptance.
