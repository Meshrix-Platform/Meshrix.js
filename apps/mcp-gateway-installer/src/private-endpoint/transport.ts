import { WebSocket as UndiciWebSocket } from "undici";
import type { RelayTransportPort } from "@meshrix/gateway/private-endpoint";
import {
  encodePrivateRelayMessage,
  encodePrivateRelayPeerMessage,
  parsePrivateRelayRecoveryMessage
} from "@meshrix/contracts/private-relay";

/**
 * RelayTransportPort over a real WebSocket client.
 *
 * The session driver hands this port contract message objects; the port
 * validates them against the wire contract (`encodePrivateRelayMessage`,
 * falling back to the recovery-channel parser for recovery/operation kinds)
 * and serializes them as JSON text frames, exactly as the relay consumes.
 *
 * Delivery semantics:
 *  - While a socket is CONNECTING, sends queue in order (bounded) and flush on
 *    open. A socket that dies before it ever opened never transmitted those
 *    messages, so the queue legitimately survives to the next connect attempt
 *    — this is what lets a queued session-open or session-reconnect ride out a
 *    failed connection attempt without inventing driver state.
 *  - Sends while CLOSED are dropped: they can only describe a dead session
 *    generation, and replaying them into a new socket would corrupt the new
 *    session (a stale session-close would terminate it). Ordering is never
 *    broken and no message is silently duplicated.
 *  - A socket that applied backpressure beyond the bounded budget is closed
 *    loudly rather than allowed to grow memory without limit.
 *
 * The port never auto-reconnects: the profile supervisor owns lifecycle,
 * reconnect generations and backoff. `onDown` reports a terminal socket state
 * exactly once per socket.
 */

/** Structural subset of the undici/browser WebSocket used by this port. */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void, options?: { once?: boolean }): void;
}

export type RelaySocketFactory = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => RelaySocket;

export type RelaySocketState = "idle" | "connecting" | "open" | "closed";

export interface RelayTransportHandlers {
  /** Socket reached OPEN; queued intent has been flushed. */
  readonly onOpen?: () => void;
  /** One decoded inbound relay message (already-deserialized JSON object). */
  readonly onMessage?: (message: unknown) => void;
  /**
   * The current socket terminally failed or closed. `detail.reason` is the
   * peer close reason when present. Fires once per socket generation.
   */
  readonly onDown?: (detail: { readonly code?: number; readonly reason?: string; readonly hadOpened: boolean }) => void;
}

export interface RelayWebSocketTransportOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly socketFactory?: RelaySocketFactory;
  readonly handlers?: RelayTransportHandlers;
  /** Bound on messages queued while a socket is still connecting. */
  readonly maxQueuedMessages?: number;
  /** Bound on queued bytes while connecting. */
  readonly maxQueuedBytes?: number;
  /** Bound on socket-level buffered bytes before the send is refused loudly. */
  readonly maxSocketBufferedBytes?: number;
}

const DEFAULT_MAX_QUEUED_MESSAGES = 64;
const DEFAULT_MAX_QUEUED_BYTES = 262_144;
const DEFAULT_MAX_SOCKET_BUFFERED_BYTES = 4_194_304;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const POLICY_CLOSE_CODE = 4001;

export class RelayWebSocketTransport implements RelayTransportPort {
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #factory: RelaySocketFactory;
  #handlers: RelayTransportHandlers;
  readonly #maxQueuedMessages: number;
  readonly #maxQueuedBytes: number;
  readonly #maxSocketBufferedBytes: number;
  #socket: RelaySocket | undefined;
  #state: RelaySocketState = "idle";
  #queue: string[] = [];
  #queuedBytes = 0;
  #generation = 0;
  /** Outbound sends dropped because no live socket existed to carry them. */
  #droppedSends = 0;
  #terminated = false;

