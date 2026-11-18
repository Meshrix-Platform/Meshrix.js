import { createHash } from "node:crypto";
import { serverToken } from "#meshrix/client-strings";

const DIRECT_TEXT_MAX_BYTES: any = 1024 * 1024;
const SETTINGS_MAX_BYTES: any = 256 * 1024;
const PUBLIC_FIELDS: readonly any[] = Object.freeze([
  "checkpoint",
  "forceNewVersion",
  "inputText",
  "parentJobId",
  "settings",
  "uploadSessionId",
  "versionGroupId",
  "workspaceId"
]);
const PUBLIC_FIELD_SET: any = new Set<any>(PUBLIC_FIELDS);
const CHECKPOINT_FIELD_SET: any = new Set<any>(["checkpointId", "mode"]);
const IDENTIFIER_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function controlledError(code?: any) : any {
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

function normalizeIdentifier(value?: any, code?: any, maxLength: any = 256) : any {
  if (typeof value !== "string") {
    throw controlledError(code);
  }
  const normalized: any = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    !IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw controlledError(code);
  }
  return normalized;
}

function normalizeCheckpoint(value?: any) : any {
  if (!isPlainObject(value)) {
    throw controlledError("job_create_checkpoint_invalid");
  }
  for (const key of Object.keys(value)) {
    if (!CHECKPOINT_FIELD_SET.has(key)) {
      throw controlledError("job_create_checkpoint_unknown_field");
    }
  }
  const checkpoint: Record<string, any> = {};
  if (Object.hasOwn(value, "checkpointId")) {
    checkpoint.checkpointId = normalizeIdentifier(
      value.checkpointId,
      "job_create_checkpoint_invalid"
    );
  }
  if (Object.hasOwn(value, "mode")) {
    checkpoint.mode = normalizeIdentifier(
      value.mode,
      "job_create_checkpoint_invalid",
      128
    );
  }
  return checkpoint;
}

function normalizeSettings(value?: any) : any {
  if (!isPlainObject(value)) {
    throw controlledError("job_create_settings_invalid");
  }
  let serialized: any;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw controlledError("job_create_settings_invalid");
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > SETTINGS_MAX_BYTES
  ) {
    throw controlledError("job_create_settings_too_large");
  }
  return JSON.parse(serialized);
}

function normalizeOptionalIdentifier(payload?: any, field?: any) : any {
  if (!Object.hasOwn(payload, field)) {
    return "";
  }
  return normalizeIdentifier(payload[field], `job_create_${field}_invalid`);
}

function createDirectTextReceipt(
  inputText?: any,
  checkpoint: Record<string, any> = {},
  resolveArchiveBatchIdentity: any = defaultArchiveBatchResolver
) : any {
  const inputSha256: any = createHash("sha256")
    .update(inputText, "utf8")
    .digest("hex");
  const checkpointId: any = serverToken(
    "checkpoint",
    checkpoint.checkpointId || inputSha256,
    inputSha256
  );
  const archiveBatch: any = resolveArchiveBatchIdentity({
    checkpointId,
    manifestDigest: inputSha256
  });
  return {
    checkpointId,
    archiveBatchId: normalizeIdentifier(
      archiveBatch?.archiveBatchId,
      "job_create_archive_batch_identity_invalid"
    ),
    clientUid: "",
    sourceType: "direct-text",
    providerId: "",
    externalId: "",
    syncBatchId: "",
    contentHash: inputSha256,
    capturedAt: "",
    manifestSha256: inputSha256,
    fileCount: 0,
    files: []
  };
}

export function defaultArchiveBatchResolver(input: Record<string, any> = {}) : any {
  if (!isPlainObject(input)) {
    throw controlledError("job_create_archive_batch_identity_invalid");
  }
  const allowed: any = new Set<any>(["archiveBatchId", "checkpointId", "manifestDigest"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw controlledError("job_create_archive_batch_identity_invalid");
    }
  }
  const archiveBatchId: any = Object.hasOwn(input, "archiveBatchId")
    ? normalizeIdentifier(
        input.archiveBatchId,
        "job_create_archive_batch_identity_invalid"
      )
    : "";
  if (archiveBatchId) {
    return { archiveBatchId };
  }
  const checkpointId: any = normalizeIdentifier(
    input.checkpointId,
    "job_create_archive_batch_identity_invalid"
  );
  const manifestDigest: any = normalizeIdentifier(
    input.manifestDigest,
    "job_create_archive_batch_identity_invalid"
  );
  return {
    archiveBatchId: serverToken(
      "archive_batch",
      checkpointId,
      manifestDigest
    )
  };
}

export function admitJobCreatePayload(
  input: Record<string, any> = {},
  { resolveArchiveBatchIdentity = defaultArchiveBatchResolver }: Record<string, any> = {}
) : any {
  if (!isPlainObject(input)) {
    throw controlledError("job_create_payload_invalid");
  }
  if (typeof resolveArchiveBatchIdentity !== "function") {
    throw controlledError("job_create_archive_batch_identity_invalid");
  }
  for (const key of Object.keys(input)) {
    if (!PUBLIC_FIELD_SET.has(key)) {
      throw controlledError("job_create_payload_unknown_field");
    }
  }

  const hasUploadSession: any = Object.hasOwn(input, "uploadSessionId");
  const hasInputText: any = Object.hasOwn(input, "inputText");
  if (hasUploadSession && hasInputText) {
    throw controlledError("job_create_input_ambiguous");
  }
  if (!hasUploadSession && !hasInputText) {
    throw controlledError("job_create_input_required");
  }

  const payload: Record<string, any> = {};
  if (Object.hasOwn(input, "checkpoint")) {
    payload.checkpoint = normalizeCheckpoint(input.checkpoint);
  }
  if (Object.hasOwn(input, "forceNewVersion")) {
    if (typeof input.forceNewVersion !== "boolean") {
      throw controlledError("job_create_forceNewVersion_invalid");
    }
    payload.forceNewVersion = input.forceNewVersion;
  }
  for (const field of [
    "parentJobId",
    "versionGroupId",
    "workspaceId"
  ]) {
    const normalized: any = normalizeOptionalIdentifier(input, field);
    if (normalized) {
      payload[field] = normalized;
    }
  }
  payload.settings = Object.hasOwn(input, "settings")
    ? normalizeSettings(input.settings)
    : {};

  if (hasUploadSession) {
    payload.uploadSessionId = normalizeIdentifier(
      input.uploadSessionId,
      "job_create_upload_session_id_invalid"
    );
    return {
      kind: "upload-session",
      uploadSessionId: payload.uploadSessionId,
      payload
    };
  }

  if (typeof input.inputText !== "string" || input.inputText.trim().length === 0) {
    throw controlledError("job_create_direct_text_invalid");
  }
  if (Buffer.byteLength(input.inputText, "utf8") > DIRECT_TEXT_MAX_BYTES) {
    throw controlledError("job_create_direct_text_too_large");
  }
  payload.inputText = input.inputText;
  return {
    kind: "direct-text",
    payload,
    receipt: createDirectTextReceipt(
      payload.inputText,
      payload.checkpoint,
      resolveArchiveBatchIdentity
    )
  };
}
