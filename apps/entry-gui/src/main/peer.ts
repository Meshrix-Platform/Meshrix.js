import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { entryError } from "@meshrix/entry";
import {
  createFilePeerCryptoStore,
  createPeerIdentity,
  loadPeerIdentity,
  type PeerCryptoStore
} from "@meshrix/peer-crypto";
import {
  PeerClient,
  createFilePeerClientStore,
  peerIdentityPublicDescriptor,
  type PeerDeviceDirectory,
  type PeerPairedSignalIdentity,
  type PeerClientStore,
  type PeerDispatchHandler,
  type PeerRouteIdentity
} from "@meshrix/peer-client";
import {
  isPeerSchemaMessage,
  peerChannelNotAdmittedError,
  peerIdForRouteDevice,
  peerInboxView,
  peerOutboxView,
  type PeerInboxView,
  type PeerOutboxView
} from "@meshrix/entry-transport";

/**
 * Entry-side peer messaging runtime — one per enrolled connection.
 *
 * Identical composition to the endpoint runtime (`EndpointPeerRuntime`):
 * a durable `PeerClient` over file stores under `<dataDir>/peer/<connSlug>/`
 * (`crypto/` Signal state, `client/` outbox/inbox), bound to the
 * relay-authenticated route identity. The wire channel is the SAME admitted
 * forward session — `attachChannel` installs the live generation's `send`,
 * `onSessionAdmitted`/`onSessionClosed` open and close the gate, and the
 * product service demuxes inbound peer-schema messages before the session
 * driver sees them.
 *
 * The crypto peer id derives from the canonical route tuple — the same
 * derivation the endpoint uses — so out-of-band safety-number verification
 * never depends on a wire-delivered peer id. A stored identity that
 * disagrees with the derivation is a hard failure, never a silent re-key.
 *
 * Dispatch is record-only by default: inbound entries persist as
 * `dispatch: "pending"`. Transport custody receipts confirm durable local
 * receipt only; application outcomes remain encrypted Peer messages.
 */

const PEER_EVENT_LOG_LIMIT = 32;
const PEER_DIR_SAFE = /[^a-z0-9._-]/giu;

/** Per-connection peer store location inside the owned data directory. */
export function peerStoreDirFor(dataDir: string, connectionId: string): string {
  return join(dataDir, "peer", connectionId.replace(PEER_DIR_SAFE, "-").toLowerCase());
}

export interface EntryPeerStatus {
  readonly enabled: true;
  readonly peerId: string;
  readonly route: PeerRouteIdentity;
  /** True while the live session generation is admitted and can carry peer traffic. */
  readonly sessionLive: boolean;
  readonly localBundle: { readonly bundleId: string; readonly revision: number } | null;
  /** Learned wire-device → crypto-peer bindings. */
  readonly peers: Readonly<Record<string, string>>;
  /** Bounded outbox-history page; continue with outboxNextAfterSequence. */
  readonly outbox: readonly PeerOutboxView[];
  readonly outboxNextAfterSequence: number | null;
  /** Bounded unsatisfied durable sends; runtime retries the original ciphertext. */
  readonly pendingOutbox: readonly PeerOutboxView[];
  readonly pendingOutboxNextAfterSequence: number | null;
  /** Number of pending local application handoffs in the returned page. */
  readonly pendingInboxPageCount: number;
  readonly pendingInboxNextAfterSequence: number | null;
  /** Continue local inbox history after this sequence through peer.inbox. */
  readonly inboxNextAfterSequence: number | null;
  /** Bounded tail of notable local events (refusals, re-pair flags, conflicts). */
  readonly events: readonly { readonly at: string; readonly kind: string; readonly detail: string }[];
}

export class EntryPeerRuntime {
  readonly client: PeerClient;
  readonly peerId: string;
  readonly #route: PeerRouteIdentity;
  readonly #cryptoStore: PeerCryptoStore;
  readonly #clientStore: PeerClientStore;
  /** Mutable channel cell shared with the client's transport closure. */
  readonly #channel: { send: ((message: Record<string, unknown>) => void) | null; live: boolean };
  readonly #events: { at: string; kind: string; detail: string }[] = [];
  readonly #sessionWork = new Set<Promise<void>>();
  #closed = false;
  #liveGeneration = 0;
  #bundlePublished = false;

