import fs from "node:fs/promises";
import path from "node:path";
import {
  SQLITE_SIDECAR_SUFFIXES,
  backupFilesRoot,
  isSqliteDataFile,
  safeRelativePath,
  storageError
} from "./backup-contract.ts";
import {
  collectSnapshotSources,
  inspectStableFile,
  pathBoundaryReason,
  pathExists
} from "./storage-file-safety.ts";
import { createStorageRestoreReport } from "./restore-report.ts";
import type { BackupManifestEntry, ValidatedBackupManifest } from "./backup-manifest.ts";
import type { RestoreAction } from "./restore-transaction-records.ts";

interface StorageWorkTracker {
  assertActive(): void;
  consume(value: { files?: number; bytes?: number; cleanupItems?: number }): void;
}

interface FileIntegrity {
  bytes: number;
  sha256: string;
}

type BackupEntryVerification =
  | { ok: true; integrity: FileIntegrity }
  | { ok: false; reason: string };

interface SnapshotSource {
  relativePath: string;
  category: string;
}

export interface StorageRestorePlan {
  manifest: ValidatedBackupManifest;
  filesRoot: string;
  selectedEntries: readonly BackupManifestEntry[];
  plannedActions: readonly RestoreAction[];
  restoreSemantics: "replacement" | "overlay";
  previewReport: Record<string, unknown>;
}

function errorField(error: unknown, field: "name" | "code"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const source = error as Record<string, unknown>;
  return String(source[field] || "");
}

async function verifyBackupEntry({
  filesRoot,
  entry,
  executionContext = null
}: {
  filesRoot: string;
  entry: BackupManifestEntry;
  executionContext?: StorageWorkTracker | null;
}): Promise<BackupEntryVerification> {
  const relativePath = safeRelativePath(entry.relativePath);
  const backupFilePath = path.join(filesRoot, relativePath);
  if (!await pathExists(backupFilePath)) return { ok: false, reason: "backup_file_missing" };
  const boundaryReason: string = await pathBoundaryReason({
    rootPath: filesRoot,
    targetPath: backupFilePath,
    allowMissingTarget: false
  });
  if (boundaryReason) return { ok: false, reason: `backup_${boundaryReason}` };
  try {
    const integrity: FileIntegrity = await inspectStableFile(backupFilePath, {
      changedCode: "backup_file_changed",
      executionContext
    });
    if (integrity.bytes !== entry.bytes) return { ok: false, reason: "backup_size_mismatch" };
    if (integrity.sha256 !== entry.sha256) return { ok: false, reason: "backup_hash_mismatch" };
    return { ok: true, integrity };
  } catch (error: unknown) {
    if (errorField(error, "name") === "StorageMaintenanceError") throw error;
    return { ok: false, reason: errorField(error, "code") || "backup_file_unreadable" };
  }
}

