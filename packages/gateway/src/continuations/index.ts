import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ContinuationCodec, ContinuationPayload } from "@meshrix/contracts/gateway";
import { canonicalJson, cloneJson, deepFreeze, digest, nonEmptyText } from "../utils.ts";

const TOKEN_VERSION = "mxcs1";
const ALGORITHM = "aes-256-gcm";
const DEFAULT_TTL_MS = 5 * 60_000;

export interface ContinuationCodecOptions {
  readonly key: Uint8Array | string;
  readonly previousKeys?: readonly (Uint8Array | string)[];
  readonly keyRevision?: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

type TokenState = "executing" | "consumed" | "outcome_unknown";

function normalizeKey(input: Uint8Array | string): Buffer {
  const key = typeof input === "string" ? Buffer.from(input, "base64url") : Buffer.from(input);
  if (key.byteLength !== 32) throw new TypeError("Continuation key must be exactly 32 bytes.");
  return key;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function continuationError(code: string, message: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

function validatePayload(value: unknown, now: number): ContinuationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw continuationError("continuation_invalid", "Continuation payload is invalid.");
  const payload = value as Record<string, unknown>;
  const requiredStrings = ["tenant", "principal", "grantRevision", "routeRef", "endpointIdentity", "routeRevision", "method", "paramsDigest"] as const;
  for (const key of requiredStrings) nonEmptyText(payload[key], `continuation.${key}`);
  if (!Number.isSafeInteger(payload.generation) || Number(payload.generation) < 1) throw continuationError("continuation_invalid", "Continuation generation is invalid.");
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || Number(payload.expiresAt) <= Number(payload.issuedAt)) throw continuationError("continuation_invalid", "Continuation lifetime is invalid.");
  if (Number(payload.expiresAt) <= now) throw continuationError("continuation_expired", "Continuation has expired.", 410);
  const upstream = payload.upstreamState;
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream) || typeof (upstream as Record<string, unknown>).present !== "boolean") throw continuationError("continuation_invalid", "Continuation upstream state marker is invalid.");
  if ((upstream as Record<string, unknown>).present && typeof (upstream as Record<string, unknown>).value !== "string") throw continuationError("continuation_invalid", "Continuation upstream state is invalid.");
  return deepFreeze(cloneJson(payload) as unknown as ContinuationPayload);
}

export class EncryptedContinuationCodec implements ContinuationCodec {
  readonly #currentKey: Buffer;
  readonly #previousKeys: readonly Buffer[];
  readonly #keyRevision: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #states = new Map<string, TokenState>();

  constructor(options: ContinuationCodecOptions) {
    this.#currentKey = normalizeKey(options.key);
    this.#previousKeys = Object.freeze((options.previousKeys ?? []).map(normalizeKey));
    this.#keyRevision = nonEmptyText(options.keyRevision ?? "k1", "keyRevision");
    this.#ttlMs = Math.min(60 * 60_000, Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS)));
    this.#now = options.now ?? Date.now;
  }

  seal(payload: ContinuationPayload): string {
    const now = this.#now();
    const normalized = validatePayload({
      ...payload,
      issuedAt: payload.issuedAt || now,
      expiresAt: Math.min(payload.expiresAt || now + this.#ttlMs, now + this.#ttlMs)
    }, now - 1);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#currentKey, iv);
    const header = `${TOKEN_VERSION}.${this.#keyRevision}`;
    cipher.setAAD(Buffer.from(header, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(normalized), "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [header, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  open(state: string, now = this.#now()): ContinuationPayload {
    if (typeof state !== "string" || state.split(".").length !== 5) throw continuationError("continuation_invalid", "Continuation state is invalid.");
    const [version, revision, ivText, tagText, ciphertextText] = state.split(".");
    if (version !== TOKEN_VERSION || revision !== this.#keyRevision && !this.#previousKeys.length) throw continuationError("continuation_invalid", "Continuation version or key revision is invalid.");
    let plaintext: Buffer | undefined;
    const keys = revision === this.#keyRevision ? [this.#currentKey, ...this.#previousKeys] : this.#previousKeys;
    for (const key of keys) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivText, "base64url"));
        decipher.setAuthTag(Buffer.from(tagText, "base64url"));
        decipher.setAAD(Buffer.from(`${version}.${revision}`, "utf8"));
        plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
        break;
      } catch {
        plaintext = undefined;
      }
    }
    if (!plaintext) throw continuationError("continuation_invalid", "Continuation authentication failed.");
    let payload: unknown;
    try {
      payload = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw continuationError("continuation_invalid", "Continuation payload cannot be decoded.");
    }
    const normalized = validatePayload(payload, now);
    const id = tokenDigest(state);
    if (normalized.oneTime) {
      const current = this.#states.get(id);
      if (current) throw continuationError(current === "outcome_unknown" ? "continuation_outcome_unknown" : "continuation_replayed", "Continuation has already been claimed.");
      this.#states.set(id, "executing");
    }
    return normalized;
  }

  settle(state: string, outcome: "consumed" | "outcome_unknown"): void {
    const id = tokenDigest(state);
    if (!this.#states.has(id)) throw continuationError("continuation_unknown", "Continuation has not been claimed.");
    this.#states.set(id, outcome);
  }

  state(state: string): TokenState | undefined {
    return this.#states.get(tokenDigest(state));
  }

  release(state: string): void {
    const id = tokenDigest(state);
    if (this.#states.get(id) === "executing") this.#states.delete(id);
  }
}

export function createContinuationCodec(options: ContinuationCodecOptions): EncryptedContinuationCodec {
  return new EncryptedContinuationCodec(options);
}

export function continuationParamsDigest(params: unknown): string {
  return digest(params);
}
