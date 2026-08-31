# Runbook

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

This runbook covers local startup, container startup, verification, and operational checks for the internal platform repository.

## Required Runtime

- Node.js version range from `package.json`.
- npm.
- Container tooling only when running the container path.

The default runtime is self-contained. Optional middleware integrations are enabled explicitly for deployment-specific extensions.

## Private-Deployment Dependency Admission

Meshrix.js is delivered to enterprises for private deployment. Dependency
admission therefore protects an operator's continuing right to install,
redistribute, operate, maintain, back up, restore, modify, and upgrade the
delivered system without an unexpected third-party commercial condition.
Source availability, popularity, or current zero-cost use is not sufficient
evidence of acceptability.

This gate applies to:

- direct and transitive source dependencies;
- bundled libraries, binaries, base images, containers, and downloaded tools;
- Operators, charts, deployment templates, installers, and release assets;
- default, optional, example, development, test, and observability components
  that enter a source or release candidate; and
- a new version, edition, module, plugin, or distribution of an already
  admitted project.

A generic protocol adapter is not an adoption of every compatible product only
when Meshrix.js does not bundle, download, require, select by default, or make a
licensing claim for the operator-supplied service.

### Authority and maturity baseline

License compliance is necessary but does not establish technical authority.
Default enterprise profiles must use established projects with durable public
governance, current security maintenance, broad production evidence, and an
operational ecosystem appropriate to the workload. Repository popularity,
vendor marketing, a single large deployment, protocol compatibility, or an
internal license alone is not sufficient.

A baseline dependency must satisfy every applicable condition:

1. it has a current supported release line, a published security contact and
   update process, immutable release artifacts, and documented upgrade and
   rollback procedures;
2. its governance, release authority, trademarks, and maintainer continuity
   are public and are not subject to an unresolved single-vendor or ownership
   dispute;
3. independent organizations have documented production operation, including
   failure, recovery, backup or replay, observability, and capacity behavior
   relevant to the selected role;
4. its standard protocol and data format permit replacement without moving
   Meshrix.js governance or business authority into the dependency; and
5. the exact artifact passes Meshrix.js conformance, failure injection,
   migration, resource-bound, and private-deployment tests.

In addition, a default dependency needs at least one authority anchor:

- an Apache Software Foundation Top-Level Project, not an incubating project;
- a CNCF Graduated project or a direct subproject governed by one;
- a neutrally governed Linux Foundation project with active maintainers and
  production users from multiple independent organizations;
- PostgreSQL Global Development Group ownership or an active, long-lived
  PostgreSQL community project listed by the PostgreSQL project; or
- a documented de facto industry standard with multiple independent
  production adopters, at least five years of maintained releases, a public
  security process, and no unresolved control or relicensing risk.

CNCF Sandbox projects, Apache Incubator projects, personal projects, and
single-vendor open-core components do not enter a default profile. A CNCF
Incubating project may be evaluated only as a non-default extension when no
Graduated or Top-Level alternative meets the capability, and it still requires
independent production evidence and a tested replacement path. If no candidate
passes both the license and authority gates, the capability remains unselected;
maintainers must not lower either gate merely to fill a matrix cell.

### License baseline

The initial license allowlist is intentionally narrow:

- Apache License 2.0;
- BSD 2-Clause and BSD 3-Clause;
- MIT;
- GNU GPL version 2 or version 3; and
- the PostgreSQL License as an explicit project exception after an exact
  permissive-license review.

AGPL and LGPL are distinct license families and are not admitted as GPL by
name similarity. A dual-licensed artifact must have one explicitly selected
allowlisted option. A mixed-license artifact must pass for every component
that is distributed. GPL code must remain process- or service-separated unless
an explicit compatibility review permits linkage, and every distribution must
satisfy the applicable source, notice, and modification obligations.

An allowlisted license is necessary but not sufficient. Reject a candidate
when any of the following is true:

- source-available, proprietary, custom, trial, or delayed-conversion terms
  restrict production use, field of use, revenue, organization size, cluster
  size, user count, geography, resale, hosting, managed service, competition,
  or redistribution;
- production operation, security maintenance, or a required capability needs
  a license key, account registration, mandatory telemetry, paid entitlement,
  recurring renewal, or commercial edition;
- dual, mixed, or edition-specific licensing leaves the rights of the exact
  source, binary, container, chart, Operator, plugin, or management component
  unclear;
- a material licensing, copyright, trademark, project-control, or governance
  dispute creates a credible redistribution, operation, upgrade, or
  maintenance-continuity risk;
- the maintainers withdraw supported community artifacts, archive the required
  repository, stop a usable security-update path, or direct production users
  to a separately licensed product;
- the release artifact, its source, its license and notice files, and its SBOM
  cannot be bound to the same immutable version and digest; or
- approval would require an enterprise customer to obtain a separate license,
  accept new third-party terms, disclose unrelated source, or assume an
  unresolved interpretation.

Unknown, conflicting, or incomplete evidence is a rejection. Maintainers must
not use a disclaimer, an optional-install label, a customer-supplied image, or
an instruction to contact the vendor as a substitute for admission.
Existing presence is not approval or grandfathering: an artifact that has not
passed this gate must be removed, replaced, or admitted before it can enter the
next release candidate.

### Admission and upgrade evidence

Before a dependency enters a change or release candidate, record and review:

1. the exact upstream owner, repository, version, source revision, artifact,
   image digest, and selected edition;
2. the authoritative license text, SPDX expression, notices, bundled
   third-party inventory, and release-candidate SBOM;
3. production, redistribution, hosting, trademark, support, security-update,
   registration, telemetry, and renewal terms;
4. current maintenance and governance status, including public relicensing or
   ownership disputes; and
5. an offline private-deployment path that does not require vendor approval or
   a vendor control plane.

Review a fixed artifact, never a floating tag. Every upgrade or distribution
change is a new admission decision. A scanner may collect evidence but cannot
resolve ambiguous legal or commercial terms; ambiguity remains denied until a
competent review records a safe conclusion.

If an admitted upstream later changes its terms or develops a material
commercial or governance risk:

1. stop upgrades and prevent the affected artifact from entering a new release
   candidate;
2. preserve the immutable source, license, notices, SBOM, and digest that prove
   the rights of the last admitted artifact;
