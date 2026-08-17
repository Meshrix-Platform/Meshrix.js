import {
  saveSettings
} from "#meshrix/product-api";
import {
  assertBoundUploadSessionStore
} from "../state/upload-session-store.ts";
import { resolveArchiveBatchIdentity } from "./archive-batch-id.ts";
import { errorMessage, errorProperty, type CodedError, type JobPayload, type JobResult, type UploadConsumptionStorageProvider } from "./jobs/contracts.ts";

type MetadataValue = null | boolean | number | string | MetadataValue[] | { [key: string]: MetadataValue };
interface PipelinePayload extends JobPayload {
  uploadSessionId?: string;
  ownerRoleId?: string;
  ownerTenantId?: string;
  canonicalObjectSources?: unknown[];
  inputText?: string;
  settings?: Record<string, unknown>;
  clientUid?: string;
  clientId?: string;
  sourceType?: string;
  resourceType?: string;
  providerId?: string;
  externalId?: string;
  syncBatchId?: string;
  capturedAt?: string;
}
interface UploadSessionFile {
  name?: string; originalFileName?: string; relativePath?: string;
  archiveBatchId?: string; contentDigest: string; sha256?: string;
  envelopeDigest: string; byteSize: number; custodyRef: string;
  custodyState: string; mediaType?: string; providerId?: string;
  externalId?: string; syncBatchId?: string; contentHash?: string;
  capturedAt?: string; sourceMetadata?: MetadataValue;
}
interface UploadConsumptionReceipt {
  receiptId: string; sessionId: string;
  objects: Array<{ objectId: string; sha256: string; byteSize: number }>;
}
interface CanonicalObjectSource {
  kind: "canonical-object";
  objectRef: { objectId: string; storageRelativePath: string; sha256: string; byteSize: number };
  originalFileName: string; mediaType: string; sourceMetadata: MetadataValue | Record<string, never>;
}
interface SourceDefaults {
  generatedAt?: string; clientUid?: string; sourceType?: string; providerId?: string;
  externalId?: string; syncBatchId?: string; capturedAt?: string;
}
interface PipelineSource {
  id: string; name: string; path: string; kind: string;
  text?: string; mediaType?: string; sourceCreatedAt?: string; sourceUpdatedAt?: string;
  sourceCollectedAt?: string; providerId?: string; externalId?: string; syncBatchId?: string;
  contentHash?: string; capturedAt?: string; sourceMetadata?: MetadataValue | Record<string, never>;
  uploadConsumptionReceiptId?: string; receiptObjectIndex?: number; contentSha256?: string;
  contentByteSize?: number; originalSha256?: string; originalByteSize?: number;
  originalRelativePath?: string;
  rawObject?: Record<string, unknown> & {
    objectId?: string; clientUid?: string; sourceType?: string; providerId?: string;
    externalId?: string; syncBatchId?: string; contentHash?: string; capturedAt?: string;
    archiveFileName?: string; originalFileName?: string; originalRelativePath?: string;
    storageRelativePath?: string; sha256?: string; byteSize?: number; sourceMetadata?: unknown;
  };
}
interface PipelineContext {
  userDataPath: string; payload: PipelinePayload; runtime: object;
  reportProgress(message: Record<string, unknown>): void | Promise<void>;
  signal: AbortSignal | null; jobId: string; archiveBatchId: string; generatedAt: string;
  warnings: string[]; settings: unknown; uploadSessionFiles: UploadSessionFile[];
  sources: PipelineSource[]; result: JobResult | null;
}


const DIRECT_TEXT_MAX_BYTES = 1024 * 1024;
const CANONICAL_OBJECT_MAX_BYTES = 512 * 1024 * 1024;
const CANONICAL_OBJECT_FIELDS = new Set<string>([
  "mediaType",
  "originalFileName",
  "rawObjectByteSize",
  "rawObjectId",
  "rawObjectSha256",
  "sourceMetadata",
  "storageRelativePath"
]);
const OPAQUE_OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UPLOAD_CONSUMPTION_RECEIPT_ID_PATTERN =
  /^upload_consumption_receipt_[a-f0-9]{32}$/u;
