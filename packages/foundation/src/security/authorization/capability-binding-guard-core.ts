import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { ensurePrivateDir } from "../../storage/private-file-atomic.ts";

export const CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION: any = "v0.0.1:risk-control:capability-binding-guard-1";
export const CAPABILITY_BINDING_GUARD_STATE_VERSION: any = 1;

export const DEFAULT_ALIAS: any = "meshrix-tool-bindings";
export const DEFAULT_NAMESPACE: any = "operation-permission";
const VALID_STATUSES: readonly any[] = Object.freeze(["valid", "invalid"]);
export const RECOVERY_PACKAGE_VERSION: any = "v0.0.1:risk-control:capability-binding-guard-recovery-1";
const AEAD_ALGORITHM: any = "aes-256-gcm";

export function nowIso() : any {
  return new Date().toISOString();
}

export function text(value?: any) : any {
  return String(value || "").trim();
}

export function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function parseIso(value: any = "") : any {
  const timestamp: any = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function parseJson(value?: any, fallback?: any) : any {
  try {
    const parsed: any = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}


export function randomBase64(bytes: any = 32) : any {
  return crypto.randomBytes(bytes).toString("base64");
}

export function resolveDataDir(dataDir: any = "") : any {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

export function sleep(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

export function safeAlias(value: any = DEFAULT_ALIAS) : any {
  return text(value || DEFAULT_ALIAS).replace(/[^a-zA-Z0-9._:-]/g, "_") || DEFAULT_ALIAS;
}

export function normalizeStatus(status: any = "valid") : any {
  const value: any = text(status || "valid");
  return VALID_STATUSES.includes(value) ? value : "invalid";
}

export function hashBase64Url(value: any = "") : any {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

export function lookupHmac(lookupKey?: any, label: any = "", value: any = "") : any {
  const key: any = Buffer.isBuffer(lookupKey)
    ? lookupKey
    : Buffer.from(String(lookupKey || ""), "base64");
  if (key.length < 32) {
    throw new Error("Capability binding guard requires a 256-bit lookup key.");
  }
  return crypto.createHmac("sha256", key)
    .update(`${String(label || "")}\0${String(value || "")}`, "utf8")
    .digest("base64url");
}

export function capabilityBindingGuardStatePath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-binding-guard", `${safeAlias(alias)}.sealed.json`);
}

export function capabilityBindingGuardLocalSealingKeyPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-binding-guard", `${safeAlias(alias)}.sealing-key`);
}

export function capabilityBindingGuardLockPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "locks", `capability-binding-guard-${safeAlias(alias)}.lock`);
}

export async function withPrivateFileLock(lockPath?: any, action?: any, { timeoutMs = 10000, staleMs = 30000 }: Record<string, any> = {}) : Promise<any> {
  ensurePrivateDir(path.dirname(lockPath));
  const startedAt: any = Date.now();
  while (true) {
    let handle: any = null;
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAt: nowIso()
      }));
      await handle.close();
      handle = null;
      try {
        return await action();
      } finally {
        await fs.promises.unlink(lockPath).catch(() : any => {});
      }
    } catch (error: any) {
      if (handle) {
        await handle.close().catch(() : any => {});
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const stat: any = await fs.promises.stat(lockPath).catch(() : any => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.promises.unlink(lockPath).catch(() : any => {});
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for capability binding guard state lock: ${lockPath}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
}

export function normalizeCapabilityBindingContext(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  const userId: any = text(
    source.boundUserId ||
      source.bound_user_id ||
      source.userId ||
      source.user_id ||
      source.subjectId ||
      source.subject_id
  );
  const agentId: any = text(
    source.agentId ||
      source.agent_id ||
      source.agentProfileId ||
      source.agent_profile_id ||
      source.profileId ||
      source.profile_id
  );
  const clientId: any = text(source.clientId || source.client_id || source.clientName || source.client_name);
  const serverId: any = text(source.serverId || source.server_id);
  const packageId: any = text(source.packageId || source.package_id || source.identityPackageId || source.identity_package_id);
  const processKeyId: any = text(source.processKeyId || source.process_key_id);
  const processPublicKeyHash: any = text(source.processPublicKeyHash || source.process_public_key_hash);
  const fingerprintId: any = text(source.fingerprintId || source.fingerprint_id || source.clientFingerprintId || source.client_fingerprint_id);
  const machineInstanceId: any = text(source.machineInstanceId || source.machine_instance_id);
  const appInstanceId: any = text(source.appInstanceId || source.app_instance_id);
  const runtimeInstanceId: any = text(source.runtimeInstanceId || source.runtime_instance_id);
  const clientFingerprintHash: any = text(source.clientFingerprintHash || source.client_fingerprint_hash || source.fingerprintHash || source.fingerprint_hash);
  const identityGeneration: any = text(source.identityGeneration || source.identity_generation);
  const defaultIdentityHash: any = text(source.defaultIdentityHash || source.default_identity_hash);
  return {
    namespace: text(source.namespace || source.bindingNamespace || source.binding_namespace || DEFAULT_NAMESPACE) || DEFAULT_NAMESPACE,
    userId,
    boundUserId: userId,
    agentId,
    agentProfileId: agentId,
    clientId,
    serverId,
    packageId,
    processKeyId,
    processPublicKeyHash,
    fingerprintId,
    machineInstanceId,
    appInstanceId,
    runtimeInstanceId,
    clientFingerprintHash,
    identityGeneration,
    defaultIdentityHash
  };
}

export function capabilityBindingKeyHash(lookupKey?: any, capabilityKey: any = "") : any {
  return lookupHmac(lookupKey, "capability-key", capabilityKey);
}

export function capabilityBindingSubjectHash(lookupKey?: any, subjectType: any = "", value: any = "") : any {
  return lookupHmac(lookupKey, `subject:${subjectType}`, value);
}

export function publicBindingRecord(record: any = null) : any {
  if (!record) {
    return null;
  }
  return {
    protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
    bindingId: text(record.bindingId),
    keyHash: text(record.keyHash),
    credentialId: text(record.credentialId),
    status: normalizeStatus(record.status),
    namespaceHash: text(record.namespaceHash),
    userHash: text(record.userHash),
    agentHash: text(record.agentHash),
    clientHash: text(record.clientHash),
    serverHash: text(record.serverHash),
    packageHash: text(record.packageHash),
    processKeyHash: text(record.processKeyHash),
    processPublicKeyHashHash: text(record.processPublicKeyHashHash),
    fingerprintIdHash: text(record.fingerprintIdHash),
    machineInstanceHash: text(record.machineInstanceHash),
    appInstanceHash: text(record.appInstanceHash),
    runtimeInstanceHash: text(record.runtimeInstanceHash),
    clientFingerprintHashHash: text(record.clientFingerprintHashHash),
    identityGenerationHash: text(record.identityGenerationHash),
    defaultIdentityHashHash: text(record.defaultIdentityHashHash),
    requireNamespace: record.requireNamespace !== false,
    requireUser: record.requireUser === true,
    requireAgent: record.requireAgent === true,
    requireClient: record.requireClient === true,
    requireServer: record.requireServer === true,
    requirePackage: record.requirePackage === true,
    requireProcessKey: record.requireProcessKey === true,
    requireProcessPublicKey: record.requireProcessPublicKey === true,
    requireFingerprintId: record.requireFingerprintId === true,
    requireMachineInstance: record.requireMachineInstance === true,
    requireAppInstance: record.requireAppInstance === true,
    requireRuntimeInstance: record.requireRuntimeInstance === true,
    requireClientFingerprint: record.requireClientFingerprint === true,
    requireIdentityGeneration: record.requireIdentityGeneration === true,
    requireDefaultIdentity: record.requireDefaultIdentity === true,
    bindingStrength: text(record.bindingStrength || "namespace"),
    issuedAt: text(record.issuedAt),
    expiresAt: text(record.expiresAt),
    invalidatedAt: text(record.invalidatedAt),
    invalidationReason: text(record.invalidationReason),
    createdAt: text(record.createdAt),
    updatedAt: text(record.updatedAt)
  };
}

export function bindingRecordFromContext(lookupKey?: any, {
  capabilityKey = "",
  credentialId = "",
  context = {},
  expiresAt = "",
  ttlMs = 0,
  issuedAt = nowIso(),
  status = "valid"
}: Record<string, any> = {}) : any {
  const normalized: any = normalizeCapabilityBindingContext(context);
  const keyHash: any = capabilityBindingKeyHash(lookupKey, capabilityKey);
  const requireUser: any = Boolean(normalized.userId);
  const requireAgent: any = Boolean(normalized.agentId);
  const requireClient: any = Boolean(normalized.clientId);
  const requireServer: any = Boolean(normalized.serverId);
  const requirePackage: any = Boolean(normalized.packageId);
  const requireProcessKey: any = Boolean(normalized.processKeyId);
  const requireProcessPublicKey: any = Boolean(normalized.processPublicKeyHash);
  const requireFingerprintId: any = Boolean(normalized.fingerprintId);
  const requireMachineInstance: any = Boolean(normalized.machineInstanceId);
  const requireAppInstance: any = Boolean(normalized.appInstanceId);
  const requireRuntimeInstance: any = Boolean(normalized.runtimeInstanceId);
  const requireClientFingerprint: any = Boolean(normalized.clientFingerprintHash);
  const requireIdentityGeneration: any = Boolean(normalized.identityGeneration);
  const requireDefaultIdentity: any = Boolean(normalized.defaultIdentityHash);
  const strengths: any = [
    requireUser ? "user" : "",
    requireAgent ? "agent" : "",
    requireClient ? "client" : "",
    requireServer ? "server" : "",
    requirePackage ? "package" : "",
    requireProcessKey ? "process-key" : "",
    requireProcessPublicKey ? "process-public-key" : "",
    requireFingerprintId ? "fingerprint-id" : "",
    requireMachineInstance ? "machine-instance" : "",
    requireAppInstance ? "app-instance" : "",
    requireRuntimeInstance ? "runtime-instance" : "",
    requireClientFingerprint ? "client-fingerprint" : "",
    requireIdentityGeneration ? "identity-generation" : "",
    requireDefaultIdentity ? "default-identity" : ""
  ].filter(Boolean);
  const timestamp: any = nowIso();
  return publicBindingRecord({
    bindingId: `cap_bind_${crypto.randomUUID()}`,
    keyHash,
    credentialId: text(credentialId),
    status,
    namespaceHash: capabilityBindingSubjectHash(lookupKey, "namespace", normalized.namespace),
    userHash: requireUser ? capabilityBindingSubjectHash(lookupKey, "user", normalized.userId) : "",
    agentHash: requireAgent ? capabilityBindingSubjectHash(lookupKey, "agent", normalized.agentId) : "",
    clientHash: requireClient ? capabilityBindingSubjectHash(lookupKey, "client", normalized.clientId) : "",
    serverHash: requireServer ? capabilityBindingSubjectHash(lookupKey, "server", normalized.serverId) : "",
    packageHash: requirePackage ? capabilityBindingSubjectHash(lookupKey, "package", normalized.packageId) : "",
    processKeyHash: requireProcessKey ? capabilityBindingSubjectHash(lookupKey, "process-key", normalized.processKeyId) : "",
    processPublicKeyHashHash: requireProcessPublicKey ? capabilityBindingSubjectHash(lookupKey, "process-public-key", normalized.processPublicKeyHash) : "",
    fingerprintIdHash: requireFingerprintId ? capabilityBindingSubjectHash(lookupKey, "fingerprint-id", normalized.fingerprintId) : "",
    machineInstanceHash: requireMachineInstance ? capabilityBindingSubjectHash(lookupKey, "machine-instance", normalized.machineInstanceId) : "",
    appInstanceHash: requireAppInstance ? capabilityBindingSubjectHash(lookupKey, "app-instance", normalized.appInstanceId) : "",
    runtimeInstanceHash: requireRuntimeInstance ? capabilityBindingSubjectHash(lookupKey, "runtime-instance", normalized.runtimeInstanceId) : "",
    clientFingerprintHashHash: requireClientFingerprint ? capabilityBindingSubjectHash(lookupKey, "client-fingerprint", normalized.clientFingerprintHash) : "",
    identityGenerationHash: requireIdentityGeneration ? capabilityBindingSubjectHash(lookupKey, "identity-generation", normalized.identityGeneration) : "",
    defaultIdentityHashHash: requireDefaultIdentity ? capabilityBindingSubjectHash(lookupKey, "default-identity", normalized.defaultIdentityHash) : "",
    requireNamespace: true,
    requireUser,
    requireAgent,
    requireClient,
    requireServer,
    requirePackage,
    requireProcessKey,
    requireProcessPublicKey,
    requireFingerprintId,
    requireMachineInstance,
    requireAppInstance,
    requireRuntimeInstance,
    requireClientFingerprint,
    requireIdentityGeneration,
    requireDefaultIdentity,
    bindingStrength: strengths.length ? strengths.join("+") : "namespace",
    issuedAt,
    expiresAt: expiresAt || (ttlMs ? new Date(parseIso(issuedAt) + Math.max(1, Number(ttlMs || 0))).toISOString() : ""),
    invalidatedAt: "",
    invalidationReason: "",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function normalizeState(input: Record<string, any> = {}) : any {
  const state: any = asObject(input);
  const normalized: Record<string, any> = {
    stateVersion: Number(state.stateVersion || CAPABILITY_BINDING_GUARD_STATE_VERSION),
    provider: text(state.provider || "unknown"),
    securityMode: text(state.securityMode || "unknown"),
    epoch: Math.max(1, Number(state.epoch || 1)),
    bindingLookupKeyBase64: text(state.bindingLookupKeyBase64),
    bindings: Array.isArray(state.bindings) ? state.bindings.map(publicBindingRecord).filter(Boolean) : [],
    events: Array.isArray(state.events) ? state.events.slice(-2048).map((event?: any) : any => asObject(event)) : [],
    createdAt: text(state.createdAt || nowIso()),
    updatedAt: text(state.updatedAt || nowIso()),
    stateRoot: text(state.stateRoot)
  };
  if (!normalized.bindingLookupKeyBase64 || Buffer.from(normalized.bindingLookupKeyBase64, "base64").length < 32) {
    normalized.bindingLookupKeyBase64 = randomBase64(32);
  }
  normalized.stateRoot = stateRoot(normalized);
  return normalized;
}

export function stateRoot(state: Record<string, any> = {}) : any {
  const normalized: Record<string, any> = {
    stateVersion: Number(state.stateVersion || CAPABILITY_BINDING_GUARD_STATE_VERSION),
    provider: text(state.provider),
    securityMode: text(state.securityMode),
    epoch: Number(state.epoch || 1),
    bindingLookupKeyHash: hashBase64Url(text(state.bindingLookupKeyBase64)),
    bindings: Array.isArray(state.bindings)
      ? state.bindings.map(publicBindingRecord).sort((a?: any, b?: any) : any => `${a.keyHash}:${a.bindingId}`.localeCompare(`${b.keyHash}:${b.bindingId}`))
      : []
  };
  return crypto.createHash("sha256").update(stableJson(normalized), "utf8").digest("base64url");
}

export function sealJson({ sealingKeyBase64 = "", payload = {} }: Record<string, any> = {}) : any {
  const key: any = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Capability binding guard state sealing key must be at least 256 bits.");
  }
  const nonce: any = crypto.randomBytes(12);
  const cipher: any = crypto.createCipheriv(AEAD_ALGORITHM, key.subarray(0, 32), nonce);
  const ciphertext: any = Buffer.concat([
    cipher.update(stableJson(payload), "utf8"),
    cipher.final()
  ]);
  return {
    algorithm: AEAD_ALGORITHM,
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    tagBase64: cipher.getAuthTag().toString("base64")
  };
}

export function openSealedJson({ sealingKeyBase64 = "", sealed = null }: Record<string, any> = {}) : any {
  const key: any = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Capability binding guard state sealing key must be at least 256 bits.");
  }
  const sealedObject: any = asObject(sealed, null);
  if (!sealedObject || sealedObject.algorithm !== AEAD_ALGORITHM) {
    throw new Error("Unsupported capability binding guard sealed state payload.");
  }
  const decipher: any = crypto.createDecipheriv(
    AEAD_ALGORITHM,
    key.subarray(0, 32),
    Buffer.from(text(sealedObject.nonceBase64), "base64")
  );
  decipher.setAuthTag(Buffer.from(text(sealedObject.tagBase64), "base64"));
  const plaintext: any = Buffer.concat([
    decipher.update(Buffer.from(text(sealedObject.ciphertextBase64), "base64")),
    decipher.final()
  ]).toString("utf8");
  return parseJson(plaintext, {});
}


export function validateBindingRecord(record: any = null, { now = nowIso() }: Record<string, any> = {}) : any {
  const normalized: any = publicBindingRecord(record);
  if (!normalized) {
    return { ok: false, reasonCode: "binding_unknown" };
  }
  if (normalized.status !== "valid") {
    return { ok: false, reasonCode: "binding_invalid", credentialId: normalized.credentialId };
  }
  if (normalized.expiresAt && parseIso(normalized.expiresAt) <= parseIso(now)) {
    return { ok: false, reasonCode: "binding_expired", credentialId: normalized.credentialId };
  }
  return { ok: true, record: normalized };
}

export function matchesRecord(lookupKey?: any, record: Record<string, any> = {}, context: Record<string, any> = {}, { now = nowIso() }: Record<string, any> = {}) : any {
  const checked: any = validateBindingRecord(record, { now });
  if (!checked.ok) {
    return checked;
  }
  const normalized: any = normalizeCapabilityBindingContext(context);
  const expectedNamespace: any = capabilityBindingSubjectHash(lookupKey, "namespace", normalized.namespace);
  if (record.requireNamespace !== false && record.namespaceHash !== expectedNamespace) {
    return { ok: false, reasonCode: "binding_namespace_mismatch", credentialId: record.credentialId };
  }
  if (record.requireUser) {
    if (!normalized.userId) {
      return { ok: false, reasonCode: "binding_user_missing", credentialId: record.credentialId };
    }
    if (record.userHash !== capabilityBindingSubjectHash(lookupKey, "user", normalized.userId)) {
      return { ok: false, reasonCode: "binding_user_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireAgent) {
    if (!normalized.agentId) {
      return { ok: false, reasonCode: "binding_agent_missing", credentialId: record.credentialId };
    }
    if (record.agentHash !== capabilityBindingSubjectHash(lookupKey, "agent", normalized.agentId)) {
      return { ok: false, reasonCode: "binding_agent_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireClient) {
    if (!normalized.clientId) {
      return { ok: false, reasonCode: "binding_client_missing", credentialId: record.credentialId };
    }
    if (record.clientHash !== capabilityBindingSubjectHash(lookupKey, "client", normalized.clientId)) {
      return { ok: false, reasonCode: "binding_client_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireServer) {
    if (!normalized.serverId) {
      return { ok: false, reasonCode: "binding_server_missing", credentialId: record.credentialId };
    }
    if (record.serverHash !== capabilityBindingSubjectHash(lookupKey, "server", normalized.serverId)) {
      return { ok: false, reasonCode: "binding_server_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requirePackage) {
    if (!normalized.packageId) {
      return { ok: false, reasonCode: "binding_package_missing", credentialId: record.credentialId };
    }
    if (record.packageHash !== capabilityBindingSubjectHash(lookupKey, "package", normalized.packageId)) {
      return { ok: false, reasonCode: "binding_package_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireProcessKey) {
    if (!normalized.processKeyId) {
      return { ok: false, reasonCode: "binding_process_key_missing", credentialId: record.credentialId };
    }
    if (record.processKeyHash !== capabilityBindingSubjectHash(lookupKey, "process-key", normalized.processKeyId)) {
      return { ok: false, reasonCode: "binding_process_key_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireProcessPublicKey) {
    if (!normalized.processPublicKeyHash) {
      return { ok: false, reasonCode: "binding_process_public_key_missing", credentialId: record.credentialId };
    }
    if (record.processPublicKeyHashHash !== capabilityBindingSubjectHash(lookupKey, "process-public-key", normalized.processPublicKeyHash)) {
      return { ok: false, reasonCode: "binding_process_public_key_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireFingerprintId) {
    if (!normalized.fingerprintId) {
      return { ok: false, reasonCode: "binding_fingerprint_id_missing", credentialId: record.credentialId };
    }
    if (record.fingerprintIdHash !== capabilityBindingSubjectHash(lookupKey, "fingerprint-id", normalized.fingerprintId)) {
      return { ok: false, reasonCode: "binding_fingerprint_id_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireMachineInstance) {
    if (!normalized.machineInstanceId) {
      return { ok: false, reasonCode: "binding_machine_instance_missing", credentialId: record.credentialId };
    }
    if (record.machineInstanceHash !== capabilityBindingSubjectHash(lookupKey, "machine-instance", normalized.machineInstanceId)) {
      return { ok: false, reasonCode: "binding_machine_instance_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireAppInstance) {
    if (!normalized.appInstanceId) {
      return { ok: false, reasonCode: "binding_app_instance_missing", credentialId: record.credentialId };
    }
    if (record.appInstanceHash !== capabilityBindingSubjectHash(lookupKey, "app-instance", normalized.appInstanceId)) {
      return { ok: false, reasonCode: "binding_app_instance_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireRuntimeInstance) {
    if (!normalized.runtimeInstanceId) {
      return { ok: false, reasonCode: "binding_runtime_instance_missing", credentialId: record.credentialId };
    }
    if (record.runtimeInstanceHash !== capabilityBindingSubjectHash(lookupKey, "runtime-instance", normalized.runtimeInstanceId)) {
      return { ok: false, reasonCode: "binding_runtime_instance_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireClientFingerprint) {
    if (!normalized.clientFingerprintHash) {
      return { ok: false, reasonCode: "binding_client_fingerprint_missing", credentialId: record.credentialId };
    }
    if (record.clientFingerprintHashHash !== capabilityBindingSubjectHash(lookupKey, "client-fingerprint", normalized.clientFingerprintHash)) {
      return { ok: false, reasonCode: "binding_client_fingerprint_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireIdentityGeneration) {
    if (!normalized.identityGeneration) {
      return { ok: false, reasonCode: "binding_identity_generation_missing", credentialId: record.credentialId };
    }
    if (record.identityGenerationHash !== capabilityBindingSubjectHash(lookupKey, "identity-generation", normalized.identityGeneration)) {
      return { ok: false, reasonCode: "binding_identity_generation_mismatch", credentialId: record.credentialId };
    }
  }
  if (record.requireDefaultIdentity) {
    if (!normalized.defaultIdentityHash) {
      return { ok: false, reasonCode: "binding_default_identity_missing", credentialId: record.credentialId };
    }
    if (record.defaultIdentityHashHash !== capabilityBindingSubjectHash(lookupKey, "default-identity", normalized.defaultIdentityHash)) {
      return { ok: false, reasonCode: "binding_default_identity_mismatch", credentialId: record.credentialId };
    }
  }
  return {
    ok: true,
    reasonCode: "capability_binding_valid",
    credentialId: record.credentialId,
    bindingId: record.bindingId,
    bindingStrength: record.bindingStrength,
    requireUser: record.requireUser,
    requireAgent: record.requireAgent,
    requireClient: record.requireClient,
    requireServer: record.requireServer,
    requirePackage: record.requirePackage,
    requireProcessKey: record.requireProcessKey,
    requireProcessPublicKey: record.requireProcessPublicKey,
    requireFingerprintId: record.requireFingerprintId,
    requireMachineInstance: record.requireMachineInstance,
    requireAppInstance: record.requireAppInstance,
    requireRuntimeInstance: record.requireRuntimeInstance,
    requireClientFingerprint: record.requireClientFingerprint,
    requireIdentityGeneration: record.requireIdentityGeneration,
    requireDefaultIdentity: record.requireDefaultIdentity
  };
}

export { stableJson };
