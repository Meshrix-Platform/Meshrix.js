/**
 * Private relay recovery contract: purpose-bound recovery authority records,
 * encrypted recovery snapshot envelopes, the bounded recovery-vault wire API
 * and the GatewayOperationRecovery status schema.
 *
 * RecoveryAuthority and the fresh-device proof flow live on the endpoint
 * channel (inside the pinned inner TLS session); the recovery vault stores
 * only opaque ciphertext plus public verification material. These schemas own
 * the wire shape; runtime transitions remain with the endpoint/gateway owners.
 */
export const PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION = "v0.0.1:private-relay:recovery-1";

export const PRIVATE_RELAY_PROOF_PURPOSES = Object.freeze([
  "recover_device",
  "vault_fetch",
  "vault_write"
]);
export const PRIVATE_RELAY_RECOVERY_KINDS = Object.freeze([
  "vault-fetch",
  "vault-snapshot",
  "vault-fetch-refused",
  "vault-write",
  "vault-write-result",
  "recovery-request",
  "recovery-challenge",
  "recovery-proof",
  "recovery-result",
  "rotation-begin",
  "rotation-state",
  "operation-query",
  "operation-status",
  "endpoint-trust-binding"
]);
export const PRIVATE_RELAY_VAULT_REFUSALS = Object.freeze([
  "not_found",
  "proof_invalid",
  "purpose_denied",
  "rate_limited",
  "authority_stale"
]);
export const PRIVATE_RELAY_VAULT_WRITE_OUTCOMES = Object.freeze([
  "committed",
  "conflict",
  "refused"
]);
export const PRIVATE_RELAY_RECOVERY_OUTCOMES = Object.freeze([
  "enrolled",
  "refused"
]);
export const PRIVATE_RELAY_RECOVERY_REFUSALS = Object.freeze([
  "authority_revoked",
  "principal_revoked",
  "stale_generation",
  "challenge_consumed",
  "challenge_expired",
  "key_possession_mismatch",
  "purpose_mismatch",
  "endpoint_unreachable"
]);
export const PRIVATE_RELAY_ROTATION_STATES = Object.freeze([
  "staged",
  "published",
  "acknowledging",
  "completed",
  "aborted"
]);
export const PRIVATE_RELAY_RECOVERY_AUTHORITY_STATES = Object.freeze([
  "active",
  "rotating",
  "revoked",
  "superseded"
]);
export const PRIVATE_RELAY_OPERATION_STATES = Object.freeze([
  "not_started",
  "dispatched_in_doubt",
  "in_progress",
  "completed",
  "completed_result_unavailable",
  "failed",
  "status_unavailable",
  "cancel_intent_recorded"
]);
export const PRIVATE_RELAY_NOT_STARTED_EVIDENCE = Object.freeze([
  "local_never_submitted",
  "endpoint_refused_pre_dispatch"
]);
export const PRIVATE_RELAY_RESULT_AVAILABILITY = Object.freeze([
  "available",
  "unavailable",
  "not_applicable"
]);
export const PRIVATE_RELAY_AEAD_ALGORITHMS = Object.freeze([
  "AES-256-GCM",
  "XChaCha20-Poly1305"
]);
export const PRIVATE_RELAY_SNAPSHOT_MAY_HOLD_PLAINTEXT = false;
export const PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED = false;

export const PRIVATE_RELAY_RECOVERY_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxNonceBytes: 96,
  maxKeyBytes: 256,
  maxSignatureBytes: 512,
  maxDigestBytes: 96,
  maxSnapshotBytes: 1_048_576,
  maxPendingEndpoints: 64,
  maxProofTranscriptBytes: 4_096
});

export const PRIVATE_RELAY_SNAPSHOT_FORBIDDEN_KEYS = Object.freeze([
  "apiKey",
  "authorization",
  "catalog",
  "config",
  "credential",
  "credentials",
  "devicePrivateKey",
  "endpointTrust",
  "grant",
  "grants",
  "keyMaterial",
  "peerName",
  "plaintext",
  "principal",
  "privateKey",
  "recoverySecret",
  "secret",
  "tlsKeyLog",
  "token",
  "upstream"
]);

