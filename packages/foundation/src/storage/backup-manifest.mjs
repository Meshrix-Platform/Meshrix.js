import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";
import { reconcileStorageBackupCatalog } from "./backup-catalog.mjs";
import {
  BACKUP_MANIFEST_FILE,
  BACKUP_RESTORE_PROTOCOL_VERSION,
  SHA256_PATTERN,
  backupPath,
  normalizeBackupId,
  nowIso,
  safeRelativePath,
  sha256Text,
  storageError
} from "./backup-contract.mjs";
import { pathBoundaryReason, readJson } from "./storage-file-safety.mjs";

export function backupIdFor(label = "") {
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const digest = sha256Text(`${timestamp}:${label}:${crypto.randomUUID()}`).slice(0, 12);
  return `backup_${timestamp}_${digest}`;
}

export function summarizeEntries(entries = []) {
  const byCategory = {};
  let bytes = 0;
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    bytes += entry.bytes || 0;
  }
  return { fileCount: entries.length, bytes, byCategory };
}

export function validateManifest(manifest, expectedBackupId) {
  if (!manifest || manifest.protocolVersion !== BACKUP_RESTORE_PROTOCOL_VERSION) {
    throw storageError("backup_manifest_invalid", "Backup manifest is missing or uses an unsupported protocol.");
  }
  const selectedBackupId = normalizeBackupId(manifest.backupId);
  if (selectedBackupId !== expectedBackupId || !Array.isArray(manifest.files)) {
    throw storageError("backup_manifest_invalid", "Backup manifest identity or file entries are invalid.");
  }
  const seenPaths = new Set();
  const files = manifest.files.map((entry) => {
    const relativePath = safeRelativePath(entry?.relativePath);
    if (seenPaths.has(relativePath)) {
      throw storageError("backup_manifest_invalid", "Backup manifest contains duplicate file entries.");
    }
    seenPaths.add(relativePath);
    const bytes = Number(entry?.bytes);
    const digest = String(entry?.sha256 || "").toLowerCase();
    const category = String(entry?.category || "").trim();
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
  const summary = summarizeEntries(files);
  if (
    Number(manifest.summary?.fileCount) !== summary.fileCount ||
    Number(manifest.summary?.bytes) !== summary.bytes ||
    JSON.stringify(manifest.summary?.byCategory || {}) !== JSON.stringify(summary.byCategory)
  ) {
    throw storageError("backup_manifest_invalid", "Backup manifest summary does not match its file entries.");
  }
  return { ...manifest, backupId: selectedBackupId, files, summary };
}

export async function loadBackupManifest({ userDataPath, backupId }) {
  const selectedBackupId = normalizeBackupId(backupId);
  const manifestPath = path.join(backupPath(userDataPath, selectedBackupId), BACKUP_MANIFEST_FILE);
  const manifestBoundaryReason = await pathBoundaryReason({
    rootPath: path.resolve(userDataPath || ServerConfig.getDataDir()),
    targetPath: manifestPath,
    allowMissingTarget: false
  });
  if (manifestBoundaryReason) {
    throw storageError("backup_manifest_invalid", "Backup manifest has an unsafe filesystem boundary.");
  }
  const manifest = await readJson(manifestPath, null);
  return validateManifest(manifest, selectedBackupId);
}

export async function rebuildStorageBackupCatalog({ userDataPath } = {}) {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  return reconcileStorageBackupCatalog({
    userDataPath: rootPath,
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    loadManifest: (selectedBackupId) => loadBackupManifest({ userDataPath: rootPath, backupId: selectedBackupId })
  });
}
