/**
 * Recovery-only bootstrap: fresh-device enrollment under current endpoint
 * authority.
 *
 * Runs strictly before normal mutual-TLS/routing enrollment and never on a
 * forwarding session — the only wire purpose here is `recover_device`. Flow:
 *
 *   recovery text → derived material → vault fetch + decrypt (snapshot-sync)
 *   → fresh Ed25519 device key into custody → recovery-request →
 *   endpoint-issued challenge → typed proof signed by the *fresh device key*
 *   → recovery-result → device admission requiring mutual-TLS rebind.
 *
 * The endpoint verifies the proof against `freshDevicePublicKey` (see the
 * endpoint recovery service): recovery-root possession is proven earlier at
 * the vault layer by the fetch proof + decryption, and the challenge binds
 * the exact fresh key that must sign. Recovery never restores an old device
 * key, session key, grant or credential — the outcome is a fresh admission.
 */
import {
  assertRecoveryPurposeSeparation,
  createRecoveryProof,
  createRecoveryRequest,
  parseRecoveryChallenge,
  parseRecoveryResult
} from "@meshrix/contracts/private-relay";
import { entryError } from "../errors.ts";
import { signEd25519, type Ed25519Keypair } from "../keys.ts";
import { recoveryProofTranscript } from "../transcripts.ts";
import type { CustodyAdapter } from "../identity/custody.ts";
import {
  enrollDeviceIdentity,
  loadDevicePrivateKey,
  type DeviceIdentity
} from "../identity/device-identity.ts";
import type { RecoveryMaterial } from "./recovery-crypto.ts";
import type { BundleConnection, EntryRecoveryBundle } from "./bundle.ts";

/**
 * Narrow endpoint port for the recovery channel. The real transport is the
 * entry relay session opened with `purpose: "recover_device"`; tests drive a
 * direct peer against the endpoint recovery service. `roundTrip` returns the
 * raw wire response — undefined when the endpoint stayed silent.
 */
