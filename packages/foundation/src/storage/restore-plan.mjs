import fs from "node:fs/promises";
import path from "node:path";
import {
  SQLITE_SIDECAR_SUFFIXES,
  backupFilesRoot,
  isSqliteDataFile,
  safeRelativePath,
  storageError
} from "./backup-contract.mjs";
import {
  collectSnapshotSources,
  inspectStableFile,
  pathBoundaryReason,
  pathExists
} from "./storage-file-safety.mjs";
import { createStorageRestoreReport } from "./restore-report.mjs";

async function verifyBackupEntry({ filesRoot, entry, executionContext = null }) {
  const relativePath = safeRelativePath(entry.relativePath);
  const backupFilePath = path.join(filesRoot, relativePath);
  if (!await pathExists(backupFilePath)) return { ok: false, reason: "backup_file_missing" };
  const boundaryReason = await pathBoundaryReason({
    rootPath: filesRoot,
    targetPath: backupFilePath,
    allowMissingTarget: false
  });
  if (boundaryReason) return { ok: false, reason: `backup_${boundaryReason}` };
  try {
    const integrity = await inspectStableFile(backupFilePath, {
      changedCode: "backup_file_changed",
      executionContext
    });
    if (integrity.bytes !== entry.bytes) return { ok: false, reason: "backup_size_mismatch" };
    if (integrity.sha256 !== entry.sha256) return { ok: false, reason: "backup_hash_mismatch" };
    return { ok: true, integrity };
  } catch (error) {
    if (error?.name === "StorageMaintenanceError") throw error;
    return { ok: false, reason: error?.code || "backup_file_unreadable" };
  }
}

async function inspectSqliteSidecarsForRestore({ rootPath, targetPath }) {
  let present = false;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${targetPath}${suffix}`;
    let stat = null;
    try {
      stat = await fs.lstat(sidecarPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { present, blockedReason: "sqlite_sidecar_unreadable" };
    }
    const boundaryReason = await pathBoundaryReason({
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

async function buildRestoreAction({ rootPath, filesRoot, entry, executionContext = null }) {
  const relativePath = safeRelativePath(entry.relativePath);
  const targetPath = path.join(rootPath, relativePath);
  const backupIntegrity = await verifyBackupEntry({ filesRoot, entry, executionContext });
  const baseAction = {
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
  const targetBoundaryReason = await pathBoundaryReason({
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
    const current = await inspectStableFile(targetPath, {
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
  } catch (error) {
    if (error?.name === "StorageMaintenanceError") throw error;
    return { ...baseAction, action: "blocked", reason: error?.code || "target_unreadable" };
  }
}

function normalizeIncludePaths(includePaths = []) {
  if (!Array.isArray(includePaths)) {
    throw storageError(
      "restore_include_paths_invalid",
      "Restore includePaths must be an array of relative paths."
    );
  }
  return includePaths.map((item) => safeRelativePath(item)).filter(Boolean);
}

function filterEntries(entries = [], selectedPaths = []) {
  if (!selectedPaths.length) return entries;
  return entries.filter((entry) =>
    selectedPaths.some((prefix) => entry.relativePath === prefix || entry.relativePath.startsWith(`${prefix}/`))
  );
}

async function buildReplacementDeletionAction({ rootPath, source, executionContext = null }) {
  const relativePath = safeRelativePath(source.relativePath);
  const targetPath = path.join(rootPath, relativePath);
  const boundaryReason = await pathBoundaryReason({ rootPath, targetPath, allowMissingTarget: false });
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
    const current = await inspectStableFile(targetPath, {
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
  } catch (error) {
    if (error?.name === "StorageMaintenanceError") throw error;
    return {
      relativePath,
      category: source.category,
      expectedBytes: 0,
      expectedSha256: "",
      currentBytes: 0,
      currentSha256: "",
      integrityVerified: false,
      action: "blocked",
      reason: error?.code || "target_unreadable"
    };
  }
}

export async function createStorageRestorePlan({
  rootPath,
  manifest,
  includePaths = [],
  executionContext
}) {
  const selectedPaths = normalizeIncludePaths(includePaths);
  const restoreSemantics = selectedPaths.length === 0 ? "replacement" : "overlay";
  const selectedEntries = filterEntries(manifest.files, selectedPaths);
  const filesRoot = backupFilesRoot(rootPath, manifest.backupId);
  const plannedActions = [];
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
    const currentSources = await collectSnapshotSources(
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
  const immutableSelectedEntries = Object.freeze([...selectedEntries]);
  const immutablePlannedActions = Object.freeze(
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
