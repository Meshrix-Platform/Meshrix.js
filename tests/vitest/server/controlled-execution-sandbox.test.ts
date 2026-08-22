import { describe, expect, it } from "vitest";

import { runControlledExecutionSandboxVerification } from "../../../tools/server-scripts/verify-controlled-execution-sandbox.ts";
import { createReleaseEvidenceReadiness } from "../../../tools/server-scripts/lib/release-evidence-readiness.ts";

describe("controlled execution sandbox", () : any => {
  it("fails closed across admission and lifecycle paths without claiming a production backend", async () : Promise<any> => {
    const report: any = await runControlledExecutionSandboxVerification({ writeReport: false });

    expect(report.summary).toEqual({
      contractChecksPassed: true,
      productionBackendConformance: false,
      opaqueCustodyReady: true,
      sandboxAcceptanceReady: false,
      reportLeakScan: true
    });
    expect(report.checks).toMatchObject({
      unconfiguredDeniedWithoutSideEffects: true,
      disabledDeniedWithoutSideEffects: true,
      missingBackendDeniedWithoutSideEffects: true,
      unhealthyBackendDeniedWithoutSideEffects: true,
      unsupportedPolicyDeniedWithoutSideEffects: true,
      fakeBackendLifecycleCompleted: true,
      cancellationTerminatesAndCleans: true,
      timeoutTerminatesAndCleans: true,
      cleanupFailureCannotSucceed: true,
      noHostFallback: true,
      receiptRedacted: true,
      reportLeakScan: true
    });
    expect(report.blockers).toEqual(["production_backend_conformance_receipt_missing"]);
    expect(report.productionBackendFailedChecks).toEqual([]);
    expect(report.opaqueCustodyReport.schemaVersion).toBe(
      "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1"
    );

    const readiness: any = createReleaseEvidenceReadiness(
      "build/reports/controlled-execution-sandbox.json",
      report,
      {
        minimumTimestampMs: Date.parse(report.generatedAt) - 1,
        nowMs: Date.parse(report.generatedAt) + 1
      }
    );
    expect(readiness.releaseReady).toBe(false);
  });
});
