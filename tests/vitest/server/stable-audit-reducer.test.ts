import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  reduceStableAuditReports,
  resolveProfileSuiteIds,
  STABLE_AUDIT_PROFILES,
  validateStableAuditPartition,
} from "../../../tools/server-scripts/reduce-stable-audit-stages.ts";

const root: any = path.resolve(import.meta.dirname, "../../..");
const registry: any = JSON.parse(
  fs.readFileSync(path.join(root, "tools/registry/tests.registry.json"), "utf8"),
);
const revision: any = "a".repeat(40);

function stageReport(profile: string): any {
  const selectedSuites: any[] = resolveProfileSuiteIds(registry, profile);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    verifier: "tests/run.ts",
    runner: "meshrix-unified-test-runner",
    profile,
    selectedSuites,
    sourceRevision: revision,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    summary: {
      passed: selectedSuites.length,
      failed: 0,
      skipped: 0,
      dryRun: 0,
      timedOut: 0,
      coverageReady: true,
      releaseReady: true,
      reportLeakScan: true,
    },
    suites: selectedSuites.map((id) => ({ id, status: "passed" })),
  };
}

describe("stable audit checkpoint reducer", () => {
  it("partitions the exact audit closure without overlap", () => {
    const stages: any = validateStableAuditPartition(registry);
    const staged: any[] = STABLE_AUDIT_PROFILES.flatMap((profile) => stages[profile]);
    expect(new Set(staged).size).toBe(staged.length);
    expect(staged.sort()).toEqual(resolveProfileSuiteIds(registry, "audit-public").sort());
  });

  it("runs the Linux materialization acceptance without an unrelated heap cap", () => {
    const suite: any = registry.suites.find((entry: any) =>
      entry.id === "jobs.upload-custody-workspace-materialization-acceptance");
    expect(suite).toMatchObject({
      command: "node",
      args: ["tests/vitest/server/support/run-upload-workspace-materialization-acceptance.ts"],
    });
    expect(JSON.stringify(suite)).not.toContain("max-old-space-size");
    expect(JSON.stringify(suite)).not.toContain("max-semi-space-size");
  });

  it("reduces one successful receipt per stage for one source revision", () => {
    const report: any = reduceStableAuditReports({
      registry,
      reports: STABLE_AUDIT_PROFILES.map(stageReport),
    });
    expect(report.profile).toBe("audit-public");
    expect(report.sourceRevision).toBe(revision);
    expect(report.summary).toMatchObject({
      failed: 0,
      releaseReady: true,
      completedStageCount: STABLE_AUDIT_PROFILES.length,
      selectedSuiteCount: 77,
    });
  });

  it("fails closed when a checkpoint is missing", () => {
    expect(() => reduceStableAuditReports({
      registry,
      reports: STABLE_AUDIT_PROFILES.slice(1).map(stageReport),
    })).toThrowError(expect.objectContaining({ code: "stable_audit_stage_report_missing" }));
  });
});
