import type { PeerClientStore, StoredGapTombstone, StoredInboxEntry } from "./store.ts";
import { emptyPeerClientMeta } from "./store.ts";
import { PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

export type PeerInboxLookup =
  | { readonly status: "new" }
  | { readonly status: "duplicate"; readonly entry: StoredInboxEntry }
  | { readonly status: "positionConflict"; readonly entry: StoredInboxEntry };

/**
 * Durable deduplicated inbox.
 *
 * Dedup happens BEFORE work is exposed: a stored message whose
 * (messageId, position) pair is already recorded is acknowledged again but
 * never decrypted or dispatched a second time. The durable cursor
 * (`lastAckedSeq`) only advances after the page's entries are committed and
 * the peer-ack has been answered, so a restart re-fetches the uncommitted
 * tail and the idempotent dedup path makes that replay harmless.
 */
export class PeerInbox {
  readonly #store: PeerClientStore;

  constructor(store: PeerClientStore) {
    this.#store = store;
  }

  /**
   * Classify an incoming stored message against the dedup index.
   * `duplicate` — same messageId at the same position: skip decrypt+dispatch.
   * `positionConflict` — a different messageId already occupies the position:
   * a mailbox-level anomaly surfaced to the caller, still acked, never stored.
   */
  async lookup(messageId: string, position: number): Promise<PeerInboxLookup> {
    const atPosition = await this.#store.loadInboxEntry(position);
    if (atPosition) {
      return atPosition.messageId === messageId
        ? Object.freeze({ status: "duplicate" as const, entry: atPosition })
        : Object.freeze({ status: "positionConflict" as const, entry: atPosition });
    }
    const byId = await this.#store.loadInboxEntryByMessageId(messageId);
    if (byId) {
      // Same messageId at a different position — the mailbox never reassigns
      // ids, so this is evidence of either store corruption or a contract
      // violation; surface it as a position conflict rather than re-dispatch.
      return Object.freeze({ status: "positionConflict" as const, entry: byId });
    }
    return Object.freeze({ status: "new" as const });
  }

  /** Commit one received entry — the store-commit before any ack/cursor move. */
  async record(entry: StoredInboxEntry): Promise<void> {
    await this.#store.saveInboxEntry(entry);
  }

  async entry(position: number): Promise<StoredInboxEntry | null> {
    return this.#store.loadInboxEntry(position);
  }

  async byMessageId(messageId: string): Promise<StoredInboxEntry | null> {
    return this.#store.loadInboxEntryByMessageId(messageId);
  }

  async list(): Promise<readonly StoredInboxEntry[]> {
    return this.#store.listInboxEntries();
  }

  /** Entries committed but not yet dispatched to the host handler. */
  async pendingDispatch(): Promise<readonly StoredInboxEntry[]> {
    return (await this.list()).filter((entry) => entry.dispatch === "pending" && entry.plaintext !== null);
  }

  async markDispatch(messageId: string, dispatch: StoredInboxEntry["dispatch"]): Promise<StoredInboxEntry | null> {
    const entry = await this.#store.loadInboxEntryByMessageId(messageId);
    if (!entry) return null;
    const next = Object.freeze({ ...entry, dispatch });
    await this.#store.saveInboxEntry(next);
    return next;
  }

  /** Record that an application receipt kind was durably recorded by the mailbox. */
  async markReported(messageId: string, kind: string): Promise<StoredInboxEntry | null> {
    const entry = await this.#store.loadInboxEntryByMessageId(messageId);
    if (!entry || entry.reports.includes(kind)) return entry;
    const next = Object.freeze({ ...entry, reports: Object.freeze([...entry.reports, kind]) });
    await this.#store.saveInboxEntry(next);
    return next;
  }

  async cursor(): Promise<number> {
    return (await this.#store.loadMeta())?.cursor ?? 0;
  }

  /** Monotonic durable advance — never rewinds. */
  async commitCursor(nextAfterSeq: number): Promise<number> {
    const meta = await this.#store.loadMeta();
    const base = meta ?? emptyPeerClientMeta();
    const cursor = Math.max(base.cursor, nextAfterSeq);
    await this.#store.saveMeta(Object.freeze({ ...base, cursor }));
    return cursor;
  }

  async recordGap(gap: { readonly fromSeq: number; readonly toSeq: number; readonly cause: "expired" | "capacity_truncated"; readonly messageIds: readonly string[] | null }): Promise<{ readonly tombstone: StoredGapTombstone; readonly fresh: boolean }> {
    const existing = await this.#store.findGapTombstone(gap.fromSeq, gap.toSeq);
    if (existing && existing.cause === gap.cause) {
      return Object.freeze({ tombstone: existing, fresh: false });
    }
    const tombstone: StoredGapTombstone = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      cause: gap.cause,
      messageIds: gap.messageIds === null ? null : Object.freeze([...gap.messageIds]),
      observedAt: new Date().toISOString()
    });
    await this.#store.saveGapTombstone(tombstone);
    return Object.freeze({ tombstone, fresh: true });
  }

  async gaps(): Promise<readonly StoredGapTombstone[]> {
    return this.#store.listGapTombstones();
  }
}
