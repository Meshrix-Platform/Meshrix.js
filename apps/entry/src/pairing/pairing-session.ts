/**
 * Pairing session state model — UI-agnostic.
 *
 * Drives the explicit trusted-pairing handshake against a narrow endpoint
 * port: the invite is validated, a fresh device identity is minted into
 * custody, the endpoint issues a pairing challenge bound to the invite and
 * device key, the device signs the challenge transcript, and the endpoint
 * returns an enrolled device record (trust binding + grant reference).
 *
 * States are honest: `offline`/`retry_required` are first-class outcomes,
 * never reclassified as success or as "not started". The pairing token from
 * the invite is a one-time bearer proving invite legitimacy — it is sent to
 * the endpoint once and never persisted into the device record.
 */
import { entryError } from "../errors.ts";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { signEd25519 } from "../keys.ts";
import type { CustodyAdapter } from "../identity/custody.ts";
import {
  enrollDeviceIdentity,
  loadDevicePrivateKey,
  type DeviceIdentity
} from "../identity/device-identity.ts";
import {
  inviteToTrustBinding,
  type PairingInvite
} from "./pairing-invite.ts";
import { parseEndpointTrustBinding } from "@meshrix/contracts/private-relay";

export type PairingState =
  | "pending"
  | "challenge_issued"
  | "proof_submitted"
  | "enrolled"
  | "refused"
  | "offline"
  | "retry_required"
  | "expired"
  | "cancelled";

export interface EnrolledDeviceRecord {
  readonly deviceId: string;
  readonly devicePublicKey: string;
  readonly fingerprint: string;
  readonly trustBinding: Record<string, unknown>;
  readonly inviteId: string;
  readonly enrolledAt: string;
  readonly capabilityGrantRef: string;
}

export interface PairingSessionSnapshot {
  readonly sessionId: string;
  readonly state: PairingState;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly deviceId: string | null;
  readonly challengeId: string | null;
  readonly refusal: string | null;
  readonly record: EnrolledDeviceRecord | null;
  readonly updatedAt: string;
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
  } | {
    readonly outcome: "refused";
    readonly refusal: string;
  }>;
  completePairing(input: {
    readonly invite: PairingInvite;
    readonly challengeId: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly capabilityGrantRef: string;
    readonly signature: string;
  }): Promise<{
    readonly outcome: "enrolled";
    readonly capabilityGrantRef: string;
  } | {
    readonly outcome: "refused";
    readonly refusal: string;
  }>;
}

/** Canonical transcript the fresh device key signs inside the challenge. */
export function pairingProofTranscript(input: {
  readonly challengeId: string;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly deviceId: string;
  readonly devicePublicKey: string;
}): string {
  return canonicalJson({
    challengeId: input.challengeId,
    inviteId: input.inviteId,
    endpointRouteId: input.endpointRouteId,
    deviceId: input.deviceId,
    devicePublicKey: input.devicePublicKey,
    purpose: "pair_device"
  });
}

let sessionCounter = 0;

export class PairingSession {
  readonly #custody: CustodyAdapter;
  readonly #endpoint: PairingEndpointPort;
  readonly #now: () => number;
  readonly #grantRef: string;
  readonly #boundRecoveryKeyId: string | null;
  readonly #sessionId: string;
  #state: PairingState = "pending";
  #invite: PairingInvite;
  #device: DeviceIdentity | null = null;
  #challengeId: string | null = null;
  #refusal: string | null = null;
  #record: EnrolledDeviceRecord | null = null;

