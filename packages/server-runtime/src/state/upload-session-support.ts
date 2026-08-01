import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { checkpointTreeId as buildCheckpointTreeId } from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import {
  ensurePrivateDir,
  writePrivateFileAtomic
} from "@meshrix/foundation/storage/private-file-atomic";
import { assertServerToken, resolveWithin } from "#meshrix/client-strings";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.ts";

export const SESSION_SCHEMA_VERSION: any = "v0.0.1:storage:opaque-upload-session-schema-2";
export const EMPTY_FILE_SHA256: any = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export function nowIso() : any {
  return new Date().toISOString();
}

export async function emitTrace(trace?: any, event: Record<string, any> = {}) : Promise<any> {
  if (typeof trace !== "function") {
    return;
  }
  await trace({
    layer: "store",
    ...event
  });
}

export function normalizeRelativePath(value?: any) : any {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

export function validateRelativePath(value?: any) : any {
  const normalized: any = normalizeRelativePath(value);
  if (!normalized) {
    throw new Error("上传文件缺少相对路径。");
  }

  const segments: any = normalized.split("/");
  if (segments.some((segment?: any) : any => !segment || segment === "." || segment === "..")) {
    throw new Error("上传路径不安全，已拒绝。");
  }

  return normalized;
}

export function normalizeSha256(value?: any, fieldName?: any) : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} 必须是 sha256 hex。`);
  }
  return normalized;
}

export function normalizeOptionalSha256(value?: any, fieldName?: any) : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalizeSha256(normalized, fieldName);
}

export function normalizeByteSize(value?: any) : any {
  const byteSize: any = Number(value || 0);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("上传文件大小无效。");
  }
  return byteSize;
}

export function normalizeFileIndex(value?: any) : any {
  const fileIndex: any = Number(value);
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    throw new Error("上传文件索引无效。");
  }
  return fileIndex;
}

export function originalFileNameForUpload(file?: any, index?: any) : any {
  return path.posix.basename(
    normalizeRelativePath(file?.relativePath || file?.name || `upload-${index + 1}`)
  );
}

export function withSessionRoot(userDataPath: any, ...parts: any[]) : any {
  return resolveWithin(path.join(userDataPath, "upload-sessions"), ...parts);
}

export function getSessionMetaPath(userDataPath?: any, sessionId?: any) : any {
  assertServerToken(sessionId, "upload_session");
  return withSessionRoot(userDataPath, sessionId, "meta.json");
}

export function ensurePrivateUploadSessionDirectories(userDataPath?: any, sessionId?: any) : any {
  assertServerToken(sessionId, "upload_session");
  const uploadSessionsPath: any = withSessionRoot(userDataPath);
  const sessionPath: any = withSessionRoot(userDataPath, sessionId);
  ensurePrivateDir(uploadSessionsPath);
  ensurePrivateDir(sessionPath);
  return { uploadSessionsPath, sessionPath };
}

export async function saveSessionMeta(userDataPath?: any, meta?: any) : Promise<any> {
  const metaPath: any = getSessionMetaPath(userDataPath, meta.sessionId);
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);
  await writePrivateFileAtomic(metaPath, JSON.stringify(meta, null, 2));
}

export async function loadSessionMeta(userDataPath?: any, sessionId?: any) : Promise<any> {
  assertServerToken(sessionId, "upload_session");
  const metaPath: any = getSessionMetaPath(userDataPath, sessionId);
  try {
    const raw: any = await fsp.readFile(metaPath, "utf8");
    const meta: any = JSON.parse(raw);
    if (meta?.schemaVersion !== SESSION_SCHEMA_VERSION) {
      const error: Error & Record<string, any> = new Error("Upload session state uses a retired plaintext schema.");
      error.code = "upload_session_plaintext_state_unsupported";
      throw error;
    }
    ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
    await fsp.chmod(metaPath, 0o600);
    return meta;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function resolveUploadSessionStatus(meta?: any) : any {
  return meta.files.length === 0 || meta.files.every(
    (file?: any) : any =>
      Number(file.receivedBytes || 0) === Number(file.byteSize || 0) &&
      Boolean(file.completedAt) &&
      file.verifiedSha256 === file.sha256
  )
    ? "complete"
    : "uploading";
}

export async function reconcileSessionMeta(userDataPath?: any, meta?: any, { custodyDescribe }: Record<string, any> = {}) : Promise<any> {
  if (typeof custodyDescribe !== "function") {
    throw new TypeError("Upload session reconciliation requires a custody describe port.");
  }
  if (!Array.isArray(meta?.files)) {
    const error: Error & Record<string, any> = new Error("Upload session metadata is invalid.");
    error.code = "upload_session_custody_state_invalid";
    throw error;
  }
  let changed: any = false;
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);
  const owner: Record<string, any> = {
    subjectId: meta.ownerSubjectId,
    userId: meta.ownerUserId,
    username: meta.ownerUsername,
    tenantId: meta.ownerTenantId
  };

  for (const file of meta.files || []) {
    if (!file.custodyRef) {
      const error: Error & Record<string, any> = new Error("Upload session contains unsupported plaintext staging state.");
      error.code = "upload_session_plaintext_state_unsupported";
      throw error;
    }
    const description: any = await custodyDescribe({
      custodyRef: file.custodyRef,
      owner
    });
    const receivedBytes: any = Number(description?.nextOffset);
    const expectedByteSize: any = Number(file.byteSize);
    const sealed: any = description?.state === "sealed_no_run";
    const staging: any = description?.state === "staging_no_run";
    if (
      description?.custodyRef !== file.custodyRef ||
      (!sealed && !staging) ||
      !Number.isSafeInteger(receivedBytes) ||
      receivedBytes < 0 ||
      !Number.isSafeInteger(expectedByteSize) ||
      expectedByteSize < 0 ||
      receivedBytes > expectedByteSize ||
      (sealed && (
        receivedBytes !== expectedByteSize ||
        Number(description.byteCount) !== expectedByteSize ||
        description.contentDigest !== file.sha256 ||
        !/^[a-f0-9]{64}$/u.test(String(description.envelopeDigest || ""))
      ))
    ) {
      const error: Error & Record<string, any> = new Error("Upload session custody state is invalid.");
      error.code = "upload_session_custody_state_invalid";
      throw error;
    }
    const next: Record<string, any> = {
      receivedBytes,
      completedAt: sealed ? (file.completedAt || nowIso()) : "",
      verifiedSha256: sealed ? description.contentDigest : "",
      contentDigest: sealed ? description.contentDigest : "",
      envelopeDigest: sealed ? description.envelopeDigest : "",
      custodyState: description.state
    };
    for (const [key, value] of (Object.entries(next) as [string, any][])) {
      if (file[key] !== value) {
        file[key] = value;
        changed = true;
      }
    }
  }

  const nextStatus: any = resolveUploadSessionStatus(meta);
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

export function buildPublicSession(meta?: any) : any {
  const archiveBatch: any = resolveArchiveBatchIdentity({
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
    files: (meta.files || []).map((file?: any) : any => ({
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
      completedAt: file.completedAt || "",
      custodyRef: file.custodyRef || "",
      custodyState: file.custodyState || "",
      contentDigest: file.contentDigest || "",
      envelopeDigest: file.envelopeDigest || ""
    }))
  };
}
