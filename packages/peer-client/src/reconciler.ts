import {
  createPeerReceiptQuery,
  parsePeerStatus,
  PRIVATE_RELAY_PEER_LIMITS
} from "@meshrix/contracts/private-relay";
import type { PeerReceipt } from "@meshrix/contracts/private-relay";

import { peerClientError } from "./errors.ts";
import type { PeerOutbox } from "./outbox.ts";
import type { StoredOutboxEntry } from "./store.ts";

export interface PeerRouteIdentity {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
}

export interface ReconcilerTransition {
  readonly entry: StoredOutboxEntry;
  readonly previousState: StoredOutboxEntry["state"];
}

export interface ReceiptReconcilerOptions {
  readonly route: PeerRouteIdentity;
  readonly outbox: PeerOutbox;
  /** Sends one wire request and resolves with the typed response object, or null when dropped/timed out. */
  readonly request: (message: Record<string, unknown>, expectKind: string) => Promise<Record<string, unknown> | null>;
  /** Attempt bound after which a never-recorded send is honestly `unrecorded`. */
  readonly maxSendAttempts: number;
  /** Observes each applied status transition (sendState/conflict/unrecorded projection is the caller's). */
  readonly onTransition?: (transition: ReconcilerTransition) => void;
}

/**
 * Receipt reconciler — the answer to a lost `peer-accepted` reply.
 *
 * `peer-accepted` can be dropped after the mailbox durably stored the send;
 * the sender-side truth then lives in the recipient partition's idempotency
 * binding and receipt records, reachable through `peer-receipt` →
 * `peer-status`. Reconciliation pulls statuses for every unreconciled
 * outbox id: a recorded position plus receipts advances the entry exactly
 * as the lost response would have, a still-zero position past the send
 * bound surfaces `unrecorded` — never a fabricated acceptance.
 */
export class ReceiptReconciler {
  readonly #options: ReceiptReconcilerOptions;

  constructor(options: ReceiptReconcilerOptions) {
    this.#options = options;
  }

  /**
   * Pull statuses for the given message ids (default: every non-terminal
   * outbox entry). Returns the entries whose state moved.
   */
  async reconcile(messageIds?: readonly string[]): Promise<readonly ReconcilerTransition[]> {
    const ids = messageIds ?? (await this.#options.outbox.unreconciled()).map((entry) => entry.messageId);
    const transitions: ReconcilerTransition[] = [];
    for (let offset = 0; offset < ids.length; offset += PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries) {
      const chunk = ids.slice(offset, offset + PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries);
      const moved = await this.#reconcileChunk(chunk);
      transitions.push(...moved);
    }
    return Object.freeze(transitions);
  }

  /** Apply an already-received peer-status document (e.g. an opportunistic push). */
  async applyStatusDocument(document: unknown): Promise<readonly ReconcilerTransition[]> {
    const parsed = parsePeerStatus(document);
    if (!parsed || parsed.deviceId !== this.#options.route.deviceId) return Object.freeze([]);
    return this.#applyStatuses(parsed.statuses);
  }

  async #reconcileChunk(ids: readonly string[]): Promise<readonly ReconcilerTransition[]> {
    if (ids.length === 0) return Object.freeze([]);
    const { route } = this.#options;
    const response = await this.#options.request(createPeerReceiptQuery({
      tenantId: route.tenantId,
      routeId: route.routeId,
      deviceId: route.deviceId,
      messageIds: [...ids]
    }), "peer-status");
    if (response === null) return Object.freeze([]);
    const parsed = parsePeerStatus(response);
    if (!parsed || parsed.deviceId !== route.deviceId) {
      throw peerClientError("peer_client_transport", "The peer-status response is malformed or out of scope.");
    }
    return this.#applyStatuses(parsed.statuses);
  }

  async #applyStatuses(statuses: readonly { readonly messageId: string; readonly position: number; readonly receipts: readonly PeerReceipt[] }[]): Promise<readonly ReconcilerTransition[]> {
    const transitions: ReconcilerTransition[] = [];
    const note = (entry: StoredOutboxEntry | null, previousState: StoredOutboxEntry["state"]): void => {
      if (entry && entry.state !== previousState) {
        const transition = Object.freeze({ entry, previousState });
        transitions.push(transition);
        this.#options.onTransition?.(transition);
      }
    };
    for (const status of statuses) {
      const before = await this.#options.outbox.entry(status.messageId);
      if (!before) continue;
      if (status.position === 0) {
        // Provably not recorded: only the attempt bound separates a slow
        // mailbox from a dropped (unpaired/revoked) send.
        if (before.state === "pending" && before.attempts >= this.#options.maxSendAttempts) {
          note(await this.#options.outbox.markUnrecorded(status.messageId), before.state);
        }
        continue;
      }
      if (before.state === "pending" || before.state === "accepted") {
        const accepted = status.receipts.find((receipt) => receipt.kind === "accepted") ?? null;
        note(await this.#options.outbox.markAccepted(status.messageId, status.position, accepted), before.state);
      }
      for (const receipt of status.receipts) {
        if (receipt.kind === "accepted") continue;
        const prior = await this.#options.outbox.entry(status.messageId);
        note(await this.#options.outbox.applyReceipt(receipt), prior?.state ?? before.state);
      }
    }
    return Object.freeze(transitions);
  }
}