const FAIL = Symbol("private-relay-recovery-fail");
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;
type RecoveryParser = (value?: unknown) => Readonly<UnknownRecord> | null;

const KIND_PARSERS: Record<string, RecoveryParser> = Object.create(null);

function isPlainObject(value?: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is UnknownRecord {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function boundedText(value: unknown, maxBytes: number = PRIVATE_RELAY_RECOVERY_LIMITS.maxOpaqueIdBytes): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : FAIL;
}

function positiveRevision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : FAIL;
}

function boolValue(value?: unknown): boolean | typeof FAIL {
  return typeof value === "boolean" ? value : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = PRIVATE_RELAY_RECOVERY_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function nonceToken(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, PRIVATE_RELAY_RECOVERY_LIMITS.maxNonceBytes);
  return normalized && NONCE_PATTERN.test(normalized) ? normalized : FAIL;
}

function publicKeyMaterial(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, PRIVATE_RELAY_RECOVERY_LIMITS.maxKeyBytes);
  return normalized && BASE64URL_PATTERN.test(normalized) ? normalized : FAIL;
}

function signatureValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, PRIVATE_RELAY_RECOVERY_LIMITS.maxSignatureBytes);
  return normalized && BASE64URL_PATTERN.test(normalized) ? normalized : FAIL;
}

function digestValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, PRIVATE_RELAY_RECOVERY_LIMITS.maxDigestBytes);
  return normalized && DIGEST_PATTERN.test(normalized) ? normalized : FAIL;
}

function instantValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, 64);
  return normalized && ISO_INSTANT_PATTERN.test(normalized) ? normalized : FAIL;
}

function opaqueCiphertext(value: unknown, maxBytes: number): string | typeof FAIL {
  if (typeof value !== "string" || !value) return FAIL;
  if (!BASE64URL_PATTERN.test(value)) return FAIL;
  return Buffer.byteLength(value, "utf8") <= Math.ceil(maxBytes * 4 / 3) + 8 ? value : FAIL;
}

export function containsForbiddenSnapshotKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => PRIVATE_RELAY_SNAPSHOT_FORBIDDEN_KEYS.includes(key))) return true;
  return Object.values(value).some((entry) => containsForbiddenSnapshotKeys(entry, seen));
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T, forbidSnapshotKeys = true): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys)) return null;
  if (forbidSnapshotKeys && containsForbiddenSnapshotKeys(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const parsed = spec[key](value[key], value);
    if (parsed === FAIL) return null;
    output[key] = parsed;
  }
  return Object.freeze(output) as ParsedSpec<T>;
}

function parseArray<T>(
  value: unknown,
  parseItem: (value: unknown) => T | typeof FAIL | null,
  max: number,
  allowEmpty: boolean = true
): readonly T[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return FAIL;
  const items: T[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === FAIL || item == null) return FAIL;
    items.push(item);
  }
  return Object.freeze(items);
}

function created<T>(parseFn: (value: unknown) => T | null, value: unknown, message: string): T {
  const parsed = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function envelope(kind: string, extras: Record<string, unknown> = {}): UnknownRecord {
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind,
    ...extras
  };
}

function commonRemote<T extends ParserSpec>(kind: string, extra: T) {
  return {
    schemaVersion: (entry: unknown) => entry === PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION ? entry : FAIL,
    kind: (entry: unknown) => entry === kind ? entry : FAIL,
    ...extra
  };
}

export function parseAeadEnvelope(value?: unknown) {
  return parseObject(value, {
    algorithm: (entry) => enumValue(entry, PRIVATE_RELAY_AEAD_ALGORITHMS),
    nonce: (entry) => nonceToken(entry),
    ciphertext: (entry) => opaqueCiphertext(entry, PRIVATE_RELAY_RECOVERY_LIMITS.maxSnapshotBytes),
    byteLength: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 0
        && (entry as number) <= PRIVATE_RELAY_RECOVERY_LIMITS.maxSnapshotBytes ? entry : FAIL
    )
  });
}

