import crypto from "node:crypto";
import {
  detectLinuxCapabilityKernelBackends,
  readKernelRecord,
  writeKernelRecord
} from "./opaque-capability-key-backends.ts";
import {
  type CapabilityKernelRecord,
  type CapabilityKernelState,
  type CapabilityKeyRecord,
  type CapabilityPermissionRecord,
  type SealedPayload,
  type UnknownRecord,
  DEFAULT_ALIAS,
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
  RECOVERY_PACKAGE_VERSION,
  asObject,
  capabilityKernelLockPath,
  createKernelRecord,
  laterIso,
  mergeKernelStates,
  normalizeKernelState,
  nowIso,
  openSealedJson,
  publicKernelRecord,
  publicKeyRecord,
  randomBase64,
  safeAlias,
  sealJson,
  stateFromKernelRecord,
  text,
  withPrivateFileLock
} from "./opaque-capability-key-core.ts";

export interface StoreListOptions { includeInvalid?: boolean }
interface SealedStoreOptions { backend?: string; dataDir?: string; alias?: string }
export interface RecoveryExportOptions { passphrase?: string; reason?: string }
export interface RecoveryImportOptions { recoveryPackage?: unknown; passphrase?: string }

export interface CapabilityKeyBindingStore {
  put(record: CapabilityKeyRecord, capabilityHashes?: string[]): CapabilityKeyRecord | Promise<CapabilityKeyRecord>;
  replaceCredential?(record: CapabilityKeyRecord, capabilityHashes?: string[], reason?: string): CapabilityKeyRecord | Promise<CapabilityKeyRecord>;
  get(keyHash: string): CapabilityKeyRecord | null | Promise<CapabilityKeyRecord | null>;
  hasCapability(keyHash: string, capabilityHashes?: string[]): boolean | Promise<boolean>;
  invalidate(keyHash: string, reason?: string): CapabilityKeyRecord | null | Promise<CapabilityKeyRecord | null>;
  list(options?: StoreListOptions): CapabilityKeyRecord[] | Promise<CapabilityKeyRecord[]>;
  close?(): void;
  exportRecoveryPackage?(options?: RecoveryExportOptions): unknown | Promise<unknown>;
  importRecoveryPackage?(options?: RecoveryImportOptions): unknown | Promise<unknown>;
}

export interface LookupKeySource {
  loadRuntimeLookupKey(): Promise<UnknownRecord>;
  rotateRuntimeLookupKey(): Promise<UnknownRecord>;
  describe(): UnknownRecord | Promise<UnknownRecord>;
}

function requireKeyRecord(value: unknown): CapabilityKeyRecord {
  const record = publicKeyRecord(value);
  if (!record) throw new Error("Capability key record is required.");
  return record;
}

function requireSealedPayload(value: unknown): SealedPayload {
  const payload = asObject(value, null);
  if (!payload || !text(payload.algorithm) || !text(payload.nonceBase64) || !text(payload.ciphertextBase64) || !text(payload.tagBase64)) {
    throw new Error("Capability kernel recovery package has an invalid sealed payload.");
  }
  return {
    algorithm: text(payload.algorithm),
    nonceBase64: text(payload.nonceBase64),
    ciphertextBase64: text(payload.ciphertextBase64),
    tagBase64: text(payload.tagBase64)
  };
}

