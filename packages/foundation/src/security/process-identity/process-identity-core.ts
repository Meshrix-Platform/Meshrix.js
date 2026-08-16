import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { apiCapabilityId } from "#meshrix/authorization-engine";
import { clientIpFromRequest, isLocalHttpHost, isLoopbackAddress } from "#meshrix/trusted-client-ip";
import { runtimeStateDir as hostRuntimeStateDir } from "../../environment-compatibility/index.ts";
import { writePrivateFileAtomic } from "../../storage/private-file-atomic.ts";

export const PROCESS_IDENTITY_PROTOCOL_VERSION = "v0.0.1:risk-control:process-identity-1";
export const CLIENT_IDENTITY_PACKAGE_VERSION = "v0.0.1:process-identity:client-package-1";
export const PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION = "MESHRIX-PROCESS-IDENTITY-V1";
export const CLIENT_FINGERPRINT_VERSION = "v0.0.1:client:fingerprint-1";

export const STATE_VERSION = 2;
export const PROCESS_IDENTITY_RETIRED_STATE_RESET = Symbol("process-identity-retired-state-reset");
const CURRENT_STATE_FIELDS = new Set([
  "stateVersion", "protocolVersion", "alias", "serverIdentity", "claimed", "claimedAt", "claimCount",
  "clients", "ownerProcessBindings", "retiredOwnerProcessBindingGenerations", "usedNonces", "createdAt", "updatedAt"
]);
export const AEAD_ALGORITHM = "aes-256-gcm";
export const DEFAULT_ALIAS = "meshrix-process-identity";
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;
export const MAX_NONCE_CACHE = 4096;
const VALID_CLIENT_STATUSES = new Set(["valid", "rotated", "revoked"]);

export interface ProcessIdentityObject extends Record<string, unknown> {
  [PROCESS_IDENTITY_RETIRED_STATE_RESET]?: boolean;
  alias?: unknown;
  serverIdentity?: ProcessIdentityObject;
  clients?: ProcessIdentityObject[];
  ownerProcessBindings?: ProcessIdentityObject[];
  retiredOwnerProcessBindingGenerations?: ProcessIdentityObject[];
  usedNonces?: ProcessIdentityObject[];
  clientFingerprint?: ProcessIdentityObject;
  fingerprint?: ProcessIdentityObject;
  signature?: ProcessIdentityObject;
  sealed?: ProcessIdentityObject | null;
  capabilities?: unknown[];
  processIdentity?: ProcessIdentityObject;
  requiredCapabilities?: unknown[];
  stateVersion?: unknown;
  protocolVersion?: unknown;
  claimed?: unknown;
  claimCount?: unknown;
  status?: unknown;
  packageId?: unknown;
  processIdentityRef?: unknown;
  bindingRef?: unknown;
  ownerId?: unknown;
  ownerGenerationDigest?: unknown;
  nonceHash?: unknown;
  expiresAt?: unknown;
  idempotencyKeyDigest?: unknown;
}

export const DEFAULT_PROCESS_IDENTITY_CAPABILITIES = Object.freeze([
  apiCapabilityId("mcp.request"),
  apiCapabilityId("process_identity.package.rotate"),
  apiCapabilityId("process_identity.package.revoke")
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function text(value: unknown = ""): string {
  return String(value || "").trim();
}

export function asObject(value?: unknown): ProcessIdentityObject;
export function asObject(value: unknown, fallback: null): ProcessIdentityObject | null;
export function asObject(
  value: unknown,
  fallback: ProcessIdentityObject
): ProcessIdentityObject;
export function asObject(
  value?: unknown,
  fallback: ProcessIdentityObject | null = {}
): ProcessIdentityObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ProcessIdentityObject
    : fallback;
}

export function asArray(value?: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return [];
}

export function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((item)  => text(item)).filter(Boolean))];
}


