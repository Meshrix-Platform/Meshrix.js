# Runbook

This runbook covers local startup, container startup, verification, and operational checks for the open platform repository.

## Required Runtime

- Node.js version range from `package.json`.
- npm.
- Container tooling only when running the container path.

The default runtime is self-contained. Optional middleware integrations are enabled explicitly for deployment-specific extensions.

## Local Startup

```bash
npm install
npm run dev
```

Default local server URL:

```text
http://127.0.0.1:7228
```

Non-development server startup:

```bash
npm run server:start
```

Automation that requests a dynamic port must use the private readiness file
instead of parsing stdout:

```bash
node tools/server-scripts/start-server.mjs --port 0 --ready-file <private-ready-file>
```

The file is atomically created with mode `0600`, contains the selected local
connection state, and is removed during shutdown. Treat it as private runtime
IPC and do not publish it as verification evidence.

## Container Startup

The source checkout Compose file builds the API-only `runtime` target for local
deployment verification:

```bash
docker compose up -d
```

For a local deployment that also serves the Web Console, select the UI image
target explicitly:

```bash
LICO_BUILD_TARGET=runtime-ui LICO_SERVER_WITH_UI=1 docker compose up -d --build
```

Create the reproducible server source archive and its SHA-256 checksum with:

```bash
npm run release:package-server-source
```

The command writes to `build/packages`. This is a source package: it excludes
installed dependencies and container images, so a target host still needs
network access while building the container image.

Set `LICO_HOST_PORT` to change the loopback host port. The Compose contract uses
that same value for bootstrap, advertised, and active service URLs while the
container continues to listen on port `7228`. The host publish address remains
`127.0.0.1` by default. An isolated VM may set `LICO_BIND_ADDRESS=0.0.0.0` and
`LICO_ADVERTISED_HOST` to its VM-local DNS name when host access is required;
do not use a non-loopback bind on an untrusted network. Its 90-second stop grace period
covers the runtime's two-phase request drain and cancellation budget. Compose
also reports container health from the loopback `/api/healthz` endpoint.

The published release image uses the `runtime-ui` target and serves both the
server and Web Console. Start that immutable image directly so the local
Compose build definition cannot silently replace it:

```bash
docker pull ghcr.io/licoland/licomesh:<version>
docker volume create licomesh-server-data
docker run -d \
  --name licomesh-server \
  --restart unless-stopped \
  --stop-timeout 90 \
  --publish 127.0.0.1:7228:7228 \
  --mount source=licomesh-server-data,target=<container-data-dir> \
  ghcr.io/licoland/licomesh:<version>
```

Before an unreliable-network deployment window, prepare the npm artifact cache:

```bash
npm run server:prepare:npm-cache
```

Container verification builds the Docker image with BuildKit dependency caches, starts compose, serves the real container, verifies MCP initialize, tools/list, `lico.capabilities.list`, `system.health`, destructive rejection, and cleanup:

```bash
npm run server:verify:deployment-flow
```

## Routine Verification

Use the narrowest check that covers the change. For repository-level readiness, run:

```bash
npm run typecheck
npm run verify:version-registry
npm test -- --suite domains.manifest
npm test
```

For broader validation:

```bash
npm test
npm run build
```

For a source split, package extraction, ownership move, protocol separation,
or feature-surface reassembly, use the externally maintained
`$lico-feature-reassembly` workflow. This repository supplies architecture and
verification facts; it does not own or duplicate the maintenance skill,
contract template, examples, or helper scripts.

Inspect both catalog-backed closures before execution:

```bash
lico-dev workflow plan changed --changed-from <ref>
lico-dev workflow plan reassembly
```

The reassembly profile covers the Core typecheck and build, public regression
gate, capability surface convergence, and canonical acceptance-plan contract.
It does not execute the final acceptance reducer or establish client or plugin
compatibility.

## Priority Zero Resource Verification

Run the repository's highest-priority resource gate after any change to a
long-lived request path, logger, metric, audit trail, event stream, queue, cache,
listener, persistence routine, or scheduler:

```bash
npm run server:verify:resource-discipline
```

The command first rejects new unbounded append paths and missing retention
contracts. It then starts the complete default service in an isolated temporary
data directory, warms it, applies repeated concurrent requests, and performs
forced garbage collection between measurement rounds. Retained heap growth is
evaluated with a robust multi-round slope instead of a single RSS comparison,
while `@datadog/pprof` independently samples live V8 allocations in standard
pprof format.

