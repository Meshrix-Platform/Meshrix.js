/**
 * Account authority contracts shared by the hosted account service and the
 * relay, endpoint, and installed Entry consumers.
 *
 * Account ids and epochs are assertions, not credentials. A consumer accepts
 * them only from the account service over a Worker service binding or after
 * an enrolled device proves possession of its registered key.
 */

export interface AccountAuthorityBinding {
  readonly accountId: string;
  readonly authEpoch: number;
}

/** Exact effect approved by the account holder. Scope order is canonicalized
 * by the issuer and consumers must compare the whole target. */
export interface AccountActionTarget {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  /** Raw Ed25519 public key, base64url encoded (32 bytes). */
  readonly devicePublicKey: string;
  readonly grantRef: string;
  readonly scopes: readonly string[];
  /** Present only for a post-recovery vault writer rotation. These public
   * keys are part of the exact step-up target; private key material never
   * leaves the installed client. */
  readonly vaultWriterRotation?: AccountVaultWriterRotationTarget;
}

export interface AccountVaultWriterRotationTarget {
  readonly vaultId: string;
  readonly generation: number;
  readonly writers: readonly AccountManagedVaultWriterKey[];
  readonly recoveryVerifier: AccountManagedVaultWriterKey;
}

export type AccountStepUpPurpose = "pair_device" | "grant_access";
export type AccountDeviceProofPurpose = "current_binding" | "managed_route" | "inspect_pairing" | "publish_pairing_target" | "inspect_step_up" | "consume_step_up" | "complete_pairing" | "claim_endpoint" | "prepare_vault_writer_rotation" | "complete_vault_writer_rotation";

export interface AccountStepUpChallenge {
  readonly challengeId: string;
  readonly account: AccountAuthorityBinding;
  readonly purpose: AccountStepUpPurpose;
  readonly target: AccountActionTarget;
  readonly passkeyOptions: AuthenticationOptionsJSON | null;
  readonly authenticatorAvailable: boolean;
  readonly bootstrapId: string | null;
  readonly expiresAt: string;
}

/** Opaque, action-bound and single-use. It is only a permit after a fresh
 * enrolled Passkey or TOTP proof has been accepted. */
export interface AccountStepUpPermit {
  readonly permitId: string;
  readonly account: AccountAuthorityBinding;
  readonly purpose: AccountStepUpPurpose;
  readonly target: AccountActionTarget;
  readonly bootstrapId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Account-issued permits are the canonical base64url encoding of 32 random
 * bytes. Unlike opaque record IDs, they may begin with `_` or `-`. */
export function isAccountStepUpPermitId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value);
}

export interface AccountStepUpConsumeRequest {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: AccountStepUpPurpose;
  readonly target: AccountActionTarget;
  readonly bootstrapId?: string;
  readonly operationId: string;
}

export type AccountStepUpConsumeResult =
  | { readonly consumed: true; readonly replayed: boolean; readonly account: AccountAuthorityBinding; readonly purpose: AccountStepUpPurpose; readonly bootstrapId: string | null; readonly target: AccountActionTarget; readonly operationId: string }
  | { readonly consumed: false; readonly reason: "account_stale" | "permit_missing" | "permit_expired" | "permit_consumed" | "purpose_mismatch" | "target_mismatch" | "operation_mismatch" };

export interface AccountStepUpInspectionRequest {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: AccountStepUpPurpose;
  readonly target: AccountActionTarget;
  readonly bootstrapId?: string;
}

export type AccountStepUpInspectionResult =
  | { readonly valid: true; readonly permit: AccountStepUpPermit }
  | { readonly valid: false; readonly reason: "account_stale" | "permit_missing" | "permit_expired" | "permit_consumed" | "purpose_mismatch" | "target_mismatch" };

/** A proof made by a device key already enrolled for the exact route/device.
 * `nonce` is fresh per request; the signed transcript binds it to the route
 * and device. Read-only current-binding requests are safe to replay, while
 * action permits have their own durable single-use fence. */
export interface AccountDeviceAuthorityProof {
  readonly purpose: AccountDeviceProofPurpose;
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly bootstrapId?: string;
  readonly endpointPinRef?: string;
  readonly claimId?: string;
  readonly permitId?: string;
  readonly operationId?: string;
  /** Base64url SHA-256 of canonical JSON for a signed route-specific request. */
  readonly requestDigest?: string;
  /** The route counterparty: an Entry ID from the endpoint, or the endpoint ID from an Entry. */
  readonly peerDeviceId?: string;
  /** Base64url SHA-256 of the canonical JSON AccountActionTarget, when present. */
  readonly targetDigest?: string;
  readonly signature: string;
}

