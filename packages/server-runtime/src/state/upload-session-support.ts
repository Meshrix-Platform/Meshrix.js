import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { checkpointTreeId as buildCheckpointTreeId } from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import { ensurePrivateDir, writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import { assertServerToken, resolveWithin } from "#meshrix/client-strings";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.ts";

export const SESSION_SCHEMA_VERSION = "v0.0.1:storage:opaque-upload-session-schema-2";
export const EMPTY_FILE_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
type UnknownRecord = Record<string, unknown>;
export interface UploadSessionFile extends UnknownRecord {
  index: number; name: string; relativePath: string; sha256: string; byteSize: number;
  receivedBytes: number; completedAt: string; verifiedSha256: string; custodyRef: string;
}
export interface UploadSessionMeta extends UnknownRecord {
  schemaVersion: string; sessionId: string; checkpointId: string; archiveBatchId: string;
  manifestDigest: string; inputDigest: string; status: "complete" | "uploading"; createdAt: string; updatedAt: string;
  files: UploadSessionFile[];
  ownerSubjectId?: string; ownerUserId?: string; ownerUsername?: string; ownerRoleId?: string;
  ownerTenantId?: string; ownerOrganizationNodeId?: string; ownerKey?: string;
  clientUid?: string; sourceType?: string; providerId?: string; externalId?: string;
  syncBatchId?: string; contentHash?: string; capturedAt?: string; checkpointTreeId?: string;
}
export type TraceEmitter = (event: UnknownRecord) => void | Promise<void>;
export type CustodyDescribe = (input: { custodyRef: string; owner: UnknownRecord }) => Promise<UnknownRecord>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}
function errorCode(error: unknown): string { return record(error)?.code as string || ""; }
function codedError(message: string, code: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  return Object.assign(new Error(message), { code, ...(statusCode === undefined ? {} : { statusCode }) });
}
function sessionFile(value: unknown): UploadSessionFile | null {
  const file = record(value);
  if (!file || typeof file.index !== "number" || typeof file.name !== "string" || typeof file.relativePath !== "string" ||
      typeof file.sha256 !== "string" || typeof file.byteSize !== "number") return null;
  return {
    ...file, index: file.index, name: file.name, relativePath: file.relativePath, sha256: file.sha256,
    byteSize: file.byteSize, receivedBytes: Number(file.receivedBytes || 0), completedAt: String(file.completedAt || ""),
    verifiedSha256: String(file.verifiedSha256 || ""), custodyRef: String(file.custodyRef || "")
  };
}
function sessionMeta(value: unknown): UploadSessionMeta | null {
  const meta = record(value);
  if (!meta || meta.schemaVersion !== SESSION_SCHEMA_VERSION || typeof meta.sessionId !== "string" || !Array.isArray(meta.files)) return null;
  const files = meta.files.map(sessionFile);
  if (files.some((file) => file === null)) return null;
  return {
    ...meta, schemaVersion: SESSION_SCHEMA_VERSION, sessionId: meta.sessionId,
    checkpointId: String(meta.checkpointId || ""), archiveBatchId: String(meta.archiveBatchId || ""),
    manifestDigest: String(meta.manifestDigest || ""), inputDigest: String(meta.inputDigest || ""),
    status: meta.status === "complete" ? "complete" : "uploading", createdAt: String(meta.createdAt || ""), updatedAt: String(meta.updatedAt || ""),
    files: files as UploadSessionFile[]
  };
}

