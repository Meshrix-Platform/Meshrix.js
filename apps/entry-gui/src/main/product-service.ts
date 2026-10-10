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
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";

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
  entryError,
  formatRecoveryText,
  generateRecoveryKey,
  isEntryError,
  loadDevicePrivateKey,
  parsePairingInviteText,
  parseRecoveryText,
  rawPublicKeyBase64Url,
  selectCustodyAdapter,
  buildEntryRecoveryBundle,
  type BundleConnection,
  type CustodyAdapter,
  type CustodyPlatform,
  type EntryRecoveryBundle,
  type PairingEndpointPort,
  type PairingInvite,
  type PairingSession,
  type PairingState,
  type RecoveryMaterial,
  type RecoveryRotation,
  type RotationDurablePort,
  type SnapshotJournal,
  type SnapshotJournalPort,
  type VaultTransport
} from "@meshrix/entry";
import {
  EntryRelaySession,
  createEntryMcpBridge,
  createEntryRecoveryChannel,
  createWssRelayTransport,
  type EntryMcpBridge,
  type EntryRecoveryChannelOptions,
  type EntryRecoveryRoundTripPort,
  type EntrySessionOptions
} from "@meshrix/entry-transport";
import type { RelayAdmissionInput, RelayTransportPort } from "@meshrix/gateway/private-endpoint";

import { EntryGuiModel, restoreGuiState, type GuiEvent } from "../shared/gui-model.ts";
import type {
  GuiConnectionView,
  GuiInviteSummary,
  GuiPairingPhase,
  GuiRouteState,
  GuiState
} from "../shared/gui-state.ts";
import type { GuiIpcResult, GuiOp } from "../shared/ipc-contract.ts";
import {
  EntryConfigStore,
  type StoredConnection,
  type StoredRotation,
  type StoredSnapshotJournal
} from "./config-store.ts";
import { custodyDeviceSigner, issueDeviceCertificate } from "./device-cert.ts";
import { HttpPairingChannel, type PairingEnrollmentExtras } from "./pairing-channel.ts";
import { buildMcpStdioSnippet, managedMcpConfigPath, writeManagedMcpConfig } from "./mcp-config.ts";
import { ownedPathsFor, type EntryLifecyclePaths } from "./lifecycle.ts";

