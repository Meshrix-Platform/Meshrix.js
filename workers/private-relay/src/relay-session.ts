/**
 * RelaySessionDO — the hibernating pair/session object for one
 * (tenantId, routeId) relay route.
 *
 * Accepted sockets use the WebSocket Hibernation API (`ctx.acceptWebSocket`),
 * so an idle admitted pair costs no active duration while sockets remain
 * open. Socket attachments carry only rebuildable routing tags (opaque ids,
 * role, mode, revisions); durable storage holds session/admission records and
 * throttled sequence-cursor checkpoints. Frame payload bytes are forwarded
 * verbatim and are never written to durable state or logs.
 *
 * Session admission authenticates the enrolled bearer credential at upgrade
 * time, then re-checks the tenant directory authority on session-open and on
 * every session-reconnect. Queue exhaustion is rejected *before* a frame is
 * accepted into the forwarding path; senders that keep flooding a full peer
 * queue are closed with `capacity_exceeded`.
 */

import { DurableObject } from "cloudflare:workers";

import type { PrivateRelayEnv } from "./env.ts";
import { RELAY_RUNTIME_LIMITS, RECOVERY_SESSION_LIMITS, integerEnv, mailboxPolicyFromEnv, metricsDurableEnabled } from "./env.ts";
import { jsonResponse, readBoundedJson } from "./http.ts";
import { directoryObjectName, mailboxObjectName, sha256Hex } from "./ids.ts";
import { RelayCounters } from "./metrics.ts";
import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_PEER_LIMITS,
  parsePrivateRelayMessage,
  encodePrivateRelayMessage,
  createSessionAdmitted,
  createSessionRejected,
  createSessionRestored,
  createSessionClose,
  createRouteStatus,
  createFlowCredit,
  parsePrivateRelayRecoveryMessage,
  recoveryChannelAdmitsOnlyRecovery,
  parsePrivateRelayPeerMessage,
  encodePrivateRelayPeerMessage,
  createPeerRetentionPolicy,
  createPeerStatus,
} from "../../../packages/contracts/src/private-relay/index.ts";

const META_KEY = "meta";
const SESSION_PREFIX = "sess:";
const ATTACHMENT_VERSION = 1;
const KNOWN_REJECT_REASONS = new Set([
  "identity_unknown",
  "identity_ambiguous",
  "mode_mismatch",
  "tenant_mismatch",
  "revoked",
  "stale_revocation_revision",
  "capacity_exceeded",
  "purpose_denied",
  "authority_stale",
]);
const CLOSE_PROTOCOL_ERROR = 4000;
const CLOSE_CAPACITY = 4001;
const CLOSE_REVOKED = 4003;
const CLOSE_IDLE = 4004;

interface SessionMeta {
  tenantId: string;
  routeId: string;
  /** Last accepted frame sequence per direction (durable checkpoint). */
  routeCursors: { toEndpoint: number; toEntry: number };
  revocationRevision: number;
  admissionGeneration: number;
}

interface SessionRecord {
  sessionId: string;
  deviceId: string;
  role: "entry" | "endpoint";
  mode: "personal" | "enterprise";
  purpose: "forward" | "recover_device";
  state: "admitted" | "streaming" | "closed";
  admittedGeneration: number;
  revocationRevision: number;
  reconnectGeneration: number;
  previousSessionId: string | null;
  createdAt: string;
  lastSeenAt: number;
}

/** Attachment payload: rebuildable routing tags only, never secrets. */
interface ConnAttachment {
  v: number;
  tenantId: string;
  routeId: string;
  deviceId: string;
  role: "entry" | "endpoint";
  mode: "personal" | "enterprise";
  phase: "pending" | "admitted";
  sessionId?: string;
  purpose?: "forward" | "recover_device";
  admittedGeneration?: number;
  revocationRevision?: number;
  reconnectGeneration?: number;
}

interface ConnState {
  ws: WebSocket;
  attachment: ConnAttachment;
  admitted: boolean;
  admitting: boolean;
  /** Token bucket for the inbound message rate limit. */
  rateTokens: number;
  rateRefillAt: number;
  /** Remaining send budget the relay granted this connection. */
  inboundCreditBytes: number;
  inboundCreditFrames: number;
  /** Frames this connection has been sent and has not yet acknowledged. */
  sentFrames: { seq: number; payloadBytes: number }[];
  outstandingBytes: number;
  dropsInRow: number;
  /** Highest mailbox position already pushed to this connection. */
  mailboxPushSeq: number;
  lastSeenAt: number;
}

interface WireLimits {
  maxFramePayloadBytes: number;
  maxOutstandingBytes: number;
  maxBufferedFrames: number;
  maxMessageRatePerSecond: number;
}

const FORWARD_LIMITS: WireLimits = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond,
};

function framePayloadBytes(base64url: string): number {
  // Unpadded base64url: n characters encode floor(n*3/4) bytes exactly.
  return Math.floor(base64url.length * 3 / 4);
}

export class RelaySessionDO extends DurableObject<PrivateRelayEnv> {
  private meta: SessionMeta | null = null;
  private sessions = new Map<string, SessionRecord>();
  private conns = new Map<WebSocket, ConnState>();
  private counters = new RelayCounters(undefined, { durable: metricsDurableEnabled(this.env) });
  private cursorsDirty = false;
  private cursorWriteChain: Promise<void> = Promise.resolve();
  private nextCursorCheckpointAt = 0;
  private lastRouteState: "reachable" | "unreachable" = "unreachable";

