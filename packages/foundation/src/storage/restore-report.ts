import {
  BACKUP_RESTORE_PROTOCOL_VERSION,
  nowIso,
  sha256Text
} from "./backup-contract.ts";
import { createStorageReceipt } from "./storage-evidence.ts";

export function createStorageRestoreReport({
  manifest,
  selectedEntries,
  plannedActions,
  shouldApply,
  receiptId = "",
  restoreSemantics
}: Record<string, any>) : any {
  const blocked: any = plannedActions.filter((action?: any) : any => action.action === "blocked").length;
  const selectedBackupActions: any = plannedActions.filter((action?: any) : any => action.action !== "delete");
  const summary: Record<string, any> = {
    create: plannedActions.filter((action?: any) : any => action.action === "create").length,
    replace: plannedActions.filter((action?: any) : any => action.action === "replace").length,
    noop: plannedActions.filter((action?: any) : any => action.action === "noop").length,
    delete: plannedActions.filter((action?: any) : any => action.action === "delete").length,
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
      verifiedFileCount: selectedBackupActions.filter((action?: any) : any => action.integrityVerified).length,
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