/** The endpoint admin surface: pairing exchange plus the recovery-access provisioning seam. */
export interface PairingChannelLike extends PairingEndpointPort {
  enrollmentExtras?(): PairingEnrollmentExtras;
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

export interface RecoveryChannelFactoryInput {
  readonly relaySessionUrl: string;
  readonly admission: RelayAdmissionInput;
  readonly headers: Record<string, string>;
}

export type RecoveryChannelLike = EntryRecoveryRoundTripPort & {
  open(): Promise<void>;
  close(): void;
};

export interface EntryProductServiceOptions {
  /** Owned data directory — the only place the app writes. */
  readonly dataDir: string;
  readonly appVersion?: string;
  /** Executable path used in the stdio MCP snippet (electron app.getPath("exe")). */
  readonly appExePath?: string;
  readonly custody?: CustodyAdapter;
  readonly custodyPlatform?: CustodyPlatform;
  /** File-fallback wrap secret — persisted per-install when not supplied. */
  readonly custodyFileWrapSecret?: Uint8Array;
  readonly now?: () => number;
  readonly pairingChannelFactory?: (baseUrl: string) => PairingChannelLike;
  readonly recoveryChannelFactory?: (input: RecoveryChannelFactoryInput) => RecoveryChannelLike;
  readonly vaultTransportFactory?: (baseUrl: string) => VaultTransport;
  readonly sessionFactory?: (options: EntrySessionOptions) => EntrySessionLike;
  readonly transportFactory?: (input: { url: string; headers: Record<string, string> }) => EntryTransportLike;
  /** Connect budget for the pinned inner channel (default 15s). */
  readonly connectTimeoutMs?: number;
}

const CUSTODY_RELAY_REF_PREFIX = "entry-gui.relay";
const CUSTODY_RECOVERY_REF_PREFIX = "entry-gui.recovery";
/** The save window for a pending recovery key — the pending secret is dropped after it. */
const MAX_RECOVERY_SECRET_WINDOW_MS = 10 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

interface PendingRecoverySecret {
  readonly recoveryText: string;
  readonly material: RecoveryMaterial;
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
  readonly rotationId: string | null;
  revealed: boolean;
  readonly expiresAt: number;
}

interface PendingPairing {
  readonly session: PairingSession;
  readonly channel: PairingChannelLike;
  readonly invite: PairingInvite;
  readonly baseUrl: string;
}

function custodyRelayRef(connectionId: string): string {
  return `${CUSTODY_RELAY_REF_PREFIX}.${connectionId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}
function custodyRecoveryRef(vaultId: string): string {
  return `${CUSTODY_RECOVERY_REF_PREFIX}.${vaultId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}

function summarizeInvite(invite: PairingInvite): GuiInviteSummary {
  return {
    inviteId: invite.inviteId,
    endpointRouteId: invite.endpointRouteId,
    tenantId: invite.tenantId,
    mode: invite.mode,
    endpointPrincipalRef: invite.endpointPrincipalRef,
    endpointSpkiPin: invite.endpointSpkiPin,
    relayService: invite.relayService,
    vaultId: invite.vaultId,
    expiresAt: invite.expiresAt
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
    endpointSpkiPin: stored.endpointSpkiPin,
    deviceId: stored.deviceId,
    deviceFingerprint: stored.deviceFingerprint,
    routeState: live?.routeState ?? "unknown",
    channelEstablished: live?.channelEstablished ?? false,
    acceptsNewWork: live?.acceptsNewWork ?? false,
    boundRecoveryKeyId: stored.boundRecoveryKeyId,
    revocation: stored.remoteRevocation === "applied"
      ? "remote_applied"
      : stored.remoteRevocation === "pending"
        ? "remote_pending"
        : "none",
    vaultId: stored.vaultId,
    capabilityGrantRef: stored.capabilityGrantRef
  };
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
  save(journal: SnapshotJournal): void {
    void this.#store.update((draft) => ({ ...draft, journal: journal as StoredSnapshotJournal }));
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

  #custody!: CustodyAdapter;
  #custodyTier: "os" | "file" = "file";
  #custodyReason = "custody not selected";
  #store!: EntryConfigStore;
  #started = false;

  #pendingPairing: PendingPairing | null = null;
  #pendingRecovery: PendingRecoverySecret | null = null;
  #recoveryMaterial: RecoveryMaterial | null = null;
  #sessions = new Map<string, LiveSession>();
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
            rotation: this.#activeRotationView()
          }
        : null,
      mcp: { snippet: null, configuredPath: this.#store.config.mcp.managedConfigPath }
    });
    this.#emit(state);
    return state;
  }

  paths(): EntryLifecyclePaths {
    return { dataDir: this.#options.dataDir };
  }

  async stop(): Promise<GuiState> {
    // Mark stopped first: an in-flight import/rotation delivery checks this
    // before creating a channel, so nothing joins the set after it is closed.
    this.#started = false;
    this.#apply({ type: "lifecycle.state", state: "stopping" });
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
    this.#pendingPairing = null;
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
      const code = isEntryError(error) ? String(error.code) : "unexpected";
      return { ok: false, error: { code, message: (error as Error).message } };
    }
  }

  async #dispatch(op: GuiOp, args?: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (op) {
      case "state.get":
        return this.snapshot();
      case "pairing.submitInvite":
        return this.submitPairingInvite({
          inviteText: String(a.inviteText ?? ""),
          pairingService: typeof a.pairingService === "string" ? a.pairingService : undefined
        });
      case "pairing.confirm":
        return this.confirmPairing();
      case "pairing.cancel":
        return this.cancelPairing();
      case "pairing.reset":
        return this.resetPairing();
      case "connection.refresh":
        return this.refreshConnection(String(a.connectionId ?? ""));
      case "connection.revoke":
        return this.revokeConnection({ connectionId: String(a.connectionId ?? ""), remote: a.remote === true });
      case "recovery.beginSetup":
        return this.beginRecoverySetup();
      case "recovery.revealKey":
        return this.revealRecoveryKey();
      case "recovery.confirmSaved":
        return this.confirmRecoverySaved();
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

