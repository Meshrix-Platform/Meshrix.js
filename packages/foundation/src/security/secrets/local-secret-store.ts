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
import {
  decryptLocalSecretPayload,
  encryptLocalSecretPayload
} from "./local-secret-envelope.ts";
import {
  resolveLocalSecretKeyProvider
} from "./local-secret-key-provider.ts";

export const LOCAL_SECRET_STORE_VERSION: any = "v0.0.1:risk-control:local-secret-store-2";

const TARGET_ID_PATTERN: any = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SECRET_REF_PATTERN: any = /^secret:\/\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/u;
const HOST_PATTERN: any = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[a-f0-9:]+)$/iu;
const MAX_SECRET_PAYLOAD_BYTES: any = 1024 * 1024;
const TARGET_KEYS: any = new Set<any>(["provider", "family", "authType", "secretRef", "scope"]);
const TARGET_SCOPE_KEYS: any = new Set<any>(["serviceId", "scopes", "allowedHosts", "allowedProtocols"]);
const EXPECTED_SCOPE_KEYS: any = new Set<any>(["serviceId", "requiredScopes", "host", "protocol"]);

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function withMutationLock(dataDir?: any, callback?: any) : Promise<any> {
  return withLocalSecretMutationLock(dataDir, async (lock?: any) : Promise<any> => {
    await cleanupOrphanValueFiles(dataDir);
    return await callback(lock);
  });
}

function emptyRegistry() : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    updatedAt: nowIso(),
    refs: {}
  };
}

function registryContractError() : any {
  const error: Error & Record<string, any> = new Error("Meshrix.js local secret registry is invalid.");
  error.code = "local_secret_registry_invalid";
  return error;
}

function targetContractError(field?: any, message: any = "") : any {
  const error: Error & Record<string, any> = new Error(message || `Meshrix.js local secret target field ${field} is invalid.`);
  error.code = "local_secret_target_invalid";
  error.field = field;
  return error;
}

function explicitTargetId(value?: any, field?: any) : any {
  const source: any = typeof value === "string" ? value : "";
  const raw: any = text(source);
  const normalized: any = raw.toLowerCase();
  if (source !== raw || raw !== normalized || !TARGET_ID_PATTERN.test(normalized)) {
    throw targetContractError(field);
  }
  return normalized;
}

function assertKnownKeys(value?: any, allowedKeys?: any, field?: any) : any {
  const unknown: any = Object.keys(asObject(value)).find((key?: any) : any => !allowedKeys.has(key));
  if (unknown) {
    throw targetContractError(`${field}.${unknown}`, `Meshrix.js local secret target contains an unsupported field: ${field}.${unknown}.`);
  }
}

function assertSecretRef(secretRef: any = "") : any {
  const source: any = typeof secretRef === "string" ? secretRef : "";
  const value: any = text(source);
  if (source !== value || !SECRET_REF_PATTERN.test(value)) {
    throw targetContractError("secretRef", "Meshrix.js local secret target requires an explicit canonical secret:// reference.");
  }
  const segments: any = value.slice("secret://".length).split("/");
  if (segments.some((segment?: any) : any => segment === "." || segment === "..")) {
    throw targetContractError("secretRef", "Meshrix.js local secret target secretRef cannot contain relative path segments.");
  }
  return value;
}

