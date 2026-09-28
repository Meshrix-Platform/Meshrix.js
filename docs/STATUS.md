# Meshrix.js Status

Status is determined from candidate-bound evidence, not from a calendar
snapshot, roadmap, or completed planning workspace.

This document records whether the current product can be used. Product
completion is decided by working runtime behavior, the functional acceptance
gate, and a healthy deployed instance. Publication channels, compatibility
matrices, and environment-qualification programs do not block deployment or
ordinary use.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Product direction** | Complete the `0.0.1` single-node public release of the Core platform and programmable gateway. The previously accepted Core deployment and the current gateway convergence candidate have separate evidence. |
| **Implementation** | Core includes the Server, Web Console, security, storage, jobs, governed operation dispatch, plugin contract, and standard MCP ingress. Optional plugins, independent services, external providers, model services, Agent products, and named-client scenarios retain separate opt-in lifecycles. |
| **Verification** | `npm test` is the core public regression. `npm run verify:acceptance` is the single product-level functional gate. Focused checks are used only to repair concrete failures before that final gate. |
| **Operation** | Existing production evidence describes an earlier accepted Core candidate. It does not establish the current gateway candidate's deployment or present service health. A supported deployment uses one `runtime-ui` process with one public origin: Console at `<server-url>/`, API at `<server-url>/api/`, and health at `<server-url>/api/healthz`. |
| **Publication** | The source repository is public. The root source license is MIT; dependency licenses apply separately. The current release definition is a candidate, and no public release is recorded in [release history](releases/README.md). |

## Production-use evidence

Run `npm run verify:production-closure` to reduce the current accepted
generation, existing-target Linux deployment receipt, live Core checks, active
service state, and branch-promotion receipt. A pass is valid only when every
input binds the same immutable commit and candidate digest. The generated
report remains under `build/`; it is operational evidence rather than a second
roadmap or product authority.

Nightly, stable, and release branch equality is candidate-promotion evidence;
it is not a tag, package publication, image publication, GitHub Release, or
public release asset. Subsequent source changes do not inherit an earlier
candidate's acceptance or deployment claim.

Public package publication is required for the current public-release outcome;
it does not retroactively invalidate the earlier Core acceptance. Broad
operating-system qualification, named-client certification, cloud matrices, and
multi-node operation retain their separate evidence boundaries.

## Gateway convergence candidate

The repository contains the focused `@meshrix/gateway` candidate and its
modern/legacy MCP adapters. The gateway work in
[PR #82](https://github.com/Meshrix-Platform/Meshrix.js/pull/82) is a development
candidate, not an accepted release. A source revision must be frozen after the
scoped repairs before acceptance or performance results can bind to it.

Focused deterministic gateway tests cover protocol, authorization, cancellation,
durable effect boundaries, crash recovery, and lifecycle behavior. Node and Web
builds, test and Web type checks, and clean-container installation of the 18
unmodified public packages have passed for the integrated source. The packaged
Core starts and serves its health, bootstrap, and RPC health contracts with native
storage. A passing engineering check does not establish external-client
adoption, publication, full-repository acceptance, or benchmark readiness.
Benchmark work requires the same candidate's actual backend, Console, standard
MCP-to-upstream, and orderly shutdown evidence as defined in
[the repository rules](../AGENTS.md#functional-availability-before-benchmarking-and-optimization).

## Public-release acceptance

The release scope is the existing single-node Core platform with Web Console,
standard MCP access, governed upstream services, and the independently embeddable
gateway. Optional integrations remain opt-in. Hosted operation and multi-node
availability are not claims of this release.

| Boundary | Required result | Current candidate evidence |
| --- | --- | --- |
| Runtime and protocol | Use the exact Node range in `package.json`; enforce MCP `2026-07-28` on the modern HTTP boundary and isolate the declared legacy profiles. Any conforming client can use authorized capabilities without a product-name allowlist. | Focused adapter and production-route checks verify required metadata, HTTP header mirrors, stdio transport behavior, notification responses, and private cache metadata. Independent HTTP client fixtures also cover the modern wire contract. Full candidate acceptance remains pending. |
| Authorization and lifecycle | Reject untrusted supplied browser origins before CLI dispatch, preserve native clients without Origin, propagate cancellation, and close active streams and owned upstream resources normally. Standalone request lifetime follows caller and service cancellation rather than a separate fixed operation deadline. | Focused checks pass for Origin rejection, cancellation, HTTP stream shutdown, stdio output backpressure and owned-child cleanup. Protected upstream dispatch rechecks authority after discovery, session initialization, DNS resolution, or queued writes; controlled revocation checks observe zero effect calls. |
| Recovery | Authorized non-read remote effects require durable pre-effect intent, a durable dispatch boundary, and conservative uncertain outcomes that never authorize blind replay. Preserve the documented offline storage-restore boundary. Optional public gateway receipt lookup and continuation-key restoration are separate capabilities. | Standalone serving uses its owned SQLite intent ledger; discovered platform MCP effects use the existing operation-proof lifecycle and durable dispatch receipt. Deterministic process tests pass for completion, storage failure, crash/reopen uncertainty, no automatic resend, and read calls without effect records. Terminal outcomes follow result validation. Offline restore has an implementation and focused tests; the current candidate's operator restore procedure and live drill remain unverified. |
| Distribution | Ship the release registry's package set and `runtime-ui` target for `linux/amd64` and `linux/arm64`; test the unmodified artifacts intended for publication in clean consumers. | Release-definition and preparation checks pass. Before the Pactium dependency refresh, complete Node/Web builds and a clean-container consumer of all 18 unmodified public packages passed, including packaged CLI, Core startup, health/bootstrap/RPC, and native storage. The runtime dependency now resolves the publicly verified `pactium@0.8.1` MIT package. Node outputs and clean-consumer evidence must be qualified against the exact dependency candidate; earlier artifact results do not certify changed dependency bytes. The independent source archive retains `pactium@0.8.0` under its original GPL-3.0-or-later identity. These package facts do not qualify the complete Meshrix.js distribution. Both target architectures still require their release-deployment evidence. |
| Functional acceptance | Complete source review and deterministic engineering verification, then obtain candidate-bound evidence for the actual backend, Console action, standard MCP upstream operation, and normal cleanup. | Historical acceptance cannot be reused for the changed gateway candidate. The separately assigned live-acceptance workflow supplies the remaining external evidence. |
| Performance and public claims | Publish reproducible measurements tied to immutable candidate and comparison versions, equivalent capabilities and security settings, synthetic workloads, resource limits, and observed failures. | No current candidate-bound comparison establishes industry-leading throughput, latency, or reliability. Benchmark validation and optimization wait for functional availability. |
| Public entry points | Provide accurate source setup, security reporting, release status, license information, and canonical documentation through `meshrix.io`; verify the selected HTTPS host. | Website source now provides product capabilities, source setup, documentation, security, and release-status links. Static content and link checks pass. Deployed HTTPS availability, visual acceptance, and public release artifacts remain unverified for this candidate. |

These are finite release acceptance conditions. Task ownership and execution
receipts belong to the delivery workflow; this document records product status.
Update each evidence statement when its owning verification has actually passed.
