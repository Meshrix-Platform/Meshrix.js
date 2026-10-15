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
import { peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import { randomOpaqueId, signEd25519 } from "../keys.ts";
import type { CustodyAdapter } from "../identity/custody.ts";
import {
  canonicalAccountActionTarget,
  isAccountStepUpPermitId,
  isPairingPeerIdentity,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type PairingCompletionReceipt,
  type PairingCompletionRequest,
  type PairingEndpointPort,
  type PairingInvite,
  type PairingPeerIdentity
} from "@meshrix/contracts/account";
import {
  enrollDeviceIdentity,
  loadDevicePrivateKey,
  type DeviceIdentity
} from "../identity/device-identity.ts";
import { inviteToTrustBinding } from "./pairing-invite.ts";
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
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly endpointPeerIdentity: PairingPeerIdentity | null;
}

export interface PairingActionAuthorization {
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: "pair_device";
  readonly target: AccountActionTarget;
}

export type {
  PairingCompletionReceipt,
  PairingCompletionRequest,
  PairingEndpointPort,
  PairingPeerIdentity
} from "@meshrix/contracts/account";

export interface PairingSessionSnapshot {
  readonly sessionId: string;
  readonly state: PairingState;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly deviceId: string | null;
  readonly challengeId: string | null;
  readonly refusal: string | null;
  readonly account: AccountAuthorityBinding | null;
  readonly target: AccountActionTarget | null;
  readonly record: EnrolledDeviceRecord | null;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical transcript the fresh device key signs inside the challenge. */
export function pairingProofTranscript(input: {
  readonly challengeId: string;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly deviceId: string;
  readonly devicePublicKey: string;
  readonly entryPeerIdentity: PairingPeerIdentity | null;
}): string {
  return canonicalJson({
    challengeId: input.challengeId,
    inviteId: input.inviteId,
    endpointRouteId: input.endpointRouteId,
    deviceId: input.deviceId,
    devicePublicKey: input.devicePublicKey,
    entryPeerIdentity: input.entryPeerIdentity,
    purpose: "pair_device"
  });
}

let sessionCounter = 0;

export class PairingSession {
  readonly #custody: CustodyAdapter;
  readonly #endpoint: PairingEndpointPort;
  readonly #now: () => number;
  readonly #boundRecoveryKeyId: string | null;
  readonly #entryPeerIdentity: PairingPeerIdentity | null;
  readonly #beforeComplete?: (input: PairingCompletionRequest) => Promise<void>;
  readonly #sessionId: string;
  #state: PairingState = "pending";
  #invite: PairingInvite;
  #device: DeviceIdentity | null = null;
  #challengeId: string | null = null;
  #account: AccountAuthorityBinding | null = null;
  #target: AccountActionTarget | null = null;
  #operationId: string | null = null;
  #refusal: string | null = null;
  #record: EnrolledDeviceRecord | null = null;

  constructor(options: {
    invite: PairingInvite;
    custody: CustodyAdapter;
    endpoint: PairingEndpointPort;
    /** Persist the exact signed operation before endpoint dispatch. */
    beforeComplete?: (input: PairingCompletionRequest) => Promise<void>;
    /** Fresh key generated before account bootstrap, stored only in custody. */
    device?: DeviceIdentity;
    /** Existing route-scoped Peer identity; null only when Peer is disabled. */
    entryPeerIdentity?: PairingPeerIdentity | null;
    boundRecoveryKeyId?: string | null;
    now?: () => number;
  }) {
    this.#invite = options.invite;
    this.#custody = options.custody;
    this.#endpoint = options.endpoint;
    this.#beforeComplete = options.beforeComplete;
    this.#boundRecoveryKeyId = options.boundRecoveryKeyId ?? null;
    this.#device = options.device ?? null;
    this.#entryPeerIdentity = options.entryPeerIdentity ?? null;
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
      account: this.#account,
      target: this.#target,
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
    if (this.#entryPeerIdentity && !validPeerIdentity(this.#entryPeerIdentity, routePeerId(this.#invite, this.#device.deviceId))) {
      throw entryError("peer_identity_invalid", "The prepared Signal identity is not bound to this exact paired route and device.");
    }
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
    if (!isBinding(answer.account)
      || !isActionTarget(answer.target)
      || answer.target.tenantId !== this.#invite.tenantId
      || answer.target.routeId !== this.#invite.endpointRouteId
      || answer.target.deviceId !== this.#device.deviceId
      || answer.target.devicePublicKey !== this.#device.publicKey) {
      throw entryError("pairing_target_mismatch", "The endpoint challenge did not bind the active account and fresh device key.");
    }
    this.#account = answer.account;
    this.#target = answer.target;
    this.#operationId ??= randomOpaqueId("pair.operation", 24);
    this.#state = "challenge_issued";
    return this.snapshot();
  }

