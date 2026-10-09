/**
 * Private relay wire contract: relay-visible admission, session and frame
 * schemas for the operator-blind forwarding profile.
 *
 * The relay sees only opaque routing identifiers, generations, revisions and
 * ciphertext bytes. Semantic grants, catalog names, upstream identities,
 * credentials and plaintext never enter a relay-visible message. Endpoint
 * trust material lives behind the inner mutually-authenticated channel and is
 * defined in private-relay-recovery.ts; this module owns the relay surface.
 */
export const PRIVATE_RELAY_SCHEMA_VERSION = "v0.0.1:private-relay:wire-1";
export const PRIVATE_RELAY_WIRE_PROTOCOL = "meshrix-private-relay/0";

export const PRIVATE_RELAY_ROLES = Object.freeze([
  "entry",
  "endpoint"
]);
export const PRIVATE_RELAY_MODES = Object.freeze([
  "personal",
  "enterprise"
]);
export const PRIVATE_RELAY_SESSION_PURPOSES = Object.freeze([
  "forward",
  "recover_device"
]);
export const PRIVATE_RELAY_KINDS = Object.freeze([
  "session-open",
  "session-admitted",
  "session-rejected",
  "route-bind",
  "route-query",
  "route-status",
  "frame",
  "frame-ack",
  "frame-status",
  "flow-credit",
  "session-close",
  "session-reconnect",
  "session-restored"
]);
export const PRIVATE_RELAY_REJECT_REASONS = Object.freeze([
  "identity_unknown",
  "identity_ambiguous",
  "mode_mismatch",
  "tenant_mismatch",
  "revoked",
  "stale_revocation_revision",
  "capacity_exceeded",
  "protocol_version_unsupported",
  "purpose_denied",
  "authority_stale"
]);
export const PRIVATE_RELAY_CLOSE_REASONS = Object.freeze([
  "normal",
  "reconnect",
  "revoked",
  "capacity_exceeded",
  "protocol_error",
  "idle_timeout"
]);
export const PRIVATE_RELAY_ROUTE_STATES = Object.freeze([
  "reachable",
  "unreachable"
]);
export const PRIVATE_RELAY_FRAME_STATES = Object.freeze([
  "accepted",
  "received"
]);
export const PRIVATE_RELAY_GAP_CAUSES = Object.freeze([
  "expired",
  "capacity_truncated"
]);
export const PRIVATE_RELAY_SESSION_STATES = Object.freeze([
  "initiated",
  "open_sent",
  "admitted",
  "rejected",
  "streaming",
  "closing",
  "closed",
  "reconnecting"
]);
export const PRIVATE_RELAY_SESSION_EVENTS = Object.freeze([
  "open",
  "admit",
  "reject",
  "frame",
  "close",
  "close_complete",
  "reconnect",
  "restore"
]);
export const PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF = false;
export const PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES = false;

export const PRIVATE_RELAY_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxNonceBytes: 96,
  maxFingerprintBytes: 96,
  maxFramePayloadBytes: 262_144,
  maxOutstandingBytes: 4_194_304,
  maxBufferedFrames: 256,
  maxMessageRatePerSecond: 128,
  maxSessionControlBytes: 16_384,
  maxGaps: 64,
  maxRouteIds: 64,
  minSeq: 0
});

export const PRIVATE_RELAY_FORBIDDEN_KEYS = Object.freeze([
  "apiKey",
  "arguments",
  "authorization",
  "catalog",
  "catalogName",
  "content",
  "credential",
  "credentials",
  "grant",
  "grantId",
  "grants",
  "plaintext",
  "principal",
  "privateKey",
  "prompt",
  "result",
  "scope",
  "scopes",
  "secret",
  "serviceLocation",
  "toolName",
  "token",
  "tool",
  "upstream",
  "upstreamHost"
]);

