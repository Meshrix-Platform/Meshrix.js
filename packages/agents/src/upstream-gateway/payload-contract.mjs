import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import {
  isUpstreamRequestRepresentationMode,
  isUpstreamResponseRepresentationMode
} from "@lico/contracts/upstream-service-publishing";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/u;
const SAFE_MAPPING_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

const REQUEST_REPRESENTATION_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-type",
  "digest",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "prefer",
  "range"
]);

const RESPONSE_REPRESENTATION_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "digest",
  "etag",
  "expires",
  "last-modified",
  "location",
  "vary"
]);

function payloadError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.reasonCode = code;
  error.status = status;
  return error;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveBytes(value, label, ceiling = MAX_PAYLOAD_BYTES) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > ceiling) {
    throw payloadError("payload_representation_invalid", `${label} must be a positive bounded byte count.`);
  }
  return number;
}

function uniqueMediaTypes(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw payloadError("payload_representation_invalid", `${label} must contain at least one media type.`);
  }
  const normalized = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()))];
  if (normalized.some((entry) => !MEDIA_TYPE.test(entry))) {
    throw payloadError("payload_representation_invalid", `${label} contains an invalid media type.`);
  }
  return Object.freeze(normalized);
}

function safeMappingName(value, label) {
  const normalized = String(value || "").trim();
  if (!SAFE_MAPPING_NAME.test(normalized)) {
    throw payloadError("payload_mapping_unsafe", `${label} is invalid.`);
  }
  return normalized;
}

function compileMultipartMapping(value) {
  const mapping = plainObject(value);
  const rawArtifactParts = Array.isArray(mapping.artifactParts) ? mapping.artifactParts : [];
  if (rawArtifactParts.length === 0 || rawArtifactParts.length > 32) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart requires between one and 32 artifact parts.");
  }
  const artifactParts = rawArtifactParts.map((entry, index) => {
    const part = plainObject(entry);
    const multiple = part.multiple === true;
    const maxCount = multiple ? Number(part.maxCount) : 1;
    if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 32) {
      throw payloadError("payload_mapping_unsafe", `artifact part ${index + 1} has an invalid maxCount.`);
    }
    return Object.freeze({
      argument: safeMappingName(part.argument, `artifact part ${index + 1} argument`),
      partName: safeMappingName(part.partName, `artifact part ${index + 1} partName`),
      required: part.required !== false,
      multiple,
      maxCount
    });
  });
  const scalarFields = (Array.isArray(mapping.scalarFields) ? mapping.scalarFields : []).map((entry, index) => {
    const field = plainObject(entry);
    return Object.freeze({
      argument: safeMappingName(field.argument, `scalar field ${index + 1} argument`),
      partName: safeMappingName(field.partName, `scalar field ${index + 1} partName`),
      required: field.required === true
    });
  });
  if (scalarFields.length > 64) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart has too many scalar fields.");
  }
  const maxParts = Number(mapping.maxParts);
  if (!Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 96) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart maxParts is invalid.");
  }
  const declaredMaximum = scalarFields.length + artifactParts.reduce((sum, part) => sum + part.maxCount, 0);
  if (declaredMaximum > maxParts) {
    throw payloadError("payload_policy_conflict", "artifact_multipart mappings can exceed maxParts.");
  }
  return Object.freeze({
    artifactParts: Object.freeze(artifactParts),
    scalarFields: Object.freeze(scalarFields),
    maxParts
  });
}

