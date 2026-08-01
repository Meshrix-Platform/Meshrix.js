import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { apiCapabilityId } from "#meshrix/authorization-engine";
import { createCapabilityBindingGuard } from "../authorization/capability-binding-guard.ts";
import { createOpaqueCapabilityKeyProvider } from "../authorization/opaque-capability-key.ts";
import { clientIpFromRequest, isLocalHttpHost, isLoopbackAddress } from "#meshrix/trusted-client-ip";
import { runtimeStateDir as hostRuntimeStateDir } from "../../environment-compatibility/index.ts";
import { writePrivateFileAtomic } from "../../storage/private-file-atomic.ts";

export const PROCESS_IDENTITY_PROTOCOL_VERSION: any = "v0.0.1:risk-control:process-identity-1";
export const CLIENT_IDENTITY_PACKAGE_VERSION: any = "v0.0.1:process-identity:client-package-1";
export const PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION: any = "MESHRIX-PROCESS-IDENTITY-V1";
export const CLIENT_FINGERPRINT_VERSION: any = "v0.0.1:client:fingerprint-1";

export const STATE_VERSION: any = 2;
export const PROCESS_IDENTITY_RETIRED_STATE_RESET: any = Symbol("process-identity-retired-state-reset");
const CURRENT_STATE_FIELDS: any = new Set<any>([
  "stateVersion", "protocolVersion", "alias", "serverIdentity", "claimed", "claimedAt", "claimCount",
  "clients", "ownerProcessBindings", "retiredOwnerProcessBindingGenerations", "usedNonces", "createdAt", "updatedAt"
]);
export const AEAD_ALGORITHM: any = "aes-256-gcm";
export const DEFAULT_ALIAS: any = "meshrix-process-identity";
export const DEFAULT_NONCE_TTL_MS: any = 5 * 60 * 1000;
export const MAX_NONCE_CACHE: any = 4096;
const VALID_CLIENT_STATUSES: any = new Set<any>(["valid", "rotated", "revoked"]);

export const DEFAULT_PROCESS_IDENTITY_CAPABILITIES: readonly any[] = Object.freeze([
  apiCapabilityId("mcp.request"),
  apiCapabilityId("process_identity.package.rotate"),
  apiCapabilityId("process_identity.package.revoke")
]);

export function nowIso() : any {
  return new Date().toISOString();
}

export function text(value: any = "") : any {
  return String(value || "").trim();
}

export function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value?: any) : any {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return [];
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((item?: any) : any => text(item)).filter(Boolean))];
}


