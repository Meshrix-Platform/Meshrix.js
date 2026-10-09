import {
  PRIVATE_RELAY_CLOSE_REASONS,
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SESSION_STATES,
  acknowledgeFrames,
  admitOutboundFrame,
  createFrame,
  createFrameAck,
  createRouteBind,
  createRouteQuery,
  createSessionClose,
  createSessionOpen,
  createSessionReconnect,
  endpointReachabilityForNewWork,
  parsePrivateRelayMessage,
  relaySessionTransition
} from "@meshrix/contracts/private-relay";

/**
 * Endpoint-side relay session driver.
 *
 * Owns the wire-level session lifecycle over a caller-supplied transport:
 * session-open/admission, bounded opaque frame pumping with explicit
 * backpressure accounting, route queries, and close/reconnect with cursor
 * bookkeeping. It never interprets frame payloads — plaintext and channel
 * semantics belong to the inner channel and the gateway kernel.
 *
 * Transport contract: `send` receives contract message objects; the transport
 * serializes them (the relay wire is JSON text). `onMessage` must feed
 * already-deserialized objects back into the driver.
 */
export interface RelayTransportPort {
  send(message: Readonly<Record<string, unknown>>): void;
  close(): void;
}

export interface RelaySessionHandlers {
  /**
   * Inbound opaque frame payload (base64url) destined for the inner channel.
   * Must return true only when the payload was durably accepted by the inner
   * channel buffer; false keeps the frame queued and withholds its ack.
   */
  onFrame?(payload: string, messageId: string): boolean;
  /** Session admitted; carries relay-issued limits and cursors. */
  onAdmitted?(admission: Readonly<Record<string, unknown>>): void;
  /** Session rejected by the relay; carries the typed reason. */
  onRejected?(reason: string, retryable: boolean): void;
  /** Peer channel closed; `reconnect` means the contract allows a new generation session. */
  onClosed?(reason: string, cursors: Readonly<Record<string, unknown>>): void;
  /** Route status change: state is reachable | unreachable | draining. */
  onRouteStatus?(routeId: string, state: string, generation: number): void;
}

export interface RelayAdmissionInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly routeId: string;
  readonly role: string;
  readonly mode: string;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
}

export type RelaySessionState = typeof PRIVATE_RELAY_SESSION_STATES[number];
export type PrivateRelayCloseReason = typeof PRIVATE_RELAY_CLOSE_REASONS[number];

export interface OutboundFrameResult {
  readonly accepted: boolean;
  readonly reason?: "backpressure" | "payload_too_large" | "not_streaming" | "invalid_message";
}

const DEFAULT_LIMITS = PRIVATE_RELAY_LIMITS;

export class PrivateRelaySession {
  readonly #transport: RelayTransportPort;
  readonly #handlers: RelaySessionHandlers;
  readonly #admission: RelayAdmissionInput;
  readonly #purpose: "forward" | "recover_device";
  readonly #nonceFactory: () => string;
  #state: RelaySessionState = "initiated";
  #limits: typeof DEFAULT_LIMITS = DEFAULT_LIMITS;
  #accounting: Readonly<{ outstandingBytes: number; outstandingFrames: number }> = Object.freeze({ outstandingBytes: 0, outstandingFrames: 0 });
  #sentFrames: Array<{ seq: number; payloadBytes: number }> = [];
  /** Inbound frames accepted by the wire but not yet deliverable to the inner channel; acks are withheld until delivered. */
  #pendingInbound: Array<{ seq: number; messageId: string; payload: string }> = [];
  #nextSeq = 1;
  #sessionId: string | null = null;
  #reconnectGeneration = 0;
  #cursors: { toEndpoint: number; toEntry: number } = Object.freeze({ toEndpoint: 0, toEntry: 0 });
  #routeState = "unreachable";

  constructor(options: {
    transport: RelayTransportPort;
    admission: RelayAdmissionInput;
    purpose?: "forward" | "recover_device";
    handlers?: RelaySessionHandlers;
    nonceFactory?: () => string;
  }) {
    this.#transport = options.transport;
    this.#handlers = options.handlers ?? {};
    this.#admission = options.admission;
    this.#purpose = options.purpose ?? "forward";
    this.#nonceFactory = options.nonceFactory ?? (() => `nonce.${Math.random().toString(36).slice(2)}.${Date.now().toString(36)}`);
  }

  get state(): RelaySessionState {
    return this.#state;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get routeState(): string {
    return this.#routeState;
  }

  get reconnectGeneration(): number {
    return this.#reconnectGeneration;
  }

