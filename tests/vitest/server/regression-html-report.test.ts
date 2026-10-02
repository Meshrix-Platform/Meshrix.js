import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertNoLeak } from "../../../tools/server-scripts/lib/report-evidence-safety.ts";
import {
  createRegressionHtmlReport,
  createRegressionReportSnapshot,
  shouldRefreshTrackedRegressionReport,
  TRACKED_REGRESSION_REPORT_PATH
} from "../../lib/regression-html-report.ts";

const fixture = {
  profile: "core-public",
  sourceRevision: "a".repeat(40),
  startedAt: "2026-08-23T00:00:00.000Z",
  finishedAt: "2026-08-23T00:00:03.000Z",
  durationMs: 3000,
  selectedSuites: ["build", "server"],
  executionProcesses: [
    { id: "build", childSuiteIds: ["build"] },
    { id: "server", childSuiteIds: ["server"] }
  ],
  summary: {
    passed: 2,
    failed: 0,
    skipped: 0,
    dryRun: 0,
    cancelled: 0,
    notRun: 0,
    coverageReady: true,
    releaseReady: true,
    reportLeakScan: true
  },
  executionPhases: [{
    id: "functional",
    label: "Functional verification",
    lanes: [
      { id: "build", dependsOn: [], processes: [] },
      { id: "server", dependsOn: ["build"], processes: [] }
    ]
  }],
  suites: [
    {
      id: "build",
      label: "Build",
      phaseId: "functional",
      laneId: "build",
      command: "npm run build:node",
      status: "passed",
      childSuiteIds: ["build"],
      durationMs: 1000,
      startedAt: "2026-08-23T00:00:00.000Z",
      finishedAt: "2026-08-23T00:00:01.000Z"
    },
    {
      id: "server",
      label: "Server tests",
      phaseId: "functional",
      laneId: "server",
      command: "npm run test:functional:backend:server -- shard-a",
      status: "passed",
      childSuiteIds: ["server"],
      durationMs: 2000,
      startedAt: "2026-08-23T00:00:01.000Z",
      finishedAt: "2026-08-23T00:00:03.000Z"
    }
  ]
};
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("tracked interactive regression report", () => {
  it("builds a bounded phase and lane snapshot", () => {
    const snapshot = createRegressionReportSnapshot(fixture, { productVersion: "0.0.1" });
    expect(snapshot.summary).toMatchObject({ total: 2, passed: 2, failed: 0, passRate: 100 });
    expect(snapshot.phases[0].durationMs).toBe(3000);
    expect(snapshot.phases[0].lanes[1]).toMatchObject({ id: "server", dependsOn: ["build"] });
    expect(snapshot.revision).toBe("aaaaaaaaaaaa");
  });

  it("counts and filters cancelled or unstarted work without trusting stale readiness", () => {
    const interrupted = {
      ...fixture,
      selectedSuites: [...fixture.selectedSuites, "deployment"],
      executionProcesses: [
        ...fixture.executionProcesses,
        { id: "deployment", childSuiteIds: ["deployment"] }
      ],
      summary: { ...fixture.summary, passed: 1, cancelled: 1, notRun: 1 },
      suites: [
        ...fixture.suites.slice(0, 1),
        {
          ...fixture.suites[1],
          status: "cancelled",
          childSuiteIds: ["server"]
        },
        {
          id: "deployment",
          phaseId: "functional",
          laneId: "server",
          command: "npm run verify:deployment",
          status: "not_run",
          childSuiteIds: ["deployment"]
        }
      ]
    };
    const snapshot = createRegressionReportSnapshot(interrupted, { productVersion: "0.0.1" });
    expect(snapshot.releaseReady).toBe(false);
    expect(snapshot.summary).toMatchObject({ total: 3, passed: 1, cancelled: 1, notRun: 1, passRate: 33.33 });
    expect(snapshot.phases[0]).toMatchObject({ cancelled: 1, notRun: 1 });
    expect(snapshot.phases[0].lanes[1]).toMatchObject({ cancelled: 1, notRun: 1 });

    const html = createRegressionHtmlReport(interrupted, { productVersion: "0.0.1" });
    expect(html).toContain('<option value="cancelled">Cancelled</option>');
    expect(html).toContain('<option value="not_run">Not run</option>');
    expect(html).toContain("phase.cancelled + ' cancelled'");
    expect(html).toContain("phase.notRun + ' not run'");
  });

  it("does not report complete readiness when a selected suite was skipped", () => {
    const skipped = {
      ...fixture,
      summary: { ...fixture.summary, passed: 1, skipped: 1 },
      suites: [fixture.suites[0], { ...fixture.suites[1], status: "skipped" }]
    };

    const snapshot = createRegressionReportSnapshot(skipped, { productVersion: "0.0.1" });
    expect(snapshot.releaseReady).toBe(false);
    expect(snapshot.summary).toMatchObject({ passed: 1, skipped: 1, total: 2 });
  });

  it("keeps a report unready when selected process evidence is missing", () => {
    const missing = { ...fixture, suites: fixture.suites.slice(0, 1) };
    const snapshot = createRegressionReportSnapshot(missing, { productVersion: "0.0.1" });
    const inconsistent = {
      ...fixture,
      summary: { ...fixture.summary, coverageReady: false }
    };

    expect(snapshot.releaseReady).toBe(false);
    expect(snapshot.summary).toMatchObject({ total: 2, passed: 1, unaccounted: 1, passRate: 50 });
    expect(createRegressionReportSnapshot(inconsistent, { productVersion: "0.0.1" }).releaseReady).toBe(false);
  });

  it("renders a self-contained interactive and privacy-safe HTML document", () => {
    const html = createRegressionHtmlReport(fixture, { productVersion: "0.0.1" });
    expect(html).toContain('<script type="application/json" id="regression-data">');
    expect(html).toContain("Search suite, lane, or command");
    expect(html).toContain("Execution phases");
    expect(html).not.toContain("https://");
    expect(() => assertNoLeak(html, "tracked regression HTML fixture")).not.toThrow();
  });

  it("refreshes only for the complete core profile", () => {
    expect(TRACKED_REGRESSION_REPORT_PATH).toBe("docs/verification/regression.html");
    expect(shouldRefreshTrackedRegressionReport({ profile: "core-public", selectedByProfile: true, acceptanceWorker: false })).toBe(true);
    expect(shouldRefreshTrackedRegressionReport({ profile: "core-public", selectedByProfile: true, acceptanceWorker: true })).toBe(false);
    expect(shouldRefreshTrackedRegressionReport({ profile: "core-public", selectedByProfile: false })).toBe(false);
    expect(shouldRefreshTrackedRegressionReport({ profile: "audit-public", selectedByProfile: true })).toBe(false);
  });

  it("declares the tracked report in the canonical test profile registry", () => {
    const registry = JSON.parse(fs.readFileSync(
      path.join(repoRoot, "tools/registry/tests.registry.json"),
      "utf8"
    ));
    expect(registry.profiles["core-public"].trackedArtifacts).toEqual([
      TRACKED_REGRESSION_REPORT_PATH
    ]);
  });
});
