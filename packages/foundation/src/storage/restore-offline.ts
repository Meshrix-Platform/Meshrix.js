import fs from "node:fs/promises";
import path from "node:path";

import { normalizeBackupId, storageError } from "./backup-contract.ts";
import { restoreStorageBackup } from "./restore-execution.ts";

export type OfflineStorageRestoreMode = "preview" | "apply";

export interface OfflineStorageRestoreRequest {
  dataRoot: string;
  backupId: string;
  mode: OfflineStorageRestoreMode;
  confirm?: boolean;
}

export interface OfflineStorageRestoreResult {
  schemaVersion: "v0.0.1:schema:definition-1";
  mode: OfflineStorageRestoreMode;
  backupId: string;
  generatedAt: string;
  applied: boolean;
  restoreSemantics: "replacement" | "overlay";
  selectedFileCount: number;
  integrity: {
    verified: boolean;
    verifiedFileCount: number;
    failedFileCount: number;
  };
  summary: {
    create: number;
    replace: number;
    noop: number;
    delete: number;
    blocked: number;
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

async function resolveDataRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw storageError("storage_data_root_invalid", "An absolute data root is required.");
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  let canonicalRoot: string;
  try {
    [stat, canonicalRoot] = await Promise.all([fs.lstat(value), fs.realpath(value)]);
  } catch {
    throw storageError("storage_data_root_unavailable", "The selected data root is unavailable.");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError("storage_data_root_invalid", "The selected data root must be a real directory.");
  }
  return canonicalRoot;
}

function projectResult(
  value: unknown,
  request: Pick<OfflineStorageRestoreRequest, "mode" | "backupId">
): OfflineStorageRestoreResult {
  const source = record(value);
  const integrity = record(source.integrity);
  const summary = record(source.summary);
  const counts = {
    create: count(summary.create),
    replace: count(summary.replace),
    noop: count(summary.noop),
    delete: count(summary.delete),
    blocked: count(summary.blocked)
  };
  const integrityCounts = {
    verifiedFileCount: count(integrity.verifiedFileCount),
    failedFileCount: count(integrity.failedFileCount)
  };
  if (
    source.backupId !== request.backupId ||
    source.dryRun !== (request.mode === "preview") ||
    source.applied !== (request.mode === "apply") ||
    (source.restoreSemantics !== "replacement" && source.restoreSemantics !== "overlay") ||
    typeof source.generatedAt !== "string" ||
    count(source.selectedFileCount) === null ||
    typeof integrity.verified !== "boolean" ||
    Object.values(counts).some((entry) => entry === null) ||
    integrityCounts.verifiedFileCount === null ||
    integrityCounts.failedFileCount === null
  ) {
    throw storageError("storage_restore_result_invalid", "Restore returned an invalid summary.");
  }

  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    mode: request.mode,
    backupId: request.backupId,
    generatedAt: source.generatedAt,
    applied: source.applied,
    restoreSemantics: source.restoreSemantics,
    selectedFileCount: count(source.selectedFileCount) as number,
    integrity: {
      verified: integrity.verified,
      verifiedFileCount: integrityCounts.verifiedFileCount as number,
      failedFileCount: integrityCounts.failedFileCount as number
    },
    summary: {
      create: counts.create as number,
      replace: counts.replace as number,
      noop: counts.noop as number,
      delete: counts.delete as number,
      blocked: counts.blocked as number
    }
  };
}

/** Runs the existing restore authority without opening the storage runtime. */
export async function restoreOfflineStorage(
  request: OfflineStorageRestoreRequest
): Promise<OfflineStorageRestoreResult> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw storageError("storage_restore_request_invalid", "A restore request is required.");
  }
  if (request.mode !== "preview" && request.mode !== "apply") {
    throw storageError("storage_restore_mode_invalid", "Restore mode must be preview or apply.");
  }
  if (request.mode === "apply" && request.confirm !== true) {
    throw storageError("storage_restore_confirmation_required", "Applying a restore requires explicit confirmation.");
  }
  if (request.mode === "preview" && request.confirm === true) {
    throw storageError("storage_restore_confirmation_unexpected", "Preview does not accept apply confirmation.");
  }

  const dataRoot = await resolveDataRoot(request.dataRoot);
  const backupId = normalizeBackupId(request.backupId);
  const rawResult = await restoreStorageBackup({
    userDataPath: dataRoot,
    backupId,
    dryRun: request.mode === "preview",
    apply: request.mode === "apply"
  });
  return projectResult(rawResult, { mode: request.mode, backupId });
}
