/**
 * Constants used by the single-node evidence reducer.
 *
 * Command execution, scheduling, report ownership, and evidence membership are
 * owned exclusively by platform-acceptance-command-catalog.ts.
 */

export const SINGLE_NODE_INTERNAL_PLATFORM_E2E_REPORT_PATH: any =
  "build/reports/single-node-internal-platform-e2e.json";

export const LOCAL_FIXTURE_SOURCE_FILES: readonly any[] = Object.freeze([
  "tools/server-scripts/verify-upstream-gateway-e2e.ts",
  "tools/server-scripts/lib/upstream-gateway-e2e-helpers.ts",
  "tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-constants.ts",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-fixture.ts",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-harness.ts",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-report.ts",
  "tools/server-scripts/lib/operation-permission-tag-governed-workflows.ts"
]);

export const PRIVATE_ROOT_PATTERNS: readonly any[] = Object.freeze([
  /\bapps\/private\b/iu,
  /\bpackages\/private\b/iu,
  /\bprivate-product\b/iu,
  /\bproprietary-runtime\b/iu,
  /\bmeshrix-private\b/iu
]);
