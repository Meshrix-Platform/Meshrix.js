# Meshrix.js Tools

The `tools/` directory contains repository scripts for startup, packaging, registry generation, verification, hygiene checks, and operational diagnostics.

## Directory Layout

| Path | Purpose |
| --- | --- |
| `tools/server-scripts/` | Server startup, runtime diagnostics, MCP utilities, package scripts, and capability verifiers. |
| `tools/verifiers/` | Registry, architecture, and release validation helpers. |
| `tools/generators/` | Generated registry and artifact maintenance scripts. |
| `tools/config-scanner.ts` | Repository local-info and privacy hygiene scanner. |

## Script Rules

- Prefer npm scripts for user-facing commands.
- Keep reusable scripts deterministic and non-interactive unless the command is explicitly an operator prompt.
- Do not hardcode local machine paths, private hosts, credentials, or runtime state.
- Use placeholders such as `<repo-root>`, `<server-url>`, `<server-data-dir>`, `<input-file>`, and `<output-file>` in examples.
- Generated reports must go under `build/`.

## Common Checks

```bash
npm run repo:local-info-hygiene
npm run verify:registry
npm test
```

`repo:local-info-hygiene` writes `build/reports/local-info-hygiene.json`. Replace real local, identity, deployment, or service details with placeholders before treating a change as ready.

## Adding A Script

1. Put the script under the owning tool directory.
2. Add an npm script when operators or verifiers need a stable command.
3. Keep inputs explicit through flags, environment variables, or config files.
4. Add or update the relevant verifier when the script becomes part of the
   Functional Release Gate. A real-machine script must instead register one
   independent Real-Machine Verification Workflow and must not enter the
   functional dependency graph.
5. Run the narrowest validation command and `npm test`.
