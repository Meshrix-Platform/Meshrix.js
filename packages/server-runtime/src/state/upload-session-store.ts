import fsp from "node:fs/promises";
import path from "node:path";
import {
  checkpointTreeId as buildCheckpointTreeId,
  deleteCheckpointTree,
  finishCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import {
  assertServerToken,
  hashClientString,
  serverToken
} from "#meshrix/client-strings";
import { queueStateMutation } from "#meshrix/state-coordinator";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.ts";
import {
  UPLOAD_SESSION_MAX_CHUNK_BYTES,
  deleteUploadSessionAdmission,
  listExpiredUploadSessionAdmissions,
  readUploadSessionAdmission,
  reserveUploadSessionAdmission,
  updateUploadSessionAdmissionStatus,
  uploadAdmissionError,
  validateUploadSessionDeclaration
} from "./upload-session-admission.ts";
import {
  assertUploadSessionOwnerAccess,
  normalizeUploadSessionOwner,
  uploadSessionAccessError,
  uploadSessionOwnerAccess,
  uploadSessionOwnerFields,
  uploadSessionOwnerKey,
  uploadSessionOwnerTrace
} from "./upload-session-owner.ts";
import {
  EMPTY_FILE_SHA256,
  SESSION_SCHEMA_VERSION,
  buildPublicSession,
  emitTrace,
  loadSessionMeta,
  normalizeByteSize,
  normalizeFileIndex,
  normalizeOptionalSha256,
  normalizeSha256,
  nowIso,
  originalFileNameForUpload,
  reconcileSessionMeta,
  resolveUploadSessionStatus,
  saveSessionMeta,
  validateRelativePath,
  withSessionRoot,
  type CustodyDescribe,
  type TraceEmitter,
  type UploadSessionMeta
} from "./upload-session-support.ts";

type UnknownRecord = Record<string, unknown>;
interface UploadFileInput extends UnknownRecord {
  relativePath?: unknown; name?: unknown; sha256?: unknown; byteSize?: unknown;
  clientUid?: unknown; clientId?: unknown; sourceType?: unknown; resourceType?: unknown;
  providerId?: unknown; externalId?: unknown; syncBatchId?: unknown; contentHash?: unknown;
  capturedAt?: unknown; sourceMetadata?: unknown; mediaType?: unknown;
}
interface CustodyResult extends UnknownRecord {
  custodyRef: string; state: string; nextOffset?: number; contentDigest: string; envelopeDigest: string;
}
interface CustodyPort {
  begin(input: UnknownRecord): Promise<CustodyResult>;
  append(input: UnknownRecord): Promise<CustodyResult>;
  seal(input: UnknownRecord): Promise<CustodyResult>;
}
interface FaultInjector { afterCustodyAppendCommitted?(input: UnknownRecord): void | Promise<void> }
interface SessionOptions extends UnknownRecord { owner?: unknown; custodyDescribe?: CustodyDescribe }
interface CreateUploadSessionInput {
  userDataPath: string; custodyPort: CustodyPort; custodyDescribe: CustodyDescribe;
  checkpoint: UnknownRecord; manifest: UnknownRecord; files?: UploadFileInput[]; owner: unknown; trace?: TraceEmitter;
}
interface AppendUploadSessionInput {
  userDataPath: string; custodyPort: CustodyPort; custodyDescribe: CustodyDescribe; sessionId: string;
  fileIndex: unknown; offset: unknown; buffer: unknown; owner: unknown; faultInjector?: FaultInjector | null; trace?: TraceEmitter;
}
interface AppendLockedInput extends Omit<AppendUploadSessionInput, "fileIndex" | "owner" | "custodyPort"> {
  safeFileIndex: number; buffer: Buffer; ownerSubject: ReturnType<typeof normalizeUploadSessionOwner>; custody: CustodyPort;
}
interface UploadSessionStore {
  createOrResumeUploadSession(input?: Omit<CreateUploadSessionInput, "userDataPath" | "custodyPort" | "custodyDescribe">): Promise<UnknownRecord>;
  appendUploadSessionChunk(input?: Omit<AppendUploadSessionInput, "userDataPath" | "custodyPort" | "custodyDescribe">): Promise<UnknownRecord>;
  getUploadSession(sessionId: string, options?: SessionOptions): Promise<unknown>;
  resolveUploadSessionFiles(sessionId: string, options?: SessionOptions): Promise<unknown>;
  buildCheckpointReceiptFromUploadSession(sessionId: string, options?: SessionOptions): Promise<unknown>;
  deleteUploadSession(sessionId: string): Promise<void>;
}
interface StoreOptions { userDataPath?: unknown; custodyPort?: unknown; custodyDescribe?: unknown; faultInjector?: FaultInjector | null }

const uploadSessionStoreBindings: WeakMap<object, string> = new WeakMap();

function uploadSessionStoreBindingError() {
  return Object.assign(
    new TypeError("A composition-bound upload session store is required."),
    { code: "upload_session_store_binding_invalid" }
  );
}

export function assertBoundUploadSessionStore(
  store: unknown,
  { userDataPath }: { userDataPath?: unknown } = {}
): UploadSessionStore {
  const expectedRoot = path.resolve(String(userDataPath || ""));
  if (
    !store ||
    typeof store !== "object" ||
    uploadSessionStoreBindings.get(store) !== expectedRoot ||
    !("resolveUploadSessionFiles" in store) ||
    typeof store.resolveUploadSessionFiles !== "function"
  ) {
    throw uploadSessionStoreBindingError();
  }
  return store as UploadSessionStore;
}

function requireCustodyPort(custodyPort: unknown): CustodyPort {
  const candidate = custodyPort as Partial<CustodyPort> | null;
  const required: Array<keyof CustodyPort> = ["begin", "append", "seal"];
  if (!candidate || required.some((name) => typeof candidate[name] !== "function")) {
    throw new TypeError("Upload session store requires a bound no-run custody staging port.");
  }
  return candidate as CustodyPort;
}

function requireCustodyDescribe(custodyDescribe: unknown): CustodyDescribe {
  if (typeof custodyDescribe !== "function") {
    throw new TypeError("Upload session store requires a bound custody describe function.");
  }
  return custodyDescribe as CustodyDescribe;
}

function freezeUploadDescriptorValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeUploadDescriptorValue(nested);
  }
  return Object.freeze(value);
}