export function nowIso(): string { return new Date().toISOString(); }
export async function emitTrace(trace: unknown, event: UnknownRecord = {}): Promise<void> {
  if (typeof trace === "function") await (trace as TraceEmitter)({ layer: "store", ...event });
}
export function uploadSessionInputError(code: string, message: string): Error & { code: string; statusCode?: number } {
  return codedError(message, code, 400);
}
export function normalizeRelativePath(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}
export function validateRelativePath(value: unknown): string {
  const normalized = normalizeRelativePath(value);
  if (!normalized) throw uploadSessionInputError("upload_path_required", "上传文件缺少相对路径。");
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw uploadSessionInputError("upload_path_unsafe", "上传路径不安全，已拒绝。");
  }
  return normalized;
}
export function normalizeSha256(value: unknown, fieldName: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw uploadSessionInputError("upload_sha256_invalid", `${String(fieldName)} 必须是 sha256 hex。`);
  return normalized;
}
export function normalizeOptionalSha256(value: unknown, fieldName: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized ? normalizeSha256(normalized, fieldName) : "";
}
export function normalizeByteSize(value: unknown): number {
  const byteSize = Number(value || 0);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw uploadSessionInputError("upload_byte_size_invalid", "上传文件大小无效。");
  return byteSize;
}
export function normalizeFileIndex(value: unknown): number {
  const fileIndex = Number(value);
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) throw uploadSessionInputError("upload_file_index_invalid", "上传文件索引无效。");
  return fileIndex;
}
export function originalFileNameForUpload(fileValue: unknown, index: number): string {
  const file = record(fileValue) || {};
  return path.posix.basename(normalizeRelativePath(file.relativePath || file.name || `upload-${index + 1}`));
}
export function withSessionRoot(userDataPath: string, ...parts: string[]): string {
  return resolveWithin(path.join(userDataPath, "upload-sessions"), ...parts);
}
export function getSessionMetaPath(userDataPath: string, sessionId: string): string {
  assertServerToken(sessionId, "upload_session");
  return withSessionRoot(userDataPath, sessionId, "meta.json");
}
export function ensurePrivateUploadSessionDirectories(userDataPath: string, sessionId: string): { uploadSessionsPath: string; sessionPath: string } {
  assertServerToken(sessionId, "upload_session");
  const uploadSessionsPath = withSessionRoot(userDataPath);
  const sessionPath = withSessionRoot(userDataPath, sessionId);
  ensurePrivateDir(uploadSessionsPath);
  ensurePrivateDir(sessionPath);
  return { uploadSessionsPath, sessionPath };
}
export async function saveSessionMeta(userDataPath: string, meta: UploadSessionMeta): Promise<void> {
  const metaPath = getSessionMetaPath(userDataPath, meta.sessionId);
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);
  await writePrivateFileAtomic(metaPath, JSON.stringify(meta, null, 2));
}
export async function loadSessionMeta(userDataPath: string, sessionId: string): Promise<UploadSessionMeta | null> {
  assertServerToken(sessionId, "upload_session");
  const metaPath = getSessionMetaPath(userDataPath, sessionId);
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    const meta = sessionMeta(parsed);
    if (!meta) throw codedError("Upload session state uses a retired plaintext schema.", "upload_session_plaintext_state_unsupported");
    ensurePrivateUploadSessionDirectories(userDataPath, sessionId);
    await fsp.chmod(metaPath, 0o600);
    return meta;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
export function resolveUploadSessionStatus(meta: UploadSessionMeta): "complete" | "uploading" {
  return meta.files.length === 0 || meta.files.every((file) =>
    Number(file.receivedBytes || 0) === Number(file.byteSize || 0) && Boolean(file.completedAt) && file.verifiedSha256 === file.sha256
  ) ? "complete" : "uploading";
}
export async function reconcileSessionMeta(userDataPath: string, meta: UploadSessionMeta, options: { custodyDescribe?: CustodyDescribe } = {}): Promise<UploadSessionMeta> {
  const custodyDescribe = options.custodyDescribe;
  if (typeof custodyDescribe !== "function") throw new TypeError("Upload session reconciliation requires a custody describe port.");
  let changed = false;
  ensurePrivateUploadSessionDirectories(userDataPath, meta.sessionId);
  const owner: UnknownRecord = { subjectId: meta.ownerSubjectId, userId: meta.ownerUserId, username: meta.ownerUsername, tenantId: meta.ownerTenantId };
  for (const file of meta.files) {
    if (!file.custodyRef) throw codedError("Upload session contains unsupported plaintext staging state.", "upload_session_plaintext_state_unsupported");
    const description = await custodyDescribe({ custodyRef: file.custodyRef, owner });
    const receivedBytes = Number(description.nextOffset);
    const expectedByteSize = Number(file.byteSize);
    const sealed = description.state === "sealed_no_run";
    const staging = description.state === "staging_no_run";
    const sealedStateInvalid = sealed && (
      receivedBytes !== expectedByteSize ||
      Number(description.byteCount) !== expectedByteSize ||
      description.contentDigest !== file.sha256 ||
      !/^[a-f0-9]{64}$/u.test(String(description.envelopeDigest || ""))
    );
    if (description.custodyRef !== file.custodyRef || (!sealed && !staging) || !Number.isSafeInteger(receivedBytes) || receivedBytes < 0 ||
        !Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0 || receivedBytes > expectedByteSize ||
        sealedStateInvalid) {
      throw codedError("Upload session custody state is invalid.", "upload_session_custody_state_invalid");
    }
    const next: UnknownRecord = {
      receivedBytes, completedAt: sealed ? (file.completedAt || nowIso()) : "",
      verifiedSha256: sealed ? description.contentDigest : "", contentDigest: sealed ? description.contentDigest : "",
      envelopeDigest: sealed ? description.envelopeDigest : "", custodyState: description.state
    };
    for (const [key, value] of Object.entries(next)) {
      if (file[key] !== value) { file[key] = value; changed = true; }
    }
  }
  const nextStatus = resolveUploadSessionStatus(meta);
  if (meta.status !== nextStatus) { meta.status = nextStatus; changed = true; }
  if (changed) { meta.updatedAt = nowIso(); await saveSessionMeta(userDataPath, meta); }
  return meta;
}
export function buildPublicSession(meta: UploadSessionMeta): UnknownRecord {
  const archiveBatch = resolveArchiveBatchIdentity({
    archiveBatchId: meta.archiveBatchId, checkpointId: meta.checkpointId,
    manifestDigest: meta.manifestDigest, inputDigest: meta.inputDigest
  });
  return {
    sessionId: meta.sessionId, checkpointId: meta.checkpointId, archiveBatchId: archiveBatch.archiveBatchId,
    clientUid: meta.clientUid || "", sourceType: meta.sourceType || "",
    checkpointTreeId: meta.checkpointTreeId || buildCheckpointTreeId("upload-session", meta.sessionId),
    manifestDigest: meta.manifestDigest, inputDigest: meta.inputDigest, status: meta.status,
    createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    files: meta.files.map((file) => ({
      index: file.index, name: file.name, relativePath: file.relativePath, originalFileName: file.originalFileName || "",
      clientUid: file.clientUid || meta.clientUid || "", sourceType: file.sourceType || meta.sourceType || "",
      providerId: file.providerId || meta.providerId || "", externalId: file.externalId || meta.externalId || "",
      syncBatchId: file.syncBatchId || meta.syncBatchId || "", contentHash: file.contentHash || meta.contentHash || "",
      capturedAt: file.capturedAt || meta.capturedAt || "", mediaType: file.mediaType, sha256: file.sha256,
      byteSize: file.byteSize, receivedBytes: file.receivedBytes || 0, completed: Boolean(file.completedAt),
      completedAt: file.completedAt || "", custodyRef: file.custodyRef || "", custodyState: file.custodyState || "",
      contentDigest: file.contentDigest || "", envelopeDigest: file.envelopeDigest || ""
    }))
  };
}
