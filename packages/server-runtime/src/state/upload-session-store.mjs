import fsp from "node:fs/promises";
import path from "node:path";
import {
  checkpointTreeId as buildCheckpointTreeId,
  deleteCheckpointTree,
  finishCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#lico/foundation/checkpoint/tree/checkpoint-tree-projection";
import {
  assertServerToken,
  hashClientString,
  serverToken
} from "#lico/client-strings";
import { queueStateMutation } from "#lico/state-coordinator";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.mjs";
import {
  UPLOAD_SESSION_MAX_CHUNK_BYTES,
  deleteUploadSessionAdmission,
  listExpiredUploadSessionAdmissions,
  readUploadSessionAdmission,
  reserveUploadSessionAdmission,
  updateUploadSessionAdmissionStatus,
  uploadAdmissionError,
  validateUploadSessionDeclaration
} from "./upload-session-admission.mjs";
import {
  assertUploadSessionOwnerAccess,
  normalizeUploadSessionOwner,
  uploadSessionAccessError,
  uploadSessionOwnerAccess,
  uploadSessionOwnerFields,
  uploadSessionOwnerKey,
  uploadSessionOwnerTrace
} from "./upload-session-owner.mjs";
import {
  EMPTY_FILE_SHA256,
  SESSION_SCHEMA_VERSION,
  appendPrivateSessionFile,
  buildPublicSession,
  createVerifiedEmptySessionFile,
  emitTrace,
  getSessionFilePath,
  hashFileSha256,
  loadSessionMeta,
  normalizeByteSize,
  normalizeFileIndex,
  normalizeOptionalSha256,
  normalizeSha256,
  nowIso,
  originalFileNameForUpload,
  resolveUploadSessionStatus,
  saveSessionMeta,
  truncatePrivateSessionFile,
  validateRelativePath,
  withSessionRoot
} from "./upload-session-support.mjs";

function withUploadSessionMutation(sessionId, mutation) {
  const queueKey = hashClientString(sessionId, "upload.session.mutation");
  return queueStateMutation(`upload-session:${queueKey}`, mutation);
}

function validateUploadSessionFiles(files) {
  const declaration = validateUploadSessionDeclaration(files);
  for (const [index, file] of files.entries()) {
    validateRelativePath(file.relativePath || file.name || `upload-${index + 1}`);
    const digest = normalizeSha256(file.sha256, `files[${index}].sha256`);
    const byteSize = normalizeByteSize(file.byteSize);
    if (byteSize === 0 && digest !== EMPTY_FILE_SHA256) {
      throw new Error(`files[${index}].sha256 与零字节文件不匹配。`);
    }
  }
  return declaration;
}

async function removeExpiredUploadSessionArtifacts(userDataPath, sessionIds) {
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
  checkpoint,
  manifest,
  files = [],
  owner,
  trace
}) {
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
    throw new Error("upload session 缺少 checkpointId。");
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
    archiveBatchId: checkpoint?.archiveBatchId,
    batchId: checkpoint?.batchId,
    clientBatchId: checkpoint?.clientBatchId,
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
  const existing = await loadSessionMeta(userDataPath, sessionId);
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
    if (existing.status === "complete" && admission.status !== "complete") {
      updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
    }
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
    } catch (error) {
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
      throw new Error("同一 checkpoint 的上传会话摘要不一致，拒绝覆盖。");
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
      throw new Error("同一 checkpoint 的归档批次不一致，拒绝覆盖。");
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
  const meta = {
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
        throw new Error(`files[${index}].sha256 与零字节文件不匹配。`);
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
        relativePath: fileToken,
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
        mediaType: "application/octet-stream",
        sha256,
        byteSize,
        receivedBytes: 0,
        completedAt: byteSize === 0 ? now : "",
        verifiedSha256: byteSize === 0 ? sha256 : ""
      };
    })
  };

  meta.status = resolveUploadSessionStatus(meta);
  try {
    for (const file of meta.files) {
      if (file.byteSize === 0) {
        await createVerifiedEmptySessionFile(userDataPath, sessionId, file.index, file.sha256);
      }
    }
    await saveSessionMeta(userDataPath, meta);
  } catch (error) {
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

export async function getUploadSession(userDataPath, sessionId, options = {}) {
  const owner = normalizeUploadSessionOwner(options.owner);
  let meta;
  try {
    meta = await loadSessionMeta(userDataPath, sessionId);
  } catch (error) {
    if (/token 格式无效/.test(String(error?.message || ""))) {
      return null;
    }
    throw error;
  }
  if (!meta) {
    return null;
  }
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    return null;
  }
  if (meta.status === "complete" && admission.status !== "complete") {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
  }
  return uploadSessionOwnerAccess(meta, owner).ok ? buildPublicSession(meta) : null;
}

