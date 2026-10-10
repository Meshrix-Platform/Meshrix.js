/**
 * Private relay peer mailbox contract: versioned wire kinds for reliable
 * peer-to-peer agent messaging over the encrypted mailbox profile.
 *
 * The mailbox stores opaque Signal-family ciphertext envelopes, durable
 * positions and typed receipts inside a per-recipient partition. Bundle
 * publication carries public prekey material only; envelope headers carry the
 * session metadata the peer crypto layer owns. Plaintext, semantic grants,
 * tool names, credentials and agent intent never enter a mailbox-visible
 * message, and an application-level receipt is always an independent agent
 * report — never derived from a mailbox acknowledgement.
 */
export const PRIVATE_RELAY_PEER_SCHEMA_VERSION = "v0.0.1:private-relay:peer-1";

const PRIVATE_RELAY_PEER_WIRE_PROTOCOL = "meshrix-private-relay/0";

export const PRIVATE_RELAY_PEER_KINDS = Object.freeze([
  "peer-bundle-publish",
  "peer-bundle-published",
  "peer-bundle-fetch",
  "peer-bundle",
  "peer-send",
  "peer-accepted",
  "peer-fetch",
  "peer-messages",
  "peer-ack",
  "peer-acked",
  "peer-receipt",
  "peer-status",
  "peer-retention-policy"
]);
export const PRIVATE_RELAY_PEER_SIGNAL_PROFILES = Object.freeze([
  "signal-x3dh",
  "signal-pqxdh"
]);
export const PRIVATE_RELAY_PEER_MESSAGE_TYPES = Object.freeze([
  "prekey",
  "session"
]);
export const PRIVATE_RELAY_PEER_RECEIPT_KINDS = Object.freeze([
  "accepted",
  "received",
  "accepted_by_agent",
  "completed",
  "rejected"
]);
export const PRIVATE_RELAY_PEER_MAILBOX_RECEIPT_KINDS = Object.freeze([
  "accepted",
  "received"
]);
export const PRIVATE_RELAY_PEER_APPLICATION_RECEIPT_KINDS = Object.freeze([
  "accepted_by_agent",
  "completed",
  "rejected"
]);
export const PRIVATE_RELAY_PEER_RECEIPT_SOURCES = Object.freeze([
  "mailbox",
  "recipient",
  "agent"
]);
export const PRIVATE_RELAY_PEER_SEND_OUTCOMES = Object.freeze([
  "accepted",
  "duplicate",
  "conflict"
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
  "capacity_exceeded",
  "rate_limited",
  "authority_stale"
]);
export const PRIVATE_RELAY_PEER_ACK_REFUSALS = Object.freeze([
  "message_unknown",
  "position_mismatch",
  "authority_stale",
  "revoked"
]);
export const PRIVATE_RELAY_PEER_GAP_CAUSES = Object.freeze([
  "expired",
  "capacity_truncated"
]);
export const PRIVATE_RELAY_PEER_APP_RECEIPTS_FROM_ACKS = false;
export const PRIVATE_RELAY_PEER_MAILBOX_SEES_PLAINTEXT = false;

export const PRIVATE_RELAY_PEER_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxEnvelopeBytes: 65_536,
  maxBundleBytes: 65_536,
  maxReceiptDetailBytes: 4_096,
  maxPageMessages: 64,
  maxAckEntries: 64,
  maxReceiptQueries: 64,
  maxReceiptsPerStatus: 16,
  maxGaps: 64,
  maxGapMessageIds: 64,
  maxMailboxCapacityBytes: 1_073_741_824,
  maxMailboxRetentionMs: 31_536_000_000,
  maxMailboxItems: 1_000_000,
  minSeq: 0
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
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;
type PeerParser = (value?: unknown) => Readonly<UnknownRecord> | null;

