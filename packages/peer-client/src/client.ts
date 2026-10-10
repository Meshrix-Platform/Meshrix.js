import { Buffer } from "node:buffer";

import {
  createPeerAck,
  createPeerBundleFetch,
  createPeerBundlePublish,
  createPeerFetch,
  createPeerRetentionPolicy,
  createPeerSend,
  parsePeerAccepted,
  parsePeerAcked,
  parsePeerBundle,
  parsePeerBundlePublished,
  parsePeerMessages,
  parsePeerRetentionPolicy,
  parsePrivateRelayPeerMessage,
  PRIVATE_RELAY_PEER_LIMITS
} from "@meshrix/contracts/private-relay";
import type {
  MailboxRetentionPolicy,
  PeerEnvelope,
  PeerReceipt
} from "@meshrix/contracts/private-relay";
import {
  acceptPeerSession,
  base64urlDecode,
  base64urlEncode,
  blockPeerIdentity,
  decodePeerEnvelope,
  encodePeerEnvelope,
  generatePrekeyBundle,
  initiatePeerSession,
  isPeerCryptoError,
  parsePeerPrekeyBundle,
  peerIdentityBinding,
  peerSafetyNumber,
  peerSessionExists,
  replenishPeerPrekeys,
  repinPeerIdentity,
  resumePeerSession,
  serializePeerEnvelope
} from "@meshrix/peer-crypto";
import type {
  PeerCryptoSession,
  PeerCryptoStore,
  PeerEnvelope as CryptoPeerEnvelope,
  PeerIdentity,
  PeerIdentityBinding
} from "@meshrix/peer-crypto";

import { isPeerClientError, peerClientError } from "./errors.ts";
import { PeerInbox } from "./inbox.ts";
import { PeerOutbox } from "./outbox.ts";
import { ReceiptReconciler, type PeerRouteIdentity } from "./reconciler.ts";
import type {
  PeerClientMeta,
  PeerClientStore,
  StoredBundleObservation,
  StoredInboxEntry,
  StoredOutboxEntry
} from "./store.ts";
import { emptyPeerClientMeta } from "./store.ts";
import type { PeerClientTransport, PeerDeviceDirectory } from "./transport.ts";
import {
  assertPeerClientOpaqueId,
  newPeerBundleId,
  newPeerMessageId,
  PEER_CLIENT_DEFAULT_MAX_SEND_ATTEMPTS,
  PEER_CLIENT_DEFAULT_PAGE_SIZE,
  PEER_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS,
  PEER_CLIENT_DEFAULT_WIRE_PROFILE,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES,
  PEER_CLIENT_STORE_RECORD_VERSION,
  type PeerClientWireProfile
} from "./types.ts";

export type { PeerRouteIdentity } from "./reconciler.ts";

/** One decrypted inbound message handed to the host dispatch surface. */
export interface PeerInboundMessage {
  readonly messageId: string;
  readonly position: number;
  /** Crypto peer id authenticated by the Signal session. */
  readonly senderPeerId: string;
  /** Relay-authenticated wire device id of the sender. */
  readonly senderDeviceId: string;
  readonly plaintext: Uint8Array;
  readonly receivedAt: string;
}

/** Application outcomes the dispatch handler may report synchronously. */
export const PEER_INBOUND_OUTCOME_KINDS = Object.freeze(["accepted_by_agent", "rejected"] as const);
export type PeerInboundOutcomeKind = (typeof PEER_INBOUND_OUTCOME_KINDS)[number];
export type PeerInboundOutcome =
  | PeerInboundOutcomeKind
  | { readonly kind: PeerInboundOutcomeKind; readonly detail?: Uint8Array };
export type PeerDispatchHandler = (
  message: PeerInboundMessage
) => PeerInboundOutcome | Promise<PeerInboundOutcome>;

/**
 * Host-neutral dispatch surface: the client exposes decrypted inbox work
 * and accepts outcome reports — it never executes message content, never
 * calls runtime control, and holds no agent authority.
 */
export interface PeerDispatchSurface {
  onInboundMessage(handler: PeerDispatchHandler): void;
}

/** Typed event vocabulary — every surface is honest evidence, never a synthesized outcome. */
export interface PeerClientEvents {
  /** A stored message was decrypted, committed and dispatched. */
  readonly inbound: PeerInboundMessage;
  /** An outbox entry changed state (accepted/received/agent-terminal). */
  readonly sendState: { readonly messageId: string; readonly peerDeviceId: string; readonly state: StoredOutboxEntry["state"]; readonly position: number | null };
  /** Sender-scope conflict — terminal, surfaced, never retried. */
  readonly conflict: { readonly messageId: string; readonly peerDeviceId: string };
  /** The mailbox provably never recorded the send past the retry bound. */
  readonly unrecorded: { readonly messageId: string; readonly peerDeviceId: string };
  /** A lost mailbox range tombstone — explicit evidence, never a silent skip. */
  readonly lostRange: { readonly fromSeq: number; readonly toSeq: number; readonly cause: string; readonly messageIds: readonly string[] | null };
  /** A pinned remote identity changed; explicit re-pair is required — never auto-repaired. */
  readonly requiresRePair: { readonly peerId: string; readonly source: "send" | "inbound"; readonly detail: string };
  readonly bundlePublished: { readonly bundleId: string; readonly revision: number; readonly outcome: string };
  readonly bundleRefused: { readonly refusal: string };
  /** Deployment mailbox retention policy advertisement (push or pull answer). */
  readonly retentionPolicy: MailboxRetentionPolicy;
  /** The mailbox refused one ack entry — reported with its typed reason. */
  readonly ackRefused: { readonly messageId: string; readonly refusal: string };
  /** A stored message could not be decrypted; recorded as evidence, still acknowledged. */
  readonly decryptFailure: { readonly messageId: string; readonly position: number; readonly code: string };
  /** Two different messageIds claimed one mailbox position — a protocol anomaly. */
  readonly positionConflict: { readonly messageId: string; readonly position: number };
  /** The host dispatch handler threw; the entry is marked failed, not retried implicitly. */
  readonly dispatchFailed: { readonly messageId: string; readonly position: number; readonly error: string };
  /** An asynchronous channel/pipeline failure — always a typed code, never a fabricated outcome. */
  readonly error: { readonly code: string; readonly detail: string };
}

