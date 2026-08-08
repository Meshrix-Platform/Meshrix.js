# What's Next: Highest-Value Open Problems

This file ranks Meshrix.js's ten highest-value open problems; item 1 is the
highest priority. It is a factual index, not an execution plan, architecture
decision, acceptance receipt, release result, or support claim. Current status
belongs to [Status](STATUS.md).

## 1. Freeze One Enterprise Single-Node Candidate

### Background

Meshrix.js has broad server, console, governance, storage, gateway, and release
surfaces. Its release definition can name a candidate, and its Functional
Release Gate can reduce repository-owned evidence.

### Problem

The current source is not represented by one immutable, auditable candidate
whose scope, package inventory, artifacts, required reports, and verification
commands all agree. Without that binding, prior or focused results cannot
establish a current candidate result.

### Affected scenarios

- Maintainer release review.
- Enterprise installation evaluation.
- Reproducing a candidate from source.
- Binding every later recovery and environment receipt.

### Possible solution paths

1. Freeze the source revision, tree, lockfile, package set, container digests,
   support boundary, and required report owners.
2. Reject stale, skipped, differently scoped, or differently bound evidence.
3. Keep publication and environment workflows downstream of the immutable
   candidate instead of using them to define it.
4. Run the complete Functional Release Gate once after the next four priority
   journeys have closed on the same candidate.

## 2. Prove the First Governed Call

### Background

The repository contains authentication, Operation Permission, downstream MCP,
upstream HTTP/MCP gateway, protected-sink permit, proof, and audit surfaces.

### Problem

Meshrix.js still needs one minimal candidate-bound journey showing that a newly
configured single-node deployment can admit one explicit principal, expose one
allowed operation, consume one exact permit, produce at most one fixed
upstream effect, and return a bounded outcome and receipt. The same journey
must prove denial, revocation, replay, conflict, cancellation, and uncertain
outcome behavior without additional effects.

### Affected scenarios

- A first-time operator validating the product.
- An agent client discovering and invoking its first operation.
- Security review of the canonical governance path.
- Regression triage when a protocol or authorization boundary changes.

### Possible solution paths

1. Use a neutral MCP peer and a synthetic fixed upstream; do not depend on a
   client, plugin, or service repository.
2. Drive configuration, grant, discovery, call, protected sink, outcome,
   audit, and cleanup through production-owned entry points.
3. Count upstream attempts and prove every negative case produces zero
   additional effects.
4. Bind the redacted journey receipt to the frozen candidate and make it a
   mandatory Functional Release Gate input.

## 3. Close the Operator Diagnostics Journey

### Background

Meshrix.js exposes health, readiness, diagnostics, metrics, audit, job, storage,
and integration-state surfaces. It also applies privacy and resource bounds to
reports and telemetry.

### Problem

The product lacks one candidate-bound operator journey proving that startup,
configuration, authentication, upstream, storage, backup, resource, and
optional-integration failures can be distinguished through bounded output
without raw requests, responses, credentials, paths, identities, or private
runtime data.

### Affected scenarios

- Failed initial installation.
- Degraded upstream or optional integration.
- Storage pressure and backup failure.
- Incident response without access to developer internals.

### Possible solution paths

1. Define a small stable diagnostic reason taxonomy and the owning source for
   every projected state.
2. Exercise healthy, degraded, unavailable, saturated, and recovery cases
   against a single-node deployment.
3. Prove optional telemetry can be shed while required governance evidence
   fails closed.
4. Bind the diagnostic receipt and privacy result to the candidate.

## 4. Prove Independent Backup and Clean-Root Restore

### Background

Meshrix.js implements backup manifests, SQLite online backup, integrity checks,
offline restore, rollback storage, crash reconciliation, and independent-root
admission.

### Problem

Those mechanisms need one repeatable same-candidate closure proving that an
operator can restore independently retained material into an empty replacement
root, rejoin separately custodied keys without copying them into the backup,
reopen the runtime, and complete the first governed call.

### Affected scenarios

- Disk or host loss.
- Corruption or accidental deletion.
- Replacement infrastructure.
- Recovery before an upgrade retry.

### Possible solution paths

1. Require an explicit backup root outside governed live storage.
2. Bind the backup generation, manifest, public prerequisites, and candidate
   without retaining secrets or business content.
3. Exercise tamper, interruption, wrong-key, partial-selection, and runtime
   reopen failures.
4. Re-run the first governed call after restore and reduce one privacy-safe
   clean-root receipt.

## 5. Prove N-1 Upgrade and Failure Rollback

### Background

The repository contains candidate upgrade orchestration and focused verification
for preflight, backup, migration, health admission, rollback, and `in_doubt`
classification.

### Problem

Upgrade support still requires two distinct immutable images and an actual
schema transition. The journey must prove that failure before or after each
commit boundary restores the previous executable and governed data generation,
or reports an honest non-automatic recovery state.

### Affected scenarios

- Routine enterprise maintenance.
- Schema migration failure.
- New version startup or health failure.
- Process loss during activation or rollback.

### Possible solution paths

1. Bind the N-1 source and destination images, schema identities, backup, and
   activation decision.
