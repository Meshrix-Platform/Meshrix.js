import type {
  PeerCryptoMutation,
  PeerCryptoStore,
  PeerIdentityBinding,
  PeerIdentitySecretRecord,
  PeerCryptoCounters,
  StoredPreKeyEntry,
  StoredPreKeyRecord
} from "./store.ts";

export interface PeerCryptoTransactionOverlay {
  readonly store: PeerCryptoStore;
  mutations(): readonly PeerCryptoMutation[];
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function clonePreKey(value: StoredPreKeyRecord): StoredPreKeyRecord {
  return Object.freeze({ ...value, record: cloneBytes(value.record) });
}

function cloneMutation(value: PeerCryptoMutation): PeerCryptoMutation {
  switch (value.kind) {
    case "identity":
      return Object.freeze({ kind: "identity", record: Object.freeze({ ...value.record }) });
    case "peerBinding":
      return value.operation === "save"
        ? Object.freeze({ kind: "peerBinding", operation: "save", record: Object.freeze({ ...value.record }) })
        : Object.freeze({ kind: "peerBinding", operation: "delete", peerId: value.peerId });
    case "session":
      return value.operation === "save"
        ? Object.freeze({ kind: "session", operation: "save", addressKey: value.addressKey, value: cloneBytes(value.value) })
        : Object.freeze({ kind: "session", operation: "delete", addressKey: value.addressKey });
    case "preKey":
      return value.operation === "save"
        ? Object.freeze({ kind: "preKey", operation: "save", record: clonePreKey(value.record) })
        : Object.freeze({ kind: "preKey", operation: "delete", id: value.id });
    case "signedPreKey":
      return value.operation === "save"
        ? Object.freeze({ kind: "signedPreKey", operation: "save", id: value.id, value: cloneBytes(value.value) })
        : Object.freeze({ kind: "signedPreKey", operation: "delete", id: value.id });
    case "kyberPreKey":
      return value.operation === "save"
        ? Object.freeze({ kind: "kyberPreKey", operation: "save", record: clonePreKey(value.record) })
        : Object.freeze({ kind: "kyberPreKey", operation: "delete", id: value.id });
    case "counters":
      return Object.freeze({ kind: "counters", counters: Object.freeze({ ...value.counters }) });
  }
}

function mutationKey(mutation: PeerCryptoMutation): string {
  switch (mutation.kind) {
    case "identity": return "identity";
    case "peerBinding": return JSON.stringify(["peerBinding", mutation.operation === "save" ? mutation.record.peerId : mutation.peerId]);
    case "session": return JSON.stringify(["session", mutation.operation === "save" ? mutation.addressKey : mutation.addressKey]);
    case "preKey": return JSON.stringify(["preKey", mutation.operation === "save" ? mutation.record.id : mutation.id]);
    case "signedPreKey": return JSON.stringify(["signedPreKey", mutation.id]);
    case "kyberPreKey": return JSON.stringify(["kyberPreKey", mutation.operation === "save" ? mutation.record.id : mutation.id]);
    case "counters": return "counters";
  }
}

/**
 * Isolate libsignal store callbacks for one ratchet operation until the exact
 * inbox or outbox record can be placed in the durable operation WAL.
 */
export function createPeerCryptoTransactionOverlay(base: PeerCryptoStore): PeerCryptoTransactionOverlay {
  const writes = new Map<string, PeerCryptoMutation>();
  const stage = (mutation: PeerCryptoMutation): void => {
    const cloned = cloneMutation(mutation);
    writes.set(mutationKey(cloned), cloned);
  };
  const current = (key: string): PeerCryptoMutation | undefined => writes.get(key);

  const store = new Proxy(base, {
    get(target, property): unknown {
      if (property === "loadIdentity") return async (): Promise<PeerIdentitySecretRecord | null> => {
        const mutation = current("identity");
        return mutation?.kind === "identity" ? Object.freeze({ ...mutation.record }) : target.loadIdentity();
      };
      if (property === "saveIdentity") return async (record: PeerIdentitySecretRecord): Promise<void> => {
        stage({ kind: "identity", record });
      };
      if (property === "loadPeerBinding") return async (peerId: string): Promise<PeerIdentityBinding | null> => {
        const mutation = current(JSON.stringify(["peerBinding", peerId]));
        if (mutation?.kind === "peerBinding") return mutation.operation === "save" ? mutation.record : null;
        return target.loadPeerBinding(peerId);
      };
      if (property === "savePeerBinding") return async (record: PeerIdentityBinding): Promise<void> => {
        stage({ kind: "peerBinding", operation: "save", record });
      };
      if (property === "deletePeerBinding") return async (peerId: string): Promise<void> => {
        stage({ kind: "peerBinding", operation: "delete", peerId });
      };
      if (property === "listPeerBindings") return async (): Promise<readonly PeerIdentityBinding[]> => {
        const records = new Map((await target.listPeerBindings()).map((record) => [record.peerId, record]));
        for (const mutation of writes.values()) {
          if (mutation.kind !== "peerBinding") continue;
          if (mutation.operation === "delete") records.delete(mutation.peerId);
          else records.set(mutation.record.peerId, mutation.record);
        }
        return Object.freeze([...records.values()]);
      };
      if (property === "loadSession") return async (addressKey: string): Promise<Uint8Array | null> => {
        const mutation = current(JSON.stringify(["session", addressKey]));
        if (mutation?.kind === "session") return mutation.operation === "save" ? cloneBytes(mutation.value) : null;
        return target.loadSession(addressKey);
      };
      if (property === "saveSession") return async (addressKey: string, value: Uint8Array): Promise<void> => {
        stage({ kind: "session", operation: "save", addressKey, value });
      };
      if (property === "deleteSession") return async (addressKey: string): Promise<void> => {
        stage({ kind: "session", operation: "delete", addressKey });
      };
      if (property === "listSessionKeys") return async (): Promise<readonly string[]> => {
        const keys = new Set(await target.listSessionKeys());
        for (const mutation of writes.values()) {
          if (mutation.kind !== "session") continue;
          if (mutation.operation === "delete") keys.delete(mutation.addressKey);
          else keys.add(mutation.addressKey);
        }
        return Object.freeze([...keys]);
      };
      if (property === "loadPreKey") return async (id: number): Promise<StoredPreKeyRecord | null> => {
        const mutation = current(JSON.stringify(["preKey", id]));
        if (mutation?.kind === "preKey") return mutation.operation === "save" ? clonePreKey(mutation.record) : null;
        return target.loadPreKey(id);
      };
      if (property === "savePreKey") return async (record: StoredPreKeyRecord): Promise<void> => {
        stage({ kind: "preKey", operation: "save", record });
      };
      if (property === "deletePreKey") return async (id: number): Promise<void> => {
        stage({ kind: "preKey", operation: "delete", id });
      };
      if (property === "listPreKeys") return async (): Promise<readonly StoredPreKeyEntry[]> => {
        const records = new Map((await target.listPreKeys()).map((record) => [record.id, record.state]));
        for (const mutation of writes.values()) {
          if (mutation.kind !== "preKey") continue;
          if (mutation.operation === "delete") records.delete(mutation.id);
          else records.set(mutation.record.id, mutation.record.state);
        }
        return Object.freeze([...records].map(([id, state]) => Object.freeze({ id, state })));
      };
      if (property === "loadSignedPreKey") return async (id: number): Promise<Uint8Array | null> => {
        const mutation = current(JSON.stringify(["signedPreKey", id]));
        if (mutation?.kind === "signedPreKey") return mutation.operation === "save" ? cloneBytes(mutation.value) : null;
        return target.loadSignedPreKey(id);
      };
      if (property === "saveSignedPreKey") return async (id: number, value: Uint8Array): Promise<void> => {
        stage({ kind: "signedPreKey", operation: "save", id, value });
      };
      if (property === "deleteSignedPreKey") return async (id: number): Promise<void> => {
        stage({ kind: "signedPreKey", operation: "delete", id });
      };
      if (property === "listSignedPreKeys") return async (): Promise<readonly number[]> => {
        const ids = new Set(await target.listSignedPreKeys());
        for (const mutation of writes.values()) {
          if (mutation.kind !== "signedPreKey") continue;
          if (mutation.operation === "delete") ids.delete(mutation.id);
          else ids.add(mutation.id);
        }
        return Object.freeze([...ids]);
      };
      if (property === "loadKyberPreKey") return async (id: number): Promise<StoredPreKeyRecord | null> => {
        const mutation = current(JSON.stringify(["kyberPreKey", id]));
        if (mutation?.kind === "kyberPreKey") return mutation.operation === "save" ? clonePreKey(mutation.record) : null;
        return target.loadKyberPreKey(id);
      };
      if (property === "saveKyberPreKey") return async (record: StoredPreKeyRecord): Promise<void> => {
        stage({ kind: "kyberPreKey", operation: "save", record });
      };
      if (property === "deleteKyberPreKey") return async (id: number): Promise<void> => {
        stage({ kind: "kyberPreKey", operation: "delete", id });
      };
      if (property === "listKyberPreKeys") return async (): Promise<readonly StoredPreKeyEntry[]> => {
        const records = new Map((await target.listKyberPreKeys()).map((record) => [record.id, record.state]));
        for (const mutation of writes.values()) {
          if (mutation.kind !== "kyberPreKey") continue;
          if (mutation.operation === "delete") records.delete(mutation.id);
          else records.set(mutation.record.id, mutation.record.state);
        }
        return Object.freeze([...records].map(([id, state]) => Object.freeze({ id, state })));
      };
      if (property === "loadCounters") return async (): Promise<PeerCryptoCounters | null> => {
        const mutation = current("counters");
        return mutation?.kind === "counters" ? Object.freeze({ ...mutation.counters }) : target.loadCounters();
      };
      if (property === "saveCounters") return async (counters: PeerCryptoCounters): Promise<void> => {
        stage({ kind: "counters", counters });
      };

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as PeerCryptoStore;

  return Object.freeze({
    store,
    mutations: () => Object.freeze([...writes.values()].map(cloneMutation))
  });
}