function syncAdmissionStatus(userDataPath: string, sessionId: string, admission: { status: string } | null, status: "complete" | "uploading") {
  if (admission?.status !== status) {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, status);
  }
}

function withUploadSessionMutation<Result>(sessionId: string, mutation: () => Result | Promise<Result>): Promise<Result> {
  const queueKey = hashClientString(sessionId, "upload.session.mutation");
  return queueStateMutation(`upload-session:${queueKey}`, mutation);
}

function validateUploadSessionFiles(files: UploadFileInput[]) {
  const declaration = validateUploadSessionDeclaration(files);
  for (const [index, file] of files.entries()) {
    validateRelativePath(file.relativePath || file.name || `upload-${index + 1}`);
    const digest = normalizeSha256(file.sha256, `files[${index}].sha256`);
    const byteSize = normalizeByteSize(file.byteSize);
    if (byteSize === 0 && digest !== EMPTY_FILE_SHA256) {
      throw uploadAdmissionError("upload_sha256_zero_byte_mismatch", 400, `files[${index}].sha256 与零字节文件不匹配。`);
    }
  }
  return declaration;
}

async function removeExpiredUploadSessionArtifacts(userDataPath: string, sessionIds: string[]): Promise<void> {
  for (const expiredSessionId of sessionIds) {
    await deleteCheckpointTree({
      userDataPath,
      treeId: buildCheckpointTreeId("upload-session", expiredSessionId)
    }).catch(() => null);
    await fsp.rm(withSessionRoot(userDataPath, expiredSessionId), {
      recursive: true,
      force: true
    });
    deleteUploadSessionAdmission(userDataPath, expiredSessionId);
  }
}