  private constructor(input: {
    readonly client: PeerClient;
    readonly peerId: string;
    readonly route: PeerRouteIdentity;
    readonly cryptoStore: PeerCryptoStore;
    readonly clientStore: PeerClientStore;
    readonly channel: { send: ((message: Record<string, unknown>) => void) | null; live: boolean };
  }) {
    this.client = input.client;
    this.peerId = input.peerId;
    this.#route = input.route;
    this.#cryptoStore = input.cryptoStore;
    this.#clientStore = input.clientStore;
    this.#channel = input.channel;
    const client = input.client;
    client.on("requiresRePair", (event) => this.#recordEvent("requiresRePair", `${event.peerId} (${event.source}): ${event.detail}`));
    client.on("conflict", (event) => this.#recordEvent("conflict", `${event.messageId} → ${event.peerDeviceId}`));
    client.on("bundleRefused", (event) => this.#recordEvent("bundleRefused", event.refusal));
    client.on("peerPresence", (event) => this.#recordEvent("peerPresence", `${event.peerDeviceId}: ${event.state}`));
    client.on("dispatchDeferred", (event) => this.#recordEvent("dispatchDeferred", `${event.messageId}@${event.senderDeviceId}`));
    client.on("error", (event) => this.#recordEvent("error", `${event.code}: ${event.detail}`));
  }

  static async create(options: {
    readonly storeDir: string;
    readonly route: PeerRouteIdentity;
    /** Pairing-authenticated remote Signal identity; null fails closed at first contact. */
    readonly pairedPeerIdentity?: PeerPairedSignalIdentity | null;
    readonly directory?: PeerDeviceDirectory;
    readonly dispatch?: PeerDispatchHandler;
  }): Promise<EntryPeerRuntime> {
    const peerId = peerIdForRouteDevice(options.route);
    if (!peerId) {
      throw entryError(
        "peer_identity_invalid",
        `The connection identity ${options.route.tenantId}/${options.route.routeId}/${options.route.deviceId} cannot derive a peer id; peer messaging is unavailable for it.`
      );
    }
    const channel: { send: ((message: Record<string, unknown>) => void) | null; live: boolean } = { send: null, live: false };
    const cryptoStore = createFilePeerCryptoStore(join(options.storeDir, "crypto"));
    const clientStore = createFilePeerClientStore(join(options.storeDir, "client"));
    await mkdir(options.storeDir, { recursive: true, mode: 0o700 });
    let identity = await loadPeerIdentity(cryptoStore);
    if (identity === null) {
      if (options.pairedPeerIdentity) {
        throw entryError(
          "peer_identity_unavailable",
          "The local Signal identity from the completed pairing is unavailable; preserve task history and re-pair this device before sending Peer messages."
        );
      }
      identity = await createPeerIdentity({ localStore: cryptoStore, peerId });
    } else if (identity.peerId !== peerId) {
      throw entryError(
        "peer_identity_invalid",
        `The stored peer identity "${identity.peerId}" does not match the derived binding "${peerId}"; the peer store does not belong to this connection.`
      );
    }
    const client = new PeerClient({
      identity,
      cryptoStore,
      clientStore,
      transport: {
        send: (message: Record<string, unknown>) => {
          if (!channel.live || channel.send === null) throw peerChannelNotAdmittedError();
          channel.send(message);
        }
      },
      route: options.route,
      ...(options.directory ? { directory: options.directory } : {}),
      ...(options.dispatch ? { dispatch: options.dispatch } : {})
    });
    try {
      // Local status and history must work while disconnected. Bind the route
      // and recover any prepared local transaction without calling resume(),
      // which also retries relay ACKs, outbox sends, and application dispatch.
      await client.prepareLocalState();
    } catch (error) {
      await client.dispose();
      throw error;
    }
    return new EntryPeerRuntime({
      client,
      peerId,
      route: options.route,
      cryptoStore,
      clientStore,
      channel
    });
  }

  /** Prepare the stable local Signal identity before it is signed into pairing. */
  static async preparePairingIdentity(options: {
    readonly storeDir: string;
    readonly route: PeerRouteIdentity;
    readonly requireExisting?: boolean;
  }): Promise<PeerPairedSignalIdentity> {
    const peerId = peerIdForRouteDevice(options.route);
    if (!peerId) throw entryError("peer_identity_invalid", "The pairing route cannot derive a Peer identity.");
    const storeDir = options.storeDir;
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const cryptoStore = createFilePeerCryptoStore(join(storeDir, "crypto"));
    let identity = await loadPeerIdentity(cryptoStore);
    if (identity === null && options.requireExisting) {
      throw entryError("peer_identity_unavailable", "The local Signal identity from the submitted pairing is unavailable; restore its protected state or explicitly pair again.");
    }
    if (identity === null) identity = await createPeerIdentity({ localStore: cryptoStore, peerId });
    if (identity.peerId !== peerId) {
      throw entryError("peer_identity_invalid", "The saved local Signal identity is bound to another pairing route.");
    }
    return peerIdentityPublicDescriptor(identity);
  }

  /** Install the live session generation's raw send. */
  attachChannel(send: (message: Record<string, unknown>) => void): void {
    if (this.#closed) return;
    this.#channel.send = send;
  }

  /** The session generation's send is gone — the gate refuses immediately. */
  detachChannel(): void {
    this.#channel.send = null;
    this.#channel.live = false;
  }

  /** Demux landing zone for inbound peer-schema messages. */
  handleInbound(message: unknown): void {
    if (this.#closed || !isPeerSchemaMessage(message)) return;
    this.client.handleInboundMessage(message);
  }

  /**
   * The forward session regained admission: recover durable local receipt,
   * dispatch, and outbox state, then publish the prekey bundle.
   */
  onSessionAdmitted(): void {
    if (this.#closed) return;
    this.#channel.live = true;
    const generation = ++this.#liveGeneration;
    const work = (async () => {
      try {
        await this.client.resume();
      } catch (error) {
        this.#recordEvent("resume_failed", error instanceof Error ? error.message : String(error));
      }
      if (this.#closed || generation !== this.#liveGeneration) return;
      if (!this.#bundlePublished) {
        try {
          await this.client.publishBundle();
          this.#bundlePublished = true;
        } catch (error) {
          this.#recordEvent("bundle_publish_failed", error instanceof Error ? error.message : String(error));
        }
      }
    })().catch((error) => {
      this.#recordEvent("peer_runtime_error", error instanceof Error ? error.message : String(error));
    });
    this.#sessionWork.add(work);
    void work.finally(() => this.#sessionWork.delete(work));
  }

  /** The live session generation ended — the gate closes with it. */
  onSessionClosed(): void {
    this.#channel.live = false;
    this.#liveGeneration += 1;
    this.client.transportLost();
  }

  get sessionLive(): boolean {
    return this.#channel.live && this.#channel.send !== null && !this.#closed;
  }

  isPeerReachable(peerDeviceId: string): boolean {
    const presence = this.client.presence(peerDeviceId);
    return this.sessionLive && presence !== null
      && presence.tenantId === this.#route.tenantId
      && presence.routeId === this.#route.routeId
      && presence.deviceId === this.#route.deviceId
      && presence.peerDeviceId === peerDeviceId
      && presence.state === "reachable";
  }

  async status(): Promise<EntryPeerStatus> {
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
      sessionLive: this.sessionLive,
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

  /** Queue + drive one send — returns the durable outbox projection. */
  async sendMessage(input: {
    readonly peerDeviceId: string;
    readonly text?: string;
    readonly plaintextBase64url?: string;
    readonly messageId?: string;
  }): Promise<PeerOutboxView> {
    if (this.#closed) {
      throw entryError("peer_unavailable", "The peer runtime is stopped.");
    }
    const plaintext = input.text !== undefined
      ? Buffer.from(input.text, "utf8")
      : input.plaintextBase64url !== undefined
        ? Buffer.from(input.plaintextBase64url, "base64url")
        : null;
    if (plaintext === null || (input.text !== undefined && input.plaintextBase64url !== undefined)) {
      throw entryError("peer_message_invalid", "peer.send requires exactly one of text or plaintextBase64url.");
    }
    if (typeof input.peerDeviceId !== "string" || !input.peerDeviceId) {
      throw entryError("peer_message_invalid", "peer.send requires the counterparty peerDeviceId.");
    }
    const entry = await this.client.sendMessage(
      input.peerDeviceId,
      new Uint8Array(plaintext),
      input.messageId === undefined ? {} : { messageId: input.messageId }
    );
    return peerOutboxView(entry);
  }

  /** Operator inbox listing — bounded local history and pending-handoff pages. */
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
   * Out-of-band safety evidence for one wire peer. The peer id comes from
   * the learned device binding or the shared route derivation — a wire
   * message can never inject one. `safetyNumber` is null until the peer
   * identity is pinned; it is never invented.
   */
  async pairSafety(peerDeviceId: string): Promise<{
    readonly peerDeviceId: string;
    readonly peerId: string | null;
    readonly safetyNumber: string | null;
  }> {
    if (typeof peerDeviceId !== "string" || !peerDeviceId) {
      throw entryError("peer_message_invalid", "peer.pairSafety requires the counterparty peerDeviceId.");
    }
    const peers = await this.client.learnedPeers();
    const peerId = peers[peerDeviceId] ?? peerIdForRouteDevice({
      tenantId: this.#route.tenantId,
      routeId: this.#route.routeId,
      deviceId: peerDeviceId
    });
    if (peerId === null) {
      return Object.freeze({ peerDeviceId, peerId: null, safetyNumber: null });
    }
    const safetyNumber = await this.client.peerSafetyNumberFor(peerId);
    return Object.freeze({ peerDeviceId, peerId, safetyNumber });
  }

  /** Detach the channel; durable state is already on disk. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#channel.send = null;
    this.#channel.live = false;
    this.#liveGeneration += 1;
    await this.client.dispose();
    await Promise.all([...this.#sessionWork]);
  }

  /** Remove the whole per-connection peer store (revocation/uninstall). */
  static async removeStore(storeDir: string): Promise<void> {
    await rm(storeDir, { recursive: true, force: true });
  }

  #recordEvent(kind: string, detail: string): void {
    this.#events.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 256) });
    if (this.#events.length > PEER_EVENT_LOG_LIMIT) this.#events.splice(0, this.#events.length - PEER_EVENT_LOG_LIMIT);
  }
}