  /** Submit the device-signed proof for the issued challenge. */
  async submitProof(authorization: PairingActionAuthorization): Promise<PairingSessionSnapshot> {
    this.#expectState("challenge_issued", "retry_required");
    const device = this.#device;
    const challengeId = this.#challengeId;
    if (!device || !challengeId) {
      throw entryError("pairing_state_invalid", "No issued challenge is bound to this session.");
    }
    const target = this.#target;
    const account = this.#account;
    if (!target || !account || !this.#operationId
      || authorization.purpose !== "pair_device"
      || !isBinding(authorization.account)
      || canonicalJson(authorization.account) !== canonicalJson(account)
      || canonicalAccountActionTarget(authorization.target) !== canonicalAccountActionTarget(target)
      || !isAccountStepUpPermitId(authorization.permitId)) {
      throw entryError("pairing_authorization_invalid", "A fresh action permit bound to this account, device and endpoint target is required.");
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
      devicePublicKey: device.publicKey,
      entryPeerIdentity: this.#entryPeerIdentity
    }));
    const completion: PairingCompletionRequest = {
      invite: this.#invite,
      challengeId,
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey,
      entryPeerIdentity: this.#entryPeerIdentity,
      signature,
      account,
      permitId: authorization.permitId,
      purpose: "pair_device",
      target,
      operationId: this.#operationId
    };
    // The callback is deliberately before the first endpoint call. Installed
    // Entry uses it to durably place the exact operation in OS custody so a
    // lost response or process restart can replay the same action.
    await this.#beforeComplete?.(completion);
    this.#state = "proof_submitted";
    let answer: unknown;
    try {
      answer = await this.#endpoint.completePairing(completion);
    } catch {
      // Once the checkpoint is saved, any thrown completion transport outcome
      // is unknown. Retry is always the same signed, idempotent operation.
      this.#state = "retry_required";
      return this.snapshot();
    }
    if (isRecord(answer) && answer.outcome === "refused" && typeof answer.refusal === "string") {
      this.#state = "refused";
      this.#refusal = answer.refusal;
      return this.snapshot();
    }
    if (!isRecord(answer) || answer.outcome !== "enrolled"
      || answer.capabilityGrantRef !== target.grantRef
      || !Number.isSafeInteger(answer.admissionGeneration) || Number(answer.admissionGeneration) < 1
      || !Number.isSafeInteger(answer.revocationRevision) || Number(answer.revocationRevision) < 0
      || (this.#entryPeerIdentity === null) !== (answer.endpointPeerIdentity === null)
      || (answer.endpointPeerIdentity !== null
        && !validPeerIdentity(answer.endpointPeerIdentity, routePeerId(this.#invite, this.#invite.endpointDeviceId)))) {
      // A malformed/transport failure outcome is not proof of success.
      this.#state = "retry_required";
      this.#refusal = "The endpoint did not confirm this exact pairing operation; its state remains pending.";
      return this.snapshot();
    }
    const enrolled = answer as unknown as PairingCompletionReceipt;
    const trustBinding = inviteToTrustBinding({
      invite: this.#invite,
      devicePublicKey: device.publicKey,
      deviceFingerprint: device.fingerprint,
      capabilityGrantRef: enrolled.capabilityGrantRef,
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
      capabilityGrantRef: enrolled.capabilityGrantRef,
      admissionGeneration: enrolled.admissionGeneration,
      revocationRevision: enrolled.revocationRevision,
      endpointPeerIdentity: enrolled.endpointPeerIdentity
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

function isBinding(value: unknown): value is AccountAuthorityBinding {
  return Boolean(value && typeof value === "object"
    && typeof (value as AccountAuthorityBinding).accountId === "string"
    && Number.isSafeInteger((value as AccountAuthorityBinding).authEpoch)
    && (value as AccountAuthorityBinding).authEpoch > 0);
}

function isActionTarget(value: unknown): value is AccountActionTarget {
  return Boolean(value && typeof value === "object"
    && typeof (value as AccountActionTarget).tenantId === "string"
    && typeof (value as AccountActionTarget).routeId === "string"
    && typeof (value as AccountActionTarget).deviceId === "string"
    && typeof (value as AccountActionTarget).devicePublicKey === "string"
    && typeof (value as AccountActionTarget).grantRef === "string"
    && Array.isArray((value as AccountActionTarget).scopes)
    && (value as AccountActionTarget).scopes.every((scope) => typeof scope === "string"));
}

function routePeerId(invite: PairingInvite, deviceId: string): string {
  return peerIdForRouteDevice({ tenantId: invite.tenantId, routeId: invite.endpointRouteId, deviceId }) ?? "";
}

function validPeerIdentity(value: unknown, expectedPeerId: string): value is PairingPeerIdentity {
  return isPairingPeerIdentity(value, expectedPeerId);
}

export function createPairingSession(options: ConstructorParameters<typeof PairingSession>[0]): PairingSession {
  return new PairingSession(options);
}
