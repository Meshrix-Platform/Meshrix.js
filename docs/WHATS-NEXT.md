# What's Next: Highest-Value Open Problems

---

This file ranks Meshrix's ten highest-value open problems; item 1 is the
highest priority. It is a factual index, not an execution plan, architecture
decision, acceptance receipt, or readiness claim.

---

## 1. Produce One Auditable, Accepted Enterprise Release Candidate

### Background

Meshrix has a canonical acceptance reducer and a release workflow that require
fresh, command-owned, privacy-safe evidence before publication. The tracked
[release baseline generator](../tools/plan/rebuild-current-plan-baseline.mjs)
defines release-truth, offline packaging, production security, recovery,
upgrade, observability, adapter isolation, and real dual-architecture
acceptance stages. The canonical
[release definition](../tools/registry/release-definition.registry.json) now
binds the version, tag, channel, package set, acceptance profile, container
platforms, and GitHub native-runner matrix. The release workflow starts the
immutable image on native Linux x64 and ARM64 runners before signing.

### Problem

There is no single immutable candidate receipt that binds the declared
enterprise single-node support boundary, artifact inventory, report ownership,
Linux x64 and ARM64 results, and the final regression. Without that binding,
individual passing checks cannot establish that one releasable candidate has
closed the complete deployment journey.

### Affected scenarios

- Release and security review.
- Enterprise evaluation and procurement evidence.
- Reproduction of an accepted build from source.
- Prioritization of all work that depends on a stable release boundary.

### Possible solution paths

1. Close release-truth convergence first: fix the support matrix, classify
   every required report owner, and bind one candidate inventory.
2. Configure the GitHub `release-candidate` environment with repository-owner
   decisions for required reviewers, allowed release tags, and any wait timer;
   keep those controls outside source-level readiness claims.
3. Produce focused receipts for each release stage, then execute the offline
   journey on real Linux x64 and ARM64 hosts.
4. Run `npm run verify:acceptance` once against the immutable candidate and
   publish only through the repository release workflow.

## 2. Encrypt Local Secret Values and Define Master-Key Custody

### Background

The [Local Secret Store](../packages/foundation/src/security/secrets/local-secret-store.mjs)
uses private files, mutation locking, revision checks, and crash-consistent
replacement. Its value record still stores the secret payload as JSON. File
permissions protect ordinary local access but do not protect a copied data
directory, backup, or disk snapshot.

### Problem

The store has no canonical master-key port or production key-custody contract.
Placing an encryption key beside the data would not change the threat boundary,
while silently selecting a platform-specific backend would make headless
deployment behavior unpredictable.

### Affected scenarios

- Provider credentials and external-service authentication material.
- Host backups, virtual-machine snapshots, and copied data directories.
- Headless private deployments without an interactive credential service.
- Key rotation, disaster recovery, and secret revocation.

### Possible solution paths

1. Require a system credential backend by default and support an explicitly
   configured external key provider for headless deployments.
2. Use authenticated envelope encryption, bind ciphertext metadata to the
   secret identity and revision, and keep all key material out of settings,
   arguments, logs, and reports.
3. Replace plaintext records atomically under the existing mutation lock,
   fail closed when the selected key backend is unavailable, and do not keep a
   local-file key fallback.
4. Verify wrong-key denial, metadata substitution, tampering, rotation,
   revocation, crash recovery, and backup inspection.

## 3. Give Durable Maintenance Runs Current Governed Authority

### Background

The
[maintenance work-queue provider](../packages/server-runtime/src/composition/maintenance-work-queue-provider.mjs)
binds queued work to a plan hash and approval digest. Scheduled, retried, or
recovered work is dispatched as a system actor, but the durable run does not
carry a current Grant reference and policy binding that can be revalidated
before execution.

### Problem

A persisted plan or approval digest proves historical agreement; it is not a
current governed execution permit. Revocation, expiry, a policy revision, or a
scope change may occur after enqueue and before a retry or protected effect.
Creating a queue-specific authorization shortcut would introduce a second
authority model.

### Affected scenarios

- Scheduled maintenance and unattended repair.
- Retry after a transient failure.
- Queue recovery after process restart.
- Cancellation, approval withdrawal, or authorization changes while work is
  waiting.

### Possible solution paths

1. Bind each run to a dedicated Maintenance Agent workload principal and
   current workload Grant, including policy revision, operation set, resource
   scope, plan digest, approval, and expiry.
2. Alternatively, bind the initiating user's Grant or require fresh
   interactive authorization on every durable resume; document the resulting
   unattended-operation limitation.
3. Revalidate at queue claim, recovery, retry, lock acquisition, and
   immediately before the first protected effect.
4. Advance the durable schema once, fail closed existing non-terminal runs
   without the new binding, and remove authorization-skipping paths.

## 4. Isolate Plugin Console Code from Main-Console Browser Authority

### Background

The current
[plugin console router](../apps/console/router/plugin-console-routes.ts)
checks artifact digest, generation, route, feature, and scope before dynamically
importing a plugin module. It then gives that same-origin JavaScript an element
from the main console document. Provenance and route admission do not restrict
the module after execution begins.

