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

async function verifyBackupEntry({ filesRoot, entry, executionContext = null }: Record<string, any>) : Promise<any> {
  const relativePath: any = safeRelativePath(entry.relativePath);
  const backupFilePath: any = path.join(filesRoot, relativePath);
  if (!await pathExists(backupFilePath)) return { ok: false, reason: "backup_file_missing" };
  const boundaryReason: any = await pathBoundaryReason({
    rootPath: filesRoot,
    targetPath: backupFilePath,
    allowMissingTarget: false
  });
  if (boundaryReason) return { ok: false, reason: `backup_${boundaryReason}` };
  try {
    const integrity: any = await inspectStableFile(backupFilePath, {
      changedCode: "backup_file_changed",
      executionContext
    });
    if (integrity.bytes !== entry.bytes) return { ok: false, reason: "backup_size_mismatch" };
    if (integrity.sha256 !== entry.sha256) return { ok: false, reason: "backup_hash_mismatch" };
    return { ok: true, integrity };
  } catch (error: any) {
    if (error?.name === "StorageMaintenanceError") throw error;
    return { ok: false, reason: error?.code || "backup_file_unreadable" };
  }
}

async function inspectSqliteSidecarsForRestore({ rootPath, targetPath }: Record<string, any>) : Promise<any> {
  let present: any = false;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath: any = `${targetPath}${suffix}`;
    let stat: any = null;
    try {
      stat = await fs.lstat(sidecarPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      return { present, blockedReason: "sqlite_sidecar_unreadable" };
    }
    const boundaryReason: any = await pathBoundaryReason({
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

async function buildRestoreAction({ rootPath, filesRoot, entry, executionContext = null }: Record<string, any>) : Promise<any> {
  const relativePath: any = safeRelativePath(entry.relativePath);
  const targetPath: any = path.join(rootPath, relativePath);
  const backupIntegrity: any = await verifyBackupEntry({ filesRoot, entry, executionContext });
  const baseAction: Record<string, any> = {
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
  const targetBoundaryReason: any = await pathBoundaryReason({
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
    const current: any = await inspectStableFile(targetPath, {
      changedCode: "restore_target_changed",
      executionContext
    });
    const contentMatches: any = current.sha256 === entry.sha256 && current.bytes === entry.bytes;
    if (isSqliteDataFile(entry.relativePath)) {
      const sidecars: any = await inspectSqliteSidecarsForRestore({ rootPath, targetPath });
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
  } catch (error: any) {
    if (error?.name === "StorageMaintenanceError") throw error;
    return { ...baseAction, action: "blocked", reason: error?.code || "target_unreadable" };
  }
}

function normalizeIncludePaths(includePaths: any = []) : any {
  if (!Array.isArray(includePaths)) {
    throw storageError(
      "restore_include_paths_invalid",
      "Restore includePaths must be an array of relative paths."
    );
  }
  return includePaths.map((item?: any) : any => safeRelativePath(item)).filter(Boolean);
}

function filterEntries(entries: any = [], selectedPaths: any = []) : any {
  if (!selectedPaths.length) return entries;
  return entries.filter((entry?: any) : any =>
    selectedPaths.some((prefix?: any) : any => entry.relativePath === prefix || entry.relativePath.startsWith(`${prefix}/`))
  );
}

async function buildReplacementDeletionAction({ rootPath, source, executionContext = null }: Record<string, any>) : Promise<any> {
  const relativePath: any = safeRelativePath(source.relativePath);
  const targetPath: any = path.join(rootPath, relativePath);
  const boundaryReason: any = await pathBoundaryReason({ rootPath, targetPath, allowMissingTarget: false });
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
    const current: any = await inspectStableFile(targetPath, {
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
  } catch (error: any) {
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
}: Record<string, any>) : Promise<any> {
  const selectedPaths: any = normalizeIncludePaths(includePaths);
  const restoreSemantics: any = selectedPaths.length === 0 ? "replacement" : "overlay";
  const selectedEntries: any = filterEntries(manifest.files, selectedPaths);
  const filesRoot: any = backupFilesRoot(rootPath, manifest.backupId);
  const plannedActions: any[] = [];
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
    const manifestPaths: any = new Set<any>(manifest.files.map((entry?: any) : any => entry.relativePath));
    const currentSources: any = await collectSnapshotSources(
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
  const immutableSelectedEntries: readonly any[] = Object.freeze([...selectedEntries]);
  const immutablePlannedActions: any = Object.freeze(
    plannedActions.map((action?: any) : any => Object.freeze({ ...action }))
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
