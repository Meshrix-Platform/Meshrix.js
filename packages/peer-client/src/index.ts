/**
 * `@meshrix/peer-client` — device-side durable peer messaging client.
 *
 * Composes the `@meshrix/peer-crypto` Signal session layer with the
 * private-relay online forwarding contract. Devices keep durable local
 * outbox and inbox state, retry the exact ciphertext, and settle delivery
 * only from a verified recipient-signed acknowledgement. The relay does not
 * retain business messages or application history.
 */

export {
  PEER_CLIENT_ERROR_CODES,
  isPeerClientError,
  peerClientError,
  type PeerClientError,
  type PeerClientErrorCode
} from "./errors.ts";

export type { PeerPresence } from "@meshrix/contracts/private-relay";

export {
  assertPeerClientOpaqueId,
  assertPeerClientPeerId,
  newPeerBundleId,
  newPeerMessageId,
  PEER_CLIENT_DEFAULT_PAGE_SIZE,
  PEER_CLIENT_DEFAULT_WIRE_PROFILE,
  PEER_CLIENT_MAX_UNCONFIRMED_BYTES_PER_ROUTE,
  PEER_CLIENT_MAX_UNCONFIRMED_MESSAGES_PER_ROUTE,
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
  PEER_INBOX_DISPATCH_STATES,
  PEER_OUTBOX_STATES,
  type PeerClientMeta,
  type PeerClientPage,
  type PeerClientPageQuery,
  type PeerClientRouteIdentity,
  type PeerClientRouteScope,
  type PeerClientStore,
  type PeerInboxDispatchState,
  type PeerLocalOrder,
  type PeerOutboxState,
  type StoredBundleObservation,
  type StoredInboxEntry,
  type StoredLocalBundle,
  type StoredOutboxEntry,
  type StoredPeerHistoryEntry
} from "./store.ts";

export {
  createFilePeerClientStore,
  FilePeerClientStore
} from "./file-store.ts";

export {
  staticPeerDirectory,
  peerIdentityPublicDescriptor,
  type PeerPairedSignalIdentity,
  type PeerClientTransport,
  type PeerDeviceDirectory
} from "./transport.ts";

export {
  PEER_APPLICATION_PROTOCOL_VERSION,
  assertPeerApplicationString,
  peerApplicationFragmentMessageId,
  newPeerApplicationDiscoveryId,
  newPeerApplicationOperationId,
  parsePeerApplicationAddress,
  peerApplicationDiscoveryKey,
  peerApplicationOperationKey,
  peerApplicationRequestDigest,
  peerApplicationTransportMessageId,
  reversePeerApplicationAddress,
  samePeerApplicationAddress,
  type AcpAgentSummary,
  type AcpPermissionOption,
  type AcpPermissionPrompt,
  type AcpPermissionResolution,
  type AcpStopReason,
  type PeerApplicationAddress,
  type PeerApplicationAgentDirectory,
  type PeerApplicationAgentExecutor,
  type PeerApplicationChange,
  type PeerApplicationDiscoveryRecovery,
  type PeerApplicationDiscoveryRecord,
  type PeerApplicationEngineOptions,
  type PeerApplicationFragment,
  type PeerApplicationFragmentSaveResult,
  type PeerApplicationHandoffPlan,
  type PeerApplicationPage,
  type PeerApplicationExecution,
  type PeerApplicationExecutionHandlers,
  type PeerApplicationExecutionResult,
  type PeerApplicationInbound,
  type PeerApplicationJournal,
  type PeerApplicationOperationStatus,
  type PeerApplicationPeerPort,
  type PeerApplicationOperationRecovery,
  type PeerApplicationPermissionRecord,
  type PeerApplicationProgress,
  type PeerApplicationProgressKind,
  type PeerApplicationRouteAuthority,
  type PeerApplicationRecord,
  type PeerApplicationResultPart,
  type PeerApplicationRole,
  type PeerApplicationSendState,
  type PeerApplicationSubmitInput
} from "./application.ts";

export { PeerApplicationEngine } from "./application-engine.ts";

export {
  PeerOutbox
} from "./outbox.ts";

export {
  PeerInbox,
  type PeerInboxLookup
} from "./inbox.ts";

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
