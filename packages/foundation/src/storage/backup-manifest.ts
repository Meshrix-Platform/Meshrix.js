import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { reconcileStorageBackupCatalog } from "./backup-catalog.ts";
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

export function backupIdFor(label: any = "") : any {
  const timestamp: any = nowIso().replace(/[:.]/g, "-");
  const digest: any = sha256Text(`${timestamp}:${label}:${crypto.randomUUID()}`).slice(0, 12);
  return `backup_${timestamp}_${digest}`;
}

export function summarizeEntries(entries: any = []) : any {
  const byCategory: Record<string, any> = {};
  let bytes: any = 0;
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    bytes += entry.bytes || 0;
  }
  return { fileCount: entries.length, bytes, byCategory };
}

export function validateManifest(manifest?: any, expectedBackupId?: any) : any {
  if (!manifest || manifest.protocolVersion !== BACKUP_RESTORE_PROTOCOL_VERSION) {
    throw storageError("backup_manifest_invalid", "Backup manifest is missing or uses an unsupported protocol.");
  }
  const selectedBackupId: any = normalizeBackupId(manifest.backupId);
  if (selectedBackupId !== expectedBackupId || !Array.isArray(manifest.files)) {
    throw storageError("backup_manifest_invalid", "Backup manifest identity or file entries are invalid.");
  }
  const seenPaths: any = new Set<any>();
  const files: any = manifest.files.map((entry?: any) : any => {
    const relativePath: any = safeRelativePath(entry?.relativePath);
    if (seenPaths.has(relativePath)) {
      throw storageError("backup_manifest_invalid", "Backup manifest contains duplicate file entries.");
    }
    seenPaths.add(relativePath);
    const bytes: any = Number(entry?.bytes);
    const digest: any = String(entry?.sha256 || "").toLowerCase();
    const category: any = String(entry?.category || "").trim();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA256_PATTERN.test(digest) || !category) {
      throw storageError("backup_manifest_invalid", "Backup manifest file metadata is invalid.");
    }
    return {
      relativePath,
      category,
      bytes,
      sha256: digest,
      mtimeMs: Number.isFinite(Number(entry?.mtimeMs)) ? Math.trunc(Number(entry.mtimeMs)) : 0
    };
  });
  const summary: any = summarizeEntries(files);
  if (
    Number(manifest.summary?.fileCount) !== summary.fileCount ||
    Number(manifest.summary?.bytes) !== summary.bytes ||
    JSON.stringify(manifest.summary?.byCategory || {}) !== JSON.stringify(summary.byCategory)
  ) {
    throw storageError("backup_manifest_invalid", "Backup manifest summary does not match its file entries.");
  }
  return { ...manifest, backupId: selectedBackupId, files, summary };
}

export async function loadBackupManifest({ userDataPath, backupId }: Record<string, any>) : Promise<any> {
  const selectedBackupId: any = normalizeBackupId(backupId);
  const manifestPath: any = path.join(backupPath(userDataPath, selectedBackupId), BACKUP_MANIFEST_FILE);
  const manifestBoundaryReason: any = await pathBoundaryReason({
    rootPath: backupRoot(userDataPath),
    targetPath: manifestPath,
    allowMissingTarget: false
  });
  if (manifestBoundaryReason) {
    throw storageError("backup_manifest_invalid", "Backup manifest has an unsafe filesystem boundary.");
  }
  const manifest: any = await readJson(manifestPath, null);
  return validateManifest(manifest, selectedBackupId);
}

export async function rebuildStorageBackupCatalog({ userDataPath }: Record<string, any> = {}) : Promise<any> {
  const rootPath: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  return reconcileStorageBackupCatalog({
    userDataPath: rootPath,
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    loadManifest: (selectedBackupId?: any) : any => loadBackupManifest({ userDataPath: rootPath, backupId: selectedBackupId })
  });
}
