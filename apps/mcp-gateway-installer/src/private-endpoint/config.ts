import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createSecureContext as createTlsContext } from "node:tls";
import {
  PRIVATE_RELAY_MODES,
  PRIVATE_RELAY_RECOVERY_LIMITS,
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  parseEndpointTrustBinding,
  parseRelayAdmissionBinding
} from "@meshrix/contracts/private-relay";
import { PEER_ID_PATTERN } from "@meshrix/peer-crypto";
import type { RelayAdmissionInput } from "@meshrix/gateway/private-endpoint";

/**
 * Private-endpoint profile configuration.
 *
 * The operator file is JSON with five sections:
 *   relay    — Workers relay base URL plus the enrolled bearer credential binding
 *   endpoint — relay-visible admission identity plus the paired-entry trust binding
 *   innerTls — the endpoint's inner-channel TLS 1.3 identity (key/cert material)
 *   recovery — enrolled recovery authorities and the optional recovery signing key
 *   gateway  — the existing gateway configuration file that declares upstreams
 *
 * Secret material is never inline: credentials and keys arrive through `env:NAME`
 * bindings or `file:PATH` references resolved relative to the config file.
 */

export function endpointConfigError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENV_BINDING = /^env:[A-Z][A-Z0-9_]*$/u;
const MAX_AUTHORITIES = 64;
const MAX_TLS_MATERIAL_BYTES = 64 * 1024;

export interface RecoveryAuthorityConfig {
  readonly recoveryKeyId: string;
  readonly principalRef: string;
  readonly publicKey: string;
  readonly generation: number;
}

export interface PrivateEndpointConfig {
  /** Relay base WebSocket URL (wss, or ws for literal loopback only). */
  readonly relayBaseUrl: URL;
  /** Full session URL: <base>/session/<tenantId>/<routeId>. */
  readonly sessionUrl: string;
  /** Environment variable that carries the relay bearer credential. */
  readonly credentialEnv: string;
  /** Relay-visible admission for this endpoint (role is fixed `endpoint`). */
  readonly admission: RelayAdmissionInput;
  /** EndpointTrustBinding-shaped record consumed by the identity store enrollment. */
  readonly trustBinding: Readonly<Record<string, unknown>>;
  readonly innerTls: {
    readonly key: string;
    readonly cert: string;
    readonly handshakeTimeoutMs?: number;
  };
  readonly recovery: {
    readonly authorities: readonly RecoveryAuthorityConfig[];
    readonly signingKey?: string;
  };
  /** Absolute path to the existing gateway profile configuration file. */
  readonly gatewayConfigPath: string;
  readonly reconnect: {
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
  };
  /** Optional loopback-only admin/state listener (direct local control channel). */
  readonly adminListen?: { readonly host: string; readonly port: number };
  /**
   * Optional environment variable carrying the admin bearer token. When set,
   * every loopback admin route (`/status`, `/healthz`, `/metrics`, `/peer/*`)
   * requires `Authorization: Bearer <token>`; when absent the surface stays
   * loopback-only with no credential check, exactly as before.
   */
  readonly adminTokenEnv?: string;
  /** Opt-in peer messaging block — absent (or disabled) means the peer stack is never started. */
  readonly peer?: PrivateEndpointPeerConfig;
}

/**
 * Endpoint-side peer messaging configuration (`"peer"` section).
 *
 *  - `enabled` — must be literally `true` to activate; every other shape is
 *    either a disabled block or a configuration error.
 *  - `storageDir` — durable peer state root (Signal crypto store + client
 *    outbox/inbox), resolved relative to the config file. Default
 *    `<configDir>/peer-state`. Owner-only permissions are enforced by the
 *    file stores at creation.
 *  - `peerId` — optional explicit crypto peer id. The default derives
 *    `peer:<tenantId>:<routeId>:<deviceId>` from the admission identity so a
 *    remote operator can predict and verify the binding out of band.
 */
export interface PrivateEndpointPeerConfig {
  readonly storageDir: string;
  readonly peerId?: string;
}

function boundedOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw endpointConfigError("private_endpoint_identity_invalid", `${label} must be a bounded opaque identifier.`);
  }
  return value;
}

function boundedPublicKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !BASE64URL.test(value) || Buffer.byteLength(value, "utf8") > PRIVATE_RELAY_RECOVERY_LIMITS.maxKeyBytes) {
    throw endpointConfigError("private_endpoint_key_invalid", `${label} must be base64url public-key material within the contract bound.`);
  }
  // The material must decode to a parseable SPKI public key — a check-mode
  // config that cannot build a key would only fail later, mid-recovery.
  try {
    createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
  } catch {
    throw endpointConfigError("private_endpoint_key_invalid", `${label} is not a parseable SPKI public key.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum || (parsed as number) > maximum) {
    throw endpointConfigError("private_endpoint_config_invalid", `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed as number;
}

/** Resolve an `env:NAME` binding to the variable name, verifying it is set. */
function environmentBinding(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENV_BINDING.test(value)) {
    throw endpointConfigError("private_endpoint_credential_invalid", `${label} requires an explicit environment binding.`);
  }
  const name = value.slice(4);
  if (!process.env[name]) {
    throw endpointConfigError("private_endpoint_credential_missing", `${label} environment binding is unavailable.`);
  }
  return name;
}

