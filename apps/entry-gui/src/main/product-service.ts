/**
 * Entry product service — the trusted main-process composition root.
 *
 * Owns everything the renderer must never hold: the custody adapter, device
 * private keys, relay bearer credentials, recovery material, TLS material and
 * live session objects. The renderer receives only the redacted `GuiState`
 * snapshot produced by `EntryGuiModel`; every emission passes the
 * secret-free scan inside `snapshot()`.
 *
 * Flows composed here:
 *   pairing invite → PairingSession (fresh custody device) → fingerprint
 *     confirm → enrolled connection → relay credential custody → session
 *   recovery setup → one generated key → one-shot reveal → derived material
 *     custody → first encrypted snapshot publish
 *   fresh-install recovery → recovery text → endpoint-issued recovery access
 *     (fresh relay device) → vault fetch/decrypt → recover_device session →
 *     fresh device + mTLS rebind
 *   rotation → staged candidate → per-endpoint begin messages over the
 *     recovery channel → pending/ack projection — never claims completion
 *     while an endpoint is pending
 *   MCP setup → stdio snippet (preferred: no listener) + loopback-HTTP notes
 *   revoke → custody refs + owned config removed; remote state reported
 *     honestly (pending vs applied)
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import {
  ACCOUNT_API_ROUTES,
  accountDeviceAuthorityTranscript,
  canonicalAccountActionTarget,
  canonicalAccountVaultWriterRotationInput,
  isAccountStepUpPermitId,
  isPairingPeerIdentity,
  type AccountDeviceAuthorityProof,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountDesktopSessionProof,
  type AccountDesktopPairingBootstrapRequest,
  type AccountDesktopVaultWriterRotationPrepareResponse,
  type AccountDesktopVaultWriterRotationCompleteRequest,
  type AccountDesktopVaultWriterRotationPrepareRequest,
  type AccountDesktopTransactionPollResponse,
  type PairingPeerIdentity
} from "@meshrix/contracts/account";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { parseSessionClose, parseSessionRejected } from "@meshrix/contracts/private-relay";
import { AccountDeviceAuthorizationClient } from "@meshrix/gateway/private-endpoint";

import {
  FetchVaultTransport,
  InMemorySnapshotJournal,
  RecoveryRotationManager,
  createEntryRecoveryService,
  createPairingSession,
  createRecoveryVaultClient,
  createSnapshotSynchronizer,
  deleteDeviceKey,
  deriveRecoveryMaterial,
  deviceIdentityFromCustody,
  encodePairingInvite,
  enrollDeviceIdentity,
  entryError,
  formatRecoveryText,
  generateRecoveryKey,
  isEntryError,
  inviteToTrustBinding,
  loadDevicePrivateKey,
  parsePairingInvite,
  parsePairingInviteText,
  parseRecoveryText,
  rawPublicKeyBase64Url,
  selectCustodyAdapter,
  signEd25519,
  buildEntryRecoveryBundle,
  type FetchOutcome,
  type BundleConnection,
  type CustodyAdapter,
  type CustodyPlatform,
  type EntryRecoveryBundle,
  type PairingActionAuthorization,
  type PairingCompletionReceipt,
  type PairingCompletionRequest,
  type PairingEndpointPort,
  type EnrolledDeviceRecord,
  type PairingInvite,
  type PairingSession,
  type DeviceIdentity,
  type PairingState,
  type RecoveryMaterial,
  type RecoveryRotation,
  type RotationDurablePort,
  type SnapshotJournal,
  type SnapshotJournalPort,
  type VaultTransport
} from "@meshrix/entry";
import {
  EntryPairingRelayChannel,
  EntryPairingCompletionRelayChannel,
  EntryRelaySession,
  createEntryMcpBridge,
  createEntryRecoveryChannel,
  createWssRelayTransport,
  isPeerSchemaMessage,
  peerIdForRouteDevice,
  type EntryMcpBridge,
  type EntryRecoveryChannelOptions,
  type EntryRecoveryRoundTripPort,
  type EntrySessionOptions,
  type PairingRelayBootstrap,
  type EntryPairingCompletionRelayChannelOptions
} from "@meshrix/entry-transport";
import type { RelayAdmissionInput, RelayTransportPort } from "@meshrix/gateway/private-endpoint";

import { EntryGuiModel, restoreGuiState, type GuiEvent } from "../shared/gui-model.ts";
import type {
  GuiConnectionView,
  GuiApplicationView,
  GuiPersonalEndpointView,
  GuiInviteSummary,
  GuiPairingPhase,
  GuiRecoveryView,
  GuiRouteState,
  GuiState
} from "../shared/gui-state.ts";
import type { GuiIpcResult, GuiOp } from "../shared/ipc-contract.ts";
import {
  EntryConfigStore,
  type StoredConnection,
  type StoredRecovery,
  type StoredRotation,
  type StoredSnapshotJournal,
  type StoredVaultWriterOperation
} from "./config-store.ts";
import {
  custodyDeviceSigner,
  issueDeviceCertificate
} from "./device-cert.ts";
import { HttpPairingChannel } from "./pairing-channel.ts";
import { buildMcpStdioSnippet, managedMcpConfigPath, writeManagedMcpConfig } from "./mcp-config.ts";
import { ownedPathsFor, type EntryLifecyclePaths } from "./lifecycle.ts";
import { EntryPeerRuntime, peerStoreDirFor } from "./peer.ts";
import { EntryApplicationPeerRouter, type ApplicationPeerRouteBinding } from "./application-peer-router.ts";
import { FilePeerApplicationJournal } from "./agent/journal.ts";
import { FileAcpAgentRegistry, type AcpAgentDefinitionInput } from "./agent/agent-registry.ts";
import { PersonalEndpointRuntime, type PersonalEndpointSnapshot, type PersonalEndpointStepUpRequest } from "./personal-endpoint.ts";
import {
  PeerApplicationEngine,
  peerApplicationTransportMessageId,
  samePeerApplicationAddress,
  type PeerApplicationAddress,
  type PeerApplicationDiscoveryRecord,
  type PeerApplicationRecord,
  type PeerApplicationRouteAuthority
} from "@meshrix/peer-client";
import {
  DesktopAccountClient,
  signDesktopPairingBootstrap,
  signDesktopAccountProof,
  type DesktopAccountTransaction
} from "./account-client.ts";
import { relayHttpBase, relaySessionUrl as buildRelaySessionUrl } from "./relay-address.ts";
import type { EntryServiceConfig } from "./service-config.ts";

/** The endpoint admin surface: pairing exchange plus the recovery-access provisioning seam. */
export interface PairingChannelLike {
  /** Best-effort remote revocation on the pairing surface; may be absent. */
  revokeDevice?(input: { deviceId: string }): Promise<{ revoked: boolean }>;
  /**
   * Fresh-device relay provisioning for fresh-install recovery. The endpoint
   * admin owns credential issuance: it retires the lost device's slot and
   * enrolls the fresh deviceId for the vault's owning route — the entry then
   * proves recovery-root possession through the vault fetch + challenge
   * signature inside the recover_device session.
   */
  recoveryAccess?(input: { vaultId: string }): Promise<{
    readonly outcome: "issued";
    readonly deviceId: string;
    readonly relayCredential: string;
    readonly tenantId: string;
    readonly routeId: string;
    readonly admissionGeneration: number;
    readonly revocationRevision: number;
  } | {
    readonly outcome: "refused";
    readonly refusal: string;
  }>;
}

/** Minimal session surface the service drives (EntryRelaySession-compatible). */
export interface EntrySessionLike {
  readonly state: string;
  readonly routeState: string;
  readonly acceptsNewWork: boolean;
  readonly channelEstablished: boolean;
  connect(): Promise<void>;
  close(reason?: "normal" | "reconnect" | "protocol_error" | "capacity_exceeded" | "idle_timeout" | "revoked"): void;
  request(message: Readonly<Record<string, unknown>>): Promise<unknown>;
  handleMessage(message: unknown): string | null;
  handleTransportClose(): void;
}

/** Transport surface the service wires to a live session. */
export interface EntryTransportLike extends RelayTransportPort {
  onMessage?: (message: Readonly<Record<string, unknown>>) => void;
  onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  onSocketDrop?: () => void;
  readonly handlers?: {
    onMessage?: (message: Readonly<Record<string, unknown>>) => void;
    onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  };
  readonly ready?: Promise<void>;
  reopen?(): Promise<void>;
}

export interface LiveSession {
  readonly session: EntrySessionLike;
  readonly transport: EntryTransportLike;
  readonly bridge: EntryMcpBridge;
}

interface ConnectionReconnectState {
  attempts: number;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RecoveryChannelFactoryInput {
  readonly relaySessionUrl: string;
  readonly admission: RelayAdmissionInput;
  readonly headers: Record<string, string>;
}

export interface PairingRelayChannelLike extends PairingEndpointPort {
  connect(): Promise<void>;
  close(): void;
}

export interface PairingRelayChannelFactoryInput {
  readonly relaySessionUrl: string;
  readonly bootstrap: PairingRelayBootstrap;
  readonly invite: PairingInvite;
  readonly innerTls: EntrySessionOptions["innerTls"];
  readonly connectTimeoutMs: number | null;
  readonly allowInsecureLoopback: false;
}

export interface PairingCompletionRelayChannelLike {
  connect(): Promise<void>;
  /** Sends only the immutable completion captured by the factory input. */
  replayCompletion(): Promise<PairingCompletionReceipt | { readonly outcome: "refused"; readonly refusal: string }>;
  close(): void;
}

export interface PairingCompletionRelayChannelFactoryInput {
  readonly relaySessionUrl: string;
  readonly bootstrap: PairingRelayBootstrap;
  readonly invite: PairingInvite;
  readonly completion: PairingCompletionRequest;
  readonly innerTls: EntrySessionOptions["innerTls"];
  readonly connectTimeoutMs: number | null;
  readonly allowInsecureLoopback: false;
}

interface PairingCompletionCheckpoint {
  readonly schemaVersion: "entry-pairing-completion-checkpoint-1";
  readonly bootstrap: PairingRelayBootstrap;
  readonly deviceKeyCustodyRef: string;
  readonly device: DeviceIdentity;
  readonly boundRecoveryKeyId: string | null;
  readonly completion: PairingCompletionRequest;
}

export type RecoveryChannelLike = EntryRecoveryRoundTripPort & {
  open(): Promise<void>;
  close(): void;
};

export interface EntryProductServiceOptions {
  /** Owned data directory — the only place the app writes. */
  readonly dataDir: string;
  readonly appVersion?: string;
  /** Executable path used in the stdio MCP snippet (the installed app binary that forwards `--mcp-stdio` to the sidecar). */
  readonly appExePath?: string;
  readonly custody?: CustodyAdapter;
  readonly custodyPlatform?: CustodyPlatform;
  /** File-fallback wrap secret — persisted per-install when not supplied. */
  readonly custodyFileWrapSecret?: Uint8Array;
  readonly now?: () => number;
  readonly pairingChannelFactory?: (baseUrl: string) => PairingChannelLike;
  /** Deterministic transport seam. Production defaults to the restricted pair_device relay channel. */
  readonly pairingRelayChannelFactory?: (input: PairingRelayChannelFactoryInput) => PairingRelayChannelLike;
  /** Completion-only fresh forward session used exclusively for saved pairing replay. */
  readonly pairingCompletionRelayChannelFactory?: (input: PairingCompletionRelayChannelFactoryInput) => PairingCompletionRelayChannelLike;
  readonly recoveryChannelFactory?: (input: RecoveryChannelFactoryInput) => RecoveryChannelLike;
  readonly vaultTransportFactory?: (baseUrl: string) => VaultTransport;
  readonly sessionFactory?: (options: EntrySessionOptions) => EntrySessionLike;
  readonly transportFactory?: (input: { url: string; headers: Record<string, string> }) => EntryTransportLike;
  /** Trusted release service origins; direct synthetic injection is for tests only. */
  readonly serviceConfig?: EntryServiceConfig | null;
  /** In-process deterministic HTTP seam; production uses global fetch. */
  readonly accountFetch?: typeof fetch;
  /** Connect budget for the pinned inner channel (default 15s). */
  readonly connectTimeoutMs?: number;
}

const CUSTODY_RELAY_REF_PREFIX = "entry-gui.relay";
const CUSTODY_RECOVERY_REF_PREFIX = "entry-gui.recovery";
const CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX = "entry-gui.account.desktop";
const CUSTODY_ACCOUNT_SESSION_REF = "entry-gui.account.session";
const CUSTODY_PAIRING_COMPLETION_PREFIX = "entry-gui.pairing.completion";
/** The save window for a pending recovery key — the pending secret is dropped after it. */
const MAX_RECOVERY_SECRET_WINDOW_MS = 10 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CONNECTION_RECONNECT_INITIAL_DELAY_MS = 1_000;
const CONNECTION_RECONNECT_MAX_DELAY_MS = 30_000;

interface PendingRecoverySecret {
  readonly recoveryText: string;
  readonly material: RecoveryMaterial;
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
  readonly rotationId: string | null;
  readonly priorView: GuiRecoveryView;
  revealed: boolean;
  confirmation: Promise<GuiState> | null;
  readonly expiresAt: number;
}

interface PendingPairing {
  session: PairingSession | null;
  channel: PairingRelayChannelLike | null;
  readonly invite: PairingInvite;
  device: Awaited<ReturnType<typeof enrollDeviceIdentity>> | null;
  entryPeerIdentity: PairingPeerIdentity | null;
  bootstrapRequest: AccountDesktopPairingBootstrapRequest | null;
  bootstrap: PairingRelayBootstrap | null;
  authorization: PairingActionAuthorization | null;
  completion: PairingCompletionRequest | null;
  completionTask: Promise<GuiState> | null;
  checkpointRef: string | null;
  boundRecoveryKeyId: string | null;
}

interface PendingGrant {
  readonly connectionId: string;
  readonly operationId: string;
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
}

interface PendingDesktopTransaction {
  readonly transaction: DesktopAccountTransaction;
  readonly actionPurpose: "pair_device" | "grant_access" | null;
  readonly binding: AccountAuthorityBinding | null;
  readonly target: AccountActionTarget | null;
  readonly bootstrapId: string | null;
  readonly claimId: string | null;
}

interface PendingPersonalStepUp {
  readonly claimId: string;
  readonly account: AccountAuthorityBinding;
  readonly target: AccountActionTarget;
  readonly promise: Promise<{ readonly account: AccountAuthorityBinding; readonly permitId: string; readonly target: AccountActionTarget }>;
  readonly resolve: (value: { readonly account: AccountAuthorityBinding; readonly permitId: string; readonly target: AccountActionTarget }) => void;
  readonly reject: (error: unknown) => void;
}

interface ApplicationDestination {
  readonly handle: string;
  readonly label: string;
  readonly address: PeerApplicationAddress;
  readonly reachable: boolean;
}

interface VaultWriterRotationFlow {
  readonly account: AccountAuthorityBinding;
  readonly prepareRequest: AccountDesktopVaultWriterRotationPrepareRequest | null;
  readonly target: AccountActionTarget | null;
  readonly expiresAt: string | null;
  readonly browserTransaction: DesktopAccountTransaction | null;
  readonly completeRequest: AccountDesktopVaultWriterRotationCompleteRequest | null;
}

interface PendingVaultWriterRotation extends Omit<StoredVaultWriterOperation, "state"> {
  state: StoredVaultWriterOperation["state"];
  flow: VaultWriterRotationFlow;
}

function custodyRelayRef(connectionId: string): string {
  return `${CUSTODY_RELAY_REF_PREFIX}.${connectionId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}
function custodyRecoveryRef(vaultId: string): string {
  return `${CUSTODY_RECOVERY_REF_PREFIX}.${vaultId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}
function custodyRecoveryKeyRef(vaultId: string, keyId: string): string {
  const suffix = keyId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase();
  return `${custodyRecoveryRef(vaultId)}.${suffix}`.slice(0, 128);
}
function retainedRecoveryRefs(
  current: StoredRecovery | null,
  vaultId: string,
  nextMaterialRef: string
): string[] {
  const refs = current?.vaultId === vaultId ? [...current.retainedMaterialRefs, current.materialRef] : [];
  return [...new Set(refs.filter((ref) => ref !== nextMaterialRef))];
}

function summarizeInvite(invite: PairingInvite): GuiInviteSummary {
  return {
    inviteId: invite.inviteId,
    endpointRouteId: invite.endpointRouteId,
    tenantId: invite.tenantId,
    mode: invite.mode,
    endpointPrincipalRef: invite.endpointPrincipalRef,
    endpointDeviceId: invite.endpointDeviceId,
    endpointSpkiPin: invite.endpointSpkiPin,
    relayService: invite.relayService,
    vaultId: invite.vaultId,
    expiresAt: invite.expiresAt
  };
}

function deviceKeyCustodyRef(deviceId: string): string {
  return `dev.${deviceId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}

function parsePairingCompletionCheckpoint(value: unknown): PairingCompletionCheckpoint | null {
  if (!isRecord(value) || value.schemaVersion !== "entry-pairing-completion-checkpoint-1"
    || !isRecord(value.bootstrap) || !isRecord(value.device) || !isRecord(value.completion)) return null;
  const bootstrapValue = value.bootstrap;
  const deviceId = typeof value.device.deviceId === "string" ? value.device.deviceId : null;
  const devicePublicKey = typeof value.device.publicKey === "string" ? value.device.publicKey : null;
  const deviceFingerprint = typeof value.device.fingerprint === "string" ? value.device.fingerprint : null;
  const completionValue = value.completion;
  const invite = parsePairingInvite(completionValue.invite);
  const target = completionValue.target;
  const expectedEntryPeerId = invite && deviceId
    ? peerIdForRouteDevice({ tenantId: invite.tenantId, routeId: invite.endpointRouteId, deviceId })
    : null;
  const entryPeerIdentity = completionValue.entryPeerIdentity === null
    ? null
    : expectedEntryPeerId !== null && expectedEntryPeerId !== undefined
      && isPairingPeerIdentity(completionValue.entryPeerIdentity, expectedEntryPeerId)
      ? Object.freeze({ ...completionValue.entryPeerIdentity })
      : undefined;
  if (!deviceId || !devicePublicKey || !deviceFingerprint
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(deviceId)
    || !/^[-A-Za-z0-9_]{43}$/u.test(devicePublicKey)
    || !/^fp\.[A-Za-z0-9_-]{20,100}$/u.test(deviceFingerprint)
    || value.deviceKeyCustodyRef !== deviceKeyCustodyRef(deviceId)
    || !invite || invite.mode !== "personal"
    || !isAccountBinding(bootstrapValue.account)
    || !isAccountBinding(completionValue.account)
    || !isActionTarget(target)
    || bootstrapValue.role !== "entry"
    || bootstrapValue.mode !== invite.mode
    || bootstrapValue.tenantId !== invite.tenantId
    || bootstrapValue.routeId !== invite.endpointRouteId
    || bootstrapValue.endpointDeviceId !== invite.endpointDeviceId
    || bootstrapValue.endpointPinRef !== invite.endpointPinRef
    || bootstrapValue.entryDeviceId !== deviceId
    || typeof bootstrapValue.bootstrapId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(bootstrapValue.bootstrapId)
    || typeof bootstrapValue.relayAdmission !== "string" || bootstrapValue.relayAdmission.length < 32
    || !Number.isSafeInteger(bootstrapValue.admissionGeneration) || Number(bootstrapValue.admissionGeneration) < 1
    || !Number.isSafeInteger(bootstrapValue.revocationRevision) || Number(bootstrapValue.revocationRevision) < 0
    || typeof bootstrapValue.expiresAt !== "string" || !Number.isFinite(Date.parse(bootstrapValue.expiresAt))
    || bootstrapValue.account.accountId !== completionValue.account.accountId
    || bootstrapValue.account.authEpoch !== completionValue.account.authEpoch
    || completionValue.deviceId !== deviceId
    || completionValue.devicePublicKey !== devicePublicKey
    || completionValue.purpose !== "pair_device"
    || entryPeerIdentity === undefined
    || target.deviceId !== deviceId
    || target.devicePublicKey !== devicePublicKey
    || target.tenantId !== invite.tenantId
    || target.routeId !== invite.endpointRouteId
    || typeof completionValue.challengeId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(completionValue.challengeId)
    || !isAccountStepUpPermitId(completionValue.permitId)
    || typeof completionValue.operationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(completionValue.operationId)
    || typeof completionValue.signature !== "string"
    || !/^[A-Za-z0-9_-]{80,100}$/u.test(completionValue.signature)
    || (value.boundRecoveryKeyId !== null && typeof value.boundRecoveryKeyId !== "string")) return null;
  const bootstrap: PairingRelayBootstrap = {
    bootstrapId: bootstrapValue.bootstrapId,
    relayAdmission: bootstrapValue.relayAdmission,
    account: bootstrapValue.account,
    tenantId: invite.tenantId,
    routeId: invite.endpointRouteId,
    endpointDeviceId: invite.endpointDeviceId,
    endpointPinRef: invite.endpointPinRef,
    entryDeviceId: deviceId,
    role: "entry",
    mode: invite.mode,
    admissionGeneration: Number(bootstrapValue.admissionGeneration),
    revocationRevision: Number(bootstrapValue.revocationRevision),
    expiresAt: bootstrapValue.expiresAt
  };
  const completion: PairingCompletionRequest = {
    invite,
    challengeId: completionValue.challengeId,
    deviceId,
    devicePublicKey,
    signature: completionValue.signature,
    account: completionValue.account,
    permitId: completionValue.permitId,
    purpose: "pair_device",
    target,
    operationId: completionValue.operationId,
    entryPeerIdentity
  };
  return {
    schemaVersion: "entry-pairing-completion-checkpoint-1",
    bootstrap,
    deviceKeyCustodyRef: deviceKeyCustodyRef(deviceId),
    device: { deviceId, publicKey: devicePublicKey, fingerprint: deviceFingerprint },
    boundRecoveryKeyId: typeof value.boundRecoveryKeyId === "string" ? value.boundRecoveryKeyId : null,
    completion
  };
}

function connectionView(
  stored: StoredConnection,
  live?: Partial<Pick<GuiConnectionView, "routeState" | "channelEstablished" | "acceptsNewWork">>
): GuiConnectionView {
  return {
    connectionId: stored.connectionId,
    displayLabel: stored.displayLabel,
    tenantId: stored.tenantId,
    routeId: stored.routeId,
    mode: stored.mode,
    endpointPrincipalRef: stored.endpointPrincipalRef,
    endpointDeviceId: stored.endpointDeviceId,
    endpointSpkiPin: stored.endpointSpkiPin,
    deviceId: stored.deviceId,
    deviceFingerprint: stored.deviceFingerprint,
    routeState: live?.routeState ?? "unknown",
    channelEstablished: live?.channelEstablished ?? false,
    acceptsNewWork: live?.acceptsNewWork ?? false,
    boundRecoveryKeyId: stored.boundRecoveryKeyId,
    revocation: stored.routeRevocation?.authorityRevoked === true
      ? stored.routeRevocation.enforcement === "complete" ? "remote_applied" : "enforcement_pending"
      : stored.routeRevocation ? "authority_pending"
      : stored.remoteRevocation === "applied"
      ? "remote_applied"
      : stored.remoteRevocation === "pending"
        ? "remote_pending"
        : "none",
    vaultId: stored.vaultId,
    capabilityGrantRef: stored.capabilityGrantRef,
    rePairRequired: stored.rePairRequired
  };
}

function emptyGrantView(notice: string | null = null): GuiState["grant"] {
  return { connectionId: null, availableScopes: [], targetScopes: [], grantRef: null, status: "idle", notice };
}

function isAccountBinding(value: unknown): value is AccountAuthorityBinding {
  return isRecord(value)
    && typeof value.accountId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(value.accountId)
    && Number.isSafeInteger(value.authEpoch)
    && Number(value.authEpoch) > 0;
}

function assertSameAccountBinding(left: AccountAuthorityBinding, right: AccountAuthorityBinding): void {
  if (left.accountId !== right.accountId || left.authEpoch !== right.authEpoch) {
    throw entryError("account_binding_mismatch", "The signed-in account and endpoint enrollment do not match.");
  }
}

function isScopeName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isActionTarget(value: unknown): value is AccountActionTarget {
  return isRecord(value)
    && typeof value.tenantId === "string"
    && typeof value.routeId === "string"
    && typeof value.deviceId === "string"
    && typeof value.devicePublicKey === "string"
    && typeof value.grantRef === "string"
    && Array.isArray(value.scopes)
    && value.scopes.every(isScopeName);
}

/**
 * Derived recovery material at rest: private keys as PKCS#8 inside custody —
 * never the 32-byte root. Key ids + public keys are re-derived on load, so a
 * tampered id cannot redirect writes silently (the signature wouldn't verify
 * anyway, but the id is also covered by the vault's signed verifier record).
 */
function serializeRecoveryMaterial(material: RecoveryMaterial): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    signingKeyId: material.signing.keyId,
    signingPkcs8: Buffer.from(material.signing.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    writerKeyId: material.writer.keyId,
    writerPkcs8: Buffer.from(material.writer.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    backupKey: material.backupKey.toString("base64url")
  }));
}

function deserializeRecoveryMaterial(secret: Uint8Array): RecoveryMaterial {
  const parsed = JSON.parse(new TextDecoder().decode(secret)) as {
    signingKeyId: string;
    signingPkcs8: string;
    writerKeyId: string;
    writerPkcs8: string;
    backupKey: string;
  };
  const signingPrivate = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.from(parsed.signingPkcs8, "base64url") });
  const writerPrivate = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.from(parsed.writerPkcs8, "base64url") });
  return {
    signing: {
      keyId: parsed.signingKeyId,
      publicKey: rawPublicKeyBase64Url(createPublicKey(signingPrivate)),
      privateKey: signingPrivate
    },
    writer: {
      keyId: parsed.writerKeyId,
      publicKey: rawPublicKeyBase64Url(createPublicKey(writerPrivate)),
      privateKey: writerPrivate
    },
    backupKey: Buffer.from(parsed.backupKey, "base64url")
  };
}

/** Vault journal bound to the owned config file — survives restarts so high-water marks never regress. */
class ConfigSnapshotJournal implements SnapshotJournalPort {
  readonly #store: EntryConfigStore;
  constructor(store: EntryConfigStore) {
    this.#store = store;
  }
  load(): SnapshotJournal | null {
    return this.#store.config.journal as SnapshotJournal | null;
  }
  save(journal: SnapshotJournal): Promise<void> {
    return this.#store.update((draft) => ({ ...draft, journal: journal as StoredSnapshotJournal }));
  }
}

/** Rotation records persisted in the owned config — non-secret state only. */
class ConfigRotationStore implements RotationDurablePort {
  readonly #store: EntryConfigStore;
  constructor(store: EntryConfigStore) {
    this.#store = store;
  }
  load(rotationId: string): RecoveryRotation | null {
    return this.loadAll().find((rotation) => rotation.rotationId === rotationId) ?? null;
  }
  loadAll(): readonly RecoveryRotation[] {
    return this.#store.config.rotations as unknown as readonly RecoveryRotation[];
  }
  save(rotation: RecoveryRotation): void {
    void this.#store.update((draft) => {
      const index = draft.rotations.findIndex((entry) => entry.rotationId === rotation.rotationId);
      const next = [...draft.rotations];
      const stored = rotation as unknown as StoredRotation;
      if (index < 0) next.push(stored); else next[index] = stored;
      return { ...draft, rotations: next };
    });
  }
  delete(rotationId: string): void {
    void this.#store.update((draft) => ({
      ...draft,
      rotations: draft.rotations.filter((entry) => entry.rotationId !== rotationId)
    }));
  }
}

export class EntryProductService {
  readonly #options: EntryProductServiceOptions;
  readonly #model = new EntryGuiModel();
  readonly #listeners = new Set<(state: GuiState) => void>();
  readonly #now: () => number;

  #snapshotPublication: Promise<GuiState> | null = null;
  #custody!: CustodyAdapter;
  #custodyTier: "os" | "file" = "file";
  #custodyReason = "custody not selected";
  #custodyAvailable = false;
  #store!: EntryConfigStore;
  #started = false;

  #pendingPairing: PendingPairing | null = null;
  #pairingCheckpointBlocked = false;
  #desktopTransaction: PendingDesktopTransaction | null = null;
  #pendingGrant: PendingGrant | null = null;
  #pendingVaultWriterRotation: PendingVaultWriterRotation | null = null;
  #pendingPersonalStepUp: PendingPersonalStepUp | null = null;
  #pendingRecovery: PendingRecoverySecret | null = null;
  #recoveryMaterial: RecoveryMaterial | null = null;
  #sessions = new Map<string, LiveSession>();
  /** Per-connection PeerClient channels owned by the canonical profile service. */
  #peers = new Map<string, EntryPeerRuntime>();
  /** Share the one durable PeerClient initialization for each connection. */
  #peerInitializations = new Map<string, Promise<EntryPeerRuntime>>();
  /** Monotonic generations fence late callbacks from replaced relay sessions. */
  #connectionGenerations = new Map<string, number>();
  /** Temporary relay/socket failures retry through the same durable peer runtime. */
  #connectionReconnects = new Map<string, ConnectionReconnectState>();
  #applicationRouter: EntryApplicationPeerRouter | null = null;
  #applicationAuthorityUnsubscribe: (() => void) | null = null;
  #applicationEngine: PeerApplicationEngine | null = null;
  #applicationJournal: FilePeerApplicationJournal | null = null;
  #agentRegistry: FileAcpAgentRegistry | null = null;
  #personalEndpoint: PersonalEndpointRuntime | null = null;
  #personalEndpointPeerBinding: ApplicationPeerRouteBinding | null = null;
  #personalEndpointPeerUnsubscribe: (() => void) | null = null;
  #entryPeerBindings = new Map<string, { readonly binding: ApplicationPeerRouteBinding; readonly unsubscribe: () => void }>();
  #applicationChangeUnsubscribe: (() => void) | null = null;
  #applicationDestinations: readonly ApplicationDestination[] = Object.freeze([]);
  #applicationRefreshTail: Promise<void> = Promise.resolve();
  #applicationInitialization: Promise<void> | null = null;
  #personalEndpointStarting: Promise<PersonalEndpointRuntime | null> | null = null;
  /** Recovery channels with in-flight exchanges — closed on stop so nothing pends forever. */
  #openRecoveryChannels = new Set<RecoveryChannelLike>();
  #rotationManager!: RecoveryRotationManager;

  constructor(options: EntryProductServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                          */
  /* ---------------------------------------------------------------- */

  async start(): Promise<GuiState> {
    const paths = this.paths();
    this.#store = new EntryConfigStore({ dataDir: paths.dataDir });
    await this.#store.load();

    const selection = this.#options.custody
      ? {
          adapter: this.#options.custody,
          // The file-tier adapter reports kind "file" ("entry-custody-file" is
          // its on-disk schema); anything else is a platform/OS store. Report
          // honestly — a file store must never masquerade as an OS keystore.
          tier: (this.#options.custody.kind === "file" || this.#options.custody.kind === "entry-custody-file" ? "file" : "os") as "os" | "file",
          reason: `injected ${this.#options.custody.kind} custody adapter`
        }
      : selectCustodyAdapter({
          platform: this.#options.custodyPlatform,
          file: { dataDir: paths.dataDir, wrapSecret: await this.#wrapSecret(paths.dataDir) },
          windows: { dataDir: paths.dataDir }
        });
    this.#custody = selection.adapter;
    this.#custodyTier = selection.tier;
    this.#custodyReason = selection.reason;
    const custodyAvailable = await this.#custody.available();
    this.#custodyAvailable = custodyAvailable;
    const savedAccount = this.#store.config.account;
    if (savedAccount?.sessionCredentialRef === CUSTODY_ACCOUNT_SESSION_REF
      && this.#custodyTier === "os"
      && custodyAvailable
      && !await this.#storedAccountCredential()) {
      await this.#custody.deleteSecret({ ref: CUSTODY_ACCOUNT_SESSION_REF }).catch(() => undefined);
      await this.#store.update((draft) => ({
        ...draft,
        account: draft.account
          ? { ...draft.account, accountId: null, authEpoch: null, sessionCredentialRef: null }
          : null
      }));
    }

