import {
  saveSettings
} from "#meshrix/product-api";
import {
  assertUploadSessionStoreBinding
} from "../state/upload-session-store.ts";
import { resolveArchiveBatchIdentity } from "./archive-batch-id.ts";

const DIRECT_TEXT_MAX_BYTES: any = 1024 * 1024;
const CANONICAL_OBJECT_MAX_BYTES: any = 512 * 1024 * 1024;
const CANONICAL_OBJECT_FIELDS: any = new Set<any>([
  "mediaType",
  "originalFileName",
  "rawObjectByteSize",
  "rawObjectId",
  "rawObjectSha256",
  "sourceMetadata",
  "storageRelativePath"
]);
const OPAQUE_OBJECT_ID_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/;

function firstText(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function throwIfAborted(signal?: any) : any {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error: Error & Record<string, any> = new Error("Job execution was cancelled.");
  error.code = "job_execution_aborted";
  throw error;
}

function uploadSessionOwnerFromPayload(payload: Record<string, any> = {}) : any {
  const subjectId: any = firstText(payload.ownerSubjectId, payload.ownerUserId, payload.ownerUsername);
  return {
    subjectId,
    userId: firstText(payload.ownerUserId, subjectId),
    username: firstText(payload.ownerUsername),
    roleId: firstText(payload.ownerRoleId),
    tenantId: firstText(payload.ownerTenantId)
  };
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function sourceText(value: Record<string, any> = {}) : any {
  return typeof value.text === "string" ? value.text.trim() : "";
}

function canonicalObjectError(code: any = "canonical_reparse_object_ref_invalid") : any {
  return Object.assign(new Error(code), {
    code,
    statusCode: 400
  });
}

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeStorageRelativePath(value?: any) : any {
  if (typeof value !== "string") {
    throw canonicalObjectError();
  }
  const normalized: any = value.trim();
  const segments: any = normalized.split("/");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 1024 ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    /^[A-Za-z]:/.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized) ||
    segments.some((segment?: any) : any => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw canonicalObjectError();
  }
  return normalized;
}

function normalizeCanonicalMetadata(value?: any) : any {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw canonicalObjectError();
  }
  let serialized: any;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw canonicalObjectError();
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > 64 * 1024
  ) {
    throw canonicalObjectError();
  }
  return JSON.parse(serialized);
}

export function normalizeCanonicalObjectSource(input: Record<string, any> = {}) : any {
  if (!isPlainObject(input)) {
    throw canonicalObjectError();
  }
  for (const key of Object.keys(input)) {
    if (!CANONICAL_OBJECT_FIELDS.has(key)) {
      throw canonicalObjectError();
    }
  }

  const objectId: any =
    typeof input.rawObjectId === "string"
      ? input.rawObjectId.trim()
      : "";
  const sha256: any =
    typeof input.rawObjectSha256 === "string"
      ? input.rawObjectSha256.trim().toLowerCase()
      : "";
  const byteSize: any = input.rawObjectByteSize;
  if (
    !OPAQUE_OBJECT_ID_PATTERN.test(objectId) ||
    !SHA256_PATTERN.test(sha256) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > CANONICAL_OBJECT_MAX_BYTES
  ) {
    throw canonicalObjectError();
  }

  const originalFileName: any =
    input.originalFileName === undefined
      ? objectId
      : String(input.originalFileName).trim();
  if (
    originalFileName.length === 0 ||
    Buffer.byteLength(originalFileName, "utf8") > 255 ||
    originalFileName.includes("/") ||
    originalFileName.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(originalFileName)
  ) {
    throw canonicalObjectError();
  }
  const mediaType: any =
    input.mediaType === undefined
      ? "application/octet-stream"
      : String(input.mediaType).trim().toLowerCase();
  if (
    mediaType.length === 0 ||
    mediaType.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
  ) {
    throw canonicalObjectError();
  }

  return {
    kind: "canonical-object",
    objectRef: {
      objectId,
      storageRelativePath: normalizeStorageRelativePath(
        input.storageRelativePath
      ),
      sha256,
      byteSize
    },
    originalFileName,
    mediaType,
    sourceMetadata: normalizeCanonicalMetadata(input.sourceMetadata)
  };
}

