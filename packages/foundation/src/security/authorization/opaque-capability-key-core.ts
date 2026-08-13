import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfig } from "#meshrix/server-config";
import {
  normalizeKernelCapabilities,
  normalizeRegisteredToolCapabilities,
  unknownKernelCapabilities
} from "#meshrix/authorization-engine";
import { stringsFrom, uniqueStrings } from "./authorization-engine-common.ts";
import { ensurePrivateDir } from "../../storage/private-file-atomic.ts";

export const OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION: any = "v0.0.1:risk-control:opaque-capability-key-1";

export const DEFAULT_ALIAS: any = "meshrix-opaque-capability-key";
export const DEFAULT_TTL_MS: any = 1000 * 60 * 60 * 24 * 30;
const VALID_STATUSES: readonly any[] = Object.freeze(["valid", "invalid"]);
const KERNEL_STATE_VERSION: any = 1;
export const RECOVERY_PACKAGE_VERSION: any = "v0.0.1:risk-control:capability-kernel-recovery-1";
const AEAD_ALGORITHM: any = "aes-256-gcm";

export function repoRoot() : any {
  return path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
}

export function helperScriptPath() : any {
  return path.join(repoRoot(), "server", "scripts", "meshrix-opaque-capability-key-helper.ts");
}

export function nowIso() : any {
  return new Date().toISOString();
}

export function parseIso(value: any = "") : any {
  const timestamp: any = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function text(value?: any) : any {
  return String(value || "").trim();
}

export function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}


export function parseJson(value?: any, fallback?: any) : any {
  try {
    const parsed: any = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
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

export function capabilityKernelStatePath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-kernel", `${safeAlias(alias)}.sealed.json`);
}

export function capabilityKernelLocalSealingKeyPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-kernel", `${safeAlias(alias)}.sealing-key`);
}