/** Canonical Ed25519 signing input. The verifier recomputes this exact
 * newline-delimited transcript; callers must not sign arbitrary request JSON. */
export function accountDeviceAuthorityTranscript(proof: Omit<AccountDeviceAuthorityProof, "signature">): string {
  return [
    "meshrix-account-device-proof-v1",
    proof.purpose,
    proof.tenantId,
    proof.routeId,
    proof.deviceId,
    proof.nonce,
    proof.bootstrapId ?? "",
    proof.endpointPinRef ?? "",
    proof.claimId ?? "",
    proof.permitId ?? "",
    proof.operationId ?? "",
    proof.requestDigest ?? "",
    proof.peerDeviceId ?? "",
    proof.targetDigest ?? "",
  ].join("\n");
}

export function canonicalAccountActionTarget(target: AccountActionTarget): string {
  return JSON.stringify({
    tenantId: target.tenantId,
    routeId: target.routeId,
    deviceId: target.deviceId,
    devicePublicKey: target.devicePublicKey,
    grantRef: target.grantRef,
    scopes: [...new Set(target.scopes)].sort(),
    vaultWriterRotation: target.vaultWriterRotation ? {
      vaultId: target.vaultWriterRotation.vaultId,
      generation: target.vaultWriterRotation.generation,
      writers: [...target.vaultWriterRotation.writers]
        .map((writer) => ({ keyId: writer.keyId, algorithm: writer.algorithm, publicKey: writer.publicKey }))
        .sort((left, right) => left.keyId.localeCompare(right.keyId)),
      recoveryVerifier: {
        keyId: target.vaultWriterRotation.recoveryVerifier.keyId,
        algorithm: target.vaultWriterRotation.recoveryVerifier.algorithm,
        publicKey: target.vaultWriterRotation.recoveryVerifier.publicKey,
      },
    } : null,
  });
}

export interface AccountDesktopProofTranscriptInput {
  readonly method: "POST";
  readonly pathname: string;
  readonly account: AccountAuthorityBinding;
  readonly clientPublicKey: string;
  readonly credentialDigest: string;
  readonly nonce: string;
  readonly bodyDigest: string;
}

/** Binds an installed-client signature to its account session and exact HTTP
 * operation. `credentialDigest` and `bodyDigest` are base64url SHA-256 values. */
export function accountDesktopSessionTranscript(input: AccountDesktopProofTranscriptInput): string {
  return [
    "meshrix-account-desktop-proof-v1",
    input.method,
    input.pathname,
    input.account.accountId,
    String(input.account.authEpoch),
    input.clientPublicKey,
    input.credentialDigest,
    input.nonce,
    input.bodyDigest,
  ].join("\n");
}

export interface AccountDeviceAuthorization extends AccountAuthorityBinding {
  readonly target: AccountActionTarget;
  readonly authorizedScopes: readonly string[];
}

export interface AccountManagedRouteBinding {
  readonly accountId: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly authEpoch: number;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly endpointPinRef: string;
  readonly vaultId: string;
}

/** First-time binding of a locally controlled endpoint to an account. The
 * endpoint key signs the exact action target before it has been enrolled;
 * the account service accepts it only with a fresh pair_device permit and
 * only when the tenant/route has no existing owner. */
export interface AccountEndpointOwnershipClaimRequest extends AccountAuthorityBinding {
  readonly claimId: string;
  readonly permitId: string;
  readonly operationId: string;
  readonly target: AccountActionTarget;
  readonly endpointPinRef: string;
  readonly mode: "personal" | "enterprise";
  readonly proof: AccountDeviceAuthorityProof;
}

export interface AccountEndpointOwnershipClaimResult {
  readonly claimed: boolean;
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly endpointPinRef: string;
  readonly vaultId: string;
  readonly mode: "personal" | "enterprise";
}

/** Initial account-bound pairing request. This admission is route-bound and
 * conveys no normal MCP execution or recovery authorization by itself. */
export interface AccountPairingBootstrapRequest extends AccountAuthorityBinding {
  readonly tenantId: string;
  readonly routeId: string;
  readonly entryDeviceId: string;
  readonly entryDevicePublicKey: string;
  /** Compared against the pin already recorded for the account-owned route. */
  readonly endpointPinRef: string;
  readonly mode: "personal" | "enterprise";
}

export interface AccountPairingBootstrap {
  readonly bootstrapId: string;
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly entryDeviceId: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly role: "entry";
  readonly mode: "personal" | "enterprise";
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly relayAdmission: string;
  readonly expiresAt: string;
}

