import crypto from "node:crypto";

import { peerClientError } from "./errors.ts";

/**
 * Shared vocabulary for the device-side peer client.
 *
 * The client owns reliable delivery on top of `@meshrix/peer-crypto` sessions
 * and the private-relay peer mailbox wire contract: sender-scoped message
 * ids, outbox/inbox durability bounds and the request timeout the admitted
 * session channel is given to answer each of the 13 wire kinds.
 */

/** Store record shape version; every persisted document carries it. */
export const PEER_CLIENT_STORE_RECORD_VERSION = 1;

/**
 * Wire envelope profile stamped on outbound sends. The crypto layer's
 * bundles always carry a signed Kyber prekey, so the negotiation profile is
 * PQXDH; the constant stays injectable for a future X3DH-only deployment.
 */
export const PEER_CLIENT_WIRE_PROFILES = Object.freeze(["signal-x3dh", "signal-pqxdh"] as const);
export type PeerClientWireProfile = (typeof PEER_CLIENT_WIRE_PROFILES)[number];
export const PEER_CLIENT_DEFAULT_WIRE_PROFILE: PeerClientWireProfile = "signal-pqxdh";

/**
 * Plaintext bound for one peer message. The wire envelope caps at 64 KiB;
 * the crypto envelope inside adds JSON + base64 framing and the first
 * (prekey) ciphertext adds X3DH/PQXDH key material, so the client bound is
 * deliberately smaller than either wire or crypto maximum.
 */
export const PEER_CLIENT_MAX_PLAINTEXT_BYTES = 49_152;

/** Default peer-fetch page size; the wire hard bound is 64 per page. */
export const PEER_CLIENT_DEFAULT_PAGE_SIZE = 32;
/** How long one wire request may wait for its typed response before it is treated as dropped. */
export const PEER_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Send-attempt bound before an unanswered, never-recorded send is surfaced
 * as `unrecorded` — the mailbox drops sends for unpaired/revoked senders
 * without a response, so reconciliation plus this bound is the honest check.
 */
export const PEER_CLIENT_DEFAULT_MAX_SEND_ATTEMPTS = 4;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;

export function assertPeerClientOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw peerClientError("peer_client_state", `The ${field} field is not a valid opaque wire identifier.`);
  }
  return value;
}

/** Sender-scoped message id — uuid-shaped, unique per sender, wire-charset safe. */
export function newPeerMessageId(): string {
  return `msg.${crypto.randomUUID()}`;
}

/** Local bundle record id — allocated once per store, stamped on outbound wire headers. */
export function newPeerBundleId(): string {
  return `bundle.${crypto.randomUUID()}`;
}
