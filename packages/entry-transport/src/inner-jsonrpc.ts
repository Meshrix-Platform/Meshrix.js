import type { Duplex } from "node:stream";
import { entryError, type EntryTransportError } from "./errors.ts";

/**
 * Inner-channel message wire between an entry device and the private gateway
 * endpoint. The inner channel is an authenticated, ordered byte stream (the
 * pinned mutual-TLS socket); this module owns the request/response framing on
 * top of it — never the semantic authorization, which stays inside the
 * endpoint kernel.
 *
 * Wire shape (one JSON value per line, UTF-8, `\n`-delimited):
 *   request : a JSON-RPC-shaped object `{ jsonrpc?, id, method, params? }`
 *             forwarded verbatim to `dispatchInnerMessage`.
 *   response: `{ id, outcome }` where `outcome` is the dispatch result — a
 *             `GatewayOutcome` object, or `null` when the endpoint did not
 *             recognize the method.
 *
 * A dispatch that throws inside the endpoint is answered with a transport
 * `GatewayFailure` carrying `effectOutcome: "unknown"`, because a thrown
 * dispatch cannot prove the effect never started.
 */

export const INNER_LINE_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_PENDING_RESPONSES = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestKey(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

/** Synthetic outcome used when the endpoint-side dispatch itself throws. */
export function innerDispatchFailedOutcome(): Record<string, unknown> {
  return {
    kind: "failure",
    origin: "transport",
    code: "endpoint_dispatch_failed",
    message: "The endpoint dispatch failed before producing an outcome.",
    status: 500,
    effectOutcome: "unknown"
  };
}

interface PendingRequest {
  readonly id: unknown;
  dispatched: boolean;
  readonly resolve: (outcome: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: NodeJS.Timeout;
}

export interface InnerRequestChannel {
  /** Forward one JSON-RPC-shaped request; resolves with the endpoint outcome (or null). */
  request(message: Readonly<Record<string, unknown>>): Promise<unknown>;
  readonly pendingCount: number;
  close(code?: string): void;
}

export interface InnerRequestChannelOptions {
  readonly socket: Duplex;
  readonly maxPending?: number;
  readonly maxLineBytes?: number;
  /** Per-request dispatch timeout; 0/undefined means the channel lifecycle bounds the request. */
  readonly requestTimeoutMs?: number;
  /** Fires once when the channel dies from a socket or protocol failure. */
  readonly onLost?: (error: unknown) => void;
}

/**
 * Entry side of the inner wire. A pending request carries explicit dispatch
 * evidence: a write that provably never reached the relay settles as
 * `entry_never_dispatched` (`not_started`), while one handed to the stream and
 * then lost settles as `entry_inner_lost` (`unknown`). Neither is ever
 * fabricated into a success.
 */
export function createInnerRequestChannel(options: InnerRequestChannelOptions): InnerRequestChannel {
  const socket = options.socket;
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING_REQUESTS);
  const maxLineBytes = Math.max(256, options.maxLineBytes ?? INNER_LINE_MAX_BYTES);
  const pending = new Map<string, PendingRequest>();
  let buffer = Buffer.alloc(0);
  let closed = false;

  function fail(error: EntryTransportError | ReturnType<typeof entryError>): void {
    if (closed) return;
    closed = true;
    options.onLost?.(error);
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(entry.dispatched
        ? entryError("entry_inner_lost", "The inner channel was lost after the request was dispatched; the operation status is unknown.", { effectOutcome: "unknown", cause: error })
        : entryError("entry_never_dispatched", "The request never reached the relay transport; the operation was not started.", { effectOutcome: "not_started", cause: error }));
    }
    pending.clear();
    buffer = Buffer.alloc(0);
    if (!socket.destroyed) socket.destroy();
  }

  function acceptLine(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      fail(entryError("entry_inner_protocol", "The endpoint returned a malformed inner-channel line."));
      return;
    }
    // The response envelope is exactly {id, outcome}; anything else is a
    // protocol violation that poisons correlation, so the channel is torn
    // down rather than guessing which request it belongs to.
    if (!isPlainObject(value) || !Object.hasOwn(value, "id") || !Object.hasOwn(value, "outcome") || Object.keys(value).length !== 2) {
      fail(entryError("entry_inner_protocol", "The endpoint returned a malformed inner-channel response envelope."));
      return;
    }
    const entry = pending.get(requestKey(value.id));
    if (!entry) return; // response for an unknown or already-settled id — dropped, never replayed
    pending.delete(requestKey(value.id));
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(value.outcome);
  }

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > maxLineBytes) {
      fail(entryError("entry_inner_protocol", "The endpoint exceeded the inner-channel line budget."));
      return;
    }
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.byteLength > maxLineBytes) {
        fail(entryError("entry_inner_protocol", "The endpoint exceeded the inner-channel line budget."));
        return;
      }
      if (line.byteLength === 0) continue;
      acceptLine(line);
      if (closed) return;
    }
  });
  socket.once("error", (error) => fail(entryError("entry_inner_socket", "The inner channel socket failed.", { cause: error })));
  socket.once("close", () => fail(entryError("entry_inner_closed", "The inner channel closed.")));

  return {
    get pendingCount() {
      return pending.size;
    },

    request(message: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (closed || socket.destroyed || socket.writableEnded) {
        return Promise.reject(entryError("entry_channel_closed", "The inner channel is not established.", { effectOutcome: "not_started" }));
      }
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number") {
        return Promise.reject(entryError("entry_request_invalid", "An inner-channel request requires a string or number id."));
      }
      const key = requestKey(id);
      if (pending.has(key)) {
        return Promise.reject(entryError("entry_request_duplicate", "A request with this id is already in flight."));
      }
      if (pending.size >= maxPending) {
        return Promise.reject(entryError("entry_backpressure", "The inner-channel pending window is full; retry when it drains.", { effectOutcome: "not_started" }));
      }
      const encoded = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > maxLineBytes) {
        return Promise.reject(entryError("entry_request_oversize", "The request exceeds the inner-channel line budget.", { effectOutcome: "not_started" }));
      }
      return new Promise<unknown>((resolve, reject) => {
        const entry: PendingRequest = {
          id,
          dispatched: false,
          resolve,
          reject,
          ...(options.requestTimeoutMs && options.requestTimeoutMs > 0
            ? {
                timer: setTimeout(() => {
                  pending.delete(key);
                  reject(entryError("entry_request_timeout", "The endpoint did not answer within the request budget; the operation status is unknown.", { effectOutcome: "unknown" }));
                }, options.requestTimeoutMs)
              }
            : {})
        };
        pending.set(key, entry);
        try {
          socket.write(encoded, (error?: Error | null) => {
            if (!error) return;
            if (pending.delete(key)) {
              if (entry.timer) clearTimeout(entry.timer);
              reject(entryError("entry_inner_lost", "The request could not be fully written to the inner channel; the operation status is unknown.", { effectOutcome: "unknown", cause: error }));
            }
          });
          // Once write() accepts the bytes, encrypted records may already be
          // inside the relay stream — a subsequent loss can no longer prove
          // non-dispatch, so the honest boundary is "entered the channel".
          entry.dispatched = true;
        } catch (error) {
          pending.delete(key);
          if (entry.timer) clearTimeout(entry.timer);
          reject(entryError("entry_never_dispatched", "The request never reached the relay transport; the operation was not started.", { effectOutcome: "not_started", cause: error }));
        }
      });
    },

    close(code = "entry_channel_closed"): void {
      fail(entryError(code, "The inner channel was closed."));
    }
  };
}