    this.#rotationManager = new RecoveryRotationManager({ store: new ConfigRotationStore(this.#store), now: this.#now });

    // A restart-stranded `staged` rotation is uncompletable by design: its
    // candidate secret lived only in the in-memory save window, which is gone.
    // Abort the record (history is preserved in config) so rotation is never
    // permanently deadlocked — the incumbent key stays active throughout.
    for (const rotation of this.#rotationManager.loadAll()) {
      if (rotation.state === "staged") {
        this.#rotationManager.abort(rotation.rotationId);
      }
    }

    // Restore persisted recovery material (derived keys only — never the root).
    if (this.#store.config.recovery) {
      const secret = await this.#custody.loadSecret({ ref: this.#store.config.recovery.materialRef });
      if (secret) this.#recoveryMaterial = deserializeRecoveryMaterial(secret);
    }
    await this.#restoreVaultWriterRotation();
    const restoredPairingCheckpoint = await this.#restorePairingCompletionCheckpoint();

    this.#started = true;
    const state = restoreGuiState(this.#model, {
      appVersion: this.#options.appVersion ?? "0.1.0",
      custody: { tier: custodyAvailable ? selection.tier : "unavailable", available: custodyAvailable, reason: selection.reason },
      lifecycle: {
        state: "ready",
        dataDir: paths.dataDir,
        configPath: this.#store.filePath,
        ownedPaths: ownedPathsFor(paths, this.#store.config),
        updatePolicy: "manual"
      },
      connections: this.#store.config.connections.map((stored) => connectionView(stored)),
      recovery: this.#store.config.recovery
        ? {
            vaultId: this.#store.config.recovery.vaultId,
            keyId: this.#store.config.recovery.keyId,
            generation: this.#store.config.recovery.generation,
            backup: journalBackupView(this.#store.config.journal),
            rotation: this.#activeRotationView(),
            writerRegistration: {
              state: this.#store.config.recovery.accountSnapshotState === "older_snapshot_preserved" ? "older_snapshot_preserved"
                : this.#store.config.recovery.accountSnapshotState === "unverified" ? "service_pending"
                  : this.#store.config.recovery.accountWriterState === "complete" ? "complete"
                    : this.#store.config.recovery.accountWriterState === "pending" ? "service_pending" : "unmanaged",
              candidateGeneration: null,
              detail: this.#store.config.recovery.accountSnapshotState === "older_snapshot_preserved"
                ? "The older encrypted snapshot is preserved and publishing remains fenced until it can be reconciled."
                : this.#store.config.recovery.accountSnapshotState === "unverified"
                  ? "Snapshot reconciliation is incomplete; publishing remains fenced. Retry the saved writer registration."
                  : null
            }
          }
        : null,
      mcp: { snippet: null, configuredPath: this.#store.config.mcp.managedConfigPath }
    });
    if (this.#pendingVaultWriterRotation) this.#applyVaultWriterRegistrationView();
    if (restoredPairingCheckpoint && this.#pendingPairing) {
      this.#apply({
        type: "pairing.invite_ready",
        sessionId: `pair.pending.${this.#pendingPairing.completion!.operationId}`,
        invite: summarizeInvite(this.#pendingPairing.invite)
      });
      this.#apply({ type: "pairing.challenge_issued", deviceFingerprint: this.#pendingPairing.device!.fingerprint });
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: "A saved pairing completion is awaiting endpoint confirmation."
      });
    } else if (this.#pairingCheckpointBlocked) {
      this.#notice("A saved pairing completion could not be loaded from protected storage. Resolve it before starting another pairing.");
    }
    this.#apply({ type: "account.updated", account: this.#accountView() });
    await this.#initializeApplicationComposition();
    await this.#refreshApplicationsView(true);
    // Resume only the account-bound personal routes handled by this release.
    // Their operation journal is profile-scoped and survives route-store cleanup.
    void this.#restorePersonalRoutes();
    return this.snapshot();
  }

  paths(): EntryLifecyclePaths {
    return { dataDir: this.#options.dataDir };
  }

  async stop(): Promise<GuiState> {
    // Mark stopped first: an in-flight import/rotation delivery checks this
    // before creating a channel, so nothing joins the set after it is closed.
    this.#started = false;
    for (const connectionId of this.#connectionReconnects.keys()) this.#clearConnectionReconnect(connectionId);
    for (const connection of this.#store?.config.connections ?? []) {
      this.#connectionGenerations.set(connection.connectionId, (this.#connectionGenerations.get(connection.connectionId) ?? 0) + 1);
    }
    // Local initialization may already be publishing durable route/WAL state.
    // Let it finish before closing the resulting runtimes and returning custody
    // of the data directory; its retired connection generation cannot connect.
    await Promise.allSettled([...this.#peerInitializations.values()]);
    this.#apply({ type: "lifecycle.state", state: "stopping" });
    this.#pendingPersonalStepUp?.reject(entryError("personal_endpoint_stopped", "Personal enrollment stopped before its account confirmation completed."));
    this.#pendingPersonalStepUp = null;
    this.#applicationChangeUnsubscribe?.();
    this.#applicationChangeUnsubscribe = null;
    this.#applicationAuthorityUnsubscribe?.();
    this.#applicationAuthorityUnsubscribe = null;
    for (const entry of this.#entryPeerBindings.values()) {
      entry.unsubscribe();
      this.#applicationRouter?.unregister(entry.binding);
    }
    this.#entryPeerBindings.clear();
    if (this.#personalEndpointPeerBinding) this.#applicationRouter?.unregister(this.#personalEndpointPeerBinding);
    this.#personalEndpointPeerUnsubscribe?.();
    this.#personalEndpointPeerUnsubscribe = null;
    this.#personalEndpointPeerBinding = null;
    this.#applicationRouter?.dispose();
    this.#applicationRouter = null;
    try { await this.#applicationEngine?.dispose(); } catch { /* durable operation rows remain available for restart */ }
    this.#applicationEngine = null;
    try { await this.#personalEndpoint?.stop(); } catch { /* best-effort transport teardown */ }
    // Detach peer channels first: a session close mid-teardown must never
    // still route wire messages into a runtime that is going away.
    for (const peer of this.#peers.values()) {
      try { await peer.close(); } catch { /* best-effort */ }
    }
    this.#peers.clear();
    for (const live of this.#sessions.values()) {
      try { live.session.close("normal"); } catch { /* best-effort */ }
      try { live.transport.close(); } catch { /* best-effort */ }
    }
    this.#sessions.clear();
    for (const channel of this.#openRecoveryChannels) {
      try { channel.close(); } catch { /* best-effort */ }
    }
    this.#openRecoveryChannels.clear();
    // A pending rotation candidate is memory-only: dropping it strands the
    // staged record forever unless it is aborted alongside.
    if (this.#pendingRecovery) this.#abandonPendingRotation(this.#pendingRecovery);
    this.#pendingRecovery = null;
    this.#pendingPairing?.channel?.close();
    this.#pendingPairing = null;
    this.#desktopTransaction = null;
    // Drain queued config writes — a graceful stop never loses a landed
    // enrollment/recovery record to a still-in-flight atomic rename.
    await this.#store?.flush();
    this.#apply({ type: "lifecycle.state", state: "stopped" });
    return this.snapshot();
  }

  snapshot(): GuiState {
    return this.#model.snapshot();
  }

  subscribe(listener: (state: GuiState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /* ---------------------------------------------------------------- */
  /* IPC dispatch — one audited entry point for every op                */
  /* ---------------------------------------------------------------- */

  async dispatch(op: GuiOp, args?: unknown): Promise<GuiIpcResult<unknown>> {
    try {
      const value = await this.#dispatch(op, args);
      return { ok: true, value };
    } catch (error) {
      // Typed codes survive honestly: entry codes, peer-client/peer-crypto
      // codes and the peer-channel gate code all carry `error.code`.
      const code = errorCode(error);
      const outcome = typeof error === "object" && error !== null && "effectOutcome" in error
        ? (error as { effectOutcome?: unknown }).effectOutcome
        : undefined;
      return {
        ok: false,
        error: {
          code,
          message: error instanceof Error ? error.message : "The requested operation could not be completed.",
          ...(outcome === "not_started" || outcome === "unknown" ? { effectOutcome: outcome } : {})
        }
      };
    }
  }

  async #dispatch(op: GuiOp, args?: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (op) {
      case "state.get":
        return this.snapshot();
      case "pairing.submitInvite":
        return this.submitPairingInvite({ inviteText: String(a.inviteText ?? "") });
      case "pairing.confirm":
        return this.confirmPairing();
      case "pairing.continue":
        return this.continuePairing();
      case "pairing.cancel":
        return this.cancelPairing();
      case "pairing.reset":
        return this.resetPairing();
      case "connection.refresh":
        return this.refreshConnection(String(a.connectionId ?? ""));
      case "connection.disconnect":
        return this.disconnectConnection({ connectionId: String(a.connectionId ?? "") });
      case "connection.revoke":
        return this.revokeConnection({ connectionId: String(a.connectionId ?? ""), remote: a.remote === true });
      case "connection.grantCatalog":
        return this.loadGrantCatalog(String(a.connectionId ?? ""));
      case "connection.grantAccess":
        return this.requestGrantAccess({
          connectionId: String(a.connectionId ?? ""),
          scopes: Array.isArray(a.scopes) ? a.scopes.filter((scope): scope is string => typeof scope === "string") : []
        });
      case "account.beginLogin":
        return this.beginAccountLogin();
      case "account.checkTransaction":
        return this.checkAccountTransaction();
      case "account.signOut":
        return this.signOutAccount();
      case "account.openSettings":
        return this.openAccountSettings();
      case "personal.status":
        return this.personalStatus();
      case "personal.enroll":
        return this.enrollPersonalEndpoint();
      case "personal.createInvite":
        return this.createPersonalPairingInvite();
      case "agent.list":
        return this.listLocalAgents();
      case "agent.register":
        return this.registerLocalAgent(a);
      case "agent.remove":
        return this.removeLocalAgent(String(a.agentId ?? ""));
      case "application.destinations":
        return this.applicationDestinations();
      case "application.discover":
        return this.discoverApplicationAgents({
          destinationHandle: String(a.destinationHandle ?? ""),
          requestId: typeof a.requestId === "string" ? a.requestId : undefined
        });
      case "application.submit":
        return this.submitApplicationTask({
          operationId: String(a.operationId ?? ""),
          destinationHandle: String(a.destinationHandle ?? ""),
          targetAgentId: String(a.targetAgentId ?? ""),
          prompt: String(a.prompt ?? ""),
          callerAgentId: typeof a.requesterAgentId === "string" ? a.requesterAgentId : undefined
        });
      case "application.list":
        return this.listApplicationOperations();
      case "application.get":
        return this.getApplicationOperation(String(a.operationId ?? ""));
      case "application.cancel":
        return this.cancelApplicationOperation(String(a.operationId ?? ""));
      case "application.resolvePermission":
        return this.resolveApplicationPermission({
          operationId: String(a.operationId ?? ""),
          permissionRequestId: String(a.permissionRequestId ?? ""),
          outcome: a.outcome === "selected" ? "selected" : "cancelled",
          optionId: typeof a.optionId === "string" ? a.optionId : undefined
        });
      case "recovery.beginSetup":
        return this.beginRecoverySetup();
      case "recovery.revealKey":
        return this.revealRecoveryKey();
      case "recovery.confirmSaved":
        return this.confirmRecoverySaved();
      case "recovery.retryWriterRegistration":
        return this.retryVaultWriterRegistration();
      case "recovery.beginRotation":
        return this.beginRecoveryRotation();
      case "recovery.abortRotation":
        return this.abortRecoveryRotation();
      case "recovery.retryRotation":
        return this.retryRotationDelivery();
      case "recovery.importText":
        return this.importRecoveryText({
          recoveryText: String(a.recoveryText ?? ""),
          serviceUrl: typeof a.serviceUrl === "string" ? a.serviceUrl : undefined
        });
      case "peer.status":
        return this.peerStatus(String(a.connectionId ?? ""));
      case "peer.send":
        return this.peerSend({
          connectionId: String(a.connectionId ?? ""),
          peerDeviceId: String(a.peerDeviceId ?? ""),
          text: typeof a.text === "string" ? a.text : undefined,
          plaintextBase64url: typeof a.plaintextBase64url === "string" ? a.plaintextBase64url : undefined,
          messageId: typeof a.messageId === "string" ? a.messageId : undefined
        });
      case "peer.inbox":
        return this.peerInbox(
          String(a.connectionId ?? ""),
          a.limit === undefined ? undefined : Number(a.limit),
          a.afterSequence === undefined ? undefined : Number(a.afterSequence)
        );
      case "peer.pairSafety":
        return this.peerPairSafety({ connectionId: String(a.connectionId ?? ""), peerDeviceId: String(a.peerDeviceId ?? "") });
      case "mcp.snippet":
        return this.mcpSnippet();
      case "mcp.writeConfig":
        return this.writeMcpConfig();
      case "lifecycle.ownedPaths":
        return this.ownedPaths();
      case "app.stop":
        return this.stop();
      default:
        throw new Error(`Unknown op ${String(op)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pairing                                                            */
  /* ---------------------------------------------------------------- */

  async submitPairingInvite(input: { inviteText: string }): Promise<GuiState> {
    this.#requireStarted();
    if (this.#hasPairingCompletionCheckpoint()) {
      throw entryError("pairing_state_invalid", "A submitted pairing is still awaiting its exact completion receipt.");
    }
    const invite = parsePairingInviteText(input.inviteText, { now: this.#now });
    if (invite.mode !== "personal") {
      throw entryError("team_not_available", "Account-managed teams require an available paid team subscription.");
    }
    if (invite.endpointPinRef !== invite.endpointSpkiPin) {
      throw entryError("pairing_pin_mismatch", "The account route pin and endpoint TLS pin do not match.");
    }
    this.#pendingPairing?.channel?.close();
    this.#pendingPairing = {
      session: null,
      channel: null,
      invite,
      device: null,
      entryPeerIdentity: null,
      bootstrapRequest: null,
      bootstrap: null,
      authorization: null,
      completion: null,
      completionTask: null,
      checkpointRef: null,
      boundRecoveryKeyId: this.#store.config.recovery?.keyId ?? null
    };
    const sessionId = `pair.pending.${randomBytes(12).toString("base64url")}`;
    this.#apply({ type: "pairing.invite_ready", sessionId, invite: summarizeInvite(invite) });
    if (!await this.#storedAccountCredential()) {
      await this.#startDesktopTransaction({ purpose: "login" });
      return this.snapshot();
    }
    await this.#beginRestrictedPairing();
    return this.snapshot();
  }

  async confirmPairing(): Promise<GuiState> {
    const pending = this.#pendingPairing;
    if (pending?.completion && pending.checkpointRef) return this.#replayPairingCompletion(pending);
    if (!pending?.session) throw entryError("pairing_state_invalid", "No endpoint challenge is awaiting confirmation.");
    if (!pending.authorization) {
      if (!this.#desktopTransaction) await this.#startPairingStepUp(pending);
      this.#apply({ type: "pairing.outcome", phase: "authorization_required" });
      return this.snapshot();
    }
    return this.#completePairing(pending);
  }

  async continuePairing(): Promise<GuiState> {
    if (this.#pendingPairing?.completion && this.#pendingPairing.checkpointRef) {
      return this.#replayPairingCompletion(this.#pendingPairing);
    }
    if (this.#desktopTransaction) return this.checkAccountTransaction();
    const pending = this.#pendingPairing;
    if (!pending) throw entryError("pairing_state_invalid", "No pairing transaction is active.");
    if (pending.authorization) return this.#completePairing(pending);
    const pairingState = pending.session?.snapshot().state;
    if ((!pending.session || pairingState === "offline" || pairingState === "retry_required")
      && await this.#storedAccountCredential()) {
      await this.#beginRestrictedPairing();
    }
    return this.snapshot();
  }

  cancelPairing(): GuiState {
    if (this.#hasPairingCompletionCheckpoint()) {
      this.#pendingPairing?.channel?.close();
      if (this.#pendingPairing) this.#pendingPairing.channel = null;
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: "This submitted pairing must be confirmed or explicitly revoked before it can be cleared."
      });
      return this.snapshot();
    }
    this.#pendingPairing?.session?.cancel();
    this.#pendingPairing?.channel?.close();
    this.#pendingPairing = null;
    this.#desktopTransaction = null;
    this.#apply({ type: "pairing.outcome", phase: "cancelled" });
    this.#apply({ type: "account.updated", account: this.#accountView() });
    return this.snapshot();
  }

  resetPairing(): GuiState {
    if (this.#hasPairingCompletionCheckpoint()) {
      this.#pendingPairing?.channel?.close();
      if (this.#pendingPairing) this.#pendingPairing.channel = null;
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: "This submitted pairing must be confirmed or explicitly revoked before it can be cleared."
      });
      return this.snapshot();
    }
    this.#pendingPairing?.channel?.close();
    this.#pendingPairing = null;
    if (this.#desktopTransaction?.actionPurpose === "pair_device") this.#desktopTransaction = null;
    this.#apply({ type: "pairing.reset" });
    this.#apply({ type: "account.updated", account: this.#accountView() });
    return this.snapshot();
  }

  async beginAccountLogin(): Promise<GuiState> {
    this.#requireStarted();
    if (this.#desktopTransaction?.transaction.purpose === "step_up") {
      throw entryError("account_transaction_pending", "Finish or cancel the current device authorization before signing in again.");
    }
    this.#desktopTransaction = null;
    await this.#startDesktopTransaction({ purpose: "login" });
    return this.snapshot();
  }

  async checkAccountTransaction(): Promise<GuiState> {
    if (this.#pendingVaultWriterRotation?.flow.completeRequest) {
      return this.#submitVaultWriterCompletion(this.#pendingVaultWriterRotation);
    }
    const pending = this.#desktopTransaction;
    if (!pending) throw entryError("account_transaction_missing", "No account browser transaction is waiting.");
    const result = await this.#accountClient().pollTransaction(
      pending.transaction.transactionId,
      pending.transaction.verifier
    );
    if (result.state === "pending") return this.snapshot();
    if (result.state === "expired" || result.state === "consumed") {
      await this.#accountClient().acknowledgeTransaction(pending.transaction.transactionId, pending.transaction.verifier).catch(() => undefined);
      this.#desktopTransaction = null;
      if (pending.claimId && this.#pendingPersonalStepUp?.claimId === pending.claimId) {
        this.#pendingPersonalStepUp.reject(entryError("account_step_up_expired", "The personal route approval expired. Start enrollment again to request a fresh approval."));
        this.#pendingPersonalStepUp = null;
      }
      this.#apply({ type: "account.updated", account: this.#accountView("The account transaction expired; start again.") });
      return this.snapshot();
    }
    if (result.state !== "complete") {
      throw entryError("account_transaction_invalid", "The account worker returned an unsupported transaction state.");
    }
    if (pending.transaction.purpose === "login") {
      if (result.purpose !== "login") throw entryError("account_transaction_mismatch", "The account worker returned a step-up result for a login request.");
      await this.#acceptAccountLogin(result);
      await this.#accountClient().acknowledgeTransaction(pending.transaction.transactionId, pending.transaction.verifier);
      this.#desktopTransaction = null;
      this.#apply({ type: "account.updated", account: this.#accountView() });
      if (this.#pendingPairing && !this.#pendingPairing.session) await this.#beginRestrictedPairing();
      return this.snapshot();
    }
    if (result.purpose !== "step_up"
      || result.actionPurpose !== pending.actionPurpose
      || !isAccountStepUpPermitId(result.permitId)
      || !pending.binding
      || !pending.target
      || canonicalAccountActionTarget(result.target) !== canonicalAccountActionTarget(pending.target)
      || canonicalJson(result.account) !== canonicalJson(pending.binding)) {
      throw entryError("account_step_up_mismatch", "The verified factor result does not match the pending account action.");
    }
    if (pending.actionPurpose === "pair_device") {
      if (pending.claimId !== null) {
        const personal = this.#pendingPersonalStepUp;
        if (!personal || personal.claimId !== pending.claimId
          || canonicalAccountActionTarget(personal.target) !== canonicalAccountActionTarget(result.target)
          || canonicalJson(personal.account) !== canonicalJson(result.account)) {
          throw entryError("account_step_up_mismatch", "The personal endpoint claim no longer matches the pending fresh-factor approval.");
        }
        await this.#accountClient().acknowledgeTransaction(pending.transaction.transactionId, pending.transaction.verifier);
        this.#desktopTransaction = null;
        this.#pendingPersonalStepUp = null;
        this.#apply({ type: "account.updated", account: this.#accountView() });
        personal.resolve({ account: result.account, permitId: result.permitId, target: result.target });
        return this.snapshot();
      }
      const pairing = this.#pendingPairing;
      if (!pairing?.session || !pairing.bootstrap || !pairing.session.snapshot().target
        || pending.bootstrapId !== pairing.bootstrap.bootstrapId) {
        throw entryError("pairing_state_invalid", "The step-up permit is no longer bound to an active pairing challenge.");
      }
      pairing.authorization = {
        account: result.account,
        permitId: result.permitId,
        purpose: "pair_device",
        target: result.target
      };
      return this.#completePairing(pairing);
    }
    if (pending.actionPurpose === "grant_access") {
      const writerRotation = this.#pendingVaultWriterRotation;
      if (writerRotation?.flow.target
        && canonicalAccountActionTarget(writerRotation.flow.target) === canonicalAccountActionTarget(result.target)) {
        return this.#completeVaultWriterRotation(writerRotation, result);
      }
      const grant = this.#pendingGrant;
      if (!grant
        || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= this.#now()
        || canonicalAccountActionTarget(grant.target) !== canonicalAccountActionTarget(pending.target)) {
        throw entryError("grant_target_expired", "The endpoint grant target expired or changed; load the endpoint's grant catalog again.");
      }
      await this.#completeGrantAccess(grant, result);
      return this.snapshot();
    }
    throw entryError("account_action_unavailable", "This account action is not connected to an installed Entry flow.");
  }

  async signOutAccount(): Promise<GuiState> {
    const stored = this.#store.config.account;
    if (stored?.sessionCredentialRef) await this.#custody.deleteSecret({ ref: stored.sessionCredentialRef }).catch(() => undefined);
    this.#desktopTransaction = null;
    this.#pendingPersonalStepUp?.reject(entryError("account_login_required", "Sign in again before completing personal endpoint enrollment."));
    this.#pendingPersonalStepUp = null;
    this.#pendingGrant = null;
    this.#apply({ type: "grant.updated", grant: emptyGrantView("Signed out on this device.") });
    await this.#store.update((draft) => ({
      ...draft,
      account: draft.account ? { ...draft.account, accountId: null, authEpoch: null, sessionCredentialRef: null } : null
    }));
    this.#apply({ type: "account.updated", account: this.#accountView("Signed out on this device.") });
    return this.snapshot();
  }

  openAccountSettings(): GuiState {
    this.#accountClient();
    return this.snapshot();
  }

  async loadGrantCatalog(connectionId: string): Promise<GuiState> {
    this.#requireStarted();
    const connection = this.#requireConnection(connectionId);
    if (connection.rePairRequired || !connection.accountBinding || !connection.endpointDeviceId) {
      throw entryError("account_repair_required", "This connection is not an active account-bound enrollment; pair it again before changing grants.");
    }
    const current = await this.#requireOSAccountSession();
    assertSameAccountBinding(current.account, connection.accountBinding);
    let live = this.#sessions.get(connectionId);
    if (!live?.session.channelEstablished) {
      await this.refreshConnection(connectionId);
      live = this.#sessions.get(connectionId);
    }
    if (!live?.session.channelEstablished) throw entryError("endpoint_unreachable", "The endpoint's pinned channel is not established.");
    const response = await live.session.request({
      jsonrpc: "2.0",
      id: `grant.catalog.${randomBytes(12).toString("base64url")}`,
      method: "meshrix/pairing/grant_catalog",
      params: {}
    });
    if (!isRecord(response) || response.outcome !== "grant_catalog"
      || !isAccountBinding(response.account)
      || response.account.accountId !== current.account.accountId
      || response.account.authEpoch !== current.account.authEpoch
      || response.endpointDeviceId !== connection.endpointDeviceId
      || !Array.isArray(response.availableScopes)
      || !response.availableScopes.every(isScopeName)) {
      throw entryError("grant_catalog_invalid", "The endpoint returned a catalog outside this account-bound route.");
    }
    const availableScopes = [...new Set(response.availableScopes as string[])].sort();
    this.#apply({
      type: "grant.updated",
      grant: {
        connectionId,
        availableScopes,
        targetScopes: [],
        grantRef: null,
        status: "catalog_ready",
        notice: null
      }
    });
    return this.snapshot();
  }

  async requestGrantAccess(input: { connectionId: string; scopes: readonly string[] }): Promise<GuiState> {
    this.#requireStarted();
    const connection = this.#requireConnection(input.connectionId);
    if (this.#desktopTransaction) throw entryError("account_transaction_pending", "Finish the current account action before requesting another grant.");
    if (connection.rePairRequired || !connection.accountBinding || !connection.endpointDeviceId) {
      throw entryError("account_repair_required", "This connection is not an active account-bound enrollment; pair it again before changing grants.");
    }
    const current = await this.#requireOSAccountSession();
    assertSameAccountBinding(current.account, connection.accountBinding);
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0 || scopes.some((scope) => !isScopeName(scope))) {
      throw entryError("grant_scope_invalid", "Choose one or more valid endpoint scopes.");
    }
    const live = this.#sessions.get(input.connectionId);
    if (!live?.session.channelEstablished) throw entryError("endpoint_unreachable", "The endpoint's pinned channel is not established.");
    const catalog = await live.session.request({
      jsonrpc: "2.0",
      id: `grant.catalog.${randomBytes(12).toString("base64url")}`,
      method: "meshrix/pairing/grant_catalog",
      params: {}
    });
    if (!isRecord(catalog) || catalog.outcome !== "grant_catalog"
      || !isAccountBinding(catalog.account)
      || catalog.account.accountId !== current.account.accountId
      || catalog.account.authEpoch !== current.account.authEpoch
      || catalog.endpointDeviceId !== connection.endpointDeviceId
      || !Array.isArray(catalog.availableScopes)
      || !catalog.availableScopes.every(isScopeName)
      || scopes.some((scope) => !(catalog.availableScopes as string[]).includes(scope))) {
      throw entryError("grant_scope_invalid", "The selected scope is not available on this endpoint.");
    }
    const answer = await live.session.request({
      jsonrpc: "2.0",
      id: `grant.target.${randomBytes(12).toString("base64url")}`,
      method: "meshrix/pairing/grant_targets",
      params: { scopes }
    });
    if (!isRecord(answer) || answer.outcome !== "grant_target"
      || !isAccountBinding(answer.account)
      || answer.account.accountId !== current.account.accountId
      || answer.account.authEpoch !== current.account.authEpoch
      || typeof answer.operationId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(answer.operationId)
      || typeof answer.expiresAt !== "string"
      || !Number.isFinite(Date.parse(answer.expiresAt))
      || !isActionTarget(answer.target)
      || answer.target.tenantId !== connection.tenantId
      || answer.target.routeId !== connection.routeId
      || answer.target.deviceId !== connection.deviceId
      || answer.target.grantRef === connection.capabilityGrantRef
      || canonicalAccountActionTarget(answer.target) !== canonicalAccountActionTarget({
        tenantId: connection.tenantId,
        routeId: connection.routeId,
        deviceId: connection.deviceId,
        devicePublicKey: answer.target.devicePublicKey,
        grantRef: answer.target.grantRef,
        scopes
      })) {
      throw entryError("grant_target_invalid", "The endpoint returned a grant target that does not match the selected route and scopes.");
    }
    const deviceIdentity = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: connection.deviceId });
    if (!deviceIdentity || deviceIdentity.publicKey !== answer.target.devicePublicKey) {
      throw entryError("grant_device_mismatch", "The target is not bound to this Entry device key.");
    }
    const pending: PendingGrant = {
      connectionId: connection.connectionId,
      operationId: answer.operationId,
      target: answer.target,
      expiresAt: answer.expiresAt
    };
    this.#pendingGrant = pending;
    await this.#startDesktopTransaction({
      purpose: "step_up",
      actionPurpose: "grant_access",
      binding: current.account,
      target: answer.target
    });
    this.#apply({
      type: "grant.updated",
      grant: {
        connectionId: connection.connectionId,
        availableScopes: [...new Set(catalog.availableScopes as string[])].sort(),
        targetScopes: [...answer.target.scopes],
        grantRef: answer.target.grantRef,
        status: "authorization_required",
        notice: null
      }
    });
    return this.snapshot();
  }

  async #completeGrantAccess(
    pending: PendingGrant,
    authorization: Extract<AccountDesktopTransactionPollResponse, { state: "complete"; purpose: "step_up" }>
  ): Promise<void> {
    const connection = this.#requireConnection(pending.connectionId);
    if (connection.rePairRequired || !connection.accountBinding) {
      throw entryError("account_repair_required", "The account-bound device was revoked; pair it again before changing grants.");
    }
    assertSameAccountBinding(authorization.account, connection.accountBinding);
    let live = this.#sessions.get(pending.connectionId);
    if (!live?.session.channelEstablished) {
      await this.refreshConnection(pending.connectionId);
      live = this.#sessions.get(pending.connectionId);
    }
    if (!live?.session.channelEstablished) {
      throw entryError("endpoint_unreachable", "The endpoint's pinned channel is not established; the same grant operation can be retried.");
    }
    const privateKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: connection.deviceId });
    if (!privateKey) throw entryError("custody_unavailable", "The Entry device signing key is unavailable in OS custody.");
    const transcript = canonicalJson({
      account: authorization.account,
      operationId: pending.operationId,
      purpose: "grant_access",
      target: pending.target
    });
    const signature = signEd25519(privateKey, transcript);
    const answer = await live.session.request({
      jsonrpc: "2.0",
      id: `grant.complete.${randomBytes(12).toString("base64url")}`,
      method: "meshrix/pairing/grant_access",
      params: {
        account: authorization.account,
        operationId: pending.operationId,
        permitId: authorization.permitId,
        purpose: "grant_access",
        target: pending.target,
        signature
      }
    });
    if (!isRecord(answer) || answer.outcome !== "granted"
      || answer.capabilityGrantRef !== pending.target.grantRef
      || !Array.isArray(answer.authorizedScopes)
      || !pending.target.scopes.every((scope) => (answer.authorizedScopes as unknown[]).includes(scope))) {
      throw entryError("grant_access_refused", "The endpoint did not confirm the exact authorized grant.");
    }
    await this.#store.update((draft) => ({
      ...draft,
      connections: draft.connections.map((entry) => entry.connectionId === pending.connectionId
        ? { ...entry, capabilityGrantRef: pending.target.grantRef, accountActionTarget: pending.target }
        : entry)
    }));
    const updated = this.#requireConnection(pending.connectionId);
    this.#apply({ type: "connection.upsert", connection: connectionView(updated, {
      routeState: routeStateOf(live.session.routeState),
      channelEstablished: live.session.channelEstablished,
      acceptsNewWork: live.session.acceptsNewWork
    }) });
    this.#apply({
      type: "grant.updated",
      grant: {
        connectionId: pending.connectionId,
        availableScopes: this.snapshot().grant.availableScopes,
        targetScopes: [...pending.target.scopes],
        grantRef: pending.target.grantRef,
        status: "granted",
        notice: "The endpoint confirmed the new access grant."
      }
    });
    const transaction = this.#desktopTransaction;
    if (transaction) {
      await this.#accountClient().acknowledgeTransaction(
        transaction.transaction.transactionId,
        transaction.transaction.verifier
      );
    }
    this.#desktopTransaction = null;
    this.#pendingGrant = null;
    this.#apply({ type: "account.updated", account: this.#accountView() });
  }

  async retryVaultWriterRegistration(): Promise<GuiState> {
    const pending = this.#pendingVaultWriterRotation;
    if (!pending) throw entryError("account_vault_rotation_invalid", "No account vault writer registration is waiting.");
    if (pending.flow.completeRequest) return this.#submitVaultWriterCompletion(pending);
    if (pending.flow.prepareRequest) return this.#submitVaultWriterPrepare(pending);
    if (!pending.flow.target) throw entryError("account_vault_rotation_invalid", "The account service has not returned a writer target yet.");
    if (!pending.flow.browserTransaction || !this.#desktopTransaction) {
      await this.#startVaultWriterStepUp(pending);
    }
    return this.snapshot();
  }

  async #beginAccountVaultWriterRegistration(
    candidate: PendingRecoverySecret,
    connection: StoredConnection
  ): Promise<void> {
    if (this.#pendingVaultWriterRotation) {
      throw entryError("account_transaction_pending", "An account vault writer operation is already pending.");
    }
    if (!connection.accountBinding || connection.rePairRequired || connection.vaultId !== candidate.vaultId) {
      throw entryError("account_repair_required", "The selected route is not paired under the current account epoch for this vault.");
    }
    const current = await this.#requireOSAccountSession();
    assertSameAccountBinding(current.account, connection.accountBinding);
    const identity = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: connection.deviceId });
    const entryKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: connection.deviceId });
    if (!identity || !entryKey) throw entryError("custody_unavailable", "The current Entry device signing key is unavailable in OS custody.");
    const materialRef = custodyRecoveryKeyRef(candidate.vaultId, candidate.keyId);
    await this.#custody.storeSecret({ ref: materialRef, secret: serializeRecoveryMaterial(candidate.material) });

    const operationId = `vault-writer-${randomBytes(24).toString("base64url")}`;
    const flowRef = `entry-gui.account.vault-writer.${randomBytes(18).toString("hex")}`;
    const writers = [{ keyId: candidate.material.writer.keyId, algorithm: "Ed25519" as const, publicKey: candidate.material.writer.publicKey }];
    const recoveryVerifier = {
      keyId: candidate.material.signing.keyId,
      algorithm: "Ed25519" as const,
      publicKey: candidate.material.signing.publicKey
    };
    const requestDigest = createHash("sha256")
      .update(canonicalAccountVaultWriterRotationInput({ operationId, vaultId: candidate.vaultId, writers, recoveryVerifier }), "utf8")
      .digest("base64url");
    const deviceUnsigned: Omit<AccountDeviceAuthorityProof, "signature"> = {
      purpose: "prepare_vault_writer_rotation",
      tenantId: connection.tenantId,
      routeId: connection.routeId,
      deviceId: connection.deviceId,
      nonce: `entry-device.${randomBytes(24).toString("base64url")}`,
      operationId,
      requestDigest
    };
    const deviceProof: AccountDeviceAuthorityProof = {
      ...deviceUnsigned,
      signature: cryptoSign(null, Buffer.from(accountDeviceAuthorityTranscript(deviceUnsigned), "utf8"), entryKey).toString("base64url")
    };
    const desktopIdentity = await this.#ensureDesktopIdentity();
    const desktopKey = await loadDevicePrivateKey({
      custody: this.#custody,
      deviceId: desktopIdentity.deviceId,
      refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
    });
    if (!desktopKey) throw entryError("account_custody_required", "The desktop account signing key is unavailable in OS custody.");
    const desktopBody = { operationId, vaultId: candidate.vaultId, writers, recoveryVerifier, deviceProof };
    const prepareRequest: AccountDesktopVaultWriterRotationPrepareRequest = {
      ...desktopBody,
      desktopProof: signDesktopAccountProof({
        pathname: ACCOUNT_API_ROUTES.desktopVaultWriterRotationPrepare,
        account: current.account,
        credential: current.credential,
        clientPublicKey: desktopIdentity.publicKey,
        privateKey: desktopKey,
        body: desktopBody
      })
    };
    const pending: PendingVaultWriterRotation = {
      operationId,
      connectionId: connection.connectionId,
      vaultId: candidate.vaultId,
      candidateKeyId: candidate.keyId,
      generation: candidate.generation,
      materialRef,
      flowRef,
      state: "prepare_pending",
      flow: {
        account: current.account,
        prepareRequest,
        target: null,
        expiresAt: null,
        browserTransaction: null,
        completeRequest: null
      }
    };
    this.#pendingVaultWriterRotation = pending;
    await this.#persistVaultWriterRotation(pending);
    this.#pendingRecovery = null;
    this.#apply({ type: "recovery.confirmed" });
    this.#applyVaultWriterRegistrationView();
    await this.#submitVaultWriterPrepare(pending);
  }

  async #submitVaultWriterPrepare(pending: PendingVaultWriterRotation): Promise<GuiState> {
    const request = pending.flow.prepareRequest;
    if (!request || request.operationId !== pending.operationId) {
      throw entryError("account_vault_rotation_invalid", "The exact pending prepare request is unavailable.");
    }
    const response = await this.#accountClient().prepareVaultWriterRotation(request);
    await this.#assertVaultWriterTarget(pending, response);
    pending.state = "authorization_required";
    pending.flow = { ...pending.flow, prepareRequest: null, target: response.target, expiresAt: response.expiresAt };
    await this.#persistVaultWriterRotation(pending);
    await this.#startVaultWriterStepUp(pending);
    this.#applyVaultWriterRegistrationView();
    return this.snapshot();
  }

  async #assertVaultWriterTarget(
    pending: PendingVaultWriterRotation,
    response: AccountDesktopVaultWriterRotationPrepareResponse
  ): Promise<void> {
    const connection = this.#requireConnection(pending.connectionId);
    const targetRotation = response.target.vaultWriterRotation;
    const materialBytes = await this.#custody.loadSecret({ ref: pending.materialRef });
    if (!materialBytes) throw entryError("custody_unavailable", "The saved candidate keys are unavailable for exact target comparison.");
    const material = deserializeRecoveryMaterial(materialBytes);
    const identity = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: connection.deviceId });
    const expectedRotation = {
      vaultId: pending.vaultId,
      generation: pending.generation,
      writers: [{ keyId: material.writer.keyId, algorithm: "Ed25519" as const, publicKey: material.writer.publicKey }],
      recoveryVerifier: { keyId: material.signing.keyId, algorithm: "Ed25519" as const, publicKey: material.signing.publicKey }
    };
    if (response.operationId !== pending.operationId
      || response.account.accountId !== pending.flow.account.accountId
      || response.account.authEpoch !== pending.flow.account.authEpoch
      || response.target.tenantId !== connection.tenantId
      || response.target.routeId !== connection.routeId
      || response.target.deviceId !== connection.deviceId
      || !identity
      || response.target.devicePublicKey !== identity.publicKey
      || !targetRotation
      || canonicalJson(targetRotation) !== canonicalJson(expectedRotation)) {
      throw entryError("account_vault_rotation_invalid", "The account service returned a writer target outside this exact vault and Entry device operation.");
    }
  }

  async #startVaultWriterStepUp(pending: PendingVaultWriterRotation): Promise<void> {
    const target = pending.flow.target;
    const expiresAt = pending.flow.expiresAt;
    if (!target || !expiresAt || Date.parse(expiresAt) <= this.#now()) {
      throw entryError("grant_target_expired", "The account writer target expired; retry registration to prepare a new target.");
    }
    await this.#startDesktopTransaction({
      purpose: "step_up",
      actionPurpose: "grant_access",
      binding: pending.flow.account,
      target
    });
    const transaction = this.#desktopTransaction?.transaction;
    if (transaction) {
      pending.flow = { ...pending.flow, browserTransaction: transaction };
      pending.state = "authorization_required";
      await this.#persistVaultWriterRotation(pending);
    }
  }

  async #completeVaultWriterRotation(
    pending: PendingVaultWriterRotation,
    authorization: Extract<AccountDesktopTransactionPollResponse, { state: "complete"; purpose: "step_up" }>
  ): Promise<GuiState> {
    if (authorization.actionPurpose !== "grant_access"
      || authorization.account.accountId !== pending.flow.account.accountId
      || authorization.account.authEpoch !== pending.flow.account.authEpoch
      || !pending.flow.target
      || canonicalAccountActionTarget(authorization.target) !== canonicalAccountActionTarget(pending.flow.target)) {
      throw entryError("account_step_up_mismatch", "The fresh factor permit does not match the exact vault writer target.");
    }
    if (!pending.flow.completeRequest) {
      const connection = this.#requireConnection(pending.connectionId);
      if (connection.rePairRequired || !connection.accountBinding) {
        throw entryError("account_repair_required", "The paired Entry device was revoked before writer registration completed.");
      }
      assertSameAccountBinding(connection.accountBinding, authorization.account);
      const entryKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: connection.deviceId });
      const desktopIdentity = await this.#ensureDesktopIdentity();
      const desktopKey = await loadDevicePrivateKey({
        custody: this.#custody,
        deviceId: desktopIdentity.deviceId,
        refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
      });
      if (!entryKey || !desktopKey) throw entryError("custody_unavailable", "A required account or Entry signing key is unavailable in OS custody.");
      const deviceUnsigned: Omit<AccountDeviceAuthorityProof, "signature"> = {
        purpose: "complete_vault_writer_rotation",
        tenantId: connection.tenantId,
        routeId: connection.routeId,
        deviceId: connection.deviceId,
        nonce: `entry-device.${randomBytes(24).toString("base64url")}`,
        permitId: authorization.permitId,
        operationId: pending.operationId,
        targetDigest: createHash("sha256").update(canonicalAccountActionTarget(pending.flow.target), "utf8").digest("base64url")
      };
      const deviceProof: AccountDeviceAuthorityProof = {
        ...deviceUnsigned,
        signature: cryptoSign(null, Buffer.from(accountDeviceAuthorityTranscript(deviceUnsigned), "utf8"), entryKey).toString("base64url")
      };
      const current = await this.#requireOSAccountSession();
      assertSameAccountBinding(current.account, authorization.account);
      const desktopBody = {
        operationId: pending.operationId,
        permitId: authorization.permitId,
        target: pending.flow.target,
        keyCustodyConfirmed: true as const,
        deviceProof
      };
      pending.flow = {
        ...pending.flow,
        completeRequest: {
          ...desktopBody,
          desktopProof: signDesktopAccountProof({
            pathname: ACCOUNT_API_ROUTES.desktopVaultWriterRotationComplete,
            account: current.account,
            credential: current.credential,
            clientPublicKey: desktopIdentity.publicKey,
            privateKey: desktopKey,
            body: desktopBody
          })
        }
      };
      pending.state = "completion_pending";
      await this.#persistVaultWriterRotation(pending);
    }
    return this.#submitVaultWriterCompletion(pending);
  }

  async #submitVaultWriterCompletion(pending: PendingVaultWriterRotation): Promise<GuiState> {
    const request = pending.flow.completeRequest;
    if (!request) throw entryError("account_vault_rotation_invalid", "The exact completion request is unavailable for retry.");
    const response = await this.#accountClient().completeVaultWriterRotation(request);
    if (response.account.accountId !== pending.flow.account.accountId
      || response.account.authEpoch !== pending.flow.account.authEpoch
      || response.vaultId !== pending.vaultId
      || response.generation !== pending.generation) {
      throw entryError("account_vault_rotation_invalid", "The writer rotation result does not match its stored account target.");
    }
    if (response.state === "pending") {
      pending.state = "completion_pending";
      pending.flow = { ...pending.flow, browserTransaction: null };
      await this.#persistVaultWriterRotation(pending);
      await this.#ackVaultWriterTransaction();
      this.#applyVaultWriterRegistrationView("Fresh factor authorization is committed. The relay has not acknowledged the writer replacement yet; encrypted snapshot publishing remains fenced.");
      this.#apply({ type: "account.updated", account: this.#accountView("Vault writer replacement is still pending at the relay.") });
      return this.snapshot();
    }
    const materialBytes = await this.#custody.loadSecret({ ref: pending.materialRef });
    if (!materialBytes) throw entryError("custody_unavailable", "The newly saved recovery keys are missing from OS custody; the old vault snapshot remains fenced.");
    const material = deserializeRecoveryMaterial(materialBytes);
    if (material.signing.keyId !== pending.candidateKeyId || material.writer.keyId !== pending.flow.target?.vaultWriterRotation?.writers[0]?.keyId) {
      throw entryError("account_vault_rotation_invalid", "The saved local keys no longer match the approved public writer target.");
    }
    const prior = this.#store.config.recovery;
    const retained = prior?.vaultId === pending.vaultId
      ? [...new Set([
          ...prior.retainedMaterialRefs,
          ...(prior.materialRef === pending.materialRef ? [] : [prior.materialRef])
        ].filter((ref) => ref !== pending.materialRef))]
      : [];
    const snapshotSourceMaterialRef = prior?.vaultId !== pending.vaultId
      ? null
      : prior.materialRef === pending.materialRef
        ? prior.snapshotSourceMaterialRef
        : prior.materialRef;
    await this.#store.update((draft) => ({
      ...draft,
      recovery: {
        vaultId: pending.vaultId,
        keyId: pending.candidateKeyId,
        generation: response.generation,
        materialRef: pending.materialRef,
        confirmedAt: new Date(this.#now()).toISOString(),
        accountWriterState: "complete",
        accountSnapshotState: "unverified",
        snapshotSourceMaterialRef,
        retainedMaterialRefs: retained
      }
    }));
    this.#recoveryMaterial = material;
    await this.#ackVaultWriterTransaction();
    this.#apply({
      type: "recovery.generated",
      vaultId: pending.vaultId,
      keyId: pending.candidateKeyId,
      generation: response.generation
    });
    this.#apply({ type: "recovery.confirmed" });
    this.#apply({ type: "account.updated", account: this.#accountView() });
    const reconciliation = await this.#reconcileAccountVaultSnapshot(pending, material);
    if (reconciliation === "complete" || reconciliation === "preserved") {
      await this.#clearVaultWriterRotation();
    }
    return this.snapshot();
  }

  async #reconcileAccountVaultSnapshot(
    pending: PendingVaultWriterRotation,
    material: RecoveryMaterial
  ): Promise<"complete" | "preserved" | "retry"> {
    const recovery = this.#store.config.recovery;
    if (!recovery || recovery.vaultId !== pending.vaultId) {
      throw entryError("account_vault_rotation_invalid", "The registered vault no longer matches the pending writer operation.");
    }
    const synchronizer = createSnapshotSynchronizer({
      vault: createRecoveryVaultClient({ transport: this.#vaultTransport(this.#defaultServiceBase()) }),
      journal: new ConfigSnapshotJournal(this.#store),
      now: this.#now
    });
    const candidateRefs = [...new Set([
      recovery.snapshotSourceMaterialRef,
      ...recovery.retainedMaterialRefs
    ].filter((ref): ref is string => Boolean(ref && ref !== recovery.materialRef)))];
    const priorMaterials: RecoveryMaterial[] = [];
    for (const ref of candidateRefs) {
      const stored = await this.#custody.loadSecret({ ref });
      if (!stored) continue;
      try {
        priorMaterials.push(deserializeRecoveryMaterial(stored));
      } catch {
        // A damaged or stale local reference cannot authorize a write. Other
        // retained keys are still tried against the same fetched ciphertext.
      }
    }

    const fetched = await synchronizer.fetchSnapshot({
      vaultId: recovery.vaultId,
      material,
      fetchKey: material.signing,
      decryptWith: priorMaterials
    });
    if (fetched.outcome === "snapshot") {
      const published = await synchronizer.publish({
        vaultId: recovery.vaultId,
        bundle: this.#buildBundle(),
        material,
        generation: recovery.generation,
        baseSnapshot: fetched,
        decryptWith: priorMaterials
      });
      await this.#store.flush();
      if (published.outcome === "committed") {
        await this.#store.update((draft) => ({
          ...draft,
          recovery: draft.recovery?.vaultId === recovery.vaultId
            ? { ...draft.recovery, accountSnapshotState: "ready", snapshotSourceMaterialRef: null }
            : draft.recovery
        }));
        this.#apply({
          type: "recovery.backup",
          lastSuccessAt: new Date(this.#now()).toISOString(),
          lastCommittedRevision: published.revision,
          lastError: null
        });
        this.#apply({
          type: "recovery.writerRegistration",
          state: "complete",
          candidateVaultId: pending.vaultId,
          candidateKeyId: pending.candidateKeyId,
          candidateGeneration: recovery.generation,
          detail: "The preserved snapshot was decrypted with a retained local key, merged, and safely published under the new writer."
        });
        return "complete";
      }
      if (published.outcome === "conflict_undecryptable") {
        await this.#persistOlderSnapshotFence(pending, recovery.snapshotSourceMaterialRef,
          "The vault changed during reconciliation and the latest encrypted snapshot could not be verified. Publishing remains fenced.");
        return "retry";
      }
      if (published.outcome === "refused" && published.retryable) {
        this.#apply({ type: "recovery.backup", lastError: "vault_write_capacity: reconciliation pending; retry when capacity is available" });
        this.#apply({ type: "recovery.writerRegistration", state: "service_pending",
          candidateVaultId: pending.vaultId, candidateKeyId: pending.candidateKeyId,
          candidateGeneration: recovery.generation,
          detail: "The writer is registered. The exact encrypted reconciliation remains pending until vault capacity is available." });
        return "retry";
      }
      throw entryError("vault_transport_error", `The preserved snapshot could not be reconciled (${published.outcome}); publishing remains fenced.`);
    }

    if (fetched.outcome === "authority_mismatch" || fetched.outcome === "decrypt_failed") {
      await this.#persistOlderSnapshotFence(pending, recovery.snapshotSourceMaterialRef,
        "The previous encrypted snapshot is preserved, but none of the retained local keys can decrypt it. New publishing is fenced to protect that data.");
      return "preserved";
    }
    if (fetched.outcome === "refused" && fetched.refusal === "not_found"
      && !recovery.snapshotSourceMaterialRef
      && recovery.retainedMaterialRefs.length === 0
      && synchronizer.committedRevision() === 0) {
      const published = await synchronizer.publish({
        vaultId: recovery.vaultId,
        bundle: this.#buildBundle(),
        material,
        generation: recovery.generation
      });
      await this.#store.flush();
      if (published.outcome === "committed") {
        await this.#store.update((draft) => ({
          ...draft,
          recovery: draft.recovery?.vaultId === recovery.vaultId
            ? { ...draft.recovery, accountSnapshotState: "ready", snapshotSourceMaterialRef: null }
            : draft.recovery
        }));
        this.#apply({
          type: "recovery.backup",
          lastSuccessAt: new Date(this.#now()).toISOString(),
          lastCommittedRevision: published.revision,
          lastError: null
        });
        this.#apply({ type: "recovery.writerRegistration", state: "complete", candidateVaultId: pending.vaultId, candidateKeyId: pending.candidateKeyId, candidateGeneration: recovery.generation });
        return "complete";
      }
      throw entryError("vault_transport_error", `The new account vault's first snapshot could not be published (${published.outcome}).`);
    }
    if (fetched.outcome === "stale") {
      throw entryError("snapshot_stale", "The vault returned a snapshot older than Entry's durable revision history; publishing remains fenced.");
    }
    if (fetched.outcome === "refused") {
      throw entryError("vault_refused", `The current vault snapshot could not be fetched (${fetched.refusal}); publishing remains fenced.`);
    }
    throw entryError("vault_unexpected_response", "The current vault snapshot could not be verified; publishing remains fenced.");
  }

  async #persistOlderSnapshotFence(
    pending: PendingVaultWriterRotation,
    sourceMaterialRef: string | null,
    detail: string
  ): Promise<void> {
    await this.#store.update((draft) => ({
      ...draft,
      recovery: draft.recovery?.vaultId === pending.vaultId
        ? { ...draft.recovery, accountSnapshotState: "older_snapshot_preserved", snapshotSourceMaterialRef: sourceMaterialRef }
        : draft.recovery,
      accountVaultWriterOperation: null
    }));
    await this.#custody.deleteSecret({ ref: pending.flowRef }).catch(() => undefined);
    this.#pendingVaultWriterRotation = null;
    this.#apply({
      type: "recovery.writerRegistration",
      state: "older_snapshot_preserved",
      candidateVaultId: pending.vaultId,
      candidateKeyId: pending.candidateKeyId,
      candidateGeneration: pending.generation,
      detail
    });
  }

  async #ackVaultWriterTransaction(): Promise<void> {
    const transaction = this.#desktopTransaction?.transaction ?? this.#pendingVaultWriterRotation?.flow.browserTransaction;
    if (transaction) {
      await this.#accountClient().acknowledgeTransaction(transaction.transactionId, transaction.verifier).catch(() => undefined);
    }
    this.#desktopTransaction = null;
  }

  #accountManagedConnection(vaultId: string): StoredConnection | null {
    const storedAccount = this.#store?.config.account;
    if (!storedAccount?.accountId || !storedAccount.authEpoch) return null;
    return this.#store.config.connections.find((connection) => connection.vaultId === vaultId
      && connection.accountBinding?.accountId === storedAccount.accountId
      && connection.accountBinding.authEpoch === storedAccount.authEpoch
      && !connection.rePairRequired) ?? null;
  }

  #isAccountManagedVault(vaultId: string): boolean {
    const recovery = this.#store?.config.recovery;
    return (recovery?.vaultId === vaultId && recovery.accountWriterState !== "unmanaged")
      || this.#store?.config.connections.some((connection) => connection.vaultId === vaultId && connection.accountBinding !== null) === true;
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                               */
  /* ---------------------------------------------------------------- */

  async refreshConnection(connectionId: string): Promise<GuiState> {
    this.#clearConnectionReconnect(connectionId);
    return this.#refreshConnectionAttempt(connectionId);
  }

  #clearConnectionReconnect(connectionId: string): void {
    const pending = this.#connectionReconnects.get(connectionId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.#connectionReconnects.delete(connectionId);
  }

  #scheduleConnectionReconnect(connectionId: string, generation: number): void {
    if (!this.#started || this.#connectionGenerations.get(connectionId) !== generation) return;
    const stored = this.#store.config.connections.find((connection) => connection.connectionId === connectionId);
    if (!stored || stored.rePairRequired) return;

    const state = this.#connectionReconnects.get(connectionId) ?? {
      attempts: 0,
      generation,
      timer: null
    };
    if (state.timer) return;
    state.generation = generation;
    const delay = Math.min(
      CONNECTION_RECONNECT_MAX_DELAY_MS,
      CONNECTION_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(state.attempts, 5)
    );
    state.attempts += 1;
    state.timer = setTimeout(() => {
      if (this.#connectionReconnects.get(connectionId) !== state) return;
      state.timer = null;
      if (!this.#started || this.#connectionGenerations.get(connectionId) !== state.generation) {
        this.#clearConnectionReconnect(connectionId);
        return;
      }
      void this.#refreshConnectionAttempt(connectionId).catch(() => {
        this.#clearConnectionReconnect(connectionId);
      });
    }, delay);
    state.timer.unref?.();
    this.#connectionReconnects.set(connectionId, state);
  }

  #retryConnectionAfterFailure(connectionId: string, generation: number, expectedRevocationRevision?: number): void {
    const current = this.#store.config.connections.find((connection) => connection.connectionId === connectionId);
    const update = current && expectedRevocationRevision !== undefined
      && expectedRevocationRevision > current.revocationRevision
      ? this.#store.update((draft) => ({
          ...draft,
          connections: draft.connections.map((connection) => connection.connectionId === connectionId
            ? { ...connection, revocationRevision: expectedRevocationRevision }
            : connection)
        }))
      : Promise.resolve();
    void update.catch(() => undefined).finally(() => this.#scheduleConnectionReconnect(connectionId, generation));
  }

  async #refreshConnectionAttempt(connectionId: string): Promise<GuiState> {
    this.#requireStarted();
    const stored = this.#requireConnection(connectionId);
    const generation = (this.#connectionGenerations.get(connectionId) ?? 0) + 1;
    this.#connectionGenerations.set(connectionId, generation);
    const pendingReconnect = this.#connectionReconnects.get(connectionId);
    if (pendingReconnect) pendingReconnect.generation = generation;
    const isCurrentGeneration = () => this.#connectionGenerations.get(connectionId) === generation;
    const previous = this.#sessions.get(connectionId);
    if (previous) this.#peers.get(connectionId)?.onSessionClosed();
    try {
      previous?.session.close("normal");
    } catch {
      try { previous?.transport.close(); } catch { /* the retired transport may already be terminal */ }
    }

    if (stored.rePairRequired) {
      this.#clearConnectionReconnect(connectionId);
      this.#unbindEntryApplicationPeer(connectionId);
      this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      this.#notice(`Connection ${connectionId} was invalidated by account recovery or epoch change; pair this device again.`);
      return this.snapshot();
    }

    const credential = await this.#custody.loadSecret({ ref: stored.relayCredentialRef });
    if (!credential) {
      this.#clearConnectionReconnect(connectionId);
      this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      this.#notice(`Connection ${connectionId} has no relay credential in custody; re-pairing is required.`);
      return this.snapshot();
    }
    const deviceKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: stored.deviceId });
    if (!isCurrentGeneration()) return this.snapshot();
    if (!deviceKey) {
      this.#clearConnectionReconnect(connectionId);
      this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      this.#notice(`Connection ${connectionId} lost its device key; re-pair or recover.`);
      return this.snapshot();
    }

    const certificate = issueDeviceCertificate({
      publicKeyRaw: rawEd25519Public(deviceKey),
      sign: custodyDeviceSigner(deviceKey),
      subject: `meshrix-entry ${stored.deviceId}`
    });
    const url = buildRelaySessionUrl(stored.relayService, stored.tenantId, stored.routeId);
    const headers = { authorization: `Bearer ${new TextDecoder().decode(credential)}` };
    const admission: RelayAdmissionInput = {
      tenantId: stored.tenantId,
      deviceId: stored.deviceId,
      routeId: stored.routeId,
      role: "entry",
      mode: stored.mode,
      admissionGeneration: stored.admissionGeneration,
      revocationRevision: stored.revocationRevision
    };
    const transport = this.#options.transportFactory?.({ url, headers })
      ?? createWssRelayTransport({ url, headers, allowInsecureLoopback: allowLoopback(url) });
    // Own readiness immediately: refresh/stop can retire this generation while
    // local Peer state is still opening. Keep the original promise unchanged;
    // session.connect() below still receives and reports its actual failure.
    void transport.ready?.catch(() => undefined);
    const sessionOptions: EntrySessionOptions = {
      transport,
      admission,
      innerTls: {
        key: deviceKey.export({ format: "pem", type: "pkcs8" }),
        cert: certificate.certPem,
        pinnedPeerSpki: [stored.endpointSpkiPin],
        handshakeTimeoutMs: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      },
      connectTimeoutMs: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      operationPrincipal: { principalRef: stored.endpointPrincipalRef, generation: this.#store.config.recovery?.generation ?? 1 },
      onRouteState: (_routeId, state) => {
        if (!isCurrentGeneration()) return;
        this.#apply({ type: "connection.state", connectionId, routeState: routeStateOf(state) });
        if (state === "reachable") {
          void this.#applicationEngine?.resume();
          void this.#refreshApplicationsView(true).catch(() => undefined);
        } else {
          void this.#refreshApplicationsView(false).catch(() => undefined);
        }
      },
      onClosed: () => {
        if (!isCurrentGeneration()) return;
        this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
        void this.#refreshApplicationsView(false).catch(() => undefined);
      },
      onChannelLost: () => {
        if (!isCurrentGeneration()) return;
        this.#apply({ type: "connection.state", connectionId, channelEstablished: false, acceptsNewWork: false });
        void this.#refreshApplicationsView(false).catch(() => undefined);
      }
    };
    const session = this.#options.sessionFactory?.(sessionOptions)
      ?? new EntryRelaySession(sessionOptions);
    const bridge = createEntryMcpBridge({ session });
    this.#sessions.set(connectionId, { session, transport, bridge });
    // Optional peer runtime: a store fault never blocks the relay session —
    // peer ops report the error honestly instead of wedging the connection.
    let peer: EntryPeerRuntime | null = null;
    try {
      peer = await this.#peerRuntimeFor(stored);
    } catch (error) {
      this.#notice(`Peer messaging failed to initialize for ${connectionId}: ${errorCode(error)}.`);
    }
    if (!isCurrentGeneration()) {
      try { session.close("normal"); } catch { /* superseded session */ }
      try { transport.close(); } catch { /* superseded transport */ }
      return this.snapshot();
    }
    if (peer) {
      peer.attachChannel((message) => transport.send(message));
    }
    attachTransport(
      transport,
      session,
      peer,
      isCurrentGeneration,
      (expectedRevision) => this.#retryConnectionAfterFailure(connectionId, generation, expectedRevision)
    );

    // connect() resolves only when the pinned inner channel is live; an
    // offline endpoint leaves the session admitted-but-unlinked — the view
    // updates whenever the handshake finishes or the budget lapses.
    this.#apply({ type: "connection.state", connectionId, routeState: "unknown", channelEstablished: false, acceptsNewWork: false });
    void session.connect()
      .then(() => {
        if (!isCurrentGeneration()) return;
        this.#clearConnectionReconnect(connectionId);
        this.#apply({
          type: "connection.state",
          connectionId,
          routeState: routeStateOf(session.routeState),
          channelEstablished: session.channelEstablished,
          acceptsNewWork: session.acceptsNewWork
        });
        void this.#applicationEngine?.resume();
        void this.#refreshApplicationsView(true).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!isCurrentGeneration()) return;
        this.#apply({ type: "connection.state", connectionId, channelEstablished: false, acceptsNewWork: false });
        // A socket can fail while local Peer state is opening, before transport
        // handlers attach. Its original ready rejection is the missed close's
        // recovery signal. Other failures (including admission/pin rejection)
        // retain their own terminal or explicit recovery policy.
        if (errorCode(error) === "entry_transport_open_failed") {
          peer?.onSessionClosed();
          this.#retryConnectionAfterFailure(connectionId, generation);
        }
        if (!this.#connectionReconnects.has(connectionId)) {
          this.#notice(`Connection ${connectionId} did not establish its pinned channel (${errorCode(error)}).`);
        }
      });
    return this.snapshot();
  }

  /** The live MCP bridge for a connection (main-process only). */
  bridgeFor(connectionId: string): EntryMcpBridge | null {
    return this.#sessions.get(connectionId)?.bridge ?? null;
  }

  async disconnectConnection(input: { connectionId: string }): Promise<GuiState> {
    this.#requireStarted();
    this.#requireConnection(input.connectionId);
    await this.#closeConnectionLocally(input.connectionId);
    this.#apply({ type: "connection.state", connectionId: input.connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
    this.#notice(`Connection ${input.connectionId} disconnected. Pairing, credentials, task history and route data remain available for reconnect.`);
    await this.#refreshApplicationsView(false).catch(() => undefined);
    return this.snapshot();
  }

  async revokeConnection(input: { connectionId: string; remote?: boolean }): Promise<GuiState> {
    this.#requireStarted();
    const stored = this.#requireConnection(input.connectionId);
    if (input.remote !== true) return this.disconnectConnection({ connectionId: input.connectionId });

    if (stored.mode === "personal" && stored.accountBinding && stored.endpointDeviceId) {
      const { account, credential } = await this.#requireOSAccountSession();
      if (account.accountId !== stored.accountBinding.accountId) {
        throw entryError("account_binding_mismatch", "Sign in to the account that owns this paired device before revoking it.");
      }
      const desktop = await this.#ensureDesktopIdentity();
      const privateKey = await loadDevicePrivateKey({
        custody: this.#custody,
        deviceId: desktop.deviceId,
        refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
      });
      if (!privateKey) throw entryError("account_custody_required", "The desktop account signing key is unavailable in OS custody.");
      let current = stored;
      if (!current.routeRevocation) {
        const routeRevocation = {
          operationId: `device-revoke.${randomBytes(18).toString("base64url")}`,
          target: "device" as const,
          authorityRevoked: false,
          enforcement: "pending" as const
        };
        await this.#store.update((draft) => ({
          ...draft,
          connections: draft.connections.map((entry) => entry.connectionId === input.connectionId
            ? { ...entry, routeRevocation, rePairRequired: true }
            : entry)
        }));
        await this.#store.flush();
        current = this.#requireConnection(input.connectionId);
      }
      await this.#closeConnectionLocally(input.connectionId);
      this.#apply({
        type: "connection.state",
        connectionId: input.connectionId,
        routeState: "unreachable",
        channelEstablished: false,
        acceptsNewWork: false,
        rePairRequired: true,
        revocation: current.routeRevocation?.authorityRevoked
          ? current.routeRevocation.enforcement === "complete" ? "remote_applied" : "enforcement_pending"
          : "authority_pending"
      });
      const operation = current.routeRevocation!;
      if (operation.authorityRevoked && operation.enforcement === "complete") return this.snapshot();
      try {
        const receipt = await this.#accountClient().revokeDevice({
          operationId: operation.operationId,
          tenantId: current.tenantId,
          routeId: current.routeId,
          deviceId: current.deviceId,
          account,
          credential,
          clientPublicKey: desktop.publicKey,
          privateKey
        });
        if (receipt.target !== "device") {
          throw entryError("account_device_revoke_invalid", "The account service returned a route-wide revoke for a device-only action.");
        }
        await this.#store.update((draft) => ({
          ...draft,
          connections: draft.connections.map((entry) => entry.connectionId === input.connectionId
            ? {
                ...entry,
                routeRevocation: {
                  operationId: operation.operationId,
                  target: "device",
                  authorityRevoked: true,
                  enforcement: receipt.enforcement
                },
                rePairRequired: true
              }
            : entry)
        }));
        await this.#store.flush();
      } catch (error) {
        this.#notice("The account authority has not confirmed this device revoke. The same operation is saved and can be retried without creating another request.");
        throw error;
      }
      const updated = this.#requireConnection(input.connectionId);
      this.#apply({ type: "connection.upsert", connection: connectionView(updated, { routeState: "unreachable", channelEstablished: false, acceptsNewWork: false }) });
      this.#notice(updated.routeRevocation?.enforcement === "complete"
        ? "The account authority revoked this device and relay enforcement is complete. Task history and pairing data are retained."
        : "The account authority revoked this device. Relay enforcement is pending; the operation can be retried safely. Task history and pairing data are retained.");
      await this.#refreshApplicationDestinations();
      await this.#refreshApplicationsView(false);
      return this.snapshot();
    }

    if (stored.mode === "personal" && !stored.accountBinding) {
      throw entryError("account_binding_missing", "This personal device has no current account binding; reconnect or pair it with the owning account before revoking it.");
    }

    const live = this.#sessions.get(input.connectionId);
    await this.#closeConnectionLocally(input.connectionId);

    let remoteRevocation: StoredConnection["remoteRevocation"] = "pending";
    if (input.remote && stored.pairingService) {
      try {
        const channel = this.#pairingChannel(stored.pairingService);
        const answer = await channel.revokeDevice?.({ deviceId: stored.deviceId });
        remoteRevocation = answer?.revoked === true ? "applied" : "pending";
      } catch {
        remoteRevocation = "pending";
      }
    }
    await this.#store.update((draft) => ({
      ...draft,
      connections: draft.connections.map((entry) => entry.connectionId === input.connectionId
        ? { ...entry, remoteRevocation, rePairRequired: true }
        : entry)
    }));
    await this.#store.flush();
    this.#apply({
      type: "connection.upsert",
      connection: connectionView(this.#requireConnection(input.connectionId), { routeState: "unreachable", channelEstablished: false, acceptsNewWork: false })
    });
    this.#notice(
      remoteRevocation === "applied"
        ? "Connection revoked locally; remote enforcement confirmed. Pairing data and accepted task history are retained."
        : "Connection is disabled locally; remote enforcement is pending. Pairing data and accepted task history are retained."
    );
    return this.snapshot();
  }

  async #closeConnectionLocally(connectionId: string): Promise<void> {
    this.#clearConnectionReconnect(connectionId);
    this.#connectionGenerations.set(connectionId, (this.#connectionGenerations.get(connectionId) ?? 0) + 1);
    this.#unbindEntryApplicationPeer(connectionId);
    const peer = this.#peers.get(connectionId);
    if (peer) {
      try { await peer.close(); } catch { /* the route may already be closed */ }
      this.#peers.delete(connectionId);
    }
    const live = this.#sessions.get(connectionId);
    try { live?.session.close("normal"); } catch { /* the transport may already be closed */ }
    try { live?.transport.close(); } catch { /* the transport may already be closed */ }
    this.#sessions.delete(connectionId);
  }

  /* ---------------------------------------------------------------- */
  /* Recovery — setup, reveal-once, import, rotation                    */
  /* ---------------------------------------------------------------- */

  beginRecoverySetup(): GuiState {
    this.#requireStarted();
    this.#discardExpiredRecoveryCandidate();
    if (this.#store.config.recovery) {
      throw entryError("recovery_state_invalid", "A recovery key is already configured; begin a rotation instead.");
    }
    if (this.#pendingRecovery) {
      throw entryError("recovery_state_invalid", "A recovery key candidate is already awaiting save confirmation; cancel it before generating another.");
    }
    const accountVault = this.#store.config.connections.find((connection) => connection.vaultId
      && connection.accountBinding && !connection.rePairRequired);
    const vaultId = accountVault?.vaultId ?? this.#store.config.connections.find((connection) => connection.vaultId)?.vaultId
      ?? `vault.entry.${randomBytes(9).toString("base64url")}`;
    const key = generateRecoveryKey({ vaultId });
    const material = deriveRecoveryMaterial(key.secret);
    this.#pendingRecovery = {
      recoveryText: formatRecoveryText(key),
      material,
      vaultId,
      keyId: material.signing.keyId,
      generation: 1,
      rotationId: null,
      priorView: this.snapshot().recovery,
      revealed: false,
      confirmation: null,
      expiresAt: this.#now() + MAX_RECOVERY_SECRET_WINDOW_MS
    };
    this.#apply({ type: "recovery.generated", vaultId, keyId: material.signing.keyId, generation: 1 });
    return this.snapshot();
  }

  /**
   * The one-shot reveal: returns the recovery text exactly once per pending
   * key, inside a bounded time window. The text is never persisted, never
   * placed into state, and cleared on confirmation.
   */
  revealRecoveryKey(): { recoveryText: string; vaultId: string; keyId: string } {
    const pending = this.#pendingRecovery;
    if (!pending) {
      throw entryError("recovery_state_invalid", "No recovery key is pending save confirmation.");
    }
    if (pending.revealed) {
      throw entryError("recovery_state_invalid", "The recovery text was already revealed once; it cannot be shown again.");
    }
    if (pending.expiresAt <= this.#now()) {
      // The candidate dies with the window — a rotation bound to it can never
      // reach publication. Abort it rather than leaving a record that blocks
      // every future rotation forever.
      this.#abandonPendingRotation(pending);
      this.#pendingRecovery = null;
      this.#apply({ type: "recovery.candidateCancelled", recovery: pending.priorView });
      throw entryError("recovery_state_invalid", "The recovery key save window expired; generate a fresh key.");
    }
    pending.revealed = true;
    this.#apply({ type: "recovery.revealed" });
    return { recoveryText: pending.recoveryText, vaultId: pending.vaultId, keyId: pending.keyId };
  }

  confirmRecoverySaved(): Promise<GuiState> {
    const pending = this.#pendingRecovery;
    if (!pending || !pending.revealed) {
      return Promise.reject(entryError("recovery_state_invalid", "The recovery text must be revealed and saved before confirmation."));
    }
    if (pending.confirmation) return pending.confirmation;
    const confirmation = this.#confirmRecoverySaved(pending);
    pending.confirmation = confirmation;
    void confirmation.catch(() => {
      if (this.#pendingRecovery === pending && pending.confirmation === confirmation) pending.confirmation = null;
    });
    return confirmation;
  }

  async #confirmRecoverySaved(pending: PendingRecoverySecret): Promise<GuiState> {
    if (this.#pendingRecovery !== pending) {
      throw entryError("recovery_state_invalid", "This recovery-key candidate is no longer active.");
    }
    const managedConnection = this.#accountManagedConnection(pending.vaultId);
    if (managedConnection || this.#isAccountManagedVault(pending.vaultId)) {
      if (!managedConnection) {
        throw entryError("account_repair_required", "Pair a current account-authorized device before registering vault backup keys.");
      }
      await this.#beginAccountVaultWriterRegistration(pending, managedConnection);
      return this.snapshot();
    }
    const materialRef = custodyRecoveryKeyRef(pending.vaultId, pending.keyId);
    await this.#custody.storeSecret({ ref: materialRef, secret: serializeRecoveryMaterial(pending.material) });
    this.#recoveryMaterial = pending.material;
    const rotationId = pending.rotationId;
    await this.#store.update((draft) => ({
      ...draft,
      recovery: {
        vaultId: pending.vaultId,
        keyId: pending.keyId,
        generation: pending.generation,
        materialRef,
        confirmedAt: new Date(this.#now()).toISOString(),
        accountWriterState: "unmanaged",
        accountSnapshotState: "ready",
        snapshotSourceMaterialRef: null,
        retainedMaterialRefs: retainedRecoveryRefs(this.#store.config.recovery, pending.vaultId, materialRef)
      }
    }));
    // The text is cleared here — the root secret is never at rest.
    this.#pendingRecovery = null;
    this.#apply({ type: "recovery.confirmed" });
    if (rotationId) {
      this.#rotationManager.markPublished(rotationId);
      // Endpoints that acknowledged before publication still count — a late
      // mark keeps the completion check exhaustive.
      const rotation = this.#rotationManager.get(rotationId);
      if (rotation && rotation.endpoints.every((entry) => entry.state === "acknowledged")) {
        this.#rotationManager.markEndpoint(rotationId, rotation.endpoints[0].endpointRouteId, "acknowledged");
      }
      this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(rotationId) });
    }
    await this.publishSnapshot();
    return this.snapshot();
  }

  /** Publish the current bundle to the vault (automatic encrypted backup). */
  publishSnapshot(): Promise<GuiState> {
    // Concurrent triggers share publication. If configuration changed during
    // successful work, publish that new intent before resolving them. Capacity
    // or terminal errors stop here and await an explicit future publication.
    if (this.#snapshotPublication) return this.#snapshotPublication;
    const intent = () => canonicalJson({
      recovery: this.#store.config.recovery,
      bundle: { ...this.#buildBundle(), createdAt: undefined }
    });
    const publication = (async () => {
      let state: GuiState;
      let submitted: string;
      do {
        submitted = intent();
        state = await this.#publishSnapshot();
      } while (!state.recovery.backup.lastError && submitted !== intent());
      return state;
    })();
    this.#snapshotPublication = publication;
    void publication.finally(() => {
      if (this.#snapshotPublication === publication) this.#snapshotPublication = null;
    }).catch(() => undefined);
    return publication;
  }

  async #publishSnapshot(): Promise<GuiState> {
    const recovery = this.#store.config.recovery;
    const material = this.#recoveryMaterial;
    if (!recovery || !material) return this.snapshot();
    if (this.#store.config.accountVaultWriterOperation || recovery.accountWriterState === "pending") {
      this.#apply({
        type: "recovery.backup",
        lastError: "Account-managed writer registration is pending; the existing encrypted snapshot is preserved and publishing is fenced."
      });
      return this.snapshot();
    }
    if (this.#isAccountManagedVault(recovery.vaultId)) {
      const activeConnection = this.#accountManagedConnection(recovery.vaultId);
      if (!activeConnection || recovery.accountWriterState !== "complete") {
        this.#apply({
          type: "recovery.backup",
          lastError: "Account recovery revoked the previous vault writer. Re-pair this device and explicitly register new keys before publishing."
        });
        return this.snapshot();
      }
      if (recovery.accountSnapshotState !== "ready") {
        const detail = recovery.accountSnapshotState === "older_snapshot_preserved"
          ? "The older encrypted snapshot is preserved. Entry cannot verify it with retained local keys, so publishing remains fenced."
          : "The new writer is registered, but the existing snapshot has not been reconciled yet; publishing remains fenced.";
        this.#apply({ type: "recovery.backup", lastError: detail });
        this.#apply({
          type: "recovery.writerRegistration",
          state: recovery.accountSnapshotState === "older_snapshot_preserved" ? "older_snapshot_preserved" : "service_pending",
          candidateVaultId: recovery.vaultId,
          candidateKeyId: recovery.keyId,
          candidateGeneration: recovery.generation,
          detail
        });
        return this.snapshot();
      }
    }
    const bundle = this.#buildBundle();
    const synchronizer = createSnapshotSynchronizer({
      vault: createRecoveryVaultClient({ transport: this.#vaultTransport(this.#defaultServiceBase()) }),
      journal: new ConfigSnapshotJournal(this.#store),
      now: this.#now
    });
    const outcome = await synchronizer.publish({
      vaultId: recovery.vaultId,
      bundle,
      material,
      generation: recovery.generation
    });
    switch (outcome.outcome) {
      case "committed":
        this.#apply({ type: "recovery.backup", lastSuccessAt: new Date(this.#now()).toISOString(), lastCommittedRevision: outcome.revision, lastError: null });
        break;
      case "conflict_unresolved":
      case "conflict_undecryptable":
        this.#apply({ type: "recovery.backup", lastError: `vault conflict at revision ${outcome.currentRevision}` });
        if (outcome.outcome === "conflict_undecryptable" && recovery.accountWriterState === "complete") {
          await this.#store.update((draft) => ({
            ...draft,
            recovery: draft.recovery?.vaultId === recovery.vaultId
              ? { ...draft.recovery, accountSnapshotState: "older_snapshot_preserved" }
              : draft.recovery
          }));
          this.#apply({
            type: "recovery.writerRegistration",
            state: "older_snapshot_preserved",
            detail: `The previous encrypted snapshot at revision ${outcome.currentRevision} remains unchanged; the new key cannot decrypt it.`
          });
        }
        break;
      case "superseded":
        this.#apply({ type: "recovery.backup", lastError: `snapshot generation superseded (vault at generation ${outcome.generation})` });
        break;
      case "refused":
        this.#apply({ type: "recovery.backup", lastError: outcome.retryable
          ? "vault_write_capacity: backup pending; retry publication when capacity is available"
          : "vault_write_refused: backup publication was not authorized" });
        break;
      default:
        this.#apply({ type: "recovery.backup", lastError: `snapshot publish ${outcome.outcome}` });
    }
    return this.snapshot();
  }

  async importRecoveryText(input: { recoveryText: string; serviceUrl?: string }): Promise<GuiState> {
    this.#requireStarted();
    this.#apply({ type: "recoveryImport.phase", phase: "working" });
    try {
      const parsed = parseRecoveryText(input.recoveryText);
      if (!parsed.vaultId) {
        throw entryError("recovery_locator_missing", "The recovery text carries no vault locator.");
      }
      const serviceBase = input.serviceUrl ?? this.#store.config.pairingServiceDefault;
      if (!serviceBase) {
        throw entryError("recovery_locator_missing", "Fresh-install recovery needs the endpoint service address (relay/vault base URL).");
      }
      const pairing = this.#pairingChannel(serviceBase);
      if (!pairing.recoveryAccess) {
        throw entryError("endpoint_unreachable", "The endpoint surface does not expose recovery access provisioning.");
      }
      // The endpoint admin retires the lost device's slot and issues a
      // fresh-device relay credential for the vault's owning route — the
      // fresh deviceId is fixed BEFORE recoverFreshProfile mints its key.
      const access = await pairing.recoveryAccess({ vaultId: parsed.vaultId });
      if (access.outcome !== "issued") {
        throw entryError("endpoint_refused", `Recovery access refused: ${access.refusal}`);
      }
      // A stop() landing mid-await must not leave a channel created after the
      // open-channel set was already closed — guard before every creation.
      this.#requireStarted();
      const channel = this.#options.recoveryChannelFactory?.({
        relaySessionUrl: buildRelaySessionUrl(serviceBase, access.tenantId, access.routeId),
        admission: {
          tenantId: access.tenantId,
          deviceId: access.deviceId,
          routeId: access.routeId,
          role: "entry",
          mode: "personal",
          admissionGeneration: access.admissionGeneration,
          revocationRevision: access.revocationRevision
        },
        headers: { authorization: `Bearer ${access.relayCredential}` }
      }) ?? createEntryRecoveryChannel(this.#recoveryChannelOptions({
        relaySessionUrl: buildRelaySessionUrl(serviceBase, access.tenantId, access.routeId),
        admission: {
          tenantId: access.tenantId,
          deviceId: access.deviceId,
          routeId: access.routeId,
          role: "entry",
          mode: "personal",
          admissionGeneration: access.admissionGeneration,
          revocationRevision: access.revocationRevision
        },
        headers: { authorization: `Bearer ${access.relayCredential}` }
      }));
      this.#openRecoveryChannels.add(channel);
      const recoveryService = createEntryRecoveryService({
        synchronizer: createSnapshotSynchronizer({
          vault: createRecoveryVaultClient({ transport: this.#vaultTransport(serviceBase) }),
          journal: new InMemorySnapshotJournal(),
          now: this.#now
        }),
        endpoint: lazyRecoveryEndpoint(channel),
        custody: this.#custody,
        now: this.#now
      });
      try {
        const outcome = await recoveryService.recoverFreshProfile({
          recoveryText: input.recoveryText,
          custody: this.#custody,
          deviceId: access.deviceId,
          routeId: access.routeId
        });
        switch (outcome.outcome) {
          case "refused":
            this.#apply({ type: "recoveryImport.phase", phase: "refused", detail: outcome.refusal });
            break;
          case "snapshot_missing":
            this.#apply({ type: "recoveryImport.phase", phase: "snapshot_missing" });
            break;
          case "snapshot_unusable":
            this.#apply({ type: "recoveryImport.phase", phase: "snapshot_unusable", detail: outcome.reason });
            break;
          case "enrolled": {
            const connection = outcome.connection;
            const device = outcome.device;
            const connectionId = `conn.${device.deviceId.toLowerCase().replace(/[^a-z0-9]/gu, ".")}`;
            const relayCredentialRef = custodyRelayRef(connectionId);
            await this.#custody.storeSecret({ ref: relayCredentialRef, secret: new TextEncoder().encode(access.relayCredential) });
            const stored: StoredConnection = {
              connectionId,
              displayLabel: `${connection.principalRef} @ ${connection.routeId}`,
              tenantId: connection.tenantId,
              routeId: connection.routeId,
              mode: connection.mode,
              endpointPrincipalRef: connection.principalRef,
              endpointDeviceId: null,
              endpointPeerIdentity: null,
              endpointSpkiPin: connection.endpointSpkiPin,
              relayService: connection.relayService,
              vaultId: connection.vaultId,
              deviceId: device.deviceId,
              deviceFingerprint: device.fingerprint,
              capabilityGrantRef: "none",
              relayCredentialRef,
              boundRecoveryKeyId: connection.recoveryAuthority?.keyId ?? null,
              pairingService: serviceBase,
              admissionGeneration: outcome.admissionGeneration,
              revocationRevision: access.revocationRevision,
              enrolledAt: new Date(this.#now()).toISOString(),
              remoteRevocation: "none",
              routeRevocation: null,
              accountBinding: null,
              rePairRequired: false
            };
            const material = deriveRecoveryMaterial(parsed.secret);
            const materialRef = custodyRecoveryKeyRef(connection.vaultId, material.signing.keyId);
            await this.#custody.storeSecret({ ref: materialRef, secret: serializeRecoveryMaterial(material) });
            this.#recoveryMaterial = material;
            await this.#store.update((draft) => ({
              ...draft,
              connections: [...draft.connections.filter((entry) => entry.connectionId !== connectionId), stored],
              recovery: {
                vaultId: connection.vaultId,
                keyId: material.signing.keyId,
                generation: outcome.generation,
                materialRef,
                confirmedAt: new Date(this.#now()).toISOString(),
                accountWriterState: "unmanaged",
                accountSnapshotState: "ready",
                snapshotSourceMaterialRef: null,
                retainedMaterialRefs: []
              },
              pairingServiceDefault: draft.pairingServiceDefault ?? serviceBase
            }));
            this.#apply({ type: "recoveryImport.phase", phase: "enrolled", enrolledConnectionId: connectionId });
            this.#apply({
              type: "recovery.imported",
              vaultId: connection.vaultId,
              keyId: material.signing.keyId,
              generation: outcome.generation,
              connection: connectionView(stored)
            });
            void this.refreshConnection(connectionId).catch(() => undefined);
            break;
          }
        }
      } finally {
        this.#openRecoveryChannels.delete(channel);
        channel.close();
      }
      return this.snapshot();
    } catch (error) {
      const detail = isEntryError(error) ? String(error.code) : (error as Error).message;
      this.#apply({ type: "recoveryImport.phase", phase: "error", detail });
      return this.snapshot();
    }
  }

  async beginRecoveryRotation(): Promise<GuiState> {
    this.#requireStarted();
    this.#discardExpiredRecoveryCandidate();
    const recovery = this.#store.config.recovery;
    const material = this.#recoveryMaterial;
    if (!recovery || !material) {
      throw entryError("recovery_state_invalid", "No active recovery key to rotate.");
    }
    if (this.#pendingRecovery) {
      throw entryError("recovery_state_invalid", "A recovery key candidate is already awaiting save confirmation; cancel it before generating another.");
    }
    if (this.#isAccountManagedVault(recovery.vaultId)) {
      if (this.#pendingVaultWriterRotation || this.#store.config.accountVaultWriterOperation) {
        throw entryError("account_transaction_pending", "Finish the existing vault writer registration before generating another key.");
      }
      if (!this.#accountManagedConnection(recovery.vaultId)) {
        throw entryError("account_repair_required", "Re-pair a device under the current account epoch before re-enrolling this vault.");
      }
      const key = generateRecoveryKey({ vaultId: recovery.vaultId });
      const candidate = deriveRecoveryMaterial(key.secret);
      this.#pendingRecovery = {
        recoveryText: formatRecoveryText(key),
        material: candidate,
        vaultId: recovery.vaultId,
        keyId: candidate.signing.keyId,
        generation: recovery.generation + 1,
        rotationId: null,
        priorView: this.snapshot().recovery,
        revealed: false,
        confirmation: null,
        expiresAt: this.#now() + MAX_RECOVERY_SECRET_WINDOW_MS
      };
      this.#apply({ type: "recovery.generated", vaultId: recovery.vaultId, keyId: candidate.signing.keyId, generation: recovery.generation + 1 });
      return this.snapshot();
    }
    const connections = this.#store.config.connections;
    if (connections.length === 0) {
      throw entryError("recovery_state_invalid", "Rotation needs at least one enrolled endpoint.");
    }
    const principalRef = connections[0].endpointPrincipalRef;
    const staged = this.#rotationManager.begin({
      incumbent: material,
      incumbentGeneration: recovery.generation,
      principalRef,
      vaultId: recovery.vaultId,
      endpointRouteIds: connections.map((connection) => connection.routeId)
    });
    // The candidate sits behind the same one-shot reveal contract as a fresh key.
    this.#pendingRecovery = {
      recoveryText: formatRecoveryText(staged.candidate),
      material: deriveRecoveryMaterial(staged.candidate.secret),
      vaultId: recovery.vaultId,
      keyId: staged.rotation.candidateKeyId,
      generation: staged.rotation.candidateGeneration,
      rotationId: staged.rotation.rotationId,
      priorView: this.snapshot().recovery,
      revealed: false,
      confirmation: null,
      expiresAt: this.#now() + MAX_RECOVERY_SECRET_WINDOW_MS
    };
    this.#apply({ type: "recovery.generated", vaultId: recovery.vaultId, keyId: staged.rotation.candidateKeyId, generation: staged.rotation.candidateGeneration });
    this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(staged.rotation.rotationId) });

    // Deliver rotation-begin per endpoint on the recovery channel. Deliveries
    // run concurrently — a silent endpoint pends its own exchange without
    // blocking the others, and a late reply still completes its ack. Note the
    // relay supersedes a same-device forward session — each affected
    // connection is refreshed after delivery so its channel re-establishes.
    void (async () => {
      await Promise.all(staged.rotation.outbound.map(async (outbound) => {
        const stored = connections.find((entry) => entry.routeId === outbound.endpointRouteId);
        if (!stored) {
          this.#rotationManager.markEndpoint(staged.rotation.rotationId, outbound.endpointRouteId, "unreachable");
          return;
        }
        await this.#deliverRotationMessage(staged.rotation.rotationId, stored, outbound.message);
      }));
    })().catch(() => undefined);
    return this.snapshot();
  }

  /**
   * Deliver one `rotation-begin` to one endpoint on a dedicated recovery
   * channel and project the reply. There is deliberately no local silence
   * deadline: the round trip settles only on the endpoint's rotation-state
   * reply, a real transport/session failure, or channel close — a slow but
   * healthy endpoint stays `pending` (never fabricated `unreachable`) and a
   * late ack still lands. `retryRotationDelivery` re-sends only the
   * un-acknowledged endpoints; acknowledged ones are never replayed.
   */
  async #deliverRotationMessage(rotationId: string, stored: StoredConnection, message: Record<string, unknown>): Promise<void> {
    const routeId = stored.routeId;
    let channel: RecoveryChannelLike | null = null;
    try {
      const credential = await this.#custody.loadSecret({ ref: stored.relayCredentialRef });
      // A stop() during the custody read cleared the channel set already —
      // creating a fresh channel now would pend forever. Shutdown is not an
      // endpoint failure, so the endpoint stays honestly pending.
      if (!this.#started) return;
      channel = this.#options.recoveryChannelFactory?.({
        relaySessionUrl: buildRelaySessionUrl(stored.relayService, stored.tenantId, routeId),
        admission: {
          tenantId: stored.tenantId,
          deviceId: stored.deviceId,
          routeId,
          role: "entry",
          mode: stored.mode,
          admissionGeneration: stored.admissionGeneration,
          revocationRevision: stored.revocationRevision
        },
        headers: { authorization: `Bearer ${credential ? new TextDecoder().decode(credential) : ""}` }
      }) ?? createEntryRecoveryChannel(this.#recoveryChannelOptions({
        relaySessionUrl: buildRelaySessionUrl(stored.relayService, stored.tenantId, routeId),
        admission: {
          tenantId: stored.tenantId,
          deviceId: stored.deviceId,
          routeId,
          role: "entry",
          mode: stored.mode,
          admissionGeneration: stored.admissionGeneration,
          revocationRevision: stored.revocationRevision
        },
        headers: { authorization: `Bearer ${credential ? new TextDecoder().decode(credential) : ""}` }
      }));
      this.#openRecoveryChannels.add(channel);
      await channel.open();
      const reply = await channel.roundTrip({ endpointRouteId: routeId, message });
      const parsed = reply && typeof reply === "object"
        ? reply as { kind?: unknown; acknowledged?: unknown; pending?: unknown }
        : null;
      if (parsed?.kind === "rotation-state"
        && Array.isArray(parsed.acknowledged)
        && parsed.acknowledged.includes(routeId)) {
        this.#rotationManager.markEndpoint(rotationId, routeId, "acknowledged");
      } else if (parsed?.kind === "rotation-state") {
        // The endpoint staged the candidate but has not acknowledged it yet —
        // honest non-terminal state, retrievable by a later redelivery.
        this.#rotationManager.markEndpoint(rotationId, routeId, "staged");
      }
      // Any other resolved shape is silence-equivalent: leave it pending.
    } catch {
      // A real rejection means the transport/session failed — provable
      // unreachable, not guessed silence.
      this.#rotationManager.markEndpoint(rotationId, routeId, "unreachable");
    } finally {
      if (channel) {
        this.#openRecoveryChannels.delete(channel);
        try { channel.close(); } catch { /* best-effort */ }
      }
    }
    this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(rotationId) });
    void this.refreshConnection(stored.connectionId).catch(() => undefined);
  }

  /**
   * Re-deliver `rotation-begin` to every endpoint that has not acknowledged —
   * nothing else is replayed. The persisted outbound payloads make this safe
   * across restarts: completed acknowledgements are kept, and each retry only
   * repeats the deliveries that never settled.
   */
  retryRotationDelivery(): GuiState {
    this.#requireStarted();
    const active = this.#openRotation();
    if (!active) {
      throw entryError("rotation_state_invalid", "No rotation is in flight.");
    }
    const owed = this.#rotationManager.pendingOutbound(active.rotationId);
    const connections = this.#store.config.connections;
    for (const target of owed) {
      const stored = connections.find((entry) => entry.routeId === target.endpointRouteId);
      if (!stored) {
        // The connection row is gone — this endpoint can never acknowledge.
        this.#rotationManager.markEndpoint(active.rotationId, target.endpointRouteId, "unreachable");
        continue;
      }
      void this.#deliverRotationMessage(active.rotationId, stored, target.message);
    }
    this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(active.rotationId) });
    return this.snapshot();
  }

  /**
   * Abort the in-flight rotation for this install. The candidate secret is
   * dropped (never persisted — nothing to scrub) and endpoints keep the
   * incumbent key. This is the deliberate exit from a rotation that cannot
   * or should not finish: start() already auto-aborts restart-orphaned
   * `staged` records, and the reveal-window expiry aborts expired ones, but
   * a live `staged`/`published`/`acknowledging` rotation can also be ended
   * explicitly here so a fresh rotation can begin.
   */
  abortRecoveryRotation(): GuiState {
    this.#requireStarted();
    if (this.#pendingVaultWriterRotation || this.#store.config.accountVaultWriterOperation) {
      throw entryError("account_transaction_pending", "This account-authorized vault writer operation must be retried or completed; its result cannot be discarded.");
    }
    const candidate = this.#pendingRecovery;
    if (candidate?.rotationId === null) {
      if (candidate.confirmation) {
        throw entryError("account_transaction_pending", "Recovery-key confirmation has started; wait for its durable result before continuing.");
      }
      this.#pendingRecovery = null;
      this.#apply({ type: "recovery.candidateCancelled", recovery: candidate.priorView });
      this.#notice("The unsaved recovery-key candidate was cancelled; the configured recovery key is unchanged.");
      return this.snapshot();
    }
    if (!this.#store.config.recovery) {
      throw entryError("recovery_state_invalid", "No recovery key is configured.");
    }
    const active = this.#openRotation();
    if (!active) {
      throw entryError("rotation_state_invalid", "No rotation is in flight.");
    }
    if (candidate?.rotationId === active.rotationId) {
      this.#pendingRecovery = null;
    }
    const aborted = this.#rotationManager.abort(active.rotationId);
    if (candidate?.rotationId === active.rotationId) {
      this.#apply({ type: "recovery.candidateCancelled", recovery: candidate.priorView });
    } else {
      this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(aborted.rotationId) });
    }
    this.#notice("The unsaved recovery-key candidate was cancelled; the configured recovery key is unchanged.");
    return this.snapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Peer messaging — online relay forwarding with client-owned custody   */
  /* ---------------------------------------------------------------- */

  /** The peer runtime for an authenticated paired connection. */
  async #peerRuntimeFor(stored: StoredConnection): Promise<EntryPeerRuntime> {
    if (stored.rePairRequired || stored.routeRevocation?.authorityRevoked) {
      throw entryError("account_repair_required", "This paired route is revoked or requires fresh enrollment; its local history remains available.");
    }
    const existing = this.#peers.get(stored.connectionId);
    if (existing) return existing;
    const inFlight = this.#peerInitializations.get(stored.connectionId);
    if (inFlight) return inFlight;
    const initializing = EntryPeerRuntime.create({
      storeDir: peerStoreDirFor(this.paths().dataDir, stored.connectionId),
      route: {
        tenantId: stored.tenantId,
        routeId: stored.routeId,
        deviceId: stored.deviceId
      },
      pairedPeerIdentity: stored.endpointPeerIdentity,
      directory: {
        resolvePeerIdentity: (peerDeviceId) => {
          const current = this.#store.config.connections.find((entry) => entry.connectionId === stored.connectionId);
          if (!current || current.rePairRequired || current.endpointDeviceId !== peerDeviceId || peerDeviceId !== stored.endpointDeviceId) return null;
          const identity = current.endpointPeerIdentity;
          const expectedPeerId = peerIdForRouteDevice({ tenantId: current.tenantId, routeId: current.routeId, deviceId: peerDeviceId });
          if (!identity || !expectedPeerId || !isPairingPeerIdentity(identity, expectedPeerId)) return null;
          const account = this.#store.config.account;
          if (!current.accountBinding || !account || account.accountId !== current.accountBinding.accountId
            || account.authEpoch !== current.accountBinding.authEpoch) return null;
          return identity;
        }
      }
    }).then((runtime) => {
      this.#peers.set(stored.connectionId, runtime);
      // stop() drains this local initialization and closes the runtime. Do not
      // activate new application work or Peer recovery during that drain.
      if (!this.#started) return runtime;
      this.#bindEntryApplicationPeer(stored, runtime);
      // If a session is already admitted, the runtime must not miss the gate.
      const live = this.#sessions.get(stored.connectionId);
      if (live) {
        runtime.attachChannel((message) => live.transport.send(message));
        if (live.session.state === "admitted" || live.session.state === "streaming") {
          runtime.onSessionAdmitted();
        }
      }
      return runtime;
    });
    this.#peerInitializations.set(stored.connectionId, initializing);
    try {
      return await initializing;
    } finally {
      if (this.#peerInitializations.get(stored.connectionId) === initializing) {
        this.#peerInitializations.delete(stored.connectionId);
      }
    }
  }

  async #requirePeerRuntime(connectionId: string): Promise<{ stored: StoredConnection; runtime: EntryPeerRuntime }> {
    this.#requireStarted();
    const stored = this.#requireConnection(connectionId);
    return { stored, runtime: await this.#peerRuntimeFor(stored) };
  }

  async peerStatus(connectionId: string) {
    const { runtime } = await this.#requirePeerRuntime(connectionId);
    return runtime.status();
  }

  async peerSend(input: {
    readonly connectionId: string;
    readonly peerDeviceId: string;
    readonly text?: string;
    readonly plaintextBase64url?: string;
    readonly messageId?: string;
  }) {
    const { runtime } = await this.#requirePeerRuntime(input.connectionId);
    return runtime.sendMessage(input);
  }

  async peerInbox(connectionId: string, limit?: number, afterSequence?: number) {
    const { runtime } = await this.#requirePeerRuntime(connectionId);
    return runtime.inbox(limit ?? 64, afterSequence ?? 0);
  }

  async peerPairSafety(input: { readonly connectionId: string; readonly peerDeviceId: string }) {
    const { runtime } = await this.#requirePeerRuntime(input.connectionId);
    return runtime.pairSafety(input.peerDeviceId);
  }

  async personalStatus(): Promise<GuiPersonalEndpointView> {
    this.#requireStarted();
    const runtime = await this.#ensurePersonalEndpoint();
    if (!runtime) return this.#model.snapshot().personalEndpoint;
    const view = this.#personalEndpointView(runtime.snapshot());
    this.#apply({ type: "personal.endpoint", endpoint: view });
    return view;
  }

  async enrollPersonalEndpoint(): Promise<GuiState> {
    this.#requireStarted();
    const { account, credential } = await this.#requireOSAccountSession();
    const runtime = await this.#ensurePersonalEndpoint();
    if (!runtime) throw entryError("service_config_missing", "This release has no configured account and relay origins; no personal route was created.");
    const desktop = await this.#ensureDesktopIdentity();
    const desktopPrivateKey = await loadDevicePrivateKey({
      custody: this.#custody,
      deviceId: desktop.deviceId,
      refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
    });
    if (!desktopPrivateKey) throw entryError("account_custody_required", "The desktop account signing key is unavailable in OS custody.");
    const input = {
      account,
      accountCredential: credential,
      desktopDeviceId: desktop.deviceId,
      desktopPublicKey: desktop.publicKey,
      desktopPrivateKey,
      requestFreshStepUp: (stepUp: PersonalEndpointStepUpRequest) => this.#requestPersonalStepUp(stepUp)
    };
    let snapshot: PersonalEndpointSnapshot;
    try {
      snapshot = await runtime.enrollCurrentAccount(input);
    } catch (error) {
      if (errorCode(error) !== "personal_endpoint_reenrollment_required") throw error;
      snapshot = await runtime.reenrollCurrentAccount(input);
    }
    this.#publishPersonalEndpointSnapshot(snapshot);
    try {
      snapshot = await runtime.start();
    } catch (error) {
      this.#notice(`The personal route is enrolled but not connected (${errorCode(error)}). Retry when the account service or relay is reachable.`);
      snapshot = runtime.snapshot();
    }
    await this.#syncPersonalEndpointPeerRoute();
    this.#publishPersonalEndpointSnapshot(snapshot);
    await this.#refreshApplicationsView(true);
    await this.#applicationEngine?.resume();
    return this.snapshot();
  }

  async createPersonalPairingInvite(): Promise<{ readonly inviteText: string }> {
    this.#requireStarted();
    const runtime = await this.#ensurePersonalEndpoint();
    if (!runtime) throw entryError("service_config_missing", "This release has no configured account and relay origins.");
    if (!runtime.endpointIdentity || !runtime.peerClient) await runtime.start();
    return Object.freeze({ inviteText: encodePairingInvite(await runtime.createPairingInvite()) });
  }

  async listLocalAgents(): Promise<readonly { readonly id: string; readonly displayName: string; readonly enabled: boolean; readonly permissionMode: "ask" }[]> {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const agents = await this.#agentRegistry!.list();
    await this.#refreshApplicationsView(false);
    return Object.freeze(agents.map((agent) => Object.freeze({
      id: agent.id,
      displayName: agent.displayName,
      enabled: agent.enabled,
      permissionMode: "ask" as const
    })));
  }

  async registerLocalAgent(input: Record<string, unknown>) {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    if (!Array.isArray(input.args) || !input.args.every((value) => typeof value === "string")
      || !isRecord(input.environment) || input.permissionPolicy !== "ask") {
      throw entryError("agent_definition_invalid", "Agent registration requires arguments, environment references, and ask-before-action permission policy.");
    }
    const summary = await this.#agentRegistry!.register({
      id: typeof input.id === "string" ? input.id : undefined,
      displayName: String(input.displayName ?? ""),
      description: typeof input.description === "string" ? input.description : null,
      command: String(input.command ?? ""),
      args: input.args as string[],
      cwd: String(input.cwd ?? ""),
      environment: input.environment as AcpAgentDefinitionInput["environment"],
      permissionPolicy: "ask",
      enabled: input.enabled !== false
    });
    await this.#refreshApplicationsView(false);
    return Object.freeze({ id: summary.id, displayName: summary.displayName, enabled: summary.enabled, permissionMode: "ask" as const });
  }

  async removeLocalAgent(agentId: string): Promise<{ readonly removed: boolean }> {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const removed = await this.#agentRegistry!.remove(agentId);
    await this.#refreshApplicationsView(false);
    return Object.freeze({ removed });
  }

  async applicationDestinations(): Promise<readonly { readonly handle: string; readonly label: string; readonly reachable: boolean }[]> {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    await this.#refreshApplicationDestinations();
    await this.#refreshApplicationsView(false);
    return Object.freeze(this.#applicationDestinations.map(({ handle, label, reachable }) => Object.freeze({ handle, label, reachable })));
  }

  async discoverApplicationAgents(input: { readonly destinationHandle: string; readonly requestId?: string }): Promise<PeerApplicationDiscoveryRecord> {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const destination = await this.#resolveApplicationDestination(input.destinationHandle);
    const currentPending = await this.#applicationJournal!.findLatestPendingDiscovery(destination.address);
    const requestId = input.requestId
      ?? currentPending?.requestId
      ?? `discovery.${randomBytes(18).toString("base64url")}`;
    const result = await this.#applicationEngine!.discoverAgents(destination.address, { requestId });
    await this.#refreshApplicationsView(false);
    return result;
  }

  async submitApplicationTask(input: {
    readonly operationId: string;
    readonly destinationHandle: string;
    readonly targetAgentId: string;
    readonly prompt: string;
    readonly callerAgentId?: string;
  }) {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    let destination: ApplicationDestination;
    try {
      destination = await this.#resolveApplicationDestination(input.destinationHandle);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { effectOutcome: "not_started" as const });
    }
    const callerAgentId = input.callerAgentId ?? null;
    try {
      const record = await this.#applicationEngine!.submit({
        address: destination.address,
        operationId: input.operationId,
        ...(callerAgentId === null ? {} : { callerAgentId }),
        targetAgentId: input.targetAgentId,
        prompt: input.prompt
      });
      await this.#refreshApplicationsView(false);
      return this.#operationSummary(record, destination.label);
    } catch (error) {
      let persisted: PeerApplicationRecord | null;
      try {
        persisted = await this.#applicationEngine!.getOperation(input.operationId);
      } catch {
        throw Object.assign(error instanceof Error ? error : new Error("The task outcome could not be checked."), { effectOutcome: "unknown" as const });
      }
      if (persisted
        && persisted.role === "caller"
        && samePeerApplicationAddress(persisted.originAddress, destination.address)
        && persisted.callerAgentId === callerAgentId
        && persisted.targetAgentId === input.targetAgentId
        && persisted.prompt === input.prompt) {
        return this.#operationSummary(persisted, destination.label);
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { effectOutcome: "not_started" as const });
    }
  }

  async listApplicationOperations() {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    await this.#refreshApplicationsView(false);
    return this.#model.snapshot().applications.operations;
  }

  async getApplicationOperation(operationId: string) {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const record = await this.#applicationEngine!.getOperation(operationId);
    if (!record) return null;
    const [parts, partial] = await Promise.all([
      this.#applicationJournal!.listResultParts(record.key),
      this.#applicationJournal!.listPartialResultChunks(record.key)
    ]);
    const resultParts = parts.length > 0 ? parts : partial;
    const result = resultParts.length > 0
      ? [...resultParts].sort((left, right) => left.index - right.index).map((part) => part.text).join("")
      : null;
    const permission = record.permission?.status === "pending" ? record.permission : null;
    const targetLabel = this.#findDestinationLabel(record.routeAddress);
    await this.#refreshApplicationsView(false);
    return Object.freeze({
      operationId: record.operationId,
      direction: record.role === "caller" ? "outbound" : "inbound",
      status: record.status,
      transportStatus: this.#operationTransportStatus(record),
      prompt: record.prompt,
      targetAgentId: record.targetAgentId,
      result,
      progress: record.progress ? Object.freeze({ sequence: record.progress.revision, summary: record.progress.text }) : null,
      permission: permission ? Object.freeze({
        permissionRequestId: permission.id,
        title: permission.request.toolCall.title,
        toolCall: permission.request.toolCall,
        options: permission.request.options
      }) : null,
      stopReason: record.resultStopReason,
      errorCode: record.lastError,
      targetLabel
    });
  }

  async cancelApplicationOperation(operationId: string) {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const prior = await this.#applicationEngine!.getOperation(operationId);
    const record = await this.#applicationEngine!.cancel(operationId);
    if (prior) this.#applicationRouter?.clearAuthorityObservation(prior.routeAddress);
    await this.#refreshApplicationsView(false);
    return this.#operationSummary(record, this.#findDestinationLabel(record.routeAddress));
  }

  async resolveApplicationPermission(input: {
    readonly operationId: string;
    readonly permissionRequestId: string;
    readonly outcome: "selected" | "cancelled";
    readonly optionId?: string;
  }) {
    this.#requireStarted();
    await this.#initializeApplicationComposition();
    const record = await this.#applicationEngine!.resolvePermission({
      operationId: input.operationId,
      permissionId: input.permissionRequestId,
      resolution: input.outcome === "selected"
        ? { outcome: "selected", optionId: input.optionId ?? "" }
        : { outcome: "cancelled" }
    });
    await this.#refreshApplicationsView(false);
    return this.getApplicationOperation(record.operationId);
  }

  /* ---------------------------------------------------------------- */
  /* MCP setup                                                          */
  /* ---------------------------------------------------------------- */

  mcpSnippet(): { snippet: string; instructions: string; managedPath: string | null } {
    const snippet = buildMcpStdioSnippet({
      serverName: "meshrix-entry",
      command: this.#options.appExePath ?? "meshrix-entry",
      args: ["--mcp-stdio"]
    });
    this.#apply({ type: "mcp.configured", snippet });
    return {
      snippet,
      instructions: "Paste this entry into your MCP client's server configuration. The stdio transport needs no listener or port.",
      managedPath: this.#store.config.mcp.managedConfigPath
    };
  }

  async writeMcpConfig(): Promise<{ snippet: string; managedPath: string }> {
    const { snippet } = this.mcpSnippet();
    const managedPath = managedMcpConfigPath(this.paths().dataDir);
    await writeManagedMcpConfig({ filePath: managedPath, snippet });
    await this.#store.update((draft) => ({ ...draft, mcp: { ...draft.mcp, managedConfigPath: managedPath } }));
    this.#apply({ type: "mcp.configured", snippet, configuredPath: managedPath });
    return { snippet, managedPath };
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                          */
  /* ---------------------------------------------------------------- */

  ownedPaths(): { ownedPaths: readonly string[]; note: string } {
    return {
      ownedPaths: ownedPathsFor(this.paths(), this.#store.config),
      note: "The app removes exactly these paths on uninstall. Relay credentials and device keys live in the platform custody store under entry-gui.* refs and are deleted per-connection or at uninstall."
    };
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  #accountClient(): DesktopAccountClient {
    const origin = this.#options.serviceConfig?.accountOrigin;
    if (!origin) throw entryError("account_origin_missing", "The installed account service is not configured.");
    return new DesktopAccountClient({ origin, fetch: this.#options.accountFetch });
  }

  async #restoreVaultWriterRotation(): Promise<void> {
    const stored = this.#store.config.accountVaultWriterOperation;
    if (!stored || this.#custodyTier !== "os" || !this.#custodyAvailable) return;
    const bytes = await this.#custody.loadSecret({ ref: stored.flowRef });
    if (!bytes) return;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return; }
    if (!isRecord(raw) || !isAccountBinding(raw.account)) return;
    const target = raw.target === null ? null : isActionTarget(raw.target) ? raw.target : null;
    if (raw.target !== null && !target) return;
    const prepareRequest = isRecord(raw.prepareRequest)
      && raw.prepareRequest.operationId === stored.operationId
      ? raw.prepareRequest as unknown as AccountDesktopVaultWriterRotationPrepareRequest
      : null;
    const completeRequest = isRecord(raw.completeRequest)
      && raw.completeRequest.operationId === stored.operationId
      && raw.completeRequest.keyCustodyConfirmed === true
      ? raw.completeRequest as unknown as AccountDesktopVaultWriterRotationCompleteRequest
      : null;
    let browserTransaction: DesktopAccountTransaction | null = null;
    if (isRecord(raw.browserTransaction)
      && raw.browserTransaction.purpose === "step_up"
      && typeof raw.browserTransaction.transactionId === "string"
      && typeof raw.browserTransaction.verifier === "string"
      && typeof raw.browserTransaction.browserUrl === "string") {
      browserTransaction = raw.browserTransaction as unknown as DesktopAccountTransaction;
    }
    const expiresAt = typeof raw.expiresAt === "string" && Number.isFinite(Date.parse(raw.expiresAt))
      ? raw.expiresAt
      : null;
    this.#pendingVaultWriterRotation = { ...stored, flow: {
      account: raw.account,
      prepareRequest,
      target,
      expiresAt,
      browserTransaction,
      completeRequest
    } };
    const localAccount = this.#store.config.account;
    if (browserTransaction && localAccount?.accountId === raw.account.accountId && localAccount.authEpoch === raw.account.authEpoch
      && target) {
      this.#desktopTransaction = {
        transaction: browserTransaction,
        actionPurpose: "grant_access",
        binding: raw.account,
        target,
        bootstrapId: null,
        claimId: null
      };
    }
  }

  async #persistVaultWriterRotation(pending: PendingVaultWriterRotation): Promise<void> {
    await this.#custody.storeSecret({
      ref: pending.flowRef,
      secret: new TextEncoder().encode(JSON.stringify({
        account: pending.flow.account,
        prepareRequest: pending.flow.prepareRequest,
        target: pending.flow.target,
        expiresAt: pending.flow.expiresAt,
        browserTransaction: pending.flow.browserTransaction,
        completeRequest: pending.flow.completeRequest
      }))
    });
    await this.#store.update((draft) => ({
      ...draft,
      accountVaultWriterOperation: {
        operationId: pending.operationId,
        connectionId: pending.connectionId,
        vaultId: pending.vaultId,
        candidateKeyId: pending.candidateKeyId,
        generation: pending.generation,
        materialRef: pending.materialRef,
        flowRef: pending.flowRef,
        state: pending.state
      }
    }));
  }

  #applyVaultWriterRegistrationView(detail?: string | null): void {
    const pending = this.#pendingVaultWriterRotation;
    if (!pending) return;
    const state = pending.state === "prepare_pending"
      ? "prepare_pending"
      : pending.state === "authorization_required"
        ? "authorization_required"
        : this.#desktopTransaction ? "authorization_required" : "service_pending";
    this.#apply({
      type: "recovery.writerRegistration",
      state,
      candidateVaultId: pending.vaultId,
      candidateKeyId: pending.candidateKeyId,
      candidateGeneration: pending.generation,
      detail: detail ?? (state === "service_pending"
        ? "The exact authorization was consumed. Vault writer replacement is waiting for the relay; publishing remains fenced."
        : state === "prepare_pending"
          ? "The account service response is pending. Retry will reuse the same signed operation."
          : "Approve this exact vault writer registration in the system browser.")
    });
  }

  async #clearVaultWriterRotation(): Promise<void> {
    const pending = this.#pendingVaultWriterRotation;
    if (!pending) return;
    await this.#store.update((draft) => ({ ...draft, accountVaultWriterOperation: null }));
    await this.#custody.deleteSecret({ ref: pending.flowRef }).catch(() => undefined);
    this.#pendingVaultWriterRotation = null;
  }

  #accountView(notice: string | null = null): GuiState["account"] {
    const originAvailable = Boolean(this.#options.serviceConfig?.accountOrigin);
    const stored = this.#store?.config.account ?? null;
    const authenticated = Boolean(this.#custodyTier === "os" && this.#custodyAvailable
      && stored?.accountId && stored.authEpoch && stored.sessionCredentialRef === CUSTODY_ACCOUNT_SESSION_REF);
    return {
      state: this.#desktopTransaction ? "transaction_pending" : authenticated ? "authenticated" : originAvailable ? "signed_out" : "unconfigured",
      accountId: stored?.accountId ?? null,
      authEpoch: stored?.authEpoch ?? null,
      transactionId: this.#desktopTransaction?.transaction.transactionId ?? null,
      transactionPurpose: this.#desktopTransaction?.transaction.purpose ?? null,
      actionPurpose: this.#desktopTransaction?.actionPurpose ?? null,
      originAvailable,
      custodyAvailable: this.#custodyAvailable && this.#custodyTier === "os",
      notice
    };
  }

  async #ensureDesktopIdentity(): Promise<DeviceIdentity> {
    if (this.#custodyTier !== "os" || !this.#custodyAvailable) {
      throw entryError("account_custody_required", "Account authentication requires an available OS-protected key store.");
    }
    let stored = this.#store.config.account;
    if (!stored) {
      const identity = await enrollDeviceIdentity({
        custody: this.#custody,
        refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
      });
      stored = {
        desktopDeviceId: identity.deviceId,
        accountId: null,
        authEpoch: null,
        sessionCredentialRef: null
      };
      await this.#store.update((draft) => ({ ...draft, account: stored }));
    }
    let identity = await deviceIdentityFromCustody({
      custody: this.#custody,
      deviceId: stored.desktopDeviceId,
      refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
    });
    if (!identity) {
      identity = await enrollDeviceIdentity({
        custody: this.#custody,
        deviceId: stored.desktopDeviceId,
        refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
      });
    }
    return identity;
  }

  async #storedAccountCredential(): Promise<string | null> {
    if (this.#custodyTier !== "os" || !this.#custodyAvailable) return null;
    const stored = this.#store.config.account;
    if (!stored?.accountId || !stored.authEpoch || stored.sessionCredentialRef !== CUSTODY_ACCOUNT_SESSION_REF) return null;
    const bytes = await this.#custody.loadSecret({ ref: CUSTODY_ACCOUNT_SESSION_REF });
    if (!bytes) return null;
    try {
      const credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return credential.length >= 32 ? credential : null;
    } catch {
      return null;
    }
  }

  async #startDesktopTransaction(input: {
    readonly purpose: "login" | "step_up";
    readonly actionPurpose?: "pair_device" | "grant_access";
    readonly target?: AccountActionTarget;
    readonly binding?: AccountAuthorityBinding;
    readonly bootstrapId?: string;
    readonly claimId?: string;
  }): Promise<void> {
    if (this.#desktopTransaction) {
      const existing = this.#desktopTransaction;
      if (existing.transaction.purpose === input.purpose
        && existing.actionPurpose === (input.actionPurpose ?? null)
        && existing.bootstrapId === (input.bootstrapId ?? null)
        && existing.claimId === (input.claimId ?? null)
        && (input.target === undefined || (existing.target && canonicalAccountActionTarget(existing.target) === canonicalAccountActionTarget(input.target)))) return;
      throw entryError("account_transaction_pending", "Finish or cancel the current account browser transaction first.");
    }
    const identity = await this.#ensureDesktopIdentity();
    const privateKey = await loadDevicePrivateKey({
      custody: this.#custody,
      deviceId: identity.deviceId,
      refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
    });
    if (!privateKey) throw entryError("account_custody_required", "The desktop account signing key is unavailable in OS custody.");
    let desktopAuth: { readonly account: AccountAuthorityBinding; readonly credential: string; readonly privateKey: KeyObject } | undefined;
    if (input.purpose === "step_up") {
      const current = await this.#requireOSAccountSession();
      if (!input.binding) throw entryError("account_step_up_mismatch", "A current account binding is required for step-up authorization.");
      assertSameAccountBinding(current.account, input.binding);
      const stored = this.#store.config.account;
      if (!stored?.accountId || stored.accountId !== current.account.accountId || stored.authEpoch !== current.account.authEpoch) {
        throw entryError("account_binding_mismatch", "The local account session changed before this authorization began.");
      }
      desktopAuth = { account: current.account, credential: current.credential, privateKey };
    }
    const transaction = await this.#accountClient().createTransaction({
      purpose: input.purpose,
      clientPublicKey: identity.publicKey,
      ...(desktopAuth ? { desktopAuth } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.actionPurpose ? { actionPurpose: input.actionPurpose } : {}),
      ...(input.bootstrapId ? { bootstrapId: input.bootstrapId } : {}),
      ...(input.claimId ? { claimId: input.claimId } : {})
    });
    this.#desktopTransaction = {
      transaction,
      actionPurpose: input.actionPurpose ?? null,
      binding: input.binding ?? null,
      target: input.target ?? null,
      bootstrapId: input.bootstrapId ?? null,
      claimId: input.claimId ?? null
    };
    this.#apply({ type: "account.updated", account: this.#accountView() });
  }

  async #acceptAccountLogin(result: Extract<AccountDesktopTransactionPollResponse, { state: "complete"; purpose: "login" }>): Promise<void> {
    if (this.#custodyTier !== "os" || !this.#custodyAvailable) {
      throw entryError("account_custody_required", "Account sessions can only be retained in OS-protected custody.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(result.account.accountId)
      || !Number.isSafeInteger(result.account.authEpoch)
      || result.account.authEpoch < 1
      || result.deviceSessionCredential.length < 32) {
      throw entryError("account_login_invalid", "The account worker returned an invalid desktop login result.");
    }
    const identity = await this.#ensureDesktopIdentity();
    await this.#custody.storeSecret({
      ref: CUSTODY_ACCOUNT_SESSION_REF,
      secret: new TextEncoder().encode(result.deviceSessionCredential)
    });
    await this.#store.update((draft) => ({
      ...draft,
      account: {
        desktopDeviceId: identity.deviceId,
        accountId: result.account.accountId,
        authEpoch: result.account.authEpoch,
        sessionCredentialRef: CUSTODY_ACCOUNT_SESSION_REF
      },
      connections: draft.connections.map((connection) => connection.accountBinding?.accountId === result.account.accountId
        && connection.accountBinding.authEpoch !== result.account.authEpoch
        ? { ...connection, rePairRequired: true }
        : connection)
    }));
    await this.#invalidateStaleAccountConnections(result.account);
  }

  async #invalidateStaleAccountConnections(binding: AccountAuthorityBinding): Promise<void> {
    const stale = this.#store.config.connections.filter((connection) => connection.accountBinding?.accountId === binding.accountId
      && connection.accountBinding.authEpoch !== binding.authEpoch);
    if (stale.length === 0) return;
    for (const connection of stale) {
      const live = this.#sessions.get(connection.connectionId);
      try { live?.session.close("revoked"); } catch { /* already closed */ }
      try { live?.transport.close(); } catch { /* already closed */ }
      this.#sessions.delete(connection.connectionId);
      const peer = this.#peers.get(connection.connectionId);
      if (peer) {
        try { await peer.close(); } catch { /* already closed */ }
        this.#peers.delete(connection.connectionId);
      }
      this.#unbindEntryApplicationPeer(connection.connectionId);
      await this.#custody.deleteSecret({ ref: connection.relayCredentialRef }).catch(() => undefined);
      await deleteDeviceKey({ custody: this.#custody, deviceId: connection.deviceId }).catch(() => undefined);
    }
    for (const connection of stale) {
      const updated = this.#store.config.connections.find((entry) => entry.connectionId === connection.connectionId);
      if (updated) this.#apply({ type: "connection.upsert", connection: connectionView(updated) });
      this.#apply({
        type: "connection.state",
        connectionId: connection.connectionId,
        routeState: "unreachable",
        channelEstablished: false,
        acceptsNewWork: false
      });
    }
  }

  #hasPairingCompletionCheckpoint(): boolean {
    return this.#pairingCheckpointBlocked
      || Boolean(this.#store?.config.pairingCompletionCheckpointRef)
      || Boolean(this.#pendingPairing?.checkpointRef);
  }

  async #restorePairingCompletionCheckpoint(): Promise<boolean> {
    const checkpointRef = this.#store.config.pairingCompletionCheckpointRef;
    if (!checkpointRef) return false;

    // A connection row carrying this reference is written only after a
    // matching endpoint receipt. It closes the crash window after the
    // checkpoint secret was deleted but before its config pointer was cleared.
    const finalizedConnection = this.#store.config.connections.find((connection) =>
      connection.pairingCompletionCheckpointRef === checkpointRef);
    const durableAdmission = finalizedConnection
      ? await this.#custody.loadSecret({ ref: finalizedConnection.relayCredentialRef })
      : null;
    if (finalizedConnection && durableAdmission) {
      await this.#custody.deleteSecret({ ref: checkpointRef });
      await this.#store.update((draft) => ({
        ...draft,
        pairingCompletionCheckpointRef: null,
        connections: draft.connections.map((connection) => connection.pairingCompletionCheckpointRef === checkpointRef
          ? { ...connection, pairingCompletionCheckpointRef: null }
          : connection)
      }));
      await this.#store.flush();
      return false;
    }
    if (finalizedConnection && !durableAdmission) {
      await this.#store.update((draft) => ({
        ...draft,
        connections: draft.connections.map((connection) => connection.pairingCompletionCheckpointRef === checkpointRef
          ? { ...connection, rePairRequired: true }
          : connection)
      }));
    }

    const saved = await this.#custody.loadSecret({ ref: checkpointRef });
    if (!saved) {
      this.#pairingCheckpointBlocked = true;
      return false;
    }
    let checkpoint: PairingCompletionCheckpoint | null = null;
    try {
      checkpoint = parsePairingCompletionCheckpoint(JSON.parse(new TextDecoder().decode(saved)));
    } catch {
      checkpoint = null;
    }
    if (!checkpoint || checkpoint.bootstrap.bootstrapId.length < 2) {
      this.#pairingCheckpointBlocked = true;
      return false;
    }
    let device: DeviceIdentity | null = null;
    try {
      device = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: checkpoint.device.deviceId });
    } catch {
      device = null;
    }
    if (!device
      || device.publicKey !== checkpoint.device.publicKey
      || device.fingerprint !== checkpoint.device.fingerprint) {
      this.#pairingCheckpointBlocked = true;
      return false;
    }
    this.#pendingPairing = {
      session: null,
      channel: null,
      invite: checkpoint.completion.invite,
      device,
      entryPeerIdentity: checkpoint.completion.entryPeerIdentity,
      bootstrapRequest: null,
      bootstrap: checkpoint.bootstrap,
      authorization: {
        account: checkpoint.completion.account,
        permitId: checkpoint.completion.permitId,
        purpose: "pair_device",
        target: checkpoint.completion.target
      },
      completion: checkpoint.completion,
      completionTask: null,
      checkpointRef,
      boundRecoveryKeyId: checkpoint.boundRecoveryKeyId
    };
    this.#pairingCheckpointBlocked = false;
    return true;
  }

  async #persistPairingCompletionCheckpoint(pending: PendingPairing, completion: PairingCompletionRequest): Promise<void> {
    const device = pending.device;
    const bootstrap = pending.bootstrap;
    if (!device || !bootstrap
      || completion.deviceId !== device.deviceId
      || completion.devicePublicKey !== device.publicKey
      || completion.invite.inviteId !== pending.invite.inviteId
      || completion.account.accountId !== bootstrap.account.accountId
      || completion.account.authEpoch !== bootstrap.account.authEpoch) {
      throw entryError("pairing_completion_invalid", "The completion cannot be checkpointed outside its active device and account bootstrap.");
    }
    if (this.#pairingCheckpointBlocked) {
      throw entryError("pairing_state_invalid", "A protected pairing checkpoint must be resolved before another completion can be sent.");
    }
    const configuredRef = this.#store.config.pairingCompletionCheckpointRef;
    let checkpointRef = pending.checkpointRef;
    if (!checkpointRef) {
      if (configuredRef) throw entryError("pairing_state_invalid", "Another submitted pairing is still awaiting its endpoint receipt.");
      checkpointRef = `${CUSTODY_PAIRING_COMPLETION_PREFIX}.${randomBytes(16).toString("hex")}`;
    }
    if (configuredRef && configuredRef !== checkpointRef) {
      throw entryError("pairing_state_invalid", "Another submitted pairing is still awaiting its endpoint receipt.");
    }
    const checkpoint: PairingCompletionCheckpoint = {
      schemaVersion: "entry-pairing-completion-checkpoint-1",
      bootstrap,
      deviceKeyCustodyRef: deviceKeyCustodyRef(device.deviceId),
      device,
      boundRecoveryKeyId: pending.boundRecoveryKeyId,
      completion
    };
    const encoded = new TextEncoder().encode(canonicalJson(checkpoint));
    const existing = await this.#custody.loadSecret({ ref: checkpointRef });
    if (existing && new TextDecoder().decode(existing) !== new TextDecoder().decode(encoded)) {
      throw entryError("pairing_completion_invalid", "The saved pairing completion differs from the active signed operation.");
    }
    if (!existing) await this.#custody.storeSecret({ ref: checkpointRef, secret: encoded });
    pending.checkpointRef = checkpointRef;
    pending.completion = completion;
    await this.#store.update((draft) => ({ ...draft, pairingCompletionCheckpointRef: checkpointRef }));
    await this.#store.flush();
  }

  async #beginRestrictedPairing(): Promise<void> {
    const pending = this.#pendingPairing;
    if (!pending) return;
    if (pending.invite.mode !== "personal") {
      throw entryError("team_not_available", "Account-managed teams require an available paid team subscription.");
    }
    if (this.#hasPairingCompletionCheckpoint()) {
      throw entryError("pairing_state_invalid", "A submitted pairing must replay its saved completion without another bootstrap.");
    }
    if (pending.session) {
      const state = pending.session.snapshot().state;
      if (state === "challenge_issued" || state === "proof_submitted" || state === "enrolled"
        || state === "refused" || state === "expired" || state === "cancelled") return;
      pending.session.interrupt();
      pending.session = null;
    }
    const stored = this.#store.config.account;
    const credential = await this.#storedAccountCredential();
    if (!stored?.accountId || !stored.authEpoch || !credential) {
      await this.#startDesktopTransaction({ purpose: "login" });
      return;
    }
    if (pending.bootstrap && (pending.bootstrap.account.accountId !== stored.accountId
      || pending.bootstrap.account.authEpoch !== stored.authEpoch)) {
      throw entryError("account_bootstrap_mismatch", "The pending pairing bootstrap belongs to a previous account epoch; cancel and start pairing again.");
    }
    if (pending.invite.endpointPinRef !== pending.invite.endpointSpkiPin) {
      throw entryError("pairing_pin_mismatch", "The account route pin and endpoint TLS pin do not match.");
    }
    const device = pending.device ?? await enrollDeviceIdentity({ custody: this.#custody });
    pending.device = device;
    const peerConnectionId = `conn.${device.deviceId.toLowerCase().replace(/[^a-z0-9]/gu, ".")}`;
    const entryPeerIdentity = await EntryPeerRuntime.preparePairingIdentity({
      storeDir: peerStoreDirFor(this.paths().dataDir, peerConnectionId),
      route: { tenantId: pending.invite.tenantId, routeId: pending.invite.endpointRouteId, deviceId: device.deviceId },
      requireExisting: pending.completion !== null
    });
    if (pending.completion && canonicalJson(pending.completion.entryPeerIdentity) !== canonicalJson(entryPeerIdentity)) {
      throw entryError("peer_identity_unavailable", "The saved pairing proof no longer matches this device's stored Signal identity.");
    }
    pending.entryPeerIdentity = entryPeerIdentity;
    if (!pending.bootstrap && !pending.bootstrapRequest) {
      const desktop = await this.#ensureDesktopIdentity();
      const desktopKey = await loadDevicePrivateKey({
        custody: this.#custody,
        deviceId: desktop.deviceId,
        refPrefix: CUSTODY_ACCOUNT_DESKTOP_REF_PREFIX
      });
      if (!desktopKey) throw entryError("account_custody_required", "The desktop account signing key is unavailable in OS custody.");
      const bootstrapBody: Omit<AccountDesktopPairingBootstrapRequest, "proof"> = {
        tenantId: pending.invite.tenantId,
        routeId: pending.invite.endpointRouteId,
        entryDeviceId: device.deviceId,
        entryDevicePublicKey: device.publicKey,
        endpointPinRef: pending.invite.endpointPinRef,
        mode: pending.invite.mode
      };
      // Keep the exact signed request before sending. If the Worker commits the
      // bootstrap but the response is lost, retry the same nonce, device key
      // and body so the authority can return the same idempotent result.
      pending.bootstrapRequest = signDesktopPairingBootstrap({
        account: { accountId: stored.accountId, authEpoch: stored.authEpoch },
        credential,
        clientPublicKey: desktop.publicKey,
        privateKey: desktopKey,
        body: bootstrapBody
      });
    }
    if (!pending.bootstrap) {
      const response = await this.#accountClient().createPairingBootstrap(pending.bootstrapRequest!);
      if (response.account.accountId !== stored.accountId
        || response.account.authEpoch !== stored.authEpoch
        || response.tenantId !== pending.invite.tenantId
        || response.routeId !== pending.invite.endpointRouteId
        || response.endpointDeviceId !== pending.invite.endpointDeviceId
        || response.endpointPinRef !== pending.invite.endpointPinRef
        || response.mode !== pending.invite.mode) {
        throw entryError("account_bootstrap_mismatch", "The account worker returned a pairing bootstrap for another account or endpoint.");
      }
      pending.bootstrap = {
        bootstrapId: response.bootstrapId,
        relayAdmission: response.relayAdmission,
        account: response.account,
        tenantId: response.tenantId,
        routeId: response.routeId,
        endpointDeviceId: response.endpointDeviceId,
        endpointPinRef: response.endpointPinRef,
        entryDeviceId: response.entryDeviceId,
        role: response.role,
        mode: response.mode,
        admissionGeneration: response.admissionGeneration,
        revocationRevision: response.revocationRevision,
        expiresAt: response.expiresAt
      };
      pending.bootstrapRequest = null;
    }
    const bootstrap = pending.bootstrap;
    const deviceKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: device.deviceId });
    if (!deviceKey) throw entryError("custody_unavailable", "The fresh pairing key was not retained in device custody.");
    const certificate = issueDeviceCertificate({
      publicKeyRaw: Buffer.from(device.publicKey, "base64url"),
      sign: custodyDeviceSigner(deviceKey),
      subject: `meshrix-entry ${device.deviceId}`
    });
    pending.channel?.close();
    pending.channel = null;
    const channelOptions: PairingRelayChannelFactoryInput = {
      relaySessionUrl: buildRelaySessionUrl(pending.invite.relayService, pending.invite.tenantId, pending.invite.endpointRouteId),
      bootstrap,
      invite: pending.invite,
      innerTls: { key: deviceKey.export({ format: "pem", type: "pkcs8" }), cert: certificate.certPem, pinnedPeerSpki: [pending.invite.endpointPinRef] },
      connectTimeoutMs: null,
      allowInsecureLoopback: false
    };
    const channel = this.#options.pairingRelayChannelFactory?.(channelOptions)
      ?? new EntryPairingRelayChannel(channelOptions);
    pending.channel = channel;
    try {
      await channel.connect();
    } catch (error) {
      channel.close();
      if (pending.channel === channel) pending.channel = null;
      throw error;
    }
    const session = createPairingSession({
      invite: pending.invite,
      custody: this.#custody,
      endpoint: channel,
      device,
      entryPeerIdentity,
      boundRecoveryKeyId: pending.boundRecoveryKeyId,
      beforeComplete: (completion) => this.#persistPairingCompletionCheckpoint(pending, completion),
      now: this.#now
    });
    pending.session = session;
    let issued: ReturnType<PairingSession["snapshot"]>;
    try {
      issued = await session.begin();
    } catch (error) {
      session.interrupt();
      channel.close();
      if (pending.channel === channel) pending.channel = null;
      throw error;
    }
    if (issued.state === "challenge_issued" && issued.deviceId) {
      this.#apply({ type: "pairing.challenge_issued", deviceFingerprint: device.fingerprint });
    } else {
      const phase = pairingOutcomePhase(issued.state);
      if (phase) this.#apply({ type: "pairing.outcome", phase, refusal: issued.refusal });
      if (phase !== "retry_required") {
        channel.close();
        pending.channel = null;
      }
    }
  }

  async #startPairingStepUp(pending: PendingPairing): Promise<void> {
    const snapshot = pending.session?.snapshot();
    if (!snapshot?.account || !snapshot.target || !pending.bootstrap) {
      throw entryError("pairing_state_invalid", "Pairing has no endpoint-derived action target for fresh authorization.");
    }
    await this.#startDesktopTransaction({
      purpose: "step_up",
      actionPurpose: "pair_device",
      binding: snapshot.account,
      target: snapshot.target,
      bootstrapId: pending.bootstrap.bootstrapId
    });
  }

  async #completePairing(pending: PendingPairing): Promise<GuiState> {
    if (pending.completionTask) return pending.completionTask;
    if (pending.completion && pending.checkpointRef) return this.#replayPairingCompletion(pending);
    const task = Promise.resolve().then(() => this.#completePairingOnce(pending));
    pending.completionTask = task;
    try {
      return await task;
    } finally {
      if (pending.completionTask === task) pending.completionTask = null;
    }
  }

  async #completePairingOnce(pending: PendingPairing): Promise<GuiState> {
    if (!pending.session || !pending.channel || !pending.bootstrap || !pending.authorization) {
      throw entryError("pairing_state_invalid", "The restricted pairing challenge or factor permit is unavailable.");
    }
    const snapshot = await pending.session.submitProof(pending.authorization);
    if (snapshot.state === "enrolled" && snapshot.record) {
      try {
        return await this.#finalizePairing(pending, snapshot.record);
      } catch {
        this.#apply({
          type: "pairing.outcome",
          phase: "retry_required",
          refusal: "The endpoint confirmed pairing, but local admission persistence or checkpoint cleanup is incomplete. Retry to finish safely."
        });
        return this.snapshot();
      }
    }
    if (pending.completion && pending.checkpointRef) {
      pending.channel.close();
      pending.channel = null;
      if (this.#desktopTransaction) {
        await this.#accountClient().acknowledgeTransaction(
          this.#desktopTransaction.transaction.transactionId,
          this.#desktopTransaction.transaction.verifier
        ).catch(() => undefined);
      }
      this.#desktopTransaction = null;
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: snapshot.refusal ?? "The saved pairing completion has no confirmed receipt yet. Retry the same operation."
      });
      return this.snapshot();
    }
    if (snapshot.state === "retry_required") {
      this.#apply({ type: "pairing.outcome", phase: "retry_required", refusal: snapshot.refusal });
    } else {
      const phase = pairingOutcomePhase(snapshot.state);
      if (phase) this.#apply({ type: "pairing.outcome", phase, refusal: snapshot.refusal });
      pending.authorization = null;
      this.#desktopTransaction = null;
      this.#apply({ type: "account.updated", account: this.#accountView(snapshot.refusal ?? "The endpoint declined this pairing action.") });
    }
    return this.snapshot();
  }

  async #replayPairingCompletion(pending: PendingPairing): Promise<GuiState> {
    if (pending.completionTask) return pending.completionTask;
    const task = Promise.resolve().then(() => this.#replayPairingCompletionOnce(pending));
    pending.completionTask = task;
    try {
      return await task;
    } finally {
      if (pending.completionTask === task) pending.completionTask = null;
    }
  }

  async #replayPairingCompletionOnce(pending: PendingPairing): Promise<GuiState> {
    const completion = pending.completion;
    const bootstrap = pending.bootstrap;
    const device = pending.device;
    const checkpointRef = pending.checkpointRef;
    if (!completion || !bootstrap || !device || !checkpointRef) {
      throw entryError("pairing_completion_invalid", "The saved pairing completion is incomplete and cannot be replayed.");
    }
    const deviceKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: device.deviceId });
    if (!deviceKey) {
      this.#pairingCheckpointBlocked = true;
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: "The original device key is unavailable in protected storage; the submitted pairing remains pending."
      });
      return this.snapshot();
    }
    const certificate = issueDeviceCertificate({
      publicKeyRaw: rawEd25519Public(deviceKey),
      sign: custodyDeviceSigner(deviceKey),
      subject: `meshrix-entry ${device.deviceId}`
    });
    const relaySessionUrl = buildRelaySessionUrl(pending.invite.relayService, pending.invite.tenantId, pending.invite.endpointRouteId);
    const channelInput: PairingCompletionRelayChannelFactoryInput = {
      relaySessionUrl,
      bootstrap,
      invite: pending.invite,
      completion,
      innerTls: {
        key: deviceKey.export({ format: "pem", type: "pkcs8" }),
        cert: certificate.certPem,
        pinnedPeerSpki: [pending.invite.endpointPinRef]
      },
      connectTimeoutMs: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      allowInsecureLoopback: false
    };
    const defaultChannelOptions: EntryPairingCompletionRelayChannelOptions = {
      ...channelInput,
      ...(this.#options.transportFactory ? { transportFactory: this.#options.transportFactory } : {})
    };
    const channel = this.#options.pairingCompletionRelayChannelFactory?.(channelInput)
      ?? new EntryPairingCompletionRelayChannel(defaultChannelOptions);
    try {
      await channel.connect();
      const receipt = await channel.replayCompletion();
      if (receipt.outcome === "refused") {
        this.#apply({
          type: "pairing.outcome",
          phase: "retry_required",
          refusal: receipt.refusal
        });
        return this.snapshot();
      }
      if (receipt.capabilityGrantRef !== completion.target.grantRef
        || !Number.isSafeInteger(receipt.admissionGeneration) || receipt.admissionGeneration < 1
        || !Number.isSafeInteger(receipt.revocationRevision) || receipt.revocationRevision < 0) {
        this.#apply({
          type: "pairing.outcome",
          phase: "retry_required",
          refusal: "The endpoint receipt did not match the saved grant target. The operation remains pending."
        });
        return this.snapshot();
      }
      const record = this.#pairingRecordFromReceipt(pending, receipt);
      return await this.#finalizePairing(pending, record);
    } catch {
      this.#apply({
        type: "pairing.outcome",
        phase: "retry_required",
        refusal: "The endpoint did not confirm the saved pairing completion. Retry the same operation when reachable."
      });
      return this.snapshot();
    } finally {
      channel.close();
    }
  }

  #pairingRecordFromReceipt(pending: PendingPairing, receipt: PairingCompletionReceipt): EnrolledDeviceRecord {
    const completion = pending.completion;
    const device = pending.device;
    const expectedPeerId = peerIdForRouteDevice({
      tenantId: pending.invite.tenantId,
      routeId: pending.invite.endpointRouteId,
      deviceId: pending.invite.endpointDeviceId
    });
    const endpointPeerIdentity = receipt.endpointPeerIdentity;
    if (!completion || !device || receipt.capabilityGrantRef !== completion.target.grantRef
      || (pending.invite.mode === "personal" && !endpointPeerIdentity)
      || (endpointPeerIdentity !== null && (!expectedPeerId || !isPairingPeerIdentity(endpointPeerIdentity, expectedPeerId)))) {
      throw entryError("pairing_completion_invalid", "The endpoint receipt does not match the saved device grant.");
    }
    return {
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey,
      fingerprint: device.fingerprint,
      trustBinding: inviteToTrustBinding({
        invite: pending.invite,
        devicePublicKey: device.publicKey,
        deviceFingerprint: device.fingerprint,
        capabilityGrantRef: receipt.capabilityGrantRef,
        boundRecoveryKeyId: pending.boundRecoveryKeyId
      }),
      inviteId: pending.invite.inviteId,
      enrolledAt: new Date(this.#now()).toISOString(),
      capabilityGrantRef: receipt.capabilityGrantRef,
      admissionGeneration: receipt.admissionGeneration,
      revocationRevision: receipt.revocationRevision,
      endpointPeerIdentity
    };
  }

  async #finalizePairing(pending: PendingPairing, record: EnrolledDeviceRecord): Promise<GuiState> {
    const bootstrap = pending.bootstrap;
    const device = pending.device;
    const checkpointRef = pending.checkpointRef;
    if (!bootstrap || !device || !checkpointRef
      || record.deviceId !== device.deviceId
      || record.devicePublicKey !== device.publicKey
      || record.capabilityGrantRef !== pending.completion?.target.grantRef
      || (pending.invite.mode === "personal" && !record.endpointPeerIdentity)) {
      throw entryError("pairing_completion_invalid", "The enrolled record does not match its durable pairing checkpoint.");
    }
    const connectionId = `conn.${record.deviceId.toLowerCase().replace(/[^a-z0-9]/gu, ".")}`;
    const relayCredentialRef = custodyRelayRef(connectionId);
    await this.#custody.storeSecret({
      ref: relayCredentialRef,
      secret: new TextEncoder().encode(bootstrap.relayAdmission)
    });
    const stored: StoredConnection = {
      connectionId,
      displayLabel: `${pending.invite.endpointPrincipalRef} @ ${pending.invite.endpointRouteId}`,
      tenantId: pending.invite.tenantId,
      routeId: pending.invite.endpointRouteId,
      mode: pending.invite.mode,
      endpointPrincipalRef: pending.invite.endpointPrincipalRef,
      endpointDeviceId: pending.invite.endpointDeviceId,
      endpointPeerIdentity: record.endpointPeerIdentity,
      endpointSpkiPin: pending.invite.endpointPinRef,
      relayService: pending.invite.relayService,
      vaultId: pending.invite.vaultId,
      deviceId: record.deviceId,
      deviceFingerprint: record.fingerprint,
      capabilityGrantRef: record.capabilityGrantRef,
      accountActionTarget: pending.completion?.target ?? null,
      relayCredentialRef,
      boundRecoveryKeyId: pending.boundRecoveryKeyId,
      pairingService: null,
      admissionGeneration: record.admissionGeneration,
      revocationRevision: record.revocationRevision,
      enrolledAt: record.enrolledAt,
      remoteRevocation: "none",
      routeRevocation: null,
      accountBinding: bootstrap.account,
      rePairRequired: false,
      pairingCompletionCheckpointRef: checkpointRef
    };
    await this.#store.update((draft) => ({
      ...draft,
      connections: [...draft.connections.filter((entry) => entry.connectionId !== connectionId), stored]
    }));
    await this.#store.flush();

    // Durable admission and the matching connection now precede checkpoint
    // clearance. If a crash lands between these writes, the connection marker
    // proves receipt-backed finalization and startup can finish cleanup.
    await this.#custody.deleteSecret({ ref: checkpointRef });
    await this.#store.update((draft) => ({
      ...draft,
      pairingCompletionCheckpointRef: null,
      connections: draft.connections.map((connection) => connection.pairingCompletionCheckpointRef === checkpointRef
        ? { ...connection, pairingCompletionCheckpointRef: null }
        : connection)
    }));
    await this.#store.flush();
    pending.checkpointRef = null;
    pending.completion = null;
    pending.channel?.close();
    if (this.#desktopTransaction) {
      await this.#accountClient().acknowledgeTransaction(
        this.#desktopTransaction.transaction.transactionId,
        this.#desktopTransaction.transaction.verifier
      ).catch(() => undefined);
    }
    this.#desktopTransaction = null;
    this.#pendingPairing = null;
    this.#pairingCheckpointBlocked = false;
    this.#apply({ type: "pairing.enrolled", connection: connectionView({ ...stored, pairingCompletionCheckpointRef: null }) });
    this.#apply({ type: "account.updated", account: this.#accountView() });
    void this.refreshConnection(connectionId).catch(() => undefined);
    void this.publishSnapshot().catch(() => undefined);
    return this.snapshot();
  }

  async #initializeApplicationComposition(): Promise<void> {
    if (this.#applicationEngine && this.#applicationJournal && this.#agentRegistry && this.#applicationRouter) return;
    if (this.#applicationInitialization) return this.#applicationInitialization;
    const initialize = async (): Promise<void> => {
      const root = join(this.paths().dataDir, "personal-agent");
      const journal = new FilePeerApplicationJournal(join(root, "history"));
      const registry = new FileAcpAgentRegistry({
        filePath: join(root, "agents.json"),
        secretResolver: {
          resolve: async (reference) => {
            const bytes = await this.#custody.loadSecret({ ref: reference });
            if (!bytes) return null;
            try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
          }
        }
      });
      // Load before accepting inbound ACP requests; otherwise a valid enrolled
      // Agent could be mistaken for an unknown id during first recovery.
      await registry.list();
      const router = new EntryApplicationPeerRouter({
        resolvePeerAuthority: (address) => this.#resolveApplicationPeerAuthority(address)
      });
      const engine = new PeerApplicationEngine({ peer: router, journal, agents: registry });
      this.#applicationJournal = journal;
      this.#agentRegistry = registry;
      this.#applicationRouter = router;
      this.#applicationEngine = engine;
      this.#applicationChangeUnsubscribe = engine.onChange(() => {
        void this.#refreshApplicationsView(false).catch(() => undefined);
      });
      this.#applicationAuthorityUnsubscribe = router.onAuthorityResolved((address) => {
        if (!this.#started) return;
        void Promise.all([
          engine.resume(),
          router.retryPendingInbound(address)
        ]).then(() => this.#refreshApplicationsView(false)).catch(() => undefined);
      });
      // Interrupted prompt reservations are marked unknown by the engine. It
      // never repeats an ACP prompt whose billing/external effects are unknown.
      await engine.resume();
    };
    const pending = initialize();
    this.#applicationInitialization = pending;
    try {
      await pending;
    } catch (error) {
      this.#applicationInitialization = null;
      throw error;
    }
  }

  async #resolveApplicationPeerAuthority(address: PeerApplicationAddress): Promise<PeerApplicationRouteAuthority> {
    const connection = this.#store.config.connections.find((entry) => entry.mode === "personal"
      && entry.tenantId === address.tenantId
      && entry.routeId === address.routeId
      && entry.deviceId === address.localDeviceId
      && entry.endpointDeviceId === address.peerDeviceId);
    if (connection) {
      if (connection.rePairRequired || connection.routeRevocation?.authorityRevoked
        || !connection.accountBinding || !connection.endpointPeerIdentity) return "revoked";
      const account = this.#store.config.account;
      if (!account?.accountId || !account.authEpoch
        || account.accountId !== connection.accountBinding.accountId
        || account.authEpoch !== connection.accountBinding.authEpoch) return "revoked";
      const target = connection.accountActionTarget;
      if (!target) return "unavailable";
      const serviceConfig = this.#options.serviceConfig;
      if (!serviceConfig?.accountOrigin) return "unavailable";
      try {
        const key = await loadDevicePrivateKey({ custody: this.#custody, deviceId: connection.deviceId });
        const identity = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: connection.deviceId });
        if (!key || !identity) return "unavailable";
        if (identity.publicKey !== target.devicePublicKey
          || target.tenantId !== connection.tenantId
          || target.routeId !== connection.routeId
          || target.deviceId !== connection.deviceId) return "revoked";
        const authority = new AccountDeviceAuthorizationClient({
          origin: serviceConfig.accountOrigin,
          tenantId: connection.tenantId,
          routeId: connection.routeId,
          deviceId: connection.deviceId,
          signingKey: key,
          ...(this.#options.accountFetch ? { fetch: this.#options.accountFetch } : {})
        });
        const decision = await authority.check({
          peerDeviceId: connection.endpointDeviceId!,
          binding: connection.accountBinding,
          authorizedTargets: [target],
          scope: "peer:message"
        });
        return decision.state === "current" ? "current"
          : decision.state === "unavailable" ? "unavailable"
            : "revoked";
      } catch {
        return "unavailable";
      }
    }

    let runtime = this.#personalEndpoint;
    if (!runtime) {
      try {
        runtime = await this.#ensurePersonalEndpoint();
      } catch {
        return "unavailable";
      }
    }
    if (!runtime) return "unavailable";
    const identity = runtime?.endpointIdentity;
    if (!identity || identity.tenantId !== address.tenantId
      || identity.routeId !== address.routeId || identity.endpointDeviceId !== address.localDeviceId) return "revoked";
    try {
      return await runtime.resolvePeerAuthority(address);
    } catch {
      return "unavailable";
    }
  }

  async #ensurePersonalEndpoint(): Promise<PersonalEndpointRuntime | null> {
    if (this.#personalEndpoint) return this.#personalEndpoint;
    if (this.#personalEndpointStarting) return this.#personalEndpointStarting;
    const config = this.#options.serviceConfig;
    if (!config?.accountOrigin || !config.relayService) {
      this.#apply({
        type: "personal.endpoint",
        endpoint: Object.freeze({
          state: "action_required",
          tenantId: null,
          routeId: null,
          deviceId: null,
          fingerprint: null,
          relayState: "unknown",
          canCreatePairingInvite: false
        })
      });
      return null;
    }
    const creating = PersonalEndpointRuntime.create({
      dataDir: this.paths().dataDir,
      custody: this.#custody,
      accountOrigin: config.accountOrigin,
      relayService: config.relayService,
      ...(this.#options.accountFetch ? { fetch: this.#options.accountFetch } : {}),
      now: this.#now,
      onState: (snapshot) => this.#onPersonalEndpointState(snapshot)
    }).then((runtime) => {
      this.#personalEndpoint = runtime;
      this.#publishPersonalEndpointSnapshot(runtime.snapshot());
      return runtime;
    }).finally(() => {
      if (this.#personalEndpointStarting === creating) this.#personalEndpointStarting = null;
    });
    this.#personalEndpointStarting = creating;
    return creating;
  }

  async #restorePersonalRoutes(): Promise<void> {
    if (!this.#started) return;
    const endpoint = await this.#ensurePersonalEndpoint().catch(() => null);
    if (endpoint?.endpointIdentity) {
      try {
        const snapshot = await endpoint.start();
        this.#publishPersonalEndpointSnapshot(snapshot);
        await this.#syncPersonalEndpointPeerRoute();
      } catch {
        this.#publishPersonalEndpointSnapshot(endpoint.snapshot());
      }
    }
    const personal = this.#store.config.connections.filter((connection) =>
      connection.mode === "personal" && connection.endpointPeerIdentity !== null && !connection.rePairRequired);
    await Promise.allSettled(personal.map((connection) => this.refreshConnection(connection.connectionId)));
    await this.#refreshApplicationsView(true).catch(() => undefined);
    await this.#applicationEngine?.resume();
  }

  #personalEndpointView(snapshot: PersonalEndpointSnapshot): GuiPersonalEndpointView {
    const relayState = snapshot.routeState === "reachable" && snapshot.relayState === "open"
      ? "reachable"
      : snapshot.relayState === "closed" ? "unreachable" : "unknown";
    return Object.freeze({
      state: snapshot.state,
      tenantId: snapshot.endpoint?.tenantId ?? null,
      routeId: snapshot.endpoint?.routeId ?? null,
      deviceId: snapshot.endpoint?.endpointDeviceId ?? null,
      fingerprint: null,
      relayState,
      canCreatePairingInvite: snapshot.state === "connected" && snapshot.acceptsNewWork
    });
  }

  #publishPersonalEndpointSnapshot(snapshot: PersonalEndpointSnapshot): void {
    this.#apply({ type: "personal.endpoint", endpoint: this.#personalEndpointView(snapshot) });
  }

  #onPersonalEndpointState(snapshot: PersonalEndpointSnapshot): void {
    this.#publishPersonalEndpointSnapshot(snapshot);
    void this.#syncPersonalEndpointPeerRoute().then(async () => {
      if (snapshot.state === "connected") await this.#refreshApplicationDestinations();
      await this.#refreshApplicationsView(false);
      await this.#applicationEngine?.resume();
    }).catch(() => undefined);
  }

  async #syncPersonalEndpointPeerRoute(): Promise<void> {
    const runtime = this.#personalEndpoint;
    const identity = runtime?.endpointIdentity;
    const client = runtime?.peerClient;
    const previous = this.#personalEndpointPeerBinding;
    if (!runtime || !identity || !client) {
      if (previous) this.#applicationRouter?.unregister(previous);
      this.#personalEndpointPeerUnsubscribe?.();
      this.#personalEndpointPeerUnsubscribe = null;
      this.#personalEndpointPeerBinding = null;
      return;
    }
    if (previous?.client === client
      && previous.tenantId === identity.tenantId
      && previous.routeId === identity.routeId
      && previous.localDeviceId === identity.endpointDeviceId) return;
    if (previous) this.#applicationRouter?.unregister(previous);
    this.#personalEndpointPeerUnsubscribe?.();
    const binding: ApplicationPeerRouteBinding = {
      tenantId: identity.tenantId,
      routeId: identity.routeId,
      localDeviceId: identity.endpointDeviceId,
      client,
      allowsPeer: async (peerDeviceId) => Boolean(await runtime.resolvePairedPeerIdentity(peerDeviceId)),
      resolvePeerAuthority: (peerDeviceId) => runtime.resolvePeerAuthority({
        tenantId: identity.tenantId,
        routeId: identity.routeId,
        localDeviceId: identity.endpointDeviceId,
        peerDeviceId
      }),
      isReachable: (peerDeviceId) => runtime.isPeerReachable(peerDeviceId),
      subscribe: (handler) => runtime.onInboundMessage(({ message }) => handler(message))
    };
    this.#personalEndpointPeerBinding = binding;
    this.#personalEndpointPeerUnsubscribe = this.#applicationRouter!.register(binding);
  }

  #bindEntryApplicationPeer(stored: StoredConnection, runtime: EntryPeerRuntime): void {
    if (!this.#applicationRouter || !stored.endpointDeviceId || !stored.endpointPeerIdentity || stored.rePairRequired) return;
    const previous = this.#entryPeerBindings.get(stored.connectionId);
    if (previous?.binding.client === runtime.client) return;
    if (previous) {
      previous.unsubscribe();
      this.#applicationRouter.unregister(previous.binding);
    }
    const binding: ApplicationPeerRouteBinding = {
      tenantId: stored.tenantId,
      routeId: stored.routeId,
      localDeviceId: stored.deviceId,
      client: runtime.client,
      allowsPeer: (peerDeviceId) => {
        const current = this.#store.config.connections.find((entry) => entry.connectionId === stored.connectionId);
        return Boolean(current && !current.rePairRequired
          && current.endpointDeviceId === peerDeviceId
          && current.endpointPeerIdentity
          && current.accountBinding
          && this.#store.config.account?.accountId === current.accountBinding.accountId
          && this.#store.config.account.authEpoch === current.accountBinding.authEpoch);
      },
      resolvePeerAuthority: async (peerDeviceId) => {
        const current = this.#store.config.connections.find((entry) => entry.connectionId === stored.connectionId);
        if (!current || current.rePairRequired || current.routeRevocation?.authorityRevoked
          || current.endpointDeviceId !== peerDeviceId || peerDeviceId !== stored.endpointDeviceId
          || !current.endpointPeerIdentity || !current.accountBinding) return "revoked";
        const account = this.#store.config.account;
        return account?.accountId === current.accountBinding.accountId
          && account.authEpoch === current.accountBinding.authEpoch
          ? "current"
          : "revoked";
      },
      isReachable: (peerDeviceId) => {
        const live = this.#sessions.get(stored.connectionId);
        return peerDeviceId === stored.endpointDeviceId
          && Boolean(live?.session.channelEstablished && live.session.acceptsNewWork)
          && runtime.isPeerReachable(peerDeviceId);
      },
      subscribe: (handler) => {
        runtime.client.onInboundMessage(handler);
        return () => runtime.client.clearInboundMessageHandler();
      }
    };
    const unsubscribe = this.#applicationRouter.register(binding);
    this.#entryPeerBindings.set(stored.connectionId, { binding, unsubscribe });
  }

  #unbindEntryApplicationPeer(connectionId: string): void {
    const current = this.#entryPeerBindings.get(connectionId);
    if (!current) return;
    current.unsubscribe();
    this.#applicationRouter?.unregister(current.binding);
    this.#entryPeerBindings.delete(connectionId);
  }

  async #refreshApplicationDestinations(): Promise<void> {
    if (!this.#applicationRouter) return;
    const candidates = new Map<string, { readonly address: PeerApplicationAddress; readonly label: string }>();
    for (const stored of this.#store.config.connections) {
      if (stored.mode !== "personal" || stored.rePairRequired || !stored.endpointDeviceId || !stored.endpointPeerIdentity) continue;
      const address: PeerApplicationAddress = Object.freeze({
        tenantId: stored.tenantId,
        routeId: stored.routeId,
        localDeviceId: stored.deviceId,
        peerDeviceId: stored.endpointDeviceId
      });
      candidates.set(canonicalJson(address), { address, label: stored.displayLabel });
    }
    const runtime = this.#personalEndpoint;
    const identity = runtime?.endpointIdentity;
    if (runtime && identity && runtime.peerClient) {
      try {
        const entries = await runtime.listPairedEntryDevices();
        for (const entry of entries) {
          const address: PeerApplicationAddress = Object.freeze({
            tenantId: identity.tenantId,
            routeId: identity.routeId,
            localDeviceId: identity.endpointDeviceId,
            peerDeviceId: entry.deviceId
          });
          candidates.set(canonicalJson(address), { address, label: `Entry device ${entry.deviceId}` });
        }
      } catch {
        // A temporary account-authority outage removes these addresses from
        // the selectable catalog. Existing journal rows remain untouched.
      }
    }
    const destinations: ApplicationDestination[] = [];
    for (const { address, label } of candidates.values()) {
      let reachable = false;
      try { reachable = await this.#applicationRouter.isPeerReachable(address); } catch { reachable = false; }
      const handle = `dst.${createHash("sha256").update(canonicalJson(address), "utf8").digest("base64url").slice(0, 24)}`;
      destinations.push(Object.freeze({ handle, label, address, reachable }));
    }
    destinations.sort((left, right) => left.label.localeCompare(right.label) || left.handle.localeCompare(right.handle));
    this.#applicationDestinations = Object.freeze(destinations);
  }

  async #refreshApplicationsView(refreshDestinations: boolean): Promise<void> {
    if (!this.#applicationEngine || !this.#agentRegistry) return;
    const task = async (): Promise<void> => {
      if (refreshDestinations) await this.#refreshApplicationDestinations();
      const [agents, operations] = await Promise.all([
        this.#agentRegistry!.list(),
        this.#applicationEngine!.listOperations()
      ]);
      const summaries = await Promise.all(operations.map((record) => this.#operationSummary(record, this.#findDestinationLabel(record.routeAddress))));
      const view: GuiApplicationView = Object.freeze({
        destinations: Object.freeze(this.#applicationDestinations.map(({ handle, label, reachable }) => Object.freeze({ handle, label, reachable }))),
        agents: Object.freeze(agents.map((agent) => Object.freeze({
          id: agent.id,
          displayName: agent.displayName,
          enabled: agent.enabled,
          permissionMode: "ask" as const
        }))),
        operations: Object.freeze(summaries)
      });
      this.#apply({ type: "applications.updated", applications: view });
    };
    const next = this.#applicationRefreshTail.then(task, task);
    this.#applicationRefreshTail = next.catch(() => undefined);
    return next;
  }

  async #resolveApplicationDestination(handle: string): Promise<ApplicationDestination> {
    await this.#refreshApplicationDestinations();
    const destination = this.#applicationDestinations.find((candidate) => candidate.handle === handle);
    if (!destination) throw entryError("peer_route_unavailable", "The selected paired device is no longer authorized. Refresh the device list and choose it again.");
    return destination;
  }

  #findDestinationLabel(address: PeerApplicationAddress): string {
    return this.#applicationDestinations.find((destination) => samePeerApplicationAddress(destination.address, address))?.label
      ?? `Device ${address.peerDeviceId}`;
  }

  #operationTransportStatus(record: PeerApplicationRecord): string {
    if (record.inboundMessageId) return "received";
    return record.status === "delivery_pending" ? "pending" : "received";
  }

  async #operationSummary(record: PeerApplicationRecord, targetLabel: string) {
    return Object.freeze({
      operationId: record.operationId,
      direction: record.role === "caller" ? "outbound" as const : "inbound" as const,
      targetLabel,
      agentLabel: record.targetAgentId,
      status: record.status,
      transportStatus: this.#operationTransportStatus(record),
      updatedAt: record.updatedAt
    });
  }

  async #requestPersonalStepUp(request: PersonalEndpointStepUpRequest): Promise<{ readonly account: AccountAuthorityBinding; readonly permitId: string; readonly target: AccountActionTarget }> {
    const current = await this.#requireOSAccountSession();
    assertSameAccountBinding(current.account, request.account);
    const targetKey = canonicalAccountActionTarget(request.target);
    const existing = this.#pendingPersonalStepUp;
    if (existing) {
      if (existing.claimId !== request.claimId
        || canonicalJson(existing.account) !== canonicalJson(request.account)
        || canonicalAccountActionTarget(existing.target) !== targetKey) {
        throw entryError("account_transaction_pending", "Finish the exact personal route authorization already open before starting another account action.");
      }
      return existing.promise;
    }
    let resolve!: PendingPersonalStepUp["resolve"];
    let reject!: PendingPersonalStepUp["reject"];
    const promise = new Promise<{ readonly account: AccountAuthorityBinding; readonly permitId: string; readonly target: AccountActionTarget }>((yes, no) => { resolve = yes; reject = no; });
    const pending: PendingPersonalStepUp = Object.freeze({
      claimId: request.claimId,
      account: Object.freeze({ ...request.account }),
      target: request.target,
      promise,
      resolve,
      reject
    });
    this.#pendingPersonalStepUp = pending;
    try {
      await this.#startDesktopTransaction({
        purpose: "step_up",
        actionPurpose: "pair_device",
        binding: request.account,
        target: request.target,
        claimId: request.claimId
      });
    } catch (error) {
      if (this.#pendingPersonalStepUp === pending) this.#pendingPersonalStepUp = null;
      reject(error);
    }
    return promise;
  }

  async #requireOSAccountSession(): Promise<{ readonly account: AccountAuthorityBinding; readonly credential: string }> {
    if (this.#custodyTier !== "os" || !this.#custodyAvailable) {
      throw entryError("account_custody_required", "Account-bound device access requires an available OS-protected key store.");
    }
    const stored = this.#store.config.account;
    const credential = await this.#storedAccountCredential();
    if (!stored?.accountId || !stored.authEpoch || !credential) {
      throw entryError("account_login_required", "Sign in to the account before pairing an endpoint.");
    }
    return { account: { accountId: stored.accountId, authEpoch: stored.authEpoch }, credential };
  }

  #requireStarted(): void {
    if (!this.#started) throw entryError("recovery_state_invalid", "The service has not started.");
  }

  #requireConnection(connectionId: string): StoredConnection {
    const stored = this.#store.config.connections.find((connection) => connection.connectionId === connectionId);
    if (!stored) throw entryError("device_record_invalid", `Unknown connection ${connectionId}.`);
    return stored;
  }

  #pairingChannel(baseUrl: string): PairingChannelLike {
    return this.#options.pairingChannelFactory?.(baseUrl) ?? new HttpPairingChannel({ baseUrl });
  }

  #vaultTransport(baseUrl: string): VaultTransport {
    return this.#options.vaultTransportFactory?.(baseUrl) ?? new FetchVaultTransport({ baseUrl });
  }

  #recoveryChannelOptions(input: RecoveryChannelFactoryInput): EntryRecoveryChannelOptions {
    return {
      relaySessionUrl: input.relaySessionUrl,
      admission: input.admission,
      headers: input.headers,
      allowInsecureLoopback: allowLoopback(input.relaySessionUrl)
    };
  }

  #defaultServiceBase(): string {
    const configured = this.#store.config.pairingServiceDefault;
    if (configured) return configured;
    const first = this.#store.config.connections[0];
    if (first) return relayHttpBase(first.relayService);
    throw entryError("recovery_locator_missing", "No endpoint service address is known for the recovery vault.");
  }

  #buildBundle(): EntryRecoveryBundle {
    const recovery = this.#store.config.recovery;
    const connections: BundleConnection[] = this.#store.config.connections.map((connection) => ({
      connectionId: connection.connectionId,
      displayLabel: connection.displayLabel,
      routeId: connection.routeId,
      tenantId: connection.tenantId,
      mode: connection.mode,
      endpointSpkiPin: connection.endpointSpkiPin,
      principalRef: connection.endpointPrincipalRef,
      relayService: connection.relayService,
      vaultId: connection.vaultId ?? recovery?.vaultId ?? "",
      trustGeneration: recovery?.generation ?? 1,
      admissionGeneration: connection.admissionGeneration,
      revocationRevision: connection.revocationRevision,
      recoveryAuthority: recovery ? { keyId: recovery.keyId, generation: recovery.generation } : null
    }));
    return buildEntryRecoveryBundle({
      profileRef: "prof.entry-gui.1",
      displayLabel: this.#store.config.profile.displayLabel,
      connections,
      now: this.#now
    });
  }

  /**
   * File-fallback wrap secret: generated once, persisted owner-only inside the
   * owned data dir. macOS/Windows use the platform store instead; the file
   * tier is reported honestly and never pretends to be an OS store.
   */
  async #wrapSecret(dataDir: string): Promise<Uint8Array> {
    if (this.#options.custodyFileWrapSecret) return this.#options.custodyFileWrapSecret;
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "custody-wrap.key");
    try {
      const raw = await readFile(file);
      if (raw.byteLength === 32) return new Uint8Array(raw);
    } catch { /* ENOENT → mint below */ }
    const secret = randomBytes(32);
    await writeFile(file, secret, { mode: 0o600 });
    return new Uint8Array(secret);
  }

  /**
   * Abort the rotation bound to a pending candidate that is being dropped.
   * The record stays in config history; endpoints keep the incumbent.
   */
  #abandonPendingRotation(pending: PendingRecoverySecret): void {
    if (!pending.rotationId || !this.#rotationManager) return;
    const rotation = this.#rotationManager.get(pending.rotationId);
    if (rotation && rotation.state !== "completed" && rotation.state !== "aborted") {
      this.#rotationManager.abort(pending.rotationId);
      this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(pending.rotationId) });
    }
  }

  #discardExpiredRecoveryCandidate(): void {
    const pending = this.#pendingRecovery;
    if (!pending || pending.confirmation || pending.expiresAt > this.#now()) return;
    this.#abandonPendingRotation(pending);
    this.#pendingRecovery = null;
    this.#apply({ type: "recovery.candidateCancelled", recovery: pending.priorView });
  }

  /**
   * The newest non-terminal rotation regardless of which key it replaces —
   * after publication the candidate is the active key, so filtering by the
   * stored incumbent key alone would hide a still-open rotation.
   */
  #openRotation(): RecoveryRotation | null {
    const open = this.#rotationManager.loadAll()
      .filter((rotation) => rotation.state !== "completed" && rotation.state !== "aborted")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return open[0] ?? null;
  }

  #rotationView(rotationId: string) {
    const rotation = this.#rotationManager.get(rotationId);
    if (!rotation) return null;
    return {
      rotationId: rotation.rotationId,
      state: rotation.state,
      candidateGeneration: rotation.candidateGeneration,
      endpoints: rotation.endpoints.map((entry) => ({ endpointRouteId: entry.endpointRouteId, state: entry.state }))
    };
  }

  #activeRotationView() {
    const recovery = this.#store.config.recovery;
    if (!recovery) return null;
    const active = this.#openRotation();
    return active ? this.#rotationView(active.rotationId) : null;
  }

  #apply(event: GuiEvent): GuiState {
    this.#model.apply(event);
    const state = this.#model.snapshot();
    this.#emit(state);
    return state;
  }

  #notice(text: string): void {
    this.#apply({ type: "notice", text });
  }

  #emit(state: GuiState): void {
    for (const listener of this.#listeners) listener(state);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function journalBackupView(journal: StoredSnapshotJournal | null): { lastSuccessAt: string | null; lastCommittedRevision: number | null; lastError: string | null } {
  return {
    lastSuccessAt: journal?.lastSuccessAt ?? null,
    lastCommittedRevision: journal?.lastCommitted?.revision ?? null,
    lastError: journal?.lastError ?? null
  };
}