export async function createOrResumeUploadSession({
  userDataPath,
  custodyPort,
  custodyDescribe,
  checkpoint,
  manifest,
  files = [],
  owner,
  trace
}: CreateUploadSessionInput) {
  const custody = requireCustodyPort(custodyPort);
  const describeCustody = requireCustodyDescribe(custodyDescribe);
  const declaration = validateUploadSessionFiles(files);
  await emitTrace(trace, {
    functionName: "createOrResumeUploadSession",
    stage: "start",
    message: "开始创建或恢复上传会话。",
    checkpointPresent: Boolean(checkpoint?.checkpointId),
    manifestPresent: Boolean(manifest?.manifestDigest),
    inputDigestPresent: Boolean(manifest?.inputDigest),
    fileCount: files.length
  });
  const clientCheckpointId =
    typeof checkpoint?.checkpointId === "string" ? checkpoint.checkpointId.trim() : "";
  if (!clientCheckpointId) {
    await emitTrace(trace, {
      functionName: "createOrResumeUploadSession",
      stage: "validation_failed",
      level: "error",
      message: "上传会话缺少客户端 checkpointId。",
      checkpointPresent: false
    });
    throw uploadAdmissionError("upload_checkpoint_id_required", 400, "upload session 缺少 checkpointId。");
  }

  const manifestDigest = normalizeSha256(manifest?.manifestDigest, "manifestDigest");
  const inputDigest = normalizeOptionalSha256(manifest?.inputDigest, "inputDigest");
  const ownerSubject = normalizeUploadSessionOwner(owner);
  const ownerKey = uploadSessionOwnerKey(ownerSubject);
  const checkpointId = serverToken(
    "checkpoint",
    clientCheckpointId,
    manifestDigest,
    inputDigest
  );
  const archiveBatch = resolveArchiveBatchIdentity({
    archiveBatchId: String(checkpoint.archiveBatchId || ""),
    batchId: String(checkpoint.batchId || ""),
    clientBatchId: String(checkpoint.clientBatchId || ""),
    checkpointId: clientCheckpointId,
    manifestDigest,
    inputDigest
  });
  const sessionId = serverToken("upload_session", checkpointId, manifestDigest, inputDigest, ownerKey);
  const clientUid = String(checkpoint?.clientUid || checkpoint?.clientId || manifest?.clientUid || manifest?.clientId || "").trim();
  const sourceType = String(checkpoint?.sourceType || checkpoint?.resourceType || manifest?.sourceType || manifest?.resourceType || "upload").trim();
  const providerId = String(checkpoint?.providerId || manifest?.providerId || "").trim();
  const externalId = String(checkpoint?.externalId || manifest?.externalId || "").trim();
  const syncBatchId = String(checkpoint?.syncBatchId || manifest?.syncBatchId || "").trim();
  const contentHash = String(checkpoint?.contentHash || manifest?.contentHash || "").trim();
  const capturedAt = String(checkpoint?.capturedAt || manifest?.capturedAt || "").trim();
  const checkpointTreeId = buildCheckpointTreeId("upload-session", sessionId);
  let existing = await loadSessionMeta(userDataPath, sessionId);
  if (existing) {
    existing = await reconcileSessionMeta(userDataPath, existing, {
      custodyDescribe: describeCustody
    });
  }
  let admission = null;
  if (existing) {
    admission = readUploadSessionAdmission(userDataPath, sessionId);
    if (!admission) {
      await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
      throw uploadAdmissionError(
        "upload_session_expired",
        410,
        "上传会话已过期。"
      );
    }
    syncAdmissionStatus(userDataPath, sessionId, admission, existing.status);
  } else {
    const admissionNowMs = Date.now();
    await removeExpiredUploadSessionArtifacts(
      userDataPath,
      listExpiredUploadSessionAdmissions(userDataPath, admissionNowMs)
    );
    admission = reserveUploadSessionAdmission({
      userDataPath,
      sessionId,
      ownerScopeKey: ownerKey,
      status: files.length === 0 ? "complete" : "uploading",
      fileCount: declaration.fileCount,
      totalBytes: declaration.totalBytes,
      nowMs: admissionNowMs
    });
    await removeExpiredUploadSessionArtifacts(userDataPath, admission.expiredSessionIds);
    if (admission.existing) {
      throw uploadAdmissionError(
        "upload_session_initializing",
        409,
        "上传会话正在初始化，请稍后重试。"
      );
    }
  }
  if (!existing) {
    try {
      await startCheckpointTree({
    userDataPath,
    treeId: checkpointTreeId,
    kind: "upload_session",
    ownerId: sessionId,
    inputHash: manifestDigest,
    rootNodeId: "upload-session",
    rootLabel: "上传会话",
    metadata: {
      sessionId,
      checkpointId,
      archiveBatchId: archiveBatch.archiveBatchId,
      clientUid,
      sourceType,
      providerId,
      externalId,
      syncBatchId,
      contentHash,
      capturedAt,
      manifestDigest,
      inputDigest,
      fileCount: files.length,
      ...uploadSessionOwnerTrace(ownerSubject)
    },
    resumePolicy: {
      mode: "chunk-offset",
      idempotencyKey: "sessionId+fileIndex+offset+sha256",
      reusableState: "upload-sessions/<sessionId>/files + meta.json"
    },
    resetOnInputHashChange: false
      });
    } catch (error: unknown) {
      deleteUploadSessionAdmission(userDataPath, sessionId);
      throw error;
    }
  }
  await emitTrace(trace, {
    functionName: "createOrResumeUploadSession",
    stage: "ids_derived",
    message: "已派生服务端 checkpoint/session token。",
    checkpointId,
    sessionId,
    manifestDigest,
    inputDigest,
    ...uploadSessionOwnerTrace(ownerSubject),
    sourceCheckpointHash: hashClientString(clientCheckpointId, "checkpoint.source")
  });

  if (existing) {
    const existingOwnerAccess = uploadSessionOwnerAccess(existing, ownerSubject);
    if (!existingOwnerAccess.ok) {
      await emitTrace(trace, {
        functionName: "createOrResumeUploadSession",
        stage: "resume_rejected",
        level: "warning",
        message: "上传会话归属不匹配，拒绝恢复。",
        sessionId,
        checkpointId,
        ...uploadSessionOwnerTrace(ownerSubject)
      });
      throw uploadSessionAccessError(sessionId);
    }
    if (existing.manifestDigest !== manifestDigest || existing.inputDigest !== inputDigest) {
      await emitTrace(trace, {
        functionName: "createOrResumeUploadSession",
        stage: "resume_rejected",
        level: "error",
        message: "同一 checkpoint 的上传会话摘要不一致。",
        sessionId,
        checkpointId,
        manifestDigest,
        inputDigest,
        existingManifestDigest: existing.manifestDigest,
        existingInputDigest: existing.inputDigest
      });
      throw uploadAdmissionError("upload_session_digest_conflict", 409, "同一 checkpoint 的上传会话摘要不一致，拒绝覆盖。");
    }
    const existingArchiveBatchId = existing.archiveBatchId
      ? resolveArchiveBatchIdentity({
          archiveBatchId: existing.archiveBatchId,
          checkpointId: existing.checkpointId,
          manifestDigest: existing.manifestDigest,
          inputDigest: existing.inputDigest
        }).archiveBatchId
      : "";
    if (existingArchiveBatchId && existingArchiveBatchId !== archiveBatch.archiveBatchId) {
      await emitTrace(trace, {
        functionName: "createOrResumeUploadSession",
        stage: "resume_rejected",
        level: "error",
        message: "同一 checkpoint 的归档批次不一致。",
        sessionId,
        checkpointId,
        archiveBatchId: archiveBatch.archiveBatchId,
        existingArchiveBatchId
      });
      throw uploadAdmissionError("upload_session_batch_conflict", 409, "同一 checkpoint 的归档批次不一致，拒绝覆盖。");
    }

    await emitTrace(trace, {
      functionName: "createOrResumeUploadSession",
      stage: "resumed",
      message: "命中已有上传会话，返回服务端权威状态。",
      sessionId,
      checkpointId,
      status: existing.status,
      files: (existing.files || []).map((file) => ({
        index: file.index,
        byteSize: file.byteSize,
        receivedBytes: file.receivedBytes || 0,
        completed: Boolean(file.completedAt)
      }))
    });
    await upsertCheckpointNode({
      userDataPath,
      treeId: existing.checkpointTreeId || checkpointTreeId,
      nodeId: "receive-upload-files",
      parentId: "upload-session",
      label: "接收上传分块",
      status: existing.status === "complete" ? "completed" : "running",
      totals: {
        fileCount: existing.files?.length || 0,
        totalBytes: (existing.files || []).reduce((sum, file) => sum + Number(file.byteSize || 0), 0),
        receivedBytes: (existing.files || []).reduce((sum, file) => sum + Number(file.receivedBytes || 0), 0),
        completedFiles: (existing.files || []).filter((file) => file.completedAt).length
      },
      cursor: {
        status: existing.status || "",
        completedFiles: (existing.files || []).filter((file) => file.completedAt).length
      }
    }).catch(() => null);
    if (existing.status === "complete") {
      await finishCheckpointTree({
        userDataPath,
        treeId: existing.checkpointTreeId || checkpointTreeId,
        status: "completed",
        message: "Upload session already complete."
      }).catch(() => null);
    }
    return buildPublicSession(existing);
  }

  const now = nowIso();
  const meta: UploadSessionMeta = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    checkpointId,
    checkpointTreeId,
    archiveBatchId: archiveBatch.archiveBatchId,
    clientArchiveBatchHash: archiveBatch.clientArchiveBatchHash,
    archiveBatchSource: archiveBatch.archiveBatchSource,
    clientUid,
    sourceType,
    providerId,
    externalId,
    syncBatchId,
    contentHash,
    capturedAt,
    sourceCheckpointHash: hashClientString(clientCheckpointId, "checkpoint.source"),
    parentCheckpointHash: hashClientString(checkpoint?.parentCheckpointId || "", "checkpoint.parent"),
    checkpointModeHash: hashClientString(checkpoint?.mode || "", "checkpoint.mode"),
    manifestDigest,
    inputDigest,
    ...uploadSessionOwnerFields(ownerSubject),
    status: files.length === 0 ? "complete" : "uploading",
    createdAt: now,
    updatedAt: now,
    files: files.map((file, index) => {
      const sourceRelativePath = validateRelativePath(
        file.relativePath || file.name || `upload-${index + 1}`
      );
      const originalFileName = originalFileNameForUpload(file, index);
      const sha256 = normalizeSha256(file.sha256, `files[${index}].sha256`);
      const byteSize = normalizeByteSize(file.byteSize);
      if (byteSize === 0 && sha256 !== EMPTY_FILE_SHA256) {
        throw uploadAdmissionError("upload_sha256_zero_byte_mismatch", 400, `files[${index}].sha256 与零字节文件不匹配。`);
      }
      const sourceRelativePathHash = hashClientString(sourceRelativePath, "upload.relative_path");
      const sourceNameHash = hashClientString(
        file.name || path.posix.basename(sourceRelativePath),
        "upload.name"
      );
      const fileToken = serverToken(
        "upload_file",
        sessionId,
        index,
        sourceRelativePathHash,
        sha256,
        byteSize
      );
      return {
        index,
        name: fileToken,
        relativePath: sourceRelativePath,
        originalFileName,
        clientUid: String(file.clientUid || file.clientId || clientUid || "").trim(),
        sourceType: String(file.sourceType || file.resourceType || sourceType || "upload").trim(),
        providerId: String(file.providerId || providerId || "").trim(),
        externalId: String(file.externalId || externalId || "").trim(),
        syncBatchId: String(file.syncBatchId || syncBatchId || "").trim(),
        contentHash: String(file.contentHash || contentHash || sha256 || "").trim(),
        capturedAt: String(file.capturedAt || capturedAt || "").trim(),
        sourceMetadata:
          file.sourceMetadata && typeof file.sourceMetadata === "object" && !Array.isArray(file.sourceMetadata)
            ? file.sourceMetadata
            : {},
        sourceNameHash,
        sourceRelativePathHash,
        clientMediaTypeHash: hashClientString(file.mediaType || "", "upload.media_type"),
        mediaType: String(file.mediaType || "application/octet-stream").trim() ||
          "application/octet-stream",
        sha256,
        byteSize,
        receivedBytes: 0,
        completedAt: "",
        verifiedSha256: "",
        custodyRef: "",
        custodyState: "",
        contentDigest: "",
        envelopeDigest: ""
      };
    })
  };

  try {
    for (const file of meta.files) {
      const begun = await custody.begin({
        sessionId,
        fileIndex: file.index,
        expectedSha256: file.sha256,
        expectedByteSize: file.byteSize,
        owner: ownerSubject,
        idempotencyKey: `upload-custody:${sessionId}:${file.index}`
      });
      file.custodyRef = begun.custodyRef;
      file.custodyState = begun.state;
      file.receivedBytes = Number(begun.nextOffset || 0);
      if (file.byteSize === 0) {
        const sealed = await custody.seal({
          custodyRef: file.custodyRef,
          owner: ownerSubject
        });
        file.custodyState = sealed.state;
        file.contentDigest = sealed.contentDigest;
        file.envelopeDigest = sealed.envelopeDigest;
        file.verifiedSha256 = sealed.contentDigest;
        file.completedAt = now;
      }
    }
    meta.status = resolveUploadSessionStatus(meta);
    await saveSessionMeta(userDataPath, meta);
    await reconcileSessionMeta(userDataPath, meta, {
      custodyDescribe: describeCustody
    });
    syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  } catch (error: unknown) {
    deleteUploadSessionAdmission(userDataPath, sessionId);
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]).catch(() => null);
    throw error;
  }
  await upsertCheckpointNode({
    userDataPath,
    treeId: checkpointTreeId,
    nodeId: "receive-upload-files",
    parentId: "upload-session",
    label: "接收上传分块",
    status: files.length === 0 ? "skipped" : meta.status === "complete" ? "completed" : "running",
    totals: {
      fileCount: meta.files.length,
      totalBytes: meta.files.reduce((sum, file) => sum + Number(file.byteSize || 0), 0),
      receivedBytes: 0,
      completedFiles: meta.files.filter((file) => file.completedAt).length
    },
    cursor: {
      status: meta.status
    }
  }).catch(() => null);
  if (meta.status === "complete") {
    await finishCheckpointTree({
      userDataPath,
      treeId: checkpointTreeId,
      status: "completed",
      message: "Upload session completed during initialization."
    }).catch(() => null);
  }
  await emitTrace(trace, {
    functionName: "createOrResumeUploadSession",
    stage: "created",
    message: "已创建上传会话元数据。",
    sessionId,
    checkpointId,
    status: meta.status,
    fileCount: meta.files.length,
    files: meta.files.map((file) => ({
      index: file.index,
      name: file.name,
      relativePath: file.relativePath,
      sourceNameHash: file.sourceNameHash,
      sourceRelativePathHash: file.sourceRelativePathHash,
      byteSize: file.byteSize,
      receivedBytes: file.receivedBytes,
      completed: Boolean(file.completedAt)
    }))
  });
  return buildPublicSession(meta);
}

