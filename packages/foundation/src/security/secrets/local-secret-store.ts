import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  appendLocalSecretAudit,
  assertLocalSecretMutationLockOwned,
  ensureLocalSecretPrivateDir,
  localSecretStorePaths,
  readLocalSecretJson,
  withLocalSecretMutationLock,
  writeLocalSecretJson
} from "./local-secret-storage.ts";
import type { LocalSecretMutationLock } from "./local-secret-storage.ts";
import {
  decryptLocalSecretPayload,
  encryptLocalSecretPayload
} from "./local-secret-envelope.ts";
import {
  resolveLocalSecretKeyProvider,
  type LocalSecretKeyProvider
} from "./local-secret-key-provider.ts";

export const LOCAL_SECRET_STORE_VERSION = "v0.0.1:risk-control:local-secret-store-2";

const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SECRET_REF_PATTERN = /^secret:\/\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/u;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[a-f0-9:]+)$/iu;
const MAX_SECRET_PAYLOAD_BYTES = 1024 * 1024;
const TARGET_KEYS = new Set(["provider", "family", "authType", "secretRef", "scope"]);
const TARGET_SCOPE_KEYS = new Set(["serviceId", "scopes", "allowedHosts", "allowedProtocols"]);
const EXPECTED_SCOPE_KEYS = new Set(["serviceId", "requiredScopes", "host", "protocol"]);

interface SecretObject extends Record<string, unknown> {
  secretRef?: unknown;
  provider?: unknown;
  family?: unknown;
  authType?: unknown;
  scope?: SecretObject;
  metadata?: SecretObject;
  serviceId?: unknown;
  scopes?: unknown;
  requiredScopes?: unknown;
  allowedHosts?: unknown;
  allowedProtocols?: unknown;
  host?: unknown;
  protocol?: unknown;
  revision?: unknown;
  credentialConfigured?: unknown;
  status?: unknown;
  valueKeys?: unknown;
  storageRef?: unknown;
  envelope?: unknown;
  binding?: unknown;
  payload?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  rotatedAt?: unknown;
  revokedAt?: unknown;
}

interface SecretTarget extends SecretObject {
  provider: string;
  family: string;
  authType: string;
  secretRef: string;
  scope: SecretObject;
}

interface SecretRegistry extends SecretObject {
  protocolVersion: string;
  refs: Record<string, SecretObject>;
  updatedAt: string;
}

type SecretStorePaths = ReturnType<typeof localSecretStorePaths>;

interface SecretWriteInput {
  dataDir?: string;
  target?: unknown;
  payload?: Record<string, unknown>;
  expectedRevision?: unknown;
  operation?: "initialize" | "rotate";
  mutationLock?: LocalSecretMutationLock | null;
  keyProvider?: LocalSecretKeyProvider | null;
}

interface SecretMasterKeyRotationInput {
  dataDir?: string;
  currentKeyProvider?: LocalSecretKeyProvider | null;
  nextKeyProvider?: LocalSecretKeyProvider | null;
}

interface SecretRevokeInput {
  dataDir?: string;
  secretRef?: unknown;
  expectedRevision?: unknown;
  mutationLock?: LocalSecretMutationLock | null;
}

interface SecretResolveInput {
  dataDir?: string;
  secretRef?: unknown;
  expectedRevision?: unknown;
  expectedScope?: unknown;
  keyProvider?: LocalSecretKeyProvider | null;
}

type LocalSecretError = Error & {
  code?: string;
  field?: unknown;
  secretRef?: unknown;
  expectedRevision?: unknown;
  actualRevision?: unknown;
  reasonCode?: unknown;
  statusCode?: number;
  status?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

function asObject(value?: unknown): SecretObject;
function asObject(value: unknown, fallback: null): SecretObject | null;
function asObject(value: unknown, fallback: SecretObject): SecretObject;
function asObject(value?: unknown, fallback: SecretObject | null = {}): SecretObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SecretObject
    : fallback;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function sha256(value?: unknown): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function withMutationLock<T>(
  dataDir: string,
  callback: (lock: LocalSecretMutationLock) => Promise<T> | T
): Promise<T> {
  return withLocalSecretMutationLock(dataDir, async (lock)  => {
    await cleanupOrphanValueFiles(dataDir);
    return await callback(lock);
  });
}

function emptyRegistry(): SecretRegistry {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    updatedAt: nowIso(),
    refs: {}
  };
}

function registryContractError()  {
  const error = new Error("Meshrix.js local secret registry is invalid.") as LocalSecretError;
  error.code = "local_secret_registry_invalid";
  return error;
}