export type PeerEnvelope = NonNullable<ReturnType<typeof parsePeerEnvelope>>;
export type PrekeyBundlePublication = NonNullable<ReturnType<typeof parsePrekeyBundlePublication>>;
export type PeerReceipt = NonNullable<ReturnType<typeof parsePeerReceipt>>;
export type MailboxRetentionPolicy = NonNullable<ReturnType<typeof parseMailboxRetentionPolicy>>;
export type MailboxSend = NonNullable<ReturnType<typeof parsePeerSend>>;
export type MailboxFetch = NonNullable<ReturnType<typeof parsePeerFetch>>;
export type MailboxAck = NonNullable<ReturnType<typeof parsePeerAck>>;

const KIND_PARSERS: Record<string, PeerParser> = {};

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

function boundedInteger(value: unknown, min: number, max: number): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : FAIL;
}

function boolValue(value?: unknown): boolean | typeof FAIL {
  return typeof value === "boolean" ? value : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = PRIVATE_RELAY_PEER_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function opaqueBytes(value: unknown, maxBytes: number): string | typeof FAIL {
  const normalized = boundedText(value, Math.ceil(maxBytes * 4 / 3) + 8);
  return normalized && BASE64URL_PATTERN.test(normalized) ? normalized : FAIL;
}

function nullableOpaqueId(value: unknown): string | null | typeof FAIL {
  return value === null ? null : opaqueId(value);
}

export function containsForbiddenPeerKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => PRIVATE_RELAY_PEER_FORBIDDEN_KEYS.includes(key))) return true;
  return Object.values(value).some((entry) => containsForbiddenPeerKeys(entry, seen));
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

function isApplicationReceiptKind(kind: unknown): boolean {
  return typeof kind === "string" && (PRIVATE_RELAY_PEER_APPLICATION_RECEIPT_KINDS as readonly string[]).includes(kind);
}

export function parsePeerEnvelopeHeaders(value?: unknown) {
  return parseObject(value, {
    messageType: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_MESSAGE_TYPES),
    senderBundleId: (entry) => opaqueId(entry),
    recipientBundleId: (entry) => opaqueId(entry),
    prekeyId: nullableOpaqueId,
    signedPrekeyId: nullableOpaqueId,
    baseKeyId: nullableOpaqueId
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

export function parsePeerReceipt(value?: unknown) {
  const parsed = parseObject(value, {
    kind: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_RECEIPT_KINDS),
    source: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_RECEIPT_SOURCES),
    messageId: (entry) => opaqueId(entry),
    position: positiveRevision,
    detail: (entry) => entry === null ? null : opaqueBytes(entry, PRIVATE_RELAY_PEER_LIMITS.maxReceiptDetailBytes)
  });
  if (!parsed) return null;
  // Receipt taxonomy honesty: the mailbox issues `accepted`, the recipient
  // issues `received`, and only an agent reports the application kinds.
  if (parsed.kind === "accepted" && (parsed.source !== "mailbox" || parsed.detail !== null)) return null;
  if (parsed.kind === "received" && (parsed.source !== "recipient" || parsed.detail !== null)) return null;
  if (isApplicationReceiptKind(parsed.kind) && parsed.source !== "agent") return null;
  return parsed;
}

export function parsePeerGap(value?: unknown) {
  return parseObject(value, {
    fromSeq: revision,
    toSeq: (entry, record) => {
      const from = revision(record.fromSeq);
      const to = revision(entry);
      return to !== FAIL && from !== FAIL && to >= from ? to : FAIL;
    },
    cause: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_GAP_CAUSES),
    messageIds: (entry) => entry === null
      ? null
      : parseArray(entry, (item) => opaqueId(item), PRIVATE_RELAY_PEER_LIMITS.maxGapMessageIds)
  });
}

export function parsePeerStoredMessage(value?: unknown) {
  return parseObject(value, {
    position: positiveRevision,
    senderDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    envelope: (entry) => parsePeerEnvelope(entry) || FAIL
  });
}

export function parseMailboxRetentionPolicy(value?: unknown) {
  return parseObject(value, {
    mailboxCapacityBytes: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxCapacityBytes),
    mailboxRetentionMs: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxRetentionMs),
    mailboxMaxItems: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxItems)
  });
}

function parsePeerAcknowledgement(value?: unknown) {
  return parseObject(value, {
    messageId: (entry) => opaqueId(entry),
    position: positiveRevision
  });
}

