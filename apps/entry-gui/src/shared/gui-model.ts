/**
 * Deterministic projection of product events into the redacted GUI snapshot.
 *
 * The model is deliberately dumb: `EntryProductService` (main process) turns
 * custody/pairing/session outcomes into `GuiEvent`s, and this reducer folds
 * them into `GuiState`. The renderer holds no logic beyond dispatching ops
 * and rendering the latest snapshot — every honesty rule lives in one place
 * here and in the service, both testable without Electron.
 */
import {
  GUI_STATE_SCHEMA_VERSION,
  assertGuiStateSecretFree,
  type GuiConnectionView,
  type GuiAccountView,
  type GuiGrantView,
  type GuiCustodyView,
  type GuiInviteSummary,
  type GuiLifecycleView,
  type GuiMcpSetupView,
  type GuiPairingPhase,
  type GuiPairingView,
  type GuiRecoveryImportView,
  type GuiRecoveryView,
  type GuiVaultWriterRegistrationState,
  type GuiRevocationState,
  type GuiRouteState,
  type GuiPersonalEndpointView,
  type GuiApplicationView,
  type GuiState
} from "./gui-state.ts";

export type GuiEvent =
  | { readonly type: "service.started"; readonly custody: GuiCustodyView; readonly lifecycle: GuiLifecycleView; readonly appVersion: string }
  | { readonly type: "lifecycle.state"; readonly state: GuiLifecycleView["state"] }
  | { readonly type: "pairing.invite_ready"; readonly sessionId: string; readonly invite: GuiInviteSummary }
  | { readonly type: "pairing.challenge_issued"; readonly deviceFingerprint: string }
  | { readonly type: "pairing.outcome"; readonly phase: Exclude<GuiPairingPhase, "idle" | "invite_ready" | "challenge_issued">; readonly refusal?: string | null }
  | { readonly type: "pairing.enrolled"; readonly connection: GuiConnectionView }
  | { readonly type: "pairing.reset" }
  | { readonly type: "connection.upsert"; readonly connection: GuiConnectionView }
  | { readonly type: "connection.state"; readonly connectionId: string; readonly routeState?: GuiRouteState; readonly channelEstablished?: boolean; readonly acceptsNewWork?: boolean; readonly revocation?: GuiRevocationState; readonly boundRecoveryKeyId?: string | null; readonly rePairRequired?: boolean }
  | { readonly type: "connection.removed"; readonly connectionId: string }
  | { readonly type: "recovery.generated"; readonly vaultId: string; readonly keyId: string; readonly generation: number }
  | { readonly type: "recovery.revealed" }
  | { readonly type: "recovery.candidateCancelled"; readonly recovery: GuiRecoveryView }
  | { readonly type: "recovery.confirmed" }
  | { readonly type: "recovery.writerRegistration"; readonly state: GuiVaultWriterRegistrationState; readonly candidateVaultId?: string; readonly candidateKeyId?: string; readonly candidateGeneration?: number; readonly detail?: string | null }
  | { readonly type: "recovery.imported"; readonly vaultId: string; readonly keyId: string; readonly generation: number; readonly connection: GuiConnectionView }
  | { readonly type: "recovery.backup"; readonly lastSuccessAt?: string | null; readonly lastCommittedRevision?: number | null; readonly lastError?: string | null }
  | { readonly type: "recovery.rotation"; readonly rotation: GuiRecoveryView["rotation"] }
  | { readonly type: "recoveryImport.phase"; readonly phase: GuiRecoveryImportView["phase"]; readonly detail?: string | null; readonly enrolledConnectionId?: string | null }
  | { readonly type: "mcp.configured"; readonly snippet: string | null; readonly configuredPath?: string | null }
  | { readonly type: "account.updated"; readonly account: GuiAccountView }
  | { readonly type: "personal.endpoint"; readonly endpoint: GuiPersonalEndpointView }
  | { readonly type: "applications.updated"; readonly applications: GuiApplicationView }
  | { readonly type: "grant.updated"; readonly grant: GuiGrantView }
  | { readonly type: "notice"; readonly text: string };

