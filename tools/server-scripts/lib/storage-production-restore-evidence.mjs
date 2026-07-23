export const STORAGE_PRODUCTION_RESTORE_REPORT_PATH =
  "build/reports/storage-production-restore-drill/latest.json";
export const STORAGE_PRODUCTION_RESTORE_REPORT_SCHEMA_VERSION =
  "v0.0.1:storage:production-restore-drill-report-1";
export const STORAGE_PRODUCTION_RESTORE_VERIFIER =
  "tools/server-scripts/verify-storage-production-restore-drill.mjs";
export const STORAGE_PRODUCTION_RESTORE_READINESS_SOURCE =
  "tools/server-scripts/lib/storage-production-restore-evidence.mjs#createStorageProductionRestoreReadiness";
export const STORAGE_PRODUCTION_RESTORE_EVIDENCE_STATUS_ACCEPTED = "accepted";

const REQUIRED_OPERATION_SEQUENCE = Object.freeze([
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

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayEqual(left = [], right = []) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function addIfFalse(reasons, condition, reason) {
  if (!condition) {
    reasons.push(reason);
  }
}

export function createStorageProductionRestoreReadiness(report = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const selectedBackend = asRecord(record.selectedBackend);
  const operatorEvidence = asRecord(record.operatorEvidence);
  const operationRegistry = asRecord(operatorEvidence.operationRegistry);
  const restoreOperation = asRecord(operationRegistry["storage.backups.restore"]);
  const previewOperation = asRecord(operationRegistry["storage.backups.restore_preview"]);
  const retentionOperation = asRecord(operationRegistry["storage.backups.retention"]);
  const guardedRestore = asRecord(operatorEvidence.guardedRestoreWithoutConfirm);
  const confirmedRestore = asRecord(operatorEvidence.confirmedRestore);
  const dispatchResults = Array.isArray(operatorEvidence.dispatchResults)
    ? operatorEvidence.dispatchResults.map(asRecord)
    : [];
  const evidence = asRecord(record.evidence);
  const runbookPromotion = asRecord(operatorEvidence.runbookPromotion);
  const reasons = [];

  addIfFalse(reasons, record.schemaVersion === STORAGE_PRODUCTION_RESTORE_REPORT_SCHEMA_VERSION, "storage-production-restore-schema-mismatch");
  addIfFalse(reasons, record.verifier === STORAGE_PRODUCTION_RESTORE_VERIFIER, "storage-production-restore-verifier-mismatch");
  addIfFalse(reasons, record.redacted === true, "storage-production-restore-redaction-flag-missing");
  addIfFalse(reasons, record.rawPayloadIncluded !== true, "storage-production-restore-raw-payload-included");
  addIfFalse(reasons, record.ok === true, "storage-production-restore-verifier-not-ok");
  addIfFalse(reasons, !["releaseReady", "productionReady", "productionReleaseReady", "coverageReady"]
    .some((field) => Object.prototype.hasOwnProperty.call(record, field)), "storage-production-restore-child-readiness-self-proof-present");
  addIfFalse(reasons, !["releaseReady", "productionReady", "productionReleaseReady", "coverageReady", "reportLeakScan", "operatorDrillReady"]
    .some((field) => Object.prototype.hasOwnProperty.call(summary, field)), "storage-production-restore-child-summary-self-proof-present");
  addIfFalse(reasons, summary.operatorRunbookPromoted === true && runbookPromotion.missingTokenCount === 0, "storage-production-restore-runbook-not-promoted");
  addIfFalse(reasons, operatorEvidence.dispatchBoundary === "server-runtime.dispatchOperation", "storage-production-restore-dispatch-boundary-mismatch");
  addIfFalse(reasons, operatorEvidence.controllerBoundary === "system-controller-runtime-handlers", "storage-production-restore-controller-boundary-mismatch");
  addIfFalse(reasons, operatorEvidence.domainBoundary === "console-domain-operation-executor", "storage-production-restore-domain-boundary-mismatch");
  addIfFalse(reasons, arrayEqual(operatorEvidence.operationSequence, REQUIRED_OPERATION_SEQUENCE), "storage-production-restore-operation-sequence-mismatch");
  addIfFalse(reasons, dispatchResults.length === REQUIRED_OPERATION_SEQUENCE.length, "storage-production-restore-dispatch-result-count-mismatch");
  const deniedCreate = dispatchResults.find((entry) => entry.operationId === "storage.backups.create" && entry.statusCode === 403);
  const deniedRestore = dispatchResults.find((entry) => entry.operationId === "storage.backups.restore" && entry.statusCode === 428);
  const retentionDispatch = dispatchResults.find((entry) => entry.operationId === "storage.backups.retention");
  addIfFalse(reasons, deniedCreate?.authorizationDecision === "deny" && deniedCreate?.executed === false, "storage-production-restore-authorization-denial-not-proven");
  addIfFalse(reasons, deniedRestore?.authorizationDecision === "allow" && deniedRestore?.approvalDecision === "deny" && deniedRestore?.executed === false, "storage-production-restore-confirmation-denial-not-proven");
  addIfFalse(reasons, retentionDispatch?.authorizationDecision === "allow" && retentionDispatch?.approvalDecision === "allow" && retentionDispatch?.executed === true, "storage-production-restore-retention-dispatch-not-proven");
  addIfFalse(reasons, operatorEvidence.authorizationDeniedWithoutSideEffects === true && summary.authorizationDeniedWithoutSideEffects === true, "storage-production-restore-denial-had-side-effects");
  addIfFalse(reasons, Number(operatorEvidence.proofBeginCount || 0) === REQUIRED_OPERATION_SEQUENCE.length, "storage-production-restore-proof-begin-count-mismatch");
  addIfFalse(reasons, Number(operatorEvidence.proofFinishCount || 0) === REQUIRED_OPERATION_SEQUENCE.length, "storage-production-restore-proof-finish-count-mismatch");
  addIfFalse(reasons, Number(operatorEvidence.auditRecordCount || 0) === REQUIRED_OPERATION_SEQUENCE.length, "storage-production-restore-audit-count-mismatch");
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
  addIfFalse(reasons, evidence.restoreIntegrityVerified === true && summary.restoreIntegrityVerified === true, "storage-production-restore-file-integrity-not-verified");
  addIfFalse(reasons, evidence.onlineRestoreRejected === true && summary.onlineRestoreRejected === true, "storage-production-restore-online-restore-not-rejected");
  addIfFalse(reasons, selectedBackend.protocolVersion === "v0.0.1:storage:core-2", "storage-production-restore-storage-protocol-mismatch");
  addIfFalse(reasons, selectedBackend.backupProtocolVersion === "v0.0.1:storage:backup-restore-1", "storage-production-restore-backup-protocol-mismatch");

  const releaseReady = reasons.length === 0;
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