export type AccountPairingAdmissionRequest = {
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly mode: "personal" | "enterprise";
  readonly operationId: string;
} & (
  | {
    readonly role: "entry";
    readonly bootstrapId: string;
    readonly claimId: null;
    /** Short-lived restricted pair_device admission. */
    readonly expiresAt: string;
  }
  | {
    readonly role: "endpoint";
    readonly bootstrapId: null;
    readonly claimId: string;
    /** Endpoint credentials live until account revocation. */
    readonly expiresAt: null;
  }
);

export type AccountPairingAdmission = {
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly mode: "personal" | "enterprise";
  readonly operationId: string;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly relayAdmission: string;
} & (
  | { readonly role: "entry"; readonly bootstrapId: string; readonly claimId: null; readonly expiresAt: string }
  | { readonly role: "endpoint"; readonly bootstrapId: null; readonly claimId: string; readonly expiresAt: null }
);

export interface AccountInspectPendingPairingRequest {
  readonly bootstrapId: string;
  /** Proof from the already account-bound receiving endpoint device key. */
  readonly proof: AccountDeviceAuthorityProof;
}

export interface AccountPendingPairing {
  readonly bootstrapId: string;
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly entryDeviceId: string;
  readonly entryDevicePublicKey: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly target: AccountActionTarget | null;
  readonly expiresAt: string;
}

export interface AccountPairingTargetPublishRequest {
  readonly bootstrapId: string;
  readonly target: AccountActionTarget;
  readonly proof: AccountDeviceAuthorityProof;
}

export interface AccountPairingCompletionRequest extends AccountAuthorityBinding {
  readonly bootstrapId: string;
  readonly operationId: string;
  readonly target: AccountActionTarget;
  /** Proof from the already account-bound receiving endpoint device key. */
  readonly proof: AccountDeviceAuthorityProof;
}

export interface AccountPairingCompletionResult {
  readonly completed: boolean;
  readonly account: AccountAuthorityBinding;
  readonly operationId: string;
  readonly relayAdmissionActive: boolean;
}

/** Durable account-to-relay revocation event. The target ids are selected by
 * account authority from its managed-resource index, never by the recovering
 * browser. Relay applies this idempotently and closes matching live routes. */
export interface AccountEpochRevocationEvent {
  readonly eventId: string;
  readonly accountId: string;
  readonly newAuthEpoch: number;
  readonly tenantIds: readonly string[];
  readonly vaultIds: readonly string[];
  readonly revokedAt: string;
}

/** A scoped device revocation remains independent of the account-wide epoch.
 * For an endpoint target it fences this whole route; for an Entry target it
 * fences only the exact device grant and its relay session. */
export interface AccountDeviceRevocationEvent {
  readonly scope: "device";
  readonly eventId: string;
  readonly operationId: string;
  readonly accountId: string;
  readonly newAuthEpoch: number;
  readonly tenantId: string;
  readonly routeId: string;
  readonly target: "route" | "device";
  readonly deviceId: string;
  readonly revokedAt: string;
}

export type AccountRelayRevocationEvent = AccountEpochRevocationEvent | AccountDeviceRevocationEvent;

export function isAccountDeviceRevocationEvent(value: unknown): value is AccountDeviceRevocationEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AccountDeviceRevocationEvent>;
  return event.scope === "device" && typeof event.eventId === "string" && typeof event.operationId === "string"
    && typeof event.accountId === "string" && Number.isSafeInteger(event.newAuthEpoch)
    && typeof event.tenantId === "string" && typeof event.routeId === "string"
    && (event.target === "route" || event.target === "device") && typeof event.deviceId === "string"
    && typeof event.revokedAt === "string";
}

export function isAccountEpochRevocationEvent(value: unknown): value is AccountEpochRevocationEvent {
  if (!value || typeof value !== "object" || "scope" in value) return false;
  const event = value as Partial<AccountEpochRevocationEvent>;
  return typeof event.eventId === "string" && typeof event.accountId === "string"
    && Number.isSafeInteger(event.newAuthEpoch) && Array.isArray(event.tenantIds)
    && Array.isArray(event.vaultIds) && typeof event.revokedAt === "string";
}

export type AccountRelayRevocationTarget =
  | { readonly eventId: string; readonly accountId: string; readonly newAuthEpoch: number; readonly revokedAt: string }
  | AccountDeviceRevocationEvent;

