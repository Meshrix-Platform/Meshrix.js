import { PRIVATE_RELAY_PEER_SCHEMA_VERSION } from "@meshrix/contracts/private-relay";
import type {
  PeerClientTransport,
  PeerDeviceDirectory,
  StoredGapTombstone,
  StoredInboxEntry,
  StoredOutboxEntry
} from "@meshrix/peer-client";

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
export interface PeerRouteScope {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
}

/**
 * Deterministic crypto peer id for one relay device:
 * `peer:<tenantId>:<routeId>:<deviceId>`.
 *
 * The components are relay-admission opaque ids already; they are re-checked
 * against the peer-id charset so a malformed admission can never smuggle a
 * delimiter or overflow the bound. Returns null instead of throwing so the
 * caller maps the failure onto its own typed error surface.
 */
export function peerIdForRouteDevice(scope: PeerRouteScope): string | null {
  // Every segment must be a non-empty opaque id WITHOUT ':' — a colon inside
  // one component would make the joined derivation ambiguous (two distinct
  // routeId/deviceId pairs could collide onto one peer id), so peer
  // derivation refuses such relay identities instead of guessing.
  for (const segment of [scope.tenantId, scope.routeId, scope.deviceId]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(segment)) return null;
  }
  const peerId = `peer:${scope.tenantId}:${scope.routeId}:${scope.deviceId}`;
  // Assembled peer ids must satisfy the crypto layer's bound (<=128 chars).
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(peerId)) return null;
  return peerId;
}

/**
 * Pairing-layer directory over the shared derivation. The peer client
 * consults it before initiating a session, so a resumed store re-binds to
 * the same peer id without a bundle fetch.
 */
export function routePeerDirectory(route: Pick<PeerRouteScope, "tenantId" | "routeId">): PeerDeviceDirectory {
  return Object.freeze({
    resolvePeerId(peerDeviceId: string): string | null {
      return peerIdForRouteDevice({ tenantId: route.tenantId, routeId: route.routeId, deviceId: peerDeviceId });
    }
  });
}

/**
 * Demux predicate: true only for objects stamped with the peer mailbox
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
  readonly position: number | null;
  readonly attempts: number;
  readonly receipts: readonly unknown[];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function peerOutboxView(entry: StoredOutboxEntry): PeerOutboxView {
  return Object.freeze({
    messageId: entry.messageId,
    peerDeviceId: entry.peerDeviceId,
    peerId: entry.peerId,
    state: entry.state,
    position: entry.position,
    attempts: entry.attempts,
    receipts: entry.receipts,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  });
}

/** Inbox row — UTF-8-clean plaintext is surfaced as `text`, binary stays base64url. */
export interface PeerInboxView {
  readonly position: number;
  readonly senderDeviceId: string;
  readonly senderPeerId: string | null;
  readonly messageId: string;
  readonly dispatch: string;
  readonly decryptError: string | null;
  readonly reports: readonly string[];
  readonly receivedAt: string;
  readonly text: string | null;
  readonly plaintextBase64url: string | null;
}

/**
 * Retention-gap tombstone projection — a mailbox range the deployment lost
 * (expired / capacity-truncated). It is surfaced verbatim on operator
 * surfaces: a gap is evidence, never a silent skip.
 */
export interface PeerGapView {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly cause: "expired" | "capacity_truncated";
  readonly messageIds: readonly string[] | null;
  readonly observedAt: string;
}

export function peerGapView(tombstone: StoredGapTombstone): PeerGapView {
  return Object.freeze({
    fromSeq: tombstone.fromSeq,
    toSeq: tombstone.toSeq,
    cause: tombstone.cause,
    messageIds: tombstone.messageIds,
    observedAt: tombstone.observedAt
  });
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
    position: entry.position,
    senderDeviceId: entry.senderDeviceId,
    senderPeerId: entry.senderPeerId,
    messageId: entry.messageId,
    dispatch: entry.dispatch,
    decryptError: entry.decryptError,
    reports: entry.reports,
    receivedAt: entry.receivedAt,
    text,
    plaintextBase64url: entry.plaintext
  });
}