function targetContractError(field?: unknown, message = "") {
  const error = new Error(message || `Meshrix.js local secret target field ${field} is invalid.`) as LocalSecretError;
  error.code = "local_secret_target_invalid";
  error.field = field;
  return error;
}

function explicitTargetId(value?: unknown, field?: unknown): string {
  const source = typeof value === "string" ? value : "";
  const raw = text(source);
  const normalized = raw.toLowerCase();
  if (source !== raw || raw !== normalized || !TARGET_ID_PATTERN.test(normalized)) {
    throw targetContractError(field);
  }
  return normalized;
}

function assertKnownKeys(value: unknown, allowedKeys: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(asObject(value)).find((key)  => !allowedKeys.has(key));
  if (unknown) {
    throw targetContractError(`${field}.${unknown}`, `Meshrix.js local secret target contains an unsupported field: ${field}.${unknown}.`);
  }
}

function assertSecretRef(secretRef: unknown = ""): string {
  const source = typeof secretRef === "string" ? secretRef : "";
  const value = text(source);
  if (source !== value || !SECRET_REF_PATTERN.test(value)) {
    throw targetContractError("secretRef", "Meshrix.js local secret target requires an explicit canonical secret:// reference.");
  }
  const segments = value.slice("secret://".length).split("/");
  if (segments.some((segment)  => segment === "." || segment === "..")) {
    throw targetContractError("secretRef", "Meshrix.js local secret target secretRef cannot contain relative path segments.");
  }
  return value;
}

function explicitTextList(
  value: unknown,
  field: string,
  {
    normalize = text,
    allowEmpty = false
  }: { normalize?: (value: unknown) => string; allowEmpty?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} must be an explicit array.`);
  }
  const normalizedValues = value.map((item)  => normalize(item));
  if (value.some((item, index)  => typeof item !== "string" || item !== normalizedValues[index])) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} must use canonical string values.`);
  }
  const values = [...new Set(normalizedValues.filter(Boolean))];
  if (!allowEmpty && values.length === 0) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} cannot be empty.`);
  }
  if (values.length !== value.length) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} contains an empty or duplicate value.`);
  }
  return values;
}

function explicitTargetScope(scope: unknown = null): SecretObject {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw targetContractError("scope", "Meshrix.js local secret target requires an explicit scope object.");
  }
  const scopeRecord = scope as SecretObject;
  assertKnownKeys(scope, TARGET_SCOPE_KEYS, "scope");
  const serviceId = text(scopeRecord.serviceId);
  if (typeof scopeRecord.serviceId !== "string" || scopeRecord.serviceId !== serviceId || !serviceId) {
    throw targetContractError("scope.serviceId", "Meshrix.js local secret target requires scope.serviceId.");
  }
  const scopes = explicitTextList(scopeRecord.scopes, "scope.scopes");
  const allowedHosts = explicitTextList(scopeRecord.allowedHosts, "scope.allowedHosts", {
    normalize: normalizedHost,
    allowEmpty: true
  });
  if (allowedHosts.some((host)  => host === "*" || !HOST_PATTERN.test(host))) {
    throw targetContractError("scope.allowedHosts", "Meshrix.js local secret target allowedHosts must contain exact host names or addresses.");
  }
  const allowedProtocols = explicitTextList(scopeRecord.allowedProtocols, "scope.allowedProtocols", {
    normalize: protocolName,
    allowEmpty: true
  });
  if (allowedProtocols.some((protocol)  => !TARGET_ID_PATTERN.test(protocol))) {
    throw targetContractError("scope.allowedProtocols");
  }
  const output: Record<string, unknown> = {
    serviceId,
    scopes,
    allowedHosts,
    allowedProtocols
  };
  return output;
}

export function validateLocalSecretTarget(target: unknown = null): SecretTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw targetContractError("target", "Meshrix.js local secret writes require an explicit target object.");
  }
  assertKnownKeys(target, TARGET_KEYS, "target");
  const targetRecord = target as SecretObject;
  return {
    provider: explicitTargetId(targetRecord.provider, "provider"),
    family: explicitTargetId(targetRecord.family, "family"),
    authType: explicitTargetId(targetRecord.authType, "authType"),
    secretRef: assertSecretRef(targetRecord.secretRef),
    scope: explicitTargetScope(targetRecord.scope)
  };
}

function assertSecretPayload(payload: Record<string, unknown> = {})  {
  const secretPayload = asObject(payload, null);
  if (!secretPayload || Object.keys(secretPayload).length === 0) {
    const error = new Error("Meshrix.js local secret write requires a non-empty JSON object payload.") as LocalSecretError;
    error.code = "local_secret_payload_invalid";
    throw error;
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(secretPayload), "utf8");
  if (payloadBytes > MAX_SECRET_PAYLOAD_BYTES) {
    const error = new Error(`Meshrix.js local secret payload exceeds the ${MAX_SECRET_PAYLOAD_BYTES} byte limit.`) as LocalSecretError;
    error.code = "local_secret_payload_too_large";
    throw error;
  }
  return secretPayload;
}

