# Architecture Tests

Static path analysis, import graph validation, layout verification, root hygiene checks, and registry consistency tests.

- `tools/verifiers/architecture-graph.ts` — Resolves relative imports, package-scoped `imports`, workspace `exports`, layer allow/deny rules, and package-manifest runtime dependencies. Classifies every edge as static runtime, type-only, or dynamic; computes static runtime SCCs with Tarjan (type-only and dynamic edges excluded); and enforces public package facades for production consumers and the declared `package.json` `bin` entry closures.
- `../../tools/server-scripts/verify-layout-audit.ts` — 13-section comprehensive layout audit
- `verify-root-hygiene.ts` — Root directory hygiene checker
- `verify-agent-entrypoints.ts` — Agent entry point verification
