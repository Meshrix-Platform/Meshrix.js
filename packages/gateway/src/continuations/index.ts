import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
  /** Persistent profiles supply an atomic store; an in-memory store must not reuse a key across restarts. */
  readonly ledger?: ContinuationLedger;
}

type TokenState = "executing" | "consumed" | "outcome_unknown";

export interface ContinuationLedger {
  claim(id: string, expiresAt: number): void | Promise<void>;
  settle(id: string, outcome: "consumed" | "outcome_unknown"): void | Promise<void>;
  release(id: string): void | Promise<void>;
  state?(id: string): TokenState | undefined;
}

function normalizeKey(input: Uint8Array | string): Buffer {
  const key = typeof input === "string" ? Buffer.from(input, "base64url") : Buffer.from(input);
  if (key.byteLength !== 32) throw new TypeError("Continuation key must be exactly 32 bytes.");
  return key;
}

function canonicalSegment(value: string, maxLength: number): Buffer {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9_-]+$/u.test(value)) throw continuationError("continuation_invalid", "Continuation encoding is not canonical.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw continuationError("continuation_invalid", "Continuation encoding is not canonical.");
  return bytes;
}

function continuationError(code: string, message: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

function validatePayload(value: unknown, now: number): ContinuationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw continuationError("continuation_invalid", "Continuation payload is invalid.");
  const payload = value as Record<string, unknown>;
  nonEmptyText(payload.tokenId, "continuation.tokenId");
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
  readonly #states = new Map<string, { state: TokenState; expiresAt: number }>();
  readonly #ledger?: ContinuationLedger;
  readonly #epoch = randomBytes(16).toString("base64url");

  constructor(options: ContinuationCodecOptions) {
    this.#currentKey = normalizeKey(options.key);
    this.#previousKeys = Object.freeze((options.previousKeys ?? []).map(normalizeKey));
    this.#keyRevision = nonEmptyText(options.keyRevision ?? "k1", "keyRevision");
    this.#ttlMs = Math.min(60 * 60_000, Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS)));
    this.#now = options.now ?? Date.now;
    this.#ledger = options.ledger;
  }

  seal(payload: ContinuationPayload): string {
    const now = this.#now();
    const normalized = validatePayload({
      ...payload,
      tokenId: payload.tokenId ?? randomBytes(24).toString("base64url"),
      ...(payload.oneTime && !this.#ledger ? { issuerEpoch: this.#epoch } : {}),
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
    return this.#decode(state, now, false);
  }

  #decode(state: string, now: number, allowExpired: boolean): ContinuationPayload {
    if (typeof state !== "string" || state.length > 16_384 || state.split(".").length !== 5) throw continuationError("continuation_invalid", "Continuation state is invalid.");
    const [version, revision, ivText, tagText, ciphertextText] = state.split(".");
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(revision)) throw continuationError("continuation_invalid", "Continuation key revision is invalid.");
    const iv = canonicalSegment(ivText, 16);
    const tag = canonicalSegment(tagText, 22);
    const ciphertext = canonicalSegment(ciphertextText, 16_384);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw continuationError("continuation_invalid", "Continuation cipher dimensions are invalid.");
    if (version !== TOKEN_VERSION || revision !== this.#keyRevision && !this.#previousKeys.length) throw continuationError("continuation_invalid", "Continuation version or key revision is invalid.");
    let plaintext: Buffer | undefined;
    const keys = revision === this.#keyRevision ? [this.#currentKey, ...this.#previousKeys] : this.#previousKeys;
    for (const key of keys) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        decipher.setAAD(Buffer.from(`${version}.${revision}`, "utf8"));
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
    const issuedAt = payload && typeof payload === "object" && "issuedAt" in payload && typeof payload.issuedAt === "number" ? payload.issuedAt : now;
    const normalized = validatePayload(payload, allowExpired ? issuedAt - 1 : now);
    if (normalized.oneTime && !this.#ledger && normalized.issuerEpoch !== this.#epoch) throw continuationError("continuation_epoch_expired", "One-time continuation belongs to a previous process.");
    return normalized;
  }

  async claim(state: string, payload: ContinuationPayload): Promise<void> {
    if (!payload.oneTime) return;
    const id = nonEmptyText(payload.tokenId, "continuation.tokenId");
    if (this.#ledger) return this.#ledger.claim(id, payload.expiresAt);
    for (const [key, entry] of this.#states) if (entry.expiresAt <= this.#now()) this.#states.delete(key);
    const current = this.#states.get(id);
    if (current) throw continuationError(current.state === "outcome_unknown" ? "continuation_outcome_unknown" : current.state === "executing" ? "continuation_in_progress" : "continuation_replayed", "Continuation has already been claimed.");
    if (this.#states.size >= 10_000) throw continuationError("continuation_capacity", "Continuation ledger is full.", 503);
    this.#states.set(id, { state: "executing", expiresAt: payload.expiresAt });
  }

  async settle(state: string, outcome: "consumed" | "outcome_unknown"): Promise<void> {
    const id = this.#decode(state, this.#now(), true).tokenId!;
    if (this.#ledger) return this.#ledger.settle(id, outcome);
    const current = this.#states.get(id);
    if (!current) return;
    this.#states.set(id, { ...current, state: outcome });
  }

  state(state: string): TokenState | undefined {
    const id = this.#decode(state, this.#now(), true).tokenId!;
    return this.#ledger?.state?.(id) ?? this.#states.get(id)?.state;
  }

  async release(state: string): Promise<void> {
    const id = this.#decode(state, this.#now(), true).tokenId!;
    if (this.#ledger) return this.#ledger.release(id);
    if (this.#states.get(id)?.state === "executing") this.#states.delete(id);
  }
}

export function createContinuationCodec(options: ContinuationCodecOptions): EncryptedContinuationCodec {
  return new EncryptedContinuationCodec(options);
}

export function continuationParamsDigest(params: unknown): string {
  return digest(params);
}