const FAIL = Symbol("private-relay-fail");
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;
type RelayParser = (value?: unknown) => Readonly<UnknownRecord> | null;
export interface PrivateRelayPeer {
  encode(value: unknown): string;
  decode(value: unknown): Readonly<UnknownRecord> | null;
  validate(value?: unknown): Readonly<UnknownRecord> | null;
}
interface FrameAccounting {
  outstandingBytes: number;
  outstandingFrames: number;
}

const KIND_PARSERS: Record<string, RelayParser> = {};

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

function boundedText(value: unknown, maxBytes: number = PRIVATE_RELAY_LIMITS.maxOpaqueIdBytes): string {
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

function boolValue(value?: unknown): boolean | typeof FAIL {
  return typeof value === "boolean" ? value : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = PRIVATE_RELAY_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function nonceToken(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, PRIVATE_RELAY_LIMITS.maxNonceBytes);
  return normalized && NONCE_PATTERN.test(normalized) ? normalized : FAIL;
}

function opaqueBytes(value: unknown, maxBytes: number): string | typeof FAIL {
  const normalized = boundedText(value, Math.ceil(maxBytes * 4 / 3) + 8);
  return normalized && BASE64URL_PATTERN.test(normalized) ? normalized : FAIL;
}

export function containsForbiddenRelayKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => PRIVATE_RELAY_FORBIDDEN_KEYS.includes(key))) return true;
  return Object.values(value).some((entry) => containsForbiddenRelayKeys(entry, seen));
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenRelayKeys(value)) return null;
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
    schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
    wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
    kind,
    ...extras
  };
}

function schemaFields(): ParserSpec {
  return {
    schemaVersion: (entry) => entry === PRIVATE_RELAY_SCHEMA_VERSION ? entry : FAIL,
    wireProtocol: (entry) => entry === PRIVATE_RELAY_WIRE_PROTOCOL ? entry : FAIL,
    kind: () => FAIL
  };
}

function commonRemote<T extends ParserSpec>(kind: string, extra: T) {
  return {
    schemaVersion: (entry: unknown) => entry === PRIVATE_RELAY_SCHEMA_VERSION ? entry : FAIL,
    wireProtocol: (entry: unknown) => entry === PRIVATE_RELAY_WIRE_PROTOCOL ? entry : FAIL,
    kind: (entry: unknown) => entry === kind ? entry : FAIL,
    ...extra
  };
}

export function parseRelayAdmissionBinding(value?: unknown) {
  const parsed = parseObject(value, {
    tenantId: (entry) => opaqueId(entry),
    deviceId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    role: (entry) => enumValue(entry, PRIVATE_RELAY_ROLES),
    mode: (entry) => enumValue(entry, PRIVATE_RELAY_MODES),
    admissionGeneration: positiveRevision,
    revocationRevision: revision
  });
  return parsed;
}

export function parseRelayLimits(value?: unknown) {
  const parsed = parseObject(value, {
    maxFramePayloadBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= PRIVATE_RELAY_LIMITS.maxFramePayloadBytes ? entry as number : FAIL
    ),
    maxOutstandingBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= PRIVATE_RELAY_LIMITS.maxOutstandingBytes ? entry as number : FAIL
    ),
    maxBufferedFrames: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= PRIVATE_RELAY_LIMITS.maxBufferedFrames ? entry as number : FAIL
    ),
    maxMessageRatePerSecond: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond ? entry as number : FAIL
    )
  });
  return parsed;
}

function parseSequenceCursors(value?: unknown) {
  return parseObject(value, {
    toEndpoint: revision,
    toEntry: revision
  });
}

function parseGap(value?: unknown) {
  return parseObject(value, {
    fromSeq: revision,
    toSeq: (entry, record) => {
      const from = revision(record.fromSeq);
      return revision(entry) !== FAIL && (entry as number) >= (from as number) ? entry : FAIL;
    },
    cause: (entry) => enumValue(entry, PRIVATE_RELAY_GAP_CAUSES)
  });
}