async function getUploadSessionLocked(
  userDataPath: string,
  sessionId: string,
  options: SessionOptions,
  custodyDescribe: CustodyDescribe
) {
  const owner = normalizeUploadSessionOwner(options.owner);
  let meta: UploadSessionMeta | null;
  try {
    meta = await loadSessionMeta(userDataPath, sessionId);
  } catch (error: unknown) {
    if (/token 格式无效/.test(error instanceof Error ? error.message : String(error))) {
      return null;
    }
    throw error;
  }
  if (!meta) {
    return null;
  }
  // Reject cross-tenant, cross-organization, or cross-principal reads before
  // touching encrypted custody state. An unauthorized caller must observe the
  // session as absent and must not be able to trigger reconciliation work.
  if (!uploadSessionOwnerAccess(meta, owner).ok) {
    return null;
  }
  meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    return null;
  }
  syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  return buildPublicSession(meta);
}

export async function getUploadSession(userDataPath: string, sessionId: string, options: SessionOptions = {}) {
  const custodyDescribe = requireCustodyDescribe(options.custodyDescribe);
  return withUploadSessionMutation(sessionId, () =>
    getUploadSessionLocked(userDataPath, sessionId, options, custodyDescribe)
  );
}

export async function appendUploadSessionChunk({
  userDataPath,
  custodyPort,
  custodyDescribe,
  sessionId,
  fileIndex,
  offset,
  buffer,
  owner,
  faultInjector = null,
  trace
}: AppendUploadSessionInput) {
  const custody = requireCustodyPort(custodyPort);
  const describeCustody = requireCustodyDescribe(custodyDescribe);
  const safeFileIndex = normalizeFileIndex(fileIndex);
  if (!Buffer.isBuffer(buffer)) {
    throw uploadAdmissionError("upload_chunk_invalid", 400, "上传分块必须是二进制内容。");
  }
  if (buffer.length > UPLOAD_SESSION_MAX_CHUNK_BYTES) {
    return {
      ok: false,
      code: "chunk_bytes_exceeded",
      session: null
    };
  }
  const ownerSubject = normalizeUploadSessionOwner(owner);
  await emitTrace(trace, {
    functionName: "appendUploadSessionChunk",
    stage: "start",
    message: "开始接收上传分块。",
    sessionId,
    fileIndex: safeFileIndex,
    offset: Number(offset || 0),
    chunkBytes: buffer.length,
    ...uploadSessionOwnerTrace(ownerSubject)
  });
  return withUploadSessionMutation(sessionId, () => appendUploadSessionChunkLocked({
    userDataPath,
    sessionId,
    safeFileIndex,
    offset,
    buffer,
    ownerSubject,
    custody,
    custodyDescribe: describeCustody,
    faultInjector,
    trace
  }));
}

