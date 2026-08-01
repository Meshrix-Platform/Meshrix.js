import crypto from "node:crypto";
import {
  detectLinuxCapabilityKernelBackends,
  readKernelRecord,
  writeKernelRecord
} from "./opaque-capability-key-backends.ts";
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
} from "./opaque-capability-key-core.ts";

export function createMemoryCapabilityKeyBindingStore() : any {
  const records: any = new Map<any, any>();
  const permissions: any = new Map<any, any>();

  function put(record?: any, capabilityHashes: any = []) : any {
    const normalized: any = publicKeyRecord(record);
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

  function replaceCredential(record?: any, capabilityHashes: any = [], reason: any = "credential_replaced") : any {
    const normalized: any = publicKeyRecord(record);
    const replacedKeyHashes: any = new Set<any>();
    const timestamp: any = nowIso();
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

  function get(keyHash: any = "") : any {
    return publicKeyRecord(records.get(String(keyHash || "")) || null);
  }

  function hasCapability(keyHash: any = "", capabilityHashes: any = []) : any {
    return capabilityHashes.some((capabilityHash?: any) : any => permissions.get(`${keyHash}:${capabilityHash}`)?.status === "valid");
  }

  function invalidate(keyHash: any = "", reason: any = "") : any {
    const existing: any = get(keyHash);
    if (!existing) {
      return null;
    }
    const updated: any = publicKeyRecord({
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

  function list({ includeInvalid = false }: Record<string, any> = {}) : any {
    const values: any = [...records.values()].map(publicKeyRecord);
    return includeInvalid ? values : values.filter((record?: any) : any => record.status === "valid");
  }

  return Object.freeze({
    put,
    replaceCredential,
    get,
    hasCapability,
    invalidate,
    list,
    close() : any {}
  });
}

export function createSealedCapabilityKernelStore({
  backend = "auto",
  dataDir = "",
  alias = DEFAULT_ALIAS
}: Record<string, any> = {}) : any {
  let loaded: any = false;
  let record: any = null;
  let state: any = null;
  let loadCount: any = 0;
  let saveCount: any = 0;
  let loadPromise: any = null;
  let mutationQueue: any = Promise.resolve();

  function enqueueMutation(action?: any) : any {
    const run: any = mutationQueue.catch(() : any => {}).then(async () : Promise<any> => withPrivateFileLock(
      capabilityKernelLockPath({ dataDir, alias }),
      async () : Promise<any> => {
        const hotState: any = loaded && state ? state : null;
        if (loadPromise) {
          await loadPromise.catch(() : any => {});
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
    mutationQueue = run.then(() : any => undefined, () : any => undefined);
    return run;
  }

  async function waitForMutations() : Promise<any> {
    await mutationQueue.catch(() : any => {});
  }

  async function load() : Promise<any> {
    if (loaded) {
      return state;
    }
    if (!loadPromise) {
      loadPromise = (async () : Promise<any> => {
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
      })().finally(() : any => {
        loadPromise = null;
      });
    }
    return loadPromise;
  }

  async function save(event: Record<string, any> = {}) : Promise<any> {
    await load();
    const timestamp: any = nowIso();
    const nextEvent: Record<string, any> = {
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

  async function put(inputRecord?: any, capabilityHashes: any = []) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      await load();
      const normalized: any = publicKeyRecord(inputRecord);
      const records: any = new Map<any, any>(state.records.map((item?: any) : any => [item.keyHash, item]));
      records.set(normalized.keyHash, normalized);
      const permissions: any = new Map<any, any>(state.permissions.map((item?: any) : any => [`${item.keyHash}:${item.capabilityHash}`, item]));
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

  async function replaceCredential(inputRecord?: any, capabilityHashes: any = [], reason: any = "credential_replaced") : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      await load();
      const normalized: any = publicKeyRecord(inputRecord);
      const timestamp: any = nowIso();
      const replacedKeyHashes: any = new Set<any>();
      const records: any = new Map<any, any>(state.records.map((item?: any) : any => {
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
      const permissions: any = new Map<any, any>(state.permissions.map((item?: any) : any => [
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

  async function get(keyHash: any = "") : Promise<any> {
    await waitForMutations();
    await load();
    return publicKeyRecord(state.records.find((item?: any) : any => item.keyHash === String(keyHash || "")) || null);
  }

  async function hasCapability(keyHash: any = "", capabilityHashes: any = []) : Promise<any> {
    await waitForMutations();
    await load();
    if (capabilityHashes.length === 0) {
      return true;
    }
    const wanted: any = new Set<any>(capabilityHashes);
    return state.permissions.some((permission?: any) : any => (
      permission.keyHash === String(keyHash || "") &&
      permission.status === "valid" &&
      wanted.has(permission.capabilityHash)
    ));
  }

  async function invalidate(keyHash: any = "", reason: any = "") : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      await load();
      const existing: any = publicKeyRecord(state.records.find((item?: any) : any => item.keyHash === String(keyHash || "")) || null);
      if (!existing) {
        return null;
      }
      const updated: any = publicKeyRecord({
        ...existing,
        status: "invalid",
        invalidatedAt: nowIso(),
        invalidationReason: text(reason),
        updatedAt: nowIso()
      });
      state = {
        ...state,
        records: state.records.map((item?: any) : any => item.keyHash === updated.keyHash ? updated : item),
        permissions: state.permissions.map((permission?: any) : any => (
          permission.keyHash === updated.keyHash ? { ...permission, status: "invalid" } : permission
        ))
      };
      await save({ action: "invalidate", keyHash: updated.keyHash, reason: text(reason) });
      return updated;
    });
  }

  async function list({ includeInvalid = false }: Record<string, any> = {}) : Promise<any> {
    await waitForMutations();
    await load();
    const values: any = state.records.map(publicKeyRecord);
    return includeInvalid ? values : values.filter((item?: any) : any => item.status === "valid");
  }

  async function loadRuntimeLookupKeyUnlocked() : Promise<any> {
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

  async function loadRuntimeLookupKey() : Promise<any> {
    if (!loaded || record?.__needsInitialWrite === true) {
      return enqueueMutation(loadRuntimeLookupKeyUnlocked);
    }
    await waitForMutations();
    return loadRuntimeLookupKeyUnlocked();
  }

  async function rotateRuntimeLookupKey() : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
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

  function recoveryKeyFromPassphrase(passphrase: any = "", saltBase64: any = "") : any {
    const passphraseText: any = text(passphrase);
    if (!passphraseText) {
      throw new Error("Capability kernel recovery export requires a passphrase.");
    }
    return crypto.scryptSync(passphraseText, Buffer.from(saltBase64, "base64"), 32).toString("base64");
  }

  async function exportRecoveryPackage({ passphrase = "", reason = "" }: Record<string, any> = {}) : Promise<any> {
    await waitForMutations();
    await load();
    const saltBase64: any = randomBase64(16);
    const recoveryKeyBase64: any = recoveryKeyFromPassphrase(passphrase, saltBase64);
    const packagePayload: Record<string, any> = {
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

  async function importRecoveryPackage({ recoveryPackage = null, passphrase = "" }: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const packageObject: any = asObject(recoveryPackage, null);
      if (!packageObject || packageObject.protocolVersion !== RECOVERY_PACKAGE_VERSION) {
        throw new Error("Unsupported capability kernel recovery package.");
      }
      const saltBase64: any = text(packageObject.kdf?.saltBase64);
      const recoveryKeyBase64: any = recoveryKeyFromPassphrase(passphrase, saltBase64);
      const opened: any = openSealedJson({
        sealingKeyBase64: recoveryKeyBase64,
        sealed: packageObject.sealedRecovery
      });
      const importedState: any = normalizeKernelState(asObject(opened.state));
      const targetProvider: any = record?.provider || (backend === "auto" && process.platform === "darwin" ? "macos-keychain" : "local-file");
      const targetSecurityMode: any = record?.securityMode || (targetProvider === "macos-keychain" ? "keyring" : "degraded_file_fallback");
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

  async function describe() : Promise<any> {
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
    close() : any {},
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
