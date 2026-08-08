# Contracts Package

The contracts package defines Meshrix.js's shared operation, event, receipt, module, protocol, and schema contracts.

## Boundaries

- Contracts describe stable data shapes and identifiers; they do not execute capability logic.
- Runtime behavior belongs to the package that owns the corresponding domain.
- Breaking contract changes must update generated artifacts, protocol projections, and acceptance evidence together.

## Verification

```bash
npm test -- --suite domains.manifest
npm run verify:registry
```
