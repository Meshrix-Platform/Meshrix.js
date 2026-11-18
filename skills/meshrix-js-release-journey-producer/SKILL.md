---
name: meshrix-js-release-journey-producer
description: Run the optional Meshrix.js external-service integration journey and report its observed results. Keep Core functional evidence and external compatibility claims separate.
audience: development
---

# Meshrix.js Release Journey Producer

This skill owns the optional external-service integration journey and its
human-readable report. `$meshrix-js-html-report-contract` owns the portable HTML
projection; `$meshrix-js-client-compatibility-matrix` owns client compatibility
evidence; `$meshrix-js-upstream-service-publishing` owns the service publication
transaction.

## Resolve the claim first

Read `docs/RUNBOOK.md` sections `Release Definition and Publication` and
`Upstream Service Publishing Functional Evidence`, then inspect the current
`package.json` entry points:

| Operation | Entry point | Scope |
| --- | --- | --- |
| Core publishing verifier | `npm run verify:upstream-service-publishing` | Synthetic isolated production-path checks of the service publishing capability. |
| External integration journey | `npm run verify:release-journey` | Optional service-and-adapter composition with explicitly supplied artifacts, containers, browser, and connector effects. |

The optional integration journey is not an npm publication prerequisite. Its
absence or failure does not change Core functional acceptance or release
eligibility. Release Deployment Verification is a separate optional runtime-ui
claim governed by the Runbook.

## Plan and run the journey

1. Inspect the working tree and preserve unrelated work. Read the
   [publishing contract](../meshrix-js-upstream-service-publishing/references/publishing-contract.md)
   when changing its capability or report contracts.
2. Inspect the integration steps without starting the journey:

   ```sh
   npm run verify:release-journey -- --plan
   ```

3. For an explicitly authorized integration, use the supplied adapter and
   converter image:

   ```sh
   npm run verify:release-journey -- --adapter-source <adapter-package-dir> --image-name <local-image>
   ```

Do not discover floating sibling source trees or substitute artifact owners.
An explicit integration input does not become a Core dependency. The resulting
HTML describes observed journey evidence; it does not claim full platform
acceptance or npm release eligibility.

## Maintain and verify

For template changes, use `npm run generate:upstream-service-report-template`
and `npm run verify:upstream-service-report-template`. Generated reports remain
projections of the underlying reports and screenshot bytes; never hand-edit them
or turn a blank template into execution evidence. Select focused tests with
`$meshrix-js-regression-planner` instead of running every release task before an
ordinary documentation change.

After a failure, preserve truthful scoped evidence and follow the owning repair
and authorization rules before another attempt.