3. select and verify a risk-free replacement behind the existing Core-owned
   port or protocol boundary;
4. migrate once, remove the affected implementation and product-specific
   defaults, and verify that no release surface still installs it; and
5. do not require existing private-deployment users to purchase a license or
   accept the upstream's new terms as the migration path.

## Local Startup

One-click start, stop, and restart:

| Command | Mode |
| --- | --- |
| `npm run start:dev` / `npm run stop:dev` / `npm run restart:dev` | Source development server |
| `npm run start:server` / `npm run stop:server` / `npm run restart:server` | Source non-development server |
| `npm run start:console` / `npm run stop:console` / `npm run restart:console` | Source Server + Web Console |
| `npm run start:compose` / `npm run stop:compose` / `npm run restart:compose` | Source-checkout container, API-only |
| `npm run start:compose:ui` / `npm run stop:compose:ui` / `npm run restart:compose:ui` | Source-checkout container, Server + Web Console |
| `npm run start:offline` / `npm run stop:offline` / `npm run restart:offline` | Offline Linux VM bundle, Server + Web Console |

These commands reuse a healthy instance of the same mode, refuse an occupied default port or a different stack on the `meshrix-server` container name, and do not wipe volumes on stop. Restart of the same mode stops then starts that stack; a different running mode fails closed. A published, offline, or `--with-ui` instance has one public origin: the Web Console at `/` and the Server API at `/api/`. External services and agents connect to that same origin; source development may add a Vite console port, and that port is not the published integration address. The developer handbook owns that address contract; the user handbook owns how operators and external systems use it. `npm run pack:offline` writes the signed Server + Web Console dual-arch bundle to `build/offline-delivery-bundle` and does not start, stop, or clean up a running instance. `node tools/server-scripts/offline-delivery-closure.ts` remains the offline acceptance oracle and is not a start or pack command.

```bash
npm install
npm run start:dev
```

Default local server URL:

```text
http://127.0.0.1:7228
```

### Local instance reuse

Before starting an ordinary local server, resolve the effective default data
directory and inspect the default backend and frontend ports.

- Reuse the default data directory when it already contains Meshrix.js runtime
  state. Do not replace it with an isolated or temporary data directory.
- Reuse a healthy server and console that already belong to the same local
  instance. Do not start a duplicate process pair.
- When the data directory exists but no service is running, start exactly one
  server against that directory and one console against that server.
- When a default port is occupied by an unrelated or unidentified process,
  stop and report the conflict. Do not silently select another port or create
  another data directory.
- Use an isolated data directory only when the operator explicitly requests
  one or when a repository-owned test or verifier requires isolation and owns
  its cleanup.

Run authentication and operational utilities against the same effective data
directory as the server. A successful command against a different data
directory updates another local instance and does not change the running
server.

Non-development server startup:

```bash
npm run server:start
```

Automation that requests a dynamic port must use the private readiness file
instead of parsing stdout:

```bash
node tools/server-scripts/start-server.ts --port 0 --ready-file <private-ready-file>
```

The file is atomically created with mode `0600`, contains the selected local
connection state, and is removed during shutdown. Treat it as private runtime
IPC and do not publish it as verification evidence.

## Container Startup

The source checkout Compose file builds the API-only `runtime` target for local
deployment verification. Prefer the one-click commands:

```bash
npm run start:compose
npm run stop:compose
npm run restart:compose
```

```bash
docker compose up -d
```

For a local deployment that also serves the Web Console, select the UI image
target explicitly, or use `npm run start:compose:ui` / `npm run stop:compose:ui` /
`npm run restart:compose:ui`:

```bash
MESHRIX_BUILD_TARGET=runtime-ui MESHRIX_SERVER_WITH_UI=1 docker compose up -d --build
```

The Compose file also defines an optional, profile-gated `format-convert`
service for the file-parser/format-convert upstream example
(`docs/examples/file-parser-format-convert.upstream.json`). A plain
`docker compose up` never starts it. Set `MESHRIX_FORMAT_CONVERT_IMAGE_NAME`
to an operator-supplied local image, then enable the profile:

```bash
docker compose --profile format-convert up -d
```

The service stays on the internal Compose network; the server reaches it as
`http://format-convert:8080`.

Create the reproducible server source archive and its SHA-256 checksum with:

```bash
npm run release:package-server-source
```

The command writes to `build/packages`. This is a source package: it excludes
installed dependencies and container images, so a target host still needs
network access while building the remaining npm artifacts. It includes the
authorized vendored Pactium tarball under `vendor/` so `Dockerfile` `COPY vendor`
and `npm ci` can resolve `file:vendor/pactium-*.tgz` without a public npmjs hit
for that package.

Set `MESHRIX_HOST_PORT` to change the loopback host port. The Compose contract uses
that same value for bootstrap, advertised, and active service URLs while the
container continues to listen on port `7228`. The host publish address remains
`127.0.0.1` by default. An isolated VM may set `MESHRIX_BIND_ADDRESS=0.0.0.0` and
`MESHRIX_ADVERTISED_HOST` to its VM-local DNS name when host access is required;
do not use a non-loopback bind on an untrusted network. Its 90-second stop grace period
covers the runtime's two-phase request drain and cancellation budget. Compose
also reports container health from the loopback `/api/healthz` endpoint.

The published release image uses the `runtime-ui` target and serves both the
server and Web Console. Production deployment must use the registry digest,
not a floating tag. The runtime root filesystem is read-only, runs as UID/GID
`10001`, drops all Linux capabilities, enables `no-new-privileges`, and keeps
data, backups, and runtime home on separate writable volumes:

