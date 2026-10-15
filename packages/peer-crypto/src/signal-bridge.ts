import {
  IdentityChange,
  IdentityKeyPair,
  KyberPreKeyRecord,
  PreKeyRecord,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SignedPreKeyRecord
} from "@signalapp/libsignal-client";
import type {
  Direction,
  IdentityKeyStore,
  KyberPreKeyStore,
  PreKeyStore,
  SessionStore,
  SignedPreKeyStore
} from "@signalapp/libsignal-client";

import { peerCryptoError } from "./errors.ts";
import type { PeerIdentity } from "./identity.ts";
import {
  peerSessionAddressKey,
  type PeerCryptoStore,
  type PeerIdentityBinding
} from "./store.ts";
import { base64urlDecode, base64urlEncode, PEER_DEVICE_ID, toExactBytes } from "./types.ts";

/**
 * Duck-typed adapters from the durable {@link PeerCryptoStore} to the
 * libsignal store callbacks. The library bridges these by method name — no
 * inheritance is required — and serializes every record through the store's
 * byte-level contract.
 */

function bindingKeyEqual(pinnedB64: string, key: PublicKey): boolean {
  const candidate = base64urlEncode(key.serialize());
  if (candidate.length !== pinnedB64.length) return false;
  let diff = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    diff |= candidate.charCodeAt(index) ^ pinnedB64.charCodeAt(index);
  }
  return diff === 0;
}

class SignalSessionStoreBridge implements SessionStore {
  readonly #store: PeerCryptoStore;

  constructor(store: PeerCryptoStore) {
    this.#store = store;
  }

  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    await this.#store.saveSession(peerSessionAddressKey(name.name(), name.deviceId()), record.serialize());
  }

  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    const bytes = await this.#store.loadSession(peerSessionAddressKey(name.name(), name.deviceId()));
    if (!bytes) return null;
    try {
      return SessionRecord.deserialize(toExactBytes(bytes));
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", "A stored session record cannot be deserialized.", { cause: error });
    }
  }

  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    const sessions: SessionRecord[] = [];
    for (const address of addresses) {
      const session = await this.getSession(address);
      if (session) sessions.push(session);
    }
    return sessions;
  }
}

class SignalIdentityKeyStoreBridge implements IdentityKeyStore {
  readonly #store: PeerCryptoStore;
  readonly #identity: PeerIdentity;

  constructor(store: PeerCryptoStore, identity: PeerIdentity) {
    this.#store = store;
    this.#identity = identity;
  }

  async getIdentityKey(): Promise<PrivateKey> {
    return this.#identity.identityKeyPair.privateKey;
  }

  async getIdentityKeyPair(): Promise<IdentityKeyPair> {
    return this.#identity.identityKeyPair;
  }

  async getLocalRegistrationId(): Promise<number> {
    return this.#identity.registrationId;
  }

  /** The pairing transaction must pin the key before Signal accepts it. */
  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<IdentityChange> {
    const peerId = name.name();
    const existing = await this.#store.loadPeerBinding(peerId);
    if (!existing) {
      throw peerCryptoError(
        "peer_identity_changed",
        `Remote identity for ${peerId} has no authenticated pairing pin; explicit pairing is required.`
      );
    }
    if (existing.state === "active" && existing.deviceId === name.deviceId() && bindingKeyEqual(existing.identityKey, key)) {
      return IdentityChange.NewOrUnchanged;
    }
    throw peerCryptoError(
      "peer_identity_changed",
      `Remote identity for ${peerId} does not match the pinned record; explicit re-pair is required.`
    );
  }

  async isTrustedIdentity(name: ProtocolAddress, key: PublicKey, _direction: Direction): Promise<boolean> {
    if (name.deviceId() !== PEER_DEVICE_ID) return false;
    const existing = await this.#store.loadPeerBinding(name.name());
    if (!existing) return false;
    if (existing.state !== "active") return false;
    if (existing.deviceId !== name.deviceId()) return false;
    return bindingKeyEqual(existing.identityKey, key);
  }

  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    const existing = await this.#store.loadPeerBinding(name.name());
    if (!existing || existing.state !== "active") return null;
    const decoded = base64urlDecode(existing.identityKey, 512);
    if (!decoded) return null;
    try {
      return PublicKey.deserialize(toExactBytes(decoded));
    } catch {
      return null;
    }
  }
}

