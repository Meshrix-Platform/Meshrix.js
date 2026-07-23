# LicoMesh Tests

This directory stores repository-level test assets.

- `tests/run.mjs`: unified test runner for repository profiles, tagged suites,
  platform gates, and JSON reports.
- `tests/verify-secret-hygiene.mjs`: source, docs, and test secret scan.
- `tests/server`: server verification mounts and mock modules.
- `tests/fixtures`: small synthetic fixtures only.

Package-local tests remain with their owning implementation.

Generated test output must go under `build/`. `tests/` is for small synthetic
fixtures, mock modules, and source-controlled test code.

See `docs/RUNBOOK.md` for the framework contract.
