import { Buffer } from "node:buffer";

import { peerCryptoError } from "./errors.ts";
import {
  assertPeerId,
  base64urlDecode,
  base64urlEncode,
  PEER_ENVELOPE_FORMAT,
  PEER_ENVELOPE_VERSION,
  PEER_MAX_CIPHERTEXT_BYTES,
  PEER_MAX_ENVELOPE_BYTES
} from "./types.ts";

/**
 * Internal ciphertext envelope seam for the peer wire contract.
 *
 * This is the crypto layer's own serialization, deliberately decoupled from
 * the wire schema a sibling contract owns: the wire node SHOULD adopt these
 * fields verbatim inside its outer envelope so crypto-side session routing
 * needs no translation. Exact-key JSON; the relay/mailbox only ever stores
 * this object — never plaintext or keys.
 *
 *   format          "meshrix-peer-envelope"   (discriminator)
 *   version         1                          (bump on shape change)
 *   senderPeerId    opaque stable sender peer id (session routing + pin lookup)
 *   senderDeviceId  sender device id (1 in the current profile)
 *   messageType     "prekey" | "signal"        (decrypt dispatch: X3DH first
 *                   message vs Double-Ratchet steady state)
 *   body            base64url of the serialized CiphertextMessage (the type
 *                   byte inside also distinguishes PreKey/Whisper; the field
 *                   exists so receivers dispatch without probing both parsers)
 */
export interface PeerEnvelope {
  readonly format: typeof PEER_ENVELOPE_FORMAT;
  readonly version: typeof PEER_ENVELOPE_VERSION;
  readonly senderPeerId: string;
  readonly senderDeviceId: number;
  readonly messageType: PeerCiphertextType;
  readonly body: string;
}

export type PeerCiphertextType = "prekey" | "signal";
export const PEER_CIPHERTEXT_TYPES = Object.freeze(["prekey", "signal"] as const);

/** Raw ciphertext plus the dispatch hint, as returned by session.encrypt(). */
export interface PeerCiphertext {
  readonly messageType: PeerCiphertextType;
  readonly body: Uint8Array;
}

/** Session routing header the sender stamps on every envelope. */
export interface PeerSessionHeader {
  readonly senderPeerId: string;
  readonly senderDeviceId: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && sorted.every((key, index) => key === keys[index]);
}

/** Compose the wire-ready envelope from a session header and fresh ciphertext. */
export function serializePeerEnvelope(header: PeerSessionHeader, ciphertext: PeerCiphertext): PeerEnvelope {
  const senderPeerId = assertPeerId(header.senderPeerId, "senderPeerId");
  if (!Number.isSafeInteger(header.senderDeviceId) || header.senderDeviceId < 1 || header.senderDeviceId > 127) {
    throw peerCryptoError("peer_envelope_malformed", "The senderDeviceId field is outside the valid device range.");
  }
  if (!PEER_CIPHERTEXT_TYPES.includes(ciphertext.messageType)) {
    throw peerCryptoError("peer_envelope_malformed", "The ciphertext messageType is not a peer ciphertext type.");
  }
  if (!(ciphertext.body instanceof Uint8Array) || ciphertext.body.length === 0 || ciphertext.body.length > PEER_MAX_CIPHERTEXT_BYTES) {
    throw peerCryptoError("peer_envelope_malformed", "The ciphertext body is empty or exceeds the size bound.");
  }
  return Object.freeze({
    format: PEER_ENVELOPE_FORMAT,
    version: PEER_ENVELOPE_VERSION,
    senderPeerId,
    senderDeviceId: header.senderDeviceId,
    messageType: ciphertext.messageType,
    body: base64urlEncode(ciphertext.body)
  });
}

export interface ParsedPeerEnvelope {
  readonly senderPeerId: string;
  readonly senderDeviceId: number;
  readonly messageType: PeerCiphertextType;
  readonly body: Uint8Array;
}

/** Strict parse of an inbound envelope value; null for any malformed shape. */
export function parsePeerEnvelope(value: unknown): ParsedPeerEnvelope | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, ["format", "version", "senderPeerId", "senderDeviceId", "messageType", "body"])) return null;
  if (value.format !== PEER_ENVELOPE_FORMAT || value.version !== PEER_ENVELOPE_VERSION) return null;
  if (typeof value.senderPeerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.senderPeerId)) return null;
  if (!Number.isSafeInteger(value.senderDeviceId) || (value.senderDeviceId as number) < 1 || (value.senderDeviceId as number) > 127) return null;
  if (value.messageType !== "prekey" && value.messageType !== "signal") return null;
  const body = base64urlDecode(value.body, PEER_MAX_CIPHERTEXT_BYTES);
  if (!body) return null;
  return Object.freeze({
    senderPeerId: value.senderPeerId,
    senderDeviceId: value.senderDeviceId as number,
    messageType: value.messageType,
    body
  });
}

/** UTF-8 JSON encoding for byte-oriented transports; bounded output. */
export function encodePeerEnvelope(envelope: PeerEnvelope): Uint8Array {
  const parsed = parsePeerEnvelope(envelope);
  if (!parsed) {
    throw peerCryptoError("peer_envelope_malformed", "The outbound envelope does not satisfy the peer envelope contract.");
  }
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/** Decode a UTF-8 JSON envelope; null on undecodable or malformed input. */
export function decodePeerEnvelope(bytes: Uint8Array): ParsedPeerEnvelope | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > PEER_MAX_ENVELOPE_BYTES) return null;
  try {
    return parsePeerEnvelope(JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")));
  } catch {
    return null;
  }
}