function serializeSourceFilesForClient(sources?: any) : any {
  return sources.map((source?: any) : any => source.kind ===
    "upload-consumption-receipt-object"
    ? {
        id: source.id,
        name: source.name,
        path: source.path,
        kind: source.kind,
        uploadConsumptionReceiptId:
          source.uploadConsumptionReceiptId,
        receiptObjectIndex: source.receiptObjectIndex,
        contentSha256: source.contentSha256,
        contentByteSize: source.contentByteSize,
        mediaType: source.mediaType,
        sourceCollectedAt: source.sourceCollectedAt,
        providerId: source.providerId,
        externalId: source.externalId,
        syncBatchId: source.syncBatchId,
        contentHash: source.contentHash,
        capturedAt: source.capturedAt,
        sourceMetadata: source.sourceMetadata
      }
    : ({
    id: source.id,
    name: source.name,
    path: source.path,
    kind: source.kind,
    sourceCreatedAt: source.sourceCreatedAt || "",
    sourceUpdatedAt: source.sourceUpdatedAt || "",
    sourceCollectedAt: source.sourceCollectedAt || "",
    text: source.text || "",
    mediaType: source.mediaType || "",
    rawObjectId: source.rawObject?.objectId || "",
    clientUid: source.rawObject?.clientUid || "",
    sourceType: source.rawObject?.sourceType || "",
    providerId: source.providerId || source.rawObject?.providerId || "",
    externalId: source.externalId || source.rawObject?.externalId || "",
    syncBatchId: source.syncBatchId || source.rawObject?.syncBatchId || "",
    contentHash: source.contentHash || source.rawObject?.contentHash || source.originalSha256 || "",
    capturedAt: source.capturedAt || source.rawObject?.capturedAt || "",
    sourceMetadata: source.sourceMetadata || source.rawObject?.sourceMetadata || {},
    archiveFileName: source.rawObject?.archiveFileName || "",
    originalFileName: source.rawObject?.originalFileName || "",
    originalRelativePath: source.rawObject?.originalRelativePath || source.originalRelativePath || "",
    storageRelativePath: source.rawObject?.storageRelativePath || "",
    rawObjectSha256: source.rawObject?.sha256 || source.originalSha256 || "",
    rawObjectByteSize: source.rawObject?.byteSize || source.originalByteSize || 0
      }));
}

function createInitialContext({
  userDataPath,
  payload,
  runtime,
  reportProgress,
  signal,
  jobId,
  archiveBatchId,
  generatedAt
}: Record<string, any>) : any {
  const executionRuntime: any =
    runtime && typeof runtime.createExecutionView === "function"
      ? runtime.createExecutionView()
      : runtime;
  return {
    userDataPath,
    payload,
    runtime: executionRuntime,
    reportProgress,
    signal,
    jobId,
    archiveBatchId,
    generatedAt,
    warnings: [],
    settings: null,
    uploadSessionFiles: [],
    sources: [],
    result: null
  };
}

function sourceDefaults(payload: Record<string, any> = {}, generatedAt: any = "") : any {
  return {
    generatedAt,
    clientUid: firstText(
      payload?.checkpointReceipt?.clientUid,
      payload?.clientUid,
      payload?.clientId,
      payload?.checkpoint?.clientUid,
      payload?.checkpoint?.clientId,
      "unknown-client"
    ),
    sourceType: firstText(
      payload?.checkpointReceipt?.sourceType,
      payload?.sourceType,
      payload?.resourceType,
      payload?.checkpoint?.sourceType,
      payload?.checkpoint?.resourceType,
      "gateway"
    ),
    providerId: firstText(payload?.checkpointReceipt?.providerId, payload?.providerId, payload?.checkpoint?.providerId),
    externalId: firstText(payload?.checkpointReceipt?.externalId, payload?.externalId, payload?.checkpoint?.externalId),
    syncBatchId: firstText(payload?.checkpointReceipt?.syncBatchId, payload?.syncBatchId, payload?.checkpoint?.syncBatchId),
    capturedAt: firstText(payload?.checkpointReceipt?.capturedAt, payload?.capturedAt, payload?.checkpoint?.capturedAt)
  };
}

