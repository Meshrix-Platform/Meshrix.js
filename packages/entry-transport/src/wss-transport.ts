import { WebSocket, type Dispatcher } from "undici";
import type { RelayTransportPort } from "@meshrix/gateway/private-endpoint";
import { entryError } from "./errors.ts";

/**
 * Real WebSocket client transport for the private-relay wire.
 *
 * The relay channel carries versioned JSON text messages; the transport owns
 * socket lifecycle (open, stale-socket isolation, reconnect) and surfaces only
 * decoded objects to the session driver. It never interprets message contents
 * — relay admission, cursors and opaque frames belong to PrivateRelaySession.
 *
 * `wss:` is required for non-loopback relays; plaintext `ws:` is accepted only
 * for literal loopback targets behind an explicit opt-in, so a development
 * fixture cannot quietly downgrade an operator's relay.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface WssRelayTransportOptions {
  readonly url: string | URL;
  /** Extra headers for the upgrade request (e.g. relay bootstrap material). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocols?: string | readonly string[];
  readonly dispatcher?: Dispatcher;
  /** Opt-in: permit plaintext ws:// to a literal loopback relay (fixtures only). */
  readonly allowInsecureLoopback?: boolean;
  readonly maxMessageBytes?: number;
  onMessage?(message: Readonly<Record<string, unknown>>): void;
  /** The live socket closed or failed before an explicit transport close. */
  onSocketClose?(code: number, reason: string, wasClean: boolean): void;
  /** A frame that was not a decodable relay message object. */
  onProtocolError?(error: unknown): void;
  onSocketOpen?(): void;
}

