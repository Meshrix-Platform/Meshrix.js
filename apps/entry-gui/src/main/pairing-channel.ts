/**
 * Legacy endpoint maintenance channel. Device enrollment itself is exclusively
 * performed over the restricted relay + pinned inner-TLS channel in
 * `EntryPairingRelayChannel`; this adapter exposes only remote revoke.
 */
import { entryError } from "@meshrix/entry";

const PAIRING_MAX_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HttpPairingChannel {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

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