export function parseSessionOpen(value?: unknown) {
  return parseObject(value, commonRemote("session-open", {
    purpose: (entry) => enumValue(entry, PRIVATE_RELAY_SESSION_PURPOSES),
    admission: (entry) => parseRelayAdmissionBinding(entry) || FAIL,
    clientNonce: (entry) => nonceToken(entry)
  }));
}

export function parseSessionAdmitted(value?: unknown) {
  return parseObject(value, commonRemote("session-admitted", {
    sessionId: (entry) => opaqueId(entry),
    purpose: (entry) => enumValue(entry, PRIVATE_RELAY_SESSION_PURPOSES),
    admittedGeneration: positiveRevision,
    revocationRevision: revision,
    routeState: (entry) => enumValue(entry, PRIVATE_RELAY_ROUTE_STATES),
    limits: (entry) => parseRelayLimits(entry) || FAIL,
    reconnectGeneration: positiveRevision,
    serverNonce: (entry) => nonceToken(entry)
  }));
}

export function parseSessionRejected(value?: unknown) {
  return parseObject(value, commonRemote("session-rejected", {
    reason: (entry) => enumValue(entry, PRIVATE_RELAY_REJECT_REASONS),
    expectedRevocationRevision: revision,
    retryable: boolValue
  }));
}

export function parseRouteBind(value?: unknown) {
  return parseObject(value, commonRemote("route-bind", {
    sessionId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    admissionGeneration: positiveRevision
  }));
}

export function parseRouteQuery(value?: unknown) {
  return parseObject(value, commonRemote("route-query", {
    routeId: (entry) => opaqueId(entry)
  }));
}

export function parseRouteStatus(value?: unknown) {
  return parseObject(value, commonRemote("route-status", {
    routeId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_ROUTE_STATES),
    generation: positiveRevision
  }));
}

export function parseFrame(value?: unknown) {
  return parseObject(value, commonRemote("frame", {
    sessionId: (entry) => opaqueId(entry),
    routeId: (entry) => opaqueId(entry),
    seq: revision,
    messageId: (entry) => opaqueId(entry),
    payload: (entry) => opaqueBytes(entry, PRIVATE_RELAY_LIMITS.maxFramePayloadBytes) ,
    final: boolValue
  }));
}

export function parseFrameAck(value?: unknown) {
  return parseObject(value, commonRemote("frame-ack", {
    routeId: (entry) => opaqueId(entry),
    upToSeq: revision
  }));
}

export function parseFrameStatus(value?: unknown) {
  return parseObject(value, commonRemote("frame-status", {
    routeId: (entry) => opaqueId(entry),
    messageId: (entry) => opaqueId(entry),
    state: (entry) => enumValue(entry, PRIVATE_RELAY_FRAME_STATES)
  }));
}

export function parseFlowCredit(value?: unknown) {
  return parseObject(value, commonRemote("flow-credit", {
    routeId: (entry) => opaqueId(entry),
    grantBytes: positiveRevision,
    grantFrames: positiveRevision
  }));
}

export function parseSessionClose(value?: unknown) {
  return parseObject(value, commonRemote("session-close", {
    sessionId: (entry) => opaqueId(entry),
    reason: (entry) => enumValue(entry, PRIVATE_RELAY_CLOSE_REASONS),
    finalCursors: (entry) => parseSequenceCursors(entry) || FAIL
  }));
}

export function parseSessionReconnect(value?: unknown) {
  return parseObject(value, commonRemote("session-reconnect", {
    previousSessionId: (entry) => opaqueId(entry),
    admission: (entry) => parseRelayAdmissionBinding(entry) || FAIL,
    lastAcknowledged: (entry) => parseSequenceCursors(entry) || FAIL,
    reconnectGeneration: positiveRevision,
    clientNonce: (entry) => nonceToken(entry)
  }));
}

