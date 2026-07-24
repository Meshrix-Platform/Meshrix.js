import { createHash, randomUUID } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "#meshrix/client-strings";

const FILE_COPY_BUFFER_BYTES = 64 * 1024;
const OBJECT_READ_STREAM_BUFFER_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeNamespace(value = "default") {
  return String(value || "default")
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96) || "default";
}

function safeFileName(value = "object.bin") {
  const baseName = path.posix.basename(String(value || "object.bin").replace(/\\/g, "/"));
  return baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180) || "object.bin";
}

function normalizeRelativePath(value = "") {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe storage object relative path: ${value}`);
  }
  return normalized;
}

function pathWithinRoot(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExpectedSha256(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized && !/^[a-f0-9]{64}$/u.test(normalized)) {
    const error = new Error("Expected storage object digest must be a SHA-256 hex value.");
    error.code = "storage_object_expected_digest_invalid";
    throw error;
  }
  return normalized;
}

function normalizeExpectedByteSize(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    const error = new Error("Expected storage object byte size must be a non-negative safe integer.");
    error.code = "storage_object_expected_size_invalid";
    throw error;
  }
  return normalized;
}

function storageObjectTarget({ userDataPath, namespace, fileName, objectId, sha256 }) {
  const safeNamespace = normalizeNamespace(namespace);
  const safeName = safeFileName(fileName);
  const objectIdentityHash = createHash("sha256")
    .update(String(objectId || ""), "utf8")
    .digest("hex")
    .slice(0, 32);
  const objectDirectory = resolveWithin(userDataPath, "objects", safeNamespace, sha256.slice(0, 2));
  const storageFileName = `${sha256.slice(0, 16)}__${objectIdentityHash}__${safeName}`;
  const targetPath = resolveWithin(objectDirectory, storageFileName);
  return {
    safeNamespace,
    safeName,
    objectDirectory,
    targetPath
  };
}

function isUnsupportedDirectorySyncError(error) {
  return process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code);
}

async function ensurePrivateObjectDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw objectIntegrityError(
      "storage_object_directory_unsafe",
      "A storage object directory is not a private regular directory."
    );
  }
  try {
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  }
}

async function hardenPrivateObjectFile(filePath) {
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  }
}

async function syncDirectory(directoryPath) {
  let handle = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function objectIntegrityError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function objectFileSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => String(value))
    .join(":");
}

async function inspectStoredObjectFile(filePath) {
  const flags = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fs.open(filePath, flags);
  } catch (error) {
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
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw objectIntegrityError("storage_object_file_unsafe", "The stored object file is not a regular file.");
    }
    const digest = createHash("sha256");
    const readBuffer = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES);
    let byteSize = 0;
    while (true) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) break;
      digest.update(readBuffer.subarray(0, bytesRead));
      byteSize += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
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
    await handle.close().catch(() => {});
  }
}

async function commitTemporaryObject({
  temporaryPath,
  targetPath,
  objectDirectory,
  byteSize,
  sha256
}) {
  await ensurePrivateObjectDirectory(objectDirectory);
  try {
    const existing = await inspectStoredObjectFile(targetPath);
    if (existing.byteSize !== byteSize || existing.sha256 !== sha256) {
      throw objectIntegrityError(
        "storage_object_integrity_mismatch",
        "An existing stored object does not match the content being persisted."
      );
    }
    await fs.rm(temporaryPath, { force: true });
    await syncDirectory(path.dirname(temporaryPath));
    return;
  } catch (error) {
    if (error?.code !== "storage_object_missing") throw error;
  }
  await fs.rename(temporaryPath, targetPath);
  await hardenPrivateObjectFile(targetPath);
  await syncDirectory(objectDirectory);
  await syncDirectory(path.dirname(temporaryPath));
}

async function createPendingObjectFile({ userDataPath, objectId }) {
  const pendingDirectory = resolveWithin(userDataPath, "objects", ".pending");
  await ensurePrivateObjectDirectory(pendingDirectory);
  const temporaryPath = resolveWithin(
    pendingDirectory,
    `${safeFileName(objectId)}.${randomUUID()}.tmp`
  );
  return { pendingDirectory, temporaryPath };
}

export function getObjectRootPath(userDataPath) {
  return path.join(userDataPath, "objects");
}

export function resolveStoredObjectPath(userDataPath, storageRelativePath) {
  const resolvedPath = resolveWithin(userDataPath, normalizeRelativePath(storageRelativePath));
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
} = {}) {
  const normalizedExpectedSha256 = normalizeExpectedSha256(expectedSha256);
  const normalizedExpectedByteSize = normalizeExpectedByteSize(expectedByteSize);
  const resolvedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  const integrity = await inspectStoredObjectFile(resolvedPath);
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
} = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resolvedObjectId = String(objectId || randomUUID());
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
  let targetHandle = null;
  let committed = false;
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
    await targetHandle?.close().catch(() => {});
    if (!committed) await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }

  const storageRelativePath = path.relative(userDataPath, targetPath).split(path.sep).join("/");
  const timestamp = nowIso();
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
} = {}) {
  const resolvedObjectId = String(objectId || randomUUID());
  const normalizedExpectedSha256 = normalizeExpectedSha256(expectedSha256);
  const normalizedExpectedByteSize = normalizeExpectedByteSize(expectedByteSize);
  const { temporaryPath } = await createPendingObjectFile({
    userDataPath,
    objectId: resolvedObjectId
  });
  const sourceHandle = await fs.open(path.resolve(String(sourcePath || "")), "r");
  let targetHandle = null;
  let committed = false;
  try {
    targetHandle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    const digest = createHash("sha256");
    const copyBuffer = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES);
    let byteSize = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(copyBuffer, 0, copyBuffer.length, null);
      if (bytesRead === 0) break;
      digest.update(copyBuffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(copyBuffer, written, bytesRead - written, null);
        if (result.bytesWritten <= 0) {
          const error = new Error("Storage object copy made no forward progress.");
          error.code = "storage_object_copy_stalled";
          throw error;
        }
        written += result.bytesWritten;
      }
      byteSize += bytesRead;
    }
    const sha256 = digest.digest("hex");
    if (normalizedExpectedSha256 && sha256 !== normalizedExpectedSha256) {
      const error = new Error("Staged storage object digest changed before persistence.");
      error.code = "storage_object_digest_mismatch";
      throw error;
    }
    if (normalizedExpectedByteSize !== null && byteSize !== normalizedExpectedByteSize) {
      const error = new Error("Staged storage object size changed before persistence.");
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
    const timestamp = nowIso();
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
    await sourceHandle.close().catch(() => {});
    await targetHandle?.close?.().catch(() => {});
    if (!committed) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

export function recordStoredObject(db, object = {}) {
  if (!db || !object?.objectId || !object?.storageRelativePath) {
    return null;
  }
  const timestamp = object.updatedAt || object.createdAt || nowIso();
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
  const metadata = object.metadata && typeof object.metadata === "object"
    ? object.metadata
    : {};
  const owner = {
    jobId: String(metadata.jobId || "").trim(),
    archiveBatchId: String(metadata.archiveBatchId || "").trim(),
    ownerSubjectId: String(metadata.ownerSubjectId || "").trim(),
    ownerUserId: String(metadata.ownerUserId || "").trim(),
    ownerUsername: String(metadata.ownerUsername || "").trim()
  };
  if (Object.values(owner).some(Boolean)) {
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

export async function readStoredObject({ userDataPath, storageRelativePath } = {}) {
  const resolvedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  return fs.readFile(resolvedPath);
}

export async function openStoredObjectReadStream({
  userDataPath,
  storageRelativePath,
  signal
} = {}) {
  const resolvedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  const handle = await fs.open(resolvedPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const error = new Error("Storage object is not a regular file.");
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
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function statStoredObject({ userDataPath, storageRelativePath } = {}) {
  const resolvedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  return fs.stat(resolvedPath);
}

export async function removeStoredObject({ userDataPath, storageRelativePath } = {}) {
  const resolvedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  await fs.rm(resolvedPath, { force: true });
}
