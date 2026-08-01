import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import {
  BACKUP_FILES_DIR,
  BACKUP_MANIFEST_FILE,
  BACKUP_RESTORE_PROTOCOL_VERSION,
  backupFilesRoot,
  backupPath,
  backupRoot,
  isSqliteDataFile,
  isStorageError,
  normalizeArtifactClassifiers,
  nowIso,
  sha256Text,
  storageError
} from "./backup-contract.ts";
import {
  assertSnapshotSourceSetStable,
  captureRegularSourceSignatures,
  cloneStableRegularFile,
  collectSnapshotSources,
  ensurePrivateDirectory,
  pathBoundaryReason,
  snapshotSqliteDatabase,
  syncDirectory,
  syncDirectoryTree,
  writeJsonAtomic
} from "./storage-file-safety.ts";
import {
  backupIdFor,
  loadBackupManifest,
  rebuildStorageBackupCatalog,
  summarizeEntries
} from "./backup-manifest.ts";
import { listStorageBackups } from "./backup-query.ts";
import { createStorageReceipt } from "./storage-evidence.ts";
import { applyStorageBackupRetention } from "./backup-retention.ts";
import { acquireStorageMaintenanceLock } from "./storage-lifecycle-lock.ts";
import { createStorageWorkTracker } from "./storage-maintenance-coordinator.ts";
import { reconcileStorageRestoreTransactionsSync } from "./restore-transaction.ts";

const MINIMUM_FREE_SPACE_RESERVE_BYTES: any = 64 * 1024 * 1024;
const FREE_SPACE_RESERVE_PERCENT: any = 10;
const MAX_PENDING_BACKUP_CLEANUP: any = 64;

