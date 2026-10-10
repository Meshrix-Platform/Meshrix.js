import type {
  MailboxRetentionPolicy,
  PeerEnvelope,
  PeerReceipt
} from "@meshrix/contracts/private-relay";

import { PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * Durable peer client store contract for one device.
 *
 * Everything the client must survive a process restart lives here: the
 * sender-scoped outbox (including the exact wire envelope bytes so a retry
 * replays byte-identical sends and the mailbox's duplicate path — never the
 * conflict path — answers), the deduplicated inbox with decrypted payloads,
 * the fetch cursor, observed truncation tombstones, queued application
 * reports, the local bundle record and learned peer bindings.
 *
 * Values are JSON-shaped records; implementations must write them with
 * owner-only permissions and never emit decrypted payloads to logs.
 */

/** Outbox lifecycle: pending → accepted(position) → received → agent-terminal. */
export const PEER_OUTBOX_STATES = Object.freeze([
  "pending",
  "accepted",
  "received",
  "accepted_by_agent",
  "completed",
  "rejected",
  "conflict",
  "unrecorded"
] as const);
export type PeerOutboxState = (typeof PEER_OUTBOX_STATES)[number];

/**
 * States after which the entry never moves again. `accepted_by_agent` is
 * deliberately NOT terminal: the agent lifecycle continues to `completed`
 * or `rejected` reports, and a late `received` may still arrive as evidence.
 */
export const PEER_OUTBOX_TERMINAL_STATES = Object.freeze([
  "completed",
  "rejected",
  "conflict",
  "unrecorded"
] as const);

/** Forward-only lifecycle order — a receipt may advance, never regress. */
export const PEER_OUTBOX_STATE_ORDER = Object.freeze({
  pending: 0,
  accepted: 1,
  received: 2,
  accepted_by_agent: 3,
  completed: 4,
  rejected: 4,
  conflict: 9,
  unrecorded: 9
} as const satisfies Record<PeerOutboxState, number>);

export function peerOutboxStateIsTerminal(state: PeerOutboxState): boolean {
  return (PEER_OUTBOX_TERMINAL_STATES as readonly string[]).includes(state);
}

export function peerOutboxStateOrder(state: PeerOutboxState): number {
  return PEER_OUTBOX_STATE_ORDER[state];
}

export interface StoredOutboxEntry {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  /** Sender-scoped id — unique per sender, replayed verbatim on retry. */
  readonly messageId: string;
  /** Wire recipient device id (mailbox partition owner). */
  readonly peerDeviceId: string;
  /** Crypto peer id the session is bound to. */
  readonly peerId: string;
  readonly state: PeerOutboxState;
  /** Mailbox-assigned durable position; null until an accepted receipt exists. */
  readonly position: number | null;
  /** The exact wire envelope sent — retry must replay these bytes identically. */
  readonly envelope: PeerEnvelope;
  /** Number of peer-send attempts issued for this entry. */
  readonly attempts: number;
  /** Receipts observed through peer-accepted or peer-status, in arrival order. */
  readonly receipts: readonly PeerReceipt[];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Inbox dispatch lifecycle for the host-neutral surface. */
export const PEER_INBOX_DISPATCH_STATES = Object.freeze([
  "pending",
  "accepted_by_agent",
  "rejected",
  "skipped",
  "failed"
] as const);
export type PeerInboxDispatchState = (typeof PEER_INBOX_DISPATCH_STATES)[number];

export interface StoredInboxEntry {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  /** Durable mailbox position — the dedup and cursor primitive. */
  readonly position: number;
  /** Relay-authenticated wire sender device id. */
  readonly senderDeviceId: string;
  /** Crypto peer id recovered from the decrypted envelope; null when undecryptable. */
  readonly senderPeerId: string | null;
  readonly messageId: string;
  /** The stored wire envelope, kept as delivery evidence. */
  readonly envelope: PeerEnvelope;
  /** base64url plaintext; null when the entry could not be decrypted. */
  readonly plaintext: string | null;
  /** Crypto/client error code when decryption failed; evidence, never hidden. */
  readonly decryptError: string | null;
  readonly dispatch: PeerInboxDispatchState;
  /** Application receipt kinds already recorded by the mailbox for this entry. */
  readonly reports: readonly string[];
  readonly receivedAt: string;
}

/** A durable tombstone for a mailbox range the deployment lost — surfaced, never skipped. */
export interface StoredGapTombstone {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly cause: "expired" | "capacity_truncated";
  readonly messageIds: readonly string[] | null;
  readonly observedAt: string;
}

/** The device's own published bundle record; revision 0 means never published. */
export interface StoredLocalBundle {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  readonly bundleId: string;
  readonly revision: number;
  readonly format: string;
  /** base64url JSON of the PeerPrekeyBundle published at `revision`; null when unpublished. */
  readonly material: string | null;
}

/** Header material remembered about the remote bundle a session was initiated against. */
export interface StoredBundleObservation {
  readonly bundleId: string;
  readonly revision: number;
  readonly oneTimePreKeyId: number | null;
  readonly signedPrekeyId: number | null;
}

/** Single atomic meta document — small, rewritten whole under owner-only permissions. */
export interface PeerClientMeta {
  readonly version: typeof PEER_CLIENT_STORE_RECORD_VERSION;
  /** Highest peer-fetch `nextAfterSeq` committed after page processing + ack. */
  readonly cursor: number;
  /** Application receipts queued for the next peer-ack `reports[]`; durable until recorded or refused. */
  readonly pendingReports: readonly PeerReceipt[];
  readonly localBundle: StoredLocalBundle | null;
  /** Learned bindings: wire device id → crypto peer id. */
  readonly peers: Readonly<Record<string, string>>;
  /** Remembered remote bundle headers per wire device id. */
  readonly bundleObservations: Readonly<Record<string, StoredBundleObservation>>;
  /** Last observed mailbox retention policy advertisement. */
  readonly retentionPolicy: MailboxRetentionPolicy | null;
}

export function emptyPeerClientMeta(): PeerClientMeta {
  return Object.freeze({
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    cursor: 0,
    pendingReports: Object.freeze([]),
    localBundle: null,
    peers: Object.freeze({}),
    bundleObservations: Object.freeze({}),
    retentionPolicy: null
  });
}

export interface PeerClientStore {
  loadMeta(): Promise<PeerClientMeta | null>;
  saveMeta(meta: PeerClientMeta): Promise<void>;

  loadOutboxEntry(messageId: string): Promise<StoredOutboxEntry | null>;
  saveOutboxEntry(entry: StoredOutboxEntry): Promise<void>;
  listOutboxEntries(): Promise<readonly StoredOutboxEntry[]>;

  loadInboxEntry(position: number): Promise<StoredInboxEntry | null>;
  loadInboxEntryByMessageId(messageId: string): Promise<StoredInboxEntry | null>;
  saveInboxEntry(entry: StoredInboxEntry): Promise<void>;
  listInboxEntries(): Promise<readonly StoredInboxEntry[]>;

  saveGapTombstone(gap: StoredGapTombstone): Promise<void>;
  findGapTombstone(fromSeq: number, toSeq: number): Promise<StoredGapTombstone | null>;
  listGapTombstones(): Promise<readonly StoredGapTombstone[]>;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/**
 * Map-backed store for tests and ephemeral composition. Mirrors the durable
 * contract (defensive copies on every boundary) so callers cannot
 * distinguish it from the file implementation.
 */
export class InMemoryPeerClientStore implements PeerClientStore {
  #meta: PeerClientMeta | null = null;
  readonly #outbox = new Map<string, StoredOutboxEntry>();
  readonly #inbox = new Map<number, StoredInboxEntry>();
  readonly #inboxById = new Map<string, number>();
  readonly #gaps: StoredGapTombstone[] = [];

  async loadMeta(): Promise<PeerClientMeta | null> {
    return clone(this.#meta);
  }

  async saveMeta(meta: PeerClientMeta): Promise<void> {
    this.#meta = clone(meta);
  }

  async loadOutboxEntry(messageId: string): Promise<StoredOutboxEntry | null> {
    return clone(this.#outbox.get(messageId) ?? null);
  }

  async saveOutboxEntry(entry: StoredOutboxEntry): Promise<void> {
    this.#outbox.set(entry.messageId, clone(entry));
  }

  async listOutboxEntries(): Promise<readonly StoredOutboxEntry[]> {
    return clone([...this.#outbox.values()]);
  }

  async loadInboxEntry(position: number): Promise<StoredInboxEntry | null> {
    return clone(this.#inbox.get(position) ?? null);
  }

  async loadInboxEntryByMessageId(messageId: string): Promise<StoredInboxEntry | null> {
    const position = this.#inboxById.get(messageId);
    return position === undefined ? null : clone(this.#inbox.get(position) ?? null);
  }

  async saveInboxEntry(entry: StoredInboxEntry): Promise<void> {
    this.#inbox.set(entry.position, clone(entry));
    this.#inboxById.set(entry.messageId, entry.position);
  }

  async listInboxEntries(): Promise<readonly StoredInboxEntry[]> {
    return clone([...this.#inbox.values()].sort((left, right) => left.position - right.position));
  }

  async saveGapTombstone(gap: StoredGapTombstone): Promise<void> {
    const existing = this.#gaps.findIndex(
      (entry) => entry.fromSeq === gap.fromSeq && entry.toSeq === gap.toSeq && entry.cause === gap.cause
    );
    if (existing >= 0) {
      this.#gaps[existing] = clone(gap);
    } else {
      this.#gaps.push(clone(gap));
      this.#gaps.sort((left, right) => left.fromSeq - right.fromSeq);
    }
  }

  async findGapTombstone(fromSeq: number, toSeq: number): Promise<StoredGapTombstone | null> {
    const found = this.#gaps.find((entry) => entry.fromSeq === fromSeq && entry.toSeq === toSeq);
    return found ? clone(found) : null;
  }

  async listGapTombstones(): Promise<readonly StoredGapTombstone[]> {
    return clone([...this.#gaps]);
  }
}

export function createInMemoryPeerClientStore(): InMemoryPeerClientStore {
  return new InMemoryPeerClientStore();
}
