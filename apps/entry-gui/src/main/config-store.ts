/**
 * Owned configuration store — the single JSON document the app persists.
 *
 * Holds only non-secret facts: connection records (identifiers, pins,
 * counters), recovery bookkeeping (locator, key id, generation), custody ref
 * names, and lifecycle metadata. Private keys, relay credentials, recovery
 * material and the pairing token live in the custody adapter or in memory —
 * pending backup ciphertext also stays here without its decryption key.
 * Treat the document as private metadata. It is written atomically
 * (tmp+rename) so a crash can never leave a torn config.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPairingPeerIdentity, type AccountActionTarget, type PairingPeerIdentity } from "@meshrix/contracts/account";
import { parseEncryptedRecoverySnapshot, peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import type { PendingSnapshotWrite } from "@meshrix/entry";

export const ENTRY_GUI_CONFIG_SCHEMA = "entry-gui-config-1";

export interface StoredConnection {
  readonly connectionId: string;
  readonly displayLabel: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointPrincipalRef: string;
  readonly endpointDeviceId: string | null;
  /** Signal identity authenticated by the exact pairing completion receipt. */
  readonly endpointPeerIdentity: PairingPeerIdentity | null;
  readonly endpointSpkiPin: string;
  readonly relayService: string;
  readonly vaultId: string | null;
  readonly deviceId: string;
  readonly deviceFingerprint: string;
  readonly capabilityGrantRef: string;
  /** Exact account-authorized grant target for live authority revalidation. */
  readonly accountActionTarget?: AccountActionTarget | null;
  /** Custody ref holding the relay bearer credential — the credential itself is never stored here. */
  readonly relayCredentialRef: string;
  readonly boundRecoveryKeyId: string | null;
  readonly pairingService: string | null;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly enrolledAt: string;
  /** Set when the user revoked locally; remote enforcement is tracked as a flag. */
  readonly remoteRevocation: "none" | "pending" | "applied";
  /** Exact account-authority revoke operation; persisted before its first request. */
  readonly routeRevocation: {
    readonly operationId: string;
    readonly target: "route" | "device";
    readonly authorityRevoked: boolean;
    readonly enforcement: "pending" | "complete";
  } | null;
  readonly accountBinding: { readonly accountId: string; readonly authEpoch: number } | null;
  readonly rePairRequired: boolean;
  /** Temporary custody-checkpoint reference retained across a confirmed-but-not-finalized pairing crash. */
  readonly pairingCompletionCheckpointRef?: string | null;
}

export interface StoredAccountClient {
  readonly desktopDeviceId: string;
  readonly accountId: string | null;
  readonly authEpoch: number | null;
  /** A ref only; the opaque credential is stored by the custody adapter. */
  readonly sessionCredentialRef: string | null;
}

export interface StoredRecovery {
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
  /** Custody ref holding derived writer/backup/signing material (never the root text). */
  readonly materialRef: string;
  readonly confirmedAt: string;
  /** Account-managed writers require current account registration after recovery. */
  readonly accountWriterState: "unmanaged" | "pending" | "complete";
  /** A newly registered account writer must reconcile the preserved remote
   * snapshot before another publication may replace it. */
  readonly accountSnapshotState: "ready" | "unverified" | "older_snapshot_preserved";
  /** Local OS-custody material reference used to decrypt the prior snapshot. */
  readonly snapshotSourceMaterialRef: string | null;
  /** Old private keys remain in OS custody for user-directed recovery of old snapshots. */
  readonly retainedMaterialRefs: readonly string[];
}

export interface StoredVaultWriterOperation {
  readonly operationId: string;
  readonly connectionId: string;
  readonly vaultId: string;
  readonly candidateKeyId: string;
  readonly generation: number;
  readonly materialRef: string;
  /** Ref to the exact retryable request/transaction, stored only in OS custody. */
  readonly flowRef: string;
  readonly state: "prepare_pending" | "authorization_required" | "completion_pending";
}

