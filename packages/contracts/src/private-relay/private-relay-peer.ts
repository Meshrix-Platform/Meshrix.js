/**
 * Private relay Peer wire contract for authenticated online forwarding.
 *
 * The relay may forward ciphertext only while both devices are reachable. It
 * never stores business envelopes, delivery receipts, application state or
 * task results. Clients keep their own durable send and receive records.
 */
export const PRIVATE_RELAY_PEER_SCHEMA_VERSION = "v0.0.1:private-relay:peer-1";

const PRIVATE_RELAY_PEER_WIRE_PROTOCOL = "meshrix-private-relay/0";

export const PRIVATE_RELAY_PEER_KINDS = Object.freeze([
  "peer-bundle-publish",
  "peer-bundle-published",
  "peer-bundle-fetch",
  "peer-bundle",
  "peer-presence",
  "peer-send",
  "peer-forwarded",
  "peer-delivery-ack"
]);
export const PRIVATE_RELAY_PEER_SIGNAL_PROFILES = Object.freeze([
  "signal-x3dh",
  "signal-pqxdh"
]);
export const PRIVATE_RELAY_PEER_MESSAGE_TYPES = Object.freeze([
  "prekey",
  "session"
]);
export const PRIVATE_RELAY_PEER_BUNDLE_PUBLISH_OUTCOMES = Object.freeze([
  "published",
  "superseded",
  "refused"
]);
export const PRIVATE_RELAY_PEER_BUNDLE_STATES = Object.freeze([
  "available",
  "unpublished",
  "refused"
]);
export const PRIVATE_RELAY_PEER_REFUSALS = Object.freeze([
  "peer_unpaired",
  "revoked",
  "stale_revision",
  "rate_limited",
  "authority_stale"
]);
export const PRIVATE_RELAY_PEER_FORWARD_OUTCOMES = Object.freeze([
  "forwarded",
  "endpoint_unreachable",
  "backpressured",
  "refused"
]);
export const PRIVATE_RELAY_PEER_FORWARD_REQUEST_KINDS = Object.freeze([
  "peer-send",
  "peer-delivery-ack"
] as const);
export const PRIVATE_RELAY_PEER_FORWARD_REFUSALS = Object.freeze([
  "peer_unpaired",
  "revoked",
  "rate_limited",
  "authority_stale"
]);
export const PRIVATE_RELAY_PEER_PRESENCE_STATES = Object.freeze(["reachable", "unreachable"] as const);
export const PRIVATE_RELAY_PEER_DELIVERY_ACK_DOMAIN = "meshrix-peer-delivery-ack-v1";
export const PRIVATE_RELAY_PEER_RELAY_SEES_PLAINTEXT = false;

export const PRIVATE_RELAY_PEER_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxEnvelopeBytes: 65_536,
  maxBundleBytes: 65_536,
  maxSignatureBytes: 64
});

export const PRIVATE_RELAY_PEER_FORBIDDEN_KEYS = Object.freeze([
  "apiKey",
  "arguments",
  "authorization",
  "body",
  "callbackUrl",
  "catalog",
  "catalogName",
  "content",
  "credential",
  "credentials",
  "execute",
  "grant",
  "grantId",
  "grants",
  "instructions",
  "message",
  "payload",
  "plaintext",
  "principal",
  "privateKey",
  "prompt",
  "result",
  "scope",
  "scopes",
  "secret",
  "serviceLocation",
  "task",
  "toolName",
  "token",
  "tool",
  "upstream",
  "upstreamHost"
]);

const FAIL = Symbol("private-relay-peer-fail");
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CIPHERTEXT_DIGEST_PATTERN = /^sha256:([A-Za-z0-9_-]{43})$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;
type PeerParser = (value?: unknown) => Readonly<UnknownRecord> | null;

/** Route identity used to derive the paired Signal peer identity. */
export interface PeerRouteIdentityTuple {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
}

/**
 * Deterministic peer identity for a relay route device.
 *
 * Replace `:` inside each tuple component with `~` before joining. The tilde
 * is excluded from the opaque component alphabet, so separators remain
 * unambiguous and safe tuples keep their existing spelling.
 */
