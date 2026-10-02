import { describe, expect, it } from "vitest";
import {
  evaluateEngineeringOutcomes,
  parseLocalCiArguments,
  sourceNodeEnvironment,
  suiteFlowResults
} from "../../../tools/scripts/local-ci.ts";
import { sanitizeVerificationLog } from "../../../tools/server-scripts/localize-verify-failure.ts";

describe("automatic local verification entry", () => {
  it("reads the maintained runner summary and preserves every failed or unexecuted suite", () => {
    const report = {
      summary: { reportLeakScan: true },
      suites: [{ id: "core", status: "failed" }, { id: "dependent", status: "not_run", reasonCode: "prerequisite_lane_incomplete" }],
      executionProcesses: [{ id: "core" }, { id: "dependent" }],
    };
    expect(suiteFlowResults(report, "build/reports/runner.json")).toMatchObject([
      { id: "core", status: "failed", reasonCode: "command_failed" },
      { id: "dependent", status: "not_run", reasonCode: "prerequisite_lane_incomplete" },
    ]);
    expect(() => suiteFlowResults({ ...report, summary: { reportLeakScan: false } }, "report.json")).toThrow("local_ci_runner_report_invalid");
  });

  it("defaults to the registered engineering scope and accepts a repository-relative report", () => {
    expect(parseLocalCiArguments([])).toMatchObject({
      scope: "engineering",
      reportPath: null,
      help: false
    });
    expect(parseLocalCiArguments([
      "--report",
      "build/ci-diagnostics/local-ci/results.json"
    ])).toMatchObject({
      scope: "engineering",
      reportPath: "build/ci-diagnostics/local-ci/results.json"
    });
    expect(parseLocalCiArguments(["--scope=release", "--report=build/ci-diagnostics/release.json"]))
      .toMatchObject({ scope: "release", reportPath: "build/ci-diagnostics/release.json" });
  });

  it("rejects platform selection, stage recursion, and report escape", () => {
    for (const args of [
      ["--platform", "linux"],
      ["--arch", "amd64"],
      ["--worker", "core-public"],
      ["--report", "../../outside.json"],
      ["--report", ""],
      ["--scope", "engineering", "--scope", "release"]
    ]) expect(() => parseLocalCiArguments(args)).toThrow();
  });

  it("passes the source export condition to every child without duplicating it", () => {
    expect(sourceNodeEnvironment({ NODE_OPTIONS: "--max-old-space-size=4096" }).NODE_OPTIONS)
      .toBe("--max-old-space-size=4096 --conditions=source");
    expect(sourceNodeEnvironment({ NODE_OPTIONS: "--conditions=source" }).NODE_OPTIONS)
      .toBe("--conditions=source");
  });

  it("keeps optional capability gaps visible while qualifying complete applicable native work", () => {
    const outcome = evaluateEngineeringOutcomes([
      { id: "core", status: "passed", phaseId: "core", laneId: "backend" },
      {
        id: "sandbox-runtime",
        status: "not_run",
        reasonCode: "docker_daemon_unavailable",
        requiredService: "docker",
        phaseId: "engineering",
        laneId: "sandbox-runtime"
      },
      {
        id: "sandbox-convergence",
        status: "not_run",
        reasonCode: "prerequisite_lane_incomplete",
        blockedBy: ["sandbox-runtime"],
        phaseId: "engineering",
        laneId: "sandbox-convergence"
      }
    ], 1);
    expect(outcome).toMatchObject({
      status: "passed",
      passed: 1,
      failed: 0,
      notRun: 2,
      optionalNotRun: 2
    });
  });

  it("does not excuse a selected failure, unknown not-run reason, or cancellation", () => {
    expect(evaluateEngineeringOutcomes([
      { id: "selected", status: "failed", phaseId: "p", laneId: "l" }
    ], 1)).toMatchObject({ status: "failed", failed: 1 });
    expect(evaluateEngineeringOutcomes([
      { id: "unknown", status: "not_run", reasonCode: "unexpected_reason", phaseId: "p", laneId: "l" }
    ], 1)).toMatchObject({ status: "failed", notRun: 1 });
    expect(evaluateEngineeringOutcomes([
      { id: "cancelled", status: "cancelled", phaseId: "p", laneId: "l" }
    ], 130)).toMatchObject({ status: "cancelled", cancelled: 1 });
  });

  it("does not turn an abnormal runner exit into success when Docker is unavailable", () => {
    const results = [
      { id: "core", status: "passed" },
      { id: "docker", status: "not_run", reasonCode: "docker_daemon_unavailable", requiredService: "docker" }
    ];
    for (const exitCode of [null, 2, 130, 137]) {
      expect(evaluateEngineeringOutcomes(results, exitCode).status).toBe("failed");
    }
    expect(evaluateEngineeringOutcomes(results, 1, { cancelled: true }).status).toBe("cancelled");
  });

  it("retains useful sanitized failure diagnostics without retaining runtime payloads", () => {
    const safe = sanitizeVerificationLog([
      "stdout | tools/server-scripts/example.ts",
      "synthetic runtime payload",
      " FAIL tests/vitest/server/example.test.ts:12",
      "AssertionError: expected 1 to equal 2"
    ].join("\n"));
    expect(safe).not.toContain("synthetic runtime payload");
    expect(safe).toContain("example.test.ts:12");
    expect(safe).toContain("expected 1 to equal 2");
  });
});