function directTextSource(text?: any, defaults: Record<string, any> = {}) : any {
  const generatedAt: any = defaults.generatedAt || new Date().toISOString();
  return {
    id: "inline-input",
    name: "inline-input.txt",
    path: "",
    kind: "direct-text",
    sourceCreatedAt: "",
    sourceUpdatedAt: "",
    sourceCollectedAt: generatedAt,
    text,
    mediaType: "text/plain",
    providerId: defaults.providerId,
    externalId: defaults.externalId,
    syncBatchId: defaults.syncBatchId,
    contentHash: "",
    capturedAt: firstText(defaults.capturedAt, generatedAt),
    sourceMetadata: {},
    rawObject: {
      objectId: "",
      clientUid: defaults.clientUid,
      sourceType: firstText(defaults.sourceType, "direct-text"),
      providerId: defaults.providerId,
      externalId: defaults.externalId,
      syncBatchId: defaults.syncBatchId,
      contentHash: "",
      capturedAt: firstText(defaults.capturedAt, generatedAt),
      originalFileName: "inline-input.txt",
      originalRelativePath: "",
      storageRelativePath: "",
      mediaType: "text/plain",
      sourceMetadata: {}
    }
  };
}

function canonicalObjectPipelineSource(source?: any, defaults: Record<string, any> = {}) : any {
  return {
    id: source.objectRef.objectId,
    name: source.originalFileName,
    path: source.objectRef.storageRelativePath,
    kind: source.kind,
    sourceCreatedAt: "",
    sourceUpdatedAt: "",
    sourceCollectedAt: defaults.generatedAt,
    text: "",
    mediaType: source.mediaType,
    providerId: defaults.providerId,
    externalId: defaults.externalId,
    syncBatchId: defaults.syncBatchId,
    contentHash: source.objectRef.sha256,
    capturedAt: firstText(defaults.capturedAt, defaults.generatedAt),
    sourceMetadata: source.sourceMetadata,
    rawObject: {
      objectId: source.objectRef.objectId,
      clientUid: defaults.clientUid,
      sourceType: firstText(defaults.sourceType, "canonical-object"),
      providerId: defaults.providerId,
      externalId: defaults.externalId,
      syncBatchId: defaults.syncBatchId,
      contentHash: source.objectRef.sha256,
      capturedAt: firstText(defaults.capturedAt, defaults.generatedAt),
      originalFileName: source.originalFileName,
      originalRelativePath: "",
      storageRelativePath: source.objectRef.storageRelativePath,
      mediaType: source.mediaType,
      sourceMetadata: source.sourceMetadata,
      sha256: source.objectRef.sha256,
      byteSize: source.objectRef.byteSize
    }
  };
}

function persistedUploadSource(file: Record<string, any> = {}, receipt?: any, index: any = 0, defaults: Record<string, any> = {}) : any {
  const originalFileName: any = firstText(file.originalFileName, file.name, `upload-${index + 1}`);
  const sourceMetadata: any = file.sourceMetadata && typeof file.sourceMetadata === "object" && !Array.isArray(file.sourceMetadata)
    ? file.sourceMetadata
    : {};
  return {
    id: `${receipt.receiptId}:${index}`,
    name: firstText(file.name, originalFileName),
    path: "",
    kind: "upload-consumption-receipt-object",
    uploadConsumptionReceiptId: receipt.receiptId,
    receiptObjectIndex: index,
    contentSha256: file.contentDigest,
    contentByteSize: file.byteSize,
    sourceCreatedAt: "",
    sourceUpdatedAt: "",
    sourceCollectedAt: firstText(file.capturedAt, defaults.generatedAt),
    text: "",
    mediaType: firstText(file.mediaType, "application/octet-stream"),
    providerId: firstText(file.providerId, defaults.providerId),
    externalId: firstText(file.externalId, defaults.externalId),
    syncBatchId: firstText(file.syncBatchId, defaults.syncBatchId),
    contentHash: firstText(file.contentHash, file.contentDigest),
    capturedAt: firstText(file.capturedAt, defaults.capturedAt, defaults.generatedAt),
    sourceMetadata
  };
}

function adoptionError(code?: any, message?: any, cause: any = null) : any {
  const error: Error & Record<string, any> = new Error(
    message,
    cause ? { cause } : undefined
  );
  error.code = code;
  return error;
}

