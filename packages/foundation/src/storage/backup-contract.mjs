import crypto from "node:crypto";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";

export const BACKUP_RESTORE_PROTOCOL_VERSION = "v0.0.1:storage:backup-restore-1";

export const BACKUP_ROOT_DIR = "backups";
export const BACKUP_FILES_DIR = "files";
export const BACKUP_MANIFEST_FILE = "backup-manifest.json";
export const RESTORE_REPORT_DIR = "restore-reports";
export const RESTORE_STAGING_DIR = "tmp";
export const EXCLUDED_TOP_LEVEL_DIRS = new Set([BACKUP_ROOT_DIR, "locks", "logs", RESTORE_STAGING_DIR]);
export const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function nowIso() {
  return new Date().toISOString();
}

export function storageError(code, message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.name = "StorageBackupRestoreError";
  error.code = code;
  error.reasonCode = code;
  if (options.detailReasonCode) error.detailReasonCode = options.detailReasonCode;
  return error;
}

export function isStorageError(error) {
  return error?.name === "StorageBackupRestoreError" ||
    error?.name === "StorageLifecycleError" ||
    error?.name === "StorageRestoreTransactionError" ||
    error?.name === "StorageMaintenanceError";
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeBackupId(value = "") {
  const text = String(value || "").trim();
  if (!/^backup_[A-Za-z0-9_.-]+$/.test(text)) {
    throw storageError("backup_id_invalid", "Invalid backupId.");
  }
  return text;
}

export function safeRelativePath(relativePath = "") {
  const value = String(relativePath || "").replace(/\\/g, "/");
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    path.posix.isAbsolute(value) ||
    segments.includes("..") ||
    segments.includes("") ||
    EXCLUDED_TOP_LEVEL_DIRS.has(segments[0])
  ) {
    throw storageError("backup_path_invalid", "Backup contains an unsafe relative path.");
  }
  return value;
}

export function backupRoot(userDataPath = "") {
  return path.join(path.resolve(userDataPath || ServerConfig.getDataDir()), BACKUP_ROOT_DIR);
}

export function backupPath(userDataPath = "", backupId = "") {
  return path.join(backupRoot(userDataPath), normalizeBackupId(backupId));
}

export function backupFilesRoot(userDataPath = "", backupId = "") {
  return path.join(backupPath(userDataPath, backupId), BACKUP_FILES_DIR);
}

export function pathWithinRoot(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeArtifactClassifiers(artifactClassifiers = []) {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier) => typeof classifier === "function")
    : [];
}

export function classifyExternalArtifact(relativePath = "", artifactClassifiers = []) {
  for (const classifier of artifactClassifiers) {
    const category = String(classifier(relativePath) || "").trim();
    if (category) return category;
  }
  return "";
}

export function classifyFile(relativePath = "", artifactClassifiers = []) {
  const value = relativePath.replace(/\\/g, "/");
  if (value.startsWith("auth/")) return "auth";
  if (value.startsWith("jobs/")) return "jobs";
  if (value.startsWith("objects/")) return "object";
  const externalCategory = classifyExternalArtifact(value, artifactClassifiers);
  if (externalCategory) return externalCategory;
  if (isSqliteDataFile(value)) return "database";
  if (value.endsWith(".json")) return "json-state";
  if (value.endsWith(".yaml") || value.endsWith(".yml")) return "config";
  return "file";
}

export function isSqliteDataFile(relativePath = "") {
  const value = String(relativePath || "").toLowerCase();
  return value.endsWith(".sqlite") || value.endsWith(".sqlite3") || value.endsWith(".db");
}

export function isSqliteSidecar(relativePath = "") {
  const value = String(relativePath || "").toLowerCase();
  return SQLITE_SIDECAR_SUFFIXES.some((suffix) => value.endsWith(suffix));
}
