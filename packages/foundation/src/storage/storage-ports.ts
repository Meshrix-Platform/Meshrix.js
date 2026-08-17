import { createHash } from "node:crypto";

export const SERVICE_MANIFEST_SCHEMA_VERSION = "v0.0.1:storage:service-manifest-1";

type JsonPrimitive = string | number | boolean | null;
export type ManifestJsonValue = JsonPrimitive | ManifestJsonValue[] | { [key: string]: ManifestJsonValue };
type JsonRecord = Record<string, unknown>;
type ReferenceType = "credential" | "certificate" | "private-key" | "trust-anchor";

export interface ManifestResourceBudget {
  maxManifestBytes: number;
  maxManifestNodes: number;
  maxReferenceCount: number;
  maxServices: number;
  maxRequestRecords: number;
  maxRequestBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxFiles: number;
  maxCleanupEntries: number;
  maxOperationMs: number;
}

export interface TypedManifestReference {
  type: ReferenceType;
  reference: string;
  revision: number;
  use: string;
  operationKey?: string;
  host?: string;
  protocol?: string;
  scopes?: string[];
}

export interface CanonicalManifestResult {
  manifest: Readonly<Record<string, unknown>>;
  canonicalBytes: Buffer;
  manifestDigest: string;
  referenceCount: number;
}

type ServiceManifestError = Error & { code: string };
type ManifestContext = { budget: Readonly<ManifestResourceBudget>; nodes: number };

const OPAQUE_SERVICE_ID_PATTERN = /^svc_[A-Za-z0-9_-]{16,96}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REFERENCE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/-]+$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u;
const FORBIDDEN_OBJECT_KEY_PATTERN = /(?:password|passphrase|secret(?:value|material)?|access[_-]?token|refresh[_-]?token|authorization|cookie|ciphertext|private[_-]?key(?:body|bytes|pem)?|certificate(?:body|bytes|pem)|trust[_-]?anchor(?:body|bytes|pem)?|raw[_-]?(?:request|body|payload|content)|resolved[_-]?(?:credential|secret|material)|environment[_-]?(?:variables?|material)|provider[_-]?(?:credential|token))/iu;
const FORBIDDEN_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/iu,
  /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu
];