export function parsePublicVerifier(value?: unknown) {
  return parseObject(value, {
    keyId: (entry) => opaqueId(entry),
    algorithm: (entry) => enumValue(entry, ["Ed25519", "ECDSA-P256"]),
    publicKey: (entry) => publicKeyMaterial(entry)
  });
}

export function parseEncryptedRecoverySnapshot(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION ? entry : FAIL,
    kind: (entry) => entry === "encrypted-recovery-snapshot" ? entry : FAIL,
    vaultId: (entry) => opaqueId(entry),
    formatVersion: positiveRevision,
    generation: positiveRevision,
    revision: positiveRevision,
    snapshot: (entry) => parseAeadEnvelope(entry) || FAIL,
    publicVerifier: (entry) => parsePublicVerifier(entry) || FAIL
  });
}

export function parseVaultFetchProof(value?: unknown) {
  return parseObject(value, {
    keyId: (entry) => opaqueId(entry),
    nonce: (entry) => nonceToken(entry),
    issuedAt: instantValue,
    signature: (entry) => signatureValue(entry)
  });
}

export function parseVaultFetch(value?: unknown) {
  return parseObject(value, commonRemote("vault-fetch", {
    vaultId: (entry) => opaqueId(entry),
    purpose: (entry) => entry === "vault_fetch" ? entry : FAIL,
    fetchProof: (entry) => parseVaultFetchProof(entry) || FAIL
  }));
}

export function parseVaultSnapshot(value?: unknown) {
  return parseObject(value, commonRemote("vault-snapshot", {
    vaultId: (entry) => opaqueId(entry),
    revision: positiveRevision,
    generation: positiveRevision,
    snapshot: (entry) => parseAeadEnvelope(entry) || FAIL,
    publicVerifier: (entry) => parsePublicVerifier(entry) || FAIL
  }));
}

export function parseVaultFetchRefused(value?: unknown) {
  return parseObject(value, commonRemote("vault-fetch-refused", {
    vaultId: (entry) => opaqueId(entry),
    refusal: (entry) => enumValue(entry, PRIVATE_RELAY_VAULT_REFUSALS),
    retryable: boolValue
  }));
}

export function parseVaultWriteAuth(value?: unknown) {
  return parseObject(value, {
    writerKeyId: (entry) => opaqueId(entry),
    nonce: (entry) => nonceToken(entry),
    snapshotDigest: (entry) => digestValue(entry),
    signature: (entry) => signatureValue(entry)
  });
}

export function parseVaultWrite(value?: unknown) {
  return parseObject(value, commonRemote("vault-write", {
    vaultId: (entry) => opaqueId(entry),
    purpose: (entry) => entry === "vault_write" ? entry : FAIL,
    expectedRevision: revision,
    snapshot: (entry) => parseEncryptedRecoverySnapshot(entry) || FAIL,
    writeAuth: (entry) => parseVaultWriteAuth(entry) || FAIL
  }));
}

export function parseVaultWriteResult(value?: unknown) {
  return parseObject(value, commonRemote("vault-write-result", {
    vaultId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, PRIVATE_RELAY_VAULT_WRITE_OUTCOMES),
    currentRevision: revision,
    committedRevision: (entry) => revision(entry)
  }));
}

export function parseRecoveryRequest(value?: unknown) {
  return parseObject(value, commonRemote("recovery-request", {
    purpose: (entry) => entry === "recover_device" ? entry : FAIL,
    endpointRouteId: (entry) => opaqueId(entry),
    freshDeviceId: (entry) => opaqueId(entry),
    freshDevicePublicKey: (entry) => publicKeyMaterial(entry)
  }));
}