export function compilePayloadTransport(operation = {}) {
  const source = plainObject(operation.payloadTransport);
  const request = plainObject(source.request);
  const response = plainObject(source.response);
  if (!isUpstreamRequestRepresentationMode(request.mode)) {
    throw payloadError("payload_representation_invalid", "Operation request representation mode is required.");
  }
  if (!isUpstreamResponseRepresentationMode(response.mode)) {
    throw payloadError("payload_representation_invalid", "Operation response representation mode is required.");
  }
  const compiledRequest = {
    mode: request.mode,
    maxBytes: positiveBytes(request.maxBytes, "payloadTransport.request.maxBytes"),
    mediaTypes: uniqueMediaTypes(request.mediaTypes, "payloadTransport.request.mediaTypes")
  };
  if (request.mode === "artifact_body") {
    compiledRequest.artifactArgument = safeMappingName(
      request.artifactArgument,
      "payloadTransport.request.artifactArgument"
    );
  }
  if (request.mode === "artifact_multipart") {
    compiledRequest.multipart = compileMultipartMapping(request.multipart);
  }
  const compiledResponse = {
    mode: response.mode,
    maxBytes: positiveBytes(response.maxBytes, "payloadTransport.response.maxBytes"),
    mediaTypes: uniqueMediaTypes(response.mediaTypes, "payloadTransport.response.mediaTypes"),
    allowRanges: response.allowRanges === true
  };
  if (request.mode === "structured_json" && !compiledRequest.mediaTypes.includes("application/json")) {
    throw payloadError("payload_policy_conflict", "structured_json request mode must accept application/json.");
  }
  if (response.mode === "structured_json" && !compiledResponse.mediaTypes.includes("application/json")) {
    throw payloadError("payload_policy_conflict", "structured_json response mode must accept application/json.");
  }
  return Object.freeze({
    request: Object.freeze(compiledRequest),
    response: Object.freeze(compiledResponse)
  });
}

function entriesFromHeaders(headers = {}) {
  if (typeof headers?.entries === "function") return [...headers.entries()];
  return Object.entries(headers);
}

function headerValue(value) {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value ?? "");
}

function normalizedMediaType(value = "") {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

export function mediaTypeAllowed(value, accepted = []) {
  const mediaType = normalizedMediaType(value);
  if (!mediaType) return false;
  return accepted.some((candidate) => {
    if (candidate === "*/*") return true;
    if (candidate.endsWith("/*")) return mediaType.startsWith(candidate.slice(0, -1));
    return candidate === mediaType;
  });
}

function selectHeaders(headers, allowedNames) {
  const selected = {};
  for (const [rawName, rawValue] of entriesFromHeaders(headers)) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!allowedNames.has(name)) continue;
    const value = headerValue(rawValue).trim();
    if (!value || /[\r\n]/u.test(value)) continue;
    selected[name] = value;
  }
  return selected;
}

export function selectRequestRepresentationHeaders(headers = {}, requestPolicy = {}, { hasBody = true } = {}) {
  const selected = selectHeaders(headers, REQUEST_REPRESENTATION_HEADERS);
  const contentType = selected["content-type"] || "application/octet-stream";
  if (hasBody && !mediaTypeAllowed(contentType, requestPolicy.mediaTypes || [])) {
    throw payloadError("unsupported_media_type", "Request media type is outside the published operation policy.", 415);
  }
  return Object.freeze(selected);
}

export function selectResponseRepresentationHeaders(headers = {}, responsePolicy = {}) {
  const selected = selectHeaders(headers, RESPONSE_REPRESENTATION_HEADERS);
  const contentType = selected["content-type"] || "application/octet-stream";
  if (!mediaTypeAllowed(contentType, responsePolicy.mediaTypes || [])) {
    throw payloadError("unsupported_media_type", "Upstream response media type is outside the published operation policy.", 502);
  }
  if (!responsePolicy.allowRanges) {
    delete selected["accept-ranges"];
    delete selected["content-range"];
  }
  return Object.freeze(selected);
}

export function createPayloadCountingTransform(maxBytes, {
  tooLargeCode,
  tooLargeStatus = 413
} = {}) {
  const limit = positiveBytes(maxBytes, "payload byte limit");
  let byteLength = 0;
  const digest = createHash("sha256");
  let digestValue = "";
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > limit) {
        callback(payloadError(
          tooLargeCode || "payload_too_large",
          "Payload exceeds the published operation limit.",
          tooLargeStatus
        ));
        return;
      }
      digest.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      digestValue = digest.digest("hex");
      callback();
    }
  });
  Object.defineProperties(transform, {
    byteLength: { get: () => byteLength },
    sha256: { get: () => digestValue }
  });
  return transform;
}

export function payloadRepresentationError(code, message, status = 400) {
  return payloadError(code, message, status);
}
