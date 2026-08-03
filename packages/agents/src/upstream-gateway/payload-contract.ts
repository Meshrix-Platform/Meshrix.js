import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import {
  isUpstreamRequestRepresentationMode,
  isUpstreamResponseRepresentationMode
} from "@meshrix/contracts/upstream-service-publishing";

const MAX_PAYLOAD_BYTES: any = 2 * 1024 * 1024 * 1024;
const DEFAULT_RESPONSE_MAX_BYTES: any = 8 * 1024 * 1024;
const MEDIA_TYPE: any = /^[A-Za-z0-9!#$&^_.+-]+\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/u;
const SAFE_MAPPING_NAME: any = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

const REQUEST_REPRESENTATION_HEADERS: any = new Set<any>([
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

const RESPONSE_REPRESENTATION_HEADERS: any = new Set<any>([
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
  "vary"
]);

function payloadError(code?: any, message?: any, status: any = 400) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.reasonCode = code;
  error.status = status;
  return error;
}

function plainObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveBytes(value?: any, label?: any, ceiling: any = MAX_PAYLOAD_BYTES) : any {
  const number: any = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > ceiling) {
    throw payloadError("payload_representation_invalid", `${label} must be a positive bounded byte count.`);
  }
  return number;
}

function uniqueMediaTypes(value?: any, label?: any, { allowWildcard = false }: Record<string, any> = {}) : any {
  if (!Array.isArray(value) || value.length === 0) {
    throw payloadError("payload_representation_invalid", `${label} must contain at least one media type.`);
  }
  const normalized: any[] = [...new Set<any>(value.map((entry?: any) : any => String(entry || "").trim().toLowerCase()))];
  if (normalized.some((entry?: any) : any => !(allowWildcard && entry === "*/*") && !MEDIA_TYPE.test(entry))) {
    throw payloadError("payload_representation_invalid", `${label} contains an invalid media type.`);
  }
  return Object.freeze(normalized);
}

function safeMappingName(value?: any, label?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!SAFE_MAPPING_NAME.test(normalized)) {
    throw payloadError("payload_mapping_unsafe", `${label} is invalid.`);
  }
  return normalized;
}

function compileMultipartMapping(value?: any) : any {
  const mapping: any = plainObject(value);
  const rawArtifactParts: any = Array.isArray(mapping.artifactParts) ? mapping.artifactParts : [];
  if (rawArtifactParts.length === 0 || rawArtifactParts.length > 32) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart requires between one and 32 artifact parts.");
  }
  const artifactParts: any = rawArtifactParts.map((entry?: any, index?: any) : any => {
    const part: any = plainObject(entry);
    const multiple: any = part.multiple === true;
    const maxCount: any = multiple ? Number(part.maxCount) : 1;
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
  const scalarFields: any = (Array.isArray(mapping.scalarFields) ? mapping.scalarFields : []).map((entry?: any, index?: any) : any => {
    const field: any = plainObject(entry);
    return Object.freeze({
      argument: safeMappingName(field.argument, `scalar field ${index + 1} argument`),
      partName: safeMappingName(field.partName, `scalar field ${index + 1} partName`),
      required: field.required === true
    });
  });
  if (scalarFields.length > 64) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart has too many scalar fields.");
  }
  const maxParts: any = Number(mapping.maxParts);
  if (!Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 96) {
    throw payloadError("payload_mapping_unsafe", "artifact_multipart maxParts is invalid.");
  }
  const declaredMaximum: any = scalarFields.length + artifactParts.reduce((sum?: any, part?: any) : any => sum + part.maxCount, 0);
  if (declaredMaximum > maxParts) {
    throw payloadError("payload_policy_conflict", "artifact_multipart mappings can exceed maxParts.");
  }
  return Object.freeze({
    artifactParts: Object.freeze(artifactParts),
    scalarFields: Object.freeze(scalarFields),
    maxParts
  });
}

