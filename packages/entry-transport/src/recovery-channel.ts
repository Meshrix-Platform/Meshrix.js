/**
 * Recovery-purpose relay channel — the production binding of the
 * `RecoveryEndpointPort` contract used by `EntryRecoverySession` and the
 * installed entry's rotation reporting.
 *
 * Opens a relay session with `purpose: "recover_device"` — the wire purpose
 * that admits only recovery kinds (request/challenge/proof/result, rotation
 * begin/state) and never forwards opaque frames. `roundTrip` correlates one
 * in-flight response at a time and settles ONLY on a matching response, a
 * transport/session failure, or an explicit `close()` — a silent endpoint is
 * never folded into a fabricated `unreachable` outcome, so a slow but healthy
 * peer can still complete the exchange whenever its reply arrives.
 */
import { PrivateRelaySession, type RelayAdmissionInput, type RelayTransportPort } from "@meshrix/gateway/private-endpoint";
import { parsePrivateRelayRecoveryMessage } from "@meshrix/contracts/private-relay";
import { entryError } from "./errors.ts";
import { createWssRelayTransport, type WssRelayTransport } from "./wss-transport.ts";

export interface EntryRecoveryRoundTripPort {
  roundTrip(input: {
    readonly endpointRouteId: string;
    readonly message: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Both real (handlers record) and injected (direct fields) transport shapes. */
export interface RecoveryTransportLike extends RelayTransportPort {
  onMessage?: (message: Readonly<Record<string, unknown>>) => void;
  onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  onSocketDrop?: () => void;
  readonly handlers?: {
    onMessage?: (message: Readonly<Record<string, unknown>>) => void;
    onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  };
  readonly ready?: Promise<void>;
}

export interface EntryRecoveryChannelOptions {
  /** ws(s) relay session URL — `/session/:tenantId/:routeId` form. */
  readonly relaySessionUrl: string;
  readonly admission: RelayAdmissionInput;
  /** Bearer credential header material (e.g. `{authorization: "Bearer …"}`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Opt-in loopback ws:// fixture transport. */
  readonly allowInsecureLoopback?: boolean;
  /** Test seam: inject a non-network transport. */
  readonly transportFactory?: () => RecoveryTransportLike;
  readonly nonceFactory?: () => string;
  readonly onRejected?: (reason: string, retryable: boolean) => void;
  readonly onClosed?: (reason: string) => void;
}

interface PendingRoundTrip {
  readonly accepts: (kind: string, message: unknown) => boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A recovery wire exchange over one short-lived recover_device session.
 * The caller opens it, runs the request/challenge/proof/result (or
 * rotation-begin/rotation-state) exchange and closes it — no inner TLS
 * channel is ever established on this purpose.
 */
export class EntryRecoveryChannel implements EntryRecoveryRoundTripPort {
  readonly #options: EntryRecoveryChannelOptions;
  readonly #transport: RecoveryTransportLike;
  readonly #session: PrivateRelaySession;
  readonly #pending: PendingRoundTrip[] = [];
  #openResolve: (() => void) | null = null;
  #openReject: ((error: unknown) => void) | null = null;

  constructor(options: EntryRecoveryChannelOptions) {
    this.#options = options;
    this.#transport = options.transportFactory?.()
      ?? createWssRelayTransport({
        url: options.relaySessionUrl,
        headers: options.headers,
        allowInsecureLoopback: options.allowInsecureLoopback,
      });
    this.#session = new PrivateRelaySession({
      transport: this.#transport,
      admission: options.admission,
      purpose: "recover_device",
      nonceFactory: options.nonceFactory,
      handlers: {
        onAdmitted: () => {
          this.#openResolve?.();
          this.#openResolve = null;
          this.#openReject = null;
        },
        onRejected: (reason, retryable) => {
          const error = entryError(
            "entry_admission_rejected",
            `The relay rejected the recovery session admission (${reason}).`,
            { effectOutcome: "not_started" }
          );
          this.#openReject?.(error);
          this.#openResolve = null;
          this.#openReject = null;
          this.#failAll(error);
          options.onRejected?.(reason, retryable);
        },
        onClosed: (reason) => {
          const error = entryError("entry_session_closed", `The recovery session closed (${reason}).`, { effectOutcome: "unknown" });
          this.#openReject?.(error);
          this.#openResolve = null;
          this.#openReject = null;
          this.#failAll(error);
          options.onClosed?.(reason);
        }
      }
    });
    const transport = this.#transport;
    const onMessage = (message: Readonly<Record<string, unknown>>) => this.#handleMessage(message);
    const onClose = () => {
      const error = entryError("endpoint_unreachable", "The relay transport dropped during a recovery exchange.", { effectOutcome: "unknown" });
      this.#openReject?.(error);
      this.#openResolve = null;
      this.#openReject = null;
      this.#failAll(error);
    };
    if (transport.handlers) {
      transport.handlers.onMessage = onMessage;
      transport.handlers.onSocketClose = () => onClose();
    } else {
      transport.onMessage = onMessage;
      transport.onSocketClose = () => onClose();
      transport.onSocketDrop = () => onClose();
    }
  }

  get state(): string {
    return this.#session.state;
  }

  /**
   * Open the recover_device session and wait for relay admission. There is no
   * local deadline: admission settles on the relay's admit/reject frame or on
   * transport failure — never on silence.
   */
  async open(): Promise<void> {
    const wss = this.#transport as Partial<WssRelayTransport>;
    if (wss.ready !== undefined) await wss.ready;
    const opened = new Promise<void>((resolve, reject) => {
      this.#openResolve = resolve;
      this.#openReject = reject;
    });
    if (!this.#session.open()) {
      this.#openResolve = null;
      this.#openReject = null;
      throw entryError("entry_session_state", `A recovery session in state "${this.#session.state}" cannot open.`);
    }
    await opened;
  }

  /**
   * One request → one matching response. `accepts` filters the response kind;
   * the default pairing is recovery-request → recovery-challenge and
   * recovery-proof → recovery-result, matched FIFO per pending request.
   *
   * The exchange is never truncated by a local silence budget: the promise
   * resolves when a matching response arrives (however late), and rejects on
   * send failure, transport drop, session close, or `close()`. Callers that
   * need a bounded observation window race this promise themselves without
   * discarding the in-flight exchange.
   */
  roundTrip(input: {
    readonly endpointRouteId: string;
    readonly message: Record<string, unknown>;
    readonly accepts?: (kind: string, message: unknown) => boolean;
  }): Promise<unknown> {
    const accepts = input.accepts ?? defaultAcceptsFor(input.message);
    return new Promise((resolve, reject) => {
      const entry = { accepts, resolve, reject };
      this.#pending.push(entry);
      try {
        this.#transport.send(input.message);
      } catch (error) {
        const index = this.#pending.indexOf(entry);
        if (index >= 0) this.#pending.splice(index, 1);
        reject(error);
      }
    });
  }

  close(): void {
    this.#failAll(entryError("entry_session_closed", "The recovery channel was closed.", { effectOutcome: "unknown" }));
    try {
      this.#session.close("normal");
    } catch {
      // A dead transport cannot deliver the close frame.
    }
    try {
      this.#transport.close();
    } catch {
      // Best-effort transport teardown.
    }
  }

  #handleMessage(message: unknown): void {
    const kind = this.#session.handleMessage(message)
      ?? (() => {
        const parsed = parsePrivateRelayRecoveryMessage(message);
        return parsed ? String((parsed as { kind: string }).kind) : null;
      })();
    if (!kind) return;
    const index = this.#pending.findIndex((entry) => entry.accepts(kind, message));
    if (index < 0) return;
    const [entry] = this.#pending.splice(index, 1);
    entry.resolve(message);
  }

  #failAll(error: unknown): void {
    const pending = this.#pending.splice(0);
    for (const entry of pending) {
      entry.reject(error);
    }
  }
}

function defaultAcceptsFor(message: Record<string, unknown>): (kind: string, message: unknown) => boolean {
  const kind = typeof message.kind === "string" ? message.kind : "";
  switch (kind) {
    case "recovery-request":
      return (kind_) => kind_ === "recovery-challenge";
    case "recovery-proof":
      return (kind_, response) =>
        kind_ === "recovery-result"
          && (response as { challengeId?: unknown }).challengeId === (message as { challengeId?: unknown }).challengeId;
    case "rotation-begin":
      return (kind_) => kind_ === "rotation-state";
    default:
      return () => true;
  }
}

export function createEntryRecoveryChannel(options: EntryRecoveryChannelOptions): EntryRecoveryChannel {
  return new EntryRecoveryChannel(options);
}