export function peerIdForRouteDevice(scope: PeerRouteIdentityTuple): string | null {
  const parts = [scope.tenantId, scope.routeId, scope.deviceId];
  if (parts.some((part) => typeof part !== "string" || !OPAQUE_ID_PATTERN.test(part))) return null;
  const peerId = `peer:${parts.map((part) => part.replace(/:/gu, "~")).join(":")}`;
  return peerId.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(peerId) ? peerId : null;
}

export type PeerEnvelope = NonNullable<ReturnType<typeof parsePeerEnvelope>>;
export type PrekeyBundlePublication = NonNullable<ReturnType<typeof parsePrekeyBundlePublication>>;
export type PeerSend = NonNullable<ReturnType<typeof parsePeerSend>>;
export type PeerForwarded = NonNullable<ReturnType<typeof parsePeerForwarded>>;
export type PeerPresence = NonNullable<ReturnType<typeof parsePeerPresence>>;
export type PeerDeliveryAck = NonNullable<ReturnType<typeof parsePeerDeliveryAck>>;
export type PeerDeliveryAckSigningInput = NonNullable<ReturnType<typeof parsePeerDeliveryAckSigningInput>>;
export type PeerMessageIdentity = Pick<PeerDeliveryAckSigningInput,
  "tenantId" | "routeId" | "senderDeviceId" | "recipientDeviceId" | "messageId">;

const KIND_PARSERS: Record<string, PeerParser> = Object.create(null);

function isPlainObject(value?: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is UnknownRecord {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function boundedText(value: unknown, maxBytes: number = PRIVATE_RELAY_PEER_LIMITS.maxOpaqueIdBytes): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : FAIL;
}

function positiveRevision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = PRIVATE_RELAY_PEER_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function canonicalBase64url(value: unknown, expectedBytes: number, maxBytes: number): string | typeof FAIL {
  const normalized = boundedText(value, Math.ceil(maxBytes * 4 / 3) + 4);
  if (!normalized || !BASE64URL_PATTERN.test(normalized) || normalized.length % 4 === 1) return FAIL;
  const bytes = Buffer.from(normalized, "base64url");
  return bytes.length === expectedBytes && bytes.length <= maxBytes && bytes.toString("base64url") === normalized
    ? normalized
    : FAIL;
}

function opaqueBytes(value: unknown, maxBytes: number): string | typeof FAIL {
  const normalized = boundedText(value, Math.ceil(maxBytes * 4 / 3) + 4);
  if (!normalized || !BASE64URL_PATTERN.test(normalized) || normalized.length % 4 === 1) return FAIL;
  const bytes = Buffer.from(normalized, "base64url");
  return bytes.length > 0 && bytes.length <= maxBytes && bytes.toString("base64url") === normalized
    ? normalized
    : FAIL;
}

function ciphertextDigest(value: unknown): string | typeof FAIL {
  const normalized = boundedText(value, 64);
  const match = CIPHERTEXT_DIGEST_PATTERN.exec(normalized);
  if (!match || canonicalBase64url(match[1], 32, 32) === FAIL) return FAIL;
  return normalized;
}

function opaqueSignature(value: unknown): string | typeof FAIL {
  return canonicalBase64url(value, PRIVATE_RELAY_PEER_LIMITS.maxSignatureBytes, PRIVATE_RELAY_PEER_LIMITS.maxSignatureBytes);
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenPeerKeys(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const parsed = spec[key](value[key], value);
    if (parsed === FAIL) return null;
    output[key] = parsed;
  }
  return Object.freeze(output) as ParsedSpec<T>;
}

function created<T>(parseFn: (value: unknown) => T | null, value: unknown, message: string): T {
  const parsed = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function envelope(kind: string, extras: Record<string, unknown> = {}): UnknownRecord {
  return {
    schemaVersion: PRIVATE_RELAY_PEER_SCHEMA_VERSION,
    wireProtocol: PRIVATE_RELAY_PEER_WIRE_PROTOCOL,
    kind,
    ...extras
  };
}

function commonRemote<T extends ParserSpec>(kind: string, extra: T) {
  return {
    schemaVersion: (entry: unknown) => entry === PRIVATE_RELAY_PEER_SCHEMA_VERSION ? entry : FAIL,
    wireProtocol: (entry: unknown) => entry === PRIVATE_RELAY_PEER_WIRE_PROTOCOL ? entry : FAIL,
    kind: (entry: unknown) => entry === kind ? entry : FAIL,
    ...extra
  };
}

export function containsForbiddenPeerKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => PRIVATE_RELAY_PEER_FORBIDDEN_KEYS.includes(key))) return true;
  return Object.values(value).some((entry) => containsForbiddenPeerKeys(entry, seen));
}

