import type {
  PeerDeliveryAck,
  PeerEnvelope,
  PeerForwarded,
  PeerMessageIdentity
} from "@meshrix/contracts/private-relay";

import { PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * Device-local durable Peer records. Relay outcomes are transport evidence;
 * only a recipient-signed ACK moves an outbox entry to delivered. Application
 * acceptance/completion remains encrypted Peer traffic and is not a delivery
 * state.
 */
export const PEER_OUTBOX_STATES = Object.freeze(["pending", "delivered", "conflict"] as const);
export type PeerOutboxState = (typeof PEER_OUTBOX_STATES)[number];

/** Route scope used for local sequence allocation and paged projections. */
export interface PeerClientRouteScope {
  readonly tenantId: string;
  readonly routeId: string;
}

/** Authenticated route identity required to reconstruct legacy sender fields. */
export interface PeerClientRouteIdentity extends PeerClientRouteScope {
  readonly deviceId: string;
}

export function peerOutboxStateIsTerminal(state: PeerOutboxState): boolean {
  return state === "delivered" || state === "conflict";
}

/** Client-local FIFO order; never appears in the relay wire contract. */
export interface PeerLocalOrder {
  readonly sequence: number;
}

export interface StoredOutboxEntry extends PeerMessageIdentity, PeerLocalOrder {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  /** Crypto peer id pinned for the recipient device. */
  readonly peerId: string;
  readonly state: PeerOutboxState;
  /** Exact ciphertext envelope reused across reconnect retries. */
  readonly envelope: PeerEnvelope;
  /** Attempts count transport writes only; no attempt count expires the record. */
  readonly attempts: number;
  /** Last online relay result; this is never durable recipient delivery proof. */
  readonly lastForwarded: PeerForwarded | null;
  /** Verified recipient receipt; persisted with the terminal delivered state. */
  readonly deliveryAck: PeerDeliveryAck | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Host-neutral application handoff state; this survives until journal commit. */
export const PEER_INBOX_DISPATCH_STATES = Object.freeze([
  "pending",
  "accepted_by_agent",
  "rejected",
  "skipped",
  "failed"
] as const);
export type PeerInboxDispatchState = (typeof PEER_INBOX_DISPATCH_STATES)[number];

export interface StoredInboxEntry extends PeerMessageIdentity, PeerLocalOrder {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  /** Crypto peer id recovered from the authenticated Signal envelope. */
  readonly senderPeerId: string | null;
  readonly envelope: PeerEnvelope;
  /** base64url plaintext for local application dispatch; never sent to relay. */
  readonly plaintext: string | null;
  readonly decryptError: string | null;
  readonly dispatch: PeerInboxDispatchState;
  /** Signed ACK persisted on this durable inbox record before send, replayed on duplicate. */
  readonly deliveryAck: PeerDeliveryAck | null;
  readonly receivedAt: string;
  readonly updatedAt: string;
}

/** The device's own published public prekey bundle. */
export interface StoredLocalBundle {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  readonly bundleId: string;
  readonly revision: number;
  readonly format: string;
  readonly material: string | null;
}

/** Header material remembered about a remote public bundle. */
export interface StoredBundleObservation {
  readonly bundleId: string;
  readonly revision: number;
  readonly oneTimePreKeyId: number | null;
  readonly signedPrekeyId: number | null;
}

/**
 * Immutable evidence retained from the superseded local mailbox model.
 * Positions, gaps and old receipt facts are historical only; no method below
 * accepts them as active transport cursors or retry authority.
 */
export interface StoredPeerHistoryEntry extends PeerLocalOrder {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly source: "legacy_outbox" | "legacy_inbox" | "legacy_gap";
  readonly messageId: string | null;
  readonly deviceId: string | null;
  readonly formerPosition: number | null;
  readonly formerGap: {
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly cause: "expired" | "capacity_truncated";
    readonly messageIds: readonly string[] | null;
  } | null;
  readonly formerState: string | null;
  readonly formerReceiptFacts: readonly Readonly<Record<string, unknown>>[];
  /**
   * Full original device-local JSON record, including any locally stored body.
   * Migration preserves it verbatim as historical user data; it is never
   * interpreted as active authority or sent through the relay.
   */
  readonly legacyRecord: Readonly<Record<string, unknown>> | null;
  readonly recordedAt: string;
}

/** Small metadata document; it contains no business message history. */
export interface PeerClientMeta {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  readonly localBundle: StoredLocalBundle | null;
  /** Learned bindings: relay device id → paired Signal peer id. */
  readonly peers: Readonly<Record<string, string>>;
  readonly bundleObservations: Readonly<Record<string, StoredBundleObservation>>;
}

export function emptyPeerClientMeta(): PeerClientMeta {
  return Object.freeze({
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    localBundle: null,
    peers: Object.freeze({}),
    bundleObservations: Object.freeze({})
  });
}

export interface PeerClientPage<T> {
  readonly items: readonly T[];
  /** Last local sequence examined, suitable as the next exclusive page cursor. */
  readonly nextAfterSequence: number | null;
}

export interface PeerClientPageQuery {
  readonly afterSequence: number;
  readonly limit: number;
}

export interface PeerClientStore {
  /**
   * Idempotently import/preserve local legacy records before route-scoped
   * work. Durable implementations remove source files only after the full
   * record is persisted under the new local history projection.
   */
  prepareRoute(route: PeerClientRouteIdentity): Promise<void>;

  /**
   * Refuse a new durable record before crypto state is committed when local
   * storage cannot accommodate it. Existing records and WAL recovery remain
   * readable regardless of current free space.
   */
  assertAvailableCapacity(additionalBytes: number): Promise<void>;

  loadMeta(): Promise<PeerClientMeta | null>;
  saveMeta(meta: PeerClientMeta): Promise<void>;

  /**
   * Durable, strictly increasing local order allocators, scoped to the bound
   * route and stream. Values must never be reused after restart; gaps after a
   * crash are harmless because these are local ordering cursors only.
   */
  allocateOutboxSequence(scope: PeerClientRouteScope): Promise<number>;
  allocateInboxSequence(scope: PeerClientRouteScope): Promise<number>;
  allocateHistorySequence(scope: PeerClientRouteScope): Promise<number>;

  loadOutboxEntry(identity: PeerMessageIdentity): Promise<StoredOutboxEntry | null>;
  saveOutboxEntry(entry: StoredOutboxEntry): Promise<void>;
  listPendingOutboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>>;
  listOutboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>>;

  loadInboxEntry(identity: PeerMessageIdentity): Promise<StoredInboxEntry | null>;
  saveInboxEntry(entry: StoredInboxEntry): Promise<void>;
  listPendingInboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>>;
  /** Durable inbox rows without a signed ACK, independent of app dispatch. */
  listPendingDeliveryAckPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>>;
  listInboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>>;

  savePeerHistoryEntry(entry: StoredPeerHistoryEntry): Promise<void>;
  listPeerHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredPeerHistoryEntry>>;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function scopeKey(scope: PeerClientRouteScope): string {
  return JSON.stringify([scope.tenantId, scope.routeId]);
}

function identityKey(identity: PeerMessageIdentity): string {
  return JSON.stringify([
    identity.tenantId,
    identity.routeId,
    identity.senderDeviceId,
    identity.recipientDeviceId,
    identity.messageId
  ]);
}

function inScope<T extends { tenantId: string; routeId: string; sequence: number }>(
  entries: Iterable<T>,
  scope: PeerClientRouteScope,
  query: PeerClientPageQuery,
  predicate: (entry: T) => boolean
): PeerClientPage<T> {
  const candidates = [...entries]
    .filter((entry) => entry.tenantId === scope.tenantId && entry.routeId === scope.routeId
      && entry.sequence > query.afterSequence && predicate(entry))
    .sort((left, right) => left.sequence - right.sequence);
  const selected = candidates.slice(0, query.limit);
  return Object.freeze({
    items: clone(selected),
    nextAfterSequence: selected.length === 0 ? null : selected[selected.length - 1].sequence
  });
}

/**
 * Map-backed store for tests and ephemeral composition. The durable file
 * implementation uses the same stable tuple and page semantics.
 */
export class InMemoryPeerClientStore implements PeerClientStore {
  #meta: PeerClientMeta | null = null;
  readonly #outbox = new Map<string, StoredOutboxEntry>();
  readonly #inbox = new Map<string, StoredInboxEntry>();
  readonly #history = new Map<string, StoredPeerHistoryEntry>();
  readonly #outboxSequences = new Map<string, number>();
  readonly #inboxSequences = new Map<string, number>();
  readonly #historySequences = new Map<string, number>();

  async prepareRoute(_route: PeerClientRouteIdentity): Promise<void> {}

  async assertAvailableCapacity(_additionalBytes: number): Promise<void> {}

  async loadMeta(): Promise<PeerClientMeta | null> {
    return clone(this.#meta);
  }

  async saveMeta(meta: PeerClientMeta): Promise<void> {
    this.#meta = clone(meta);
  }

  async allocateOutboxSequence(scope: PeerClientRouteScope): Promise<number> {
    return this.#next(this.#outboxSequences, scopeKey(scope));
  }

  async allocateInboxSequence(scope: PeerClientRouteScope): Promise<number> {
    return this.#next(this.#inboxSequences, scopeKey(scope));
  }

  async allocateHistorySequence(scope: PeerClientRouteScope): Promise<number> {
    return this.#next(this.#historySequences, scopeKey(scope));
  }

  async loadOutboxEntry(identity: PeerMessageIdentity): Promise<StoredOutboxEntry | null> {
    return clone(this.#outbox.get(identityKey(identity)) ?? null);
  }

  async saveOutboxEntry(entry: StoredOutboxEntry): Promise<void> {
    this.#outbox.set(identityKey(entry), clone(entry));
    this.#advance(this.#outboxSequences, scopeKey(entry), entry.sequence);
  }

  async listPendingOutboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>> {
    return inScope(this.#outbox.values(), scope, query, (entry) => entry.state === "pending");
  }

  async listOutboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>> {
    return inScope(this.#outbox.values(), scope, query, (entry) => entry.state !== "pending");
  }

  async loadInboxEntry(identity: PeerMessageIdentity): Promise<StoredInboxEntry | null> {
    return clone(this.#inbox.get(identityKey(identity)) ?? null);
  }

  async saveInboxEntry(entry: StoredInboxEntry): Promise<void> {
    this.#inbox.set(identityKey(entry), clone(entry));
    this.#advance(this.#inboxSequences, scopeKey(entry), entry.sequence);
  }

  async listPendingInboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return inScope(this.#inbox.values(), scope, query, (entry) => entry.dispatch === "pending");
  }

  async listPendingDeliveryAckPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return inScope(this.#inbox.values(), scope, query, (entry) => entry.deliveryAck === null);
  }

  async listInboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return inScope(this.#inbox.values(), scope, query, (entry) => entry.dispatch !== "pending");
  }

  async savePeerHistoryEntry(entry: StoredPeerHistoryEntry): Promise<void> {
    this.#history.set(entry.evidenceId, clone(entry));
    this.#advance(this.#historySequences, scopeKey(entry), entry.sequence);
  }

  async listPeerHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredPeerHistoryEntry>> {
    return inScope(this.#history.values(), scope, query, () => true);
  }

  #next(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  #advance(map: Map<string, number>, key: string, sequence: number): void {
    if (Number.isSafeInteger(sequence) && sequence > (map.get(key) ?? 0)) map.set(key, sequence);
  }
}

export function createInMemoryPeerClientStore(): InMemoryPeerClientStore {
  return new InMemoryPeerClientStore();
}
