import {
  PreKeyRecord,
  SignedPreKeyRecord,
  KyberPreKeyRecord
} from "@signalapp/libsignal-client";

import { peerCryptoError } from "./errors.ts";
import type { PeerIdentity } from "./identity.ts";
import type { PeerCryptoStore } from "./store.ts";
import {
  assertPeerId,
  base64urlDecode,
  base64urlEncode,
  PEER_MAX_PREKEY_ID,
  PEER_PREKEY_BUNDLE_FORMAT,
  PEER_PREKEY_BUNDLE_VERSION,
  toExactBytes
} from "./types.ts";

/**
 * Publishable prekey bundle contract. This is the device-to-device X3DH/PQXDH
 * advertisement: only public key material travels; the matching private
 * records stay inside the publisher's store until a peer's first prekey
 * message consumes them. Strict exact-key JSON — unknown, missing or extra
 * fields are malformed.
 */
export interface PeerPrekeyBundle {
  readonly format: typeof PEER_PREKEY_BUNDLE_FORMAT;
  readonly version: typeof PEER_PREKEY_BUNDLE_VERSION;
  readonly peerId: string;
  readonly deviceId: number;
  readonly registrationId: number;
  /** base64url identity PublicKey.serialize() — the key this binding pins. */
  readonly identityKey: string;
  readonly signedPreKey: {
    readonly id: number;
    readonly publicKey: string;
    readonly signature: string;
  };
  /** Present when a one-time EC prekey backs this bundle (PQXDH-family). */
  readonly oneTimePreKey: {
    readonly id: number;
    readonly publicKey: string;
  } | null;
  readonly kyberPreKey: {
    readonly id: number;
    readonly publicKey: string;
    readonly signature: string;
  };
}

function prekeyId(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= PEER_MAX_PREKEY_ID
    ? value as number
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && sorted.every((key, index) => key === keys[index]);
}

/**
 * Mint a fresh publishable bundle for this identity. Each call consumes one
 * available one-time prekey and one available Kyber prekey by marking them
 * `published` — a later `signalDecryptPreKey` consumes the private record.
 * An empty pool fails with `peer_prekey_exhausted`; never silently reuses a
 * claimed prekey.
 */
export async function generatePrekeyBundle(
  identity: PeerIdentity,
  options: { readonly localStore?: PeerCryptoStore } = {}
): Promise<PeerPrekeyBundle> {
  const store = options.localStore ?? identity.localStore;
  const oneTimeEntries = (await store.listPreKeys())
    .filter((entry) => entry.state === "available")
    .sort((left, right) => left.id - right.id);
  const kyberEntries = (await store.listKyberPreKeys())
    .filter((entry) => entry.state === "available")
    .sort((left, right) => left.id - right.id);
  if (oneTimeEntries.length === 0 || kyberEntries.length === 0) {
    throw peerCryptoError(
      "peer_prekey_exhausted",
      "No unpublished one-time or Kyber prekey remains; call replenishPeerPrekeys before minting another bundle."
    );
  }
  const oneTimeId = oneTimeEntries[0].id;
  const kyberId = kyberEntries[0].id;
  const oneTime = await store.loadPreKey(oneTimeId);
  const kyber = await store.loadKyberPreKey(kyberId);
  if (!oneTime || !kyber) {
    throw peerCryptoError("peer_store_error", "An available prekey listing has no backing record.");
  }
  const signedIds = [...(await store.listSignedPreKeys())].sort((left: number, right: number) => right - left);
  if (signedIds.length === 0) {
    throw peerCryptoError("peer_store_error", "No signed prekey exists for this identity.");
  }
  const signedBytes = await store.loadSignedPreKey(signedIds[0]);
  if (!signedBytes) {
    throw peerCryptoError("peer_store_error", "The latest signed prekey listing has no backing record.");
  }
  let signed: SignedPreKeyRecord;
  let oneTimeRecord: PreKeyRecord;
  let kyberRecord: KyberPreKeyRecord;
  try {
    signed = SignedPreKeyRecord.deserialize(toExactBytes(signedBytes));
    oneTimeRecord = PreKeyRecord.deserialize(toExactBytes(oneTime.record));
    kyberRecord = KyberPreKeyRecord.deserialize(toExactBytes(kyber.record));
  } catch (error: unknown) {
    throw peerCryptoError("peer_store_error", "A stored prekey record cannot be deserialized.", { cause: error });
  }
  await store.savePreKey(Object.freeze({ id: oneTimeId, state: "published" as const, record: oneTime.record }));
  try {
    await store.saveKyberPreKey(Object.freeze({ id: kyberId, state: "published" as const, record: kyber.record }));
  } catch (error: unknown) {
    // Roll the one-time claim back: a half-published bundle must not burn a prekey.
    await store.savePreKey(Object.freeze({ id: oneTimeId, state: "available" as const, record: oneTime.record }));
    throw error;
  }
  return Object.freeze({
    format: PEER_PREKEY_BUNDLE_FORMAT,
    version: PEER_PREKEY_BUNDLE_VERSION,
    peerId: identity.peerId,
    deviceId: identity.deviceId,
    registrationId: identity.registrationId,
    identityKey: base64urlEncode(identity.publicKey.serialize()),
    signedPreKey: Object.freeze({
      id: signed.id(),
      publicKey: base64urlEncode(signed.publicKey().serialize()),
      signature: base64urlEncode(signed.signature())
    }),
    oneTimePreKey: Object.freeze({
      id: oneTimeRecord.id(),
      publicKey: base64urlEncode(oneTimeRecord.publicKey().serialize())
    }),
    kyberPreKey: Object.freeze({
      id: kyberRecord.id(),
      publicKey: base64urlEncode(kyberRecord.publicKey().serialize()),
      signature: base64urlEncode(kyberRecord.signature())
    })
  });
}