export function createMemoryCapabilityKeyBindingStore() {
  const records = new Map<string, CapabilityKeyRecord>();
  const permissions = new Map<string, CapabilityPermissionRecord>();

  function put(record: CapabilityKeyRecord, capabilityHashes: string[] = []) {
    const normalized = requireKeyRecord(record);
    records.set(normalized.keyHash, normalized);
    for (const capabilityHash of capabilityHashes) {
      permissions.set(`${normalized.keyHash}:${capabilityHash}`, {
        keyHash: normalized.keyHash,
        capabilityHash,
        status: normalized.status,
        createdAt: nowIso()
      });
    }
    return normalized;
  }

  function replaceCredential(record: CapabilityKeyRecord, capabilityHashes: string[] = [], reason = "credential_replaced") {
    const normalized = requireKeyRecord(record);
    const replacedKeyHashes = new Set<string>();
    const timestamp = nowIso();
    for (const [keyHash, existing] of records.entries()) {
      if (existing.credentialId !== normalized.credentialId || existing.status !== "valid") continue;
      replacedKeyHashes.add(keyHash);
      records.set(keyHash, requireKeyRecord({
        ...existing,
        status: "invalid",
        invalidatedAt: timestamp,
        invalidationReason: text(reason),
        updatedAt: timestamp
      }));
    }
    for (const [permissionKey, permission] of permissions.entries()) {
      if (replacedKeyHashes.has(permission.keyHash)) {
        permissions.set(permissionKey, { ...permission, status: "invalid" });
      }
    }
    return put(normalized, capabilityHashes);
  }

  function get(keyHash = "") {
    return publicKeyRecord(records.get(String(keyHash || "")) || null);
  }

  function hasCapability(keyHash = "", capabilityHashes: string[] = []) {
    return capabilityHashes.some((capabilityHash) => permissions.get(`${keyHash}:${capabilityHash}`)?.status === "valid");
  }

  function invalidate(keyHash = "", reason = "") {
    const existing = get(keyHash);
    if (!existing) {
      return null;
    }
    const updated = requireKeyRecord({
      ...existing,
      status: "invalid",
      invalidatedAt: nowIso(),
      invalidationReason: text(reason),
      updatedAt: nowIso()
    });
    records.set(updated.keyHash, updated);
    for (const [permissionKey, permission] of permissions.entries()) {
      if (permission.keyHash === updated.keyHash) {
        permissions.set(permissionKey, { ...permission, status: "invalid" });
      }
    }
    return updated;
  }

  function list({ includeInvalid = false }: StoreListOptions = {}) {
    const values = [...records.values()];
    return includeInvalid ? values : values.filter((record) => record.status === "valid");
  }

  return Object.freeze({
    put,
    replaceCredential,
    get,
    hasCapability,
    invalidate,
    list,
    close() {}
  });
}

