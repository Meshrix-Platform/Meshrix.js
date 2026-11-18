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
import type {
  RestoreEntry,
  RestoreTransactionRecord
} from "./restore-transaction-records.ts";
import {
  executeDurableRestoreTransaction,
  reconcileStorageRestoreTransactionsSync
} from "./restore-transaction.ts";

type UnknownRecord = Record<string, unknown>;

interface StorageWorkTracker {
  assertActive(): void;
  consume(value: { files?: number; bytes?: number; cleanupItems?: number }): void;
}

interface MaintenanceLock {
  assertRestoreQuiesced(): Promise<void>;
  release(): Promise<void>;
}

function attachInternalPath<T extends object>(value: T, property: PropertyKey, internalPath: string): T {
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
}: {
  userDataPath?: string;
  backupId?: string;
  dryRun?: boolean;
  apply?: boolean;
  includePaths?: readonly string[];
  signal?: AbortSignal | null;
  budget?: UnknownRecord;
  executionContext?: StorageWorkTracker | null;
} = {}): Promise<unknown> {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker = executionContext || createStorageWorkTracker({ signal, budget }) as StorageWorkTracker;
  tracker.assertActive();
  const shouldApply = dryRun === false && apply === true;
  let maintenanceLock: MaintenanceLock | null = null;
  try {
    if (shouldApply) {
      maintenanceLock = await acquireStorageMaintenanceLock(rootPath) as MaintenanceLock;
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
    const selectedEntryByPath = new Map<string, RestoreEntry>(
      plan.selectedEntries.map((entry) => [entry.relativePath, entry])
    );
    const committedReportPath = await executeDurableRestoreTransaction({
      userDataPath: rootPath,
      backupId: manifest.backupId,
      receiptId,
      report,
      records,
      stageInstall: async (record: RestoreTransactionRecord, stagedPath: string): Promise<void> => {
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
  } catch (error: unknown) {
    if (isStorageError(error)) throw error;
    throw storageError("storage_restore_failed", "Storage restore could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock?.release().catch(() => {});
  }
}
