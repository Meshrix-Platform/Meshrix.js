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
| **Product direction** | The 0.0.1 Core single-node production-use closure is complete. There is no standing project plan or perpetual roadmap; new work comes from real use, an explicit product decision, or a concrete defect. |
| **Implementation** | Core includes the Server, Web Console, security, storage, jobs, governed operation dispatch, plugin contract, and standard MCP ingress. Optional plugins, independent services, external providers, model services, Agent products, and named-client scenarios retain separate opt-in lifecycles. |
| **Verification** | `npm test` is the core public regression. `npm run verify:acceptance` is the single product-level functional gate. Focused checks are used only to repair concrete failures before that final gate. |
| **Operation** | The accepted Core candidate recorded by the current production evidence is deployed and active on the existing Linux virtual machine. A usable deployment remains one running `runtime-ui` process with one public origin: Console at `<server-url>/`, API at `<server-url>/api/`, and health at `<server-url>/api/healthz`. |

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

Public package publication, broad operating-system qualification, client
compatibility certification, cloud matrices, and future multi-node work remain
separate optional activities. They do not reopen the completed Core
production-use closure.
