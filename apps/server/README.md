# Meshrix Server Application

`apps/server` is the Meshrix Node server executable (`@meshrix/server`). It owns the HTTP runtime bootstrap and process lifecycle: `bin/meshrix.ts` starts the server, and `runtime/` wires configuration, middleware, routes, console assets, proxy handling, and listener lifecycle.

## Responsibilities

- Command-line entry point and runtime bootstrap for the Meshrix server process.
- HTTP server assembly: middleware, routes, static handlers, and console asset serving.
- Graceful startup, shutdown, and listener lifecycle management.

## Boundaries

- Platform capability logic belongs to the owning `packages/` modules; this application only composes them.
- The operator-facing console frontend lives in `apps/console`.
- Deployment, packaging, and release orchestration belongs to CI and `tools/`.

## Verification

```bash
npm test
```
