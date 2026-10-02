# Meshrix.js Tests

This directory stores repository-level test assets.

- `tests/run.ts`: unified test runner for repository profiles, tagged suites,
  platform gates, and JSON reports.
- `tests/verify-secret-hygiene.ts`: source, docs, and test secret scan.
- `tests/server`: server verification mounts and mock modules.
- `tests/fixtures`: small synthetic fixtures only.

Package-local tests remain with their owning implementation.

The runner waits for each command to exit naturally. SIGINT and SIGTERM cancel
owned child processes; started work is reported as `cancelled`, while selected
work that never starts is reported as `not_run` without command timestamps.
Cancelled or incomplete coverage cannot set `coverageReady` or `releaseReady`.

Generated test output must go under `build/`. `tests/` is for small synthetic
fixtures, mock modules, and source-controlled test code.

See `docs/RUNBOOK.md` for the framework contract.
