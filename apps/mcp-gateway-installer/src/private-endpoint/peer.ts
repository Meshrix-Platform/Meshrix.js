import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  createPeerSessionChannel,
  isPeerSchemaMessage,
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

import { endpointConfigError } from "./config.ts";
import type { PrivateEndpointPeerConfig } from "./config.ts";

/**
 * Endpoint-side peer messaging runtime.
 *
 * One `PeerClient` per endpoint profile run, backed by the durable file
 * stores under `peer.storageDir` (`crypto/` Signal state + `client/`
 * outbox/inbox/cursor). The wire channel is the SAME admitted forward
 * session the endpoint already owns — peer kinds are demuxed by the profile
 * before the session driver sees them, and outbound peer requests pass the
 * admission gate so nothing is offered on a dead generation.
 *
 * Identity: the crypto peer id defaults to `peer:<tenant>:<route>:<device>` —
 * the entry product derives the identical value for its counterparty, so an
 * operator can compare safety numbers out of band. A configured `peerId`
 * must match the stored identity; a mismatch is a loud configuration error,
 * never a silent re-key.
 *
 * Dispatch: `dispatch` is injectable for a host integration; when absent the
 * runtime is record-only — inbound entries land durably in the inbox as
 * `dispatch: "pending"` and an operator reports application outcomes
 * explicitly through `POST /peer/ack-outcome`. No message content is ever
 * executed and no agent receipt is fabricated.
 */

