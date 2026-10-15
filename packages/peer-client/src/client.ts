import { Buffer } from "node:buffer";

import {
  createPeerBundleFetch,
  createPeerBundlePublish,
  createPeerDeliveryAck,
  createPeerSend,
  parsePeerBundle,
  parsePeerBundlePublished,
  parsePeerDeliveryAck,
  parsePeerForwarded,
  parsePeerPresence,
  parsePeerSend,
  parsePrivateRelayPeerMessage,
  peerDeliveryAckMatchesSend,
  peerDeliveryAckSigningInputForSend,
  peerDeliveryAckTranscript,
  peerIdForRouteDevice,
  PRIVATE_RELAY_PEER_LIMITS
} from "@meshrix/contracts/private-relay";
import type {
  PeerDeliveryAck,
  PeerEnvelope,
  PeerForwarded,
  PeerMessageIdentity,
  PeerPresence,
  PeerSend
} from "@meshrix/contracts/private-relay";
import {
  acceptPeerSession,
  base64urlDecode,
  base64urlEncode,
  blockPeerIdentity,
  createPeerCryptoTransactionOverlay,
  decodePeerEnvelope,
  encodePeerEnvelope,
  generatePrekeyBundle,
  initiatePeerSession,
  isPeerCryptoError,
  parsePeerPrekeyBundle,
  PEER_DEVICE_ID,
  peerIdentityBinding,
  peerCryptoError,
  peerSafetyNumber,
  signPeerIdentityMessage,
  peerSessionExists,
  pinPeerIdentity,
  replenishPeerPrekeys,
  repinPeerIdentity,
  resumePeerSession,
  verifyPeerIdentityMessage,
  serializePeerEnvelope
} from "@meshrix/peer-crypto";
import type {
  PeerCryptoPreparedOperation,
  PeerCryptoSession,
  PeerCryptoStore,
  PeerEnvelope as CryptoPeerEnvelope,
  PeerIdentity,
  PeerIdentityBinding
} from "@meshrix/peer-crypto";

import { isPeerClientError, peerClientError } from "./errors.ts";
import { PeerInbox, type PeerInboxLookup } from "./inbox.ts";
import { PeerOutbox } from "./outbox.ts";
import type {
  PeerClientMeta,
  PeerClientPage,
  PeerClientStore,
  StoredBundleObservation,
  StoredInboxEntry,
  StoredOutboxEntry
} from "./store.ts";
import { emptyPeerClientMeta } from "./store.ts";
import type {
  PeerClientTransport,
  PeerDeviceDirectory,
  PeerPairedSignalIdentity
} from "./transport.ts";
import {
  assertPeerClientOpaqueId,
  assertPeerClientPeerId,
  newPeerBundleId,
  newPeerMessageId,
  PEER_CLIENT_DEFAULT_PAGE_SIZE,
  PEER_CLIENT_DEFAULT_WIRE_PROFILE,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES,
  PEER_CLIENT_STORE_RECORD_VERSION,
  type PeerClientWireProfile
} from "./types.ts";

export interface PeerRouteIdentity {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
}

/** Decrypted message committed to the local inbox before application dispatch. */
export interface PeerInboundMessage {
  readonly messageId: string;
  readonly senderPeerId: string;
  readonly senderDeviceId: string;
  readonly plaintext: Uint8Array;
  readonly receivedAt: string;
}

export const PEER_INBOUND_OUTCOME_KINDS = Object.freeze(["accepted_by_agent", "rejected", "deferred"] as const);
export type PeerInboundOutcomeKind = (typeof PEER_INBOUND_OUTCOME_KINDS)[number];
export type PeerInboundOutcome =
  | "accepted_by_agent"
  | { readonly kind: "rejected" | "deferred"; readonly detail?: Uint8Array };
export type PeerDispatchHandler = (message: PeerInboundMessage) => PeerInboundOutcome | Promise<PeerInboundOutcome>;

export interface PeerDispatchSurface {
  onInboundMessage(handler: PeerDispatchHandler): void;
  clearInboundMessageHandler(): void;
  retryPendingDispatch(): Promise<void>;
}

export interface PeerClientEvents {
  readonly inbound: PeerInboundMessage;
  readonly sendState: {
    readonly messageId: string;
    readonly peerDeviceId: string;
    readonly state: StoredOutboxEntry["state"];
    readonly lastForwarded: PeerForwarded | null;
  };
  readonly conflict: { readonly messageId: string; readonly peerDeviceId: string };
  readonly requiresRePair: { readonly peerId: string; readonly source: "send" | "inbound"; readonly detail: string };
  readonly bundlePublished: { readonly bundleId: string; readonly revision: number; readonly outcome: string };
  readonly bundleRefused: { readonly refusal: string };
  /** Presence is an exact route-scoped retry wakeup, not authorization. */
  readonly peerPresence: PeerPresence;
  readonly dispatchDeferred: { readonly messageId: string; readonly senderDeviceId: string };
  readonly error: { readonly code: string; readonly detail: string };
}

type PeerClientEventName = keyof PeerClientEvents;

export interface PeerClientOptions {
  readonly identity: PeerIdentity;
  readonly cryptoStore: PeerCryptoStore;
  readonly clientStore: PeerClientStore;
  readonly transport: PeerClientTransport;
  readonly route: PeerRouteIdentity;
  readonly directory?: PeerDeviceDirectory;
  readonly dispatch?: PeerDispatchHandler;
  readonly wireProfile?: PeerClientWireProfile;
  readonly pageSize?: number;
}

interface PendingRequest {
  readonly match: (message: Record<string, unknown>) => boolean;
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly reject: (error: unknown) => void;
}

interface DecodedPreparedRecord {
  readonly kind: "send" | "receive";
  readonly messageId: string;
  readonly entry: StoredOutboxEntry | StoredInboxEntry;
}

interface ForwardRetry {
  readonly kind: "peer-send" | "peer-delivery-ack";
  readonly identity: PeerMessageIdentity;
  readonly peerDeviceId: string;
  delayMs: number;
  waitForPresence: boolean;
  sending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type DispatchAttemptResult = "settled" | "deferred" | "not_attempted";

const CLIENT_RECEIVE_WINDOW = 16;
const CLIENT_DISPATCH_WINDOW = CLIENT_RECEIVE_WINDOW;
const OLD_PLAINTEXT_LIMIT = 57_344;
const FORWARD_RETRY_INITIAL_DELAY_MS = 1_000;
const FORWARD_RETRY_MAX_DELAY_MS = 30_000;

function jsonDecode(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")) as unknown; }
  catch { return null; }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "private_storage_capacity") return "peer_client_backpressured";
  return isPeerCryptoError(error) || isPeerClientError(error) ? error.code : "peer_client_transport";
}

/**
 * Client-owned reliable delivery over the online private relay. The relay
 * forwards ciphertext only; the exact local outbox survives uncertainty and
 * the recipient's signed durable receipt is the only delivered transition.
 */
export class PeerClient implements PeerDispatchSurface {
  readonly outbox: PeerOutbox;
  readonly inbox: PeerInbox;

