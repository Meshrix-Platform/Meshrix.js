---
name: meshrix-js-release-journey-producer
description: Run the optional Meshrix.js external-service integration journey and bind its existing report bundle to a candidate. Keep Core functional evidence and external compatibility claims separate.
---

# Meshrix.js Release Journey Producer

This skill owns the external-service integration journey and its candidate
receipt. `$meshrix-js-html-report-contract` owns the portable HTML projection;
`$meshrix-js-client-compatibility-matrix` owns client compatibility evidence;
`$meshrix-js-upstream-service-publishing` owns the publication transaction.

## Resolve the claim first

Read `docs/RUNBOOK.md` sections `Release Definition and Publication` and
`Upstream Service Publishing Functional Evidence`, then inspect the current
`package.json` entry points. The three operations have different prerequisites
and evidence meanings:

| Operation | Entry point | Scope |
| --- | --- | --- |
| Core publishing verifier | `npm run verify:upstream-service-publishing` | Synthetic isolated production-path evidence required by the Functional Release Gate. Starts local runtime fixtures. |
| External integration journey | `npm run verify:release-journey` | Optional service-and-adapter composition with explicitly supplied artifacts, containers, browser, and connector effects. |
| Candidate bundle verifier | `npm run verify:upstream-service-publishing-candidate` | Checks already-produced bytes against the clean immutable tag and writes a bounded receipt. Starts no runtime journey. |

The optional integration is neither a Core functional-acceptance input nor a
publication dependency. Its absence or failure cannot change a Core result.
The mandatory Release Deployment Verification remains governed by the Runbook;
an optional journey does not replace it.

## Prepare, execute, and bind

1. Inspect the working tree and preserve unrelated work. Read the
   [publishing contract](../meshrix-js-upstream-service-publishing/references/publishing-contract.md)
   when changing its capability or evidence contracts.
2. Inspect the integration steps without starting the journey:

   ```sh
   npm run verify:release-journey -- --plan
   ```

3. For an authorized integration, use the explicitly supplied adapter and
   converter image. Existing authorization for the same target, operation, and
   effects remains valid; new effects require a decision. Run once:

   ```sh
   npm run verify:release-journey -- --adapter-source <adapter-package-dir> --image-name <local-image>
   ```

4. Run the candidate bundle verifier only after the required current artifacts
   and the clean immutable tag already exist. Do not create or publish a tag
   merely to satisfy this verifier. Missing evidence is not a successful plan
   or a reason to rerun the same command unchanged.

Never discover floating sibling source trees or silently substitute artifact
owners. An explicit integration input does not become a Core dependency.

## Maintain and verify

For template changes, use `npm run generate:upstream-service-report-template`
and `npm run verify:upstream-service-report-template`. Generated reports remain
projections of verified reports and actual screenshot bytes; never hand-edit
them or turn a blank template into execution evidence. Select focused tests
with `$meshrix-js-regression-planner`, instead of running every release task
before an ordinary documentation change.

Read required artifact names and ordering from the release definition and
candidate verifier. The external receipt carries only
`upstream-publishing-prepublication-passed`; it cannot declare
`functional-complete`, whole-platform readiness, or untested compatibility.
After a failure, preserve truthful scoped evidence and follow the owning
repair and authorization rules before another attempt.
