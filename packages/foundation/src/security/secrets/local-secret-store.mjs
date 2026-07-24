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
} from "./local-secret-storage.mjs";

export const LOCAL_SECRET_STORE_VERSION = "v0.0.1:risk-control:local-secret-store-1";

const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SECRET_REF_PATTERN = /^secret:\/\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/u;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[a-f0-9:]+)$/iu;
const MAX_SECRET_PAYLOAD_BYTES = 1024 * 1024;
const TARGET_KEYS = new Set(["provider", "family", "authType", "secretRef", "scope"]);
const TARGET_SCOPE_KEYS = new Set(["serviceId", "scopes", "allowedHosts", "allowedProtocols"]);
const EXPECTED_SCOPE_KEYS = new Set(["serviceId", "requiredScopes", "host", "protocol"]);

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").trim();
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function withMutationLock(dataDir, callback) {
  return withLocalSecretMutationLock(dataDir, async (lock) => {
    await cleanupOrphanValueFiles(dataDir);
    return await callback(lock);
  });
}

function emptyRegistry() {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    updatedAt: nowIso(),
    refs: {}
  };
}

function registryContractError() {
  const error = new Error("Meshrix local secret registry is invalid.");
  error.code = "local_secret_registry_invalid";
  return error;
}

function targetContractError(field, message = "") {
  const error = new Error(message || `Meshrix local secret target field ${field} is invalid.`);
  error.code = "local_secret_target_invalid";
  error.field = field;
  return error;
}

function explicitTargetId(value, field) {
  const source = typeof value === "string" ? value : "";
  const raw = text(source);
  const normalized = raw.toLowerCase();
  if (source !== raw || raw !== normalized || !TARGET_ID_PATTERN.test(normalized)) {
    throw targetContractError(field);
  }
  return normalized;
}

function assertKnownKeys(value, allowedKeys, field) {
  const unknown = Object.keys(asObject(value)).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw targetContractError(`${field}.${unknown}`, `Meshrix local secret target contains an unsupported field: ${field}.${unknown}.`);
  }
}

function assertSecretRef(secretRef = "") {
  const source = typeof secretRef === "string" ? secretRef : "";
  const value = text(source);
  if (source !== value || !SECRET_REF_PATTERN.test(value)) {
    throw targetContractError("secretRef", "Meshrix local secret target requires an explicit canonical secret:// reference.");
  }
  const segments = value.slice("secret://".length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw targetContractError("secretRef", "Meshrix local secret target secretRef cannot contain relative path segments.");
  }
  return value;
}

function explicitTextList(value, field, { normalize = text, allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw targetContractError(field, `Meshrix local secret target field ${field} must be an explicit array.`);
  }
  const normalizedValues = value.map((item) => normalize(item));
  if (value.some((item, index) => typeof item !== "string" || item !== normalizedValues[index])) {
    throw targetContractError(field, `Meshrix local secret target field ${field} must use canonical string values.`);
  }
  const values = [...new Set(normalizedValues.filter(Boolean))];
  if (!allowEmpty && values.length === 0) {
    throw targetContractError(field, `Meshrix local secret target field ${field} cannot be empty.`);
  }
  if (values.length !== value.length) {
    throw targetContractError(field, `Meshrix local secret target field ${field} contains an empty or duplicate value.`);
  }
  return values;
}

function explicitTargetScope(scope = null) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw targetContractError("scope", "Meshrix local secret target requires an explicit scope object.");
  }
  assertKnownKeys(scope, TARGET_SCOPE_KEYS, "scope");
  const serviceId = text(scope.serviceId);
  if (typeof scope.serviceId !== "string" || scope.serviceId !== serviceId || !serviceId) {
    throw targetContractError("scope.serviceId", "Meshrix local secret target requires scope.serviceId.");
  }
  const scopes = explicitTextList(scope.scopes, "scope.scopes");
  const allowedHosts = explicitTextList(scope.allowedHosts, "scope.allowedHosts", {
    normalize: normalizedHost,
    allowEmpty: true
  });
  if (allowedHosts.some((host) => host === "*" || !HOST_PATTERN.test(host))) {
    throw targetContractError("scope.allowedHosts", "Meshrix local secret target allowedHosts must contain exact host names or addresses.");
  }
  const allowedProtocols = explicitTextList(scope.allowedProtocols, "scope.allowedProtocols", {
    normalize: protocolName,
    allowEmpty: true
  });
  if (allowedProtocols.some((protocol) => !TARGET_ID_PATTERN.test(protocol))) {
    throw targetContractError("scope.allowedProtocols");
  }
  const output = {
    serviceId,
    scopes,
    allowedHosts,
    allowedProtocols
  };
  return output;
}