/** Exact event identity, including all authority-selected resource partitions. */
export function sameAccountRevocationEvent(actual: unknown, expected: AccountRelayRevocationEvent): boolean {
  if (isAccountDeviceRevocationEvent(expected)) {
    return isAccountDeviceRevocationEvent(actual) && actual.eventId === expected.eventId
      && actual.operationId === expected.operationId && actual.accountId === expected.accountId
      && actual.newAuthEpoch === expected.newAuthEpoch && actual.tenantId === expected.tenantId
      && actual.routeId === expected.routeId && actual.target === expected.target
      && actual.deviceId === expected.deviceId && actual.revokedAt === expected.revokedAt;
  }
  if (!isAccountEpochRevocationEvent(expected) || !isAccountEpochRevocationEvent(actual)) return false;
  const exact = (a: readonly string[], b: readonly string[]) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const expectedIds = new Set(b);
    return expectedIds.size === b.length && new Set(a).size === a.length && a.every(id => expectedIds.has(id));
  };
  return actual.eventId === expected.eventId && actual.accountId === expected.accountId
    && actual.newAuthEpoch === expected.newAuthEpoch && actual.revokedAt === expected.revokedAt
    && exact(actual.tenantIds, expected.tenantIds) && exact(actual.vaultIds, expected.vaultIds);
}

export interface AccountEpochRevocationAcknowledgement {
  readonly eventId: string;
  readonly applied: boolean;
  readonly acknowledgedTenantIds: readonly string[];
  readonly acknowledgedVaultIds: readonly string[];
  readonly closedRouteCount: number;
}

export interface AccountDeviceRevocationAcknowledgement {
  readonly scope: "device";
  readonly eventId: string;
  readonly operationId: string;
  readonly applied: boolean;
  readonly tenantId: string;
  readonly routeId: string;
  readonly target: "route" | "device";
  readonly deviceId: string;
}

export type AccountRelayRevocationAcknowledgement =
  | AccountEpochRevocationAcknowledgement
  | AccountDeviceRevocationAcknowledgement;

/** Cloudflare Worker service-binding RPC surface. The account Worker exposes
 * these methods through WorkerEntrypoint; endpoint Node processes use the
 * signed HTTPS device-proof route defined by ACCOUNT_API_ROUTES. */
export interface AccountAuthorityClient {
  /** Exact durable recovery event facts; grants only application of that event. */
  inspectRevocationEvent(eventId: string): Promise<AccountRelayRevocationEvent | null>;
  /**
   * Resolve an opaque browser session credential to its current account
   * binding for trusted Worker-to-Worker authorization. Returns no account
   * when the session is absent, inactive, stale, or behind a revocation fence.
   * The credential must never be returned or included in logs.
   */
  inspectSessionCredential(credential: string): Promise<AccountAuthorityBinding | null>;
  /** Indexed membership facts for one partition, without copying every target. */
  inspectRevocationTarget(eventId: string, kind: "tenant" | "vault" | "route" | "device", targetId: string): Promise<AccountRelayRevocationTarget | null>;
  currentBinding(accountId: string): Promise<AccountAuthorityBinding | null>;
  isCurrent(binding: AccountAuthorityBinding): Promise<boolean>;
  /** Returns one route only when the account epoch, personal tenant, route, vault, and account-wide revocation fence are current. */
  currentManagedRoute(binding: AccountAuthorityBinding, tenantId: string, routeId: string): Promise<AccountManagedRouteBinding | null>;
  inspectStepUpPermit(request: AccountStepUpInspectionRequest): Promise<AccountStepUpInspectionResult>;
  consumeStepUpPermit(request: AccountStepUpConsumeRequest): Promise<AccountStepUpConsumeResult>;
  createPairingBootstrap(request: AccountPairingBootstrapRequest): Promise<AccountPairingBootstrap>;
  inspectPendingPairing(request: AccountInspectPendingPairingRequest): Promise<AccountPendingPairing | null>;
  publishPairingTarget(request: AccountPairingTargetPublishRequest): Promise<AccountPendingPairing | null>;
  completePairing(request: AccountPairingCompletionRequest): Promise<AccountPairingCompletionResult>;
  deviceAuthorization(proof: AccountDeviceAuthorityProof): Promise<AccountDeviceAuthorization | null>;
  managedRoute(tenantId: string, routeId: string): Promise<AccountManagedRouteBinding | null>;
  claimEndpointOwnership(request: AccountEndpointOwnershipClaimRequest): Promise<AccountEndpointOwnershipClaimResult>;
}

export interface AccountRelayRevocationClient {
  applyAccountRevocation(event: AccountRelayRevocationEvent): Promise<AccountRelayRevocationAcknowledgement>;
}

