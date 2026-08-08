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

Useful repository-level fallbacks are:

```sh
npm run typecheck
npm run build
npm test
```

Use `npm run verify:acceptance` only after all focused checks pass and only once
for the assembled candidate. Use `npm run repo:local-info-hygiene` before
publication.

## Bound side effects

Static checks and build output may run by default. Network access, protected
runtime data, container startup, destructive reset, and publication require
explicit authorization. A skipped or unavailable environment-specific check
does not establish support and does not invalidate an unrelated source claim.
