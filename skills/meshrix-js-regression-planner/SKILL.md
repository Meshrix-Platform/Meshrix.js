---
name: meshrix-js-regression-planner
description: Select the smallest repository-owned Meshrix.js regression closure for changed files or a named capability.
---

# Meshrix.js Regression Planner

## Select the closure

Start from the changed files and the scripts in `package.json`. Prefer the
narrowest typecheck, verifier, or test suite that owns the changed behavior.
Include direct consumers, configuration, registries, generated projections,
tests, and documentation when their contract changed.

Read the command and its inputs before choosing it; do not run `npm test` as
a prerequisite for selecting verification. Documentation-only changes need
referenced-path, command, and fact checks. Skill changes use
`npm run verify:skills`; documentation changes use the relevant documentation
verifier. They do not require runtime acceptance without a behavior or release
claim that needs it.

Operator helper changes also use `npm run verify:skill-tools` for synthetic
request, credential-delivery, and authorization-boundary behavior. Offline
packer changes use its `--contract` checks and `--dry-run` with an explicit
repository; those results do not claim a real container deployment. Skill
distribution changes use the distribution repository's `npm test` and
`npm run validate`. These are maintenance checks, not added Core release gates.

For source behavior, repository-level fallbacks are:

```sh
npm run typecheck
npm run build
npm test
```

These commands are alternatives selected by the changed behavior, not a
mandatory sequence for every task. `npm test` runs the `core-public` profile.
Use `npm run verify:acceptance` for a functional-completeness release claim,
after its required current evidence is ready. Reuse results for unchanged
inputs and claims. Use `npm run repo:local-info-hygiene` before publication.

## Discover failures and finish

Complete the selected diagnostic scope before repairing individual failures.
Collect failures from every safely executable independent suite and record
unexecuted dependency-bound checks explicitly; an early stop never proves that
all defects are known. A continuous user journey follows
`$meshrix-js-checkpoint-real-validation`: freeze the failed attempt, preserve
its failure packet, and follow its repair handoff instead of crossing a failed
checkpoint. This does not authorize unsafe discovery or override an applicable
AGENTS.md requirement for maintainer direction.

Run one final complete regression for the selected outcome only after all
changes, source review, in-scope repairs, and focused checks are complete.
Do not disguise a full regression as a diagnostic run to bypass that limit.
If final regression fails, diagnose and report the concrete repair and
verification proposal; the developer decides whether to repair and rerun.
Do not automatically loop. A successful unchanged receipt may be reused, but a
failed or partial result never establishes completion.

## Bound side effects

Static checks and build output may run by default. Network access, protected
runtime data, container startup, destructive reset, and publication require
explicit authorization. Authorization already provided for the same target,
operation, and side-effect scope remains valid; do not request it again.
New targets or materially different effects require additional authorization.
A command flag records admission but does not itself grant user authority.
Prepare the concrete operation and continue independent authorized work while
any required decision is pending.

A skipped or unavailable environment-specific check does not invalidate an
unrelated source claim. Its qualification remains with the owning workflow and
blocks this task only when the accepted outcome requires that environment.
