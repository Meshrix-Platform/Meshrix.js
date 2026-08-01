export const STORAGE_PRODUCTION_RESTORE_REPORT_PATH: any =
  "build/reports/storage-production-restore-drill/latest.json";
export const STORAGE_PRODUCTION_RESTORE_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:storage:production-restore-drill-report-1";
export const STORAGE_PRODUCTION_RESTORE_VERIFIER: any =
  "tools/server-scripts/verify-storage-production-restore-drill.ts";
export const STORAGE_PRODUCTION_RESTORE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/storage-production-restore-evidence.ts#createStorageProductionRestoreReadiness";
export const STORAGE_PRODUCTION_RESTORE_EVIDENCE_STATUS_ACCEPTED: any = "accepted";

const REQUIRED_OPERATION_SEQUENCE: readonly any[] = Object.freeze([
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
const AUDITED_OPERATION_COUNT: any = REQUIRED_OPERATION_SEQUENCE.filter(
  (operationId?: any) : any => operationId !== "storage.backups.list"
).length;

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayEqual(left: any = [], right: any = []) : any {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value?: any, index?: any) : any => value === right[index]);
}

function addIfFalse(reasons?: any, condition?: any, reason?: any) : any {
  if (!condition) {
    reasons.push(reason);
  }
}