function parsePeerAckRefusal(value?: unknown) {
  return parseObject(value, {
    messageId: (entry) => opaqueId(entry),
    refusal: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_ACK_REFUSALS)
  });
}

function parsePeerStatusEntry(value?: unknown) {
  const parsed = parseObject(value, {
    messageId: (entry) => opaqueId(entry),
    position: revision,
    receipts: (entry) => parseArray(entry, parsePeerReceipt, PRIVATE_RELAY_PEER_LIMITS.maxReceiptsPerStatus)
  });
  // An unknown send reports position 0 and must not invent receipts.
  if (!parsed || (parsed.position === 0 && parsed.receipts.length !== 0)) return null;
  return parsed;
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

export function parsePeerSend(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-send", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    peerDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    envelope: (entry) => parsePeerEnvelope(entry) || FAIL
  }));
  if (!parsed || parsed.deviceId === parsed.peerDeviceId) return null;
  return parsed;
}

export function parsePeerAccepted(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-accepted", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    peerDeviceId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, PRIVATE_RELAY_PEER_SEND_OUTCOMES),
    position: revision,
    receipt: (entry, record) => {
      if (record.outcome === "conflict") return entry === null ? null : FAIL;
      return parsePeerReceipt(entry) || FAIL;
    }
  }));
  if (!parsed || parsed.deviceId === parsed.peerDeviceId) return null;
  if (parsed.outcome !== "conflict") {
    const receipt = parsed.receipt;
    if (!receipt || receipt.kind !== "accepted" || receipt.source !== "mailbox"
      || receipt.messageId !== parsed.messageId || receipt.position !== parsed.position) return null;
  }
  return parsed;
}

export function parsePeerFetch(value?: unknown) {
  return parseObject(value, commonRemote("peer-fetch", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    afterSeq: revision,
    limit: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxPageMessages)
  }));
}

export function parsePeerMessages(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-messages", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    messages: (entry) => parseArray(entry, parsePeerStoredMessage, PRIVATE_RELAY_PEER_LIMITS.maxPageMessages),
    nextAfterSeq: revision,
    more: boolValue,
    gaps: (entry) => parseArray(entry, parsePeerGap, PRIVATE_RELAY_PEER_LIMITS.maxGaps)
  }));
  if (!parsed) return null;
  // Positions are delivered strictly ascending, the resume cursor never
  // rewinds past a delivered position, and tombstone ranges never overlap.
  let lastPosition = 0;
  for (const message of parsed.messages) {
    if (message.position <= lastPosition) return null;
    lastPosition = message.position;
  }
  if (parsed.nextAfterSeq < lastPosition) return null;
  let lastGapTo = -1;
  for (const gap of parsed.gaps) {
    if (gap.fromSeq <= lastGapTo) return null;
    lastGapTo = gap.toSeq;
  }
  return parsed;
}

export function parsePeerAck(value?: unknown) {
  const parsed = parseObject(value, commonRemote("peer-ack", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    received: (entry) => parseArray(entry, parsePeerAcknowledgement, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries),
    reports: (entry) => parseArray(entry, parsePeerReceipt, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries)
  }));
  if (!parsed || (parsed.received.length === 0 && parsed.reports.length === 0)) return null;
  // `reports` carries application-level receipts only; mailbox kinds are
  // issued by the mailbox, never claimed by a recipient.
  for (const report of parsed.reports) {
    if (!isApplicationReceiptKind(report.kind)) return null;
  }
  return parsed;
}

export function parsePeerAcked(value?: unknown) {
  return parseObject(value, commonRemote("peer-acked", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    recorded: (entry) => parseArray(entry, parsePeerReceipt, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries),
    refused: (entry) => parseArray(entry, parsePeerAckRefusal, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries)
  }));
}

export function parsePeerReceiptQuery(value?: unknown) {
  return parseObject(value, commonRemote("peer-receipt", {
    tenantId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    messageIds: (entry) => parseArray(entry, (item) => opaqueId(item), PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries, false)
  }));
}

export function parsePeerStatus(value?: unknown) {
  return parseObject(value, commonRemote("peer-status", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    statuses: (entry) => parseArray(entry, parsePeerStatusEntry, PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries)
  }));
}

