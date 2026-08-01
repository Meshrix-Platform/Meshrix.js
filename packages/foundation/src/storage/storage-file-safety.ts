import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openSqliteDatabase } from "./sqlite-database.ts";
import {
  EXCLUDED_TOP_LEVEL_DIRS,
  isSecretCustodyPath,
  classifyFile,
  isSqliteDataFile,
  isSqliteSidecar,
  isStorageError,
  pathWithinRoot,
  safeRelativePath,
  storageError
} from "./backup-contract.ts";

export async function pathExists(filePath?: any) : Promise<any> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath?: any, fallback: any = null) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw storageError("backup_manifest_invalid", "Backup manifest is not valid JSON.", { cause: error });
  }
}

export async function writeJsonAtomic(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath: any = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  let handle: any = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error: any) {
    await handle?.close().catch(() : any => {});
    await fs.rm(tempPath, { force: true }).catch(() : any => {});
    throw error;
  }
}

export function isUnsupportedDirectorySyncError(error?: any) : any {
  return process.platform === "win32" &&
    ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

export async function syncDirectory(directoryPath?: any) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fs.open(directoryPath, fsNative.constants.O_RDONLY);
    await handle.sync();
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

export async function syncDirectoryTree(directoryPath?: any) : Promise<any> {
  const entries: any = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await syncDirectoryTree(path.join(directoryPath, entry.name));
    }
  }
  await syncDirectory(directoryPath);
}

export async function realpathOrResolved(candidatePath?: any) : Promise<any> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export async function realExistingAncestor(candidatePath?: any) : Promise<any> {
  let currentPath: any = path.resolve(candidatePath);
  while (true) {
    try {
      return await fs.realpath(currentPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const parentPath: any = path.dirname(currentPath);
      if (parentPath === currentPath) return currentPath;
      currentPath = parentPath;
    }
  }
}

export async function internalParentSymlinkReason(rootPath?: any, parentPath?: any) : Promise<any> {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(parentPath));
  if (!relative || relative === ".") return "";
  let currentPath: any = path.resolve(rootPath);
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stat: any = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) return "target_parent_symlink_unsupported";
    } catch (error: any) {
      if (error?.code === "ENOENT") return "";
      return "target_parent_unresolvable";
    }
  }
  return "";
}

export async function pathBoundaryReason({ rootPath, targetPath, allowMissingTarget = true }: Record<string, any> = {}) : Promise<any> {
  const normalizedRoot: any = path.resolve(rootPath);
  const normalizedTarget: any = path.resolve(targetPath);
  if (!pathWithinRoot(normalizedTarget, normalizedRoot)) return "target_outside_root";
  const realRoot: any = await realpathOrResolved(normalizedRoot);
  if (normalizedTarget === normalizedRoot) {
    return "";
  }
  const parentSymlinkReason: any = await internalParentSymlinkReason(normalizedRoot, path.dirname(normalizedTarget));
  if (parentSymlinkReason) return parentSymlinkReason;
  const realAncestor: any = await realExistingAncestor(path.dirname(normalizedTarget));
  if (!pathWithinRoot(realAncestor, realRoot)) return "target_parent_outside_root";
  try {
    const targetStat: any = await fs.lstat(normalizedTarget);
    if (targetStat.isSymbolicLink()) return "target_symlink_unsupported";
    const realTarget: any = await fs.realpath(normalizedTarget);
    if (!pathWithinRoot(realTarget, realRoot)) return "target_outside_root";
  } catch (error: any) {
    if (!allowMissingTarget || error?.code !== "ENOENT") return "target_unresolvable";
  }
  return "";
}

export async function ensurePrivateDirectory(rootPath?: any, directoryPath?: any) : Promise<any> {
  const beforeReason: any = await pathBoundaryReason({
    rootPath,
    targetPath: directoryPath,
    allowMissingTarget: true
  });
  if (beforeReason) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory has an unsafe boundary.");
  }
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const afterReason: any = await pathBoundaryReason({
    rootPath,
    targetPath: directoryPath,
    allowMissingTarget: false
  });
  if (afterReason) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory has an unsafe boundary.");
  }
  const stat: any = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storageError("storage_directory_boundary_invalid", "A storage maintenance directory is not a private directory.");
  }
  await fs.chmod(directoryPath, 0o700);
}

export function statSignature(stat?: any) : any {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value?: any) : any => String(value))
    .join(":");
}

function privateNoExecErrorPrefix(value?: any) : any {
  const normalized: any = String(value || "storage_object").trim();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized)
    ? normalized
    : "storage_object";
}