export function parseSessionRestored(value?: unknown) {
  return parseObject(value, commonRemote("session-restored", {
    sessionId: (entry) => opaqueId(entry),
    reconnectGeneration: positiveRevision,
    gaps: (entry) => parseArray(entry, parseGap, PRIVATE_RELAY_LIMITS.maxGaps),
    limits: (entry) => parseRelayLimits(entry) || FAIL,
    cursors: (entry) => parseSequenceCursors(entry) || FAIL
  }));
}

KIND_PARSERS["session-open"] = parseSessionOpen;
KIND_PARSERS["session-admitted"] = parseSessionAdmitted;
KIND_PARSERS["session-rejected"] = parseSessionRejected;
KIND_PARSERS["route-bind"] = parseRouteBind;
KIND_PARSERS["route-query"] = parseRouteQuery;
KIND_PARSERS["route-status"] = parseRouteStatus;
KIND_PARSERS["frame"] = parseFrame;
KIND_PARSERS["frame-ack"] = parseFrameAck;
KIND_PARSERS["frame-status"] = parseFrameStatus;
KIND_PARSERS["flow-credit"] = parseFlowCredit;
KIND_PARSERS["session-close"] = parseSessionClose;
KIND_PARSERS["session-reconnect"] = parseSessionReconnect;
KIND_PARSERS["session-restored"] = parseSessionRestored;

export function parsePrivateRelayMessage(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenRelayKeys(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

export function assertRelayAdmissionOnlyRouting(value?: unknown) {
  const parsed = parseSessionOpen(value) || parseSessionReconnect(value);
  if (!parsed) {
    throw new Error("Relay admission must be a versioned session-open or session-reconnect message.");
  }
  if (containsForbiddenRelayKeys(value)) {
    throw new Error("Relay admission must not carry semantic grants, catalog names, upstream identities or credentials.");
  }
  return true;
}

export function assertRouteBindIsEndpoint(value?: unknown) {
  const bind = parseRouteBind(value);
  if (!bind) {
    throw new Error("Route binding must be a versioned route-bind message.");
  }
  return true;
}

const SESSION_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  initiated: Object.freeze({ open: "open_sent" }),
  open_sent: Object.freeze({ admit: "admitted", reject: "rejected", close: "closed" }),
  admitted: Object.freeze({ frame: "streaming", close: "closing", reconnect: "reconnecting" }),
  rejected: Object.freeze({}),
  streaming: Object.freeze({ frame: "streaming", close: "closing", reconnect: "reconnecting" }),
  closing: Object.freeze({ close_complete: "closed" }),
  closed: Object.freeze({ reconnect: "reconnecting" }),
  reconnecting: Object.freeze({ restore: "admitted", reject: "rejected" })
});

export function relaySessionTransition(state: unknown, event: unknown): string | null {
  if (typeof state !== "string" || typeof event !== "string") return null;
  const transitions = SESSION_TRANSITIONS[state];
  if (!transitions) return null;
  const next = transitions[event];
  return typeof next === "string" ? next : null;
}

export function assertRelaySessionTransition(state: unknown, event: unknown): string {
  const next = relaySessionTransition(state, event);
  if (!next) {
    throw new Error(`PRIVATE_RELAY_SESSION_TRANSITION_REJECTED: ${String(state)} + ${String(event)} is not a valid transition.`);
  }
  return next;
}

export function endpointReachabilityForNewWork(routeState?: unknown): "reachable" | "endpoint_unreachable" {
  return routeState === "reachable" ? "reachable" : "endpoint_unreachable";
}

export function assertOfflineCallHandling(submittedBeforeOffline: unknown): string {
  if (submittedBeforeOffline === true) {
    return "operation_status_query_required";
  }
  if (PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES !== false) {
    throw new Error("New calls must not be silently queued while the endpoint is unreachable.");
  }
  return "endpoint_unreachable";
}

