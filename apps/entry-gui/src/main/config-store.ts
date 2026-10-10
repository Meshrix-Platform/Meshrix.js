/**
 * Owned configuration store — the single JSON document the app persists.
 *
 * Holds only non-secret facts: connection records (identifiers, pins,
 * counters), recovery bookkeeping (locator, key id, generation), custody ref
 * names, and lifecycle metadata. Private keys, relay credentials, recovery
 * material and the pairing token live in the custody adapter or in memory —
 * this file is safe to read for support and is written atomically
 * (tmp+rename) so a crash can never leave a torn config.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ENTRY_GUI_CONFIG_SCHEMA = "entry-gui-config-1";

export interface StoredConnection {
  readonly connectionId: string;
  readonly displayLabel: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointPrincipalRef: string;
  readonly endpointSpkiPin: string;
  readonly relayService: string;
  readonly vaultId: string | null;
  readonly deviceId: string;
  readonly deviceFingerprint: string;
  readonly capabilityGrantRef: string;
  /** Custody ref holding the relay bearer credential — the credential itself is never stored here. */
  readonly relayCredentialRef: string;
  readonly boundRecoveryKeyId: string | null;
  readonly pairingService: string | null;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly enrolledAt: string;
  /** Set when the user revoked locally; remote enforcement is tracked as a flag. */
  readonly remoteRevocation: "none" | "pending" | "applied";
}

export interface StoredRecovery {
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
  /** Custody ref holding derived writer/backup/signing material (never the root text). */
  readonly materialRef: string;
  readonly confirmedAt: string;
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
  readonly journal: StoredSnapshotJournal | null;
  readonly rotations: readonly StoredRotation[];
  readonly mcp: { readonly managedConfigPath: string | null };
  readonly pairingServiceDefault: string | null;
  /**
   * Opt-in peer messaging switch — non-secret fact only. `enabled:false` is
   * the default; peer identities, sessions, outbox and inbox live under the
   * owned `peer/` data directory, never in this document.
   */
  readonly peer: { readonly enabled: boolean };
}

export function emptyEntryGuiConfig(): EntryGuiConfig {
  return {
    schemaVersion: ENTRY_GUI_CONFIG_SCHEMA,
    profile: { displayLabel: "Meshrix Entry" },
    connections: [],
    recovery: null,
    journal: null,
    rotations: [],
    mcp: { managedConfigPath: null },
    pairingServiceDefault: null,
    peer: { enabled: false }
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

function parseStoredConnection(value: unknown): StoredConnection | null {
  if (!isRecord(value)) return null;
  const connectionId = opaque(value.connectionId);
  const deviceId = opaque(value.deviceId);
  const deviceFingerprint = opaque(value.deviceFingerprint);
  const tenantId = opaque(value.tenantId);
  const routeId = opaque(value.routeId);
  const principal = opaque(value.endpointPrincipalRef);
  const spkiPin = boundedText(value.endpointSpkiPin, 128);
  const relayService = boundedText(value.relayService);
  const relayCredentialRef = opaque(value.relayCredentialRef);
  const capabilityGrantRef = opaque(value.capabilityGrantRef) ?? "none";
  const enrolledAt = boundedText(value.enrolledAt, 64) ?? "";
  const admissionGeneration = Number.isSafeInteger(value.admissionGeneration) ? Number(value.admissionGeneration) : 1;
  const revocationRevision = Number.isSafeInteger(value.revocationRevision) ? Number(value.revocationRevision) : 0;
  const mode = value.mode === "enterprise" ? "enterprise" : "personal";
  if (!connectionId || !deviceId || !deviceFingerprint || !tenantId || !routeId || !principal || !spkiPin || !relayService || !relayCredentialRef) {
    return null;
  }
  return {
    connectionId,
    displayLabel: boundedText(value.displayLabel, 128) ?? connectionId,
    tenantId,
    routeId,
    mode,
    endpointPrincipalRef: principal,
    endpointSpkiPin: spkiPin,
    relayService,
    vaultId: value.vaultId === null || value.vaultId === undefined ? null : opaque(value.vaultId),
    deviceId,
    deviceFingerprint,
    capabilityGrantRef,
    relayCredentialRef,
    boundRecoveryKeyId: value.boundRecoveryKeyId == null ? null : opaque(value.boundRecoveryKeyId),
    pairingService: value.pairingService == null ? null : boundedText(value.pairingService),
    admissionGeneration,
    revocationRevision,
    enrolledAt,
    remoteRevocation: value.remoteRevocation === "pending" || value.remoteRevocation === "applied" ? value.remoteRevocation : "none"
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
  return {
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
        return { vaultId, keyId, generation, materialRef, confirmedAt };
      })()
    : null;
  const mcp = isRecord(value.mcp) ? value.mcp : {};
  return {
    schemaVersion: ENTRY_GUI_CONFIG_SCHEMA,
    profile: { displayLabel: boundedText(isRecord(value.profile) ? value.profile.displayLabel : null, 128) ?? "Meshrix Entry" },
    connections,
    recovery,
    journal: parseJournal(value.journal),
    rotations: Array.isArray(value.rotations)
      ? value.rotations.map(parseRotation).filter((entry): entry is StoredRotation => entry !== null)
      : [],
    mcp: { managedConfigPath: boundedText(mcp.managedConfigPath, 1024) },
    pairingServiceDefault: boundedText(value.pairingServiceDefault),
    peer: { enabled: isRecord(value.peer) && value.peer.enabled === true }
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