export interface WssRelayTransport extends RelayTransportPort {
  /** Resolves when the current socket finishes its first open; rejects if it dies first. */
  readonly ready: Promise<void>;
  readonly readyState: number;
  readonly closed: boolean;
  /**
   * Live callback record: mutable so a session composed after the transport
   * can attach its delivery handlers without a second construction pass.
   * Constructor options seed this record.
   */
  readonly handlers: {
    onMessage?(message: Readonly<Record<string, unknown>>): void;
    onSocketClose?(code: number, reason: string, wasClean: boolean): void;
    onProtocolError?(error: unknown): void;
    onSocketOpen?(): void;
  };
  /** Re-establish the socket after a drop; refused after an explicit close(). */
  reopen(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeUrl(input: string | URL, allowInsecureLoopback: boolean): URL {
  const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  if (url.username || url.password || url.hash) {
    throw entryError("entry_transport_url_invalid", "The relay URL must not carry credentials or fragments.");
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:" && allowInsecureLoopback && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return url;
  if (url.protocol === "ws:") {
    throw entryError("entry_transport_insecure", "Plaintext ws:// relays are only permitted for explicit loopback fixtures.");
  }
  throw entryError("entry_transport_url_invalid", "The relay URL must use wss://.");
}

export function createWssRelayTransport(options: WssRelayTransportOptions): WssRelayTransport {
  const url = normalizeUrl(options.url, options.allowInsecureLoopback === true);
  const maxMessageBytes = Math.max(1024, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
  const handlers = {
    onMessage: options.onMessage,
    onSocketClose: options.onSocketClose,
    onProtocolError: options.onProtocolError,
    onSocketOpen: options.onSocketOpen
  };
  let socket: WebSocket | undefined;
  let generation = 0;
  let terminated = false;
  let reopening: Promise<void> | undefined;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Ready is a stored wait primitive: a later awaiter still observes its
  // settlement, but a close with no waiter must not surface as an unhandled
  // rejection.
  void ready.catch(() => undefined);

  function handleMessageEvent(data: unknown): void {
    if (typeof data !== "string") {
      handlers.onProtocolError?.(entryError("entry_transport_protocol", "The relay sent a non-text message; the wire is JSON text only."));
      return;
    }
    if (Buffer.byteLength(data, "utf8") > maxMessageBytes) {
      handlers.onProtocolError?.(entryError("entry_transport_oversize", "The relay message exceeds the wire byte budget."));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch (error) {
      handlers.onProtocolError?.(entryError("entry_transport_protocol", "The relay message is not valid JSON.", { cause: error }));
      return;
    }
    if (!isPlainObject(value)) {
      handlers.onProtocolError?.(entryError("entry_transport_protocol", "The relay message is not a JSON object."));
      return;
    }
    handlers.onMessage?.(value);
  }

  function connect(): void {
    const current = ++generation;
    const ws = new WebSocket(url.toString(), {
      protocols: options.protocols === undefined ? [] : [...options.protocols] as string[],
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      headers: options.headers ? { ...options.headers } : {}
    });
    socket = ws;
    ws.addEventListener("open", () => {
      if (current !== generation || terminated) return;
      handlers.onSocketOpen?.();
      readyResolve?.();
      readyResolve = undefined;
    });
    ws.addEventListener("message", (event) => {
      if (current !== generation || terminated) return;
      handleMessageEvent(event.data);
    });
    ws.addEventListener("error", () => {
      if (current !== generation || terminated) return;
      readyReject?.(entryError("entry_transport_open_failed", "The relay socket failed before it opened."));
      readyReject = undefined;
      // A close event always follows an error on a live socket.
    });
    ws.addEventListener("close", (event) => {
      if (current !== generation || terminated) return;
      if (socket === ws) socket = undefined;
      readyReject?.(entryError("entry_transport_open_failed", "The relay socket closed before it opened."));
      readyReject = undefined;
      handlers.onSocketClose?.(event.code, event.reason, event.wasClean);
    });
  }

  connect();

  return {
    ready,
    handlers,
    get readyState() {
      return socket?.readyState ?? WebSocket.CLOSED;
    },
    get closed() {
      return terminated;
    },

    send(message: Readonly<Record<string, unknown>>): void {
      const state = socket?.readyState;
      if (terminated) {
        throw entryError("entry_transport_closed", "The relay transport is closed; the message was not sent.");
      }
      if (state === WebSocket.CONNECTING) {
        throw entryError("entry_transport_not_open", "The relay socket is still connecting; the message was not sent.");
      }
      if (state !== WebSocket.OPEN || !socket) {
        throw entryError("entry_transport_closed", "The relay socket is not open; the message was not sent.");
      }
      socket.send(JSON.stringify(message));
    },

    reopen(): Promise<void> {
      if (terminated) {
        return Promise.reject(entryError("entry_transport_closed", "A closed transport cannot be reopened."));
      }
      if (reopening) return reopening;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return Promise.reject(entryError("entry_transport_still_open", "The relay socket is still live; reopen is only valid after a drop."));
      }
      reopening = new Promise<void>((resolve, reject) => {
        const current = ++generation;
        const ws = new WebSocket(url.toString(), {
          protocols: options.protocols === undefined ? [] : [...options.protocols] as string[],
          ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
          headers: options.headers ? { ...options.headers } : {}
        });
        socket = ws;
        ws.addEventListener("open", () => {
          if (current !== generation || terminated) return;
          reopening = undefined;
          handlers.onSocketOpen?.();
          resolve();
        });
        ws.addEventListener("message", (event) => {
          if (current !== generation || terminated) return;
          handleMessageEvent(event.data);
        });
        ws.addEventListener("error", () => {
          if (current !== generation || terminated) return;
          // close follows; the failure settles there.
        });
        ws.addEventListener("close", (event) => {
          if (current !== generation || terminated) return;
          if (socket === ws) socket = undefined;
          if (reopening) {
            reopening = undefined;
            reject(entryError("entry_transport_open_failed", `The relay socket closed during reconnect (code ${event.code}).`));
          }
          handlers.onSocketClose?.(event.code, event.reason, event.wasClean);
        });
      });
      return reopening;
    },

    close(): void {
      if (terminated) return;
      terminated = true;
      generation += 1;
      readyReject?.(entryError("entry_transport_closed", "The relay transport was closed."));
      readyReject = undefined;
      const current = socket;
      socket = undefined;
      if (current && current.readyState !== WebSocket.CLOSED && current.readyState !== WebSocket.CLOSING) {
        try {
          current.close(1000, "normal");
        } catch {
          // An already-dead socket cannot fail a close.
        }
      }
    }
  };
}