The installed profiler package, compiled binding, and dependency-manager
artifact cache are reusable local tool state and are intentionally preserved
between runs. They are never used to hold profiles or service data and are not
targets of gate cleanup.

Only a compact, redacted, atomically replaced result is written under
`build/reports/`. Raw heap profiles, readiness state, service data, and load
responses remain private temporary data and are removed when the command ends.
Any policy, persistence-growth, log-growth, heap-growth, allocation-growth, or
request-integrity violation returns a non-zero exit code and blocks the Core
gate.

### Governed evidence capacity review

This review operationalizes [Governed Execution And Minimum
Evidence](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md).

For every changed protected-resource or side-effect path, maintainers must
classify retained data before release:

1. Keep every required governance lifecycle proof in its compact fixed schema.
2. Aggregate routine success, ordinary denial, retry, health, latency, and
   capacity facts by finite time buckets.
3. Keep debug logs, traces, and profiles sampled, byte-bounded, time-bounded,
   local, and auto-expiring.
4. Prove that a mandatory proof-store failure denies before the protected
   action, while optional telemetry pressure sheds data without blocking the
   owning transaction.
5. Measure record amplification and retention convergence with representative
   volume; do not estimate capacity from JSON payload size alone.

Size the mandatory evidence store from peak protected operations per second,
the explicit retention objective, measured p99 on-disk amplification including
indexes, and a documented safety factor. Reaching the optional telemetry budget
drops telemetry and increments one bounded loss counter. Reaching mandatory
unexpired-proof capacity must not trigger silent eviction; the affected
protected operations apply backpressure or fail closed until governed archival,
pruning, or capacity repair succeeds.

A quick gate should exercise at least 100,000 synthetic lifecycle events. Final
storage characterization should exercise at least 1,000,000 events, crash
points around Intent/effect/Outcome, store-full and read-only failure, privacy
injection, and a complete retention cycle. Until a catalog-backed verifier
proves that matrix for the selected storage engine, record the scope as
non-converged rather than compensating with additional logs.

## Release Publication

`.github/workflows/release.yml` is the sole publication path. It runs only for
semantic version tags, serializes all release runs globally, and fails unless
the tagged commit is verifiably contained in the canonical `release` branch.
The workflow runs the canonical acceptance authority before any publication.

LicoMesh `0.0.1` has an exact registry dependency on `pactium@0.5.0`. Publish
that Pactium version first and confirm registry visibility before creating the
LicoMesh tag:

```bash
npm view pactium@0.5.0 version --registry=https://registry.npmjs.org/
```

The LicoMesh clean-install and container gates intentionally fail while that
version is absent. This is a publication ordering requirement, not a LicoArc or
non-current-platform support blocker.

The workflow stages a multi-platform container and compares the intended OCI
manifest digest with the GHCR version tag before and after creating that tag.
An existing equal digest is idempotent; an existing different digest fails
without replacing the version tag. Before any candidate image is pushed, the
workflow requires a clean packed-package install and headless start on Node.js
22, executes the final `macos-arm64` MCP archive with its bundled runtime on a
macOS arm64 runner, and performs a read-only registry preflight for every npm
release-set package. The assembly jobs remain credential-free.

The commit-pinned Trivy action uses the pinned Trivy `v0.69.3` binary to scan
both `linux/amd64` and `linux/arm64` operating-system and library packages. It
rejects actionable `HIGH` or `CRITICAL` findings before the image authority is
signed. The image authority also requires exact platform manifest and
attestation-subject digest bindings, SLSA provenance schema and build semantics,
exact repository/ref/commit build arguments, and a non-empty SPDX document for
each platform. The signing job refetches the registry evidence and accepts it
only when all validated evidence hashes remain identical. GitHub Release assets are covered by
`RELEASE_SHA256SUMS`; its entries use the final flattened asset basenames. The
workflow signs that checksum file with Sigstore and verifies the exact workflow
identity and GitHub Actions issuer before publication. Release consumers must
verify `RELEASE_SHA256SUMS.sigstore.json` before using the checksum file.
On a complete workflow rerun, finalized remote Sigstore assets are reused only
when the release metadata, exact asset set, GitHub digests, and every
deterministic source asset match the current tagged inputs. A mismatch on an
already published release fails closed; an incomplete private draft may be
regenerated and replaced before publication.