function validateUploadAdoptionBinding(payload?: any, files?: any) : any {
  const receipt: any = payload?.checkpointReceipt;
  const expectedFiles: any = Array.isArray(receipt?.files)
    ? receipt.files
    : [];
  if (
    !receipt ||
    expectedFiles.length !== files.length ||
    Number(receipt.fileCount) !== files.length ||
    expectedFiles.some((expected?: any, index?: any) : any =>
      expected?.sha256 !== files[index]?.contentDigest ||
      Number(expected?.byteSize) !== Number(files[index]?.byteSize)
    )
  ) {
    throw adoptionError(
      "upload_session_adoption_binding_mismatch",
      "Upload session adoption does not match its checkpoint receipt."
    );
  }
  if (files.some((file?: any) : any =>
    file?.custodyState !== "sealed_no_run" ||
    !file?.custodyRef ||
    !SHA256_PATTERN.test(String(file?.contentDigest || "")) ||
    !SHA256_PATTERN.test(String(file?.envelopeDigest || ""))
  )) {
    throw adoptionError(
      "upload_session_adoption_not_sealed",
      "Upload session adoption requires sealed custody objects."
    );
  }
  return files;
}

async function resolveBoundUploadSessionFiles(
  uploadSessionStore?: any,
  payload?: any
) : Promise<any> {
  try {
    const files: any = await uploadSessionStore.resolveUploadSessionFiles(
      payload.uploadSessionId,
      { owner: uploadSessionOwnerFromPayload(payload) }
    );
    return validateUploadAdoptionBinding(payload, files);
  } catch (error: any) {
    if (error?.code) throw error;
    const message: any = String(error?.message || "");
    if (message.includes("尚未完成")) {
      throw adoptionError(
        "upload_session_adoption_not_sealed",
        "Upload session adoption requires sealed custody objects.",
        error
      );
    }
    throw adoptionError(
      "upload_session_not_found",
      "Upload session is unavailable.",
      error
    );
  }
}