const UPLOAD_SOURCE_METADATA_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "absolutepath",
  "buffer",
  "bytes",
  "ciphertextbytes",
  "ciphertextbytesize",
  "custodyref",
  "envelopedigest",
  "filepath",
  "hostpath",
  "key",
  "objectid",
  "rawobjectid",
  "sourcepath",
  "stagedpath",
  "storagepath",
  "storagerelativepath",
  "stream"
]);

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function throwIfAborted(signal?: AbortSignal | null) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Job execution was cancelled.") as CodedError;
  error.code = "job_execution_aborted";
  throw error;
}

function uploadSessionOwnerFromPayload(payload: PipelinePayload = {}) {
  const subjectId = firstText(payload.ownerSubjectId, payload.ownerUserId, payload.ownerUsername);
  return {
    subjectId,
    userId: firstText(payload.ownerUserId, subjectId),
    username: firstText(payload.ownerUsername),
    roleId: firstText(payload.ownerRoleId),
    tenantId: firstText(payload.ownerTenantId)
  };
}

function asArray(value?: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sourceText(value: { text?: string } = {}) {
  return typeof value.text === "string" ? value.text.trim() : "";
}

function canonicalObjectError(code = "canonical_reparse_object_ref_invalid") {
  return Object.assign(new Error(code), {
    code,
    statusCode: 400
  });
}

function isPlainObject(value?: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeUploadSourceMetadataValue(value: unknown, depth = 0): MetadataValue {
  if (depth > 8) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= 4096 ? value : "";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((item) =>
      sanitizeUploadSourceMetadataValue(item, depth + 1)
    );
  }
  if (!isPlainObject(value)) return null;
  const sanitized: { [key: string]: MetadataValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (UPLOAD_SOURCE_METADATA_FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    sanitized[key] = sanitizeUploadSourceMetadataValue(item, depth + 1);
  }
  return sanitized;
}

function sanitizeUploadSourceMetadata(value?: unknown) {
  if (!isPlainObject(value)) return {};
  const sanitized = sanitizeUploadSourceMetadataValue(value);
  const serialized = JSON.stringify(sanitized);
  return Buffer.byteLength(serialized, "utf8") <= 64 * 1024
    ? sanitized
    : {};
}

function normalizeStorageRelativePath(value?: unknown) {
  if (typeof value !== "string") {
    throw canonicalObjectError();
  }
  const normalized = value.trim();
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 1024 ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    /^[A-Za-z]:/.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw canonicalObjectError();
  }
  return normalized;
}

function normalizeCanonicalMetadata(value?: unknown): MetadataValue | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw canonicalObjectError();
  }
  let serialized: string | undefined;
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

export function normalizeCanonicalObjectSource(input: unknown = {}): CanonicalObjectSource {
  if (!isPlainObject(input)) {
    throw canonicalObjectError();
  }
  for (const key of Object.keys(input)) {
    if (!CANONICAL_OBJECT_FIELDS.has(key)) {
      throw canonicalObjectError();
    }
  }

  const objectId =
    typeof input.rawObjectId === "string"
      ? input.rawObjectId.trim()
      : "";
  const sha256 =
    typeof input.rawObjectSha256 === "string"
      ? input.rawObjectSha256.trim().toLowerCase()
      : "";
  const byteSize = input.rawObjectByteSize;
  if (
    !OPAQUE_OBJECT_ID_PATTERN.test(objectId) ||
    !SHA256_PATTERN.test(sha256) ||
    !Number.isSafeInteger(byteSize) ||
    Number(byteSize) < 0 ||
    Number(byteSize) > CANONICAL_OBJECT_MAX_BYTES
  ) {
    throw canonicalObjectError();
  }

  const originalFileName =
    input.originalFileName === undefined
      ? objectId
      : String(input.originalFileName).trim();
  if (
    originalFileName.length === 0 ||
    Buffer.byteLength(originalFileName, "utf8") > 255 ||
    originalFileName.includes("/") ||
    originalFileName.includes("\\") ||
    Array.from(originalFileName).some((character) => {
      const codePoint = character.codePointAt(0) || 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw canonicalObjectError();
  }
  const mediaType =
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
      byteSize: Number(byteSize)
    },
    originalFileName,
    mediaType,
    sourceMetadata: normalizeCanonicalMetadata(input.sourceMetadata)
  };
}

