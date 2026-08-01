import { createHash } from "node:crypto";

export const SERVICE_MANIFEST_SCHEMA_VERSION: any = "v0.0.1:storage:service-manifest-1";

const OPAQUE_SERVICE_ID_PATTERN: any = /^svc_[A-Za-z0-9_-]{16,96}$/u;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const REFERENCE_PATTERN: any = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/-]+$/u;
const SAFE_TOKEN_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_HOST_PATTERN: any = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u;
const FORBIDDEN_OBJECT_KEY_PATTERN: any = /(?:password|passphrase|secret(?:value|material)?|access[_-]?token|refresh[_-]?token|authorization|cookie|ciphertext|private[_-]?key(?:body|bytes|pem)?|certificate(?:body|bytes|pem)|trust[_-]?anchor(?:body|bytes|pem)?|raw[_-]?(?:request|body|payload|content)|resolved[_-]?(?:credential|secret|material)|environment[_-]?(?:variables?|material)|provider[_-]?(?:credential|token))/iu;
const FORBIDDEN_VALUE_PATTERNS: any[] = [
  /-----BEGIN [A-Z0-9 ]+-----/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/iu,
  /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\u0000/u
];

function looksLikeHighEntropyBase64(value?: any) : any {
  if (value.length < 256 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const bytes: any = Buffer.from(value, "base64");
  if (bytes.length < 192) return false;
  const frequencies: any = new Uint32Array(256);
  for (const byte of bytes) frequencies[byte] += 1;
  let distinct: any = 0;
  let entropy: any = 0;
  for (const count of frequencies) {
    if (count === 0) continue;
    distinct += 1;
    const probability: any = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return distinct >= 32 && entropy >= 4.5;
}

const REFERENCE_SCHEMES: Readonly<Record<string, any>> = Object.freeze({
  credential: new Set<any>(["credential", "secret"]),
  certificate: new Set<any>(["certificate"]),
  "private-key": new Set<any>(["private-key"]),
  "trust-anchor": new Set<any>(["trust-anchor"])
});

const MANIFEST_TOP_LEVEL_KEYS: any = new Set<any>([
  "schemaVersion",
  "references",
  "payload",
  "metadata"
]);

const REFERENCE_KEYS: any = new Set<any>([
  "type",
  "reference",
  "revision",
  "use",
  "operationKey",
  "host",
  "protocol",
  "scopes"
]);

const DEFAULT_BUDGET: Readonly<Record<string, any>> = Object.freeze({
  maxManifestBytes: 256 * 1024,
  maxManifestNodes: 10_000,
  maxReferenceCount: 128,
  maxServices: 2_048,
  maxRequestRecords: 8_192,
  maxRequestBytes: 8 * 1024 * 1024,
  maxReadBytes: 32 * 1024 * 1024,
  maxWriteBytes: 4 * 1024 * 1024,
  maxFiles: 8_256,
  maxCleanupEntries: 256,
  maxOperationMs: 30_000
});

const HARD_BUDGET: Readonly<Record<string, any>> = Object.freeze({
  maxManifestBytes: 1024 * 1024,
  maxManifestNodes: 50_000,
  maxReferenceCount: 512,
  maxServices: 8_192,
  maxRequestRecords: 32_768,
  maxRequestBytes: 64 * 1024 * 1024,
  maxReadBytes: 128 * 1024 * 1024,
  maxWriteBytes: 16 * 1024 * 1024,
  maxFiles: 40_000,
  maxCleanupEntries: 2_048,
  maxOperationMs: 120_000
});

const BUDGET_KEYS: any = new Set<any>(Object.keys(DEFAULT_BUDGET));

export function serviceManifestError(code?: any, message?: any, cause?: any) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertPlainObject(value?: any, code?: any, message?: any) : any {
  const prototype: any = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw serviceManifestError(code, message);
  }
  return value;
}

function normalizeSafeString(value?: any, field?: any, { maxLength = 512, pattern = null }: Record<string, any> = {}) : any {
  if (typeof value !== "string") {
    throw serviceManifestError(
      "storage_manifest_schema_invalid",
      `Service manifest ${field} must be a string.`
    );
  }
  const normalized: any = value.normalize("NFC");
  if (!normalized || normalized !== value || normalized.length > maxLength || (pattern && !pattern.test(normalized))) {
    throw serviceManifestError(
      "storage_manifest_schema_invalid",
      `Service manifest ${field} is invalid.`
    );
  }
  if (FORBIDDEN_VALUE_PATTERNS.some((candidate?: any) : any => candidate.test(normalized)) || looksLikeHighEntropyBase64(normalized)) {
    throw serviceManifestError(
      "storage_manifest_sensitive_material",
      `Service manifest ${field} contains material that must be represented by a typed reference.`
    );
  }
  return normalized;
}

export function validateOpaqueServiceId(value?: any) : any {
  if (typeof value !== "string" || value.normalize("NFC") !== value || !OPAQUE_SERVICE_ID_PATTERN.test(value)) {
    throw serviceManifestError(
      "storage_manifest_service_id_invalid",
      "Service manifest identity must be a canonical opaque service identifier."
    );
  }
  return value;
}

export function validateManifestDigest(value?: any, field: any = "digest") : any {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw serviceManifestError(
      "storage_manifest_digest_invalid",
      `Service manifest ${field} must be a lowercase SHA-256 digest.`
    );
  }
  return value;
}

