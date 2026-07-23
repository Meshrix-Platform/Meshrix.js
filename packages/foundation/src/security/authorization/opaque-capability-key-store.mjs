import crypto from "node:crypto";
import {
  detectLinuxCapabilityKernelBackends,
  readKernelRecord,
  writeKernelRecord
} from "./opaque-capability-key-backends.mjs";
import {
  DEFAULT_ALIAS,
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
  RECOVERY_PACKAGE_VERSION,
  asObject,
  capabilityKernelLockPath,
  createEmptyKernelState,
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
} from "./opaque-capability-key-core.mjs";

export function createMemoryCapabilityKeyBindingStore() {
  const records = new Map();
  const permissions = new Map();

  function put(record, capabilityHashes = []) {
    const normalized = publicKeyRecord(record);
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

  function replaceCredential(record, capabilityHashes = [], reason = "credential_replaced") {
    const normalized = publicKeyRecord(record);
    const replacedKeyHashes = new Set();
    const timestamp = nowIso();
    for (const [keyHash, existing] of records.entries()) {
      if (existing.credentialId !== normalized.credentialId || existing.status !== "valid") continue;
      replacedKeyHashes.add(keyHash);
      records.set(keyHash, publicKeyRecord({
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

  function hasCapability(keyHash = "", capabilityHashes = []) {
    return capabilityHashes.some((capabilityHash) => permissions.get(`${keyHash}:${capabilityHash}`)?.status === "valid");
  }

  function invalidate(keyHash = "", reason = "") {
    const existing = get(keyHash);
    if (!existing) {
      return null;
    }
    const updated = publicKeyRecord({
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

  function list({ includeInvalid = false } = {}) {
    const values = [...records.values()].map(publicKeyRecord);
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
} = {}) {
  let loaded = false;
  let record = null;
  let state = null;
  let loadCount = 0;
  let saveCount = 0;
  let loadPromise = null;
  let mutationQueue = Promise.resolve();

  function enqueueMutation(action) {
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
          await load();
          state = mergeKernelStates(state, hotState);
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
    return loadPromise;
  }

  async function save(event = {}) {
    await load();
    const timestamp = nowIso();
    const nextEvent = {
      eventId: `cap_event_${crypto.randomUUID()}`,
      at: timestamp,
      ...asObject(event)
    };
    state = normalizeKernelState({
      ...state,
      epoch: Number(state.epoch || 1) + 1,
      updatedAt: timestamp,
      events: [...(Array.isArray(state.events) ? state.events : []), nextEvent].slice(-2048)
    });
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

  async function put(inputRecord, capabilityHashes = []) {
    return enqueueMutation(async () => {
      await load();
      const normalized = publicKeyRecord(inputRecord);
      const records = new Map(state.records.map((item) => [item.keyHash, item]));
      records.set(normalized.keyHash, normalized);
      const permissions = new Map(state.permissions.map((item) => [`${item.keyHash}:${item.capabilityHash}`, item]));
      for (const capabilityHash of capabilityHashes) {
        permissions.set(`${normalized.keyHash}:${capabilityHash}`, {
          keyHash: normalized.keyHash,
          capabilityHash,
          status: normalized.status,
          createdAt: nowIso()
        });
      }
      state = {
        ...state,
        records: [...records.values()].map(publicKeyRecord),
        permissions: [...permissions.values()]
      };
      await save({ action: "put", keyHash: normalized.keyHash, capabilityHashCount: capabilityHashes.length });
      return normalized;
    });
  }

  async function replaceCredential(inputRecord, capabilityHashes = [], reason = "credential_replaced") {
    return enqueueMutation(async () => {
      await load();
      const normalized = publicKeyRecord(inputRecord);
      const timestamp = nowIso();
      const replacedKeyHashes = new Set();
      const records = new Map(state.records.map((item) => {
        if (item.credentialId !== normalized.credentialId || item.status !== "valid") {
          return [item.keyHash, item];
        }
        replacedKeyHashes.add(item.keyHash);
        return [item.keyHash, publicKeyRecord({
          ...item,
          status: "invalid",
          invalidatedAt: timestamp,
          invalidationReason: text(reason),
          updatedAt: timestamp
        })];
      }));
      records.set(normalized.keyHash, normalized);
      const permissions = new Map(state.permissions.map((item) => [
        `${item.keyHash}:${item.capabilityHash}`,
        replacedKeyHashes.has(item.keyHash) ? { ...item, status: "invalid" } : item
      ]));
      for (const capabilityHash of capabilityHashes) {
        permissions.set(`${normalized.keyHash}:${capabilityHash}`, {
          keyHash: normalized.keyHash,
          capabilityHash,
          status: normalized.status,
          createdAt: timestamp
        });
      }
      state = {
        ...state,
        records: [...records.values()].map(publicKeyRecord),
        permissions: [...permissions.values()]
      };
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
    await load();
    return publicKeyRecord(state.records.find((item) => item.keyHash === String(keyHash || "")) || null);
  }

  async function hasCapability(keyHash = "", capabilityHashes = []) {
    await waitForMutations();
    await load();
    if (capabilityHashes.length === 0) {
      return true;
    }
    const wanted = new Set(capabilityHashes);
    return state.permissions.some((permission) => (
      permission.keyHash === String(keyHash || "") &&
      permission.status === "valid" &&
      wanted.has(permission.capabilityHash)
    ));
  }

  async function invalidate(keyHash = "", reason = "") {
    return enqueueMutation(async () => {
      await load();
      const existing = publicKeyRecord(state.records.find((item) => item.keyHash === String(keyHash || "")) || null);
      if (!existing) {
        return null;
      }
      const updated = publicKeyRecord({
        ...existing,
        status: "invalid",
        invalidatedAt: nowIso(),
        invalidationReason: text(reason),
        updatedAt: nowIso()
      });
      state = {
        ...state,
        records: state.records.map((item) => item.keyHash === updated.keyHash ? updated : item),
        permissions: state.permissions.map((permission) => (
          permission.keyHash === updated.keyHash ? { ...permission, status: "invalid" } : permission
        ))
      };
      await save({ action: "invalidate", keyHash: updated.keyHash, reason: text(reason) });
      return updated;
    });
  }

  async function list({ includeInvalid = false } = {}) {
    await waitForMutations();
    await load();
    const values = state.records.map(publicKeyRecord);
    return includeInvalid ? values : values.filter((item) => item.status === "valid");
  }

  async function loadRuntimeLookupKeyUnlocked() {
    await load();
    if (record.__needsInitialWrite === true) {
      record.__needsInitialWrite = false;
      await save({ action: "initialize_runtime_lookup_key" });
    }
    return {
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      provider: record.provider,
      securityMode: record.securityMode,
      alias: record.alias,
      generation: Number(state.epoch || record.generation || 1),
      runtimeLookupKeyBase64: state.runtimeLookupKeyBase64
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
      await load();
      if (state.records.length > 0 || state.permissions.length > 0) {
        throw new Error("Runtime lookup key rotation is only allowed before capability bindings exist; rotate opaque capability keys instead.");
      }
      state = {
        ...state,
        runtimeLookupKeyBase64: randomBase64(32)
      };
      await save({ action: "rotate_runtime_lookup_key" });
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

  async function exportRecoveryPackage({ passphrase = "", reason = "" } = {}) {
    await waitForMutations();
    await load();
    const saltBase64 = randomBase64(16);
    const recoveryKeyBase64 = recoveryKeyFromPassphrase(passphrase, saltBase64);
    const packagePayload = {
      protocolVersion: RECOVERY_PACKAGE_VERSION,
      alias: safeAlias(alias),
      exportedAt: nowIso(),
      reason: text(reason),
      provider: record.provider,
      securityMode: record.securityMode,
      state
    };
    return {
      protocolVersion: RECOVERY_PACKAGE_VERSION,
      alias: safeAlias(alias),
      exportedAt: packagePayload.exportedAt,
      stateRoot: state.stateRoot,
      epoch: state.epoch,
      kdf: {
        name: "scrypt",
        saltBase64
      },
      sealedRecovery: sealJson({ sealingKeyBase64: recoveryKeyBase64, payload: packagePayload })
    };
  }

  async function importRecoveryPackage({ recoveryPackage = null, passphrase = "" } = {}) {
    return enqueueMutation(async () => {
      const packageObject = asObject(recoveryPackage, null);
      if (!packageObject || packageObject.protocolVersion !== RECOVERY_PACKAGE_VERSION) {
        throw new Error("Unsupported capability kernel recovery package.");
      }
      const saltBase64 = text(packageObject.kdf?.saltBase64);
      const recoveryKeyBase64 = recoveryKeyFromPassphrase(passphrase, saltBase64);
      const opened = openSealedJson({
        sealingKeyBase64: recoveryKeyBase64,
        sealed: packageObject.sealedRecovery
      });
      const importedState = normalizeKernelState(asObject(opened.state));
      const targetProvider = record?.provider || (backend === "auto" && process.platform === "darwin" ? "macos-keychain" : "local-file");
      const targetSecurityMode = record?.securityMode || (targetProvider === "macos-keychain" ? "keyring" : "degraded_file_fallback");
      state = {
        ...importedState,
        provider: targetProvider,
        securityMode: targetSecurityMode
      };
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
    await load();
    return {
      ...publicKernelRecord(record),
      loadCount,
      saveCount,
      bindingCount: state.records.length,
      permissionBindingCount: state.permissions.length,
      runtimeLookupKeyRotationSupported: state.records.length === 0 && state.permissions.length === 0,
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
