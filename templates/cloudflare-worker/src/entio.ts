import { validateUpstreamUrl, UpstreamUrlError } from "./ssrf.ts";

// Entio v2 approval protocol — requester side. Formats and the §5.1 check
// order mirror the Entio repo's docs/approval-v2.md and the shared verify
// crate (entio-verify v2::evaluate); see docs/entio-approvals.md.

const textEncoder = new TextEncoder();
const ENTIO_DOMAIN = "entio:v2\0";
const CONCLUSION_CORE_KEYS = ["v", "pair", "request_digest", "expires_at", "decision", "decided_at"] as const;
const MAX_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAIR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class EntioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntioFormatError";
  }
}

function isWellFormedString(value: string): boolean {
  if (typeof (value as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
}

/** RFC 8785 JCS restricted to safe integers — the Entio v2 profile. */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new EntioFormatError("JCS profile admits safe integers only.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!isWellFormedString(value)) {
      throw new EntioFormatError("JCS strings must be well-formed Unicode.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsCanonicalize(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      parts.push(`${jcsCanonicalize(key)}:${jcsCanonicalize(member)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new EntioFormatError("Value is not JCS-canonicalizable.");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64Decode(value: string): Uint8Array | null {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return null;
  }
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function bytesToHexGrouped(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i]!.toString(16).padStart(2, "0");
  return (hex.match(/.{1,8}/gu) ?? []).join(" ");
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function requestDigest(request: unknown): Promise<string> {
  return sha256Base64Url(jcsCanonicalize(request));
}

/** Convert a DER ECDSA signature into the 64-byte IEEE P1363 r‖s form. */
export function derToP1363(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let offset = 1;
  let seqLen = der[offset]!;
  offset += 1;
  if (seqLen === 0x81) {
    if (offset >= der.length) return null;
    seqLen = der[offset]!;
    offset += 1;
  } else if (seqLen > 0x7f) {
    return null;
  }
  if (offset + seqLen !== der.length) return null;
  const readInt = (): Uint8Array | null => {
    if (offset + 2 > der.length || der[offset] !== 0x02) return null;
    const len = der[offset + 1]!;
    offset += 2;
    if (len === 0 || len > 33 || offset + len > der.length) return null;
    const raw = der.slice(offset, offset + len);
    offset += len;
    return len === 33 && raw[0] === 0 ? raw.subarray(1) : raw;
  };
  const r = readInt();
  const s = readInt();
  if (!r || !s || offset !== der.length || r.length > 32 || s.length > 32) return null;
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

function intField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function conclusionCore(conclusion: Record<string, unknown>): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  for (const key of CONCLUSION_CORE_KEYS) {
    if (key in conclusion) core[key] = conclusion[key];
  }
  return core;
}

export type EntioVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "rejected" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Entio approval-v2 §5.1, in order — any failure is `invalid`, matching the
 * shared verify crate's stable reason strings.
 */
export async function evaluateConclusion(
  request: unknown,
  conclusion: unknown,
  verifyAtMs: number,
  pinnedPubkeyB64: string,
): Promise<EntioVerdict> {
  const fail = (reason: string): EntioVerdict => ({ kind: "invalid", reason });
  if (!isPlainRecord(request) || !isPlainRecord(conclusion)) {
    return fail("conclusion is not an object");
  }
  const core = conclusionCore(conclusion);

  if (intField(core, "v") !== 2 || strField(core, "pair") !== strField(request, "pair")) {
    return fail("conclusion does not match this pairing");
  }
  let digest: string;
  try {
    digest = await requestDigest(request);
  } catch {
    return fail("request is not canonicalizable");
  }
  if (strField(core, "request_digest") !== digest) {
    return fail("conclusion digest does not match the request");
  }
  if (intField(core, "expires_at") !== intField(request, "expires_at")) {
    return fail("conclusion expiry does not match the request");
  }
  const expiresAt = intField(core, "expires_at");
  if (expiresAt === null) return fail("missing expiry");
  const decidedAt = intField(core, "decided_at");
  if (decidedAt === null) return fail("missing decided_at");
  if (decidedAt > expiresAt || verifyAtMs > expiresAt) {
    return fail("decision window has closed");
  }
  const pubkeyB64 = strField(conclusion, "pubkey");
  if (pubkeyB64 === null) return fail("missing pubkey");
  const pinned = base64Decode(pinnedPubkeyB64.trim());
  if (!pinned) return fail("pinned key is not base64");
  const presented = base64Decode(pubkeyB64);
  if (!presented) return fail("conclusion pubkey is not base64");
  if (!bytesEqual(presented, pinned)) {
    return fail("conclusion signed by an unpinned device key");
  }
  const sigB64 = strField(conclusion, "signature");
  if (sigB64 === null) return fail("missing signature");
  const sigDer = base64Decode(sigB64);
  if (!sigDer) return fail("signature is not base64");
  const sigRaw = derToP1363(sigDer);
  if (!sigRaw) return fail("signature is not DER");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      presented as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return fail("bad public key");
  }
  let message: string;
  try {
    message = ENTIO_DOMAIN + jcsCanonicalize(core);
  } catch {
    return fail("conclusion is not canonicalizable");
  }
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sigRaw as unknown as BufferSource,
    textEncoder.encode(message) as unknown as BufferSource,
  );
  if (!ok) return fail("signature does not verify");
  const decision = strField(core, "decision");
  if (decision === "approved") return { kind: "approved" };
  if (decision === "rejected") return { kind: "rejected" };
  return fail("decision is not a known value");
}

/** Validate that a base64 x9.63 point is a real P-256 key (import = on-curve check). */
export async function validateApproverPubkey(pubkeyB64: string): Promise<boolean> {
  const bytes = base64Decode(pubkeyB64.trim());
  if (!bytes) return false;
  try {
    await crypto.subtle.importKey(
      "raw",
      bytes as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return true;
  } catch {
    return false;
  }
}

/** Out-of-band fingerprint shown to operators: hex SHA-256 of the x9.63 bytes, grouped in eights. */
export async function pubkeyFingerprint(pubkeyB64: string): Promise<string | null> {
  const bytes = base64Decode(pubkeyB64.trim());
  if (!bytes) return null;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return bytesToHexGrouped(new Uint8Array(digest));
}

export interface EntioPairingInput {
  readonly relay: string;
  readonly pair: string;
  readonly secret: string;
}

export function isPairId(value: string): boolean {
  return PAIR_ID_PATTERN.test(value);
}

/**
 * Parse `entio://pair?i=<uuid>&s=<secret>&r=<encoded relay origin>`.
 * `r` is optional (older codes default relay-side).
 */
export function parsePairCode(code: string): { pair: string; secret: string; relay: string | null } | null {
  let url: URL;
  try {
    url = new URL(code.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "entio:" || url.hostname !== "pair") return null;
  const pair = url.searchParams.get("i") ?? "";
  const secret = url.searchParams.get("s") ?? "";
  const relay = url.searchParams.get("r");
  if (!isPairId(pair) || !secret) return null;
  return { pair, secret, relay };
}

/**
 * A relay base URL: the upstream SSRF rules (https, 443/8443, public host),
 * plus an explicit http:// loopback exception for `wrangler dev` against a
 * local selfhost relay.
 */
export function validateRelayBaseUrl(raw: string): string {
  try {
    const validated = validateUpstreamUrl(raw);
    return validated.origin;
  } catch (error) {
    if (!(error instanceof UpstreamUrlError)) throw error;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new UpstreamUrlError("ssrf_invalid_url", "Relay URL is malformed.");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol === "http:" && loopback && !parsed.username && !parsed.password) {
    return parsed.origin;
  }
  throw new UpstreamUrlError(
    "ssrf_invalid_url",
    "Relay URL must be https on port 443/8443 (or http:// loopback for local dev).",
  );
}

export interface ApprovalRequestParams {
  readonly pair: string;
  readonly instance: string;
  readonly approvalId: string;
  readonly keyId: string;
  readonly keyName: string;
  readonly toolName: string;
  readonly argsSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

/** Build the content-bound Entio v2 request for one pending approval. */
export function buildApprovalRequest(params: ApprovalRequestParams): Record<string, unknown> {
  if (!(params.issuedAt < params.expiresAt) || params.expiresAt - params.issuedAt > MAX_REQUEST_WINDOW_MS) {
    throw new EntioFormatError("Approval window must satisfy issued_at < expires_at <= issued_at + 24h.");
  }
  return {
    v: 2,
    type: "approval",
    source: { system: "meshrix-gateway", instance: params.instance.slice(0, 64) },
    pair: params.pair,
    nonce: params.nonce,
    issued_at: params.issuedAt,
    expires_at: params.expiresAt,
    summary: `Approve MCP call ${params.toolName} via key ${params.keyName}`.slice(0, 200),
    fields: {
      action: "mcp.tools/call",
      target: params.toolName,
      key: params.keyName,
      key_id: params.keyId,
      args_sha256: params.argsSha256,
      approval: params.approvalId,
      gateway: params.instance.slice(0, 64),
    },
  };
}

