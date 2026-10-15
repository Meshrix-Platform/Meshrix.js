import { Buffer } from "node:buffer";
import { randomBytes, createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  ACCOUNT_API_ROUTES,
  canonicalAccountActionTarget,
  isAccountStepUpPermitId,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountManagedRouteBinding,
  type AccountDeviceRevokeResponse,
  type AccountEndpointOwnershipClaimCompleteResponse,
  type AccountEndpointOwnershipClaimPrepareResponse,
  type PairingPeerIdentity
} from "@meshrix/contracts/account";
import type { Gateway, GatewayOutcome, GatewayStats, Subscription } from "@meshrix/contracts/gateway";
import type { AccountDeviceCurrentBindingResponse } from "@meshrix/contracts/account";
import {
  EndpointAccountPairingApplication,
  AccountEndpointAuthorityClient,
  accountDeviceAuthorizationMatches,
  createEndpointIdentityStore,
  createFileEndpointIdentityDurablePort,
  createPrivateGatewayEndpoint,
  type EndpointDeviceRecord,
  type EndpointIdentityStore,
  type InnerTlsChannel,
  type PrivateEndpoint,
  type RecoverySigner,
  type RelayAdmissionInput
} from "@meshrix/gateway/private-endpoint";
import {
  PeerClient,
  createFilePeerClientStore,
  type PeerDispatchHandler,
  type PeerClientTransport,
  type PeerInboundMessage,
  type PeerInboundOutcome,
  type PeerRouteIdentity
} from "@meshrix/peer-client";
import {
  createFilePeerCryptoStore,
  createPeerIdentity,
  loadPeerIdentity,
  type PeerIdentity,
  type PeerCryptoStore
} from "@meshrix/peer-crypto";
import {
  createInnerDispatchLoop,
  createPeerSessionChannel,
  createWssRelayTransport,
  isPeerSchemaMessage,
  peerIdForRouteDevice,
  type InnerDispatchLoop,
  type WssRelayTransport,
  type WssRelayTransportOptions
} from "@meshrix/entry-transport";
import {
  deviceIdentityFromCustody,
  enrollDeviceIdentity,
  entryError,
  loadDevicePrivateKey,
  parsePairingInvite,
  type CustodyAdapter,
  type DeviceIdentity,
  type PairingInvite
} from "@meshrix/entry";

import { signDesktopAccountProof } from "./account-client.ts";
import {
  custodyDeviceSigner,
  issueDeviceCertificate
} from "./device-cert.ts";
import {
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  parseSessionClose,
  parseSessionRejected
} from "@meshrix/contracts/private-relay";

import { normalizeRelayBase, relaySessionUrl } from "./relay-address.ts";

const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_FILE = "personal-endpoint.json";
const IDENTITY_FILE = "endpoint-identity.json";
const CLAIM_SECRET_PREFIX = "personal.endpoint.claim";
const RELAY_SECRET_REF = "personal.endpoint.relay";
const DEVICE_CUSTODY_PREFIX = "personal.endpoint.device";
const PEER_STORE_DIR = "peer";
const TRUST_SCOPE = "peer:message";
const PRIVATE_PERSONAL_PREFIX = "personal-endpoint";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,8192}$/u;
/** Account-issued Relay credentials may append the documented path-bound ticket tag. */
const RELAY_CREDENTIAL = /^[A-Za-z0-9_-]{32,8192}(?:\.[A-Za-z0-9_-]{24})?$/u;
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export interface PersonalEndpointIdentity {
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
}

export interface PersonalEndpointPeerRoute {
  readonly tenantId: string;
  readonly routeId: string;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
}

export interface PersonalEndpointInboundMessage {
  readonly address: PersonalEndpointPeerRoute;
  readonly message: PeerInboundMessage;
}

export type PersonalEndpointAuthorityDecision = "current" | "unavailable" | "revoked";

export type PersonalEndpointInboundHandler = (
  delivery: PersonalEndpointInboundMessage
) => PeerInboundOutcome | Promise<PeerInboundOutcome>;

export interface PersonalEndpointEntryDevice {
  readonly deviceId: string;
  readonly displayLabel: null;
}

type AuthorityDecision<T> =
  | { readonly state: "current"; readonly value: T }
  | { readonly state: "changed"; readonly value: T }
  | { readonly state: "revoked" }
  | { readonly state: "unavailable" };

export interface PersonalEndpointSnapshot {
  readonly state: "unregistered" | "enrolled" | "connecting" | "connected" | "unreachable" | "action_required" | "revoked";
  readonly account: AccountAuthorityBinding | null;
  readonly endpoint: PersonalEndpointIdentity | null;
  readonly peerId: string | null;
  readonly relayState: "idle" | "connecting" | "open" | "closed";
  readonly routeState: string;
  readonly acceptsNewWork: boolean;
  /** Durable account-authority results from this profile's prior route retirements. */
  readonly routeRevocations: readonly AccountDeviceRevokeResponse[];
}

export interface PersonalEndpointStepUpRequest {
  readonly claimId: string;
  readonly account: AccountAuthorityBinding;
  readonly target: AccountActionTarget;
}

export interface PersonalEndpointStepUpResult {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly target: AccountActionTarget;
}

export interface PersonalEndpointEnrollmentInput {
  readonly account: AccountAuthorityBinding;
  readonly accountCredential: string;
  readonly desktopDeviceId: string;
  readonly desktopPublicKey: string;
  readonly desktopPrivateKey: KeyObject;
  readonly requestFreshStepUp: (input: PersonalEndpointStepUpRequest) => Promise<PersonalEndpointStepUpResult>;
}

export interface PersonalEndpointRuntimeOptions {
  readonly dataDir: string;
  readonly custody: CustodyAdapter;
  /** Trusted release-owned relay base URL. No user JSON or staging default is used. */
  readonly relayService: string | URL;
  /** Trusted release-owned account HTTPS origin. */
  readonly accountOrigin: string | URL;
  readonly fetch?: typeof fetch;
  /** Optional deterministic relay seam for local Workerd/source fixtures. */
  readonly createRelayTransport?: (options: WssRelayTransportOptions) => WssRelayTransport;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
  readonly onState?: (snapshot: PersonalEndpointSnapshot) => void;
}

interface PersonalEndpointProfile {
  readonly schemaVersion: 1;
  readonly endpointDeviceId: string;
  readonly routeId: string;
  /** Route-scoped Peer storage. null retains the pre-route-scoped local store without moving user data. */
  readonly peerStoreKey: string | null;
  /** Prevents a revoked local profile from being silently rebound to another account. */
  readonly priorAccountId: string | null;
  readonly state: "unregistered" | "enrolled" | "revoked";
  readonly account: AccountAuthorityBinding | null;
  readonly tenantId: string | null;
  readonly vaultId: string | null;
  readonly endpointPinRef: string | null;
  readonly endpointPrincipalRef: string | null;
  readonly capabilityGrantRef: string | null;
  readonly relayService: string;
  readonly admissionGeneration: number | null;
  readonly revocationRevision: number | null;
  /** Persisted before the exact old-route revoke request so retries reuse its id. */
  readonly pendingRouteRevocationOperationId: string | null;
  readonly routeRevocations: readonly AccountDeviceRevokeResponse[];
}

interface ClaimCheckpoint {
  readonly schemaVersion: 1;
  readonly phase: "prepared" | "ready" | "completed";
  readonly account: AccountAuthorityBinding;
  readonly desktopDeviceId: string;
  readonly desktopPublicKey: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly endpointPinRef: string;
  readonly prepared: AccountEndpointOwnershipClaimPrepareResponse;
  readonly permitId?: string;
  readonly operationId?: string;
  readonly completed?: AccountEndpointOwnershipClaimCompleteResponse;
}

interface PeerClientBinding {
  readonly client: PeerClient;
  readonly identity: PeerIdentity;
  readonly store: PeerCryptoStore;
  readonly route: PeerRouteIdentity;
  readonly peerId: string;
}

function personalError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function authorityErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameBinding(left: AccountAuthorityBinding | null | undefined, right: AccountAuthorityBinding | null | undefined): boolean {
  return Boolean(left && right && left.accountId === right.accountId && left.authEpoch === right.authEpoch);
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function accountBinding(value: unknown): value is AccountAuthorityBinding {
  return isRecord(value) && opaque(value.accountId) && Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0;
}

function isAccountDeviceRevokeResponse(value: unknown): value is AccountDeviceRevokeResponse {
  return isRecord(value) && value.authorityRevoked === true && opaque(value.operationId)
    && (value.target === "route" || value.target === "device")
    && opaque(value.tenantId) && opaque(value.routeId) && opaque(value.deviceId)
    && (value.enforcement === "pending" || value.enforcement === "complete");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function claimSecretRef(routeId: string): string {
  // Custody refs must match the lowercase contract (see assertCustodyRef);
  // hex keeps the digest injective where base64url is not.
  return `${CLAIM_SECRET_PREFIX}.${createHash("sha256").update(routeId, "utf8").digest("hex")}`;
}

function endpointIdentityId(prefix: string): string {
  return `${prefix}.${randomBytes(18).toString("base64url")}`;
}

function normalizedAccountOrigin(input: string | URL): URL {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw personalError("account_authority_origin_invalid", "Account authority must be a bare HTTPS origin.");
  }
  return url;
}

function accountSessionTranscriptBody(input: {
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly endpointPinRef: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...input, mode: "personal" as const });
}

