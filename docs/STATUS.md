# Meshrix.js Status

Status is determined from the current candidate-bound evidence, not from a
calendar snapshot or an older planning receipt.

This document records whether the current product can be used. Product
completion is decided by working runtime behavior, the functional acceptance
gate, and a healthy deployed instance. Publication channels, compatibility
matrices, and environment-qualification programs do not block deployment or
ordinary use.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Product direction** | PLAN-005 is the current 0.0.1 Core production-use closure. Older convergence and release plans are historical provenance rather than parallel execution authority. |
| **Implementation** | Core includes the Server, Web Console, security, storage, jobs, governed operation dispatch, plugin contract, and standard MCP ingress. Optional plugins, independent services, external providers, model services, Agent products, and named-client scenarios retain separate opt-in lifecycles. |
| **Verification** | `npm test` is the core public regression. `npm run verify:acceptance` is the single product-level functional gate. Focused checks are used only to repair concrete failures before that final gate. |
| **Operation** | A usable deployment is one running `runtime-ui` process with one public origin: Console at `<server-url>/`, API at `<server-url>/api/`, and health at `<server-url>/api/healthz`. The current closure is incomplete until that instance is running and a real authenticated operation succeeds. |

## Production-use closure

The current work is complete only when all of the following are true:

1. concrete failing tests or runtime defects are fixed at their owning source;
2. the focused checks for those fixes pass;
3. one clean candidate passes `npm run verify:acceptance`;
4. that candidate is deployed to the existing Linux virtual machine;
5. health, Console delivery, authentication, and one governed operation work
   through the deployed public origin; and
6. the service remains running for real use.

Public package publication, broad operating-system qualification, client
compatibility certification, cloud matrices, and future multi-node work are
separate optional activities. They do not reopen or block this production-use
closure.

Nightly, stable, and release branch equality is candidate promotion evidence;
it is not a tag, package publication, image publication, GitHub Release, or
public release asset. A completion claim is valid only when the accepted
generation, existing-target Linux production-use receipt, and branch authority
receipt all bind the same immutable commit and candidate digest.

The current execution priority is [What's Next](WHATS-NEXT.md).