The credential-free npm preflight packs the complete public release set and
checks every immutable version and dist-tag before the workflow receives GHCR
write authority. After canonical acceptance and signed asset finalization, the
trusted-publishing job repeats the same all-package preflight immediately before
its first npm mutation. The checks cover immutable SHA-512 integrity, npm
registry signatures, SLSA provenance attestations, and monotonic `latest` or
`next` state. A missing or older tag on an existing version fails closed because
GitHub OIDC trusted publishing cannot repair dist-tags; a newer tag is preserved.
Missing versions are then published by dependency topology with the root
`licomesh` package last, and every registry postcondition is reverified.
The published set is then installed without lifecycle scripts and checked with
`npm audit signatures`, which cryptographically verifies registry signatures
and provenance attestations. The GitHub Release becomes public only after this
npm closure succeeds.
Publication uses npm trusted publishing with GitHub OIDC and does not accept a
raw npm token. The local release-set check is offline and does not contact or
mutate the registry:

```bash
npm run release:publish-npm -- --dry-run
```

The read-only registry preflight contacts the public registry but does not use
publication credentials and cannot publish:

```bash
npm run release:publish-npm -- --preflight
```

The built-in project release runbook prepares and validates a candidate only.
It does not commit, tag, push, upload assets, publish packages, or create a
parallel release path.

For final release-readiness validation, run the platform acceptance authority:

```bash
npm run verify:acceptance
```

### Upstream Service Publishing Readiness

Run the canonical production-path publishing verifier before platform acceptance:

```bash
npm run verify:upstream-service-publishing
```

The command writes `build/reports/upstream-service-publishing.json`. Its reducer recomputes authenticated mutation, durable publication, immutable runtime snapshot, Operation Permission revision agreement, scoped audience projection, catalog invalidation, acknowledgement, disconnect, timeout, reconnect fencing, and governed loopback forwarding. The verifier uses protocol-owned schemas and a neutral peer; it does not discover or run a client repository, implementation, build, plan, test, report, or receipt. Only the platform acceptance reducer may promote the accepted server report to release readiness.

For a non-authoritative diagnostic that records currently open platform gaps without
publishing a release-ready claim, run:

```bash
npm run platform:audit:report
```

The acceptance state machine owns the command DAG and final aggregate report. Its foundation task runs the core public test profile once; that profile is the sole owner of public-boundary, secret-hygiene, local-info, registry, root-hygiene, and script-registry child reports. The remaining server layers refresh plugin-package admission and runtime evidence, protocol-only upstream fixture transit, neutral downstream peer conformance, gateway platform profiling, surface convergence, private-deployment aggregate E2E, and gap audit. External plugin-product evidence remains independently owned outside the Core acceptance DAG. Capability checkpoints cite canonical `acceptanceCommandId` values instead of copied shell commands. After the DAG finishes, the platform reducer requires every checked Core criterion's command to have passed in that same run and every cited Core report to be command-owned, fresh, schema-valid, leak-scanned, and ready. External product evidence cannot block or promote a Core receipt. Verifier-health failures, Core-actionable blockers, unknown or unexecuted commands, unowned reports, and inconsistent capability reports remain platform failures.

Final readiness is reduced through `tools/server-scripts/lib/release-evidence-readiness.mjs`. Full acceptance executes in an isolated workspace inside a fresh Linux container with a stable discoverable cgroup CPU quota. It publishes an immutable evidence generation only after every required child report, aggregate reduction, privacy check, and proof anchor succeeds. `build/acceptance-evidence/current.json` is the atomic pointer to the accepted generation; failed or interrupted runs leave the preceding generation intact. Child readiness fields are input evidence. Exit code `0` means the selected Core release scope is accepted. Exit code `2` means a Core-required but structurally valid evidence dependency remains blocked; optional current-host or external-product support gaps do not produce this exit code. All other non-zero results mean failed. Only a command explicitly registered with blocked exit code `2` may produce that state, and its fresh report must independently reduce to `blocked`. Use `npm run verify:acceptance:plan` to inspect the sanitized DAG, report ownership, blocker protocol, worst-case schedule, and job budget without creating a workspace or changing the generation pointer. To refresh the capability evidence report directly, run:

```bash
npm run verify:capability-acceptance-machines
```

The capability report stops at local `verified`, `blocked`, or `failed` evidence states. Local implementation gaps are always `failed`; only canonical external-evidence blockers can be `blocked`. Owner decisions are recorded for maintainers but cannot produce a machine-level blocked result until a source-controlled decision authority contract exists. The capability report never declares project-level release readiness.