  /** True when a new call can be submitted; false maps to endpoint_unreachable for callers. */
  get acceptsNewWork(): boolean {
    return endpointReachabilityForNewWork(this.#routeState) === "reachable"
      && (this.#state === "admitted" || this.#state === "streaming");
  }

  #transition(event: string): boolean {
    const next = relaySessionTransition(this.#state, event);
    if (!next) return false;
    this.#state = next as RelaySessionState;
    return true;
  }

  /** Open a new session. Returns false immediately if the state machine forbids it. */
  open(): boolean {
    if (!this.#transition("open")) return false;
    this.#transport.send(createSessionOpen({
      purpose: this.#purpose,
      admission: this.#admission,
      clientNonce: this.#nonceFactory()
    }));
    return true;
  }

  /** Reconnect after close/hibernation with cursors; rechecks authorization via fresh admission. */
  reconnect(input: { lastAcknowledged?: { toEndpoint: number; toEntry: number }; revocationRevision?: number } = {}): boolean {
    if (this.#state !== "closed" && this.#state !== "closing") return false;
    if (!this.#transition("reconnect")) return false;
    const admission = input.revocationRevision !== undefined
      ? { ...this.#admission, revocationRevision: input.revocationRevision }
      : this.#admission;
    this.#transport.send(createSessionReconnect({
      previousSessionId: this.#sessionId ?? "unknown",
      admission,
      lastAcknowledged: input.lastAcknowledged ?? this.#cursors,
      reconnectGeneration: this.#reconnectGeneration + 1,
      clientNonce: this.#nonceFactory()
    }));
    return true;
  }