export interface StoredRotation {
  readonly rotationId: string;
  readonly incumbentKeyId: string;
  readonly incumbentGeneration: number;
  readonly candidateKeyId: string;
  readonly candidatePublicKey: string;
  readonly candidateGeneration: number;
  readonly principalRef: string;
  readonly state: "staged" | "published" | "acknowledging" | "completed" | "aborted";
  readonly endpoints: readonly { readonly endpointRouteId: string; readonly state: string; readonly detail?: string }[];
  /**
   * Replayable per-endpoint `rotation-begin` wire payloads — public keys and
   * signatures only, so an interrupted rotation can be redelivered after a
   * restart without rebuilding proof material.
   */
  readonly outbound: readonly { readonly endpointRouteId: string; readonly message: Record<string, unknown> }[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface StoredSnapshotJournal {
  readonly pendingWrite?: PendingSnapshotWrite | null;
  readonly lastCommitted: { readonly revision: number; readonly generation: number; readonly digest: string } | null;
  readonly highestSeen: { readonly revision: number; readonly generation: number } | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
}

export interface EntryGuiConfig {
  readonly schemaVersion: typeof ENTRY_GUI_CONFIG_SCHEMA;
  readonly profile: { readonly displayLabel: string };
  readonly connections: readonly StoredConnection[];
  readonly recovery: StoredRecovery | null;
  readonly accountVaultWriterOperation: StoredVaultWriterOperation | null;
  readonly journal: StoredSnapshotJournal | null;
  readonly rotations: readonly StoredRotation[];
  readonly mcp: { readonly managedConfigPath: string | null };
  readonly pairingServiceDefault: string | null;
  /** Opaque pointer only; the complete replayable pairing request is in OS custody. */
  readonly pairingCompletionCheckpointRef: string | null;
  readonly account: StoredAccountClient | null;
}

export function emptyEntryGuiConfig(): EntryGuiConfig {
  return {
    schemaVersion: ENTRY_GUI_CONFIG_SCHEMA,
    profile: { displayLabel: "Meshrix Entry" },
    connections: [],
    recovery: null,
    accountVaultWriterOperation: null,
    journal: null,
    rotations: [],
    mcp: { managedConfigPath: null },
    pairingServiceDefault: null,
    pairingCompletionCheckpointRef: null,
    account: null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
function opaque(value: unknown): string | null {
  return typeof value === "string" && OPAQUE.test(value) ? value : null;
}
function boundedText(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= max ? value : null;
}

function parseAccountActionTarget(value: unknown): AccountActionTarget | null {
  if (!isRecord(value)
    || typeof value.tenantId !== "string"
    || typeof value.routeId !== "string"
    || typeof value.deviceId !== "string"
    || typeof value.devicePublicKey !== "string"
    || typeof value.grantRef !== "string"
    || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => typeof scope === "string")) return null;
  return Object.freeze({
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    devicePublicKey: value.devicePublicKey,
    grantRef: value.grantRef,
    scopes: Object.freeze([...value.scopes] as string[])
  });
}

function parseStoredConnection(value: unknown): StoredConnection | null {
  if (!isRecord(value)) return null;
  const connectionId = opaque(value.connectionId);
  const deviceId = opaque(value.deviceId);
  const deviceFingerprint = opaque(value.deviceFingerprint);
  const tenantId = opaque(value.tenantId);
  const routeId = opaque(value.routeId);
  const principal = opaque(value.endpointPrincipalRef);
  const endpointDeviceId = value.endpointDeviceId == null ? null : opaque(value.endpointDeviceId);
  const expectedEndpointPeerId = peerIdForRouteDevice({
    tenantId: tenantId ?? "",
    routeId: routeId ?? "",
    deviceId: endpointDeviceId ?? ""
  });
  const endpointPeerIdentity = value.endpointPeerIdentity === null || value.endpointPeerIdentity === undefined
    ? null
    : expectedEndpointPeerId !== null && isPairingPeerIdentity(value.endpointPeerIdentity, expectedEndpointPeerId)
      ? Object.freeze({ ...value.endpointPeerIdentity })
      : null;
  const routeRevocation = isRecord(value.routeRevocation)
    && opaque(value.routeRevocation.operationId)
    && (value.routeRevocation.target === "route" || value.routeRevocation.target === "device")
    && typeof value.routeRevocation.authorityRevoked === "boolean"
    && (value.routeRevocation.enforcement === "pending" || value.routeRevocation.enforcement === "complete")
    ? Object.freeze({
        operationId: opaque(value.routeRevocation.operationId)!,
        target: value.routeRevocation.target,
        authorityRevoked: value.routeRevocation.authorityRevoked,
        enforcement: value.routeRevocation.enforcement
      })
    : null;
  const spkiPin = boundedText(value.endpointSpkiPin, 128);
  const relayService = boundedText(value.relayService);
  const relayCredentialRef = opaque(value.relayCredentialRef);
  const capabilityGrantRef = opaque(value.capabilityGrantRef) ?? "none";
  const enrolledAt = boundedText(value.enrolledAt, 64) ?? "";
  const admissionGeneration = Number.isSafeInteger(value.admissionGeneration) ? Number(value.admissionGeneration) : 1;
  const revocationRevision = Number.isSafeInteger(value.revocationRevision) ? Number(value.revocationRevision) : 0;
  const mode = value.mode === "enterprise" ? "enterprise" : "personal";
  if (!connectionId || !deviceId || !deviceFingerprint || !tenantId || !routeId || !principal || !spkiPin || !relayService || !relayCredentialRef
    || (value.endpointPeerIdentity !== null && value.endpointPeerIdentity !== undefined && endpointPeerIdentity === null)
    || (value.routeRevocation !== null && value.routeRevocation !== undefined && routeRevocation === null)) {
    return null;
  }
  return {
    connectionId,
    displayLabel: boundedText(value.displayLabel, 128) ?? connectionId,
    tenantId,
    routeId,
    mode,
    endpointPrincipalRef: principal,
    endpointDeviceId,
    endpointPeerIdentity,
    endpointSpkiPin: spkiPin,
    relayService,
    vaultId: value.vaultId === null || value.vaultId === undefined ? null : opaque(value.vaultId),
    deviceId,
    deviceFingerprint,
    capabilityGrantRef,
    accountActionTarget: parseAccountActionTarget(value.accountActionTarget),
    relayCredentialRef,
    boundRecoveryKeyId: value.boundRecoveryKeyId == null ? null : opaque(value.boundRecoveryKeyId),
    pairingService: value.pairingService == null ? null : boundedText(value.pairingService),
    admissionGeneration,
    revocationRevision,
    enrolledAt,
    remoteRevocation: value.remoteRevocation === "pending" || value.remoteRevocation === "applied" ? value.remoteRevocation : "none",
    routeRevocation,
    accountBinding: isRecord(value.accountBinding)
      && typeof value.accountBinding.accountId === "string"
      && Number.isSafeInteger(value.accountBinding.authEpoch)
      ? { accountId: value.accountBinding.accountId, authEpoch: Number(value.accountBinding.authEpoch) }
      : null,
    rePairRequired: value.rePairRequired === true,
    pairingCompletionCheckpointRef: typeof value.pairingCompletionCheckpointRef === "string"
      && /^entry-gui\.pairing\.completion\.[a-f0-9]{32}$/u.test(value.pairingCompletionCheckpointRef)
      ? value.pairingCompletionCheckpointRef
      : null
  };
}

function parseStoredAccount(value: unknown): StoredAccountClient | null {
  if (!isRecord(value)) return null;
  const desktopDeviceId = opaque(value.desktopDeviceId);
  if (!desktopDeviceId) return null;
  const accountId = value.accountId === null || value.accountId === undefined ? null : opaque(value.accountId);
  const authEpoch = value.authEpoch === null || value.authEpoch === undefined
    ? null
    : Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0 ? Number(value.authEpoch) : null;
  const sessionCredentialRef = value.sessionCredentialRef === null || value.sessionCredentialRef === undefined
    ? null
    : opaque(value.sessionCredentialRef);
  if ((accountId === null) !== (authEpoch === null)) return null;
  return { desktopDeviceId, accountId, authEpoch, sessionCredentialRef };
}

function parseVaultWriterOperation(value: unknown): StoredVaultWriterOperation | null {
  if (!isRecord(value)) return null;
  const operationId = opaque(value.operationId);
  const connectionId = opaque(value.connectionId);
  const vaultId = opaque(value.vaultId);
  const candidateKeyId = opaque(value.candidateKeyId);
  const materialRef = opaque(value.materialRef);
  const flowRef = opaque(value.flowRef);
  const generation = Number.isSafeInteger(value.generation) ? Number(value.generation) : 0;
  const states = new Set(["prepare_pending", "authorization_required", "completion_pending"]);
  if (!operationId || !connectionId || !vaultId || !candidateKeyId || !materialRef || !flowRef
    || generation < 1 || !states.has(String(value.state))) return null;
  return {
    operationId,
    connectionId,
    vaultId,
    candidateKeyId,
    generation,
    materialRef,
    flowRef,
    state: value.state as StoredVaultWriterOperation["state"]
  };
}

function parseJournal(value: unknown): StoredSnapshotJournal | null {
  if (!isRecord(value)) return null;
  const committed = isRecord(value.lastCommitted)
    ? {
        revision: Number.isSafeInteger(value.lastCommitted.revision) ? Number(value.lastCommitted.revision) : 0,
        generation: Number.isSafeInteger(value.lastCommitted.generation) ? Number(value.lastCommitted.generation) : 1,
        digest: boundedText(value.lastCommitted.digest, 128) ?? ""
      }
    : null;
  const highest = isRecord(value.highestSeen)
    ? {
        revision: Number.isSafeInteger(value.highestSeen.revision) ? Number(value.highestSeen.revision) : 0,
        generation: Number.isSafeInteger(value.highestSeen.generation) ? Number(value.highestSeen.generation) : 1
      }
    : null;
  const pending = isRecord(value.pendingWrite) ? value.pendingWrite : null;
  const envelope = pending ? parseEncryptedRecoverySnapshot(pending.snapshot) : null;
  const pendingWrite: PendingSnapshotWrite | null = pending && envelope
    && typeof pending.writerKeyId === "string" && pending.writerKeyId.length <= 128
    && pending.vaultId === envelope.vaultId && pending.generation === envelope.generation
    && Number.isSafeInteger(pending.expectedRevision) && Number(pending.expectedRevision) >= 0
    && Number(pending.expectedRevision) + 1 === envelope.revision
    && typeof pending.inputDigest === "string" && /^[a-f0-9]{64}$/u.test(pending.inputDigest)
    ? { vaultId: envelope.vaultId, writerKeyId: pending.writerKeyId,
        generation: envelope.generation, expectedRevision: Number(pending.expectedRevision),
        inputDigest: pending.inputDigest, snapshot: pending.snapshot as Record<string, unknown> }
    : null;
  return {
    pendingWrite,
    lastCommitted: committed,
    highestSeen: highest,
    lastSuccessAt: boundedText(value.lastSuccessAt, 64),
    lastError: boundedText(value.lastError, 256)
  };
}

const ROTATION_STATES = new Set(["staged", "published", "acknowledging", "completed", "aborted"]);
function parseRotation(value: unknown): StoredRotation | null {
  if (!isRecord(value)) return null;
  const rotationId = opaque(value.rotationId);
  const incumbentKeyId = opaque(value.incumbentKeyId);
  const candidateKeyId = opaque(value.candidateKeyId);
  const principalRef = opaque(value.principalRef);
  if (!rotationId || !incumbentKeyId || !candidateKeyId || !principalRef) return null;
  const state = ROTATION_STATES.has(String(value.state)) ? value.state as StoredRotation["state"] : "staged";
  const endpoints = Array.isArray(value.endpoints)
    ? value.endpoints.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const routeId = opaque(entry.endpointRouteId);
        if (!routeId) return [];
        return [{
          endpointRouteId: routeId,
          state: boundedText(entry.state, 32) ?? "staged",
          detail: boundedText(entry.detail, 256) ?? undefined
        }];
      })
    : [];
  const outbound = Array.isArray(value.outbound)
    ? value.outbound.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const routeId = opaque(entry.endpointRouteId);
        if (!routeId || !isRecord(entry.message)) return [];
        return [{ endpointRouteId: routeId, message: entry.message }];
      })
    : [];
  return {
    rotationId,
    incumbentKeyId,
    incumbentGeneration: Number.isSafeInteger(value.incumbentGeneration) ? Number(value.incumbentGeneration) : 1,
    candidateKeyId,
    candidatePublicKey: boundedText(value.candidatePublicKey, 128) ?? "",
    candidateGeneration: Number.isSafeInteger(value.candidateGeneration) ? Number(value.candidateGeneration) : 2,
    principalRef,
    state,
    endpoints,
    outbound,
    startedAt: boundedText(value.startedAt, 64) ?? "",
    updatedAt: boundedText(value.updatedAt, 64) ?? ""
  };
}