### Problem

An admitted but compromised plugin console module has the browser authority of
the main console, including access to same-origin DOM and APIs. Meshrix has no
opaque-origin UI sandbox, independent plugin origin, or versioned capability
bridge.

### Affected scenarios

- Third-party administrative views and plugin-provided routes.
- A compromised signing or plugin publication path.
- Multi-administrator consoles with high-privilege sessions.
- Plugin revocation, route removal, and live session cleanup.

### Possible solution paths

1. Replace the module-mount ABI with an opaque-origin iframe using
   `sandbox="allow-scripts"` without `allow-same-origin`, form, or
   top-navigation privileges.
2. Expose a closed-schema, size-bounded, session-bound, entry-bound capability
   bridge over a versioned `MessageChannel`.
3. Use an independently controlled origin if the deployment can provide and
   verify that isolation boundary.
4. If console modules remain same-origin, classify them as trusted first-party
   code and narrow the admitted publisher set; do not describe that option as
   sandboxing.

## 5. Implement a Supervised, Fail-Isolated Optional-Adapter Runtime

### Background

Optional identity, telemetry, notification, provider, and external-service
integrations should extend an already operable Core. The release baseline names
an `integration-task-supervisor.mjs` implementation and a
`verify-integration-task-supervisor.mjs` verifier, but neither surface is
present in tracked source. Existing integrations use several different
composition and shutdown patterns.

### Problem

Core lacks one bounded lifecycle contract for adapter connect, activation,
execution, cancellation, retry, close, and degraded-state projection. A slow
or unavailable remote integration can therefore acquire too much influence
over startup or shutdown, while concrete adapters risk duplicating lifecycle
and privacy behavior.

### Affected scenarios

- OIDC, OTLP, webhook, model-provider, and external-service adapters.
- Remote dependencies that are absent, invalid, slow, or unavailable.
- Optional queue or datastore profiles such as PostgreSQL.
- Process shutdown while an adapter is connecting, retrying, or flushing.

### Possible solution paths

1. Add one Core-owned asynchronous supervisor with bounded concurrency,
   deadlines, cancellation, backoff, resource budgets, typed availability, and
   privacy-safe status.
2. Keep concrete implementations in their owning plugin plans; Core owns only
   versioned ports, neutral fixtures, default-off behavior, and isolation
   verification.
3. Preserve fail-before-listen for explicitly selected executable in-process
   plugins unless a complete supervised-plugin state-machine migration is
   selected. Do not silently reinterpret the existing deployment-integrity
   contract.
4. Keep PostgreSQL outside the single-node release until queue availability,
   accepted-work durability, activation, and recovery semantics are decided.

## 6. Build a Fully Offline Dual-Architecture Compose Artifact

### Background

The source [Compose definition](../docker-compose.yml) can build and verify a
local deployment. The current source package intentionally excludes installed
dependencies and container images, so the target host still needs network
access. The release boundary requires Linux x64 and ARM64 support.

### Problem

Meshrix does not yet have one verified offline artifact containing every
immutable image and installation dependency, with an exact inventory, SBOM,
signature, and platform binding. A source archive or a locally cached build is
not sufficient evidence for an air-gapped clean-host installation.

### Affected scenarios

- Air-gapped and restricted-network enterprise deployment.
- Disaster reinstall when public registries are unavailable.
- Architecture-specific image and dependency validation.
- Supply-chain review of the exact deployable artifact.

### Possible solution paths

1. Assemble a platform-bound OCI layout or equivalent offline image archive
   together with all required package artifacts and the Compose definition.
2. Pin every image, dependency, and base artifact by immutable digest and
   generate an exact inventory, per-platform SBOM, checksums, and signatures.
3. Verify extraction, inventory integrity, installation, startup, governed
   operation, and shutdown on clean Linux x64 and ARM64 hosts with public
   network access disabled.
4. Reuse the canonical release assembly and signing authorities instead of
   creating a second offline publication path.

## 7. Select and Prove the Production TLS and Startup-Security Boundary

### Background

The default server is a loopback HTTP service. Production deployment currently
delegates TLS termination to an administrator-managed reverse proxy, while the
release baseline requires mounted TLS material, secure startup preflight, and
privacy-safe failure diagnostics. No concrete TLS owner and versioned ingress
contract has been selected.

### Problem

The project cannot yet prove certificate readiness, reload behavior, trusted
proxy bounds, forwarded identity, external-admission failure, and diagnostics
as one production ingress contract. Selecting a specific gateway framework in
Core would also make an optional third-party implementation part of the server
lifecycle.

### Affected scenarios

- Non-loopback private deployment.
- Certificate rotation and expired or malformed certificate material.
- Reverse-proxy outage or misconfiguration.
- Forwarded client identity, secure cookies, health checks, and audit origin.

### Possible solution paths