export function parseRecoveryChallenge(value?: unknown) {
  return parseObject(value, commonRemote("recovery-challenge", {
    challengeId: (entry) => opaqueId(entry),
    purpose: (entry) => entry === "recover_device" ? entry : FAIL,
    endpointRouteId: (entry) => opaqueId(entry),
    principalRef: (entry) => opaqueId(entry),
    generation: positiveRevision,
    nonce: (entry) => nonceToken(entry),
    freshDevicePublicKey: (entry) => publicKeyMaterial(entry),
    issuedAt: instantValue,
    expiresAt: (entry, record) => {
      const issued = instantValue(record.issuedAt);
      const expiry = instantValue(entry);
      if (issued === FAIL || expiry === FAIL) return FAIL;
      return new Date(entry as string).getTime() > new Date(issued as string).getTime() ? expiry : FAIL;
    },
    singleUse: (entry) => entry === true ? entry : FAIL
  }));
}

export function parseRecoveryProof(value?: unknown) {
  return parseObject(value, commonRemote("recovery-proof", {
    purpose: (entry) => entry === "recover_device" ? entry : FAIL,
    challengeId: (entry) => opaqueId(entry),
    endpointRouteId: (entry) => opaqueId(entry),
    principalRef: (entry) => opaqueId(entry),
    generation: positiveRevision,
    freshDeviceId: (entry) => opaqueId(entry),
    freshDevicePublicKey: (entry) => publicKeyMaterial(entry),
    signature: (entry) => signatureValue(entry)
  }));
}

export function parseRecoveryResult(value?: unknown) {
  return parseObject(value, commonRemote("recovery-result", {
    challengeId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, PRIVATE_RELAY_RECOVERY_OUTCOMES),
    refusal: (entry, record) => {
      if (record.outcome === "refused") return enumValue(entry, PRIVATE_RELAY_RECOVERY_REFUSALS);
      return entry === null ? null : FAIL;
    },
    deviceAdmission: (entry, record) => {
      if (record.outcome !== "enrolled") return entry === null ? null : FAIL;
      const admission = parseObject(entry, {
        deviceId: (item) => opaqueId(item),
        admissionGeneration: positiveRevision,
        requiresMutualTlsRebind: (item) => item === true ? item : FAIL
      });
      return admission || FAIL;
    }
  }));
}

export function parseRotationBegin(value?: unknown) {
  return parseObject(value, commonRemote("rotation-begin", {
    rotationId: (entry) => opaqueId(entry),
    recoveryKeyId: (entry) => opaqueId(entry),
    principalRef: (entry) => opaqueId(entry),
    currentGeneration: positiveRevision,
    candidateGeneration: (entry, record) => {
      const current = positiveRevision(record.currentGeneration);
      const candidate = positiveRevision(entry);
      if (current === FAIL || candidate === FAIL) return FAIL;
      return (candidate as number) > (current as number) ? candidate : FAIL;
    },
    candidatePublicKey: (entry) => publicKeyMaterial(entry),
    administrationProof: (entry) => parseVaultFetchProof(entry) || FAIL
  }));
}

export function parseRotationState(value?: unknown) {
  return parseObject(value, commonRemote("rotation-state", {
    rotationId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_ROTATION_STATES),
    acknowledged: (entry) => parseArray(entry, (item) => opaqueId(item), PRIVATE_RELAY_RECOVERY_LIMITS.maxPendingEndpoints),
    pending: (entry) => parseArray(entry, (item) => opaqueId(item), PRIVATE_RELAY_RECOVERY_LIMITS.maxPendingEndpoints),
    globalComplete: (entry) => entry === false ? entry : FAIL
  }));
}