  constructor(ctx: DurableObjectState, env: PrivateRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.counters.count("storageReads", 3);
      const [meta, counters, sessionRecords] = await Promise.all([
        ctx.storage.get<SessionMeta>(META_KEY),
        ctx.storage.get("counters"),
        ctx.storage.list<SessionRecord>({ prefix: SESSION_PREFIX }),
      ]);
      if (meta) this.meta = meta;
      if (counters) this.counters = new RelayCounters(counters as Record<string, number>, { durable: metricsDurableEnabled(this.env) });
      const now = Date.now();
      for (const record of sessionRecords.values()) {
        this.sessions.set(record.sessionId, record);
      }
      // Rebuild connection state from hibernated sockets. Attachments carry
      // the routing tags needed to rejoin the in-memory forwarding tables.
      for (const ws of ctx.getWebSockets()) {
        const attachment = this.readAttachment(ws);
        if (!attachment) {
          try { ws.close(CLOSE_PROTOCOL_ERROR, "protocol_error"); } catch { /* already closed */ }
          continue;
        }
        this.conns.set(ws, this.freshConn(ws, attachment, now));
      }
      this.scheduleAlarm();
    });
  }

  private readAttachment(ws: WebSocket): ConnAttachment | null {
    try {
      const raw = ws.deserializeAttachment() as ConnAttachment | null;
      if (!raw || raw.v !== ATTACHMENT_VERSION) return null;
      if (typeof raw.tenantId !== "string" || typeof raw.routeId !== "string") return null;
      if (typeof raw.deviceId !== "string") return null;
      if (raw.role !== "entry" && raw.role !== "endpoint") return null;
      if (raw.mode !== "personal" && raw.mode !== "enterprise") return null;
      if (raw.phase !== "pending" && raw.phase !== "admitted") return null;
      return raw;
    } catch {
      return null;
    }
  }

  private freshConn(ws: WebSocket, attachment: ConnAttachment, now: number): ConnState {
    const session = attachment.sessionId ? this.sessions.get(attachment.sessionId) : undefined;
    const admitted = attachment.phase === "admitted" && !!session && session.state !== "closed";
    const limits = session?.purpose === "recover_device" ? RECOVERY_SESSION_LIMITS : FORWARD_LIMITS;
    return {
      ws,
      attachment,
      admitted,
      admitting: false,
      rateTokens: limits.maxMessageRatePerSecond,
      rateRefillAt: now,
      inboundCreditBytes: limits.maxOutstandingBytes,
      inboundCreditFrames: limits.maxBufferedFrames,
      sentFrames: [],
      outstandingBytes: 0,
      dropsInRow: 0,
      mailboxPushSeq: 0,
      lastSeenAt: now,
    };
  }

  // ------------------------------------------------------------------
  // Storage helpers (counted)
  // ------------------------------------------------------------------

  private async sget<T>(key: string): Promise<T | undefined> {
    this.counters.count("storageReads");
    return this.ctx.storage.get<T>(key);
  }

  private async sput(key: string, value: unknown): Promise<void> {
    this.counters.count("storageWrites");
    await this.ctx.storage.put(key, value);
  }

  private async flushCounters(): Promise<void> {
    this.counters.count("storageWrites");
    await this.counters.flush((key, value) => this.ctx.storage.put(key, value));
  }

  private persistCursorsSoon(): void {
    this.cursorsDirty = true;
    // Checkpoint at most once per interval, and only piggybacked on real
    // events (never a timer loop). Message frequency therefore never maps
    // to durable write frequency; an unflushed position after eviction is
    // reported as a typed `expired` gap on reconnect by design.
    const now = Date.now();
    if (now < this.nextCursorCheckpointAt) return;
    this.nextCursorCheckpointAt = now + RELAY_RUNTIME_LIMITS.cursorCheckpointMinIntervalMs;
    this.cursorWriteChain = this.cursorWriteChain
      .then(() => this.flushCursorCheckpoint())
      .catch(() => { /* durable loss recorded as gap on restore */ });
  }

  private async flushCursorCheckpoint(): Promise<void> {
    if (!this.cursorsDirty || !this.meta) return;
    this.cursorsDirty = false;
    await this.sput(META_KEY, this.meta);
    await this.flushCounters();
  }

  // ------------------------------------------------------------------
  // HTTP surface (router reach-in)
  // ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    this.counters.count("httpRequests");
    try {
      const url = new URL(request.url);
      if (url.pathname === "/session" && request.headers.get("upgrade") === "websocket") {
        return await this.handleUpgrade(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/apply-revocation") {
        return await this.handleApplyRevocation(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/counters") {
        await this.cursorWriteChain;
        return jsonResponse(this.counters.tieredSnapshot());
      }
      if (request.method === "GET" && url.pathname === "/internal/state") {
        return jsonResponse({
          sessions: [...this.sessions.values()],
          conns: [...this.conns.values()].map((conn) => ({
            deviceId: conn.attachment.deviceId,
            role: conn.attachment.role,
            admitted: conn.admitted,
            outstandingBytes: conn.outstandingBytes,
          })),
          routeCursors: this.meta?.routeCursors ?? null,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    } finally {
      await this.flushCounters();
    }
  }

  /**
   * Upgrade: authenticate the enrolled bearer credential, then attach a
   * hibernation-accepted socket carrying rebuildable routing tags only.
   */
  private async handleUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get("tenantId") ?? "";
    const routeId = url.searchParams.get("routeId") ?? "";
    const auth = request.headers.get("authorization") ?? "";
    const credential = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!tenantId || !routeId || !credential) {
      return jsonResponse({ error: "identity_unknown" }, 401);
    }
    this.counters.count("directoryChecks");
    const directoryId = this.env.RELAY_DIRECTORY.idFromName(directoryObjectName(tenantId));
    const directory = this.env.RELAY_DIRECTORY.get(directoryId);
    const lookup = await directory.fetch("http://directory/internal/credential-lookup", {
      method: "POST",
      body: JSON.stringify({ credentialDigest: await sha256Hex(credential) }),
    });
    const result = await lookup.json() as {
      ok: boolean;
      reason?: string;
      device?: { deviceId: string; routeId: string; role: "entry" | "endpoint"; mode: "personal" | "enterprise"; admissionGeneration: number };
    };
    if (!result.ok || !result.device) {
      return jsonResponse({ error: result.reason ?? "identity_unknown" }, 403);
    }
    if (result.device.routeId !== routeId) {
      return jsonResponse({ error: "tenant_mismatch" }, 403);
    }
    if (this.conns.size >= RELAY_RUNTIME_LIMITS.maxSocketsPerSessionObject) {
      return jsonResponse({ error: "capacity_exceeded" }, 429);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: ConnAttachment = {
      v: ATTACHMENT_VERSION,
      tenantId,
      routeId,
      deviceId: result.device.deviceId,
      role: result.device.role,
      mode: result.device.mode,
      phase: "pending",
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.conns.set(server, this.freshConn(server, attachment, Date.now()));
    this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleApplyRevocation(request: Request): Promise<Response> {
    const body = await readBoundedJson(request, 8_192) as Record<string, unknown> | null;
    if (!body || typeof body.revocationRevision !== "number") {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    if (this.meta) {
      this.meta.revocationRevision = Math.max(this.meta.revocationRevision, body.revocationRevision);
      await this.sput(META_KEY, this.meta);
    }
    const targetDevice = typeof body.deviceId === "string" ? body.deviceId : null;
    const routeRevoked = body.routeRevoked === true;
    const closed: string[] = [];
    for (const conn of [...this.conns.values()]) {
      if (!conn.admitted) continue;
      if (routeRevoked || (targetDevice && conn.attachment.deviceId === targetDevice)) {
        closed.push(conn.attachment.deviceId);
        this.closeConn(conn, "revoked", CLOSE_REVOKED);
      }
    }
    this.counters.count("sessionsRevoked", closed.length);
    return jsonResponse({ closed });
  }

  // ------------------------------------------------------------------
  // WebSocket events
  // ------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.counters.count("webSocketEvents");
    const conn = this.conns.get(ws);
    if (!conn) {
      try { ws.close(CLOSE_PROTOCOL_ERROR, "protocol_error"); } catch { /* closed */ }
      return;
    }
    conn.lastSeenAt = Date.now();
    if (typeof message !== "string") {
      this.counters.count("messagesIn");
      this.rejectOrDrop(conn);
      return;
    }
    const maxBytes = integerEnv(
      this.env.RELAY_MAX_SESSION_MESSAGE_BYTES,
      RELAY_RUNTIME_LIMITS.defaultMaxSessionMessageBytes,
      1_024,
      2 * 1024 * 1024,
    );
    this.counters.count("messagesIn");
    this.counters.count("bytesIn", message.length);
    if (message.length > maxBytes) {
      this.closeConn(conn, "capacity_exceeded", CLOSE_CAPACITY);
      return;
    }
    if (!this.consumeRateToken(conn)) {
      this.counters.count("rateLimitDrops");
      this.rejectOrDrop(conn);
      return;
    }
    // Parse the JSON text exactly once; both wire parsers consume the same
    // object so recovery-channel kinds never pay a second parse.
    const rawParsed = safeJson(message);
    const parsed = rawParsed === null ? null : parsePrivateRelayMessage(rawParsed);
    const kind = (parsed as { kind?: string } | null)?.kind ?? null;
    if (!conn.admitted) {
      await this.handlePendingMessage(conn, kind, parsed);
      return;
    }
    await this.handleAdmittedMessage(conn, kind, parsed, message, rawParsed);
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.counters.count("webSocketEvents");
    const conn = this.conns.get(ws);
    this.conns.delete(ws);
    if (conn?.admitted && conn.attachment.sessionId) {
      const session = this.sessions.get(conn.attachment.sessionId);
      if (session && session.state !== "closed") {
        session.state = "closed";
        this.counters.count("sessionsClosed");
        this.cursorsDirty = true;
        await this.sput(`${SESSION_PREFIX}${session.sessionId}`, session);
        // A socket close is a bounded transition: flush the cursor edge.
        await this.flushCursorCheckpoint();
        this.notifyRouteStateChange();
      }
    }
    this.scheduleAlarm();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.counters.count("webSocketEvents");
    await this.webSocketClose(ws, 1011, "error", false);
  }

  // ------------------------------------------------------------------
  // Admission (pre-session)
  // ------------------------------------------------------------------

  private async handlePendingMessage(
    conn: ConnState,
    kind: string | null,
    parsed: unknown,
  ): Promise<void> {
    if (conn.admitting) {
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (kind === "session-open" || kind === "session-reconnect") {
      conn.admitting = true;
      try {
        await this.admit(conn, kind, parsed as Record<string, unknown>);
      } finally {
        conn.admitting = false;
      }
      return;
    }
    // Anything else before admission is a protocol violation.
    this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
  }

  private async admit(conn: ConnState, kind: "session-open" | "session-reconnect", message: Record<string, unknown>): Promise<void> {
    const admission = (message as { admission?: Record<string, unknown> }).admission;
    const identity = conn.attachment;
    const reject = (reason: string, expectedRevocationRevision = 0, retryable = false): void => {
      this.counters.count("sessionsRejected");
      this.sendMessage(conn, encodePrivateRelayMessage(createSessionRejected({ reason, expectedRevocationRevision, retryable })));
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
    };

    if (!admission) return reject("identity_unknown");
    // The presented binding must equal the credential-authenticated identity.
    if (admission.tenantId !== identity.tenantId
      || admission.routeId !== identity.routeId
      || admission.deviceId !== identity.deviceId
      || admission.role !== identity.role) {
      return reject("tenant_mismatch");
    }
    if (admission.mode !== identity.mode) {
      return reject("mode_mismatch");
    }
    const presentedRevision = typeof admission.revocationRevision === "number" ? admission.revocationRevision : -1;
    this.counters.count("directoryChecks");
    const directory = this.env.RELAY_DIRECTORY.get(this.env.RELAY_DIRECTORY.idFromName(directoryObjectName(identity.tenantId)));
    const check = await directory.fetch("http://directory/internal/admission-check", {
      method: "POST",
      body: JSON.stringify({
        deviceId: identity.deviceId,
        routeId: identity.routeId,
        role: identity.role,
        mode: identity.mode,
        revocationRevision: presentedRevision,
      }),
    });
    const result = await check.json() as {
      ok: boolean;
      reason?: string;
      expectedRevocationRevision?: number;
      retryable?: boolean;
      admissionGeneration?: number;
      revocationRevision?: number;
    };
    if (!result.ok) {
      const reason = KNOWN_REJECT_REASONS.has(result.reason ?? "") ? result.reason! : "identity_unknown";
      return reject(reason, result.expectedRevocationRevision ?? 0, result.retryable === true);
    }

    let purposeFinal: "forward" | "recover_device" =
      (message as { purpose?: string }).purpose === "recover_device" ? "recover_device" : "forward";

    let reconnectGeneration = 1;
    let previousSessionId: string | null = null;
    let gaps: { fromSeq: number; toSeq: number; cause: "expired" }[] = [];
    if (kind === "session-reconnect") {
      previousSessionId = (message as { previousSessionId?: string }).previousSessionId ?? null;
      const previous = previousSessionId ? this.sessions.get(previousSessionId) : undefined;
      if (!previous || previous.deviceId !== identity.deviceId) {
        return reject("identity_unknown", result.revocationRevision ?? 0);
      }
      // session-reconnect carries no purpose: inherit the previous binding.
      purposeFinal = previous.purpose;
      const claimed = (message as { reconnectGeneration?: number }).reconnectGeneration ?? 0;
      if (claimed <= previous.reconnectGeneration) {
        return reject("authority_stale", result.revocationRevision ?? 0, true);
      }
      reconnectGeneration = claimed;
      previous.state = "closed";
      this.counters.count("storageWrites");
      await this.ctx.storage.put(`${SESSION_PREFIX}${previous.sessionId}`, previous);
      const lastAcked = (message as { lastAcknowledged?: { toEndpoint?: number; toEntry?: number } }).lastAcknowledged;
      const cursors = this.meta?.routeCursors ?? { toEndpoint: 0, toEntry: 0 };
      if (lastAcked) {
        if (typeof lastAcked.toEndpoint === "number" && cursors.toEndpoint > lastAcked.toEndpoint) {
          gaps.push({ fromSeq: lastAcked.toEndpoint + 1, toSeq: cursors.toEndpoint, cause: "expired" });
        }
        if (typeof lastAcked.toEntry === "number" && cursors.toEntry > lastAcked.toEntry) {
          gaps.push({ fromSeq: lastAcked.toEntry + 1, toSeq: cursors.toEntry, cause: "expired" });
        }
      }
    }

    const now = Date.now();
    const sessionId = `sess.${crypto.randomUUID()}`;
    const record: SessionRecord = {
      sessionId,
      deviceId: identity.deviceId,
      role: identity.role,
      mode: identity.mode,
      purpose: purposeFinal,
      state: "admitted",
      admittedGeneration: result.admissionGeneration ?? 1,
      revocationRevision: result.revocationRevision ?? 0,
      reconnectGeneration,
      previousSessionId,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: now,
    };
    if (!this.meta) {
      this.meta = {
        tenantId: identity.tenantId,
        routeId: identity.routeId,
        routeCursors: { toEndpoint: 0, toEntry: 0 },
        revocationRevision: result.revocationRevision ?? 0,
        admissionGeneration: result.admissionGeneration ?? 1,
      };
    }
    this.meta.revocationRevision = result.revocationRevision ?? this.meta.revocationRevision;
    this.sessions.set(sessionId, record);
    this.pruneSessionRecords();
    this.counters.count("storageWrites", 2);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(META_KEY, this.meta);
      await txn.put(`${SESSION_PREFIX}${sessionId}`, record);
    });
    await this.flushCounters();

    // Supersede any earlier admitted connection for the same device+role.
    for (const other of this.conns.values()) {
      if (other !== conn && other.admitted && other.attachment.deviceId === identity.deviceId && other.attachment.role === identity.role) {
        this.closeConn(other, "reconnect", CLOSE_PROTOCOL_ERROR);
      }
    }

    conn.admitted = true;
    conn.attachment = {
      ...identity,
      phase: "admitted",
      sessionId,
      purpose: purposeFinal,
      admittedGeneration: record.admittedGeneration,
      revocationRevision: record.revocationRevision,
      reconnectGeneration,
    };
    conn.ws.serializeAttachment(conn.attachment);
    const limits = purposeFinal === "recover_device" ? RECOVERY_SESSION_LIMITS : FORWARD_LIMITS;
    conn.inboundCreditBytes = limits.maxOutstandingBytes;
    conn.inboundCreditFrames = limits.maxBufferedFrames;
    conn.rateTokens = limits.maxMessageRatePerSecond;

    const routeState = this.endpointAttached() ? "reachable" : "unreachable";
    this.counters.count("sessionsAdmitted");
    if (kind === "session-open") {
      this.sendMessage(conn, encodePrivateRelayMessage(createSessionAdmitted({
        sessionId,
        purpose: purposeFinal,
        admittedGeneration: record.admittedGeneration,
        revocationRevision: record.revocationRevision,
        routeState,
        limits,
        reconnectGeneration,
        cursors: { ...this.meta.routeCursors },
        serverNonce: `sn.${sessionId.slice(-16)}relaynonce`,
      })));
    } else {
      this.counters.count("sessionsRestored");
      this.sendMessage(conn, encodePrivateRelayMessage(createSessionRestored({
        sessionId,
        reconnectGeneration,
        gaps,
        limits,
        cursors: { ...this.meta.routeCursors },
      })));
    }
    // The peer mailbox policy advertisement travels with (re)admission on
    // forward sessions — the enrollment-time carrier the wire contract
    // designates, so a device learns the finite retention bounds before it
    // ever opens its mailbox.
    if (purposeFinal === "forward") this.pushMailboxPolicy(conn);
    // The newly admitted socket already learned the route state in-band;
    // only peers need a change notice.
    this.notifyRouteStateChange(conn);
  }

  // ------------------------------------------------------------------
  // Admitted message dispatch
  // ------------------------------------------------------------------

  private async handleAdmittedMessage(
    conn: ConnState,
    kind: string | null,
    parsed: unknown,
    raw: string,
    rawParsed: unknown,
  ): Promise<void> {
    const purpose = conn.attachment.purpose ?? "forward";
    if (!kind) {
      // Peer mailbox kinds are not session-wire messages either; they are
      // request/response over the same admitted channel and are dispatched
      // to the per-recipient MailboxDO — never forwarded peer-to-peer.
      const peer = rawParsed === null ? null : parsePrivateRelayPeerMessage(rawParsed);
      const peerKind = (peer as { kind?: string } | null)?.kind ?? null;
      if (peerKind) {
        if (purpose !== "forward") {
          // A recovery-purpose channel must never carry mailbox traffic.
          this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
          return;
        }
        await this.handlePeerMessage(conn, peerKind, peer as Record<string, unknown>);
        return;
      }
      // Recovery-channel kinds are not session-wire messages.
      const recovery = rawParsed === null ? null : parsePrivateRelayRecoveryMessage(rawParsed);
      const recoveryKind = (recovery as { kind?: string } | null)?.kind ?? null;
      if (recoveryKind && purpose === "recover_device" && recoveryChannelAdmitsOnlyRecovery(recoveryKind, purpose)) {
        this.forwardOpaque(conn, raw, recoveryKind);
        return;
      }
      this.rejectOrDrop(conn);
      return;
    }
    if (purpose === "recover_device" && !recoveryChannelAdmitsOnlyRecovery(kind, purpose)) {
      // A recovery-purpose session must never carry forwarding frames.
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
      return;
    }
    switch (kind) {
      case "frame":
        this.handleFrame(conn, parsed as { sessionId: string; routeId: string; seq: number; messageId: string; payload: string }, raw);
        return;
      case "frame-ack":
        this.handleFrameAck(conn, parsed as { routeId: string; upToSeq: number });
        return;
      case "route-bind":
      case "route-query":
        this.handleRouteQuery(conn, parsed as { routeId: string });
        return;
      case "session-close":
        await this.handleSessionClose(conn, parsed as { sessionId: string; reason: string; finalCursors?: unknown });
        return;
      case "flow-credit":
      case "frame-status":
      case "session-admitted":
      case "session-rejected":
      case "session-restored":
      case "route-status":
        // Relay-originated kinds on the client direction: dropped, counted.
        this.rejectOrDrop(conn);
        return;
      case "session-open":
      case "session-reconnect":
        this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
        return;
      default:
        this.rejectOrDrop(conn);
        return;
    }
  }

  // ------------------------------------------------------------------
  // Peer mailbox dispatch (request/response on the admitted channel)
  // ------------------------------------------------------------------

  /**
   * The deployment's finite mailbox retention policy, advertised at
   * admission and re-served on `peer-retention-policy` pulls so a client
   * that missed the push can recover it without polling storage.
   */
  private pushMailboxPolicy(conn: ConnState): void {
    this.sendMessage(conn, encodePrivateRelayPeerMessage(createPeerRetentionPolicy({
      routeId: conn.attachment.routeId,
      deviceId: conn.attachment.deviceId,
      ...mailboxPolicyFromEnv(this.env),
    })));
  }

  /**
   * Resolve this device's paired route peer through the tenant directory —
   * the same admission authority the mailbox consults. Returns null when
   * the route has no second enrolled device or the pairing is broken.
   */
  private async routePeerDeviceId(attachment: ConnAttachment): Promise<string | null> {
    this.counters.count("directoryChecks");
    const directory = this.env.RELAY_DIRECTORY.get(
      this.env.RELAY_DIRECTORY.idFromName(directoryObjectName(attachment.tenantId)),
    );
    const response = await directory.fetch("http://directory/internal/route-peer", {
      method: "POST",
      body: JSON.stringify({ routeId: attachment.routeId, deviceId: attachment.deviceId }),
    });
    const result = await response.json() as { ok?: boolean; peerDeviceId?: string | null };
    return result.ok === true && typeof result.peerDeviceId === "string" ? result.peerDeviceId : null;
  }

  /**
   * Forward one peer wire request to its owning mailbox partition and relay
   * the typed response on the same connection. The stamped admission is the
   * credential-authenticated session identity — the mailbox re-checks the
   * binding against it and the directory, so a message claiming a foreign
   * tenantId/routeId/deviceId is refused as a protocol violation.
   */
  private async handlePeerMessage(conn: ConnState, kind: string, message: Record<string, unknown>): Promise<void> {
    const identity = conn.attachment;
    // `peer-retention-policy` is mailbox→device shaped (no tenantId); every
    // other request kind binds the full session identity exactly.
    if (message.routeId !== identity.routeId
      || message.deviceId !== identity.deviceId
      || (kind !== "peer-retention-policy" && message.tenantId !== identity.tenantId)) {
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (kind === "peer-retention-policy") {
      // Pull fallback for the admission-time advertisement.
      this.pushMailboxPolicy(conn);
      return;
    }

    let ownerDeviceId: string;
    if (kind === "peer-send" || kind === "peer-bundle-fetch") {
      ownerDeviceId = message.peerDeviceId as string;
    } else if (kind === "peer-receipt") {
      // Receipt status lives in the recipient partition — the paired peer.
      const peerDeviceId = await this.routePeerDeviceId(identity);
      if (!peerDeviceId) {
        // No paired peer: every queried send is honestly unknown.
        this.sendMessage(conn, encodePrivateRelayPeerMessage(createPeerStatus({
          routeId: identity.routeId,
          deviceId: identity.deviceId,
          statuses: (message.messageIds as string[]).map((messageId) => ({
            messageId, position: 0, receipts: [],
          })),
        })));
        return;
      }
      ownerDeviceId = peerDeviceId;
    } else {
      // bundle-publish / fetch / ack operate on the caller's own partition.
      ownerDeviceId = identity.deviceId;
    }

    const stub = this.env.RELAY_MAILBOX.get(
      this.env.RELAY_MAILBOX.idFromName(mailboxObjectName(identity.tenantId, identity.routeId, ownerDeviceId)),
    );
    const response = await stub.fetch("http://mailbox.internal/internal/peer", {
      method: "POST",
      body: JSON.stringify({
        admission: {
          tenantId: identity.tenantId,
          routeId: identity.routeId,
          deviceId: identity.deviceId,
          role: identity.role,
          revocationRevision: identity.revocationRevision ?? 0,
          admissionGeneration: identity.admittedGeneration ?? 0,
          sessionId: identity.sessionId ?? "",
        },
        message,
      }),
    });
    const outcome = await response.json() as {
      ok?: boolean;
      drop?: boolean;
      response?: Record<string, unknown>;
    };
    if (outcome.ok !== true || outcome.drop === true || !outcome.response) return;
    const encoded = encodePrivateRelayPeerMessage(outcome.response);
    this.sendMessage(conn, encoded);

    if (kind === "peer-send" && outcome.response.outcome === "accepted") {
      // Event-driven wakeup: a newly durably stored envelope is pushed to
      // the recipient's live session; pull via peer-fetch remains the
      // supported fallback for a disconnected or lagging recipient.
      await this.notifyMailboxPeer(conn, message.peerDeviceId as string);
    }
    if (kind === "peer-fetch" && typeof outcome.response.nextAfterSeq === "number") {
      conn.mailboxPushSeq = Math.max(conn.mailboxPushSeq, outcome.response.nextAfterSeq);
    }
  }

  /**
   * Push the next mailbox page to the recipient's live connection after a
   * committed send. Uses the recipient's own admitted-session stamp; a
   * recipient without a live socket simply pulls on its next fetch.
   */
  private async notifyMailboxPeer(sender: ConnState, recipientDeviceId: string): Promise<void> {
    for (const other of this.conns.values()) {
      if (other === sender || !other.admitted || other.attachment.deviceId !== recipientDeviceId) continue;
      const identity = other.attachment;
      const stub = this.env.RELAY_MAILBOX.get(
        this.env.RELAY_MAILBOX.idFromName(mailboxObjectName(identity.tenantId, identity.routeId, recipientDeviceId)),
      );
      const response = await stub.fetch("http://mailbox.internal/internal/peer", {
        method: "POST",
        body: JSON.stringify({
          admission: {
            tenantId: identity.tenantId,
            routeId: identity.routeId,
            deviceId: identity.deviceId,
            role: identity.role,
            revocationRevision: identity.revocationRevision ?? 0,
            admissionGeneration: identity.admittedGeneration ?? 0,
            sessionId: identity.sessionId ?? "",
          },
          message: {
            schemaVersion: "v0.0.1:private-relay:peer-1",
            wireProtocol: "meshrix-private-relay/0",
            kind: "peer-fetch",
            tenantId: identity.tenantId,
            routeId: identity.routeId,
            deviceId: identity.deviceId,
            afterSeq: other.mailboxPushSeq,
            limit: PRIVATE_RELAY_PEER_LIMITS.maxPageMessages,
          },
        }),
      });
      const outcome = await response.json() as {
        ok?: boolean;
        drop?: boolean;
        response?: Record<string, unknown> & { nextAfterSeq?: number; messages?: unknown[]; gaps?: unknown[] };
      };
      if (outcome.ok !== true || outcome.drop === true || !outcome.response) return;
      const page = outcome.response;
      const delivered = (page.messages?.length ?? 0) > 0 || (page.gaps?.length ?? 0) > 0;
      if (delivered) {
        this.sendMessage(other, encodePrivateRelayPeerMessage(page));
      }
      if (typeof page.nextAfterSeq === "number") {
        other.mailboxPushSeq = Math.max(other.mailboxPushSeq, page.nextAfterSeq);
      }
      return;
    }
  }

  /** Forward an opaque recovery message to the opposite-role connection. */
  private forwardOpaque(conn: ConnState, raw: string, kind: string): void {
    const peer = this.peerOf(conn);
    if (!peer) {
      this.counters.count("framesDropped");
      this.sendMessage(conn, encodePrivateRelayMessage(createRouteStatus({
        routeId: conn.attachment.routeId,
        state: "unreachable",
        generation: this.meta?.admissionGeneration ?? 1,
      })));
      return;
    }
    // Recovery messages carry no transport acks, so there is no honest way
    // to release an outstanding-byte budget — a cumulative counter would
    // only wedge a live recovery exchange. The bound here is per message,
    // plus the inbound rate limit and session-level socket caps.
    if (raw.length > RECOVERY_SESSION_LIMITS.maxOutstandingBytes) {
      this.rejectOrDrop(conn);
      return;
    }
    peer.ws.send(raw);
    this.counters.count("messagesOut");
    this.counters.count("bytesOut", raw.length);
    if (kind === "recovery-request" || kind === "recovery-proof") {
      this.counters.count("framesForwarded");
    }
  }

  private handleFrame(
    conn: ConnState,
    frame: { sessionId: string; routeId: string; seq: number; messageId: string; payload: string },
    raw: string,
  ): void {
    if (frame.sessionId !== conn.attachment.sessionId || frame.routeId !== this.meta?.routeId) {
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
      return;
    }
    const direction = conn.attachment.role === "entry" ? "toEndpoint" : "toEntry";
    const cursor = this.meta!.routeCursors[direction];
    if (frame.seq <= cursor) {
      // Replay or duplicate: dropped without acknowledgement.
      this.counters.count("framesDropped");
      return;
    }
    const peer = this.peerOf(conn);
    if (!peer) {
      this.counters.count("framesDropped");
      this.sendMessage(conn, encodePrivateRelayMessage(createRouteStatus({
        routeId: conn.attachment.routeId,
        state: "unreachable",
        generation: this.meta!.admissionGeneration,
      })));
      return;
    }
    const payloadBytes = framePayloadBytes(frame.payload);
    const limits = FORWARD_LIMITS;
    if (payloadBytes > limits.maxFramePayloadBytes) {
      this.closeConn(conn, "capacity_exceeded", CLOSE_CAPACITY);
      return;
    }
    // Reject queue exhaustion BEFORE accepting the frame into the path.
    if (peer.outstandingBytes + payloadBytes > limits.maxOutstandingBytes
      || peer.sentFrames.length >= limits.maxBufferedFrames) {
      this.rejectOrDrop(conn);
      return;
    }
    if (conn.inboundCreditBytes < payloadBytes || conn.inboundCreditFrames < 1) {
      this.rejectOrDrop(conn);
      return;
    }
    conn.inboundCreditBytes -= payloadBytes;
    conn.inboundCreditFrames -= 1;
    conn.dropsInRow = 0;
    peer.outstandingBytes += payloadBytes;
    peer.sentFrames.push({ seq: frame.seq, payloadBytes });
    peer.ws.send(raw);
    this.counters.count("messagesOut");
    this.counters.count("bytesOut", raw.length);
    this.counters.count("framesForwarded");
    this.meta!.routeCursors[direction] = frame.seq;
    this.persistCursorsSoon();
    const session = this.sessions.get(conn.attachment.sessionId!);
    if (session && session.state === "admitted") {
      session.state = "streaming";
      this.cursorWriteChain = this.cursorWriteChain.then(() => this.sput(`${SESSION_PREFIX}${session.sessionId}`, session)).catch(() => {});
    }
    this.notifyRouteStateChange();
  }

  private handleFrameAck(conn: ConnState, ack: { routeId: string; upToSeq: number }): void {
    if (ack.routeId !== this.meta?.routeId) {
      this.rejectOrDrop(conn);
      return;
    }
    const acknowledged = conn.sentFrames.filter((frame) => frame.seq <= ack.upToSeq);
    if (acknowledged.length === 0 && ack.upToSeq > 0 && conn.sentFrames.length > 0) {
      // Ack references a sequence we never sent — protocol violation.
      this.closeConn(conn, "protocol_error", CLOSE_PROTOCOL_ERROR);
      return;
    }
    let releasedBytes = 0;
    for (const frame of acknowledged) releasedBytes += frame.payloadBytes;
    conn.sentFrames = conn.sentFrames.filter((frame) => frame.seq > ack.upToSeq);
    conn.outstandingBytes = Math.max(0, conn.outstandingBytes - releasedBytes);
    const peer = this.peerOf(conn);
    if (peer && releasedBytes > 0) {
      peer.inboundCreditBytes = Math.min(
        (conn.attachment.purpose === "recover_device" ? RECOVERY_SESSION_LIMITS : FORWARD_LIMITS).maxOutstandingBytes,
        peer.inboundCreditBytes + releasedBytes,
      );
      peer.inboundCreditFrames = Math.min(
        FORWARD_LIMITS.maxBufferedFrames,
        peer.inboundCreditFrames + acknowledged.length,
      );
      this.counters.count("flowCreditsGranted");
      this.sendMessage(peer, encodePrivateRelayMessage(createFlowCredit({
        routeId: ack.routeId,
        grantBytes: releasedBytes,
        grantFrames: acknowledged.length,
      })));
    }
    this.persistCursorsSoon();
  }

  private handleRouteQuery(conn: ConnState, query: { routeId: string }): void {
    if (query.routeId !== this.meta?.routeId) {
      this.rejectOrDrop(conn);
      return;
    }
    this.sendMessage(conn, encodePrivateRelayMessage(createRouteStatus({
      routeId: query.routeId,
      state: this.endpointAttached() ? "reachable" : "unreachable",
      generation: this.meta.admissionGeneration,
    })));
  }

  private async handleSessionClose(conn: ConnState, close: { sessionId: string; reason: string }): Promise<void> {
    const session = conn.attachment.sessionId ? this.sessions.get(conn.attachment.sessionId) : undefined;
    if (session) {
      session.state = "closed";
      this.counters.count("sessionsClosed");
      this.cursorsDirty = true;
      await this.sput(`${SESSION_PREFIX}${session.sessionId}`, session);
      await this.flushCursorCheckpoint();
    }
    this.closeConn(conn, "normal", 1000);
    this.notifyRouteStateChange();
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private peerOf(conn: ConnState): ConnState | null {
    const peerRole = conn.attachment.role === "entry" ? "endpoint" : "entry";
    for (const other of this.conns.values()) {
      if (other !== conn && other.admitted && other.attachment.role === peerRole) return other;
    }
    return null;
  }

  private endpointAttached(): boolean {
    for (const conn of this.conns.values()) {
      if (conn.admitted && conn.attachment.role === "endpoint") return true;
    }
    return false;
  }

  private notifyRouteStateChange(exclude?: ConnState): void {
    const state = this.endpointAttached() ? "reachable" : "unreachable";
    // A notice is only useful on a real reachability transition; repeating
    // the current state on every frame/close wastes wire messages.
    if (state === this.lastRouteState) return;
    this.lastRouteState = state;
    const message = encodePrivateRelayMessage(createRouteStatus({
      routeId: this.meta?.routeId ?? "route.unknown",
      state,
      generation: this.meta?.admissionGeneration ?? 1,
    }));
    for (const conn of this.conns.values()) {
      if (conn.admitted && conn !== exclude) this.sendMessage(conn, message);
    }
  }

  private consumeRateToken(conn: ConnState): boolean {
    const now = Date.now();
    const limits = conn.attachment.purpose === "recover_device" ? RECOVERY_SESSION_LIMITS : FORWARD_LIMITS;
    const refill = ((now - conn.rateRefillAt) / 1000) * limits.maxMessageRatePerSecond;
    if (refill >= 1) {
      conn.rateTokens = Math.min(limits.maxMessageRatePerSecond, conn.rateTokens + refill);
      conn.rateRefillAt = now;
    }
    if (conn.rateTokens < 1) return false;
    conn.rateTokens -= 1;
    return true;
  }

  /** Drop before acceptance; close the sender after sustained flooding. */
  private rejectOrDrop(conn: ConnState): void {
    conn.dropsInRow += 1;
    this.counters.count("framesDropped");
    if (conn.dropsInRow >= RELAY_RUNTIME_LIMITS.maxConsecutiveBackpressureDrops) {
      this.closeConn(conn, "capacity_exceeded", CLOSE_CAPACITY);
    }
  }

  private sendMessage(conn: ConnState, encoded: string): void {
    if (!encoded) return;
    try {
      conn.ws.send(encoded);
      this.counters.count("messagesOut");
      this.counters.count("bytesOut", encoded.length);
    } catch {
      // Socket already closed.
    }
  }

  private closeConn(conn: ConnState, reason: string, code: number): void {
    try {
      if (conn.admitted) {
        this.sendMessage(conn, encodePrivateRelayMessage(createSessionClose({
          sessionId: conn.attachment.sessionId ?? "sess.unknown",
          reason,
          finalCursors: { ...(this.meta?.routeCursors ?? { toEndpoint: 0, toEntry: 0 }) },
        })));
      }
      conn.ws.close(code, reason.slice(0, 120));
    } catch { /* already closed */ }
    if (conn.attachment.sessionId) {
      const session = this.sessions.get(conn.attachment.sessionId);
      if (session && session.state !== "closed") {
        session.state = "closed";
        this.counters.count("sessionsClosed");
        this.cursorWriteChain = this.cursorWriteChain.then(() => this.sput(`${SESSION_PREFIX}${session.sessionId}`, session)).catch(() => {});
      }
    }
    this.conns.delete(conn.ws);
    this.notifyRouteStateChange();
  }

  private pruneSessionRecords(): void {
    const closed = [...this.sessions.values()].filter((s) => s.state === "closed");
    if (this.sessions.size <= RELAY_RUNTIME_LIMITS.maxSessionRecordsPerRoute) return;
    const pruneCount = this.sessions.size - RELAY_RUNTIME_LIMITS.maxSessionRecordsPerRoute;
    const toPrune = closed.slice(0, pruneCount);
    for (const record of toPrune) {
      this.sessions.delete(record.sessionId);
      this.cursorWriteChain = this.cursorWriteChain.then(async () => {
        this.counters.count("storageDeletes");
        await this.ctx.storage.delete(`${SESSION_PREFIX}${record.sessionId}`);
      }).catch(() => {});
    }
  }

  /**
   * Only pending (pre-admission) sockets expire: an admitted socket
   * hibernates at zero active-duration cost while silent, so closing a
   * healthy idle stream would only buy reconnection churn. Revocation and
   * explicit session-close remain the live-socket termination paths.
   */
  private scheduleAlarm(): void {
    let earliest: number | null = null;
    const now = Date.now();
    for (const conn of this.conns.values()) {
      if (conn.admitted) continue;
      const expiry = conn.lastSeenAt + RELAY_RUNTIME_LIMITS.pendingSocketTimeoutMs;
      if (earliest === null || expiry < earliest) earliest = expiry;
    }
    if (earliest === null) return;
    this.ctx.storage.setAlarm(Math.max(earliest, now + 1)).catch(() => {});
  }

  async alarm(): Promise<void> {
    this.counters.count("alarmRuns");
    const now = Date.now();
    for (const conn of [...this.conns.values()]) {
      if (conn.admitted) continue;
      if (now >= conn.lastSeenAt + RELAY_RUNTIME_LIMITS.pendingSocketTimeoutMs) {
        this.closeConn(conn, "idle_timeout", CLOSE_IDLE);
      }
    }
    this.pruneSessionRecords();
    await this.cursorWriteChain;
    await this.flushCursorCheckpoint();
    await this.flushCounters();
    this.scheduleAlarm();
  }

  /** Test hook: mark every connection last-seen at epoch for alarm checks. */
  __testForceIdleAll(): void {
    for (const conn of this.conns.values()) conn.lastSeenAt = 0;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