```bash
candidate='registry.example/meshrix-js/runtime@sha256:<manifest-digest>'
public_base_url='https://meshrix.example.com'
key_source='/etc/meshrix/secrets/local-secret-master-key'
proof_signer_source='/etc/meshrix/secrets/operation-proof-signer-secret'
trusted_proxy='<trusted-proxy-ip>'
install -d -m 0700 /etc/meshrix/secrets
umask 077
openssl rand -hex 32 > "$key_source"
openssl rand -hex 32 > "$proof_signer_source"
docker pull "$candidate"
docker volume create meshrix-server-data
docker volume create meshrix-server-backups
docker volume create meshrix-codex-home
docker network create meshrix-core
docker run -d \
  --name meshrix-server \
  --restart unless-stopped \
  --stop-timeout 90 \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --security-opt no-new-privileges=true \
  --cap-drop ALL \
  --network meshrix-core \
  --publish 127.0.0.1:7228:7228 \
  --env MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE=/run/secrets/meshrix-local-secret-master-key \
  --env MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY=production \
  --env MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE=/run/secrets/meshrix-operation-proof-signer-secret \
  --env MESHRIX_PRODUCTION_INGRESS_MODE=trusted-proxy \
  --env MESHRIX_TRUSTED_PROXIES="$trusted_proxy" \
  --env MESHRIX_COOKIE_SECURE=always \
  --env MESHRIX_BACKUP_ROOT=/app/backups \
  --env MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT=1 \
  --env MESHRIX_BOOTSTRAP_URL="$public_base_url" \
  --env MESHRIX_ADVERTISED_BASE_URL="$public_base_url" \
  --env MESHRIX_ACTIVE_SERVICE_URL="$public_base_url" \
  --mount type=bind,src="$key_source",dst=/run/secrets/meshrix-local-secret-master-key,readonly \
  --mount type=bind,src="$proof_signer_source",dst=/run/secrets/meshrix-operation-proof-signer-secret,readonly \
  --mount source=meshrix-server-data,target=/app/data \
  --mount source=meshrix-server-backups,target=/app/backups \
  --mount source=meshrix-codex-home,target=/codex-home \
  "$candidate"
```

The same immutable activation is available through the production Compose
overlay. `MESHRIX_IMAGE_NAME` must contain the digest reference.
`MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE` must be an absolute operator-custodied
file outside Meshrix.js data and backup volumes.
`MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE` must be a second, different
operator-custodied file with the same external-custody boundary, and
`MESHRIX_PUBLIC_BASE_URL` must be the HTTPS URL owned by the administrator's
reverse proxy. `MESHRIX_TRUSTED_PROXIES` must list the exact IP address or
addresses from which that proxy reaches the container. Production admission
requires exact HTTPS forwarding metadata from those peers and leaves only
local health probes available without proxy metadata.
`--no-build --pull never` prevents the cloud host from replacing the candidate
with a local build or network result:

```bash
MESHRIX_IMAGE_NAME="$candidate" \
MESHRIX_PULL_POLICY=never \
MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE="$key_source" \
MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE="$proof_signer_source" \
MESHRIX_PUBLIC_BASE_URL="$public_base_url" \
MESHRIX_TRUSTED_PROXIES="$trusted_proxy" \
  docker compose -f docker-compose.yml -f docker-compose.enterprise.yml \
  up -d --no-build --pull never --wait meshrix-server
```

Inspect the deterministic online or preloaded-offline activation plan with:

```bash
MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE="$key_source" \
MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE="$proof_signer_source" \
MESHRIX_PUBLIC_BASE_URL="$public_base_url" \
MESHRIX_TRUSTED_PROXIES="$trusted_proxy" \
  node tools/server-scripts/enterprise-single-node-cloud-deployment.ts \
  plan --candidate "$candidate" --offline
```

Neither secret source is printed by the planner or stored in a Meshrix.js report.
The planner rejects shared paths or identical values. Do not replace the
encryption key independently: current encrypted values intentionally fail with
the wrong key. The Local Secret Store provides an all-active-value
re-encryption transaction that verifies every new envelope before one registry
commit. An operator-facing governed command and external KMS/HSM custody remain
separate release work.

Offline activation itself has no registry dependency after the exact image is
loaded and addressable by digest. Candidate-bound Linux amd64 and arm64 OCI
layouts, inventory, SBOM, provenance, signatures, and activation instructions
are assembled by composing
`tools/server-scripts/enterprise-single-node-offline-bundle.ts`. Prove exact
byte transfer and the disconnected lifecycle contract with:

```bash
node tools/server-scripts/offline-delivery-closure.ts
```

The closure writes `build/reports/offline-delivery-closure.json`. Operator
steps are in `docker/offline-delivery-instructions.md`. The offline images are
Server + Web Console (`runtime-ui`); API-only `runtime` images do not satisfy
the bundle. Import, start, Console-root load, the first governed
`system.health` call, stop, and cleanup must run on a Linux operating system
inside a virtual machine without network access or rebuild.
Ubuntu is preferred; Debian is accepted. A macOS operator host is allowed when
that Linux VM is reachable. When a Linux VM target or a dual-architecture
builder is unavailable, the oracle fails closed with `blocked_by_environment`
and a finite reason. Contract-fixture bytes do not satisfy acceptance. Native
Linux, Ubuntu, Debian, capacity, and publication qualification remain remaining
required work after the named workflows. To write the signed Server + Web Console dual-arch bundle without
starting or stopping an instance, run `npm run pack:offline`. To import and
start that bundle without the closure's stop and cleanup steps, run
`npm run start:offline`. Stop it with `npm run stop:offline`. Restart the same
offline stack with `npm run restart:offline`.

The plan-scoped final receipt consumes those exact current reports:

```bash
node tools/server-scripts/functional-final.ts
```

It writes `build/reports/functional-final.json`. A reachable Linux VM from this
macOS operator host is enough to close the current plan candidate. Prefer
Ubuntu; accept Debian. This command is not `npm run verify:acceptance`.
Project-level functional-complete, publication, production-readiness, native
Linux, Ubuntu, Debian, and environment qualification remain remaining required
work.

Before an upgrade, invoke the governed `storage.backups.create` operation and
retain its successful receipt; backups are written to the independent
`meshrix-server-backups` volume. Keep the previous digest and pass it as
`--previous` to inspect the rollback activation plus the governed
`storage.backups.restore_preview` and `storage.backups.restore` recovery
entries. The durable orchestration state machine is implemented at
`tools/server-scripts/upgrade/enterprise-upgrade-rollback.ts`; verify its
successful, rolled-back, and `in_doubt` paths with
`npm run vitest -- tests/vitest/server/enterprise-upgrade-rollback.test.ts`. The candidate-bound
enterprise operations closure is:

```bash
node tools/server-scripts/enterprise-operations-closure.ts
```