export function createSealedCapabilityKernelStore({
  backend = "auto",
  dataDir = "",
  alias = DEFAULT_ALIAS
}: SealedStoreOptions = {}) {
  let loaded = false;
  let record: CapabilityKernelRecord | null = null;
  let state: CapabilityKernelState | null = null;
  let loadCount = 0;
  let saveCount = 0;
  let loadPromise: Promise<CapabilityKernelState> | null = null;
  let mutationQueue = Promise.resolve();

  function enqueueMutation<T>(action: () => T | Promise<T>): Promise<T> {
    const run = mutationQueue.catch(() => {}).then(async () => withPrivateFileLock(
      capabilityKernelLockPath({ dataDir, alias }),
      async () => {
        const hotState = loaded && state ? state : null;
        if (loadPromise) {
          await loadPromise.catch(() => {});
        }
        loaded = false;
        state = null;
        loadPromise = null;
        if (hotState) {
          const persistedState = await load();
          state = mergeKernelStates(persistedState, hotState);
          if (!record) throw new Error("Capability kernel record is not loaded.");
          record = {
            ...record,
            generation: Number(state.epoch || record?.generation || 1),
            stateRoot: state.stateRoot,
            updatedAt: laterIso(record?.updatedAt, state.updatedAt)
          };
          loaded = true;
        }
        return action();
      }
    ));
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function waitForMutations() {
    await mutationQueue.catch(() => {});
  }

  async function load() {
    if (loaded) {
      if (!state) throw new Error("Capability kernel state is not loaded.");
      return state;
    }
    if (!loadPromise) {
      loadPromise = (async () => {
        record = await readKernelRecord({ backend, dataDir, alias });
        record.alias = safeAlias(alias);
        if (!record.sealingKeyBase64 || !record.sealedState) {
          record = createKernelRecord({
            alias,
            provider: record.provider || (backend === "auto" && process.platform === "darwin" ? "macos-keychain" : "local-file"),
            securityMode: record.securityMode || (record.provider === "macos-keychain" ? "keyring" : "degraded_file_fallback")
          });
          record = await writeKernelRecord({ backend, dataDir, alias }, record);
        }
        state = stateFromKernelRecord(record);
        loaded = true;
        loadCount += 1;
        return state;
      })().finally(() => {
        loadPromise = null;
      });
    }
    if (!loadPromise) throw new Error("Capability kernel load did not start.");
    return loadPromise;
  }

  async function save(event: UnknownRecord = {}) {
    const currentState = await load();
    const timestamp = nowIso();
    const nextEvent: UnknownRecord = {
      eventId: `cap_event_${crypto.randomUUID()}`,
      at: timestamp,
      ...asObject(event)
    };
    state = normalizeKernelState({
      ...currentState,
      epoch: Number(currentState.epoch || 1) + 1,
      updatedAt: timestamp,
      events: [...currentState.events, nextEvent].slice(-2048)
    });
    if (!record) throw new Error("Capability kernel record is not loaded.");
    record = {
      ...record,
      generation: state.epoch,
      sealedState: sealJson({ sealingKeyBase64: record.sealingKeyBase64, payload: state }),
      stateRoot: state.stateRoot,
      updatedAt: timestamp
    };
    record = await writeKernelRecord({ backend, dataDir, alias }, record);
    saveCount += 1;
    return state;
  }

  async function put(inputRecord: CapabilityKeyRecord, capabilityHashes: string[] = []) {
    return enqueueMutation(async () => {
      const currentState = await load();
      const normalized = requireKeyRecord(inputRecord);
      const records = new Map(currentState.records.map((item) => [item.keyHash, item]));
      records.set(normalized.keyHash, normalized);
      const permissions = new Map(currentState.permissions.map((item) => [`${item.keyHash}:${item.capabilityHash}`, item]));
      for (const capabilityHash of capabilityHashes) {
        permissions.set(`${normalized.keyHash}:${capabilityHash}`, {
          keyHash: normalized.keyHash,
          capabilityHash,
          status: normalized.status,
          createdAt: nowIso()
        });
      }
      state = normalizeKernelState({
        ...currentState,
        records: [...records.values()],
        permissions: [...permissions.values()]
      });
      await save({ action: "put", keyHash: normalized.keyHash, capabilityHashCount: capabilityHashes.length });
      return normalized;
    });
  }

  async function replaceCredential(inputRecord: CapabilityKeyRecord, capabilityHashes: string[] = [], reason = "credential_replaced") {
    return enqueueMutation(async () => {
      const currentState = await load();
      const normalized = requireKeyRecord(inputRecord);
      const timestamp = nowIso();
      const replacedKeyHashes = new Set<string>();
      const records = new Map(currentState.records.map((item) => {
        if (item.credentialId !== normalized.credentialId || item.status !== "valid") {
          return [item.keyHash, item];
        }
        replacedKeyHashes.add(item.keyHash);
        return [item.keyHash, requireKeyRecord({
          ...item,
          status: "invalid",
          invalidatedAt: timestamp,
          invalidationReason: text(reason),
          updatedAt: timestamp
        })];
      }));
      records.set(normalized.keyHash, normalized);
      const permissions = new Map(currentState.permissions.map((item) => [
        `${item.keyHash}:${item.capabilityHash}`,
        replacedKeyHashes.has(item.keyHash) ? { ...item, status: "invalid" as const } : item
      ]));
      for (const capabilityHash of capabilityHashes) {
        permissions.set(`${normalized.keyHash}:${capabilityHash}`, {
          keyHash: normalized.keyHash,
          capabilityHash,
          status: normalized.status,
          createdAt: timestamp
        });
      }
      state = normalizeKernelState({
        ...currentState,
        records: [...records.values()],
        permissions: [...permissions.values()]
      });
      await save({
        action: "replace-credential",
        credentialId: normalized.credentialId,
        keyHash: normalized.keyHash,
        replacedKeyCount: replacedKeyHashes.size,
        capabilityHashCount: capabilityHashes.length
      });
      return normalized;
    });
  }

  async function get(keyHash = "") {
    await waitForMutations();
    const currentState = await load();
    return publicKeyRecord(currentState.records.find((item) => item.keyHash === String(keyHash || "")) || null);
  }

  async function hasCapability(keyHash = "", capabilityHashes: string[] = []) {
    await waitForMutations();
    const currentState = await load();
    if (capabilityHashes.length === 0) {
      return true;
    }
    const wanted = new Set(capabilityHashes);
    return currentState.permissions.some((permission) => (
      permission.keyHash === String(keyHash || "") &&
      permission.status === "valid" &&
      wanted.has(permission.capabilityHash)
    ));
  }

  async function invalidate(keyHash = "", reason = "") {
    return enqueueMutation(async () => {
      const currentState = await load();
      const existing = publicKeyRecord(currentState.records.find((item) => item.keyHash === String(keyHash || "")) || null);
      if (!existing) {
        return null;
      }
      const updated = requireKeyRecord({
        ...existing,
        status: "invalid",
        invalidatedAt: nowIso(),
        invalidationReason: text(reason),
        updatedAt: nowIso()
      });
      state = normalizeKernelState({
        ...currentState,
        records: currentState.records.map((item) => item.keyHash === updated.keyHash ? updated : item),
        permissions: currentState.permissions.map((permission) => (
          permission.keyHash === updated.keyHash ? { ...permission, status: "invalid" as const } : permission
        ))
      });
      await save({ action: "invalidate", keyHash: updated.keyHash, reason: text(reason) });
      return updated;
    });
  }

  async function list({ includeInvalid = false }: StoreListOptions = {}) {
    await waitForMutations();
    const currentState = await load();
    const values = currentState.records;
    return includeInvalid ? values : values.filter((item) => item.status === "valid");
  }

  async function loadRuntimeLookupKeyUnlocked() {
    const currentState = await load();
    if (!record) throw new Error("Capability kernel record is not loaded.");
    if (record.__needsInitialWrite === true) {
      record.__needsInitialWrite = false;
      await save({ action: "initialize_runtime_lookup_key" });
    }
    return {
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      provider: record.provider,
      securityMode: record.securityMode,
      alias: record.alias,
      generation: Number(currentState.epoch || record.generation || 1),
      runtimeLookupKeyBase64: currentState.runtimeLookupKeyBase64
    };
  }

  async function loadRuntimeLookupKey() {
    if (!loaded || record?.__needsInitialWrite === true) {
      return enqueueMutation(loadRuntimeLookupKeyUnlocked);
    }
    await waitForMutations();
    return loadRuntimeLookupKeyUnlocked();
  }

  async function rotateRuntimeLookupKey() {
    return enqueueMutation(async () => {
      const currentState = await load();
      if (currentState.records.length > 0 || currentState.permissions.length > 0) {
        throw new Error("Runtime lookup key rotation is only allowed before capability bindings exist; rotate opaque capability keys instead.");
      }
      state = normalizeKernelState({
        ...currentState,
        runtimeLookupKeyBase64: randomBase64(32)
      });
      await save({ action: "rotate_runtime_lookup_key" });
      if (!record) throw new Error("Capability kernel record is not loaded.");
      return publicKernelRecord(record);
    });
  }

  function recoveryKeyFromPassphrase(passphrase = "", saltBase64 = "") {
    const passphraseText = text(passphrase);
    if (!passphraseText) {
      throw new Error("Capability kernel recovery export requires a passphrase.");
    }
    return crypto.scryptSync(passphraseText, Buffer.from(saltBase64, "base64"), 32).toString("base64");
  }

  async function exportRecoveryPackage({ passphrase = "", reason = "" }: RecoveryExportOptions = {}) {
    await waitForMutations();
    const currentState = await load();
    if (!record) throw new Error("Capability kernel record is not loaded.");
    const saltBase64 = randomBase64(16);
    const recoveryKeyBase64 = recoveryKeyFromPassphrase(passphrase, saltBase64);
    const packagePayload: UnknownRecord = {
      protocolVersion: RECOVERY_PACKAGE_VERSION,
      alias: safeAlias(alias),
      exportedAt: nowIso(),
      reason: text(reason),
      provider: record.provider,
      securityMode: record.securityMode,
      state: currentState
    };
    return {
      protocolVersion: RECOVERY_PACKAGE_VERSION,
      alias: safeAlias(alias),
      exportedAt: packagePayload.exportedAt,
      stateRoot: currentState.stateRoot,
      epoch: currentState.epoch,
      kdf: {
        name: "scrypt",
        saltBase64
      },
      sealedRecovery: sealJson({ sealingKeyBase64: recoveryKeyBase64, payload: packagePayload })
    };
  }

  async function importRecoveryPackage({ recoveryPackage = null, passphrase = "" }: RecoveryImportOptions = {}) {
    return enqueueMutation(async () => {
      const packageObject = asObject(recoveryPackage, null);
      if (!packageObject || packageObject.protocolVersion !== RECOVERY_PACKAGE_VERSION) {
        throw new Error("Unsupported capability kernel recovery package.");
      }
      const saltBase64 = text(asObject(packageObject.kdf).saltBase64);
      const recoveryKeyBase64 = recoveryKeyFromPassphrase(passphrase, saltBase64);
      const opened = openSealedJson({
        sealingKeyBase64: recoveryKeyBase64,
        sealed: requireSealedPayload(packageObject.sealedRecovery)
      });
      const importedState = normalizeKernelState(asObject(opened.state));
      const targetProvider = record?.provider || (backend === "auto" && process.platform === "darwin" ? "macos-keychain" : "local-file");
      const targetSecurityMode = record?.securityMode || (targetProvider === "macos-keychain" ? "keyring" : "degraded_file_fallback");
      state = normalizeKernelState({
        ...importedState,
        provider: targetProvider,
        securityMode: targetSecurityMode
      });
      record = record || createKernelRecord({ alias, provider: state.provider, securityMode: state.securityMode, state });
      record = {
        ...record,
        generation: Number(state.epoch || 1),
        sealedState: sealJson({ sealingKeyBase64: record.sealingKeyBase64, payload: state }),
        stateRoot: state.stateRoot,
        updatedAt: nowIso()
      };
      loaded = true;
      record = await writeKernelRecord({ backend, dataDir, alias }, record);
      saveCount += 1;
      return {
        ok: true,
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        alias: safeAlias(alias),
        epoch: state.epoch,
        stateRoot: state.stateRoot,
        provider: record.provider,
        securityMode: record.securityMode
      };
    });
  }

  async function describe() {
    await waitForMutations();
    const currentState = await load();
    if (!record) throw new Error("Capability kernel record is not loaded.");
    return {
      ...publicKernelRecord(record),
      loadCount,
      saveCount,
      bindingCount: currentState.records.length,
      permissionBindingCount: currentState.permissions.length,
      runtimeLookupKeyRotationSupported: currentState.records.length === 0 && currentState.permissions.length === 0,
      linuxDetectedBackends: detectLinuxCapabilityKernelBackends()
    };
  }

  return Object.freeze({
    put,
    replaceCredential,
    get,
    hasCapability,
    invalidate,
    list,
    close() {},
    keySource: {
      loadRuntimeLookupKey,
      rotateRuntimeLookupKey,
      describe
    },
    exportRecoveryPackage,
    importRecoveryPackage,
    describe
  });
}