1. Keep TLS in an administrator-owned reverse proxy and define a Core ingress
   contract for trusted proxy bounds, identity forwarding, readiness, health,
   and failure reporting.
2. Implement a Core-owned TLS listener if certificate custody and reload must
   be part of the Core availability contract.
3. Package gateway implementations as optional adapters while ensuring their
   absence blocks external admission, not bounded Core startup and shutdown.
4. Verify malformed, missing, expired, rotated, and untrusted material without
   exposing certificate paths or private runtime details.

## 8. Prove Independent Backup and Clean-Host Restore

### Background

Meshrix implements manifest verification, SQLite online backup, offline
restore, crash journaling, rollback storage, and a production restore drill.
The enterprise release boundary additionally requires backups to an explicitly
configured independent mount and recovery on a clean host.

### Problem

Current local storage mechanics do not by themselves prove that a lost or
unusable server can be rebuilt from independently retained material. Backup
location admission, portable custody metadata, required-key recovery, and the
complete clean-host operator journey are not closed as one receipt.

### Affected scenarios

- Host or disk loss.
- Corruption, accidental deletion, and failed repair.
- Migration to replacement infrastructure.
- Recovery from an offline or separately retained backup generation.

### Possible solution paths

1. Require an explicit independent backup target; keep empty configuration
   non-executable and reject targets inside governed live storage.
2. Bind the backup manifest, data generation, required public metadata, and
   restoration prerequisites without embedding secrets.
3. Run the registered backup operations and restore drill on a clean host,
   including integrity failure, interrupted restore, and runtime reopen.
4. Define measurable recovery-time and capacity budgets after functional
   correctness is closed.

## 9. Implement N-1 Upgrade with Failure Rollback

### Background

The release baseline requires a preflighted N-1 upgrade with pre-upgrade
backup, atomic migration, health validation, and rollback. It names an upgrade
rollback verifier, but the tracked source does not yet contain the planned
upgrade workflow and verifier.

### Problem

An operator cannot prove that a failed application or schema upgrade returns
the node to the last healthy version without losing governed state. Running a
new binary and relying on manual backup recovery leaves version switching,
migration commit, health admission, and rollback ordering unspecified.

### Affected scenarios

- Routine enterprise maintenance.
- Schema or data migration failure.
- Crash or power loss during an upgrade.
- A new version that starts but fails health or governed-operation checks.

### Possible solution paths

1. Add compatibility preflight, independent pre-upgrade backup, staged
   artifacts, one durable migration transaction, and an atomic active-version
   switch.
2. Admit the new version only after bounded health and governed-operation
   checks; otherwise restore the prior data generation and executable version.
3. Use backup-based rollback instead of retaining a permanent legacy runtime
   or compatibility implementation.
4. Verify failures before migration, at each commit boundary, after startup,
   and during rollback, then prove the healthy retry path.

## 10. Close Emergency Administrator Recovery and Real External Identity

### Background

Core has local console authentication and stores OIDC configuration through
governed operations. It does not implement OIDC discovery, authorization-code
callback, token exchange, key rotation, or external session establishment. The
release boundary also requires an audited emergency administrator path that
works without an external identity provider.

### Problem

Configuration storage can be mistaken for working enterprise identity
integration, while outage, disablement, role mapping, session revocation, and
administrator lockout semantics remain unresolved. Making an identity provider
a startup dependency would also violate the optional-adapter availability
boundary.

### Affected scenarios

- Enterprise single sign-on.
- Identity-provider outage or key rotation.
- Immediate offboarding and role reduction.
- First bootstrap, local administrator lockout, and emergency recovery.

### Possible solution paths

1. Keep audited emergency administrator recovery and its disablement controls
   in Core, independent of every external identity provider.
2. Define one versioned external-identity port and implement generic OIDC in
   an independently owned adapter verified against synthetic peers.
3. Version named provider profiles separately from generic protocol
   conformance and avoid provider-specific behavior in Core.
4. Decide whether provider disablement revokes existing sessions immediately
   or at bounded revalidation, then verify outage isolation, role mapping,
   audit coverage, and session termination.

---

## Appendix: Maintenance Standard

Current behavior remains owned by source, schemas, registries, capability
documents, and verifiers. Possible solution paths are alternatives for
evaluation; a selected durable decision must be recorded in the owning formal
document and implemented before it becomes a project fact.

- Keep exactly ten active problems in this file, ordered from highest to
  lowest priority.
- Every problem must contain **Background**, **Problem**, **Affected
  scenarios**, and **Possible solution paths**.
- Include only gaps that can be reproduced from tracked source, configuration,
  protocol, or verifier behavior. Do not rank work from unreviewed runtime
  data, private evidence, popularity, or speculative demand.
- Close a problem only after the owning implementation, focused verification,
  and required acceptance evidence agree. Remove the closed entry instead of
  retaining a completed history, promote the remaining entries, and add the
  next highest-value open problem.
- Re-rank when a security boundary, release dependency, supported deployment
  profile, or objective implementation fact changes. A rank change does not
  authorize implementation or weaken an existing fail-closed boundary.