  bindRoute(): boolean {
    if (this.#state !== "admitted" || !this.#sessionId) return false;
    this.#transport.send(createRouteBind({
      sessionId: this.#sessionId,
      routeId: this.#admission.routeId,
      admissionGeneration: this.#admission.admissionGeneration
    }));
    return true;
  }

  queryRoute(routeId: string): void {
    this.#transport.send(createRouteQuery({ routeId }));
  }

  /**
   * Offer an outbound opaque payload. Admission to the frame stream is refused
   * rather than silently queued when bounded buffers are full — a slow reader
   * produces backpressure, not unbounded memory.
   */
  sendPayload(payloadBase64Url: string, options: { messageId?: string; final?: boolean } = {}): OutboundFrameResult {
    if (this.#state !== "admitted" && this.#state !== "streaming") {
      return Object.freeze({ accepted: false, reason: "not_streaming" });
    }
    const frame = createFrame({
      sessionId: this.#sessionId ?? "pending",
      routeId: this.#admission.routeId,
      seq: this.#nextSeq,
      messageId: options.messageId ?? `msg.${this.#admission.deviceId}.${this.#nextSeq}`,
      payload: payloadBase64Url,
      final: options.final === true
    });
    const accounting = admitOutboundFrame(this.#accounting, frame, this.#limits);
    if (!accounting) {
      return Object.freeze({
        accepted: false,
        reason: Buffer.byteLength(payloadBase64Url, "utf8") > Math.ceil(this.#limits.maxFramePayloadBytes * 4 / 3) + 8
          ? "payload_too_large"
          : "backpressure"
      });
    }
    this.#accounting = accounting;
    this.#sentFrames.push({ seq: this.#nextSeq, payloadBytes: Math.ceil(payloadBase64Url.length * 3 / 4) });
    this.#nextSeq += 1;
    this.#transition("frame");
    this.#transport.send(frame);
    return Object.freeze({ accepted: true });
  }

  close(reason: PrivateRelayCloseReason = "normal"): boolean {
    if (this.#state === "closed" || this.#state === "closing" || this.#state === "initiated") return false;
    if (!this.#transition("close")) return false;
    const wireReason = (PRIVATE_RELAY_CLOSE_REASONS as readonly string[]).includes(reason) ? reason : "protocol_error";
    try {
      this.#transport.send(createSessionClose({
        sessionId: this.#sessionId ?? "unknown",
        reason: wireReason,
        finalCursors: this.#cursors
      }));
    } finally {
      this.#transition("close_complete");
    }
    return true;
  }

  /**
   * Typed session failure: the peer is told why the session ends and the
   * final cursors are preserved for a reconnect. Used when a bounded buffer
   * is exhausted by a peer that cannot be safely continued.
   */
  failSession(reason: PrivateRelayCloseReason): boolean {
    if (this.#state === "closed" || this.#state === "closing") return false;
    const closed = this.close(reason);
    this.#transport.close();
    return closed;
  }

  /**
   * Deliver queued inbound frames after the inner channel drained. Each
   * successful delivery emits its ack; the first undeliverable head stops the
   * flush so ordering is preserved.
   */
  flushInbound(): number {
    let delivered = 0;
    let lastSeq = 0;
    while (this.#pendingInbound.length > 0) {
      const head = this.#pendingInbound[0];
      if (!this.#deliverInbound(head.payload, head.messageId)) break;
      this.#pendingInbound.shift();
      this.#cursors = Object.freeze({ ...this.#cursors, toEndpoint: Math.max(this.#cursors.toEndpoint, head.seq) });
      lastSeq = head.seq;
      delivered += 1;
    }
    // One cumulative ack per flush — a deep drain must not turn into a burst
    // of inbound relay messages.
    if (delivered > 0) {
      this.#transport.send(createFrameAck({ routeId: this.#admission.routeId, upToSeq: lastSeq }));
    }
    return delivered;
  }

  #ackInbound(seq: number): void {
    this.#cursors = Object.freeze({ ...this.#cursors, toEndpoint: Math.max(this.#cursors.toEndpoint, seq) });
    // frame-ack is the only client→relay receipt kind the relay runtime
    // accepts; frame-status/flow-credit are relay-originated and would be
    // dropped (and billed) as invalid inbound messages.
    this.#transport.send(createFrameAck({ routeId: this.#admission.routeId, upToSeq: seq }));
  }

  #deliverInbound(payload: string, messageId: string): boolean {
    if (!this.#handlers.onFrame) return false;
    try {
      return this.#handlers.onFrame(payload, messageId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Feed a decoded relay message into the session driver. Returns the parsed
   * wire kind so callers can route without a second parse, or null when the
   * message is not a session-channel message.
   */
  handleMessage(message: unknown): string | null {
    const parsed = parsePrivateRelayMessage(message);
    if (!parsed) return null;
    const kind = String(parsed.kind);
    switch (kind) {
      case "session-admitted": {
        if (this.#state !== "open_sent" && this.#state !== "reconnecting") return kind;
        this.#sessionId = String(parsed.sessionId);
        this.#limits = parsed.limits as typeof DEFAULT_LIMITS;
        this.#reconnectGeneration = Number(parsed.reconnectGeneration);
        this.#routeState = String(parsed.routeState);
        this.#transition("admit");
        this.#handlers.onAdmitted?.(parsed);
        break;
      }
      case "session-rejected": {
        this.#transition("reject");
        this.#handlers.onRejected?.(String(parsed.reason), parsed.retryable === true);
        break;
      }
      case "session-restored": {
        if (this.#state !== "reconnecting") return kind;
        this.#sessionId = String(parsed.sessionId);
        this.#reconnectGeneration = Number(parsed.reconnectGeneration);
        this.#limits = parsed.limits as typeof DEFAULT_LIMITS;
        const cursors = parsed.cursors as { toEndpoint?: number; toEntry?: number } | undefined;
        if (cursors) {
          this.#cursors = Object.freeze({
            toEndpoint: Number(cursors.toEndpoint ?? 0),
            toEntry: Number(cursors.toEntry ?? 0)
          });
        }
        this.#transition("restore");
        this.#handlers.onAdmitted?.(parsed);
        break;
      }
      case "route-status": {
        this.#routeState = String(parsed.state);
        this.#handlers.onRouteStatus?.(String(parsed.routeId), this.#routeState, Number(parsed.generation));
        break;
      }
      case "frame": {
        if (this.#state !== "admitted" && this.#state !== "streaming") break;
        this.#transition("frame");
        const seq = Number(parsed.seq);
        const messageId = String(parsed.messageId);
        const payload = String(parsed.payload);
        if (seq <= this.#cursors.toEndpoint) {
          // Retransmit of an already-delivered frame — ack idempotently.
          this.#ackInbound(seq);
          break;
        }
        if (this.#pendingInbound.length > 0) {
          // Preserve ordering behind the undelivered head. A retransmitted seq
          // that is already queued is dropped — double delivery would corrupt
          // the inner TLS record stream.
          if (this.#pendingInbound.some((pending) => pending.seq === seq)) break;
          if (this.#pendingInbound.length >= this.#limits.maxBufferedFrames) {
            this.failSession("capacity_exceeded");
            break;
          }
          this.#pendingInbound.push({ seq, messageId, payload });
          break;
        }
        if (this.#deliverInbound(payload, messageId)) {
          this.#ackInbound(seq);
        } else {
          this.#pendingInbound.push({ seq, messageId, payload });
        }
        break;
      }
      case "frame-ack": {
        const accounting = acknowledgeFrames(this.#accounting, parsed, this.#sentFrames);
        if (accounting) {
          this.#sentFrames = this.#sentFrames.filter((frame) => frame.seq > Number(parsed.upToSeq));
          this.#accounting = accounting;
        }
        break;
      }
      case "session-close": {
        const cursors = parsed.finalCursors as { toEndpoint?: number; toEntry?: number } | undefined;
        if (cursors) {
          this.#cursors = Object.freeze({
            toEndpoint: Number(cursors.toEndpoint ?? 0),
            toEntry: Number(cursors.toEntry ?? 0)
          });
        }
        this.#transition("close");
        this.#transition("close_complete");
        this.#handlers.onClosed?.(String(parsed.reason), parsed.finalCursors as Readonly<Record<string, unknown>>);
        this.#transport.close();
        break;
      }
      default:
        break;
    }
    return kind;
  }
}

export function createPrivateRelaySession(options: ConstructorParameters<typeof PrivateRelaySession>[0]): PrivateRelaySession {
  return new PrivateRelaySession(options);
}