  async submitPairingInvite(input: { inviteText: string; pairingService?: string }): Promise<GuiState> {
    this.#requireStarted();
    const invite = parsePairingInviteText(input.inviteText, { now: this.#now });
    const baseUrl = input.pairingService ?? this.#store.config.pairingServiceDefault ?? serviceBaseFromRelay(invite.relayService);
    const channel = this.#pairingChannel(baseUrl);
    const session = createPairingSession({
      invite,
      custody: this.#custody,
      endpoint: channel,
      boundRecoveryKeyId: this.#store.config.recovery?.keyId ?? null
    });
    this.#pendingPairing = { session, channel, invite, baseUrl };

    this.#apply({ type: "pairing.invite_ready", sessionId: session.sessionId, invite: summarizeInvite(invite) });
    const snapshot = await session.begin();
    if (snapshot.state === "challenge_issued" && snapshot.deviceId) {
      const device = await deviceIdentityFromCustody({ custody: this.#custody, deviceId: snapshot.deviceId });
      this.#apply({ type: "pairing.challenge_issued", deviceFingerprint: device?.fingerprint ?? snapshot.deviceId });
      await this.#store.update((draft) => ({ ...draft, pairingServiceDefault: baseUrl }));
    } else {
      const phase = pairingOutcomePhase(snapshot.state);
      if (phase) this.#apply({ type: "pairing.outcome", phase, refusal: snapshot.refusal });
    }
    return this.snapshot();
  }

  async confirmPairing(): Promise<GuiState> {
    const pending = this.#pendingPairing;
    if (!pending) throw entryError("pairing_state_invalid", "No pairing session is awaiting confirmation.");
    const snapshot = await pending.session.submitProof();
    if (snapshot.state === "enrolled" && snapshot.record) {
      const record = snapshot.record;
      const extras = pending.channel.enrollmentExtras?.() ?? { relayCredential: null, admissionGeneration: null, revocationRevision: null };
      const connectionId = `conn.${record.deviceId.toLowerCase().replace(/[^a-z0-9]/gu, ".")}`;
      const relayCredentialRef = custodyRelayRef(connectionId);
      if (extras.relayCredential) {
        await this.#custody.storeSecret({ ref: relayCredentialRef, secret: new TextEncoder().encode(extras.relayCredential) });
      }
      const stored: StoredConnection = {
        connectionId,
        displayLabel: `${pending.invite.endpointPrincipalRef} @ ${pending.invite.endpointRouteId}`,
        tenantId: pending.invite.tenantId,
        routeId: pending.invite.endpointRouteId,
        mode: pending.invite.mode,
        endpointPrincipalRef: pending.invite.endpointPrincipalRef,
        endpointSpkiPin: pending.invite.endpointSpkiPin,
        relayService: pending.invite.relayService,
        vaultId: pending.invite.vaultId,
        deviceId: record.deviceId,
        deviceFingerprint: record.fingerprint,
        capabilityGrantRef: record.capabilityGrantRef,
        relayCredentialRef,
        boundRecoveryKeyId: this.#store.config.recovery?.keyId ?? null,
        pairingService: pending.baseUrl,
        admissionGeneration: extras.admissionGeneration ?? 1,
        revocationRevision: extras.revocationRevision ?? 0,
        enrolledAt: record.enrolledAt,
        remoteRevocation: "none"
      };
      await this.#store.update((draft) => ({
        ...draft,
        connections: [...draft.connections.filter((entry) => entry.connectionId !== connectionId), stored]
      }));
      this.#apply({ type: "pairing.enrolled", connection: connectionView(stored) });
      this.#pendingPairing = null;
      if (!extras.relayCredential) {
        this.#notice("Enrollment carried no relay credential; the connection cannot open until the endpoint issues one.");
      }
      void this.refreshConnection(connectionId).catch(() => undefined);
      void this.publishSnapshot().catch(() => undefined);
      return this.snapshot();
    }
    const phase = pairingOutcomePhase(snapshot.state);
    if (phase) this.#apply({ type: "pairing.outcome", phase, refusal: snapshot.refusal });
    return this.snapshot();
  }

  cancelPairing(): GuiState {
    this.#pendingPairing?.session.cancel();
    this.#pendingPairing = null;
    this.#apply({ type: "pairing.outcome", phase: "cancelled" });
    return this.snapshot();
  }

  resetPairing(): GuiState {
    this.#pendingPairing = null;
    this.#apply({ type: "pairing.reset" });
    return this.snapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                               */
  /* ---------------------------------------------------------------- */

  async refreshConnection(connectionId: string): Promise<GuiState> {
    this.#requireStarted();
    const stored = this.#requireConnection(connectionId);
    this.#sessions.get(connectionId)?.session.close("normal");

    const credential = await this.#custody.loadSecret({ ref: stored.relayCredentialRef });
    if (!credential) {
      this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      this.#notice(`Connection ${connectionId} has no relay credential in custody; re-pairing is required.`);
      return this.snapshot();
    }
    const deviceKey = await loadDevicePrivateKey({ custody: this.#custody, deviceId: stored.deviceId });
    if (!deviceKey) {
      this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      this.#notice(`Connection ${connectionId} lost its device key; re-pair or recover.`);
      return this.snapshot();
    }

    const certificate = issueDeviceCertificate({
      publicKeyRaw: rawEd25519Public(deviceKey),
      sign: custodyDeviceSigner(deviceKey),
      subject: `meshrix-entry ${stored.deviceId}`
    });
    const url = relaySessionWsUrl(stored.relayService, stored.tenantId, stored.routeId);
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
        this.#apply({ type: "connection.state", connectionId, routeState: routeStateOf(state) });
      },
      onClosed: () => {
        this.#apply({ type: "connection.state", connectionId, routeState: "unreachable", channelEstablished: false, acceptsNewWork: false });
      },
      onChannelLost: () => {
        this.#apply({ type: "connection.state", connectionId, channelEstablished: false, acceptsNewWork: false });
      }
    };
    const session = this.#options.sessionFactory?.(sessionOptions)
      ?? new EntryRelaySession(sessionOptions);
    const bridge = createEntryMcpBridge({ session });
    this.#sessions.set(connectionId, { session, transport, bridge });
    attachTransport(transport, session);

    // connect() resolves only when the pinned inner channel is live; an
    // offline endpoint leaves the session admitted-but-unlinked — the view
    // updates whenever the handshake finishes or the budget lapses.
    this.#apply({ type: "connection.state", connectionId, routeState: "unknown", channelEstablished: false, acceptsNewWork: false });
    void session.connect()
      .then(() => {
        this.#apply({
          type: "connection.state",
          connectionId,
          routeState: routeStateOf(session.routeState),
          channelEstablished: session.channelEstablished,
          acceptsNewWork: session.acceptsNewWork
        });
      })
      .catch((error: unknown) => {
        this.#apply({ type: "connection.state", connectionId, channelEstablished: false, acceptsNewWork: false });
        this.#notice(`Connection ${connectionId} did not establish its pinned channel (${errorCode(error)}).`);
      });
    return this.snapshot();
  }

