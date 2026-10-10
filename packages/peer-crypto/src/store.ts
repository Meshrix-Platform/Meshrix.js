import { peerCryptoError } from "./errors.ts";
import { PEER_DEVICE_ID, PEER_ID_PATTERN } from "./types.ts";

/**
 * Durable crypto store contract for one device.
 *
 * Every persisted value is an opaque serialized record produced by the
 * library's own `serialize()` — the store never interprets key bytes.
 * Secret material (identity private key, prekey private keys, ratchet state)
 * lives here and nowhere else; implementations must write it with
 * owner-only permissions and never emit it to logs.
 *
 * Lifecycle: `createPeerIdentity` writes the prekey pool first and the
 * identity record last, so a present identity record always implies a
 * committed device identity.
 */

/** Secret local identity record; `identityKeyPair` is base64url of IdentityKeyPair.serialize(). */
export interface PeerIdentitySecretRecord {
  readonly version: 1;
  readonly peerId: string;
  readonly deviceId: number;
  readonly registrationId: number;
  readonly identityKeyPair: string;
  readonly createdAt: string;
}

/** Public pinned remote identity; the trust root for peer_identity_changed honesty. */
export interface PeerIdentityBinding {
  readonly peerId: string;
  readonly deviceId: number;
  /** base64url of the remote PublicKey.serialize() bytes. */
  readonly identityKey: string;
  readonly trustGeneration: number;
  readonly pinnedAt: string;
  /** "blocked" keeps the pin as evidence after a detected change; never silently re-trusted. */
  readonly state: "active" | "blocked";
}

export type PeerPrekeyState = "available" | "published" | "used";

export interface StoredPreKeyEntry {
  readonly id: number;
  readonly state: PeerPrekeyState;
}

export interface StoredPreKeyRecord {
  readonly id: number;
  readonly state: PeerPrekeyState;
  /** Serialized PreKeyRecord / KyberPreKeyRecord bytes. */
  readonly record: Uint8Array;
}

/** Monotonic id allocators; ids never recycle after one-time records are deleted. */
export interface PeerCryptoCounters {
  readonly nextPreKeyId: number;
  readonly nextSignedPreKeyId: number;
  readonly nextKyberPreKeyId: number;
}

/** Stable store key for one session address: `sesame` resolution is per (name, device). */
export function peerSessionAddressKey(name: string, deviceId: number = PEER_DEVICE_ID): string {
  return `${deviceId}--${name}`;
}

export function parsePeerSessionAddressKey(key: string): { readonly name: string; readonly deviceId: number } | null {
  const split = key.indexOf("--");
  if (split <= 0) return null;
  const deviceId = Number(key.slice(0, split));
  const name = key.slice(split + 2);
  if (!Number.isSafeInteger(deviceId) || deviceId < 1 || !PEER_ID_PATTERN.test(name)) return null;
  return Object.freeze({ name, deviceId });
}

export interface PeerCryptoStore {
  loadIdentity(): Promise<PeerIdentitySecretRecord | null>;
  saveIdentity(record: PeerIdentitySecretRecord): Promise<void>;

  loadPeerBinding(peerId: string): Promise<PeerIdentityBinding | null>;
  savePeerBinding(binding: PeerIdentityBinding): Promise<void>;
  deletePeerBinding(peerId: string): Promise<void>;
  listPeerBindings(): Promise<readonly PeerIdentityBinding[]>;

  loadSession(addressKey: string): Promise<Uint8Array | null>;
  saveSession(addressKey: string, serialized: Uint8Array): Promise<void>;
  deleteSession(addressKey: string): Promise<void>;
  listSessionKeys(): Promise<readonly string[]>;

  loadPreKey(id: number): Promise<StoredPreKeyRecord | null>;
  savePreKey(record: StoredPreKeyRecord): Promise<void>;
  deletePreKey(id: number): Promise<void>;
  listPreKeys(): Promise<readonly StoredPreKeyEntry[]>;

  loadSignedPreKey(id: number): Promise<Uint8Array | null>;
  saveSignedPreKey(id: number, serialized: Uint8Array): Promise<void>;
  deleteSignedPreKey(id: number): Promise<void>;
  listSignedPreKeys(): Promise<readonly number[]>;

  loadKyberPreKey(id: number): Promise<StoredPreKeyRecord | null>;
  saveKyberPreKey(record: StoredPreKeyRecord): Promise<void>;
  deleteKyberPreKey(id: number): Promise<void>;
  listKyberPreKeys(): Promise<readonly StoredPreKeyEntry[]>;