function looksLikeHighEntropyBase64(value: string): boolean {
  if (value.length < 256 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 192) return false;
  const frequencies = new Uint32Array(256);
  for (const byte of bytes) frequencies[byte] += 1;
  let distinct = 0;
  let entropy = 0;
  for (const count of frequencies) {
    if (count === 0) continue;
    distinct += 1;
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return distinct >= 32 && entropy >= 4.5;
}

const REFERENCE_SCHEMES: Readonly<Record<ReferenceType, ReadonlySet<string>>> = Object.freeze({
  credential: new Set(["credential", "secret"]),
  certificate: new Set(["certificate"]),
  "private-key": new Set(["private-key"]),
  "trust-anchor": new Set(["trust-anchor"])
});

const MANIFEST_TOP_LEVEL_KEYS = new Set<string>([
  "schemaVersion",
  "references",
  "payload",
  "metadata"
]);

const REFERENCE_KEYS = new Set<string>([
  "type",
  "reference",
  "revision",
  "use",
  "operationKey",
  "host",
  "protocol",
  "scopes"
]);

const DEFAULT_BUDGET: Readonly<ManifestResourceBudget> = Object.freeze({
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

const HARD_BUDGET: Readonly<ManifestResourceBudget> = Object.freeze({
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

const BUDGET_KEYS = new Set<keyof ManifestResourceBudget>(Object.keys(DEFAULT_BUDGET) as Array<keyof ManifestResourceBudget>);

export function serviceManifestError(code: string, message: string, cause?: unknown): ServiceManifestError {
  const error = new Error(message, cause ? { cause } : undefined) as ServiceManifestError;
  error.code = code;
  return error;
}

function assertPlainObject(value: unknown, code: string, message: string): asserts value is JsonRecord {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw serviceManifestError(code, message);
  }
}

function normalizeSafeString(
  value: unknown,
  field: string,
  { maxLength = 512, pattern = null }: { maxLength?: number; pattern?: RegExp | null } = {}
): string {
  if (typeof value !== "string") {
    throw serviceManifestError(
      "storage_manifest_schema_invalid",
      `Service manifest ${field} must be a string.`
    );
  }
  const normalized = value.normalize("NFC");
  if (!normalized || normalized !== value || normalized.length > maxLength || (pattern && !pattern.test(normalized))) {
    throw serviceManifestError(
      "storage_manifest_schema_invalid",
      `Service manifest ${field} is invalid.`
    );
  }
  if (
    normalized.includes(String.fromCodePoint(0)) ||
    FORBIDDEN_VALUE_PATTERNS.some((candidate) => candidate.test(normalized)) ||
    looksLikeHighEntropyBase64(normalized)
  ) {
    throw serviceManifestError(
      "storage_manifest_sensitive_material",
      `Service manifest ${field} contains material that must be represented by a typed reference.`
    );
  }
  return normalized;
}

export function validateOpaqueServiceId(value: unknown): string {
  if (typeof value !== "string" || value.normalize("NFC") !== value || !OPAQUE_SERVICE_ID_PATTERN.test(value)) {
    throw serviceManifestError(
      "storage_manifest_service_id_invalid",
      "Service manifest identity must be a canonical opaque service identifier."
    );
  }
  return value;
}

export function validateManifestDigest(value: unknown, field = "digest"): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw serviceManifestError(
      "storage_manifest_digest_invalid",
      `Service manifest ${field} must be a lowercase SHA-256 digest.`
    );
  }
  return value;
}

export function validateManifestRevision(value: unknown, field = "revision"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw serviceManifestError(
      "storage_manifest_revision_invalid",
      `Service manifest ${field} must be a non-negative safe integer.`
    );
  }
  return value;
}

export function normalizeManifestResourceBudget(input: unknown = {}): Readonly<ManifestResourceBudget> {
  assertPlainObject(
    input,
    "storage_manifest_budget_invalid",
    "Service manifest resource budget must be an object."
  );
  for (const key of Object.keys(input)) {
    if (!BUDGET_KEYS.has(key as keyof ManifestResourceBudget)) {
      throw serviceManifestError(
        "storage_manifest_budget_invalid",
        "Service manifest resource budget contains an unsupported field."
      );
    }
  }
  const normalized = {} as ManifestResourceBudget;
  for (const key of BUDGET_KEYS) {
    const value = input[key] ?? DEFAULT_BUDGET[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > HARD_BUDGET[key]) {
      throw serviceManifestError(
        "storage_manifest_budget_invalid",
        `Service manifest resource budget ${key} is outside the supported range.`
      );
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function isReferenceType(value: string): value is ReferenceType {
  return value === "credential" || value === "certificate" || value === "private-key" || value === "trust-anchor";
}

function normalizeReference(reference: unknown): TypedManifestReference {
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
  const type = normalizeSafeString(reference.type, "reference type", {
    maxLength: 32,
    pattern: /^(?:credential|certificate|private-key|trust-anchor)$/u
  });
  if (!isReferenceType(type)) {
    throw serviceManifestError("storage_manifest_reference_invalid", "Service manifest reference type is invalid.");
  }
  const referenceValue = normalizeSafeString(reference.reference, "reference value", {
    maxLength: 512,
    pattern: REFERENCE_PATTERN
  });
  const scheme = referenceValue.slice(0, referenceValue.indexOf(":"));
  if (!REFERENCE_SCHEMES[type].has(scheme) || referenceValue.includes("@") || referenceValue.includes("?") || referenceValue.includes("#")) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest reference scheme does not match its declared type."
    );
  }
  if (typeof reference.revision !== "number" || !Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest reference revision must be a positive safe integer."
    );
  }
  const normalized: TypedManifestReference = {
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
    const scopes = reference.scopes.map((scope) => normalizeSafeString(scope, "reference scope", {
      maxLength: 128,
      pattern: SAFE_TOKEN_PATTERN
    }));
    if (new Set(scopes).size !== scopes.length) {
      throw serviceManifestError(
        "storage_manifest_reference_invalid",
        "Service manifest reference scopes must be unique."
      );
    }
    normalized.scopes = scopes.sort();
  }
  return normalized;
}

function normalizeJsonValue(
  value: unknown,
  context: ManifestContext,
  path = "manifest",
  depth = 0,
  schemaContext = false
): ManifestJsonValue {
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
    return value.map((item, index) => normalizeJsonValue(item, context, `${path}[${index}]`, depth + 1, schemaContext));
  }
  assertPlainObject(
    value,
    "storage_manifest_schema_invalid",
    "Service manifest values must contain only JSON objects and arrays."
  );
  const normalized: Record<string, ManifestJsonValue> = {};
  const keys = Object.keys(value).sort();
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
    const schemaPropertyName = schemaContext && path.endsWith(".properties");
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

export function stableManifestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableManifestJson).join(",")}]`;
  const source = value as JsonRecord;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableManifestJson(source[key])}`).join(",")}}`;
}

export function sha256ManifestBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function deepFreezeManifest<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeManifest(child);
  return Object.freeze(value);
}

export function canonicalizeTypedReferenceManifest(
  value: unknown,
  budgetInput: unknown = {}
): Readonly<CanonicalManifestResult> {
  const budgetSource = typeof budgetInput === "object" && budgetInput !== null && !Array.isArray(budgetInput)
    ? budgetInput as JsonRecord
    : {};
  const budget: Readonly<ManifestResourceBudget> = Object.isFrozen(budgetSource) && BUDGET_KEYS.size === Object.keys(budgetSource).length
    ? budgetSource as unknown as Readonly<ManifestResourceBudget>
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
  const references = value.references.map(normalizeReference);
  references.sort((left, right) => stableManifestJson(left).localeCompare(stableManifestJson(right)));
  const referenceKeys = references.map(stableManifestJson);
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    throw serviceManifestError(
      "storage_manifest_reference_invalid",
      "Service manifest references must be unique."
    );
  }
  const context: ManifestContext = { budget, nodes: 0 };
  const normalized: Record<string, unknown> = {
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
  const canonicalBytes = Buffer.from(stableManifestJson(normalized), "utf8");
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

export function createDurableManifestWriterPort<TArguments extends unknown[], TResult>(
  commitManifestSet: (...arguments_: TArguments) => TResult
): Readonly<{ commitManifestSet: (...arguments_: TArguments) => TResult }> {
  if (typeof commitManifestSet !== "function") {
    throw new TypeError("DurableManifestWriterPort requires commitManifestSet.");
  }
  return Object.freeze({ commitManifestSet });
}

export function createManifestSnapshotReaderPort<TArguments extends unknown[], TResult>(
  getSnapshot: (...arguments_: TArguments) => TResult
): Readonly<{ getSnapshot: (...arguments_: TArguments) => TResult }> {
  if (typeof getSnapshot !== "function") {
    throw new TypeError("ManifestSnapshotReaderPort requires getSnapshot.");
  }
  return Object.freeze({ getSnapshot });
}

export function createManifestCandidateAuthorityPort({
  getCandidateSnapshot,
  acknowledgePublished
}: {
  getCandidateSnapshot?: (...arguments_: unknown[]) => unknown;
  acknowledgePublished?: (...arguments_: unknown[]) => unknown;
} = {}): Readonly<{
  getCandidateSnapshot: (...arguments_: unknown[]) => unknown;
  acknowledgePublished: (...arguments_: unknown[]) => unknown;
}> {
  if (typeof getCandidateSnapshot !== "function" || typeof acknowledgePublished !== "function") {
    throw new TypeError(
      "ManifestCandidateAuthorityPort requires candidate read and publication acknowledgement operations."
    );
  }
  return Object.freeze({ getCandidateSnapshot, acknowledgePublished });
}