function privateNoExecFileError(errorPrefix?: any, suffix?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = `${errorPrefix}_${suffix}`;
  return error;
}

export async function openPrivateNoExecRegularFile(
  filePath?: any,
  { errorPrefix }: Record<string, any> = {}
) : Promise<any> {
  const prefix: any = privateNoExecErrorPrefix(errorPrefix);
  const knownCodes: any = new Set<any>([
    `${prefix}_file_unsafe`,
    `${prefix}_file_aliased`,
    `${prefix}_mode_unsafe`
  ]);
  const flags: any =
    fsNative.constants.O_RDONLY |
    (fsNative.constants.O_NOFOLLOW || 0);
  let handle: any = null;
  try {
    handle = await fs.open(filePath, flags);
    const stat: any = await handle.stat({ bigint: true });
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
  } catch (error: any) {
    await handle?.close().catch(() : any => {});
    if (knownCodes.has(error?.code)) throw error;
    throw privateNoExecFileError(
      prefix,
      "file_unsafe",
      "A private no-exec file could not be opened safely."
    );
  }
}

export async function openRegularFile(filePath?: any) : Promise<any> {
  const flags: any = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  let handle: any = null;
  try {
    handle = await fs.open(filePath, flags);
    const stat: any = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw storageError("backup_file_type_invalid", "Backup files must be regular files.");
    }
    return { handle, stat };
  } catch (error: any) {
    await handle?.close().catch(() : any => {});
    if (isStorageError(error)) throw error;
    throw storageError("backup_file_unreadable", "A backup file could not be opened safely.", { cause: error });
  }
}

export async function hashOpenFile(handle?: any, executionContext: any = null) : Promise<any> {
  const hash: any = crypto.createHash("sha256");
  let bytes: any = 0;
  const meter: any = new Transform({
    transform(chunk?: any, encoding?: any, callback?: any) : any {
      try {
        executionContext?.consume({ bytes: chunk.length });
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      } catch (error: any) {
        callback(error);
      }
    }
  });
  const sink: any = new Transform({
    transform(chunk?: any, encoding?: any, callback?: any) : any {
      callback();
    }
  });
  await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), meter, sink);
  return { bytes, sha256: hash.digest("hex") };
}

export async function inspectStableFile(
  filePath?: any,
  { changedCode = "backup_file_changed", executionContext = null }: Record<string, any> = {}
) : Promise<any> {
  const { handle, stat: before } = await openRegularFile(filePath);
  try {
    executionContext?.assertActive();
    const integrity: any = await hashOpenFile(handle, executionContext);
    const after: any = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after) || integrity.bytes !== Number(after.size)) {
      throw storageError(changedCode, "A file changed while its integrity was being verified.");
    }
    return {
      ...integrity,
      mtimeMs: Math.trunc(Number(before.mtimeMs))
    };
  } finally {
    await handle.close().catch(() : any => {});
  }
}

export async function copyStableRegularFile({
  sourcePath,
  targetPath,
  expectedBytes = null,
  expectedSha256 = "",
  executionContext = null
}: Record<string, any>) : Promise<any> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const { handle, stat: before } = await openRegularFile(sourcePath);
  const hash: any = crypto.createHash("sha256");
  let bytes: any = 0;
  const meter: any = new Transform({
    transform(chunk?: any, encoding?: any, callback?: any) : any {
      try {
        executionContext?.consume({ bytes: chunk.length });
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      } catch (error: any) {
        callback(error);
      }
    }
  });
  try {
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0 }),
      meter,
      fsNative.createWriteStream(targetPath, { flags: "wx", mode: 0o600 })
    );
    const targetHandle: any = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const after: any = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after) || bytes !== Number(after.size)) {
      throw storageError("backup_source_changed", "A source file changed while the backup snapshot was created.");
    }
    const copiedSha256: any = hash.digest("hex");
    const targetIntegrity: any = await inspectStableFile(targetPath, {
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
  } catch (error: any) {
    await fs.rm(targetPath, { force: true }).catch(() : any => {});
    throw error;
  } finally {
    await handle.close().catch(() : any => {});
  }
}