async function inspectSqliteSidecarsForRestore({
  rootPath,
  targetPath
}: {
  rootPath: string;
  targetPath: string;
}): Promise<{ present: boolean; blockedReason: string }> {
  let present = false;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${targetPath}${suffix}`;
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(sidecarPath);
    } catch (error: unknown) {
      if (errorField(error, "code") === "ENOENT") continue;
      return { present, blockedReason: "sqlite_sidecar_unreadable" };
    }
    const boundaryReason: string = await pathBoundaryReason({
      rootPath,
      targetPath: sidecarPath,
      allowMissingTarget: false
    });
    if (boundaryReason || !stat.isFile() || stat.isSymbolicLink()) {
      return { present, blockedReason: "sqlite_sidecar_unsafe" };
    }
    present = true;
  }
  return { present, blockedReason: "" };
}

async function buildRestoreAction({
  rootPath,
  filesRoot,
  entry,
  executionContext = null
}: {
  rootPath: string;
  filesRoot: string;
  entry: BackupManifestEntry;
  executionContext?: StorageWorkTracker | null;
}): Promise<RestoreAction> {
  const relativePath = safeRelativePath(entry.relativePath);
  const targetPath = path.join(rootPath, relativePath);
  const backupIntegrity = await verifyBackupEntry({ filesRoot, entry, executionContext });
  const baseAction: Omit<RestoreAction, "action" | "reason"> = {
    relativePath,
    category: entry.category,
    expectedBytes: entry.bytes,
    expectedSha256: entry.sha256,
    currentBytes: 0,
    currentSha256: "",
    integrityVerified: backupIntegrity.ok
  };
  if (!backupIntegrity.ok) {
    return { ...baseAction, action: "blocked", reason: backupIntegrity.reason };
  }
  const targetBoundaryReason: string = await pathBoundaryReason({
    rootPath,
    targetPath,
    allowMissingTarget: true
  });
  if (targetBoundaryReason) {
    return { ...baseAction, action: "blocked", reason: targetBoundaryReason };
  }
  if (!await pathExists(targetPath)) {
    return { ...baseAction, action: "create", reason: "target_missing" };
  }
  try {
    const current: FileIntegrity = await inspectStableFile(targetPath, {
      changedCode: "restore_target_changed",
      executionContext
    });
    const contentMatches = current.sha256 === entry.sha256 && current.bytes === entry.bytes;
    if (isSqliteDataFile(entry.relativePath)) {
      const sidecars = await inspectSqliteSidecarsForRestore({ rootPath, targetPath });
      if (sidecars.blockedReason) {
        return {
          ...baseAction,
          action: "blocked",
          reason: sidecars.blockedReason,
          currentBytes: current.bytes,
          currentSha256: current.sha256
        };
      }
      if (contentMatches && sidecars.present) {
        return {
          ...baseAction,
          action: "replace",
          reason: "sqlite_sidecar_present",
          currentBytes: current.bytes,
          currentSha256: current.sha256
        };
      }
    }
    return {
      ...baseAction,
      action: contentMatches ? "noop" : "replace",
      reason: contentMatches ? "hash_match" : "hash_mismatch",
      currentBytes: current.bytes,
      currentSha256: current.sha256
    };
  } catch (error: unknown) {
    if (errorField(error, "name") === "StorageMaintenanceError") throw error;
    return { ...baseAction, action: "blocked", reason: errorField(error, "code") || "target_unreadable" };
  }
}

function normalizeIncludePaths(includePaths: unknown = []): string[] {
  if (!Array.isArray(includePaths)) {
    throw storageError(
      "restore_include_paths_invalid",
      "Restore includePaths must be an array of relative paths."
    );
  }
  return includePaths.map((item) => safeRelativePath(item)).filter(Boolean);
}

function filterEntries(
  entries: readonly BackupManifestEntry[] = [],
  selectedPaths: readonly string[] = []
): BackupManifestEntry[] {
  if (!selectedPaths.length) return [...entries];
  return entries.filter((entry) =>
    selectedPaths.some((prefix) => entry.relativePath === prefix || entry.relativePath.startsWith(`${prefix}/`))
  );
}

async function buildReplacementDeletionAction({
  rootPath,
  source,
  executionContext = null
}: {
  rootPath: string;
  source: SnapshotSource;
  executionContext?: StorageWorkTracker | null;
}): Promise<RestoreAction> {
  const relativePath = safeRelativePath(source.relativePath);
  const targetPath = path.join(rootPath, relativePath);
  const boundaryReason: string = await pathBoundaryReason({ rootPath, targetPath, allowMissingTarget: false });
  if (boundaryReason) {
    return {
      relativePath,
      category: source.category,
      expectedBytes: 0,
      expectedSha256: "",
      currentBytes: 0,
      currentSha256: "",
      integrityVerified: false,
      action: "blocked",
      reason: boundaryReason
    };
  }
  try {
    const current: FileIntegrity = await inspectStableFile(targetPath, {
      changedCode: "restore_target_changed",
      executionContext
    });
    return {
      relativePath,
      category: source.category,
      expectedBytes: 0,
      expectedSha256: "",
      currentBytes: current.bytes,
      currentSha256: current.sha256,
      integrityVerified: true,
      action: "delete",
      reason: "not_in_backup"
    };
  } catch (error: unknown) {
    if (errorField(error, "name") === "StorageMaintenanceError") throw error;
    return {
      relativePath,
      category: source.category,
      expectedBytes: 0,
      expectedSha256: "",
      currentBytes: 0,
      currentSha256: "",
      integrityVerified: false,
      action: "blocked",
      reason: errorField(error, "code") || "target_unreadable"
    };
  }
}

export async function createStorageRestorePlan({
  rootPath,
  manifest,
  includePaths = [],
  executionContext
}: {
  rootPath: string;
  manifest: ValidatedBackupManifest;
  includePaths?: unknown;
  executionContext: StorageWorkTracker;
}): Promise<Readonly<StorageRestorePlan>> {
  const selectedPaths = normalizeIncludePaths(includePaths);
  const restoreSemantics = selectedPaths.length === 0 ? "replacement" : "overlay";
  const selectedEntries = filterEntries(manifest.files, selectedPaths);
  const filesRoot = backupFilesRoot(rootPath, manifest.backupId);
  const plannedActions: RestoreAction[] = [];
  for (const entry of selectedEntries) {
    executionContext.consume({ files: 1 });
    plannedActions.push(await buildRestoreAction({
      rootPath,
      filesRoot,
      entry,
      executionContext
    }));
  }
  if (restoreSemantics === "replacement") {
    const manifestPaths = new Set(manifest.files.map((entry) => entry.relativePath));
    const currentSources: SnapshotSource[] = await collectSnapshotSources(
      rootPath,
      rootPath,
      [],
      [],
      { includeSqliteSidecars: true }
    );
    executionContext.consume({ files: currentSources.length });
    for (const source of currentSources) {
      executionContext.assertActive();
      if (manifestPaths.has(source.relativePath)) continue;
      plannedActions.push(await buildReplacementDeletionAction({
        rootPath,
        source,
        executionContext
      }));
    }
  }
  const immutableSelectedEntries: readonly BackupManifestEntry[] = Object.freeze([...selectedEntries]);
  const immutablePlannedActions: readonly RestoreAction[] = Object.freeze(
    plannedActions.map((action) => Object.freeze({ ...action }))
  );
  return Object.freeze({
    manifest,
    filesRoot,
    selectedEntries: immutableSelectedEntries,
    plannedActions: immutablePlannedActions,
    restoreSemantics,
    previewReport: createStorageRestoreReport({
      manifest,
      selectedEntries: immutableSelectedEntries,
      plannedActions: immutablePlannedActions,
      shouldApply: false,
      restoreSemantics
    })
  });
}
