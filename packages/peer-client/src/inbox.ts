import type { PeerDeliveryAck, PeerEnvelope, PeerMessageIdentity } from "@meshrix/contracts/private-relay";

import { peerClientError } from "./errors.ts";
import type { PeerClientPage, PeerClientRouteScope, PeerClientStore, StoredInboxEntry } from "./store.ts";
import { assertPeerClientOpaqueId, PEER_CLIENT_DEFAULT_PAGE_SIZE, PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

export type PeerInboxLookup =
  | { readonly status: "new" }
  | { readonly status: "duplicate"; readonly entry: StoredInboxEntry }
  | { readonly status: "conflict"; readonly entry: StoredInboxEntry };

/** Local durable inbox keyed by the complete sender/recipient/message tuple. */
export class PeerInbox {
  readonly #store: PeerClientStore;
  readonly #scope: PeerClientRouteScope;
  readonly #recipientDeviceId: string;

  constructor(store: PeerClientStore, route: { readonly tenantId: string; readonly routeId: string; readonly deviceId: string }) {
    this.#store = store;
    this.#scope = Object.freeze({ tenantId: route.tenantId, routeId: route.routeId });
    this.#recipientDeviceId = route.deviceId;
  }

  identity(messageId: string, senderDeviceId: string): PeerMessageIdentity {
    return Object.freeze({
      tenantId: this.#scope.tenantId,
      routeId: this.#scope.routeId,
      senderDeviceId: assertPeerClientOpaqueId(senderDeviceId, "senderDeviceId"),
      recipientDeviceId: this.#recipientDeviceId,
      messageId: assertPeerClientOpaqueId(messageId, "messageId")
    });
  }

  async lookup(identity: PeerMessageIdentity, envelope: PeerEnvelope): Promise<PeerInboxLookup> {
    const existing = await this.#store.loadInboxEntry(identity);
    if (!existing) return Object.freeze({ status: "new" });
    return JSON.stringify(existing.envelope) === JSON.stringify(envelope)
      ? Object.freeze({ status: "duplicate", entry: existing })
      : Object.freeze({ status: "conflict", entry: existing });
  }

  async entry(identity: PeerMessageIdentity): Promise<StoredInboxEntry | null> {
    return this.#store.loadInboxEntry(identity);
  }

  async record(entry: StoredInboxEntry): Promise<void> {
    const existing = await this.#store.loadInboxEntry(entry);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) return;
      throw peerClientError("peer_client_conflict", "A durable inbox tuple already contains different message data.");
    }
    await this.#store.saveInboxEntry(entry);
  }

  async saveEntry(entry: StoredInboxEntry): Promise<void> {
    const existing = await this.#store.loadInboxEntry(entry);
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return;
    await this.#store.saveInboxEntry(entry);
  }

  async pendingDispatchPage(afterSequence = 0, limit = PEER_CLIENT_DEFAULT_PAGE_SIZE): Promise<PeerClientPage<StoredInboxEntry>> {
    const page = await this.#store.listPendingInboxPage(this.#scope, { afterSequence, limit });
    return Object.freeze({ ...page, items: Object.freeze(page.items.filter((entry) => entry.plaintext !== null)) });
  }

  pendingDeliveryAckPage(afterSequence = 0, limit = PEER_CLIENT_DEFAULT_PAGE_SIZE): Promise<PeerClientPage<StoredInboxEntry>> {
    return this.#store.listPendingDeliveryAckPage(this.#scope, { afterSequence, limit });
  }

  async historyPage(afterSequence = 0, limit = PEER_CLIENT_DEFAULT_PAGE_SIZE): Promise<PeerClientPage<StoredInboxEntry>> {
    return this.#store.listInboxHistoryPage(this.#scope, { afterSequence, limit });
  }

  async markDispatch(identity: PeerMessageIdentity, dispatch: StoredInboxEntry["dispatch"]): Promise<StoredInboxEntry | null> {
    const entry = await this.#store.loadInboxEntry(identity);
    if (!entry || entry.dispatch === dispatch) return entry;
    const next = Object.freeze({ ...entry, dispatch, updatedAt: new Date().toISOString() });
    await this.#store.saveInboxEntry(next);
    return next;
  }

  async markDeliveryAck(identity: PeerMessageIdentity, ack: PeerDeliveryAck): Promise<StoredInboxEntry | null> {
    const entry = await this.#store.loadInboxEntry(identity);
    if (!entry) return null;
    if (entry.deliveryAck !== null) {
      if (JSON.stringify(entry.deliveryAck) !== JSON.stringify(ack)) {
        throw peerClientError("peer_client_conflict", "A durable inbox tuple already has a different signed ACK.");
      }
      return entry;
    }
    const next = Object.freeze({ ...entry, deliveryAck: ack, updatedAt: new Date().toISOString() });
    await this.#store.saveInboxEntry(next);
    return next;
  }

  createEntry(input: {
    readonly identity: PeerMessageIdentity;
    readonly sequence: number;
    readonly senderPeerId: string | null;
    readonly envelope: PeerEnvelope;
    readonly plaintext: string | null;
    readonly decryptError: string | null;
    readonly dispatch: StoredInboxEntry["dispatch"];
    readonly deliveryAck: PeerDeliveryAck | null;
  }): StoredInboxEntry {
    const now = new Date().toISOString();
    return Object.freeze({
      ...input.identity,
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence: input.sequence,
      senderPeerId: input.senderPeerId,
      envelope: input.envelope,
      plaintext: input.plaintext,
      decryptError: input.decryptError,
      dispatch: input.dispatch,
      deliveryAck: input.deliveryAck,
      receivedAt: now,
      updatedAt: now
    });
  }
}