It composes governed MCP, denial and uncertainty, diagnostics, emergency
administration, key lifecycle, clean-root restore, and N-1 upgrade / failed
rollback producers into `build/reports/enterprise-operations-closure.json`.
Missing container, key, or restore environments fail closed with a finite
blocker. Capacity, production-readiness, and environment qualification remain remaining
required work after this closure. Digest-pinned images may be supplied as
`--candidate` and `--previous`. The repository does not yet prove an N-1 schema
migration against two distinct released images. Upgrade completeness remains
remaining required work until that evidence exists.

Before an unreliable-network deployment window, prepare the npm artifact cache:

```bash
npm run server:prepare:npm-cache
```

Container verification builds the Docker image with BuildKit dependency caches, starts compose, serves the real container, verifies MCP initialize, tools/list, `meshrix.capabilities.list`, `system.health`, destructive rejection, and cleanup:

```bash
npm run server:verify:deployment-flow
```

For routine local verification, Podman uses the same Compose file and the same
verifier:

```bash
podman machine init
podman machine start
npm run server:verify:deployment-flow:podman
```

Initialize the Podman machine only once. The Podman report is written separately
as `build/reports/deployment-container-flow-podman.json`. It is development-
environment simulation evidence for the Functional Release Gate. Real-machine
qualification remains remaining required work until the named Real-Machine
Verification Workflow passes.

## TypeScript Source And Build Boundary

Meshrix.js source is authored as TypeScript throughout the Node.js backend,
repository tooling, tests, and Vue application. Local npm scripts enable the
`source` export condition so workspace packages resolve their `.ts` entry
points. Run source entry points through the owning npm script; when invoking a
source file directly, use `node --conditions=source <entry>.ts`.

Production and container execution use emitted JavaScript from `dist/` rather
than runtime type stripping. Validate and build both runtime surfaces with:

```bash
npm run typecheck
npm run build
```

`typecheck:node`, `typecheck:test`, and `typecheck:web` are the independently
diagnosable checks. `build:node` emits the Node.js packages and applications;
`build:web` builds the Vue console.

## Routine Verification

Use the narrowest check that covers the change. For repository-level functional
verification, run:

```bash
npm run typecheck
npm run verify:version-registry
npm test -- --suite domains.manifest
npm test
```

`npm test` is the only complete regression entry point. Its ordered plan is
owned by `tools/registry/tests.registry.json` and executes four resumable,
traceable phases:

1. Check the base environment and repository integrity. Resource and memory
   discipline runs first and remains isolated so concurrent work cannot distort
   its measurements.
2. Build and verify the Web Console and backend in parallel lanes. The backend
   build is an explicit prerequisite for two bounded Server shards, the unit
   suite, and the contract suite; those dependent lanes start together after
   the build succeeds or fails, so the phase still discovers all functional
   failures without one oversized Vitest process. The worker-thread audit test
   is a separate lane that starts after both Server shards finish; this avoids
   V8 worker teardown overlapping the fork pools while keeping the ordinary
   frontend and backend suites parallel.
3. Verify the frontend/backend acceptance interface and protocol contracts.
4. Verify independent services, runtime plugins, and Agent client adapters in
   parallel lanes. Each plugin lane keeps packaging steps sequential where they
   share build output.

Suites remain sequential inside one lane, lanes run concurrently inside one
phase, and phases run in order. The report records every phase, lane, process,
and result so a failed lane can be resumed with its owning narrow command.
`npm run verify` delegates to this entry point and does not repeat the same
builds or tests. A complete `core-public` run also refreshes the bounded,
interactive snapshot at `docs/verification/regression.html`. Focused suites,
explicit tags, alternate profiles, and dry runs never overwrite that snapshot.
Commit the refreshed file with the accepted product version; Git history then
retains prior snapshots while the current path always shows the latest metrics.

For broader validation:

```bash
npm test
npm run build
```

Workspace file collaboration uses the shared Working View and Change Set
model. Host asset fetches remain ordinary Host operations. The focused
command below leaves capacity, environment qualification, and the named
efficiency profile as remaining required work:

```bash
node --conditions=source tools/server-scripts/verify-workspace-collaboration-migration.ts
```

The named warm efficiency profile compares equivalent frozen legacy and
collaborative workloads. `capacityCertified` is true only when completeness,
privacy, safety, recovery, and every warm threshold pass; otherwise it is
false with a finite reason. Environment qualification, publication, and
production-readiness remain remaining required work after this command:

```bash
NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-agent-service-efficiency-profile.ts
```

The report is `build/reports/agent-service-efficiency-profile.json`.

For a source split, package extraction, ownership move, protocol separation,
or feature-surface reassembly, use the repository-owned architecture and
verification contracts. Inspect the changed-file closure before execution:

```bash
npm run verify:better-plan
npm run verify:core-platform-surface-convergence
```

PLAN-005 is the sole current production-use Plan. Its canonical Better Plan v3
workspace is `docs/plans`: `Manifest.json` indexes the Plan,
`production-use-closure/Plan.json` is the semantic source,
`production-use-closure/Plan.md` is the generated projection, and
`production-use-closure/Checkpoints.json` is execution state only. Never infer
semantic authority from the projection or reconstruct missing state from an
acceptance report.

Use the same fail-closed authority for validation and next work:

```bash
npm run verify:better-plan
npm run plan:next
```

An absent, malformed, or mismatched workspace requires Plan repair. These
commands do not run functional acceptance, deploy a candidate, advance a
branch, publish an artifact, or mutate checkpoints; only canonical Better Plan
lifecycle commands may change execution state. Product acceptance, Linux
deployment evidence, production-closure verification, and branch advancement
remain candidate evidence owned by their separate workflows. Those product
workflows never read or validate `docs/plans`; Plan validity cannot block or
promote a product candidate. The Plan workspace remains a local process
document and is excluded from public release artifacts.

The reassembly profile covers the Core typecheck and build, public regression
gate, capability surface convergence, and acceptance contract.
It does not execute the Functional Release Gate. Environment qualification,
client compatibility, and plugin compatibility remain remaining required work.

### Optional integration isolation

After changing an optional provider, identity, telemetry, notification,
datastore, or external-service lifecycle, run:

```bash
npm run server:verify:integration-task-supervisor
```

The check proves that empty, disabled, unconfigured, invalid, slow, failed, and
cancelled adapters remain capability-scoped; work begins only after Core
readiness; concurrency, queueing, retries, timeouts, and close are bounded; and
the emitted status contains only stable reason codes and counters. A passing
supervisor check proves the Core lifecycle authority, not that any concrete
third-party adapter is configured or healthy.

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