export function parsePeerRetentionPolicy(value?: unknown) {
  return parseObject(value, commonRemote("peer-retention-policy", {
    routeId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    mailboxCapacityBytes: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxCapacityBytes),
    mailboxRetentionMs: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxRetentionMs),
    mailboxMaxItems: (entry) => boundedInteger(entry, 1, PRIVATE_RELAY_PEER_LIMITS.maxMailboxItems)
  }));
}

KIND_PARSERS["peer-bundle-publish"] = parsePeerBundlePublish;
KIND_PARSERS["peer-bundle-published"] = parsePeerBundlePublished;
KIND_PARSERS["peer-bundle-fetch"] = parsePeerBundleFetch;
KIND_PARSERS["peer-bundle"] = parsePeerBundle;
KIND_PARSERS["peer-send"] = parsePeerSend;
KIND_PARSERS["peer-accepted"] = parsePeerAccepted;
KIND_PARSERS["peer-fetch"] = parsePeerFetch;
KIND_PARSERS["peer-messages"] = parsePeerMessages;
KIND_PARSERS["peer-ack"] = parsePeerAck;
KIND_PARSERS["peer-acked"] = parsePeerAcked;
KIND_PARSERS["peer-receipt"] = parsePeerReceiptQuery;
KIND_PARSERS["peer-status"] = parsePeerStatus;
KIND_PARSERS["peer-retention-policy"] = parsePeerRetentionPolicy;

export function parsePrivateRelayPeerMessage(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenPeerKeys(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

export function assertPeerEnvelopeCipherOnly(value?: unknown) {
  const parsed = parsePeerSend(value);
  if (!parsed) {
    throw new Error("Peer sends must be a versioned peer-send message carrying an opaque Signal envelope.");
  }
  if (containsForbiddenPeerKeys(value)) {
    throw new Error("Peer envelopes must not carry plaintext, semantic grants, tool names, credentials or agent intent.");
  }
  if (PRIVATE_RELAY_PEER_MAILBOX_SEES_PLAINTEXT !== false) {
    throw new Error("The peer mailbox stores ciphertext and public prekey material only.");
  }
  return true;
}

export function peerReceiptIsMailboxIssued(receipt?: unknown): boolean {
  const parsed = parsePeerReceipt(receipt);
  return !!parsed && parsed.kind === "accepted" && parsed.source === "mailbox";
}

export function peerReceiptIsRecipientRecorded(receipt?: unknown): boolean {
  const parsed = parsePeerReceipt(receipt);
  return !!parsed && parsed.kind === "received" && parsed.source === "recipient";
}

export function peerReceiptIsApplicationReport(receipt?: unknown): boolean {
  const parsed = parsePeerReceipt(receipt);
  return !!parsed && isApplicationReceiptKind(parsed.kind) && parsed.source === "agent";
}

export function assertPeerReceiptIndependent(receipt?: unknown) {
  const parsed = parsePeerReceipt(receipt);
  if (!parsed) {
    throw new Error("Peer receipt must satisfy the typed receipt contract.");
  }
  if (isApplicationReceiptKind(parsed.kind) && PRIVATE_RELAY_PEER_APP_RECEIPTS_FROM_ACKS !== false) {
    throw new Error("Application receipts are independent agent reports and must never be derived from mailbox acknowledgements.");
  }
  return true;
}

/**
 * Sender-scoped idempotency verdict for two peer-send messages. Identical
 * scope and envelope bytes is an honest `retry` (the stored `accepted`
 * receipt is replayed); identical scope with different envelope bytes is a
 * typed `conflict`; anything outside the (tenant, route, sender, recipient,
 * messageId) scope is `distinct`. Unparseable input yields null.
 */
export function peerSendReplayClass(first?: unknown, replay?: unknown): "retry" | "conflict" | "distinct" | null {
  const a = parsePeerSend(first);
  const b = parsePeerSend(replay);
  if (!a || !b) return null;
  if (a.tenantId !== b.tenantId || a.routeId !== b.routeId || a.deviceId !== b.deviceId
    || a.peerDeviceId !== b.peerDeviceId || a.messageId !== b.messageId) return "distinct";
  return JSON.stringify(a.envelope) === JSON.stringify(b.envelope) ? "retry" : "conflict";
}

/**
 * Ack coverage honesty: every messageId a peer-ack asked to record is either
 * durably recorded or explicitly refused — never silently dropped — and the
 * response never invents unrequested outcomes.
 */
export function peerAckFullyRecorded(ack?: unknown, acked?: unknown): boolean {
  const request = parsePeerAck(ack);
  const response = parsePeerAcked(acked);
  if (!request || !response) return false;
  if (request.routeId !== response.routeId || request.deviceId !== response.deviceId) return false;
  const requested = new Set<string>([
    ...request.received.map((entry) => entry.messageId),
    ...request.reports.map((entry) => entry.messageId)
  ]);
  const answered = new Set<string>([
    ...response.recorded.map((entry) => entry.messageId),
    ...response.refused.map((entry) => entry.messageId)
  ]);
  if (requested.size !== answered.size) return false;
  for (const messageId of requested) {
    if (!answered.has(messageId)) return false;
  }
  return true;
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

export function createPeerSend(value: Record<string, unknown> = {}) {
  return created(parsePeerSend, envelope("peer-send", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    peerDeviceId: value.peerDeviceId,
    messageId: value.messageId,
    envelope: value.envelope
  }), "Private relay peer-send does not satisfy the wire contract.");
}

export function createPeerAccepted(value: Record<string, unknown> = {}) {
  return created(parsePeerAccepted, envelope("peer-accepted", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    peerDeviceId: value.peerDeviceId,
    messageId: value.messageId,
    outcome: value.outcome,
    position: value.position,
    receipt: value.outcome === "conflict" ? null : value.receipt
  }), "Private relay peer-accepted does not satisfy the wire contract.");
}

export function createPeerFetch(value: Record<string, unknown> = {}) {
  return created(parsePeerFetch, envelope("peer-fetch", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    afterSeq: value.afterSeq,
    limit: value.limit
  }), "Private relay peer-fetch does not satisfy the wire contract.");
}

