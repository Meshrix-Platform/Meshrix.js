import { PRIVATE_RELAY_PEER_SCHEMA_VERSION } from "@meshrix/contracts/private-relay";
import { peerIdForRouteDevice } from "@meshrix/contracts/private-relay/peer";
import type { PeerDeliveryAck, PeerForwarded } from "@meshrix/contracts/private-relay";
import type { PeerClientTransport, StoredInboxEntry, StoredOutboxEntry } from "@meshrix/peer-client";

/**
 * Peer-messaging channel plumbing shared by the entry product and the
 * private-endpoint profile.
 *
 * The peer stack (`@meshrix/peer-client`) travels as request/response wire
 * kinds on the SAME authenticated admitted forward session that already
 * carries frames and recovery control — never a second connection. This
 * module owns the two pieces both products must agree on bit-for-bit:
 *
 *  - `peerIdForRouteDevice` — the derivation binding a crypto peer id to the
 *    relay-authenticated route identity. Two devices on one route derive the
 *    same peer id for each other, which is what makes pinned-identity safety
 *    numbers computable out of band without trusting wire-delivered ids.
 *  - `isPeerSchemaMessage` — the demux predicate: peer-schema objects bypass
 *    the session driver (which owns session/frame/recovery kinds) and land
 *    on `PeerClient.handleInboundMessage` instead.
 *
 * `createPeerSessionChannel` adapts a raw session `send` into the
 * `PeerClientTransport` port with an admission gate: peer requests thrown
 * while the session is down fail immediately with `peer_channel_not_admitted`
 * instead of dying silently inside a transport queue.
 */

/** Relay route identity the peer id derivation is bound to. */
export type { PeerRouteIdentityTuple as PeerRouteScope } from "@meshrix/contracts/private-relay/peer";
export { peerIdForRouteDevice };

/**
 * Demux predicate: true only for objects stamped with the Peer
 * schema. Session drivers ignore these kinds; this is how the product routes
 * them to the peer client without the session layer ever interpreting them.
 */
export function isPeerSchemaMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && (message as { schemaVersion?: unknown }).schemaVersion === PRIVATE_RELAY_PEER_SCHEMA_VERSION;
}

/** Error thrown when a peer request is offered while the session is down. */
export function peerChannelNotAdmittedError(): Error & { code: string } {
  return Object.assign(
    new Error("The relay session is not admitted; peer messages cannot be carried until it is live."),
    { code: "peer_channel_not_admitted" }
  );
}

/**
 * Adapt a session transport's `send` into the `PeerClientTransport` port.
 *
 * `send` reaches the wire only while `admitted()` reports the session is
 * live; otherwise the request fails fast — the peer client's in-flight slot
 * must never wait on a channel that cannot answer. The inbound side is NOT
 * attached here: products demux inbound messages themselves (peer schema →
 * `PeerClient.handleInboundMessage`, everything else → the session driver),
 * so this adapter is deliberately send-only.
 */
export function createPeerSessionChannel(input: {
  readonly send: (message: Record<string, unknown>) => void;
  readonly admitted: () => boolean;
}): PeerClientTransport {
  return Object.freeze({
    send(message: Record<string, unknown>): void {
      if (!input.admitted()) throw peerChannelNotAdmittedError();
      input.send(message);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Operator-surface projections — identical on entry and endpoint       */
/* ------------------------------------------------------------------ */

/** Outbox row for a trusted local operator surface (envelope stays in the store). */
export interface PeerOutboxView {
  readonly messageId: string;
  readonly peerDeviceId: string;
  readonly peerId: string;
  readonly state: string;
  readonly sequence: number;
  readonly attempts: number;
  readonly lastForwarded: PeerForwarded | null;
  readonly deliveryAck: PeerDeliveryAck | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function peerOutboxView(entry: StoredOutboxEntry): PeerOutboxView {
  return Object.freeze({
    messageId: entry.messageId,
    peerDeviceId: entry.recipientDeviceId,
    peerId: entry.peerId,
    state: entry.state,
    sequence: entry.sequence,
    attempts: entry.attempts,
    lastForwarded: entry.lastForwarded,
    deliveryAck: entry.deliveryAck,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  });
}

/** Inbox row — UTF-8-clean plaintext is surfaced as `text`, binary stays base64url. */
export interface PeerInboxView {
  readonly sequence: number;
  readonly senderDeviceId: string;
  readonly senderPeerId: string | null;
  readonly messageId: string;
  readonly dispatch: string;
  readonly transportReceived: boolean;
  readonly decryptError: string | null;
  readonly receivedAt: string;
  readonly text: string | null;
  readonly plaintextBase64url: string | null;
}

export function peerInboxView(entry: StoredInboxEntry): PeerInboxView {
  let text: string | null = null;
  if (entry.plaintext !== null) {
    try {
      const decoded = Buffer.from(entry.plaintext, "base64url").toString("utf8");
      // Re-encode to prove the payload was clean UTF-8 — binary stays base64url only.
      if (Buffer.from(decoded, "utf8").toString("base64url") === entry.plaintext) text = decoded;
    } catch { /* binary payload — text stays null */ }
  }
  return Object.freeze({
    sequence: entry.sequence,
    senderDeviceId: entry.senderDeviceId,
    senderPeerId: entry.senderPeerId,
    messageId: entry.messageId,
    dispatch: entry.dispatch,
    transportReceived: entry.deliveryAck !== null,
    decryptError: entry.decryptError,
    receivedAt: entry.receivedAt,
    text,
    plaintextBase64url: entry.plaintext
  });
}