function parseArray<T>(
  value: unknown,
  parseItem: (value: unknown) => T | typeof FAIL | null,
  max: number,
  allowEmpty: boolean = true
): readonly T[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return FAIL;
  const items: T[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === FAIL || item == null) return FAIL;
    items.push(item);
  }
  return Object.freeze(items);
}

export function parsePeerEnvelopeHeaders(value?: unknown) {
  return parseObject(value, {
    messageType: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_MESSAGE_TYPES),
    senderBundleId: (entry) => opaqueId(entry),
    recipientBundleId: (entry) => opaqueId(entry),
    prekeyId: (entry) => entry === null ? null : opaqueId(entry),
    signedPrekeyId: (entry) => entry === null ? null : opaqueId(entry),
    baseKeyId: (entry) => entry === null ? null : opaqueId(entry)
  });
}

export function parsePeerEnvelope(value?: unknown) {
  return parseObject(value, {
    format: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_SIGNAL_PROFILES),
    headers: (entry) => parsePeerEnvelopeHeaders(entry) || FAIL,
    ciphertext: (entry) => opaqueBytes(entry, PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes)
  });
}

export function parsePrekeyBundlePublication(value?: unknown) {
  return parseObject(value, {
    format: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_SIGNAL_PROFILES),
    bundleId: (entry) => opaqueId(entry),
    revision: positiveRevision,
    material: (entry) => opaqueBytes(entry, PRIVATE_RELAY_PEER_LIMITS.maxBundleBytes)
  });
}

export function parsePeerSend(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-send", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    senderDeviceId: (entry) => opaqueId(entry),
    recipientDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    envelope: (entry) => parsePeerEnvelope(entry) || FAIL
  }));
  if (!parsed || parsed.senderDeviceId === parsed.recipientDeviceId) return null;
  return parsed;
}

export function parsePeerForwarded(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-forwarded", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    requestKind: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_FORWARD_REQUEST_KINDS),
    sourceDeviceId: (entry) => opaqueId(entry),
    targetDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_FORWARD_OUTCOMES),
    refusal: (entry, record) => record.outcome === "refused"
      ? enumValue(entry, PRIVATE_RELAY_PEER_FORWARD_REFUSALS)
      : entry === null ? null : FAIL
  }));
  if (!parsed || parsed.sourceDeviceId === parsed.targetDeviceId) return null;
  return parsed;
}

export function parsePeerDeliveryAckSigningInput(value?: unknown) {
  const parsed = parseObject(value, {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    senderDeviceId: (entry) => opaqueId(entry),
    recipientDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    ciphertextDigest
  });
  if (!parsed || parsed.senderDeviceId === parsed.recipientDeviceId) return null;
  return parsed;
}

export function parsePeerDeliveryAck(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-delivery-ack", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    senderDeviceId: (entry) => opaqueId(entry),
    recipientDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    ciphertextDigest,
    signature: opaqueSignature
  }));
  if (!parsed || parsed.senderDeviceId === parsed.recipientDeviceId) return null;
  return parsed;
}

/** Domain-separated, newline-delimited transcript for a Signal identity XEdDSA receive ACK. */
export function peerDeliveryAckTranscript(value: PeerDeliveryAckSigningInput): string {
  const parsed = parsePeerDeliveryAckSigningInput(value);
  if (!parsed) throw new TypeError("Peer delivery ACK signing input does not satisfy the wire contract.");
  return [
    PRIVATE_RELAY_PEER_DELIVERY_ACK_DOMAIN,
    parsed.tenantId,
    parsed.routeId,
    parsed.senderDeviceId,
    parsed.recipientDeviceId,
    parsed.messageId,
    parsed.ciphertextDigest
  ].join("\n");
}

async function digestPeerSendCiphertext(send: PeerSend): Promise<string> {
  const ciphertext = Buffer.from(send.envelope.ciphertext, "base64url");
  const bytes = await crypto.subtle.digest("SHA-256", ciphertext);
  return `sha256:${Buffer.from(bytes).toString("base64url")}`;
}

/** SHA-256 binding over the exact decoded ciphertext bytes in a peer send. */
export async function peerCiphertextDigest(send?: unknown): Promise<string | null> {
  const parsed = parsePeerSend(send);
  return parsed ? digestPeerSendCiphertext(parsed) : null;
}

