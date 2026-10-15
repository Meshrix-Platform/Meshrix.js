/**
 * Entry pairing contract shared by the installed Entry application, the
 * entry-transport pairing channel, and endpoint pairing surfaces.
 *
 * The invite artifact is a wire object crossing the endpoint-to-entry
 * boundary; its schema constants and structural types therefore live in
 * Contracts rather than in any single consumer package.
 */
import type { AccountActionTarget, AccountAuthorityBinding } from "./authorization.ts";

export const ENTRY_PAIRING_SCHEMA = "v0.0.1:entry:pairing-invite-2";
export const ENTRY_PAIRING_KIND = "entry-pairing-invite";

export interface PairingRecoveryAuthority {
  readonly keyId: string;
  readonly generation: number;
}

export interface PairingInvite {
  readonly schemaVersion: string;
  readonly kind: typeof ENTRY_PAIRING_KIND;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly tenantId: string;
  readonly mode: "personal" | "enterprise";
  /** Account-authority-owned endpoint key identity; never inferred from route/principal ids. */
  readonly endpointDeviceId: string;
  readonly endpointPrincipalRef: string;
  /** Endpoint SPKI pin — the inner-channel trust anchor (`spki` form). */
  readonly endpointSpkiPin: string;
  /** Account route pin binding. It must equal endpointSpkiPin. */
  readonly endpointPinRef: string;
  /** Relay service base URL the endpoint is reachable through. */
  readonly relayService: string;
  readonly vaultId: string;
  /** Recovery authority enrolled at invite issue (informational binding). */
  readonly recoveryAuthority: PairingRecoveryAuthority | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** One-time bearer token proving invite legitimacy to the endpoint. */
  readonly pairingToken: string;
}

/** Public Signal identity accepted only through the explicit pinned pairing
 * exchange. `identityKey` is the serialized libsignal public key, base64url. */
export interface PairingPeerIdentity {
  readonly peerId: string;
  readonly signalDeviceId: number;
  readonly registrationId: number;
  readonly identityKey: string;
}

export function isPairingPeerIdentity(value: unknown, expectedPeerId?: string): value is PairingPeerIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<PairingPeerIdentity>;
  return typeof identity.peerId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(identity.peerId)
    && (expectedPeerId === undefined || identity.peerId === expectedPeerId)
    && identity.signalDeviceId === 1
    && Number.isSafeInteger(identity.registrationId)
    && (identity.registrationId as number) >= 1 && (identity.registrationId as number) <= 0x3fff
    && typeof identity.identityKey === "string"
    && /^[A-Za-z0-9_-]{44}$/u.test(identity.identityKey);
}

export interface PairingCompletionRequest {
  readonly invite: PairingInvite;
  readonly challengeId: string;
  readonly deviceId: string;
  readonly devicePublicKey: string;
  /** Stable Signal identity of the Entry route/device being paired. Null only
   * when a self-hosted endpoint has Peer messaging disabled. */
  readonly entryPeerIdentity: PairingPeerIdentity | null;
  readonly signature: string;
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: "pair_device";
  readonly target: AccountActionTarget;
  readonly operationId: string;
}

export interface PairingCompletionReceipt {
  readonly outcome: "enrolled";
  readonly capabilityGrantRef: string;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  /** Endpoint Signal identity returned over the invite-pinned TLS channel. */
  readonly endpointPeerIdentity: PairingPeerIdentity | null;
}

/**
 * Narrow endpoint port for pairing. The production binding arrives with the
 * GUI/transport node; tests drive a fake endpoint.
 */
export interface PairingEndpointPort {
  beginPairing(input: {
    readonly invite: PairingInvite;
    readonly deviceId: string;
    readonly devicePublicKey: string;
  }): Promise<{
    readonly outcome: "challenge";
    readonly challengeId: string;
    readonly nonce: string;
    readonly expiresAt: string;
    readonly account: AccountAuthorityBinding;
    readonly target: AccountActionTarget;
  } | {
    readonly outcome: "refused";
    readonly refusal: string;
  }>;
  completePairing(input: PairingCompletionRequest): Promise<PairingCompletionReceipt | {
    readonly outcome: "refused";
    readonly refusal: string;
  }>;
}
