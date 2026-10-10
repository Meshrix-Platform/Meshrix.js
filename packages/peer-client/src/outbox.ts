import type { PeerEnvelope, PeerReceipt } from "@meshrix/contracts/private-relay";

import { peerClientError } from "./errors.ts";
import type {
  PeerClientStore,
  PeerOutboxState,
  StoredOutboxEntry
} from "./store.ts";
import { peerOutboxStateIsTerminal, peerOutboxStateOrder } from "./store.ts";
import { assertPeerClientOpaqueId, PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * Durable sender-scoped outbox.
 *
 * Entries persist before the first wire attempt and carry the exact wire
 * envelope bytes, so a retry after a lost `peer-accepted` reply or a
 * reconnect replays byte-identical scope+content — the mailbox answers
 * `duplicate` (success) rather than `conflict`. States move only forward:
 * pending → accepted(position) → received → agent-terminal
 * (accepted_by_agent / completed / rejected); `conflict` and `unrecorded`
 * are terminal honest failures that are surfaced, never retried.
 */
export class PeerOutbox {
  readonly #store: PeerClientStore;

  constructor(store: PeerClientStore) {
    this.#store = store;
  }

  async entry(messageId: string): Promise<StoredOutboxEntry | null> {
    return this.#store.loadOutboxEntry(messageId);
  }

  async list(): Promise<readonly StoredOutboxEntry[]> {
    return this.#store.listOutboxEntries();
  }

  /** Entries awaiting a first (or retry) send — the reconnect retry set. */
  async pending(): Promise<readonly StoredOutboxEntry[]> {
    return (await this.list()).filter((entry) => entry.state === "pending");
  }

  /** Every non-terminal entry — the receipt-reconciliation query set. */
  async unreconciled(): Promise<readonly StoredOutboxEntry[]> {
    return (await this.list()).filter((entry) => !peerOutboxStateIsTerminal(entry.state));
  }

  /**
   * Persist a new pending entry. Re-enqueueing the same messageId with the
   * same envelope bytes is idempotent (returns the stored entry); the same
   * messageId with different envelope bytes refuses loudly — that reuse is
   * exactly the wire's conflict class and must never be smuggled through.
   */
  async enqueue(input: {
    readonly messageId: string;
    readonly peerDeviceId: string;
    readonly peerId: string;
    readonly envelope: PeerEnvelope;
  }): Promise<StoredOutboxEntry> {
    const messageId = assertPeerClientOpaqueId(input.messageId, "messageId");
    const existing = await this.#store.loadOutboxEntry(messageId);
    if (existing) {
      if (JSON.stringify(existing.envelope) === JSON.stringify(input.envelope)) return existing;
      throw peerClientError(
        "peer_client_conflict",
        `Message ${messageId} already exists in the outbox with different envelope bytes; sender-scoped ids are single-use.`
      );
    }
    const now = new Date().toISOString();
    const entry: StoredOutboxEntry = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      messageId,
      peerDeviceId: assertPeerClientOpaqueId(input.peerDeviceId, "peerDeviceId"),
      peerId: assertPeerClientOpaqueId(input.peerId, "peerId"),
      state: "pending",
      position: null,
      envelope: input.envelope,
      attempts: 0,
      receipts: Object.freeze([]),
      lastError: null,
      createdAt: now,
      updatedAt: now
    });
    await this.#store.saveOutboxEntry(entry);
    return entry;
  }

  async markAttempt(messageId: string, lastError: string | null = null): Promise<StoredOutboxEntry | null> {
    return this.#update(messageId, (entry) => Object.freeze({
      ...entry,
      attempts: entry.attempts + 1,
      lastError,
      updatedAt: new Date().toISOString()
    }));
  }

  async noteError(messageId: string, lastError: string): Promise<StoredOutboxEntry | null> {
    return this.#update(messageId, (entry) => Object.freeze({
      ...entry,
      lastError,
      updatedAt: new Date().toISOString()
    }));
  }

  /**
   * The mailbox's accepted/duplicate outcome: durable position plus the
   * mailbox-issued accepted receipt. `duplicate` replays the original
   * position — it is the success answer for an honest retry, so the stored
   * position is asserted to match rather than silently moved.
   */
  async markAccepted(messageId: string, position: number, receipt: PeerReceipt | null): Promise<StoredOutboxEntry | null> {
    return this.#update(messageId, (entry) => {
      if (peerOutboxStateIsTerminal(entry.state)) return entry;
      if (entry.position !== null && entry.position !== position) {
        return Object.freeze({
          ...entry,
          lastError: `position_mismatch: stored ${entry.position}, mailbox reported ${position}`,
          updatedAt: new Date().toISOString()
        });
      }
      const receipts = receipt && !entry.receipts.some((seen) => seen.kind === receipt.kind && seen.position === receipt.position)
        ? Object.freeze([...entry.receipts, receipt])
        : entry.receipts;
      return Object.freeze({
        ...entry,
        // Forward-only: a duplicate accepted landing after `received` must not regress.
        state: peerOutboxStateOrder("accepted") > peerOutboxStateOrder(entry.state) ? "accepted" as const : entry.state,
        position,
        receipts,
        lastError: null,
        updatedAt: new Date().toISOString()
      });
    });
  }

  /**
   * Advance the entry along the receipt taxonomy. Mailbox `accepted` arms
   * the position, recipient `received` moves to received, and agent kinds
   * terminate. Application receipts are independent reports — this never
   * derives them from acks. A receipt claiming a different position than
   * the recorded one is noted honestly, not applied.
   */
  async applyReceipt(receipt: PeerReceipt): Promise<StoredOutboxEntry | null> {
    return this.#update(receipt.messageId, (entry) => {
      if (peerOutboxStateIsTerminal(entry.state)) return entry;
      if (entry.position !== null && receipt.position !== entry.position) {
        return Object.freeze({
          ...entry,
          lastError: `position_mismatch: stored ${entry.position}, receipt ${receipt.kind} reported ${receipt.position}`,
          updatedAt: new Date().toISOString()
        });
      }
      const receipts = entry.receipts.some((seen) => seen.kind === receipt.kind && seen.position === receipt.position)
        ? entry.receipts
        : Object.freeze([...entry.receipts, receipt]);
      const candidate: PeerOutboxState = receipt.kind === "accepted" ? "accepted"
        : receipt.kind === "received" ? "received"
          : receipt.kind as PeerOutboxState; // parser-validated application kinds map 1:1 to agent states
      return Object.freeze({
        ...entry,
        // Forward-only: later receipts stay evidence without moving the state back.
        state: peerOutboxStateOrder(candidate) > peerOutboxStateOrder(entry.state) ? candidate : entry.state,
        position: entry.position ?? (receipt.position > 0 ? receipt.position : null),
        receipts,
        updatedAt: new Date().toISOString()
      });
    });
  }

  /** Terminal: sender-scope conflict — surfaced, never retried. */
  async markConflict(messageId: string): Promise<StoredOutboxEntry | null> {
    return this.#update(messageId, (entry) => peerOutboxStateIsTerminal(entry.state)
      ? entry
      : Object.freeze({ ...entry, state: "conflict" as const, updatedAt: new Date().toISOString() }));
  }

  /** Terminal: provably never recorded by the mailbox past the retry bound. */
  async markUnrecorded(messageId: string): Promise<StoredOutboxEntry | null> {
    return this.#update(messageId, (entry) => peerOutboxStateIsTerminal(entry.state)
      ? entry
      : Object.freeze({ ...entry, state: "unrecorded" as const, updatedAt: new Date().toISOString() }));
  }

  async #update(messageId: string, mutate: (entry: StoredOutboxEntry) => StoredOutboxEntry): Promise<StoredOutboxEntry | null> {
    const existing = await this.#store.loadOutboxEntry(messageId);
    if (!existing) return null;
    const next = mutate(existing);
    if (next !== existing) await this.#store.saveOutboxEntry(next);
    return next;
  }
}
