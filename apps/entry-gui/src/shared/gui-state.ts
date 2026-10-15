/**
 * Redacted GUI state — the only application snapshot the renderer is ever
 * allowed to see.
 *
 * Every field is deliberately non-secret: identifiers, fingerprints, public
 * pins, timestamps and honest state labels. Recovery roots, device private
 * keys, relay credentials, snapshot plaintext and TLS material have no field
 * here at all — there is nothing to "forget to redact".
 *
 * `assertGuiStateSecretFree` is a defense-in-depth scan over the serialized
 * snapshot so a future field cannot silently leak a secret-shaped value; both
 * the main-process emitter and the tests run it on every snapshot.
 */
export const GUI_STATE_SCHEMA_VERSION = "v0.0.1:entry-gui:state-3";

export type GuiPairingPhase =
  | "idle"
  | "invite_ready"
  | "challenge_issued"
  | "authorization_required"
  | "proof_submitted"
  | "enrolled"
  | "refused"
  | "offline"
  | "retry_required"
  | "expired"
  | "cancelled";

export interface GuiInviteSummary {
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly tenantId: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointDeviceId: string;
  readonly endpointPrincipalRef: string;
  /** The endpoint's inner-channel SPKI pin — the decrypting party's trust anchor. */
  readonly endpointSpkiPin: string;
  readonly relayService: string;
  readonly vaultId: string;
  readonly expiresAt: string;
}

export interface GuiPairingView {
  readonly phase: GuiPairingPhase;
  readonly sessionId: string | null;
  readonly invite: GuiInviteSummary | null;
  /** Fresh device fingerprint — shown for explicit user confirmation. */
  readonly deviceFingerprint: string | null;
  readonly refusal: string | null;
  readonly enrolledConnectionId: string | null;
}

export type GuiRouteState = "reachable" | "unreachable" | "draining" | "unknown";

export type GuiRevocationState = "none" | "local_revoked" | "remote_pending" | "remote_applied" | "authority_pending" | "enforcement_pending";

export interface GuiConnectionView {
  readonly connectionId: string;
  readonly displayLabel: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly mode: "personal" | "enterprise";
  /** Decrypting party — the endpoint principal that terminates the inner TLS. */
  readonly endpointPrincipalRef: string;
  readonly endpointDeviceId: string | null;
  /** Pinned SPKI fingerprint of the decrypting party, displayed verbatim. */
  readonly endpointSpkiPin: string;
  readonly deviceId: string;
  readonly deviceFingerprint: string;
  readonly routeState: GuiRouteState;
  readonly channelEstablished: boolean;
  readonly acceptsNewWork: boolean;
  readonly boundRecoveryKeyId: string | null;
  readonly revocation: GuiRevocationState;
  readonly vaultId: string | null;
  readonly capabilityGrantRef: string;
  /** Account recovery or epoch change invalidated this local enrollment. */
  readonly rePairRequired: boolean;
}

export type GuiRecoveryState =
  | "not_configured"
  | "awaiting_save"
  | "account_authorization_required"
  | "account_writer_pending"
  | "ready"
  | "backup_unreadable"
  | "rotation_pending";

export type GuiVaultWriterRegistrationState =
  | "unmanaged"
  | "prepare_pending"
  | "authorization_required"
  | "service_pending"
  | "complete"
  | "older_snapshot_preserved";

export interface GuiRotationEndpointView {
  readonly endpointRouteId: string;
  readonly state: "pending" | "staged" | "acknowledged" | "unreachable" | "refused";
}

export interface GuiRecoveryView {
  readonly state: GuiRecoveryState;
  readonly vaultId: string | null;
  readonly keyId: string | null;
  readonly generation: number | null;
  /** True once the key text was revealed through the one-shot display. */
  readonly keyRevealed: boolean;
  readonly writerRegistration: {
    readonly state: GuiVaultWriterRegistrationState;
    readonly candidateGeneration: number | null;
    readonly detail: string | null;
  };
  readonly backup: {
    readonly lastSuccessAt: string | null;
    readonly lastCommittedRevision: number | null;
    readonly lastError: string | null;
  };
  readonly rotation: {
    readonly rotationId: string;
    readonly state: string;
    readonly candidateGeneration: number;
    readonly endpoints: readonly GuiRotationEndpointView[];
  } | null;
}

export type GuiRecoveryImportPhase =
  | "idle"
  | "working"
  | "enrolled"
  | "refused"
  | "snapshot_missing"
  | "snapshot_unusable"
  | "error";

export interface GuiRecoveryImportView {
  readonly phase: GuiRecoveryImportPhase;
  readonly detail: string | null;
  readonly enrolledConnectionId: string | null;
}

export interface GuiMcpSetupView {
  readonly transport: "stdio";
  /** Standard MCP client configuration snippet (JSON) the user pastes. */
  readonly snippet: string | null;
  /** Owned managed-config path when the app wrote one; null otherwise. */
  readonly configuredPath: string | null;
}

export interface GuiAccountView {
  readonly state: "unconfigured" | "signed_out" | "authenticated" | "transaction_pending" | "recovery_required";
  readonly accountId: string | null;
  readonly authEpoch: number | null;
  readonly transactionId: string | null;
  readonly transactionPurpose: "login" | "step_up" | null;
  readonly actionPurpose: "pair_device" | "grant_access" | null;
  readonly originAvailable: boolean;
  readonly custodyAvailable: boolean;
  readonly notice: string | null;
}