const MAX_NOTICES = 20;

function emptyPairing(): GuiPairingView {
  return {
    phase: "idle",
    sessionId: null,
    invite: null,
    deviceFingerprint: null,
    refusal: null,
    enrolledConnectionId: null
  };
}

function emptyRecovery(): GuiRecoveryView {
  return {
    state: "not_configured",
    vaultId: null,
    keyId: null,
    generation: null,
    keyRevealed: false,
    writerRegistration: { state: "unmanaged", candidateGeneration: null, detail: null },
    backup: { lastSuccessAt: null, lastCommittedRevision: null, lastError: null },
    rotation: null
  };
}

function emptyGrant(): GuiGrantView {
  return { connectionId: null, availableScopes: [], targetScopes: [], grantRef: null, status: "idle", notice: null };
}

function emptyPersonalEndpoint(): GuiPersonalEndpointView {
  return { state: "unregistered", tenantId: null, routeId: null, deviceId: null, fingerprint: null, relayState: "unknown", canCreatePairingInvite: false };
}

function emptyApplications(): GuiApplicationView {
  return { destinations: [], agents: [], operations: [] };
}

export class EntryGuiModel {
  #state: GuiState = {
    schemaVersion: GUI_STATE_SCHEMA_VERSION,
    appVersion: "0.1.0",
    custody: { tier: "unavailable", available: false, reason: "custody not yet selected" },
    lifecycle: { state: "starting", dataDir: "", configPath: "", ownedPaths: [], updatePolicy: "manual" },
    pairing: emptyPairing(),
    recovery: emptyRecovery(),
    recoveryImport: { phase: "idle", detail: null, enrolledConnectionId: null },
    connections: [],
    mcp: { transport: "stdio", snippet: null, configuredPath: null },
    account: { state: "unconfigured", accountId: null, authEpoch: null, transactionId: null, transactionPurpose: null, actionPurpose: null, originAvailable: false, custodyAvailable: false, notice: null },
    personalEndpoint: emptyPersonalEndpoint(),
    applications: emptyApplications(),
    grant: emptyGrant(),
    notices: []
  };

  /** Fold one event; returns the new redacted snapshot. */
  apply(event: GuiEvent): GuiState {
    switch (event.type) {
      case "service.started":
        this.#state = {
          ...this.#state,
          appVersion: event.appVersion,
          custody: event.custody,
          lifecycle: event.lifecycle
        };
        break;
      case "lifecycle.state":
        this.#state = {
          ...this.#state,
          lifecycle: { ...this.#state.lifecycle, state: event.state }
        };
        break;
      case "pairing.invite_ready":
        this.#state = {
          ...this.#state,
          pairing: { ...emptyPairing(), phase: "invite_ready", sessionId: event.sessionId, invite: event.invite }
        };
        break;
      case "pairing.challenge_issued":
        this.#state = {
          ...this.#state,
          pairing: {
            ...this.#state.pairing,
            phase: "challenge_issued",
            deviceFingerprint: event.deviceFingerprint
          }
        };
        break;
      case "pairing.outcome":
        this.#state = {
          ...this.#state,
          pairing: {
            ...this.#state.pairing,
            phase: event.phase,
            refusal: event.refusal ?? null
          }
        };
        break;
      case "pairing.enrolled":
        this.#state = {
          ...this.#state,
          pairing: { ...this.#state.pairing, phase: "enrolled", enrolledConnectionId: event.connection.connectionId },
          connections: upsertConnection(this.#state.connections, event.connection)
        };
        break;
      case "pairing.reset":
        this.#state = { ...this.#state, pairing: emptyPairing() };
        break;
      case "connection.upsert":
        this.#state = {
          ...this.#state,
          connections: upsertConnection(this.#state.connections, event.connection)
        };
        break;
      case "connection.state":
        this.#state = {
          ...this.#state,
          connections: this.#state.connections.map((connection) => {
            if (connection.connectionId !== event.connectionId) return connection;
            return {
              ...connection,
              routeState: event.routeState ?? connection.routeState,
              channelEstablished: event.channelEstablished ?? connection.channelEstablished,
              acceptsNewWork: event.acceptsNewWork ?? connection.acceptsNewWork,
              revocation: event.revocation ?? connection.revocation,
              rePairRequired: event.rePairRequired ?? connection.rePairRequired,
              boundRecoveryKeyId: event.boundRecoveryKeyId !== undefined ? event.boundRecoveryKeyId : connection.boundRecoveryKeyId
            };
          })
        };
        break;
      case "connection.removed":
        this.#state = {
          ...this.#state,
          connections: this.#state.connections.filter((connection) => connection.connectionId !== event.connectionId)
        };
        break;
      case "recovery.generated":
        this.#state = {
          ...this.#state,
          recovery: {
            ...emptyRecovery(),
            state: "awaiting_save",
            vaultId: event.vaultId,
            keyId: event.keyId,
            generation: event.generation
          }
        };
        break;
      case "recovery.revealed":
        this.#state = {
          ...this.#state,
          recovery: { ...this.#state.recovery, keyRevealed: true }
        };
        break;
      case "recovery.candidateCancelled":
        this.#state = { ...this.#state, recovery: event.recovery };
        break;
      case "recovery.confirmed":
        this.#state = {
          ...this.#state,
          recovery: { ...this.#state.recovery, state: "ready", keyRevealed: this.#state.recovery.keyRevealed }
        };
        break;
      case "recovery.writerRegistration":
        this.#state = {
          ...this.#state,
          recovery: {
            ...this.#state.recovery,
            ...(this.#state.recovery.vaultId ? {} : event.candidateVaultId ? { vaultId: event.candidateVaultId } : {}),
            ...(this.#state.recovery.keyId ? {} : event.candidateKeyId ? { keyId: event.candidateKeyId } : {}),
            ...(this.#state.recovery.generation ? {} : event.candidateGeneration ? { generation: event.candidateGeneration } : {}),
            writerRegistration: {
              state: event.state,
              candidateGeneration: event.candidateGeneration ?? this.#state.recovery.writerRegistration.candidateGeneration,
              detail: event.detail ?? null
            },
            state: event.state === "authorization_required" || event.state === "prepare_pending"
              ? "account_authorization_required"
              : event.state === "service_pending"
                ? "account_writer_pending"
                : event.state === "complete"
                  ? "ready"
                  : this.#state.recovery.state
          }
        };
        break;
      case "recovery.imported":
        this.#state = {
          ...this.#state,
          recovery: {
            ...this.#state.recovery,
            state: "ready",
            vaultId: event.vaultId,
            keyId: event.keyId,
            generation: event.generation,
            keyRevealed: false
          },
          connections: upsertConnection(this.#state.connections, event.connection)
        };
        break;
      case "recovery.backup": {
        const backup = {
          lastSuccessAt: event.lastSuccessAt !== undefined ? event.lastSuccessAt : this.#state.recovery.backup.lastSuccessAt,
          lastCommittedRevision: event.lastCommittedRevision !== undefined ? event.lastCommittedRevision : this.#state.recovery.backup.lastCommittedRevision,
          lastError: event.lastError !== undefined ? event.lastError : this.#state.recovery.backup.lastError
        };
        const state = event.lastError && !event.lastSuccessAt
          ? "backup_unreadable"
          : this.#state.recovery.state === "not_configured"
            ? this.#state.recovery.state
            : "ready";
        this.#state = { ...this.#state, recovery: { ...this.#state.recovery, backup, state } };
        break;
      }
      case "recovery.rotation": {
        const active = event.rotation && event.rotation.state !== "completed" && event.rotation.state !== "aborted";
        this.#state = {
          ...this.#state,
          recovery: {
            ...this.#state.recovery,
            rotation: event.rotation,
            state: active ? "rotation_pending" : (this.#state.recovery.state === "rotation_pending" ? "ready" : this.#state.recovery.state)
          }
        };
        break;
      }
      case "recoveryImport.phase":
        this.#state = {
          ...this.#state,
          recoveryImport: {
            phase: event.phase,
            detail: event.detail ?? null,
            enrolledConnectionId: event.enrolledConnectionId ?? this.#state.recoveryImport.enrolledConnectionId
          }
        };
        break;
      case "mcp.configured":
        this.#state = {
          ...this.#state,
          mcp: { ...this.#state.mcp, snippet: event.snippet, configuredPath: event.configuredPath ?? this.#state.mcp.configuredPath }
        };
        break;
      case "account.updated":
        this.#state = { ...this.#state, account: event.account };
        break;
      case "personal.endpoint":
        this.#state = { ...this.#state, personalEndpoint: event.endpoint };
        break;
      case "applications.updated":
        this.#state = { ...this.#state, applications: event.applications };
        break;
      case "grant.updated":
        this.#state = { ...this.#state, grant: event.grant };
        break;
      case "notice": {
        const notices = [...this.#state.notices, event.text].slice(-MAX_NOTICES);
        this.#state = { ...this.#state, notices };
        break;
      }
      default:
        return this.#state;
    }
    return this.#state;
  }

  /** The redacted snapshot — scanned for secret material before it leaves. */
  snapshot(): GuiState {
    assertGuiStateSecretFree(this.#state);
    return this.#state;
  }
}

