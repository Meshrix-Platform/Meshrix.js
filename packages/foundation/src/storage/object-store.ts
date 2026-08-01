import { createHash, randomUUID } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "#meshrix/client-strings";
import { openPrivateNoExecRegularFile } from "./storage-file-safety.ts";

const FILE_COPY_BUFFER_BYTES: any = 64 * 1024;
const OBJECT_READ_STREAM_BUFFER_BYTES: any = 64 * 1024;
const PRIVATE_DIRECTORY_MODE: any = 0o700;
const PRIVATE_FILE_MODE: any = 0o600;
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES: any = new Set<any>(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);

function nowIso() : any {
  return new Date().toISOString();
}

function normalizeNamespace(value: any = "default") : any {
  return String(value || "default")
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96) || "default";
}

function safeFileName(value: any = "object.bin") : any {
  const baseName: any = path.posix.basename(String(value || "object.bin").replace(/\\/g, "/"));
  return baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180) || "object.bin";
}

function normalizeRelativePath(value: any = "") : any {
  const normalized: any = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  const segments: any = normalized.split("/");
  if (!normalized || segments.some((segment?: any) : any => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe storage object relative path: ${value}`);
  }
  return normalized;
}

function pathWithinRoot(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExpectedSha256(value: any = "") : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  if (normalized && !/^[a-f0-9]{64}$/u.test(normalized)) {
    const error: Error & Record<string, any> = new Error("Expected storage object digest must be a SHA-256 hex value.");
    error.code = "storage_object_expected_digest_invalid";
    throw error;
  }
  return normalized;
}

function normalizeExpectedByteSize(value?: any) : any {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized: any = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    const error: Error & Record<string, any> = new Error("Expected storage object byte size must be a non-negative safe integer.");
    error.code = "storage_object_expected_size_invalid";
    throw error;
  }
  return normalized;
}

function storageObjectTarget({ userDataPath, namespace, fileName, objectId, sha256 }: Record<string, any>) : any {
  const safeNamespace: any = normalizeNamespace(namespace);
  const safeName: any = safeFileName(fileName);
  const objectIdentityHash: any = createHash("sha256")
    .update(String(objectId || ""), "utf8")
    .digest("hex")
    .slice(0, 32);
  const objectDirectory: any = resolveWithin(userDataPath, "objects", safeNamespace, sha256.slice(0, 2));
  const storageFileName: any = `${sha256.slice(0, 16)}__${objectIdentityHash}__${safeName}`;
  const targetPath: any = resolveWithin(objectDirectory, storageFileName);
  return {
    safeNamespace,
    safeName,
    objectDirectory,
    targetPath
  };
}

function isUnsupportedDirectorySyncError(error?: any) : any {
  return process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code);
}

async function ensurePrivateObjectDirectory(directoryPath?: any) : Promise<any> {
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat: any = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw objectIntegrityError(
      "storage_object_directory_unsafe",
      "A storage object directory is not a private regular directory."
    );
  }
  try {
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  }
}

async function hardenPrivateObjectFile(filePath?: any) : Promise<any> {
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  }
}

async function syncDirectory(directoryPath?: any) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

function objectIntegrityError(code?: any, message?: any, cause?: any) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function objectFileSignature(stat?: any) : any {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value?: any) : any => String(value))
    .join(":");
}

async function inspectStoredObjectFile(filePath?: any) : Promise<any> {
  const flags: any = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  let handle: any = null;
  try {
    handle = await fs.open(filePath, flags);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw objectIntegrityError("storage_object_missing", "The stored object file is missing.", error);
    }
    if (error?.code === "ELOOP") {
      throw objectIntegrityError("storage_object_file_unsafe", "The stored object file is not a regular file.", error);
    }
    throw objectIntegrityError(
      "storage_object_integrity_unavailable",
      "The stored object file could not be opened for integrity verification.",
      error
    );
  }

  try {
    const before: any = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw objectIntegrityError("storage_object_file_unsafe", "The stored object file is not a regular file.");
    }
    const digest: any = createHash("sha256");
    const readBuffer: any = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES);
    let byteSize: any = 0;
    while (true) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) break;
      digest.update(readBuffer.subarray(0, bytesRead));
      byteSize += bytesRead;
    }
    const after: any = await handle.stat({ bigint: true });
    if (
      objectFileSignature(before) !== objectFileSignature(after) ||
      !Number.isSafeInteger(Number(after.size)) ||
      byteSize !== Number(after.size)
    ) {
      throw objectIntegrityError(
        "storage_object_changed_during_verification",
        "The stored object changed during integrity verification."
      );
    }
    return {
      byteSize,
      sha256: digest.digest("hex")
    };
  } finally {
    await handle.close().catch(() : any => {});
  }
}

async function commitTemporaryObject({
  temporaryPath,
  targetPath,
  objectDirectory,
  byteSize,
  sha256
}: Record<string, any>) : Promise<any> {
  await ensurePrivateObjectDirectory(objectDirectory);
  try {
    const existing: any = await inspectStoredObjectFile(targetPath);
    if (existing.byteSize !== byteSize || existing.sha256 !== sha256) {
      throw objectIntegrityError(
        "storage_object_integrity_mismatch",
        "An existing stored object does not match the content being persisted."
      );
    }
    await fs.rm(temporaryPath, { force: true });
    await syncDirectory(path.dirname(temporaryPath));
    return;
  } catch (error: any) {
    if (error?.code !== "storage_object_missing") throw error;
  }
  await fs.rename(temporaryPath, targetPath);
  await hardenPrivateObjectFile(targetPath);
  await syncDirectory(objectDirectory);
  await syncDirectory(path.dirname(temporaryPath));
}

async function createPendingObjectFile({ userDataPath, objectId }: Record<string, any>) : Promise<any> {
  const pendingDirectory: any = resolveWithin(userDataPath, "objects", ".pending");
  await ensurePrivateObjectDirectory(pendingDirectory);
  const temporaryPath: any = resolveWithin(
    pendingDirectory,
    `${safeFileName(objectId)}.${randomUUID()}.tmp`
  );
  return { pendingDirectory, temporaryPath };
}

export function getObjectRootPath(userDataPath?: any) : any {
  return path.join(userDataPath, "objects");
}

export function resolveStoredObjectPath(userDataPath?: any, storageRelativePath?: any) : any {
  const resolvedPath: any = resolveWithin(userDataPath, normalizeRelativePath(storageRelativePath));
  if (!pathWithinRoot(resolvedPath, getObjectRootPath(userDataPath))) {
    throw new Error(`Unsafe storage object relative path: ${storageRelativePath}`);
  }
  return resolvedPath;
}

export async function verifyStoredObjectIntegrity({
  userDataPath,
  storageRelativePath,
  expectedSha256 = "",
  expectedByteSize = null
}: Record<string, any> = {}) : Promise<any> {
  const normalizedExpectedSha256: any = normalizeExpectedSha256(expectedSha256);
  const normalizedExpectedByteSize: any = normalizeExpectedByteSize(expectedByteSize);
  const resolvedPath: any = resolveStoredObjectPath(userDataPath, storageRelativePath);
  const integrity: any = await inspectStoredObjectFile(resolvedPath);
  if (
    (normalizedExpectedSha256 && integrity.sha256 !== normalizedExpectedSha256) ||
    (normalizedExpectedByteSize !== null && integrity.byteSize !== normalizedExpectedByteSize)
  ) {
    throw objectIntegrityError(
      "storage_object_integrity_mismatch",
      "The stored object does not match its persisted integrity metadata."
    );
  }
  return integrity;
}

export async function putStoredObject({
  userDataPath,
  buffer,
  namespace = "default",
  fileName = "object.bin",
  mediaType = "application/octet-stream",
  metadata = {},
  objectId = randomUUID()
}: Record<string, any> = {}) : Promise<any> {
  const bytes: any = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const sha256: any = createHash("sha256").update(bytes).digest("hex");
  const resolvedObjectId: any = String(objectId || randomUUID());
  const {
    safeNamespace,
    safeName,
    objectDirectory,
    targetPath
  } = storageObjectTarget({
    userDataPath,
    namespace,
    fileName,
    objectId: resolvedObjectId,
    sha256
  });

  const { temporaryPath } = await createPendingObjectFile({
    userDataPath,
    objectId: resolvedObjectId
  });
  let targetHandle: any = null;
  let committed: any = false;
  try {
    targetHandle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await targetHandle.writeFile(bytes);
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    await commitTemporaryObject({
      temporaryPath,
      targetPath,
      objectDirectory,
      byteSize: bytes.length,
      sha256
    });
    committed = true;
  } finally {
    await targetHandle?.close().catch(() : any => {});
    if (!committed) await fs.rm(temporaryPath, { force: true }).catch(() : any => {});
  }

  const storageRelativePath: any = path.relative(userDataPath, targetPath).split(path.sep).join("/");
  const timestamp: any = nowIso();
  return {
    objectId: resolvedObjectId,
    namespace: safeNamespace,
    fileName: safeName,
    storageRelativePath,
    sha256,
    byteSize: bytes.length,
    mediaType: String(mediaType || "application/octet-stream"),
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function putStoredObjectFromFile({
  userDataPath,
  sourcePath,
  namespace = "default",
  fileName = "object.bin",
  mediaType = "application/octet-stream",
  metadata = {},
  objectId = randomUUID(),
  expectedSha256 = "",
  expectedByteSize = null
}: Record<string, any> = {}) : Promise<any> {
  const resolvedObjectId: any = String(objectId || randomUUID());
  const normalizedExpectedSha256: any = normalizeExpectedSha256(expectedSha256);
  const normalizedExpectedByteSize: any = normalizeExpectedByteSize(expectedByteSize);
  const { temporaryPath } = await createPendingObjectFile({
    userDataPath,
    objectId: resolvedObjectId
  });
  const sourceHandle: any = await fs.open(path.resolve(String(sourcePath || "")), "r");
  let targetHandle: any = null;
  let committed: any = false;
  try {
    targetHandle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    const digest: any = createHash("sha256");
    const copyBuffer: any = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES);
    let byteSize: any = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(copyBuffer, 0, copyBuffer.length, null);
      if (bytesRead === 0) break;
      digest.update(copyBuffer.subarray(0, bytesRead));
      let written: any = 0;
      while (written < bytesRead) {
        const result: any = await targetHandle.write(copyBuffer, written, bytesRead - written, null);
        if (result.bytesWritten <= 0) {
          const error: Error & Record<string, any> = new Error("Storage object copy made no forward progress.");
          error.code = "storage_object_copy_stalled";
          throw error;
        }
        written += result.bytesWritten;
      }
      byteSize += bytesRead;
    }
    const sha256: any = digest.digest("hex");
    if (normalizedExpectedSha256 && sha256 !== normalizedExpectedSha256) {
      const error: Error & Record<string, any> = new Error("Staged storage object digest changed before persistence.");
      error.code = "storage_object_digest_mismatch";
      throw error;
    }
    if (normalizedExpectedByteSize !== null && byteSize !== normalizedExpectedByteSize) {
      const error: Error & Record<string, any> = new Error("Staged storage object size changed before persistence.");
      error.code = "storage_object_size_mismatch";
      throw error;
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    const {
      safeNamespace,
      safeName,
      objectDirectory,
      targetPath
    } = storageObjectTarget({
      userDataPath,
      namespace,
      fileName,
      objectId: resolvedObjectId,
      sha256
    });
    await commitTemporaryObject({
      temporaryPath,
      targetPath,
      objectDirectory,
      byteSize,
      sha256
    });
    committed = true;
    const timestamp: any = nowIso();
    return {
      objectId: resolvedObjectId,
      namespace: safeNamespace,
      fileName: safeName,
      storageRelativePath: path.relative(userDataPath, targetPath).split(path.sep).join("/"),
      sha256,
      byteSize,
      mediaType: String(mediaType || "application/octet-stream"),
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
  } finally {
    await sourceHandle.close().catch(() : any => {});
    await targetHandle?.close?.().catch(() : any => {});
    if (!committed) {
      await fs.rm(temporaryPath, { force: true }).catch(() : any => {});
    }
  }
}

export function recordStoredObject(db?: any, object: Record<string, any> = {}) : any {
  if (!db || !object?.objectId || !object?.storageRelativePath) {
    return null;
  }
  const timestamp: any = object.updatedAt || object.createdAt || nowIso();
  db.prepare(`
    INSERT INTO storage_objects (
      object_id, namespace, storage_rel_path, sha256, byte_size,
      media_type, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(object_id) DO UPDATE SET
      namespace = excluded.namespace,
      storage_rel_path = excluded.storage_rel_path,
      sha256 = excluded.sha256,
      byte_size = excluded.byte_size,
      media_type = excluded.media_type,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    object.objectId,
    object.namespace || "default",
    object.storageRelativePath,
    object.sha256 || "",
    Number(object.byteSize || 0),
    object.mediaType || "application/octet-stream",
    JSON.stringify(object.metadata && typeof object.metadata === "object" ? object.metadata : {}),
    object.createdAt || timestamp,
    timestamp
  );
  const metadata: any = object.metadata && typeof object.metadata === "object"
    ? object.metadata
    : {};
  const owner: Record<string, any> = {
    jobId: String(metadata.jobId || "").trim(),
    archiveBatchId: String(metadata.archiveBatchId || "").trim(),
    ownerSubjectId: String(metadata.ownerSubjectId || "").trim(),
    ownerUserId: String(metadata.ownerUserId || "").trim(),
    ownerUsername: String(metadata.ownerUsername || "").trim()
  };
  if ((Object.values(owner) as any[]).some(Boolean)) {
    db.prepare(`
      INSERT INTO storage_object_owners (
        object_id, job_id, archive_batch_id, owner_subject_id,
        owner_user_id, owner_username, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET
        job_id = excluded.job_id,
        archive_batch_id = excluded.archive_batch_id,
        owner_subject_id = excluded.owner_subject_id,
        owner_user_id = excluded.owner_user_id,
        owner_username = excluded.owner_username,
        updated_at = excluded.updated_at
    `).run(
      object.objectId,
      owner.jobId,
      owner.archiveBatchId,
      owner.ownerSubjectId,
      owner.ownerUserId,
      owner.ownerUsername,
      object.createdAt || timestamp,
      timestamp
    );
  }
  return object;
}

export async function readStoredObject({ userDataPath, storageRelativePath }: Record<string, any> = {}) : Promise<any> {
  const resolvedPath: any = resolveStoredObjectPath(userDataPath, storageRelativePath);
  return fs.readFile(resolvedPath);
}

export async function openStoredObjectReadStream({
  userDataPath,
  storageRelativePath,
  signal
}: Record<string, any> = {}) : Promise<any> {
  const resolvedPath: any = resolveStoredObjectPath(userDataPath, storageRelativePath);
  const handle: any = await fs.open(resolvedPath, "r");
  try {
    const stat: any = await handle.stat();
    if (!stat.isFile()) {
      const error: Error & Record<string, any> = new Error("Storage object is not a regular file.");
      error.code = "storage_object_not_regular_file";
      throw error;
    }
    return {
      byteSize: stat.size,
      stream: handle.createReadStream({
        autoClose: true,
        highWaterMark: OBJECT_READ_STREAM_BUFFER_BYTES,
        signal
      })
    };
  } catch (error: any) {
    await handle.close().catch(() : any => {});
    throw error;
  }
}

function privateObjectRelativePath(value?: any) : any {
  const normalized: any = String(value || "").trim();
  const segments: any = normalized.split("/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    segments.some(
      (segment?: any) : any => !segment || segment === "." || segment === ".."
    )
  ) {
    throw objectIntegrityError(
      "upload_custody_file_unsafe",
      "The private custody object identity is invalid."
    );
  }
  return normalized;
}

export async function openPrivateNoExecObjectReadStream({
  userDataPath,
  storageRelativePath,
  signal
}: Record<string, any> = {}) : Promise<any> {
  let resolvedPath: any;
  try {
    resolvedPath = resolveStoredObjectPath(
      userDataPath,
      privateObjectRelativePath(storageRelativePath)
    );
  } catch {
    throw objectIntegrityError(
      "upload_custody_file_unsafe",
      "The private custody object identity is invalid."
    );
  }
  const { handle, stat } = await openPrivateNoExecRegularFile(
    resolvedPath,
    { errorPrefix: "upload_custody" }
  );
  try {
    const byteSize: any = Number(stat.size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw objectIntegrityError(
        "upload_custody_file_unsafe",
        "The private custody object size is invalid."
      );
    }
    return {
      byteSize,
      stream: handle.createReadStream({
        autoClose: true,
        highWaterMark: OBJECT_READ_STREAM_BUFFER_BYTES,
        signal
      })
    };
  } catch (error: any) {
    await handle.close().catch(() : any => {});
    throw error;
  }
}

export async function statStoredObject({ userDataPath, storageRelativePath }: Record<string, any> = {}) : Promise<any> {
  const resolvedPath: any = resolveStoredObjectPath(userDataPath, storageRelativePath);
  return fs.stat(resolvedPath);
}

export async function removeStoredObject({ userDataPath, storageRelativePath }: Record<string, any> = {}) : Promise<any> {
  const resolvedPath: any = resolveStoredObjectPath(userDataPath, storageRelativePath);
  await fs.rm(resolvedPath, { force: true });
}