/** Redacted profile-level personal endpoint status. No credentials or keys. */
export interface GuiPersonalEndpointView {
  readonly state: "unregistered" | "enrolled" | "connecting" | "connected" | "unreachable" | "revoked" | "action_required";
  readonly tenantId: string | null;
  readonly routeId: string | null;
  readonly deviceId: string | null;
  readonly fingerprint: string | null;
  readonly relayState: "reachable" | "unreachable" | "unknown";
  readonly canCreatePairingInvite: boolean;
}

/** Safe Agent catalog projection; executable details and environment stay local. */
export interface GuiAgentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly permissionMode: "ask" | "allow_list" | "deny_all";
}

/** Durable application history projection; prompt, result and permission payload are fetched explicitly. */
export interface GuiApplicationSummary {
  readonly operationId: string;
  readonly direction: "outbound" | "inbound";
  readonly targetLabel: string;
  readonly agentLabel: string;
  readonly status: string;
  readonly transportStatus: string;
  readonly updatedAt: string;
}

export interface GuiApplicationView {
  readonly destinations: readonly {
    readonly handle: string;
    readonly label: string;
    readonly reachable: boolean;
  }[];
  readonly agents: readonly GuiAgentSummary[];
  readonly operations: readonly GuiApplicationSummary[];
}

export interface GuiGrantView {
  readonly connectionId: string | null;
  readonly availableScopes: readonly string[];
  readonly targetScopes: readonly string[];
  readonly grantRef: string | null;
  readonly status: "idle" | "catalog_ready" | "authorization_required" | "granted";
  readonly notice: string | null;
}

export interface GuiLifecycleView {
  readonly state: "starting" | "ready" | "stopping" | "stopped";
  /** Application-owned data directory (informational). */
  readonly dataDir: string;
  readonly configPath: string;
  /** Paths the app owns and removes on revoke/uninstall — nothing else. */
  readonly ownedPaths: readonly string[];
  /** Updates are manual/explicit; the app never self-executes a binary update. */
  readonly updatePolicy: "manual";
}

export interface GuiCustodyView {
  readonly tier: "os" | "file" | "unavailable";
  readonly available: boolean;
  readonly reason: string;
}

export interface GuiState {
  readonly schemaVersion: typeof GUI_STATE_SCHEMA_VERSION;
  readonly appVersion: string;
  readonly custody: GuiCustodyView;
  readonly lifecycle: GuiLifecycleView;
  readonly pairing: GuiPairingView;
  readonly recovery: GuiRecoveryView;
  readonly recoveryImport: GuiRecoveryImportView;
  readonly connections: readonly GuiConnectionView[];
  readonly mcp: GuiMcpSetupView;
  readonly account: GuiAccountView;
  readonly personalEndpoint: GuiPersonalEndpointView;
  readonly applications: GuiApplicationView;
  readonly grant: GuiGrantView;
  /** Bounded human-readable notices (never secret material). */
  readonly notices: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Secret-free invariant                                               */
/* ------------------------------------------------------------------ */

const FORBIDDEN_KEY_PATTERN = /(?:secret|private[-_]?key|pairingtoken|passphrase|password|recoverytext|keymaterial|tlskey|sessionkey)/iu;
/** Terminal `…key`/`…token`/`…credential(s)` names suggest held material unless a reference suffix says otherwise. */
const MATERIAL_TERMINAL = /(?:key|token|credential|credentials)$/iu;
const REFERENCE_KEY_SUFFIX = /(?:ref|id|fingerprint|pin|publickey|keyid)$/iu;
/** The user-held recovery text prefix — its presence anywhere in a snapshot is a leak. */
const RECOVERY_TEXT_PATTERN = /mrk1-[a-z2-7]/iu;
/** Raw Ed25519 private material travels as PKCS#8 DER — base64 blobs of that size are suspicious. */
const PKCS8_MARKER = /MC4CAQAwBQYDK2Vw/;

export interface SecretScanFinding {
  readonly path: string;
  readonly reason: string;
}

/**
 * Deep-scan a JSON-shaped snapshot for secret-looking keys or values.
 * Returns findings; an empty array means the snapshot is safe to send to the
 * renderer. This scans structure only — it does not bless arbitrary strings.
 */
export function scanGuiStateForSecrets(value: unknown, path = "$", findings: SecretScanFinding[] = []): SecretScanFinding[] {
  if (value === null || value === undefined) return findings;
  if (typeof value === "string") {
    if (RECOVERY_TEXT_PATTERN.test(value)) {
      findings.push({ path, reason: "recovery text present in snapshot" });
    } else if (PKCS8_MARKER.test(value)) {
      findings.push({ path, reason: "pkcs8 key material marker present" });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanGuiStateForSecrets(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)
        || (MATERIAL_TERMINAL.test(key) && !REFERENCE_KEY_SUFFIX.test(key))) {
        findings.push({ path: `${path}.${key}`, reason: `forbidden key name "${key}"` });
      }
      scanGuiStateForSecrets(entry, `${path}.${key}`, findings);
    }
  }
  return findings;
}

/** Throws when a snapshot carries any secret-shaped field — used before every IPC emission. */
export function assertGuiStateSecretFree(state: GuiState): void {
  const findings = scanGuiStateForSecrets(state);
  if (findings.length > 0) {
    const detail = findings.map((finding) => `${finding.path}: ${finding.reason}`).join("; ");
    throw new Error(`GUI state snapshot contains secret material: ${detail}`);
  }
}