export function compilePayloadTransport(operation: Record<string, any> = {}) : any {
  const source: any = plainObject(operation.payloadTransport);
  const request: any = plainObject(source.request);
  const response: any = source.response === undefined
    ? {
        mode: "opaque_stream",
        maxBytes: DEFAULT_RESPONSE_MAX_BYTES,
        mediaTypes: ["*/*"]
      }
    : plainObject(source.response);
  if (!isUpstreamRequestRepresentationMode(request.mode)) {
    throw payloadError("payload_representation_invalid", "Operation request representation mode is required.");
  }
  if (!isUpstreamResponseRepresentationMode(response.mode)) {
    throw payloadError("payload_representation_invalid", "Operation response representation mode is required.");
  }
  const compiledRequest: Record<string, any> = {
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
  const compiledResponse: Record<string, any> = {
    mode: response.mode,
    maxBytes: positiveBytes(response.maxBytes, "payloadTransport.response.maxBytes"),
    mediaTypes: uniqueMediaTypes(response.mediaTypes, "payloadTransport.response.mediaTypes", { allowWildcard: true }),
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

function entriesFromHeaders(headers: Record<string, any> = {}) : any {
  if (typeof headers?.entries === "function") return [...headers.entries()];
  return (Object.entries(headers) as [string, any][]);
}

function headerValue(value?: any) : any {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value ?? "");
}

function normalizedMediaType(value: any = "") : any {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

export function mediaTypeAllowed(value?: any, accepted: any = []) : any {
  const mediaType: any = normalizedMediaType(value);
  if (!mediaType) return false;
  return accepted.some((candidate?: any) : any => {
    if (candidate === "*/*") return true;
    if (candidate.endsWith("/*")) return mediaType.startsWith(candidate.slice(0, -1));
    return candidate === mediaType;
  });
}

function selectHeaders(headers?: any, allowedNames?: any) : any {
  const selected: Record<string, any> = {};
  for (const [rawName, rawValue] of entriesFromHeaders(headers)) {
    const name: any = String(rawName || "").trim().toLowerCase();
    if (!allowedNames.has(name)) continue;
    const value: any = headerValue(rawValue).trim();
    if (!value || /[\r\n]/u.test(value)) continue;
    selected[name] = value;
  }
  return selected;
}

export function selectRequestRepresentationHeaders(headers: Record<string, any> = {}, requestPolicy: Record<string, any> = {}, { hasBody = true }: Record<string, any> = {}) : any {
  const selected: any = selectHeaders(headers, REQUEST_REPRESENTATION_HEADERS);
  const contentType: any = selected["content-type"] || "application/octet-stream";
  if (hasBody && !mediaTypeAllowed(contentType, requestPolicy.mediaTypes || [])) {
    throw payloadError("unsupported_media_type", "Request media type is outside the published operation policy.", 415);
  }
  return Object.freeze(selected);
}

export function selectResponseRepresentationHeaders(headers: Record<string, any> = {}, responsePolicy: Record<string, any> = {}) : any {
  const selected: any = selectHeaders(headers, RESPONSE_REPRESENTATION_HEADERS);
  const contentType: any = selected["content-type"] || "application/octet-stream";
  if (!mediaTypeAllowed(contentType, responsePolicy.mediaTypes || [])) {
    throw payloadError("unsupported_media_type", "Upstream response media type is outside the published operation policy.", 502);
  }
  if (!responsePolicy.allowRanges) {
    delete selected["accept-ranges"];
    delete selected["content-range"];
  }
  return Object.freeze(selected);
}

export function createPayloadCountingTransform(maxBytes?: any, {
  tooLargeCode,
  tooLargeStatus = 413
}: Record<string, any> = {}) : any {
  const limit: any = positiveBytes(maxBytes, "payload byte limit");
  let byteLength: any = 0;
  const digest: any = createHash("sha256");
  let digestValue: any = "";
  const transform: any = new Transform({
    transform(chunk?: any, _encoding?: any, callback?: any) : any {
      const bytes: any = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
    flush(callback?: any) : any {
      digestValue = digest.digest("hex");
      callback();
    }
  });
  Object.defineProperties(transform, {
    byteLength: { get: () : any => byteLength },
    sha256: { get: () : any => digestValue }
  });
  return transform;
}

export function assertDeclaredSha256Digest(headers: Record<string, any> = {}, computedHex: any = "", kind: any = "payload") : any {
  const declared: any = headerValue(
    typeof headers?.get === "function" ? headers.get("digest") : headers?.digest
  ).trim();
  if (!declared) return;
  const entry: any = declared
    .split(",")
    .map((value?: any) : any => value.trim())
    .find((value?: any) : any => /^sha-?256=/iu.test(value));
  if (!entry) {
    throw payloadError(
      `${kind}_digest_unsupported`,
      `Declared ${kind} digest does not contain SHA-256.`,
      kind === "request" ? 400 : 502
    );
  }
  const encoded: any = entry.slice(entry.indexOf("=") + 1).trim().replace(/^:|:$/gu, "").replace(/^"|"$/gu, "");
  const normalizedHex: any = String(computedHex || "").trim().toLowerCase();
  const computedBase64: any = /^[a-f0-9]{64}$/u.test(normalizedHex)
    ? Buffer.from(normalizedHex, "hex").toString("base64")
    : "";
  if (!normalizedHex || ![normalizedHex, computedBase64].includes(encoded)) {
    throw payloadError(
      `${kind}_digest_mismatch`,
      `Declared ${kind} digest does not match the streamed bytes.`,
      kind === "request" ? 400 : 502
    );
  }
}

export function payloadRepresentationError(code?: any, message?: any, status: any = 400) : any {
  return payloadError(code, message, status);
}
