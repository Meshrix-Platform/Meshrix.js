import crypto from "node:crypto";

import {
  IdentityKeyPair,
  KEMKeyPair,
  KyberPreKeyRecord,
  PreKeyRecord,
  PrivateKey,
  PublicKey,
  SignedPreKeyRecord
} from "@signalapp/libsignal-client";

import { peerCryptoError } from "./errors.ts";
import type { PeerCryptoStore, PeerIdentitySecretRecord } from "./store.ts";
import { requireIdentityRecord } from "./store.ts";
import {
  assertPeerId,
  base64urlDecode,
  base64urlEncode,
  PEER_DEFAULT_KYBER_PREKEY_COUNT,
  PEER_DEFAULT_ONE_TIME_PREKEY_COUNT,
  PEER_DEVICE_ID,
  PEER_MAX_PREKEY_ID,
  PEER_STORE_RECORD_VERSION,
  toExactBytes
} from "./types.ts";

/**
 * Local device identity: the peerId the pairing layer binds, the Signal
 * registration id and the identity keypair. Private key material is held in
 * private fields only — `toJSON` exposes the public projection so a stringified
 * identity can never leak secret bytes.
 */
export class PeerIdentity {
  readonly peerId: string;
  readonly deviceId: number;
  readonly registrationId: number;
  readonly createdAt: string;
  /** Store this identity was created/loaded against; used by prekey pool operations. */
  readonly localStore: PeerCryptoStore;
  readonly #keyPair: IdentityKeyPair;

  constructor(record: PeerIdentitySecretRecord, localStore: PeerCryptoStore) {
    const keyPairBytes = base64urlDecode(record.identityKeyPair, 4096);
    if (!keyPairBytes) {
      throw peerCryptoError("peer_store_error", "The stored identity keypair cannot be decoded.");
    }
    let keyPair: IdentityKeyPair;
    try {
      keyPair = IdentityKeyPair.deserialize(toExactBytes(keyPairBytes));
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", "The stored identity keypair cannot be deserialized.", { cause: error });
    }
    this.#keyPair = keyPair;
    this.peerId = record.peerId;
    this.deviceId = record.deviceId;
    this.registrationId = record.registrationId;
    this.createdAt = record.createdAt;
    this.localStore = localStore;
  }

  /** Package-internal: the identity keypair for signing and the identity store bridge. */
  get identityKeyPair(): IdentityKeyPair {
    return this.#keyPair;
  }

  get publicKey(): PublicKey {
    return this.#keyPair.publicKey;
  }

  /** Public-only projection — no private key bytes, safe for logs and wire metadata. */
  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      peerId: this.peerId,
      deviceId: this.deviceId,
      registrationId: this.registrationId,
      identityKey: base64urlEncode(this.#keyPair.publicKey.serialize()),
      createdAt: this.createdAt
    });
  }
}

/** Sign a domain-separated peer control transcript with the enrolled Signal identity. */
export function signPeerIdentityMessage(identity: PeerIdentity, message: Uint8Array): Uint8Array {
  return new Uint8Array(identity.identityKeyPair.privateKey.sign(toExactBytes(message)));
}

/** Verify a Signal identity signature against bytes obtained from pairing-pinned custody. */
export function verifyPeerIdentityMessage(
  identityKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  if (signature.byteLength !== 64) return false;
  try {
    return PublicKey.deserialize(toExactBytes(identityKey)).verify(toExactBytes(message), toExactBytes(signature));
  } catch {
    return false;
  }
}

async function nextId(store: PeerCryptoStore, field: "nextPreKeyId" | "nextSignedPreKeyId" | "nextKyberPreKeyId"): Promise<number> {
  const counters = await store.loadCounters()
    ?? Object.freeze({ nextPreKeyId: 1, nextSignedPreKeyId: 1, nextKyberPreKeyId: 1 });
  const id = counters[field];
  if (!Number.isSafeInteger(id) || id < 1 || id > PEER_MAX_PREKEY_ID) {
    throw peerCryptoError("peer_state_invalid", "The prekey id space is exhausted; reset requires a fresh device identity.");
  }
  await store.saveCounters(Object.freeze({ ...counters, [field]: id + 1 }));
  return id;
}

async function mintOneTimePreKey(store: PeerCryptoStore): Promise<number> {
  const id = await nextId(store, "nextPreKeyId");
  const privateKey = PrivateKey.generate();
  const record = PreKeyRecord.new(id, privateKey.getPublicKey(), privateKey);
  await store.savePreKey(Object.freeze({ id, state: "available" as const, record: record.serialize() }));
  return id;
}

async function mintKyberPreKey(identity: PeerIdentity, store: PeerCryptoStore): Promise<number> {
  const id = await nextId(store, "nextKyberPreKeyId");
  const keyPair = KEMKeyPair.generate();
  const signature = identity.identityKeyPair.privateKey.sign(toExactBytes(keyPair.getPublicKey().serialize()));
  const record = KyberPreKeyRecord.new(id, Date.now(), keyPair, signature);
  await store.saveKyberPreKey(Object.freeze({ id, state: "available" as const, record: record.serialize() }));
  return id;
}