function allowLoopback(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function routeStateOf(state: string): GuiRouteState {
  return state === "reachable" || state === "unreachable" || state === "draining" ? state : "unknown";
}

/**
 * Fold the entry pairing state machine into the GUI outcome phases. The
 * wire-level "pending" has no GUI outcome equivalent — a begin() that never
 * transitioned keeps the phase it already showed rather than fabricating one.
 */
function pairingOutcomePhase(state: PairingState): Exclude<GuiPairingPhase, "idle" | "invite_ready" | "challenge_issued"> | null {
  switch (state) {
    case "proof_submitted":
    case "enrolled":
    case "refused":
    case "offline":
    case "retry_required":
    case "expired":
    case "cancelled":
      return state;
    default:
      return null;
  }
}

function errorCode(error: unknown): string {
  if (isEntryError(error)) return String(error.code);
  // Peer-client/crypto and channel errors all carry a stable string `code`.
  const tagged = (error as { code?: unknown }).code;
  if (typeof tagged === "string" && tagged) return tagged;
  return "unexpected";
}

function rawEd25519Public(privateKey: KeyObject): Uint8Array {
  const raw = Buffer.from(rawPublicKeyBase64Url(createPublicKey(privateKey)), "base64url");
  return new Uint8Array(raw);
}

/**
 * Wire the transport's delivery callbacks onto the session (handles both
 * shapes). Peer-schema messages demux to the peer runtime BEFORE the session
 * driver: they are request/response kinds on the same admitted channel and
 * the session layer must never interpret them. Admission/close transitions
 * open and close the peer channel gate so sends never ride a dead session.
 */
function attachTransport(
  transport: EntryTransportLike,
  session: EntrySessionLike,
  peer: EntryPeerRuntime | null | undefined,
  isCurrentGeneration: () => boolean,
  onRetryableFailure: (expectedRevocationRevision?: number) => void
): void {
  let retryableTerminal = false;
  const onMessage = (message: Readonly<Record<string, unknown>>) => {
    if (!isCurrentGeneration()) return;
    if (peer && isPeerSchemaMessage(message)) {
      peer.handleInbound(message);
      return;
    }
    const offeredKind = message.kind;
    const rejected = offeredKind === "session-rejected" ? parseSessionRejected(message) : null;
    const closed = offeredKind === "session-close" ? parseSessionClose(message) : null;
    const kind = session.handleMessage(message);
    if (peer) {
      const state = session.state;
      if ((kind === "session-admitted" || kind === "session-restored")
        && (state === "admitted" || state === "streaming")) {
        peer.onSessionAdmitted();
      } else if ((kind === "session-close" && state === "closed") || kind === "session-rejected") {
        peer.onSessionClosed();
      }
    }
    if (kind === "session-rejected" && session.state === "rejected" && rejected?.retryable === true) {
      retryableTerminal = true;
      onRetryableFailure(rejected.expectedRevocationRevision);
    } else if (kind === "session-close" && session.state === "closed"
      && (closed?.reason === "capacity_exceeded" || closed?.reason === "idle_timeout")) {
      retryableTerminal = true;
      onRetryableFailure();
    }
  };
  const onClose = () => {
    if (!isCurrentGeneration()) return;
    const stateBeforeClose = session.state;
    peer?.onSessionClosed();
    session.handleTransportClose();
    if (!retryableTerminal && stateBeforeClose !== "closed" && stateBeforeClose !== "rejected") {
      onRetryableFailure();
    }
  };
  if (transport.handlers) {
    transport.handlers.onMessage = onMessage;
    transport.handlers.onSocketClose = () => onClose();
  } else {
    transport.onMessage = onMessage;
    transport.onSocketClose = () => onClose();
    transport.onSocketDrop = () => onClose();
  }
}

/**
 * The recovery endpoint surface: the channel is provisioned with the issued
 * fresh-device credential upstream of the first roundTrip; `open` is deferred
 * until the vault fetch succeeds so a missing snapshot never opens a session.
 */
function lazyRecoveryEndpoint(channel: RecoveryChannelLike): EntryRecoveryRoundTripPort {
  let opened = false;
  return {
    async roundTrip(input: { endpointRouteId: string; message: Record<string, unknown> }): Promise<unknown> {
      if (!opened) {
        await channel.open();
        opened = true;
      }
      return channel.roundTrip(input);
    }
  };
}

export function createEntryProductService(options: EntryProductServiceOptions): EntryProductService {
  return new EntryProductService(options);
}