/**
 * Resolve a `file:PATH` or `env:NAME` material reference. File paths resolve
 * relative to the configuration file directory so a moved deployment stays
 * self-contained.
 */
async function materialReference(value: unknown, label: string, baseDir: string): Promise<string> {
  if (typeof value !== "string" || !value) {
    throw endpointConfigError("private_endpoint_material_invalid", `${label} requires a file:PATH or env:NAME reference.`);
  }
  if (value.startsWith("file:")) {
    const filePath = value.slice(5);
    if (!filePath) throw endpointConfigError("private_endpoint_material_invalid", `${label} file reference is empty.`);
    const resolved = isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
    const content = await readFile(resolved, "utf8").catch(() => {
      throw endpointConfigError("private_endpoint_material_missing", `${label} file is not readable.`);
    });
    if (Buffer.byteLength(content, "utf8") > MAX_TLS_MATERIAL_BYTES) {
      throw endpointConfigError("private_endpoint_material_invalid", `${label} exceeds the material size bound.`);
    }
    return content;
  }
  if (ENV_BINDING.test(value)) {
    const name = value.slice(4);
    const content = process.env[name];
    if (!content) {
      throw endpointConfigError("private_endpoint_credential_missing", `${label} environment binding is unavailable.`);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_TLS_MATERIAL_BYTES) {
      throw endpointConfigError("private_endpoint_material_invalid", `${label} exceeds the material size bound.`);
    }
    return content;
  }
  throw endpointConfigError("private_endpoint_material_invalid", `${label} must be a file:PATH or env:NAME reference.`);
}

function relayBaseUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw endpointConfigError("private_endpoint_relay_invalid", "Relay configuration requires a url.");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw endpointConfigError("private_endpoint_relay_invalid", "Relay url is not a parseable WebSocket URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw endpointConfigError("private_endpoint_relay_invalid", "Relay url must not carry credentials, a query or a fragment.");
  }
  if (url.protocol === "wss:") return url;
  // Plain ws is a local-development binding only — it must resolve to a
  // literal loopback host so no configuration can silently downgrade a remote
  // relay hop to cleartext.
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase());
  if (url.protocol === "ws:" && loopback) return url;
  throw endpointConfigError("private_endpoint_relay_unsafe", "Relay url requires wss:; ws: is only permitted for literal loopback hosts.");
}