async function persistUploadSessionSources({
  payload = {},
  uploadSessionFiles = [],
  storageProvider = null,
  jobId = "",
  archiveBatchId = "",
  generatedAt = ""
}: Record<string, any> = {}) : Promise<any> {
  if (!payload.uploadSessionId) {
    return {
      receipt: null,
      sources: []
    };
  }
  if (
    !storageProvider ||
    typeof storageProvider.commitUploadConsumptionReceipt !== "function" ||
    !Array.isArray(uploadSessionFiles)
  ) {
    const error: Error & Record<string, any> = new Error("Upload session persistence requires the canonical storage provider.");
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  const receipt: any = await storageProvider.commitUploadConsumptionReceipt({
    sessionId: payload.uploadSessionId,
    owner: uploadSessionOwnerFromPayload(payload),
    custodyDescriptors: uploadSessionFiles.map((file?: any, index?: any) : any => ({
      resourceRef: `upload-resource:${payload.uploadSessionId}:${index}`,
      custodyRef: file.custodyRef,
      custodyState: file.custodyState,
      contentDigest: file.contentDigest,
      envelopeDigest: file.envelopeDigest,
      byteSize: file.byteSize
    }))
  });
  const defaults: any = sourceDefaults(payload, generatedAt);
  return {
    receipt,
    sources: uploadSessionFiles.map((file?: any, index?: any) : any =>
      persistedUploadSource(file, receipt, index, defaults)
    )
  };
}

function collectIncomingSources({
  payload = {},
  persistedUploadSources = [],
  generatedAt = ""
}: Record<string, any>) : any {
  const defaults: any = sourceDefaults(payload, generatedAt);
  const canonicalSources: any = asArray(payload.canonicalObjectSources)
    .map((source?: any) : any => normalizeCanonicalObjectSource(source))
    .map((source?: any) : any => canonicalObjectPipelineSource(source, defaults));
  const inlineText: any =
    typeof payload.inputText === "string"
      ? payload.inputText
      : "";
  if (
    inlineText &&
    Buffer.byteLength(inlineText, "utf8") > DIRECT_TEXT_MAX_BYTES
  ) {
    const error: Error & Record<string, any> = new Error("job_create_direct_text_too_large");
    error.code = "job_create_direct_text_too_large";
    throw error;
  }
  const inputKindCount: any =
    Number(Boolean(payload.uploadSessionId)) +
    Number(canonicalSources.length > 0) +
    Number(inlineText.trim().length > 0);
  if (inputKindCount > 1) {
    const error: Error & Record<string, any> = new Error("job_pipeline_input_ambiguous");
    error.code = "job_pipeline_input_ambiguous";
    throw error;
  }
  const sources: any[] = [...persistedUploadSources, ...canonicalSources];
  if (inlineText) {
    sources.unshift(directTextSource(inlineText, defaults));
  }

  const warnings: any[] = [];
  const storedWithoutTextCount: any = persistedUploadSources.filter((source?: any) : any => !sourceText(source)).length;
  if (storedWithoutTextCount > 0) {
    warnings.push(
      `${storedWithoutTextCount} uploaded file(s) were stored as canonical objects without normalized text; upstream processing may submit normalized text separately.`
    );
  }
  if (sources.length === 0) {
    warnings.push("No text source was supplied. Submit extracted text to this job before running ingestion.");
  }
  return { sources, warnings };
}

export function createJobPipeline({
  userDataPath,
  payload,
  runtime,
  storageProvider,
  uploadSessionStore,
  reportProgress,
  jobId,
  generatedAt,
  signal = null
}: Record<string, any>) : any {
  const boundUploadSessionStore: any = payload?.uploadSessionId
    ? assertUploadSessionStoreBinding(uploadSessionStore, userDataPath)
    : null;
  const archiveBatchIdentity: any = resolveArchiveBatchIdentity({
    archiveBatchId:
      payload?.checkpointReceipt?.archiveBatchId ||
      payload?.archiveBatchId ||
      payload?.checkpoint?.archiveBatchId ||
      "",
    batchId: payload?.batchId || payload?.checkpoint?.batchId || "",
    clientBatchId: payload?.clientBatchId || payload?.checkpoint?.clientBatchId || "",
    checkpointId:
      payload?.checkpointReceipt?.checkpointId ||
      payload?.checkpointId ||
      payload?.checkpoint?.checkpointId ||
      "",
    manifestDigest:
      payload?.checkpointReceipt?.manifestSha256 ||
      payload?.checkpointReceipt?.manifestDigest ||
      payload?.checkpoint?.manifestDigest ||
      payload?.manifestSha256 ||
      "",
    inputDigest: payload?.checkpoint?.inputDigest || payload?.inputDigest || ""
  });
  const archiveBatchId: any = archiveBatchIdentity.archiveBatchId || jobId;

  return {
    createContext() : any {
      return createInitialContext({
        userDataPath,
        payload,
        runtime,
        reportProgress,
        signal,
        jobId,
        archiveBatchId,
        generatedAt
      });
    },
    async run(context?: any) : Promise<any> {
      throwIfAborted(context.signal);
      if (payload.uploadSessionId) {
        context.uploadSessionFiles = await resolveBoundUploadSessionFiles(
          boundUploadSessionStore,
          payload
        );
      }
      throwIfAborted(context.signal);
      context.reportProgress({
        progressPercent: 8,
        stage: "保存配置"
      });
      context.settings = await saveSettings(userDataPath, payload.settings);
      throwIfAborted(context.signal);

      context.reportProgress({
        progressPercent: 26,
        stage: "接收上游文本"
      });
      const persistedUpload: any = await persistUploadSessionSources({
        payload,
        uploadSessionFiles: context.uploadSessionFiles,
        storageProvider,
        jobId,
        archiveBatchId,
        generatedAt
      });
      const persistedUploadSources: any = persistedUpload.sources;
      throwIfAborted(context.signal);
      const incoming: any = collectIncomingSources({
        payload,
        persistedUploadSources,
        generatedAt
      });
      context.sources = incoming.sources;
      for (const source of context.sources || []) {
        if (source?.rawObject) {
          source.rawObject.jobId = jobId;
          source.rawObject.ownerSubjectId = firstText(payload.ownerSubjectId, payload.ownerUserId, payload.ownerUsername);
          source.rawObject.ownerUserId = firstText(payload.ownerUserId, payload.ownerSubjectId);
          source.rawObject.ownerUsername = firstText(payload.ownerUsername);
        }
      }
      context.warnings.push(...incoming.warnings);
      throwIfAborted(context.signal);

      context.reportProgress({
        progressPercent: 76,
        stage: "整理上游负载"
      });
      context.result = {
        batchId: context.archiveBatchId,
        jobId,
        generatedAt,
        accepted: true,
        gateway: {
          mode: "upstream_text_receipt",
          sourceCount: context.sources.length,
          uploadSessionFileCount: context.uploadSessionFiles.length
        },
        ...(payload.uploadSessionId
          ? {
              uploadConsumptionReceiptId:
                persistedUpload.receipt.receiptId
            }
          : {}),
        warnings: context.warnings,
        sourceFiles: serializeSourceFilesForClient(context.sources)
      };

      throwIfAborted(context.signal);

      context.reportProgress({
        progressPercent: 100,
        stage: "结果已生成"
      });

      return context.result;
    }
  };
}
