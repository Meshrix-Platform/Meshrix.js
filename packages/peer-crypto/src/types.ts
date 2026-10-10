import { Buffer } from "node:buffer";

import { peerCryptoError } from "./errors.ts";

/**
 * Shared vocabulary for the device-side peer crypto layer.
 *
 * The layer implements the resolved DEC-PEER-ENCRYPTED-MAILBOX profile:
 * one-to-one direct messaging over the Signal protocol stack (PQXDH-family
 * prekey exchange plus Double Ratchet) through the Node-native
 * `@signalapp/libsignal-client` bindings. Peers are addressed by an opaque
 * stable `peerId` provisioned by the pairing layer and a single fixed device
 * id — Sesame-style resolution keeps exactly one active session per
 * (peerId, deviceId) pair. No group or MLS primitives exist here.
 */

/** One device per peer pair: the pairing profile fixes deviceId at 1. */
export const PEER_DEVICE_ID = 1;

export const PEER_ENVELOPE_FORMAT = "meshrix-peer-envelope";
export const PEER_ENVELOPE_VERSION = 1;
export const PEER_PREKEY_BUNDLE_FORMAT = "meshrix-peer-prekey-bundle";
export const PEER_PREKEY_BUNDLE_VERSION = 1;
export const PEER_STORE_RECORD_VERSION = 1;

/** Opaque peer identifiers reuse the relay admission charset and bound. */
export const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** Serialized ciphertext upper bound; aligned with the relay frame payload cap. */
export const PEER_MAX_CIPHERTEXT_BYTES = 262_144;
export const PEER_MAX_ENVELOPE_BYTES = 393_216;
export const PEER_MAX_PLAINTEXT_BYTES = 262_144;
export const PEER_MAX_PREKEY_ID = 0xff_ff_ff;

export const PEER_DEFAULT_ONE_TIME_PREKEY_COUNT = 8;
export const PEER_DEFAULT_KYBER_PREKEY_COUNT = 8;
export const PEER_SAFETY_NUMBER_ITERATIONS = 5200;
export const PEER_SAFETY_NUMBER_VERSION = 0;

export function assertPeerId(value: unknown, field: string = "peerId"): string {
  if (typeof value !== "string" || !PEER_ID_PATTERN.test(value)) {
    throw peerCryptoError("peer_envelope_malformed", `The ${field} field is not a valid opaque peer identifier.`);
  }
  return value;
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function base64urlDecode(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  if (base64urlEncode(bytes) !== value) return null;
  return bytes;
}

/** Copy into an exactly-sized Uint8Array backed by ArrayBuffer for the native API. */
export function toExactBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
