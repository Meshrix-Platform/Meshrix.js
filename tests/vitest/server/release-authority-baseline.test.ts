import { describe, expect, it } from "vitest";

import {
  loadReleaseAuthorityBaselineRegistry,
  validateReleaseAuthorityBaselineFindings
} from "../../../tools/verifiers/registry-release-authority-baseline.ts";
import {
  createReleaseEvidenceReadiness
} from "../../../tools/server-scripts/lib/release-evidence-readiness.ts";
import {
  requiredReportSpec,
  validateRequiredReport
} from "../../../tools/server-scripts/lib/required-report-validator.ts";

describe("release authority baseline", () : any => {
  it("identifies every current release-graph authority category from live catalogs", async () : Promise<any> => {
    const { data, registryPath, rootDir } = await loadReleaseAuthorityBaselineRegistry();
    const { findings, coverage } = await validateReleaseAuthorityBaselineFindings(data, {
      rootDir,
      registryPath
    });

    expect(findings).toEqual([]);
    expect(coverage.commands.length).toBeGreaterThan(10);
    expect(coverage.reports.length).toBeGreaterThan(10);
    expect(coverage.capabilities.length).toBeGreaterThan(5);
    expect(coverage.checkpoints.length).toBe(coverage.capabilities.length);
    expect(coverage.reducerInputs).toEqual(expect.arrayContaining([
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
      "tools/server-scripts/lib/platform-acceptance-reducer.ts",
      "tools/server-scripts/lib/required-report-validator.ts"
    ]));
    expect(coverage.requiredReportSpecs.length).toBeGreaterThan(10);
    expect(coverage.generatedProjections.length).toBeGreaterThan(0);
    expect(coverage.sourceAuthorities.length).toBeGreaterThan(5);
    expect(coverage.commands).toContain("upstream-service-publishing");
    expect(coverage.reports).toContain("build/reports/upstream-service-publishing.json");
  });

  it("names retained positive forwarding and every lockdown or static-only authority to remove later", async () : Promise<any> => {
    const { data, registryPath, rootDir } = await loadReleaseAuthorityBaselineRegistry();
    const { findings, inventory } = await validateReleaseAuthorityBaselineFindings(data, {
      rootDir,
      registryPath
    });

    expect(findings).toEqual([]);
    expect(inventory.retainedPositiveForwardingIds).toEqual(expect.arrayContaining([
      "fact-source-authority-positive-path",
      "platform-acceptance-reducer-positive-path",
      "capability-acceptance-positive-path"
    ]));
    expect(inventory.removeLaterIds).toEqual(expect.arrayContaining([
      "security-local-stdio-lockdown",
      "static-only-placeholder-report-success"
    ]));
    const removeLater: any = data.migrationInventory.removeLaterLockdownOrStaticOnly;
    expect(removeLater.every((entry?: any) : any => entry.status === "present-must-remove-after-positive-path")).toBe(true);
    expect(removeLater.some((entry?: any) : any => entry.classification === "lockdown")).toBe(true);
    expect(removeLater.some((entry?: any) : any => entry.classification === "static-only")).toBe(true);

    const retained: any = data.migrationInventory.retainedPositiveForwarding;
    expect(retained.every((entry?: any) : any => Array.isArray(entry.assertions) && entry.assertions.length > 0)).toBe(true);
  });

  it("rejects placeholder gates and reports as required release facts", async () : Promise<any> => {
    const { data } = await loadReleaseAuthorityBaselineRegistry();
    expect(data.policy.placeholderReportsCannotSatisfyReleaseFacts).toBe(true);
    expect(data.policy.neverImportGeneratedReportStatus).toBe(true);

    const placeholderPath: any = "build/reports/repo-organization.json";
    const placeholderReport: Record<string, any> = {
      schemaVersion: "placeholder",
      verifier: "placeholder-gate",
      generatedAt: "1970-01-01T00:00:00.000Z",
      summary: {
        releaseReady: true,
        reportLeakScan: true
      },
      releaseReady: true
    };

    const validation: any = validateRequiredReport(placeholderPath, placeholderReport, {
      nowMs: Date.parse("2026-07-12T00:00:00.000Z"),
      minimumTimestampMs: Date.parse("2026-07-12T00:00:00.000Z")
    });
    expect(validation.accepted).toBe(false);
    expect(validation.reasons.length).toBeGreaterThan(0);

    const readiness: any = createReleaseEvidenceReadiness(placeholderPath, placeholderReport);
    expect(readiness.releaseReady).toBe(false);
    expect(readiness.reasons.length).toBeGreaterThan(0);

    const staticOnly: any = data.migrationInventory.removeLaterLockdownOrStaticOnly
      .find((entry?: any) : any => entry.id === "static-only-placeholder-report-success");
    expect(staticOnly?.classification).toBe("static-only");
    expect(staticOnly?.status).toBe("present-must-remove-after-positive-path");

    const spec: any = requiredReportSpec(placeholderPath);
    expect(spec.path).toBe(placeholderPath);
    expect(spec.reducer).toBeTruthy();
  });

  it("fails closed on contradictory inventory classifications", async () : Promise<any> => {
    const { data, registryPath, rootDir } = await loadReleaseAuthorityBaselineRegistry();
    const mutated: any = structuredClone(data);
    mutated.migrationInventory.retainedPositiveForwarding.push({
      id: "security-local-stdio-lockdown",
      classification: "retained-positive-forwarding",
      description: "contradiction fixture",
      authorityPaths: ["tools/server-scripts/verify-security-local-stdio-lockdown.ts"],
      assertions: ["contradiction"]
    });

    const { findings } = await validateReleaseAuthorityBaselineFindings(mutated, {
      rootDir,
      registryPath
    });
    const kinds: any = findings.map((finding?: any) : any => finding.kind);
    expect(kinds).toContain("inventory-classification-contradiction");
  });
});