function validatePreparedClaim(value: unknown, expected: {
  readonly account: AccountAuthorityBinding;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly now: number;
}): AccountEndpointOwnershipClaimPrepareResponse {
  if (!isRecord(value) || !opaque(value.claimId) || !sameBinding(value.account as AccountAuthorityBinding, expected.account)
    || !opaque(value.vaultId) || !isRecord(value.target)
    || value.target.routeId !== expected.routeId || value.target.deviceId !== expected.endpointDeviceId
    || value.target.devicePublicKey !== expected.endpointPublicKey || !opaque(value.target.tenantId)
    || !opaque(value.target.grantRef) || !Array.isArray(value.target.scopes)
    || value.target.scopes.length === 0 || value.target.scopes.some((scope) => typeof scope !== "string")
    || value.target.vaultWriterRotation !== undefined
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= expected.now) {
    throw personalError("account_endpoint_claim_invalid", "Account authority returned a claim target outside this local endpoint identity.");
  }
  return value as unknown as AccountEndpointOwnershipClaimPrepareResponse;
}

function validateCompletedClaim(value: unknown, checkpoint: ClaimCheckpoint): AccountEndpointOwnershipClaimCompleteResponse {
  if (!isRecord(value) || value.claimed !== true || !sameBinding(value.account as AccountAuthorityBinding, checkpoint.account)
    || value.tenantId !== checkpoint.prepared.target.tenantId || value.routeId !== checkpoint.routeId
    || value.endpointDeviceId !== checkpoint.endpointDeviceId || value.endpointPublicKey !== checkpoint.endpointPublicKey
    || value.endpointPinRef !== checkpoint.endpointPinRef || value.vaultId !== checkpoint.prepared.vaultId
    || value.mode !== "personal" || typeof value.relayAdmission !== "string" || !RELAY_CREDENTIAL.test(value.relayAdmission)
    || !Number.isSafeInteger(value.admissionGeneration) || Number(value.admissionGeneration) < 1
    || !Number.isSafeInteger(value.revocationRevision) || Number(value.revocationRevision) < 0
    || !(value.expiresAt === null || typeof value.expiresAt === "string")) {
    throw personalError("account_endpoint_claim_invalid", "Account authority returned an invalid endpoint claim result.");
  }
  return value as unknown as AccountEndpointOwnershipClaimCompleteResponse;
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw personalError("account_authority_response_invalid", "Account authority returned an oversized response.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {
    throw personalError("account_authority_response_invalid", "Account authority returned malformed JSON.");
  }
  if (!response.ok) {
    const code = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string" ? parsed.error.code : "account_authority_refused";
    throw personalError(code, "Account authority refused this endpoint operation.");
  }
  return parsed;
}

async function accountPost(input: {
  readonly origin: URL;
  readonly path: string;
  readonly body: unknown;
  readonly fetch: typeof fetch;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetch(new URL(input.path, input.origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-store", "content-type": "application/json" },
      body: JSON.stringify(input.body)
    });
  } catch {
    throw personalError("account_authority_unavailable", "Account authority could not be reached.");
  }
  return responseJson(response);
}

function saveOwnerOnly(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no temporary file remains */ }
    throw personalError("personal_endpoint_state_write_failed", "Personal endpoint state could not be saved safely.");
  }
}

function defaultProfile(relayService: URL): PersonalEndpointProfile {
  const routeId = endpointIdentityId("route.personal");
  return Object.freeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    endpointDeviceId: endpointIdentityId("dev.personal"),
    routeId,
    peerStoreKey: routeId,
    priorAccountId: null,
    state: "unregistered",
    account: null,
    tenantId: null,
    vaultId: null,
    endpointPinRef: null,
    endpointPrincipalRef: null,
    capabilityGrantRef: null,
    relayService: relayService.toString(),
    admissionGeneration: null,
    revocationRevision: null,
    pendingRouteRevocationOperationId: null,
    routeRevocations: Object.freeze([])
  });
}

function loadProfile(path: string, relayService: URL): PersonalEndpointProfile {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultProfile(relayService);
    throw personalError("personal_endpoint_state_unreadable", "Personal endpoint state could not be read.");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== PROFILE_SCHEMA_VERSION || !opaque(value.endpointDeviceId)
      || !opaque(value.routeId) || !(value.peerStoreKey === undefined || value.peerStoreKey === null || opaque(value.peerStoreKey))
      || !(value.priorAccountId === undefined || value.priorAccountId === null || opaque(value.priorAccountId))
      || !["unregistered", "enrolled", "revoked"].includes(String(value.state))
      || !(value.account === null || accountBinding(value.account))
      || !(value.tenantId === null || opaque(value.tenantId))
      || !(value.vaultId === null || opaque(value.vaultId))
      || !(value.endpointPinRef === null || typeof value.endpointPinRef === "string")
      || !(value.endpointPrincipalRef === null || opaque(value.endpointPrincipalRef))
      || !(value.capabilityGrantRef === null || opaque(value.capabilityGrantRef))
      || typeof value.relayService !== "string"
      || !(value.admissionGeneration === null || Number.isSafeInteger(value.admissionGeneration))
      || !(value.revocationRevision === null || Number.isSafeInteger(value.revocationRevision))) throw new Error("invalid");
    if (!(value.pendingRouteRevocationOperationId === undefined || value.pendingRouteRevocationOperationId === null || opaque(value.pendingRouteRevocationOperationId))
      || !(value.routeRevocations === undefined || (Array.isArray(value.routeRevocations) && value.routeRevocations.every(isAccountDeviceRevokeResponse)))) throw new Error("invalid");
    const storedRelay = normalizeRelayBase(value.relayService);
    if (storedRelay.toString() !== relayService.toString()) {
      throw personalError("personal_endpoint_relay_conflict", "This personal endpoint is already bound to a different release-configured relay.");
    }
    return Object.freeze({
      ...structuredClone(value),
      peerStoreKey: typeof value.peerStoreKey === "string" ? value.peerStoreKey : null,
      priorAccountId: typeof value.priorAccountId === "string" ? value.priorAccountId : null,
      pendingRouteRevocationOperationId: typeof value.pendingRouteRevocationOperationId === "string" ? value.pendingRouteRevocationOperationId : null,
      routeRevocations: Object.freeze(Array.isArray(value.routeRevocations) ? value.routeRevocations.map((item) => Object.freeze({ ...item })) : [])
    } as unknown as PersonalEndpointProfile);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "personal_endpoint_relay_conflict") throw error;
    throw personalError("personal_endpoint_state_invalid", "Personal endpoint state is malformed or unsupported.");
  }
}

function trustBinding(input: {
  readonly identity: DeviceIdentity;
  readonly endpointPrincipalRef: string;
  readonly capabilityGrantRef: string;
}): Record<string, unknown> {
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "endpoint-trust-binding",
    pairedIdentityKey: input.identity.publicKey,
    pairedIdentityFingerprint: input.identity.fingerprint,
    mode: "personal",
    role: "endpoint",
    trustGeneration: 1,
    endpointPrincipalRef: input.endpointPrincipalRef,
    capabilityGrantRef: input.capabilityGrantRef,
    boundRecoveryKeyId: null
  };
}

function disabledGateway(): Gateway {
  const failure: GatewayOutcome = Object.freeze({
    kind: "failure",
    origin: "policy",
    code: "personal_endpoint_gateway_disabled",
    message: "Personal device communication is available only through the encrypted peer application channel.",
    status: 403,
    effectOutcome: "not_started"
  });
  const stats: GatewayStats = Object.freeze({
    started: true,
    closing: false,
    activeInvocations: 0,
    catalogRevision: "personal-endpoint-disabled",
    admission: Object.freeze({ enabled: false })
  });
  const subscription: Subscription = Object.freeze({
    id: "personal-endpoint-disabled",
    events: { async *[Symbol.asyncIterator]() {} },
    close() {}
  });
  return {
    async start() {},
    async close() {},
    async invoke() { return failure; },
    async continue() { return failure; },
    catalog() { return Object.freeze({ revision: stats.catalogRevision, items: Object.freeze([]) }); },
    subscribe() { return subscription; },
    stats() { return stats; }
  };
}

function createRecoverySigner(key: KeyObject): RecoverySigner {
  return Object.freeze({
    sign(transcript: unknown): string {
      const algorithm = key.asymmetricKeyType === "ed25519" ? null : "sha256";
      return cryptoSign(algorithm, Buffer.from(String(transcript), "utf8"), key).toString("base64url");
    },
    verify(input: { readonly publicKey: string; readonly signature: string; readonly transcript: unknown }): boolean {
      try {
        const publicKey = input.publicKey.startsWith("-----BEGIN")
          ? createPublicKey(input.publicKey)
          : createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
        const algorithm = publicKey.asymmetricKeyType === "ed25519" ? null : "sha256";
        return cryptoVerify(algorithm, Buffer.from(String(input.transcript), "utf8"), publicKey, Buffer.from(input.signature, "base64url"));
      } catch { return false; }
    }
  });
}

/**
 * Same-client receiving endpoint for the personal profile. Account authority
 * owns route/device allocation; the host owns custody, the existing encrypted
 * relay session, pairing and a durable PeerClient. The regular Gateway MCP
 * path is disabled by construction — application messages only travel through
 * PeerClient and the host-neutral ACP engine.
 */
