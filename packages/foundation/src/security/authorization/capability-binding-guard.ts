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
} from "./capability-binding-guard-core.ts";
import {
  createRecord,
  openState,
  readRecord,
  resolveAutoBindingGuardBackend,
  writeRecord
} from "./capability-binding-guard-backends.ts";

export {
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
  capabilityBindingGuardStatePath,
  normalizeCapabilityBindingContext,
  capabilityBindingKeyHash,
  capabilityBindingSubjectHash
} from "./capability-binding-guard-core.ts";

export function createCapabilityBindingGuard({
  backend = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER || "auto",
  alias = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS || DEFAULT_ALIAS,
  dataDir = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_DATA_DIR || ""
}: Record<string, any> = {}) : any {
  const resolvedBackend: any = resolveAutoBindingGuardBackend(backend);
  const storageBackend: any = backend === "auto" ? "auto" : resolvedBackend;
  let loaded: any = false;
  let record: any = null;
  let state: any = null;
  let loadCount: any = 0;
  let saveCount: any = 0;
  let loadPromise: any = null;
  let mutationQueue: any = Promise.resolve();

  function enqueueMutation(action?: any) : any {
    const run: any = mutationQueue.catch(() : any => {}).then(async () : Promise<any> => {
      if (resolvedBackend === "memory") {
        return action();
      }
      return withPrivateFileLock(
        capabilityBindingGuardLockPath({ dataDir, alias }),
        async () : Promise<any> => {
          if (loadPromise) {
            await loadPromise.catch(() : any => {});
          }
          loaded = false;
          state = null;
          loadPromise = null;
          return action();
        }
      );
    });
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
      })().finally(() : any => {
        loadPromise = null;
      });
    }
    return loadPromise;
  }

  async function save(event: Record<string, any> = {}) : Promise<any> {
    await load();
    const timestamp: any = nowIso();
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

  async function bindCapabilityKey(input: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const rawKey: any = text(input.key || input.capabilityKey);
      if (!rawKey) {
        throw new Error("Capability binding guard requires an opaque capability key.");
      }
      await load();
      const lookupKey: any = Buffer.from(state.bindingLookupKeyBase64, "base64");
      const nextRecord: any = bindingRecordFromContext(lookupKey, {
        capabilityKey: rawKey,
        credentialId: input.credentialId,
        context: input.context || input.binding || input,
        expiresAt: input.expiresAt,
        ttlMs: input.ttlMs,
        issuedAt: input.issuedAt || nowIso(),
        status: input.status || "valid"
      });
      const timestamp: any = nowIso();
      let replacedBindingCount: any = 0;
      const currentBindings: any = state.bindings.map((item?: any) : any => {
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
          ...currentBindings.filter((item?: any) : any => !(item.keyHash === nextRecord.keyHash && item.credentialId === nextRecord.credentialId)),
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

  async function verifyCapabilityKeyBinding(input: Record<string, any> = {}) : Promise<any> {
    const rawKey: any = text(input.key || input.capabilityKey);
    if (!rawKey) {
      return { ok: false, reasonCode: "capability_key_missing" };
    }
    await waitForMutations();
    await load();
    const lookupKey: any = Buffer.from(state.bindingLookupKeyBase64, "base64");
    const keyHash: any = capabilityBindingKeyHash(lookupKey, rawKey);
    const credentialId: any = text(input.credentialId);
    const records: any = state.bindings.filter((item?: any) : any => (
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
    let lastDenied: any = null;
    for (const item of records) {
      const decision: any = matchesRecord(lookupKey, item, input.context || input.binding || input, { now: input.now || nowIso() });
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

  async function invalidateCapabilityKeyBinding({ capabilityKey = "", key = "", credentialId = "", reason = "" }: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const rawKey: any = text(key || capabilityKey);
      await load();
      const lookupKey: any = Buffer.from(state.bindingLookupKeyBase64, "base64");
      const keyHash: any = rawKey ? capabilityBindingKeyHash(lookupKey, rawKey) : "";
      const resolvedCredentialId: any = text(credentialId);
      const timestamp: any = nowIso();
      const invalidated: any[] = [];
      state = {
        ...state,
        bindings: state.bindings.map((item?: any) : any => {
          const matches: any = (keyHash && item.keyHash === keyHash) ||
            (resolvedCredentialId && item.credentialId === resolvedCredentialId);
          if (!matches || item.status !== "valid") {
            return item;
          }
          const updated: any = publicBindingRecord({
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

  async function describe() : Promise<any> {
    await waitForMutations();
    await load();
    const providerName: any = state.provider || record.provider || resolvedBackend;
    const securityMode: any = state.securityMode || record.securityMode || "";
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
      activeBindingCount: state.bindings.filter((item?: any) : any => item.status === "valid").length,
      stateRoot: state.stateRoot,
      statePath: providerName === "local-file" || securityMode === "degraded_file_fallback"
        ? capabilityBindingGuardStatePath({ dataDir, alias })
        : ""
    };
  }

  function recoveryKeyFromPassphrase(passphrase: any = "", saltBase64: any = "") : any {
    const passphraseText: any = text(passphrase);
    if (!passphraseText) {
      throw new Error("Capability binding guard recovery export requires a passphrase.");
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
        throw new Error("Unsupported capability binding guard recovery package.");
      }
      if (packageObject.kdf?.name !== "scrypt") {
        throw new Error("Unsupported capability binding guard recovery KDF.");
      }
      const saltBase64: any = text(packageObject.kdf?.saltBase64);
      if (Buffer.from(saltBase64, "base64").length < 16) {
        throw new Error("Capability binding guard recovery package requires the current KDF salt.");
      }
      const recoveryKeyBase64: any = recoveryKeyFromPassphrase(passphrase, saltBase64);
      const opened: any = openSealedJson({
        sealingKeyBase64: recoveryKeyBase64,
        sealed: packageObject.sealedRecovery
      });
      if (opened.protocolVersion !== RECOVERY_PACKAGE_VERSION) {
        throw new Error("Unsupported capability binding guard recovery payload.");
      }
      const recoveredState: any = asObject(opened.state, null);
      if (!recoveredState || Number(recoveredState.stateVersion) !== CAPABILITY_BINDING_GUARD_STATE_VERSION) {
        throw new Error("Unsupported capability binding guard recovery state version.");
      }
      if (Buffer.from(text(recoveredState.bindingLookupKeyBase64), "base64").length < 32) {
        throw new Error("Capability binding guard recovery state requires a 256-bit lookup key.");
      }
      const importedState: any = normalizeState(recoveredState);
      if (!text(packageObject.stateRoot) || importedState.stateRoot !== packageObject.stateRoot) {
        throw new Error("Capability binding guard recovery state root mismatch.");
      }
      if (Number(packageObject.epoch) !== importedState.epoch) {
        throw new Error("Capability binding guard recovery epoch mismatch.");
      }
      const targetProvider: any = record?.provider || (
        resolvedBackend === "memory"
          ? "memory"
          : resolvedBackend === "macos-keychain"
            ? "macos-keychain"
            : "local-file"
      );
      const targetSecurityMode: any = record?.securityMode || (
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
    close() : any {}
  });
}

export function createMemoryCapabilityBindingGuard(input: Record<string, any> = {}) : any {
  return createCapabilityBindingGuard({ ...input, backend: "memory" });
}