export function validateManifestRevision(value?: any, field?: any) : any {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceManifestError(
      "storage_manifest_revision_invalid",
      `Service manifest ${field} must be a non-negative safe integer.`
    );
  }
  return value;
}

export function normalizeManifestResourceBudget(input: Record<string, any> = {}) : any {
  assertPlainObject(
    input,
    "storage_manifest_budget_invalid",
    "Service manifest resource budget must be an object."
  );
  for (const key of Object.keys(input)) {
    if (!BUDGET_KEYS.has(key)) {
      throw serviceManifestError(
        "storage_manifest_budget_invalid",
        "Service manifest resource budget contains an unsupported field."
      );
    }
  }
  const normalized: Record<string, any> = {};
  for (const key of BUDGET_KEYS) {
    const value: any = input[key] ?? DEFAULT_BUDGET[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_BUDGET[key]) {
      throw serviceManifestError(
        "storage_manifest_budget_invalid",
        `Service manifest resource budget ${key} is outside the supported range.`
      );
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function normalizeReference(reference?: any) : any {
  assertPlainObject(
    reference,
    "storage_manifest_reference_invalid",
    "Service manifest references must be objects."
  );
  for (const key of Object.keys(reference)) {
    if (!REFERENCE_KEYS.has(key)) {
      throw serviceManifestError(
        "storage_manifest_reference_invalid",
        "Service manifest reference contains an unsupported field."
      );
    }
  }
  const type: any = normalizeSafeString(reference.type, "reference type", {
    maxLength: 32,
    pattern: /^(?:credential|certificate|private-key|trust-anchor)$/u
  });
  const referenceValue: any = normalizeSafeString(reference.reference, "reference value", {
    maxLength: 512,
    pattern: REFERENCE_PATTERN
  });
  const scheme: any = referenceValue.slice(0, referenceValue.indexOf(":"));
  if (!REFERENCE_SCHEMES[type].has(scheme) || referenceValue.includes("@") || referenceValue.includes("?") || referenceValue.includes("#")) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest reference scheme does not match its declared type."
    );
  }
  if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest reference revision must be a positive safe integer."
    );
  }
  const normalized: Record<string, any> = {
    type,
    reference: referenceValue,
    revision: reference.revision,
    use: normalizeSafeString(reference.use, "reference use", {
      maxLength: 128,
      pattern: SAFE_TOKEN_PATTERN
    })
  };
  if (reference.operationKey !== undefined) {
    normalized.operationKey = normalizeSafeString(reference.operationKey, "reference operation key", {
      maxLength: 128,
      pattern: SAFE_TOKEN_PATTERN
    });
  }
  if (reference.host !== undefined) {
    normalized.host = normalizeSafeString(reference.host, "reference host", {
      maxLength: 253,
      pattern: SAFE_HOST_PATTERN
    }).toLowerCase();
  }
  if (reference.protocol !== undefined) {
    normalized.protocol = normalizeSafeString(reference.protocol, "reference protocol", {
      maxLength: 32,
      pattern: /^[a-z][a-z0-9+.-]{0,31}$/u
    });
  }
  if (reference.scopes !== undefined) {
    if (!Array.isArray(reference.scopes) || reference.scopes.length > 128) {
      throw serviceManifestError(
        "storage_manifest_reference_invalid",
        "Service manifest reference scopes must be a bounded array."
      );
    }
    const scopes: any = reference.scopes.map((scope?: any) : any => normalizeSafeString(scope, "reference scope", {
      maxLength: 128,
      pattern: SAFE_TOKEN_PATTERN
    }));
    if (new Set<any>(scopes).size !== scopes.length) {
      throw serviceManifestError(
        "storage_manifest_reference_invalid",
        "Service manifest reference scopes must be unique."
      );
    }
    normalized.scopes = scopes.sort();
  }
  return normalized;
}