function explicitTextList(value?: any, field?: any, { normalize = text, allowEmpty = false }: Record<string, any> = {}) : any {
  if (!Array.isArray(value)) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} must be an explicit array.`);
  }
  const normalizedValues: any = value.map((item?: any) : any => normalize(item));
  if (value.some((item?: any, index?: any) : any => typeof item !== "string" || item !== normalizedValues[index])) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} must use canonical string values.`);
  }
  const values: any[] = [...new Set<any>(normalizedValues.filter(Boolean))];
  if (!allowEmpty && values.length === 0) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} cannot be empty.`);
  }
  if (values.length !== value.length) {
    throw targetContractError(field, `Meshrix.js local secret target field ${field} contains an empty or duplicate value.`);
  }
  return values;
}

function explicitTargetScope(scope: any = null) : any {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw targetContractError("scope", "Meshrix.js local secret target requires an explicit scope object.");
  }
  assertKnownKeys(scope, TARGET_SCOPE_KEYS, "scope");
  const serviceId: any = text(scope.serviceId);
  if (typeof scope.serviceId !== "string" || scope.serviceId !== serviceId || !serviceId) {
    throw targetContractError("scope.serviceId", "Meshrix.js local secret target requires scope.serviceId.");
  }
  const scopes: any = explicitTextList(scope.scopes, "scope.scopes");
  const allowedHosts: any = explicitTextList(scope.allowedHosts, "scope.allowedHosts", {
    normalize: normalizedHost,
    allowEmpty: true
  });
  if (allowedHosts.some((host?: any) : any => host === "*" || !HOST_PATTERN.test(host))) {
    throw targetContractError("scope.allowedHosts", "Meshrix.js local secret target allowedHosts must contain exact host names or addresses.");
  }
  const allowedProtocols: any = explicitTextList(scope.allowedProtocols, "scope.allowedProtocols", {
    normalize: protocolName,
    allowEmpty: true
  });
  if (allowedProtocols.some((protocol?: any) : any => !TARGET_ID_PATTERN.test(protocol))) {
    throw targetContractError("scope.allowedProtocols");
  }
  const output: Record<string, any> = {
    serviceId,
    scopes,
    allowedHosts,
    allowedProtocols
  };
  return output;
}

export function validateLocalSecretTarget(target: any = null) : any {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw targetContractError("target", "Meshrix.js local secret writes require an explicit target object.");
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

function assertSecretPayload(payload: Record<string, any> = {}) : any {
  const secretPayload: any = asObject(payload, null);
  if (!secretPayload || Object.keys(secretPayload).length === 0) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret write requires a non-empty JSON object payload.");
    error.code = "local_secret_payload_invalid";
    throw error;
  }
  const payloadBytes: any = Buffer.byteLength(JSON.stringify(secretPayload), "utf8");
  if (payloadBytes > MAX_SECRET_PAYLOAD_BYTES) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret payload exceeds the ${MAX_SECRET_PAYLOAD_BYTES} byte limit.`);
    error.code = "local_secret_payload_too_large";
    throw error;
  }
  return secretPayload;
}

function revisionOf(entry: any = null) : any {
  const revision: any = Number(entry?.revision || 0);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function hasExpectedRevision(expectedRevision?: any) : any {
  return expectedRevision !== undefined && expectedRevision !== null && text(expectedRevision) !== "";
}

function parseExpectedRevision(expectedRevision?: any, secretRef?: any) : any {
  const revision: any = Number(expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret expectedRevision is invalid for ${secretRef}.`);
    error.code = "local_secret_revision_invalid";
    error.secretRef = secretRef;
    error.expectedRevision = expectedRevision;
    throw error;
  }
  return revision;
}

function assertExpectedRevision(entry?: any, expectedRevision?: any, secretRef?: any) : any {
  if (!hasExpectedRevision(expectedRevision)) return;
  const expected: any = parseExpectedRevision(expectedRevision, secretRef);
  const actual: any = revisionOf(entry);
  if (actual !== expected) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret revision conflict for ${secretRef}: expected ${expected}, got ${actual}.`);
    error.code = "local_secret_revision_conflict";
    error.secretRef = secretRef;
    error.expectedRevision = expected;
    error.actualRevision = actual;
    throw error;
  }
}

function cleanTextList(value?: any) : any {
  const values: any = Array.isArray(value) ? value : [value];
  return [...new Set<any>(values.map((item?: any) : any => text(item)).filter(Boolean))];
}

function lifecycleStatus(entry: Record<string, any> = {}) : any {
  if (entry?.revokedAt) return "revoked";
  return text(entry?.status || "active").toLowerCase();
}

function entryResolvable(entry: any = null) : any {
  return entry?.credentialConfigured === true && lifecycleStatus(entry) === "active";
}

function effectiveSecretScope(metadata: Record<string, any> = {}) : any {
  const source: any = asObject(metadata);
  const nested: any = asObject(source.scope, null);
  return nested || source;
}

function normalizedHost(value: any = "") : any {
  return text(value).toLowerCase().replace(/^\[|\]$/g, "");
}

