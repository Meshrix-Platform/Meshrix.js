import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_ACCEPTANCE_COMMANDS,
  ACCEPTANCE_REQUIRED_REPORTS
} from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_REPORT_PATH,
  PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST
} from "../../../tools/server-scripts/lib/platform-acceptance-report-catalog.ts";
import {
  buildReleaseReportOwnership,
  createReleaseEvidenceInventory,
  expectedReleaseReportProvenance,
  RELEASE_REPORT_PROVENANCE_SCHEMA,
  releaseEvidenceReportPayloadDigest,
  stampReleaseReportProvenance
} from "../../../tools/server-scripts/lib/release-report-provenance.ts";
import {
  createCurrentRunReportDriftAudit,
  createReportFreshnessEvidence
} from "../../../tools/server-scripts/lib/release-evidence-freshness.ts";
import { requiredReportSpec } from "../../../tools/server-scripts/lib/required-report-validator.ts";
import { simulateCleanCheckoutPr } from "../../../tools/server-scripts/simulate-clean-checkout-pr.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("acceptance gate provenance substrate", () => {
  it("names acceptance and public-gate commands and reports in one registry", () => {
    expect(PLATFORM_ACCEPTANCE_COMMANDS.length).toBeGreaterThan(0);
    for (const command of PLATFORM_ACCEPTANCE_COMMANDS) {
      expect(command.id).toBeTruthy();
      expect(command.label).toBeTruthy();
      expect(command.command).toBeTruthy();
    }
    const ids = new Set(PLATFORM_ACCEPTANCE_COMMANDS.map((command) => command.id));
    expect(ids).toContain("foundation-tests");
    expect(ids).toContain("platform-acceptance-plan");
    expect(ids).toContain("typecheck");
    expect(ACCEPTANCE_REQUIRED_REPORTS.length).toBeGreaterThan(0);
    expect(ACCEPTANCE_REQUIRED_REPORTS).toContain("build/reports/local-info-hygiene.json");
    expect(PLATFORM_ACCEPTANCE_REPORT_PATH).toBe("build/reports/platform-acceptance.json");
    expect(() => buildReleaseReportOwnership(PLATFORM_ACCEPTANCE_COMMANDS)).not.toThrow();
    expect(PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST.length).toBeGreaterThan(0);
    expect(RELEASE_REPORT_PROVENANCE_SCHEMA).toMatch(/^v0\.0\.1:/u);
  });

  it("emits schemaVersion, producer, commandId, timestamp, and payloadDigest on producers", async () => {
    const reportPath = "build/reports/local-info-hygiene.json";
    const spec = requiredReportSpec(reportPath);
    expect(spec).toBeTruthy();
    const command = {
      id: "foundation-tests",
      label: "Core public foundation gate",
      command: "npm",
      args: ["test"],
      report: reportPath,
      ownedReports: []
    };
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-provenance-"));
    try {
      const generatedAt = new Date().toISOString();
      const rawReport = {
        schemaVersion: spec.schemaVersion,
        generatedAt,
        verifier: spec.verifier,
        summary: { releaseReady: true, reportLeakScan: true }
      };
      const reportFile = path.join(tempRoot, ...reportPath.split("/"));
      await fs.mkdir(path.dirname(reportFile), { recursive: true });
      await fs.writeFile(reportFile, `${JSON.stringify(rawReport)}\n`, "utf8");

      await stampReleaseReportProvenance({
        repoRoot: tempRoot,
        commands: [command],
        results: [{ id: command.id, status: "passed" }],
        requiredReportPaths: [reportPath],
        recordedAt: "2026-08-16T00:00:00.000Z"
      });

      const stamped = JSON.parse(await fs.readFile(reportFile, "utf8"));
      const provenance = stamped.releaseEvidenceProvenance;
      expect(provenance.schemaVersion).toBe(RELEASE_REPORT_PROVENANCE_SCHEMA);
      expect(provenance.commandId).toBe(command.id);
      expect(provenance.producer).toBe(spec.verifier);
      expect(provenance.recordedAt).toBe("2026-08-16T00:00:00.000Z");
      expect(provenance.reportPayloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.keys(provenance).sort()).toEqual([
        "commandId",
        "producer",
        "recordedAt",
        "reportPayloadDigest",
        "schemaVersion"
      ]);

      const inventory = createReleaseEvidenceInventory({
        commands: [command],
        requiredReportPaths: [reportPath]
      });
      expect(inventory[0]).toMatchObject({
        reportPath,
        ownerCommandId: command.id,
        producer: spec.verifier,
        reportSchemaVersion: spec.schemaVersion,
        provenanceSchemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA
      });
      const expected = expectedReleaseReportProvenance({
        commandId: command.id,
        producer: spec.verifier
      });
      expect(expected).toEqual({
        schemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA,
        commandId: command.id,
        producer: spec.verifier
      });
      expect(releaseEvidenceReportPayloadDigest(rawReport)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on stale or unverifiable reports", () => {
    const now = Date.now();
    const report = { generatedAt: new Date(now - 60_000).toISOString(), summary: {} };
    const stale = createReportFreshnessEvidence("build/reports/example.json", report, {}, {
      notBeforeMs: now
    });
    expect(stale.fresh).toBe(false);
    expect(stale.source).toBe("embedded-timestamp");
    const fresh = createReportFreshnessEvidence("build/reports/example.json", report, {}, {
      notBeforeMs: now - 120_000
    });
    expect(fresh.fresh).toBe(true);
    const untrusted = createReportFreshnessEvidence(
      "build/reports/example.json",
      { summary: {} },
      { mtimeMs: now },
      { notBeforeMs: now }
    );
    expect(untrusted.fresh).toBe(false);
    expect(untrusted.source).toBe("file-mtime-not-trusted");

    const drift = createCurrentRunReportDriftAudit({
      beforeSnapshot: {},
      afterSnapshot: { "build/reports/stale.json": "a".repeat(64) },
      allowedReports: ["build/reports/allowed.json"]
    });
    expect(drift.consistent).toBe(false);
    expect(drift.currentRunOrphans).toEqual(["build/reports/stale.json"]);
  });

  it("writes a fresh plan to an isolated output root without replacing docs/plans", async () => {
    const outputRoot = path.join(repoRoot, "build", "clean-checkout-pr-simulation", "acceptance-test");
    const result = await simulateCleanCheckoutPr({ repoRoot, outputRoot });
    expect(result.ok).toBe(true);
    expect(result.docsPlansUnchanged).toBe(true);
    expect(result.plansRoot).toBe(path.join(repoRoot, "docs", "plans"));
    expect(result.nodes).toBeGreaterThan(0);
    for (const relativePath of [
      "Manifest.json",
      "Capabilities.json",
      "FutureGoals.md",
      "end-to-end-release/Plan.md",
      "end-to-end-release/Checkpoints.json",
      "end-to-end-release/DependencyMap.json"
    ]) {
      const content = await fs.readFile(path.join(outputRoot, relativePath), "utf8");
      expect(content.trim().length).toBeGreaterThan(0);
    }
    const checkpoints = JSON.parse(
      await fs.readFile(path.join(outputRoot, "end-to-end-release", "Checkpoints.json"), "utf8")
    );
    expect(Array.isArray(checkpoints)).toBe(true);
    expect(checkpoints.some((node) => node.code === "DQ-PROVENANCE")).toBe(true);
  });
});