export interface RecoveryEndpointPort {
  roundTrip(input: {
    readonly endpointRouteId: string;
    readonly message: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface RecoveryBootstrapInput {
  readonly material: RecoveryMaterial;
  /** The decrypted bundle for the target connection (already fetched). */
  readonly bundle: EntryRecoveryBundle;
  /** Connection to recover — selects endpointRouteId and expected authority. */
  readonly connection: BundleConnection;
  readonly custody: CustodyAdapter;
  /** Fresh device id; defaults to a generated `dev.entry.*` opaque id. */
  readonly deviceId?: string;
}

export type RecoveryBootstrapOutcome =
  | {
      readonly outcome: "enrolled";
      readonly device: DeviceIdentity;
      readonly admission: {
        readonly deviceId: string;
        readonly admissionGeneration: number;
        readonly requiresMutualTlsRebind: true;
      };
      readonly generation: number;
      readonly principalRef: string;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: string;
    };

/** Clock-skew bound for challenge expiry checks (client side). */
const CHALLENGE_EXPIRY_GRACE_MS = 5_000;

export class EntryRecoverySession {
  readonly #endpoint: RecoveryEndpointPort;
  readonly #now: () => number;

  constructor(options: {
    endpoint: RecoveryEndpointPort;
    now?: () => number;
  }) {
    this.#endpoint = options.endpoint;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Run the recovery bootstrap for one connection. Throws typed EntryErrors
   * for local/validation failures; endpoint refusals return a typed outcome.
   */
  async recover(input: RecoveryBootstrapInput): Promise<RecoveryBootstrapOutcome> {
    const connection = input.connection;
    const device = await enrollDeviceIdentity({
      custody: input.custody,
      deviceId: input.deviceId
    });

    const request = createRecoveryRequest({
      endpointRouteId: connection.routeId,
      freshDeviceId: device.deviceId,
      freshDevicePublicKey: device.publicKey
    });
    const challengeRaw = await this.#endpoint.roundTrip({
      endpointRouteId: connection.routeId,
      message: request
    });
    const challenge = parseRecoveryChallenge(challengeRaw);
    if (!challenge) {
      if (challengeRaw === undefined || challengeRaw === null) {
        throw entryError(
          "endpoint_unreachable",
          `Endpoint ${connection.routeId} did not answer the recovery request.`
        );
      }
      throw entryError(
        "endpoint_unexpected_response",
        "Endpoint returned a message that is not a valid recovery-challenge."
      );
    }
    assertRecoveryPurposeSeparation(challenge.purpose, "recover_device");
    if (challenge.endpointRouteId !== connection.routeId) {
      throw entryError(
        "endpoint_refused",
        "Recovery challenge answered by a different endpoint route than requested."
      );
    }
    if (challenge.freshDevicePublicKey !== device.publicKey) {
      throw entryError(
        "endpoint_refused",
        "Recovery challenge does not bind this fresh device key."
      );
    }
    if (challenge.principalRef !== connection.principalRef) {
      throw entryError(
        "endpoint_refused",
        "Recovery challenge principal does not match the paired endpoint principal."
      );
    }
    const expectedGeneration = connection.recoveryAuthority?.generation ?? 1;
    if (challenge.generation < expectedGeneration) {
      throw entryError(
        "endpoint_refused",
        `Recovery challenge generation ${challenge.generation} is older than the known authority generation ${expectedGeneration}.`
      );
    }
    const expiresAt = Date.parse(challenge.expiresAt);
    const issuedAt = Date.parse(challenge.issuedAt);
    const now = this.#now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now - CHALLENGE_EXPIRY_GRACE_MS) {
      throw entryError("endpoint_refused", "Recovery challenge arrived already expired.");
    }
    if (!Number.isFinite(issuedAt) || expiresAt <= issuedAt) {
      throw entryError("endpoint_unexpected_response", "Recovery challenge has inconsistent timestamps.");
    }

    const deviceKey = await loadDevicePrivateKey({
      custody: input.custody,
      deviceId: device.deviceId
    });
    if (!deviceKey) {
      throw entryError("custody_unavailable", "Fresh device key could not be loaded from custody.");
    }
    const transcript = recoveryProofTranscript({
      challengeId: String(challenge.challengeId),
      endpointRouteId: String(challenge.endpointRouteId),
      principalRef: String(challenge.principalRef),
      generation: Number(challenge.generation),
      freshDeviceId: device.deviceId,
      freshDevicePublicKey: device.publicKey
    });
    const proof = createRecoveryProof({
      challengeId: challenge.challengeId,
      endpointRouteId: challenge.endpointRouteId,
      principalRef: challenge.principalRef,
      generation: challenge.generation,
      freshDeviceId: device.deviceId,
      freshDevicePublicKey: device.publicKey,
      signature: signEd25519(deviceKey, transcript)
    });
    const resultRaw = await this.#endpoint.roundTrip({
      endpointRouteId: connection.routeId,
      message: proof
    });
    const result = parseRecoveryResult(resultRaw);
    if (!result) {
      throw entryError(
        "endpoint_unexpected_response",
        "Endpoint returned a message that is not a valid recovery-result."
      );
    }
    if (result.challengeId !== challenge.challengeId) {
      throw entryError(
        "endpoint_unexpected_response",
        "Recovery result answered a different challenge."
      );
    }
    if (result.outcome === "refused") {
      return { outcome: "refused", refusal: String(result.refusal) };
    }
    const admission = result.deviceAdmission;
    if (!admission) {
      throw entryError(
        "endpoint_unexpected_response",
        "An enrolled recovery result must carry a device admission."
      );
    }
    if (admission.deviceId !== device.deviceId) {
      throw entryError(
        "endpoint_unexpected_response",
        "Recovery admission names a different device than enrolled."
      );
    }
    return {
      outcome: "enrolled",
      device,
      admission: {
        deviceId: String(admission.deviceId),
        admissionGeneration: Number(admission.admissionGeneration),
        requiresMutualTlsRebind: true
      },
      generation: Number(challenge.generation),
      principalRef: String(challenge.principalRef)
    };
  }
}

export function createEntryRecoverySession(options: ConstructorParameters<typeof EntryRecoverySession>[0]): EntryRecoverySession {
  return new EntryRecoverySession(options);
}