function revisionOf(entry: SecretObject | null = null): number {
  const revision = Number(entry?.revision || 0);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function hasExpectedRevision(expectedRevision?: unknown): boolean {
  return expectedRevision !== undefined && expectedRevision !== null && text(expectedRevision) !== "";
}

function parseExpectedRevision(expectedRevision?: unknown, secretRef?: unknown): number {
  const revision = Number(expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    const error = new Error(`Meshrix.js local secret expectedRevision is invalid for ${secretRef}.`) as LocalSecretError;
    error.code = "local_secret_revision_invalid";
    error.secretRef = secretRef;
    error.expectedRevision = expectedRevision;
    throw error;
  }
  return revision;
}

function assertExpectedRevision(
  entry?: SecretObject | null,
  expectedRevision?: unknown,
  secretRef?: unknown
): void {
  if (!hasExpectedRevision(expectedRevision)) return;
  const expected = parseExpectedRevision(expectedRevision, secretRef);
  const actual = revisionOf(entry);
  if (actual !== expected) {
    const error = new Error(`Meshrix.js local secret revision conflict for ${secretRef}: expected ${expected}, got ${actual}.`) as LocalSecretError;
    error.code = "local_secret_revision_conflict";
    error.secretRef = secretRef;
    error.expectedRevision = expected;
    error.actualRevision = actual;
    throw error;
  }
}

function cleanTextList(value?: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item)  => text(item)).filter(Boolean))];
}

function lifecycleStatus(entry: SecretObject = {}): string {
  if (entry?.revokedAt) return "revoked";
  return text(entry?.status || "active").toLowerCase();
}

function entryResolvable(entry: SecretObject | null = null): boolean {
  return entry?.credentialConfigured === true && lifecycleStatus(entry) === "active";
}

function effectiveSecretScope(metadata: unknown = {}): SecretObject {
  const source = asObject(metadata);
  const nested = asObject(source.scope, null);
  return nested || source;
}

function normalizedHost(value: unknown = ""): string {
  return text(value).toLowerCase().replace(/^\[|\]$/g, "");
}

function protocolName(value: unknown = ""): string {
  return text(value).toLowerCase().replace(/:$/, "");
}

function assertScopeTextMatch({
  scope = {},
  expected = {},
  field = "",
  reasonCode = ""
}: { scope?: SecretObject; expected?: SecretObject; field?: string; reasonCode?: string } = {}) {
  const allowed = text(scope[field]);
  const requested = text(expected[field]);
  if (!requested || allowed === requested) {
    return;
  }
  const error = new Error(`Meshrix.js local secret scope denied: ${reasonCode || field}.`) as LocalSecretError;
  error.code = "local_secret_scope_denied";
  error.reasonCode = reasonCode || `${field}_mismatch`;
  error.field = field;
  throw error;
}

function assertScopeListIncludes({
  scope = {},
  scopeField = "",
  expectedValue = "",
  normalize = text,
  reasonCode = "",
  missingReasonCode = ""
}: {
  scope?: SecretObject;
  scopeField?: string;
  expectedValue?: unknown;
  normalize?: (value: unknown) => string;
  reasonCode?: string;
  missingReasonCode?: string;
} = {}) {
  const allowed = cleanTextList(scope[scopeField]).map((item)  => normalize(item)).filter(Boolean);
  const requested = normalize(expectedValue);
  if (!requested && allowed.length === 0) {
    return;
  }
  if (requested && allowed.includes(requested)) {
    return;
  }
  const deniedReason = !requested
    ? missingReasonCode || reasonCode || `${scopeField}_required`
    : reasonCode || `${scopeField}_not_allowed`;
  const error = new Error(`Meshrix.js local secret scope denied: ${deniedReason}.`) as LocalSecretError;
  error.code = "local_secret_scope_denied";
  error.reasonCode = deniedReason;
  error.field = scopeField;
  throw error;
}