export interface EndpointPeerStatus {
  readonly enabled: true;
  readonly peerId: string;
  readonly route: PeerRouteIdentity;
  /** True when the live session is admitted/streaming and can carry peer traffic. */
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

const PEER_EVENT_LOG_LIMIT = 32;

export class EndpointPeerRuntime {
  readonly client: PeerClient;
  readonly peerId: string;
  readonly #route: PeerRouteIdentity;
  readonly #sessionLive: () => boolean;
  readonly #cryptoStore: PeerCryptoStore;
  readonly #clientStore: PeerClientStore;
  readonly #events: { at: string; kind: string; detail: string }[] = [];
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
  }) {
    this.client = input.client;
    this.peerId = input.peerId;
    this.#route = input.route;
    this.#sessionLive = input.sessionLive;
    this.#cryptoStore = input.cryptoStore;
    this.#clientStore = input.clientStore;
    // Operator evidence surface: every honest refusal/anomaly the client
    // surfaces is retained in a bounded event log on the status surface —
    // never synthesized, never hidden.
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
    readonly peer: PrivateEndpointPeerConfig;
    readonly route: PeerRouteIdentity;
    /** Raw session send — the transport's contract-object sink. */
    readonly send: (message: Record<string, unknown>) => void;
    /** True only while the forward session may carry peer traffic. */
    readonly sessionLive: () => boolean;
    readonly dispatch?: PeerDispatchHandler;
    readonly requestTimeoutMs?: number;
    readonly maxSendAttempts?: number;
  }): Promise<EndpointPeerRuntime> {
    const peerId = options.peer.peerId ?? peerIdForRouteDevice(options.route);
    if (!peerId) {
      throw endpointConfigError(
        "private_endpoint_peer_invalid",
        `The admission identity ${options.route.tenantId}/${options.route.routeId}/${options.route.deviceId} cannot derive a peer id (':' inside a segment would corrupt the binding); set peer.peerId explicitly.`
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
        `Configured peer.peerId "${peerId}" does not match the stored identity "${identity.peerId}"; remove the peer store or fix the configuration.`
      );
    }
    const client = new PeerClient({
      identity,
      cryptoStore,
      clientStore,
      transport: createPeerSessionChannel({ send: options.send, admitted: () => options.sessionLive() }),
      route: options.route,
      directory: routePeerDirectory(options.route),
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.maxSendAttempts !== undefined ? { maxSendAttempts: options.maxSendAttempts } : {})
    });
    return new EndpointPeerRuntime({
      client,
      peerId,
      route: options.route,
      sessionLive: options.sessionLive,
      cryptoStore,
      clientStore
    });
  }

  /** Demux landing zone for inbound peer-schema messages. */
  handleInbound(message: unknown): void {
    if (this.#closed || !isPeerSchemaMessage(message)) return;
    this.client.handleInboundMessage(message);
  }

  /**
   * The forward session (re)gained admission. Retry pending outbox sends,
   * reconcile receipts, drain queued reports and fetch from the durable
   * cursor — the client's own machinery is idempotent across every call.
   * The first live admission also publishes this device's prekey bundle so
   * the peer can initiate.
   */
  onSessionLive(): void {
    if (this.#closed) return;
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
      // The admission push carries the retention policy; pull it explicitly
      // as well so a missed advertisement is still recovered.
      try {
        await this.client.fetchRetentionPolicy();
      } catch (error) {
        this.#recordEvent("retention_policy_failed", error instanceof Error ? error.message : String(error));
      }
    })().catch((error) => {
      this.#recordEvent("peer_runtime_error", error instanceof Error ? error.message : String(error));
    });
  }

  /** The session generation ended — the send gate closes with it automatically. */
  onSessionDown(): void {
    this.#liveGeneration += 1;
  }

  /** Owner surface: point-in-time peer projection. */
  async status(): Promise<EndpointPeerStatus> {
    const [localBundle, retentionPolicy, peers, outbox, inbox, gaps] = await Promise.all([
      this.client.localBundle(),
      this.client.retentionPolicy(),
      this.client.learnedPeers(),
      this.client.outbox.list(),
      this.client.inbox.list(),
      this.client.inbox.gaps()
    ]);
    return Object.freeze({
      enabled: true,
      peerId: this.peerId,
      route: this.#route,
      sessionLive: !this.#closed && this.#sessionLive(),
      localBundle,
      retentionPolicy,
      peers,
      cursor: await this.client.inbox.cursor(),
      outbox: outbox.map(peerOutboxView),
      inboxCount: inbox.length,
      gaps: gaps.map(peerGapView),
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

  /** Explicit mailbox pull from the durable cursor (the fetch op). */
  async sync(): Promise<{ readonly cursor: number }> {
    if (this.#closed) {
      throw endpointConfigError("private_endpoint_peer_closed", "The peer runtime is stopped.");
    }
    await this.client.sync();
    return Object.freeze({ cursor: await this.client.inbox.cursor() });
  }

  /** Operator inbox listing — most recent first, bounded by the caller's limit. */
  async inbox(limit = 64): Promise<readonly PeerInboxView[]> {
    const entries = await this.client.inbox.list();
    return entries.slice(-Math.max(1, Math.min(limit, 512))).reverse().map(peerInboxView);
  }

  /** Explicit application receipt for a received message — recorded evidence, never derived. */
  async reportOutcome(input: {
    readonly messageId: string;
    readonly outcome: "accepted_by_agent" | "completed" | "rejected";
    readonly detailBase64url?: string;
  }): Promise<{ readonly messageId: string; readonly outcome: string; readonly recorded: true }> {
    if (this.#closed) {
      throw endpointConfigError("private_endpoint_peer_closed", "The peer runtime is stopped.");
    }
    if (!["accepted_by_agent", "completed", "rejected"].includes(input.outcome)) {
      throw endpointConfigError("private_endpoint_peer_invalid", `Unknown application outcome "${String(input.outcome)}".`);
    }
    const detail = input.detailBase64url === undefined ? undefined : new Uint8Array(Buffer.from(input.detailBase64url, "base64url"));
    await this.client.reportOutcome(input.messageId, input.outcome, detail);
    return Object.freeze({ messageId: input.messageId, outcome: input.outcome, recorded: true });
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
    const peers = await this.client.learnedPeers();
    const peerId = peers[peerDeviceId] ?? routePeerDirectory(this.#route).resolvePeerId(peerDeviceId);
    if (peerId === null) {
      return Object.freeze({ peerDeviceId, peerId: null, safetyNumber: null });
    }
    const safetyNumber = await this.client.peerSafetyNumberFor(peerId);
    return Object.freeze({ peerDeviceId, peerId, safetyNumber });
  }

  /** Best-effort close: the durable stores are already persisted; nothing is discarded. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#liveGeneration += 1;
  }

  #recordEvent(kind: string, detail: string): void {
    this.#events.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 256) });
    if (this.#events.length > PEER_EVENT_LOG_LIMIT) this.#events.splice(0, this.#events.length - PEER_EVENT_LOG_LIMIT);
  }
}