export function parseEndpointTrustBinding(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION ? entry : FAIL,
    kind: (entry) => entry === "endpoint-trust-binding" ? entry : FAIL,
    pairedIdentityKey: (entry) => publicKeyMaterial(entry),
    pairedIdentityFingerprint: (entry) => opaqueId(entry, PRIVATE_RELAY_RECOVERY_LIMITS.maxNonceBytes),
    mode: (entry) => enumValue(entry, ["personal", "enterprise"]),
    role: (entry) => enumValue(entry, ["entry", "endpoint"]),
    trustGeneration: positiveRevision,
    endpointPrincipalRef: (entry) => opaqueId(entry),
    capabilityGrantRef: (entry) => opaqueId(entry),
    boundRecoveryKeyId: (entry) => entry === null ? null : opaqueId(entry)
  });
}

export function parseOperationQuery(value?: unknown) {
  return parseObject(value, commonRemote("operation-query", {
    operationId: (entry) => opaqueId(entry),
    principalRef: (entry) => opaqueId(entry),
    generation: positiveRevision
  }));
}

export function parseOperationStatus(value?: unknown) {
  const parsed = parseObject(value, commonRemote("operation-status", {
    operationId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_OPERATION_STATES),
    notStartedEvidence: (entry, record) => {
      if (record.state === "not_started") return enumValue(entry, PRIVATE_RELAY_NOT_STARTED_EVIDENCE);
      return entry === null ? null : FAIL;
    },
    resultAvailability: (entry) => enumValue(entry, PRIVATE_RELAY_RESULT_AVAILABILITY),
    revision: positiveRevision
  }));
  if (!parsed) return null;
  if (parsed.state === "not_started" && parsed.resultAvailability !== "not_applicable") return null;
  if (parsed.state === "completed" && parsed.resultAvailability !== "available") return null;
  if (parsed.state === "completed_result_unavailable" && parsed.resultAvailability !== "unavailable") return null;
  return parsed;
}

KIND_PARSERS["vault-fetch"] = parseVaultFetch;
KIND_PARSERS["vault-snapshot"] = parseVaultSnapshot;
KIND_PARSERS["vault-fetch-refused"] = parseVaultFetchRefused;
KIND_PARSERS["vault-write"] = parseVaultWrite;
KIND_PARSERS["vault-write-result"] = parseVaultWriteResult;
KIND_PARSERS["recovery-request"] = parseRecoveryRequest;
KIND_PARSERS["recovery-challenge"] = parseRecoveryChallenge;
KIND_PARSERS["recovery-proof"] = parseRecoveryProof;
KIND_PARSERS["recovery-result"] = parseRecoveryResult;
KIND_PARSERS["rotation-begin"] = parseRotationBegin;
KIND_PARSERS["rotation-state"] = parseRotationState;
KIND_PARSERS["operation-query"] = parseOperationQuery;
KIND_PARSERS["operation-status"] = parseOperationStatus;
KIND_PARSERS["endpoint-trust-binding"] = parseEndpointTrustBinding;

