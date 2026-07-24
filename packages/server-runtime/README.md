# Server Runtime Package

The server runtime package is Meshrix's composition root for state stores, jobs, workers, settings, discovery, server-side console operation projection, and product API orchestration.

## Boundaries

- Runtime composition wires domain providers together; it does not duplicate their implementations.
- Persistent state and external effects must pass through explicit lifecycle and authorization boundaries.
- User configuration is authoritative: missing values remain unconfigured and are not replaced by hidden product defaults.

## Verification

```bash
npm run server:verify
npm run server:verify:headless
npm test
```
