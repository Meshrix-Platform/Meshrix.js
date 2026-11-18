import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { reconcileStorageBackupCatalog } from "./backup-catalog.ts";
import type { StorageBackupCatalog } from "./backup-catalog.ts";
import {
  BACKUP_MANIFEST_FILE,
  BACKUP_RESTORE_PROTOCOL_VERSION,
  SHA256_PATTERN,
  backupRoot,
  backupPath,
  normalizeBackupId,
  nowIso,
  safeRelativePath,
  sha256Text,
  storageError
} from "./backup-contract.ts";
import { pathBoundaryReason, readJson } from "./storage-file-safety.ts";

type JsonRecord = Record<string, unknown>;

export interface BackupManifestEntry {
  relativePath: string;
  category: string;
  bytes: number;
  sha256: string;
  mtimeMs: number;
}

export interface BackupManifestSummary {
  fileCount: number;
  bytes: number;
  byCategory: Record<string, number>;
}

export type ValidatedBackupManifest = JsonRecord & {
  protocolVersion: string;
  backupId: string;
  files: BackupManifestEntry[];
  summary: BackupManifestSummary;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function backupIdFor(label = ""): string {
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const digest = sha256Text(`${timestamp}:${label}:${crypto.randomUUID()}`).slice(0, 12);
  return `backup_${timestamp}_${digest}`;
}

export function summarizeEntries(entries: readonly Pick<BackupManifestEntry, "category" | "bytes">[] = []): BackupManifestSummary {
  const byCategory: Record<string, number> = {};
  let bytes = 0;
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    bytes += entry.bytes || 0;
  }
  return { fileCount: entries.length, bytes, byCategory };
}

export function validateManifest(manifest: unknown, expectedBackupId?: string): ValidatedBackupManifest {
  if (!isRecord(manifest) || manifest.protocolVersion !== BACKUP_RESTORE_PROTOCOL_VERSION) {
    throw storageError("backup_manifest_invalid", "Backup manifest is missing or uses an unsupported protocol.");
  }
  const selectedBackupId = normalizeBackupId(manifest.backupId);
  if (selectedBackupId !== expectedBackupId || !Array.isArray(manifest.files)) {
    throw storageError("backup_manifest_invalid", "Backup manifest identity or file entries are invalid.");
  }
  const seenPaths = new Set<string>();
  const files = manifest.files.map((entry: unknown): BackupManifestEntry => {
    const entryRecord = isRecord(entry) ? entry : {};
    const relativePath = safeRelativePath(entryRecord.relativePath);
    if (seenPaths.has(relativePath)) {
      throw storageError("backup_manifest_invalid", "Backup manifest contains duplicate file entries.");
    }
    seenPaths.add(relativePath);
    const bytes = Number(entryRecord.bytes);
    const digest = String(entryRecord.sha256 || "").toLowerCase();
    const category = String(entryRecord.category || "").trim();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA256_PATTERN.test(digest) || !category) {
      throw storageError("backup_manifest_invalid", "Backup manifest file metadata is invalid.");
    }
    return {
      relativePath,
      category,
      bytes,
      sha256: digest,
      mtimeMs: Number.isFinite(Number(entryRecord.mtimeMs)) ? Math.trunc(Number(entryRecord.mtimeMs)) : 0
    };
  });
  const summary = summarizeEntries(files);
  const manifestSummary = isRecord(manifest.summary) ? manifest.summary : {};
  if (
    Number(manifestSummary.fileCount) !== summary.fileCount ||
    Number(manifestSummary.bytes) !== summary.bytes ||
    JSON.stringify(manifestSummary.byCategory || {}) !== JSON.stringify(summary.byCategory)
  ) {
    throw storageError("backup_manifest_invalid", "Backup manifest summary does not match its file entries.");
  }
  return {
    ...manifest,
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    backupId: selectedBackupId,
    files,
    summary
  };
}

export async function loadBackupManifest({
  userDataPath,
  backupId
}: {
  userDataPath: string;
  backupId?: string;
}): Promise<ValidatedBackupManifest> {
  const selectedBackupId = normalizeBackupId(backupId);
  const manifestPath = path.join(backupPath(userDataPath, selectedBackupId), BACKUP_MANIFEST_FILE);
  const manifestBoundaryReason = await pathBoundaryReason({
    rootPath: backupRoot(userDataPath),
    targetPath: manifestPath,
    allowMissingTarget: false
  });
  if (manifestBoundaryReason) {
    throw storageError("backup_manifest_invalid", "Backup manifest has an unsafe filesystem boundary.");
  }
  const manifest: unknown = await readJson(manifestPath, null);
  return validateManifest(manifest, selectedBackupId);
}

export async function rebuildStorageBackupCatalog({
  userDataPath
}: {
  userDataPath?: string;
} = {}): Promise<Readonly<StorageBackupCatalog>> {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  return reconcileStorageBackupCatalog({
    userDataPath: rootPath,
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    loadManifest: (selectedBackupId?: string): Promise<ValidatedBackupManifest> =>
      loadBackupManifest({ userDataPath: rootPath, backupId: selectedBackupId })
  });
}