export interface InnerDispatchLoopOptions {
  readonly socket: Duplex;
  /** Decoded inner request → dispatch outcome (GatewayOutcome | null). */
  readonly dispatch: (message: Record<string, unknown>) => Promise<unknown> | unknown;
  readonly maxLineBytes?: number;
  readonly maxPendingResponses?: number;
  readonly onProtocolError?: (error: unknown) => void;
  readonly onLost?: (error: unknown) => void;
}

export interface InnerDispatchLoop {
  readonly pendingResponses: number;
  close(): void;
}

/**
 * Endpoint side of the inner wire. The endpoint product binds a
 * `dispatchInnerMessage`-shaped function; this adapter only owns framing,
 * response envelope, ordering and bounded backpressure — it never interprets
 * the semantic outcome it carries.
 */
export function createInnerDispatchLoop(options: InnerDispatchLoopOptions): InnerDispatchLoop {
  const socket = options.socket;
  const maxLineBytes = Math.max(256, options.maxLineBytes ?? INNER_LINE_MAX_BYTES);
  const maxPendingResponses = Math.max(1, options.maxPendingResponses ?? DEFAULT_MAX_PENDING_RESPONSES);
  let buffer = Buffer.alloc(0);
  let closed = false;
  let writing = false;
  const queue: string[] = [];

  function destroy(error: unknown): void {
    if (closed) return;
    closed = true;
    queue.length = 0;
    buffer = Buffer.alloc(0);
    options.onLost?.(error);
    if (!socket.destroyed) socket.destroy();
  }

  async function pumpWrites(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      while (queue.length > 0 && !closed) {
        const line = queue[0];
        const canContinue = socket.write(line);
        if (!canContinue) {
          // Bounded wait for the socket to drain; a peer that never drains
          // stays backpressured rather than unbounded-buffered.
          await new Promise<void>((resolve, reject) => {
            socket.once("drain", resolve);
            socket.once("error", reject);
            socket.once("close", () => reject(entryError("entry_inner_closed", "The inner channel closed.")));
          });
        }
        if (closed) return;
        queue.shift();
      }
    } catch (error) {
      destroy(error);
    } finally {
      writing = false;
    }
  }

  function respond(id: unknown, outcome: unknown): void {
    if (closed) return;
    if (queue.length >= maxPendingResponses) {
      destroy(entryError("entry_inner_backpressure", "The inner-channel response queue is exhausted."));
      return;
    }
    queue.push(`${JSON.stringify({ id, outcome })}\n`);
    void pumpWrites();
  }

  function acceptLine(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8")) as unknown;
    } catch (error) {
      options.onProtocolError?.(entryError("entry_inner_protocol", "A malformed inner-channel request line was dropped.", { cause: error }));
      destroy(entryError("entry_inner_protocol", "A malformed inner-channel request line was dropped."));
      return;
    }
    if (!isPlainObject(value) || !Object.hasOwn(value, "id") || (typeof value.id !== "string" && typeof value.id !== "number") || typeof value.method !== "string") {
      options.onProtocolError?.(entryError("entry_inner_protocol", "An inner-channel request lacks a valid id or method."));
      destroy(entryError("entry_inner_protocol", "An inner-channel request lacks a valid id or method."));
      return;
    }
    const id = value.id;
    Promise.resolve()
      .then(() => options.dispatch(value))
      .then((outcome) => respond(id, outcome ?? null))
      .catch(() => {
        // A thrown dispatch cannot prove the effect never started — answer
        // with honest transport-level doubt, never a fabricated success.
        respond(id, innerDispatchFailedOutcome());
      });
  }

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > maxLineBytes) {
      destroy(entryError("entry_inner_protocol", "The peer exceeded the inner-channel line budget."));
      return;
    }
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.byteLength === 0) continue;
      acceptLine(line);
      if (closed) return;
    }
  });
  socket.once("error", (error) => destroy(entryError("entry_inner_socket", "The inner channel socket failed.", { cause: error })));
  socket.once("close", () => destroy(entryError("entry_inner_closed", "The inner channel closed.")));

  return {
    get pendingResponses() {
      return queue.length;
    },
    close(): void {
      destroy(entryError("entry_channel_closed", "The inner dispatch loop was closed."));
    }
  };
}
