import fs from "node:fs";
import path from "node:path";

import {
  ensurePrivateDir,
  writePrivateFileAtomic
} from "@meshrix/foundation/storage/private-file-atomic";
import { assertPrivateStorageCapacity } from "@meshrix/foundation/storage/private-storage-capacity";

import { peerCryptoError } from "./errors.ts";
import {
  applyPeerCryptoMutation,
  type PeerCryptoPreparedOperation,
  type PeerCryptoCounters,
  type PeerCryptoStore,
  type PeerIdentityBinding,
  type PeerIdentitySecretRecord,
  type PeerPrekeyState,
  type PeerCryptoMutation,
  type StoredPreKeyEntry,
  type StoredPreKeyRecord
} from "./store.ts";
import { base64urlDecode, base64urlEncode, PEER_STORE_RECORD_VERSION } from "./types.ts";

/**
 * File-backed durable crypto store. One JSON document per record under an
 * owner-only directory; every write goes through `writePrivateFileAtomic`
 * (temp file → fsync → rename, 0o600) so a crash can lose a record but can
 * never leave a torn key file. Assumes a single writer process — the device
 * owns this directory.
 *
 * Layout:
 *   identity.json             local identity keypair + registration id (secret)
 *   meta.json                 monotonic prekey id counters
 *   peers/<peerId>.json       pinned remote identity bindings (public)
 *   sessions/<addr>.json      serialized SessionRecord ratchet state (secret)
 *   prekeys/<id>.json         one-time EC prekeys (secret)
 *   signed-prekeys/<id>.json  signed EC prekeys (secret)
 *   kyber-prekeys/<id>.json   post-quantum prekeys (secret)
 */

const KIND_DIRS = Object.freeze({
  peers: "peers",
  sessions: "sessions",
  prekeys: "prekeys",
  signedPrekeys: "signed-prekeys",
  kyberPrekeys: "kyber-prekeys"
} as const);