  readonly #identity: PeerIdentity;
  readonly #cryptoStore: PeerCryptoStore;
  readonly #clientStore: PeerClientStore;
  readonly #transport: PeerClientTransport;
  readonly #route: PeerRouteIdentity;
  readonly #directory: PeerDeviceDirectory | null;
  readonly #wireProfile: PeerClientWireProfile;
  readonly #pageSize: number;
  readonly #listeners = new Map<PeerClientEventName, Set<(payload: never) => void>>();
  readonly #pendingRequests = new Set<PendingRequest>();
  readonly #presence = new Map<string, PeerPresence>();
  readonly #dispatching = new Map<string, Promise<DispatchAttemptResult>>();
  #dispatchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #dispatchRetryRunning = false;
  #dispatchRetryRequested = false;
  #dispatchRetryWaitingForActive = false;
  #dispatchRetryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS;
  #dispatchRetryAfterSequence = 0;
  #metaCache: PeerClientMeta | null = null;
  #dispatchHandler: PeerDispatchHandler | null = null;
  #cryptoTail: Promise<void> = Promise.resolve();
  #cryptoQueueDepth = 0;
  #storeTail: Promise<void> = Promise.resolve();
  #preparedRoute: Promise<void> | null = null;
  readonly #forwarding = new Set<string>();
  readonly #acknowledging = new Map<string, { repeat: boolean }>();
  readonly #forwardRetries = new Map<string, ForwardRetry>();
  readonly #bundleFetches = new Map<string, Promise<{ descriptor: PeerPairedSignalIdentity; bundle: ReturnType<typeof parsePeerPrekeyBundle> }>>();
  #disposed = false;
  #disposeWork: Promise<void> | null = null;

