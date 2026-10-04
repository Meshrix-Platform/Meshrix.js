import { describe, expect, it } from "vitest";
import {
  STORAGE_PRODUCTION_RESTORE_REPORT_PATH,
  createStorageProductionRestoreReadiness
} from "../../../tools/server-scripts/lib/storage-production-restore-evidence.ts";
import { createReleaseEvidenceReadiness } from "../../../tools/server-scripts/lib/release-evidence-readiness.ts";

const operationSequence: readonly any[] = Object.freeze([
  "storage.backups.list",
  "storage.backups.create",
  "storage.backups.list",
  "storage.backups.create",
  "storage.backups.retention",
  "storage.backups.list",
  "storage.backups.restore",
  "storage.backups.restore_preview",
  "storage.backups.restore",
  "storage.backups.restore"
]);

function reportFixture() : any {
  const dispatchResults: any = operationSequence.map((operationId?: any, index?: any) : any => ({
    operationId,
    authorizationDecision: index === 1 ? "deny" : "allow",
    approvalDecision: index === 6 ? "deny" : index === 1 ? "" : "allow",
    executed: ![1, 6].includes(index),
    statusCode: index === 1 ? 403 : index === 6 ? 428 : index === 9 ? 409 : 200
  }));
  return {
    schemaVersion: "v0.0.1:storage:production-restore-drill-report-1",
    verifier: "tools/server-scripts/verify-storage-production-restore-drill.ts",
    generatedAt: new Date().toISOString(),
    ok: true,
    redacted: true,
    rawPayloadIncluded: false,
    summary: {
      operatorRunbookPromoted: true,
      authorizationDeniedWithoutSideEffects: true,
      backupManifestIntegrityVerified: true,
      secretCustodyExcluded: true,
      restoreIntegrityVerified: true,
      onlineRestoreRejected: true,
      storageKernelReopenedAfterRestore: true,
      offlineCliRestoreVerified: true,
      offlineCliActiveOwnerRefusalVerified: true
    },
    selectedBackend: {
      protocolVersion: "v0.0.1:storage:core-2",
      backupProtocolVersion: "v0.0.1:storage:backup-restore-1"
    },
    operatorEvidence: {
      dispatchBoundary: "server-runtime.dispatchOperation",
      controllerBoundary: "system-controller-runtime-handlers",
      domainBoundary: "console-domain-operation-executor",
      operationSequence,
      dispatchResults,
      proofBeginCount: 4,
      proofFinishCount: 4,
      auditRecordCount: operationSequence.filter((operationId?: any) : any => operationId !== "storage.backups.list").length,
      authorizationDeniedWithoutSideEffects: true,
      runbookPromotion: { missingTokenCount: 0 },
      operationRegistry: {
        "storage.backups.retention": { risk: "repair_write", requiresConfirmation: true },
        "storage.backups.restore_preview": { readOnly: true },
        "storage.backups.restore": { risk: "repair_write", requiresConfirmation: true }
      },
      guardedRestoreWithoutConfirm: { statusCode: 428, confirmationRequired: true },
      confirmedRestore: { dryRun: false, applied: true, blocked: 0 },
      offlineCli: {
        previewSucceeded: true,
        previewWasReadOnly: true,
        previewIntegrityVerified: true,
        applySucceeded: true,
        applyWasApplied: true,
        applyIntegrityVerified: true,
        activeOwnerErrorCode: "storage_restore_runtime_active",
        activeOwnerDataPreserved: true,
        maxOutputBytes: 512
      }
    },
    evidence: {
      restoredSettingsMatchBaseline: true,
      restoredJobMetaMatchBaseline: true,
      restoredUploadSessionMatchBaseline: true,
      restoredObjectMatchBaseline: true,
      storageKernelReopenedAfterRestore: true,
      backupManifestIntegrityVerified: true,
      secretCustodyExcluded: true,
      restoreIntegrityVerified: true,
      onlineRestoreRejected: true,
      offlineCliRestoreVerified: true,
      offlineCliActiveOwnerRefusalVerified: true,
      offlineCliPreservedGovernedState: true,
      offlineCliPreservedIndependentKeys: true
    }
  };
}

describe("storage production restore parent reduction", () : any => {
  it("accepts dispatcher facts only after the parent validator performs the leak scan", () : any => {
    const readiness: any = createReleaseEvidenceReadiness(STORAGE_PRODUCTION_RESTORE_REPORT_PATH, reportFixture());
    expect(readiness).toMatchObject({
      releaseReady: true,
      requiredReportValidationPassed: true,
      reportLeakScan: true,
      productionRestoreEvidenceAccepted: true
    });
  });

  it("rejects child-owned readiness and leak-scan self-assertions", () : any => {
    const childClaim: any = reportFixture();
    childClaim.releaseReady = true;
    childClaim.summary.reportLeakScan = true;
    const readiness: any = createStorageProductionRestoreReadiness(childClaim);
    expect(readiness.releaseReady).toBe(false);
    expect(readiness.reasons).toEqual(expect.arrayContaining([
      "storage-production-restore-child-readiness-self-proof-present",
      "storage-production-restore-child-summary-self-proof-present"
    ]));
  });

  it("does not accept the dispatcher drill without direct offline CLI evidence", () : any => {
    const incomplete: any = reportFixture();
    delete incomplete.operatorEvidence.offlineCli;
    incomplete.summary.offlineCliRestoreVerified = false;
    const readiness: any = createStorageProductionRestoreReadiness(incomplete);
    expect(readiness.releaseReady).toBe(false);
    expect(readiness.reasons).toContain("storage-production-restore-offline-cli-preview-not-verified");
  });
});