## Release Definition and Publication

Meshrix.js has three deliberately separate acceptance standards:

1. The **Functional Release Gate** is the mandatory project release closure.
   It proves that the implementation and code organization are complete,
   internally consistent, secure, resource-bounded, reproducible, and covered
   by every simulation, container, failure-injection, recovery, packaging, and
   protocol check that the development environment can execute. A missing,
   skipped, stale, or failing required functional check fails this gate.
2. **Release Deployment Verification** is the mandatory runtime-ui deployment
   closure for the exact stable candidate. On a GitHub-hosted `ubuntu-24.04`
   runner it deploys the runtime-ui surface and drives bounded external
   deterministic synthetic requests with no real model dependency, then
   verifies termination and cleanup of every deployment resource. Its
   fixed-size privacy-safe receipt is the named **Release Deployment Claim**.
3. A **Real-Machine Verification Workflow** is remaining required work that
   independently repeats the exact accepted candidate on one declared
   operating system, architecture, device, host, or network environment. Its
   successful receipt is the named **Environment Support Claim** for that
   exact environment.

The dependency is one-way:

```text
Functional Release Gate receipt
  -> Release Deployment Verification receipt
  -> Release Deployment Claim
Functional Release Gate receipt
  -> Real-Machine Verification Workflow receipt
  -> Environment Support Claim
```

A release-deployment workflow must refuse an unaccepted or mismatched
candidate, and its absence or failure blocks tag publication for that commit.
A real-machine workflow must refuse an unaccepted or mismatched candidate, but
its absence, unavailability, failure, or expired receipt never changes the
Functional Release Gate result and never blocks project publication. It only
leaves that environment qualification as remaining required work. Project-level
functional results are `passed` or `failed`; `blocked` is not a project release
result. Real-machine workflow results are `not_run`, `ineligible`, `passed`, or
`failed`.

Avoid the ambiguous standalone terms `production-ready`, `final readiness`,
and `platform acceptance`. State the exact remaining-work or completed evidence
instead: `functional release accepted`, `real-machine verified on
<environment>`, `release deployment verified on ubuntu-24.04`, or
`environment qualification remains remaining required work`.

`tools/registry/release-definition.registry.json` is the sole source for the
product version, Git tag, release channel, package manifest set, container
platforms, functional acceptance profile, local container engine, and the exact
fourteen-file upstream publishing candidate bundle. Package manifests, the
lockfile, workflow expressions, tags, reports, and this runbook are projections
of that definition.

Before creating a tag, update the definition, prepare all version projections,
and verify them:

```bash
npm run release:prepare
npm run verify:release-definition
npm run release:prepare -- --check
```

The detachable format-conversion integration can be checked separately when
the sibling service and adapter repositories are available:

```bash
npm run verify:release-journey
```

This command re-runs that integration scenario deterministically on an
isolated Docker Compose stack: it builds and starts the server plus the
`format-convert` profile on a free loopback port with
`MESHRIX_ADVERTISED_BASE_URL` set to the mapped URL, bootstraps the
containerized owner account, publishes
`docs/examples/file-parser-format-convert.upstream.json` through the
authenticated control plane, seeds the client-adapter cache, installs the MCP
connector for every detected supported local target with isolated temporary
client configuration and a minimal journey grant, approves each device
authorization through the Console, drives each real connector stdio proxy
after uploading the tracked Chinese UTF-8
fixture from `tools/server-scripts/lib/release-journey-fixture.ts` through an
authenticated upload session with raw `application/octet-stream` bytes
(without a Base64 JSON file field), converts it through a governed owner-bound
`upload:` artifact reference, and asserts the `[resource_link, text]` result
for both `convert-full-access-debug` and
`convert-require-approval-debug`. The latter must have zero successful
execution before approval and exactly one after approval per detected target;
the former skips only the approval wait and remains fully governed.
It downloads the PDF by following the returned resource_link URL with
the connector `fetch` command, and verifies `%PDF-` magic, byte bounds,
embedded Noto CJK fonts, and full ToUnicode coverage of the fixture's Han
codepoints. It writes `build/reports/release-journey.json` with per-step
receipts and exits nonzero on any failure; cleanup (connector uninstall and
grant revocation, compose `down -v`, temporary secrets and work directories)
always runs and is duration-bound in the report. Missing, duplicate, skipped,
or failed required steps and any incomplete cleanup keep `releaseReady` false.
Its seven-row matrix covers OpenClaw, Codex, Claude Code,
Antigravity, OpenCode, Pi, and Kimi CLI. A missing local command is
`not_detected`; every detected target must pass installation, upload,
tools/list, both debug calls, uninstall, and cleanup. The integration check
forbids simulation whenever at least one supported local client is detected.
Only after the complete seven-target scan returns zero detected clients may it
run one explicitly labelled `mcp-simulator` fallback through the same request
and evidence path. That fallback is protocol-path evidence, not client
compatibility evidence, and carries the fixed zero-client reason in the report.
The integration check
also requires one expected `meshrix.agentWorkspace.list`
`missing_capabilities` denial per real or simulated execution target because the journey Grant
deliberately excludes unrelated workspace authority; the HTML distinguishes
this non-amplification evidence from format-convert failures. The integration check
needs Docker, an operator-supplied format-convert image passed with
`--image-name`, and an operator-supplied client adapter source passed with
`MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE` or `--adapter-source`. Useful flags:
`--plan`, `--keep-stack`, `--port`, `--adapter-source`, `--image-name`,
`--json`. A pass proves only that this optional service-and-adapter composition
works end to end. Because the supplied artifacts are outside the repository,
the command is neither a Meshrix.js Functional Release Gate input
nor a Meshrix.js publication dependency. Its absence or failure cannot change the
Core `functional-complete` result.

A successful journey writes a ten-section, navigable, bilingual, single-file
HTML projection with captions, lazy embedded screenshots, total timing, and
cleanup timing. Its safe-configuration section places the verified publication
state and bounded runtime health immediately before the digest-bound health and
operation interface catalog. The client lifecycle is ordered as discovery,
install, upload, tools/list, both operation branches, uninstall, and cleanup;
every detected or fallback row must carry its own passing lifecycle outcomes.
The provenance section projects only step or cleanup identifiers, statuses, and
bounded durations—never their receipts or messages. It records candidate
context but remains unbound: embedding a
final receipt would create an HTML/receipt digest cycle. On a clean immutable
tag, bind the final HTML and all other required bytes with:

```bash
npm run verify:upstream-service-publishing-candidate
```

The resulting
`build/reports/upstream-service-publishing-candidate.json` binds the tag,
source commit and tree, release-definition digest, Core JSON, journey JSON,
publishing JSON, final HTML, and ten screenshots. Its scoped
`upstream-publishing-prepublication-passed` claim never establishes
`functional-complete`. A failed journey writes only a redacted,
non-authoritative HTML recovery projection without candidate status or embedded
screenshots. That recovery projection includes only the stable failing stage
and code plus bounded step and cleanup identifier/status/duration rows; it never
projects failure messages, receipts, logs, or runtime values.

`.github/workflows/release.yml` is the sole publication path. It runs only for
semantic version tags, serializes all release runs globally, and fails unless
the tagged commit equals the canonical `release` branch tip. The release
branch is promoted only by `.github/workflows/release-branch.yml`, which
resolves the successful stable complete-gate run for the exact push commit,
downloads its stable authority bundle, runs the external runtime-ui deployment
verification on `ubuntu-24.04`, and uploads the `release-authority` bundle for
that commit. `release.yml` imports that authority and revalidates candidate
identity, functional receipt, and deployment receipt before any publication.
Its protected `release-candidate` GitHub environment is the review boundary.
Before that authority, a read-only `upstream-service-publishing` job runs the
self-contained Core verifier. It checks out no detachable service or plugin
repository and performs no registry or release mutation. Every later
publication job inherits the Core prepublication and release deployment
prerequisites.
Multi-platform assembly, scanning, signing, SBOM, and provenance checks are
functional artifact requirements. Native host execution is performed only by
the remaining Real-Machine Verification Workflows and cannot block publication.

Meshrix.js `0.0.1` consumes exact file-vendored `pactium@0.8.0` from
`vendor/pactium-0.8.0.tgz`. The server source archive and container build copy
that tarball; they must not require a live npmjs fetch for Pactium. Public
publication of Meshrix.js `0.0.1` remains remaining required work and is a
separate npm-channel decision.

The workflow stages a multi-platform container and compares the intended OCI
manifest digest with the GHCR version tag before and after creating that tag.
An existing equal digest is idempotent; an existing different digest fails
without replacing the version tag. Before any candidate image is pushed, the
workflow requires a clean packed-package install and headless start on Node.js
22 and performs a read-only registry preflight for every npm release-set
package. The assembly jobs remain credential-free. Execution of the final MCP
archive on a native macOS, Linux, or Windows runner belongs to a separate
Real-Machine Verification Workflow.

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
`meshrix` package last, and every registry postcondition is reverified.
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

Run the mandatory Functional Release Gate:

```bash
npm run verify:acceptance
```

The command accepts a release candidate only when every required functional
report is fresh, command-owned, schema-valid, privacy-safe, and successful.
Development-host simulations, isolated containers, neutral protocol peers,
fault injection, bounded-load checks, clean temporary roots, offline artifact
inspection, startup and shutdown, rollback rehearsal, and recovery rehearsal
belong in this gate whenever they can be executed without a particular real
machine or external deployment. Exit code `0` means `passed`; every non-zero
exit means `failed`.

The acceptance orchestrator materializes the explicit Git commit in a detached
private worktree. It never copies a dirty caller workspace, and a failed run
retains one candidate-bound fixed-field failure envelope without moving the
accepted-generation pointer.

For the first installation on a clean supported Ubuntu or Debian x64/arm64
Orb target, create an owner-only (`0600`) non-symlink login input containing
exact UTF-8 JSON with only `username` and `password`; the normalized username
must be `owner`. Keep this file under operator-private custody and run:

```bash
npm run bootstrap:native:orb -- \
  --machine <target-id> \
  --origin <server-url> \
  --candidate <accepted-40-hex-commit> \
  --login-input <private-login-input>
```

The bootstrap accepts only the current post-commit acceptance generation and
archives that Git object rather than the caller's dirty tree. It installs the
candidate-locked authenticated Node runtime, Core with
`runtime.enabledPlugins: []`, external data/config/secrets, the private owner,
and one enabled `meshrix-js.service` on port 7228. The login credential is
validated and serialized once before the first target call, streamed through
standard input, and not retained in arguments, service configuration, output,
logs, or the receipt. Unsafe, linked, foreign, partial, or ambiguous fixed
state fails closed. If activation or live verification fails, the bootstrap
stops and disables the service and removes only its own unit; inactive
installation state remains for diagnosis and an exact resume.
The successful private receipt is `build/reports/native-orb-bootstrap.json`.

After bootstrap has left the service active, deploy a later accepted commit to
that existing native Linux target through the unchanged nine-stage Core
upgrade catalog:

```bash
npm run deploy:native:orb -- \
  --machine <target-id> \
  --origin <server-url> \
  --candidate <accepted-40-hex-commit> \
  --login-input <private-login-input>
```

Reuse the same operator-custodied login input. The deployment
builds in an inactive candidate release directory while the current service
continues running, switches the systemd working directory atomically, and
restores the prior activation if health, Console, authentication, governed
read, candidate identity, or service activity cannot be proven. Retained
evidence contains only bounded booleans and public candidate identities.

After both local acceptance and existing-target verification, branch promotion
uses the explicit accepted commit. Nightly feedback is bounded and
non-gating; stable and release require their own exact successful authorities.
No completed failed workflow is automatically retried, and this procedure
does not publish tags or assets or modify branch policy.

Inspect the sanitized functional DAG without executing it:

```bash
npm run verify:acceptance:plan
```

Run the mandatory Release Deployment Verification against an exact stable
candidate and its functional receipt:

```bash
npm run server:verify:release-deployment -- \
  --source-candidate build/release/control/SOURCE_CANDIDATE.json \
  --functional-receipt build/reports/platform-acceptance.json \
  --output build/reports/release-deployment.json \
  --cleanup-state <private-cleanup-state>
```