  constructor(options: PeerClientOptions) {
    this.#identity = options.identity;
    this.#cryptoStore = options.cryptoStore;
    this.#clientStore = options.clientStore;
    this.#transport = options.transport;
    this.#route = Object.freeze({
      tenantId: assertPeerClientOpaqueId(options.route.tenantId, "route.tenantId"),
      routeId: assertPeerClientOpaqueId(options.route.routeId, "route.routeId"),
      deviceId: assertPeerClientOpaqueId(options.route.deviceId, "route.deviceId")
    });
    this.#directory = options.directory ?? null;
    this.#dispatchHandler = options.dispatch ?? null;
    this.#wireProfile = options.wireProfile ?? PEER_CLIENT_DEFAULT_WIRE_PROFILE;
    this.#pageSize = Math.min(Math.max(1, options.pageSize ?? PEER_CLIENT_DEFAULT_PAGE_SIZE), 256);
    this.outbox = new PeerOutbox(options.clientStore, this.#route);
    this.inbox = new PeerInbox(options.clientStore, this.#route);
    this.#transport.onMessage?.((message) => this.handleInboundMessage(message));
  }

  on<E extends PeerClientEventName>(event: E, handler: (payload: PeerClientEvents[E]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) { set = new Set(); this.#listeners.set(event, set); }
    set.add(handler as (payload: never) => void);
    return () => set?.delete(handler as (payload: never) => void);
  }

  #emit<E extends PeerClientEventName>(event: E, payload: PeerClientEvents[E]): void {
    for (const handler of this.#listeners.get(event) ?? []) {
      try { (handler as (value: PeerClientEvents[E]) => void)(payload); } catch { /* Observers cannot break custody. */ }
    }
  }

  /** Latest relay reachability for one paired device on this exact route. */
  presence(peerDeviceId: string): PeerPresence | null {
    return this.#presence.get(assertPeerClientOpaqueId(peerDeviceId, "peerDeviceId")) ?? null;
  }

  /** Bind this route's local stores and recover prepared local state without network or application dispatch. */
  async prepareLocalState(): Promise<void> {
    await this.#withCrypto(() => Promise.resolve());
  }

  #emitSend(entry: StoredOutboxEntry): void {
    this.#emit("sendState", {
      messageId: entry.messageId,
      peerDeviceId: entry.recipientDeviceId,
      state: entry.state,
      lastForwarded: entry.lastForwarded
    });
    if (entry.state === "conflict") this.#emit("conflict", { messageId: entry.messageId, peerDeviceId: entry.recipientDeviceId });
  }

  async #prepareRoute(): Promise<void> {
    if (this.#preparedRoute) return this.#preparedRoute;
    this.#preparedRoute = this.#clientStore.prepareRoute(this.#route).catch((error: unknown) => {
      this.#preparedRoute = null;
      throw error;
    });
    return this.#preparedRoute;
  }

  #withStore<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(peerClientError("peer_client_state", "The Peer client was disposed."));
    const run = this.#storeTail.then(operation, operation);
    this.#storeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #withCrypto<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(peerClientError("peer_client_state", "The Peer client was disposed."));
    this.#cryptoQueueDepth += 1;
    const run = this.#cryptoTail.then(async () => {
      await this.#prepareRoute();
      await this.#recoverPreparedOperation();
      return operation();
    }, async () => {
      await this.#prepareRoute();
      await this.#recoverPreparedOperation();
      return operation();
    });
    this.#cryptoTail = run.then(() => undefined, () => undefined).finally(() => { this.#cryptoQueueDepth -= 1; });
    return run;
  }

  async #recoverPreparedOperation(): Promise<void> {
    const prepared = await this.#cryptoStore.loadPreparedOperation();
    if (prepared === null) return;
    const application = this.#decodePreparedRecord(prepared);
    await this.#cryptoStore.applyPreparedOperation();
    if (application.kind === "send") {
      await this.outbox.saveEntry(application.entry as StoredOutboxEntry);
    } else {
      await this.inbox.saveEntry(application.entry as StoredInboxEntry);
    }
    await this.#cryptoStore.finalizePreparedOperation(application.messageId, application.kind);
  }

  #decodePreparedRecord(prepared: PeerCryptoPreparedOperation): DecodedPreparedRecord {
    const value = jsonDecode(prepared.applicationRecord);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw peerClientError("peer_client_store", "A prepared Peer operation record is malformed.");
    }
    const entry = value as Record<string, unknown>;
    if (entry.version !== PEER_CLIENT_STORE_RECORD_VERSION || entry.messageId !== prepared.messageId) {
      throw peerClientError("peer_client_store", "A prepared Peer operation does not match its message id.");
    }
    if (prepared.kind === "send") {
      if (entry.state !== "pending" || typeof entry.recipientDeviceId !== "string" || !entry.envelope) {
        throw peerClientError("peer_client_store", "A prepared Peer send is malformed.");
      }
      return Object.freeze({ kind: "send", messageId: prepared.messageId, entry: entry as unknown as StoredOutboxEntry });
    }
    if (entry.dispatch !== "pending" || typeof entry.recipientDeviceId !== "string"
      || typeof entry.senderDeviceId !== "string" || typeof entry.plaintext !== "string" || !entry.envelope) {
      throw peerClientError("peer_client_store", "A prepared Peer receive is malformed.");
    }
    return Object.freeze({ kind: "receive", messageId: prepared.messageId, entry: entry as unknown as StoredInboxEntry });
  }

  async #meta(): Promise<PeerClientMeta> {
    if (this.#metaCache === null) this.#metaCache = (await this.#clientStore.loadMeta()) ?? emptyPeerClientMeta();
    return this.#metaCache;
  }

  async #saveMeta(patch: Partial<PeerClientMeta>): Promise<PeerClientMeta> {
    const meta = Object.freeze({ ...(await this.#meta()), ...patch });
    await this.#clientStore.saveMeta(meta);
    this.#metaCache = meta;
    return meta;
  }

  #request(
    message: Record<string, unknown>,
    match: (message: Record<string, unknown>) => boolean
  ): Promise<Record<string, unknown>> {
    if (this.#disposed) return Promise.reject(peerClientError("peer_client_state", "The Peer client was disposed."));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const expectation: PendingRequest = {
        match,
        resolve: (value) => { this.#pendingRequests.delete(expectation); resolve(value); },
        reject: (error) => { this.#pendingRequests.delete(expectation); reject(error); }
      };
      this.#pendingRequests.add(expectation);
      const failed = (error: unknown): void => {
        expectation.reject(peerClientError("peer_client_transport", "The session channel could not carry a Peer control request.", { cause: error }));
      };
      try { void Promise.resolve(this.#transport.send(message)).catch(failed); }
      catch (error: unknown) { failed(error); }
    });
  }

  /** Demultiplex control pushes before any queued decrypt or application work. */
  handleInboundMessage(value: unknown): void {
    if (this.#disposed) return;
    const parsed = parsePrivateRelayPeerMessage(value);
    if (!parsed) return;
    const message = parsed as Record<string, unknown>;
    switch (message.kind) {
      case "peer-presence": {
        const presence = parsePeerPresence(message);
        if (!presence || presence.tenantId !== this.#route.tenantId || presence.routeId !== this.#route.routeId
          || presence.deviceId !== this.#route.deviceId) return;
        const prior = this.#presence.get(presence.peerDeviceId);
        this.#presence.set(presence.peerDeviceId, presence);
        this.#emit("peerPresence", presence);
        if (presence.state === "reachable" && (prior?.state !== "reachable" || prior.sessionId !== presence.sessionId)) {
          void this.#wakePeer(presence.peerDeviceId).catch((error: unknown) => this.#emitError(error));
        }
        return;
      }
      case "peer-delivery-ack": {
        const ack = parsePeerDeliveryAck(message);
        if (ack) void this.#applyDeliveryAck(ack).catch((error: unknown) => this.#emitError(error));
        return;
      }
      case "peer-forwarded": {
        const forwarded = parsePeerForwarded(message);
        if (forwarded) void this.#applyForwarded(forwarded).catch((error: unknown) => this.#emitError(error));
        return;
      }
      case "peer-send": {
        const send = parsePeerSend(message);
        if (send) this.#admitReceive(send);
        return;
      }
      default: {
        const waiting = [...this.#pendingRequests].find((pending) => pending.match(message));
        waiting?.resolve(message);
      }
    }
  }

  #emitError(error: unknown): void {
    this.#emit("error", { code: errorCode(error), detail: error instanceof Error ? error.message : String(error) });
  }

  #clearDispatchRetry(): void {
    if (this.#dispatchRetryTimer !== null) clearTimeout(this.#dispatchRetryTimer);
    this.#dispatchRetryTimer = null;
    this.#dispatchRetryRequested = false;
    this.#dispatchRetryWaitingForActive = false;
    this.#dispatchRetryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS;
    this.#dispatchRetryAfterSequence = 0;
  }

  #scheduleDispatchRetry(): void {
    if (this.#disposed || this.#dispatchHandler === null) return;
    if (this.#dispatchRetryRunning) {
      this.#dispatchRetryRequested = true;
      return;
    }
    if (this.#dispatchRetryTimer !== null) return;
    const delay = this.#dispatchRetryDelayMs;
    this.#dispatchRetryDelayMs = Math.min(delay * 2, FORWARD_RETRY_MAX_DELAY_MS);
    this.#dispatchRetryTimer = setTimeout(() => {
      this.#dispatchRetryTimer = null;
      if (this.#disposed || this.#dispatchHandler === null) {
        this.#clearDispatchRetry();
        return;
      }
      if (this.#dispatchRetryRunning) {
        this.#dispatchRetryRequested = true;
        return;
      }
      this.#dispatchRetryRunning = true;
      this.#dispatchRetryRequested = false;
      void this.#retryPendingDispatchPages(this.#dispatchRetryAfterSequence)
        .catch((error: unknown) => {
          this.#emitError(error);
          this.#dispatchRetryAfterSequence = 0;
          this.#dispatchRetryRequested = true;
        })
        .finally(() => {
          this.#dispatchRetryRunning = false;
          if (this.#disposed || this.#dispatchHandler === null) {
            this.#dispatchRetryRequested = false;
            return;
          }
          if (this.#dispatchRetryRequested) {
            this.#dispatchRetryRequested = false;
            this.#scheduleDispatchRetry();
            return;
          }
          this.#dispatchRetryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS;
          this.#dispatchRetryAfterSequence = 0;
        });
    }, delay);
    this.#dispatchRetryTimer.unref?.();
  }

  async #retryPendingDispatchPages(afterSequence: number): Promise<void> {
    let cursor = afterSequence;
    for (;;) {
      if (this.#disposed || this.#dispatchHandler === null) return;
      const page = await this.inbox.pendingDispatchPage(cursor, this.#pageSize);
      for (const entry of page.items) {
        if (this.#disposed || this.#dispatchHandler === null) return;
        const key = JSON.stringify([entry.tenantId, entry.routeId, entry.senderDeviceId, entry.recipientDeviceId, entry.messageId]);
        if (this.#dispatching.has(key)) continue;
        void this.#dispatchEntry(entry).catch((error: unknown) => this.#emitError(error));
        if (this.#dispatchRetryWaitingForActive) {
          this.#dispatchRetryAfterSequence = 0;
          return;
        }
      }
      if (page.nextAfterSequence === null) {
        this.#dispatchRetryAfterSequence = 0;
        return;
      }
      cursor = page.nextAfterSequence;
      this.#dispatchRetryAfterSequence = cursor;
    }
  }

  /** Called only when the current admitted transport is lost. Old control
   * replies can no longer arrive; durable work and active dispatch stay owned. */
  transportLost(): void {
    this.#presence.clear();
    for (const retry of this.#forwardRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
      retry.timer = null;
      retry.waitForPresence = true;
    }
    for (const pending of [...this.#pendingRequests]) {
      pending.reject(peerClientError("peer_client_transport", "The admitted transport was lost before its Peer control response."));
    }
  }

  /** Stop local retry timers when the host retires this route client. Durable
   * outbox/inbox responsibility remains in the store for a future instance.
   * Resolves once every already-queued durable operation has settled, so a
   * caller tearing down the route's storage cannot race detached writes. */
  dispose(): Promise<void> {
    if (this.#disposeWork) return this.#disposeWork;
    this.#disposed = true;
    for (const retry of this.#forwardRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
    }
    this.#clearDispatchRetry();
    this.#forwardRetries.clear();
    this.#dispatchHandler = null;
    this.#listeners.clear();
    for (const pending of [...this.#pendingRequests]) {
      pending.reject(peerClientError("peer_client_state", "The Peer client was disposed while a control request was pending."));
    }
    this.#disposeWork = Promise.allSettled([this.#cryptoTail, this.#storeTail]).then(() => undefined);
    return this.#disposeWork;
  }

  #admitReceive(send: PeerSend): void {
    if (send.tenantId !== this.#route.tenantId || send.routeId !== this.#route.routeId
      || send.recipientDeviceId !== this.#route.deviceId || send.senderDeviceId === this.#route.deviceId) return;
    if (this.#cryptoQueueDepth >= CLIENT_RECEIVE_WINDOW) {
      this.#emit("error", { code: "peer_client_backpressured", detail: "The bounded local receive window is full; sender retains its ciphertext." });
      return;
    }
    void this.#withCrypto(() => this.#receiveSend(send))
      .then((entry) => entry ? this.#replayInboxEntry(entry, send) : undefined)
      .catch((error: unknown) => this.#emitError(error));
  }

  async #receiveSend(send: PeerSend): Promise<StoredInboxEntry | null> {
    const identity: PeerMessageIdentity = Object.freeze({
      tenantId: send.tenantId,
      routeId: send.routeId,
      senderDeviceId: send.senderDeviceId,
      recipientDeviceId: send.recipientDeviceId,
      messageId: send.messageId
    });
    const lookup = await this.inbox.lookup(identity, send.envelope);
    if (lookup.status === "conflict") {
      this.#emit("error", { code: "peer_client_conflict", detail: "A message tuple was replayed with different ciphertext." });
      return null;
    }
    if (lookup.status === "duplicate") return lookup.entry;

    const ciphertext = base64urlDecode(send.envelope.ciphertext, PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    if (ciphertext === null) return null;
    const rawEnvelope = jsonDecode(ciphertext);
    const parsedEnvelope = decodePeerEnvelope(ciphertext);
    if (!rawEnvelope || !parsedEnvelope) return null;

    const { descriptor, identityKey } = await this.#pairedSignalIdentity(send.senderDeviceId);
    if (descriptor.peerId !== parsedEnvelope.senderPeerId || parsedEnvelope.senderDeviceId !== descriptor.signalDeviceId) {
      this.#emit("requiresRePair", { peerId: descriptor.peerId, source: "inbound", detail: "The encrypted sender does not match the pinned pairing identity." });
      throw peerCryptoError("peer_identity_changed", "The encrypted sender does not match the pinned pairing identity.");
    }
    const meta = await this.#meta();
    if (meta.peers[send.senderDeviceId] !== undefined && meta.peers[send.senderDeviceId] !== descriptor.peerId) {
      this.#emit("requiresRePair", { peerId: descriptor.peerId, source: "inbound", detail: "The route device now resolves to a different pinned crypto peer." });
      throw peerCryptoError("peer_identity_changed", "The route device now resolves to a different pinned crypto peer.");
    }

    await pinPeerIdentity(this.#cryptoStore, { peerId: descriptor.peerId, identityKey, peerDeviceId: descriptor.signalDeviceId });
    const overlay = createPeerCryptoTransactionOverlay(this.#cryptoStore);
    let plaintext: Uint8Array;
    try {
      if (parsedEnvelope.messageType === "prekey") {
        const accepted = await acceptPeerSession({ identity: this.#identity, localStore: overlay.store, envelope: rawEnvelope });
        plaintext = accepted.plaintext;
      } else {
        const session = await resumePeerSession({
          identity: this.#identity,
          localStore: overlay.store,
          peerId: parsedEnvelope.senderPeerId,
          peerDeviceId: parsedEnvelope.senderDeviceId
        });
        plaintext = await session.decrypt({ messageType: parsedEnvelope.messageType, body: parsedEnvelope.body });
      }
    } catch (error: unknown) {
      // A Signal duplicate under a new transport tuple is not evidence that
      // this message id was durably committed. Record it without a receipt.
      if (isPeerCryptoError(error, "peer_duplicate_message")) {
        const sequence = await this.#clientStore.allocateInboxSequence({ tenantId: this.#route.tenantId, routeId: this.#route.routeId });
        const skipped = this.inbox.createEntry({
          identity,
          sequence,
          senderPeerId: descriptor.peerId,
          envelope: send.envelope,
          plaintext: null,
          decryptError: error.code,
          dispatch: "skipped",
          deliveryAck: null
        });
        await this.inbox.record(skipped);
      }
      throw error;
    }

    const sequence = await this.#clientStore.allocateInboxSequence({ tenantId: this.#route.tenantId, routeId: this.#route.routeId });
    const entry = this.inbox.createEntry({
      identity,
      sequence,
      senderPeerId: descriptor.peerId,
      envelope: send.envelope,
      plaintext: base64urlEncode(plaintext),
      decryptError: null,
      dispatch: "pending",
      deliveryAck: null
    });
    const prepared: PeerCryptoPreparedOperation = Object.freeze({
      version: 1,
      kind: "receive",
      messageId: send.messageId,
      mutations: overlay.mutations(),
      applicationRecord: Buffer.from(JSON.stringify(entry), "utf8"),
      preparedAt: new Date().toISOString()
    });
    await this.#clientStore.assertAvailableCapacity(Buffer.byteLength(JSON.stringify(entry), "utf8") + 4_096);
    await this.#cryptoStore.prepareOperation(prepared);
    await this.#recoverPreparedOperation();

    return this.inbox.entry(identity);
  }

  async #replayInboxEntry(entry: StoredInboxEntry, send: PeerSend): Promise<void> {
    try {
      if (entry.deliveryAck !== null || entry.plaintext !== null) await this.#createAndForwardAck(entry, send);
    } catch (error: unknown) { this.#emitError(error); }
    if (entry.dispatch === "pending") await this.#dispatchEntry(entry);
  }

  async #createAndForwardAck(entry: StoredInboxEntry, send: PeerSend): Promise<void> {
    const key = JSON.stringify([entry.tenantId, entry.routeId, entry.senderDeviceId, entry.recipientDeviceId, entry.messageId]);
    const active = this.#acknowledging.get(key);
    if (active) {
      active.repeat = true;
      return;
    }
    const state = { repeat: false };
    this.#acknowledging.set(key, state);
    try {
      let attempts = 0;
      do {
        state.repeat = false;
        await this.#forwardStoredAck(entry, send);
        attempts += 1;
      } while (state.repeat && attempts < 2);
      if (state.repeat) this.#scheduleForwardRetry("peer-delivery-ack", entry, entry.senderDeviceId);
    } finally {
      this.#acknowledging.delete(key);
    }
  }

  async #forwardStoredAck(entry: StoredInboxEntry, send: PeerSend): Promise<void> {
    try {
      const current = await this.inbox.entry(entry);
      if (!current) return;
      if (current.deliveryAck !== null) {
        const identity: PeerMessageIdentity = current;
        const retry = this.#forwardRetries.get(this.#forwardRetryKey("peer-delivery-ack", identity));
        if (retry?.timer !== null && retry?.timer !== undefined) return;
        if (retry?.sending) return;
        if (retry) {
          retry.waitForPresence = false;
          await this.#retryForward(retry);
          return;
        }
        await this.#sendAck(current.deliveryAck);
        return;
      }
      if (current.plaintext === null) return;
      const signingInput = await peerDeliveryAckSigningInputForSend(send);
      if (!signingInput) throw peerClientError("peer_client_state", "The committed send cannot produce a signed delivery receipt.");
      const signature = base64urlEncode(signPeerIdentityMessage(
        this.#identity,
        Buffer.from(peerDeliveryAckTranscript(signingInput), "utf8")
      ));
      const ack = createPeerDeliveryAck({ ...signingInput, signature });
      const saved = await this.#withStore(() => this.inbox.markDeliveryAck(current, ack));
      if (saved?.deliveryAck !== null && saved?.deliveryAck !== undefined) await this.#sendAck(saved.deliveryAck);
    } catch (error: unknown) { this.#emitError(error); }
  }

  async #sendAck(ack: PeerDeliveryAck): Promise<void> {
    try {
      await this.#transport.send(ack as unknown as Record<string, unknown>);
    } catch (error: unknown) {
      const identity: PeerMessageIdentity = Object.freeze({
        tenantId: ack.tenantId,
        routeId: ack.routeId,
        senderDeviceId: ack.senderDeviceId,
        recipientDeviceId: ack.recipientDeviceId,
        messageId: ack.messageId
      });
      this.#scheduleForwardRetry("peer-delivery-ack", identity, ack.senderDeviceId);
      throw error;
    }
  }

  async #applyDeliveryAck(ack: PeerDeliveryAck): Promise<void> {
    if (ack.tenantId !== this.#route.tenantId || ack.routeId !== this.#route.routeId
      || ack.senderDeviceId !== this.#route.deviceId || ack.recipientDeviceId === this.#route.deviceId) return;
    const identity: PeerMessageIdentity = Object.freeze({
      tenantId: ack.tenantId,
      routeId: ack.routeId,
      senderDeviceId: ack.senderDeviceId,
      recipientDeviceId: ack.recipientDeviceId,
      messageId: ack.messageId
    });
    const entry = await this.#withStore(() => this.outbox.entryForIdentity(identity));
    if (!entry || entry.state === "conflict") return;
    const send = createPeerSend({
      tenantId: entry.tenantId,
      routeId: entry.routeId,
      senderDeviceId: entry.senderDeviceId,
      recipientDeviceId: entry.recipientDeviceId,
      messageId: entry.messageId,
      envelope: entry.envelope
    });
    if (!await peerDeliveryAckMatchesSend(ack, send)) {
      this.#emit("error", { code: "peer_client_invalid_delivery_ack", detail: "A receipt did not match the exact pending ciphertext." });
      return;
    }
    const { descriptor } = await this.#pairedSignalIdentity(ack.recipientDeviceId);
    const binding = await peerIdentityBinding(this.#cryptoStore, descriptor.peerId);
    const pinnedIdentityKey = binding?.state === "active" ? base64urlDecode(binding.identityKey, 512) : null;
    const pairedIdentityKey = base64urlDecode(descriptor.identityKey, 512);
    const signatureBytes = base64urlDecode(ack.signature, 64);
    if (!binding || binding.state !== "active" || !pinnedIdentityKey || !pairedIdentityKey
      || Buffer.compare(pinnedIdentityKey, pairedIdentityKey) !== 0
      || signatureBytes === null
      || !verifyPeerIdentityMessage(
        pinnedIdentityKey,
        Buffer.from(peerDeliveryAckTranscript({
          tenantId: ack.tenantId,
          routeId: ack.routeId,
          senderDeviceId: ack.senderDeviceId,
          recipientDeviceId: ack.recipientDeviceId,
          messageId: ack.messageId,
          ciphertextDigest: ack.ciphertextDigest
        }), "utf8"),
        signatureBytes
      )) {
      this.#emit("error", { code: "peer_client_invalid_delivery_ack", detail: "A receipt signature did not match the active pairing-pinned Signal identity." });
      return;
    }
    const next = await this.#withStore(() => this.outbox.applyDeliveryAck(identity, ack));
    if (next) {
      this.#clearForwardRetry("peer-send", identity);
      this.#emitSend(next);
      void this.#drivePending(undefined, false).catch((error: unknown) => this.#emitError(error));
    }
  }

  async #applyForwarded(forwarded: PeerForwarded): Promise<void> {
    if (forwarded.tenantId !== this.#route.tenantId || forwarded.routeId !== this.#route.routeId
      || forwarded.sourceDeviceId !== this.#route.deviceId || forwarded.targetDeviceId === this.#route.deviceId) return;
    if (forwarded.requestKind === "peer-send") {
      const identity = this.outbox.identity(forwarded.messageId, forwarded.targetDeviceId);
      const entry = await this.#withStore(() => this.outbox.noteForwarded(identity, forwarded));
      if (entry) this.#emitSend(entry);
      if (!entry || entry.state !== "pending") {
        this.#clearForwardRetry("peer-send", identity);
        return;
      }
      if (forwarded.outcome === "endpoint_unreachable") {
        this.#waitForPeerPresence("peer-send", identity, forwarded.targetDeviceId);
        return;
      }
      if (forwarded.outcome === "forwarded" || this.#isRetryableForward(forwarded)) this.#scheduleForwardRetry("peer-send", identity, forwarded.targetDeviceId);
      else this.#clearForwardRetry("peer-send", identity);
      return;
    }

    // For a delivery ACK, the wire source is the recipient and its target is
    // the original sender. Reconstruct the original tuple before looking up
    // the durable inbox receipt; a same-ID peer-send cannot consume this result.
    const identity: PeerMessageIdentity = Object.freeze({
      tenantId: forwarded.tenantId,
      routeId: forwarded.routeId,
      senderDeviceId: forwarded.targetDeviceId,
      recipientDeviceId: forwarded.sourceDeviceId,
      messageId: forwarded.messageId
    });
    const entry = await this.#withStore(() => this.inbox.entry(identity));
    if (!entry || entry.deliveryAck === null) {
      this.#clearForwardRetry("peer-delivery-ack", identity);
      return;
    }
    if (forwarded.outcome === "forwarded") {
      this.#clearForwardRetry("peer-delivery-ack", identity);
      return;
    }
    if (forwarded.outcome === "endpoint_unreachable") {
      this.#waitForPeerPresence("peer-delivery-ack", identity, forwarded.targetDeviceId);
      return;
    }
    if (this.#isRetryableForward(forwarded)) this.#scheduleForwardRetry("peer-delivery-ack", identity, forwarded.targetDeviceId);
    else this.#clearForwardRetry("peer-delivery-ack", identity);
  }

  #isRetryableForward(forwarded: PeerForwarded): boolean {
    return forwarded.outcome === "backpressured"
      || (forwarded.outcome === "refused" && (forwarded.refusal === "authority_stale" || forwarded.refusal === "rate_limited"));
  }

  #forwardRetryKey(kind: ForwardRetry["kind"], identity: PeerMessageIdentity): string {
    return JSON.stringify([kind, identity.tenantId, identity.routeId, identity.senderDeviceId,
      identity.recipientDeviceId, identity.messageId]);
  }

  #clearForwardRetry(kind: ForwardRetry["kind"], identity: PeerMessageIdentity): void {
    const key = this.#forwardRetryKey(kind, identity);
    const retry = this.#forwardRetries.get(key);
    if (!retry) return;
    if (retry.timer !== null) clearTimeout(retry.timer);
    this.#forwardRetries.delete(key);
  }

  #retryFor(kind: ForwardRetry["kind"], identity: PeerMessageIdentity, peerDeviceId: string): ForwardRetry {
    const key = this.#forwardRetryKey(kind, identity);
    let retry = this.#forwardRetries.get(key);
    if (retry) return retry;
    retry = {
      kind,
      identity: Object.freeze({ ...identity }),
      peerDeviceId,
      delayMs: FORWARD_RETRY_INITIAL_DELAY_MS,
      waitForPresence: false,
      sending: false,
      timer: null
    };
    this.#forwardRetries.set(key, retry);
    return retry;
  }

  #scheduleForwardRetry(kind: ForwardRetry["kind"], identity: PeerMessageIdentity, peerDeviceId: string): void {
    if (this.#disposed) return;
    const retry = this.#retryFor(kind, identity, peerDeviceId);
    retry.waitForPresence = false;
    if (retry.timer !== null) return;
    if (this.presence(peerDeviceId)?.state !== "reachable") {
      retry.waitForPresence = true;
      return;
    }
    const key = this.#forwardRetryKey(kind, identity);
    retry.timer = setTimeout(() => {
      if (this.#forwardRetries.get(key) !== retry) return;
      retry.timer = null;
      if (this.#disposed) {
        this.#clearForwardRetry(kind, identity);
        return;
      }
      if (this.presence(peerDeviceId)?.state !== "reachable") {
        retry.waitForPresence = true;
        return;
      }
      retry.delayMs = Math.min(retry.delayMs * 2, FORWARD_RETRY_MAX_DELAY_MS);
      void this.#retryForward(retry).catch((error: unknown) => {
        this.#emitError(error);
        if (this.#forwardRetries.get(key) === retry && retry.timer === null) {
          this.#scheduleForwardRetry(retry.kind, retry.identity, retry.peerDeviceId);
        }
      });
    }, retry.delayMs);
    // A pending business delivery must not keep an otherwise idle host alive.
    retry.timer.unref?.();
  }

  #waitForPeerPresence(kind: ForwardRetry["kind"], identity: PeerMessageIdentity, peerDeviceId: string): void {
    if (this.#disposed) return;
    const retry = this.#retryFor(kind, identity, peerDeviceId);
    if (retry.timer !== null) clearTimeout(retry.timer);
    retry.timer = null;
    retry.waitForPresence = true;
  }

  async #retryForward(retry: ForwardRetry): Promise<void> {
    const key = this.#forwardRetryKey(retry.kind, retry.identity);
    if (this.#forwardRetries.get(key) !== retry || retry.sending) return;
    if (this.presence(retry.peerDeviceId)?.state !== "reachable") {
      retry.waitForPresence = true;
      return;
    }
    retry.waitForPresence = false;
    retry.sending = true;
    try {
      if (retry.kind === "peer-send") {
        const entry = await this.#withStore(() => this.outbox.entryForIdentity(retry.identity));
        if (!entry || entry.state !== "pending") {
          this.#clearForwardRetry(retry.kind, retry.identity);
          return;
        }
        if (this.#forwardRetries.get(key) !== retry) return;
        await this.#forwardEntry(entry);
        return;
      }
      const entry = await this.#withStore(() => this.inbox.entry(retry.identity));
      if (!entry || entry.deliveryAck === null) {
        this.#clearForwardRetry(retry.kind, retry.identity);
        return;
      }
      if (this.#disposed || this.#forwardRetries.get(key) !== retry) return;
      await this.#sendAck(entry.deliveryAck);
    } finally {
      retry.sending = false;
    }
  }

  async #retryTrackedForPeer(peerDeviceId: string): Promise<void> {
    for (const retry of this.#forwardRetries.values()) {
      if (retry.peerDeviceId !== peerDeviceId || !retry.waitForPresence) continue;
      retry.waitForPresence = false;
      if (retry.timer !== null) clearTimeout(retry.timer);
      retry.timer = null;
      await this.#retryForward(retry);
    }
  }

  async #pairedSignalIdentity(peerDeviceId: string): Promise<{ readonly descriptor: PeerPairedSignalIdentity; readonly identityKey: Uint8Array }> {
    const descriptor = this.#directory ? await this.#directory.resolvePeerIdentity(peerDeviceId) : null;
    if (descriptor === null) throw peerClientError("peer_client_unknown_peer", "The route device has no authenticated paired Signal identity.");
    const peerId = assertPeerClientPeerId(descriptor.peerId, "pairedIdentity.peerId");
    const expectedPeerId = peerIdForRouteDevice({ tenantId: this.#route.tenantId, routeId: this.#route.routeId, deviceId: peerDeviceId });
    if (expectedPeerId === null || peerId !== expectedPeerId) {
      throw peerClientError("peer_client_unknown_peer", "The pairing identity is not bound to this exact route device.");
    }
    const identityKey = base64urlDecode(descriptor.identityKey, 512);
    if (!identityKey || descriptor.signalDeviceId !== PEER_DEVICE_ID
      || !Number.isSafeInteger(descriptor.registrationId) || descriptor.registrationId < 1 || descriptor.registrationId > 0x3fff) {
      throw peerClientError("peer_client_unknown_peer", "The paired Signal identity descriptor is malformed.");
    }
    return { descriptor: Object.freeze({ ...descriptor, peerId }), identityKey };
  }

  async #remoteBundle(peerDeviceId: string, descriptor: PeerPairedSignalIdentity): Promise<ReturnType<typeof parsePeerPrekeyBundle>> {
    const pending = this.#bundleFetches.get(peerDeviceId);
    if (pending) return (await pending).bundle;
    const promise = (async () => {
      const response = await this.#request(createPeerBundleFetch({
        tenantId: this.#route.tenantId,
        routeId: this.#route.routeId,
        deviceId: this.#route.deviceId,
        peerDeviceId
      }), (message) => message.kind === "peer-bundle" && message.deviceId === peerDeviceId && message.routeId === this.#route.routeId);
      const bundleMessage = parsePeerBundle(response);
      if (!bundleMessage || bundleMessage.deviceId !== peerDeviceId) throw peerClientError("peer_client_transport", "The peer bundle response is malformed or out of route scope.");
      if (bundleMessage.state === "refused") throw peerClientError("peer_client_bundle_unavailable", `The bundle was refused: ${bundleMessage.refusal}.`);
      if (bundleMessage.state !== "available" || bundleMessage.bundle === null) throw peerClientError("peer_client_bundle_unavailable", "The paired device has not published a prekey bundle.");
      const bytes = base64urlDecode(bundleMessage.bundle.material, PRIVATE_RELAY_PEER_LIMITS.maxBundleBytes);
      const bundle = bytes === null ? null : parsePeerPrekeyBundle(jsonDecode(bytes));
      if (!bundle || bundle.peerId !== descriptor.peerId || bundle.deviceId !== descriptor.signalDeviceId
        || bundle.registrationId !== descriptor.registrationId || bundle.identityKey !== descriptor.identityKey) {
        this.#emit("requiresRePair", { peerId: descriptor.peerId, source: "send", detail: "The bundle differs from the authenticated pairing identity." });
        throw peerCryptoError("peer_identity_changed", "The fetched prekey bundle does not match the pairing identity.");
      }
      const observation: StoredBundleObservation = Object.freeze({
        bundleId: bundleMessage.bundle.bundleId,
        revision: bundleMessage.bundle.revision,
        oneTimePreKeyId: bundle.oneTimePreKey?.id ?? null,
        signedPrekeyId: bundle.signedPreKey.id
      });
      const meta = await this.#meta();
      await this.#saveMeta({
        peers: Object.freeze({ ...meta.peers, [peerDeviceId]: descriptor.peerId }),
        bundleObservations: Object.freeze({ ...meta.bundleObservations, [peerDeviceId]: observation })
      });
      return { descriptor, bundle };
    })();
    this.#bundleFetches.set(peerDeviceId, promise);
    try { return (await promise).bundle; }
    finally { if (this.#bundleFetches.get(peerDeviceId) === promise) this.#bundleFetches.delete(peerDeviceId); }
  }

  async #sessionFor(peerDeviceId: string, localStore: PeerCryptoStore): Promise<{
    readonly session: PeerCryptoSession;
    readonly peerId: string;
    readonly observation: StoredBundleObservation | null;
  }> {
    const meta = await this.#meta();
    const { descriptor, identityKey } = await this.#pairedSignalIdentity(peerDeviceId);
    if (meta.peers[peerDeviceId] !== undefined && meta.peers[peerDeviceId] !== descriptor.peerId) {
      this.#emit("requiresRePair", { peerId: descriptor.peerId, source: "send", detail: "The paired device resolves to a different retained Signal identity." });
      throw peerCryptoError("peer_identity_changed", "The route's authenticated Signal identity changed.");
    }
    await pinPeerIdentity(this.#cryptoStore, { peerId: descriptor.peerId, identityKey, peerDeviceId: descriptor.signalDeviceId });
    const binding = await peerIdentityBinding(this.#cryptoStore, descriptor.peerId);
    if (binding !== null && binding.state !== "active") {
      this.#emit("requiresRePair", { peerId: descriptor.peerId, source: "send", detail: "The pinned peer identity is blocked." });
      throw peerCryptoError("peer_identity_changed", "The pinned peer identity is blocked.");
    }
    const observation = meta.bundleObservations[peerDeviceId] ?? null;
    if (await peerSessionExists(this.#cryptoStore, descriptor.peerId)) {
      const session = await resumePeerSession({ identity: this.#identity, localStore, peerId: descriptor.peerId, peerDeviceId: descriptor.signalDeviceId });
      return { session, peerId: descriptor.peerId, observation };
    }
    const bundle = await this.#remoteBundle(peerDeviceId, descriptor);
    if (!bundle) throw peerClientError("peer_client_bundle_unavailable", "The prekey bundle could not be decoded.");
    const session = await initiatePeerSession({ identity: this.#identity, localStore, remoteBundle: bundle });
    return { session, peerId: descriptor.peerId, observation: (await this.#meta()).bundleObservations[peerDeviceId] ?? null };
  }

  async #wireEnvelope(envelope: CryptoPeerEnvelope, observation: StoredBundleObservation | null): Promise<PeerEnvelope> {
    const local = await this.#localBundle();
    return Object.freeze({
      format: this.#wireProfile,
      headers: Object.freeze({
        messageType: envelope.messageType === "prekey" ? "prekey" as const : "session" as const,
        senderBundleId: local.bundleId,
        recipientBundleId: observation?.bundleId ?? "unpublished",
        prekeyId: observation?.oneTimePreKeyId == null ? null : `opk.${observation.oneTimePreKeyId}`,
        signedPrekeyId: observation?.signedPrekeyId == null ? null : `spk.${observation.signedPrekeyId}`,
        baseKeyId: null
      }),
      ciphertext: base64urlEncode(encodePeerEnvelope(envelope))
    });
  }

  async #localBundle() {
    const meta = await this.#meta();
    if (meta.localBundle) return meta.localBundle;
    const bundle = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      bundleId: newPeerBundleId(),
      revision: 0,
      format: this.#wireProfile as string,
      material: null
    });
    await this.#saveMeta({ localBundle: bundle });
    return bundle;
  }

  async sendMessage(peerDeviceId: string, plaintext: Uint8Array | string, options: { readonly messageId?: string } = {}): Promise<StoredOutboxEntry> {
    await this.#prepareRoute();
    const recipient = assertPeerClientOpaqueId(peerDeviceId, "peerDeviceId");
    if (recipient === this.#route.deviceId) throw peerClientError("peer_client_state", "A device cannot send to itself.");
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
      throw peerClientError("peer_client_state", "The Peer plaintext is empty or exceeds the supported encoded size.");
    }
    const messageId = options.messageId === undefined ? newPeerMessageId() : assertPeerClientOpaqueId(options.messageId, "messageId");
    const identity = this.outbox.identity(messageId, recipient);
    const existing = await this.outbox.entryForIdentity(identity);
    if (existing) {
      if (existing.state === "conflict") throw peerClientError("peer_client_conflict", "This message identity is already conflicted.");
      if (existing.state === "pending"
        && !this.#forwardRetries.has(this.#forwardRetryKey("peer-send", identity))) await this.#forwardEntry(existing);
      return (await this.outbox.entryForIdentity(identity)) ?? existing;
    }

    return this.#withCrypto(async () => {
      // A prior process may have crashed after the ratchet+outbox WAL commit
      // but before the caller observed success. Recovery above owns that ID;
      // never encrypt the same logical identity again.
      const recovered = await this.outbox.entryForIdentity(identity);
      if (recovered) {
        if (recovered.state === "conflict") throw peerClientError("peer_client_conflict", "This message identity is already conflicted.");
        return recovered;
      }
      const overlay = createPeerCryptoTransactionOverlay(this.#cryptoStore);
      const { session, peerId, observation } = await this.#sessionFor(recipient, overlay.store);
      const encrypted = await session.encrypt(bytes);
      const cryptoEnvelope = serializePeerEnvelope(session.envelopeHeader(), encrypted);
      const envelope = await this.#wireEnvelope(cryptoEnvelope, observation);
      const sequence = await this.#clientStore.allocateOutboxSequence({ tenantId: this.#route.tenantId, routeId: this.#route.routeId });
      const entry = await this.outbox.createEntry({ recipientDeviceId: recipient, messageId, peerId, envelope, sequence });
      const prepared: PeerCryptoPreparedOperation = Object.freeze({
        version: 1,
        kind: "send",
        messageId,
        mutations: overlay.mutations(),
        applicationRecord: Buffer.from(JSON.stringify(entry), "utf8"),
        preparedAt: new Date().toISOString()
      });
      await this.#cryptoStore.prepareOperation(prepared);
      await this.#recoverPreparedOperation();
      const saved = await this.outbox.entryForIdentity(identity);
      if (!saved) throw peerClientError("peer_client_store", "The prepared ciphertext was not committed to the durable outbox.");
      this.#emitSend(saved);
      return saved;
    }).then(async (entry) => {
      await this.#forwardEntry(entry);
      return (await this.outbox.entryForIdentity(identity)) ?? entry;
    });
  }

  async #forwardEntry(entry: StoredOutboxEntry): Promise<void> {
    if (this.#disposed || entry.state !== "pending") return;
    const key = JSON.stringify([entry.tenantId, entry.routeId, entry.senderDeviceId, entry.recipientDeviceId, entry.messageId]);
    if (this.#forwarding.has(key)) return;
    this.#forwarding.add(key);
    try {
      const pending = await this.outbox.pendingPage(0, CLIENT_RECEIVE_WINDOW);
      if (!pending.items.some((candidate) => candidate.messageId === entry.messageId && candidate.recipientDeviceId === entry.recipientDeviceId)) return;
      const updated = await this.#withStore(() => this.outbox.markAttempt(this.outbox.identity(entry.messageId, entry.recipientDeviceId)));
      if (!updated || updated.state !== "pending" || this.#disposed) return;
      const send = createPeerSend({
        tenantId: updated.tenantId,
        routeId: updated.routeId,
        senderDeviceId: updated.senderDeviceId,
        recipientDeviceId: updated.recipientDeviceId,
        messageId: updated.messageId,
        envelope: updated.envelope
      });
      // A relay-forwarded frame may still fail receiver admission or durable
      // storage. Keep retrying this exact ciphertext until a signed ACK settles it.
      this.#scheduleForwardRetry("peer-send", updated, updated.recipientDeviceId);
      try {
        await this.#transport.send(send as unknown as Record<string, unknown>);
      } catch (error: unknown) {
        this.#scheduleForwardRetry("peer-send", this.outbox.identity(updated.messageId, updated.recipientDeviceId), updated.recipientDeviceId);
        this.#emitError(error);
      }
    } finally {
      this.#forwarding.delete(key);
    }
  }

  async #drivePending(peerDeviceId?: string, force = false): Promise<void> {
    // The first page is the entire unconfirmed window. Anything later remains
    // sender-owned and is released in FIFO order as signed ACKs settle rows.
    const page = await this.outbox.pendingPage(0, CLIENT_RECEIVE_WINDOW);
    for (const entry of page.items) {
      if (peerDeviceId !== undefined && entry.recipientDeviceId !== peerDeviceId) continue;
      const presence = this.presence(entry.recipientDeviceId);
      if (presence?.state === "unreachable") continue;
      if (this.#forwardRetries.has(this.#forwardRetryKey("peer-send", entry))) continue;
      if (entry.lastForwarded !== null && (!force || presence?.state !== "reachable")) continue;
      await this.#forwardEntry(entry);
    }
  }

  async #wakePeer(peerDeviceId: string): Promise<void> {
    await this.#retryTrackedForPeer(peerDeviceId);
    await this.#retryAcksForPeer(peerDeviceId);
    await this.#drivePending(peerDeviceId, true);
  }

  async #retryAcksForPeer(peerDeviceId?: string): Promise<void> {
    let afterSequence = 0;
    for (;;) {
      const page = await this.inbox.pendingDeliveryAckPage(afterSequence, this.#pageSize);
      for (const entry of page.items) {
        if (entry.plaintext === null || entry.deliveryAck !== null) continue;
        if (peerDeviceId !== undefined && entry.senderDeviceId !== peerDeviceId) continue;
        const send = createPeerSend({
          tenantId: entry.tenantId,
          routeId: entry.routeId,
          senderDeviceId: entry.senderDeviceId,
          recipientDeviceId: entry.recipientDeviceId,
          messageId: entry.messageId,
          envelope: entry.envelope
        });
        await this.#createAndForwardAck(entry, send);
      }
      if (page.nextAfterSequence === null) return;
      afterSequence = page.nextAfterSequence;
    }
  }

  onInboundMessage(handler: PeerDispatchHandler): void {
    this.#dispatchHandler = handler;
    void this.retryPendingDispatch().catch((error: unknown) => this.#emitError(error));
  }

  clearInboundMessageHandler(): void {
    this.#dispatchHandler = null;
    this.#clearDispatchRetry();
  }

  async retryPendingDispatch(): Promise<void> {
    if (this.#disposed || this.#dispatchHandler === null) return;
    await this.#prepareRoute();
    let afterSequence = 0;
    for (;;) {
      const page = await this.inbox.pendingDispatchPage(afterSequence, this.#pageSize);
      for (const entry of page.items) await this.#dispatchEntry(entry);
      if (page.nextAfterSequence === null) break;
      afterSequence = page.nextAfterSequence;
    }
  }

  async #dispatchEntry(entry: StoredInboxEntry): Promise<DispatchAttemptResult> {
    const handler = this.#dispatchHandler;
    if (this.#disposed || handler === null || entry.plaintext === null || entry.dispatch !== "pending") return "not_attempted";
    const key = JSON.stringify([entry.tenantId, entry.routeId, entry.senderDeviceId, entry.recipientDeviceId, entry.messageId]);
    const active = this.#dispatching.get(key);
    if (active) return active;
    if (this.#dispatching.size >= CLIENT_DISPATCH_WINDOW) {
      this.#dispatchRetryWaitingForActive = true;
      return "not_attempted";
    }
    const work = this.#dispatchEntryOnce(entry, handler);
    this.#dispatching.set(key, work);
    let result: DispatchAttemptResult;
    try {
      result = await work;
    } catch (error: unknown) {
      this.#emitError(error);
      result = "deferred";
    } finally {
      if (this.#dispatching.get(key) === work) this.#dispatching.delete(key);
    }
    if (this.#dispatchRetryWaitingForActive) {
      this.#dispatchRetryWaitingForActive = false;
      this.#dispatchRetryAfterSequence = 0;
      this.#scheduleDispatchRetry();
    }
    if (result === "deferred") this.#scheduleDispatchRetry();
    return result;
  }

  async #dispatchEntryOnce(snapshot: StoredInboxEntry, handler: PeerDispatchHandler): Promise<DispatchAttemptResult> {
    const entry = await this.#withStore(() => this.inbox.entry(snapshot));
    if (this.#dispatchHandler !== handler) return "not_attempted";
    if (!entry || entry.dispatch !== "pending") return "settled";
    if (entry.plaintext === null) return "not_attempted";
    {
      const plaintext = base64urlDecode(entry.plaintext, OLD_PLAINTEXT_LIMIT);
      if (plaintext === null) {
        this.#emit("error", { code: "peer_client_store", detail: "A durable inbox plaintext cannot be decoded." });
        return "not_attempted";
      }
      const message: PeerInboundMessage = Object.freeze({
        messageId: entry.messageId,
        senderPeerId: entry.senderPeerId ?? "",
        senderDeviceId: entry.senderDeviceId,
        plaintext,
        receivedAt: entry.receivedAt
      });
      let outcome: PeerInboundOutcome;
      try { outcome = await handler(message); }
      catch (error: unknown) {
        this.#emit("dispatchDeferred", { messageId: entry.messageId, senderDeviceId: entry.senderDeviceId });
        this.#emitError(error);
        return "deferred";
      }
      const kind = typeof outcome === "string" ? outcome : outcome?.kind;
      if (kind === "deferred") {
        this.#emit("dispatchDeferred", { messageId: entry.messageId, senderDeviceId: entry.senderDeviceId });
        return "deferred";
      }
      if (kind !== "accepted_by_agent" && kind !== "rejected") {
        this.#emit("error", { code: "peer_client_state", detail: "The inbound handler returned an invalid dispatch outcome." });
        return "deferred";
      }
      const identity: PeerMessageIdentity = entry;
      await this.#withStore(() => this.inbox.markDispatch(identity, kind));
      this.#emit("inbound", message);
      return "settled";
    }
  }

  async publishBundle(): Promise<{ readonly bundleId: string; readonly revision: number; readonly outcome: string }> {
    await this.#prepareRoute();
    let bundle;
    try { bundle = await generatePrekeyBundle(this.#identity); }
    catch (error: unknown) {
      if (!isPeerCryptoError(error, "peer_prekey_exhausted")) throw error;
      await replenishPeerPrekeys(this.#identity);
      bundle = await generatePrekeyBundle(this.#identity);
    }
    const material = base64urlEncode(Buffer.from(JSON.stringify(bundle), "utf8"));
    const local = await this.#localBundle();
    let revision = local.revision + 1;
    let retriedStale = false;
    for (;;) {
      const response = await this.#request(createPeerBundlePublish({
        tenantId: this.#route.tenantId,
        routeId: this.#route.routeId,
        deviceId: this.#route.deviceId,
        bundle: { format: this.#wireProfile, bundleId: local.bundleId, revision, material }
      }), (message) => message.kind === "peer-bundle-published" && message.routeId === this.#route.routeId
        && message.deviceId === this.#route.deviceId && message.bundleId === local.bundleId);
      const published = parsePeerBundlePublished(response);
      if (!published || published.deviceId !== this.#route.deviceId || published.bundleId !== local.bundleId) {
        throw peerClientError("peer_client_transport", "The prekey publish response is malformed or out of scope.");
      }
      if (published.outcome === "refused") {
        if (published.refusal === "stale_revision" && !retriedStale) {
          retriedStale = true;
          revision = published.currentRevision + 1;
          continue;
        }
        this.#emit("bundleRefused", { refusal: published.refusal ?? "authority_stale" });
        throw peerClientError("peer_client_bundle_unavailable", `The prekey bundle was refused: ${published.refusal}.`);
      }
      await this.#saveMeta({
        localBundle: Object.freeze({
          version: PEER_CLIENT_STORE_RECORD_VERSION,
          bundleId: local.bundleId,
          revision: published.currentRevision,
          format: this.#wireProfile,
          material
        })
      });
      this.#emit("bundlePublished", { bundleId: local.bundleId, revision: published.currentRevision, outcome: published.outcome });
      return Object.freeze({ bundleId: local.bundleId, revision: published.currentRevision, outcome: published.outcome });
    }
  }

  /** Reconcile only device-local durable work over the online transport. */
  async sync(): Promise<void> { await this.resume(); }

  async resume(): Promise<void> {
    await this.#prepareRoute();
    await this.#withCrypto(() => Promise.resolve());
    await this.#retryAcksForPeer();
    await this.retryPendingDispatch();
    await this.#drivePending(undefined, true);
  }

  async repinPeer(peerId: string, newIdentityKey: Uint8Array): Promise<PeerIdentityBinding> {
    return repinPeerIdentity(this.#cryptoStore, peerId, newIdentityKey);
  }

  async blockPeer(peerId: string): Promise<PeerIdentityBinding | null> {
    return blockPeerIdentity(this.#cryptoStore, peerId);
  }

  async peerSafetyNumberFor(peerId: string): Promise<string | null> {
    const binding = await peerIdentityBinding(this.#cryptoStore, peerId);
    if (!binding || binding.state !== "active") return null;
    const key = base64urlDecode(binding.identityKey, 512);
    if (key === null) return null;
    return peerSafetyNumber(this.#identity, { peerId, identityKey: key });
  }

  async learnedPeers(): Promise<Readonly<Record<string, string>>> { return (await this.#meta()).peers; }

  async localBundle(): Promise<{ readonly bundleId: string; readonly revision: number } | null> {
    const bundle = (await this.#meta()).localBundle;
    return bundle === null ? null : Object.freeze({ bundleId: bundle.bundleId, revision: bundle.revision });
  }
}