async function appendUploadSessionChunkLocked({
  userDataPath,
  sessionId,
  safeFileIndex,
  offset,
  buffer,
  ownerSubject,
  custody,
  custodyDescribe,
  faultInjector,
  trace
}: AppendLockedInput) {
  let meta: UploadSessionMeta | null;
  try {
    meta = await loadSessionMeta(userDataPath, sessionId);
  } catch (error: unknown) {
    if (/token 格式无效/.test(error instanceof Error ? error.message : String(error))) {
      await emitTrace(trace, {
        functionName: "appendUploadSessionChunk",
        stage: "session_token_invalid",
        level: "error",
        message: "上传会话 token 格式无效。",
        sessionId,
        fileIndex: safeFileIndex
      });
      return {
        ok: false,
        code: "not_found",
        session: null
      };
    }
    throw error;
  }
  if (!meta) {
    await emitTrace(trace, {
      functionName: "appendUploadSessionChunk",
      stage: "session_not_found",
      level: "error",
      message: "上传会话不存在。",
      sessionId,
      fileIndex: safeFileIndex
    });
    return {
      ok: false,
      code: "not_found",
      session: null
    };
  }
  meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    return {
      ok: false,
      code: "session_expired",
      session: null
    };
  }
  syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  const ownerAccess = uploadSessionOwnerAccess(meta, ownerSubject);
  if (!ownerAccess.ok) {
    await emitTrace(trace, {
      functionName: "appendUploadSessionChunk",
      stage: "session_owner_mismatch",
      level: "warning",
      message: "上传会话归属不匹配，拒绝写入分块。",
      sessionId,
      fileIndex: safeFileIndex,
      ...uploadSessionOwnerTrace(ownerSubject)
    });
    return {
      ok: false,
      code: "not_found",
      session: null
    };
  }

  const file = meta.files.find((item) => item.index === safeFileIndex);
  if (!file) {
    await emitTrace(trace, {
      functionName: "appendUploadSessionChunk",
      stage: "file_not_found",
      level: "error",
      message: "上传文件索引不存在。",
      sessionId,
      fileIndex: safeFileIndex
    });
    return {
      ok: false,
      code: "file_not_found",
      session: buildPublicSession(meta)
    };
  }

  let appended: CustodyResult;
  const previousOffset = Number(file.receivedBytes || 0);
  try {
    appended = await custody.append({
      custodyRef: file.custodyRef,
      owner: ownerSubject,
      offset: Number(offset),
      bytes: buffer
    });
  } catch (error: unknown) {
    if ((error !== null && typeof error === "object" ? (error as UnknownRecord).code : undefined) === "upload_custody_offset_mismatch") {
      meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
      meta.status = resolveUploadSessionStatus(meta);
      meta.updatedAt = nowIso();
      await saveSessionMeta(userDataPath, meta);
      return {
        ok: false,
        code: "offset_mismatch",
        expectedOffset: Number(
          meta.files.find((item) => item.index === safeFileIndex)?.receivedBytes || 0
        ),
        session: buildPublicSession(meta)
      };
    }
    if ((error !== null && typeof error === "object" ? (error as UnknownRecord).code : undefined) === "upload_custody_size_exceeded") {
      return {
        ok: false,
        code: "chunk_too_large",
        expectedOffset: Number(file.receivedBytes || 0),
        session: buildPublicSession(meta)
      };
    }
    throw error;
  }
  await faultInjector?.afterCustodyAppendCommitted?.({
    committedOffset: Number(appended.nextOffset || 0),
    custodyRef: file.custodyRef,
    custodyState: appended.state,
    fileIndex: safeFileIndex,
    previousOffset
  });
  file.receivedBytes = Number(appended.nextOffset || 0);
  file.custodyState = appended.state;
  file.completedAt = "";
  file.verifiedSha256 = "";
  file.contentDigest = "";
  file.envelopeDigest = "";

  if (Number(file.receivedBytes || 0) === Number(file.byteSize || 0)) {
    try {
      const sealed = await custody.seal({
        custodyRef: file.custodyRef,
        owner: ownerSubject
      });
      file.custodyState = sealed.state;
      file.contentDigest = sealed.contentDigest;
      file.envelopeDigest = sealed.envelopeDigest;
      file.verifiedSha256 = sealed.contentDigest;
      file.completedAt = nowIso();
    } catch (error: unknown) {
      if ((error !== null && typeof error === "object" ? (error as UnknownRecord).code : undefined) !== "upload_custody_content_digest_mismatch") throw error;
      meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
      meta.status = resolveUploadSessionStatus(meta);
      meta.updatedAt = nowIso();
      await saveSessionMeta(userDataPath, meta);
      return {
        ok: false,
        code: "sha256_mismatch",
        expectedOffset: Number(file.receivedBytes || 0),
        session: buildPublicSession(meta)
      };
    }
  }

  meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
  meta.status = resolveUploadSessionStatus(meta);
  meta.updatedAt = nowIso();
  await saveSessionMeta(userDataPath, meta);
  syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  const reconciled = meta;
  const treeId = reconciled.checkpointTreeId || buildCheckpointTreeId("upload-session", reconciled.sessionId);
  await upsertCheckpointNode({
    userDataPath,
    treeId,
    nodeId: "receive-upload-files",
    parentId: "upload-session",
    label: "接收上传分块",
    status: reconciled.status === "complete" ? "completed" : "running",
    totals: {
      fileCount: reconciled.files?.length || 0,
      totalBytes: (reconciled.files || []).reduce((sum, item) => sum + Number(item.byteSize || 0), 0),
      receivedBytes: (reconciled.files || []).reduce((sum, item) => sum + Number(item.receivedBytes || 0), 0),
      completedFiles: (reconciled.files || []).filter((item) => item.completedAt).length
    },
    cursor: {
      fileIndex: safeFileIndex,
      receivedBytes: file.receivedBytes,
      byteSize: file.byteSize,
      completed: Boolean(file.completedAt),
      status: reconciled.status
    }
  }).catch(() => null);
  if (reconciled.status === "complete") {
    await finishCheckpointTree({
      userDataPath,
      treeId,
      status: "completed",
      message: "Upload session completed.",
      metadata: {
        fileCount: reconciled.files?.length || 0
      }
    }).catch(() => null);
  }
  await emitTrace(trace, {
    functionName: "appendUploadSessionChunk",
    stage: "accepted",
    message: "上传分块已写入并保存会话元数据。",
    sessionId,
    fileIndex: safeFileIndex,
    offset: Number(offset),
    chunkBytes: buffer.length,
    receivedBytes: file.receivedBytes,
    byteSize: file.byteSize,
    completed: Boolean(file.completedAt),
    status: reconciled.status
  });
  return {
    ok: true,
    code: "ok",
    session: buildPublicSession(reconciled)
  };
}