2. Admit the new image only after readiness and the first governed call pass.
3. Exercise each durable boundary, rollback, reopen, and healthy retry.
4. Use backup-based rollback and remove any temporary compatibility path after
   the migration closes.

## 6. Produce a Complete Offline Installation Artifact

### Background

The source Compose path can build and run locally, but source archives and
ordinary image caches do not constitute a disconnected installation artifact.

### Problem

Meshrix.js lacks one candidate-bound package containing every required immutable
image and installation dependency together with inventory, SBOM, provenance,
signature, extraction, verification, startup, shutdown, and cleanup procedures.

### Affected scenarios

- Air-gapped enterprise installation.
- Disaster reinstall without public registries.
- Supply-chain inspection of the exact deployed bytes.
- Separate Linux architecture support claims.

### Possible solution paths

1. Build platform-bound OCI layouts with exact dependency inventories.
2. Verify digests, signatures, SBOMs, provenance, and dependency completeness
   before loading anything on the target.
3. Prove a network-disabled install and the first governed call.
4. Keep native Linux x64 and arm64 support as separate downstream environment
   claims.

## 7. Close Production Ingress and Key Custody

### Background

Meshrix.js has a trusted-proxy ingress contract, encrypted local secret storage,
separate proof-signing material, and fail-closed production configuration
surfaces.

### Problem

The candidate needs one complete operator journey for certificate and proxy
admission, key creation, rotation, recovery, wrong-key denial, signer-history
verification, and diagnostics. A configured path or synthetic component test
does not establish deployed support.

### Affected scenarios

- Non-loopback private deployment.
- TLS or proxy misconfiguration.
- Secret-store or signer-key rotation.
- Clean-root recovery with independent custody.

### Possible solution paths

1. Keep TLS in the administrator-owned proxy unless Meshrix.js deliberately
   selects a different product boundary.
2. Expose existing re-encryption through one governed operator operation.
3. Retain only the minimum historical verification material.
4. Prove malformed, missing, substituted, expired, rotated, and unavailable
   inputs without exposing private values.

## 8. Isolate Emergency Administration from External Identity

### Background

Meshrix.js has local console authentication and configuration surfaces for
external identity. An optional identity provider must not own Meshrix.js startup,
shutdown, or recovery.

### Problem

The candidate needs an audited emergency-administrator journey that survives
external identity absence or outage. Configuration storage must not be
presented as working OIDC login, and external-session revocation semantics
remain separately owned.

### Affected scenarios

- First bootstrap and administrator lockout.
- Identity-provider outage or key rotation.
- Immediate offboarding and role reduction.
- Recovery while optional integrations are unavailable.

### Possible solution paths

1. Keep emergency administration self-contained and explicitly controllable.
2. Give external identity one versioned optional port and independent receipt.
3. Define session revalidation and revocation behavior before claiming support.
4. Prove external identity failure never bypasses authority or blocks bounded
   local recovery.

## 9. Isolate Plugin Console Code

### Background

Plugin provenance and route admission can be checked before a browser module
is loaded, but admitted same-origin JavaScript still receives the main
console's browser authority.

### Problem

An admitted but compromised plugin console module can access same-origin DOM
and APIs beyond a narrow feature contract. Provenance is not browser
isolation.

### Affected scenarios

- Third-party administrative views.
- Compromised plugin publication.
- High-privilege console sessions.
- Plugin revocation during a live session.

### Possible solution paths

1. Use an opaque-origin sandbox with a closed, versioned capability bridge.
2. Bind every message to session, route, plugin generation, scope, and size.
3. Use an independently controlled origin when the deployment supports it.
4. If same-origin execution remains, classify it as trusted first-party code
   instead of describing it as sandboxed.

## 10. Complete Optional-Integration Runtime Migration

### Background

Meshrix.js has a common bounded supervisor for optional asynchronous integration
work, while concrete integrations still use multiple composition and shutdown
patterns.

### Problem

An integration with an independent startup, retry, queue, execution, or close
loop cannot inherit the common isolation evidence and may influence Meshrix.js
availability beyond its capability.

### Affected scenarios

- External identity, telemetry, notification, model, and service adapters.
- Absent, invalid, slow, or unavailable remote dependencies.
- Shutdown while integration work is connecting or retrying.
- Separate enabled-path compatibility claims.

### Possible solution paths

1. Move each concrete integration to the common Host lifecycle in its owning
   repository or plan.
2. Remove the superseded lifecycle in the same migration.
3. Prove default-off, bounded degraded state, cancellation, retry, and close.
4. Keep every concrete integration outside the single-node candidate
   dependency graph unless the product boundary is explicitly changed.

## Maintenance standard

- Keep exactly ten active problems, ordered by current product value.
- Keep **Background**, **Problem**, **Affected scenarios**, and **Possible
  solution paths** for every entry.
- Describe only gaps reproducible from current source, configuration,
  protocol, or verifier ownership.
- Remove a closed problem after implementation, focused verification, and
  required same-candidate evidence agree.
- Never turn a proposal, plan, command, or prior report into a current status
  claim.