type PeerClientEventName = keyof PeerClientEvents;

export interface PeerClientOptions {
  /** The device's crypto identity (owns peerId + keypair + store). */
  readonly identity: PeerIdentity;
  readonly cryptoStore: PeerCryptoStore;
  /** Durable outbox/inbox store — FilePeerClientStore or a host adapter. */
  readonly clientStore: PeerClientStore;
  /** Admitted session channel port for the 13 wire kinds. */
  readonly transport: PeerClientTransport;
  /** Authenticated wire identity bound to the session admission. */
  readonly route: PeerRouteIdentity;
  /** Optional pairing-layer lookup: wire device id → crypto peer id. */
  readonly directory?: PeerDeviceDirectory;
  /** Optional host dispatch handler; attachable later via onInboundMessage. */
  readonly dispatch?: PeerDispatchHandler;
  readonly wireProfile?: PeerClientWireProfile;
  readonly pageSize?: number;
  readonly requestTimeoutMs?: number;
  readonly maxSendAttempts?: number;
}

interface PendingExpectation {
  readonly expectKind: string;
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Device-side peer client: composes the durable outbox, deduplicated inbox
 * and the crypto session layer over the admitted session channel.
 *
 * - sendMessage: bundle-fetch on first contact → X3DH/PQXDH initiate →
 *   Double Ratchet encrypt → wire peer-send → reconcile.
 * - handlePush/sync: peer-fetch from the durable cursor → decrypt → dedup →
 *   dispatch → peer-ack (idempotent) → cursor commit.
 * - Every pinned-identity change surfaces `requiresRePair`; every send
 *   anomaly surfaces its typed terminal state. Nothing is auto-repaired.
 */
export class PeerClient implements PeerDispatchSurface {
  readonly outbox: PeerOutbox;
  readonly inbox: PeerInbox;
  readonly reconciler: ReceiptReconciler;

  readonly #identity: PeerIdentity;
  readonly #cryptoStore: PeerCryptoStore;
  readonly #clientStore: PeerClientStore;
  readonly #transport: PeerClientTransport;
  readonly #route: PeerRouteIdentity;
  readonly #directory: PeerDeviceDirectory | null;
  readonly #wireProfile: PeerClientWireProfile;
  readonly #pageSize: number;
  readonly #requestTimeoutMs: number;

