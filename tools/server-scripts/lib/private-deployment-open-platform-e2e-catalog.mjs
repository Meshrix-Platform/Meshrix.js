/**
 * Constants used by the private-deployment evidence reducer.
 *
 * Command execution, scheduling, report ownership, and evidence membership are
 * owned exclusively by platform-acceptance-command-catalog.mjs.
 */

export const PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH =
  "build/reports/private-deployment-open-platform-e2e.json";

export const LOCAL_FIXTURE_SOURCE_FILES = Object.freeze([
  "tools/server-scripts/verify-upstream-gateway-e2e.mjs",
  "tools/server-scripts/lib/upstream-gateway-e2e-helpers.mjs",
  "tools/server-scripts/verify-operation-permission-tag-governed-e2e.mjs",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-constants.mjs",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-fixture.mjs",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-harness.mjs",
  "tools/server-scripts/lib/operation-permission-tag-governed-e2e-report.mjs",
  "tools/server-scripts/lib/operation-permission-tag-governed-workflows.mjs"
]);

export const PRIVATE_ROOT_PATTERNS = Object.freeze([
  /\bapps\/private\b/iu,
  /\bpackages\/private\b/iu,
  /\bprivate-product\b/iu,
  /\bproprietary-runtime\b/iu,
  /\bmeshrix-private\b/iu
]);
