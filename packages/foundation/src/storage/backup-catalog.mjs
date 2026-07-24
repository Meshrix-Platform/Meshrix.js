import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { writePrivateFileAtomic } from "./private-file-atomic.mjs";

export const STORAGE_BACKUP_CATALOG_SCHEMA = "v0.0.1:storage:backup-catalog-1";

const CATALOG_FILE = "backup-catalog.json";
const BACKUP_ID_PATTERN = /^backup_[A-Za-z0-9_.-]+$/u;

function catalogError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "StorageBackupCatalogError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function roots(userDataPath = "") {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const backupRoot = path.join(rootPath, "backups");
  return { rootPath, backupRoot, catalogPath: path.join(backupRoot, CATALOG_FILE) };
}

function normalizeEntry(value, expectedBackupId = "") {
  const backupId = String(value?.backupId || "");
  const createdAt = String(value?.createdAt || "");
  if (
    !BACKUP_ID_PATTERN.test(backupId) ||
    (expectedBackupId && backupId !== expectedBackupId) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !value?.summary || typeof value.summary !== "object" || Array.isArray(value.summary) ||
    !value?.consistency || typeof value.consistency !== "object" || Array.isArray(value.consistency)
  ) {
    throw catalogError("storage_backup_catalog_entry_invalid", "Backup catalog entry is invalid.");
  }
  return Object.freeze({
    backupId,
    label: String(value.label || ""),
    createdAt,
    summary: Object.freeze({ ...value.summary }),
    consistency: Object.freeze({ ...value.consistency })
  });
}

function normalizeCatalog(value, protocolVersion) {
  if (
    !value ||
    value.schemaVersion !== STORAGE_BACKUP_CATALOG_SCHEMA ||
    value.protocolVersion !== protocolVersion ||
    !Array.isArray(value.backups)
  ) {
    throw catalogError("storage_backup_catalog_invalid", "Backup catalog is invalid.");
  }
  const seen = new Set();
  const backups = value.backups.map((entry) => {
    const normalized = normalizeEntry(entry);
    if (seen.has(normalized.backupId)) {
      throw catalogError("storage_backup_catalog_invalid", "Backup catalog contains duplicate identities.");
    }
    seen.add(normalized.backupId);
    return normalized;
  });
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.backupId.localeCompare(right.backupId));
  return Object.freeze({
    schemaVersion: STORAGE_BACKUP_CATALOG_SCHEMA,
    protocolVersion,
    revision: String(value.revision || ""),
    backups: Object.freeze(backups)
  });
}

function catalogValue(backups, protocolVersion) {
  const normalized = backups.map((entry) => normalizeEntry(entry));
  normalized.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.backupId.localeCompare(right.backupId));
  const revision = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return {
    schemaVersion: STORAGE_BACKUP_CATALOG_SCHEMA,
    protocolVersion,
    revision,
    backups: normalized
  };
}

function entryFromManifest(manifest, expectedBackupId, protocolVersion) {
  if (manifest?.protocolVersion !== protocolVersion) {
    throw catalogError("storage_backup_catalog_manifest_invalid", "Backup manifest protocol does not match the catalog.");
  }
  return normalizeEntry(manifest, expectedBackupId);
}

export async function readStorageBackupCatalog({ userDataPath, protocolVersion } = {}) {
  const { catalogPath } = roots(userDataPath);
  try {
    return normalizeCatalog(JSON.parse(await fs.readFile(catalogPath, "utf8")), protocolVersion);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.name === "StorageBackupCatalogError") throw error;
    throw catalogError("storage_backup_catalog_invalid", "Backup catalog could not be read.", error);
  }
}

async function manifestDirectoryEntries(backupRoot) {
  try {
    return (await fs.readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function reconcileStorageBackupCatalog({
  userDataPath,
  protocolVersion,
  loadManifest
} = {}) {
  if (typeof loadManifest !== "function") {
    throw new TypeError("Backup catalog reconciliation requires a manifest loader.");
  }
  const { backupRoot, catalogPath } = roots(userDataPath);
  const backups = [];
  for (const entry of await manifestDirectoryEntries(backupRoot)) {
    try {
      backups.push(entryFromManifest(await loadManifest(entry.name), entry.name, protocolVersion));
    } catch {
      // Invalid or incomplete directories are not indexed as usable backups.
    }
  }
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const value = catalogValue(backups, protocolVersion);
  await writePrivateFileAtomic(catalogPath, `${JSON.stringify(value, null, 2)}\n`);
  return normalizeCatalog(value, protocolVersion);
}

export function reconcileStorageBackupCatalogSync({ userDataPath, protocolVersion } = {}) {
  const { backupRoot, catalogPath } = roots(userDataPath);
  let dirents = [];
  try {
    dirents = fsNative.readdirSync(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { reconciled: false, backupCount: 0 };
    throw error;
  }
  const backups = [];
  for (const entry of dirents
    .filter((candidate) => candidate.isDirectory() && BACKUP_ID_PATTERN.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const manifestPath = path.join(backupRoot, entry.name, "backup-manifest.json");
      const stat = fsNative.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const manifest = JSON.parse(fsNative.readFileSync(manifestPath, "utf8"));
      backups.push(entryFromManifest(manifest, entry.name, protocolVersion));
    } catch {
      // Startup catalog rebuilding ignores unusable backup directories.
    }
  }
  fsNative.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const value = catalogValue(backups, protocolVersion);
  const tempPath = path.join(backupRoot, `.${CATALOG_FILE}.${crypto.randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fsNative.openSync(tempPath, "wx", 0o600);
    fsNative.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsNative.fsyncSync(descriptor);
    fsNative.closeSync(descriptor);
    descriptor = null;
    fsNative.renameSync(tempPath, catalogPath);
    let directoryDescriptor = null;
    try {
      directoryDescriptor = fsNative.openSync(backupRoot, fsNative.constants.O_RDONLY);
      fsNative.fsyncSync(directoryDescriptor);
    } catch (error) {
      const unsupported = process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
      if (!unsupported) throw error;
    } finally {
      if (directoryDescriptor !== null) fsNative.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) fsNative.closeSync(descriptor);
    try {
      fsNative.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the reconciliation result after atomic rename.
    }
  }
  return { reconciled: true, backupCount: backups.length, revision: value.revision };
}