export function parseEntryGuiConfig(value: unknown): EntryGuiConfig | null {
  if (!isRecord(value) || value.schemaVersion !== ENTRY_GUI_CONFIG_SCHEMA) return null;
  const connections = Array.isArray(value.connections)
    ? value.connections.map(parseStoredConnection).filter((entry): entry is StoredConnection => entry !== null)
    : [];
  const recovery = isRecord(value.recovery)
    ? ((): StoredRecovery | null => {
        const vaultId = opaque(value.recovery.vaultId);
        const keyId = opaque(value.recovery.keyId);
        const materialRef = opaque(value.recovery.materialRef);
        const generation = Number.isSafeInteger(value.recovery.generation) ? Number(value.recovery.generation) : 1;
        const confirmedAt = boundedText(value.recovery.confirmedAt, 64) ?? "";
        if (!vaultId || !keyId || !materialRef) return null;
        const retainedMaterialRefs = Array.isArray(value.recovery.retainedMaterialRefs)
          ? value.recovery.retainedMaterialRefs.filter((entry): entry is string => Boolean(opaque(entry)))
          : [];
        const accountWriterState = value.recovery.accountWriterState === "pending" || value.recovery.accountWriterState === "complete"
          ? value.recovery.accountWriterState
          : "unmanaged";
        const accountSnapshotState = value.recovery.accountSnapshotState === "unverified"
          || value.recovery.accountSnapshotState === "older_snapshot_preserved"
          ? value.recovery.accountSnapshotState
          : "ready";
        const snapshotSourceMaterialRef = value.recovery.snapshotSourceMaterialRef == null
          ? null
          : opaque(value.recovery.snapshotSourceMaterialRef);
        return {
          vaultId,
          keyId,
          generation,
          materialRef,
          confirmedAt,
          accountWriterState,
          accountSnapshotState,
          snapshotSourceMaterialRef,
          retainedMaterialRefs
        };
      })()
    : null;
  const mcp = isRecord(value.mcp) ? value.mcp : {};
  return {
    schemaVersion: ENTRY_GUI_CONFIG_SCHEMA,
    profile: { displayLabel: boundedText(isRecord(value.profile) ? value.profile.displayLabel : null, 128) ?? "Meshrix Entry" },
    connections,
    recovery,
    accountVaultWriterOperation: parseVaultWriterOperation(value.accountVaultWriterOperation),
    journal: parseJournal(value.journal),
    rotations: Array.isArray(value.rotations)
      ? value.rotations.map(parseRotation).filter((entry): entry is StoredRotation => entry !== null)
      : [],
    mcp: { managedConfigPath: boundedText(mcp.managedConfigPath, 1024) },
    pairingServiceDefault: boundedText(value.pairingServiceDefault),
    pairingCompletionCheckpointRef: typeof value.pairingCompletionCheckpointRef === "string"
      && /^entry-gui\.pairing\.completion\.[a-f0-9]{32}$/u.test(value.pairingCompletionCheckpointRef)
      ? value.pairingCompletionCheckpointRef
      : null,
    account: parseStoredAccount(value.account)
  };
}