  #metaCache: PeerClientMeta | null = null;
  #dispatchHandler: PeerDispatchHandler | null = null;
  #pending: PendingExpectation | null = null;
  #laneTail: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Map<PeerClientEventName, Set<(payload: never) => void>>();

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
    this.#pageSize = Math.min(Math.max(1, options.pageSize ?? PEER_CLIENT_DEFAULT_PAGE_SIZE), PRIVATE_RELAY_PEER_LIMITS.maxPageMessages);
    this.#requestTimeoutMs = Math.max(50, options.requestTimeoutMs ?? PEER_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS);
    this.outbox = new PeerOutbox(options.clientStore);
    this.inbox = new PeerInbox(options.clientStore);
    this.reconciler = new ReceiptReconciler({
      route: this.#route,
      outbox: this.outbox,
      request: (message, expectKind) => this.#request(message, expectKind),
      maxSendAttempts: Math.max(1, options.maxSendAttempts ?? PEER_CLIENT_DEFAULT_MAX_SEND_ATTEMPTS),
      onTransition: (transition) => this.#emitSendTransition(transition.entry)
    });
    this.#transport.onMessage?.((message) => this.handleInboundMessage(message));
  }

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  on<E extends PeerClientEventName>(event: E, handler: (payload: PeerClientEvents[E]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  #emit<E extends PeerClientEventName>(event: E, payload: PeerClientEvents[E]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (payload: PeerClientEvents[E]) => void)(payload);
      } catch {
        // A listener fault must never break the delivery pipeline.
      }
    }
  }

  #emitSendTransition(entry: StoredOutboxEntry): void {
    this.#emit("sendState", { messageId: entry.messageId, peerDeviceId: entry.peerDeviceId, state: entry.state, position: entry.position });
    if (entry.state === "conflict") this.#emit("conflict", { messageId: entry.messageId, peerDeviceId: entry.peerDeviceId });
    if (entry.state === "unrecorded") this.#emit("unrecorded", { messageId: entry.messageId, peerDeviceId: entry.peerDeviceId });
  }

  // ------------------------------------------------------------------
  // lane + meta plumbing
  // ------------------------------------------------------------------

  /** Serialize every client operation — one channel, one ratchet, one store. */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#laneTail.then(operation, operation);
    this.#laneTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #meta(): Promise<PeerClientMeta> {
    if (this.#metaCache === null) {
      this.#metaCache = (await this.#clientStore.loadMeta()) ?? emptyPeerClientMeta();
    }
    return this.#metaCache;
  }

  async #saveMeta(patch: Partial<PeerClientMeta>): Promise<PeerClientMeta> {
    const meta = Object.freeze({ ...(await this.#meta()), ...patch });
    this.#metaCache = meta;
    await this.#clientStore.saveMeta(meta);
    return meta;
  }

  /**
   * One wire request → its typed response. Correlation is by expected kind
   * over the single in-flight slot the lane guarantees; a pushed page of
   * the expected kind is a lawful answer (pages process idempotently).
   * Resolves null on timeout — the honest "dropped reply" signal.
   */
  async #request(message: Record<string, unknown>, expectKind: string): Promise<Record<string, unknown> | null> {
    const response = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        resolve(null);
      }, this.#requestTimeoutMs);
      this.#pending = {
        expectKind,
        timer,
        resolve: (value: Record<string, unknown>) => {
          clearTimeout(timer);
          this.#pending = null;
          resolve(value);
        }
      };
    });
    try {
      await this.#transport.send(message);
    } catch (error: unknown) {
      if (this.#pending?.expectKind === expectKind) {
        clearTimeout(this.#pending.timer);
        this.#pending = null;
      }
      throw peerClientError("peer_client_transport", `The session channel failed to carry a ${expectKind} request.`, { cause: error });
    }
    return response;
  }

  /**
   * Demux entry for every decoded channel message: an expected response
   * resolves the in-flight request; anything else is a push and is
   * processed through the lane. Malformed input drops silently, exactly as
   * the relay drops malformed input.
   */
  handleInboundMessage(value: unknown): void {
    const parsed = parsePrivateRelayPeerMessage(value);
    if (!parsed) return;
    const kind = (parsed as { readonly kind?: string }).kind;
    if (kind !== undefined && this.#pending !== null && kind === this.#pending.expectKind) {
      this.#pending.resolve(parsed as Record<string, unknown>);
      return;
    }
    void this.#enqueue(() => this.#handlePush(parsed as Record<string, unknown>)).catch((error: unknown) => {
      this.#emit("error", {
        code: isPeerCryptoError(error) || isPeerClientError(error) ? error.code : "peer_client_transport",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async #handlePush(message: Record<string, unknown>): Promise<void> {
    const kind = (message as { readonly kind?: string }).kind;
    switch (kind) {
      case "peer-messages": {
        // Mailbox wakeup page: process it, then drain the rest via fetch.
        const page = parsePeerMessages(message);
        if (!page || page.deviceId !== this.#route.deviceId) return;
        const more = await this.#processPage(page);
        if (more) await this.#syncLoop();
        await this.#drainPendingDispatch();
        return;
      }
      case "peer-retention-policy": {
        const policy = parsePeerRetentionPolicy(message);
        if (!policy || policy.deviceId !== this.#route.deviceId) return;
        await this.#saveMeta({ retentionPolicy: policy });
        this.#emit("retentionPolicy", policy);
        return;
      }
      case "peer-accepted": {
        const accepted = parsePeerAccepted(message);
        if (accepted) await this.#applyAccepted(accepted);
        return;
      }
      case "peer-status": {
        await this.reconciler.applyStatusDocument(message);
        return;
      }
      case "peer-acked": {
        const acked = parsePeerAcked(message);
        if (acked) await this.#applyAcked(acked);
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------
  // dispatch surface
  // ------------------------------------------------------------------

  /**
   * Register the host's inbound handler. Attaching drains every committed
   * entry still marked `pending` — work is never re-decrypted, only the
   * deferred dispatch runs.
   */
  onInboundMessage(handler: PeerDispatchHandler): void {
    this.#dispatchHandler = handler;
    void this.#enqueue(() => this.#drainPendingDispatch()).catch((error: unknown) => {
      this.#emit("error", {
        code: isPeerCryptoError(error) || isPeerClientError(error) ? error.code : "peer_client_transport",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  }

  // ------------------------------------------------------------------
  // sending
  // ------------------------------------------------------------------

  /**
   * Queue + drive one send. First contact fetches the remote bundle and
   * initiates X3DH/PQXDH; later sends resume the ratchet from the durable
   * store. Returns the durable outbox entry — `state` honestly reports how
   * far delivery got (pending when the reply was lost; reconciliation
   * resolves it).
   */
  async sendMessage(
    peerDeviceId: string,
    plaintext: Uint8Array | string,
    options: { readonly messageId?: string } = {}
  ): Promise<StoredOutboxEntry> {
    return this.#enqueue(async () => {
      const checkedPeer = assertPeerClientOpaqueId(peerDeviceId, "peerDeviceId");
      if (checkedPeer === this.#route.deviceId) {
        throw peerClientError("peer_client_state", "A device cannot send a peer message to itself.");
      }
      const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
        throw peerClientError("peer_client_state", "The plaintext is empty or exceeds the peer client bound.");
      }
      const messageId = options.messageId === undefined
        ? newPeerMessageId()
        : assertPeerClientOpaqueId(options.messageId, "messageId");
      const existing = await this.outbox.entry(messageId);
      if (existing) {
        if (existing.state === "conflict" || existing.state === "unrecorded") {
          throw peerClientError("peer_client_state", `Message ${messageId} is terminally ${existing.state}; sender-scoped ids are never retried past a terminal outcome.`);
        }
        // Caller-driven retry: same id, same stored envelope bytes.
        await this.#driveSend(existing);
        return (await this.outbox.entry(messageId)) ?? existing;
      }
      const { session, peerId, observation } = await this.#sessionFor(checkedPeer);
      const ciphertext = await session.encrypt(bytes);
      const cryptoEnvelope = serializePeerEnvelope(session.envelopeHeader(), ciphertext);
      const wireEnvelope = await this.#wireEnvelope(cryptoEnvelope, observation);
      const entry = await this.outbox.enqueue({
        messageId,
        peerDeviceId: checkedPeer,
        peerId,
        envelope: wireEnvelope
      });
      await this.#driveSend(entry);
      return (await this.outbox.entry(messageId)) ?? entry;
    });
  }

  /**
   * Resolve (and when necessary establish) the crypto session for a wire
   * peer: resume a durable session when one exists, otherwise fetch the
   * remote bundle — pairing and revocation are re-read by the mailbox on
   * every fetch — and initiate X3DH/PQXDH.
   */
  async #sessionFor(peerDeviceId: string): Promise<{
    readonly session: PeerCryptoSession;
    readonly peerId: string;
    readonly observation: StoredBundleObservation | null;
  }> {
    const meta = await this.#meta();
    const learned = meta.peers[peerDeviceId];
    const directoryPeer = this.#directory ? await this.#directory.resolvePeerId(peerDeviceId) : null;
    let peerId = directoryPeer ?? learned ?? null;
    const observed = meta.bundleObservations[peerDeviceId] ?? null;
    if (peerId !== null && await peerSessionExists(this.#cryptoStore, peerId)) {
      // Local revocation honesty on every send: a blocked pin refuses before
      // the ratchet is resumed — encrypt does not re-run the trust check.
      const binding = await peerIdentityBinding(this.#cryptoStore, peerId);
      if (binding !== null && binding.state !== "active") {
        this.#emit("requiresRePair", { peerId, source: "send", detail: "The pinned peer identity is blocked." });
        throw peerClientError("peer_client_state", `Peer ${peerId} is blocked; an explicit re-pair is required.`);
      }
      try {
        const session = await resumePeerSession({
          identity: this.#identity,
          localStore: this.#cryptoStore,
          peerId
        });
        return { session, peerId, observation: observed };
      } catch (error: unknown) {
        if (isPeerCryptoError(error, "peer_identity_changed")) {
          this.#emit("requiresRePair", { peerId, source: "send", detail: "The pinned peer identity is blocked or missing." });
        }
        throw error;
      }
    }
    const response = await this.#request(createPeerBundleFetch({
      tenantId: this.#route.tenantId,
      routeId: this.#route.routeId,
      deviceId: this.#route.deviceId,
      peerDeviceId
    }), "peer-bundle");
    if (response === null) {
      throw peerClientError("peer_client_transport", "The peer-bundle-fetch was dropped by the session channel.");
    }
    const bundle = parsePeerBundle(response);
    if (!bundle || bundle.deviceId !== peerDeviceId) {
      throw peerClientError("peer_client_transport", "The peer-bundle response is malformed or out of scope.");
    }
    if (bundle.state === "refused") {
      throw peerClientError("peer_client_bundle_unavailable", `The remote bundle fetch was refused: ${bundle.refusal}.`);
    }
    if (bundle.state !== "available" || bundle.bundle === null) {
      throw peerClientError("peer_client_bundle_unavailable", "The remote peer has not published a prekey bundle.");
    }
    const materialBytes = base64urlDecode(bundle.bundle.material, PRIVATE_RELAY_PEER_LIMITS.maxBundleBytes);
    const material = materialBytes === null ? null : parsePeerPrekeyBundle(this.#jsonDecode(materialBytes));
    if (material === null) {
      throw peerClientError("peer_client_bundle_unavailable", "The remote bundle material does not satisfy the prekey bundle contract.");
    }
    peerId = material.peerId;
    const observation: StoredBundleObservation = Object.freeze({
      bundleId: bundle.bundle.bundleId,
      revision: bundle.bundle.revision,
      oneTimePreKeyId: material.oneTimePreKey === null ? null : material.oneTimePreKey.id,
      signedPrekeyId: material.signedPreKey.id
    });
    await this.#saveMeta({
      peers: Object.freeze({ ...meta.peers, [peerDeviceId]: peerId }),
      bundleObservations: Object.freeze({ ...meta.bundleObservations, [peerDeviceId]: observation })
    });
    if (await peerSessionExists(this.#cryptoStore, peerId)) {
      const session = await resumePeerSession({
        identity: this.#identity,
        localStore: this.#cryptoStore,
        peerId
      });
      return { session, peerId, observation };
    }
    try {
      const session = await initiatePeerSession({
        identity: this.#identity,
        localStore: this.#cryptoStore,
        remoteBundle: material
      });
      return { session, peerId, observation };
    } catch (error: unknown) {
      if (isPeerCryptoError(error, "peer_identity_changed")) {
        this.#emit("requiresRePair", { peerId, source: "send", detail: "The fetched bundle's identity key differs from the pinned record." });
      }
      throw error;
    }
  }

  /** Map the crypto envelope onto the opaque wire envelope + routing headers. */
  async #wireEnvelope(cryptoEnvelope: CryptoPeerEnvelope, observation: StoredBundleObservation | null): Promise<PeerEnvelope> {
    const local = await this.#localBundle();
    const bytes = encodePeerEnvelope(cryptoEnvelope);
    return Object.freeze({
      format: this.#wireProfile,
      headers: Object.freeze({
        messageType: cryptoEnvelope.messageType === "prekey" ? "prekey" as const : "session" as const,
        senderBundleId: local.bundleId,
        recipientBundleId: observation?.bundleId ?? "unpublished",
        prekeyId: observation?.oneTimePreKeyId != null ? `opk.${observation.oneTimePreKeyId}` : null,
        signedPrekeyId: observation?.signedPrekeyId != null ? `spk.${observation.signedPrekeyId}` : null,
        baseKeyId: null
      }),
      ciphertext: base64urlEncode(bytes)
    });
  }

  async #localBundle() {
    const meta = await this.#meta();
    if (meta.localBundle) return meta.localBundle;
    const local = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      bundleId: newPeerBundleId(),
      revision: 0,
      format: this.#wireProfile as string,
      material: null
    });
    await this.#saveMeta({ localBundle: local });
    return local;
  }

  /**
   * Issue (or re-issue) one outbox entry over the channel. A dropped
   * `peer-accepted` is reconciled immediately via peer-status; a conflict
   * is terminal; accepted/duplicate record the mailbox receipt.
   */
  async #driveSend(entry: StoredOutboxEntry): Promise<void> {
    if (entry.state !== "pending") return;
    await this.outbox.markAttempt(entry.messageId);
    const send = createPeerSend({
      tenantId: this.#route.tenantId,
      routeId: this.#route.routeId,
      deviceId: this.#route.deviceId,
      peerDeviceId: entry.peerDeviceId,
      messageId: entry.messageId,
      envelope: entry.envelope
    });
    const response = await this.#request(send, "peer-accepted");
    if (response === null) {
      // Lost reply: reconcile honestly instead of guessing.
      await this.reconciler.reconcile([entry.messageId]).catch(() => Object.freeze([]));
      return;
    }
    const accepted = parsePeerAccepted(response);
    if (!accepted || accepted.messageId !== entry.messageId || accepted.peerDeviceId !== entry.peerDeviceId) {
      await this.outbox.noteError(entry.messageId, "The peer-accepted response does not match the send scope.");
      return;
    }
    await this.#applyAccepted(accepted);
  }

  async #applyAccepted(accepted: {
    readonly messageId: string;
    readonly peerDeviceId: string;
    readonly outcome: string;
    readonly position: number;
    readonly receipt: PeerReceipt | null;
  }): Promise<void> {
    if (accepted.outcome === "conflict") {
      const entry = await this.outbox.markConflict(accepted.messageId);
      if (entry) this.#emitSendTransition(entry);
      return;
    }
    const entry = await this.outbox.markAccepted(accepted.messageId, accepted.position, accepted.receipt);
    if (entry) this.#emitSendTransition(entry);
  }

  // ------------------------------------------------------------------
  // bundle publication
  // ------------------------------------------------------------------

  /**
   * Mint + publish the device's prekey bundle. `peer_prekey_exhausted`
   * triggers exactly one replenish-and-retry before surfacing; a refused
   * publish surfaces its typed refusal.
   */
  async publishBundle(): Promise<{ readonly bundleId: string; readonly revision: number; readonly outcome: string }> {
    return this.#enqueue(async () => {
      let bundle;
      try {
        bundle = await generatePrekeyBundle(this.#identity);
      } catch (error: unknown) {
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
          bundle: {
            format: this.#wireProfile,
            bundleId: local.bundleId,
            revision,
            material
          }
        }), "peer-bundle-published");
        if (response === null) {
          throw peerClientError("peer_client_transport", "The peer-bundle-publish was dropped by the session channel.");
        }
        const published = parsePeerBundlePublished(response);
        if (!published || published.deviceId !== this.#route.deviceId || published.bundleId !== local.bundleId) {
          throw peerClientError("peer_client_transport", "The peer-bundle-published response is malformed or out of scope.");
        }
        if (published.outcome === "refused") {
          // A reinstalled (or second-store) writer restarts at revision 1; the
          // mailbox accepts only strictly-greater revisions, so re-issue the
          // same material once at stored+1 — never retry past that.
          if (published.refusal === "stale_revision" && !retriedStale) {
            retriedStale = true;
            revision = published.currentRevision + 1;
            continue;
          }
          this.#emit("bundleRefused", { refusal: published.refusal ?? "authority_stale" });
          throw peerClientError("peer_client_bundle_unavailable", `The bundle publish was refused: ${published.refusal}.`);
        }
        await this.#saveMeta({
          localBundle: Object.freeze({
            version: PEER_CLIENT_STORE_RECORD_VERSION,
            bundleId: local.bundleId,
            revision: published.currentRevision,
            format: this.#wireProfile as string,
            material
          })
        });
        this.#emit("bundlePublished", { bundleId: local.bundleId, revision: published.currentRevision, outcome: published.outcome });
        return Object.freeze({ bundleId: local.bundleId, revision: published.currentRevision, outcome: published.outcome });
      }
    });
  }

  // ------------------------------------------------------------------
  // receiving: fetch loop, page processing, acks
  // ------------------------------------------------------------------

  /** Fetch loop from the durable cursor until the mailbox reports no more pages. */
  async sync(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#syncLoop();
      await this.#drainPendingDispatch();
    });
  }

  async #syncLoop(): Promise<void> {
    for (;;) {
      const cursor = await this.inbox.cursor();
      const response = await this.#request(createPeerFetch({
        tenantId: this.#route.tenantId,
        routeId: this.#route.routeId,
        deviceId: this.#route.deviceId,
        afterSeq: cursor,
        limit: this.#pageSize
      }), "peer-messages");
      if (response === null) {
        throw peerClientError("peer_client_transport", "The peer-fetch was dropped by the session channel.");
      }
      const page = parsePeerMessages(response);
      if (!page || page.deviceId !== this.#route.deviceId) {
        throw peerClientError("peer_client_transport", "The peer-messages page is malformed or out of scope.");
      }
      const more = await this.#processPage(page);
      if (!more) return;
    }
  }

  /**
   * Process one peer-messages page: tombstones surface first, each stored
   * message dedups before decrypt+dispatch, and the whole page closes with
   * one idempotent peer-ack (received[] + queued reports[]) before the
   * durable cursor moves to nextAfterSeq.
   */
  async #processPage(page: {
    readonly messages: readonly { readonly position: number; readonly senderDeviceId: string; readonly messageId: string; readonly envelope: PeerEnvelope }[];
    readonly nextAfterSeq: number;
    readonly more: boolean;
    readonly gaps: readonly { readonly fromSeq: number; readonly toSeq: number; readonly cause: string; readonly messageIds: readonly string[] | null }[];
  }): Promise<boolean> {
    for (const gap of page.gaps) {
      const { tombstone, fresh } = await this.inbox.recordGap(gap as { readonly fromSeq: number; readonly toSeq: number; readonly cause: "expired" | "capacity_truncated"; readonly messageIds: readonly string[] | null });
      // Replay-durable: a redelivered page re-surfaces only genuinely new tombstones.
      if (fresh) {
        this.#emit("lostRange", { fromSeq: tombstone.fromSeq, toSeq: tombstone.toSeq, cause: tombstone.cause, messageIds: tombstone.messageIds });
      }
    }
    const received: { readonly messageId: string; readonly position: number }[] = [];
    for (const stored of page.messages) {
      const lookup = await this.inbox.lookup(stored.messageId, stored.position);
      if (lookup.status === "positionConflict") {
        this.#emit("positionConflict", { messageId: stored.messageId, position: stored.position });
        received.push({ messageId: stored.messageId, position: stored.position });
        continue;
      }
      if (lookup.status === "duplicate") {
        received.push({ messageId: stored.messageId, position: stored.position });
        if (lookup.entry.dispatch === "pending" && lookup.entry.plaintext !== null && this.#dispatchHandler !== null) {
          await this.#dispatchEntry(lookup.entry);
        }
        continue;
      }
      const entry = await this.#buildInboxEntry(stored);
      await this.inbox.record(entry);
      if (entry.plaintext !== null && this.#dispatchHandler !== null) {
        await this.#dispatchEntry(entry);
      }
      received.push({ messageId: stored.messageId, position: stored.position });
    }
    const meta = await this.#meta();
    const reports = meta.pendingReports.slice(0, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries);
    await this.#ack({ received, reports });
    await this.inbox.commitCursor(page.nextAfterSeq);
    return page.more;
  }

  /** Decrypt one stored message into a durable inbox entry — never fabricates plaintext. */
  async #buildInboxEntry(stored: {
    readonly position: number;
    readonly senderDeviceId: string;
    readonly messageId: string;
    readonly envelope: PeerEnvelope;
  }): Promise<StoredInboxEntry> {
    const entry: StoredInboxEntry = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      position: stored.position,
      senderDeviceId: stored.senderDeviceId,
      senderPeerId: null,
      messageId: stored.messageId,
      envelope: stored.envelope,
      plaintext: null,
      decryptError: null,
      dispatch: "pending",
      reports: Object.freeze([]),
      receivedAt: new Date().toISOString()
    });
    const fail = (code: string, senderPeerId: string | null, dispatch: StoredInboxEntry["dispatch"]): StoredInboxEntry => {
      if (code !== "peer_duplicate_message") {
        this.#emit("decryptFailure", { messageId: stored.messageId, position: stored.position, code });
      }
      return Object.freeze({ ...entry, senderPeerId, decryptError: code, dispatch });
    };
    const bytes = base64urlDecode(stored.envelope.ciphertext, PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    if (bytes === null) return fail("peer_envelope_malformed", null, "failed");
    const rawEnvelope = this.#jsonDecode(bytes);
    const parsed = decodePeerEnvelope(bytes);
    if (rawEnvelope === null || parsed === null) return fail("peer_envelope_malformed", null, "failed");
    try {
      let plaintext: Uint8Array;
      if (parsed.messageType === "prekey") {
        const accepted = await acceptPeerSession({
          identity: this.#identity,
          localStore: this.#cryptoStore,
          envelope: rawEnvelope
        });
        plaintext = accepted.plaintext;
      } else {
        const session = await resumePeerSession({
          identity: this.#identity,
          localStore: this.#cryptoStore,
          peerId: parsed.senderPeerId,
          peerDeviceId: parsed.senderDeviceId
        });
        plaintext = await session.decrypt({ messageType: parsed.messageType, body: parsed.body });
      }
      const meta = await this.#meta();
      if (meta.peers[stored.senderDeviceId] !== parsed.senderPeerId) {
        await this.#saveMeta({ peers: Object.freeze({ ...meta.peers, [stored.senderDeviceId]: parsed.senderPeerId }) });
      }
      return Object.freeze({
        ...entry,
        senderPeerId: parsed.senderPeerId,
        plaintext: base64urlEncode(plaintext)
      });
    } catch (error: unknown) {
      const code = isPeerCryptoError(error) ? error.code : isPeerClientError(error) ? error.code : "peer_message_unauthentic";
      if (code === "peer_identity_changed") {
        this.#emit("requiresRePair", { peerId: parsed.senderPeerId, source: "inbound", detail: "The inbound sender identity differs from the pinned record." });
      }
      // peer_duplicate_message: the ratchet already consumed this ciphertext
      // — delivery evidence only; recorded skipped, never re-dispatched.
      return fail(code, parsed.senderPeerId, code === "peer_duplicate_message" ? "skipped" : "failed");
    }
  }

  #jsonDecode(bytes: Uint8Array): unknown {
    try {
      return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
    } catch {
      return null;
    }
  }

  /** Run the host handler for one committed entry, then queue its application report. */
  async #dispatchEntry(entry: StoredInboxEntry): Promise<void> {
    if (this.#dispatchHandler === null || entry.plaintext === null) return;
    const plaintext = base64urlDecode(entry.plaintext, PEER_CLIENT_MAX_PLAINTEXT_BYTES + 8192);
    if (plaintext === null) {
      await this.inbox.markDispatch(entry.messageId, "failed");
      return;
    }
    const message: PeerInboundMessage = Object.freeze({
      messageId: entry.messageId,
      position: entry.position,
      senderPeerId: entry.senderPeerId ?? "",
      senderDeviceId: entry.senderDeviceId,
      plaintext,
      receivedAt: entry.receivedAt
    });
    let outcome: PeerInboundOutcome;
    try {
      outcome = await this.#dispatchHandler(message);
    } catch (error: unknown) {
      await this.inbox.markDispatch(entry.messageId, "failed");
      this.#emit("dispatchFailed", { messageId: entry.messageId, position: entry.position, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const kind = typeof outcome === "string" ? outcome : outcome?.kind;
    if (kind !== "accepted_by_agent" && kind !== "rejected") {
      await this.inbox.markDispatch(entry.messageId, "failed");
      this.#emit("dispatchFailed", { messageId: entry.messageId, position: entry.position, error: "The dispatch handler returned an outcome outside the contract." });
      return;
    }
    const detail = typeof outcome === "object" && outcome.detail instanceof Uint8Array ? outcome.detail : null;
    await this.inbox.markDispatch(entry.messageId, kind);
    const meta = await this.#meta();
    const report: PeerReceipt = Object.freeze({
      kind,
      source: "agent",
      messageId: entry.messageId,
      position: entry.position,
      detail: detail === null ? null : base64urlEncode(detail)
    });
    await this.#saveMeta({ pendingReports: Object.freeze([...meta.pendingReports, report]) });
    this.#emit("inbound", message);
  }

  /** Retry every committed-but-undispatched entry — e.g. after the handler attaches. */
  async #drainPendingDispatch(): Promise<void> {
    if (this.#dispatchHandler === null) return;
    for (const entry of await this.inbox.pendingDispatch()) {
      const current = await this.inbox.entry(entry.position);
      if (current?.dispatch === "pending" && current.plaintext !== null) {
        await this.#dispatchEntry(current);
      }
    }
    await this.#drainReports();
  }

  // ------------------------------------------------------------------
  // acks + application reports
  // ------------------------------------------------------------------

  async #ack(input: {
    readonly received: readonly { readonly messageId: string; readonly position: number }[];
    readonly reports: readonly PeerReceipt[];
  }): Promise<void> {
    if (input.received.length === 0 && input.reports.length === 0) return;
    const response = await this.#request(createPeerAck({
      tenantId: this.#route.tenantId,
      routeId: this.#route.routeId,
      deviceId: this.#route.deviceId,
      received: [...input.received],
      reports: [...input.reports]
    }), "peer-acked");
    if (response === null) {
      throw peerClientError("peer_client_transport", "The peer-ack was dropped by the session channel.");
    }
    const acked = parsePeerAcked(response);
    if (!acked || acked.deviceId !== this.#route.deviceId) {
      throw peerClientError("peer_client_transport", "The peer-acked response is malformed or out of scope.");
    }
    await this.#applyAcked(acked);
  }

  /** Retire answered reports and mark inbox entries; refused ids surface with reasons. */
  async #applyAcked(acked: {
    readonly recorded: readonly PeerReceipt[];
    readonly refused: readonly { readonly messageId: string; readonly refusal: string }[];
  }): Promise<void> {
    const meta = await this.#meta();
    const answered = new Set<string>([
      ...acked.recorded.map((receipt) => receipt.messageId),
      ...acked.refused.map((entry) => entry.messageId)
    ]);
    if (meta.pendingReports.some((report) => answered.has(report.messageId))) {
      await this.#saveMeta({
        pendingReports: Object.freeze(meta.pendingReports.filter((report) => !answered.has(report.messageId)))
      });
    }
    for (const receipt of acked.recorded) {
      if (receipt.source === "agent") {
        await this.inbox.markReported(receipt.messageId, receipt.kind);
      }
    }
    for (const refused of acked.refused) {
      this.#emit("ackRefused", { messageId: refused.messageId, refusal: refused.refusal });
    }
  }

  /** Flush queued application reports — standalone peer-ack outside a fetch page. */
  async #drainReports(): Promise<void> {
    // Loop until the queue empties: the ack bound slices each request to
    // maxAckEntries, and applyAcked only retires ids the mailbox answered.
    for (;;) {
      const meta = await this.#meta();
      const reports = meta.pendingReports.slice(0, PRIVATE_RELAY_PEER_LIMITS.maxAckEntries);
      if (reports.length === 0) return;
      await this.#ack({ received: [], reports });
    }
  }

  /**
   * Report an application outcome for a received message
   * (accepted_by_agent / completed / rejected). Independent evidence —
   * never derived from mailbox acks; queued durably until the mailbox
   * records or refuses it.
   */
  async reportOutcome(
    messageId: string,
    outcome: "accepted_by_agent" | "completed" | "rejected",
    detail?: Uint8Array
  ): Promise<void> {
    return this.#enqueue(async () => {
      const entry = await this.inbox.byMessageId(messageId);
      if (!entry) {
        throw peerClientError("peer_client_state", `No inbox entry exists for ${messageId}; reports require a received position.`);
      }
      const meta = await this.#meta();
      const report: PeerReceipt = Object.freeze({
        kind: outcome,
        source: "agent",
        messageId,
        position: entry.position,
        detail: detail instanceof Uint8Array && detail.length > 0 ? base64urlEncode(detail) : null
      });
      const pendingReports = meta.pendingReports.filter((pending) => !(pending.messageId === messageId && pending.kind === outcome));
      await this.#saveMeta({ pendingReports: Object.freeze([...pendingReports, report]) });
      await this.#drainReports();
    });
  }

  // ------------------------------------------------------------------
  // reconciliation + resume
  // ------------------------------------------------------------------

  /** Pull peer-status for unreconciled (or given) outbox entries. */
  async reconcile(messageIds?: readonly string[]): Promise<void> {
    return this.#enqueue(async () => {
      await this.reconciler.reconcile(messageIds);
    });
  }

  /**
   * Re-attach after restart/reconnect: retry pending sends (same ids, same
   * envelopes — duplicate is success), reconcile receipts, flush queued
   * reports and run the fetch loop from the durable cursor.
   */
  async resume(): Promise<void> {
    return this.#enqueue(async () => {
      for (const entry of await this.outbox.pending()) {
        await this.#driveSend(entry);
      }
      await this.reconciler.reconcile();
      await this.#drainReports();
      await this.#syncLoop();
      await this.#drainPendingDispatch();
    });
  }

  /** Pull the deployment's retention policy advertisement (fallback for a missed push). */
  async fetchRetentionPolicy(): Promise<MailboxRetentionPolicy> {
    return this.#enqueue(async () => {
      const response = await this.#request(createPeerRetentionPolicy({
        routeId: this.#route.routeId,
        deviceId: this.#route.deviceId,
        mailboxCapacityBytes: 1,
        mailboxRetentionMs: 1,
        mailboxMaxItems: 1
      }), "peer-retention-policy");
      if (response === null) {
        throw peerClientError("peer_client_transport", "The peer-retention-policy pull was dropped by the session channel.");
      }
      const policy = parsePeerRetentionPolicy(response);
      if (!policy || policy.deviceId !== this.#route.deviceId) {
        throw peerClientError("peer_client_transport", "The peer-retention-policy response is malformed or out of scope.");
      }
      await this.#saveMeta({ retentionPolicy: policy });
      this.#emit("retentionPolicy", policy);
      return policy;
    });
  }

  // ------------------------------------------------------------------
  // trust management (explicit host actions — never automatic)
  // ------------------------------------------------------------------

  /** The ONLY sanctioned acceptance of a changed peer identity — the re-pair path. */
  async repinPeer(peerId: string, newIdentityKey: Uint8Array): Promise<PeerIdentityBinding> {
    return this.#enqueue(() => repinPeerIdentity(this.#cryptoStore, peerId, newIdentityKey));
  }

  /** Block a pinned peer identity; every later trust check refuses. */
  async blockPeer(peerId: string): Promise<PeerIdentityBinding | null> {
    return this.#enqueue(() => blockPeerIdentity(this.#cryptoStore, peerId));
  }

  /** Out-of-band verification number over both identity keys, or null when unpinned. */
  async peerSafetyNumberFor(peerId: string): Promise<string | null> {
    const binding = await peerIdentityBinding(this.#cryptoStore, peerId);
    if (!binding || binding.state !== "active") return null;
    const key = base64urlDecode(binding.identityKey, 512);
    if (key === null) return null;
    return peerSafetyNumber(this.#identity, { peerId, identityKey: key });
  }

  /** Learned wire-device → crypto-peer bindings (pairing evidence cache). */
  async learnedPeers(): Promise<Readonly<Record<string, string>>> {
    return (await this.#meta()).peers;
  }

  /** The local bundle record (revision 0 = allocated but never published). */
  async localBundle(): Promise<{ readonly bundleId: string; readonly revision: number } | null> {
    const bundle = (await this.#meta()).localBundle;
    return bundle === null ? null : Object.freeze({ bundleId: bundle.bundleId, revision: bundle.revision });
  }

  /** Last observed retention policy advertisement, if any. */
  async retentionPolicy(): Promise<MailboxRetentionPolicy | null> {
    return (await this.#meta()).retentionPolicy;
  }
}