export function validateLocalSecretTarget(target = null) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw targetContractError("target", "Meshrix local secret writes require an explicit target object.");
  }
  assertKnownKeys(target, TARGET_KEYS, "target");
  return {
    provider: explicitTargetId(target.provider, "provider"),
    family: explicitTargetId(target.family, "family"),
    authType: explicitTargetId(target.authType, "authType"),
    secretRef: assertSecretRef(target.secretRef),
    scope: explicitTargetScope(target.scope)
  };
}

function assertSecretPayload(payload = {}) {
  const secretPayload = asObject(payload, null);
  if (!secretPayload || Object.keys(secretPayload).length === 0) {
    const error = new Error("Meshrix local secret write requires a non-empty JSON object payload.");
    error.code = "local_secret_payload_invalid";
    throw error;
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(secretPayload), "utf8");
  if (payloadBytes > MAX_SECRET_PAYLOAD_BYTES) {
    const error = new Error(`Meshrix local secret payload exceeds the ${MAX_SECRET_PAYLOAD_BYTES} byte limit.`);
    error.code = "local_secret_payload_too_large";
    throw error;
  }
  return secretPayload;
}

function revisionOf(entry = null) {
  const revision = Number(entry?.revision || 0);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function hasExpectedRevision(expectedRevision) {
  return expectedRevision !== undefined && expectedRevision !== null && text(expectedRevision) !== "";
}

function parseExpectedRevision(expectedRevision, secretRef) {
  const revision = Number(expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    const error = new Error(`Meshrix local secret expectedRevision is invalid for ${secretRef}.`);
    error.code = "local_secret_revision_invalid";
    error.secretRef = secretRef;
    error.expectedRevision = expectedRevision;
    throw error;
  }
  return revision;
}

function assertExpectedRevision(entry, expectedRevision, secretRef) {
  if (!hasExpectedRevision(expectedRevision)) return;
  const expected = parseExpectedRevision(expectedRevision, secretRef);
  const actual = revisionOf(entry);
  if (actual !== expected) {
    const error = new Error(`Meshrix local secret revision conflict for ${secretRef}: expected ${expected}, got ${actual}.`);
    error.code = "local_secret_revision_conflict";
    error.secretRef = secretRef;
    error.expectedRevision = expected;
    error.actualRevision = actual;
    throw error;
  }
}

function cleanTextList(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => text(item)).filter(Boolean))];
}

function lifecycleStatus(entry = {}) {
  if (entry?.revokedAt) return "revoked";
  return text(entry?.status || "active").toLowerCase();
}

function entryResolvable(entry = null) {
  return entry?.credentialConfigured === true && lifecycleStatus(entry) === "active";
}

function effectiveSecretScope(metadata = {}) {
  const source = asObject(metadata);
  const nested = asObject(source.scope, null);
  return nested || source;
}

function normalizedHost(value = "") {
  return text(value).toLowerCase().replace(/^\[|\]$/g, "");
}

function protocolName(value = "") {
  return text(value).toLowerCase().replace(/:$/, "");
}

function assertScopeTextMatch({
  scope = {},
  expected = {},
  field = "",
  reasonCode = ""
} = {}) {
  const allowed = text(scope[field]);
  const requested = text(expected[field]);
  if (!requested || allowed === requested) {
    return;
  }
  const error = new Error(`Meshrix local secret scope denied: ${reasonCode || field}.`);
  error.code = "local_secret_scope_denied";
  error.reasonCode = reasonCode || `${field}_mismatch`;
  error.field = field;
  throw error;
}

