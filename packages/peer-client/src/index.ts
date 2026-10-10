/**
 * `@meshrix/peer-client` — device-side durable peer messaging client
 * (DEC-PEER-ENCRYPTED-MAILBOX).
 *
 * Composes the `@meshrix/peer-crypto` Signal session layer and the
 * private-relay peer mailbox wire contract into a reliable delivery
 * surface: a sender-scoped durable outbox whose retries replay identical
 * envelope bytes (the mailbox's `duplicate` class is success; `conflict`
 * is terminal and surfaced), a deduplicated inbox with cursor resume and
 * honest gap tombstones, application receipts reported as independent
 * agent evidence — never derived from mailbox acks — and a host-neutral
 * dispatch surface with no agent execution authority.
 */

export {
  PEER_CLIENT_ERROR_CODES,
  isPeerClientError,
  peerClientError,
  type PeerClientError,
  type PeerClientErrorCode
} from "./errors.ts";

export {
  assertPeerClientOpaqueId,
  newPeerBundleId,
  newPeerMessageId,
  PEER_CLIENT_DEFAULT_MAX_SEND_ATTEMPTS,
  PEER_CLIENT_DEFAULT_PAGE_SIZE,
  PEER_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS,
  PEER_CLIENT_DEFAULT_WIRE_PROFILE,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES,
  PEER_CLIENT_STORE_RECORD_VERSION,
  PEER_CLIENT_WIRE_PROFILES,
  type PeerClientWireProfile
} from "./types.ts";

export {
  createInMemoryPeerClientStore,
  emptyPeerClientMeta,
  InMemoryPeerClientStore,
  peerOutboxStateIsTerminal,
  peerOutboxStateOrder,
  PEER_INBOX_DISPATCH_STATES,
  PEER_OUTBOX_STATES,
  PEER_OUTBOX_TERMINAL_STATES,
  type PeerClientMeta,
  type PeerClientStore,
  type PeerInboxDispatchState,
  type PeerOutboxState,
  type StoredBundleObservation,
  type StoredGapTombstone,
  type StoredInboxEntry,
  type StoredLocalBundle,
  type StoredOutboxEntry
} from "./store.ts";

export {
  createFilePeerClientStore,
  FilePeerClientStore
} from "./file-store.ts";

export {
  staticPeerDirectory,
  type PeerClientTransport,
  type PeerDeviceDirectory
} from "./transport.ts";

export {
  PeerOutbox
} from "./outbox.ts";

export {
  PeerInbox,
  type PeerInboxLookup
} from "./inbox.ts";

export {
  ReceiptReconciler,
  type ReceiptReconcilerOptions,
  type ReconcilerTransition
} from "./reconciler.ts";

export {
  PeerClient,
  PEER_INBOUND_OUTCOME_KINDS,
  type PeerClientEvents,
  type PeerClientOptions,
  type PeerDispatchHandler,
  type PeerDispatchSurface,
  type PeerInboundMessage,
  type PeerInboundOutcome,
  type PeerInboundOutcomeKind,
  type PeerRouteIdentity
} from "./client.ts";
