import {
  saveSettings
} from "#meshrix/product-api";
import { serverToken } from "#meshrix/client-strings";
import { resolveUploadSessionFiles } from "../state/upload-session-store.mjs";
import { resolveArchiveBatchIdentity } from "./archive-batch-id.mjs";
import { createUploadSessionConsumption } from "./upload-session-consumption.mjs";

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Job execution was cancelled.");
  error.code = "job_execution_aborted";
  throw error;
}

function uploadSessionOwnerFromPayload(payload = {}) {
  const subjectId = firstText(payload.ownerSubjectId, payload.ownerUserId, payload.ownerUsername);
  return {
    subjectId,
    userId: firstText(payload.ownerUserId, subjectId),
    username: firstText(payload.ownerUsername),
    roleId: firstText(payload.ownerRoleId),
    tenantId: firstText(payload.ownerTenantId)
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceText(value = {}) {
  return firstText(value.text, value.content, value.body, value.markdown, value.plainText);
}

function serializeSourceFilesForClient(sources) {
  return sources.map((source) => ({
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
}) {
  const executionRuntime =
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

function sourceDefaults(payload = {}, generatedAt = "") {
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

function normalizeTextSource(source = {}, index = 0, defaults = {}) {
  const text = sourceText(source);
  if (!text) {
    return null;
  }
  const generatedAt = defaults.generatedAt || new Date().toISOString();
  const name = firstText(
    source.name,
    source.title,
    source.fileName,
    source.originalFileName,
    defaults.name,
    `source-${index + 1}.txt`
  );
  const id = firstText(
    source.id,
    source.sourceId,
    source.externalId,
    `${defaults.idPrefix || "source"}-${index + 1}`
  );
  const sourceMetadata = {
    ...(source.sourceMetadata || {}),
    ...(source.metadata || {})
  };
  return {
    id,
    name,
    path: firstText(source.path, source.relativePath, source.storageRelativePath),
    kind: firstText(source.kind, defaults.kind, "text"),
    sourceCreatedAt: firstText(source.sourceCreatedAt, source.createdAt),
    sourceUpdatedAt: firstText(source.sourceUpdatedAt, source.updatedAt),
    sourceCollectedAt: firstText(source.sourceCollectedAt, source.collectedAt, generatedAt),
    text,
    mediaType: firstText(source.mediaType, "text/plain"),
    providerId: firstText(source.providerId, defaults.providerId),
    externalId: firstText(source.externalId, defaults.externalId),
    syncBatchId: firstText(source.syncBatchId, defaults.syncBatchId),
    contentHash: firstText(source.contentHash, source.sha256),
    capturedAt: firstText(source.capturedAt, defaults.capturedAt, generatedAt),
    sourceMetadata,
    rawObject: {
      objectId: firstText(source.rawObjectId, source.objectId),
      clientUid: firstText(source.clientUid, defaults.clientUid),
      sourceType: firstText(source.sourceType, defaults.sourceType, "gateway"),
      providerId: firstText(source.providerId, defaults.providerId),
      externalId: firstText(source.externalId, defaults.externalId),
      syncBatchId: firstText(source.syncBatchId, defaults.syncBatchId),
      contentHash: firstText(source.contentHash, source.sha256),
      capturedAt: firstText(source.capturedAt, defaults.capturedAt, generatedAt),
      originalFileName: firstText(source.originalFileName, source.fileName, name),
      originalRelativePath: firstText(source.originalRelativePath, source.relativePath),
      storageRelativePath: firstText(source.storageRelativePath),
      mediaType: firstText(source.mediaType, "text/plain"),
      sourceMetadata
    }
  };
}

function persistedUploadSource(file = {}, storedObject = {}, index = 0, defaults = {}) {
  const originalFileName = firstText(file.originalFileName, file.name, `upload-${index + 1}`);
  const sourceMetadata = file.sourceMetadata && typeof file.sourceMetadata === "object" && !Array.isArray(file.sourceMetadata)
    ? file.sourceMetadata
    : {};
  return {
    id: storedObject.objectId,
    name: firstText(file.name, storedObject.fileName, originalFileName),
    path: storedObject.storageRelativePath,
    kind: "stored-object",
    sourceCreatedAt: "",
    sourceUpdatedAt: "",
    sourceCollectedAt: firstText(file.capturedAt, defaults.generatedAt),
    text: "",
    mediaType: firstText(storedObject.mediaType, file.mediaType, "application/octet-stream"),
    providerId: firstText(file.providerId, defaults.providerId),
    externalId: firstText(file.externalId, defaults.externalId),
    syncBatchId: firstText(file.syncBatchId, defaults.syncBatchId),
    contentHash: firstText(file.contentHash, storedObject.sha256),
    capturedAt: firstText(file.capturedAt, defaults.capturedAt, defaults.generatedAt),
    sourceMetadata,
    rawObject: {
      objectId: storedObject.objectId,
      clientUid: firstText(file.clientUid, defaults.clientUid),
      sourceType: firstText(file.sourceType, defaults.sourceType, "upload"),
      providerId: firstText(file.providerId, defaults.providerId),
      externalId: firstText(file.externalId, defaults.externalId),
      syncBatchId: firstText(file.syncBatchId, defaults.syncBatchId),
      contentHash: firstText(file.contentHash, storedObject.sha256),
      capturedAt: firstText(file.capturedAt, defaults.capturedAt, defaults.generatedAt),
      originalFileName,
      originalRelativePath: firstText(file.relativePath, originalFileName),
      storageRelativePath: storedObject.storageRelativePath,
      mediaType: firstText(storedObject.mediaType, file.mediaType, "application/octet-stream"),
      sourceMetadata,
      sha256: storedObject.sha256,
      byteSize: storedObject.byteSize
    }
  };
}

async function persistUploadSessionSources({
  payload = {},
  uploadSessionFiles = [],
  storageProvider = null,
  jobId = "",
  archiveBatchId = "",
  generatedAt = ""
} = {}) {
  if (!payload.uploadSessionId) {
    return [];
  }
  if (!storageProvider || typeof storageProvider.putObjectsFromFiles !== "function") {
    const error = new Error("Upload session persistence requires the canonical storage provider.");
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  const inputs = uploadSessionFiles.map((file, index) => ({
    objectId: serverToken(
      "storage_object",
      jobId,
      archiveBatchId,
      index,
      file.sha256,
      file.byteSize
    ),
    sourcePath: file.stagedPath,
    namespace: "job-uploads",
    fileName: firstText(file.originalFileName, file.name, `upload-${index + 1}.bin`),
    mediaType: firstText(file.mediaType, "application/octet-stream"),
    expectedSha256: file.sha256,
    expectedByteSize: file.byteSize,
    metadata: {
      artifactKind: "job-upload-source",
      jobId,
      archiveBatchId,
      sourceIndex: index,
      clientUid: firstText(file.clientUid),
      sourceType: firstText(file.sourceType, "upload"),
      providerId: firstText(file.providerId),
      externalId: firstText(file.externalId),
      syncBatchId: firstText(file.syncBatchId),
      contentHash: firstText(file.contentHash, file.sha256),
      capturedAt: firstText(file.capturedAt, generatedAt),
      originalFileName: firstText(file.originalFileName, file.name),
      originalRelativePath: firstText(file.relativePath),
      ownerSubjectId: firstText(payload.ownerSubjectId, payload.ownerUserId, payload.ownerUsername),
      ownerUserId: firstText(payload.ownerUserId, payload.ownerSubjectId),
      ownerUsername: firstText(payload.ownerUsername)
    }
  }));
  const storedObjects = await storageProvider.putObjectsFromFiles(inputs);
  if (storedObjects.length !== uploadSessionFiles.length) {
    const error = new Error("Upload session persistence did not commit every staged file.");
    error.code = "upload_session_persistence_incomplete";
    throw error;
  }
  const defaults = sourceDefaults(payload, generatedAt);
  return uploadSessionFiles.map((file, index) =>
    persistedUploadSource(file, storedObjects[index], index, defaults)
  );
}

function collectIncomingTextSources({
  payload = {},
  persistedUploadSources = [],
  generatedAt = ""
}) {
  const defaults = sourceDefaults(payload, generatedAt);
  const candidates = [
    ...asArray(payload.sources),
    ...asArray(payload.documents),
    ...asArray(payload.uploadedFiles)
  ];
  const textSources = candidates
    .map((source, index) => normalizeTextSource(source, index, defaults))
    .filter(Boolean);
  const sources = [...persistedUploadSources, ...textSources];

  const inlineText = firstText(payload.inputText, payload.text, payload.content);
  if (inlineText) {
    sources.unshift(normalizeTextSource({
      id: "inline-input",
      name: firstText(payload.title, payload.name, "inline-input.txt"),
      text: inlineText,
      sourceType: defaults.sourceType,
      providerId: defaults.providerId,
      externalId: defaults.externalId,
      syncBatchId: defaults.syncBatchId,
      capturedAt: defaults.capturedAt
    }, 0, { ...defaults, idPrefix: "inline" }));
  }

  const warnings = [];
  const storedWithoutTextCount = persistedUploadSources.filter((source) => !sourceText(source)).length;
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
  reportProgress,
  jobId,
  generatedAt,
  signal = null
}) {
  const archiveBatchIdentity = resolveArchiveBatchIdentity({
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
  const archiveBatchId = archiveBatchIdentity.archiveBatchId || jobId;

  return {
    createContext() {
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
    async run(context) {
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
      if (payload.uploadSessionId) {
        context.uploadSessionFiles = await resolveUploadSessionFiles(userDataPath, payload.uploadSessionId, {
          owner: uploadSessionOwnerFromPayload(payload)
        });
      }
      throwIfAborted(context.signal);
      const persistedUploadSources = await persistUploadSessionSources({
        payload,
        uploadSessionFiles: context.uploadSessionFiles,
        storageProvider,
        jobId,
        archiveBatchId,
        generatedAt
      });
      throwIfAborted(context.signal);
      const incoming = collectIncomingTextSources({
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
              uploadSessionConsumption: createUploadSessionConsumption({
                expectedFileCount: context.uploadSessionFiles.length,
                persistedFileCount: persistedUploadSources.length
              })
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