export function createPeerMessages(value: Record<string, unknown> = {}) {
  return created(parsePeerMessages, envelope("peer-messages", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    messages: value.messages || [],
    nextAfterSeq: value.nextAfterSeq,
    more: value.more === true,
    gaps: value.gaps || []
  }), "Private relay peer-messages does not satisfy the wire contract.");
}

export function createPeerAck(value: Record<string, unknown> = {}) {
  return created(parsePeerAck, envelope("peer-ack", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    received: value.received || [],
    reports: value.reports || []
  }), "Private relay peer-ack does not satisfy the wire contract.");
}

export function createPeerAcked(value: Record<string, unknown> = {}) {
  return created(parsePeerAcked, envelope("peer-acked", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    recorded: value.recorded || [],
    refused: value.refused || []
  }), "Private relay peer-acked does not satisfy the wire contract.");
}

export function createPeerReceiptQuery(value: Record<string, unknown> = {}) {
  return created(parsePeerReceiptQuery, envelope("peer-receipt", {
    tenantId: value.tenantId,
    routeId: value.routeId,
    deviceId: value.deviceId,
    messageIds: value.messageIds
  }), "Private relay peer-receipt does not satisfy the wire contract.");
}

export function createPeerStatus(value: Record<string, unknown> = {}) {
  return created(parsePeerStatus, envelope("peer-status", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    statuses: value.statuses || []
  }), "Private relay peer-status does not satisfy the wire contract.");
}

export function createPeerRetentionPolicy(value: Record<string, unknown> = {}) {
  return created(parsePeerRetentionPolicy, envelope("peer-retention-policy", {
    routeId: value.routeId,
    deviceId: value.deviceId,
    mailboxCapacityBytes: value.mailboxCapacityBytes,
    mailboxRetentionMs: value.mailboxRetentionMs,
    mailboxMaxItems: value.mailboxMaxItems
  }), "Private relay peer-retention-policy does not satisfy the wire contract.");
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