export function sha256Hex(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function sha256TextBase64Url(value: unknown = ""): string {
  return sha256Base64Url(Buffer.from(String(value || ""), "utf8"));
}

export function clientFingerprintHash({
  fingerprintId = "",
  machineInstanceId = "",
  appInstanceId = "",
  runtimeInstanceId = ""
}: Record<string, unknown> = {})  {
  return `sha256:${sha256TextBase64Url([
    CLIENT_FINGERPRINT_VERSION,
    text(fingerprintId),
    text(machineInstanceId),
    text(appInstanceId),
    text(runtimeInstanceId)
  ].join("\n"))}`;
}

export function randomToken(prefix = "tok", bytes = 24): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function parseTimestampMs(value: unknown = ""): number {
  const raw = text(value);
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 0;
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveDataDir(dataDir: unknown = ""): string {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

export function safeAlias(alias: unknown = DEFAULT_ALIAS): string {
  return text(alias || DEFAULT_ALIAS).replace(/[^a-zA-Z0-9._:-]/g, "_") || DEFAULT_ALIAS;
}

export function stateDir({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, unknown> = {})  {
  return hostRuntimeStateDir({
    dataDir: resolveDataDir(dataDir),
    category: "security",
    namespace: "process-identity",
    alias: safeAlias(alias)
  });
}

export function processIdentityStatePath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, unknown> = {})  {
  return path.join(stateDir({ dataDir, alias }), "state.sealed.json");
}

export function processIdentitySealingKeyPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, unknown> = {})  {
  return path.join(stateDir({ dataDir, alias }), "state.sealing-key");
}

export function sealJson({ sealingKeyBase64 = "", payload = {} }: Record<string, unknown> = {})  {
  const key = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Process identity state sealing key must be at least 256 bits.");
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AEAD_ALGORITHM, key.subarray(0, 32), nonce);
  const ciphertext = Buffer.concat([
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

export function openSealedJson({ sealingKeyBase64 = "", sealed = null }: Record<string, unknown> = {})  {
  const key = Buffer.from(text(sealingKeyBase64), "base64");
  if (key.length < 32) {
    throw new Error("Process identity state sealing key must be at least 256 bits.");
  }
  const sealedObject = asObject(sealed, null);
  if (!sealedObject || sealedObject.algorithm !== AEAD_ALGORITHM) {
    throw new Error("Unsupported process identity sealed state payload.");
  }
  const decipher = crypto.createDecipheriv(
    AEAD_ALGORITHM,
    key.subarray(0, 32),
    Buffer.from(text(sealedObject.nonceBase64), "base64")
  );
  decipher.setAuthTag(Buffer.from(text(sealedObject.tagBase64), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(text(sealedObject.ciphertextBase64), "base64")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

export function generateServerIdentity()  {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiBase64 = publicKeySpki.toString("base64");
  const digest = sha256Base64Url(publicKeySpki);
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

export function publicServerIdentity(serverIdentity: Record<string, unknown> = {})  {
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

export function normalizeClientRecord(record: ProcessIdentityObject = {}): ProcessIdentityObject {
  const input = asObject(record);
  const clientFingerprint = normalizeClientFingerprint(input.clientFingerprint || input, { required: false });
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

export function normalizeState(input: ProcessIdentityObject = {}): ProcessIdentityObject {
  const timestamp = nowIso();
  const source = asObject(input);
  const serverIdentity = asObject(source.serverIdentity, null) || generateServerIdentity();
  return {
    stateVersion: STATE_VERSION,
    protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
    alias: safeAlias(source.alias || DEFAULT_ALIAS),
    serverIdentity,
    claimed: source.claimed === true,
    claimedAt: text(source.claimedAt),
    claimCount: Math.max(0, Number(source.claimCount || 0)),
    clients: Array.isArray(source.clients) ? source.clients.map(normalizeClientRecord).filter((item)  => item.packageId) : [],
    ownerProcessBindings: Array.isArray(source.ownerProcessBindings)
      ? source.ownerProcessBindings.map((binding)  => ({
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
        })).filter((binding)  => binding.processIdentityRef && binding.bindingRef)
      : [],
    retiredOwnerProcessBindingGenerations: Array.isArray(source.retiredOwnerProcessBindingGenerations)
      ? source.retiredOwnerProcessBindingGenerations.map((entry)  => ({
          ownerId: text(entry.ownerId),
          ownerGenerationDigest: text(entry.ownerGenerationDigest),
          retiredAt: text(entry.retiredAt)
        })).filter((entry)  => entry.ownerId && /^[a-f0-9]{64}$/u.test(entry.ownerGenerationDigest))
      : [],
    usedNonces: Array.isArray(source.usedNonces) ? source.usedNonces.map((item)  => ({
      nonceHash: text(item.nonceHash),
      packageId: text(item.packageId),
      seenAt: text(item.seenAt),
      expiresAt: text(item.expiresAt)
    })).filter((item)  => item.nonceHash) : [],
    createdAt: text(source.createdAt || timestamp),
    updatedAt: text(source.updatedAt || timestamp)
  };
}

export function stateRoot(state: ProcessIdentityObject = {}): string {
  return sha256Base64Url(Buffer.from(stableJson({
    stateVersion: Number(state.stateVersion || STATE_VERSION),
    serverId: state.serverIdentity?.serverId || "",
    serverTrustPin: state.serverIdentity?.serverTrustPin || "",
    claimed: state.claimed === true,
    clients: (state.clients || []).map((client)  => ({
      packageId: client.packageId,
      clientId: client.clientId,
      processKeyId: client.processKeyId,
      processPublicKeyHash: client.processPublicKeyHash,
      clientFingerprintHash: client.clientFingerprint?.fingerprintHash || "",
      identityGeneration: client.identityGeneration,
      capabilityCredentialId: client.capabilityCredentialId,
      status: client.status
    })).sort((left, right) => text(left.packageId).localeCompare(text(right.packageId))),
    ownerProcessBindings: (state.ownerProcessBindings || []).map((binding)  => ({
      processIdentityRef: binding.processIdentityRef,
      ownerId: binding.ownerId,
      ownerGenerationDigest: binding.ownerGenerationDigest,
      bindingRef: binding.bindingRef,
      targetRef: binding.targetRef,
      contextDigest: binding.contextDigest,
      idempotencyKeyDigest: binding.idempotencyKeyDigest,
      status: binding.status,
      receiptDigest: binding.receiptDigest
    })).sort((left, right) => text(left.processIdentityRef).localeCompare(text(right.processIdentityRef))),
    retiredOwnerProcessBindingGenerations: (state.retiredOwnerProcessBindingGenerations || []).map((entry)  => ({
      ownerId: entry.ownerId,
      ownerGenerationDigest: entry.ownerGenerationDigest,
      retiredAt: entry.retiredAt
    })).sort((left, right)  => `${left.ownerId}:${left.ownerGenerationDigest}`.localeCompare(`${right.ownerId}:${right.ownerGenerationDigest}`))
  }), "utf8"));
}

export async function readRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, unknown> = {}): Promise<ProcessIdentityObject> {
  const statePath = processIdentityStatePath({ dataDir, alias });
  const sealingPath = processIdentitySealingKeyPath({ dataDir, alias });
  try {
    const [record, sealingKeyBase64] = await Promise.all([
      fs.promises.readFile(statePath, "utf8").then((raw)  => JSON.parse(raw)),
      fs.promises.readFile(sealingPath, "utf8").then((raw)  => text(raw))
    ]);
    return { ...record, sealingKeyBase64 };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    const timestamp = nowIso();
    const state = normalizeState({
      alias,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const sealingKeyBase64 = crypto.randomBytes(32).toString("base64");
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

export async function writeRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, unknown> = {}, record: Record<string, unknown> = {})  {
  const { sealingKeyBase64, ...persistedRecord } = record;
  await writePrivateFileAtomic(processIdentitySealingKeyPath({ dataDir, alias }), `${text(sealingKeyBase64)}\n`);
  await writePrivateFileAtomic(processIdentityStatePath({ dataDir, alias }), `${JSON.stringify(persistedRecord, null, 2)}\n`);
  return record;
}

export function openState(record: ProcessIdentityObject = {}): ProcessIdentityObject {
  const opened = openSealedJson({
    sealingKeyBase64: record.sealingKeyBase64,
    sealed: record.sealedState
  });
  const openedFields = Object.keys(asObject(opened));
  if (Number(opened?.stateVersion) !== STATE_VERSION || openedFields.length !== CURRENT_STATE_FIELDS.size ||
      openedFields.some((field)  => !CURRENT_STATE_FIELDS.has(field))) {
    const timestamp = nowIso();
    const reset = normalizeState({
      alias: record.alias || opened?.alias || DEFAULT_ALIAS,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    Object.defineProperty(reset, PROCESS_IDENTITY_RETIRED_STATE_RESET, { value: true });
    return reset;
  }
  const state = normalizeState(opened);
  if (record.stateRoot && stateRoot(state) !== record.stateRoot) {
    throw new Error("Process identity sealed state root mismatch.");
  }
  return state;
}

export function createRecord({
  alias = DEFAULT_ALIAS,
  state = {},
  sealingKeyBase64 = ""
}: { alias?: unknown; state?: ProcessIdentityObject; sealingKeyBase64?: unknown } = {}) {
  const timestamp = nowIso();
  const normalized = normalizeState({
    ...asObject(state),
    alias,
    updatedAt: timestamp
  });
  const key = text(sealingKeyBase64) || crypto.randomBytes(32).toString("base64");
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

export function publicKeyFromInput(input: Record<string, unknown> = {})  {
  const source = asObject(input);
  const pem = text(source.processPublicKeyPem || source.publicKeyPem || source.publicKey || source.clientPublicKeyPem);
  const spkiBase64 = text(source.processPublicKeySpkiBase64 || source.publicKeySpkiBase64 || source.clientPublicKeySpkiBase64);
  let publicKey = null;
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
  const spki = publicKey.export({ format: "der", type: "spki" });
  const hash = `sha256:${sha256Base64Url(spki)}`;
  return {
    publicKey,
    processPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    processPublicKeySpkiBase64: spki.toString("base64"),
    processPublicKeyHash: hash,
    processKeyId: text(source.processKeyId) || `pk_${hash.slice("sha256:".length, "sha256:".length + 24)}`
  };
}

export function normalizeClientFingerprint(input: Record<string, unknown> = {}, {
  required = false,
  clientId: _clientId = "",
  installationId: _installationId = "",
  processPublicKeyHash: _processPublicKeyHash = ""
}: Record<string, unknown> = {})  {
  const source = asObject(input);
  const nested = asObject(source.clientFingerprint || source.client_fingerprint || source.fingerprint, source);
  const fingerprintId = text(
    nested.fingerprintId ||
      nested.fingerprint_id ||
      source.clientFingerprintId ||
      source.client_fingerprint_id ||
      source.fingerprintId ||
      source.fingerprint_id
  );
  const machineInstanceId = text(
    nested.machineInstanceId ||
      nested.machine_instance_id ||
      source.machineInstanceId ||
      source.machine_instance_id
  );
  const appInstanceId = text(
    nested.appInstanceId ||
      nested.app_instance_id ||
      source.appInstanceId ||
      source.app_instance_id
  );
  const runtimeInstanceId = text(
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
  const computedHash = clientFingerprintHash({
    fingerprintId,
    machineInstanceId,
    appInstanceId,
    runtimeInstanceId
  });
  const suppliedHash = text(nested.fingerprintHash || nested.fingerprint_hash || source.clientFingerprintHash || source.client_fingerprint_hash);
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

export function privateKeyFromPem(privateKeyPem = "")  {
  return crypto.createPrivateKey(text(privateKeyPem));
}

export function signStableObject(privateKeyPem = "", payload: Record<string, unknown> = {})  {
  return crypto.sign(null, Buffer.from(stableJson(payload), "utf8"), privateKeyFromPem(privateKeyPem)).toString("base64url");
}

export function verifyClientIdentityPackageSignature({ packageObject = null, serverPublicKeyPem = "" }: Record<string, unknown> = {})  {
  const packageSource = asObject(packageObject, null);
  const signature = packageSource?.signature || {};
  if (!packageSource || !text(signature.value)) {
    return { ok: false, reasonCode: "identity_package_signature_missing" };
  }
  const { signature: _signature, ...payload } = packageSource;
  void _signature;
  const publicKey = crypto.createPublicKey(text(serverPublicKeyPem) || text(packageSource.serverPublicKeyPem));
  const ok = crypto.verify(
    null,
    Buffer.from(stableJson(payload), "utf8"),
    publicKey,
    Buffer.from(text(signature.value), "base64url")
  );
  return ok
    ? { ok: true, reasonCode: "identity_package_signature_valid" }
    : { ok: false, reasonCode: "identity_package_signature_invalid" };
}

export function clientBindingContext(client: ProcessIdentityObject = {})  {
  const fingerprint = normalizeClientFingerprint(asObject(client.clientFingerprint), { required: false });
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

export function createClientIdentityPackage({
  state = {},
  client = {},
  capabilityKey = "",
  nonce = ""
}: {
  state?: ProcessIdentityObject;
  client?: ProcessIdentityObject;
  capabilityKey?: unknown;
  nonce?: unknown;
} = {}): ProcessIdentityObject {
  const serverIdentity = state.serverIdentity || {};
  const payload: Record<string, unknown> = {
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
    clientFingerprint: normalizeClientFingerprint(asObject(client.clientFingerprint), { required: false }),
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
      value: signStableObject(text(serverIdentity.privateKeyPem), payload)
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
}: Record<string, unknown> = {})  {
  const fingerprint = normalizeClientFingerprint(asObject(clientFingerprint), { required: false });
  const parts = [
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
  const fingerprintParts = [
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

export function bodySha256Hex(body: unknown = Buffer.alloc(0)): string {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  return sha256Hex(value);
}

export function pathWithQueryFromUrl(url: URL | null = null): string {
  if (!url) return "/";
  return `${url.pathname || "/"}${url.search || ""}`;
}

export function headerValue(headers: Record<string, unknown> = {}, name = "")  {
  const lower = name.toLowerCase();
  const entry = (Object.entries(headers || {}) as [string, unknown][]).find(([key])  => key.toLowerCase() === lower);
  const value = entry?.[1];
  return Array.isArray(value) ? text(value[0]) : text(value);
}

export function capabilityKeyFromHeaders(headers: Record<string, unknown> = {})  {
  const explicit = headerValue(headers, "x-meshrix-capability-key");
  if (explicit) {
    return explicit;
  }
  const authorization = headerValue(headers, "authorization");
  const match = authorization.match(/^Bearer\s+(ock_[A-Za-z0-9_-]+)$/i);
  return match ? match[1] : "";
}

export function clientFingerprintFromHeaders(headers: Record<string, unknown> = {})  {
  const candidate: Record<string, unknown> = {
    fingerprintId: headerValue(headers, "x-meshrix-client-fingerprint-id"),
    machineInstanceId: headerValue(headers, "x-meshrix-machine-instance-id"),
    appInstanceId: headerValue(headers, "x-meshrix-app-instance-id"),
    runtimeInstanceId: headerValue(headers, "x-meshrix-runtime-instance-id"),
    fingerprintHash: headerValue(headers, "x-meshrix-client-fingerprint-hash")
  };
  return normalizeClientFingerprint(candidate, { required: false });
}

export function clientFingerprintMatches(left: Record<string, unknown> = {}, right: Record<string, unknown> = {})  {
  return text(left.fingerprintId) === text(right.fingerprintId) &&
    text(left.machineInstanceId) === text(right.machineInstanceId) &&
    text(left.appInstanceId) === text(right.appInstanceId) &&
    text(left.runtimeInstanceId) === text(right.runtimeInstanceId) &&
    text(left.fingerprintHash) === text(right.fingerprintHash);
}

export function timingSafeTextEqual(left = "", right = "")  {
  const leftHash = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightHash = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

export function operationRequiredCapabilities(operation: ProcessIdentityObject = {}): string[] {
  const configured = uniqueStrings(asArray(operation.processIdentity?.requiredCapabilities));
  return configured.length > 0 ? configured : [apiCapabilityId(text(operation.id))].filter(Boolean);
}

export function requestIsLoopback(request: { headers?: Record<string, unknown> } | null = null): boolean {
  const normalizedHeaders: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(request?.headers || {})) {
    if (typeof value === "string" || value === undefined) {
      normalizedHeaders[name] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      normalizedHeaders[name] = value;
    }
  }
  const ip = clientIpFromRequest({ headers: normalizedHeaders }, { unknown: "" });
  if (!isLoopbackAddress(ip)) {
    return false;
  }
  const host = headerValue(request?.headers || {}, "host");
  return !host || isLocalHttpHost(host);
}

export function deny(status?: number, reasonCode?: string, error?: string) {
  return { ok: false, status, reasonCode, error };
}

export function normalizeClientInput(input: Record<string, unknown> = {})  {
  const source = asObject(input);
  const key = publicKeyFromInput(source);
  const clientId = text(source.clientId) || `client_${sha256TextBase64Url(key.processPublicKeyHash).slice(0, 24)}`;
  const installationId = text(source.installationId) || `install_${sha256TextBase64Url(`${clientId}:${key.processPublicKeyHash}`).slice(0, 24)}`;
  const clientFingerprint = normalizeClientFingerprint(source, {
    required: true,
    clientId,
    installationId,
    processPublicKeyHash: key.processPublicKeyHash
  });
  const defaultIdentityHash = text(source.defaultIdentityHash || source.default_identity_hash);
  if (!defaultIdentityHash) {
    throw Object.assign(new Error("default identity hash is required"), { status: 400, reasonCode: "default_identity_hash_missing" });
  }
  const capabilities = uniqueStrings(DEFAULT_PROCESS_IDENTITY_CAPABILITIES);
  return {
    ...key,
    clientId,
    installationId,
    clientFingerprint,
    defaultIdentityHash,
    capabilities
  };
}

export function generateProcessIdentityClientKeyPair()  {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
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
}: Record<string, unknown> = {})  {
  const packageObject = asObject(clientIdentityPackage);
  const processKey = asObject(packageObject.processKey);
  const clientFingerprint = normalizeClientFingerprint(packageObject.clientFingerprint, { required: false });
  const pathWithQuery = typeof url === "string"
    ? pathWithQueryFromUrl(new URL(url, "http://127.0.0.1"))
    : pathWithQueryFromUrl(url instanceof URL ? url : null);
  const bodyHash = bodySha256Hex(Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8"));
  const canonical = canonicalProcessIdentityRequest({
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
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKeyFromPem(text(privateKeyPem))).toString("base64url");
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