The controller deploys the runtime-ui surface for the exact candidate, drives
the bounded external deterministic synthetic request scenarios, verifies
termination and cleanup, and writes one fixed-size privacy-safe deployment
receipt with `capacityCertified: false`. Exit code `0` means the Release
Deployment Claim is present; every non-zero exit means the claim is absent
and tag publication for that commit is blocked. If the controller is
interrupted, invoke the same exact-resource cleanup through
`--cleanup-only --cleanup-state <private-cleanup-state>`; never substitute a
broad container, volume, process, or directory cleanup.

After the Functional Release Gate has accepted an immutable candidate, an
operator may run any registered real-machine workflow:

```bash
npm run verify:real-machine -- \
  run \
  --state-root <private-state-root> \
  --run-id <run-id> \
  --environment <environment-id> \
  --target <target-id> \
  --architecture <architecture> \
  --candidate sha256:<candidate-digest> \
  --functional-report <functional-acceptance-report>
```

Each workflow is a complete operational unit. It validates the functional
receipt and candidate identity, preflights the environment, starts only the
resources it owns, waits for bounded readiness, runs its declared probes and
failure cases, performs graceful shutdown, verifies termination and cleanup,
and writes one redacted candidate-bound receipt. Repeating the command on the
same clean environment must not require source edits or ad hoc operator
patches. Separate workflows are required for separate operating systems,
architectures, hosts, cloud environments, network environments, and clean-host
recovery targets.

`run` executes the registered `prepare`, `start`, `verify`, `stop`, and
`cleanup` phases and then reduces their receipts. Operators may invoke one
phase at a time with the same run identity and then invoke `reduce` to resume a
controlled deployment window.
The target selects its source-controlled command manifest; `--commands` may
name another reviewed repository-relative manifest when the workflow contract
explicitly permits it.

For repository-operated verification, dispatch
`.github/workflows/real-machine-validation.yml`. Every run requires the target,
the exact 40-character source revision, and the successful release-workflow
run ID that produced the functional receipt and candidate. The workflow checks
that the run used `.github/workflows/release.yml`, completed successfully, and
has the same source revision; it then downloads both inputs from that run and
derives the candidate digest locally. It does not accept a hand-entered
candidate digest.

Target-specific inputs fail before deployment:

- Native macOS and Windows require the portable artifact name and filename;
  macOS also declares its verifier input subdirectory.
- Native Linux requires the production base URL and trusted-proxy contract.
- Public-cloud verification additionally requires the Agent MCP, governed
  upstream HTTP, governed upstream MCP, and deliberate-fault HTTPS endpoints,
  the expected `sha256:<64-hex>` TLS certificate digest, and a bounded capacity
  count.
- Clean-host recovery requires an independent backup workflow run and artifact
  whose root contains `backup-manifest.json`.

Docker-backed targets consume the repository environment secrets for the local
secret master key and operation-proof signer. Public-cloud endpoint tokens are
also repository environment secrets, never workflow inputs. Secret custody
files live only in a bounded runner-temporary directory, are excluded from
receipt artifacts, are removed before materialization, and are removed again
under `always()` after the run. The public-cloud and clean-host targets require
self-hosted runners carrying the corresponding labels; lack of such a runner
leaves that environment qualification as remaining required work.

An optional workflow that cannot run returns its own `not_run`, `ineligible`,
or `failed` result and leaves only its environment qualification as remaining
required work. The Functional Release Gate does not read, wait for, or
aggregate these receipts.

### Upstream Service Publishing Functional Evidence

Run the canonical production-path publishing verifier before the Functional
Release Gate:

```bash
npm run verify:upstream-service-publishing
```

The Core verifier writes the reducer-owned
`build/reports/upstream-service-publishing.json`. When explicitly supplied
service and adapter artifacts are available, run the repository integration
workflow with:

```bash
npm run verify:release-journey -- --adapter-source <adapter-package-dir> --image-name <local-image>
```

That closure additionally starts the isolated external service, publishes it,
authorizes the connector-managed downstream agent, uploads the source through
the authenticated upload-session raw byte stream, drives the real MCP proxy
with only the owner-bound `upload:` reference, and writes the offline
`build/reports/upstream-service-publishing.html` projection. The HTML records
the exact safe startup command, the non-Base64 upload configuration, the
external service file budget, and the separate multipart request-envelope
limit before the UI-enabled runtime configuration, then
embeds ten digest-bound screenshots from the real Meshrix.js Web Console:
authenticated publishing, basic configuration, operation configuration,
published runtime health, tool catalog projection, pending Token authorization,
completed Token authorization, pending operation approval, completed operation
approval, and the downstream MCP call matrix. The report includes the complete
seven-target catalog; every detected local client must pass isolated install,
upload, tools/list, both debug calls, uninstall, and cleanup, while an absent
client is recorded as `not_detected`. Synthetic pages, receipt cards, and
DOM-only snapshots are invalid. Missing, duplicate,
blank, reordered, stale, digest-mismatched, non-Console, or privacy-unsafe
images fail the closure. The offline report includes English and Simplified
Chinese copy with a right-aligned language switch and no external script or
resource. The report tree is local-only under Git-ignored `build/`. Synthetic
fixture URLs, generated service identities, catalog digests, and tool identities
remain visible; credentials, authorization codes and request identities,
process fingerprints, account metadata, execution and trace identities, and
backend payloads remain protected.

The HTML has exactly ten semantic sections with in-document navigation and
table captions. Runtime health is listed beside the published operations, and
client rows separately expose upload, uninstall, and cleanup outcomes. A fresh
local success is scoped but unbound evidence; only the external candidate
receipt binds the final HTML bytes and complete bundle. The Functional Release
Gate remains the sole platform release authority.

The reducer recomputes authenticated mutation, durable publication, immutable
runtime snapshot, Operation Permission revision agreement, scoped audience
projection, catalog invalidation, acknowledgement, disconnect, timeout,
reconnect fencing, and governed loopback forwarding. The verifier uses
protocol-owned schemas and a neutral peer; it does not discover or run a client
repository, implementation, build, plan, test, report, or receipt. Only the
Functional Release Gate may consume the JSON report as project release
evidence; the HTML does not create a second readiness authority.

For a non-authoritative diagnostic that records currently open functional or
remaining environment-qualification gaps without changing either result, run:

```bash
npm run platform:audit:report
```

