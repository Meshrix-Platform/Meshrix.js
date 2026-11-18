import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type Database from "better-sqlite3";
import { pipeline } from "node:stream/promises";
import { openSqliteDatabase } from "./sqlite-database.ts";
import {
  EXCLUDED_TOP_LEVEL_DIRS,
  isSecretCustodyPath,
  isUnpublishedObjectStagingPath,
  classifyFile,
  isSqliteDataFile,
  isSqliteSidecar,
  isStorageError,
  pathWithinRoot,
  safeRelativePath,
  storageError
} from "./backup-contract.ts";
import type { StorageArtifactClassifier } from "./backup-contract.ts";

type UnknownRecord = Record<string, unknown>;
type PrivateFileError = Error & { code: string };

interface StorageExecutionContext {
  assertActive(): void;
  consume(amounts: { files?: number; bytes?: number; cleanupItems?: number }): void;
}

export interface StableFileIntegrity {
  bytes: number;
  sha256: string;
  mtimeMs: number;
}

export interface SnapshotFileIntegrity extends StableFileIntegrity {
  copyMethod: string;
}

export interface SnapshotSource {
  relativePath: string;
  sourcePath: string;
  category: string;
}

export interface OpenRegularFileResult {
  handle: FileHandle;
  stat: BigIntStats;
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function errorCode(error: unknown): string {
  return String(record(error).code || "");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath: string, fallback: unknown = null): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return fallback;
    throw storageError("backup_manifest_invalid", "Backup manifest is not valid JSON.", { cause: error });
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error: unknown) {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return process.platform === "win32" &&
    ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error));
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(directoryPath, fsNative.constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function syncDirectoryTree(directoryPath: string): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await syncDirectoryTree(path.join(directoryPath, entry.name));
    }
  }
  await syncDirectory(directoryPath);
}

export async function realpathOrResolved(candidatePath: string): Promise<string> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export async function realExistingAncestor(candidatePath: string): Promise<string> {
  let currentPath = path.resolve(candidatePath);
  while (true) {
    try {
      return await fs.realpath(currentPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return currentPath;
      currentPath = parentPath;
    }
  }
}

export async function internalParentSymlinkReason(rootPath: string, parentPath: string): Promise<string> {
  const relative = path.relative(path.resolve(rootPath), path.resolve(parentPath));
  if (!relative || relative === ".") return "";
  let currentPath = path.resolve(rootPath);
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) return "target_parent_symlink_unsupported";
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return "";
      return "target_parent_unresolvable";
    }
  }
  return "";
}

export async function pathBoundaryReason({ rootPath, targetPath, allowMissingTarget = true }: {
  rootPath: string;
  targetPath: string;
  allowMissingTarget?: boolean;
}): Promise<string> {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (!pathWithinRoot(normalizedTarget, normalizedRoot)) return "target_outside_root";
  const realRoot = await realpathOrResolved(normalizedRoot);
  if (normalizedTarget === normalizedRoot) {
    return "";
  }
  const parentSymlinkReason = await internalParentSymlinkReason(normalizedRoot, path.dirname(normalizedTarget));
  if (parentSymlinkReason) return parentSymlinkReason;
  const realAncestor = await realExistingAncestor(path.dirname(normalizedTarget));
  if (!pathWithinRoot(realAncestor, realRoot)) return "target_parent_outside_root";
  try {
    const targetStat = await fs.lstat(normalizedTarget);
    if (targetStat.isSymbolicLink()) return "target_symlink_unsupported";
    const realTarget = await fs.realpath(normalizedTarget);
    if (!pathWithinRoot(realTarget, realRoot)) return "target_outside_root";
  } catch (error: unknown) {
    if (!allowMissingTarget || errorCode(error) !== "ENOENT") return "target_unresolvable";
  }
  return "";
}

export async function ensurePrivateDirectory(rootPath: string, directoryPath: string): Promise<void> {
  const beforeReason = await pathBoundaryReason({
    rootPath,
    targetPath: directoryPath,
    allowMissingTarget: true
  });
  if (beforeReason) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory has an unsafe boundary.");
  }
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const afterReason = await pathBoundaryReason({
    rootPath,
    targetPath: directoryPath,
    allowMissingTarget: false
  });
  if (afterReason) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory has an unsafe boundary.");
  }
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory is not a private directory.");
  }
  await fs.chmod(directoryPath, 0o700);
}

