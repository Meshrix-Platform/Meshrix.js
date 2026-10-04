---
name: meshrix-js-release-engineering-workflow
description: Plan, implement, and verify substantial Meshrix.js delivery against the repository release contract. This chapter belongs to $meshrix-js-developer-handbook. Published artifact shape belongs to $meshrix-js-release-artifact-contract.
audience: development
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
the affected checks. Release acceptance uses `npm run verify:acceptance`; its
existing profile runs exact-artifact npm consumer qualification on discovered
available targets. At least one complete platform must qualify, and every
selected target must pass. Ordinary source or documentation work does not
acquire release claims automatically. Follow `docs/RUNBOOK.md` for optional
deployment and publication requirements.

Follow `AGENTS.md` for execution authority. Local build, install, data
migration, live acceptance, publication, push, and deployment are distinct
actions with separate evidence and authorization boundaries.

Offline delivery may run on Linux inside a virtual machine. Prefer Ubuntu;
accept Debian. Do not treat that path as native Linux support or as `npm run
verify:acceptance`.

## Release boundary

`.github/workflows/release.yml` is the normal npm publication workflow. A
`v*` tag push or manual dispatch from that tag checks out the selected source,
confirms that its version matches package metadata, runs the applicable build
and release tests, packs and smoke-tests the `meshrix.js` and
`@meshrix/gateway` archives, publishes those archives to npm through standard
GitHub Actions Trusted Publishing, and creates a GitHub Release.

The release definition owns the version and Node/npm toolchain pins. Existing
npm Trusted Publisher configuration uses the `release-candidate` GitHub
environment. For first publication, the temporary `NPM_BOOTSTRAP_TOKEN`
environment secret is exposed as `NODE_AUTH_TOKEN` to create packages that do
not yet exist; configure Trusted Publishing once the packages exist and then
remove the secret. Do not make stable-branch promotion a release prerequisite,
or add cross-workflow run identifiers, custom OIDC probes, or
candidate receipts as extra publication steps. Branch maintenance remains
separate from npm publication. The [release runbook](../../docs/RUNBOOK.md#release-definition-and-publication)
owns the exact operator steps.

Commit only when covered by user authorization; treat push as a separate
publication decision. Review the exact staged tree before commit and the exact
outgoing commit range before push. A source task may finish with verified,
reviewable changes when no commit was requested. A requested publication stays
incomplete until its authorized publication steps finish.
Report only task identifiers, counts, statuses, timings, and irreversible
digests; never retain runtime payloads, credentials, machine identity, or local
paths.