async function resolveUploadSessionFilesLocked(
  userDataPath: string,
  sessionId: string,
  options: SessionOptions,
  custodyDescribe: CustodyDescribe
) {
  const owner = normalizeUploadSessionOwner(options.owner);
  let meta = await loadSessionMeta(userDataPath, sessionId);
  if (!meta) {
    throw uploadAdmissionError("upload_session_not_found", 404, `上传会话不存在：${sessionId}`);
  }
  meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    throw uploadAdmissionError("upload_session_expired", 410, "上传会话已过期。");
  }
  syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  assertUploadSessionOwnerAccess(meta, owner);

  if (meta.status !== "complete") {
    throw uploadAdmissionError("upload_session_incomplete", 409, `上传会话尚未完成：${sessionId}`);
  }

  return Object.freeze(meta.files.map((file) => Object.freeze({
    name: file.name,
    relativePath: file.relativePath,
    sourceNameHash: file.sourceNameHash || "",
    sourceRelativePathHash: file.sourceRelativePathHash || "",
    originalFileName: file.originalFileName || "",
    clientUid: file.clientUid || meta.clientUid || "",
    sourceType: file.sourceType || meta.sourceType || "",
    providerId: file.providerId || meta.providerId || "",
    externalId: file.externalId || meta.externalId || "",
    syncBatchId: file.syncBatchId || meta.syncBatchId || "",
    contentHash: file.contentHash || meta.contentHash || file.sha256 || "",
    capturedAt: file.capturedAt || meta.capturedAt || "",
    sourceMetadata: freezeUploadDescriptorValue(file.sourceMetadata || {}),
    archiveBatchId: meta.archiveBatchId || "",
    mediaType: file.mediaType,
    sha256: file.sha256,
    byteSize: file.byteSize,
    custodyRef: file.custodyRef,
    resourceRef: `upload-resource:${meta.sessionId}:${file.index}`,
    contentDigest: file.contentDigest || file.sha256,
    envelopeDigest: file.envelopeDigest,
    custodyState: file.custodyState
  })));
}