  constructor(options: {
    invite: PairingInvite;
    custody: CustodyAdapter;
    endpoint: PairingEndpointPort;
    /** Grant reference the endpoint admin staged for this invite. */
    capabilityGrantRef?: string;
    boundRecoveryKeyId?: string | null;
    now?: () => number;
  }) {
    this.#invite = options.invite;
    this.#custody = options.custody;
    this.#endpoint = options.endpoint;
    this.#grantRef = options.capabilityGrantRef ?? `grant.pending.${options.invite.inviteId}`;
    this.#boundRecoveryKeyId = options.boundRecoveryKeyId ?? null;
    this.#now = options.now ?? (() => Date.now());
    sessionCounter += 1;
    this.#sessionId = `pair.session.${sessionCounter}.${Math.random().toString(36).slice(2, 10)}`;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  snapshot(): PairingSessionSnapshot {
    return Object.freeze({
      sessionId: this.#sessionId,
      state: this.#state,
      inviteId: this.#invite.inviteId,
      endpointRouteId: this.#invite.endpointRouteId,
      deviceId: this.#device?.deviceId ?? null,
      challengeId: this.#challengeId,
      refusal: this.#refusal,
      record: this.#record,
      updatedAt: new Date(this.#now()).toISOString()
    });
  }

  #expectState(...allowed: PairingState[]): void {
    if (!allowed.includes(this.#state)) {
      throw entryError(
        "pairing_state_invalid",
        `Pairing session in state ${this.#state}; expected ${allowed.join("|")}.`
      );
    }
  }

  /** Begin: mint the fresh device key into custody and request a challenge. */
  async begin(): Promise<PairingSessionSnapshot> {
    this.#expectState("pending", "retry_required");
    if (Date.parse(this.#invite.expiresAt) <= this.#now()) {
      this.#state = "expired";
      return this.snapshot();
    }
    this.#device ??= await enrollDeviceIdentity({ custody: this.#custody });
    let answer: Awaited<ReturnType<PairingEndpointPort["beginPairing"]>>;
    try {
      answer = await this.#endpoint.beginPairing({
        invite: this.#invite,
        deviceId: this.#device.deviceId,
        devicePublicKey: this.#device.publicKey
      });
    } catch (error) {
      // Transport failure is honest offline state — not a refusal.
      if ((error as { code?: unknown })?.code === "endpoint_unreachable") {
        this.#state = "offline";
        return this.snapshot();
      }
      throw error;
    }
    if (answer.outcome === "refused") {
      this.#state = "refused";
      this.#refusal = answer.refusal;
      return this.snapshot();
    }
    if (Date.parse(answer.expiresAt) <= this.#now()) {
      this.#state = "expired";
      return this.snapshot();
    }
    this.#challengeId = answer.challengeId;
    this.#state = "challenge_issued";
    return this.snapshot();
  }

  /** Submit the device-signed proof for the issued challenge. */
  async submitProof(): Promise<PairingSessionSnapshot> {
    this.#expectState("challenge_issued", "retry_required");
    const device = this.#device;
    const challengeId = this.#challengeId;
    if (!device || !challengeId) {
      throw entryError("pairing_state_invalid", "No issued challenge is bound to this session.");
    }
    const privateKey = await loadDevicePrivateKey({
      custody: this.#custody,
      deviceId: device.deviceId
    });
    if (!privateKey) {
      throw entryError("custody_unavailable", "The paired device key is not in custody.");
    }
    const signature = signEd25519(privateKey, pairingProofTranscript({
      challengeId,
      inviteId: this.#invite.inviteId,
      endpointRouteId: this.#invite.endpointRouteId,
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey
    }));
    this.#state = "proof_submitted";
    let answer: Awaited<ReturnType<PairingEndpointPort["completePairing"]>>;
    try {
      answer = await this.#endpoint.completePairing({
        invite: this.#invite,
        challengeId,
        deviceId: device.deviceId,
        devicePublicKey: device.publicKey,
        capabilityGrantRef: this.#grantRef,
        signature
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "endpoint_unreachable") {
        // The proof may or may not have landed — explicit retry-required,
        // never a silent re-submit or a false enrolled claim.
        this.#state = "retry_required";
        return this.snapshot();
      }
      throw error;
    }
    if (answer.outcome === "refused") {
      this.#state = "refused";
      this.#refusal = answer.refusal;
      return this.snapshot();
    }
    const trustBinding = inviteToTrustBinding({
      invite: this.#invite,
      devicePublicKey: device.publicKey,
      deviceFingerprint: device.fingerprint,
      capabilityGrantRef: answer.capabilityGrantRef,
      boundRecoveryKeyId: this.#boundRecoveryKeyId
    });
    // The record is only enrolled when it satisfies the wire contract.
    if (!parseEndpointTrustBinding(trustBinding)) {
      throw entryError("device_record_invalid", "The produced trust binding fails the wire contract.");
    }
    this.#record = Object.freeze({
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey,
      fingerprint: device.fingerprint,
      trustBinding,
      inviteId: this.#invite.inviteId,
      enrolledAt: new Date(this.#now()).toISOString(),
      capabilityGrantRef: answer.capabilityGrantRef
    });
    this.#state = "enrolled";
    return this.snapshot();
  }

  /** Mark the session interrupted and retry-safe (e.g. app restart). */
  interrupt(): PairingSessionSnapshot {
    if (this.#state === "enrolled" || this.#state === "refused" || this.#state === "cancelled") {
      return this.snapshot();
    }
    this.#state = "retry_required";
    return this.snapshot();
  }

  cancel(): PairingSessionSnapshot {
    if (this.#state !== "enrolled") {
      this.#state = "cancelled";
    }
    return this.snapshot();
  }
}

export function createPairingSession(options: ConstructorParameters<typeof PairingSession>[0]): PairingSession {
  return new PairingSession(options);
}