function normalizeJsonValue(value?: any, context?: any, path: any = "manifest", depth: any = 0, schemaContext: any = false) : any {
  context.nodes += 1;
  if (context.nodes > context.budget.maxManifestNodes || depth > 32) {
    throw serviceManifestError(
      "storage_manifest_budget_exceeded",
      "Service manifest structure exceeds its resource budget."
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw serviceManifestError(
        "storage_manifest_schema_invalid",
        "Service manifest numbers must be finite."
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return normalizeSafeString(value, path, { maxLength: 8_192 });
  }
  if (Array.isArray(value)) {
    return value.map((item?: any, index?: any) : any => normalizeJsonValue(item, context, `${path}[${index}]`, depth + 1, schemaContext));
  }
  assertPlainObject(
    value,
    "storage_manifest_schema_invalid",
    "Service manifest values must contain only JSON objects and arrays."
  );
  const normalized: Record<string, any> = {};
  const keys: any = Object.keys(value).sort();
  for (const key of keys) {
    if (
      key.normalize("NFC") !== key ||
      !key ||
      key.length > 128 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      throw serviceManifestError(
        "storage_manifest_schema_invalid",
        "Service manifest contains an invalid object key."
      );
    }
    const schemaPropertyName: any = schemaContext && path.endsWith(".properties");
    if (!schemaPropertyName && FORBIDDEN_OBJECT_KEY_PATTERN.test(key)) {
      throw serviceManifestError(
        "storage_manifest_sensitive_material",
        "Service manifest sensitive material must be represented by a typed reference."
      );
    }
    normalized[key] = normalizeJsonValue(
      value[key],
      context,
      `${path}.${key}`,
      depth + 1,
      schemaContext || key.endsWith("Schema")
    );
  }
  return normalized;
}

export function stableManifestJson(value?: any) : any {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableManifestJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableManifestJson(value[key])}`).join(",")}}`;
}

export function sha256ManifestBytes(bytes?: any) : any {
  return createHash("sha256").update(bytes).digest("hex");
}

export function deepFreezeManifest(value?: any) : any {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of (Object.values(value) as any[])) deepFreezeManifest(child);
  return Object.freeze(value);
}

export function canonicalizeTypedReferenceManifest(value?: any, budgetInput: Record<string, any> = {}) : any {
  const budget: any = Object.isFrozen(budgetInput) && BUDGET_KEYS.size === Object.keys(budgetInput).length
    ? budgetInput
    : normalizeManifestResourceBudget(budgetInput);
  assertPlainObject(
    value,
    "storage_manifest_schema_invalid",
    "Service manifest must be an object."
  );
  for (const key of Object.keys(value)) {
    if (!MANIFEST_TOP_LEVEL_KEYS.has(key)) {
      throw serviceManifestError(
        "storage_manifest_schema_invalid",
        "Service manifest contains an unsupported top-level field."
      );
    }
  }
  if (value.schemaVersion !== SERVICE_MANIFEST_SCHEMA_VERSION || !Array.isArray(value.references)) {
    throw serviceManifestError(
      "storage_manifest_schema_invalid",
      "Service manifest schemaVersion and references are required."
    );
  }
  if (value.references.length > budget.maxReferenceCount) {
    throw serviceManifestError(
      "storage_manifest_budget_exceeded",
      "Service manifest reference count exceeds its resource budget."
    );
  }
  assertPlainObject(
    value.payload,
    "storage_manifest_schema_invalid",
    "Service manifest payload must be an object."
  );
  const references: any = value.references.map(normalizeReference);
  references.sort((left?: any, right?: any) : any => stableManifestJson(left).localeCompare(stableManifestJson(right)));
  const referenceKeys: any = references.map(stableManifestJson);
  if (new Set<any>(referenceKeys).size !== referenceKeys.length) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest references must be unique."
    );
  }
  const context: Record<string, any> = { budget, nodes: 0 };
  const normalized: Record<string, any> = {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    references,
    payload: normalizeJsonValue(value.payload, context, "manifest.payload")
  };
  if (value.metadata !== undefined) {
    assertPlainObject(
      value.metadata,
      "storage_manifest_schema_invalid",
      "Service manifest metadata must be an object."
    );
    normalized.metadata = normalizeJsonValue(value.metadata, context, "manifest.metadata");
  }
  const canonicalBytes: any = Buffer.from(stableManifestJson(normalized), "utf8");
  if (canonicalBytes.length > budget.maxManifestBytes) {
    throw serviceManifestError(
      "storage_manifest_budget_exceeded",
      "Service manifest bytes exceed its resource budget."
    );
  }
  return Object.freeze({
    manifest: deepFreezeManifest(normalized),
    canonicalBytes,
    manifestDigest: sha256ManifestBytes(canonicalBytes),
    referenceCount: references.length
  });
}

export function createDurableManifestWriterPort(commitManifestSet?: any) : any {
  if (typeof commitManifestSet !== "function") {
    throw new TypeError("DurableManifestWriterPort requires commitManifestSet.");
  }
  return Object.freeze({ commitManifestSet });
}

export function createManifestSnapshotReaderPort(getSnapshot?: any) : any {
  if (typeof getSnapshot !== "function") {
    throw new TypeError("ManifestSnapshotReaderPort requires getSnapshot.");
  }
  return Object.freeze({ getSnapshot });
}

export function createManifestCandidateAuthorityPort({
  getCandidateSnapshot,
  acknowledgePublished
}: Record<string, any> = {}) : any {
  if (typeof getCandidateSnapshot !== "function" || typeof acknowledgePublished !== "function") {
    throw new TypeError(
      "ManifestCandidateAuthorityPort requires candidate read and publication acknowledgement operations."
    );
  }
  return Object.freeze({ getCandidateSnapshot, acknowledgePublished });
}