For gateway load validation, use the combined gateway profile:

```bash
npm run server:stress:gateway-platform
```

The profile writes redacted reports under `build/reports/` and covers downstream MCP, upstream forwarding checks, and self-contained upstream fixture transit readiness. It returns non-zero when any required evidence report is not release-ready. CPU, RSS, duration, concurrency, and request-rate limits are controlled by the stress runner options or environment defaults; the runner records a controlled cutoff instead of continuing after the configured CPU or RSS threshold is reached.

## Runtime Utilities

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

## Storage Backup Restore Production Drill

Storage production recovery evidence comes from a host-level operator drill rather than a document-only statement. The drill exercises the registered `storage.backups.list`, `storage.backups.create`, `storage.backups.retention`, `storage.backups.restore_preview`, and `storage.backups.restore` operation path against the selected private-deployment storage backend. It verifies authorization denial with zero storage side effects, confirmation denial before restore execution, retention approval, the confirmed restore, proof and audit lifecycle completion, and storage-kernel reopen. The verifier writes only a redacted fact report; the parent evidence reducer determines readiness.

Backup creation identifies SQLite from the file path rather than the capability
artifact category. Every `.sqlite`, `.sqlite3`, and `.db` file, including
nested authentication databases and `pactium.sqlite`, uses SQLite online backup.
Regular files are copied into an unpublished snapshot tree only while
their source identity and metadata remain stable, and the copied destination is
verified against its actual size and SHA-256. The manifest is written after all
files pass verification and the complete snapshot is published with an atomic
directory rename. File contents, the staged directory tree, and the final
backup-root directory entry are synchronized in that order before success is
reported. A changed source or file set fails the operation without
publishing a partial backup. Governed symbolic links, FIFOs, sockets, devices,
and other non-regular filesystem artifacts are not backup inputs. Their
presence fails the operation without following or deleting the artifact.

Restore preview verifies the manifest metadata and the size and SHA-256 of every
selected backup file. A restore without `includePaths` is a replacement of all
governed mutable files: files created after the backup are quarantined with the
prior generation and removed when the restore commits. A restore with
`includePaths` is an overlay and does not delete unselected or post-backup
files. Any non-array `includePaths` value is rejected before planning and never
expands into a replacement restore. A confirmed restore requires the server runtime and all storage
resources for that data directory to be stopped. An online attempt returns HTTP
`409` with reason code `storage_restore_runtime_active`; do not remove the
runtime lease while the process is active. After the offline boundary is
established, restore uses isolated staging and rollback storage. It revalidates
targets before commit, atomically replaces individual files, removes stale
SQLite sidecars within the same rollback boundary, and verifies the installed
bytes and database integrity. Persistent standalone Pactium runtimes share the
same lifecycle lease as the server storage kernel, including across multiple
runtime instances in one process. The final runtime owner releases the lease;
a runtime in any process keeps confirmed restore unavailable. A full
replacement restore also fails closed if governed storage contains a symlink,
FIFO, socket, device, or other non-regular artifact absent from the backup.

Before the first governed target rename, restore publishes a private durable
transaction journal and a staged receipt. The journal records whether recovery
must roll back or may finalize the committed generation. Runtime startup
reconciles every journal after acquiring the runtime lease and before creating
or opening ordinary storage. A process termination below the durable commit
point restores the entire pre-restore generation; a termination above it keeps
the verified restored generation and completes receipt publication. If either
generation cannot be verified against the journal, startup fails closed and
preserves the transaction directory for controlled recovery.
Moving a pre-restore file into rollback storage synchronizes the rollback name
before synchronizing deletion of the source name. Newly created directory
entries are synchronized along the complete storage-root-to-leaf chain before
either rollback or installation renames. This ordering can leave an
extra recoverable name after a power interruption, but it does not acknowledge
a state in which the only prior generation has been durably removed.

A SQLite entry with a byte-identical main database is treated as a replacement
when a WAL, shared-memory, or rollback-journal sidecar is present. Restore
quarantines those sidecars with the prior main database and removes any empty
sidecars created by integrity verification before finalizing, so recovery state
newer than the selected backup cannot remain authoritative. Runtime startup may
remove a stable maintenance lease whose PID and hashed process-start identity
show that its owner terminated or that the PID was reused. It continues
to refuse active maintenance with `storage_maintenance_active` and unverifiable
maintenance ownership with `storage_maintenance_state_unknown`.