async function mintSignedPreKey(identity: PeerIdentity, store: PeerCryptoStore): Promise<number> {
  const id = await nextId(store, "nextSignedPreKeyId");
  const privateKey = PrivateKey.generate();
  const signature = identity.identityKeyPair.privateKey.sign(toExactBytes(privateKey.getPublicKey().serialize()));
  const record = SignedPreKeyRecord.new(id, Date.now(), privateKey.getPublicKey(), privateKey, signature);
  await store.saveSignedPreKey(id, record.serialize());
  return id;
}

export interface PeerPrekeyPoolSize {
  readonly oneTimeCount: number;
  readonly kyberCount: number;
}

/**
 * Mint fresh one-time and Kyber prekeys up to the requested pool depth.
 * Already-published or used records are never touched; this is the only way
 * out of `peer_prekey_exhausted`.
 */
export async function replenishPeerPrekeys(
  identity: PeerIdentity,
  pool: Partial<PeerPrekeyPoolSize> = {}
): Promise<PeerPrekeyPoolSize> {
  const store = identity.localStore;
  const targetOneTime = pool.oneTimeCount ?? PEER_DEFAULT_ONE_TIME_PREKEY_COUNT;
  const targetKyber = pool.kyberCount ?? PEER_DEFAULT_KYBER_PREKEY_COUNT;
  const oneTime = await store.listPreKeys();
  const kyber = await store.listKyberPreKeys();
  const availableOneTime = oneTime.filter((entry) => entry.state === "available").length;
  const availableKyber = kyber.filter((entry) => entry.state === "available").length;
  for (let index = availableOneTime; index < targetOneTime; index += 1) {
    await mintOneTimePreKey(store);
  }
  for (let index = availableKyber; index < targetKyber; index += 1) {
    await mintKyberPreKey(identity, store);
  }
  return Object.freeze({ oneTimeCount: targetOneTime, kyberCount: targetKyber });
}

/**
 * Rotate the signed prekey: mints a fresh record under a new id. Older signed
 * prekeys stay loadable so peers holding an earlier published bundle can still
 * complete their handshake.
 */
export async function rotateSignedPreKey(identity: PeerIdentity): Promise<number> {
  return mintSignedPreKey(identity, identity.localStore);
}

export interface CreatePeerIdentityOptions {
  readonly localStore: PeerCryptoStore;
  /** Optional caller-provisioned opaque id; a random `peer.<id>` is generated otherwise. */
  readonly peerId?: string;
  readonly prekeyPool?: Partial<PeerPrekeyPoolSize>;
}

/**
 * Create a fresh device identity: generates the identity keypair, registration
 * id and the initial prekey pool. The identity record commits last, so a
 * loaded identity always implies a committed pool seed. An existing identity
 * record is never overwritten — `loadPeerIdentity` resumes it.
 */
export async function createPeerIdentity(options: CreatePeerIdentityOptions): Promise<PeerIdentity> {
  const store = options.localStore;
  if (await store.loadIdentity() !== null) {
    throw peerCryptoError("peer_state_invalid", "A local peer identity already exists in this store; load it with loadPeerIdentity.");
  }
  const peerId = options.peerId === undefined
    ? `peer.${crypto.randomBytes(12).toString("base64url")}`
    : assertPeerId(options.peerId);
  const keyPair = IdentityKeyPair.generate();
  const registrationId = crypto.randomInt(1, 0x4000);
  const record: PeerIdentitySecretRecord = Object.freeze({
    version: PEER_STORE_RECORD_VERSION,
    peerId,
    deviceId: PEER_DEVICE_ID,
    registrationId,
    identityKeyPair: base64urlEncode(keyPair.serialize()),
    createdAt: new Date().toISOString()
  });
  const identity = new PeerIdentity(record, store);
  await store.saveCounters(Object.freeze({ nextPreKeyId: 1, nextSignedPreKeyId: 1, nextKyberPreKeyId: 1 }));
  await mintSignedPreKey(identity, store);
  await replenishPeerPrekeys(identity, options.prekeyPool ?? {});
  await store.saveIdentity(record);
  return identity;
}

/** Resume the device identity committed in this store, or null when none exists. */
export async function loadPeerIdentity(store: PeerCryptoStore): Promise<PeerIdentity | null> {
  const record = await store.loadIdentity();
  if (record === null) return null;
  const identity = new PeerIdentity(requireIdentityRecord(record), store);
  const counters = await store.loadCounters();
  if (counters === null) {
    await store.saveCounters(Object.freeze({ nextPreKeyId: 1, nextSignedPreKeyId: 1, nextKyberPreKeyId: 1 }));
  }
  return identity;
}
