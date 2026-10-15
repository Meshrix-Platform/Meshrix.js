import type {
  AccountStepUpPurpose,
  AuthenticationOptionsJSON,
  AuthenticationResponseJSON,
  RegistrationOptionsJSON,
  RegistrationResponseJSON,
} from "./authorization.ts";

export interface PasskeyCredentialRecord {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly backedUp: boolean;
}

export interface PasskeyRegistrationOptionsInput {
  readonly accountId: string;
  readonly email: string;
  readonly challenge: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly excludeCredentialIds: readonly string[];
}

export interface PasskeyRegistrationVerificationInput {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly response: RegistrationResponseJSON;
}

export interface PasskeyAuthenticationOptionsInput {
  readonly challenge: string;
  readonly rpId: string;
  readonly credentialIds: readonly string[];
}

export interface PasskeyAuthenticationVerificationInput {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly response: AuthenticationResponseJSON;
  readonly credential: PasskeyCredentialRecord;
}

export interface VerifiedPasskeyRegistration {
  readonly verified: true;
  readonly credential: PasskeyCredentialRecord;
}

export interface VerifiedPasskeyAuthentication {
  readonly verified: true;
  readonly newSignCount: number;
  readonly userVerified: true;
}

export interface PasskeyProvider {
  createRegistrationOptions(input: PasskeyRegistrationOptionsInput): Promise<RegistrationOptionsJSON>;
  verifyRegistration(input: PasskeyRegistrationVerificationInput): Promise<VerifiedPasskeyRegistration | null>;
  createAuthenticationOptions(input: PasskeyAuthenticationOptionsInput): Promise<AuthenticationOptionsJSON>;
  verifyAuthentication(input: PasskeyAuthenticationVerificationInput): Promise<VerifiedPasskeyAuthentication | null>;
}

export interface TotpCredentialMaterial {
  readonly secret: string;
  readonly otpauthUrl: string;
}

export interface TotpProvider {
  createTotpCredential(input: { readonly issuer: string; readonly accountLabel: string }): Promise<TotpCredentialMaterial>;
  verifyTotpCode(input: { readonly secret: string; readonly code: string; readonly nowMs: number }): Promise<{ readonly matchedStep: number } | null>;
}

/** Password verifiers include their KDF version, parameters and random salt.
 * Null performs the same cost verification for an unknown identity. */
export interface PasswordProvider {
  createPasswordCredential(input: { readonly password: string }): Promise<{ readonly verifier: string }>;
  verifyPassword(input: { readonly password: string; readonly verifier: string | null }): Promise<{
    readonly valid: boolean;
    readonly replacementVerifier?: string;
  }>;
}

export type OAuthProviderId = "google" | "github" | "apple";
/** enrollment_confirmation checks the same already-linked stable subject in
 * a fresh browser/state/PKCE flow; it does not assert provider auth_time. */
export type OAuthPurpose = "activation" | "login" | "link" | "enrollment_confirmation";

export interface OAuthAuthorizationInput {
  readonly provider: OAuthProviderId;
  readonly purpose: OAuthPurpose;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly callbackUrl: string;
}

export interface OAuthIdentity {
  readonly provider: OAuthProviderId;
  readonly subject: string;
  readonly verifiedEmail: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface OAuthCallbackInput extends OAuthAuthorizationInput {
  readonly authorizationCode: string;
}

export interface OAuthProvider {
  buildAuthorizationUrl(input: OAuthAuthorizationInput): Promise<string>;
  exchangeCallback(input: OAuthCallbackInput): Promise<OAuthIdentity | null>;
}

export type EmailDeliveryOutcome =
  | { readonly status: "sent"; readonly providerMessageId: string }
  | { readonly status: "quota-deferred"; readonly quota: "daily" | "monthly"; readonly retryAt?: string }
  | { readonly status: "rate-limited"; readonly retryAt?: string }
  | { readonly status: "config-rejected"; readonly detailCode: string }
  | { readonly status: "delivery-unknown"; readonly detailCode: string }
  | { readonly status: "provider-rejected"; readonly detailCode: string };

export interface TransactionalEmailInput {
  readonly eventId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface TransactionalEmailProvider {
  sendTransactionalEmail(input: TransactionalEmailInput): Promise<EmailDeliveryOutcome>;
}

/** Call context persisted by authority and supplied only after the matching
 * server-side state row has been consumed exactly once. */
export interface OAuthStoredContext extends OAuthAuthorizationInput {
  readonly accountId: string | null;
  readonly authEpoch: number | null;
  readonly emailChallengeId: string | null;
  readonly recoveryAttemptId: string | null;
}

export interface StepUpProviderContext {
  readonly purpose: AccountStepUpPurpose;
  readonly challengeId: string;
  readonly accountId: string;
  readonly authEpoch: number;
}
