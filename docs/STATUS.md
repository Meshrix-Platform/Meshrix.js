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
| **Publication** | The source repository is public. Project-owned source is licensed under Apache-2.0; dependency licenses apply separately. The current release definition is a candidate, and no public release is recorded in [release history](releases/README.md). |

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
candidate, not an accepted release. The current bounded functional evidence binds
candidate `df7dd9b9e49b2ec98dc32810c777e5ffb14f302b`. Later changes require
new affected evidence; they do not inherit this candidate's result.

Focused deterministic gateway tests cover protocol, authorization, cancellation,
durable effect boundaries, crash recovery, and lifecycle behavior. The prior MIT
dependency candidate passed its Node build and clean-container installation of
all 18 unmodified public packages, including packaged Core startup, native
storage, and health/bootstrap/RPC contracts. The first live diagnostic exposed
Console onboarding and gateway dispatch defects. Their corrections also address
discovery, scoped MCP tool selection, and unchosen request deadlines across the
platform and optional connector. The corrected candidate completed a bounded Linux
Core/Console/standard-MCP route: service publication, exact tool selection and
catalogs, an authorized upstream read, omitted-operation refusal, UI revocation,
revoked-client refusal, and normal shutdown and cleanup. These are recorded
observations for that candidate and configuration, not a new run or proof of
an autonomous Agent development task.

Changed source and artifacts require their own affected verification. The current
priority is actual first-use effectiveness and removal of avoidable user friction;
engineering checks and real user-task evidence remain separate. Benchmark work
requires the same candidate's actual backend, Console, standard MCP-to-upstream,
and orderly shutdown evidence as defined in
[the repository rules](../AGENTS.md#functional-availability-before-benchmarking-and-optimization).
Those prerequisites are recorded for the named Linux candidate; full-repository
acceptance, final distribution qualification and publication remain separate.

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
| Distribution | Ship the release registry's package set and `runtime-ui` target for `linux/amd64` and `linux/arm64`; test the unmodified artifacts intended for publication in clean consumers. | Release-definition and preparation checks pass. The runtime dependency resolves the publicly verified `pactium@0.8.1` MIT package. That dependency candidate passed its Node build and a fresh-container consumer of all 18 unmodified public packages, including packaged CLI, Core startup, health/bootstrap/RPC, and native storage. Subsequent platform and connector repairs change the intended artifacts, so exact final-artifact consumer evidence remains required; prior receipts apply only to their original bytes. The independent source archive retains `pactium@0.8.0` under its original GPL-3.0-or-later identity. These package facts do not qualify the complete Meshrix.js distribution. Both target architectures still require their release-deployment evidence. |
| Functional acceptance | Complete source review and deterministic engineering verification, then obtain candidate-bound evidence for the actual backend, Console action, standard MCP upstream operation, and normal cleanup. | The initial isolated diagnostic found adoption-blocking defects and remains a failed attempt. The repaired `df7dd9b` candidate subsequently passed the bounded actual Linux Core/Console/standard-MCP route, selected-tool and denial checks, UI revocation and normal cleanup. This is functional-availability evidence for that scenario, not the complete product-level acceptance gate or autonomous Agent task evidence. New user-journey improvements require affected engineering checks and actual revalidation. |
| Performance and public claims | Publish reproducible measurements tied to immutable candidate and comparison versions, equivalent capabilities and security settings, synthetic workloads, resource limits, and observed failures. | No current candidate-bound comparison establishes industry-leading throughput, latency, or reliability. One contained comparison completed its direct reference, but Meshrix.js admission errors left fixed-load legs incomplete and the comparator did not satisfy the selected discovery contract. No comparative ranking follows. Functional prerequisites are recorded for the named candidate; further work must diagnose the actual limitation and retain all failed results. Comparative performance does not replace user-journey effectiveness. |
| Public entry points | Provide accurate source setup, security reporting, release status, license information, and canonical documentation through `meshrix.io`; verify the selected HTTPS host. | Website source explains service connection, scoped client access, Core/Console and the standalone gateway, with source setup, documentation, security, and release-status links. Static checks and a local desktop/mobile browser observation passed. Local preview is not deployment evidence; hosted HTTPS availability and public release artifacts remain unverified. |

These are finite release acceptance conditions. Task ownership and execution
receipts belong to the delivery workflow; this document records product status.
Update each evidence statement when its owning verification has actually passed.
