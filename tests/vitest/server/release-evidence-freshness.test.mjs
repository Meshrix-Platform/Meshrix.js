import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCurrentRunReportDriftAudit,
  createReportFreshnessEvidence,
  snapshotJsonReportFiles
} from "../../../tools/server-scripts/lib/release-evidence-freshness.mjs";
import {
  failedEvidenceStateCommandIds,
  layerStatus,
  reduceCapabilityEvidenceExecution,
  validateBlockedCommandResults
} from "../../../tools/server-scripts/verify-platform-acceptance.mjs";

describe("release evidence freshness and report drift", () => {
  it("does not accept file mtime as freshness evidence", () => {
    const freshness = createReportFreshnessEvidence(
      "build/reports/no-embedded-time.json",
      { summary: { ok: true } },
      { mtimeMs: Date.now() },
      { notBeforeMs: Date.now() - 1000 }
    );

    expect(freshness.fresh).toBe(false);
    expect(freshness.source).toBe("file-mtime-not-trusted");
    expect(freshness.embeddedTimestampPresent).toBe(false);
  });

  it("detects only current-run unregistered report files by content hash", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "licomesh-release-drift-"));
    const reportsDir = path.join(repoRoot, "build", "reports");
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(path.join(reportsDir, "baseline.json"), JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }));

    const beforeSnapshot = await snapshotJsonReportFiles(repoRoot);
    await fs.writeFile(path.join(reportsDir, "allowed.json"), JSON.stringify({ generatedAt: "2026-01-02T00:00:00.000Z" }));
    await fs.writeFile(path.join(reportsDir, "orphan.json"), JSON.stringify({ generatedAt: "2026-01-02T00:00:00.000Z" }));
    const afterSnapshot = await snapshotJsonReportFiles(repoRoot);

    const audit = createCurrentRunReportDriftAudit({
      beforeSnapshot,
      afterSnapshot,
      allowedReports: ["build/reports/allowed.json"]
    });

    expect(audit.currentRunOrphans).toEqual(["build/reports/orphan.json"]);
    expect(audit.consistent).toBe(false);
  });

  it("accepts only a report-consistent direct blocker and propagates it across passed dependencies", () => {
    const commands = [
      { id: "blocker", report: "build/reports/blocker.json", blockedExitCodes: [2] },
      { id: "preflight", blockedExitCodes: [] },
      { id: "dependent", dependsOn: ["blocker", "preflight"], blockedExitCodes: [] }
    ];
    const results = [
      { id: "blocker", status: "blocked", exitCode: 2, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" },
      { id: "preflight", status: "passed", exitCode: 0, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" },
      { id: "dependent", status: "blocked", exitCode: 2, timedOut: false, startedAt: "", dependsOn: ["blocker", "preflight"] }
    ];
    const reportEvidence = {
      "build/reports/blocker.json": { validationPassed: true, liveStatus: "blocked" }
    };

    expect(validateBlockedCommandResults(results, reportEvidence, commands)).toEqual({
      valid: true,
      validBlockedCommandIds: ["blocker", "dependent"],
      invalidBlockedCommandIds: [],
      reasons: []
    });
    expect(layerStatus("foundation", [
      { id: "passed", layer: "acceptance.foundation", status: "passed" },
      { id: "blocked", layer: "acceptance.foundation", status: "blocked" }
    ])).toMatchObject({ status: "blocked", failedCommands: [], blockedCommands: ["blocked"] });
  });

  it("keeps legal blocked evidence out of failure ids while retaining failed and privacy-unsafe states", () => {
    expect(failedEvidenceStateCommandIds({
      nodes: [
        { commandId: "blocked", state: "blocked" },
        { commandId: "pending", state: "pending" },
        { commandId: "missing", state: "missing" },
        { commandId: "stale", state: "stale" },
        { commandId: "failed", state: "failed" },
        { commandId: "privacy", state: "privacy-unsafe" }
      ]
    })).toEqual([
      "evidence-state:failed:failed",
      "evidence-state:privacy:privacy-unsafe"
    ]);
  });

  it("rejects blocker/report mismatches and blocked propagation across a failed dependency", () => {
    const command = {
      id: "blocker",
      report: "build/reports/blocker.json",
      blockedExitCodes: [2]
    };
    const reportEvidence = {
      "build/reports/blocker.json": { validationPassed: true, liveStatus: "blocked" }
    };
    const passedWithBlockedReport = validateBlockedCommandResults([
      { id: "blocker", status: "passed", exitCode: 0, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" }
    ], reportEvidence, [command]);
    expect(passedWithBlockedReport).toMatchObject({
      valid: false,
      invalidBlockedCommandIds: ["blocker"]
    });
    expect(validateBlockedCommandResults([
      { id: "blocker", status: "passed", exitCode: 0, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" }
    ], {}, [command])).toMatchObject({
      valid: false,
      invalidBlockedCommandIds: ["blocker"]
    });

    const failedPropagation = validateBlockedCommandResults([
      { id: "blocker", status: "blocked", exitCode: 2, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" },
      { id: "failed", status: "failed", exitCode: 1, timedOut: false, startedAt: "2026-07-10T00:00:00.000Z" },
      { id: "dependent", status: "blocked", exitCode: 2, timedOut: false, startedAt: "", dependsOn: ["blocker", "failed"] }
    ], reportEvidence, [
      command,
      { id: "failed" },
      { id: "dependent", dependsOn: ["blocker", "failed"] }
    ]);
    expect(failedPropagation).toMatchObject({
      valid: false,
      validBlockedCommandIds: ["blocker"],
      invalidBlockedCommandIds: ["dependent"]
    });
  });

  it("binds checked capability evidence to same-run passed commands and validated owned reports", () => {
    const commands = [{
      id: "producer",
      ownedReports: ["build/reports/producer.json"]
    }];
    const results = [{ id: "producer", status: "passed" }];
    const reportEvidence = {
      "build/reports/producer.json": {
        validationPassed: true,
        reportLeakScan: true,
        releaseReady: true
      }
    };
    const binding = {
      acceptanceCommandId: "producer",
      report: "build/reports/producer.json"
    };

    expect(reduceCapabilityEvidenceExecution({
      bindings: [binding],
      commands,
      reportEvidence,
      results
    })).toMatchObject({ ready: true, bindingCount: 1, reasons: [] });

    expect(reduceCapabilityEvidenceExecution({
      bindings: [binding],
      commands,
      validBlockedCommandIds: ["producer"],
      reportEvidence: {
        "build/reports/producer.json": {
          validationPassed: true,
          reportLeakScan: true,
          releaseReady: false,
          coverageReady: true,
          liveStatus: "blocked"
        }
      },
      results: [{ id: "producer", status: "blocked" }]
    })).toMatchObject({ ready: true, bindingCount: 1, reasons: [] });

    expect(reduceCapabilityEvidenceExecution({
      bindings: [binding],
      commands,
      validBlockedCommandIds: ["producer"],
      reportEvidence: {
        "build/reports/producer.json": {
          validationPassed: true,
          reportLeakScan: true,
          releaseReady: false,
          coverageReady: false,
          liveStatus: "failed"
        }
      },
      results: [{ id: "producer", status: "blocked" }]
    })).toMatchObject({
      ready: false,
      reasons: ["capability-evidence-report-not-ready:producer:build/reports/producer.json"]
    });

    expect(reduceCapabilityEvidenceExecution({
      bindings: [
        { acceptanceCommandId: "unknown" },
        { acceptanceCommandId: "producer", report: "build/reports/unowned.json" }
      ],
      commands,
      reportEvidence,
      results
    })).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining([
        "capability-evidence-command-unknown:unknown",
        "capability-evidence-report-not-owned:producer:build/reports/unowned.json"
      ])
    });
  });
});
