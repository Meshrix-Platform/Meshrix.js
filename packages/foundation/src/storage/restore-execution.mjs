import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";
import {
  RESTORE_REPORT_DIR,
  backupPath,
  isStorageError,
  nowIso,
  storageError
} from "./backup-contract.mjs";
import { loadBackupManifest } from "./backup-manifest.mjs";
import { copyStableRegularFile } from "./storage-file-safety.mjs";
import { acquireStorageMaintenanceLock } from "./storage-lifecycle-lock.mjs";
import { createStorageWorkTracker } from "./storage-maintenance-coordinator.mjs";
import { createStorageRestorePlan } from "./restore-plan.mjs";
import { createStorageRestoreReport } from "./restore-report.mjs";
import { buildRestoreTransactionRecords } from "./restore-transaction-records.mjs";
import {
  executeDurableRestoreTransaction,
  reconcileStorageRestoreTransactionsSync
} from "./restore-transaction.mjs";

function attachInternalPath(value, property, internalPath) {
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
} = {}) {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  const shouldApply = dryRun === false && apply === true;
  let maintenanceLock = null;
  try {
    if (shouldApply) {
      maintenanceLock = await acquireStorageMaintenanceLock(rootPath);
      await maintenanceLock.assertRestoreQuiesced();
      reconcileStorageRestoreTransactionsSync(rootPath);
    }
    const manifest = await loadBackupManifest({ userDataPath: rootPath, backupId });
    const plan = await createStorageRestorePlan({
      rootPath,
      manifest,
      includePaths,
      executionContext: tracker
    });
    if (!shouldApply) return plan.previewReport;
    const firstBlocked = plan.plannedActions.find((action) => action.action === "blocked");
    if (firstBlocked) {
      throw storageError(
        "storage_restore_integrity_failed",
        "Storage restore was refused because backup integrity verification failed.",
        { detailReasonCode: firstBlocked.reason }
      );
    }
    const receiptId = `restore_${nowIso().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 12)}`;
    const report = createStorageRestoreReport({
      manifest,
      selectedEntries: plan.selectedEntries,
      plannedActions: plan.plannedActions,
      shouldApply: true,
      receiptId,
      restoreSemantics: plan.restoreSemantics
    });
    const reportPath = path.join(
      backupPath(rootPath, manifest.backupId),
      RESTORE_REPORT_DIR,
      `${receiptId}.json`
    );
    const records = await buildRestoreTransactionRecords({
      rootPath,
      entries: plan.selectedEntries,
      actions: plan.plannedActions
    });
    tracker.consume({ cleanupItems: records.length });
    tracker.assertActive();
    const selectedEntryByPath = new Map(
      plan.selectedEntries.map((entry) => [entry.relativePath, entry])
    );
    const committedReportPath = await executeDurableRestoreTransaction({
      userDataPath: rootPath,
      backupId: manifest.backupId,
      receiptId,
      report,
      records,
      stageInstall: async (record, stagedPath) => {
        const entry = selectedEntryByPath.get(record.relativePath);
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
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw storageError("storage_restore_failed", "Storage restore could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock?.release().catch(() => {});
  }
}