export function initialFrameAccounting(): FrameAccounting {
  return Object.freeze({ outstandingBytes: 0, outstandingFrames: 0 });
}

export function admitOutboundFrame(
  accounting: FrameAccounting,
  frame: unknown,
  limits: unknown
): FrameAccounting | null {
  const parsedFrame = parseFrame(frame);
  const parsedLimits = parseRelayLimits(limits);
  if (!parsedFrame || !parsedLimits || !accounting) return null;
  const payloadBytes = Math.ceil(parsedFrame.payload.length * 3 / 4);
  const bytes = accounting.outstandingBytes + payloadBytes;
  const frames = accounting.outstandingFrames + 1;
  if (bytes > parsedLimits.maxOutstandingBytes || frames > parsedLimits.maxBufferedFrames) return null;
  return Object.freeze({ outstandingBytes: bytes, outstandingFrames: frames });
}

export function acknowledgeFrames(
  accounting: FrameAccounting,
  ack: unknown,
  sentFrames: readonly { seq: number; payloadBytes: number }[]
): FrameAccounting | null {
  const parsedAck = parseFrameAck(ack);
  if (!parsedAck || !accounting || !Array.isArray(sentFrames)) return null;
  const remaining = sentFrames.filter((frame) => frame.seq > parsedAck.upToSeq);
  if (remaining.length === sentFrames.length && parsedAck.upToSeq > 0) return null;
  const bytes = remaining.reduce((total, frame) => total + frame.payloadBytes, 0);
  if (bytes > accounting.outstandingBytes) return null;
  return Object.freeze({ outstandingBytes: bytes, outstandingFrames: remaining.length });
}

export function createSessionOpen(value: Record<string, unknown> = {}) {
  return created(parseSessionOpen, envelope("session-open", {
    purpose: value.purpose,
    admission: value.admission,
    clientNonce: value.clientNonce
  }), "Private relay session-open does not satisfy the wire contract.");
}

export function createSessionAdmitted(value: Record<string, unknown> = {}) {
  return created(parseSessionAdmitted, envelope("session-admitted", {
    sessionId: value.sessionId,
    purpose: value.purpose,
    admittedGeneration: value.admittedGeneration,
    revocationRevision: value.revocationRevision,
    routeState: value.routeState,
    limits: value.limits,
    reconnectGeneration: value.reconnectGeneration,
    serverNonce: value.serverNonce
  }), "Private relay session-admitted does not satisfy the wire contract.");
}

export function createSessionRejected(value: Record<string, unknown> = {}) {
  return created(parseSessionRejected, envelope("session-rejected", {
    reason: value.reason,
    expectedRevocationRevision: value.expectedRevocationRevision,
    retryable: value.retryable
  }), "Private relay session-rejected does not satisfy the wire contract.");
}

export function createRouteBind(value: Record<string, unknown> = {}) {
  return created(parseRouteBind, envelope("route-bind", {
    sessionId: value.sessionId,
    routeId: value.routeId,
    admissionGeneration: value.admissionGeneration
  }), "Private relay route-bind does not satisfy the wire contract.");
}

export function createRouteQuery(value: Record<string, unknown> = {}) {
  return created(parseRouteQuery, envelope("route-query", {
    routeId: value.routeId
  }), "Private relay route-query does not satisfy the wire contract.");
}

export function createRouteStatus(value: Record<string, unknown> = {}) {
  return created(parseRouteStatus, envelope("route-status", {
    routeId: value.routeId,
    state: value.state,
    generation: value.generation
  }), "Private relay route-status does not satisfy the wire contract.");
}

export function createFrame(value: Record<string, unknown> = {}) {
  return created(parseFrame, envelope("frame", {
    sessionId: value.sessionId,
    routeId: value.routeId,
    seq: value.seq,
    messageId: value.messageId,
    payload: value.payload,
    final: value.final === true
  }), "Private relay frame does not satisfy the wire contract.");
}

