import crypto from "node:crypto";
import { PEER_ID_PATTERN } from "@meshrix/peer-crypto";

import { peerClientError } from "./errors.ts";

/**
 * Shared vocabulary for the device-side peer client.
 *
 * The client owns reliable delivery on top of `@meshrix/peer-crypto` sessions
 * and the private-relay online forwarding contract: immutable message ids,
 * and durable local outbox/inbox records.
 */

/** Store record shape version; every persisted document carries it. */
export const PEER_CLIENT_STORE_RECORD_VERSION = 2;

/**
 * Wire envelope profile stamped on outbound sends. The crypto layer's
 * bundles always carry a signed Kyber prekey, so the negotiation profile is
 * PQXDH; the constant stays injectable for a future X3DH-only deployment.
 */
export const PEER_CLIENT_WIRE_PROFILES = Object.freeze(["signal-x3dh", "signal-pqxdh"] as const);
export type PeerClientWireProfile = (typeof PEER_CLIENT_WIRE_PROFILES)[number];
export const PEER_CLIENT_DEFAULT_WIRE_PROFILE: PeerClientWireProfile = "signal-pqxdh";

/**
 * Maximum application plaintext that leaves room for worst-case initial
 * PQXDH/Signal serialization under the 65,536-byte relay ciphertext cap.
 * The crypto JSON envelope reserves 246 bytes for its fixed header; its
 * base64 body can therefore encode at most 48,967 ciphertext bytes. The
 * 32 KiB shared application ceiling leaves over 15 KiB for Signal/PQXDH
 * overhead. Runtime validation covers both fresh PQXDH and established
 * Signal messages without trial encryption or speculative ratchet advances.
 */
export const PEER_CLIENT_MAX_PLAINTEXT_BYTES = 32_768;

/** Default local history page size. Peer history is paged locally, never fetched from the relay. */
export const PEER_CLIENT_DEFAULT_PAGE_SIZE = 32;
/** Maximum concurrently unconfirmed data sends on one route; later sends remain durably queued FIFO. */
export const PEER_CLIENT_MAX_UNCONFIRMED_MESSAGES_PER_ROUTE = 16;
/** Bound for the same in-flight window; control ACKs bypass it. */
export const PEER_CLIENT_MAX_UNCONFIRMED_BYTES_PER_ROUTE = 1_048_576;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;

export function assertPeerClientOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw peerClientError("peer_client_state", `The ${field} field is not a valid opaque wire identifier.`);
  }
  return value;
}

export function assertPeerClientPeerId(value: unknown, field: string): string {
  if (typeof value !== "string" || !PEER_ID_PATTERN.test(value)) {
    throw peerClientError("peer_client_state", `The ${field} field is not a valid peer identifier.`);
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
