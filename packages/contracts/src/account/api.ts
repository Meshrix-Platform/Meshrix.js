import type {
  AccountActionTarget,
  AccountAuthorityBinding,
  AccountManagedRouteBinding,
  AccountEndpointOwnershipClaimResult,
  AccountManagedVaultWriterKey,
  AccountStepUpChallenge,
  AccountStepUpPermit,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "./authorization.ts";
import type { OAuthProviderId } from "./provider-ports.ts";

export const ACCOUNT_API_BASE = "/api/account";
export const ACCOUNT_CSRF_HEADER = "x-account-csrf";

/** Canonical same-origin browser and installed Entry HTTP routes. */
export const ACCOUNT_API_ROUTES = Object.freeze({
  capabilities: `${ACCOUNT_API_BASE}/capabilities`,
  registrationRequest: `${ACCOUNT_API_BASE}/registration/request`,
  registrationVerify: `${ACCOUNT_API_BASE}/registration/verify`,
  activationComplete: `${ACCOUNT_API_BASE}/activation/complete`,
  session: `${ACCOUNT_API_BASE}/session`,
  csrfBootstrap: `${ACCOUNT_API_BASE}/csrf`,
  signOut: `${ACCOUNT_API_BASE}/session/sign-out`,
  sessions: `${ACCOUNT_API_BASE}/sessions`,
  sessionRevoke: `${ACCOUNT_API_BASE}/sessions/{sessionId}`,
  sessionsRevokeOthers: `${ACCOUNT_API_BASE}/sessions/revoke-others`,
  devices: `${ACCOUNT_API_BASE}/devices`,
  accountDelete: `${ACCOUNT_API_BASE}/delete`,
  securityEvents: `${ACCOUNT_API_BASE}/security/events`,
  passkeyRegistrationOptions: `${ACCOUNT_API_BASE}/passkeys/enrollment/options`,
  passkeyRegistrationVerify: `${ACCOUNT_API_BASE}/passkeys/enrollment/verify`,
  passkeyLoginOptions: `${ACCOUNT_API_BASE}/passkeys/login/options`,
  passkeyLoginVerify: `${ACCOUNT_API_BASE}/passkeys/login/verify`,
  authenticatorEnrollment: `${ACCOUNT_API_BASE}/authenticators/enrollment`,
  authenticatorEnrollmentVerify: `${ACCOUNT_API_BASE}/authenticators/enrollment/verify`,
  passwordEnrollment: `${ACCOUNT_API_BASE}/password/enrollment`,
  passwordLogin: `${ACCOUNT_API_BASE}/password/login`,
  passwordTotpVerify: `${ACCOUNT_API_BASE}/password/login/totp`,
  oauthStart: `${ACCOUNT_API_BASE}/oauth/{provider}/start`,
  oauthCallback: `${ACCOUNT_API_BASE}/oauth/{provider}/callback`,
  factors: `${ACCOUNT_API_BASE}/security/factors`,
  factorRemove: `${ACCOUNT_API_BASE}/security/factors/{factorId}`,
  securityReauthentication: `${ACCOUNT_API_BASE}/security/reauthentication`,
  securityReauthenticationStatus: `${ACCOUNT_API_BASE}/security/reauthentication/status`,
  securityReauthenticationPasskeyVerify: `${ACCOUNT_API_BASE}/security/reauthentication/passkey/verify`,
  securityReauthenticationAuthenticatorVerify: `${ACCOUNT_API_BASE}/security/reauthentication/authenticator/verify`,
  securityEnrollmentConfirmationStart: `${ACCOUNT_API_BASE}/security/enrollment-confirmation/{provider}/start`,
  identityLinks: `${ACCOUNT_API_BASE}/security/identities`,
  identityLinkStart: `${ACCOUNT_API_BASE}/security/identities/{provider}/link`,
  identityUnlink: `${ACCOUNT_API_BASE}/security/identities/{provider}`,
  deviceEndpointClaimPrepare: `${ACCOUNT_API_BASE}/device/endpoints/claim/prepare`,
  deviceEndpointClaimComplete: `${ACCOUNT_API_BASE}/device/endpoints/claim/complete`,
  deviceRevoke: `${ACCOUNT_API_BASE}/device/revoke`,
  stepUpChallenge: `${ACCOUNT_API_BASE}/authorization/step-up`,
  stepUpPasskeyVerify: `${ACCOUNT_API_BASE}/authorization/step-up/passkey/verify`,
  stepUpAuthenticatorVerify: `${ACCOUNT_API_BASE}/authorization/step-up/authenticator/verify`,
  recoveryRedeem: `${ACCOUNT_API_BASE}/recovery/redeem`,
  recoveryPrepare: `${ACCOUNT_API_BASE}/recovery/prepare`,
  recoveryEmailRequest: `${ACCOUNT_API_BASE}/recovery/email`,
  recoveryCodesGenerate: `${ACCOUNT_API_BASE}/recovery/codes`,
  recoveryStatus: `${ACCOUNT_API_BASE}/recovery/status`,
  recoveryComplete: `${ACCOUNT_API_BASE}/recovery/complete`,
  recoveryRotateOptions: `${ACCOUNT_API_BASE}/recovery/rotate/options`,
  recoveryRotatePasskey: `${ACCOUNT_API_BASE}/recovery/rotate/passkey`,
  recoveryRotateAuthenticator: `${ACCOUNT_API_BASE}/recovery/rotate/authenticator`,
  deviceCurrentBinding: `${ACCOUNT_API_BASE}/device/current-binding`,
  deviceManagedRoute: `${ACCOUNT_API_BASE}/device/managed-route`,
  devicePendingPairingInspect: `${ACCOUNT_API_BASE}/device/pairing/inspect`,
  devicePairingTargetPublish: `${ACCOUNT_API_BASE}/device/pairing/target`,
  deviceStepUpInspect: `${ACCOUNT_API_BASE}/device/authorization/inspect`,
  deviceStepUpConsume: `${ACCOUNT_API_BASE}/device/authorization/consume`,
  devicePairingComplete: `${ACCOUNT_API_BASE}/device/pairing/complete`,
  desktopVaultWriterRotationPrepare: `${ACCOUNT_API_BASE}/desktop/vault-writers/prepare`,
  desktopVaultWriterRotationComplete: `${ACCOUNT_API_BASE}/desktop/vault-writers/complete`,
  desktopTransaction: `${ACCOUNT_API_BASE}/desktop/transactions`,
  desktopCodeContext: `${ACCOUNT_API_BASE}/desktop/code/context`,
  desktopCodeComplete: `${ACCOUNT_API_BASE}/desktop/code/complete`,
  desktopCodeApprove: `${ACCOUNT_API_BASE}/desktop/code/approve`,
  desktopTransactionPoll: `${ACCOUNT_API_BASE}/desktop/transactions/{transactionId}/poll`,
  desktopTransactionAcknowledge: `${ACCOUNT_API_BASE}/desktop/transactions/{transactionId}/acknowledge`,
  desktopPairingBootstrap: `${ACCOUNT_API_BASE}/desktop/pairing/bootstrap`,
} as const);

export type AccountFactorType = "passkey" | "password" | "authenticator" | "google" | "github" | "apple";

export interface AccountFactorSummary {
  readonly id: string;
  readonly type: AccountFactorType;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface AccountCapabilitiesResponse {
  readonly registrationAvailable: true;
  readonly defaultFactor: "passkey";
  readonly factors: { readonly passkey: true; readonly password?: true; readonly authenticator: true };
  readonly oauthProviders: readonly OAuthProviderId[];
  readonly emailDelivery: "available" | "temporarily_unavailable";
  readonly authenticationOriginAvailable: boolean;
}

export interface AccountApiError {
  readonly error: {
    readonly code:
      | "invalid_request"
      | "invalid_code"
      | "rate_limited"
      | "email_delivery_unavailable"
      | "provider_unavailable"
      | "configuration_missing"
      | "unauthorized"
      | "forbidden"
      | "factor_required"
      | "factor_verification_failed"
      | "account_active"
      | "account_stale"
      | "step_up_expired"
      | "step_up_consumed"
      | "target_mismatch"
      | "recovery_invalid"
      | "recovery_pending"
      | "conflict"
      | "not_found"
      | "internal_error";
    readonly message: string;
    readonly retryAt?: string;
  };
}

export interface AccountRegistrationRequest {
  readonly email: string;
}

export interface AccountRegistrationRequestResponse {
  readonly accepted: true;
  readonly delivery: "sent" | "pending";
}

/** Anonymous same-origin mutations echo this token through x-account-csrf.
 * The token is not authentication and is bound to a short-lived cookie. */
export interface AccountCsrfBootstrapResponse {
  readonly csrfToken: string;
}

export interface AccountSignOutResponse {
  readonly signedOut: true;
}

export interface AccountSessionSummary {
  readonly id: string;
  readonly kind: "browser" | "desktop";
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export interface AccountSessionListResponse {
  readonly sessions: readonly AccountSessionSummary[];
}

export interface AccountSessionRevokeResponse {
  readonly revoked: true;
  readonly current: boolean;
}

/** One active device authorization granted through account step-up approval. */
export interface AccountDeviceGrantSummary {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
}

export interface AccountDeviceListResponse {
  readonly devices: readonly AccountDeviceGrantSummary[];
}

export type AccountSecurityEventKind =
  | "authenticator_throttled"
  | "session_revoked"
  | "recovery_code_replaced"
  | "recovery_redeemed"
  | "factor_added"
  | "factor_removed";

export interface AccountSecurityEvent {
  readonly kind: AccountSecurityEventKind;
  readonly createdAt: string;
  readonly subjectRef: string | null;
}

export interface AccountSecurityEventListResponse {
  readonly events: readonly AccountSecurityEvent[];
}

export interface AccountRecoveryRotateOptionsResponse {
  readonly challenge: {
    readonly challengeId: string;
    readonly passkeyOptions: import("./authorization.ts").AuthenticationOptionsJSON | null;
    readonly authenticatorAvailable: boolean;
    readonly expiresAt: string;
  };
}

export interface AccountRecoveryRotateResponse {
  readonly replaced: true;
  readonly recoveryCodeDelivery: "pending";
}

export interface AccountRegistrationVerifyRequest {
  readonly email: string;
  readonly code: string;
}

export interface AccountRegistrationVerifyResponse {
  readonly activation: { readonly sessionState: "factor_enrollment_required" };
  readonly availableMethods: readonly ["passkey", "password_authenticator", "google", "github", "apple"];
}

export interface AccountActivationCompleteResponse {
  readonly account: AccountAuthorityBinding & { readonly email: string };
  readonly state: "active";
  readonly recoveryCodeDelivery: "sent" | "pending";
}

export interface AccountSessionResponse {
  readonly authenticated: boolean;
  readonly account: (AccountAuthorityBinding & { readonly email: string }) | null;
  readonly state: "anonymous" | "activation" | "active" | "recovery";
  readonly csrfToken: string | null;
  readonly factors: readonly AccountFactorSummary[];
  readonly recoveryDeliveryPending: boolean;
  /** Count of unused generated offline recovery codes; absent until sign-in. */
  readonly recoveryCodesRemaining?: number;
  readonly pendingSecurityReauthentication: AccountSecurityReauthenticationVerifiedResponse | null;
}

export interface PasskeyEnrollmentOptionsResponse {
  readonly challengeId: string;
  readonly options: import("./authorization.ts").RegistrationOptionsJSON;
}

export interface PasskeyEnrollmentOptionsRequest {
  /** Required for active accounts; activation/recovery sessions use their restricted authority. */
  readonly reauthenticationId?: string;
}

export interface PasskeyEnrollmentVerifyRequest {
  readonly challengeId: string;
  readonly response: RegistrationResponseJSON;
  readonly label?: string;
}

export interface PasskeyLoginOptionsRequest {
  readonly email: string;
}

export interface PasskeyLoginOptionsResponse {
  readonly challengeId: string;
  readonly options: import("./authorization.ts").AuthenticationOptionsJSON;
}

export interface PasskeyLoginVerifyRequest {
  readonly email: string;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}

export interface AuthenticatorEnrollmentResponse {
  readonly factorId: string;
  readonly challengeId: string;
  /** Display once in the browser for QR provisioning. Never returned later. */
  readonly otpauthUrl: string;
  readonly verificationRequired: true;
}

export interface AuthenticatorEnrollmentRequest {
  /** Required for active accounts; restricted activation/recovery sessions omit it. */
  readonly reauthenticationId?: string;
}

export interface AuthenticatorVerifyRequest {
  readonly challengeId: string;
  readonly code: string;
  readonly label?: string;
}

export interface PasswordLoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface PasswordLoginResponse {
  readonly challengeId: string;
  readonly secondFactor: "authenticator";
  readonly expiresAt: string;
}

export interface PasswordTotpVerifyRequest {
  readonly challengeId: string;
  readonly email: string;
  readonly code: string;
}

export interface OAuthStartRequest {
  readonly provider: OAuthProviderId;
  readonly purpose: "activation" | "login";
  /** Optional user-facing desktop device code; OAuth state must bind and
   * validate it server-side. This never carries a verifier or session credential. */
  readonly code?: string;
}

export interface OAuthStartResponse {
  readonly authorizationUrl: string;
}

export interface AccountFactorListResponse {
  readonly factors: readonly AccountFactorSummary[];
}

export type AccountSecurityMutationIntent = "enroll_factor" | "remove_factor" | "link_identity" | "unlink_identity" | "delete_account";

export interface AccountSecurityReauthenticationStartRequest {
  readonly intent: AccountSecurityMutationIntent;
  readonly targetId?: string;
}

export interface AccountSecurityReauthenticationChallenge {
  readonly challengeId: string;
  readonly intent: AccountSecurityMutationIntent;
  readonly targetId: string | null;
  readonly passkeyOptions: import("./authorization.ts").AuthenticationOptionsJSON | null;
  readonly authenticatorAvailable: boolean;
  /** Available only for an OAuth-only account adding its first local factor. */
  readonly linkedIdentityConfirmationProviders: readonly OAuthProviderId[];
  readonly expiresAt: string;
}

export interface AccountSecurityReauthenticationStartResponse {
  readonly challenge: AccountSecurityReauthenticationChallenge;
}

export interface AccountSecurityEnrollmentConfirmationStartRequest {
  /** A fresh same-subject OAuth callback proves possession of an already-linked
   * identity for this mutation; it makes no provider-auth-time assertion. */
  readonly intent: "enroll_factor";
  readonly targetId: "passkey" | "authenticator" | "password";
}

export interface AccountSecurityReauthenticationPasskeyVerifyRequest {
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}

export interface AccountSecurityReauthenticationAuthenticatorVerifyRequest {
  readonly challengeId: string;
  readonly code: string;
}

export interface AccountSecurityReauthenticationVerifiedResponse {
  /** One-use, session-bound authorization for exactly the requested mutation. */
  readonly reauthenticationId: string;
  readonly intent: AccountSecurityMutationIntent;
  readonly targetId: string | null;
  readonly method: "passkey" | "authenticator" | "linked_identity_confirmation";
  readonly provider?: OAuthProviderId;
  readonly expiresAt: string;
}

export interface AccountSecurityMutationRequest {
  readonly reauthenticationId: string;
}

export interface AccountSecurityReauthenticationStatusResponse {
  readonly authorization: AccountSecurityReauthenticationVerifiedResponse | null;
}

export interface AccountOAuthLinkStartRequest {
  readonly provider: OAuthProviderId;
  readonly reauthenticationId: string;
}

export interface AccountIdentityLinksResponse {
  readonly identities: readonly {
    readonly provider: OAuthProviderId;
    readonly subjectLabel: string;
    readonly linkedAt: string;
  }[];
}

export interface AccountStepUpStartRequest {
  /** The browser never submits an action target or bootstrap/claim reference.
   * The authority resolves the exact pending action from the user-facing
   * desktop device code after confirming the current browser account. */
  readonly code: string;
}

export interface AccountStepUpStartResponse {
  readonly challenge: AccountStepUpChallenge;
}

export interface AccountStepUpPasskeyVerifyRequest {
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}

export interface AccountStepUpAuthenticatorVerifyRequest {
  readonly challengeId: string;
  readonly code: string;
}

export interface AccountStepUpVerifiedResponse {
  readonly permit: AccountStepUpPermit;
}

export interface AccountRecoveryRedeemRequest {
  readonly email: string;
  readonly code: string;
  /** Issued by recovery/prepare and bound to a separate HttpOnly cookie. */
  readonly attemptId: string;
}

export interface AccountRecoveryPrepareRequest {
  readonly email: string;
}

export interface AccountRecoveryPrepareResponse {
  readonly attemptId: string;
  readonly continuation: "ready";
}

export interface AccountRecoveryCodesGenerateRequest {
  /** Challenge from recoveryRotateOptions; the verified factor gates generation. */
  readonly challengeId: string;
  readonly response?: AuthenticationResponseJSON;
  readonly code?: string;
}

export interface AccountRecoveryCodesGenerateResponse {
  /** Plaintext codes shown exactly once; only their digests are stored. */
  readonly codes: readonly string[];
}

export interface AccountRecoveryRedeemResponse {
  readonly account: AccountAuthorityBinding & { readonly email: string };
  readonly state: "recovery";
  readonly revocation: "pending" | "complete";
  readonly enrollmentRequired: true;
}

export interface AccountRecoveryCompleteResponse {
  readonly account: AccountAuthorityBinding & { readonly email: string };
  readonly state: "active";
  readonly recoveryCodeDelivery: "sent" | "pending";
}

export interface AccountRecoveryCompleteRequest {
  /** Recovery continuation is authenticated by the HttpOnly cookie. */
  readonly acknowledgePendingDelivery?: true;
}

export interface AccountRecoveryStatusResponse {
  readonly state: "none" | "continuation_ready" | "recovery_enrollment_required" | "complete";
  readonly account: (AccountAuthorityBinding & { readonly email: string }) | null;
  readonly revocation: "pending" | "complete" | null;
  readonly recoveryCodeDelivery: "pending" | "sent" | null;
}

export interface AccountDeviceCurrentBindingRequest {
  readonly peerDeviceId: string;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export interface AccountDeviceCurrentBindingResponse {
  readonly account: AccountAuthorityBinding;
  /** Exact active grant for this endpoint/Entry pair, or null when revoked. */
  readonly target: AccountActionTarget | null;
  readonly authorizedScopes: readonly string[];
}

/** Signed endpoint startup/current-route query. Unlike current-binding, this
 * proves the enrolled endpoint key itself and returns its canonical managed
 * route; it does not select or authorize an Entry peer grant. */
export interface AccountDeviceManagedRouteRequest {
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof & { readonly purpose: "managed_route" };
}

export interface AccountDeviceManagedRouteResponse {
  readonly managedRoute: AccountManagedRouteBinding;
}

export interface AccountDeviceStepUpConsumeRequest {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: AccountStepUpChallenge["purpose"];
  readonly target: AccountActionTarget;
  readonly bootstrapId?: string;
  readonly operationId: string;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export interface AccountDeviceStepUpInspectRequest {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: AccountStepUpChallenge["purpose"];
  readonly target: AccountActionTarget;
  readonly bootstrapId?: string;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export type AccountDeviceStepUpInspectResponse =
  | { readonly valid: true; readonly permit: AccountStepUpPermit }
  | { readonly valid: false; readonly reason: string };

export interface AccountPendingPairingInspectRequest {
  readonly bootstrapId: string;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export type AccountPendingPairingInspectResponse = import("./authorization.ts").AccountPendingPairing | null;

export interface AccountPairingTargetPublishApiRequest {
  readonly bootstrapId: string;
  readonly target: AccountActionTarget;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export type AccountPairingTargetPublishApiResponse = import("./authorization.ts").AccountPendingPairing | null;

export interface AccountDevicePairingCompletionRequest {
  readonly account: AccountAuthorityBinding;
  readonly bootstrapId: string;
  readonly operationId: string;
  readonly target: AccountActionTarget;
  readonly proof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export interface AccountEndpointOwnershipClaimPrepareRequest {
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly endpointPinRef: string;
  readonly mode: "personal";
  readonly desktopProof: AccountDesktopSessionProof;
}

export interface AccountEndpointOwnershipClaimPrepareResponse {
  readonly claimId: string;
  readonly account: AccountAuthorityBinding;
  /** Newly allocated for an unowned route; reused only for an idempotent
   * claim of the same account-owned route. */
  readonly vaultId: string;
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
}

export interface AccountEndpointOwnershipClaimCompleteRequest {
  readonly claimId: string;
  readonly permitId: string;
  readonly operationId: string;
  readonly endpointProof: import("./authorization.ts").AccountDeviceAuthorityProof;
  readonly desktopProof: AccountDesktopSessionProof;
}

export interface AccountEndpointOwnershipClaimCompleteResponse extends AccountEndpointOwnershipClaimResult {
  readonly relayAdmission: string;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly expiresAt: string | null;
}

/** Browser context is resolved from server-held transaction state. The UI
 * never trusts a target copied from its URL. */
interface AccountDesktopStepUpTransactionBase {
  readonly purpose: "step_up";
  readonly verifierDigest: string;
  readonly clientPublicKey: string;
  readonly target: AccountActionTarget;
  /** A current desktop-session proof for POST /api/account/desktop/transactions.
   * It signs the canonical JSON of all other request fields, including the
   * verifier digest, action purpose, exact target and the single bootstrap or
   * claim reference. Browser cookies never cross into the installed client. */
  readonly desktopProof: AccountDesktopSessionProof;
}

export type AccountDesktopTransactionCreateRequest =
  | {
    readonly purpose: "login";
    /** Digest of a client-generated verifier retained only by installed Entry. */
    readonly verifierDigest: string;
    readonly clientPublicKey: string;
    readonly target?: null;
  }
  | (AccountDesktopStepUpTransactionBase & {
    readonly actionPurpose: "pair_device";
    readonly bootstrapId: string;
    readonly claimId?: never;
  })
  | (AccountDesktopStepUpTransactionBase & {
    readonly actionPurpose: "pair_device";
    readonly bootstrapId?: never;
    /** Server-prepared initial endpoint claim; the exact target and current
     * account epoch are revalidated by the authority. */
    readonly claimId: string;
  })
  | (AccountDesktopStepUpTransactionBase & {
    readonly actionPurpose: "grant_access";
    readonly bootstrapId?: never;
    readonly claimId?: never;
  });

/** A current signed desktop-session request that approves a pending
 * XXXX-XXXX desktop code transaction — the headless counterpart of the
 * browser approval page. An already-enrolled device vouches for the code:
 * for `login` transactions the approval binds the account exactly as the
 * browser completion does; for `step_up` transactions the proof stands in
 * for the verified factor and issues the bound permit directly. */
export interface AccountDesktopCodeApproveRequest {
  readonly code: string;
  readonly desktopProof: AccountDesktopSessionProof;
}

export interface AccountDesktopSessionProof {
  readonly credential: string;
  readonly clientPublicKey: string;
  readonly nonce: string;
  /** SHA-256 digest of canonical JSON for the request body excluding proof. */
  readonly bodyDigest: string;
  readonly signature: string;
}

/** A current signed desktop-session request that revokes exactly one
 * account-owned endpoint route or Entry grant. Target role is resolved by the
 * authority from its own route/grant rows, never from the caller. */
export interface AccountDeviceRevokeRequest {
  readonly operationId: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly desktopProof: AccountDesktopSessionProof;
}

export interface AccountDeviceRevokeResponse {
  readonly authorityRevoked: true;
  readonly operationId: string;
  readonly target: "route" | "device";
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly enforcement: "pending" | "complete";
}

export interface AccountDesktopVaultWriterRotationPrepareRequest {
  readonly operationId: string;
  readonly vaultId: string;
  readonly writers: readonly AccountManagedVaultWriterKey[];
  readonly recoveryVerifier: AccountManagedVaultWriterKey;
  readonly desktopProof: AccountDesktopSessionProof;
  readonly deviceProof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export interface AccountDesktopVaultWriterRotationPrepareResponse {
  readonly operationId: string;
  readonly account: AccountAuthorityBinding;
  /** Server-derived from the account-owned vault route/current Entry grant. */
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
}

export interface AccountDesktopVaultWriterRotationCompleteRequest {
  readonly operationId: string;
  readonly permitId: string;
  readonly target: AccountActionTarget;
  /** Entry submits only after it has durably saved the matching private keys. */
  readonly keyCustodyConfirmed: true;
  readonly desktopProof: AccountDesktopSessionProof;
  readonly deviceProof: import("./authorization.ts").AccountDeviceAuthorityProof;
}

export interface AccountDesktopVaultWriterRotationCompleteResponse {
  readonly state: "pending" | "complete";
  readonly account: AccountAuthorityBinding;
  readonly operationId: string;
  readonly vaultId: string;
  readonly generation: number;
}

export interface AccountDesktopPairingBootstrapRequest {
  readonly tenantId: string;
  readonly routeId: string;
  readonly entryDeviceId: string;
  /** Fresh endpoint-specific Entry key, distinct from the desktop client key. */
  readonly entryDevicePublicKey: string;
  readonly endpointPinRef: string;
  readonly mode: "personal" | "enterprise";
  readonly proof: AccountDesktopSessionProof;
}

export interface AccountDesktopPairingBootstrapResponse {
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

export type AccountDesktopTransactionContextResponse =
  | { readonly purpose: "login"; readonly target: null }
  | { readonly purpose: "step_up"; readonly actionPurpose: "pair_device"; readonly target: AccountActionTarget; readonly bootstrapId: string | null; readonly claimId: string | null }
  | { readonly purpose: "step_up"; readonly actionPurpose: "grant_access"; readonly target: AccountActionTarget; readonly bootstrapId: null; readonly claimId: null };

export interface AccountDesktopTransactionCreateResponse {
  readonly transactionId: string;
  readonly browserUrl: string;
  /** User-facing XXXX-XXXX device code shown in the client and entered (or
   * prefilled) on the account approval page. */
  readonly userCode: string;
}

export interface AccountDesktopCodeContextRequest {
  readonly code: string;
}

export interface AccountDesktopCodeCompleteRequest {
  readonly code: string;
  readonly permitId?: string;
}

export interface AccountDesktopTransactionPollRequest {
  readonly verifier: string;
}

export interface AccountDesktopTransactionAcknowledgeRequest {
  readonly verifier: string;
}

export type AccountDesktopTransactionPollResponse =
  | { readonly state: "pending" }
  | { readonly state: "complete"; readonly purpose: "login"; readonly account: AccountAuthorityBinding & { readonly email: string }; readonly deviceSessionCredential: string; readonly permitId: null; readonly target: null }
  | { readonly state: "complete"; readonly purpose: "step_up"; readonly actionPurpose: AccountStepUpChallenge["purpose"]; readonly account: AccountAuthorityBinding & { readonly email: string }; readonly deviceSessionCredential: null; readonly permitId: string; readonly target: AccountActionTarget }
  | { readonly state: "expired" | "consumed" };

export interface PasswordEnrollmentRequest {readonly password:string;readonly reauthenticationId?:string;}
export type PasswordEnrollmentResponse = {readonly enrolled:true;readonly secondFactorRequired:"authenticator"} | {readonly changed:true;readonly signedOut:true;readonly revocation:"pending"};
