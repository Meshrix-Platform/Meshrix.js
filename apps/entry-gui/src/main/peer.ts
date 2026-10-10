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
  type PeerClientStore,
  type PeerDispatchHandler,
  type PeerRouteIdentity
} from "@meshrix/peer-client";
import {
  isPeerSchemaMessage,
  peerChannelNotAdmittedError,
  peerGapView,
  peerIdForRouteDevice,
  peerInboxView,
  peerOutboxView,
  routePeerDirectory,
  type PeerGapView,
  type PeerInboxView,
  type PeerOutboxView
} from "@meshrix/entry-transport";
import type { MailboxRetentionPolicy } from "@meshrix/contracts/private-relay";

/**
 * Entry-side peer messaging runtime — one per enrolled connection.
 *
 * Identical composition to the endpoint runtime (`EndpointPeerRuntime`):
 * a durable `PeerClient` over file stores under `<dataDir>/peer/<connSlug>/`
 * (`crypto/` Signal state, `client/` outbox/inbox/cursor), bound to the
 * relay-authenticated route identity. The wire channel is the SAME admitted
 * forward session — `attachChannel` installs the live generation's `send`,
 * `onSessionAdmitted`/`onSessionClosed` open and close the gate, and the
 * product service demuxes inbound peer-schema messages before the session
 * driver sees them.
 *
 * The crypto peer id derives as `peer:<tenant>:<route>:<device>` — the same
 * derivation the endpoint uses — so out-of-band safety-number verification
 * never depends on a wire-delivered peer id. A stored identity that
 * disagrees with the derivation is a hard failure, never a silent re-key.
 *
 * Dispatch is record-only by default: inbound entries persist as
 * `dispatch: "pending"` and a local agent/operator reports the application
 * outcome through `peer.ackOutcome`. No content is executed and no agent
 * receipt is ever fabricated from mailbox acknowledgements.
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
  readonly retentionPolicy: MailboxRetentionPolicy | null;
  /** Learned wire-device → crypto-peer bindings. */
  readonly peers: Readonly<Record<string, string>>;
  readonly cursor: number;
  readonly outbox: readonly PeerOutboxView[];
  readonly inboxCount: number;
  /** Mailbox ranges the deployment lost — retention-gap evidence, verbatim. */
  readonly gaps: readonly PeerGapView[];
  /** Bounded tail of notable events (refusals, re-pair flags, tombstones). */
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
    client.on("ackRefused", (event) => this.#recordEvent("ackRefused", `${event.messageId}: ${event.refusal}`));
    client.on("lostRange", (event) => this.#recordEvent("lostRange", `positions ${event.fromSeq}-${event.toSeq} lost (${event.cause})`));
    client.on("conflict", (event) => this.#recordEvent("conflict", `${event.messageId} → ${event.peerDeviceId}`));
    client.on("unrecorded", (event) => this.#recordEvent("unrecorded", `${event.messageId} → ${event.peerDeviceId}`));
    client.on("bundleRefused", (event) => this.#recordEvent("bundleRefused", event.refusal));
    client.on("decryptFailure", (event) => this.#recordEvent("decryptFailure", `${event.messageId}@${event.position}: ${event.code}`));
    client.on("error", (event) => this.#recordEvent("error", `${event.code}: ${event.detail}`));
  }

  static async create(options: {
    readonly storeDir: string;
    readonly route: PeerRouteIdentity;
    readonly dispatch?: PeerDispatchHandler;
    readonly requestTimeoutMs?: number;
    readonly maxSendAttempts?: number;
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
      directory: routePeerDirectory(options.route),
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.maxSendAttempts !== undefined ? { maxSendAttempts: options.maxSendAttempts } : {})
    });
    return new EntryPeerRuntime({
      client,
      peerId,
      route: options.route,
      cryptoStore,
      clientStore,
      channel
    });
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
   * The forward session (re)gained admission: retry pending sends, reconcile
   * receipts, flush reports and fetch from the durable cursor — all
   * idempotent inside the client. First live admission also publishes the
   * prekey bundle and pulls the retention-policy advertisement as a fallback
   * for the admission-time push.
   */
  onSessionAdmitted(): void {
    if (this.#closed) return;
    this.#channel.live = true;
    const generation = ++this.#liveGeneration;
    void (async () => {
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
      try {
        await this.client.fetchRetentionPolicy();
      } catch (error) {
        this.#recordEvent("retention_policy_failed", error instanceof Error ? error.message : String(error));
      }
    })().catch((error) => {
      this.#recordEvent("peer_runtime_error", error instanceof Error ? error.message : String(error));
    });
  }

  /** The live session generation ended — the gate closes with it. */
  onSessionClosed(): void {
    this.#channel.live = false;
    this.#liveGeneration += 1;
  }

  get sessionLive(): boolean {
    return this.#channel.live && this.#channel.send !== null && !this.#closed;
  }

  async status(): Promise<EntryPeerStatus> {
    const [localBundle, retentionPolicy, peers, outbox, inbox, cursor, gaps] = await Promise.all([
      this.client.localBundle(),
      this.client.retentionPolicy(),
      this.client.learnedPeers(),
      this.client.outbox.list(),
      this.client.inbox.list(),
      this.client.inbox.cursor(),
      this.client.inbox.gaps()
    ]);
    return Object.freeze({
      enabled: true,
      peerId: this.peerId,
      route: this.#route,
      sessionLive: this.sessionLive,
      localBundle,
      retentionPolicy,
      peers,
      cursor,
      outbox: outbox.map(peerOutboxView),
      inboxCount: inbox.length,
      gaps: gaps.map(peerGapView),
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

  /** Explicit mailbox pull from the durable cursor (the fetch op). */
  async sync(): Promise<{ readonly cursor: number }> {
    if (this.#closed) {
      throw entryError("peer_unavailable", "The peer runtime is stopped.");
    }
    await this.client.sync();
    return Object.freeze({ cursor: await this.client.inbox.cursor() });
  }

  /** Operator inbox listing — most recent first, bounded. */
  async inbox(limit = 64): Promise<readonly PeerInboxView[]> {
    const entries = await this.client.inbox.list();
    return entries.slice(-Math.max(1, Math.min(limit, 512))).reverse().map(peerInboxView);
  }

  /** Explicit application receipt — recorded evidence, never derived from acks. */
  async reportOutcome(input: {
    readonly messageId: string;
    readonly outcome: "accepted_by_agent" | "completed" | "rejected";
    readonly detailBase64url?: string;
  }): Promise<{ readonly messageId: string; readonly outcome: string; readonly recorded: true }> {
    if (this.#closed) {
      throw entryError("peer_unavailable", "The peer runtime is stopped.");
    }
    if (!["accepted_by_agent", "completed", "rejected"].includes(input.outcome)) {
      throw entryError("peer_message_invalid", `Unknown application outcome "${String(input.outcome)}".`);
    }
    const detail = input.detailBase64url === undefined ? undefined : new Uint8Array(Buffer.from(input.detailBase64url, "base64url"));
    await this.client.reportOutcome(input.messageId, input.outcome, detail);
    return Object.freeze({ messageId: input.messageId, outcome: input.outcome, recorded: true });
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
    const peerId = peers[peerDeviceId] ?? routePeerDirectory(this.#route).resolvePeerId(peerDeviceId);
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