function protocolName(value: any = "") : any {
  return text(value).toLowerCase().replace(/:$/, "");
}

function assertScopeTextMatch({
  scope = {},
  expected = {},
  field = "",
  reasonCode = ""
}: Record<string, any> = {}) : any {
  const allowed: any = text(scope[field]);
  const requested: any = text(expected[field]);
  if (!requested || allowed === requested) {
    return;
  }
  const error: Error & Record<string, any> = new Error(`Meshrix.js local secret scope denied: ${reasonCode || field}.`);
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
}: Record<string, any> = {}) : any {
  const allowed: any = cleanTextList(scope[scopeField]).map((item?: any) : any => normalize(item)).filter(Boolean);
  const requested: any = normalize(expectedValue);
  if (!requested && allowed.length === 0) {
    return;
  }
  if (requested && allowed.includes(requested)) {
    return;
  }
  const deniedReason: any = !requested
    ? missingReasonCode || reasonCode || `${scopeField}_required`
    : reasonCode || `${scopeField}_not_allowed`;
  const error: Error & Record<string, any> = new Error(`Meshrix.js local secret scope denied: ${deniedReason}.`);
  error.code = "local_secret_scope_denied";
  error.reasonCode = deniedReason;
  error.field = scopeField;
  throw error;
}

function assertSecretScopeAllowed({
  entry = {},
  secretRef = "",
  expectedScope = {}
}: Record<string, any> = {}) : any {
  const expected: any = asObject(expectedScope, null);
  if (!expected) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret resolution requires an explicit expected scope.");
    error.code = "local_secret_scope_required";
    error.statusCode = 403;
    error.secretRef = secretRef;
    throw error;
  }
  const unknownExpectedField: any = Object.keys(expected).find((key?: any) : any => !EXPECTED_SCOPE_KEYS.has(key));
  if (unknownExpectedField) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret expected scope contains an unsupported field: ${unknownExpectedField}.`);
    error.code = "local_secret_scope_invalid";
    error.statusCode = 403;
    error.secretRef = secretRef;
    error.field = unknownExpectedField;
    throw error;
  }
  if (!text(expected.serviceId) || !Array.isArray(expected.requiredScopes)) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret expected scope requires serviceId and requiredScopes.");
    error.code = "local_secret_scope_invalid";
    error.statusCode = 403;
    error.secretRef = secretRef;
    throw error;
  }
  const scope: any = effectiveSecretScope(entry.metadata);
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
  } catch (error: any) {
    error.secretRef = secretRef;
    error.statusCode = 403;
    throw error;
  }
}

async function readRegistry(dataDir: any = "") : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir });
  const registry: any = await readLocalSecretJson(paths.registryPath, emptyRegistry());
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
  for (const [secretRef, entry] of (Object.entries(registry.refs) as [string, any][])) {
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

async function saveRegistry(dataDir?: any, registry?: any) : Promise<any> {
  registry.updatedAt = nowIso();
  const paths: any = localSecretStorePaths({ dataDir });
  await writeLocalSecretJson(paths.registryPath, registry);
}

function revisionValuePath(paths?: any, secretRef?: any, revision?: any) : any {
  const valueId: any = sha256(secretRef).slice(0, 40);
  const mutationId: any = crypto.randomUUID().replace(/-/g, "");
  return path.join(paths.valuesDir, `${valueId}.r${revision}.${mutationId}.json`);
}

function assertExpectedRevisionProvided(expectedRevision?: any, secretRef?: any) : any {
  if (!hasExpectedRevision(expectedRevision)) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret expectedRevision is required for ${secretRef}.`);
    error.code = "local_secret_revision_required";
    error.secretRef = secretRef;
    throw error;
  }
  return parseExpectedRevision(expectedRevision, secretRef);
}

