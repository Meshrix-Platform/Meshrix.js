import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { checkpointTreeId as buildCheckpointTreeId } from "#lico/foundation/checkpoint/tree/checkpoint-tree-projection";
import {
  ensurePrivateDir,
  writePrivateFileAtomic
} from "@lico/foundation/storage/private-file-atomic";
import { assertServerToken, resolveWithin } from "#lico/client-strings";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.mjs";

export const SESSION_SCHEMA_VERSION = "v0.0.1:storage:checkpoint-upload-session-schema-1";
export const EMPTY_FILE_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export function nowIso() {
  return new Date().toISOString();
}

export async function emitTrace(trace, event = {}) {
  if (typeof trace !== "function") {
    return;
  }
  await trace({
    layer: "store",
    ...event
  });
}

export function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

export function validateRelativePath(value) {
  const normalized = normalizeRelativePath(value);
  if (!normalized) {
    throw new Error("上传文件缺少相对路径。");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("上传路径不安全，已拒绝。");
  }

  return normalized;
}

export function normalizeSha256(value, fieldName) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} 必须是 sha256 hex。`);
  }
  return normalized;
}

export function normalizeOptionalSha256(value, fieldName) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalizeSha256(normalized, fieldName);
}

export function normalizeByteSize(value) {
  const byteSize = Number(value || 0);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("上传文件大小无效。");
  }
  return byteSize;
}

export function normalizeFileIndex(value) {
  const fileIndex = Number(value);
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    throw new Error("上传文件索引无效。");
  }
  return fileIndex;
}

export function originalFileNameForUpload(file, index) {
  return path.posix.basename(
    normalizeRelativePath(file?.relativePath || file?.name || `upload-${index + 1}`)
  );
}

export async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function withSessionRoot(userDataPath, ...parts) {
  return resolveWithin(path.join(userDataPath, "upload-sessions"), ...parts);
}

export function getSessionMetaPath(userDataPath, sessionId) {
  assertServerToken(sessionId, "upload_session");
  return withSessionRoot(userDataPath, sessionId, "meta.json");
}

export function getSessionFilePath(userDataPath, sessionId, fileIndex) {
  assertServerToken(sessionId, "upload_session");
  return withSessionRoot(userDataPath, sessionId, "files", `${normalizeFileIndex(fileIndex)}.part`);
}

export function ensurePrivateUploadSessionDirectories(userDataPath, sessionId) {
  assertServerToken(sessionId, "upload_session");
  const uploadSessionsPath = withSessionRoot(userDataPath);
  const sessionPath = withSessionRoot(userDataPath, sessionId);
  const filesPath = withSessionRoot(userDataPath, sessionId, "files");
  ensurePrivateDir(uploadSessionsPath);
  ensurePrivateDir(sessionPath);
  ensurePrivateDir(filesPath);
  return { uploadSessionsPath, sessionPath, filesPath };
}

async function syncPrivateFile(filePath, flags, mutation) {
  const handle = await fsp.open(filePath, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await mutation(handle);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let directoryHandle = null;
  try {
    directoryHandle = await fsp.open(path.dirname(filePath), "r");
    await directoryHandle.sync();
  } catch (error) {
    const unsupportedOnWindows =
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
    if (!unsupportedOnWindows) {
      throw error;
    }
  } finally {
    await directoryHandle?.close();
  }
}

export async function createVerifiedEmptySessionFile(userDataPath, sessionId, fileIndex, expectedSha256) {
  ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
  const filePath = getSessionFilePath(userDataPath, sessionId, fileIndex);
  await syncPrivateFile(filePath, "w", async () => undefined);
  const actualSha256 = await hashFileSha256(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`零字节上传文件 sha256 校验失败：${fileIndex}`);
  }
  return filePath;
}

export async function appendPrivateSessionFile(userDataPath, sessionId, fileIndex, buffer) {
  ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
  const filePath = getSessionFilePath(userDataPath, sessionId, fileIndex);
  await syncPrivateFile(filePath, "a", async (handle) => {
    let writtenBytes = 0;
    while (writtenBytes < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        writtenBytes,
        buffer.length - writtenBytes
      );
      if (bytesWritten <= 0) {
        throw new Error("上传分块写入未取得进展。");
      }
      writtenBytes += bytesWritten;
    }
  });
  return filePath;
}

export async function truncatePrivateSessionFile(userDataPath, sessionId, fileIndex, byteSize = 0) {
  ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
  const filePath = getSessionFilePath(userDataPath, sessionId, fileIndex);
  await syncPrivateFile(filePath, "r+", async (handle) => {
    await handle.truncate(byteSize);
  });
  return filePath;
}

export async function saveSessionMeta(userDataPath, meta) {
  const metaPath = getSessionMetaPath(userDataPath, meta.sessionId);
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);
  await writePrivateFileAtomic(metaPath, JSON.stringify(meta, null, 2));
}

export async function loadSessionMeta(userDataPath, sessionId) {
  assertServerToken(sessionId, "upload_session");
  const metaPath = getSessionMetaPath(userDataPath, sessionId);
  try {
    const raw = await fsp.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
    await fsp.chmod(metaPath, 0o600);
    return reconcileSessionMeta(userDataPath, meta);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function resolveUploadSessionStatus(meta) {
  return meta.files.length === 0 || meta.files.every(
    (file) =>
      Number(file.receivedBytes || 0) === Number(file.byteSize || 0) &&
      Boolean(file.completedAt) &&
      file.verifiedSha256 === file.sha256
  )
    ? "complete"
    : "uploading";
}

export async function reconcileSessionMeta(userDataPath, meta) {
  let changed = false;
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);

  for (const file of meta.files || []) {
    const filePath = getSessionFilePath(userDataPath, meta.sessionId, file.index);
    let actualSize = 0;
    let fileExists = false;

    try {
      const stats = await fsp.stat(filePath);
      actualSize = Math.max(0, Number(stats.size || 0));
      fileExists = true;
      await fsp.chmod(filePath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (!fileExists && Number(file.byteSize || 0) === 0) {
      await createVerifiedEmptySessionFile(userDataPath, meta.sessionId, file.index, file.sha256);
      fileExists = true;
      changed = true;
    }

    if (actualSize > Number(file.byteSize || 0)) {
      await truncatePrivateSessionFile(
        userDataPath,
        meta.sessionId,
        file.index,
        Number(file.byteSize || 0)
      );
      actualSize = Number(file.byteSize || 0);
      changed = true;
    }

    if (Number(file.receivedBytes || 0) !== actualSize) {
      file.receivedBytes = actualSize;
      changed = true;
    }

    if (fileExists && actualSize === Number(file.byteSize || 0)) {
      const sha256 = await hashFileSha256(filePath);
      if (sha256 === file.sha256) {
        if (!file.completedAt) {
          file.completedAt = nowIso();
          changed = true;
        }
        if (file.verifiedSha256 !== sha256) {
          file.verifiedSha256 = sha256;
          changed = true;
        }
      } else {
        if (Number(file.byteSize || 0) === 0) {
          throw new Error(`零字节上传文件 sha256 校验失败：${file.index}`);
        }
        await truncatePrivateSessionFile(userDataPath, meta.sessionId, file.index, 0);
        file.receivedBytes = 0;
        file.completedAt = "";
        file.verifiedSha256 = "";
        changed = true;
      }
    } else if (file.completedAt || file.verifiedSha256) {
      file.completedAt = "";
      file.verifiedSha256 = "";
      changed = true;
    }
  }

  const nextStatus = resolveUploadSessionStatus(meta);
  if (meta.status !== nextStatus) {
    meta.status = nextStatus;
    changed = true;
  }

  if (changed) {
    meta.updatedAt = nowIso();
    await saveSessionMeta(userDataPath, meta);
  }

  return meta;
}

export function buildPublicSession(meta) {
  const archiveBatch = resolveArchiveBatchIdentity({
    archiveBatchId: meta.archiveBatchId,
    checkpointId: meta.checkpointId,
    manifestDigest: meta.manifestDigest,
    inputDigest: meta.inputDigest
  });
  return {
    sessionId: meta.sessionId,
    checkpointId: meta.checkpointId,
    archiveBatchId: archiveBatch.archiveBatchId,
    clientUid: meta.clientUid || "",
    sourceType: meta.sourceType || "",
    checkpointTreeId: meta.checkpointTreeId || buildCheckpointTreeId("upload-session", meta.sessionId),
    manifestDigest: meta.manifestDigest,
    inputDigest: meta.inputDigest,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    files: (meta.files || []).map((file) => ({
      index: file.index,
      name: file.name,
      relativePath: file.relativePath,
      originalFileName: file.originalFileName || "",
      clientUid: file.clientUid || meta.clientUid || "",
      sourceType: file.sourceType || meta.sourceType || "",
      providerId: file.providerId || meta.providerId || "",
      externalId: file.externalId || meta.externalId || "",
      syncBatchId: file.syncBatchId || meta.syncBatchId || "",
      contentHash: file.contentHash || meta.contentHash || "",
      capturedAt: file.capturedAt || meta.capturedAt || "",
      mediaType: file.mediaType,
      sha256: file.sha256,
      byteSize: file.byteSize,
      receivedBytes: file.receivedBytes || 0,
      completed: Boolean(file.completedAt),
      completedAt: file.completedAt || ""
    }))
  };
}