const CLONE_UNSUPPORTED_CODES: any = new Set<any>(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"]);

export async function cloneStableRegularFile({
  sourcePath,
  targetPath,
  executionContext = null
}: Record<string, any>) : Promise<any> {
  const cloneFlag: any = fsNative.constants.COPYFILE_FICLONE_FORCE;
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
    } catch (error: any) {
      if (!CLONE_UNSUPPORTED_CODES.has(error?.code)) throw error;
      await handle.close();
      return {
        ...(await copyStableRegularFile({ sourcePath, targetPath, executionContext })),
        copyMethod: "stream-copy"
      };
    }
    await fs.chmod(targetPath, 0o600);
    const after: any = await handle.stat({ bigint: true });
    if (statSignature(before) !== statSignature(after)) {
      throw storageError("backup_source_changed", "A source file changed while the backup snapshot was created.");
    }
    executionContext?.consume({ bytes: Number(before.size) });
    const targetHandle: any = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const targetIntegrity: any = await inspectStableFile(targetPath, {
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
  } catch (error: any) {
    await fs.rm(targetPath, { force: true }).catch(() : any => {});
    throw error;
  } finally {
    await handle.close().catch(() : any => {});
  }
}

export async function snapshotSqliteDatabase({
  sourcePath,
  targetPath,
  baselinePath = "",
  executionContext = null
}: Record<string, any>) : Promise<any> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  let sourceDatabase: any = null;
  let snapshotDatabase: any = null;
  let seededFromBaseline: any = false;
  try {
    const sourceStat: any = await fs.lstat(sourcePath);
    executionContext?.assertActive();
    executionContext?.consume({ bytes: Number(sourceStat.size || 0) });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw storageError("backup_file_type_invalid", "SQLite backup sources must be regular files.");
    }
    if (baselinePath && Number.isInteger(fsNative.constants.COPYFILE_FICLONE_FORCE)) {
      try {
        await fs.copyFile(baselinePath, targetPath, fsNative.constants.COPYFILE_FICLONE_FORCE);
        seededFromBaseline = true;
      } catch (error: any) {
        if (!CLONE_UNSUPPORTED_CODES.has(error?.code) && error?.code !== "ENOENT") throw error;
        await fs.rm(targetPath, { force: true }).catch(() : any => {});
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
    const targetHandle: any = await fs.open(targetPath, "r+");
    try {
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    const integrity: any = await inspectStableFile(targetPath, {
      changedCode: "backup_target_changed",
      executionContext
    });
    return {
      ...integrity,
      mtimeMs: Math.trunc(sourceStat.mtimeMs),
      copyMethod: seededFromBaseline ? "copy-on-write-page-update" : "sqlite-online-backup"
    };
  } catch (error: any) {
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
    await fs.rm(targetPath, { force: true }).catch(() : any => {});
    if (isStorageError(error)) throw error;
    throw storageError("backup_sqlite_snapshot_failed", "SQLite online backup could not be completed safely.", { cause: error });
  }
}

export async function collectSnapshotSources(
  rootPath?: any,
  currentPath: any = rootPath,
  entries: any = [],
  artifactClassifiers: any = [],
  { includeSqliteSidecars = false }: Record<string, any> = {}
) : Promise<any> {
  const currentBoundaryReason: any = await pathBoundaryReason({
    rootPath,
    targetPath: currentPath,
    allowMissingTarget: false
  });
  if (currentBoundaryReason) {
    throw storageError("backup_source_boundary_invalid", "A backup source directory escaped the storage root.");
  }
  let dirents: any[] = [];
  try {
    dirents = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return entries;
    throw error;
  }
  for (const dirent of dirents) {
    const absolutePath: any = path.join(currentPath, dirent.name);
    const relativePath: any = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
    const topLevel: any = relativePath.split("/")[0];
    if (EXCLUDED_TOP_LEVEL_DIRS.has(topLevel) || isSecretCustodyPath(relativePath)) continue;
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
  return entries.sort((a?: any, b?: any) : any => a.relativePath.localeCompare(b.relativePath));
}

export async function captureRegularSourceSignatures(sources: any = []) : Promise<any> {
  const signatures: any = new Map<any, any>();
  for (const source of sources) {
    if (isSqliteDataFile(source.relativePath)) continue;
    const { handle, stat } = await openRegularFile(source.sourcePath);
    try {
      signatures.set(source.relativePath, statSignature(stat));
    } finally {
      await handle.close().catch(() : any => {});
    }
  }
  return signatures;
}

export async function assertSnapshotSourceSetStable({
  rootPath,
  sources,
  regularSourceSignatures,
  artifactClassifiers
}: Record<string, any>) : Promise<any> {
  const currentSources: any = await collectSnapshotSources(
    rootPath,
    rootPath,
    [],
    artifactClassifiers
  );
  const expectedSet: any = sources.map((source?: any) : any => `${source.relativePath}:${source.category}`);
  const currentSet: any = currentSources.map((source?: any) : any => `${source.relativePath}:${source.category}`);
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
      await handle.close().catch(() : any => {});
    }
  }
}
