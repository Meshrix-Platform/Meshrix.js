import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";

export const BACKUP_RESTORE_PROTOCOL_VERSION: any = "v0.0.1:storage:backup-restore-1";
export const BACKUP_ROOT_ENV: any = "MESHRIX_BACKUP_ROOT";
export const REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV: any =
  "MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT";

export const BACKUP_ROOT_DIR: any = "backups";
export const BACKUP_FILES_DIR: any = "files";
export const BACKUP_MANIFEST_FILE: any = "backup-manifest.json";
export const RESTORE_REPORT_DIR: any = "restore-reports";
export const RESTORE_STAGING_DIR: any = "tmp";
export const EXCLUDED_TOP_LEVEL_DIRS: any = new Set<any>([BACKUP_ROOT_DIR, "locks", "logs", RESTORE_STAGING_DIR]);
export const SECRET_CUSTODY_EXCLUDED_ROOTS: readonly any[] = Object.freeze([
  "secrets",
  "security/execution-sandbox-custody"
]);
export const SQLITE_SIDECAR_SUFFIXES: readonly any[] = Object.freeze(["-wal", "-shm", "-journal"]);
export const SHA256_PATTERN: any = /^[a-f0-9]{64}$/;

export function nowIso() : any {
  return new Date().toISOString();
}

export function storageError(code?: any, message?: any, options: Record<string, any> = {}) : any {
  const error: Error & Record<string, any> = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.name = "StorageBackupRestoreError";
  error.code = code;
  error.reasonCode = code;
  if (options.detailReasonCode) error.detailReasonCode = options.detailReasonCode;
  return error;
}

export function isStorageError(error?: any) : any {
  return error?.name === "StorageBackupRestoreError" ||
    error?.name === "StorageLifecycleError" ||
    error?.name === "StorageRestoreTransactionError" ||
    error?.name === "StorageMaintenanceError";
}

export function sha256Text(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeBackupId(value: any = "") : any {
  const text: any = String(value || "").trim();
  if (!/^backup_[A-Za-z0-9_.-]+$/.test(text)) {
    throw storageError("backup_id_invalid", "Invalid backupId.");
  }
  return text;
}

export function safeRelativePath(relativePath: any = "") : any {
  const value: any = String(relativePath || "").replace(/\\/g, "/");
  const segments: any = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    path.posix.isAbsolute(value) ||
    segments.includes("..") ||
    segments.includes("") ||
    EXCLUDED_TOP_LEVEL_DIRS.has(segments[0]) ||
    isSecretCustodyPath(value)
  ) {
    throw storageError("backup_path_invalid", "Backup contains an unsafe relative path.");
  }
  return value;
}

export function isSecretCustodyPath(relativePath: any = "") : any {
  const value: any = String(relativePath || "").replace(/\\/gu, "/").replace(/^\.?\//u, "");
  return SECRET_CUSTODY_EXCLUDED_ROOTS.some((root?: any) : any => value === root || value.startsWith(`${root}/`)) ||
    /^security\/[^/]+\/[^/]+\.sealing-key$/u.test(value);
}

export function backupRoot(userDataPath: any = "") : any {
  const storageRoot: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  const configured: any = String(process.env[BACKUP_ROOT_ENV] || "").trim();
  if (!configured) {
    if (["1", "true", "yes"].includes(
      String(process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV] || "").trim().toLowerCase()
    )) {
      throw storageError(
        "storage_independent_backup_root_required",
        "An independent backup root is required for this deployment."
      );
    }
    return path.join(storageRoot, BACKUP_ROOT_DIR);
  }
  if (!path.isAbsolute(configured)) {
    throw storageError(
      "storage_backup_root_invalid",
      "The configured backup root must be absolute."
    );
  }
  const selected: any = path.resolve(configured);
  if (pathWithinRoot(selected, storageRoot) || pathWithinRoot(storageRoot, selected)) {
    throw storageError(
      "storage_backup_root_not_independent",
      "The configured backup root overlaps governed live storage."
    );
  }
  return selected;
}

export async function assertIndependentBackupRootReady({
  userDataPath = "",
  required = ["1", "true", "yes"].includes(
    String(process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV] || "").trim().toLowerCase()
  )
}: Record<string, any> = {}) : Promise<any> {
  const configured: any = String(process.env[BACKUP_ROOT_ENV] || "").trim();
  if (!configured && !required) {
    return Object.freeze({ configured: false, independent: false });
  }
  const selected: any = backupRoot(userDataPath);
  let stat: any;
  let realPath: any;
  let realStoragePath: any;
  try {
    [stat, realPath, realStoragePath] = await Promise.all([
      fs.lstat(selected),
      fs.realpath(selected),
      fs.realpath(path.resolve(userDataPath || ServerConfig.getDataDir()))
    ]);
  } catch {
    throw storageError(
      "storage_backup_root_unavailable",
      "The configured independent backup root is unavailable."
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    pathWithinRoot(realPath, realStoragePath) ||
    pathWithinRoot(realStoragePath, realPath)
  ) {
    throw storageError(
      "storage_backup_root_invalid",
      "The configured independent backup root is not a real directory."
    );
  }
  return Object.freeze({ configured: true, independent: true });
}

export function backupPath(userDataPath: any = "", backupId: any = "") : any {
  return path.join(backupRoot(userDataPath), normalizeBackupId(backupId));
}

export function backupFilesRoot(userDataPath: any = "", backupId: any = "") : any {
  return path.join(backupPath(userDataPath, backupId), BACKUP_FILES_DIR);
}

export function pathWithinRoot(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeArtifactClassifiers(artifactClassifiers: any = []) : any {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier?: any) : any => typeof classifier === "function")
    : [];
}

export function classifyExternalArtifact(relativePath: any = "", artifactClassifiers: any = []) : any {
  for (const classifier of artifactClassifiers) {
    const category: any = String(classifier(relativePath) || "").trim();
    if (category) return category;
  }
  return "";
}

export function classifyFile(relativePath: any = "", artifactClassifiers: any = []) : any {
  const value: any = relativePath.replace(/\\/g, "/");
  if (value.startsWith("auth/")) return "auth";
  if (value.startsWith("jobs/")) return "jobs";
  if (value.startsWith("objects/")) return "object";
  const externalCategory: any = classifyExternalArtifact(value, artifactClassifiers);
  if (externalCategory) return externalCategory;
  if (isSqliteDataFile(value)) return "database";
  if (value.endsWith(".json")) return "json-state";
  if (value.endsWith(".yaml") || value.endsWith(".yml")) return "config";
  return "file";
}

export function isSqliteDataFile(relativePath: any = "") : any {
  const value: any = String(relativePath || "").toLowerCase();
  return value.endsWith(".sqlite") || value.endsWith(".sqlite3") || value.endsWith(".db");
}

export function isSqliteSidecar(relativePath: any = "") : any {
  const value: any = String(relativePath || "").toLowerCase();
  return SQLITE_SIDECAR_SUFFIXES.some((suffix?: any) : any => value.endsWith(suffix));
}
