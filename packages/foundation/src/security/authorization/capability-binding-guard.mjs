import crypto from "node:crypto";
import {
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
  CAPABILITY_BINDING_GUARD_STATE_VERSION,
  DEFAULT_ALIAS,
  RECOVERY_PACKAGE_VERSION,
  asObject,
  bindingRecordFromContext,
  capabilityBindingGuardLockPath,
  capabilityBindingGuardStatePath,
  capabilityBindingKeyHash,
  matchesRecord,
  normalizeState,
  nowIso,
  openSealedJson,
  publicBindingRecord,
  randomBase64,
  safeAlias,
  sealJson,
  text,
  withPrivateFileLock
} from "./capability-binding-guard-core.mjs";
import {
  createRecord,
  openState,
  readRecord,
  resolveAutoBindingGuardBackend,
  writeRecord
} from "./capability-binding-guard-backends.mjs";

export {
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
  capabilityBindingGuardStatePath,
  normalizeCapabilityBindingContext,
  capabilityBindingKeyHash,
  capabilityBindingSubjectHash
} from "./capability-binding-guard-core.mjs";

export function createCapabilityBindingGuard({
  backend = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER || "auto",
  alias = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS || DEFAULT_ALIAS,
  dataDir = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_DATA_DIR || ""
} = {}) {
  const resolvedBackend = resolveAutoBindingGuardBackend(backend);
  const storageBackend = backend === "auto" ? "auto" : resolvedBackend;
  let loaded = false;
  let record = null;
  let state = null;
  let loadCount = 0;
  let saveCount = 0;
  let loadPromise = null;
  let mutationQueue = Promise.resolve();

  function enqueueMutation(action) {
    const run = mutationQueue.catch(() => {}).then(async () => {
      if (resolvedBackend === "memory") {
        return action();
      }
      return withPrivateFileLock(
        capabilityBindingGuardLockPath({ dataDir, alias }),
        async () => {
          if (loadPromise) {
            await loadPromise.catch(() => {});
          }
          loaded = false;
          state = null;
          loadPromise = null;
          return action();
        }
      );
    });
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
        if (resolvedBackend === "memory") {
          record = createRecord({ alias, provider: "memory", securityMode: "memory" });
        } else {
          record = await readRecord({ backend: storageBackend, dataDir, alias });
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("Capability binding guard record is invalid.");
        }
        record.alias = safeAlias(alias);
        state = openState(record);
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
    state = normalizeState({
      ...state,
      epoch: Number(state.epoch || 1) + 1,
      updatedAt: timestamp,
      events: [
        ...(Array.isArray(state.events) ? state.events : []),
        {
          eventId: `cap_bind_event_${crypto.randomUUID()}`,
          at: timestamp,
          ...asObject(event)
        }
      ].slice(-2048)
    });
    record = {
      ...record,
      generation: state.epoch,
      sealedState: sealJson({ sealingKeyBase64: record.sealingKeyBase64, payload: state }),
      stateRoot: state.stateRoot,
      updatedAt: timestamp
    };
    if (resolvedBackend !== "memory") {
      record = await writeRecord({ backend: storageBackend, dataDir, alias }, record);
    }
    saveCount += 1;
    return state;
  }

  async function bindCapabilityKey(input = {}) {
    return enqueueMutation(async () => {
      const rawKey = text(input.key || input.capabilityKey);
      if (!rawKey) {
        throw new Error("Capability binding guard requires an opaque capability key.");
      }
      await load();
      const lookupKey = Buffer.from(state.bindingLookupKeyBase64, "base64");
      const nextRecord = bindingRecordFromContext(lookupKey, {
        capabilityKey: rawKey,
        credentialId: input.credentialId,
        context: input.context || input.binding || input,
        expiresAt: input.expiresAt,
        ttlMs: input.ttlMs,
        issuedAt: input.issuedAt || nowIso(),
        status: input.status || "valid"
      });
      const timestamp = nowIso();
      let replacedBindingCount = 0;
      const currentBindings = state.bindings.map((item) => {
        if (
          input.replaceCredential !== true ||
          item.credentialId !== nextRecord.credentialId ||
          item.status !== "valid"
        ) {
          return item;
        }
        replacedBindingCount += 1;
        return publicBindingRecord({
          ...item,
          status: "invalid",
          invalidatedAt: timestamp,
          invalidationReason: text(input.replacementReason || "credential_replaced"),
          updatedAt: timestamp
        });
      });
      state = {
        ...state,
        bindings: [
          ...currentBindings.filter((item) => !(item.keyHash === nextRecord.keyHash && item.credentialId === nextRecord.credentialId)),
          nextRecord
        ]
      };
      await save({
        action: "bind",
        keyHash: nextRecord.keyHash,
        credentialId: nextRecord.credentialId,
        bindingStrength: nextRecord.bindingStrength,
        replacedBindingCount
      });
      return {
        protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
        credentialId: nextRecord.credentialId,
        bindingId: nextRecord.bindingId,
        bindingStrength: nextRecord.bindingStrength,
        requireUser: nextRecord.requireUser,
        requireAgent: nextRecord.requireAgent,
        requireClient: nextRecord.requireClient,
        requireServer: nextRecord.requireServer,
        requirePackage: nextRecord.requirePackage,
        requireProcessKey: nextRecord.requireProcessKey,
        requireProcessPublicKey: nextRecord.requireProcessPublicKey,
        requireFingerprintId: nextRecord.requireFingerprintId,
        requireMachineInstance: nextRecord.requireMachineInstance,
        requireAppInstance: nextRecord.requireAppInstance,
        requireRuntimeInstance: nextRecord.requireRuntimeInstance,
        requireClientFingerprint: nextRecord.requireClientFingerprint,
        requireIdentityGeneration: nextRecord.requireIdentityGeneration,
        requireDefaultIdentity: nextRecord.requireDefaultIdentity,
        expiresAt: nextRecord.expiresAt,
        replacedBindingCount
      };
    });
  }

  async function verifyCapabilityKeyBinding(input = {}) {
    const rawKey = text(input.key || input.capabilityKey);
    if (!rawKey) {
      return { ok: false, reasonCode: "capability_key_missing" };
    }
    await waitForMutations();
    await load();
    const lookupKey = Buffer.from(state.bindingLookupKeyBase64, "base64");
    const keyHash = capabilityBindingKeyHash(lookupKey, rawKey);
    const credentialId = text(input.credentialId);
    const records = state.bindings.filter((item) => (
      item.keyHash === keyHash &&
      (!credentialId || item.credentialId === credentialId)
    ));
    if (records.length === 0) {
      return {
        ok: true,
        applicable: false,
        reasonCode: "capability_binding_not_registered"
      };
    }
    let lastDenied = null;
    for (const item of records) {
      const decision = matchesRecord(lookupKey, item, input.context || input.binding || input, { now: input.now || nowIso() });
      if (decision.ok) {
        return {
          ...decision,
          applicable: true
        };
      }
      lastDenied = decision;
    }
    return {
      ok: false,
      applicable: true,
      ...(lastDenied || { reasonCode: "capability_binding_denied" })
    };
  }

  async function invalidateCapabilityKeyBinding({ capabilityKey = "", key = "", credentialId = "", reason = "" } = {}) {
    return enqueueMutation(async () => {
      const rawKey = text(key || capabilityKey);
      await load();
      const lookupKey = Buffer.from(state.bindingLookupKeyBase64, "base64");
      const keyHash = rawKey ? capabilityBindingKeyHash(lookupKey, rawKey) : "";
      const resolvedCredentialId = text(credentialId);
      const timestamp = nowIso();
      const invalidated = [];
      state = {
        ...state,
        bindings: state.bindings.map((item) => {
          const matches = (keyHash && item.keyHash === keyHash) ||
            (resolvedCredentialId && item.credentialId === resolvedCredentialId);
          if (!matches || item.status !== "valid") {
            return item;
          }
          const updated = publicBindingRecord({
            ...item,
            status: "invalid",
            invalidatedAt: timestamp,
            invalidationReason: text(reason),
            updatedAt: timestamp
          });
          invalidated.push(updated);
          return updated;
        })
      };
      if (invalidated.length > 0) {
        await save({ action: "invalidate", credentialId: resolvedCredentialId, reason: text(reason), count: invalidated.length });
      }
      return invalidated;
    });
  }

  async function describe() {
    await waitForMutations();
    await load();
    const providerName = state.provider || record.provider || resolvedBackend;
    const securityMode = state.securityMode || record.securityMode || "";
    return {
      protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
      provider: providerName,
      securityMode,
      alias: safeAlias(alias),
      degraded: securityMode === "degraded_file_fallback",
      runtimeLookupLoaded: loaded,
      loadCount,
      saveCount,
      bindingCount: state.bindings.length,
      activeBindingCount: state.bindings.filter((item) => item.status === "valid").length,
      stateRoot: state.stateRoot,
      statePath: providerName === "local-file" || securityMode === "degraded_file_fallback"
        ? capabilityBindingGuardStatePath({ dataDir, alias })
        : ""
    };
  }

  function recoveryKeyFromPassphrase(passphrase = "", saltBase64 = "") {
    const passphraseText = text(passphrase);
    if (!passphraseText) {
      throw new Error("Capability binding guard recovery export requires a passphrase.");
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
        throw new Error("Unsupported capability binding guard recovery package.");
      }
      if (packageObject.kdf?.name !== "scrypt") {
        throw new Error("Unsupported capability binding guard recovery KDF.");
      }
      const saltBase64 = text(packageObject.kdf?.saltBase64);
      if (Buffer.from(saltBase64, "base64").length < 16) {
        throw new Error("Capability binding guard recovery package requires the current KDF salt.");
      }
      const recoveryKeyBase64 = recoveryKeyFromPassphrase(passphrase, saltBase64);
      const opened = openSealedJson({
        sealingKeyBase64: recoveryKeyBase64,
        sealed: packageObject.sealedRecovery
      });
      if (opened.protocolVersion !== RECOVERY_PACKAGE_VERSION) {
        throw new Error("Unsupported capability binding guard recovery payload.");
      }
      const recoveredState = asObject(opened.state, null);
      if (!recoveredState || Number(recoveredState.stateVersion) !== CAPABILITY_BINDING_GUARD_STATE_VERSION) {
        throw new Error("Unsupported capability binding guard recovery state version.");
      }
      if (Buffer.from(text(recoveredState.bindingLookupKeyBase64), "base64").length < 32) {
        throw new Error("Capability binding guard recovery state requires a 256-bit lookup key.");
      }
      const importedState = normalizeState(recoveredState);
      if (!text(packageObject.stateRoot) || importedState.stateRoot !== packageObject.stateRoot) {
        throw new Error("Capability binding guard recovery state root mismatch.");
      }
      if (Number(packageObject.epoch) !== importedState.epoch) {
        throw new Error("Capability binding guard recovery epoch mismatch.");
      }
      const targetProvider = record?.provider || (
        resolvedBackend === "memory"
          ? "memory"
          : resolvedBackend === "macos-keychain"
            ? "macos-keychain"
            : "local-file"
      );
      const targetSecurityMode = record?.securityMode || (
        targetProvider === "memory"
          ? "memory"
          : targetProvider === "macos-keychain"
            ? "keyring"
            : "degraded_file_fallback"
      );
      state = normalizeState({
        ...importedState,
        provider: targetProvider,
        securityMode: targetSecurityMode
      });
      record = record || createRecord({ alias, provider: state.provider, securityMode: state.securityMode, state });
      record = {
        ...record,
        generation: Number(state.epoch || 1),
        sealedState: sealJson({ sealingKeyBase64: record.sealingKeyBase64, payload: state }),
        stateRoot: state.stateRoot,
        updatedAt: nowIso()
      };
      loaded = true;
      if (resolvedBackend !== "memory") {
        record = await writeRecord({ backend: storageBackend, dataDir, alias }, record);
      }
      saveCount += 1;
      return {
        ok: true,
        protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
        alias: safeAlias(alias),
        epoch: state.epoch,
        stateRoot: state.stateRoot,
        provider: record.provider,
        securityMode: record.securityMode
      };
    });
  }

  return Object.freeze({
    protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
    provider: resolvedBackend,
    alias,
    bindCapabilityKey,
    verifyCapabilityKeyBinding,
    invalidateCapabilityKeyBinding,
    exportRecoveryPackage,
    importRecoveryPackage,
    describe,
    close() {}
  });
}

export function createMemoryCapabilityBindingGuard(input = {}) {
  return createCapabilityBindingGuard({ ...input, backend: "memory" });
}