export function sha256Hex(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function sha256TextBase64Url(value: any = "") : any {
  return sha256Base64Url(Buffer.from(String(value || ""), "utf8"));
}

export function clientFingerprintHash({
  fingerprintId = "",
  machineInstanceId = "",
  appInstanceId = "",
  runtimeInstanceId = ""
}: Record<string, any> = {}) : any {
  return `sha256:${sha256TextBase64Url([
    CLIENT_FINGERPRINT_VERSION,
    text(fingerprintId),
    text(machineInstanceId),
    text(appInstanceId),
    text(runtimeInstanceId)
  ].join("\n"))}`;
}

export function randomToken(prefix: any = "tok", bytes: any = 24) : any {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function parseTimestampMs(value: any = "") : any {
  const raw: any = text(value);
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const numeric: any = Number(raw);
    if (!Number.isFinite(numeric)) return 0;
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed: any = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveDataDir(dataDir: any = "") : any {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

export function safeAlias(alias: any = DEFAULT_ALIAS) : any {
  return text(alias || DEFAULT_ALIAS).replace(/[^a-zA-Z0-9._:-]/g, "_") || DEFAULT_ALIAS;
}

export function stateDir({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return hostRuntimeStateDir({
    dataDir: resolveDataDir(dataDir),
    category: "security",
    namespace: "process-identity",
    alias: safeAlias(alias)
  });
}

export function processIdentityStatePath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(stateDir({ dataDir, alias }), "state.sealed.json");
}

export function processIdentitySealingKeyPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(stateDir({ dataDir, alias }), "state.sealing-key");
}

export function sealJson({ sealingKeyBase64 = "", payload = {} }: Record<string, any> = {}) : any {
  const key: any = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Process identity state sealing key must be at least 256 bits.");
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
    throw new Error("Process identity state sealing key must be at least 256 bits.");
  }
  const sealedObject: any = asObject(sealed, null);
  if (!sealedObject || sealedObject.algorithm !== AEAD_ALGORITHM) {
    throw new Error("Unsupported process identity sealed state payload.");
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
  return JSON.parse(plaintext);
}

export function generateServerIdentity() : any {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki: any = publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiBase64: any = publicKeySpki.toString("base64");
  const digest: any = sha256Base64Url(publicKeySpki);
  return {
    serverId: `srv_${digest.slice(0, 32)}`,
    serverKeyId: `srvkey_${digest.slice(0, 24)}`,
    serverTrustPin: `ed25519-spki-sha256:${digest}`,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    publicKeySpkiBase64,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    createdAt: nowIso()
  };
}

export function publicServerIdentity(serverIdentity: Record<string, any> = {}) : any {
  return {
    protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
    serverId: text(serverIdentity.serverId),
    serverKeyId: text(serverIdentity.serverKeyId),
    serverTrustPin: text(serverIdentity.serverTrustPin),
    publicKeyPem: text(serverIdentity.publicKeyPem),
    publicKeySpkiBase64: text(serverIdentity.publicKeySpkiBase64),
    createdAt: text(serverIdentity.createdAt)
  };
}

export function normalizeClientRecord(record: Record<string, any> = {}) : any {
  const input: any = asObject(record);
  const clientFingerprint: any = normalizeClientFingerprint(input.clientFingerprint || input, { required: false });
  return {
    packageId: text(input.packageId),
    clientId: text(input.clientId),
    installationId: text(input.installationId),
    serverId: text(input.serverId),
    serverTrustPin: text(input.serverTrustPin),
    processKeyId: text(input.processKeyId),
    processPublicKeyPem: text(input.processPublicKeyPem),
    processPublicKeySpkiBase64: text(input.processPublicKeySpkiBase64),
    processPublicKeyHash: text(input.processPublicKeyHash),
    clientFingerprint,
    defaultIdentityHash: text(input.defaultIdentityHash),
    identityGeneration: Math.max(1, Number(input.identityGeneration || 1)),
    capabilityCredentialId: text(input.capabilityCredentialId),
    capabilities: uniqueStrings(asArray(input.capabilities)),
    status: VALID_CLIENT_STATUSES.has(text(input.status)) ? text(input.status) : "revoked",
    issuedAt: text(input.issuedAt),
    expiresAt: text(input.expiresAt),
    rotatedAt: text(input.rotatedAt),
    revokedAt: text(input.revokedAt),
    revocationReason: text(input.revocationReason),
    revocationEndpoint: text(input.revocationEndpoint),
    revocationReceiptDigestSha256: text(input.revocationReceiptDigestSha256),
    ownerSubjectRef: text(input.ownerSubjectRef),
    ownerArtifactId: text(input.ownerArtifactId),
    ownerArtifactDigestSha256: text(input.ownerArtifactDigestSha256)
  };
}

export function normalizeState(input: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  const source: any = asObject(input);
  const serverIdentity: any = asObject(source.serverIdentity, null) || generateServerIdentity();
  return {
    stateVersion: STATE_VERSION,
    protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
    alias: safeAlias(source.alias || DEFAULT_ALIAS),
    serverIdentity,
    claimed: source.claimed === true,
    claimedAt: text(source.claimedAt),
    claimCount: Math.max(0, Number(source.claimCount || 0)),
    clients: Array.isArray(source.clients) ? source.clients.map(normalizeClientRecord).filter((item?: any) : any => item.packageId) : [],
    ownerProcessBindings: Array.isArray(source.ownerProcessBindings)
      ? source.ownerProcessBindings.map((binding?: any) : any => ({
          processIdentityRef: text(binding.processIdentityRef),
          ownerId: text(binding.ownerId),
          ownerGenerationDigest: text(binding.ownerGenerationDigest),
          bindingRef: text(binding.bindingRef),
          targetRef: text(binding.targetRef),
          contextDigest: text(binding.contextDigest),
          idempotencyKeyDigest: text(binding.idempotencyKeyDigest),
          status: text(binding.status) === "revoked" ? "revoked" : "valid",
          issuedAt: text(binding.issuedAt),
          expiresAt: text(binding.expiresAt),
          revokedAt: text(binding.revokedAt),
          receiptDigest: text(binding.receiptDigest)
        })).filter((binding?: any) : any => binding.processIdentityRef && binding.bindingRef)
      : [],
    retiredOwnerProcessBindingGenerations: Array.isArray(source.retiredOwnerProcessBindingGenerations)
      ? source.retiredOwnerProcessBindingGenerations.map((entry?: any) : any => ({
          ownerId: text(entry.ownerId),
          ownerGenerationDigest: text(entry.ownerGenerationDigest),
          retiredAt: text(entry.retiredAt)
        })).filter((entry?: any) : any => entry.ownerId && /^[a-f0-9]{64}$/u.test(entry.ownerGenerationDigest))
      : [],
    usedNonces: Array.isArray(source.usedNonces) ? source.usedNonces.map((item?: any) : any => ({
      nonceHash: text(item.nonceHash),
      packageId: text(item.packageId),
      seenAt: text(item.seenAt),
      expiresAt: text(item.expiresAt)
    })).filter((item?: any) : any => item.nonceHash) : [],
    createdAt: text(source.createdAt || timestamp),
    updatedAt: text(source.updatedAt || timestamp)
  };
}

export function stateRoot(state: Record<string, any> = {}) : any {
  return sha256Base64Url(Buffer.from(stableJson({
    stateVersion: Number(state.stateVersion || STATE_VERSION),
    serverId: state.serverIdentity?.serverId || "",
    serverTrustPin: state.serverIdentity?.serverTrustPin || "",
    claimed: state.claimed === true,
    clients: (state.clients || []).map((client?: any) : any => ({
      packageId: client.packageId,
      clientId: client.clientId,
      processKeyId: client.processKeyId,
      processPublicKeyHash: client.processPublicKeyHash,
      clientFingerprintHash: client.clientFingerprint?.fingerprintHash || "",
      identityGeneration: client.identityGeneration,
      capabilityCredentialId: client.capabilityCredentialId,
      status: client.status
    })).sort((left?: any, right?: any) : any => left.packageId.localeCompare(right.packageId)),
    ownerProcessBindings: (state.ownerProcessBindings || []).map((binding?: any) : any => ({
      processIdentityRef: binding.processIdentityRef,
      ownerId: binding.ownerId,
      ownerGenerationDigest: binding.ownerGenerationDigest,
      bindingRef: binding.bindingRef,
      targetRef: binding.targetRef,
      contextDigest: binding.contextDigest,
      idempotencyKeyDigest: binding.idempotencyKeyDigest,
      status: binding.status,
      receiptDigest: binding.receiptDigest
    })).sort((left?: any, right?: any) : any => left.processIdentityRef.localeCompare(right.processIdentityRef)),
    retiredOwnerProcessBindingGenerations: (state.retiredOwnerProcessBindingGenerations || []).map((entry?: any) : any => ({
      ownerId: entry.ownerId,
      ownerGenerationDigest: entry.ownerGenerationDigest,
      retiredAt: entry.retiredAt
    })).sort((left?: any, right?: any) : any => `${left.ownerId}:${left.ownerGenerationDigest}`.localeCompare(`${right.ownerId}:${right.ownerGenerationDigest}`))
  }), "utf8"));
}

export async function readRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  const statePath: any = processIdentityStatePath({ dataDir, alias });
  const sealingPath: any = processIdentitySealingKeyPath({ dataDir, alias });
  try {
    const [record, sealingKeyBase64] = await Promise.all([
      fs.promises.readFile(statePath, "utf8").then((raw?: any) : any => JSON.parse(raw)),
      fs.promises.readFile(sealingPath, "utf8").then((raw?: any) : any => text(raw))
    ]);
    return { ...record, sealingKeyBase64 };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    const timestamp: any = nowIso();
    const state: any = normalizeState({
      alias,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const sealingKeyBase64: any = crypto.randomBytes(32).toString("base64");
    return {
      protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
      alias: safeAlias(alias),
      stateRoot: stateRoot(state),
      sealedState: sealJson({ sealingKeyBase64, payload: state }),
      sealingKeyBase64,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }
}

export async function writeRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const { sealingKeyBase64, ...persistedRecord } = record;
  await writePrivateFileAtomic(processIdentitySealingKeyPath({ dataDir, alias }), `${text(sealingKeyBase64)}\n`);
  await writePrivateFileAtomic(processIdentityStatePath({ dataDir, alias }), `${JSON.stringify(persistedRecord, null, 2)}\n`);
  return record;
}

export function openState(record: Record<string, any> = {}) : any {
  const opened: any = openSealedJson({
    sealingKeyBase64: record.sealingKeyBase64,
    sealed: record.sealedState
  });
  const openedFields: any = Object.keys(asObject(opened));
  if (Number(opened?.stateVersion) !== STATE_VERSION || openedFields.length !== CURRENT_STATE_FIELDS.size ||
      openedFields.some((field?: any) : any => !CURRENT_STATE_FIELDS.has(field))) {
    const timestamp: any = nowIso();
    const reset: any = normalizeState({
      alias: record.alias || opened?.alias || DEFAULT_ALIAS,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    Object.defineProperty(reset, PROCESS_IDENTITY_RETIRED_STATE_RESET, { value: true });
    return reset;
  }
  const state: any = normalizeState(opened);
  if (record.stateRoot && stateRoot(state) !== record.stateRoot) {
    throw new Error("Process identity sealed state root mismatch.");
  }
  return state;
}

export function createRecord({ alias = DEFAULT_ALIAS, state, sealingKeyBase64 = "" }: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  const normalized: any = normalizeState({
    ...asObject(state),
    alias,
    updatedAt: timestamp
  });
  const key: any = text(sealingKeyBase64) || crypto.randomBytes(32).toString("base64");
  return {
    protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
    alias: safeAlias(alias),
    stateRoot: stateRoot(normalized),
    sealedState: sealJson({ sealingKeyBase64: key, payload: normalized }),
    sealingKeyBase64: key,
    createdAt: text(state?.createdAt || timestamp),
    updatedAt: timestamp
  };
}

export function publicKeyFromInput(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  const pem: any = text(source.processPublicKeyPem || source.publicKeyPem || source.publicKey || source.clientPublicKeyPem);
  const spkiBase64: any = text(source.processPublicKeySpkiBase64 || source.publicKeySpkiBase64 || source.clientPublicKeySpkiBase64);
  let publicKey: any = null;
  if (pem) {
    publicKey = crypto.createPublicKey(pem);
  } else if (spkiBase64) {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki"
    });
  } else {
    throw Object.assign(new Error("process public key is required"), { status: 400, reasonCode: "process_public_key_missing" });
  }
  const spki: any = publicKey.export({ format: "der", type: "spki" });
  const hash: any = `sha256:${sha256Base64Url(spki)}`;
  return {
    publicKey,
    processPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    processPublicKeySpkiBase64: spki.toString("base64"),
    processPublicKeyHash: hash,
    processKeyId: text(source.processKeyId) || `pk_${hash.slice("sha256:".length, "sha256:".length + 24)}`
  };
}

export function normalizeClientFingerprint(input: Record<string, any> = {}, {
  required = false,
  clientId = "",
  installationId = "",
  processPublicKeyHash = ""
}: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  const nested: any = asObject(source.clientFingerprint || source.client_fingerprint || source.fingerprint, source);
  const fingerprintId: any = text(
    nested.fingerprintId ||
      nested.fingerprint_id ||
      source.clientFingerprintId ||
      source.client_fingerprint_id ||
      source.fingerprintId ||
      source.fingerprint_id
  );
  const machineInstanceId: any = text(
    nested.machineInstanceId ||
      nested.machine_instance_id ||
      source.machineInstanceId ||
      source.machine_instance_id
  );
  const appInstanceId: any = text(
    nested.appInstanceId ||
      nested.app_instance_id ||
      source.appInstanceId ||
      source.app_instance_id
  );
  const runtimeInstanceId: any = text(
    nested.runtimeInstanceId ||
      nested.runtime_instance_id ||
      source.runtimeInstanceId ||
      source.runtime_instance_id
  );
  if (!fingerprintId && !machineInstanceId && !appInstanceId && !runtimeInstanceId) {
    if (required) {
      throw Object.assign(new Error("client fingerprint is required"), { status: 400, reasonCode: "client_fingerprint_missing" });
    }
    return {};
  }
  if (required && (!fingerprintId || !machineInstanceId || !appInstanceId || !runtimeInstanceId)) {
    throw Object.assign(new Error("client fingerprint is incomplete"), { status: 400, reasonCode: "client_fingerprint_incomplete" });
  }
  const computedHash: any = clientFingerprintHash({
    fingerprintId,
    machineInstanceId,
    appInstanceId,
    runtimeInstanceId
  });
  const suppliedHash: any = text(nested.fingerprintHash || nested.fingerprint_hash || source.clientFingerprintHash || source.client_fingerprint_hash);
  if (suppliedHash && suppliedHash !== computedHash) {
    throw Object.assign(new Error("client fingerprint hash mismatch"), { status: 400, reasonCode: "client_fingerprint_hash_mismatch" });
  }
  return {
    schemaVersion: text(nested.schemaVersion) || "v0.0.1:schema:definition-1",
    protocolVersion: text(nested.protocolVersion) || PROCESS_IDENTITY_PROTOCOL_VERSION,
    fingerprintVersion: text(nested.fingerprintVersion) || CLIENT_FINGERPRINT_VERSION,
    fingerprintId,
    machineInstanceId,
    appInstanceId,
    runtimeInstanceId,
    fingerprintHash: computedHash,
    createdAtUnix: Number(nested.createdAtUnix || nested.created_at_unix || 0),
    updatedAtUnix: Number(nested.updatedAtUnix || nested.updated_at_unix || 0)
  };
}

export function privateKeyFromPem(privateKeyPem: any = "") : any {
  return crypto.createPrivateKey(text(privateKeyPem));
}

export function signStableObject(privateKeyPem: any = "", payload: Record<string, any> = {}) : any {
  return crypto.sign(null, Buffer.from(stableJson(payload), "utf8"), privateKeyFromPem(privateKeyPem)).toString("base64url");
}

export function verifyClientIdentityPackageSignature({ packageObject = null, serverPublicKeyPem = "" }: Record<string, any> = {}) : any {
  const packageSource: any = asObject(packageObject, null);
  const signature: any = packageSource?.signature || {};
  if (!packageSource || !text(signature.value)) {
    return { ok: false, reasonCode: "identity_package_signature_missing" };
  }
  const { signature: _signature, ...payload } = packageSource;
  void _signature;
  const publicKey: any = crypto.createPublicKey(text(serverPublicKeyPem) || packageSource.serverPublicKeyPem || "");
  const ok: any = crypto.verify(
    null,
    Buffer.from(stableJson(payload), "utf8"),
    publicKey,
    Buffer.from(text(signature.value), "base64url")
  );
  return ok
    ? { ok: true, reasonCode: "identity_package_signature_valid" }
    : { ok: false, reasonCode: "identity_package_signature_invalid" };
}

export function clientBindingContext(client: Record<string, any> = {}) : any {
  const fingerprint: any = normalizeClientFingerprint(client.clientFingerprint, { required: false });
  return {
    namespace: "process-identity",
    clientId: client.clientId,
    serverId: client.serverId,
    packageId: client.packageId,
    processKeyId: client.processKeyId,
    processPublicKeyHash: client.processPublicKeyHash,
    fingerprintId: fingerprint.fingerprintId || "",
    machineInstanceId: fingerprint.machineInstanceId || "",
    appInstanceId: fingerprint.appInstanceId || "",
    runtimeInstanceId: fingerprint.runtimeInstanceId || "",
    clientFingerprintHash: fingerprint.fingerprintHash || "",
    identityGeneration: String(client.identityGeneration || ""),
    defaultIdentityHash: client.defaultIdentityHash
  };
}

export function createClientIdentityPackage({ state, client, capabilityKey = "", nonce = "" }: Record<string, any> = {}) : any {
  const serverIdentity: any = state.serverIdentity || {};
  const payload: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: CLIENT_IDENTITY_PACKAGE_VERSION,
    packageId: client.packageId,
    clientId: client.clientId,
    installationId: client.installationId,
    serverId: client.serverId,
    serverTrustPin: client.serverTrustPin,
    serverPublicKeyPem: serverIdentity.publicKeyPem,
    serverPublicKeySpkiBase64: serverIdentity.publicKeySpkiBase64,
    serverKeyId: serverIdentity.serverKeyId,
    processKey: {
      processKeyId: client.processKeyId,
      publicKeyPem: client.processPublicKeyPem,
      publicKeySpkiBase64: client.processPublicKeySpkiBase64,
      publicKeyHash: client.processPublicKeyHash
    },
    clientFingerprint: normalizeClientFingerprint(client.clientFingerprint, { required: false }),
    defaultIdentityHash: client.defaultIdentityHash,
    identityGeneration: client.identityGeneration,
    issuedAt: client.issuedAt,
    expiresAt: client.expiresAt,
    capabilities: client.capabilities,
    capability: {
      type: "opaque-capability-key",
      key: capabilityKey,
      credentialId: client.capabilityCredentialId
    },
    claimNonce: text(nonce)
  };
  return {
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId: serverIdentity.serverKeyId,
      value: signStableObject(serverIdentity.privateKeyPem, payload)
    }
  };
}

export function canonicalProcessIdentityRequest({
  method = "GET",
  pathWithQuery = "/",
  bodySha256 = "",
  timestamp = "",
  nonce = "",
  clientId = "",
  packageId = "",
  processKeyId = "",
  clientFingerprint = {}
}: Record<string, any> = {}) : any {
  const fingerprint: any = normalizeClientFingerprint(clientFingerprint, { required: false });
  const parts: any[] = [
    PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION,
    text(method).toUpperCase(),
    text(pathWithQuery) || "/",
    text(bodySha256).toLowerCase(),
    text(timestamp),
    text(nonce),
    text(clientId),
    text(packageId),
    text(processKeyId)
  ];
  const fingerprintParts: any[] = [
    fingerprint.fingerprintId || "",
    fingerprint.machineInstanceId || "",
    fingerprint.appInstanceId || "",
    fingerprint.runtimeInstanceId || "",
    fingerprint.fingerprintHash || ""
  ];
  if (fingerprintParts.some(Boolean)) {
    parts.push(...fingerprintParts);
  }
  return parts.join("\n");
}

export function bodySha256Hex(body: any = Buffer.alloc(0)) : any {
  const value: any = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  return sha256Hex(value);
}

export function pathWithQueryFromUrl(url: any = null) : any {
  if (!url) return "/";
  return `${url.pathname || "/"}${url.search || ""}`;
}

export function headerValue(headers: Record<string, any> = {}, name: any = "") : any {
  const lower: any = name.toLowerCase();
  const entry: any = (Object.entries(headers || {}) as [string, any][]).find(([key]: any[]) : any => key.toLowerCase() === lower);
  const value: any = entry?.[1];
  return Array.isArray(value) ? text(value[0]) : text(value);
}

export function capabilityKeyFromHeaders(headers: Record<string, any> = {}) : any {
  const explicit: any = headerValue(headers, "x-meshrix-capability-key");
  if (explicit) {
    return explicit;
  }
  const authorization: any = headerValue(headers, "authorization");
  const match: any = authorization.match(/^Bearer\s+(ock_[A-Za-z0-9_-]+)$/i);
  return match ? match[1] : "";
}

export function clientFingerprintFromHeaders(headers: Record<string, any> = {}) : any {
  const candidate: Record<string, any> = {
    fingerprintId: headerValue(headers, "x-meshrix-client-fingerprint-id"),
    machineInstanceId: headerValue(headers, "x-meshrix-machine-instance-id"),
    appInstanceId: headerValue(headers, "x-meshrix-app-instance-id"),
    runtimeInstanceId: headerValue(headers, "x-meshrix-runtime-instance-id"),
    fingerprintHash: headerValue(headers, "x-meshrix-client-fingerprint-hash")
  };
  return normalizeClientFingerprint(candidate, { required: false });
}

export function clientFingerprintMatches(left: Record<string, any> = {}, right: Record<string, any> = {}) : any {
  return text(left.fingerprintId) === text(right.fingerprintId) &&
    text(left.machineInstanceId) === text(right.machineInstanceId) &&
    text(left.appInstanceId) === text(right.appInstanceId) &&
    text(left.runtimeInstanceId) === text(right.runtimeInstanceId) &&
    text(left.fingerprintHash) === text(right.fingerprintHash);
}

export function timingSafeTextEqual(left: any = "", right: any = "") : any {
  const leftHash: any = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightHash: any = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

export function operationRequiredCapabilities(operation: Record<string, any> = {}) : any {
  const configured: any = uniqueStrings(asArray(operation.processIdentity?.requiredCapabilities));
  return configured.length > 0 ? configured : [apiCapabilityId(operation.id || "")].filter(Boolean);
}

export function requestIsLoopback(request: any = null) : any {
  const ip: any = clientIpFromRequest(request, { unknown: "" });
  if (!isLoopbackAddress(ip)) {
    return false;
  }
  const host: any = headerValue(request?.headers || {}, "host");
  return !host || isLocalHttpHost(host);
}

export function deny(status?: any, reasonCode?: any, error?: any) : any {
  return { ok: false, status, reasonCode, error };
}

export function normalizeClientInput(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  const key: any = publicKeyFromInput(source);
  const clientId: any = text(source.clientId) || `client_${sha256TextBase64Url(key.processPublicKeyHash).slice(0, 24)}`;
  const installationId: any = text(source.installationId) || `install_${sha256TextBase64Url(`${clientId}:${key.processPublicKeyHash}`).slice(0, 24)}`;
  const clientFingerprint: any = normalizeClientFingerprint(source, {
    required: true,
    clientId,
    installationId,
    processPublicKeyHash: key.processPublicKeyHash
  });
  const defaultIdentityHash: any = text(source.defaultIdentityHash || source.default_identity_hash);
  if (!defaultIdentityHash) {
    throw Object.assign(new Error("default identity hash is required"), { status: 400, reasonCode: "default_identity_hash_missing" });
  }
  const capabilities: any = uniqueStrings(DEFAULT_PROCESS_IDENTITY_CAPABILITIES);
  return {
    ...key,
    clientId,
    installationId,
    clientFingerprint,
    defaultIdentityHash,
    capabilities
  };
}

export function generateProcessIdentityClientKeyPair() : any {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki: any = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    publicKeySpkiBase64: publicKeySpki.toString("base64"),
    publicKeyHash: `sha256:${sha256Base64Url(publicKeySpki)}`
  };
}

export function createProcessIdentityRequestHeaders({
  privateKeyPem = "",
  method = "POST",
  url = "/",
  body = "",
  clientIdentityPackage = {},
  timestamp = nowIso(),
  nonce = randomToken("nonce", 18)
}: Record<string, any> = {}) : any {
  const packageObject: any = asObject(clientIdentityPackage);
  const processKey: any = asObject(packageObject.processKey);
  const clientFingerprint: any = normalizeClientFingerprint(packageObject.clientFingerprint, { required: false });
  const pathWithQuery: any = typeof url === "string"
    ? pathWithQueryFromUrl(new URL(url, "http://127.0.0.1"))
    : pathWithQueryFromUrl(url);
  const bodyHash: any = bodySha256Hex(Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8"));
  const canonical: any = canonicalProcessIdentityRequest({
    method,
    pathWithQuery,
    bodySha256: bodyHash,
    timestamp,
    nonce,
    clientId: packageObject.clientId,
    packageId: packageObject.packageId,
    processKeyId: processKey.processKeyId,
    clientFingerprint
  });
  const signature: any = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKeyFromPem(privateKeyPem)).toString("base64url");
  return {
    "x-meshrix-client-id": packageObject.clientId,
    "x-meshrix-identity-package-id": packageObject.packageId,
    "x-meshrix-process-key-id": processKey.processKeyId,
    "x-meshrix-timestamp": timestamp,
    "x-meshrix-nonce": nonce,
    "x-meshrix-body-sha256": bodyHash,
    "x-meshrix-client-fingerprint-id": clientFingerprint.fingerprintId || "",
    "x-meshrix-machine-instance-id": clientFingerprint.machineInstanceId || "",
    "x-meshrix-app-instance-id": clientFingerprint.appInstanceId || "",
    "x-meshrix-runtime-instance-id": clientFingerprint.runtimeInstanceId || "",
    "x-meshrix-client-fingerprint-hash": clientFingerprint.fingerprintHash || "",
    "x-meshrix-signature": signature,
    "x-meshrix-capability-key": asObject(packageObject.capability).key
  };
}

export { stableJson };
