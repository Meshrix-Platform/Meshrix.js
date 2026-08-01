import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolveAutoCapabilityKernelBackend } from "./opaque-capability-key-backends.ts";
import {
  DEFAULT_ALIAS,
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
  canonicalOpaqueCapabilities,
  capabilityKeyHash,
  capabilityPermissionHash,
  candidateCapabilitiesFor,
  createCapabilityKey,
  createKeyRecord,
  helperScriptPath,
  isClosedPipeError,
  nowIso,
  rejectUnknownOpaqueCapabilities,
  text,
  validateKeyRecord
} from "./opaque-capability-key-core.ts";
import {
  normalizeRegisteredToolCapabilities,
  unknownKernelCapabilities
} from "#meshrix/authorization-engine";
import {
  createMemoryCapabilityKeyBindingStore,
  createSealedCapabilityKernelStore
} from "./opaque-capability-key-store.ts";

function runCommandJson({ command, args = [], env = {}, input = {}, timeoutMs = 15000 }: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    let stdout: any = "";
    let stderr: any = "";
    const timeout: any = setTimeout(() : any => {
      child.kill("SIGTERM");
      reject(new Error(`Opaque capability key helper timed out: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString();
    });
    child.on("error", (error?: any) : any => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", (error?: any) : any => {
      if (isClosedPipeError(error)) {
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code?: any) : any => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Opaque capability key helper failed with exit code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error: any) {
        reject(new Error(`Opaque capability key helper returned invalid JSON: ${error.message}`));
      }
    });
    try {
      child.stdin.end(`${JSON.stringify(input)}\n`);
    } catch (error: any) {
      if (!isClosedPipeError(error)) {
        clearTimeout(timeout);
        reject(error);
      }
    }
  });
}

function createMemoryLookupKeySource() : any {
  let generation: any = 1;
  let runtimeLookupKeyBase64: any = crypto.randomBytes(32).toString("base64");
  let loadCount: any = 0;
  return {
    async loadRuntimeLookupKey() : Promise<any> {
      loadCount += 1;
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        provider: "memory",
        generation,
        runtimeLookupKeyBase64
      };
    },
    async rotateRuntimeLookupKey() : Promise<any> {
      generation += 1;
      runtimeLookupKeyBase64 = crypto.randomBytes(32).toString("base64");
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        provider: "memory",
        generation
      };
    },
    describe() : any {
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        provider: "memory",
        generation,
        loadCount
      };
    }
  };
}

function createCommandLookupKeySource({
  alias = DEFAULT_ALIAS,
  backend = process.platform === "darwin" ? "macos-keychain" : "local-file",
  dataDir = "",
  command = process.execPath,
  args = [helperScriptPath()],
  env = {},
  timeoutMs = 15000
}: Record<string, any> = {}) : any {
  async function request(action?: any, input: Record<string, any> = {}) : Promise<any> {
    return runCommandJson({
      command,
      args,
      env,
      timeoutMs,
      input: {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        action,
        backend,
        alias,
        dataDir,
        ...input
      }
    });
  }
  return {
    loadRuntimeLookupKey: () : any => request("loadRuntimeLookupKey"),
    rotateRuntimeLookupKey: () : any => request("rotateRuntimeLookupKey"),
    describe: () : any => request("describe")
  };
}

export function createOpaqueCapabilityKeyProvider({
  backend = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER || "auto",
  alias = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS || DEFAULT_ALIAS,
  dataDir = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_DATA_DIR || "",
  bindingStore = null,
  lookupKeySource = null,
  command = "",
  args = [],
  env = {}
}: Record<string, any> = {}) : any {
  const resolvedBackend: any = resolveAutoCapabilityKernelBackend(backend);
  const storageBackend: any = backend === "auto" ? "auto" : resolvedBackend;
  const sealedKernel: any = !bindingStore && resolvedBackend !== "memory"
    ? createSealedCapabilityKernelStore({ backend: storageBackend, dataDir, alias })
    : null;
  const store: any = bindingStore ||
    sealedKernel ||
    createMemoryCapabilityKeyBindingStore();
  const keySource: any = lookupKeySource ||
    sealedKernel?.keySource ||
    (resolvedBackend === "memory"
      ? createMemoryLookupKeySource()
      : createCommandLookupKeySource({
          alias,
          backend: ["macos-keychain", "local-file"].includes(resolvedBackend) ? resolvedBackend : "external-command",
          dataDir,
          command: command || process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_COMMAND || process.execPath,
          args: args.length
            ? args
            : command || process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_COMMAND
            ? String(process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ARGS || "").split(/\s+/).filter(Boolean)
            : [helperScriptPath()],
          env
        }));
  let runtimeLookupKey: any = null;
  let runtimeLookupGeneration: any = 0;
  let runtimeLookupLoadCount: any = 0;
  let providerMutationQueue: any = Promise.resolve();

  function enqueueProviderMutation(action?: any) : any {
    const run: any = providerMutationQueue.catch(() : any => {}).then(action);
    providerMutationQueue = run.then(() : any => undefined, () : any => undefined);
    return run;
  }

  async function waitForProviderMutations() : Promise<any> {
    await providerMutationQueue.catch(() : any => {});
  }

  async function getRuntimeLookupKey() : Promise<any> {
    if (!runtimeLookupKey) {
      const loaded: any = await keySource.loadRuntimeLookupKey();
      runtimeLookupKey = Buffer.from(String(loaded.runtimeLookupKeyBase64 || ""), "base64");
      runtimeLookupGeneration = Number(loaded.generation || 0);
      runtimeLookupLoadCount += 1;
      if (runtimeLookupKey.length < 32) {
        throw new Error("Runtime lookup key helper returned an invalid key.");
      }
    }
    return runtimeLookupKey;
  }

  async function issue({
    capabilityKey = createCapabilityKey(),
    key = "",
    capabilities = [],
    trustedCapabilityPermissions = [],
    replaceCredential = false,
    replacementReason = "credential_replaced",
    ...input
  }: Record<string, any> = {}) : Promise<any> {
    return enqueueProviderMutation(async () : Promise<any> => {
      const rawKey: any = text(key || capabilityKey);
      rejectUnknownOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const lookupKey: any = await getRuntimeLookupKey();
      const keyHash: any = capabilityKeyHash(lookupKey, rawKey);
      const normalizedCapabilities: any = canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const record: any = createKeyRecord({
        ...input,
        keyHash,
        capabilities: normalizedCapabilities,
        trustedCapabilityPermissions: normalizedCapabilities
      });
      const capabilityHashes: any = normalizedCapabilities.map((capability?: any) : any => capabilityPermissionHash(lookupKey, capability));
      if (replaceCredential === true) {
        if (typeof store.replaceCredential !== "function") {
          throw new Error("Capability key store does not support atomic credential replacement.");
        }
        await store.replaceCredential(record, capabilityHashes, replacementReason);
      } else {
        await store.put(record, capabilityHashes);
      }
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        capabilityKey: rawKey,
        credentialId: record.credentialId,
        status: record.status,
        capabilitySetHash: record.capabilitySetHash,
        capabilityCount: record.capabilityCount,
        expiresAt: record.expiresAt,
        runtimeLookupGeneration
      };
    });
  }

  async function verify({
    capabilityKey = "",
    key = "",
    requiredCapability = "",
    requiredCapabilities = [],
    now = nowIso(),
    minGrantVersion = 0,
    includeRecordDetails = false
  }: Record<string, any> = {}) : Promise<any> {
    const rawKey: any = text(key || capabilityKey);
    if (!rawKey) {
      return { ok: false, reasonCode: "capability_key_missing" };
    }
    await waitForProviderMutations();
    const requestedCapabilities: any = requiredCapability ? [requiredCapability] : requiredCapabilities;
    const registeredToolCapabilities: any = normalizeRegisteredToolCapabilities(requestedCapabilities);
    const trustedRegisteredToolCapabilities: any = new Set<any>(registeredToolCapabilities);
    const unknownRequired: any = unknownKernelCapabilities(requestedCapabilities)
      .filter((capability?: any) : any => !trustedRegisteredToolCapabilities.has(capability));
    if (unknownRequired.length > 0) {
      return {
        ok: false,
        reasonCode: "unknown_capability",
        unknownCapabilities: unknownRequired,
        keyHash: "",
        runtimeLookupGeneration
      };
    }
    const required: any = canonicalOpaqueCapabilities(requestedCapabilities, registeredToolCapabilities);
    if (required.length === 0) {
      return { ok: false, reasonCode: "capability_required" };
    }
    const lookupKey: any = await getRuntimeLookupKey();
    const keyHash: any = capabilityKeyHash(lookupKey, rawKey);
    const recordCheck: any = validateKeyRecord(await store.get(keyHash), { now, minGrantVersion });
    if (!recordCheck.ok) {
      return { ...recordCheck, keyHash: "", runtimeLookupGeneration };
    }
    const missingCapabilities: any[] = [];
    for (const capability of required) {
      const candidateHashes: any = candidateCapabilitiesFor(capability)
        .map((candidate?: any) : any => capabilityPermissionHash(lookupKey, candidate));
      if (!(await store.hasCapability(keyHash, candidateHashes))) {
        missingCapabilities.push(capability);
      }
    }
    if (missingCapabilities.length > 0) {
      return {
        ok: false,
        reasonCode: "missing_capabilities",
        credentialId: recordCheck.record.credentialId,
        missingCapabilities,
        keyHash: "",
        runtimeLookupGeneration
      };
    }
    const decision: Record<string, any> = {
      ok: true,
      reasonCode: "capability_key_valid",
      credentialId: recordCheck.record.credentialId,
      requiredCapabilities: required,
      missingCapabilities: [],
      expiresAt: recordCheck.record.expiresAt,
      runtimeLookupGeneration
    };
    if (includeRecordDetails === true) {
      return {
        ...decision,
        keyHash,
        capabilitySetHash: recordCheck.record.capabilitySetHash,
        capabilityCount: recordCheck.record.capabilityCount,
        grantVersion: recordCheck.record.grantVersion,
        constraints: recordCheck.record.constraints,
        metadata: recordCheck.record.metadata
      };
    }
    return decision;
  }

  async function invalidate({ capabilityKey = "", key = "", reason = "" }: Record<string, any> = {}) : Promise<any> {
    return enqueueProviderMutation(async () : Promise<any> => {
      const rawKey: any = text(key || capabilityKey);
      if (!rawKey) {
        return null;
      }
      const lookupKey: any = await getRuntimeLookupKey();
      const keyHash: any = capabilityKeyHash(lookupKey, rawKey);
      return store.invalidate(keyHash, reason);
    });
  }

  async function invalidateCredential({ credentialId = "", reason = "" }: Record<string, any> = {}) : Promise<any> {
    return enqueueProviderMutation(async () : Promise<any> => {
      const resolvedCredentialId: any = text(credentialId);
      if (!resolvedCredentialId) {
        return [];
      }
      const records: any = await store.list({ includeInvalid: false });
      const invalidated: any[] = [];
      for (const record of records) {
        if (record.credentialId !== resolvedCredentialId) {
          continue;
        }
        const updated: any = await store.invalidate(record.keyHash, reason);
        if (updated) {
          invalidated.push(updated);
        }
      }
      return invalidated;
    });
  }

  async function rotateCapabilityKey({ capabilityKey = "", key = "", capabilities = [], trustedCapabilityPermissions = [], reason = "rotated", ...input }: Record<string, any> = {}) : Promise<any> {
    return enqueueProviderMutation(async () : Promise<any> => {
      const rawKey: any = text(key || capabilityKey);
      const lookupKey: any = await getRuntimeLookupKey();
      const oldHash: any = capabilityKeyHash(lookupKey, rawKey);
      const existing: any = await store.get(oldHash);
      if (!existing || existing.status !== "valid") {
        return { ok: false, reasonCode: "capability_key_invalid" };
      }
      rejectUnknownOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const normalizedCapabilities: any = canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      if (normalizedCapabilities.length === 0) {
        return { ok: false, reasonCode: "capabilities_required_for_rotation" };
      }
      await store.invalidate(oldHash, reason);
      const newCapabilityKey: any = createCapabilityKey();
      const newHash: any = capabilityKeyHash(lookupKey, newCapabilityKey);
      const newRecord: any = createKeyRecord({
        ...existing,
        ...input,
        keyHash: newHash,
        capabilities: normalizedCapabilities,
        trustedCapabilityPermissions: normalizedCapabilities,
        status: "valid",
        issuedAt: nowIso()
      });
      await store.put(newRecord, normalizedCapabilities.map((capability?: any) : any => capabilityPermissionHash(lookupKey, capability)));
      return {
        ok: true,
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        capabilityKey: newCapabilityKey,
        credentialId: newRecord.credentialId,
        oldStatus: "invalid",
        status: "valid",
        runtimeLookupGeneration
      };
    });
  }

  async function describe() : Promise<any> {
    await waitForProviderMutations();
    const keySourceDescription: any = typeof keySource.describe === "function"
      ? await keySource.describe()
      : {};
    return {
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      provider: resolvedBackend,
      securityMode: keySourceDescription.securityMode || (resolvedBackend === "local-file"
        ? "degraded_file_fallback"
        : resolvedBackend === "macos-keychain"
          ? "keyring"
          : ""),
      alias,
      runtimeLookupGeneration,
      runtimeLookupLoaded: Boolean(runtimeLookupKey),
      runtimeLookupLoadCount,
      bindingCount: (await store.list({ includeInvalid: true })).length,
      permissionBindingCount: keySourceDescription.permissionBindingCount,
      stateRoot: keySourceDescription.stateRoot || "",
      linuxDetectedBackends: Array.isArray(keySourceDescription.linuxDetectedBackends)
        ? keySourceDescription.linuxDetectedBackends
        : [],
      keySource: {
        provider: keySourceDescription.provider || resolvedBackend,
        securityMode: keySourceDescription.securityMode || "",
        generation: keySourceDescription.generation || 0,
        loadCount: keySourceDescription.loadCount,
        runtimeLookupKeyRotationSupported: keySourceDescription.runtimeLookupKeyRotationSupported === true
      }
    };
  }

  async function exportRecoveryPackage(input: Record<string, any> = {}) : Promise<any> {
    await waitForProviderMutations();
    if (typeof store.exportRecoveryPackage !== "function") {
      throw new Error("Capability key provider backend does not support recovery export.");
    }
    return store.exportRecoveryPackage(input);
  }

  async function importRecoveryPackage(input: Record<string, any> = {}) : Promise<any> {
    if (typeof store.importRecoveryPackage !== "function") {
      throw new Error("Capability key provider backend does not support recovery import.");
    }
    return enqueueProviderMutation(async () : Promise<any> => {
      runtimeLookupKey = null;
      runtimeLookupGeneration = 0;
      return store.importRecoveryPackage(input);
    });
  }

  return Object.freeze({
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    provider: resolvedBackend,
    alias,
    issue,
    verify,
    invalidate,
    invalidateCredential,
    rotateCapabilityKey,
    exportRecoveryPackage,
    importRecoveryPackage,
    describe,
    store,
    close() : any {
      store.close?.();
    }
  });
}

export function createMemoryOpaqueCapabilityKeyProvider(input: Record<string, any> = {}) : any {
  return createOpaqueCapabilityKeyProvider({ ...input, backend: "memory" });
}

export function createCommandOpaqueCapabilityKeyProvider(input: Record<string, any> = {}) : any {
  return createOpaqueCapabilityKeyProvider({
    ...input,
    backend: input.backend || (process.platform === "darwin" ? "macos-keychain" : "local-file")
  });
}
