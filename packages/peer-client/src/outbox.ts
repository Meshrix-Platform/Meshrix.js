import type { PeerDeliveryAck, PeerEnvelope, PeerForwarded, PeerMessageIdentity } from "@meshrix/contracts/private-relay";

import { peerClientError } from "./errors.ts";
import type { PeerClientPage, PeerClientRouteScope, PeerClientStore, StoredOutboxEntry } from "./store.ts";
import { assertPeerClientOpaqueId, assertPeerClientPeerId, PEER_CLIENT_DEFAULT_PAGE_SIZE, PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * Durable sender-owned ciphertext. Relay outcomes are attempt observations;
 * only a recipient-signed delivery ACK settles an outbox entry.
 */
export class PeerOutbox {
  readonly #store: PeerClientStore;
  readonly #scope: PeerClientRouteScope;
  readonly #senderDeviceId: string;

  constructor(store: PeerClientStore, route: { readonly tenantId: string; readonly routeId: string; readonly deviceId: string }) {
    this.#store = store;
    this.#scope = Object.freeze({ tenantId: route.tenantId, routeId: route.routeId });
    this.#senderDeviceId = route.deviceId;
  }

  identity(messageId: string, recipientDeviceId: string): PeerMessageIdentity {
    return Object.freeze({
      tenantId: this.#scope.tenantId,
      routeId: this.#scope.routeId,
      senderDeviceId: this.#senderDeviceId,
      recipientDeviceId: assertPeerClientOpaqueId(recipientDeviceId, "recipientDeviceId"),
      messageId: assertPeerClientOpaqueId(messageId, "messageId")
    });
  }

  async entry(messageId: string, recipientDeviceId: string): Promise<StoredOutboxEntry | null> {
    return this.#store.loadOutboxEntry(this.identity(messageId, recipientDeviceId));
  }

  async entryForIdentity(identity: PeerMessageIdentity): Promise<StoredOutboxEntry | null> {
    return this.#store.loadOutboxEntry(identity);
  }

  async pendingPage(afterSequence = 0, limit = PEER_CLIENT_DEFAULT_PAGE_SIZE): Promise<PeerClientPage<StoredOutboxEntry>> {
    return this.#store.listPendingOutboxPage(this.#scope, { afterSequence, limit });
  }

  async historyPage(afterSequence = 0, limit = PEER_CLIENT_DEFAULT_PAGE_SIZE): Promise<PeerClientPage<StoredOutboxEntry>> {
    return this.#store.listOutboxHistoryPage(this.#scope, { afterSequence, limit });
  }

  async enqueue(input: {
    readonly recipientDeviceId: string;
    readonly messageId: string;
    readonly peerId: string;
    readonly envelope: PeerEnvelope;
    readonly sequence?: number;
  }): Promise<StoredOutboxEntry> {
    const identity = this.identity(input.messageId, input.recipientDeviceId);
    const existing = await this.#store.loadOutboxEntry(identity);
    if (existing) {
      if (JSON.stringify(existing.envelope) === JSON.stringify(input.envelope)) return existing;
      throw peerClientError("peer_client_conflict", `Message ${identity.messageId} already has different ciphertext in the durable outbox.`);
    }
    const entry = await this.createEntry(input);
    await this.saveEntry(entry);
    return entry;
  }

  async createEntry(input: {
    readonly recipientDeviceId: string;
    readonly messageId: string;
    readonly peerId: string;
    readonly envelope: PeerEnvelope;
    readonly sequence?: number;
  }): Promise<StoredOutboxEntry> {
    const identity = this.identity(input.messageId, input.recipientDeviceId);
    const now = new Date().toISOString();
    const sequence = input.sequence ?? await this.#store.allocateOutboxSequence(this.#scope);
    return Object.freeze({
      ...identity,
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence,
      peerId: assertPeerClientPeerId(input.peerId, "peerId"),
      state: "pending",
      envelope: input.envelope,
      attempts: 0,
      lastForwarded: null,
      deliveryAck: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    });
  }

  async saveEntry(entry: StoredOutboxEntry): Promise<void> {
    const identity = this.identity(entry.messageId, entry.recipientDeviceId);
    const existing = await this.#store.loadOutboxEntry(identity);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) return;
      throw peerClientError("peer_client_conflict", `Message ${identity.messageId} already has a different durable outbox record.`);
    }
    await this.#store.saveOutboxEntry(entry);
  }

  async markAttempt(identity: PeerMessageIdentity, lastError: string | null = null): Promise<StoredOutboxEntry | null> {
    return this.#update(identity, (entry) => Object.freeze({
      ...entry,
      attempts: entry.attempts + 1,
      lastError,
      updatedAt: new Date().toISOString()
    }));
  }

  async noteForwarded(identity: PeerMessageIdentity, forwarded: PeerForwarded): Promise<StoredOutboxEntry | null> {
    return this.#update(identity, (entry) => {
      if (entry.state !== "pending") return entry;
      if (JSON.stringify(entry.lastForwarded) === JSON.stringify(forwarded)) return entry;
      return Object.freeze({ ...entry, lastForwarded: forwarded, updatedAt: new Date().toISOString() });
    });
  }

  async applyDeliveryAck(identity: PeerMessageIdentity, ack: PeerDeliveryAck): Promise<StoredOutboxEntry | null> {
    return this.#update(identity, (entry) => {
      if (entry.state === "delivered") {
        if (JSON.stringify(entry.deliveryAck) !== JSON.stringify(ack)) {
          throw peerClientError("peer_client_conflict", "A delivered outbox identity received a different signed delivery ACK.");
        }
        return entry;
      }
      if (entry.state === "conflict") return entry;
      return Object.freeze({
        ...entry,
        state: "delivered",
        deliveryAck: ack,
        lastError: null,
        updatedAt: new Date().toISOString()
      });
    });
  }

  async markConflict(identity: PeerMessageIdentity, detail: string): Promise<StoredOutboxEntry | null> {
    return this.#update(identity, (entry) => entry.state === "conflict"
      ? entry
      : Object.freeze({ ...entry, state: "conflict", lastError: detail, updatedAt: new Date().toISOString() }));
  }

  async #update(identity: PeerMessageIdentity, mutate: (entry: StoredOutboxEntry) => StoredOutboxEntry): Promise<StoredOutboxEntry | null> {
    const existing = await this.#store.loadOutboxEntry(identity);
    if (!existing) return null;
    const next = mutate(existing);
    if (next !== existing) await this.#store.saveOutboxEntry(next);
    return next;
  }
}
