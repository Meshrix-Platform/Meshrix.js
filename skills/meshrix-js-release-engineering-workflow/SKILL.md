---
name: meshrix-js-release-engineering-workflow
description: Plan, implement, and verify substantial Meshrix.js delivery against the private repository release contract.
---

# Meshrix.js Release Engineering Workflow

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

Run the narrowest package script that covers the changed capability. After all
focused checks pass, run:

```sh
npm run typecheck
npm run build
npm test
npm run verify:acceptance
npm run repo:local-info-hygiene
git diff --check
```

Do not rerun the full regression between individual subchanges. A protected
resource, runtime-data probe, publication, or external effect requires explicit
authorization and exact scope.

## Release boundary

Treat commit and push as separate publication decisions. Review the exact
staged tree before commit and the exact outgoing commit range before push.
Report only task identifiers, counts, statuses, timings, and irreversible
digests; never retain runtime payloads, credentials, machine identity, or local
paths.