export async function appendUploadSessionChunk({
  userDataPath,
  sessionId,
  fileIndex,
  offset,
  buffer,
  owner,
  trace
}) {
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
  trace
}) {
  let meta;
  try {
    meta = await loadSessionMeta(userDataPath, sessionId);
  } catch (error) {
    if (/token 格式无效/.test(String(error?.message || ""))) {
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
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    return {
      ok: false,
      code: "session_expired",
      session: null
    };
  }
  if (meta.status === "complete" && admission.status !== "complete") {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
  }
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

  if (Number(offset) !== Number(file.receivedBytes || 0)) {
    await emitTrace(trace, {
      functionName: "appendUploadSessionChunk",
      stage: "offset_mismatch",
      level: "warning",
      message: "客户端上传 offset 与服务端 receivedBytes 不一致。",
      sessionId,
      fileIndex: safeFileIndex,
      offset: Number(offset),
      expectedOffset: Number(file.receivedBytes || 0),
      receivedBytes: Number(file.receivedBytes || 0)
    });
    return {
      ok: false,
      code: "offset_mismatch",
      expectedOffset: Number(file.receivedBytes || 0),
      session: buildPublicSession(meta)
    };
  }

  const remainingBytes = Number(file.byteSize || 0) - Number(file.receivedBytes || 0);
  if (buffer.length > remainingBytes) {
    await emitTrace(trace, {
      functionName: "appendUploadSessionChunk",
      stage: "chunk_too_large",
      level: "error",
      message: "上传分块超过该文件剩余字节数。",
      sessionId,
      fileIndex: safeFileIndex,
      chunkBytes: buffer.length,
      remainingBytes
    });
    return {
      ok: false,
      code: "chunk_too_large",
      expectedOffset: Number(file.receivedBytes || 0),
      session: buildPublicSession(meta)
    };
  }

  const filePath = await appendPrivateSessionFile(
    userDataPath,
    sessionId,
    safeFileIndex,
    buffer
  );
  file.receivedBytes = Number(file.receivedBytes || 0) + buffer.length;
  file.completedAt = "";
  file.verifiedSha256 = "";

  if (Number(file.receivedBytes || 0) === Number(file.byteSize || 0)) {
    const sha256 = await hashFileSha256(filePath);
    if (sha256 !== file.sha256) {
      await truncatePrivateSessionFile(userDataPath, sessionId, safeFileIndex, 0);
      file.receivedBytes = 0;
      file.completedAt = "";
      file.verifiedSha256 = "";
      meta.status = resolveUploadSessionStatus(meta);
      meta.updatedAt = nowIso();
      await saveSessionMeta(userDataPath, meta);
      await upsertCheckpointNode({
        userDataPath,
        treeId: meta.checkpointTreeId || buildCheckpointTreeId("upload-session", meta.sessionId),
        nodeId: "receive-upload-files",
        parentId: "upload-session",
        label: "上传分块校验失败，等待重传",
        status: "running",
        error: "sha256_mismatch",
        cursor: {
          fileIndex: safeFileIndex,
          expectedOffset: 0
        }
      }).catch(() => null);
      await emitTrace(trace, {
        functionName: "appendUploadSessionChunk",
        stage: "sha256_mismatch",
        level: "error",
        message: "文件完成后 sha256 校验失败，已重置该文件上传进度。",
        sessionId,
        fileIndex: safeFileIndex,
        expectedSha256: file.sha256,
        actualSha256: sha256
      });
      return {
        ok: false,
        code: "sha256_mismatch",
        expectedOffset: 0,
        session: buildPublicSession(meta)
      };
    }

    file.verifiedSha256 = sha256;
    file.completedAt = nowIso();
  }

  meta.status = resolveUploadSessionStatus(meta);
  meta.updatedAt = nowIso();
  await saveSessionMeta(userDataPath, meta);
  if (meta.status === "complete") {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
  }
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

export async function resolveUploadSessionFiles(userDataPath, sessionId, options = {}) {
  const owner = normalizeUploadSessionOwner(options.owner);
  const meta = await loadSessionMeta(userDataPath, sessionId);
  if (!meta) {
    throw new Error(`上传会话不存在：${sessionId}`);
  }
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    throw uploadAdmissionError("upload_session_expired", 410, "上传会话已过期。");
  }
  if (meta.status === "complete" && admission.status !== "complete") {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
  }
  assertUploadSessionOwnerAccess(meta, owner);

  if (meta.status !== "complete") {
    throw new Error(`上传会话尚未完成：${sessionId}`);
  }

  return meta.files.map((file) => ({
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
    sourceMetadata: file.sourceMetadata || {},
    archiveBatchId: meta.archiveBatchId || "",
    mediaType: file.mediaType,
    sha256: file.sha256,
    byteSize: file.byteSize,
    stagedPath: getSessionFilePath(userDataPath, sessionId, file.index)
  }));
}

export async function buildCheckpointReceiptFromUploadSession(userDataPath, sessionId, options = {}) {
  const owner = normalizeUploadSessionOwner(options.owner);
  const meta = await loadSessionMeta(userDataPath, sessionId);
  if (!meta) {
    throw new Error(`上传会话不存在：${sessionId}`);
  }
  const admission = readUploadSessionAdmission(userDataPath, sessionId);
  if (!admission) {
    await removeExpiredUploadSessionArtifacts(userDataPath, [sessionId]);
    throw uploadAdmissionError("upload_session_expired", 410, "上传会话已过期。");
  }
  if (meta.status === "complete" && admission.status !== "complete") {
    updateUploadSessionAdmissionStatus(userDataPath, sessionId, "complete");
  }
  assertUploadSessionOwnerAccess(meta, owner);

  if (meta.status !== "complete") {
    throw new Error(`上传会话尚未完成：${sessionId}`);
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

export async function deleteUploadSession(userDataPath, sessionId) {
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