Idempotent file-object persistence verifies the physical object using its
recorded byte count and streaming SHA-256 before returning the existing
metadata. A missing or same-size corrupted object fails closed and must be
reconciled rather than silently accepted. Buffered objects follow the same
private staging, file synchronization, atomic rename, and parent-directory
synchronization sequence before their metadata is committed.

Run the storage operation verifier and the production drill:

```bash
node tools/server-scripts/verify-backup-restore.mjs
node tools/server-scripts/verify-storage-production-restore-drill.mjs
```

The production drill writes `build/reports/storage-production-restore-drill/latest.json` without child-owned readiness or leak-scan flags. The required-report validator performs the sensitive-data scan, and the parent evidence reducer in `tools/server-scripts/lib/release-evidence-readiness.mjs` evaluates the operation, integrity, authorization, proof, and audit facts.

## Operation Proof Evidence Policy

Operation proof evidence is governed by `LICO_OPERATION_PROOF_EVIDENCE_POLICY` and
`LICO_OPERATION_PROOF_SIGNER_SECRET`. The policy defaults to `development`, which
produces non-verifiable operation proof entries.

Set the policy to `production` only when a signer secret is configured:

```bash
export LICO_OPERATION_PROOF_EVIDENCE_POLICY=production
export LICO_OPERATION_PROOF_SIGNER_SECRET=<redacted-secret>
```

A production policy without a configured signer fails closed before operation
proof evidence can be produced. The operation proof substrate verifier
(`npm test -- --suite runtime.operation-proof-substrate`) also rejects production
policy without a signer, enforcing consistency between declared policy and
signer presence. User configuration remains empty by default; the verifier
enforces the declared intent rather than imposing a default policy.

### Signer Provisioning

Generate a signer secret with sufficient entropy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Store the secret through the deployment environment or a secret manager. Do not
write the secret value into repository source, documentation, or generated
reports.

### Signer Rotation

To rotate the signer secret:

1. Provision the new secret under a fresh environment variable.
2. Deploy with both old and new secrets available and the new secret configured
   as `LICO_OPERATION_PROOF_SIGNER_SECRET`.
3. Verify the proof substrate verifier passes against the new secret.
4. Remove the old secret from the deployment environment.
5. Record the rotation in the deployment audit log.

Run the operation proof substrate verifier after rotation:

```bash
npm test -- --suite runtime.operation-proof-substrate
```

## Controlled Execution Sandbox

The execution sandbox is unconfigured and disabled by default. An operator must explicitly configure enablement, provider mode, allowed provider classes, policy profile, policy revision, and receipt requirement. Provider executables, sockets, probe commands, runtime classes, and backend definitions are core-owned trusted-adapter facts and are not user configuration. Missing, disabled, invalid, unhealthy, expired, or policy-incomplete state projects `sandboxAvailable: false`, denies before input resolution or backend creation, and never falls back to a host process. Fixed-location Podman and Docker adapters become selectable only after the exact local provider passes the real OCI conformance verifier and its trusted receipt remains current.

Provision or revoke a trusted OCI conformance receipt explicitly:

```bash
node tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs provision --user-data-path <user-data-path> --policy-revision <policy-revision> --runtime-profile <runtime-profile>
node tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs revoke --user-data-path <user-data-path> --provider-id <provider-id>
```

The runtime data path must be absolute. The command emits only bounded status and check counts; it does not print provider paths, runtime probe output, or the supplied data path. A failed provision attempt leaves no trusted receipt for that candidate.

Run the contract and lifecycle verifier:

```bash
npm run verify:controlled-execution-sandbox
```

The generated report separates contract evidence, live backend conformance, opaque custody, and launcher-boundary closure. `sandboxAcceptanceReady` is true only when every required current fact passes. A false value or a fixed blocker such as `production_backend_conformance_receipt_missing` is an objective sandbox blocker and cannot be overridden by a plugin contribution.

The current hardened OCI adapter accepts only the governed Node runtime profile. It enables the Node permission model without child-process, worker, native-addon, WASI, FFI, inspector, or network grants and layers that policy with the container isolation controls. Requests for a different runtime command or a non-zero subprocess capability fail as unsupported instead of being approximated through the cgroup PID budget.

## Evidence Handling

- Reports use redacted evidence for secrets, grant tokens, local absolute paths, private runtime state, and raw prompts.
- Keep generated reports under `build/`.
- For an interrupted command, record the command, prerequisite, and follow-up verification path.