export async function resolveUploadSessionFiles(userDataPath: string, sessionId: string, options: SessionOptions = {}) {
  const custodyDescribe = requireCustodyDescribe(options.custodyDescribe);
  return withUploadSessionMutation(sessionId, () =>
    resolveUploadSessionFilesLocked(
      userDataPath,
      sessionId,
      options,
      custodyDescribe
    )
  );
}

async function buildCheckpointReceiptFromUploadSessionLocked(
  userDataPath: string,
  sessionId: string,
  options: SessionOptions,
  custodyDescribe: CustodyDescribe
) {
  const owner = normalizeUploadSessionOwner(options.owner);
  let meta = await loadSessionMeta(userDataPath, sessionId);
  if (!meta) {
    throw uploadAdmissionError("upload_session_not_found", 404, `上传会话不存在：${sessionId}`);
  }
  meta = await reconcileSessionMeta(userDataPath, meta, { custodyDescribe });
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    throw uploadAdmissionError("upload_session_expired", 410, "上传会话已过期。");
  }
  syncAdmissionStatus(userDataPath, sessionId, admission, meta.status);
  assertUploadSessionOwnerAccess(meta, owner);

  if (meta.status !== "complete") {
    throw uploadAdmissionError("upload_session_incomplete", 409, `上传会话尚未完成：${sessionId}`);
  }

  const archiveBatch = resolveArchiveBatchIdentity({
    archiveBatchId: meta.archiveBatchId,
    checkpointId: meta.checkpointId,
    manifestDigest: meta.manifestDigest,
    inputDigest: meta.inputDigest
  });
  return {
    checkpointId: meta.checkpointId,
    archiveBatchId: archiveBatch.archiveBatchId,
    clientUid: meta.clientUid || "",
    sourceType: meta.sourceType || "",
    providerId: meta.providerId || "",
    externalId: meta.externalId || "",
    syncBatchId: meta.syncBatchId || "",
    contentHash: meta.contentHash || "",
    capturedAt: meta.capturedAt || "",
    ownerSubjectId: meta.ownerSubjectId || "",
    ownerUserId: meta.ownerUserId || "",
    ownerUsername: meta.ownerUsername || "",
    ownerRoleId: meta.ownerRoleId || "",
    ownerTenantId: meta.ownerTenantId || "",
    verifiedAt: nowIso(),
    manifestSha256: meta.manifestDigest,
    fileCount: meta.files.length,
    files: meta.files.map((file) => ({
      name: file.name,
      relativePath: file.relativePath,
      originalFileName: file.originalFileName || "",
      clientUid: file.clientUid || meta.clientUid || "",
      sourceType: file.sourceType || meta.sourceType || "",
      providerId: file.providerId || meta.providerId || "",
      externalId: file.externalId || meta.externalId || "",
      syncBatchId: file.syncBatchId || meta.syncBatchId || "",
      contentHash: file.contentHash || meta.contentHash || file.sha256 || "",
      capturedAt: file.capturedAt || meta.capturedAt || "",
      sourceMetadata: file.sourceMetadata || {},
      sourceNameHash: file.sourceNameHash || "",
      sourceRelativePathHash: file.sourceRelativePathHash || "",
      sha256: file.sha256,
      byteSize: file.byteSize
    }))
  };
}