/** Strict parse of a remote bundle; returns null for any malformed shape. */
export function parsePeerPrekeyBundle(value: unknown): PeerPrekeyBundle | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, [
    "format", "version", "peerId", "deviceId", "registrationId",
    "identityKey", "signedPreKey", "oneTimePreKey", "kyberPreKey"
  ])) return null;
  if (value.format !== PEER_PREKEY_BUNDLE_FORMAT || value.version !== PEER_PREKEY_BUNDLE_VERSION) return null;
  let peerId: string;
  try {
    peerId = assertPeerId(value.peerId);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(value.deviceId) || (value.deviceId as number) < 1 || (value.deviceId as number) > 127) return null;
  if (!Number.isSafeInteger(value.registrationId) || (value.registrationId as number) < 1) return null;
  const identityKey = base64urlDecode(value.identityKey, 512);
  if (!identityKey) return null;
  if (!isPlainObject(value.signedPreKey)
    || !hasExactKeys(value.signedPreKey, ["id", "publicKey", "signature"])) return null;
  const signedId = prekeyId(value.signedPreKey.id);
  const signedPub = base64urlDecode(value.signedPreKey.publicKey, 512);
  const signedSig = base64urlDecode(value.signedPreKey.signature, 1024);
  if (signedId === null || !signedPub || !signedSig) return null;
  if (value.oneTimePreKey !== null) {
    if (!isPlainObject(value.oneTimePreKey)
      || !hasExactKeys(value.oneTimePreKey, ["id", "publicKey"])) return null;
    const otpId = prekeyId(value.oneTimePreKey.id);
    const otpPub = base64urlDecode(value.oneTimePreKey.publicKey, 512);
    if (otpId === null || !otpPub) return null;
  }
  if (!isPlainObject(value.kyberPreKey)
    || !hasExactKeys(value.kyberPreKey, ["id", "publicKey", "signature"])) return null;
  const kyberId = prekeyId(value.kyberPreKey.id);
  const kyberPub = base64urlDecode(value.kyberPreKey.publicKey, 4096);
  const kyberSig = base64urlDecode(value.kyberPreKey.signature, 1024);
  if (kyberId === null || !kyberPub || !kyberSig) return null;
  return Object.freeze(value as unknown as PeerPrekeyBundle);
}