export function parsePrivateRelayRecoveryMessage(value?: unknown) {
  if (!isPlainObject(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

export function assertSnapshotServiceVisibility(value?: unknown) {
  const parsed = parseEncryptedRecoverySnapshot(value) || parseVaultSnapshot(value);
  if (!parsed) {
    throw new Error("Recovery snapshot must be a versioned opaque AEAD envelope.");
  }
  if (containsForbiddenSnapshotKeys(value)) {
    throw new Error("Recovery snapshots must not expose peer names, trust references, configuration or secret material to the service.");
  }
  if (PRIVATE_RELAY_SNAPSHOT_MAY_HOLD_PLAINTEXT !== false) {
    throw new Error("The recovery vault stores ciphertext and public verification material only.");
  }
  return true;
}

export function assertRecoveryPurposeSeparation(purpose?: unknown, expected?: unknown) {
  if (typeof purpose !== "string" || !PRIVATE_RELAY_PROOF_PURPOSES.includes(purpose as never)) {
    throw new Error("Recovery proofs must carry a typed purpose.");
  }
  if (purpose !== expected) {
    throw new Error(`PRIVATE_RELAY_PURPOSE_MISMATCH: ${purpose} cannot satisfy ${String(expected)}.`);
  }
  return true;
}

export function vaultWriteCommitted(write?: unknown, result?: unknown): boolean {
  const parsedWrite = parseVaultWrite(write);
  const parsedResult = parseVaultWriteResult(result);
  if (!parsedWrite || !parsedResult) return false;
  if (parsedResult.vaultId !== parsedWrite.vaultId) return false;
  if (parsedResult.outcome !== "committed") return false;
  return parsedResult.committedRevision > parsedWrite.expectedRevision
    && parsedResult.committedRevision === parsedResult.currentRevision;
}

export function vaultWriteIsConflict(result?: unknown): boolean {
  const parsed = parseVaultWriteResult(result);
  return parsed?.outcome === "conflict";
}

export function operationRetryPermitted(state?: unknown): boolean {
  return state === "not_started";
}

export function assertOperationStatusHonest(value?: unknown) {
  const parsed = parseOperationStatus(value);
  if (!parsed) {
    throw new Error("Operation status must be a versioned operation-status message.");
  }
  if (parsed.state === "dispatched_in_doubt" || parsed.state === "status_unavailable") {
    if (PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED !== false) {
      throw new Error("An unknown operation outcome must never be blindly retried.");
    }
  }
  return true;
}

const ROTATION_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  staged: Object.freeze({ publish: "published", abort: "aborted" }),
  published: Object.freeze({ acknowledge: "acknowledging", abort: "aborted" }),
  acknowledging: Object.freeze({ complete: "completed", abort: "aborted" }),
  completed: Object.freeze({}),
  aborted: Object.freeze({})
});

export function rotationTransition(state: unknown, event: unknown): string | null {
  if (typeof state !== "string" || typeof event !== "string") return null;
  const transitions = ROTATION_TRANSITIONS[state];
  if (!transitions) return null;
  const next = transitions[event];
  return typeof next === "string" ? next : null;
}

export function assertRotationNotGlobal(value?: unknown) {
  const parsed = parseRotationState(value);
  if (!parsed) {
    throw new Error("Rotation state must be a versioned rotation-state message.");
  }
  if (parsed.pending.length > 0 && (parsed.state === "completed")) {
    throw new Error("A rotation with pending endpoints is not complete; report per-endpoint acknowledgement honestly.");
  }
  return true;
}

export function recoveryChannelAdmitsOnlyRecovery(kind?: unknown, sessionPurpose?: unknown): boolean {
  if (sessionPurpose !== "recover_device") return true;
  return typeof kind === "string" && [
    "recovery-request",
    "recovery-challenge",
    "recovery-proof",
    "recovery-result",
    "session-close",
    "session-reconnect"
  ].includes(kind);
}

export function createVaultFetch(value: Record<string, unknown> = {}) {
  return created(parseVaultFetch, envelope("vault-fetch", {
    vaultId: value.vaultId,
    purpose: "vault_fetch",
    fetchProof: value.fetchProof
  }), "Private relay vault-fetch does not satisfy the recovery contract.");
}

export function createVaultSnapshot(value: Record<string, unknown> = {}) {
  return created(parseVaultSnapshot, envelope("vault-snapshot", {
    vaultId: value.vaultId,
    revision: value.revision,
    generation: value.generation,
    snapshot: value.snapshot,
    publicVerifier: value.publicVerifier
  }), "Private relay vault-snapshot does not satisfy the recovery contract.");
}

export function createVaultFetchRefused(value: Record<string, unknown> = {}) {
  return created(parseVaultFetchRefused, envelope("vault-fetch-refused", {
    vaultId: value.vaultId,
    refusal: value.refusal,
    retryable: value.retryable === true
  }), "Private relay vault-fetch-refused does not satisfy the recovery contract.");
}

export function createVaultWrite(value: Record<string, unknown> = {}) {
  return created(parseVaultWrite, envelope("vault-write", {
    vaultId: value.vaultId,
    purpose: "vault_write",
    expectedRevision: value.expectedRevision,
    snapshot: value.snapshot,
    writeAuth: value.writeAuth
  }), "Private relay vault-write does not satisfy the recovery contract.");
}

export function createVaultWriteResult(value: Record<string, unknown> = {}) {
  return created(parseVaultWriteResult, envelope("vault-write-result", {
    vaultId: value.vaultId,
    outcome: value.outcome,
    currentRevision: value.currentRevision,
    committedRevision: value.committedRevision
  }), "Private relay vault-write-result does not satisfy the recovery contract.");
}

export function createRecoveryRequest(value: Record<string, unknown> = {}) {
  return created(parseRecoveryRequest, envelope("recovery-request", {
    purpose: "recover_device",
    endpointRouteId: value.endpointRouteId,
    freshDeviceId: value.freshDeviceId,
    freshDevicePublicKey: value.freshDevicePublicKey
  }), "Private relay recovery-request does not satisfy the recovery contract.");
}

export function createRecoveryChallenge(value: Record<string, unknown> = {}) {
  return created(parseRecoveryChallenge, envelope("recovery-challenge", {
    challengeId: value.challengeId,
    purpose: "recover_device",
    endpointRouteId: value.endpointRouteId,
    principalRef: value.principalRef,
    generation: value.generation,
    nonce: value.nonce,
    freshDevicePublicKey: value.freshDevicePublicKey,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    singleUse: true
  }), "Private relay recovery-challenge does not satisfy the recovery contract.");
}

export function createRecoveryProof(value: Record<string, unknown> = {}) {
  return created(parseRecoveryProof, envelope("recovery-proof", {
    purpose: "recover_device",
    challengeId: value.challengeId,
    endpointRouteId: value.endpointRouteId,
    principalRef: value.principalRef,
    generation: value.generation,
    freshDeviceId: value.freshDeviceId,
    freshDevicePublicKey: value.freshDevicePublicKey,
    signature: value.signature
  }), "Private relay recovery-proof does not satisfy the recovery contract.");
}

export function createRecoveryResult(value: Record<string, unknown> = {}) {
  return created(parseRecoveryResult, envelope("recovery-result", {
    challengeId: value.challengeId,
    outcome: value.outcome,
    refusal: value.outcome === "refused" ? value.refusal : null,
    deviceAdmission: value.outcome === "enrolled" ? value.deviceAdmission : null
  }), "Private relay recovery-result does not satisfy the recovery contract.");
}

export function createRotationBegin(value: Record<string, unknown> = {}) {
  return created(parseRotationBegin, envelope("rotation-begin", {
    rotationId: value.rotationId,
    recoveryKeyId: value.recoveryKeyId,
    principalRef: value.principalRef,
    currentGeneration: value.currentGeneration,
    candidateGeneration: value.candidateGeneration,
    candidatePublicKey: value.candidatePublicKey,
    administrationProof: value.administrationProof
  }), "Private relay rotation-begin does not satisfy the recovery contract.");
}

export function createRotationState(value: Record<string, unknown> = {}) {
  return created(parseRotationState, envelope("rotation-state", {
    rotationId: value.rotationId,
    state: value.state,
    acknowledged: value.acknowledged || [],
    pending: value.pending || [],
    globalComplete: false
  }), "Private relay rotation-state does not satisfy the recovery contract.");
}

export function createOperationQuery(value: Record<string, unknown> = {}) {
  return created(parseOperationQuery, envelope("operation-query", {
    operationId: value.operationId,
    principalRef: value.principalRef,
    generation: value.generation
  }), "Private relay operation-query does not satisfy the recovery contract.");
}

export function createOperationStatus(value: Record<string, unknown> = {}) {
  return created(parseOperationStatus, envelope("operation-status", {
    operationId: value.operationId,
    state: value.state,
    notStartedEvidence: value.state === "not_started" ? value.notStartedEvidence : null,
    resultAvailability: value.resultAvailability,
    revision: value.revision
  }), "Private relay operation-status does not satisfy the recovery contract.");
}