function assertScopeListIncludes({
  scope = {},
  expected = {},
  scopeField = "",
  expectedValue = "",
  normalize = text,
  reasonCode = "",
  missingReasonCode = ""
} = {}) {
  const allowed = cleanTextList(scope[scopeField]).map((item) => normalize(item)).filter(Boolean);
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
  const error = new Error(`Meshrix local secret scope denied: ${deniedReason}.`);
  error.code = "local_secret_scope_denied";
  error.reasonCode = deniedReason;
  error.field = scopeField;
  throw error;
}

function assertSecretScopeAllowed({
  entry = {},
  secretRef = "",
  expectedScope = {}
} = {}) {
  const expected = asObject(expectedScope, null);
  if (!expected) {
    const error = new Error("Meshrix local secret resolution requires an explicit expected scope.");
    error.code = "local_secret_scope_required";
    error.statusCode = 403;
    error.secretRef = secretRef;
    throw error;
  }
  const unknownExpectedField = Object.keys(expected).find((key) => !EXPECTED_SCOPE_KEYS.has(key));
  if (unknownExpectedField) {
    const error = new Error(`Meshrix local secret expected scope contains an unsupported field: ${unknownExpectedField}.`);
    error.code = "local_secret_scope_invalid";
    error.statusCode = 403;
    error.secretRef = secretRef;
    error.field = unknownExpectedField;
    throw error;
  }
  if (!text(expected.serviceId) || !Array.isArray(expected.requiredScopes)) {
    const error = new Error("Meshrix local secret expected scope requires serviceId and requiredScopes.");
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
      expected,
      scopeField: "allowedHosts",
      expectedValue: expected.host,
      normalize: normalizedHost,
      reasonCode: "host_not_allowed",
      missingReasonCode: "host_required"
    });
    assertScopeListIncludes({
      scope,
      expected,
      scopeField: "allowedProtocols",
      expectedValue: expected.protocol,
      normalize: protocolName,
      reasonCode: "protocol_not_allowed",
      missingReasonCode: "protocol_required"
    });
    for (const requestedScope of cleanTextList(expected.requiredScopes)) {
      assertScopeListIncludes({
        scope,
        expected,
        scopeField: "scopes",
        expectedValue: requestedScope,
        reasonCode: "scope_not_allowed"
      });
    }
  } catch (error) {
    error.secretRef = secretRef;
    error.statusCode = 403;
    throw error;
  }
}

async function readRegistry(dataDir = "") {
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readLocalSecretJson(paths.registryPath, emptyRegistry());
  if (
    !registry ||
    typeof registry !== "object" ||
    Array.isArray(registry) ||
    registry.protocolVersion !== LOCAL_SECRET_STORE_VERSION ||
    !registry.refs ||
    typeof registry.refs !== "object" ||
    Array.isArray(registry.refs)
  ) {
    throw registryContractError();
  }
  for (const [secretRef, entry] of Object.entries(registry.refs)) {
    try {
      if (
        assertSecretRef(secretRef) !== text(entry?.secretRef) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        revisionOf(entry) === 0 ||
        !["active", "revoked"].includes(lifecycleStatus(entry))
      ) {
        throw registryContractError();
      }
    } catch {
      throw registryContractError();
    }
  }
  return {
    ...registry,
    refs: registry.refs
  };
}

async function saveRegistry(dataDir, registry) {
  registry.updatedAt = nowIso();
  const paths = localSecretStorePaths({ dataDir });
  await writeLocalSecretJson(paths.registryPath, registry);
}

function revisionValuePath(paths, secretRef, revision) {
  const valueId = sha256(secretRef).slice(0, 40);
  const mutationId = crypto.randomUUID().replace(/-/g, "");
  return path.join(paths.valuesDir, `${valueId}.r${revision}.${mutationId}.json`);
}

function assertExpectedRevisionProvided(expectedRevision, secretRef) {
  if (!hasExpectedRevision(expectedRevision)) {
    const error = new Error(`Meshrix local secret expectedRevision is required for ${secretRef}.`);
    error.code = "local_secret_revision_required";
    error.secretRef = secretRef;
    throw error;
  }
  return parseExpectedRevision(expectedRevision, secretRef);
}