export class PersonalEndpointRuntime {
  readonly #options: PersonalEndpointRuntimeOptions;
  readonly #dataDir: string;
  readonly #relayBase: URL;
  readonly #accountOrigin: URL;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelSchedule: (handle: unknown) => void;
  readonly #profilePath: string;
  readonly #identityPath: string;
  #peerStoreDir: string;
  readonly #identityStore: EndpointIdentityStore;
  readonly #inboundHandlers = new Set<PersonalEndpointInboundHandler>();
  #profile: PersonalEndpointProfile;
  #peerBinding: PeerClientBinding | null = null;
  #endpoint: PrivateEndpoint | null = null;
  #transport: WssRelayTransport | null = null;
  #accountAuthority: AccountEndpointAuthorityClient | null = null;
  #pairing: EndpointAccountPairingApplication | null = null;
  #endpointKey: KeyObject | null = null;
  #deviceIdentity: DeviceIdentity | null = null;
  #peerIdentity: PeerIdentity | null = null;
  #peerCryptoStore: PeerCryptoStore | null = null;
  #publishedPeerBundleFor: string | null = null;
  #peerBundlePublication: { readonly peerId: string; readonly promise: Promise<void> } | null = null;
  #peerAdmissionWork = new WeakMap<PeerClient, Promise<void>>();
  #routeState = "unreachable";
  #connecting = false;
  #stopping = false;
  #closeWork: Promise<void> | null = null;
  #reconnectAttempt = 0;
  #reconnectTimer: unknown;
  #innerLoops = new Set<InnerDispatchLoop>();
  #startedOnce = false;