/** Build the recipient's signing input from the exact received send. */
export async function peerDeliveryAckSigningInputForSend(send?: unknown): Promise<PeerDeliveryAckSigningInput | null> {
  const parsed = parsePeerSend(send);
  if (!parsed) return null;
  return parsePeerDeliveryAckSigningInput({
    tenantId: parsed.tenantId,
    routeId: parsed.routeId,
    senderDeviceId: parsed.senderDeviceId,
    recipientDeviceId: parsed.recipientDeviceId,
    messageId: parsed.messageId,
    ciphertextDigest: await digestPeerSendCiphertext(parsed)
  });
}

/** Exact route/device/message/digest binding; signature verification remains with paired-key custody. */
export async function peerDeliveryAckMatchesSend(ack?: unknown, send?: unknown): Promise<boolean> {
  const parsedAck = parsePeerDeliveryAck(ack);
  const parsedSend = parsePeerSend(send);
  return !!parsedAck && !!parsedSend
    && parsedAck.tenantId === parsedSend.tenantId
    && parsedAck.routeId === parsedSend.routeId
    && parsedAck.senderDeviceId === parsedSend.senderDeviceId
    && parsedAck.recipientDeviceId === parsedSend.recipientDeviceId
    && parsedAck.messageId === parsedSend.messageId
    && parsedAck.ciphertextDigest === await digestPeerSendCiphertext(parsedSend);
}

export function parsePeerBundlePublish(value?: unknown) {
  return parseObject(value, commonRemote("peer-bundle-publish", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    bundle: (entry) => parsePrekeyBundlePublication(entry) || FAIL
  }));
}

export function parsePeerBundlePublished(value?: unknown) {
  return parseObject(value, commonRemote("peer-bundle-published", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    bundleId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_BUNDLE_PUBLISH_OUTCOMES),
    currentRevision: revision,
    refusal: (entry, record) => {
      if (record.outcome === "refused") return enumValue(entry, PRIVATE_RELAY_PEER_REFUSALS);
      return entry === null ? null : FAIL;
    }
  }));
}

export function parsePeerBundleFetch(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-bundle-fetch", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    peerDeviceId: (entry) => opaqueId(entry)
  }));
  if (!parsed || parsed.deviceId === parsed.peerDeviceId) return null;
  return parsed;
}

export function parsePeerBundle(value?: unknown) {
  return parseObject(value, commonRemote("peer-bundle", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_BUNDLE_STATES),
    bundle: (entry, record) => {
      if (record.state === "available") return parsePrekeyBundlePublication(entry) || FAIL;
      return entry === null ? null : FAIL;
    },
    refusal: (entry, record) => {
      if (record.state === "refused") return enumValue(entry, PRIVATE_RELAY_PEER_REFUSALS);
      return entry === null ? null : FAIL;
    }
  }));
}

/** Ephemeral paired-device reachability used only to wake durable client retries. */
export function parsePeerPresence(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-presence", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    peerDeviceId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_PRESENCE_STATES),
    sessionId: (entry, record) => record.state === "reachable" ? opaqueId(entry) : entry === null ? null : FAIL
  }));
  if (!parsed || parsed.deviceId === parsed.peerDeviceId) return null;
  return parsed;
}

KIND_PARSERS["peer-bundle-publish"] = parsePeerBundlePublish;
KIND_PARSERS["peer-bundle-published"] = parsePeerBundlePublished;
KIND_PARSERS["peer-bundle-fetch"] = parsePeerBundleFetch;
KIND_PARSERS["peer-bundle"] = parsePeerBundle;
KIND_PARSERS["peer-presence"] = parsePeerPresence;
KIND_PARSERS["peer-send"] = parsePeerSend;
KIND_PARSERS["peer-forwarded"] = parsePeerForwarded;
KIND_PARSERS["peer-delivery-ack"] = parsePeerDeliveryAck;