  /** The live MCP bridge for a connection (main-process only). */
  bridgeFor(connectionId: string): EntryMcpBridge | null {
    return this.#sessions.get(connectionId)?.bridge ?? null;
  }

  async revokeConnection(input: { connectionId: string; remote?: boolean }): Promise<GuiState> {
    this.#requireStarted();
    const stored = this.#requireConnection(input.connectionId);
    const live = this.#sessions.get(input.connectionId);
    try { live?.session.close("normal"); } catch { /* dead */ }
    try { live?.transport.close(); } catch { /* dead */ }
    this.#sessions.delete(input.connectionId);
    // Only entry-owned refs are deleted — custody files under entry-gui.*
    // and the config record. Nothing outside the owned boundary is touched.
    await deleteDeviceKey({ custody: this.#custody, deviceId: stored.deviceId });
    await this.#custody.deleteSecret({ ref: stored.relayCredentialRef }).catch(() => undefined);

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
      connections: draft.connections.filter((entry) => entry.connectionId !== input.connectionId)
    }));
    this.#apply({ type: "connection.state", connectionId: input.connectionId, revocation: remoteRevocation === "applied" ? "remote_applied" : "remote_pending" });
    this.#apply({ type: "connection.removed", connectionId: input.connectionId });
    this.#notice(
      remoteRevocation === "applied"
        ? "Connection revoked locally; remote enforcement confirmed."
        : "Connection revoked locally; remote enforcement is pending — the endpoint applies it on its next authority check."
    );
    return this.snapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Recovery — setup, reveal-once, import, rotation                    */
  /* ---------------------------------------------------------------- */

  beginRecoverySetup(): GuiState {
    this.#requireStarted();
    if (this.#store.config.recovery) {
      throw entryError("recovery_state_invalid", "A recovery key is already configured; begin a rotation instead.");
    }
    const vaultId = this.#store.config.connections.find((connection) => connection.vaultId)?.vaultId
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
      revealed: false,
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
      throw entryError("recovery_state_invalid", "The recovery key save window expired; generate a fresh key.");
    }
    pending.revealed = true;
    this.#apply({ type: "recovery.revealed" });
    return { recoveryText: pending.recoveryText, vaultId: pending.vaultId, keyId: pending.keyId };
  }

  async confirmRecoverySaved(): Promise<GuiState> {
    const pending = this.#pendingRecovery;
    if (!pending || !pending.revealed) {
      throw entryError("recovery_state_invalid", "The recovery text must be revealed and saved before confirmation.");
    }
    const materialRef = custodyRecoveryRef(pending.vaultId);
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
        confirmedAt: new Date(this.#now()).toISOString()
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
  async publishSnapshot(): Promise<GuiState> {
    const recovery = this.#store.config.recovery;
    const material = this.#recoveryMaterial;
    if (!recovery || !material) return this.snapshot();
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
        break;
      case "superseded":
        this.#apply({ type: "recovery.backup", lastError: `snapshot generation superseded (vault at generation ${outcome.generation})` });
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
        relaySessionUrl: relaySessionWsUrl(serviceBase, access.tenantId, access.routeId),
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
        relaySessionUrl: relaySessionWsUrl(serviceBase, access.tenantId, access.routeId),
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
              remoteRevocation: "none"
            };
            const material = deriveRecoveryMaterial(parsed.secret);
            const materialRef = custodyRecoveryRef(connection.vaultId);
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
                confirmedAt: new Date(this.#now()).toISOString()
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
    const recovery = this.#store.config.recovery;
    const material = this.#recoveryMaterial;
    if (!recovery || !material) {
      throw entryError("recovery_state_invalid", "No active recovery key to rotate.");
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
      revealed: false,
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
        relaySessionUrl: relaySessionWsUrl(stored.relayService, stored.tenantId, routeId),
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
        relaySessionUrl: relaySessionWsUrl(stored.relayService, stored.tenantId, routeId),
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
    if (!this.#store.config.recovery) {
      throw entryError("recovery_state_invalid", "No recovery key is configured.");
    }
    const active = this.#openRotation();
    if (!active) {
      throw entryError("rotation_state_invalid", "No rotation is in flight.");
    }
    if (this.#pendingRecovery?.rotationId === active.rotationId) {
      this.#pendingRecovery = null;
    }
    const aborted = this.#rotationManager.abort(active.rotationId);
    this.#apply({ type: "recovery.rotation", rotation: this.#rotationView(aborted.rotationId) });
    return this.snapshot();
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
    if (first) return serviceBaseFromRelay(first.relayService);
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

function serviceBaseFromRelay(relayService: string): string {
  try {
    const url = new URL(relayService);
    if (url.protocol === "wss:") return `https://${url.host}`;
    if (url.protocol === "ws:") return `http://${url.host}`;
    return url.origin;
  } catch {
    return relayService;
  }
}

function relaySessionWsUrl(serviceOrRelayBase: string, tenantId: string, routeId: string): string {
  const url = new URL(serviceBaseFromRelay(serviceOrRelayBase));
  const proto = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  return `${proto}//${url.host}/session/${encodeURIComponent(tenantId)}/${encodeURIComponent(routeId)}`;
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
  return isEntryError(error) ? String(error.code) : (error as Error).name;
}

function rawEd25519Public(privateKey: KeyObject): Uint8Array {
  const raw = Buffer.from(rawPublicKeyBase64Url(createPublicKey(privateKey)), "base64url");
  return new Uint8Array(raw);
}

/** Wire the transport's delivery callbacks onto the session (handles both shapes). */
function attachTransport(transport: EntryTransportLike, session: EntrySessionLike): void {
  const onMessage = (message: Readonly<Record<string, unknown>>) => session.handleMessage(message);
  const onClose = () => session.handleTransportClose();
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
