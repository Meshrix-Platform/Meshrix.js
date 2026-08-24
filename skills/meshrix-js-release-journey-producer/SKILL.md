---
name: meshrix-js-release-journey-producer
description: Run the Meshrix.js pre-release upstream-service-publishing producer and its side-effect-free prepublication verifier — the two catalog-backed verification lanes, candidate-bound receipts, and the generated report outputs. Use before every Meshrix.js release candidate. The HTML report contract is owned by $meshrix-js-html-report-contract; the client compatibility matrix by $meshrix-js-client-compatibility-matrix; publishing to a running instance by $meshrix-js-upstream-service-publishing.
---

# Meshrix.js Release Journey Producer

This skill owns the **verification lanes and candidate receipt** of the
upstream service publishing journey. The portable HTML report contract belongs
to `$meshrix-js-html-report-contract`; the downstream client compatibility
matrix belongs to `$meshrix-js-client-compatibility-matrix`; publishing a
service to a running instance belongs to `$meshrix-js-upstream-service-publishing`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Read [references/publishing-contract.md](../../meshrix-js-upstream-service-publishing/references/publishing-contract.md) completely when changing the capability flow, state model, security boundary, event contract, protocol delivery, server gate, or receipt contract.
3. Keep the lanes separate from the report contract and the publication operation: this skill owns the two verification lanes and the receipt; `$meshrix-js-html-report-contract` owns the template, renderer, and screenshots; `$meshrix-js-upstream-service-publishing` owns the publication transaction.

## Verify the closed loop

Use two catalog-backed lanes and never conflate their claims:

- `meshrix.upstream-service-prepublication` is the side-effect-free verifier
  for an already-produced report bundle. It validates the template and every
  candidate-bound artifact, then emits a bounded receipt. It must not start a
  service, browser, container, client, upload, authorization, or invocation.
- `meshrix.release-journey` is the side-effecting producer. It creates a fresh
  isolated bundle and must run before every Meshrix.js release candidate; a cached
  receipt never substitutes for this run.

Plan the safe lane first, then run the complete producer with explicit
side-effect admission:

```text
npm run verify:upstream-service-publishing-candidate
npm run verify:upstream-service-publishing-candidate
npm run verify:upstream-service-publishing
npm run verify:upstream-service-publishing
```

The safe lane fails closed when the template or any required artifact is
missing, stale, reordered, dirty-candidate-bound, privacy-unsafe, or
digest-mismatched. Its claim is limited to upstream publishing
prepublication; it cannot emit `functional-complete`, overall `releaseReady`,
or replace the platform acceptance reducer. The full journey remains outside
the tag workflow until the external converter image and adapter bundle have
immutable, owner-published digests. Never restore floating sibling-repository
checkouts as a shortcut.

## Run the maintenance loop

Before any side-effecting journey, run the safe maintenance loop:

```text
npm run generate:upstream-service-report-template
npm run verify:upstream-service-report-template
npm run vitest -- --run \
  tests/vitest/server/upstream-service-publishing-candidate.test.ts \
  tests/vitest/server/upstream-service-publishing-html.test.ts \
  tests/vitest/server/release-journey.test.ts \
  tests/vitest/server/release-workflow-supply-chain.test.ts
npm run generate:upstream-service-publishing-report
npm run verify:upstream-service-publishing-candidate
```

Never hand-edit a generated report. The catalog-backed workflow must validate
the tracked template before either the Core verifier or runtime release
journey. The Core report and candidate receipt tasks must bind their declared
outputs by byte length and SHA-256. The runtime task must bind every mandatory
report output.

Every blank template must remain portable, offline, bilingual, synthetic, and
visibly marked `Not executed / 未执行`. It is neither release evidence nor a
readiness authority and must not contain real screenshots, digests, runtime
values, private paths, or `build/` artifact references.

## Outputs

One successful run must converge on these outputs:

- `build/reports/upstream-service-publishing.json` is the recomputable,
  reducer-owned evidence authority.
- `build/reports/release-journey.json` proves the isolated external-service,
  connector, and downstream-agent journey.
- `build/reports/upstream-service-publishing.html` is the offline,
  single-file portable human-readable release report projected only from the
  verified reports, actual publishing JSON, and digest-bound screenshot bytes.
  Its content contract is owned by `$meshrix-js-html-report-contract`.
- `docs/examples/upstream-service-publishing-report-template.html` is the
  tracked, portable blank structural template. Its deterministic generator
  must pass `--check` before the runtime journey.
- `build/reports/upstream-service-publishing/upstream-service-basic-config.json`
  is the actual JSON document used for the upstream publication request. The
  HTML must embed its exact verified bytes as a downloadable data URL beside
  the upstream basic-configuration screenshot and display its digest. The
  embedded copy is not a substitute for the gate-owned source file.
- `build/reports/upstream-service-publishing/screenshots/` contains only
  screenshots captured from the running Meshrix.js Web Console.
- `build/reports/upstream-service-publishing-candidate.json` is the bounded
  external receipt that binds one release-definition version and tag, exact
  source commit/tree, Core and journey reports, actual publishing JSON, final
  HTML, and exactly eleven ordered screenshots by repository-relative path, byte
  length, and SHA-256. It carries only the scoped
  `upstream-publishing-prepublication-passed` claim.

## Acceptance boundary

Run this targeted closure first, then the canonical platform acceptance
reducer. The paired capability reports provide mandatory scoped evidence, but
only the platform reducer may declare the Meshrix.js functional release accepted.
