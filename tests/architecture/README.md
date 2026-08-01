# Architecture Tests

Static path analysis, import graph validation, layout verification, root hygiene checks, and registry consistency tests.

- `tools/verifiers/architecture-graph.ts` — Resolves relative imports, package-scoped `imports`, workspace `exports`, layer allow/deny rules, and package-manifest runtime dependencies.
- `../../tools/server-scripts/verify-layout-audit.ts` — 13-section comprehensive layout audit
- `verify-root-hygiene.ts` — Root directory hygiene checker
- `verify-agent-entrypoints.ts` — Agent entry point verification
