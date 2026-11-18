import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
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
import type { StorageArtifactClassifier } from "./backup-contract.ts";
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

const MINIMUM_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const FREE_SPACE_RESERVE_PERCENT = 10;
const MAX_PENDING_BACKUP_CLEANUP = 64;

type WorkAmounts = { files?: number; bytes?: number; cleanupItems?: number };

interface StorageWorkTracker {
  assertActive(): void;
  assertFits(amounts: WorkAmounts): void;
  consume(amounts: WorkAmounts): void;
}

interface MaintenanceLock {
  release(): Promise<void>;
}

interface SnapshotSource {
  sourcePath: string;
  relativePath: string;
  category: string;
}

interface SnapshotIntegrity {
  bytes: number;
  sha256: string;
  mtimeMs: number;
  copyMethod: string;
}

interface SnapshotEntry extends SnapshotIntegrity {
  relativePath: string;
  category: string;
}

interface SnapshotCapacity {
  sourceBytes: number;
  requiredBytes: number;
  availableBytes: number;
  safetyReserveBytes: number;
}

export type StorageBackupManifest = Record<string, unknown> & {
  protocolVersion: string;
  backupId: string;
  label: string;
  createdAt: string;
  files: SnapshotEntry[];
};

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code || "");
}

async function reconcilePendingBackups({
  rootPath,
  tracker
}: {
  rootPath: string;
  tracker: StorageWorkTracker;
}): Promise<number> {
  const selectedBackupRoot = backupRoot(rootPath);
  let entries: Dirent<string>[] = [];
  try {
    entries = await fs.readdir(selectedBackupRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  const pending = entries
    .filter((entry) => entry.name.startsWith(".backup_") && entry.name.endsWith(".pending"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selected = pending.slice(0, MAX_PENDING_BACKUP_CLEANUP);
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

async function estimateSnapshotBytes(sources: readonly SnapshotSource[]): Promise<number> {
  let bytes = 0;
  for (const source of sources) {
    const stat = await fs.lstat(source.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw storageError("backup_file_type_invalid", "Backup sources must be regular files.");
    }
    bytes += Number(stat.size || 0);
    if (isSqliteDataFile(source.relativePath)) {
      try {
        const wal = await fs.lstat(`${source.sourcePath}-wal`);
        if (!wal.isFile() || wal.isSymbolicLink()) {
          throw storageError("backup_file_type_invalid", "SQLite WAL sources must be regular files.");
        }
        bytes += Number(wal.size || 0);
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    if (!Number.isSafeInteger(bytes)) {
      throw storageError("storage_backup_capacity_invalid", "Backup source size exceeds safe capacity arithmetic.");
    }
  }
  return bytes;
}

async function assertSnapshotCapacity({
  rootPath,
  sourceBytes,
  tracker
}: {
  rootPath: string;
  sourceBytes: number;
  tracker: StorageWorkTracker;
}): Promise<SnapshotCapacity> {
  const expectedWorkBytes = sourceBytes * 2;
  if (!Number.isSafeInteger(expectedWorkBytes)) {
    throw storageError("storage_backup_capacity_invalid", "Backup work size exceeds safe capacity arithmetic.");
  }
  tracker.assertFits({ files: 0, bytes: expectedWorkBytes });
  const stats = await fs.statfs(rootPath, { bigint: true });
  const availableBigInt = stats.bavail * stats.bsize;
  const availableBytes = availableBigInt > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(availableBigInt);
  const safetyReserveBytes = Math.max(
    MINIMUM_FREE_SPACE_RESERVE_BYTES,
    Math.ceil(sourceBytes * FREE_SPACE_RESERVE_PERCENT / 100)
  );
  const requiredBytes = sourceBytes + safetyReserveBytes;
  if (!Number.isSafeInteger(requiredBytes) || availableBytes < requiredBytes) {
    throw storageError(
      "storage_backup_capacity_insufficient",
      "Storage backup capacity is insufficient before snapshot copying begins."
    );
  }
  return { sourceBytes, requiredBytes, availableBytes, safetyReserveBytes };
}

async function latestBackupBaseline(rootPath: string): Promise<Map<string, string>> {
  const listing = await listStorageBackups({ userDataPath: rootPath });
  const latest = listing.backups[0];
  const latestBackupId = typeof latest?.backupId === "string" ? latest.backupId : "";
  if (!latestBackupId) return new Map();
  const manifest = await loadBackupManifest({ userDataPath: rootPath, backupId: latestBackupId });
  return new Map(manifest.files.map((entry) => [
    entry.relativePath,
    path.join(backupFilesRoot(rootPath, latestBackupId), entry.relativePath)
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
}: {
  userDataPath?: string;
  label?: string;
  artifactClassifiers?: unknown;
  signal?: AbortSignal | null;
  budget?: Record<string, unknown>;
  retentionPolicy?: unknown;
  executionContext?: StorageWorkTracker | null;
} = {}): Promise<StorageBackupManifest & { retention?: unknown }> {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const tracker: StorageWorkTracker = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const maintenanceLock: MaintenanceLock = await acquireStorageMaintenanceLock(rootPath);
  const backupId = backupIdFor(label);
  const finalBackupPath = backupPath(rootPath, backupId);
  const stagingBackupPath = path.join(backupRoot(rootPath), `.${backupId}.pending`);
  const stagingFilesRoot = path.join(stagingBackupPath, BACKUP_FILES_DIR);
  try {
    reconcileStorageRestoreTransactionsSync(rootPath);
    const selectedBackupRoot = backupRoot(rootPath);
    await ensurePrivateDirectory(selectedBackupRoot, selectedBackupRoot);
    await syncDirectory(rootPath);
    await reconcilePendingBackups({ rootPath, tracker });
    const selectedArtifactClassifiers: StorageArtifactClassifier[] = normalizeArtifactClassifiers(artifactClassifiers);
    const sources: SnapshotSource[] = await collectSnapshotSources(
      rootPath,
      rootPath,
      [],
      selectedArtifactClassifiers
    );
    tracker.assertFits({ files: sources.length });
    const sourceBytes = await estimateSnapshotBytes(sources);
    const capacity = await assertSnapshotCapacity({ rootPath, sourceBytes, tracker });
    const baselineByPath = await latestBackupBaseline(rootPath);
    await ensurePrivateDirectory(selectedBackupRoot, stagingFilesRoot);
    const regularSourceSignatures = await captureRegularSourceSignatures(sources);
    const entries: SnapshotEntry[] = [];
    for (const source of sources) {
      tracker.consume({ files: 1 });
      const sourceBoundaryReason: string = await pathBoundaryReason({
        rootPath,
        targetPath: source.sourcePath,
        allowMissingTarget: false
      });
      if (sourceBoundaryReason) {
        throw storageError("backup_source_boundary_invalid", "A backup source file escaped the storage root.");
      }
      const targetPath = path.join(stagingFilesRoot, source.relativePath);
      const integrity: SnapshotIntegrity = isSqliteDataFile(source.relativePath)
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
    const summary = summarizeEntries(entries);
    const manifest: StorageBackupManifest = {
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
    const retention: unknown = retentionPolicy
      ? await applyStorageBackupRetention({
          userDataPath: rootPath,
          policy: retentionPolicy,
          executionContext: tracker,
          maintenanceLock
        })
      : null;
    return retention ? { ...manifest, retention } : manifest;
  } catch (error: unknown) {
    await fs.rm(stagingBackupPath, { recursive: true, force: true }).catch(() => {});
    if (isStorageError(error)) throw error;
    throw storageError("storage_backup_failed", "Storage backup could not be completed safely.", { cause: error });
  } finally {
    await maintenanceLock.release().catch(() => {});
  }
}