export async function loadPrivateEndpointConfig(path: string): Promise<PrivateEndpointConfig> {
  let provided: unknown;
  try {
    provided = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw endpointConfigError("private_endpoint_config_invalid", "Private endpoint configuration must be a readable JSON file.");
  }
  if (!record(provided)) {
    throw endpointConfigError("private_endpoint_config_invalid", "Private endpoint configuration must be an object.");
  }
  if (provided.profile !== undefined && provided.profile !== "private-endpoint") {
    throw endpointConfigError("private_endpoint_profile_unsupported", "Profile is not a private endpoint configuration.");
  }
  const baseDir = dirname(resolve(path));

  // --- relay -----------------------------------------------------------
  const relay = provided.relay;
  if (!record(relay)) throw endpointConfigError("private_endpoint_relay_invalid", "Private endpoint needs a relay section.");
  const base = relayBaseUrl(relay.url);
  const credentialEnv = environmentBinding(relay.credential, "Relay credential");

  // --- endpoint admission + trust binding -------------------------------
  const endpoint = provided.endpoint;
  if (!record(endpoint)) throw endpointConfigError("private_endpoint_identity_invalid", "Private endpoint needs an endpoint section.");
  if (endpoint.role !== undefined && endpoint.role !== "endpoint") {
    throw endpointConfigError("private_endpoint_role_invalid", "The receiving profile always presents the endpoint role.");
  }
  if (typeof endpoint.mode !== "string" || !PRIVATE_RELAY_MODES.includes(endpoint.mode as never)) {
    throw endpointConfigError("private_endpoint_mode_invalid", "Endpoint mode must be personal or enterprise.");
  }
  const admission: RelayAdmissionInput = Object.freeze({
    tenantId: boundedOpaqueId(endpoint.tenantId, "Endpoint tenantId"),
    deviceId: boundedOpaqueId(endpoint.deviceId, "Endpoint deviceId"),
    routeId: boundedOpaqueId(endpoint.routeId, "Endpoint routeId"),
    role: "endpoint",
    mode: endpoint.mode,
    admissionGeneration: safeInteger(endpoint.admissionGeneration, "Endpoint admissionGeneration", 1, Number.MAX_SAFE_INTEGER),
    revocationRevision: safeInteger(endpoint.revocationRevision, "Endpoint revocationRevision", 0, Number.MAX_SAFE_INTEGER)
  });
  // Re-validate through the canonical wire parser so no profile-specific
  // interpretation can drift from the contract the relay enforces.
  if (!parseRelayAdmissionBinding(admission)) {
    throw endpointConfigError("private_endpoint_identity_invalid", "Endpoint admission does not satisfy the relay admission contract.");
  }
  const trustBinding = Object.freeze({
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "endpoint-trust-binding",
    pairedIdentityKey: boundedPublicKey(endpoint.pairedIdentityKey, "Paired identity key"),
    pairedIdentityFingerprint: boundedOpaqueId(endpoint.pairedIdentityFingerprint, "Paired identity fingerprint"),
    mode: endpoint.mode,
    role: "endpoint",
    trustGeneration: safeInteger(endpoint.trustGeneration, "Endpoint trustGeneration", 1, Number.MAX_SAFE_INTEGER),
    endpointPrincipalRef: boundedOpaqueId(endpoint.endpointPrincipalRef, "Endpoint principalRef"),
    capabilityGrantRef: boundedOpaqueId(endpoint.capabilityGrantRef, "Endpoint capabilityGrantRef"),
    boundRecoveryKeyId: endpoint.boundRecoveryKeyId === undefined || endpoint.boundRecoveryKeyId === null
      ? null
      : boundedOpaqueId(endpoint.boundRecoveryKeyId, "Bound recovery key id")
  });
  if (!parseEndpointTrustBinding(trustBinding)) {
    throw endpointConfigError("private_endpoint_trust_invalid", "Endpoint trust binding does not satisfy the wire contract.");
  }

  // --- inner TLS identity ------------------------------------------------
  const innerTls = provided.innerTls;
  if (!record(innerTls)) throw endpointConfigError("private_endpoint_tls_invalid", "Private endpoint needs an innerTls section.");
  const tlsKey = await materialReference(innerTls.key, "Inner TLS key", baseDir);
  const tlsCert = await materialReference(innerTls.cert, "Inner TLS certificate", baseDir);
  try {
    createTlsContext({ key: tlsKey, cert: tlsCert });
  } catch {
    throw endpointConfigError("private_endpoint_tls_invalid", "Inner TLS key/certificate pair is not usable.");
  }
  const handshakeTimeoutMs = innerTls.handshakeTimeoutMs === undefined
    ? undefined
    : safeInteger(innerTls.handshakeTimeoutMs, "Inner TLS handshakeTimeoutMs", 0, 600_000);

  // --- recovery authority --------------------------------------------------
  const recovery = provided.recovery;
  let authorities: RecoveryAuthorityConfig[] = [];
  let signingKey: string | undefined;
  if (recovery !== undefined) {
    if (!record(recovery)) throw endpointConfigError("private_endpoint_recovery_invalid", "Recovery section must be an object.");
    if (recovery.authorities !== undefined && !Array.isArray(recovery.authorities)) {
      throw endpointConfigError("private_endpoint_recovery_invalid", "Recovery authorities must be an array.");
    }
    const raw = Array.isArray(recovery.authorities) ? recovery.authorities : [];
    if (raw.length > MAX_AUTHORITIES) {
      throw endpointConfigError("private_endpoint_recovery_invalid", "Recovery authority list exceeds the bounded size.");
    }
    authorities = raw.map((entry: unknown, index: number) => {
      if (!record(entry)) throw endpointConfigError("private_endpoint_recovery_invalid", `Recovery authority ${index} must be an object.`);
      return Object.freeze({
        recoveryKeyId: boundedOpaqueId(entry.recoveryKeyId, `Recovery authority ${index} recoveryKeyId`),
        principalRef: boundedOpaqueId(entry.principalRef, `Recovery authority ${index} principalRef`),
        publicKey: boundedPublicKey(entry.publicKey, `Recovery authority ${index} publicKey`),
        generation: safeInteger(entry.generation, `Recovery authority ${index} generation`, 1, Number.MAX_SAFE_INTEGER)
      });
    });
    if (new Set(authorities.map((authority) => authority.recoveryKeyId)).size !== authorities.length) {
      throw endpointConfigError("private_endpoint_recovery_invalid", "Recovery authority identities must be unique.");
    }
    if (recovery.signingKey !== undefined) {
      signingKey = await materialReference(recovery.signingKey, "Recovery signing key", baseDir);
      try {
        createPrivateKey(signingKey);
      } catch {
        throw endpointConfigError("private_endpoint_key_invalid", "Recovery signing key is not a parseable private key.");
      }
    }
  }

  // --- upstream gateway composition ----------------------------------------
  const gateway = provided.gateway;
  if (!record(gateway) || typeof gateway.configPath !== "string" || !gateway.configPath) {
    throw endpointConfigError("private_endpoint_gateway_invalid", "Private endpoint needs gateway.configPath pointing at a gateway configuration file.");
  }
  const gatewayConfigPath = isAbsolute(gateway.configPath) ? gateway.configPath : resolve(baseDir, gateway.configPath);

  // --- reconnect supervision ------------------------------------------------
  const reconnect = provided.reconnect;
  if (reconnect !== undefined && !record(reconnect)) {
    throw endpointConfigError("private_endpoint_reconnect_invalid", "Reconnect section must be an object.");
  }
  const initialDelayMs = reconnect?.initialDelayMs === undefined
    ? 250
    : safeInteger(reconnect.initialDelayMs, "Reconnect initialDelayMs", 1, 60_000);
  const maxDelayMs = reconnect?.maxDelayMs === undefined
    ? 30_000
    : safeInteger(reconnect.maxDelayMs, "Reconnect maxDelayMs", initialDelayMs, 600_000);

  // --- optional loopback admin surface ---------------------------------------
  const admin = provided.admin;
  let adminListen: PrivateEndpointConfig["adminListen"];
  let adminTokenEnv: string | undefined;
  if (admin !== undefined) {
    if (!record(admin) || !record(admin.listen)) {
      throw endpointConfigError("private_endpoint_admin_invalid", "Admin section needs a listen object.");
    }
    const host = typeof admin.listen.host === "string" ? admin.listen.host : "127.0.0.1";
    if (!["127.0.0.1", "::1"].includes(host)) {
      throw endpointConfigError("private_endpoint_admin_unsafe", "The endpoint admin surface only binds literal loopback.");
    }
    const port = admin.listen.port === undefined ? 0 : safeInteger(admin.listen.port, "Admin listen port", 0, 65_535);
    adminListen = Object.freeze({ host, port });
    if (admin.token !== undefined) {
      adminTokenEnv = environmentBinding(admin.token, "Admin bearer token");
    }
  }

  // --- optional peer messaging ---------------------------------------------
  const peerSection = provided.peer;
  let peerConfig: PrivateEndpointPeerConfig | undefined;
  if (peerSection !== undefined) {
    if (!record(peerSection)) {
      throw endpointConfigError("private_endpoint_peer_invalid", "The peer section must be an object.");
    }
    if (peerSection.enabled !== undefined && peerSection.enabled !== true && peerSection.enabled !== false) {
      throw endpointConfigError("private_endpoint_peer_invalid", "peer.enabled must be a boolean.");
    }
    if (peerSection.enabled === true) {
      const storageDir = peerSection.storageDir === undefined
        ? resolve(baseDir, "peer-state")
        : (() => {
            if (typeof peerSection.storageDir !== "string" || !peerSection.storageDir) {
              throw endpointConfigError("private_endpoint_peer_invalid", "peer.storageDir must be a non-empty path.");
            }
            return isAbsolute(peerSection.storageDir) ? peerSection.storageDir : resolve(baseDir, peerSection.storageDir);
          })();
      let peerId: string | undefined;
      if (peerSection.peerId !== undefined) {
        if (typeof peerSection.peerId !== "string" || !PEER_ID_PATTERN.test(peerSection.peerId)) {
          throw endpointConfigError("private_endpoint_peer_invalid", "peer.peerId must satisfy the peer identifier contract.");
        }
        peerId = peerSection.peerId;
      }
      peerConfig = Object.freeze({ storageDir, ...(peerId ? { peerId } : {}) });
    }
  }

  return Object.freeze({
    relayBaseUrl: base,
    sessionUrl: `${base.origin}${base.pathname === "/" ? "" : base.pathname.replace(/\/$/u, "")}/session/${admission.tenantId}/${admission.routeId}`,
    credentialEnv,
    admission,
    trustBinding,
    innerTls: Object.freeze({ key: tlsKey, cert: tlsCert, ...(handshakeTimeoutMs ? { handshakeTimeoutMs } : {}) }),
    recovery: Object.freeze({ authorities: Object.freeze(authorities), ...(signingKey ? { signingKey } : {}) }),
    gatewayConfigPath,
    reconnect: Object.freeze({ initialDelayMs, maxDelayMs }),
    ...(adminListen ? { adminListen } : {}),
    ...(adminTokenEnv ? { adminTokenEnv } : {}),
    ...(peerConfig ? { peer: peerConfig } : {})
  });
}