export class EntryConfigStore {
  readonly filePath: string;
  #config: EntryGuiConfig;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { readonly dataDir: string; readonly config?: EntryGuiConfig }) {
    this.filePath = path.join(options.dataDir, "entry-gui.config.json");
    this.#config = options.config ?? emptyEntryGuiConfig();
  }

  get config(): EntryGuiConfig {
    return this.#config;
  }

  async load(): Promise<EntryGuiConfig> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = parseEntryGuiConfig(JSON.parse(text));
      this.#config = parsed ?? emptyEntryGuiConfig();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#config = emptyEntryGuiConfig();
    }
    return this.#config;
  }

  /**
   * Mutate-and-persist; writes are serialized so the file never interleaves.
   * The caller's promise rejects on I/O failure, but the queue itself swallows
   * the outcome — a single failed write must not permanently poison every
   * subsequent update for the rest of the process lifetime.
   */
  update(mutate: (draft: EntryGuiConfig) => EntryGuiConfig): Promise<void> {
    const next = mutate(this.#config);
    this.#config = next;
    const payload = JSON.stringify(next, null, 2) + "\n";
    const write = this.#writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
    });
    this.#writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  /** Remove the owned config file (used by revoke/uninstall paths). */
  async remove(): Promise<void> {
    await this.#writeQueue.catch(() => undefined);
    await rm(this.filePath, { force: true });
  }

  /**
   * Drain queued writes — `stop()` awaits this so a late flush never lands
   * after shutdown (or after the owning directory is gone).
   */
  async flush(): Promise<void> {
    await this.#writeQueue.catch(() => undefined);
  }
}
