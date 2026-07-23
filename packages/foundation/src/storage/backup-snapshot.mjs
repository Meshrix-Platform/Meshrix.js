import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";
import {
  BACKUP_FILES_DIR,
  BACKUP_MANIFEST_FILE,
  BACKUP_RESTORE_PROTOCOL_VERSION,
  backupPath,
  backupRoot,
  isSqliteDataFile,
  isStorageError,
  normalizeArtifactClassifiers,
  nowIso,
  sha256Text,
  storageError
} from "./backup-contract.mjs";
import {
  assertSnapshotSourceSetStable,
  captureRegularSourceSignatures,
  collectSnapshotSources,
  copyStableRegularFile,
  ensurePrivateDirectory,
  pathBoundaryReason,
  snapshotSqliteDatabase,
  syncDirectory,
  syncDirectoryTree,
  writeJsonAtomic
} from "./storage-file-safety.mjs";
import {
  backupIdFor,
  rebuildStorageBackupCatalog,
  summarizeEntries
} from "./backup-manifest.mjs";
import { createStorageReceipt } from "./storage-evidence.mjs";
import { acquireStorageMaintenanceLock } from "./storage-lifecycle-lock.mjs";
import { createStorageWorkTracker } from "./storage-maintenance-coordinator.mjs";
import { reconcileStorageRestoreTransactionsSync } from "./restore-transaction.mjs";

export async function createStorageBackup({
  userDataPath,
  label = "",
  artifactClassifiers = [],
  signal = null,
  budget = {},
  executionContext = null
} = {}) {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const maintenanceLock = await acquireStorageMaintenanceLock(rootPath);
  const backupId = backupIdFor(label);
  const finalBackupPath = backupPath(rootPath, backupId);
  const stagingBackupPath = path.join(backupRoot(rootPath), `.${backupId}.pending`);
  const stagingFilesRoot = path.join(stagingBackupPath, BACKUP_FILES_DIR);
  try {
    reconcileStorageRestoreTransactionsSync(rootPath);
    await ensurePrivateDirectory(rootPath, backupRoot(rootPath));
    await syncDirectory(rootPath);
    await ensurePrivateDirectory(rootPath, stagingFilesRoot);
    const selectedArtifactClassifiers = normalizeArtifactClassifiers(artifactClassifiers);
    const sources = await collectSnapshotSources(
      rootPath,
      rootPath,
      [],
      selectedArtifactClassifiers
    );
    const regularSourceSignatures = await captureRegularSourceSignatures(sources);
    const entries = [];
    for (const source of sources) {
      tracker.consume({ files: 1 });
      const sourceBoundaryReason = await pathBoundaryReason({
        rootPath,
        targetPath: source.sourcePath,
        allowMissingTarget: false
      });
      if (sourceBoundaryReason) {
        throw storageError("backup_source_boundary_invalid", "A backup source file escaped the storage root.");
      }
      const targetPath = path.join(stagingFilesRoot, source.relativePath);
      const integrity = isSqliteDataFile(source.relativePath)
        ? await snapshotSqliteDatabase({
            sourcePath: source.sourcePath,
            targetPath,
            executionContext: tracker
          })
        : await copyStableRegularFile({
            sourcePath: source.sourcePath,
            targetPath,
            executionContext: tracker
          });
      entries.push({
        relativePath: source.relativePath,
        category: source.category,
        bytes: integrity.bytes,
        sha256: integrity.sha256,
        mtimeMs: integrity.mtimeMs
      });
    }
    await assertSnapshotSourceSetStable({
      rootPath,
      sources,
      regularSourceSignatures,
      artifactClassifiers: selectedArtifactClassifiers
    });
    const summary = summarizeEntries(entries);
    const manifest = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
      backupId,
      label: String(label || ""),
      createdAt: nowIso(),
      consistency: {
        publication: "atomic-directory-rename",
        regularFiles: "stable-snapshot-interval-single-pass-copy-and-destination-verification",
        sqlite: "sqlite-online-backup",
        manifestIntegrity: "size-and-sha256-per-file"
      },
      summary,
      files: entries,
      receipt: createStorageReceipt({
        kind: "backup-create",
        status: "verified",
        counts: { files: summary.fileCount, bytes: summary.bytes },
        digestPrefixes: {
          content: sha256Text(JSON.stringify(entries)).slice(0, 16)
        }
      })
    };
    await writeJsonAtomic(path.join(stagingBackupPath, BACKUP_MANIFEST_FILE), manifest);
    await syncDirectoryTree(stagingBackupPath);
    await fs.rename(stagingBackupPath, finalBackupPath);
    await syncDirectory(backupRoot(rootPath));
    await rebuildStorageBackupCatalog({ userDataPath: rootPath });
    return manifest;
  } catch (error) {
    await fs.rm(stagingBackupPath, { recursive: true, force: true }).catch(() => {});
    if (isStorageError(error)) throw error;
    throw storageError("storage_backup_failed", "Storage backup could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock.release().catch(() => {});
  }
}