export function statSignature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => String(value))
    .join(":");
}

function privateNoExecErrorPrefix(value: unknown): string {
  const normalized = String(value || "storage_object").trim();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized)
    ? normalized
    : "storage_object";
}

function privateNoExecFileError(errorPrefix: string, suffix: string, message: string): PrivateFileError {
  const error = new Error(message) as PrivateFileError;
  error.code = `${errorPrefix}_${suffix}`;
  return error;
}

export async function openPrivateNoExecRegularFile(
  filePath: string,
  { errorPrefix }: { errorPrefix?: unknown } = {}
): Promise<OpenRegularFileResult> {
  const prefix = privateNoExecErrorPrefix(errorPrefix);
  const knownCodes = new Set([
    `${prefix}_file_unsafe`,
    `${prefix}_file_aliased`,
    `${prefix}_mode_unsafe`
  ]);
  const flags =
    fsNative.constants.O_RDONLY |
    (fsNative.constants.O_NOFOLLOW || 0);
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, flags);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw privateNoExecFileError(
        prefix,
        "file_unsafe",
        "A private no-exec file is not a regular file."
      );
    }
    if (Number(stat.nlink) !== 1) {
      throw privateNoExecFileError(
        prefix,
        "file_aliased",
        "A private no-exec file has an unsafe link count."
      );
    }
    if (
      process.platform !== "win32" &&
      (Number(stat.mode) & 0o777) !== 0o600
    ) {
      throw privateNoExecFileError(
        prefix,
        "mode_unsafe",
        "A private no-exec file has unsafe permissions."
      );
    }
    return { handle, stat };
  } catch (error: unknown) {
    await handle?.close().catch(() => {});
    if (knownCodes.has(errorCode(error))) throw error;
    throw privateNoExecFileError(
      prefix,
      "file_unsafe",
      "A private no-exec file could not be opened safely."
    );
  }
}

export async function openRegularFile(filePath: string): Promise<OpenRegularFileResult> {
  const flags = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, flags);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw storageError("backup_file_type_invalid", "Backup files must be regular files.");
    }
    return { handle, stat };
  } catch (error: unknown) {
    await handle?.close().catch(() => {});
    if (isStorageError(error)) throw error;
    throw storageError("backup_file_unreadable", "A backup file could not be opened safely.", { cause: error });
  }
}

export async function hashOpenFile(
  handle: FileHandle,
  executionContext: StorageExecutionContext | null = null
): Promise<Omit<StableFileIntegrity, "mtimeMs">> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      try {
        executionContext?.consume({ bytes: chunk.length });
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      } catch (error: unknown) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  const sink = new Transform({
    transform(_chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      callback();
    }
  });
  await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), meter, sink);
  return { bytes, sha256: hash.digest("hex") };
}