export function createFrameAck(value: Record<string, unknown> = {}) {
  return created(parseFrameAck, envelope("frame-ack", {
    routeId: value.routeId,
    upToSeq: value.upToSeq
  }), "Private relay frame-ack does not satisfy the wire contract.");
}

export function createFrameStatus(value: Record<string, unknown> = {}) {
  return created(parseFrameStatus, envelope("frame-status", {
    routeId: value.routeId,
    messageId: value.messageId,
    state: value.state
  }), "Private relay frame-status does not satisfy the wire contract.");
}

export function createFlowCredit(value: Record<string, unknown> = {}) {
  return created(parseFlowCredit, envelope("flow-credit", {
    routeId: value.routeId,
    grantBytes: value.grantBytes,
    grantFrames: value.grantFrames
  }), "Private relay flow-credit does not satisfy the wire contract.");
}

export function createSessionClose(value: Record<string, unknown> = {}) {
  return created(parseSessionClose, envelope("session-close", {
    sessionId: value.sessionId,
    reason: value.reason,
    finalCursors: value.finalCursors
  }), "Private relay session-close does not satisfy the wire contract.");
}

export function createSessionReconnect(value: Record<string, unknown> = {}) {
  return created(parseSessionReconnect, envelope("session-reconnect", {
    previousSessionId: value.previousSessionId,
    admission: value.admission,
    lastAcknowledged: value.lastAcknowledged,
    reconnectGeneration: value.reconnectGeneration,
    clientNonce: value.clientNonce
  }), "Private relay session-reconnect does not satisfy the wire contract.");
}

export function createSessionRestored(value: Record<string, unknown> = {}) {
  return created(parseSessionRestored, envelope("session-restored", {
    sessionId: value.sessionId,
    reconnectGeneration: value.reconnectGeneration,
    gaps: value.gaps || [],
    limits: value.limits,
    cursors: value.cursors
  }), "Private relay session-restored does not satisfy the wire contract.");
}

export function encodePrivateRelayMessage(value?: unknown) {
  const parsed = parsePrivateRelayMessage(value);
  if (!parsed) return "";
  return JSON.stringify(parsed);
}

export function decodePrivateRelayMessage(value?: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return parsePrivateRelayMessage(JSON.parse(value));
  } catch {
    return null;
  }
}

export function createPrivateRelayPeer(peerId: unknown = "peer-a"): PrivateRelayPeer {
  const normalizedPeerId = opaqueId(peerId);
  if (normalizedPeerId === FAIL) {
    throw new TypeError("Neutral private relay peer requires a stable opaque identity.");
  }
  return Object.freeze({
    peerId: normalizedPeerId,
    encode: encodePrivateRelayMessage,
    decode: decodePrivateRelayMessage,
    validate: parsePrivateRelayMessage
  }) as PrivateRelayPeer;
}

function isPrivateRelayPeer(value: unknown): value is PrivateRelayPeer {
  return isPlainObject(value)
    && typeof value.encode === "function"
    && typeof value.decode === "function";
}

export function agreePrivateRelayPeers(left?: unknown, right?: unknown, message?: unknown) {
  if (!isPrivateRelayPeer(left) || !isPrivateRelayPeer(right)) return null;
  const encodedByLeft = left.encode(message);
  const encodedByRight = right.encode(message);
  if (!encodedByLeft || !encodedByRight) return null;
  const leftView = right.decode(encodedByLeft);
  const rightView = left.decode(encodedByRight);
  const leftEcho = left.decode(encodedByRight);
  const rightEcho = right.decode(encodedByLeft);
  if (!leftView || !rightView || !leftEcho || !rightEcho) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(rightView)) return null;
  if (JSON.stringify(leftEcho) !== JSON.stringify(rightEcho)) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(parsePrivateRelayMessage(message))) return null;
  return leftView;
}