function assertSecretScopeAllowed({
  entry = {},
  secretRef = "",
  expectedScope = {}
}: { entry?: SecretObject; secretRef?: string; expectedScope?: unknown } = {}): void {
  const expected = asObject(expectedScope, null);
  if (!expected) {
    const error = new Error("Meshrix.js local secret resolution requires an explicit expected scope.") as LocalSecretError;
    error.code = "local_secret_scope_required";
    error.statusCode = 403;
    error.secretRef = secretRef;
    throw error;
  }
  const unknownExpectedField = Object.keys(expected).find((key)  => !EXPECTED_SCOPE_KEYS.has(key));
  if (unknownExpectedField) {
    const error = new Error(`Meshrix.js local secret expected scope contains an unsupported field: ${unknownExpectedField}.`) as LocalSecretError;
    error.code = "local_secret_scope_invalid";
    error.statusCode = 403;
    error.secretRef = secretRef;
    error.field = unknownExpectedField;
    throw error;
  }
  if (!text(expected.serviceId) || !Array.isArray(expected.requiredScopes)) {
    const error = new Error("Meshrix.js local secret expected scope requires serviceId and requiredScopes.") as LocalSecretError;
    error.code = "local_secret_scope_invalid";
    error.statusCode = 403;
    error.secretRef = secretRef;
    throw error;
  }
  const scope = effectiveSecretScope(entry.metadata);
  try {
    assertScopeTextMatch({ scope, expected, field: "serviceId", reasonCode: "service_id_mismatch" });
    assertScopeListIncludes({
      scope,
      scopeField: "allowedHosts",
      expectedValue: expected.host,
      normalize: normalizedHost,
      reasonCode: "host_not_allowed",
      missingReasonCode: "host_required"
    });
    assertScopeListIncludes({
      scope,
      scopeField: "allowedProtocols",
      expectedValue: expected.protocol,
      normalize: protocolName,
      reasonCode: "protocol_not_allowed",
      missingReasonCode: "protocol_required"
    });
    for (const requestedScope of cleanTextList(expected.requiredScopes)) {
      assertScopeListIncludes({
        scope,
        scopeField: "scopes",
        expectedValue: requestedScope,
        reasonCode: "scope_not_allowed"
      });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const localError = error as LocalSecretError;
    localError.secretRef = secretRef;
    localError.statusCode = 403;
    throw error;
  }
}

async function readRegistry(dataDir = ""): Promise<SecretRegistry> {
  const paths = localSecretStorePaths({ dataDir });
  const registry = asObject(await readLocalSecretJson<unknown>(paths.registryPath, emptyRegistry()), null);
  const registryRefs = asObject(registry?.refs, null);
  if (
    !registry ||
    registry.protocolVersion !== LOCAL_SECRET_STORE_VERSION ||
    !registryRefs
  ) {
    throw registryContractError();
  }
  const refs: Record<string, SecretObject> = {};
  for (const [secretRef, rawEntry] of Object.entries(registryRefs)) {
    const entry = asObject(rawEntry, null);
    try {
      if (
        !entry ||
        assertSecretRef(secretRef) !== text(entry.secretRef) ||
        revisionOf(entry) === 0 ||
        !["active", "revoked"].includes(lifecycleStatus(entry))
      ) {
        throw registryContractError();
      }
    } catch {
      throw registryContractError();
    }
    refs[secretRef] = entry;
  }
  return {
    ...registry,
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    updatedAt: text(registry.updatedAt),
    refs
  };
}

async function saveRegistry(dataDir: string, registry: SecretRegistry): Promise<void> {
  registry.updatedAt = nowIso();
  const paths = localSecretStorePaths({ dataDir });
  await writeLocalSecretJson(paths.registryPath, registry);
}

function revisionValuePath(paths: SecretStorePaths, secretRef: string, revision: number): string {
  const valueId = sha256(secretRef).slice(0, 40);
  const mutationId = crypto.randomUUID().replace(/-/g, "");
  return path.join(paths.valuesDir, `${valueId}.r${revision}.${mutationId}.json`);
}

function assertExpectedRevisionProvided(expectedRevision: unknown, secretRef: string): number {
  if (!hasExpectedRevision(expectedRevision)) {
    const error = new Error(`Meshrix.js local secret expectedRevision is required for ${secretRef}.`) as LocalSecretError;
    error.code = "local_secret_revision_required";
    error.secretRef = secretRef;
    throw error;
  }
  return parseExpectedRevision(expectedRevision, secretRef);
}

function assertTargetIdentityMatches(entry: SecretObject, target: SecretTarget): void {
  for (const field of ["provider", "family", "authType"]) {
    if (text(entry?.[field]) === target[field]) continue;
    const error = new Error(`Meshrix.js local secret target does not match the configured ${field}.`) as LocalSecretError;
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = field;
    throw error;
  }
  const configuredScope = effectiveSecretScope(entry?.metadata);
  if (JSON.stringify(configuredScope) !== JSON.stringify(target.scope)) {
    const error = new Error("Meshrix.js local secret target scope does not match the configured binding.") as LocalSecretError;
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = "scope";
    throw error;
  }
}

function targetMetadata(target: SecretTarget): SecretObject {
  return {
    scope: target.scope
  };
}

function secretEnvelopeBinding({
  secretRef,
  provider,
  family,
  authType,
  revision,
  metadata,
  valueKeys
}: Record<string, unknown> = {})  {
  return {
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    secretRef: text(secretRef),
    provider: text(provider),
    family: text(family),
    authType: text(authType),
    revision: Number(revision || 0),
    metadata: asObject(metadata),
    valueKeys: cleanTextList(valueKeys).sort()
  };
}

function publicLocalSecretEntry(entry: SecretObject = {}) {
  const scope = effectiveSecretScope(entry.metadata);
  return {
    secretRef: text(entry.secretRef),
    provider: text(entry.provider),
    family: text(entry.family),
    authType: text(entry.authType),
    credentialConfigured: entry.credentialConfigured === true,
    status: lifecycleStatus(entry),
    revision: revisionOf(entry),
    valueKeys: cleanTextList(entry.valueKeys).sort(),
    scopeBinding: {
      serviceBound: Boolean(text(scope.serviceId)),
      scopeCount: cleanTextList(scope.scopes).length,
      hostCount: cleanTextList(scope.allowedHosts).length,
      protocolCount: cleanTextList(scope.allowedProtocols).length
    },
    createdAt: text(entry.createdAt),
    updatedAt: text(entry.updatedAt),
    ...(entry.rotatedAt ? { rotatedAt: text(entry.rotatedAt) } : {}),
    ...(entry.revokedAt ? { revokedAt: text(entry.revokedAt) } : {})
  };
}

async function writeLocalSecret({
  dataDir = "",
  target = null,
  payload = {},
  expectedRevision,
  operation = "initialize",
  mutationLock = null,
  keyProvider = null
}: SecretWriteInput = {}) {
  const resolvedTarget = validateLocalSecretTarget(target);
  const resolvedSecretRef = resolvedTarget.secretRef;
  const secretPayload = assertSecretPayload(payload);

  const paths = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  await ensureLocalSecretPrivateDir(paths.valuesDir);

  const registry = await readRegistry(paths.dataDir);
  const existing = registry.refs[resolvedSecretRef] || null;
  if (operation === "initialize" && existing) {
    const error = new Error(`Meshrix.js local secret is already configured: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = "local_secret_already_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "initialize" && hasExpectedRevision(expectedRevision)) {
    const error = new Error("Meshrix.js local secret initialize does not accept expectedRevision.") as LocalSecretError;
    error.code = "local_secret_revision_unexpected";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !existing) {
    const error = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !entryResolvable(existing)) {
    const error = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = lifecycleStatus(existing) === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate") {
    assertExpectedRevisionProvided(expectedRevision, resolvedSecretRef);
    assertExpectedRevision(existing, expectedRevision, resolvedSecretRef);
    assertTargetIdentityMatches(existing, resolvedTarget);
  }
  const timestamp = nowIso();
  const previousRevision = revisionOf(existing);
  const revision = previousRevision + 1;
  const rotatedAt = operation === "rotate" ? timestamp : "";
  const metadata = targetMetadata(resolvedTarget);
  const valueKeys = Object.keys(secretPayload).sort();
  const resolvedKeyProvider = resolveLocalSecretKeyProvider({
    dataDir: paths.dataDir,
    keyProvider
  });
  const envelope = await encryptLocalSecretPayload({
    payload: secretPayload,
    binding: secretEnvelopeBinding({
      secretRef: resolvedSecretRef,
      provider: resolvedTarget.provider,
      family: resolvedTarget.family,
      authType: resolvedTarget.authType,
      revision,
      metadata,
      valueKeys
    }),
    keyProvider: resolvedKeyProvider
  });
  const valuePath = revisionValuePath(paths, resolvedSecretRef, revision);
  const valueRecord: Record<string, unknown> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    secretRef: resolvedSecretRef,
    provider: resolvedTarget.provider,
    family: resolvedTarget.family,
    authType: resolvedTarget.authType,
    envelope,
    metadata,
    status: "active",
    revision,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    ...(rotatedAt ? { rotatedAt } : {})
  };
  await writeLocalSecretJson(valuePath, valueRecord);

  const entry: Record<string, unknown> = {
    secretRef: resolvedSecretRef,
    provider: resolvedTarget.provider,
    family: resolvedTarget.family,
    authType: resolvedTarget.authType,
    storageRef: `local:${path.basename(valuePath)}`,
    valueKeys,
    credentialConfigured: true,
    status: "active",
    revision,
    createdAt: existing?.createdAt || valueRecord.createdAt,
    updatedAt: valueRecord.updatedAt,
    ...(rotatedAt ? { rotatedAt } : {}),
    metadata
  };
  registry.refs[resolvedSecretRef] = entry;
  const previousValuePath = existing ? localValuePathForEntry(paths, existing) : "";
  if (!mutationLock) {
    throw new Error("Meshrix.js local secret mutation lock is required.");
  }
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending = false;
  if (previousValuePath && previousValuePath !== valuePath) {
    await fs.unlink(previousValuePath).catch((error: unknown)  => {
      if (errorCode(error) !== "ENOENT") staleValueCleanupPending = true;
    });
  }

  const event = operation === "rotate" ? "secret.rotated" : "secret.initialized";
  await appendLocalSecretAudit(paths.dataDir, {
    event,
    secretRef: resolvedSecretRef,
    provider: resolvedTarget.provider,
    family: resolvedTarget.family,
    authType: resolvedTarget.authType,
    valueKeys: entry.valueKeys,
    previousRevision,
    revision,
    status: "active",
    staleValueCleanupPending,
    ...(rotatedAt ? { rotatedAt } : {}),
    createdAt: timestamp
  });

  return {
    ok: true,
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    action: operation,
    secret: publicLocalSecretEntry(entry)
  };
}

export async function initializeLocalSecret(input: SecretWriteInput = {}) {
  return withMutationLock(input.dataDir ?? "", (mutationLock)  => writeLocalSecret({
    ...input,
    operation: "initialize",
    mutationLock
  }));
}

export async function rotateLocalSecret(input: SecretWriteInput = {}) {
  return withMutationLock(input.dataDir ?? "", (mutationLock)  => writeLocalSecret({
    ...input,
    operation: "rotate",
    mutationLock
  }));
}

export async function rotateLocalSecretMasterKey({
  dataDir = "",
  currentKeyProvider = null,
  nextKeyProvider = null
}: SecretMasterKeyRotationInput = {}) {
  if (!currentKeyProvider || !nextKeyProvider) {
    const error = new Error("Meshrix.js local secret master-key rotation requires current and next key providers.") as LocalSecretError;
    error.code = "local_secret_master_key_rotation_provider_required";
    throw error;
  }
  return withMutationLock(dataDir, async (mutationLock)  => {
    const paths = localSecretStorePaths({ dataDir });
    await cleanupOrphanValueFiles(paths.dataDir);
    const [currentKeyFact, nextKeyFact] = await Promise.all([
      currentKeyProvider.loadKey(),
      nextKeyProvider.loadKey()
    ]);
    try {
      if (
        !currentKeyFact?.keyId ||
        !nextKeyFact?.keyId ||
        currentKeyFact.keyId === nextKeyFact.keyId
      ) {
        const error = new Error("Meshrix.js local secret master-key rotation requires a distinct next key.") as LocalSecretError;
        error.code = "local_secret_master_key_rotation_same_key";
        throw error;
      }
    } finally {
      currentKeyFact?.key?.fill(0);
      nextKeyFact?.key?.fill(0);
    }

    const registry = await readRegistry(paths.dataDir);
    const activeEntries = Object.entries(registry.refs)
      .filter(([, entry])  => entryResolvable(entry))
      .sort(([left], [right])  => left.localeCompare(right));
    const staged: Array<{
      secretRef: string;
      currentValuePath: string;
      nextValuePath: string;
      storageRef: string;
    }> = [];
    let registryCommitted = false;
    try {
      for (const [secretRef, entry] of activeEntries) {
        const currentValuePath = localValuePathForEntry(paths, entry);
        const currentValueRecord = await readLocalSecretJson<unknown>(currentValuePath, null);
        if (!valueRecordMatchesEntry(currentValueRecord, entry, secretRef)) {
          const error = new Error("Meshrix.js local secret master-key rotation found an invalid value record.") as LocalSecretError;
          error.code = "local_secret_master_key_rotation_value_invalid";
          throw error;
        }
        const binding = secretEnvelopeBinding({
          secretRef,
          provider: entry.provider,
          family: entry.family,
          authType: entry.authType,
          revision: revisionOf(entry),
          metadata: entry.metadata,
          valueKeys: entry.valueKeys
        });
        const payload = await decryptLocalSecretPayload({
          envelope: currentValueRecord.envelope,
          binding,
          keyProvider: currentKeyProvider
        });
        const nextEnvelope = await encryptLocalSecretPayload({
          payload,
          binding,
          keyProvider: nextKeyProvider
        });
        const nextValuePath = revisionValuePath(paths, secretRef, revisionOf(entry));
        const nextValueRecord: Record<string, unknown> = {
          ...currentValueRecord,
          envelope: nextEnvelope,
          masterKeyRotatedAt: nowIso()
        };
        await writeLocalSecretJson(nextValuePath, nextValueRecord);
        await decryptLocalSecretPayload({
          envelope: nextEnvelope,
          binding,
          keyProvider: nextKeyProvider
        });
        staged.push({
          secretRef,
          currentValuePath,
          nextValuePath,
          storageRef: `local:${path.basename(nextValuePath)}`
        });
      }

      await assertLocalSecretMutationLockOwned(mutationLock);
      for (const item of staged) {
        registry.refs[item.secretRef] = {
          ...registry.refs[item.secretRef],
          storageRef: item.storageRef
        };
      }
      await saveRegistry(paths.dataDir, registry);
      registryCommitted = true;
      let staleValueCleanupPending = 0;
      for (const item of staged) {
        await fs.unlink(item.currentValuePath).catch((error: unknown)  => {
          if (errorCode(error) !== "ENOENT") staleValueCleanupPending += 1;
        });
      }
      await appendLocalSecretAudit(paths.dataDir, {
        event: "secret.master-key-rotated",
        rotatedSecretCount: staged.length,
        staleValueCleanupPending,
        createdAt: nowIso()
      });
      return Object.freeze({
        ok: true,
        protocolVersion: LOCAL_SECRET_STORE_VERSION,
        action: "rotate-master-key",
        rotatedSecretCount: staged.length,
        staleValueCleanupPending
      });
    } catch (error) {
      if (!registryCommitted) {
        await Promise.all(
          staged.map((item)  => fs.unlink(item.nextValuePath).catch(()  => {}))
        );
      }
      throw error;
    }
  });
}

function localValuePathForEntry(paths: SecretStorePaths, entry: SecretObject = {}): string {
  const storageRef = text(entry.storageRef);
  if (!storageRef.startsWith("local:")) return "";
  const fileName = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    return "";
  }
  return path.join(paths.valuesDir, fileName);
}

function canonicalStorageFileName(secretRef: string, revision: number, fileName: string): boolean {
  const valueId = sha256(secretRef).slice(0, 40);
  const pattern = new RegExp(`^${valueId}\\.r${revision}\\.[a-f0-9]{32}\\.json$`, "u");
  return pattern.test(fileName);
}

async function cleanupOrphanValueFiles(dataDir = "")  {
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const referencedFiles = new Set(
    Object.values(registry.refs)
      .map((entry)  => text(entry.storageRef))
      .filter((storageRef)  => storageRef.startsWith("local:"))
      .map((storageRef)  => storageRef.slice("local:".length))
  );
  let fileNames;
  try {
    fileNames = await fs.readdir(paths.valuesDir);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const fileName of fileNames) {
    if (referencedFiles.has(fileName)) continue;
    if (!/^[a-f0-9]{40}\.r[1-9][0-9]*\.[a-f0-9]{32}\.json$/u.test(fileName)) continue;
    await fs.unlink(path.join(paths.valuesDir, fileName)).catch((error: unknown)  => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function valueRecordMatchesEntry(
  valueRecord: unknown,
  entry: SecretObject,
  secretRef: string
): valueRecord is SecretObject {
  const record = asObject(valueRecord, null);
  if (!record) return false;
  if (record.protocolVersion !== LOCAL_SECRET_STORE_VERSION) return false;
  if (record.secretRef !== secretRef) return false;
  if (record.status !== "active" || lifecycleStatus(entry) !== "active") return false;
  if (revisionOf(record) !== revisionOf(entry)) return false;
  for (const field of ["provider", "family", "authType"]) {
    if (text(record[field]) !== text(entry[field])) return false;
  }
  if (JSON.stringify(asObject(record.metadata)) !== JSON.stringify(asObject(entry.metadata))) return false;
  if (Object.hasOwn(record, "payload")) return false;
  return Boolean(
    record.envelope &&
    typeof record.envelope === "object" &&
    !Array.isArray(record.envelope)
  );
}

async function revokeLocalSecretUnlocked({
  dataDir = "",
  secretRef = "",
  expectedRevision,
  mutationLock = null
}: SecretRevokeInput = {}) {
  const resolvedSecretRef = assertSecretRef(secretRef);
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const existing = registry.refs[resolvedSecretRef] || null;
  if (!existing) {
    const error = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(existing)) {
    const error = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = lifecycleStatus(existing) === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  assertExpectedRevisionProvided(expectedRevision, resolvedSecretRef);
  assertExpectedRevision(existing, expectedRevision, resolvedSecretRef);

  const timestamp = nowIso();
  const previousRevision = revisionOf(existing);
  const revision = previousRevision + 1;
  const entry: Record<string, unknown> = {
    secretRef: resolvedSecretRef,
    provider: text(existing.provider),
    family: text(existing.family),
    authType: text(existing.authType),
    credentialConfigured: false,
    status: "revoked",
    revision,
    createdAt: text(existing.createdAt),
    revokedAt: timestamp,
    updatedAt: timestamp,
    metadata: asObject(existing.metadata)
  };
  registry.refs[resolvedSecretRef] = entry;
  const valuePath = localValuePathForEntry(paths, existing);
  if (!mutationLock) {
    throw new Error("Meshrix.js local secret mutation lock is required.");
  }
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending = false;
  if (valuePath) {
    await fs.unlink(valuePath).catch((error: unknown)  => {
      if (errorCode(error) !== "ENOENT") staleValueCleanupPending = true;
    });
  }

  await appendLocalSecretAudit(paths.dataDir, {
    event: "secret.revoked",
    secretRef: resolvedSecretRef,
    provider: entry.provider,
    family: entry.family,
    previousRevision,
    revision,
    status: "revoked",
    staleValueCleanupPending,
    revokedAt: timestamp,
    createdAt: timestamp
  });
  return {
    ok: true,
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    action: "revoke",
    secret: publicLocalSecretEntry(entry)
  };
}

export async function revokeLocalSecret(input: SecretRevokeInput = {}) {
  return withMutationLock(input.dataDir ?? "", (mutationLock)  => revokeLocalSecretUnlocked({
    ...input,
    mutationLock
  }));
}

export async function resolveLocalSecretPayload({
  dataDir = "",
  secretRef = "",
  expectedRevision = undefined,
  expectedScope = null,
  keyProvider = null
}: SecretResolveInput = {}) {
  const resolvedSecretRef = assertSecretRef(secretRef);
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const entry = registry.refs[resolvedSecretRef] || null;
  if (!entry) {
    const error = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(entry)) {
    const status = lifecycleStatus(entry);
    const error = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`) as LocalSecretError;
    error.code = status === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    error.status = status;
    throw error;
  }
  if (hasExpectedRevision(expectedRevision)) {
    assertExpectedRevision(entry, expectedRevision, resolvedSecretRef);
  }
  assertSecretScopeAllowed({ entry, secretRef: resolvedSecretRef, expectedScope });
  const storageRef = text(entry.storageRef);
  if (!storageRef.startsWith("local:")) {
    const error = new Error(`Meshrix.js local secret storage is not local for ${resolvedSecretRef}.`) as LocalSecretError;
    error.code = "local_secret_storage_unsupported";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const fileName = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    const error = new Error(`Meshrix.js local secret storage ref is invalid for ${resolvedSecretRef}.`) as LocalSecretError;
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!canonicalStorageFileName(resolvedSecretRef, revisionOf(entry), fileName)) {
    const error = new Error(`Meshrix.js local secret storage ref is not canonical for ${resolvedSecretRef}.`) as LocalSecretError;
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const valueRecord = await readLocalSecretJson<unknown>(path.join(paths.valuesDir, fileName), null);
  if (!valueRecordMatchesEntry(valueRecord, entry, resolvedSecretRef)) {
    const error = new Error(`Meshrix.js local secret value record does not match ${resolvedSecretRef}.`) as LocalSecretError;
    error.code = "local_secret_value_mismatch";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const payload = await decryptLocalSecretPayload({
    envelope: valueRecord.envelope,
    binding: secretEnvelopeBinding({
      secretRef: resolvedSecretRef,
      provider: entry.provider,
      family: entry.family,
      authType: entry.authType,
      revision: revisionOf(entry),
      metadata: entry.metadata,
      valueKeys: entry.valueKeys
    }),
    keyProvider: resolveLocalSecretKeyProvider({
      dataDir: paths.dataDir,
      keyProvider
    })
  });
  return {
    secretRef: resolvedSecretRef,
    provider: entry.provider || valueRecord.provider || "",
    family: entry.family || valueRecord.family || "",
    authType: entry.authType || valueRecord.authType || "",
    status: lifecycleStatus(entry),
    revision: revisionOf(entry),
    metadata: asObject(entry.metadata),
    payload
  };
}

export async function listLocalSecretEntries({ dataDir = "" }: { dataDir?: string } = {}) {
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  return Object.values(registry.refs)
    .sort((left, right)  => String(left.provider || left.secretRef).localeCompare(String(right.provider || right.secretRef)))
    .map(publicLocalSecretEntry);
}