export async function inspectStableFile(
  filePath: string,
  {
    changedCode = "backup_file_changed",
    executionContext = null
  }: { changedCode?: string; executionContext?: StorageExecutionContext | null } = {}
): Promise<StableFileIntegrity> {
  const { handle, stat: before } = await openRegularFile(filePath);
  try {
    executionContext?.assertActive();
    const integrity = await hashOpenFile(handle, executionContext);
    const after = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after) || integrity.bytes !== Number(after.size)) {
      throw storageError(changedCode, "A file changed while its integrity was being verified.");
    }
    return {
      ...integrity,
      mtimeMs: Math.trunc(Number(before.mtimeMs))
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function copyStableRegularFile({
  sourcePath,
  targetPath,
  expectedBytes = null,
  expectedSha256 = "",
  executionContext = null
}: {
  sourcePath: string;
  targetPath: string;
  expectedBytes?: number | null;
  expectedSha256?: string;
  executionContext?: StorageExecutionContext | null;
}): Promise<StableFileIntegrity> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const { handle, stat: before } = await openRegularFile(sourcePath);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      try {
        executionContext?.consume({ bytes: chunk.length });
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      } catch (error: unknown) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  try {
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0 }),
      meter,
      fsNative.createWriteStream(targetPath, { flags: "wx", mode: 0o600 })
    );
    const targetHandle = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const after = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after) || bytes !== Number(after.size)) {
      throw storageError("backup_source_changed", "A source file changed while the backup snapshot was created.");
    }
    const copiedSha256 = hash.digest("hex");
    const targetIntegrity = await inspectStableFile(targetPath, {
      changedCode: "backup_target_changed",
      executionContext
    });
    if (targetIntegrity.bytes !== bytes || targetIntegrity.sha256 !== copiedSha256) {
      throw storageError("backup_target_verification_failed", "A copied backup file failed destination verification.");
    }
    if (expectedBytes !== null && targetIntegrity.bytes !== expectedBytes) {
      throw storageError("backup_size_mismatch", "A backup file does not match its manifest size.");
    }
    if (expectedSha256 && targetIntegrity.sha256 !== expectedSha256) {
      throw storageError("backup_hash_mismatch", "A backup file does not match its manifest digest.");
    }
    return {
      bytes: targetIntegrity.bytes,
      sha256: targetIntegrity.sha256,
      mtimeMs: Math.trunc(Number(before.mtimeMs))
    };
  } catch (error: unknown) {
    await fs.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

const CLONE_UNSUPPORTED_CODES = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"]);

export async function cloneStableRegularFile({
  sourcePath,
  targetPath,
  executionContext = null
}: {
  sourcePath: string;
  targetPath: string;
  executionContext?: StorageExecutionContext | null;
}): Promise<SnapshotFileIntegrity> {
  const cloneFlag = fsNative.constants.COPYFILE_FICLONE_FORCE;
  if (!Number.isInteger(cloneFlag)) {
    return {
      ...(await copyStableRegularFile({ sourcePath, targetPath, executionContext })),
      copyMethod: "stream-copy"
    };
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const { handle, stat: before } = await openRegularFile(sourcePath);
  try {
    executionContext?.assertActive();
    try {
      await fs.copyFile(sourcePath, targetPath, cloneFlag);
    } catch (error: unknown) {
      if (!CLONE_UNSUPPORTED_CODES.has(errorCode(error))) throw error;
      await handle.close();
      return {
        ...(await copyStableRegularFile({ sourcePath, targetPath, executionContext })),
        copyMethod: "stream-copy"
      };
    }
    await fs.chmod(targetPath, 0o600);
    const after = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after)) {
      throw storageError("backup_source_changed", "A source file changed while the backup snapshot was created.");
    }
    executionContext?.consume({ bytes: Number(before.size) });
    const targetHandle = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const targetIntegrity = await inspectStableFile(targetPath, {
      changedCode: "backup_target_changed",
      executionContext
    });
    if (targetIntegrity.bytes !== Number(before.size)) {
      throw storageError("backup_target_verification_failed", "A cloned backup file failed destination verification.");
    }
    return {
      bytes: targetIntegrity.bytes,
      sha256: targetIntegrity.sha256,
      mtimeMs: Math.trunc(Number(before.mtimeMs)),
      copyMethod: "copy-on-write"
    };
  } catch (error: unknown) {
    await fs.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function snapshotSqliteDatabase({
  sourcePath,
  targetPath,
  baselinePath = "",
  executionContext = null
}: {
  sourcePath: string;
  targetPath: string;
  baselinePath?: string;
  executionContext?: StorageExecutionContext | null;
}): Promise<SnapshotFileIntegrity> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  let sourceDatabase: Database.Database | null = null;
  let snapshotDatabase: Database.Database | null = null;
  let seededFromBaseline = false;
  try {
    const sourceStat = await fs.lstat(sourcePath);
    executionContext?.assertActive();
    executionContext?.consume({ bytes: Number(sourceStat.size || 0) });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw storageError("backup_file_type_invalid", "SQLite backup sources must be regular files.");
    }
    if (baselinePath && Number.isInteger(fsNative.constants.COPYFILE_FICLONE_FORCE)) {
      try {
        await fs.copyFile(baselinePath, targetPath, fsNative.constants.COPYFILE_FICLONE_FORCE);
        seededFromBaseline = true;
      } catch (error: unknown) {
        const code = errorCode(error);
        if (!CLONE_UNSUPPORTED_CODES.has(code) && code !== "ENOENT") throw error;
        await fs.rm(targetPath, { force: true }).catch(() => {});
      }
    }
    sourceDatabase = openSqliteDatabase(sourcePath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    await sourceDatabase.backup(targetPath);
    sourceDatabase.close();
    sourceDatabase = null;
    await fs.chmod(targetPath, 0o600);
    snapshotDatabase = openSqliteDatabase(targetPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    if (String(snapshotDatabase.pragma("quick_check", { simple: true }) || "").toLowerCase() !== "ok") {
      throw storageError("backup_sqlite_integrity_failed", "SQLite backup integrity verification failed.");
    }
    snapshotDatabase.close();
    snapshotDatabase = null;
    const targetHandle = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const integrity = await inspectStableFile(targetPath, {
      changedCode: "backup_target_changed",
      executionContext
    });
    return {
      ...integrity,
      mtimeMs: Math.trunc(sourceStat.mtimeMs),
      copyMethod: seededFromBaseline ? "copy-on-write-page-update" : "sqlite-online-backup"
    };
  } catch (error: unknown) {
    try {
      snapshotDatabase?.close();
    } catch {
      // Preserve the snapshot failure.
    }
    try {
      sourceDatabase?.close();
    } catch {
      // Preserve the snapshot failure.
    }
    await fs.rm(targetPath, { force: true }).catch(() => {});
    if (isStorageError(error)) throw error;
    throw storageError("backup_sqlite_snapshot_failed", "SQLite online backup could not be completed safely.", { cause: error });
  }
}

export async function collectSnapshotSources(
  rootPath: string,
  currentPath = rootPath,
  entries: SnapshotSource[] = [],
  artifactClassifiers: readonly StorageArtifactClassifier[] = [],
  { includeSqliteSidecars = false }: { includeSqliteSidecars?: boolean } = {}
): Promise<SnapshotSource[]> {
  const currentBoundaryReason = await pathBoundaryReason({
    rootPath,
    targetPath: currentPath,
    allowMissingTarget: false
  });
  if (currentBoundaryReason) {
    throw storageError("backup_source_boundary_invalid", "A backup source directory escaped the storage root.");
  }
  let dirents: Dirent<string>[] = [];
  try {
    dirents = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return entries;
    throw error;
  }
  for (const dirent of dirents) {
    const absolutePath = path.join(currentPath, dirent.name);
    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
    const topLevel = relativePath.split("/")[0];
    if (
      EXCLUDED_TOP_LEVEL_DIRS.has(topLevel) ||
      isUnpublishedObjectStagingPath(relativePath) ||
      isSecretCustodyPath(relativePath)
    ) continue;
    if (dirent.isSymbolicLink() || (!dirent.isDirectory() && !dirent.isFile())) {
      throw storageError(
        "storage_artifact_type_unsupported",
        "Storage backup and replacement restore require governed artifacts to be regular files or directories."
      );
    }
    if (dirent.isDirectory()) {
      await collectSnapshotSources(
        rootPath,
        absolutePath,
        entries,
        artifactClassifiers,
        { includeSqliteSidecars }
      );
      continue;
    }
    if (!includeSqliteSidecars && isSqliteSidecar(relativePath)) continue;
    entries.push({
      relativePath: safeRelativePath(relativePath),
      sourcePath: absolutePath,
      category: classifyFile(relativePath, artifactClassifiers)
    });
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function captureRegularSourceSignatures(
  sources: readonly SnapshotSource[] = []
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>();
  for (const source of sources) {
    if (isSqliteDataFile(source.relativePath)) continue;
    const { handle, stat } = await openRegularFile(source.sourcePath);
    try {
      signatures.set(source.relativePath, statSignature(stat));
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return signatures;
}

export async function assertSnapshotSourceSetStable({
  rootPath,
  sources,
  regularSourceSignatures,
  artifactClassifiers
}: {
  rootPath: string;
  sources: readonly SnapshotSource[];
  regularSourceSignatures: ReadonlyMap<string, string>;
  artifactClassifiers: readonly StorageArtifactClassifier[];
}): Promise<void> {
  const currentSources = await collectSnapshotSources(
    rootPath,
    rootPath,
    [],
    artifactClassifiers
  );
  const expectedSet = sources.map((source) => `${source.relativePath}:${source.category}`);
  const currentSet = currentSources.map((source) => `${source.relativePath}:${source.category}`);
  if (JSON.stringify(expectedSet) !== JSON.stringify(currentSet)) {
    throw storageError("backup_source_set_changed", "The storage file set changed while the backup snapshot was created.");
  }
  for (const source of currentSources) {
    if (isSqliteDataFile(source.relativePath)) continue;
    const { handle, stat } = await openRegularFile(source.sourcePath);
    try {
      if (regularSourceSignatures.get(source.relativePath) !== statSignature(stat)) {
        throw storageError("backup_source_changed", "A source file changed while the backup snapshot was created.");
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
