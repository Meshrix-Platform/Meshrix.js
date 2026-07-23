# UI Console Package

The UI console package owns reusable browser-side components, typed clients, display helpers, and view contexts. Server operation executors and state projections belong to the server-runtime composition boundary.

## Boundaries

- Browser clients call registered HTTP/RPC operations rather than importing server executors.
- Secret values are accepted only on write paths and are never returned through public projections.
- UI availability and status must reflect executable runtime capabilities.

## Verification

```bash
npm run console:verify
npm test -- --suite domains.manifest
```
