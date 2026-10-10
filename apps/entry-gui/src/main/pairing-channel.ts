/**
 * Production pairing channel — the narrow HTTPS binding of the
 * `PairingEndpointPort` contract.
 *
 * The endpoint product's admin surface owns invite issuance; pairing runs as
 * two bounded JSON exchanges against that surface:
 *
 *   POST {base}/pairing/begin     {kind:"entry-pairing-begin",    invite, deviceId, devicePublicKey}
 *       → {outcome:"challenge", challengeId, nonce, expiresAt} | {outcome:"refused", refusal}
 *   POST {base}/pairing/complete  {kind:"entry-pairing-complete", invite, challengeId,
 *                                  deviceId, devicePublicKey, capabilityGrantRef, signature}
 *       → {outcome:"enrolled", capabilityGrantRef, relayCredential?, admissionGeneration?,
 *          revocationRevision?} | {outcome:"refused", refusal}
 *   POST {base}/pairing/revoke    {kind:"entry-pairing-revoke",   deviceId}
 *       → {revoked: boolean}   (best-effort remote enforcement)
 *
 * The invite's one-time `pairingToken` travels inside the invite body — it is
 * the bearer proof that authorizes enrollment on the endpoint's side.
 * `enrollmentExtras()` exposes the post-enrollment material the port's fixed
 * return type cannot carry (relay credential, relay counters); it is never
 * part of the redacted GUI snapshot.
 */
import { entryError, type PairingEndpointPort, type PairingInvite } from "@meshrix/entry";

export interface PairingEnrollmentExtras {
  readonly relayCredential: string | null;
  readonly admissionGeneration: number | null;
  readonly revocationRevision: number | null;
}

const PAIRING_MAX_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HttpPairingChannel implements PairingEndpointPort {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  #extras: PairingEnrollmentExtras = {
    relayCredential: null,
    admissionGeneration: null,
    revocationRevision: null
  };

  constructor(options: {
    readonly baseUrl: string;
    readonly fetchImpl?: typeof fetch;
  }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw entryError(
        "pairing_invite_invalid",
        "The pairing surface must be HTTPS (loopback HTTP is allowed for local fixtures only)."
      );
    }
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Extras captured from the last enrolled response — non-state, main-process only. */
  enrollmentExtras(): PairingEnrollmentExtras {
    return this.#extras;
  }

  async beginPairing(input: {
    readonly invite: PairingInvite;
    readonly deviceId: string;
    readonly devicePublicKey: string;
  }) {
    const body = await this.#post("/pairing/begin", {
      schemaVersion: "v0.0.1:entry:pairing-exchange-1",
      kind: "entry-pairing-begin",
      invite: input.invite,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey
    });
    if (isRecord(body) && body.outcome === "challenge"
      && typeof body.challengeId === "string"
      && typeof body.nonce === "string"
      && typeof body.expiresAt === "string") {
      return {
        outcome: "challenge" as const,
        challengeId: body.challengeId,
        nonce: body.nonce,
        expiresAt: body.expiresAt
      };
    }
    if (isRecord(body) && body.outcome === "refused" && typeof body.refusal === "string") {
      return { outcome: "refused" as const, refusal: body.refusal };
    }
    throw entryError("endpoint_unexpected_response", "The pairing surface returned an unexpected begin response.");
  }

  async completePairing(input: {
    readonly invite: PairingInvite;
    readonly challengeId: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly capabilityGrantRef: string;
    readonly signature: string;
  }) {
    const body = await this.#post("/pairing/complete", {
      schemaVersion: "v0.0.1:entry:pairing-exchange-1",
      kind: "entry-pairing-complete",
      invite: input.invite,
      challengeId: input.challengeId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      capabilityGrantRef: input.capabilityGrantRef,
      signature: input.signature
    });
    if (isRecord(body) && body.outcome === "enrolled" && typeof body.capabilityGrantRef === "string") {
      this.#extras = {
        relayCredential: typeof body.relayCredential === "string" ? body.relayCredential : null,
        admissionGeneration: Number.isSafeInteger(body.admissionGeneration) ? Number(body.admissionGeneration) : null,
        revocationRevision: Number.isSafeInteger(body.revocationRevision) ? Number(body.revocationRevision) : null
      };
      return { outcome: "enrolled" as const, capabilityGrantRef: body.capabilityGrantRef };
    }
    if (isRecord(body) && body.outcome === "refused" && typeof body.refusal === "string") {
      return { outcome: "refused" as const, refusal: body.refusal };
    }
    throw entryError("endpoint_unexpected_response", "The pairing surface returned an unexpected complete response.");
  }

  /** Best-effort remote revocation report; throws endpoint_unreachable on transport failure. */
  async revokeDevice(input: { readonly deviceId: string }): Promise<{ readonly revoked: boolean }> {
    const body = await this.#post("/pairing/revoke", {
      schemaVersion: "v0.0.1:entry:pairing-exchange-1",
      kind: "entry-pairing-revoke",
      deviceId: input.deviceId
    });
    return { revoked: isRecord(body) && body.revoked === true };
  }

  /**
   * One POST with a bounded response budget. There is no local response deadline — the request
   * settles on the endpoint's reply, on a real transport failure, or on the
   * runtime's own connection teardown — so a slow but healthy pairing surface
   * is never misreported as unreachable and the user's retry never collides
   * with a duplicate enrollment this process already abandoned.
   */
  async #post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error"
      });
      const text = await readPairingResponseText(response);
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (!response.ok) {
        if (isRecord(body) && body.outcome === "refused") return body;
        throw entryError(
          response.status >= 500 ? "endpoint_unreachable" : "endpoint_refused",
          `Pairing surface answered HTTP ${response.status}.`
        );
      }
      return body;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code: string }).code.startsWith("endpoint_")) {
        throw error;
      }
      throw entryError(
        "endpoint_unreachable",
        `Pairing surface unreachable: ${(error as Error).message}`
      );
    }
  }
}

/**
 * Read a pairing response bounded to the byte budget while it streams — a
 * misconfigured or hostile pairing surface must not grow this process's
 * memory by sending an unbounded body that is only rejected after buffering.
 */
async function readPairingResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PAIRING_MAX_BODY_BYTES) {
    throw entryError("endpoint_unexpected_response", "Pairing surface response exceeded the byte budget.");
  }
  const stream = response.body;
  if (!stream) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > PAIRING_MAX_BODY_BYTES) {
      throw entryError("endpoint_unexpected_response", "Pairing surface response exceeded the byte budget.");
    }
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PAIRING_MAX_BODY_BYTES) {
        void reader.cancel();
        throw entryError("endpoint_unexpected_response", "Pairing surface response exceeded the byte budget.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createHttpPairingChannel(options: ConstructorParameters<typeof HttpPairingChannel>[0]): HttpPairingChannel {
  return new HttpPairingChannel(options);
}
