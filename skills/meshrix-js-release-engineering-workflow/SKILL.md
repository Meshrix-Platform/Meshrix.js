---
name: meshrix-js-release-engineering-workflow
description: Plan, implement, and verify substantial Meshrix.js delivery against the repository release contract. This chapter belongs to $meshrix-js-developer-handbook. Published artifact shape belongs to $meshrix-js-release-artifact-contract.
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

Apply the common engineering workflow owned by `CONTRIBUTING.md`. Update the
canonical source first, migrate every owned consumer, regenerate derived
facts, and remove superseded names, paths, compatibility layers, fixtures,
tests, and documentation in the same change.

Use `$meshrix-js-regression-planner` to select focused checks and one final
integration scope. Complete source review and in-scope repairs before final
regression. Repair in-scope failures found during final verification and rerun
the affected checks. A functional-completeness release still requires
`npm run verify:acceptance` and its current required evidence; ordinary source
or documentation work does not acquire that release claim automatically.
Follow `docs/RUNBOOK.md` for release deployment and publication requirements.

Follow `AGENTS.md` for execution authority. Local build, install, data
migration, live acceptance, publication, push, and deployment are distinct
actions with separate evidence and authorization boundaries.

Offline delivery may run on Linux inside a virtual machine. Prefer Ubuntu;
accept Debian. Do not treat that path as native Linux support or as `npm run
verify:acceptance`.

## Release boundary

`.github/workflows/release-branch.yml` validates the exact stable authority,
performs the release deployment, creates or verifies the canonical tag at that
commit, and dispatches `.github/workflows/release.yml` at the tag. The release
workflow validates the exact originating run and waits for it to complete
before consuming its authority artifact. Direct tag pushes and API dispatches
share this one publication workflow; do not add a reusable caller or a second
publisher identity.

The release definition owns the version and Node/npm toolchain pins. Build and
prepare the `meshrix.js` and `@meshrix/gateway` npm archives once, before any
publication credential is available. Registry preflight and the publisher must
consume the same uploaded archive directory without repacking. Keep bootstrap
explicitly limited to the first version, `0.0.1`; ordinary publication uses
GitHub OIDC from the hosted `release.yml` publisher job. The publisher tests
each package's npm OIDC exchange before attempting a registry mutation. Its
GitHub workflow identity and environment are an intended configuration until
that package-specific hosted exchange succeeds; workflow refs alone do not
prove the npm-side match. See `docs/RUNBOOK.md` for hosted protection and npm
publisher setup requirements.

Commit only when covered by user authorization; treat push as a separate
publication decision. Review the exact staged tree before commit and the exact
outgoing commit range before push. A source task may finish with verified,
reviewable changes when no commit was requested. A requested publication stays
incomplete until its authorized publication steps finish.
Report only task identifiers, counts, statuses, timings, and irreversible
digests; never retain runtime payloads, credentials, machine identity, or local
paths.