function safeName(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

function unsafeName(encoded: string): string | null {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || Buffer.from(bytes).toString("base64url") !== encoded) return null;
  return bytes.toString("utf8");
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBytes(value: unknown, what: string): Uint8Array {
  const bytes = base64urlDecode(value, 16 * 1024 * 1024);
  if (!bytes) throw peerCryptoError("peer_store_error", `Store record ${what} carries no valid base64url payload.`);
  return bytes;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw peerCryptoError("peer_store_error", `Store record ${what} is missing a required string field.`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw peerCryptoError("peer_store_error", `Store record ${what} is missing a required integer field.`);
  }
  return value as number;
}

function asPrekeyState(value: unknown, what: string): PeerPrekeyState {
  if (value === "available" || value === "published" || value === "used") return value;
  throw peerCryptoError("peer_store_error", `Store record ${what} carries an unknown prekey lifecycle state.`);
}

export class FilePeerCryptoStore implements PeerCryptoStore {
  readonly #root: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw peerCryptoError("peer_state_invalid", "FilePeerCryptoStore requires a root directory path.");
    }
    this.#root = rootDir;
    ensurePrivateDir(this.#root);
    for (const dir of Object.values(KIND_DIRS)) {
      ensurePrivateDir(path.join(this.#root, dir));
    }
  }

  get rootDir(): string {
    return this.#root;
  }

  #file(kind: keyof typeof KIND_DIRS | "identity" | "meta", name?: string): string {
    if (kind === "identity") return path.join(this.#root, "identity.json");
    if (kind === "meta") return path.join(this.#root, "meta.json");
    return path.join(this.#root, KIND_DIRS[kind], `${safeName(String(name))}.json`);
  }

  async #read(file: string, what: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isEntry(parsed)) throw new Error("not an object");
      return parsed;
    } catch (error: unknown) {
      throw peerCryptoError("peer_store_error", `Store record ${what} cannot be parsed.`, { cause: error });
    }
  }

  async #write(file: string, value: Readonly<Record<string, unknown>>): Promise<void> {
    await writePrivateFileAtomic(file, `${JSON.stringify(value)}\n`);
  }

  async #list(kind: keyof typeof KIND_DIRS): Promise<readonly Record<string, unknown>[]> {
    const dir = path.join(this.#root, KIND_DIRS[kind]);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const out: Record<string, unknown>[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#read(path.join(dir, name), `${kind}/${name}`);
      if (record) out.push(record);
    }
    return Object.freeze(out);
  }

  async #delete(file: string): Promise<void> {
    await fs.promises.unlink(file).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
  }

  async loadIdentity(): Promise<PeerIdentitySecretRecord | null> {
    const record = await this.#read(this.#file("identity"), "identity");
    if (!record) return null;
    return Object.freeze({
      version: PEER_STORE_RECORD_VERSION,
      peerId: asString(record.peerId, "identity.peerId"),
      deviceId: asNumber(record.deviceId, "identity.deviceId"),
      registrationId: asNumber(record.registrationId, "identity.registrationId"),
      identityKeyPair: asString(record.identityKeyPair, "identity.identityKeyPair"),
      createdAt: asString(record.createdAt, "identity.createdAt")
    });
  }

  async saveIdentity(record: PeerIdentitySecretRecord): Promise<void> {
    await this.#write(this.#file("identity"), { v: PEER_STORE_RECORD_VERSION, ...record });
  }

  async loadPeerBinding(peerId: string): Promise<PeerIdentityBinding | null> {
    const record = await this.#read(this.#file("peers", peerId), `peers/${peerId}`);
    if (!record) return null;
    const state = record.state;
    if (state !== "active" && state !== "blocked") {
      throw peerCryptoError("peer_store_error", `Peer binding ${peerId} carries an unknown state.`);
    }
    return Object.freeze({
      peerId: asString(record.peerId, "peerBinding.peerId"),
      deviceId: asNumber(record.deviceId, "peerBinding.deviceId"),
      identityKey: asString(record.identityKey, "peerBinding.identityKey"),
      trustGeneration: asNumber(record.trustGeneration, "peerBinding.trustGeneration"),
      pinnedAt: asString(record.pinnedAt, "peerBinding.pinnedAt"),
      state
    });
  }

  async savePeerBinding(binding: PeerIdentityBinding): Promise<void> {
    await this.#write(this.#file("peers", binding.peerId), { v: PEER_STORE_RECORD_VERSION, ...binding });
  }

  async deletePeerBinding(peerId: string): Promise<void> {
    await this.#delete(this.#file("peers", peerId));
  }

  async listPeerBindings(): Promise<readonly PeerIdentityBinding[]> {
    const records = await this.#list("peers");
    const out: PeerIdentityBinding[] = [];
    for (const record of records) {
      const peerId = asString(record.peerId, "peerBinding.peerId");
      const binding = await this.loadPeerBinding(peerId);
      if (binding) out.push(binding);
    }
    return Object.freeze(out);
  }

  async loadSession(addressKey: string): Promise<Uint8Array | null> {
    const record = await this.#read(this.#file("sessions", addressKey), `sessions/${addressKey}`);
    if (!record) return null;
    return asBytes(record.record, `sessions/${addressKey}`);
  }

  async saveSession(addressKey: string, serialized: Uint8Array): Promise<void> {
    await this.#write(this.#file("sessions", addressKey), {
      v: PEER_STORE_RECORD_VERSION,
      addressKey,
      record: base64urlEncode(serialized)
    });
  }

  async deleteSession(addressKey: string): Promise<void> {
    await this.#delete(this.#file("sessions", addressKey));
  }

  async listSessionKeys(): Promise<readonly string[]> {
    const dir = path.join(this.#root, KIND_DIRS.sessions);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const out: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const decoded = unsafeName(name.slice(0, -".json".length));
      if (decoded !== null) out.push(decoded);
    }
    return Object.freeze(out);
  }

  async #loadPreKeyEntry(kind: "prekeys" | "kyberPrekeys", id: number): Promise<StoredPreKeyRecord | null> {
    const record = await this.#read(this.#file(kind, String(id)), `${kind}/${id}`);
    if (!record) return null;
    return Object.freeze({
      id: asNumber(record.id, `${kind}.id`),
      state: asPrekeyState(record.state, `${kind}/${id}`),
      record: asBytes(record.record, `${kind}/${id}`)
    });
  }

  async #savePreKeyEntry(kind: "prekeys" | "kyberPrekeys", entry: StoredPreKeyRecord): Promise<void> {
    await this.#write(this.#file(kind, String(entry.id)), {
      v: PEER_STORE_RECORD_VERSION,
      id: entry.id,
      state: entry.state,
      record: base64urlEncode(entry.record)
    });
  }

  async #listPreKeyEntries(kind: "prekeys" | "kyberPrekeys"): Promise<readonly StoredPreKeyEntry[]> {
    const records = await this.#list(kind);
    const out: StoredPreKeyEntry[] = [];
    for (const record of records) {
      out.push(Object.freeze({
        id: asNumber(record.id, `${kind}.id`),
        state: asPrekeyState(record.state, `${kind}`)
      }));
    }
    return Object.freeze(out);
  }

  async loadPreKey(id: number): Promise<StoredPreKeyRecord | null> {
    return this.#loadPreKeyEntry("prekeys", id);
  }

  async savePreKey(record: StoredPreKeyRecord): Promise<void> {
    await this.#savePreKeyEntry("prekeys", record);
  }

  async deletePreKey(id: number): Promise<void> {
    await this.#delete(this.#file("prekeys", String(id)));
  }

  async listPreKeys(): Promise<readonly StoredPreKeyEntry[]> {
    return this.#listPreKeyEntries("prekeys");
  }

  async loadSignedPreKey(id: number): Promise<Uint8Array | null> {
    const record = await this.#read(this.#file("signedPrekeys", String(id)), `signedPrekeys/${id}`);
    if (!record) return null;
    return asBytes(record.record, `signedPrekeys/${id}`);
  }

  async saveSignedPreKey(id: number, serialized: Uint8Array): Promise<void> {
    await this.#write(this.#file("signedPrekeys", String(id)), {
      v: PEER_STORE_RECORD_VERSION,
      id,
      record: base64urlEncode(serialized)
    });
  }

  async deleteSignedPreKey(id: number): Promise<void> {
    await this.#delete(this.#file("signedPrekeys", String(id)));
  }

  async listSignedPreKeys(): Promise<readonly number[]> {
    const records = await this.#list("signedPrekeys");
    return Object.freeze(records.map((record) => asNumber(record.id, "signedPrekeys.id")));
  }

  async loadKyberPreKey(id: number): Promise<StoredPreKeyRecord | null> {
    return this.#loadPreKeyEntry("kyberPrekeys", id);
  }

  async saveKyberPreKey(record: StoredPreKeyRecord): Promise<void> {
    await this.#savePreKeyEntry("kyberPrekeys", record);
  }

  async deleteKyberPreKey(id: number): Promise<void> {
    await this.#delete(this.#file("kyberPrekeys", String(id)));
  }

  async listKyberPreKeys(): Promise<readonly StoredPreKeyEntry[]> {
    return this.#listPreKeyEntries("kyberPrekeys");
  }

  async loadCounters(): Promise<PeerCryptoCounters | null> {
    const record = await this.#read(this.#file("meta"), "meta");
    if (!record) return null;
    return Object.freeze({
      nextPreKeyId: asNumber(record.nextPreKeyId, "meta.nextPreKeyId"),
      nextSignedPreKeyId: asNumber(record.nextSignedPreKeyId, "meta.nextSignedPreKeyId"),
      nextKyberPreKeyId: asNumber(record.nextKyberPreKeyId, "meta.nextKyberPreKeyId")
    });
  }

  async saveCounters(counters: PeerCryptoCounters): Promise<void> {
    await this.#write(this.#file("meta"), { v: PEER_STORE_RECORD_VERSION, ...counters });
  }

  async loadPreparedOperation(): Promise<PeerCryptoPreparedOperation | null> {
    const file = path.join(this.#root, "peer-operation.json");
    const legacyFile = path.join(this.#root, "inbound-receive.json");
    const current = await this.#read(file, "peer-operation");
    if (current !== null) {
      // Validate every recovery field before removing the old source. If the
      // current journal is corrupt, the legacy source remains available.
      const operation = this.#decodePreparedOperation(current, "peerOperation", false);
      await this.#delete(legacyFile);
      return operation;
    }

    const legacy = await this.#read(legacyFile, "legacy inbound-receive");
    if (legacy === null) return null;
    const operation = this.#decodePreparedOperation(legacy, "legacyReceive", true);
    if (operation === null) return null;

    // Persist a fully validated replacement before unlinking the only
    // recoverable copy of the legacy receive operation.
    await this.#write(file, { ...legacy, kind: "receive" });
    await this.#delete(legacyFile);
    return operation;
  }

  #decodePreparedOperation(
    record: Readonly<Record<string, unknown>>,
    what: "peerOperation" | "legacyReceive",
    legacyReceive: boolean
  ): PeerCryptoPreparedOperation | null {
    if (record.v !== 1) {
      throw peerCryptoError("peer_store_error", `The ${what} journal has an unknown version.`);
    }
    if (record.state === "finalized") {
      asString(record.messageId, `${what}.messageId`);
      if (record.kind !== undefined && record.kind !== "receive" && record.kind !== "send") {
        throw peerCryptoError("peer_store_error", `The ${what} journal has an unknown direction.`);
      }
      if (!legacyReceive && record.kind !== "receive" && record.kind !== "send") {
        throw peerCryptoError("peer_store_error", `The ${what} finalized journal has no direction.`);
      }
      if (legacyReceive && record.kind !== undefined && record.kind !== "receive") {
        throw peerCryptoError("peer_store_error", "The legacy receive journal has an invalid direction.");
      }
      return null;
    }
    if (record.state !== "prepared") {
      throw peerCryptoError("peer_store_error", `The ${what} journal has an unknown state.`);
    }
    const messageId = asString(record.messageId, `${what}.messageId`);
    const preparedAt = asString(record.preparedAt, `${what}.preparedAt`);
    // Only the existing local receive journal predates a direction tag.
    const kind = record.kind === undefined && legacyReceive ? "receive" : record.kind;
    if ((kind !== "send" && kind !== "receive") || (legacyReceive && kind !== "receive")) {
      throw peerCryptoError("peer_store_error", `The ${what} journal has an unknown direction.`);
    }
    if (!Array.isArray(record.mutations)) {
      throw peerCryptoError("peer_store_error", `The ${what} journal has no mutation batch.`);
    }
    const applicationRecord = asBytes(record.applicationRecord, `${what}.applicationRecord`);
    return Object.freeze({
      version: 1,
      kind,
      messageId,
      preparedAt,
      mutations: Object.freeze(record.mutations.map((mutation, index) => asPeerCryptoMutation(mutation, `${what}.mutations[${index}]`))),
      applicationRecord
    });
  }

  async prepareOperation(operation: PeerCryptoPreparedOperation): Promise<void> {
    if (operation.version !== 1 || operation.messageId.length === 0 || operation.applicationRecord.length === 0
      || (operation.kind !== "send" && operation.kind !== "receive")) {
      throw peerCryptoError("peer_store_error", "The peer operation transaction is malformed.");
    }
    if (await this.loadPreparedOperation()) {
      throw peerCryptoError("peer_store_error", "A peer operation transaction is still awaiting recovery.");
    }
    const mutations = operation.mutations.map(serializePeerCryptoMutation);
    const record = {
      v: 1,
      state: "prepared",
      kind: operation.kind,
      messageId: operation.messageId,
      preparedAt: operation.preparedAt,
      mutations,
      applicationRecord: base64urlEncode(operation.applicationRecord)
    };
    const serialized = `${JSON.stringify(record)}\n`;
    await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(serialized, "utf8"));
    await writePrivateFileAtomic(path.join(this.#root, "peer-operation.json"), serialized);
  }

  async applyPreparedOperation(): Promise<void> {
    const operation = await this.loadPreparedOperation();
    if (!operation) return;
    for (const mutation of operation.mutations) await applyPeerCryptoMutation(this, mutation);
  }

  async finalizePreparedOperation(messageId: string, kind: PeerCryptoPreparedOperation["kind"]): Promise<void> {
    const file = path.join(this.#root, "peer-operation.json");
    const current = await this.#read(file, "peer-operation");
    if (current?.state === "finalized" && current.v === 1 && current.messageId === messageId && current.kind === kind) return;
    if (!current || current.state !== "prepared" || current.v !== 1 || current.messageId !== messageId || current.kind !== kind) {
      throw peerCryptoError("peer_store_error", "The peer operation transaction does not match its finalization identity.");
    }
    // A durable marker is used instead of unlink: after fsync+rename, a crash
    // cannot resurrect this older ratchet batch over later session writes.
    await this.#write(file, { v: 1, state: "finalized", kind, messageId });
  }
}

function asPeerCryptoMutation(value: unknown, what: string): PeerCryptoMutation {
  if (!isEntry(value)) throw peerCryptoError("peer_store_error", `The inbound receive journal mutation ${what} is malformed.`);
  const kind = value.kind;
  const operation = value.operation;
  if (kind === "identity") {
    const record = value.record;
    if (!isEntry(record) || record.version !== PEER_STORE_RECORD_VERSION) throw peerCryptoError("peer_store_error", `The inbound identity mutation ${what} is malformed.`);
    return Object.freeze({
      kind,
      record: Object.freeze({
        version: PEER_STORE_RECORD_VERSION,
        peerId: asString(record.peerId, `${what}.peerId`),
        deviceId: asNumber(record.deviceId, `${what}.deviceId`),
        registrationId: asNumber(record.registrationId, `${what}.registrationId`),
        identityKeyPair: asString(record.identityKeyPair, `${what}.identityKeyPair`),
        createdAt: asString(record.createdAt, `${what}.createdAt`)
      })
    });
  }
  if (kind === "peerBinding") {
    if (operation === "delete") return Object.freeze({ kind, operation, peerId: asString(value.peerId, `${what}.peerId`) });
    const record = value.record;
    if (operation !== "save" || !isEntry(record) || (record.state !== "active" && record.state !== "blocked")) {
      throw peerCryptoError("peer_store_error", `The inbound peer-binding mutation ${what} is malformed.`);
    }
    return Object.freeze({
      kind,
      operation,
      record: Object.freeze({
        peerId: asString(record.peerId, `${what}.peerId`),
        deviceId: asNumber(record.deviceId, `${what}.deviceId`),
        identityKey: asString(record.identityKey, `${what}.identityKey`),
        trustGeneration: asNumber(record.trustGeneration, `${what}.trustGeneration`),
        pinnedAt: asString(record.pinnedAt, `${what}.pinnedAt`),
        state: record.state
      })
    });
  }
  if (kind === "session") {
    const addressKey = asString(value.addressKey, `${what}.addressKey`);
    return operation === "save"
      ? Object.freeze({ kind, operation, addressKey, value: asBytes(value.value, `${what}.value`) })
      : operation === "delete"
        ? Object.freeze({ kind, operation, addressKey })
        : malformedReceiveMutation(what);
  }
  if (kind === "preKey" || kind === "kyberPreKey") {
    if (operation === "delete") return Object.freeze({ kind, operation, id: asNumber(value.id, `${what}.id`) });
    const record = value.record;
    if (operation !== "save" || !isEntry(record)) return malformedReceiveMutation(what);
    return Object.freeze({
      kind,
      operation,
      record: Object.freeze({
        id: asNumber(record.id, `${what}.id`),
        state: asPrekeyState(record.state, `${what}.state`),
        record: asBytes(record.record, `${what}.record`)
      })
    });
  }
  if (kind === "signedPreKey") {
    const id = asNumber(value.id, `${what}.id`);
    return operation === "save"
      ? Object.freeze({ kind, operation, id, value: asBytes(value.value, `${what}.value`) })
      : operation === "delete"
        ? Object.freeze({ kind, operation, id })
        : malformedReceiveMutation(what);
  }
  if (kind === "counters") {
    if (!isEntry(value.counters)) return malformedReceiveMutation(what);
    return Object.freeze({ kind, counters: Object.freeze({
      nextPreKeyId: asNumber(value.counters.nextPreKeyId, `${what}.nextPreKeyId`),
      nextSignedPreKeyId: asNumber(value.counters.nextSignedPreKeyId, `${what}.nextSignedPreKeyId`),
      nextKyberPreKeyId: asNumber(value.counters.nextKyberPreKeyId, `${what}.nextKyberPreKeyId`)
    }) });
  }
  return malformedReceiveMutation(what);
}

function malformedReceiveMutation(what: string): never {
  throw peerCryptoError("peer_store_error", `The peer operation journal mutation ${what} is malformed.`);
}

function serializePeerCryptoMutation(mutation: PeerCryptoMutation): Record<string, unknown> {
  switch (mutation.kind) {
    case "identity":
    case "peerBinding":
      return { ...mutation };
    case "session":
      return mutation.operation === "save"
        ? { ...mutation, value: base64urlEncode(mutation.value) }
        : { ...mutation };
    case "preKey":
    case "kyberPreKey":
      return mutation.operation === "save"
        ? { ...mutation, record: { ...mutation.record, record: base64urlEncode(mutation.record.record) } }
        : { ...mutation };
    case "signedPreKey":
      return mutation.operation === "save"
        ? { ...mutation, value: base64urlEncode(mutation.value) }
        : { ...mutation };
    case "counters":
      return { ...mutation };
  }
}

export function createFilePeerCryptoStore(rootDir: string): FilePeerCryptoStore {
  return new FilePeerCryptoStore(rootDir);
}