  loadCounters(): Promise<PeerCryptoCounters | null>;
  saveCounters(counters: PeerCryptoCounters): Promise<void>;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneRecord<T extends { readonly record: Uint8Array }>(entry: T): T {
  return Object.freeze({ ...entry, record: cloneBytes(entry.record) }) as T;
}

/**
 * Map-backed store for tests and ephemeral composition. Mirrors the durable
 * contract byte-for-byte (defensive copies on every boundary) so callers
 * cannot distinguish it from the file implementation.
 */
export class InMemoryPeerCryptoStore implements PeerCryptoStore {
  readonly #identity: { current: PeerIdentitySecretRecord | null } = { current: null };
  readonly #bindings = new Map<string, PeerIdentityBinding>();
  readonly #sessions = new Map<string, Uint8Array>();
  readonly #preKeys = new Map<number, StoredPreKeyRecord>();
  readonly #signedPreKeys = new Map<number, Uint8Array>();
  readonly #kyberPreKeys = new Map<number, StoredPreKeyRecord>();
  readonly #counters: { current: PeerCryptoCounters | null } = { current: null };

  async loadIdentity(): Promise<PeerIdentitySecretRecord | null> {
    return this.#identity.current;
  }

  async saveIdentity(record: PeerIdentitySecretRecord): Promise<void> {
    this.#identity.current = Object.freeze({ ...record });
  }

  async loadPeerBinding(peerId: string): Promise<PeerIdentityBinding | null> {
    return this.#bindings.get(peerId) ?? null;
  }

  async savePeerBinding(binding: PeerIdentityBinding): Promise<void> {
    this.#bindings.set(binding.peerId, Object.freeze({ ...binding }));
  }

  async deletePeerBinding(peerId: string): Promise<void> {
    this.#bindings.delete(peerId);
  }

  async listPeerBindings(): Promise<readonly PeerIdentityBinding[]> {
    return [...this.#bindings.values()];
  }

  async loadSession(addressKey: string): Promise<Uint8Array | null> {
    const record = this.#sessions.get(addressKey);
    return record ? cloneBytes(record) : null;
  }

  async saveSession(addressKey: string, serialized: Uint8Array): Promise<void> {
    this.#sessions.set(addressKey, cloneBytes(serialized));
  }

  async deleteSession(addressKey: string): Promise<void> {
    this.#sessions.delete(addressKey);
  }

  async listSessionKeys(): Promise<readonly string[]> {
    return [...this.#sessions.keys()];
  }

  async loadPreKey(id: number): Promise<StoredPreKeyRecord | null> {
    const record = this.#preKeys.get(id);
    return record ? cloneRecord(record) : null;
  }

  async savePreKey(record: StoredPreKeyRecord): Promise<void> {
    this.#preKeys.set(record.id, cloneRecord(record));
  }

  async deletePreKey(id: number): Promise<void> {
    this.#preKeys.delete(id);
  }

  async listPreKeys(): Promise<readonly StoredPreKeyEntry[]> {
    return [...this.#preKeys.values()].map(({ id, state }) => Object.freeze({ id, state }));
  }

  async loadSignedPreKey(id: number): Promise<Uint8Array | null> {
    const record = this.#signedPreKeys.get(id);
    return record ? cloneBytes(record) : null;
  }

  async saveSignedPreKey(id: number, serialized: Uint8Array): Promise<void> {
    this.#signedPreKeys.set(id, cloneBytes(serialized));
  }

  async deleteSignedPreKey(id: number): Promise<void> {
    this.#signedPreKeys.delete(id);
  }

  async listSignedPreKeys(): Promise<readonly number[]> {
    return [...this.#signedPreKeys.keys()];
  }

  async loadKyberPreKey(id: number): Promise<StoredPreKeyRecord | null> {
    const record = this.#kyberPreKeys.get(id);
    return record ? cloneRecord(record) : null;
  }

  async saveKyberPreKey(record: StoredPreKeyRecord): Promise<void> {
    this.#kyberPreKeys.set(record.id, cloneRecord(record));
  }

  async deleteKyberPreKey(id: number): Promise<void> {
    this.#kyberPreKeys.delete(id);
  }

  async listKyberPreKeys(): Promise<readonly StoredPreKeyEntry[]> {
    return [...this.#kyberPreKeys.values()].map(({ id, state }) => Object.freeze({ id, state }));
  }

  async loadCounters(): Promise<PeerCryptoCounters | null> {
    return this.#counters.current;
  }

  async saveCounters(counters: PeerCryptoCounters): Promise<void> {
    this.#counters.current = Object.freeze({ ...counters });
  }
}

export function createInMemoryPeerCryptoStore(): InMemoryPeerCryptoStore {
  return new InMemoryPeerCryptoStore();
}

export function requireIdentityRecord(record: PeerIdentitySecretRecord | null): PeerIdentitySecretRecord {
  if (!record) {
    throw peerCryptoError("peer_state_invalid", "No local peer identity exists in this store; call createPeerIdentity first.");
  }
  return record;
}