async function reconcilePendingBackups({ rootPath, tracker }: Record<string, any>) : Promise<any> {
  const selectedBackupRoot: any = backupRoot(rootPath);
  let entries: any[] = [];
  try {
    entries = await fs.readdir(selectedBackupRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const pending: any = entries
    .filter((entry?: any) : any => entry.name.startsWith(".backup_") && entry.name.endsWith(".pending"))
    .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
  const selected: any = pending.slice(0, MAX_PENDING_BACKUP_CLEANUP);
  for (const entry of selected) {
    tracker.consume({ cleanupItems: 1 });
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw storageError(
        "storage_backup_pending_boundary_invalid",
        "A pending backup has an unsafe filesystem boundary."
      );
    }
    await fs.rm(path.join(selectedBackupRoot, entry.name), { recursive: true, force: true });
  }
  if (pending.length > selected.length) {
    throw storageError(
      "storage_backup_pending_capacity_exceeded",
      "Pending backup cleanup exceeded its bounded maintenance batch."
    );
  }
  if (selected.length > 0) await syncDirectory(selectedBackupRoot);
  return selected.length;
}

async function estimateSnapshotBytes(sources?: any) : Promise<any> {
  let bytes: any = 0;
  for (const source of sources) {
    const stat: any = await fs.lstat(source.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw storageError("backup_file_type_invalid", "Backup sources must be regular files.");
    }
    bytes += Number(stat.size || 0);
    if (isSqliteDataFile(source.relativePath)) {
      try {
        const wal: any = await fs.lstat(`${source.sourcePath}-wal`);
        if (!wal.isFile() || wal.isSymbolicLink()) {
          throw storageError("backup_file_type_invalid", "SQLite WAL sources must be regular files.");
        }
        bytes += Number(wal.size || 0);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!Number.isSafeInteger(bytes)) {
      throw storageError("storage_backup_capacity_invalid", "Backup source size exceeds safe capacity arithmetic.");
    }
  }
  return bytes;
}

async function assertSnapshotCapacity({ rootPath, sourceBytes, tracker }: Record<string, any>) : Promise<any> {
  const expectedWorkBytes: any = sourceBytes * 2;
  if (!Number.isSafeInteger(expectedWorkBytes)) {
    throw storageError("storage_backup_capacity_invalid", "Backup work size exceeds safe capacity arithmetic.");
  }
  tracker.assertFits({ files: 0, bytes: expectedWorkBytes });
  const stats: any = await fs.statfs(rootPath, { bigint: true });
  const availableBigInt: any = stats.bavail * stats.bsize;
  const availableBytes: any = availableBigInt > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(availableBigInt);
  const safetyReserveBytes: any = Math.max(
    MINIMUM_FREE_SPACE_RESERVE_BYTES,
    Math.ceil(sourceBytes * FREE_SPACE_RESERVE_PERCENT / 100)
  );
  const requiredBytes: any = sourceBytes + safetyReserveBytes;
  if (!Number.isSafeInteger(requiredBytes) || availableBytes < requiredBytes) {
    throw storageError(
      "storage_backup_capacity_insufficient",
      "Storage backup capacity is insufficient before snapshot copying begins."
    );
  }
  return { sourceBytes, requiredBytes, availableBytes, safetyReserveBytes };
}

async function latestBackupBaseline(rootPath?: any) : Promise<any> {
  const listing: any = await listStorageBackups({ userDataPath: rootPath });
  const latest: any = listing.backups[0];
  if (!latest) return new Map<any, any>();
  const manifest: any = await loadBackupManifest({ userDataPath: rootPath, backupId: latest.backupId });
  return new Map<any, any>(manifest.files.map((entry?: any) : any => [
    entry.relativePath,
    path.join(backupFilesRoot(rootPath, latest.backupId), entry.relativePath)
  ]));
}

export async function createStorageBackup({
  userDataPath,
  label = "",
  artifactClassifiers = [],
  signal = null,
  budget = {},
  retentionPolicy = null,
  executionContext = null
}: Record<string, any> = {}) : Promise<any> {
  const rootPath: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker: any = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const maintenanceLock: any = await acquireStorageMaintenanceLock(rootPath);
  const backupId: any = backupIdFor(label);
  const finalBackupPath: any = backupPath(rootPath, backupId);
  const stagingBackupPath: any = path.join(backupRoot(rootPath), `.${backupId}.pending`);
  const stagingFilesRoot: any = path.join(stagingBackupPath, BACKUP_FILES_DIR);
  try {
    reconcileStorageRestoreTransactionsSync(rootPath);
    const selectedBackupRoot: any = backupRoot(rootPath);
    await ensurePrivateDirectory(selectedBackupRoot, selectedBackupRoot);
    await syncDirectory(rootPath);
    await reconcilePendingBackups({ rootPath, tracker });
    const selectedArtifactClassifiers: any = normalizeArtifactClassifiers(artifactClassifiers);
    const sources: any = await collectSnapshotSources(
      rootPath,
      rootPath,
      [],
      selectedArtifactClassifiers
    );
    tracker.assertFits({ files: sources.length });
    const sourceBytes: any = await estimateSnapshotBytes(sources);
    const capacity: any = await assertSnapshotCapacity({ rootPath, sourceBytes, tracker });
    const baselineByPath: any = await latestBackupBaseline(rootPath);
    await ensurePrivateDirectory(selectedBackupRoot, stagingFilesRoot);
    const regularSourceSignatures: any = await captureRegularSourceSignatures(sources);
    const entries: any[] = [];
    for (const source of sources) {
      tracker.consume({ files: 1 });
      const sourceBoundaryReason: any = await pathBoundaryReason({
        rootPath,
        targetPath: source.sourcePath,
        allowMissingTarget: false
      });
      if (sourceBoundaryReason) {
        throw storageError("backup_source_boundary_invalid", "A backup source file escaped the storage root.");
      }
      const targetPath: any = path.join(stagingFilesRoot, source.relativePath);
      const integrity: any = isSqliteDataFile(source.relativePath)
        ? await snapshotSqliteDatabase({
            sourcePath: source.sourcePath,
            targetPath,
            baselinePath: baselineByPath.get(source.relativePath) || "",
            executionContext: tracker
          })
        : await cloneStableRegularFile({
            sourcePath: source.sourcePath,
            targetPath,
            executionContext: tracker
          });
      entries.push({
        relativePath: source.relativePath,
        category: source.category,
        bytes: integrity.bytes,
        sha256: integrity.sha256,
        mtimeMs: integrity.mtimeMs,
        copyMethod: integrity.copyMethod
      });
    }
    await assertSnapshotSourceSetStable({
      rootPath,
      sources,
      regularSourceSignatures,
      artifactClassifiers: selectedArtifactClassifiers
    });
    const summary: any = summarizeEntries(entries);
    const manifest: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
      backupId,
      label: String(label || ""),
      createdAt: nowIso(),
      consistency: {
        publication: "atomic-directory-rename",
        regularFiles: "copy-on-write-first-with-stable-source-and-destination-verification",
        sqlite: "copy-on-write-baseline-with-sqlite-online-page-backup",
        manifestIntegrity: "size-and-sha256-per-file"
      },
      secretCustody: {
        mode: "separate-custody-required",
        secretMaterialIncluded: false,
        replacementRestorePreservesExcludedCustody: true
      },
      capacity: {
        preflight: "statfs-before-copy",
        estimatedSourceBytes: capacity.sourceBytes,
        requiredAvailableBytes: capacity.requiredBytes,
        safetyReserveBytes: capacity.safetyReserveBytes,
        sequentialFileConcurrency: 1
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
    const retention: any = retentionPolicy
      ? await applyStorageBackupRetention({
          userDataPath: rootPath,
          policy: retentionPolicy,
          executionContext: tracker,
          maintenanceLock
        })
      : null;
    return retention ? { ...manifest, retention } : manifest;
  } catch (error: any) {
    await fs.rm(stagingBackupPath, { recursive: true, force: true }).catch(() : any => {});
    if (isStorageError(error)) throw error;
    throw storageError("storage_backup_failed", "Storage backup could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock.release().catch(() : any => {});
  }
}
