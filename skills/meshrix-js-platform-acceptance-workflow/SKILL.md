---
name: meshrix-js-platform-acceptance-workflow
description: Run or inspect the canonical Meshrix.js functional-completeness release gate and its aggregate evidence report. Use for functional release acceptance, acceptance task changes, or aggregate development-environment evidence validation. The optional real-machine verification workflow is owned by $meshrix-js-real-machine-verification.
---

# Meshrix.js Platform Acceptance Workflow

This skill owns the **functional-completeness release gate** for Meshrix.js
and its aggregate evidence report. The optional real-machine verification
workflow belongs to `$meshrix-js-real-machine-verification`.

## Protect functional-release authority

Treat the core acceptance reducer as the only mandatory authority for the
Meshrix.js `functional-complete` release claim. Its project-level result is either
`accepted` or `failed`; missing, stale, or invalid mandatory functional
evidence is a failure, not a project-level blocked state.

Real-machine execution, publisher identity, credential, signing, notarization,
listing, store access, and network-server availability are outside this
mandatory claim. They must not make functional acceptance or an otherwise
eligible project release fail.

The optional real-machine workflow may run only after consuming a current,
candidate-bound `functional-complete` receipt. It may issue an environment
support claim for the tested candidate and target, but it must never revoke,
block, or replace functional acceptance. Layer tests and claim-specific
profiles supply scoped evidence; they do not independently establish another
claim's readiness. Use `$meshrix-js-real-machine-verification` for that
workflow.

Plan with `npm run verify:acceptance:plan`. Confirm that every selected task declares its dependencies, locks, timeout, side-effect class, and owner.

Run targeted and layer checks before the acceptance task. Required
development-environment simulations belong to functional completeness and must
be repeatable. Do not run the reducer when required evidence is stale or
produced by an untrusted command path.

A functional-completeness claim requires current evidence that every protected sink
consumes a governed permit; mandatory compact receipts survive the required
retention and crash boundaries; routine telemetry has zero unbounded
per-request growth; and optional telemetry sheds safely under pressure. A child
report may establish only its scoped evidence readiness.

## Handle evidence

Keep planning read-only. Write reducer-owned reports only during an explicit workflow run. Do not let plan mode overwrite acceptance evidence.

Report the reducer status, task IDs, counts, and sanitized failure categories. Never infer a pass from truncated logs or manually assembled command lists.

## Boundaries

Do not run real-machine or environment qualification from this skill; those
belong to `$meshrix-js-real-machine-verification`. The real-machine workflow
never changes the functional acceptance result.
