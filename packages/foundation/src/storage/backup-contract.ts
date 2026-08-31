import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";

export const BACKUP_RESTORE_PROTOCOL_VERSION = "v0.0.1:storage:backup-restore-1";
export const BACKUP_ROOT_ENV = "MESHRIX_BACKUP_ROOT";
export const REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV =
  "MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT";

export const BACKUP_ROOT_DIR = "backups";
export const BACKUP_FILES_DIR = "files";
export const BACKUP_MANIFEST_FILE = "backup-manifest.json";
export const RESTORE_REPORT_DIR = "restore-reports";
export const RESTORE_STAGING_DIR = "tmp";
export const EXCLUDED_TOP_LEVEL_DIRS = new Set<string>([BACKUP_ROOT_DIR, "locks", "logs", RESTORE_STAGING_DIR]);
export const UNPUBLISHED_OBJECT_STAGING_ROOT = "objects/.pending";
export const SECRET_CUSTODY_EXCLUDED_ROOTS: readonly string[] = Object.freeze([
  "secrets",
  "security/execution-sandbox-custody"
]);
export const SQLITE_SIDECAR_SUFFIXES: readonly string[] = Object.freeze(["-wal", "-shm", "-journal"]);
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface StorageBackupRestoreError extends Error {
  code: string;
  reasonCode: string;
  detailReasonCode?: string;
}

export type StorageArtifactClassifier = (relativePath: string) => unknown;

export function nowIso(): string {
  return new Date().toISOString();
}

export function storageError(
  code: string,
  message: string,
  options: { cause?: unknown; detailReasonCode?: string } = {}
): StorageBackupRestoreError {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined) as StorageBackupRestoreError;
  error.name = "StorageBackupRestoreError";
  error.code = code;
  error.reasonCode = code;
  if (options.detailReasonCode) error.detailReasonCode = options.detailReasonCode;
  return error;
}

export function isStorageError(error: unknown): error is Error {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = String(error.name || "");
  return name === "StorageBackupRestoreError" ||
    name === "StorageLifecycleError" ||
    name === "StorageRestoreTransactionError" ||
    name === "StorageMaintenanceError";
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeBackupId(value: unknown = ""): string {
  const text = String(value || "").trim();
  if (!/^backup_[A-Za-z0-9_.-]+$/.test(text)) {
    throw storageError("backup_id_invalid", "Invalid backupId.");
  }
  return text;
}

export function safeRelativePath(relativePath: unknown = ""): string {
  const value = String(relativePath || "").replace(/\\/g, "/");
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    path.posix.isAbsolute(value) ||
    segments.includes("..") ||
    segments.includes("") ||
    EXCLUDED_TOP_LEVEL_DIRS.has(segments[0]) ||
    isUnpublishedObjectStagingPath(value) ||
    isSecretCustodyPath(value)
  ) {
    throw storageError("backup_path_invalid", "Backup contains an unsafe relative path.");
  }
  return value;
}

export function isUnpublishedObjectStagingPath(relativePath: unknown = ""): boolean {
  const value = path.posix.normalize(
    String(relativePath || "").replace(/\\/gu, "/")
  ).replace(/^\.?\//u, "");
  return value === UNPUBLISHED_OBJECT_STAGING_ROOT ||
    value.startsWith(`${UNPUBLISHED_OBJECT_STAGING_ROOT}/`);
}

export function isSecretCustodyPath(relativePath: unknown = ""): boolean {
  const value = String(relativePath || "").replace(/\\/gu, "/").replace(/^\.?\//u, "");
  return SECRET_CUSTODY_EXCLUDED_ROOTS.some((root) => value === root || value.startsWith(`${root}/`)) ||
    // Any sealing key under security/ at any depth: sealing keys are
    // operator-custody secrets and must never enter a backup snapshot.
    // This covers both flat layouts (security/<module>/<alias>.sealing-key)
    // and nested runtime-state layouts (security/<namespace>/<alias>/state.sealing-key).
    /^security\/(?:[^/]+\/)*[^/]+\.sealing-key$/u.test(value);
}

export function backupRoot(userDataPath = ""): string {
  const storageRoot = path.resolve(userDataPath || ServerConfig.getDataDir());
  const configured = String(process.env[BACKUP_ROOT_ENV] || "").trim();
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
  const selected = path.resolve(configured);
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
}: {
  userDataPath?: string;
  required?: boolean;
} = {}): Promise<Readonly<{ configured: boolean; independent: boolean }>> {
  const configured = String(process.env[BACKUP_ROOT_ENV] || "").trim();
  if (!configured && !required) {
    return Object.freeze({ configured: false, independent: false });
  }
  const selected = backupRoot(userDataPath);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  let realPath: string;
  let realStoragePath: string;
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

export function backupPath(userDataPath = "", backupId: unknown = ""): string {
  return path.join(backupRoot(userDataPath), normalizeBackupId(backupId));
}

export function backupFilesRoot(userDataPath = "", backupId: unknown = ""): string {
  return path.join(backupPath(userDataPath, backupId), BACKUP_FILES_DIR);
}

export function pathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeArtifactClassifiers(artifactClassifiers: unknown = []): StorageArtifactClassifier[] {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier): classifier is StorageArtifactClassifier => typeof classifier === "function")
    : [];
}

export function classifyExternalArtifact(
  relativePath = "",
  artifactClassifiers: readonly StorageArtifactClassifier[] = []
): string {
  for (const classifier of artifactClassifiers) {
    const category = String(classifier(relativePath) || "").trim();
    if (category) return category;
  }
  return "";
}

export function classifyFile(relativePath = "", artifactClassifiers: readonly StorageArtifactClassifier[] = []): string {
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

export function isSqliteDataFile(relativePath: unknown = ""): boolean {
  const value = String(relativePath || "").toLowerCase();
  return value.endsWith(".sqlite") || value.endsWith(".sqlite3") || value.endsWith(".db");
}

export function isSqliteSidecar(relativePath: unknown = ""): boolean {
  const value = String(relativePath || "").toLowerCase();
  return SQLITE_SIDECAR_SUFFIXES.some((suffix) => value.endsWith(suffix));
}
