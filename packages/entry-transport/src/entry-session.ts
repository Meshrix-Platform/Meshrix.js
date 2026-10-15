import type { Duplex } from "node:stream";
import type { TLSSocketOptions } from "node:tls";
import {
  PrivateRelaySession,
  createInnerTlsClient,
  createRelayFrameDuplex,
  type InnerTlsChannel,
  type RelayAdmissionInput,
  type RelayFrameDuplex,
  type RelaySessionState,
  type RelayTransportPort
} from "@meshrix/gateway/private-endpoint";
import {
  createOperationQuery,
  parseOperationStatus,
  parsePrivateRelayRecoveryMessage
} from "@meshrix/contracts/private-relay";
import { createInnerRequestChannel, type InnerRequestChannel } from "./inner-jsonrpc.ts";
import { entryError } from "./errors.ts";

/**
 * Entry-side session and inner-channel composition.
 *
 * Owns one `PrivateRelaySession` driving a `RelayTransportPort` (WSS in
 * production, in-memory in tests), the bounded relay-frame duplex that pumps
 * opaque payloads, the pinned inner mutual-TLS client channel, and the
 * request channel over it. Reconnect rebuilds the pump, the TLS handshake and
 * the request channel — never replaying frames the peer already
 * acknowledged and never resurrecting a pending request as a second
 * dispatch.
 */
export interface EntryTransportLifecycle {
  /** Resolves when the first socket is open (real transports only). */
  readonly ready?: Promise<void>;
  /** Re-establishes a dropped socket; the session driver reconnects on top. */
  reopen?(): Promise<void>;
}

export interface EntryOperationPrincipal {
  /** Principal + authority generation the endpoint binds operation queries to. */
  readonly principalRef: string;
  readonly generation: number;
}

export interface EntrySessionOptions {
  readonly transport: RelayTransportPort & Partial<EntryTransportLifecycle>;
  readonly admission: RelayAdmissionInput;
  /** The entry's paired device credential plus the pinned endpoint SPKI pins. */
  readonly innerTls: {
    readonly key: TLSSocketOptions["key"];
    readonly cert: TLSSocketOptions["cert"];
    readonly pinnedPeerSpki: readonly string[];
    readonly handshakeTimeoutMs?: number;
  };
  readonly purpose?: "forward" | "recover_device" | "pair_device";
  readonly maxPendingRequests?: number;
  readonly maxInnerLineBytes?: number;
  readonly requestTimeoutMs?: number;
  /** `null` waits for a real relay/channel outcome or explicit cancellation. */
  readonly connectTimeoutMs?: number | null;
  readonly operationPrincipal?: EntryOperationPrincipal;
  readonly operationQueryTimeoutMs?: number;
  readonly nonceFactory?: () => string;
  readonly onOperationStatus?: (status: Readonly<Record<string, unknown>>) => void;
  readonly onRejected?: (reason: string, retryable: boolean) => void;
  readonly onRouteState?: (routeId: string, state: string, generation: number) => void;
  readonly onClosed?: (reason: string) => void;
  /** The inner TLS handshake or channel failed; the session is being closed. */
  readonly onChannelLost?: (error: unknown) => void;
}

interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingStatusQuery {
  readonly resolve: (status: Readonly<Record<string, unknown>>) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_QUERY_TIMEOUT_MS = 15_000;

export class EntryRelaySession {
  readonly #options: EntrySessionOptions;
  readonly #session: PrivateRelaySession;
  #pump: RelayFrameDuplex | undefined;
  #tls: InnerTlsChannel | undefined;
  #channel: InnerRequestChannel | undefined;
  /** Sender session the live channel is bound to; an endpoint reconnect replaces it. */
  #boundPeerSessionId: string | undefined;
  /** True once route-status reported the endpoint detached until the next reachable notice. */
  #peerDetached = false;
  #readyWaiters = new Set<ReadyWaiter>();
  #statusQueries = new Map<string, PendingStatusQuery>();

  constructor(options: EntrySessionOptions) {
    this.#options = options;
    this.#session = new PrivateRelaySession({
      transport: options.transport,
      admission: options.admission,
      purpose: options.purpose ?? "forward",
      nonceFactory: options.nonceFactory,
      handlers: {
        onAdmitted: () => this.#establishChannel(),
        onFrame: (payload, _messageId, peerSessionId) => {
          // The relay forwards the sender's sessionId verbatim. An endpoint
          // session replacement means a fresh TLS endpoint on its side — the
          // channel bound to the previous session answers nothing, so rebuild
          // and re-handshake before feeding the new peer's records.
          if (this.#boundPeerSessionId !== undefined && peerSessionId !== this.#boundPeerSessionId) {
            this.#establishChannel();
          }
          this.#boundPeerSessionId = peerSessionId;
          return this.#pump ? this.#pump.feed(payload) : false;
        },
        onRejected: (reason, retryable) => {
          const error = entryError("entry_admission_rejected", `The relay rejected the session admission (${reason}).`, { effectOutcome: "not_started" });
          this.#settleReady(error);
          options.onRejected?.(reason, retryable);
        },
        onRouteStatus: (routeId, state, generation) => {
          if (state === "unreachable") {
            // The endpoint session is gone — the inner channel is dead weight.
            // Settle connect waiters honestly instead of burning the budget.
            this.#peerDetached = true;
            this.#teardownChannel("entry_endpoint_detached");
            this.#settleReady(entryError("endpoint_unreachable", "The private endpoint detached from the route.", { effectOutcome: "not_started" }));
          } else if (state === "reachable" && this.#peerDetached) {
            // A fresh endpoint session re-handshakes from zero.
            this.#peerDetached = false;
            if (this.#session.state === "admitted" || this.#session.state === "streaming") {
              this.#establishChannel();
            }
          }
          options.onRouteState?.(routeId, state, generation);
        },
        onClosed: (reason) => {
          this.#teardownChannel("entry_session_closed");
          this.#settleReady(entryError("entry_session_closed", `The relay session closed (${reason}).`, { effectOutcome: "not_started" }));
          for (const query of this.#statusQueries.values()) {
            clearTimeout(query.timer);
            query.reject(entryError("entry_session_closed", "The relay session closed before the operation status arrived.", { effectOutcome: "unknown" }));
          }
          this.#statusQueries.clear();
          options.onClosed?.(reason);
        }
      }
    });
  }

  get state(): RelaySessionState {
    return this.#session.state;
  }

  get routeState(): string {
    return this.#session.routeState;
  }

  get sessionId(): string | null {
    return this.#session.sessionId;
  }

  /** True only when the relay reports the route reachable AND an inner channel is live. */
  get acceptsNewWork(): boolean {
    return this.#session.acceptsNewWork && this.#channel !== undefined;
  }

  get channelEstablished(): boolean {
    return this.#channel !== undefined;
  }

  get pendingStatusQueries(): number {
    return this.#statusQueries.size;
  }

  /** Open the session and wait for the pinned inner channel to come up. */
  async connect(): Promise<void> {
    if (this.#options.transport.ready !== undefined) await this.#options.transport.ready;
    const ready = this.#readyWaiter(this.#connectBudget());
    try {
      if (!this.#session.open()) {
        throw entryError("entry_session_state", `A session in state "${this.#session.state}" cannot open.`);
      }
    } catch (error) {
      this.#settleReady(error);
      throw error;
    }
    await ready;
  }

  /**
   * Session-level reconnect per the wire contract: the transport is
   * re-established first, then `session-reconnect` carries the preserved
   * cursors and the caller's fresh revocation revision.
   */
  async reconnect(input: { readonly revocationRevision?: number } = {}): Promise<void> {
    if (this.#options.transport.reopen) await this.#options.transport.reopen();
    const ready = this.#readyWaiter(this.#connectBudget());
    try {
      if (!this.#session.reconnect(input)) {
        throw entryError("entry_session_state", `A session in state "${this.#session.state}" cannot reconnect.`);
      }
    } catch (error) {
      this.#settleReady(error);
      throw error;
    }
    await ready;
  }

  /** Forward one JSON-RPC-shaped inner request; resolves with the endpoint outcome. */
  request(message: Readonly<Record<string, unknown>>): Promise<unknown> {
    const channel = this.#channel;
    if (!channel) {
      return Promise.reject(entryError("endpoint_unreachable", "The private endpoint is unreachable; no inner channel is established.", { effectOutcome: "not_started" }));
    }
    return channel.request(message);
  }

  /**
   * Wire-level operation status query over the relay recovery channel. The
   * answer is the endpoint ledger's own record — never a local guess.
   */
  queryOperation(operationId: string): Promise<Readonly<Record<string, unknown>>> {
    const principal = this.#options.operationPrincipal;
    if (!principal) {
      return Promise.reject(entryError("entry_operation_principal_missing", "An operation principal is required to bind recovery queries."));
    }
    const timeoutMs = this.#options.operationQueryTimeoutMs ?? DEFAULT_OPERATION_QUERY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#statusQueries.delete(operationId);
        reject(entryError("entry_operation_query_timeout", "The endpoint did not answer the operation query; the status stays unknown.", { effectOutcome: "unknown" }));
      }, timeoutMs);
      this.#statusQueries.set(operationId, { resolve, reject, timer });
      try {
        this.#options.transport.send(createOperationQuery({
          operationId,
          principalRef: principal.principalRef,
          generation: principal.generation
        }) as Readonly<Record<string, unknown>>);
      } catch (error) {
        this.#statusQueries.delete(operationId);
        clearTimeout(timer);
        reject(entryError("endpoint_unreachable", "The operation query could not be sent to the relay.", { effectOutcome: "unknown", cause: error }));
      }
    });
  }

  /**
   * Feed one decoded transport message. Returns the parsed wire kind, or null
   * for an unrecognized payload. Session kinds go to the driver; recovery
   * kinds are routed here because they terminate at the entry (status
   * answers) rather than the frame pump.
   */
  handleMessage(message: unknown): string | null {
    const kind = this.#session.handleMessage(message)
      ?? (() => {
        const parsed = parsePrivateRelayRecoveryMessage(message);
        return parsed ? String(parsed.kind) : null;
      })();
    if (kind === "operation-status") {
      const status = parseOperationStatus(message);
      if (!status) return kind;
      this.#options.onOperationStatus?.(status);
      const pending = this.#statusQueries.get(String(status.operationId));
      if (pending) {
        this.#statusQueries.delete(String(status.operationId));
        clearTimeout(pending.timer);
        pending.resolve(status);
      }
    }
    return kind;
  }

  /**
   * The underlying socket died without a session-close: pending requests
   * settle by their dispatch evidence, then the driver transitions to
   * `closed` so `reconnect()` becomes valid. The session-close send on a dead
   * transport may throw — the transition happens first and the failure is
   * swallowed because the peer is already gone.
   */
  handleTransportClose(): void {
    this.#teardownChannel("entry_transport_lost");
    this.#settleReady(entryError("entry_transport_lost", "The relay transport dropped before the channel established.", { effectOutcome: "unknown" }));
    try {
      this.#session.close("reconnect");
    } catch {
      // Dead transports cannot deliver the close frame; the state already closed.
    }
  }

  close(reason: "normal" | "reconnect" | "protocol_error" | "capacity_exceeded" | "idle_timeout" | "revoked" = "normal"): void {
    this.#teardownChannel("entry_session_closed");
    this.#settleReady(entryError("entry_session_closed", "The entry session was closed.", { effectOutcome: "not_started" }));
    try {
      this.#session.close(reason);
    } catch {
      // A dead transport cannot deliver the close frame.
    }
    try {
      this.#options.transport.close();
    } catch {
      // Close is best-effort on a failed transport.
    }
    for (const query of this.#statusQueries.values()) {
      clearTimeout(query.timer);
      query.reject(entryError("entry_session_closed", "The entry session was closed before the operation status arrived.", { effectOutcome: "unknown" }));
    }
    this.#statusQueries.clear();
  }

  #settleReady(error?: unknown): void {
    for (const waiter of this.#readyWaiters) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
    this.#readyWaiters.clear();
  }

  #connectBudget(): number | undefined {
    return this.#options.connectTimeoutMs === null
      ? undefined
      : this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  #readyWaiter(timeoutMs: number | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject };
      this.#readyWaiters.add(waiter);
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          if (this.#readyWaiters.delete(waiter)) {
            reject(entryError("entry_connect_timeout", "The inner channel did not establish within the connect budget.", { effectOutcome: "not_started" }));
          }
        }, timeoutMs).unref();
      }
    });
  }

  #teardownChannel(code: string): void {
    const channel = this.#channel;
    this.#channel = undefined;
    this.#tls = undefined;
    this.#boundPeerSessionId = undefined;
    const pump = this.#pump;
    this.#pump = undefined;
    channel?.close(code);
    if (pump && !pump.destroyed) pump.destroy();
  }

  /**
   * Fires for both session-admitted and session-restored: a restored session
   * must rebuild the whole inner channel so acknowledged cursors are honored
   * and no stale TLS state survives into the new generation.
   */
  #establishChannel(): void {
    this.#teardownChannel("entry_channel_replaced");
    const pump = createRelayFrameDuplex({
      sendFrame: (payload) => this.#session.sendPayload(payload).accepted,
      onDrained: () => {
        try {
          this.#session.flushInbound();
        } catch {
          // A dropped transport cannot deliver the ack — the session close path owns the error.
        }
      }
    });
    const tls = createInnerTlsClient({
      socket: pump as unknown as Duplex,
      key: this.#options.innerTls.key,
      cert: this.#options.innerTls.cert,
      pinnedPeerSpki: this.#options.innerTls.pinnedPeerSpki,
      handshakeTimeoutMs: this.#options.innerTls.handshakeTimeoutMs
    });
    this.#pump = pump;
    this.#tls = tls;
    void tls.established.then(() => {
      if (this.#tls !== tls) return; // superseded by a newer admission
      const channel = createInnerRequestChannel({
        socket: tls.socket as unknown as Duplex,
        maxPending: this.#options.maxPendingRequests,
        maxLineBytes: this.#options.maxInnerLineBytes,
        requestTimeoutMs: this.#options.requestTimeoutMs,
        onLost: (error) => {
          if (this.#channel === channel) this.#channel = undefined;
          this.#options.onChannelLost?.(error);
        }
      });
      this.#channel = channel;
      // The channel is live — frames the driver queued while it was down can
      // drain now (seq cursors keep re-delivery idempotent).
      try {
        this.#session.flushInbound();
      } catch {
        // A dropped transport cannot deliver the ack — the close path owns it.
      }
      this.#settleReady(undefined);
    }).catch((error: unknown) => {
      if (this.#tls === tls) {
        this.#tls = undefined;
        this.#pump = undefined;
      }
      this.#settleReady(entryError("entry_handshake_failed", "The pinned inner TLS handshake failed.", { cause: error, effectOutcome: "not_started" }));
      this.#options.onChannelLost?.(error);
      // The peer is not the pinned endpoint (or the channel was poisoned):
      // close the session so the next work attempt goes through a fresh
      // admission instead of streaming into a broken channel.
      try {
        this.#session.close("protocol_error");
      } catch {
        // The transport may already be dead.
      }
    });
  }
}

export function createEntryRelaySession(options: EntrySessionOptions): EntryRelaySession {
  return new EntryRelaySession(options);
}