function assertTargetIdentityMatches(entry, target) {
  for (const field of ["provider", "family", "authType"]) {
    if (text(entry?.[field]) === target[field]) continue;
    const error = new Error(`Meshrix local secret target does not match the configured ${field}.`);
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = field;
    throw error;
  }
  const configuredScope = effectiveSecretScope(entry?.metadata);
  if (JSON.stringify(configuredScope) !== JSON.stringify(target.scope)) {
    const error = new Error("Meshrix local secret target scope does not match the configured binding.");
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = "scope";
    throw error;
  }
}

function targetMetadata(target) {
  return {
    scope: target.scope
  };
}

function publicLocalSecretEntry(entry = {}) {
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
  mutationLock = null
} = {}) {
  const resolvedTarget = validateLocalSecretTarget(target);
  const resolvedSecretRef = resolvedTarget.secretRef;
  const secretPayload = assertSecretPayload(payload);

  const paths = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  await ensureLocalSecretPrivateDir(paths.valuesDir);

  const registry = await readRegistry(paths.dataDir);
  const existing = registry.refs[resolvedSecretRef] || null;
  if (operation === "initialize" && existing) {
    const error = new Error(`Meshrix local secret is already configured: ${resolvedSecretRef}`);
    error.code = "local_secret_already_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "initialize" && hasExpectedRevision(expectedRevision)) {
    const error = new Error("Meshrix local secret initialize does not accept expectedRevision.");
    error.code = "local_secret_revision_unexpected";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !existing) {
    const error = new Error(`Meshrix local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !entryResolvable(existing)) {
    const error = new Error(`Meshrix local secret is not active: ${resolvedSecretRef}`);
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
  const valuePath = revisionValuePath(paths, resolvedSecretRef, revision);
  const valueRecord = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    secretRef: resolvedSecretRef,
    provider: resolvedTarget.provider,
    family: resolvedTarget.family,
    authType: resolvedTarget.authType,
    payload: secretPayload,
    metadata,
    status: "active",
    revision,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    ...(rotatedAt ? { rotatedAt } : {})
  };
  await writeLocalSecretJson(valuePath, valueRecord);

  const entry = {
    secretRef: resolvedSecretRef,
    provider: resolvedTarget.provider,
    family: resolvedTarget.family,
    authType: resolvedTarget.authType,
    storageRef: `local:${path.basename(valuePath)}`,
    valueKeys: Object.keys(secretPayload).sort(),
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
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending = false;
  if (previousValuePath && previousValuePath !== valuePath) {
    await fs.unlink(previousValuePath).catch((error) => {
      if (error?.code !== "ENOENT") staleValueCleanupPending = true;
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

export async function initializeLocalSecret(input = {}) {
  return withMutationLock(input.dataDir, (mutationLock) => writeLocalSecret({
    ...input,
    operation: "initialize",
    mutationLock
  }));
}

export async function rotateLocalSecret(input = {}) {
  return withMutationLock(input.dataDir, (mutationLock) => writeLocalSecret({
    ...input,
    operation: "rotate",
    mutationLock
  }));
}

function localValuePathForEntry(paths, entry = {}) {
  const storageRef = text(entry.storageRef);
  if (!storageRef.startsWith("local:")) return "";
  const fileName = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    return "";
  }
  return path.join(paths.valuesDir, fileName);
}

function canonicalStorageFileName(secretRef, revision, fileName) {
  const valueId = sha256(secretRef).slice(0, 40);
  const pattern = new RegExp(`^${valueId}\\.r${revision}\\.[a-f0-9]{32}\\.json$`, "u");
  return pattern.test(fileName);
}

async function cleanupOrphanValueFiles(dataDir = "") {
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const referencedFiles = new Set(
    Object.values(registry.refs)
      .map((entry) => text(entry.storageRef))
      .filter((storageRef) => storageRef.startsWith("local:"))
      .map((storageRef) => storageRef.slice("local:".length))
  );
  let fileNames;
  try {
    fileNames = await fs.readdir(paths.valuesDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const fileName of fileNames) {
    if (referencedFiles.has(fileName)) continue;
    if (!/^[a-f0-9]{40}\.r[1-9][0-9]*\.[a-f0-9]{32}\.json$/u.test(fileName)) continue;
    await fs.unlink(path.join(paths.valuesDir, fileName)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function valueRecordMatchesEntry(valueRecord, entry, secretRef) {
  if (!valueRecord || typeof valueRecord !== "object" || Array.isArray(valueRecord)) return false;
  if (valueRecord.protocolVersion !== LOCAL_SECRET_STORE_VERSION) return false;
  if (valueRecord.secretRef !== secretRef) return false;
  if (valueRecord.status !== "active" || lifecycleStatus(entry) !== "active") return false;
  if (revisionOf(valueRecord) !== revisionOf(entry)) return false;
  for (const field of ["provider", "family", "authType"]) {
    if (text(valueRecord[field]) !== text(entry[field])) return false;
  }
  if (JSON.stringify(asObject(valueRecord.metadata)) !== JSON.stringify(asObject(entry.metadata))) return false;
  const payload = asObject(valueRecord.payload, null);
  return Boolean(payload && Object.keys(payload).length > 0);
}

async function revokeLocalSecretUnlocked({
  dataDir = "",
  secretRef = "",
  expectedRevision,
  mutationLock = null
} = {}) {
  const resolvedSecretRef = assertSecretRef(secretRef);
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const existing = registry.refs[resolvedSecretRef] || null;
  if (!existing) {
    const error = new Error(`Meshrix local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(existing)) {
    const error = new Error(`Meshrix local secret is not active: ${resolvedSecretRef}`);
    error.code = lifecycleStatus(existing) === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  assertExpectedRevisionProvided(expectedRevision, resolvedSecretRef);
  assertExpectedRevision(existing, expectedRevision, resolvedSecretRef);

  const timestamp = nowIso();
  const previousRevision = revisionOf(existing);
  const revision = previousRevision + 1;
  const entry = {
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
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending = false;
  if (valuePath) {
    await fs.unlink(valuePath).catch((error) => {
      if (error?.code !== "ENOENT") staleValueCleanupPending = true;
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

export async function revokeLocalSecret(input = {}) {
  return withMutationLock(input.dataDir, (mutationLock) => revokeLocalSecretUnlocked({
    ...input,
    mutationLock
  }));
}

export async function resolveLocalSecretPayload({
  dataDir = "",
  secretRef = "",
  expectedRevision = undefined,
  expectedScope = null
} = {}) {
  const resolvedSecretRef = assertSecretRef(secretRef);
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  const entry = registry.refs[resolvedSecretRef] || null;
  if (!entry) {
    const error = new Error(`Meshrix local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(entry)) {
    const status = lifecycleStatus(entry);
    const error = new Error(`Meshrix local secret is not active: ${resolvedSecretRef}`);
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
    const error = new Error(`Meshrix local secret storage is not local for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_unsupported";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const fileName = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    const error = new Error(`Meshrix local secret storage ref is invalid for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!canonicalStorageFileName(resolvedSecretRef, revisionOf(entry), fileName)) {
    const error = new Error(`Meshrix local secret storage ref is not canonical for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const valueRecord = await readLocalSecretJson(path.join(paths.valuesDir, fileName), null);
  if (!valueRecordMatchesEntry(valueRecord, entry, resolvedSecretRef)) {
    const error = new Error(`Meshrix local secret value record does not match ${resolvedSecretRef}.`);
    error.code = "local_secret_value_mismatch";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  return {
    secretRef: resolvedSecretRef,
    provider: entry.provider || valueRecord.provider || "",
    family: entry.family || valueRecord.family || "",
    authType: entry.authType || valueRecord.authType || "",
    status: lifecycleStatus(entry),
    revision: revisionOf(entry),
    metadata: asObject(entry.metadata),
    payload: asObject(valueRecord.payload)
  };
}

export async function listLocalSecretEntries({ dataDir = "" } = {}) {
  const paths = localSecretStorePaths({ dataDir });
  const registry = await readRegistry(paths.dataDir);
  return Object.values(registry.refs)
    .sort((left, right) => String(left.provider || left.secretRef).localeCompare(String(right.provider || right.secretRef)))
    .map(publicLocalSecretEntry);
}
