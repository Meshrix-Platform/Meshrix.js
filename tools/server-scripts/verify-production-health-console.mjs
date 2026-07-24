#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import {
  buildProductionHealthReport,
  PRODUCTION_HEALTH_REPORT_TYPE
} from "../../packages/foundation/src/observability/report-reader.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function writeSampleReport(root, runId, overrides = {}) {
  const reportDir = path.join(root, runId);
  await fs.mkdir(reportDir, { recursive: true });
  const report = {
    schemaVersion: "v0.0.1:schema:definition-1",
    reportType: "v0.0.1:platform:production-readiness-1",
    runId,
    generatedAt: overrides.generatedAt || "2026-05-21T00:00:00.000Z",
    mode: overrides.mode || "full",
    repoRoot,
    git: { branch: "main", commit: "0123456789abcdef", dirtyFileCount: 2 },
    overallStatus: overrides.overallStatus || "pass",
    productionClaimAllowed: overrides.productionClaimAllowed ?? false,
    releaseClaim: overrides.releaseClaim || "blocked-by-dirty-worktree",
    summary: overrides.summary || { pass: 3, fail: 0, timeout: 0, blockedP0: 0 },
    coverage: overrides.coverage || {
      required: ["architecture", "trace-observability", "backup-restore"],
      byRequirement: {
        architecture: ["architecture"],
        "trace-observability": ["trace-observability"],
        "backup-restore": ["backup-restore"]
      },
      missing: []
    },
    gates: overrides.gates || [
      {
        id: "architecture",
        title: "架构门禁",
        blockerLevel: "P0",
        owner: "platform-architecture",
        coverage: ["architecture"],
        status: "pass",
        evidencePath: `build/reports/production-readiness/${runId}/architecture.log`,
        commands: [{ command: "node tools/server-scripts/verify-architecture-patterns.mjs", exitCode: 0, timedOut: false, elapsedMs: 12 }],
        nextStep: "修复架构治理。"
      },
      {
        id: "trace-observability",
        title: "内部 Trace 与日志脱敏",
        blockerLevel: "P0",
        owner: "observability",
        coverage: ["trace-observability"],
        status: "pass",
        evidencePath: `build/reports/production-readiness/${runId}/trace-observability.log`,
        commands: [{ command: "npm run server:verify:trace-context", exitCode: 0, timedOut: false, elapsedMs: 15 }],
        nextStep: "补齐 trace。"
      },
      {
        id: "backup-restore",
        title: "备份恢复和 Checkpoint",
        blockerLevel: "P0",
        owner: "ops-runtime",
        coverage: ["backup-restore"],
        status: "pass",
        evidencePath: `build/reports/production-readiness/${runId}/backup-restore.log`,
        commands: [{ command: "npm run server:verify:ops", exitCode: 0, timedOut: false, elapsedMs: 18 }],
        nextStep: "补齐恢复演练。"
      }
    ]
  };
  await fs.writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function verifyReportReader() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-production-health-"));
  const reportRoot = path.join(tempRoot, "reports", "production-readiness");
  try {
    const missing = await buildProductionHealthReport({
      repoRoot: tempRoot,
      reportRoot: path.join(tempRoot, "missing"),
      userDataPath: tempRoot,
      capabilityKernelBackend: "local-file",
      capabilityBindingBackend: "local-file"
    });
    assert.equal(missing.reportType, PRODUCTION_HEALTH_REPORT_TYPE);
    assert.equal(missing.status, "missing");
    assert.equal(missing.latestReport, null);
    assert.equal(missing.capabilityKernel.securityMode, "degraded_file_fallback");
    assert.equal(missing.capabilityKernel.degraded, true);
    assert.equal(missing.capabilityBindingGuard.securityMode, "degraded_file_fallback");
    assert.equal(missing.capabilityBindingGuard.degraded, true);

    await writeSampleReport(reportRoot, "20260521T000000Z", {
      generatedAt: "2026-05-21T00:00:00.000Z",
      overallStatus: "blocked",
      summary: { pass: 0, fail: 1, timeout: 0, blockedP0: 1 },
      gates: [
        {
          id: "architecture",
          title: "架构门禁",
          blockerLevel: "P0",
          owner: "platform-architecture",
          coverage: ["architecture"],
          status: "fail",
          evidencePath: "build/reports/production-readiness/20260521T000000Z/architecture.log",
          commands: [{ command: "node tools/server-scripts/verify-architecture-patterns.mjs", exitCode: 1, timedOut: false, elapsedMs: 9 }],
          nextStep: "修复架构治理。"
        }
      ]
    });
    await writeSampleReport(reportRoot, "20260522T000000Z", {
      generatedAt: "2026-05-22T00:00:00.000Z"
    });
    await writeSampleReport(reportRoot, "20260523T000000Z", {
      generatedAt: "2026-05-23T00:00:00.000Z",
      mode: "quick",
      overallStatus: "blocked",
      summary: { pass: 1, fail: 0, timeout: 0, blockedP0: 0 },
      coverage: {
        required: ["architecture", "trace-observability"],
        byRequirement: { architecture: ["architecture"], "trace-observability": [] },
        missing: ["trace-observability"]
      },
      gates: [
        {
          id: "architecture",
          title: "架构门禁",
          blockerLevel: "P0",
          owner: "platform-architecture",
          coverage: ["architecture"],
          status: "pass",
          evidencePath: "build/reports/production-readiness/20260523T000000Z/architecture.log",
          commands: [{ command: "node tools/server-scripts/verify-architecture-patterns.mjs", exitCode: 0, timedOut: false, elapsedMs: 9 }],
          nextStep: "修复架构治理。"
        }
      ]
    });

    const health = await buildProductionHealthReport({
      repoRoot: tempRoot,
      reportRoot,
      userDataPath: tempRoot,
      capabilityKernelBackend: "local-file",
      capabilityBindingBackend: "local-file"
    });
    assert.equal(health.reportType, PRODUCTION_HEALTH_REPORT_TYPE);
    assert.equal(health.status, "pass");
    assert.equal(health.latestReport.runId, "20260522T000000Z");
    assert.equal(health.latestReport.overallStatus, "pass");
    assert.equal(health.latestReport.productionClaimAllowed, false);
    assert.equal(health.latestReport.releaseClaim, "blocked-by-dirty-worktree");
    assert.equal(health.latestReport.git.dirtyFileCount, 2);
    assert.equal(health.summary.pass, 3);
    assert.ok(health.sections.some((section) => section.id === "observability" && section.status === "pass"));
    assert.ok(
      health.sections.some(
        (section) =>
          section.id === "security" &&
          section.total === 3 &&
          section.missingGateIds.includes("capability-kernel-security")
      )
    );
    assert.ok(health.gates.some((gate) => gate.id === "backup-restore" && gate.commandSummary.total === 1));
    assert.equal(health.history.length, 3);
    assert.equal(health.history[0].runId, "20260523T000000Z");
    assert.equal(health.capabilityKernel.securityMode, "degraded_file_fallback");
    assert.equal(health.capabilityKernel.recoverySupported, true);
    assert.equal(health.capabilityBindingGuard.securityMode, "degraded_file_fallback");
    assert.equal(health.capabilityBindingGuard.degraded, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function verifyOperationRegistry() {
  const operation = SERVER_API_OPERATIONS.find((item) => item.id === "production.health");
  assert.ok(operation, "production.health operation must be registered");
  assert.equal(operation.http.method, "GET");
  assert.equal(operation.http.path, "/api/production/health");
  assert.equal(operation.target.controller, "system");
  assert.equal(operation.target.method, "handleProductionHealth");
  assert.ok(operation.requiredScopes.includes("console:read"));
  assert.equal(operation.readOnly, true);
}

async function verifyFrontendWiring() {
  const productionHealthComponentDir = path.join(repoRoot, "apps/console/components/admin/production-health");
  const productionHealthComponentFiles = await fs.readdir(productionHealthComponentDir);
  const productionHealthComponents = (await Promise.all(
    productionHealthComponentFiles
      .filter((fileName) => fileName.endsWith(".vue"))
      .sort()
      .map((fileName) => fs.readFile(path.join(productionHealthComponentDir, fileName), "utf8"))
  )).join("\n");
  const files = {
    router: await fs.readFile(path.join(repoRoot, "apps/console/router/index.ts"), "utf8"),
    routerRoutes: await fs.readFile(path.join(repoRoot, "apps/console/router/routes.ts"), "utf8"),
    adminRouteRegistry: await fs.readFile(path.join(repoRoot, "apps/console/router/admin-route-registry.mjs"), "utf8"),
    bridge: await fs.readFile(path.join(repoRoot, "apps/console/lib/bridge.ts"), "utf8"),
    productionHealth: await fs.readFile(path.join(repoRoot, "apps/console/lib/production-health.ts"), "utf8"),
    productionHealthClient: await fs.readFile(path.join(repoRoot, "apps/console/lib/production-health-client.ts"), "utf8"),
    versionRelease: await fs.readFile(path.join(repoRoot, "apps/console/lib/version-release.ts"), "utf8"),
    versionReleaseView: await fs.readFile(path.join(repoRoot, "apps/console/views/admin/VersionReleaseView.vue"), "utf8"),
    versionReleaseReadinessCard: await fs.readFile(
      path.join(repoRoot, "apps/console/components/admin/version-release/VersionReleaseReadinessCard.vue"),
      "utf8"
    ),
    registry: await fs.readFile(path.join(repoRoot, "packages/foundation/config/frontend-feature-registry.yaml"), "utf8"),
    versionNav: await fs.readFile(
      path.join(repoRoot, "apps/console/components/shell/side-nav/ConsoleSideNavVersionSection.vue"),
      "utf8"
    ),
    routeController: await fs.readFile(path.join(repoRoot, "apps/console/composables/console-shell-route-controller.ts"), "utf8"),
    i18n: await fs.readFile(path.join(repoRoot, "apps/console/i18n/console-messages.ts"), "utf8"),
    view: await fs.readFile(path.join(repoRoot, "apps/console/views/admin/ProductionHealthView.vue"), "utf8"),
    components: productionHealthComponents
  };
  assert.match(files.router, /ADMIN_ROUTE_REGISTRY\.map/);
  assert.match(files.router, /resolveAdminComponent/);
  assert.match(files.router, /path:\s*`\/admin\/\$\{entry\.slug\}`/);
  assert.match(files.routerRoutes, /import\.meta\.glob\(["']\.\.\/views\/admin\/\*\.vue["']\)/);
  assert.match(files.routerRoutes, /resolveAdminComponent/);
  assert.match(files.adminRouteRegistry, /viewKey:\s*"productionHealth"/);
  assert.match(files.adminRouteRegistry, /slug:\s*"production-health"/);
  assert.match(files.adminRouteRegistry, /componentName:\s*"ProductionHealthView\.vue"/);
  assert.match(files.bridge, /getProductionHealth/);
  assert.match(files.bridge, /production-health-client/);
  assert.doesNotMatch(files.bridge, /\/api\/production\/health/);
  assert.match(files.productionHealthClient, /\/api\/production\/health/);
  assert.match(files.productionHealthClient, /\/api\/readiness\/baseline\/status/);
  assert.match(files.productionHealth, /loadProductionHealthSnapshot/);
  assert.match(files.productionHealth, /getProductionHealth\(\)/);
  assert.doesNotMatch(files.productionHealth, /from\s+["']\.\/bridge["']/);
  assert.match(files.versionRelease, /getProductionHealth/);
  assert.match(files.versionReleaseView, /VersionReleaseReadinessCard/);
  assert.match(files.versionReleaseReadinessCard, /productionClaimAllowed/);
  assert.match(files.versionReleaseReadinessCard, /dirtyFileCount/);
  assert.match(files.versionReleaseReadinessCard, /releaseClaim/);
  assert.match(files.versionReleaseReadinessCard, /禁止生产声明/);
  assert.match(files.registry, /admin\.production-health/);
  assert.match(files.versionNav, /msg\.nav\.productionHealth/);
  assert.match(files.versionNav, /openAdmin\('productionHealth'\)/);
  assert.match(files.routeController, /messages\.nav\.productionHealth/);
  assert.match(files.i18n, /productionHealth:\s*"交付门禁"/);
  assert.match(files.view, /loadProductionHealthSnapshot/);
  assert.match(files.view, /ProductionHealthHeroCard/);
  assert.doesNotMatch(files.view, /bridge\.getProductionHealth/);
  assert.match(files.components, /Capability Kernel/);
  assert.match(files.components, /capabilityKernel/);
  assert.match(files.components, /Binding Guard/);
  assert.match(files.components, /capabilityBindingGuard/);
  assert.match(files.components, /门禁明细/);
}

async function main() {
  await verifyReportReader();
  verifyOperationRegistry();
  await verifyFrontendWiring();
  const currentDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-production-health-current-"));
  try {
    const current = await buildProductionHealthReport({
      repoRoot,
      userDataPath: currentDataDir,
      capabilityKernelBackend: "local-file",
      capabilityBindingBackend: "local-file"
    });
    assert.equal(current.reportType, PRODUCTION_HEALTH_REPORT_TYPE);
    assert.ok(current.capabilityKernel);
    assert.ok(current.capabilityBindingGuard);
  } finally {
    await fs.rm(currentDataDir, { recursive: true, force: true });
  }
  console.log("[production-health-console] ok");
}

await main();