  constructor(options: RelayWebSocketTransportOptions) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#factory = options.socketFactory ?? ((url, init) => new UndiciWebSocket(url, { headers: init.headers }) as unknown as RelaySocket);
    this.#handlers = options.handlers ?? {};
    this.#maxQueuedMessages = options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.#maxSocketBufferedBytes = options.maxSocketBufferedBytes ?? DEFAULT_MAX_SOCKET_BUFFERED_BYTES;
  }

  get state(): RelaySocketState {
    return this.#state;
  }

  get droppedSends(): number {
    return this.#droppedSends;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Queued-but-never-transmitted outbound messages (connecting sockets only). */
  get queuedMessages(): number {
    return this.#queue.length;
  }

  /** Assign/replace lifecycle handlers (the supervisor owns them). */
  setHandlers(handlers: RelayTransportHandlers): void {
    this.#handlers = handlers;
  }

  /** Drop retained intent; used when the owning session is rebuilt. */
  resetQueue(): void {
    this.#queue = [];
    this.#queuedBytes = 0;
  }

  /** Open a fresh socket generation. Illegal while one is live. */
  connect(): boolean {
    if (this.#terminated || this.#state === "connecting" || this.#state === "open") return false;
    const generation = ++this.#generation;
    this.#state = "connecting";
    let socket: RelaySocket;
    try {
      socket = this.#factory(this.#url, { headers: this.#headers });
    } catch {
      this.#state = "closed";
      this.#handlers.onDown?.({ hadOpened: false });
      return false;
    }
    this.#socket = socket;
    let opened = false;
    let reported = false;
    const down = (detail: { code?: number; reason?: string }) => {
      if (reported || generation !== this.#generation) return;
      reported = true;
      this.#socket = undefined;
      this.#state = "closed";
      this.#handlers.onDown?.({ ...detail, hadOpened: opened });
    };
    socket.addEventListener("open", () => {
      if (generation !== this.#generation || this.#socket !== socket) return;
      opened = true;
      this.#state = "open";
      const pending = this.#queue;
      this.#queue = [];
      this.#queuedBytes = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (!this.#write(socket, pending[index])) {
          // A write that failed mid-flush strands the remainder on a socket
          // that is already closing loudly — count them honestly rather than
          // pretending the intent drained.
          this.#droppedSends += pending.length - index;
          break;
        }
      }
      this.#handlers.onOpen?.();
    });
    socket.addEventListener("message", (event: { data?: unknown }) => {
      if (generation !== this.#generation || this.#socket !== socket) return;
      const data = event.data;
      if (typeof data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      this.#handlers.onMessage?.(parsed);
    });
    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      // Messages queued behind a socket that opened are already transmitted;
      // a socket that never opened keeps its queue for the next attempt.
      if (opened) this.resetQueue();
      down({ code: typeof event.code === "number" ? event.code : undefined, reason: typeof event.reason === "string" ? event.reason : undefined });
    });
    socket.addEventListener("error", () => {
      // The close event always follows an error; nothing to do until then.
    });
    return true;
  }

  /** Serialize and send (or queue behind a connecting socket). */
  send(message: Readonly<Record<string, unknown>>): void {
    const serialized = this.#serialize(message);
    if (serialized === null) return;
    if (this.#state === "open" && this.#socket) {
      this.#write(this.#socket, serialized);
      return;
    }
    if (this.#state === "connecting") {
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (this.#queue.length >= this.#maxQueuedMessages || this.#queuedBytes + bytes > this.#maxQueuedBytes) {
        // Loud bound: a wedged pending queue must fail the connect attempt,
        // not silently drop ordering inside a live session.
        this.#socket?.close(POLICY_CLOSE_CODE, "capacity_exceeded");
        this.#droppedSends += 1;
        return;
      }
      this.#queue.push(serialized);
      this.#queuedBytes += bytes;
      return;
    }
    // Closed/idle: the owning generation is dead; the send is dropped so no
    // stale control message can leak into a future socket generation.
    this.#droppedSends += 1;
  }

  /** Driver-facing close: ends the live socket without clearing profile intent. */
  close(): void {
    const socket = this.#socket;
    if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
      try { socket.close(1000, "normal"); } catch { /* already closed */ }
    }
  }

  /** Profile-facing terminate: drop all intent and close the socket. */
  terminate(): void {
    this.#terminated = true;
    this.resetQueue();
    this.close();
  }

  #write(socket: RelaySocket, serialized: string): boolean {
    if (socket.bufferedAmount > this.#maxSocketBufferedBytes) {
      // The peer stopped reading. Closing is loud and bounded; absorbing the
      // send anyway would grow memory without the peer ever catching up.
      try { socket.close(POLICY_CLOSE_CODE, "capacity_exceeded"); } catch { /* closed */ }
      return false;
    }
    try {
      socket.send(serialized);
      return true;
    } catch {
      return false;
    }
  }

  #serialize(message: Readonly<Record<string, unknown>>): string | null {
    const sessionWire = encodePrivateRelayMessage(message);
    if (sessionWire) return sessionWire;
    // Recovery/operation kinds are validated by the recovery parser — anything
    // else never reaches the wire, matching relay-side rejection.
    if (parsePrivateRelayRecoveryMessage(message)) return JSON.stringify(message);
    // Peer mailbox kinds share the admitted session channel; the contract
    // encoder is the authority — a non-peer object still drops loudly.
    const peerWire = encodePrivateRelayPeerMessage(message);
    if (peerWire) return peerWire;
    this.#droppedSends += 1;
    return null;
  }
}

export function createRelayWebSocketTransport(options: RelayWebSocketTransportOptions): RelayWebSocketTransport {
  return new RelayWebSocketTransport(options);
}
