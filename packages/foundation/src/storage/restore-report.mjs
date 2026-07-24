import {
  BACKUP_RESTORE_PROTOCOL_VERSION,
  nowIso,
  sha256Text
} from "./backup-contract.mjs";
import { createStorageReceipt } from "./storage-evidence.mjs";

export function createStorageRestoreReport({
  manifest,
  selectedEntries,
  plannedActions,
  shouldApply,
  receiptId = "",
  restoreSemantics
}) {
  const blocked = plannedActions.filter((action) => action.action === "blocked").length;
  const selectedBackupActions = plannedActions.filter((action) => action.action !== "delete");
  const summary = {
    create: plannedActions.filter((action) => action.action === "create").length,
    replace: plannedActions.filter((action) => action.action === "replace").length,
    noop: plannedActions.filter((action) => action.action === "noop").length,
    delete: plannedActions.filter((action) => action.action === "delete").length,
    blocked
  };
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    backupId: manifest.backupId,
    generatedAt: nowIso(),
    dryRun: !shouldApply,
    applied: shouldApply,
    receiptId,
    restoreSemantics,
    selectedFileCount: selectedEntries.length,
    integrity: {
      verified: blocked === 0,
      verifiedFileCount: selectedBackupActions.filter((action) => action.integrityVerified).length,
      failedFileCount: blocked
    },
    summary,
    receipt: createStorageReceipt({
      kind: shouldApply ? "backup-restore" : "backup-restore-preview",
      status: shouldApply ? "applied" : "verified",
      ...(receiptId ? { receiptId } : {}),
      counts: {
        selected: selectedEntries.length,
        changed: summary.create + summary.replace + summary.delete,
        blocked
      },
      digestPrefixes: {
        manifest: sha256Text(JSON.stringify(manifest.files)).slice(0, 16)
      }
    }),
    plannedActions
  };
}
