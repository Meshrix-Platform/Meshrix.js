import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PEER_CRYPTO_ERROR_CODES,
  createFilePeerCryptoStore,
  createPeerIdentity,
  loadPeerIdentity,
  type PeerCryptoStore
} from "@meshrix/peer-crypto";
import {
  PEER_CLIENT_ERROR_CODES,
  PeerClient,
  createFilePeerClientStore,
  type PeerClientStore,
  type PeerDeviceDirectory,
  type PeerDispatchHandler,
  type PeerRouteIdentity
} from "@meshrix/peer-client";
import {
  createPeerSessionChannel,
  isPeerSchemaMessage,
  peerIdForRouteDevice,
  peerInboxView,
  peerOutboxView,
  type PeerInboxView,
  type PeerOutboxView
} from "@meshrix/entry-transport";
import { PRIVATE_RELAY_PEER_FORWARD_REFUSALS, PRIVATE_RELAY_PEER_REFUSALS } from "@meshrix/contracts/private-relay";

import { endpointConfigError } from "./config.ts";
import type { PrivateEndpointPeerConfig } from "./config.ts";

/**
 * Endpoint-side peer messaging runtime.
 *
 * One `PeerClient` per endpoint profile run, backed by the durable file
 * stores under `peer.storageDir` (`crypto/` Signal state + `client/`
 * outbox/inbox). The wire channel is the SAME admitted forward
 * session the endpoint already owns — peer kinds are demuxed by the profile
 * before the session driver sees them, and outbound peer requests pass the
 * admission gate so nothing is offered on a dead generation.
 *
 * Identity: the crypto peer id is deterministically derived from the
 * authenticated route tuple.
 * Peer identities are accepted only from the authenticated pairing record;
 * relay bundle contents never establish trust. A configured `peerId` must
 * match the stored identity; a mismatch is a loud configuration error, never
 * a silent re-key.
 *
 * Dispatch: `dispatch` is injectable for a host integration; when absent the
 * runtime is record-only — inbound entries land durably in the inbox as
 * `dispatch: "pending"`. Transport receipts prove durable device custody;
 * application outcomes remain encrypted Peer messages.
 */

export interface EndpointPeerStatus {
  readonly enabled: true;
  readonly peerId: string;
  readonly route: PeerRouteIdentity;
  /** True when the live session is admitted/streaming and can carry peer traffic. */
  readonly sessionLive: boolean;
  readonly localBundle: { readonly bundleId: string; readonly revision: number } | null;
  /** Current route-bound wire-device → crypto-peer bindings. */
  readonly peers: Readonly<Record<string, string>>;
  readonly outbox: readonly PeerOutboxView[];
  readonly outboxNextAfterSequence: number | null;
  readonly pendingOutbox: readonly PeerOutboxView[];
  readonly pendingOutboxNextAfterSequence: number | null;
  readonly pendingInboxPageCount: number;
  readonly pendingInboxNextAfterSequence: number | null;
  readonly inboxNextAfterSequence: number | null;
  /** Bounded tail of notable local events (refusals, re-pair flags, conflicts). */
  readonly events: readonly { readonly at: string; readonly kind: string; readonly detail: string }[];
}

const PEER_EVENT_LOG_LIMIT = 32;

export class EndpointPeerRuntime {
  readonly client: PeerClient;
  readonly peerId: string;
  readonly #route: PeerRouteIdentity;
  readonly #sessionLive: () => boolean;
  readonly #cryptoStore: PeerCryptoStore;
  readonly #clientStore: PeerClientStore;
  readonly #resolvePeerIdentity: PeerDeviceDirectory["resolvePeerIdentity"];
  readonly #events: { at: string; kind: string; detail: string }[] = [];
  readonly #sessionWork = new Set<Promise<void>>();
  #closed = false;
  #liveGeneration = 0;
  #bundlePublished = false;