export function parsePrivateRelayPeerMessage(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenPeerKeys(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

export function assertPeerEnvelopeCipherOnly(value?: unknown) {
  if (!parsePeerSend(value)) {
    throw new Error("Peer sends must be versioned online-forwarding messages carrying an opaque Signal envelope.");
  }
  if (containsForbiddenPeerKeys(value)) {
    throw new Error("Peer envelopes must not carry plaintext, semantic grants, tool names, credentials or agent intent.");
  }
  if (PRIVATE_RELAY_PEER_RELAY_SEES_PLAINTEXT !== false) {
    throw new Error("The private relay forwards ciphertext and public prekey material only.");
  }
  return true;
}

/**
 * Sender-scoped local retry classification. It does not assert relay storage:
 * an identical tuple and envelope is safe to forward again; reuse of that
 * tuple/messageId with different envelope bytes is a local conflict.
 */
export function peerSendReplayClass(first?: unknown, replay?: unknown): "retry" | "conflict" | "distinct" | null {
  const a = parsePeerSend(first);
  const b = parsePeerSend(replay);
  if (!a || !b) return null;
  if (a.tenantId !== b.tenantId || a.routeId !== b.routeId || a.senderDeviceId !== b.senderDeviceId
    || a.recipientDeviceId !== b.recipientDeviceId || a.messageId !== b.messageId) return "distinct";
  return JSON.stringify(a.envelope) === JSON.stringify(b.envelope) ? "retry" : "conflict";
}

export function createPeerBundlePublish(value: Record<string, unknown> = {}) {
  return created(parsePeerBundlePublish, envelope("peer-bundle-publish", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    bundle: value.bundle
  }), "Private relay peer-bundle-publish does not satisfy the wire contract.");
}

export function createPeerBundlePublished(value: Record<string, unknown> = {}) {
  return created(parsePeerBundlePublished, envelope("peer-bundle-published", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    bundleId: value.bundleId,
    outcome: value.outcome,
    currentRevision: value.currentRevision,
    refusal: value.outcome === "refused" ? value.refusal : null
  }), "Private relay peer-bundle-published does not satisfy the wire contract.");
}

export function createPeerBundleFetch(value: Record<string, unknown> = {}) {
  return created(parsePeerBundleFetch, envelope("peer-bundle-fetch", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    peerDeviceId: value.peerDeviceId
  }), "Private relay peer-bundle-fetch does not satisfy the wire contract.");
}

export function createPeerBundle(value: Record<string, unknown> = {}) {
  return created(parsePeerBundle, envelope("peer-bundle", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    state: value.state,
    bundle: value.state === "available" ? value.bundle : null,
    refusal: value.state === "refused" ? value.refusal : null
  }), "Private relay peer-bundle does not satisfy the wire contract.");
}

export function createPeerPresence(value: Record<string, unknown> = {}) {
  return created(parsePeerPresence, envelope("peer-presence", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    peerDeviceId: value.peerDeviceId,
    state: value.state,
    sessionId: value.state === "reachable" ? value.sessionId : null
  }), "Private relay peer-presence does not satisfy the wire contract.");
}

export function createPeerSend(value: Record<string, unknown> = {}) {
  return created(parsePeerSend, envelope("peer-send", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    senderDeviceId: value.senderDeviceId,
    recipientDeviceId: value.recipientDeviceId,
    messageId: value.messageId,
    envelope: value.envelope
  }), "Private relay peer-send does not satisfy the wire contract.");
}

export function createPeerForwarded(value: Record<string, unknown> = {}) {
  return created(parsePeerForwarded, envelope("peer-forwarded", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    requestKind: value.requestKind,
    sourceDeviceId: value.sourceDeviceId,
    targetDeviceId: value.targetDeviceId,
    messageId: value.messageId,
    outcome: value.outcome,
    refusal: value.outcome === "refused" ? value.refusal : null
  }), "Private relay peer-forwarded does not satisfy the wire contract.");
}

export function createPeerDeliveryAck(value: Record<string, unknown> = {}) {
  return created(parsePeerDeliveryAck, envelope("peer-delivery-ack", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    senderDeviceId: value.senderDeviceId,
    recipientDeviceId: value.recipientDeviceId,
    messageId: value.messageId,
    ciphertextDigest: value.ciphertextDigest,
    signature: value.signature
  }), "Private relay peer-delivery-ack does not satisfy the wire contract.");
}

export function encodePrivateRelayPeerMessage(value?: unknown) {
  const parsed = parsePrivateRelayPeerMessage(value);
  if (!parsed) return "";
  return JSON.stringify(parsed);
}

export function decodePrivateRelayPeerMessage(value?: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return parsePrivateRelayPeerMessage(JSON.parse(value));
  } catch {
    return null;
  }
}