export function createStorageProductionRestoreReadiness(report: Record<string, any> = {}) : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const selectedBackend: any = asRecord(record.selectedBackend);
  const operatorEvidence: any = asRecord(record.operatorEvidence);
  const operationRegistry: any = asRecord(operatorEvidence.operationRegistry);
  const restoreOperation: any = asRecord(operationRegistry["storage.backups.restore"]);
  const previewOperation: any = asRecord(operationRegistry["storage.backups.restore_preview"]);
  const retentionOperation: any = asRecord(operationRegistry["storage.backups.retention"]);
  const guardedRestore: any = asRecord(operatorEvidence.guardedRestoreWithoutConfirm);
  const confirmedRestore: any = asRecord(operatorEvidence.confirmedRestore);
  const dispatchResults: any = Array.isArray(operatorEvidence.dispatchResults)
    ? operatorEvidence.dispatchResults.map(asRecord)
    : [];
  const evidence: any = asRecord(record.evidence);
  const runbookPromotion: any = asRecord(operatorEvidence.runbookPromotion);
  const reasons: any[] = [];

  addIfFalse(reasons, record.schemaVersion === STORAGE_PRODUCTION_RESTORE_REPORT_SCHEMA_VERSION, "storage-production-restore-schema-mismatch");
  addIfFalse(reasons, record.verifier === STORAGE_PRODUCTION_RESTORE_VERIFIER, "storage-production-restore-verifier-mismatch");
  addIfFalse(reasons, record.redacted === true, "storage-production-restore-redaction-flag-missing");
  addIfFalse(reasons, record.rawPayloadIncluded !== true, "storage-production-restore-raw-payload-included");
  addIfFalse(reasons, record.ok === true, "storage-production-restore-verifier-not-ok");
  addIfFalse(reasons, !["releaseReady", "productionReady", "productionReleaseReady", "coverageReady"]
    .some((field?: any) : any => Object.prototype.hasOwnProperty.call(record, field)), "storage-production-restore-child-readiness-self-proof-present");
  addIfFalse(reasons, !["releaseReady", "productionReady", "productionReleaseReady", "coverageReady", "reportLeakScan", "operatorDrillReady"]
    .some((field?: any) : any => Object.prototype.hasOwnProperty.call(summary, field)), "storage-production-restore-child-summary-self-proof-present");
  addIfFalse(reasons, summary.operatorRunbookPromoted === true && runbookPromotion.missingTokenCount === 0, "storage-production-restore-runbook-not-promoted");
  addIfFalse(reasons, operatorEvidence.dispatchBoundary === "server-runtime.dispatchOperation", "storage-production-restore-dispatch-boundary-mismatch");
  addIfFalse(reasons, operatorEvidence.controllerBoundary === "system-controller-runtime-handlers", "storage-production-restore-controller-boundary-mismatch");
  addIfFalse(reasons, operatorEvidence.domainBoundary === "console-domain-operation-executor", "storage-production-restore-domain-boundary-mismatch");
  addIfFalse(reasons, arrayEqual(operatorEvidence.operationSequence, REQUIRED_OPERATION_SEQUENCE), "storage-production-restore-operation-sequence-mismatch");
  addIfFalse(reasons, dispatchResults.length === REQUIRED_OPERATION_SEQUENCE.length, "storage-production-restore-dispatch-result-count-mismatch");
  const deniedCreate: any = dispatchResults.find((entry?: any) : any => entry.operationId === "storage.backups.create" && entry.statusCode === 403);
  const deniedRestore: any = dispatchResults.find((entry?: any) : any => entry.operationId === "storage.backups.restore" && entry.statusCode === 428);
  const retentionDispatch: any = dispatchResults.find((entry?: any) : any => entry.operationId === "storage.backups.retention");
  addIfFalse(reasons, deniedCreate?.authorizationDecision === "deny" && deniedCreate?.executed === false, "storage-production-restore-authorization-denial-not-proven");
  addIfFalse(reasons, deniedRestore?.authorizationDecision === "allow" && deniedRestore?.approvalDecision === "deny" && deniedRestore?.executed === false, "storage-production-restore-confirmation-denial-not-proven");
  addIfFalse(reasons, retentionDispatch?.authorizationDecision === "allow" && retentionDispatch?.approvalDecision === "allow" && retentionDispatch?.executed === true, "storage-production-restore-retention-dispatch-not-proven");
  addIfFalse(reasons, operatorEvidence.authorizationDeniedWithoutSideEffects === true && summary.authorizationDeniedWithoutSideEffects === true, "storage-production-restore-denial-had-side-effects");
  addIfFalse(
    reasons,
    Number(operatorEvidence.proofBeginCount || 0) === Number(operatorEvidence.proofFinishCount || 0),
    "storage-production-restore-proof-lifecycle-unbalanced"
  );
  addIfFalse(reasons, Number(operatorEvidence.proofBeginCount || 0) > 0, "storage-production-restore-proof-begin-count-missing");
  addIfFalse(
    reasons,
    Number(operatorEvidence.auditRecordCount || 0) === AUDITED_OPERATION_COUNT,
    "storage-production-restore-audit-count-mismatch"
  );
  addIfFalse(reasons, restoreOperation.requiresConfirmation === true, "storage-production-restore-confirmation-not-required");
  addIfFalse(reasons, restoreOperation.risk === "repair_write", "storage-production-restore-risk-not-repair-write");
  addIfFalse(reasons, previewOperation.readOnly === true, "storage-production-restore-preview-not-read-only");
  addIfFalse(reasons, retentionOperation.requiresConfirmation === true && retentionOperation.risk === "repair_write", "storage-production-restore-retention-risk-contract-mismatch");
  addIfFalse(reasons, guardedRestore.statusCode === 428 && guardedRestore.confirmationRequired === true, "storage-production-restore-unguarded-restore-not-denied");
  addIfFalse(reasons, confirmedRestore.dryRun === false && confirmedRestore.applied === true, "storage-production-restore-confirmed-restore-not-applied");
  addIfFalse(reasons, Number(confirmedRestore.blocked || 0) === 0, "storage-production-restore-confirmed-restore-blocked");
  addIfFalse(reasons, evidence.restoredSettingsMatchBaseline === true, "storage-production-restore-settings-not-restored");
  addIfFalse(reasons, evidence.restoredJobMetaMatchBaseline === true, "storage-production-restore-job-meta-not-restored");
  addIfFalse(reasons, evidence.restoredUploadSessionMatchBaseline === true, "storage-production-restore-upload-session-not-restored");
  addIfFalse(reasons, evidence.restoredObjectMatchBaseline === true, "storage-production-restore-object-not-restored");
  addIfFalse(reasons, evidence.storageKernelReopenedAfterRestore === true && summary.storageKernelReopenedAfterRestore === true, "storage-production-restore-kernel-not-reopened");
  addIfFalse(reasons, evidence.backupManifestIntegrityVerified === true && summary.backupManifestIntegrityVerified === true, "storage-production-restore-manifest-integrity-not-verified");
  addIfFalse(reasons, evidence.secretCustodyExcluded === true && summary.secretCustodyExcluded === true, "storage-production-restore-secret-custody-not-excluded");
  addIfFalse(reasons, evidence.restoreIntegrityVerified === true && summary.restoreIntegrityVerified === true, "storage-production-restore-file-integrity-not-verified");
  addIfFalse(reasons, evidence.onlineRestoreRejected === true && summary.onlineRestoreRejected === true, "storage-production-restore-online-restore-not-rejected");
  addIfFalse(reasons, selectedBackend.protocolVersion === "v0.0.1:storage:core-2", "storage-production-restore-storage-protocol-mismatch");
  addIfFalse(reasons, selectedBackend.backupProtocolVersion === "v0.0.1:storage:backup-restore-1", "storage-production-restore-backup-protocol-mismatch");

  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: STORAGE_PRODUCTION_RESTORE_READINESS_SOURCE,
    report: STORAGE_PRODUCTION_RESTORE_REPORT_PATH,
    releaseReady,
    coverageReady: releaseReady,
    productionReleaseReady: releaseReady,
    productionReleaseStatus: releaseReady ? "ready" : "blocked",
    productionRestoreEvidenceStatus: releaseReady ? STORAGE_PRODUCTION_RESTORE_EVIDENCE_STATUS_ACCEPTED : "rejected",
    productionRestoreEvidenceAccepted: releaseReady,
    reasons
  };
}
