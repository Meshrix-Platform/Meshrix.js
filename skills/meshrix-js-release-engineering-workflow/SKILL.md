---
name: meshrix-js-release-engineering-workflow
description: Plan, implement, and verify substantial Meshrix.js delivery against the private repository release contract. This chapter belongs to $meshrix-js-developer-handbook. Published artifact shape belongs to $meshrix-js-release-artifact-contract.
---

# Meshrix.js Release Engineering Workflow

This chapter belongs to `$meshrix-js-developer-handbook`. It owns delivery
workflow. The published artifact shape and public address contract belong to
`$meshrix-js-release-artifact-contract`. Operating a running instance belongs
to `$meshrix-js-user-handbook`.

## Establish the candidate

1. Run `git status --short` and preserve unrelated work.
2. Identify the exact product capability, canonical fact owner, consumers,
   generated artifacts, tests, documentation, and release surfaces affected.
3. Keep one independently acceptable feature or migration closure active at a
   time.

## Implement and verify

Update the canonical source first, migrate every owned consumer, regenerate
derived facts, and remove superseded names, paths, compatibility layers,
fixtures, tests, and documentation in the same change.

Use `$meshrix-js-regression-planner` to select focused checks and one final
integration scope. Complete source review and in-scope repairs before final
regression. A functional-completeness release still requires
`npm run verify:acceptance` and its current required evidence; ordinary source
or documentation work does not acquire that release claim automatically.
Follow `docs/RUNBOOK.md` for the separate release deployment and publication
requirements. Final-regression failures return to the developer for the repair
and rerun decision rather than starting an automatic loop.

A protected resource, runtime-data probe, publication, or external effect
requires explicit authorization and exact scope. Reuse existing authorization
for the same target, operation, and effects; do not ask again for an unchanged
authorized step.

Offline delivery may run on Linux inside a virtual machine. Prefer Ubuntu;
accept Debian. Do not treat that path as native Linux support or as `npm run
verify:acceptance`.

## Release boundary

Commit only when covered by user authorization; treat push as a separate
publication decision. Review the exact staged tree before commit and the exact
outgoing commit range before push. A source task may finish with verified,
reviewable changes when no commit was requested. A requested publication stays
incomplete until its authorized publication steps finish.
Report only task identifiers, counts, statuses, timings, and irreversible
digests; never retain runtime payloads, credentials, machine identity, or local
paths.