export interface AccountRelayControlClient extends AccountRelayRevocationClient {
  createPairingAdmission(request: AccountPairingAdmissionRequest): Promise<AccountPairingAdmission>;
  activateAccountAdmission(input: {
    readonly account: AccountAuthorityBinding;
    readonly operationId: string;
    readonly bootstrapId: string;
    readonly tenantId: string;
    readonly routeId: string;
    readonly deviceId: string;
    readonly role: "entry";
    readonly relayAdmission: string;
  }): Promise<{ readonly active: boolean; readonly tenantId: string; readonly routeId: string }>;
  bindAccountVault(input: AccountManagedVaultBindingRequest): Promise<AccountManagedVaultBindingResult>;
  replaceAccountVaultWriters(input: AccountManagedVaultWriterRotationRequest): Promise<AccountManagedVaultWriterRotationResult>;
}

export interface AccountManagedVaultBindingRequest {
  readonly account: AccountAuthorityBinding;
  readonly vaultId: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly operationId: string;
}

export interface AccountManagedVaultBindingResult {
  readonly bound: boolean;
  readonly vaultId: string;
  readonly accountId: string;
  readonly authEpoch: number;
}

export interface AccountManagedVaultWriterKey {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKey: string;
}

export interface AccountManagedVaultWriterRotationRequest {
  readonly account: AccountAuthorityBinding;
  readonly vaultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly writers: readonly AccountManagedVaultWriterKey[];
  readonly recoveryVerifier: AccountManagedVaultWriterKey;
}

/** Canonical request digest input for Entry device possession proof. */
export function canonicalAccountVaultWriterRotationInput(input: {
  readonly operationId: string;
  readonly vaultId: string;
  readonly writers: readonly AccountManagedVaultWriterKey[];
  readonly recoveryVerifier: AccountManagedVaultWriterKey;
}): string {
  const key = (value: AccountManagedVaultWriterKey) => ({
    keyId: value.keyId,
    algorithm: value.algorithm,
    publicKey: value.publicKey,
  });
  return JSON.stringify({
    operationId: input.operationId,
    vaultId: input.vaultId,
    writers: [...input.writers].map(key).sort((left, right) => left.keyId.localeCompare(right.keyId)),
    recoveryVerifier: key(input.recoveryVerifier),
  });
}

export interface AccountManagedVaultWriterRotationResult {
  readonly rotated: boolean;
  readonly vaultId: string;
  readonly generation: number;
}

/** JSON-compatible WebAuthn types used at the browser API boundary. */
export type Base64UrlString = string;

export interface AuthenticationOptionsJSON {
  readonly challenge: Base64UrlString;
  readonly timeout?: number;
  readonly rpId?: string;
  readonly allowCredentials?: readonly {
    readonly id: Base64UrlString;
    readonly type: "public-key";
    readonly transports?: readonly string[];
  }[];
  readonly userVerification?: "required" | "preferred" | "discouraged";
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface RegistrationOptionsJSON {
  readonly rp: { readonly name: string; readonly id: string };
  readonly user: { readonly id: Base64UrlString; readonly name: string; readonly displayName: string };
  readonly challenge: Base64UrlString;
  readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: number }[];
  readonly timeout?: number;
  readonly excludeCredentials?: readonly {
    readonly id: Base64UrlString;
    readonly type: "public-key";
    readonly transports?: readonly string[];
  }[];
  readonly authenticatorSelection: {
    readonly authenticatorAttachment?: "platform" | "cross-platform";
    readonly residentKey?: "required" | "preferred" | "discouraged";
    readonly requireResidentKey?: boolean;
    readonly userVerification: "required";
  };
  readonly attestation?: "none" | "indirect" | "direct" | "enterprise";
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface RegistrationResponseJSON {
  readonly id: Base64UrlString;
  readonly rawId: Base64UrlString;
  readonly type: "public-key";
  readonly authenticatorAttachment?: "platform" | "cross-platform" | null;
  readonly response: {
    readonly attestationObject: Base64UrlString;
    readonly clientDataJSON: Base64UrlString;
    readonly transports?: readonly string[];
    readonly publicKey?: Base64UrlString;
    readonly publicKeyAlgorithm?: number;
  };
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
}

export interface AuthenticationResponseJSON {
  readonly id: Base64UrlString;
  readonly rawId: Base64UrlString;
  readonly type: "public-key";
  readonly authenticatorAttachment?: "platform" | "cross-platform" | null;
  readonly response: {
    readonly authenticatorData: Base64UrlString;
    readonly clientDataJSON: Base64UrlString;
    readonly signature: Base64UrlString;
    readonly userHandle?: Base64UrlString | null;
  };
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
}