function upsertConnection(connections: readonly GuiConnectionView[], next: GuiConnectionView): GuiConnectionView[] {
  const index = connections.findIndex((connection) => connection.connectionId === next.connectionId);
  if (index < 0) return [...connections, next];
  const copy = [...connections];
  copy[index] = next;
  return copy;
}

/** Initial-restore helper: rebuild a connection list + recovery view from persisted config. */
export function restoreGuiState(model: EntryGuiModel, input: {
  readonly appVersion: string;
  readonly custody: GuiCustodyView;
  readonly lifecycle: GuiLifecycleView;
  readonly connections: readonly GuiConnectionView[];
  readonly recovery: Partial<GuiRecoveryView> | null;
  readonly mcp?: Partial<GuiMcpSetupView>;
}): GuiState {
  model.apply({ type: "service.started", custody: input.custody, lifecycle: input.lifecycle, appVersion: input.appVersion });
  for (const connection of input.connections) {
    model.apply({ type: "connection.upsert", connection });
  }
  if (input.recovery) {
    if (input.recovery.vaultId && input.recovery.keyId) {
      model.apply({
        type: "recovery.generated",
        vaultId: input.recovery.vaultId,
        keyId: input.recovery.keyId,
        generation: input.recovery.generation ?? 1
      });
      // A restored key was already saved by the user once — it is not re-shown.
      model.apply({ type: "recovery.confirmed" });
    }
    if (input.recovery.backup) model.apply({ type: "recovery.backup", ...input.recovery.backup });
    if (input.recovery.rotation) model.apply({ type: "recovery.rotation", rotation: input.recovery.rotation });
    if (input.recovery.writerRegistration) model.apply({
      type: "recovery.writerRegistration",
      state: input.recovery.writerRegistration.state,
      candidateGeneration: input.recovery.writerRegistration.candidateGeneration ?? undefined,
      detail: input.recovery.writerRegistration.detail
    });
  }
  if (input.mcp?.snippet !== undefined) {
    model.apply({ type: "mcp.configured", snippet: input.mcp.snippet ?? null, configuredPath: input.mcp.configuredPath ?? null });
  }
  return model.snapshot();
}