The functional acceptance state machine owns the mandatory command DAG and
aggregate report. Its foundation task runs the Core public test profile once;
that profile owns the public-boundary, secret-hygiene, local-info, registry,
root-hygiene, and script-registry child reports. The remaining functional
layers refresh plugin-package admission and runtime evidence, protocol-only
upstream fixture transit, neutral downstream peer conformance, gateway
profiling, surface convergence, private-deployment aggregate E2E, and gap
audit. External product adoption and real-machine receipts remain outside this
DAG and cannot block or promote it.

Functional acceptance is reduced through
`tools/server-scripts/lib/release-evidence-readiness.ts`. It publishes an
immutable evidence generation only after every required functional child
report, aggregate reduction, privacy check, and proof anchor succeeds.
`build/acceptance-evidence/current.json` is the atomic pointer to the accepted
generation; failed or interrupted runs leave the preceding generation intact.
Child readiness fields are input evidence. Missing implementation, missing
simulation, unavailable local tooling declared by the functional contract,
unknown or unexecuted commands, unowned reports, and inconsistent capability
reports all fail the Functional Release Gate. External-machine availability
cannot produce a project-level status.

To refresh the capability evidence report directly, run:

```bash
npm run verify:capability-acceptance-machines
```

The capability report stops at local `verified` or `failed` evidence states.
It never declares project-level acceptance and never requests an external
machine receipt. Environment-specific verification is owned exclusively by
the separately invoked real-machine workflow.

For gateway load validation, use the combined gateway profile:

```bash
npm run server:stress:gateway-platform
```

The profile writes redacted reports under `build/reports/` and covers
downstream MCP, upstream forwarding checks, and self-contained upstream fixture
transit. It returns non-zero when any required functional evidence report
fails. CPU, RSS, duration, concurrency, and request-rate limits are controlled
by the stress runner options or environment defaults; the runner records a
controlled cutoff instead of continuing after the configured CPU or RSS
threshold is reached.

## Runtime Utilities

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

## Storage Backup Restore Production Drill

Storage production recovery evidence comes from a repeatable operator drill
rather than a document-only statement. The drill exercises the registered
`storage.backups.list`, `storage.backups.create`,
`storage.backups.retention`, `storage.backups.restore_preview`, and
`storage.backups.restore` operation path against the selected
private-deployment storage backend. It verifies authorization denial with zero
storage side effects, confirmation denial before restore execution, retention
approval, the confirmed restore, proof and audit lifecycle completion, and
storage-kernel reopen. The functional verifier writes only a redacted fact
report; the Functional Release Gate determines acceptance. Execution on a
separate physical or virtual host remains remaining environment qualification
work for that host.

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

Object files under `objects/.pending` are unpublished atomic-write staging and
never enter a backup manifest. Backup creation and replacement restore leave
that directory untouched; only objects already renamed into the published
object tree are recoverable from a successful backup.

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
node tools/server-scripts/verify-backup-restore.ts
node tools/server-scripts/verify-storage-production-restore-drill.ts
```

The production drill writes `build/reports/storage-production-restore-drill/latest.json` without child-owned readiness or leak-scan flags. The required-report validator performs the sensitive-data scan, and the parent evidence reducer in `tools/server-scripts/lib/release-evidence-readiness.ts` evaluates the operation, integrity, authorization, proof, and audit facts.

## Operation Proof Evidence Policy

Operation proof evidence is governed by
`MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY`. The policy defaults to
`development`, which produces non-production-verifiable operation proof
entries. Production uses a separately custodied signer file selected through
`MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE`.

Set the policy to `production` only when a signer secret is configured:

```bash
export MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY=production
export MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE=/run/secrets/meshrix-operation-proof-signer-secret
```

A production policy without valid external signer custody fails before the
proof runtime opens. The operation proof substrate verifier
(`npm test -- --suite runtime.operation-proof-substrate`) also rejects production
policy without a signer, enforcing consistency between declared policy and
signer presence. User configuration remains empty by default; the verifier
enforces the declared intent rather than imposing a default policy.

### Signer Provisioning

Generate a 32-byte signer secret as lowercase hexadecimal text:

```bash
umask 077
openssl rand -hex 32 > /etc/meshrix/secrets/operation-proof-signer-secret
```

Keep the file outside Meshrix.js data and backup volumes and distinct from the
Local Secret Store master key. Do not write the value into repository source,
documentation, generated reports, or a Compose environment field.

### Signer Rotation

The proof port can compose one active signing generation with explicitly
retained historical verification generations through
`createMeshrixSignerKeyRing`; unknown generations fail verification. The
production signer file still selects one active symmetric signer. A governed
operator rotation command and external asymmetric KMS/HSM custody remain
release requirements.

Run the operation proof substrate verifier after rotation:

```bash
npm test -- --suite runtime.operation-proof-substrate
```

## Controlled Execution Sandbox

The execution sandbox is unconfigured and disabled by default. An operator must explicitly configure enablement, provider mode, allowed provider classes, policy profile, policy revision, and receipt requirement. Provider executables, sockets, probe commands, runtime classes, and backend definitions are core-owned trusted-adapter facts and are not user configuration. Missing, disabled, invalid, unhealthy, expired, or policy-incomplete state projects `sandboxAvailable: false`, denies before input resolution or backend creation, and never falls back to a host process. Fixed-location Podman and Docker adapters become selectable only after the exact local provider passes the real OCI conformance verifier and its trusted receipt remains current. Podman with `crun` is the canonical open-source engine and is sufficient on its own; Docker is optional compatibility, is not required, and cannot turn a failed installed Podman provisioning attempt into a successful receipt.

Provision or revoke a trusted OCI conformance receipt explicitly:

```bash
node tools/server-scripts/verify-execution-sandbox-oci-conformance.ts provision --user-data-path <user-data-path> --policy-revision <policy-revision> --runtime-profile <runtime-profile>
node tools/server-scripts/verify-execution-sandbox-oci-conformance.ts revoke --user-data-path <user-data-path> --provider-id <provider-id>
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
- Keep complete machine-readable reports, raw output, and transient evidence under `build/`.
- `docs/verification/regression.html` is the sole tracked projection: the full core regression generates it from bounded version, phase, lane, duration, and result metrics. Do not hand-edit it.
- For an interrupted command, record the command, prerequisite, and follow-up verification path.