class SignalPreKeyStoreBridge implements PreKeyStore {
  readonly #store: PeerCryptoStore;

  constructor(store: PeerCryptoStore) {
    this.#store = store;
  }

  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    await this.#store.savePreKey(Object.freeze({ id, state: "available" as const, record: record.serialize() }));
  }

  async getPreKey(id: number): Promise<PreKeyRecord> {
    const entry = await this.#store.loadPreKey(id);
    if (!entry) {
      throw peerCryptoError("peer_session_broken", `The referenced one-time prekey ${id} is no longer held.`);
    }
    try {
      return PreKeyRecord.deserialize(toExactBytes(entry.record));
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", "A stored one-time prekey cannot be deserialized.", { cause: error });
    }
  }

  async removePreKey(id: number): Promise<void> {
    await this.#store.deletePreKey(id);
  }
}

class SignalSignedPreKeyStoreBridge implements SignedPreKeyStore {
  readonly #store: PeerCryptoStore;

  constructor(store: PeerCryptoStore) {
    this.#store = store;
  }

  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    await this.#store.saveSignedPreKey(id, record.serialize());
  }

  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const bytes = await this.#store.loadSignedPreKey(id);
    if (!bytes) {
      throw peerCryptoError("peer_session_broken", `The referenced signed prekey ${id} is no longer held.`);
    }
    try {
      return SignedPreKeyRecord.deserialize(toExactBytes(bytes));
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", "A stored signed prekey cannot be deserialized.", { cause: error });
    }
  }
}

class SignalKyberPreKeyStoreBridge implements KyberPreKeyStore {
  readonly #store: PeerCryptoStore;

  constructor(store: PeerCryptoStore) {
    this.#store = store;
  }

  async saveKyberPreKey(kyberPreKeyId: number, record: KyberPreKeyRecord): Promise<void> {
    await this.#store.saveKyberPreKey(Object.freeze({ id: kyberPreKeyId, state: "available" as const, record: record.serialize() }));
  }

  async getKyberPreKey(kyberPreKeyId: number): Promise<KyberPreKeyRecord> {
    const entry = await this.#store.loadKyberPreKey(kyberPreKeyId);
    if (!entry) {
      throw peerCryptoError("peer_session_broken", `The referenced Kyber prekey ${kyberPreKeyId} is no longer held.`);
    }
    try {
      return KyberPreKeyRecord.deserialize(toExactBytes(entry.record));
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", "A stored Kyber prekey cannot be deserialized.", { cause: error });
    }
  }

  async markKyberPreKeyUsed(kyberPreKeyId: number, _signedPreKeyId: number, _baseKey: PublicKey): Promise<void> {
    // The record stays loadable so a replayed prekey message still resolves;
    // the "used" marker only feeds pool accounting and later cleanup.
    const entry = await this.#store.loadKyberPreKey(kyberPreKeyId);
    if (entry && entry.state !== "used") {
      await this.#store.saveKyberPreKey(Object.freeze({ id: kyberPreKeyId, state: "used" as const, record: entry.record }));
    }
  }
}

export interface SignalStoreBridgeSet {
  readonly sessions: SignalSessionStoreBridge;
  readonly identities: SignalIdentityKeyStoreBridge;
  readonly preKeys: SignalPreKeyStoreBridge;
  readonly signedPreKeys: SignalSignedPreKeyStoreBridge;
  readonly kyberPreKeys: SignalKyberPreKeyStoreBridge;
}

export function createSignalStoreBridges(store: PeerCryptoStore, identity: PeerIdentity): SignalStoreBridgeSet {
  return Object.freeze({
    sessions: new SignalSessionStoreBridge(store),
    identities: new SignalIdentityKeyStoreBridge(store, identity),
    preKeys: new SignalPreKeyStoreBridge(store),
    signedPreKeys: new SignalSignedPreKeyStoreBridge(store),
    kyberPreKeys: new SignalKyberPreKeyStoreBridge(store)
  });
}