  private constructor(options: PersonalEndpointRuntimeOptions, profile: PersonalEndpointProfile) {
    this.#options = options;
    this.#dataDir = resolve(options.dataDir, PRIVATE_PERSONAL_PREFIX);
    this.#relayBase = normalizeRelayBase(options.relayService);
    this.#accountOrigin = normalizedAccountOrigin(options.accountOrigin);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.#profilePath = join(this.#dataDir, PROFILE_FILE);
    this.#identityPath = join(this.#dataDir, IDENTITY_FILE);
    this.#peerStoreDir = profile.peerStoreKey
      ? join(this.#dataDir, PEER_STORE_DIR, profile.peerStoreKey)
      : join(this.#dataDir, PEER_STORE_DIR);
    this.#profile = profile;
    this.#identityStore = createEndpointIdentityStore(createFileEndpointIdentityDurablePort(this.#identityPath));
  }

  static async create(options: PersonalEndpointRuntimeOptions): Promise<PersonalEndpointRuntime> {
    if (!options.dataDir) throw personalError("personal_endpoint_data_dir_invalid", "Personal endpoint data directory is required.");
    if (!options.custody || !(await options.custody.available())) {
      throw personalError("personal_endpoint_custody_unavailable", "A protected local credential store is required for endpoint keys and relay admission.");
    }
    const dataDir = resolve(options.dataDir, PRIVATE_PERSONAL_PREFIX);
    const relay = normalizeRelayBase(options.relayService);
    const profile = loadProfile(join(dataDir, PROFILE_FILE), relay);
    const runtime = new PersonalEndpointRuntime(options, profile);
    // Persist generated route/device ids before any authority request so an
    // ambiguous response can be replayed with the same exact claim target.
    if (!existsSync(runtime.#profilePath)) runtime.#saveProfile();
    if (profile.state === "enrolled") {
      await runtime.#loadClaimedIdentity();
      await runtime.#ensurePeerIdentity();
    }
    return runtime;
  }

  get peerClient(): PeerClient | null {
    return this.#peerBinding?.client ?? null;
  }

  get endpointIdentity(): PersonalEndpointIdentity | null {
    if (this.#profile.state !== "enrolled" || !this.#profile.tenantId) return null;
    return Object.freeze({ tenantId: this.#profile.tenantId, routeId: this.#profile.routeId, endpointDeviceId: this.#profile.endpointDeviceId });
  }

  static async createAndEnroll(options: PersonalEndpointRuntimeOptions, input: PersonalEndpointEnrollmentInput): Promise<PersonalEndpointRuntime> {
    const runtime = await PersonalEndpointRuntime.create(options);
    await runtime.enrollCurrentAccount(input);
    return runtime;
  }

  async enrollCurrentAccount(input: PersonalEndpointEnrollmentInput): Promise<PersonalEndpointSnapshot> {
    this.#assertNotStopped();
    this.#validateEnrollmentInput(input);
    if (this.#profile.state === "enrolled") {
      if (this.#profile.account?.accountId !== input.account.accountId) {
        throw personalError("personal_endpoint_account_conflict", "This endpoint is already owned by another account.");
      }
      if (!sameBinding(this.#profile.account, input.account)) {
        throw personalError("personal_endpoint_reenrollment_required", "This account recovered or changed epoch. Explicitly refresh the endpoint to create a new route after fresh account verification.");
      }
      await this.#loadClaimedIdentity();
      return this.snapshot();
    }
    if (this.#profile.state === "revoked") {
      throw personalError("personal_endpoint_reenrollment_required", "This endpoint was revoked. Explicitly refresh it under the same account to create a new route after fresh account verification.");
    }
    if (this.#profile.priorAccountId && this.#profile.priorAccountId !== input.account.accountId) {
      throw personalError("personal_endpoint_account_conflict", "This retained personal profile can only be re-enrolled by its original account.");
    }

    let deviceIdentity = await deviceIdentityFromCustody({
      custody: this.#options.custody,
      deviceId: this.#profile.endpointDeviceId,
      refPrefix: DEVICE_CUSTODY_PREFIX
    });
    if (!deviceIdentity) {
      deviceIdentity = await enrollDeviceIdentity({
        custody: this.#options.custody,
        deviceId: this.#profile.endpointDeviceId,
        refPrefix: DEVICE_CUSTODY_PREFIX
      });
    }
    const endpointKey = await loadDevicePrivateKey({
      custody: this.#options.custody,
      deviceId: this.#profile.endpointDeviceId,
      refPrefix: DEVICE_CUSTODY_PREFIX
    });
    if (!endpointKey) throw personalError("personal_endpoint_key_unavailable", "The endpoint signing key is unavailable in local custody.");
    this.#endpointKey = endpointKey;
    this.#deviceIdentity = deviceIdentity;
    const certificate = issueDeviceCertificate({
      publicKeyRaw: Buffer.from(deviceIdentity.publicKey, "base64url"),
      sign: custodyDeviceSigner(endpointKey),
      subject: `meshrix-personal-endpoint ${this.#profile.endpointDeviceId}`,
      notBefore: new Date(this.#now())
    });
    const endpointPinRef = certificate.spkiPin;
    const claimSecret = await this.#loadClaimCheckpoint();
    const checkpointMatches = claimSecret && sameBinding(claimSecret.account, input.account)
      && claimSecret.desktopDeviceId === input.desktopDeviceId
      && claimSecret.desktopPublicKey === input.desktopPublicKey
      && claimSecret.routeId === this.#profile.routeId
      && claimSecret.endpointDeviceId === this.#profile.endpointDeviceId
      && claimSecret.endpointPublicKey === deviceIdentity.publicKey
      && claimSecret.endpointPinRef === endpointPinRef;
    if (claimSecret && !checkpointMatches) {
      throw personalError("personal_endpoint_claim_checkpoint_conflict", "A pending endpoint claim belongs to a different local identity or account. Preserve it or use a separate profile.");
    }
    let checkpoint = checkpointMatches ? claimSecret : null;
    if (!checkpoint) {
      const prepareBody = accountSessionTranscriptBody({
        routeId: this.#profile.routeId,
        endpointDeviceId: this.#profile.endpointDeviceId,
        endpointPublicKey: deviceIdentity.publicKey,
        endpointPinRef
      });
      const path = ACCOUNT_API_ROUTES.deviceEndpointClaimPrepare;
      const desktopProof = signDesktopAccountProof({
        pathname: path,
        account: input.account,
        credential: input.accountCredential,
        clientPublicKey: input.desktopPublicKey,
        privateKey: input.desktopPrivateKey,
        body: prepareBody
      });
      const prepared = validatePreparedClaim(await accountPost({
        origin: this.#accountOrigin,
        path,
        body: { ...prepareBody, desktopProof },
        fetch: this.#fetch
      }), {
        account: input.account,
        routeId: this.#profile.routeId,
        endpointDeviceId: this.#profile.endpointDeviceId,
        endpointPublicKey: deviceIdentity.publicKey,
        now: this.#now()
      });
      checkpoint = Object.freeze({
        schemaVersion: 1,
        phase: "prepared",
        account: Object.freeze({ ...input.account }),
        desktopDeviceId: input.desktopDeviceId,
        desktopPublicKey: input.desktopPublicKey,
        routeId: this.#profile.routeId,
        endpointDeviceId: this.#profile.endpointDeviceId,
        endpointPublicKey: deviceIdentity.publicKey,
        endpointPinRef,
        prepared
      });
      await this.#saveClaimCheckpoint(checkpoint);
    }
    const prepared = validatePreparedClaim(checkpoint.prepared, {
      account: input.account,
      routeId: this.#profile.routeId,
      endpointDeviceId: this.#profile.endpointDeviceId,
      endpointPublicKey: deviceIdentity.publicKey,
      now: this.#now()
    });
    if (checkpoint.phase === "prepared") {
      const stepUp = await input.requestFreshStepUp({
        claimId: prepared.claimId,
        account: input.account,
        target: prepared.target
      });
      if (!sameBinding(stepUp.account, input.account) || !isAccountStepUpPermitId(stepUp.permitId)
        || canonicalAccountActionTarget(stepUp.target) !== canonicalAccountActionTarget(prepared.target)) {
        throw personalError("personal_endpoint_step_up_mismatch", "The fresh account factor was not bound to this endpoint claim.");
      }
      checkpoint = Object.freeze({
        ...checkpoint,
        phase: "ready",
        permitId: stepUp.permitId,
        operationId: randomBytes(32).toString("base64url")
      });
      await this.#saveClaimCheckpoint(checkpoint);
    }
    if (!checkpoint.permitId || !checkpoint.operationId) {
      throw personalError("personal_endpoint_claim_checkpoint_invalid", "The endpoint claim checkpoint is missing its idempotent completion identity.");
    }
    if (checkpoint.phase !== "completed") {
      const endpointAuthority = new AccountEndpointAuthorityClient({
        origin: this.#accountOrigin,
        tenantId: prepared.target.tenantId,
        routeId: this.#profile.routeId,
        deviceId: this.#profile.endpointDeviceId,
        signingKey: endpointKey,
        fetch: this.#fetch
      });
      const completeBody = Object.freeze({ claimId: prepared.claimId, permitId: checkpoint.permitId, operationId: checkpoint.operationId });
      const path = ACCOUNT_API_ROUTES.deviceEndpointClaimComplete;
      const proofBody = Object.freeze({
        ...completeBody,
        endpointProof: endpointAuthority.signClaimProof({
          claimId: prepared.claimId,
          permitId: checkpoint.permitId,
          operationId: checkpoint.operationId,
          endpointPinRef,
          target: prepared.target
        })
      });
      const completeRequest = {
        ...proofBody,
        desktopProof: signDesktopAccountProof({
          pathname: path,
          account: input.account,
          credential: input.accountCredential,
          clientPublicKey: input.desktopPublicKey,
          privateKey: input.desktopPrivateKey,
          body: proofBody
        })
      };
      const completed = validateCompletedClaim(await accountPost({ origin: this.#accountOrigin, path, body: completeRequest, fetch: this.#fetch }), checkpoint);
      checkpoint = Object.freeze({ ...checkpoint, phase: "completed", completed });
      await this.#saveClaimCheckpoint(checkpoint);
    }
    const completed = checkpoint.completed;
    if (!completed) throw personalError("personal_endpoint_claim_checkpoint_invalid", "The completed account claim is missing its durable result.");
    const endpointAuthority = new AccountEndpointAuthorityClient({
      origin: this.#accountOrigin,
      tenantId: completed.tenantId,
      routeId: completed.routeId,
      deviceId: completed.endpointDeviceId,
      signingKey: endpointKey,
      fetch: this.#fetch
    });
    const managedRoute = await endpointAuthority.managedRoute();
    if (!managedRoute || managedRoute.accountId !== input.account.accountId || managedRoute.authEpoch !== input.account.authEpoch
      || managedRoute.tenantId !== completed.tenantId || managedRoute.routeId !== completed.routeId
      || managedRoute.endpointDeviceId !== completed.endpointDeviceId
      || managedRoute.endpointPublicKey !== deviceIdentity.publicKey || managedRoute.endpointPinRef !== endpointPinRef
      || managedRoute.vaultId !== completed.vaultId) {
      throw personalError("account_endpoint_claim_not_current", "The account authority has not confirmed this endpoint claim as the current route owner.");
    }
    const principalRef = `personal.${digest(`${input.account.accountId}\n${this.#profile.endpointDeviceId}`).slice(0, 32)}`;
    const record = this.#identityStore.device(this.#profile.endpointDeviceId);
    if (!record) {
      this.#identityStore.enroll({
        deviceId: this.#profile.endpointDeviceId,
        tenantId: completed.tenantId,
        routeId: completed.routeId,
        trustBinding: trustBinding({ identity: deviceIdentity, endpointPrincipalRef: principalRef, capabilityGrantRef: prepared.target.grantRef })
      });
    } else if (record.role !== "endpoint" || record.tenantId !== completed.tenantId || record.routeId !== completed.routeId
      || record.pairedIdentityKey !== deviceIdentity.publicKey || record.capabilityGrantRef !== prepared.target.grantRef) {
      throw personalError("personal_endpoint_identity_conflict", "Stored endpoint trust does not match the verified account claim.");
    }
    this.#identityStore.activateAccountEndpointClaim({
      deviceId: completed.endpointDeviceId,
      account: Object.freeze({ accountId: managedRoute.accountId, authEpoch: managedRoute.authEpoch }),
      admissionGeneration: completed.admissionGeneration,
      revocationRevision: completed.revocationRevision
    });
    await this.#options.custody.storeSecret({ ref: RELAY_SECRET_REF, secret: new TextEncoder().encode(completed.relayAdmission) });
    this.#profile = Object.freeze({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      endpointDeviceId: completed.endpointDeviceId,
      routeId: completed.routeId,
      peerStoreKey: this.#profile.peerStoreKey ?? this.#profile.routeId,
      priorAccountId: null,
      state: "enrolled",
      account: Object.freeze({ accountId: managedRoute.accountId, authEpoch: managedRoute.authEpoch }),
      tenantId: completed.tenantId,
      vaultId: completed.vaultId,
      endpointPinRef,
      endpointPrincipalRef: principalRef,
      capabilityGrantRef: prepared.target.grantRef,
      relayService: this.#relayBase.toString(),
      admissionGeneration: completed.admissionGeneration,
      revocationRevision: completed.revocationRevision,
      pendingRouteRevocationOperationId: null,
      routeRevocations: this.#profile.routeRevocations
    });
    // First enrollment creates the route-scoped Peer store only after the
    // account assigns the stable route. Bind this process to that same path
    // before the durable Signal identity is created or reloaded, so a restart
    // uses the identical pairing key and encrypted history.
    this.#peerStoreDir = join(this.#dataDir, PEER_STORE_DIR, this.#profile.peerStoreKey!);
    this.#saveProfile();
    await this.#options.custody.deleteSecret({ ref: claimSecretRef(checkpoint.routeId) });
    await this.#loadClaimedIdentity();
    await this.#ensurePeerIdentity();
    this.#emitState();
    return this.snapshot();
  }

  /** Explicit recovery after account recovery or endpoint-route revocation.
   * The old route and its Peer journal remain addressable; only a same-owner
   * fresh account claim may create a new route identity. */
  async reenrollCurrentAccount(input: PersonalEndpointEnrollmentInput): Promise<PersonalEndpointSnapshot> {
    this.#assertNotStopped();
    this.#validateEnrollmentInput(input);
    const ownerAccountId = this.#profile.account?.accountId ?? this.#profile.priorAccountId;
    if (!ownerAccountId || ownerAccountId !== input.account.accountId) {
      throw personalError("personal_endpoint_account_conflict", "A personal endpoint can only be refreshed by its original account.");
    }

    if (this.#profile.state === "unregistered") {
      return this.enrollCurrentAccount(input);
    }

    await this.#loadClaimedIdentity();
    const decision = await this.#requireCurrentEndpointBinding();
    if (decision.state === "unavailable") {
      throw personalError("account_authority_unavailable", "Account authority is temporarily unavailable; the existing endpoint identity and data were preserved.");
    }
    if (decision.state === "current" && sameBinding(this.#profile.account, input.account)) {
      if (this.#profile.state === "revoked") {
        // Recover profiles previously fenced by an ambiguous local error. The
        // authority confirms the exact original route and no key is replaced.
        this.#profile = Object.freeze({ ...this.#profile, state: "enrolled" });
        this.#saveProfile();
        this.#stopping = false;
        await this.#loadClaimedIdentity();
        await this.#ensurePeerIdentity();
        this.#emitState();
        return this.snapshot();
      }
      throw personalError("personal_endpoint_still_current", "This route is still current. No replacement identity was created.");
    }

    if (decision.state === "changed" && decision.value.accountId !== input.account.accountId) {
      throw personalError("personal_endpoint_account_conflict", "The current route belongs to a different account; this profile cannot be taken over.");
    }
    if (decision.state === "changed" && decision.value.authEpoch !== input.account.authEpoch) {
      throw personalError("account_stale", "Sign in again with the account's current session before replacing this route.");
    }
    await this.#revokeCurrentRoute(input);
    await this.#markProfileRevoked();
    const replacementRouteId = endpointIdentityId("route.personal");
    this.#profile = Object.freeze({
      ...this.#profile,
      endpointDeviceId: endpointIdentityId("dev.personal"),
      routeId: replacementRouteId,
      peerStoreKey: replacementRouteId,
      state: "unregistered",
      account: null,
      priorAccountId: ownerAccountId,
      tenantId: null,
      vaultId: null,
      endpointPinRef: null,
      endpointPrincipalRef: null,
      capabilityGrantRef: null,
      admissionGeneration: null,
      revocationRevision: null,
      pendingRouteRevocationOperationId: null,
      routeRevocations: this.#profile.routeRevocations
    });
    // The route id scopes both the Peer identity and its inbox/outbox. Keep
    // the old directory untouched so an accepted operation can never migrate.
    this.#peerStoreDir = join(this.#dataDir, PEER_STORE_DIR, this.#profile.peerStoreKey!);
    this.#peerBinding = null;
    this.#peerIdentity = null;
    this.#peerCryptoStore = null;
    this.#accountAuthority = null;
    this.#endpointKey = null;
    this.#deviceIdentity = null;
    this.#pairing = null;
    this.#stopping = false;
    this.#startedOnce = false;
    this.#saveProfile();
    this.#emitState();
    return this.enrollCurrentAccount(input);
  }

  async createPairingInvite(): Promise<PairingInvite> {
    this.#assertNotStopped();
    if (!this.#pairing || this.#profile.state !== "enrolled") {
      throw personalError("personal_endpoint_not_started", "Start the account-enrolled personal endpoint before creating a pairing invite.");
    }
    const peerBinding = this.#peerBinding;
    if (!peerBinding || !this.#endpoint?.session.acceptsNewWork) {
      throw personalError("peer_route_unavailable", "The personal endpoint has not completed Relay admission.");
    }
    await this.#onPeerSessionReady(peerBinding);
    if (this.#publishedPeerBundleFor !== peerBinding.peerId || !this.snapshot().acceptsNewWork) {
      throw personalError("peer_client_bundle_unavailable", "The personal endpoint's Signal bundle is not published yet.");
    }
    const current = await this.#requireCurrentEndpointBinding();
    if (current.state === "revoked" || current.state === "changed") {
      await this.#markProfileRevoked();
      throw personalError("personal_endpoint_not_current", "Account authority no longer recognizes this endpoint as current.");
    }
    if (current.state === "unavailable") {
      throw personalError("account_authority_unavailable", "Account authority is temporarily unavailable; the enrolled endpoint identity remains available for recovery.");
    }
    const result = await this.#pairing.issueInvite();
    const invite = parsePairingInvite(result.invite);
    if (!invite || Date.parse(invite.expiresAt) <= this.#now()) {
      throw personalError("personal_endpoint_invite_invalid", "Endpoint pairing generated a malformed or expired invite.");
    }
    if (invite.tenantId !== this.#profile.tenantId || invite.endpointRouteId !== this.#profile.routeId
      || invite.endpointDeviceId !== this.#profile.endpointDeviceId || invite.endpointPinRef !== this.#profile.endpointPinRef
      || invite.relayService !== this.#relayBase.toString()) {
      throw personalError("personal_endpoint_invite_invalid", "Endpoint pairing generated an invite outside its account-bound route.");
    }
    return invite;
  }

  async start(): Promise<PersonalEndpointSnapshot> {
    this.#assertNotStopped();
    if (this.#profile.state !== "enrolled") {
      throw personalError("personal_endpoint_not_enrolled", "Sign in and enroll this device under the personal account before hosting pairing.");
    }
    if (this.#endpoint && this.#transport) return this.snapshot();
    await this.#loadClaimedIdentity();
    const peerIdentity = await this.#ensurePeerIdentity();
    const current = await this.#requireCurrentEndpointBinding();
    if (current.state === "revoked" || current.state === "changed") {
      await this.#markProfileRevoked();
      throw personalError("personal_endpoint_not_current", "This endpoint's account-owned route has been revoked or changed.");
    }
    if (current.state === "unavailable") {
      this.#startedOnce = true;
      this.#routeState = "unreachable";
      this.#emitState();
      throw personalError("account_authority_unavailable", "Account authority could not verify this endpoint. Its identity and stored application data remain available for recovery.");
    }
    const endpointKey = this.#endpointKey!;
    const identity = this.#identityStore;
    const deviceIdentity = this.#deviceIdentity;
    if (!deviceIdentity) throw personalError("personal_endpoint_key_unavailable", "The endpoint public identity is unavailable in local custody.");
    const own = identity.device(this.#profile.endpointDeviceId);
    if (!own || own.revoked || own.role !== "endpoint" || !sameBinding(own.accountBinding, this.#profile.account)) {
      throw personalError("personal_endpoint_identity_unavailable", "The local endpoint identity is revoked or does not match the current account binding.");
    }
    const authority = this.#accountAuthority!;
    const accountPairing = new EndpointAccountPairingApplication({
      identity,
      authority,
      proof: authority,
      invite: Object.freeze({
        tenantId: this.#profile.tenantId!,
        routeId: this.#profile.routeId,
        endpointDeviceId: this.#profile.endpointDeviceId,
        endpointPinRef: this.#profile.endpointPinRef!,
        endpointSpkiPin: this.#profile.endpointPinRef!,
        endpointPrincipalRef: this.#profile.endpointPrincipalRef!,
        relayService: this.#relayBase.toString(),
        vaultId: this.#profile.vaultId!,
        mode: "personal" as const,
        recoveryAuthority: null
      }),
      availableScopes: [TRUST_SCOPE],
      endpointPeerIdentity: this.#peerIdentityDescriptor(peerIdentity),
      now: this.#now
    });
    this.#pairing = accountPairing;
    const admission: RelayAdmissionInput = Object.freeze({
      tenantId: this.#profile.tenantId!,
      routeId: this.#profile.routeId,
      deviceId: this.#profile.endpointDeviceId,
      role: "endpoint",
      mode: "personal",
      admissionGeneration: this.#profile.admissionGeneration!,
      revocationRevision: Math.max(this.#profile.revocationRevision!, identity.revocationRevision(this.#profile.tenantId!))
    });
    const transportOptions: WssRelayTransportOptions = {
      url: relaySessionUrl(this.#relayBase, this.#profile.tenantId!, this.#profile.routeId),
      headers: { authorization: `Bearer ${await this.#loadRelayAdmission()}` },
      allowInsecureLoopback: this.#relayBase.protocol === "ws:"
    };
    const transport = this.#options.createRelayTransport?.(transportOptions) ?? createWssRelayTransport(transportOptions);
    this.#transport = transport;
    let endpoint!: PrivateEndpoint;
    const endpointAuthority = Object.freeze({
      contextFor({ device }: { readonly device: EndpointDeviceRecord }) {
        return Object.freeze({
          tenant: device.tenantId,
          principal: device.principalRef,
          authGeneration: String(device.trustGeneration),
          grant: Object.freeze({ revision: String(device.admissionGeneration), routes: Object.freeze([TRUST_SCOPE]) }),
          metadata: Object.freeze({
            accountId: device.accountBinding?.accountId ?? "",
            authEpoch: device.accountBinding?.authEpoch ?? 0,
            deviceId: device.deviceId
          })
        });
      }
    });
    endpoint = createPrivateGatewayEndpoint({
      gateway: disabledGateway(),
      identity,
      authority: endpointAuthority,
      recoverySigner: createRecoverySigner(endpointKey),
      accountPairing,
      transport,
      admission,
      innerTls: { key: endpointKey.export({ format: "pem", type: "pkcs8" }), cert: this.#issueEndpointCertificate(deviceIdentity).certPem },
      onInnerChannel: (channel, peer) => this.#attachPairingDispatch(endpoint, authority, channel, peer)
    });
    this.#endpoint = endpoint;
    const peerRoute: PeerRouteIdentity = Object.freeze({ tenantId: admission.tenantId, routeId: admission.routeId, deviceId: admission.deviceId });
    const peer = await this.#createPeerClient(peerRoute, transport);
    this.#peerBinding = peer;
    if (this.#inboundHandlers.size > 0) this.#attachPeerDispatch(peer.client);
    this.#startedOnce = true;
    const isCurrentTransport = (): boolean => !this.#stopping && this.#transport === transport;
    transport.handlers.onMessage = (message) => {
      if (!isCurrentTransport()) return;
      const currentEndpoint = this.#endpoint;
      const binding = this.#peerBinding;
      if (!currentEndpoint || !binding) return;
      const kind = isRecord(message) ? message.kind : undefined;
      const sessionState = currentEndpoint.session.state;
      const sessionId = currentEndpoint.session.sessionId;
      const rejected = kind === "session-rejected" ? parseSessionRejected(message) : null;
      const closed = kind === "session-close" ? parseSessionClose(message) : null;
      const currentRejection = rejected !== null && (sessionState === "open_sent" || sessionState === "reconnecting");
      const currentClose = closed !== null && closed.sessionId === sessionId
        && (sessionState === "admitted" || sessionState === "streaming" || sessionState === "closing");
      const retryableRejection = currentRejection && rejected?.retryable === true;
      const recoverableClose = currentClose && (closed?.reason === "capacity_exceeded" || closed?.reason === "idle_timeout");
      const currentAdmission = kind === "session-admitted" && (sessionState === "open_sent" || sessionState === "reconnecting");
      const currentRestore = kind === "session-restored" && sessionState === "reconnecting";
      // Terminal messages from an older session must never close the current
      // generation. The transport also fences stale socket callbacks; this
      // exact session/state check protects the host boundary independently.
      if ((kind === "session-rejected" && !currentRejection) || (kind === "session-close" && !currentClose)) return;
      if (isPeerSchemaMessage(message)) {
        if (sessionState !== "closed" && sessionState !== "rejected") binding.client.handleInboundMessage(message);
        return;
      }
      if (currentRejection || currentClose) binding.client.transportLost();
      if (retryableRejection || recoverableClose) {
        // These server terminal messages are followed by a WebSocket close.
        // Preserve the session cursors and let that real close event use the
        // existing reconnect path instead of permanently terminating WSS.
        currentEndpoint.session.transportLost();
      } else {
        currentEndpoint.handleRelayMessage(message);
      }
      if ((currentAdmission || currentRestore)
        && (currentEndpoint.session.state === "admitted" || currentEndpoint.session.state === "streaming")) {
        this.#reconnectAttempt = 0;
        void this.#onPeerSessionReady(binding).catch(() => {});
      }
      const state = currentEndpoint?.session.state;
      this.#routeState = currentEndpoint && (state === "admitted" || state === "streaming")
        ? currentEndpoint.session.routeState
        : "unreachable";
      this.#emitState();
    };
    transport.handlers.onSocketClose = () => {
      if (!isCurrentTransport()) return;
      this.#peerBinding?.client.transportLost();
      this.#endpoint?.session.transportLost();
      this.#routeState = "unreachable";
      this.#emitState();
      if (this.#endpoint?.session.state !== "rejected") this.#scheduleReconnect();
    };
    transport.handlers.onSocketOpen = () => {
      if (!isCurrentTransport()) return;
      this.#routeState = "connecting";
      const currentEndpoint = this.#endpoint;
      if (currentEndpoint?.session.state === "initiated") currentEndpoint.open();
      else if (currentEndpoint?.session.state === "closed" && currentEndpoint.session.sessionId) currentEndpoint.reconnect();
      this.#emitState();
    };
    transport.handlers.onProtocolError = () => {
      if (!isCurrentTransport()) return;
      this.#routeState = "unreachable";
      this.#emitState();
    };
    this.#connecting = true;
    try {
      await transport.ready;
    } catch (error) {
      this.#connecting = false;
      endpoint.session.transportLost();
      this.#routeState = "unreachable";
      this.#startedOnce = true;
      this.#emitState();
      this.#scheduleReconnect();
      throw error;
    }
    this.#connecting = false;
    if (endpoint.session.state === "initiated") endpoint.open();
    this.#routeState = endpoint.session.acceptsNewWork ? endpoint.session.routeState : "unreachable";
    this.#emitState();
    return this.snapshot();
  }

  snapshot(): PersonalEndpointSnapshot {
    const endpoint = this.endpointIdentity;
    const relayState = this.#transport === null
      ? "idle"
      : this.#transport.readyState === 1 ? "open"
        : this.#transport.readyState === 0 ? "connecting" : "closed";
    const acceptsNewWork = Boolean(this.#endpoint?.session.acceptsNewWork && relayState === "open"
      && this.#profile.state === "enrolled" && this.#routeState === "reachable"
      && this.#peerBinding && this.#publishedPeerBundleFor === this.#peerBinding.peerId);
    const state: PersonalEndpointSnapshot["state"] = this.#profile.state === "revoked"
      ? "revoked"
      : this.#profile.state === "unregistered"
        ? "unregistered"
        : this.#connecting
          ? "connecting"
          : acceptsNewWork
            ? "connected"
            : this.#startedOnce
              ? "unreachable"
              : "enrolled";
    return Object.freeze({
      state,
      account: this.#profile.account ? Object.freeze({ ...this.#profile.account }) : null,
      endpoint,
      peerId: this.#peerBinding?.peerId ?? null,
      relayState,
      routeState: this.#routeState,
      acceptsNewWork,
      routeRevocations: Object.freeze(this.#profile.routeRevocations.map((result) => Object.freeze({ ...result })))
    });
  }

  onInboundMessage(handler: PersonalEndpointInboundHandler): () => void {
    if (typeof handler !== "function") throw personalError("personal_endpoint_handler_invalid", "Peer inbound handler must be a function.");
    this.#inboundHandlers.add(handler);
    const binding = this.#peerBinding;
    if (binding) {
      this.#attachPeerDispatch(binding.client);
      void binding.client.retryPendingDispatch().catch(() => {});
    }
    return () => {
      this.#inboundHandlers.delete(handler);
      if (this.#inboundHandlers.size === 0) this.#peerBinding?.client.clearInboundMessageHandler();
    };
  }

  async sendMessage(peerDeviceId: string, plaintext: Uint8Array, options: { readonly messageId?: string } = {}) {
    await this.#assertReachablePeer(peerDeviceId);
    if (!this.#peerBinding) throw personalError("personal_endpoint_not_started", "Personal endpoint PeerClient is not running.");
    return this.#peerBinding.client.sendMessage(peerDeviceId, plaintext, options);
  }

  async isPeerReachable(peerDeviceId: string): Promise<boolean> {
    try {
      await this.#assertReachablePeer(peerDeviceId);
      return true;
    } catch {
      return false;
    }
  }

  async listPairedEntryDevices(): Promise<readonly PersonalEndpointEntryDevice[]> {
    if (!this.#profile.account || !this.#profile.tenantId) return Object.freeze([]);
    const devices = this.#identityStore.devices().filter((device) => device.role === "entry" && !device.revoked
      && device.tenantId === this.#profile.tenantId && device.routeId === this.#profile.routeId
      && sameBinding(device.accountBinding, this.#profile.account));
    const current = await Promise.all(devices.map(async (device) => {
      const decision = await this.#currentEntryAuthorization(device);
      return decision.state === "current" ? device : null;
    }));
    return Object.freeze(current.filter((device): device is EndpointDeviceRecord => device !== null)
      .map((device) => Object.freeze({ deviceId: device.deviceId, displayLabel: null })));
  }

  async resolvePairedPeerIdentity(peerDeviceId: string): Promise<PairingPeerIdentity | null> {
    const entry = this.#identityStore.device(peerDeviceId);
    if (!entry || entry.role !== "entry" || entry.revoked || !sameBinding(entry.accountBinding, this.#profile.account)
      || entry.tenantId !== this.#profile.tenantId || entry.routeId !== this.#profile.routeId || !entry.entryPeerIdentity) return null;
    return Object.freeze({ ...entry.entryPeerIdentity });
  }

  /** Resolve fresh source authority for this exact route address; it does not depend on relay reachability. */
  async resolvePeerAuthority(address: PersonalEndpointPeerRoute): Promise<PersonalEndpointAuthorityDecision> {
    if (address.tenantId !== this.#profile.tenantId || address.routeId !== this.#profile.routeId
      || address.localDeviceId !== this.#profile.endpointDeviceId || !opaque(address.peerDeviceId)) return "revoked";
    const entry = this.#identityStore.device(address.peerDeviceId);
    if (!entry || entry.role !== "entry" || entry.revoked || !sameBinding(entry.accountBinding, this.#profile.account)
      || entry.tenantId !== address.tenantId || entry.routeId !== address.routeId) return "revoked";
    const decision = await this.#currentEntryAuthorization(entry);
    return decision.state === "current" ? "current" : decision.state === "unavailable" ? "unavailable" : "revoked";
  }

  /** A trust anchor for the PeerClient's signed Signal-identity binding. */
  async getPeerTrustAnchor(peerDeviceId: string): Promise<{ readonly deviceId: string; readonly publicKey: string; readonly account: AccountAuthorityBinding } | null> {
    const entry = this.#identityStore.device(peerDeviceId);
    if (!entry || entry.role !== "entry" || entry.revoked || !sameBinding(entry.accountBinding, this.#profile.account)) return null;
    const current = await this.#currentEntryAuthorization(entry);
    if (current.state !== "current") return null;
    return Object.freeze({ deviceId: entry.deviceId, publicKey: entry.pairedIdentityKey, account: Object.freeze({ ...entry.accountBinding! }) });
  }

  async stop(): Promise<void> {
    await this.#closeActiveConnection("reconnect");
    this.#emitState();
  }

  async #closeActiveConnection(reason: "reconnect" | "revoked"): Promise<void> {
    if (this.#stopping) return this.#closeWork ?? undefined;
    this.#stopping = true;
    this.#closeWork = this.#drainActiveConnection(reason);
    await this.#closeWork;
  }

  async #drainActiveConnection(reason: "reconnect" | "revoked"): Promise<void> {
    const client = this.#peerBinding?.client;
    const admissionWork = client ? this.#peerAdmissionWork.get(client) : undefined;
    if (this.#reconnectTimer !== undefined) {
      this.#cancelSchedule(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    for (const loop of this.#innerLoops) loop.close();
    this.#innerLoops.clear();
    try { this.#endpoint?.close(reason); } catch { /* the transport may already be gone */ }
    this.#transport?.close();
    await client?.dispose();
    this.#endpoint = null;
    this.#transport = null;
    this.#peerBinding = null;
    this.#routeState = "unreachable";
    this.#connecting = false;
    await admissionWork?.catch(() => {});
  }

  async #ensurePeerIdentity(): Promise<PeerIdentity> {
    if (this.#peerIdentity) return this.#peerIdentity;
    if (this.#profile.state !== "enrolled" || !this.#profile.tenantId) {
      throw personalError("personal_endpoint_not_enrolled", "A stable account route is required before creating the Peer identity.");
    }
    const route: PeerRouteIdentity = Object.freeze({
      tenantId: this.#profile.tenantId,
      routeId: this.#profile.routeId,
      deviceId: this.#profile.endpointDeviceId
    });
    const peerId = peerIdForRouteDevice(route);
    if (!peerId) throw personalError("peer_identity_invalid", "Account-assigned route identifiers cannot derive a safe peer identity.");
    mkdirSync(this.#peerStoreDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#peerStoreDir, 0o700);
    const store = this.#peerCryptoStore ?? createFilePeerCryptoStore(join(this.#peerStoreDir, "crypto"));
    let identity = await loadPeerIdentity(store);
    if (!identity) {
      const hasPairedDevices = this.#identityStore.devices().some((device) => device.role === "entry"
        && device.tenantId === this.#profile.tenantId && device.routeId === this.#profile.routeId);
      if (hasPairedDevices) {
        throw personalError("peer_identity_missing", "This route has paired devices but its retained Peer identity is missing; preserve the existing Peer data before recovery.");
      }
      identity = await createPeerIdentity({ localStore: store, peerId });
    } else if (identity.peerId !== peerId) {
      throw personalError("peer_identity_invalid", "Durable Peer identity does not match this account route.");
    }
    this.#peerCryptoStore = store;
    this.#peerIdentity = identity;
    return identity;
  }

  #peerIdentityDescriptor(identity: PeerIdentity): PairingPeerIdentity {
    return Object.freeze({
      peerId: identity.peerId,
      signalDeviceId: identity.deviceId,
      registrationId: identity.registrationId,
      identityKey: Buffer.from(identity.publicKey.serialize()).toString("base64url")
    });
  }

  async #loadClaimedIdentity(): Promise<void> {
    if ((this.#profile.state !== "enrolled" && this.#profile.state !== "revoked") || !this.#profile.account || !this.#profile.tenantId
      || !this.#profile.endpointPinRef || !this.#profile.endpointPrincipalRef || !this.#profile.capabilityGrantRef) return;
    const identity = await deviceIdentityFromCustody({
      custody: this.#options.custody,
      deviceId: this.#profile.endpointDeviceId,
      refPrefix: DEVICE_CUSTODY_PREFIX
    });
    const key = await loadDevicePrivateKey({
      custody: this.#options.custody,
      deviceId: this.#profile.endpointDeviceId,
      refPrefix: DEVICE_CUSTODY_PREFIX
    });
    if (!identity || !key) throw personalError("personal_endpoint_key_unavailable", "The enrolled endpoint key is missing from local custody.");
    this.#endpointKey = key;
    this.#deviceIdentity = identity;
    const certificate = this.#issueEndpointCertificate(identity);
    if (certificate.spkiPin !== this.#profile.endpointPinRef) {
      throw personalError("personal_endpoint_pin_mismatch", "The local endpoint key no longer matches its account-registered TLS pin.");
    }
    this.#accountAuthority = new AccountEndpointAuthorityClient({
      origin: this.#accountOrigin,
      tenantId: this.#profile.tenantId,
      routeId: this.#profile.routeId,
      deviceId: this.#profile.endpointDeviceId,
      signingKey: key,
      fetch: this.#fetch
    });
    void certificate;
  }

  #issueEndpointCertificate(identity: DeviceIdentity): ReturnType<typeof issueDeviceCertificate> {
    const key = this.#endpointKey;
    if (!key) throw personalError("personal_endpoint_key_unavailable", "The endpoint key is unavailable for its pinned TLS channel.");
    return issueDeviceCertificate({
      publicKeyRaw: Buffer.from(identity.publicKey, "base64url"),
      sign: custodyDeviceSigner(key),
      subject: `meshrix-personal-endpoint ${identity.deviceId}`,
      notBefore: new Date(this.#now())
    });
  }

  async #createPeerClient(route: PeerRouteIdentity, transport: WssRelayTransport): Promise<PeerClientBinding> {
    const identity = await this.#ensurePeerIdentity();
    const peerId = identity.peerId;
    const store = this.#peerCryptoStore!;
    const clientStore = createFilePeerClientStore(join(this.#peerStoreDir, "client"));
    const channel: PeerClientTransport = createPeerSessionChannel({
      send: (message) => transport.send(message),
      admitted: () => this.#endpoint?.session.acceptsNewWork === true && transport.readyState === 1
    });
    const client = new PeerClient({
      identity,
      cryptoStore: store,
      clientStore,
      transport: channel,
      route,
      directory: Object.freeze({
        resolvePeerIdentity: (peerDeviceId: string) => this.resolvePairedPeerIdentity(peerDeviceId)
      })
    });
    return Object.freeze({ client, identity, store, route, peerId });
  }

  #onPeerSessionReady(binding: PeerClientBinding): Promise<void> {
    const current = this.#peerAdmissionWork.get(binding.client);
    if (current) return current;
    const work = this.#finishPeerAdmission(binding).finally(() => {
      if (this.#peerAdmissionWork.get(binding.client) === work) this.#peerAdmissionWork.delete(binding.client);
    });
    this.#peerAdmissionWork.set(binding.client, work);
    return work;
  }

  async #finishPeerAdmission(binding: PeerClientBinding): Promise<void> {
    if (!this.#isPeerSessionReady(binding.client)) return;
    try {
      await this.#publishPeerBundle(binding);
    } catch {
      // A later session restore retries the same stable identity. Do not
      // expose this endpoint as ready or consume key-dependent queued work.
      // If WSS remains live, the shared recovery scheduler retries publication
      // directly instead of waiting for a restore event that may never arrive.
      if (this.#isPeerSessionReady(binding.client)) this.#scheduleReconnect();
      this.#emitState();
      return;
    }
    if (!this.#isPeerSessionReady(binding.client)) return;
    try {
      await binding.client.resume();
      await binding.client.retryPendingDispatch();
    } catch {
      // The durable PeerClient journal and the next restore own recovery.
    }
    if (!this.#isPeerSessionReady(binding.client)) return;
    this.#routeState = this.#endpoint!.session.routeState;
    this.#emitState();
  }

  #isPeerSessionReady(client: PeerClient): boolean {
    return !this.#stopping && this.#profile.state === "enrolled"
      && this.#peerBinding?.client === client
      && this.#endpoint?.session.acceptsNewWork === true
      && this.#transport?.readyState === 1;
  }

  async #publishPeerBundle(binding: PeerClientBinding): Promise<void> {
    if (this.#publishedPeerBundleFor === binding.peerId) return;
    const existing = this.#peerBundlePublication;
    if (existing?.peerId === binding.peerId) return existing.promise;
    const promise = binding.client.publishBundle().then(() => {
      this.#publishedPeerBundleFor = binding.peerId;
    }).finally(() => {
      if (this.#peerBundlePublication?.promise === promise) this.#peerBundlePublication = null;
    });
    this.#peerBundlePublication = Object.freeze({ peerId: binding.peerId, promise });
    return promise;
  }

  #attachPeerDispatch(client: PeerClient): void {
    const dispatch: PeerDispatchHandler = (message) => this.#dispatchInbound(message);
    client.onInboundMessage(dispatch);
  }

  async #dispatchInbound(message: PeerInboundMessage): Promise<PeerInboundOutcome> {
    const sender = this.#identityStore.device(message.senderDeviceId);
    if (!sender || sender.role !== "entry" || sender.revoked || !sameBinding(sender.accountBinding, this.#profile.account)
      || sender.tenantId !== this.#profile.tenantId || sender.routeId !== this.#profile.routeId) {
      return { kind: "rejected" };
    }
    const route = Object.freeze({
      tenantId: sender.tenantId,
      routeId: sender.routeId,
      localDeviceId: this.#profile.endpointDeviceId,
      peerDeviceId: sender.deviceId
    });
    // Fresh source authority is resolved by the application admission port
    // before journal reservation or ACP. Keeping this transport dispatch
    // local-only avoids an extra account request per Signal inbox delivery.
    if (this.#inboundHandlers.size === 0) return { kind: "deferred" };
    let result: PeerInboundOutcome = "accepted_by_agent";
    for (const handler of [...this.#inboundHandlers]) {
      result = await handler(Object.freeze({ address: route, message }));
      if (typeof result === "object" && result.kind === "rejected") return result;
    }
    return result;
  }

  async #revokeCurrentRoute(input: PersonalEndpointEnrollmentInput): Promise<AccountDeviceRevokeResponse> {
    const tenantId = this.#profile.tenantId;
    const routeId = this.#profile.routeId;
    const deviceId = this.#profile.endpointDeviceId;
    if (!tenantId || !this.#profile.account) {
      throw personalError("personal_endpoint_reenrollment_invalid", "The retained route identity is incomplete; no replacement route was created.");
    }
    const operationId = this.#profile.pendingRouteRevocationOperationId ?? randomBytes(32).toString("base64url");
    if (!this.#profile.pendingRouteRevocationOperationId) {
      this.#profile = Object.freeze({ ...this.#profile, pendingRouteRevocationOperationId: operationId });
      this.#saveProfile();
    }
    const path = ACCOUNT_API_ROUTES.deviceRevoke;
    const body = Object.freeze({ operationId, tenantId, routeId, deviceId });
    const desktopProof = signDesktopAccountProof({
      pathname: path,
      account: input.account,
      credential: input.accountCredential,
      clientPublicKey: input.desktopPublicKey,
      privateKey: input.desktopPrivateKey,
      body
    });
    const response = await accountPost({
      origin: this.#accountOrigin,
      path,
      body: { ...body, desktopProof },
      fetch: this.#fetch
    });
    if (!isAccountDeviceRevokeResponse(response) || response.operationId !== operationId || response.target !== "route"
      || response.tenantId !== tenantId || response.routeId !== routeId || response.deviceId !== deviceId) {
      throw personalError("account_route_revocation_invalid", "Account authority did not confirm the exact route fence; no replacement route was created.");
    }
    const prior = this.#profile.routeRevocations.filter((item) => item.operationId !== operationId);
    this.#profile = Object.freeze({
      ...this.#profile,
      pendingRouteRevocationOperationId: null,
      routeRevocations: Object.freeze([...prior, Object.freeze({ ...response })])
    });
    this.#saveProfile();
    return response;
  }

  async #assertReachablePeer(peerDeviceId: string): Promise<EndpointDeviceRecord> {
    if (!opaque(peerDeviceId) || !this.#endpoint || !this.#transport || !this.#accountAuthority
      || this.#profile.state !== "enrolled" || !this.#endpoint.session.acceptsNewWork
      || this.#transport.readyState !== 1 || this.#routeState !== "reachable") {
      throw personalError("endpoint_unreachable", "The personal endpoint route is not currently available for new work.");
    }
    const entry = this.#identityStore.device(peerDeviceId);
    if (!entry || entry.role !== "entry" || entry.revoked || !sameBinding(entry.accountBinding, this.#profile.account)
      || entry.tenantId !== this.#profile.tenantId || entry.routeId !== this.#profile.routeId) {
      throw personalError("account_device_revoked", "This device is not paired to the current personal route.");
    }
    const authorization = await this.#currentEntryAuthorization(entry);
    if (authorization.state === "revoked") {
      throw personalError("account_device_revoked", "The current account authority does not authorize this paired device.");
    }
    if (authorization.state === "unavailable") {
      throw personalError("account_authority_unavailable", "Account authority is temporarily unavailable; no new work was accepted for delivery.");
    }
    const presence = this.#peerBinding?.client.presence(peerDeviceId) ?? null;
    if (!presence || presence.tenantId !== entry.tenantId || presence.routeId !== entry.routeId
      || presence.deviceId !== this.#profile.endpointDeviceId || presence.peerDeviceId !== entry.deviceId
      || presence.state !== "reachable") {
      throw personalError("endpoint_unreachable", "The paired device is not currently reachable; the new operation was not accepted.");
    }
    return entry;
  }

  async #currentEntryAuthorization(entry: EndpointDeviceRecord): Promise<AuthorityDecision<AccountDeviceCurrentBindingResponse>> {
    const binding = entry.accountBinding;
    const authority = this.#accountAuthority;
    if (!binding || !authority || entry.revoked) return { state: "revoked" };
    try {
      const response = await authority.currentDeviceAuthorization(entry.deviceId);
      if (!response) return { state: "unavailable" };
      return accountDeviceAuthorizationMatches({ response, binding, device: entry, scope: TRUST_SCOPE })
        ? { state: "current", value: response }
        : { state: "revoked" };
    } catch (error) {
      const code = authorityErrorCode(error);
      return code === "not_found" || code === "forbidden" ? { state: "revoked" } : { state: "unavailable" };
    }
  }

  async #requireCurrentEndpointBinding(): Promise<AuthorityDecision<AccountManagedRouteBinding>> {
    const authority = this.#accountAuthority;
    const profile = this.#profile;
    if (!authority || (profile.state !== "enrolled" && profile.state !== "revoked") || !profile.account) return { state: "revoked" };
    try {
      const route = await authority.managedRoute();
      if (!route) return { state: "unavailable" };
      const identityMatches = route.accountId === profile.account.accountId
        && route.tenantId === profile.tenantId && route.routeId === profile.routeId
        && route.endpointDeviceId === profile.endpointDeviceId && route.endpointPinRef === profile.endpointPinRef
        && route.vaultId === profile.vaultId;
      if (!identityMatches) return { state: "revoked" };
      return route.authEpoch === profile.account.authEpoch
        ? { state: "current", value: route }
        : { state: "changed", value: route };
    } catch (error) {
      return authorityErrorCode(error) === "not_found" ? { state: "revoked" } : { state: "unavailable" };
    }
  }

  async #loadRelayAdmission(): Promise<string> {
    const bytes = await this.#options.custody.loadSecret({ ref: RELAY_SECRET_REF });
    if (!bytes) throw personalError("personal_endpoint_credential_unavailable", "The Relay admission credential is missing from local custody.");
    let credential: string;
    try { credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
      throw personalError("personal_endpoint_credential_invalid", "The Relay admission credential in local custody is malformed.");
    }
    if (!RELAY_CREDENTIAL.test(credential)) throw personalError("personal_endpoint_credential_invalid", "The Relay admission credential in local custody is invalid.");
    return credential;
  }

  async #loadClaimCheckpoint(): Promise<ClaimCheckpoint | null> {
    const bytes = await this.#options.custody.loadSecret({ ref: claimSecretRef(this.#profile.routeId) });
    if (!bytes) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(value) || value.schemaVersion !== 1 || !["prepared", "ready", "completed"].includes(String(value.phase))
        || !accountBinding(value.account) || !opaque(value.desktopDeviceId) || typeof value.desktopPublicKey !== "string"
        || !opaque(value.routeId) || !opaque(value.endpointDeviceId) || typeof value.endpointPublicKey !== "string"
        || typeof value.endpointPinRef !== "string" || !isRecord(value.prepared)
        || value.phase !== "prepared" && !isAccountStepUpPermitId(value.permitId)) throw new Error("invalid");
      return value as unknown as ClaimCheckpoint;
    } catch {
      throw personalError("personal_endpoint_claim_checkpoint_invalid", "The protected pending endpoint claim is malformed; no identity or application history was changed.");
    }
  }

  async #saveClaimCheckpoint(checkpoint: ClaimCheckpoint): Promise<void> {
    await this.#options.custody.storeSecret({
      ref: claimSecretRef(checkpoint.routeId),
      secret: new TextEncoder().encode(JSON.stringify(checkpoint))
    });
  }

  #saveProfile(): void {
    saveOwnerOnly(this.#profilePath, `${JSON.stringify(this.#profile)}\n`);
  }

  #validateEnrollmentInput(input: PersonalEndpointEnrollmentInput): void {
    if (!accountBinding(input.account) || !TOKEN.test(input.accountCredential)
      || !opaque(input.desktopDeviceId) || typeof input.desktopPublicKey !== "string"
      || typeof input.requestFreshStepUp !== "function") {
      throw personalError("personal_endpoint_enrollment_invalid", "A current account session and desktop device identity are required.");
    }
    this.#assertDesktopKey(input.desktopPublicKey, input.desktopPrivateKey);
  }

  async #markProfileRevoked(): Promise<void> {
    if (this.#profile.state !== "revoked") {
      this.#profile = Object.freeze({ ...this.#profile, state: "revoked" });
      this.#saveProfile();
    }
    await this.#closeActiveConnection("revoked");
    this.#routeState = "unreachable";
    this.#emitState();
  }

  #attachPairingDispatch(endpoint: PrivateEndpoint, _authority: AccountEndpointAuthorityClient, channel: InnerTlsChannel, peer: {
    readonly peerSessionId: string;
    readonly peerSpki: string;
    readonly pairingOnly: boolean;
    readonly device?: EndpointDeviceRecord;
  }): void {
    const loop = createInnerDispatchLoop({
      socket: channel.socket,
      async dispatch(message) {
        if (typeof message.method !== "string" || !message.method.startsWith("meshrix/pairing/")) {
          return Object.freeze({
            kind: "failure",
            origin: "policy",
            code: "personal_endpoint_gateway_disabled",
            message: "This personal endpoint accepts only account pairing control over its TLS control channel.",
            status: 403,
            effectOutcome: "not_started"
          });
        }
        return endpoint.dispatchAccountMessage({
          peerSessionId: peer.peerSessionId,
          pairingOnly: peer.pairingOnly,
          ...(peer.device ? { device: peer.device } : {}),
          message
        });
      }
    });
    this.#innerLoops.add(loop);
    channel.socket.once("close", () => this.#innerLoops.delete(loop));
  }

  #scheduleReconnect(): void {
    if (this.#stopping || !this.#transport || this.#reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** Math.min(this.#reconnectAttempt, 16));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#schedule(() => {
      this.#reconnectTimer = undefined;
      const binding = this.#peerBinding;
      if (binding && this.#isPeerSessionReady(binding.client)) {
        if (this.#publishedPeerBundleFor !== binding.peerId) {
          void this.#onPeerSessionReady(binding).catch(() => {});
        }
        return;
      }
      void this.#reconnect();
    }, delay);
    if (this.#reconnectTimer && typeof this.#reconnectTimer === "object" && "unref" in this.#reconnectTimer) {
      (this.#reconnectTimer as NodeJS.Timeout).unref();
    }
  }

  async #reconnect(): Promise<void> {
    if (this.#stopping || !this.#transport || !this.#endpoint) return;
    this.#connecting = true;
    this.#emitState();
    try {
      await this.#transport.reopen();
      if (this.#stopping) return;
      this.#routeState = "connecting";
      if (this.#endpoint.session.state === "closed" && this.#endpoint.session.sessionId) {
        this.#endpoint.reconnect();
      } else if (this.#endpoint.session.state === "closed") {
        // A never-admitted session has no cursor to restore. The same endpoint
        // identity and admission are re-used; durable peer stores are untouched.
        this.#endpoint = createPrivateGatewayEndpoint({
          gateway: disabledGateway(),
          identity: this.#identityStore,
          authority: { contextFor: ({ device }) => Object.freeze({
            tenant: device.tenantId,
            principal: device.principalRef,
            authGeneration: String(device.trustGeneration),
            grant: Object.freeze({ revision: String(device.admissionGeneration), routes: Object.freeze([TRUST_SCOPE]) })
          }) },
          recoverySigner: createRecoverySigner(this.#endpointKey!),
          ...(this.#pairing ? { accountPairing: this.#pairing } : {}),
          transport: this.#transport,
          admission: {
            tenantId: this.#profile.tenantId!, routeId: this.#profile.routeId, deviceId: this.#profile.endpointDeviceId,
            role: "endpoint", mode: "personal", admissionGeneration: this.#profile.admissionGeneration!,
            revocationRevision: this.#profile.revocationRevision!
          },
          innerTls: { key: this.#endpointKey!.export({ format: "pem", type: "pkcs8" }), cert: this.#issueEndpointCertificate(this.#deviceIdentity!).certPem },
          onInnerChannel: (channel, binding) => this.#attachPairingDispatch(this.#endpoint!, this.#accountAuthority!, channel, binding)
        });
        this.#endpoint.open();
      }
      this.#routeState = "unreachable";
      this.#connecting = false;
      this.#emitState();
    } catch {
      this.#connecting = false;
      this.#routeState = "unreachable";
      this.#emitState();
      this.#scheduleReconnect();
    }
  }

  #assertDesktopKey(desktopPublicKey: string, privateKey: KeyObject): void {
    if (!privateKey || privateKey.asymmetricKeyType !== "ed25519") {
      throw personalError("account_desktop_key_invalid", "Desktop account proofs require an Ed25519 identity.");
    }
    const actual = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    if (actual !== desktopPublicKey) throw personalError("account_desktop_key_mismatch", "The desktop public key does not match its custodied signing key.");
  }

  #emitState(): void {
    this.#options.onState?.(this.snapshot());
  }

  #assertNotStopped(): void {
    if (this.#stopping) throw personalError("personal_endpoint_stopped", "The personal endpoint runtime has stopped.");
  }
}