function serializeSourceFilesForClient(sources: PipelineSource[]) {
  return sources.map((source) => source.kind ===
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
}: {
  userDataPath: string; payload: PipelinePayload; runtime: Record<string, unknown>;
  reportProgress(message: Record<string, unknown>): void | Promise<void>;
  signal: AbortSignal | null; jobId: string; archiveBatchId: string; generatedAt: string;
}): PipelineContext {
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

function sourceDefaults(payload: PipelinePayload = {}, generatedAt = ""): SourceDefaults {
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

function directTextSource(text: string, defaults: SourceDefaults = {}): PipelineSource {
  const generatedAt = defaults.generatedAt || new Date().toISOString();
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

function canonicalObjectPipelineSource(source: CanonicalObjectSource, defaults: SourceDefaults = {}): PipelineSource {
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

function persistedUploadSource(file: UploadSessionFile, receipt: UploadConsumptionReceipt, index = 0, defaults: SourceDefaults = {}): PipelineSource {
  const logicalObject = receipt.objects[index];
  const originalFileName = firstText(file.originalFileName, file.name, `upload-${index + 1}`);
  const sourceMetadata = sanitizeUploadSourceMetadata(file.sourceMetadata);
  return {
    id: `${receipt.receiptId}:${index}`,
    name: firstText(file.name, originalFileName),
    path: "",
    kind: "upload-consumption-receipt-object",
    uploadConsumptionReceiptId: receipt.receiptId,
    receiptObjectIndex: index,
    contentSha256: logicalObject.sha256,
    contentByteSize: logicalObject.byteSize,
    sourceCreatedAt: "",
    sourceUpdatedAt: "",
    sourceCollectedAt: firstText(file.capturedAt, defaults.generatedAt),
    text: "",
    mediaType: firstText(file.mediaType, "application/octet-stream"),
    providerId: firstText(file.providerId, defaults.providerId),
    externalId: firstText(file.externalId, defaults.externalId),
    syncBatchId: firstText(file.syncBatchId, defaults.syncBatchId),
    contentHash: firstText(file.contentHash, logicalObject.sha256),
    capturedAt: firstText(file.capturedAt, defaults.capturedAt, defaults.generatedAt),
    sourceMetadata
  };
}

function validateUploadConsumptionReceipt(
  receipt: unknown,
  payload: PipelinePayload,
  uploadSessionFiles: UploadSessionFile[] = []
) {
  if (!isPlainObject(receipt)) {
    throw adoptionError(
      "upload_session_adoption_receipt_invalid",
      "Upload session adoption returned an invalid durable receipt."
    );
  }
  if (
    !receipt ||
    !UPLOAD_CONSUMPTION_RECEIPT_ID_PATTERN.test(String(receipt.receiptId || "")) ||
    receipt.sessionId !== payload.uploadSessionId ||
    !Array.isArray(receipt.objects) ||
    receipt.objects.length !== uploadSessionFiles.length ||
    receipt.objects.some((logicalObject: { objectId: string; sha256: string; byteSize: number }, index: number) =>
      Object.keys(logicalObject || {}).sort().join(",") !==
        "byteSize,objectId,sha256" ||
      !OPAQUE_OBJECT_ID_PATTERN.test(String(logicalObject?.objectId || "")) ||
      logicalObject?.sha256 !== uploadSessionFiles[index]?.contentDigest ||
      Number(logicalObject?.byteSize) !== Number(uploadSessionFiles[index]?.byteSize) ||
      !Number.isSafeInteger(Number(logicalObject?.byteSize)) ||
      Number(logicalObject?.byteSize) < 0
    )
  ) {
    throw adoptionError(
      "upload_session_adoption_receipt_invalid",
      "Upload session adoption returned an invalid durable receipt."
    );
  }
  return {
    receiptId: String(receipt.receiptId),
    sessionId: String(receipt.sessionId),
    objects: (receipt.objects as Array<Record<string, unknown>>).map((object) => ({
      objectId: String(object.objectId),
      sha256: String(object.sha256),
      byteSize: Number(object.byteSize)
    }))
  };
}

function adoptionError(code: string, message: string, cause: unknown = null) {
  const error = new Error(
    message,
    cause ? { cause } : undefined
  ) as CodedError;
  error.code = code;
  return error;
}

function validateUploadAdoptionBinding(payload: PipelinePayload, files: unknown): UploadSessionFile[] {
  const receipt = payload?.checkpointReceipt;
  const expectedFiles = Array.isArray(receipt?.files)
    ? receipt.files
    : [];
  const owner = uploadSessionOwnerFromPayload(payload);
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !Object.isFrozen(files) ||
    files.some((file) => !Object.isFrozen(file)) ||
    !receipt ||
    expectedFiles.length !== files.length ||
    Number(receipt.fileCount) !== files.length ||
    firstText(receipt.archiveBatchId) !== firstText(files[0]?.archiveBatchId) ||
    firstText(receipt.ownerSubjectId) !== owner.subjectId ||
    firstText(receipt.ownerUserId) !== owner.userId ||
    firstText(receipt.ownerUsername) !== owner.username ||
    firstText(receipt.ownerRoleId) !== owner.roleId ||
    firstText(receipt.ownerTenantId) !== owner.tenantId ||
    expectedFiles.some((expected, index) =>
      firstText(files[index]?.archiveBatchId) !== firstText(receipt.archiveBatchId) ||
      firstText(expected?.name) !== firstText(files[index]?.name) ||
      firstText(expected?.relativePath) !== firstText(files[index]?.relativePath) ||
      expected?.sha256 !== files[index]?.contentDigest ||
      files[index]?.sha256 !== files[index]?.contentDigest ||
      Number(expected?.byteSize) !== Number(files[index]?.byteSize)
    )
  ) {
    throw adoptionError(
      "upload_session_adoption_binding_mismatch",
      "Upload session adoption does not match its checkpoint receipt."
    );
  }
  if (files.some((file) =>
    file?.custodyState !== "sealed_no_run" ||
    !file?.custodyRef ||
    !SHA256_PATTERN.test(String(file?.contentDigest || "")) ||
    !SHA256_PATTERN.test(String(file?.envelopeDigest || "")) ||
    !Number.isSafeInteger(Number(file?.byteSize)) ||
    Number(file?.byteSize) < 0
  )) {
    throw adoptionError(
      "upload_session_adoption_not_sealed",
      "Upload session adoption requires sealed custody objects."
    );
  }
  return files;
}

async function resolveBoundUploadSessionFiles(
  uploadSessionStore: { resolveUploadSessionFiles(sessionId: string, input: { owner: ReturnType<typeof uploadSessionOwnerFromPayload> }): Promise<unknown> },
  payload: PipelinePayload
) {
  if (!payload.uploadSessionId) {
    throw adoptionError("upload_session_not_found", "Upload session is unavailable.");
  }
  try {
    const files = await uploadSessionStore.resolveUploadSessionFiles(
      payload.uploadSessionId,
      { owner: uploadSessionOwnerFromPayload(payload) }
    );
    return validateUploadAdoptionBinding(payload, files);
  } catch (error) {
    if (errorProperty(error, "code") && errorProperty(error, "code") !== "upload_session_incomplete") throw error;
    const message = errorMessage(error);
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
  generatedAt = ""
}: {
  payload?: PipelinePayload; uploadSessionFiles?: UploadSessionFile[];
  storageProvider?: UploadConsumptionStorageProvider | null; jobId?: string; archiveBatchId?: string; generatedAt?: string;
} = {}) {
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
    const error = new Error("Upload session persistence requires the canonical storage provider.") as CodedError;
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  const receipt = validateUploadConsumptionReceipt(
    await storageProvider.commitUploadConsumptionReceipt({
      sessionId: payload.uploadSessionId,
      owner: uploadSessionOwnerFromPayload(payload),
      custodyDescriptors: uploadSessionFiles.map((file, index) => ({
        resourceRef: `upload-resource:${payload.uploadSessionId}:${index}`,
        custodyRef: file.custodyRef,
        custodyState: file.custodyState,
        contentDigest: file.contentDigest,
        envelopeDigest: file.envelopeDigest,
        byteSize: file.byteSize
      }))
    }),
    payload,
    uploadSessionFiles
  );
  const defaults = sourceDefaults(payload, generatedAt);
  return {
    receipt,
    sources: uploadSessionFiles.map((file, index) =>
      persistedUploadSource(file, receipt, index, defaults)
    )
  };
}

function collectIncomingSources({
  payload = {},
  persistedUploadSources = [],
  generatedAt = ""
}: { payload?: PipelinePayload; persistedUploadSources?: PipelineSource[]; generatedAt?: string }) {
  const defaults = sourceDefaults(payload, generatedAt);
  const canonicalSources = asArray(payload.canonicalObjectSources)
    .map((source) => normalizeCanonicalObjectSource(source))
    .map((source) => canonicalObjectPipelineSource(source, defaults));
  const inlineText =
    typeof payload.inputText === "string"
      ? payload.inputText
      : "";
  if (
    inlineText &&
    Buffer.byteLength(inlineText, "utf8") > DIRECT_TEXT_MAX_BYTES
  ) {
    const error = new Error("job_create_direct_text_too_large") as CodedError;
    error.code = "job_create_direct_text_too_large";
    throw error;
  }
  const inputKindCount =
    Number(Boolean(payload.uploadSessionId)) +
    Number(canonicalSources.length > 0) +
    Number(inlineText.trim().length > 0);
  if (inputKindCount > 1) {
    const error = new Error("job_pipeline_input_ambiguous") as CodedError;
    error.code = "job_pipeline_input_ambiguous";
    throw error;
  }
  const sources = [...persistedUploadSources, ...canonicalSources];
  if (inlineText) {
    sources.unshift(directTextSource(inlineText, defaults));
  }

  const warnings = [];
  const storedWithoutTextCount = persistedUploadSources.filter((source) => !sourceText(source)).length;
  if (storedWithoutTextCount > 0) {
    warnings.push(
      `${storedWithoutTextCount} uploaded file(s) were adopted as sealed custody references without normalized text; upstream processing may submit normalized text separately.`
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
}: {
  userDataPath: string; payload: PipelinePayload; runtime: Record<string, unknown>;
  storageProvider?: UploadConsumptionStorageProvider | null;
  uploadSessionStore?: { resolveUploadSessionFiles(sessionId: string, input: { owner: ReturnType<typeof uploadSessionOwnerFromPayload> }): Promise<unknown> } | null;
  reportProgress(message: Record<string, unknown>): void | Promise<void>;
  jobId: string; generatedAt: string; signal?: AbortSignal | null;
}) {
  const boundUploadSessionStore: unknown = payload?.uploadSessionId
    ? assertBoundUploadSessionStore(uploadSessionStore, { userDataPath })
    : null;
  const uploadResolver = boundUploadSessionStore &&
    typeof (boundUploadSessionStore as { resolveUploadSessionFiles?: unknown }).resolveUploadSessionFiles === "function"
      ? boundUploadSessionStore as { resolveUploadSessionFiles(sessionId: string, input: { owner: ReturnType<typeof uploadSessionOwnerFromPayload> }): Promise<unknown> }
      : null;
  if (
    payload?.uploadSessionId &&
    (!storageProvider ||
      typeof storageProvider.commitUploadConsumptionReceipt !== "function")
  ) {
    const error = new Error(
      "Upload session persistence requires the canonical storage provider."
    ) as CodedError;
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
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
    async run(context: PipelineContext) {
      throwIfAborted(context.signal);
      if (payload.uploadSessionId) {
        if (!uploadResolver) {
          throw adoptionError("upload_session_not_found", "Upload session is unavailable.");
        }
        context.uploadSessionFiles = await resolveBoundUploadSessionFiles(
          uploadResolver,
          payload
        );
      }
      throwIfAborted(context.signal);
      const persistedUpload = await persistUploadSessionSources({
        payload,
        uploadSessionFiles: context.uploadSessionFiles,
        storageProvider,
        jobId,
        archiveBatchId,
        generatedAt
      });
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
      const persistedUploadSources = persistedUpload.sources;
      throwIfAborted(context.signal);
      const incoming = collectIncomingSources({
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
        persistedUpload.receipt?.receiptId || ""
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