export function capabilityKernelLockPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "locks", `capability-kernel-${safeAlias(alias)}.lock`);
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
        throw new Error(`Timed out waiting for capability kernel state lock: ${lockPath}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
}

export function canonicalOpaqueCapabilities(capabilities: any = [], trustedCapabilityPermissions: any = []) : any {
  const trusted: any = new Set<any>(normalizeRegisteredToolCapabilities(trustedCapabilityPermissions));
  return uniqueStrings(stringsFrom(
    normalizeKernelCapabilities(capabilities),
    stringsFrom(capabilities).filter((capability?: any) : any => trusted.has(capability))
  )).sort();
}

export function rejectUnknownOpaqueCapabilities(capabilities: any = [], trustedCapabilityPermissions: any = []) : any {
  const trusted: any = new Set<any>(normalizeRegisteredToolCapabilities(trustedCapabilityPermissions));
  const unknown: any = unknownKernelCapabilities(capabilities).filter((capability?: any) : any => !trusted.has(capability));
  if (unknown.length > 0) {
    throw new Error(`Unknown opaque capability permission: ${unknown.join(", ")}`);
  }
}

export function opaqueCapabilityHash(capabilities: any = [], trustedCapabilityPermissions: any = []) : any {
  return crypto.createHash("sha256")
    .update(stableJson(canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions)))
    .digest("base64url");
}

export function createCapabilityKey() : any {
  return `ock_${crypto.randomBytes(32).toString("base64url")}`;
}

export function capabilityKeyHash(runtimeLookupKey?: any, capabilityKey: any = "") : any {
  const key: any = Buffer.isBuffer(runtimeLookupKey)
    ? runtimeLookupKey
    : Buffer.from(String(runtimeLookupKey || ""), "base64");
  if (key.length < 32) {
    throw new Error("Capability key lookup requires a 256-bit runtime lookup key.");
  }
  return crypto.createHmac("sha256", key).update(String(capabilityKey || ""), "utf8").digest("base64url");
}

export function capabilityPermissionHash(runtimeLookupKey?: any, capability: any = "") : any {
  const key: any = Buffer.isBuffer(runtimeLookupKey)
    ? runtimeLookupKey
    : Buffer.from(String(runtimeLookupKey || ""), "base64");
  if (key.length < 32) {
    throw new Error("Capability permission lookup requires a 256-bit runtime lookup key.");
  }
  return crypto.createHmac("sha256", key).update(String(capability || ""), "utf8").digest("base64url");
}

export function normalizeStatus(status: any = "valid") : any {
  const value: any = text(status || "valid");
  return VALID_STATUSES.includes(value) ? value : "invalid";
}

export function candidateCapabilitiesFor(requiredCapability: any = "") : any {
  const capability: any = text(requiredCapability);
  if (!capability) {
    return [];
  }
  const candidates: any[] = [capability];
  if (capability.startsWith("cap:api:")) {
    candidates.push("cap:api:*");
  }
  if (capability.startsWith("cap:tool:")) {
    candidates.push("cap:tool:*");
  }
  candidates.push("cap:*");
  return [...new Set<any>(candidates)];
}

export function publicKeyRecord(record: any = null) : any {
  if (!record) {
    return null;
  }
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    keyHash: record.keyHash,
    credentialId: record.credentialId,
    status: normalizeStatus(record.status),
    capabilitySetHash: record.capabilitySetHash || "",
    capabilityCount: Number(record.capabilityCount || 0),
    constraints: asObject(record.constraints),
    grantVersion: Number(record.grantVersion || 1),
    metadata: asObject(record.metadata),
    issuedAt: record.issuedAt || "",
    expiresAt: record.expiresAt || "",
    invalidatedAt: record.invalidatedAt || "",
    invalidationReason: record.invalidationReason || "",
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || ""
  };
}

export function createKeyRecord({
  keyHash = "",
  credentialId = `opq_cap_${crypto.randomUUID()}`,
  capabilities = [],
  trustedCapabilityPermissions = [],
  constraints = {},
  ttlMs = DEFAULT_TTL_MS,
  issuedAt = nowIso(),
  expiresAt = "",
  grantVersion = 1,
  metadata = {},
  status = "valid"
}: Record<string, any> = {}) : any {
  const normalizedCapabilities: any = canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
  if (!keyHash) {
    throw new Error("Capability key binding requires a key hash.");
  }
  if (normalizedCapabilities.length === 0) {
    throw new Error("Capability key binding requires at least one kernel capability.");
  }
  const timestamp: any = nowIso();
  return publicKeyRecord({
    keyHash,
    credentialId: text(credentialId) || `opq_cap_${crypto.randomUUID()}`,
    status,
    capabilitySetHash: opaqueCapabilityHash(normalizedCapabilities, normalizedCapabilities),
    capabilityCount: normalizedCapabilities.length,
    constraints: asObject(constraints),
    grantVersion: Number(grantVersion || 1),
    metadata: asObject(metadata),
    issuedAt,
    expiresAt: expiresAt || new Date(parseIso(issuedAt) + Math.max(1, Number(ttlMs || DEFAULT_TTL_MS))).toISOString(),
    invalidatedAt: "",
    invalidationReason: "",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateKeyRecord(record: any = null, { now = nowIso(), minGrantVersion = 0 }: Record<string, any> = {}) : any {
  if (!record) {
    return { ok: false, reasonCode: "capability_key_unknown" };
  }
  const normalized: any = publicKeyRecord(record);
  if (normalized.status !== "valid") {
    return {
      ok: false,
      reasonCode: "capability_key_invalid",
      status: normalized.status,
      credentialId: normalized.credentialId
    };
  }
  if (Number(normalized.grantVersion || 0) < Number(minGrantVersion || 0)) {
    return { ok: false, reasonCode: "credential_grant_version_stale", credentialId: normalized.credentialId };
  }
  if (normalized.expiresAt && parseIso(normalized.expiresAt) <= parseIso(now)) {
    return { ok: false, reasonCode: "capability_key_expired", credentialId: normalized.credentialId };
  }
  return { ok: true, record: normalized };
}

export function hashBase64Url(value: any = "") : any {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

export function randomBase64(bytes: any = 32) : any {
  return crypto.randomBytes(bytes).toString("base64");
}

export function keychainService(alias: any = DEFAULT_ALIAS) : any {
  return `com.meshrix.capability-kernel.${safeAlias(alias)}`;
}

export function createEmptyKernelState({ provider = "memory", securityMode = "memory", runtimeLookupKeyBase64 = "" }: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  return normalizeKernelState({
    stateVersion: KERNEL_STATE_VERSION,
    provider,
    securityMode,
    epoch: 1,
    runtimeLookupKeyBase64: runtimeLookupKeyBase64 || randomBase64(32),
    records: [],
    permissions: [],
    events: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function normalizeKernelState(input: Record<string, any> = {}) : any {
  const state: any = asObject(input);
  const normalized: Record<string, any> = {
    stateVersion: Number(state.stateVersion || KERNEL_STATE_VERSION),
    provider: text(state.provider || "unknown"),
    securityMode: text(state.securityMode || "unknown"),
    epoch: Math.max(1, Number(state.epoch || 1)),
    runtimeLookupKeyBase64: text(state.runtimeLookupKeyBase64),
    records: Array.isArray(state.records) ? state.records.map(publicKeyRecord).filter(Boolean) : [],
    permissions: Array.isArray(state.permissions)
      ? state.permissions.map((permission?: any) : any => ({
          keyHash: text(permission.keyHash),
          capabilityHash: text(permission.capabilityHash),
          status: normalizeStatus(permission.status),
          createdAt: permission.createdAt || nowIso()
        })).filter((permission?: any) : any => permission.keyHash && permission.capabilityHash)
      : [],
    events: Array.isArray(state.events) ? state.events.slice(-2048).map((event?: any) : any => asObject(event)) : [],
    createdAt: state.createdAt || nowIso(),
    updatedAt: state.updatedAt || nowIso(),
    stateRoot: text(state.stateRoot)
  };
  if (!normalized.runtimeLookupKeyBase64 || Buffer.from(normalized.runtimeLookupKeyBase64, "base64").length < 32) {
    normalized.runtimeLookupKeyBase64 = randomBase64(32);
  }
  normalized.stateRoot = kernelStateRoot(normalized);
  return normalized;
}

export function isoTime(value: any = "") : any {
  const parsed: any = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function earlierIso(a: any = "", b: any = "") : any {
  const aTime: any = isoTime(a);
  const bTime: any = isoTime(b);
  if (!aTime) {
    return b || "";
  }
  if (!bTime) {
    return a || "";
  }
  return aTime <= bTime ? a : b;
}

export function laterIso(a: any = "", b: any = "") : any {
  const aTime: any = isoTime(a);
  const bTime: any = isoTime(b);
  if (!aTime) {
    return b || "";
  }
  if (!bTime) {
    return a || "";
  }
  return aTime >= bTime ? a : b;
}

export function mergeKeyRecord(existing: any = null, candidate: any = null) : any {
  const current: any = publicKeyRecord(existing);
  const next: any = publicKeyRecord(candidate);
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (current.status !== "valid" || next.status !== "valid") {
    const invalid: any = current.status !== "valid" ? current : next;
    const other: any = current.status !== "valid" ? next : current;
    return publicKeyRecord({
      ...other,
      ...invalid,
      status: "invalid",
      invalidatedAt: laterIso(current.invalidatedAt, next.invalidatedAt),
      invalidationReason: invalid.invalidationReason || other.invalidationReason,
      createdAt: earlierIso(current.createdAt, next.createdAt),
      updatedAt: laterIso(current.updatedAt, next.updatedAt)
    });
  }
  return isoTime(next.updatedAt || next.createdAt) >= isoTime(current.updatedAt || current.createdAt)
    ? next
    : current;
}

export function mergePermissionRecord(existing: any = null, candidate: any = null) : any {
  if (!existing) {
    return candidate;
  }
  if (!candidate) {
    return existing;
  }
  const status: any = existing.status !== "valid" || candidate.status !== "valid" ? "invalid" : "valid";
  return {
    ...existing,
    ...candidate,
    status,
    createdAt: earlierIso(existing.createdAt, candidate.createdAt)
  };
}

export function mergeKernelStates(persistedInput: Record<string, any> = {}, hotInput: Record<string, any> = {}) : any {
  const persisted: any = normalizeKernelState(persistedInput);
  const hot: any = normalizeKernelState(hotInput);
  if (persisted.runtimeLookupKeyBase64 !== hot.runtimeLookupKeyBase64) {
    return persisted;
  }
  const records: any = new Map<any, any>();
  for (const record of persisted.records) {
    records.set(record.keyHash, mergeKeyRecord(records.get(record.keyHash), record));
  }
  for (const record of hot.records) {
    records.set(record.keyHash, mergeKeyRecord(records.get(record.keyHash), record));
  }
  const permissions: any = new Map<any, any>();
  for (const permission of persisted.permissions) {
    const key: any = `${permission.keyHash}:${permission.capabilityHash}`;
    permissions.set(key, mergePermissionRecord(permissions.get(key), permission));
  }
  for (const permission of hot.permissions) {
    const key: any = `${permission.keyHash}:${permission.capabilityHash}`;
    permissions.set(key, mergePermissionRecord(permissions.get(key), permission));
  }
  const eventsById: any = new Map<any, any>();
  for (const event of [...persisted.events, ...hot.events]) {
    const normalized: any = asObject(event);
    const key: any = text(normalized.eventId) || crypto.createHash("sha256").update(stableJson(normalized)).digest("base64url");
    eventsById.set(key, normalized);
  }
  return normalizeKernelState({
    ...persisted,
    epoch: Math.max(Number(persisted.epoch || 1), Number(hot.epoch || 1)),
    records: [...records.values()],
    permissions: [...permissions.values()],
    events: [...eventsById.values()].slice(-2048),
    createdAt: earlierIso(persisted.createdAt, hot.createdAt),
    updatedAt: laterIso(persisted.updatedAt, hot.updatedAt)
  });
}

export function kernelStateRoot(state: Record<string, any> = {}) : any {
  const normalized: Record<string, any> = {
    stateVersion: Number(state.stateVersion || KERNEL_STATE_VERSION),
    provider: text(state.provider),
    securityMode: text(state.securityMode),
    epoch: Number(state.epoch || 1),
    runtimeLookupKeyHash: hashBase64Url(text(state.runtimeLookupKeyBase64)),
    records: Array.isArray(state.records) ? state.records.map(publicKeyRecord).sort((a?: any, b?: any) : any => a.keyHash.localeCompare(b.keyHash)) : [],
    permissions: Array.isArray(state.permissions)
      ? state.permissions.map((permission?: any) : any => ({
          keyHash: text(permission.keyHash),
          capabilityHash: text(permission.capabilityHash),
          status: normalizeStatus(permission.status)
        })).sort((a?: any, b?: any) : any => `${a.keyHash}:${a.capabilityHash}`.localeCompare(`${b.keyHash}:${b.capabilityHash}`))
      : []
  };
  return crypto.createHash("sha256").update(stableJson(normalized), "utf8").digest("base64url");
}

export function sealJson({ sealingKeyBase64 = "", payload = {} }: Record<string, any> = {}) : any {
  const key: any = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Capability kernel state sealing key must be at least 256 bits.");
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
    throw new Error("Capability kernel state sealing key must be at least 256 bits.");
  }
  const sealedObject: any = asObject(sealed, null);
  if (!sealedObject || sealedObject.algorithm !== AEAD_ALGORITHM) {
    throw new Error("Unsupported capability kernel sealed state payload.");
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

export function publicKernelRecord(record: Record<string, any> = {}) : any {
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    alias: safeAlias(record.alias || DEFAULT_ALIAS),
    provider: text(record.provider || "local-file"),
    securityMode: text(record.securityMode || "degraded_file_fallback"),
    generation: Number(record.generation || 1),
    stateRoot: text(record.stateRoot),
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || ""
  };
}

export function createKernelRecord({ alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback", state = null, sealingKeyBase64 = "" }: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  const normalizedState: any = normalizeKernelState(state || createEmptyKernelState({ provider, securityMode }));
  const sealingKey: any = sealingKeyBase64 || randomBase64(32);
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    alias: safeAlias(alias),
    provider,
    securityMode,
    generation: Number(normalizedState.epoch || 1),
    sealingKeyBase64: sealingKey,
    sealedState: sealJson({ sealingKeyBase64: sealingKey, payload: normalizedState }),
    stateRoot: normalizedState.stateRoot,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isClosedPipeError(error?: any) : any {
  return error?.code === "EPIPE" || error?.code === "ECONNRESET";
}

export function markNeedsInitialWrite(record?: any) : any {
  Object.defineProperty(record, "__needsInitialWrite", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return record;
}

export function stateFromKernelRecord(record: Record<string, any> = {}) : any {
  const opened: any = openSealedJson({
    sealingKeyBase64: record.sealingKeyBase64,
    sealed: record.sealedState
  });
  const state: any = normalizeKernelState({
    ...opened,
    provider: record.provider,
    securityMode: record.securityMode
  });
  if (record.stateRoot && state.stateRoot !== record.stateRoot) {
    throw new Error("Capability kernel sealed state root mismatch.");
  }
  return state;
}

export { stableJson };
