import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import {
  RESTORE_REPORT_DIR,
  backupPath,
  isStorageError,
  nowIso,
  storageError
} from "./backup-contract.ts";
import { loadBackupManifest } from "./backup-manifest.ts";
import { copyStableRegularFile } from "./storage-file-safety.ts";
import { acquireStorageMaintenanceLock } from "./storage-lifecycle-lock.ts";
import { createStorageWorkTracker } from "./storage-maintenance-coordinator.ts";
import { createStorageRestorePlan } from "./restore-plan.ts";
import { createStorageRestoreReport } from "./restore-report.ts";
import { buildRestoreTransactionRecords } from "./restore-transaction-records.ts";
import {
  executeDurableRestoreTransaction,
  reconcileStorageRestoreTransactionsSync
} from "./restore-transaction.ts";

function attachInternalPath(value?: any, property?: any, internalPath?: any) : any {
  Object.defineProperty(value, property, {
    value: internalPath,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return value;
}

export async function restoreStorageBackup({
  userDataPath,
  backupId,
  dryRun = true,
  apply = false,
  includePaths = [],
  signal = null,
  budget = {},
  executionContext = null
}: Record<string, any> = {}) : Promise<any> {
  const rootPath: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker: any = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  const shouldApply: any = dryRun === false && apply === true;
  let maintenanceLock: any = null;
  try {
    if (shouldApply) {
      maintenanceLock = await acquireStorageMaintenanceLock(rootPath);
      await maintenanceLock.assertRestoreQuiesced();
      reconcileStorageRestoreTransactionsSync(rootPath);
    }
    const manifest: any = await loadBackupManifest({ userDataPath: rootPath, backupId });
    const plan: any = await createStorageRestorePlan({
      rootPath,
      manifest,
      includePaths,
      executionContext: tracker
    });
    if (!shouldApply) return plan.previewReport;
    const firstBlocked: any = plan.plannedActions.find((action?: any) : any => action.action === "blocked");
    if (firstBlocked) {
      throw storageError(
        "storage_restore_integrity_failed",
        "Storage restore was refused because backup integrity verification failed.",
        { detailReasonCode: firstBlocked.reason }
      );
    }
    const receiptId: any = `restore_${nowIso().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 12)}`;
    const report: any = createStorageRestoreReport({
      manifest,
      selectedEntries: plan.selectedEntries,
      plannedActions: plan.plannedActions,
      shouldApply: true,
      receiptId,
      restoreSemantics: plan.restoreSemantics
    });
    const reportPath: any = path.join(
      backupPath(rootPath, manifest.backupId),
      RESTORE_REPORT_DIR,
      `${receiptId}.json`
    );
    const records: any = await buildRestoreTransactionRecords({
      rootPath,
      entries: plan.selectedEntries,
      actions: plan.plannedActions
    });
    tracker.consume({ cleanupItems: records.length });
    tracker.assertActive();
    const selectedEntryByPath: any = new Map<any, any>(
      plan.selectedEntries.map((entry?: any) : any => [entry.relativePath, entry])
    );
    const committedReportPath: any = await executeDurableRestoreTransaction({
      userDataPath: rootPath,
      backupId: manifest.backupId,
      receiptId,
      report,
      records,
      stageInstall: async (record?: any, stagedPath?: any) : Promise<any> => {
        const entry: any = selectedEntryByPath.get(record.relativePath);
        if (!entry) {
          throw storageError(
            "storage_restore_transaction_invalid",
            "A restore transaction install target is missing its backup manifest entry."
          );
        }
        await copyStableRegularFile({
          sourcePath: path.join(plan.filesRoot, record.relativePath),
          targetPath: stagedPath,
          expectedBytes: entry.bytes,
          expectedSha256: entry.sha256,
          executionContext: tracker
        });
      }
    });
    if (committedReportPath !== reportPath) {
      throw storageError(
        "storage_restore_receipt_invalid",
        "Storage restore produced an unexpected receipt location."
      );
    }
    return attachInternalPath(report, "reportPath", committedReportPath);
  } catch (error: any) {
    if (isStorageError(error)) throw error;
    throw storageError("storage_restore_failed", "Storage restore could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock?.release().catch(() : any => {});
  }
}