function assertTargetIdentityMatches(entry?: any, target?: any) : any {
  for (const field of ["provider", "family", "authType"]) {
    if (text(entry?.[field]) === target[field]) continue;
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret target does not match the configured ${field}.`);
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = field;
    throw error;
  }
  const configuredScope: any = effectiveSecretScope(entry?.metadata);
  if (JSON.stringify(configuredScope) !== JSON.stringify(target.scope)) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret target scope does not match the configured binding.");
    error.code = "local_secret_target_mismatch";
    error.secretRef = target.secretRef;
    error.field = "scope";
    throw error;
  }
}

function targetMetadata(target?: any) : any {
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
}: Record<string, any> = {}) : any {
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

function publicLocalSecretEntry(entry: Record<string, any> = {}) : any {
  const scope: any = effectiveSecretScope(entry.metadata);
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
}: Record<string, any> = {}) : Promise<any> {
  const resolvedTarget: any = validateLocalSecretTarget(target);
  const resolvedSecretRef: any = resolvedTarget.secretRef;
  const secretPayload: any = assertSecretPayload(payload);

  const paths: any = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  await ensureLocalSecretPrivateDir(paths.valuesDir);

  const registry: any = await readRegistry(paths.dataDir);
  const existing: any = registry.refs[resolvedSecretRef] || null;
  if (operation === "initialize" && existing) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is already configured: ${resolvedSecretRef}`);
    error.code = "local_secret_already_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "initialize" && hasExpectedRevision(expectedRevision)) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret initialize does not accept expectedRevision.");
    error.code = "local_secret_revision_unexpected";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !existing) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate" && !entryResolvable(existing)) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`);
    error.code = lifecycleStatus(existing) === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (operation === "rotate") {
    assertExpectedRevisionProvided(expectedRevision, resolvedSecretRef);
    assertExpectedRevision(existing, expectedRevision, resolvedSecretRef);
    assertTargetIdentityMatches(existing, resolvedTarget);
  }
  const timestamp: any = nowIso();
  const previousRevision: any = revisionOf(existing);
  const revision: any = previousRevision + 1;
  const rotatedAt: any = operation === "rotate" ? timestamp : "";
  const metadata: any = targetMetadata(resolvedTarget);
  const valueKeys: any = Object.keys(secretPayload).sort();
  const resolvedKeyProvider: any = resolveLocalSecretKeyProvider({
    dataDir: paths.dataDir,
    keyProvider
  });
  const envelope: any = await encryptLocalSecretPayload({
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
  const valuePath: any = revisionValuePath(paths, resolvedSecretRef, revision);
  const valueRecord: Record<string, any> = {
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

  const entry: Record<string, any> = {
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
  const previousValuePath: any = existing ? localValuePathForEntry(paths, existing) : "";
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending: any = false;
  if (previousValuePath && previousValuePath !== valuePath) {
    await fs.unlink(previousValuePath).catch((error?: any) : any => {
      if (error?.code !== "ENOENT") staleValueCleanupPending = true;
    });
  }

  const event: any = operation === "rotate" ? "secret.rotated" : "secret.initialized";
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

export async function initializeLocalSecret(input: Record<string, any> = {}) : Promise<any> {
  return withMutationLock(input.dataDir, (mutationLock?: any) : any => writeLocalSecret({
    ...input,
    operation: "initialize",
    mutationLock
  }));
}

export async function rotateLocalSecret(input: Record<string, any> = {}) : Promise<any> {
  return withMutationLock(input.dataDir, (mutationLock?: any) : any => writeLocalSecret({
    ...input,
    operation: "rotate",
    mutationLock
  }));
}

export async function rotateLocalSecretMasterKey({
  dataDir = "",
  currentKeyProvider = null,
  nextKeyProvider = null
}: Record<string, any> = {}) : Promise<any> {
  if (!currentKeyProvider || !nextKeyProvider) {
    const error: Error & Record<string, any> = new Error("Meshrix.js local secret master-key rotation requires current and next key providers.");
    error.code = "local_secret_master_key_rotation_provider_required";
    throw error;
  }
  return withMutationLock(dataDir, async (mutationLock?: any) : Promise<any> => {
    const paths: any = localSecretStorePaths({ dataDir });
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
        const error: Error & Record<string, any> = new Error("Meshrix.js local secret master-key rotation requires a distinct next key.");
        error.code = "local_secret_master_key_rotation_same_key";
        throw error;
      }
    } finally {
      currentKeyFact?.key?.fill(0);
      nextKeyFact?.key?.fill(0);
    }

    const registry: any = await readRegistry(paths.dataDir);
    const activeEntries: any = (Object.entries(registry.refs) as [string, any][])
      .filter(([, entry]: any[]) : any => entryResolvable(entry))
      .sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right));
    const staged: any[] = [];
    let registryCommitted: any = false;
    try {
      for (const [secretRef, entry] of activeEntries) {
        const currentValuePath: any = localValuePathForEntry(paths, entry);
        const currentValueRecord: any = await readLocalSecretJson(currentValuePath, null);
        if (!valueRecordMatchesEntry(currentValueRecord, entry, secretRef)) {
          const error: Error & Record<string, any> = new Error("Meshrix.js local secret master-key rotation found an invalid value record.");
          error.code = "local_secret_master_key_rotation_value_invalid";
          throw error;
        }
        const binding: any = secretEnvelopeBinding({
          secretRef,
          provider: entry.provider,
          family: entry.family,
          authType: entry.authType,
          revision: revisionOf(entry),
          metadata: entry.metadata,
          valueKeys: entry.valueKeys
        });
        const payload: any = await decryptLocalSecretPayload({
          envelope: currentValueRecord.envelope,
          binding,
          keyProvider: currentKeyProvider
        });
        const nextEnvelope: any = await encryptLocalSecretPayload({
          payload,
          binding,
          keyProvider: nextKeyProvider
        });
        const nextValuePath: any = revisionValuePath(paths, secretRef, revisionOf(entry));
        const nextValueRecord: Record<string, any> = {
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
      let staleValueCleanupPending: any = 0;
      for (const item of staged) {
        await fs.unlink(item.currentValuePath).catch((error?: any) : any => {
          if (error?.code !== "ENOENT") staleValueCleanupPending += 1;
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
    } catch (error: any) {
      if (!registryCommitted) {
        await Promise.all(
          staged.map((item?: any) : any => fs.unlink(item.nextValuePath).catch(() : any => {}))
        );
      }
      throw error;
    }
  });
}

function localValuePathForEntry(paths?: any, entry: Record<string, any> = {}) : any {
  const storageRef: any = text(entry.storageRef);
  if (!storageRef.startsWith("local:")) return "";
  const fileName: any = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    return "";
  }
  return path.join(paths.valuesDir, fileName);
}

function canonicalStorageFileName(secretRef?: any, revision?: any, fileName?: any) : any {
  const valueId: any = sha256(secretRef).slice(0, 40);
  const pattern: any = new RegExp(`^${valueId}\\.r${revision}\\.[a-f0-9]{32}\\.json$`, "u");
  return pattern.test(fileName);
}

async function cleanupOrphanValueFiles(dataDir: any = "") : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir });
  const registry: any = await readRegistry(paths.dataDir);
  const referencedFiles: any = new Set<any>(
    (Object.values(registry.refs) as any[])
      .map((entry?: any) : any => text(entry.storageRef))
      .filter((storageRef?: any) : any => storageRef.startsWith("local:"))
      .map((storageRef?: any) : any => storageRef.slice("local:".length))
  );
  let fileNames: any;
  try {
    fileNames = await fs.readdir(paths.valuesDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const fileName of fileNames) {
    if (referencedFiles.has(fileName)) continue;
    if (!/^[a-f0-9]{40}\.r[1-9][0-9]*\.[a-f0-9]{32}\.json$/u.test(fileName)) continue;
    await fs.unlink(path.join(paths.valuesDir, fileName)).catch((error?: any) : any => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function valueRecordMatchesEntry(valueRecord?: any, entry?: any, secretRef?: any) : any {
  if (!valueRecord || typeof valueRecord !== "object" || Array.isArray(valueRecord)) return false;
  if (valueRecord.protocolVersion !== LOCAL_SECRET_STORE_VERSION) return false;
  if (valueRecord.secretRef !== secretRef) return false;
  if (valueRecord.status !== "active" || lifecycleStatus(entry) !== "active") return false;
  if (revisionOf(valueRecord) !== revisionOf(entry)) return false;
  for (const field of ["provider", "family", "authType"]) {
    if (text(valueRecord[field]) !== text(entry[field])) return false;
  }
  if (JSON.stringify(asObject(valueRecord.metadata)) !== JSON.stringify(asObject(entry.metadata))) return false;
  if (Object.hasOwn(valueRecord, "payload")) return false;
  return Boolean(
    valueRecord.envelope &&
    typeof valueRecord.envelope === "object" &&
    !Array.isArray(valueRecord.envelope)
  );
}

async function revokeLocalSecretUnlocked({
  dataDir = "",
  secretRef = "",
  expectedRevision,
  mutationLock = null
}: Record<string, any> = {}) : Promise<any> {
  const resolvedSecretRef: any = assertSecretRef(secretRef);
  const paths: any = localSecretStorePaths({ dataDir });
  const registry: any = await readRegistry(paths.dataDir);
  const existing: any = registry.refs[resolvedSecretRef] || null;
  if (!existing) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(existing)) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`);
    error.code = lifecycleStatus(existing) === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  assertExpectedRevisionProvided(expectedRevision, resolvedSecretRef);
  assertExpectedRevision(existing, expectedRevision, resolvedSecretRef);

  const timestamp: any = nowIso();
  const previousRevision: any = revisionOf(existing);
  const revision: any = previousRevision + 1;
  const entry: Record<string, any> = {
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
  const valuePath: any = localValuePathForEntry(paths, existing);
  await assertLocalSecretMutationLockOwned(mutationLock);
  await saveRegistry(paths.dataDir, registry);
  let staleValueCleanupPending: any = false;
  if (valuePath) {
    await fs.unlink(valuePath).catch((error?: any) : any => {
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

export async function revokeLocalSecret(input: Record<string, any> = {}) : Promise<any> {
  return withMutationLock(input.dataDir, (mutationLock?: any) : any => revokeLocalSecretUnlocked({
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
}: Record<string, any> = {}) : Promise<any> {
  const resolvedSecretRef: any = assertSecretRef(secretRef);
  const paths: any = localSecretStorePaths({ dataDir });
  const registry: any = await readRegistry(paths.dataDir);
  const entry: any = registry.refs[resolvedSecretRef] || null;
  if (!entry) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not configured: ${resolvedSecretRef}`);
    error.code = "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!entryResolvable(entry)) {
    const status: any = lifecycleStatus(entry);
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret is not active: ${resolvedSecretRef}`);
    error.code = status === "revoked" ? "local_secret_revoked" : "local_secret_not_configured";
    error.secretRef = resolvedSecretRef;
    error.status = status;
    throw error;
  }
  if (hasExpectedRevision(expectedRevision)) {
    assertExpectedRevision(entry, expectedRevision, resolvedSecretRef);
  }
  assertSecretScopeAllowed({ entry, secretRef: resolvedSecretRef, expectedScope });
  const storageRef: any = text(entry.storageRef);
  if (!storageRef.startsWith("local:")) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret storage is not local for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_unsupported";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const fileName: any = storageRef.slice("local:".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret storage ref is invalid for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  if (!canonicalStorageFileName(resolvedSecretRef, revisionOf(entry), fileName)) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret storage ref is not canonical for ${resolvedSecretRef}.`);
    error.code = "local_secret_storage_invalid";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const valueRecord: any = await readLocalSecretJson(path.join(paths.valuesDir, fileName), null);
  if (!valueRecordMatchesEntry(valueRecord, entry, resolvedSecretRef)) {
    const error: Error & Record<string, any> = new Error(`Meshrix.js local secret value record does not match ${resolvedSecretRef}.`);
    error.code = "local_secret_value_mismatch";
    error.secretRef = resolvedSecretRef;
    throw error;
  }
  const payload: any = await decryptLocalSecretPayload({
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

export async function listLocalSecretEntries({ dataDir = "" }: Record<string, any> = {}) : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir });
  const registry: any = await readRegistry(paths.dataDir);
  return (Object.values(registry.refs) as any[])
    .sort((left?: any, right?: any) : any => String(left.provider || left.secretRef).localeCompare(String(right.provider || right.secretRef)))
    .map(publicLocalSecretEntry);
}