  private constructor(input: {
    readonly client: PeerClient;
    readonly peerId: string;
    readonly route: PeerRouteIdentity;
    readonly sessionLive: () => boolean;
    readonly cryptoStore: PeerCryptoStore;
    readonly clientStore: PeerClientStore;
    readonly resolvePeerIdentity: PeerDeviceDirectory["resolvePeerIdentity"];
  }) {
    this.client = input.client;
    this.peerId = input.peerId;
    this.#route = input.route;
    this.#sessionLive = input.sessionLive;
    this.#cryptoStore = input.cryptoStore;
    this.#clientStore = input.clientStore;
    this.#resolvePeerIdentity = input.resolvePeerIdentity;
    // Operator evidence surface: every honest refusal/anomaly the client
    // surfaces is retained in a bounded event log on the status surface —
    // never synthesized, never hidden.
    const client = input.client;
    client.on("requiresRePair", () => this.#recordEvent("requiresRePair"));
    client.on("conflict", () => this.#recordEvent("conflict"));
    client.on("bundleRefused", (event) => this.#recordEvent("bundleRefused", event.refusal));
    client.on("peerPresence", (event) => this.#recordEvent("peerPresence", event.state));
    client.on("dispatchDeferred", () => this.#recordEvent("dispatchDeferred"));
    client.on("error", (event) => this.#recordEvent("error", event.code));
  }

  static async create(options: {
    readonly peer: PrivateEndpointPeerConfig;
    readonly route: PeerRouteIdentity;
    /** Raw session send — the transport's contract-object sink. */
    readonly send: (message: Record<string, unknown>) => void;
    /** True only while the forward session may carry peer traffic. */
    readonly sessionLive: () => boolean;
    /** Resolves only a public Signal identity persisted by authenticated pairing. */
    readonly resolvePeerIdentity: PeerDeviceDirectory["resolvePeerIdentity"];
    readonly dispatch?: PeerDispatchHandler;
  }): Promise<EndpointPeerRuntime> {
    const peerId = options.peer.peerId ?? peerIdForRouteDevice(options.route);
    if (!peerId) {
      throw endpointConfigError(
        "private_endpoint_peer_invalid",
        "The admission identity cannot derive a peer id; configure peer.peerId explicitly."
      );
    }
    const cryptoDir = join(options.peer.storageDir, "crypto");
    const clientDir = join(options.peer.storageDir, "client");
    await mkdir(options.peer.storageDir, { recursive: true, mode: 0o700 });
    const cryptoStore = createFilePeerCryptoStore(cryptoDir);
    const clientStore = createFilePeerClientStore(clientDir);
    let identity = await loadPeerIdentity(cryptoStore);
    if (identity === null) {
      identity = await createPeerIdentity({ localStore: cryptoStore, peerId });
    } else if (identity.peerId !== peerId) {
      throw endpointConfigError(
        "private_endpoint_peer_invalid",
        "Configured peer identity does not match the stored identity; verify the profile and preserved peer data."
      );
    }
    const client = new PeerClient({
      identity,
      cryptoStore,
      clientStore,
      transport: createPeerSessionChannel({ send: options.send, admitted: () => options.sessionLive() }),
      route: options.route,
      directory: Object.freeze({ resolvePeerIdentity: options.resolvePeerIdentity }),
      ...(options.dispatch ? { dispatch: options.dispatch } : {})
    });
    return new EndpointPeerRuntime({
      client,
      peerId,
      route: options.route,
      sessionLive: options.sessionLive,
      cryptoStore,
      clientStore,
      resolvePeerIdentity: options.resolvePeerIdentity
    });
  }

  /** Demux landing zone for inbound peer-schema messages. */
  handleInbound(message: unknown): void {
    if (this.#closed || !isPeerSchemaMessage(message)) return;
    this.client.handleInboundMessage(message);
  }

  /**
   * The forward session regained admission. Recover local durable receipt,
   * dispatch and outbox state. The first live admission also publishes this device's prekey bundle so
   * the peer can initiate.
   */
  onSessionLive(): void {
    if (this.#closed) return;
    const generation = ++this.#liveGeneration;
    const work = (async () => {
      try {
        await this.client.resume();
      } catch (error) {
        this.#recordEvent("resume_failed");
      }
      if (this.#closed || generation !== this.#liveGeneration) return;
      if (!this.#bundlePublished) {
        try {
          await this.client.publishBundle();
          this.#bundlePublished = true;
        } catch (error) {
          this.#recordEvent("bundle_publish_failed");
        }
      }
    })().catch((error) => {
      this.#recordEvent("peer_runtime_error");
    });
    this.#sessionWork.add(work);
    void work.finally(() => this.#sessionWork.delete(work));
  }

  /** The session generation ended — the send gate closes with it automatically. */
  onSessionDown(): void {
    this.#liveGeneration += 1;
    this.client.transportLost();
  }

  /** Owner surface: point-in-time peer projection. */
  async status(): Promise<EndpointPeerStatus> {
    const [localBundle, peers, outboxHistory, outboxPending, inboxHistory, inboxPending] = await Promise.all([
      this.client.localBundle(),
      this.client.learnedPeers(),
      this.client.outbox.historyPage(0, 32),
      this.client.outbox.pendingPage(0, 32),
      this.client.inbox.historyPage(0, 32),
      this.client.inbox.pendingDispatchPage(0, 32)
    ]);
    return Object.freeze({
      enabled: true,
      peerId: this.peerId,
      route: this.#route,
      sessionLive: !this.#closed && this.#sessionLive(),
      localBundle,
      peers,
      outbox: outboxHistory.items.map(peerOutboxView),
      outboxNextAfterSequence: outboxHistory.nextAfterSequence,
      pendingOutbox: outboxPending.items.map(peerOutboxView),
      pendingOutboxNextAfterSequence: outboxPending.nextAfterSequence,
      pendingInboxPageCount: inboxPending.items.length,
      pendingInboxNextAfterSequence: inboxPending.nextAfterSequence,
      inboxNextAfterSequence: inboxHistory.nextAfterSequence,
      events: Object.freeze([...this.#events])
    });
  }

  /** Queue and drive one send — returns the durable outbox projection. */
  async sendMessage(input: {
    readonly peerDeviceId: string;
    readonly text?: string;
    readonly plaintextBase64url?: string;
    readonly messageId?: string;
  }): Promise<PeerOutboxView> {
    if (this.#closed) {
      throw endpointConfigError("private_endpoint_peer_closed", "The peer runtime is stopped.");
    }
    const plaintext = input.text !== undefined
      ? Buffer.from(input.text, "utf8")
      : input.plaintextBase64url !== undefined
        ? Buffer.from(input.plaintextBase64url, "base64url")
        : null;
    if (plaintext === null || (input.text !== undefined && input.plaintextBase64url !== undefined)) {
      throw endpointConfigError("private_endpoint_peer_invalid", "peer send requires exactly one of text or plaintextBase64url.");
    }
    const entry = await this.client.sendMessage(
      input.peerDeviceId,
      new Uint8Array(plaintext),
      input.messageId === undefined ? {} : { messageId: input.messageId }
    );
    return peerOutboxView(entry);
  }

  /** Bounded local inbox history pages. */
  async inbox(limit = 64, afterSequence = 0): Promise<{
    readonly entries: readonly PeerInboxView[];
    readonly pendingEntries: readonly PeerInboxView[];
    readonly historyNextAfterSequence: number | null;
    readonly pendingNextAfterSequence: number | null;
  }> {
    const pageSize = Math.max(1, Math.min(limit, 512));
    const [history, pending] = await Promise.all([
      this.client.inbox.historyPage(afterSequence, pageSize),
      this.client.inbox.pendingDispatchPage(afterSequence, pageSize)
    ]);
    const entries = history.items.map(peerInboxView);
    const pendingEntries = pending.items.map(peerInboxView);
    return Object.freeze({
      entries: Object.freeze(entries),
      pendingEntries: Object.freeze(pendingEntries),
      historyNextAfterSequence: history.nextAfterSequence,
      pendingNextAfterSequence: pending.nextAfterSequence
    });
  }

  /**
   * Out-of-band safety evidence for one wire peer: resolves the learned
   * device→peer binding, then the pinned-identity safety number. A null
   * safetyNumber means the peer identity is not pinned (never observed or
   * blocked) — it is never invented.
   */
  async pairSafety(peerDeviceId: string): Promise<{
    readonly peerDeviceId: string;
    readonly peerId: string | null;
    readonly safetyNumber: string | null;
  }> {
    const paired = await this.#resolvePeerIdentity(peerDeviceId);
    if (!paired) {
      return Object.freeze({ peerDeviceId, peerId: null, safetyNumber: null });
    }
    const safetyNumber = await this.client.peerSafetyNumberFor(paired.peerId);
    return Object.freeze({ peerDeviceId, peerId: paired.peerId, safetyNumber });
  }

  /** Best-effort close: the durable stores are already persisted; nothing is discarded. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#liveGeneration += 1;
    await this.client.dispose();
    await Promise.all([...this.#sessionWork]);
  }

  #recordEvent(kind: string, code?: unknown): void {
    // Event kinds are authored here. Arbitrary provider/crypto error text,
    // message contents and peer-supplied detail never enter retained status.
    this.#events.push({ at: new Date().toISOString(), kind, detail: stablePeerCode(code) ?? kind });
    if (this.#events.length > PEER_EVENT_LOG_LIMIT) this.#events.splice(0, this.#events.length - PEER_EVENT_LOG_LIMIT);
  }
}

/** Allowlisted machine vocabulary only; never retain arbitrary provider text. */
export function stablePeerCode(value: unknown): string | null {
  return typeof value === "string" && [...PEER_CLIENT_ERROR_CODES, ...PEER_CRYPTO_ERROR_CODES,
    ...PRIVATE_RELAY_PEER_REFUSALS, ...PRIVATE_RELAY_PEER_FORWARD_REFUSALS].some((code) => code === value) ? value : null;
}