export async function buildCheckpointReceiptFromUploadSession(
  userDataPath: string,
  sessionId: string,
  options: SessionOptions = {}
) {
  const custodyDescribe = requireCustodyDescribe(options.custodyDescribe);
  return withUploadSessionMutation(sessionId, () =>
    buildCheckpointReceiptFromUploadSessionLocked(
      userDataPath,
      sessionId,
      options,
      custodyDescribe
    )
  );
}

export async function deleteUploadSession(userDataPath: string, sessionId: string): Promise<void> {
  if (!sessionId) {
    return;
  }

  assertServerToken(sessionId, "upload_session");
  deleteUploadSessionAdmission(userDataPath, sessionId);
  await deleteCheckpointTree({
    userDataPath,
    treeId: buildCheckpointTreeId("upload-session", sessionId)
  }).catch(() => null);
  await fsp.rm(withSessionRoot(userDataPath, sessionId), {
    recursive: true,
    force: true
  });
}

export function createUploadSessionStore({
  userDataPath,
  custodyPort,
  custodyDescribe,
  faultInjector = null
}: StoreOptions = {}): UploadSessionStore {
  const root = String(userDataPath || "").trim();
  if (!root) {
    throw new TypeError("Upload session store requires userDataPath.");
  }
  const custody = requireCustodyPort(custodyPort);
  const describeCustody = requireCustodyDescribe(custodyDescribe);
  const store = Object.freeze({
    createOrResumeUploadSession(input: Partial<Omit<CreateUploadSessionInput, "userDataPath" | "custodyPort" | "custodyDescribe">> = {}) {
      return createOrResumeUploadSession({
        userDataPath: root,
        custodyPort: custody,
        custodyDescribe: describeCustody,
        checkpoint: input.checkpoint || {},
        manifest: input.manifest || {},
        files: input.files || [],
        owner: input.owner,
        trace: input.trace
      });
    },
    appendUploadSessionChunk(input: Partial<Omit<AppendUploadSessionInput, "userDataPath" | "custodyPort" | "custodyDescribe">> = {}) {
      return appendUploadSessionChunk({
        userDataPath: root,
        custodyPort: custody,
        custodyDescribe: describeCustody,
        sessionId: String(input.sessionId || ""),
        fileIndex: input.fileIndex,
        offset: input.offset,
        buffer: input.buffer,
        owner: input.owner,
        trace: input.trace,
        faultInjector
      });
    },
    getUploadSession(sessionId: string, options: SessionOptions = {}) {
      return getUploadSession(root, sessionId, {
        ...options,
        custodyDescribe: describeCustody
      });
    },
    resolveUploadSessionFiles(sessionId: string, options: SessionOptions = {}) {
      return resolveUploadSessionFiles(root, sessionId, {
        ...options,
        custodyDescribe: describeCustody
      });
    },
    buildCheckpointReceiptFromUploadSession(sessionId: string, options: SessionOptions = {}) {
      return buildCheckpointReceiptFromUploadSession(root, sessionId, {
        ...options,
        custodyDescribe: describeCustody
      });
    },
    deleteUploadSession(sessionId: string) {
      return deleteUploadSession(root, sessionId);
    }
  });
  uploadSessionStoreBindings.set(store, path.resolve(root));
  return store;
}
