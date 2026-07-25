import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolveAutoCapabilityKernelBackend } from "./opaque-capability-key-backends.mjs";
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
} from "./opaque-capability-key-core.mjs";
import {
  normalizeRegisteredToolCapabilities,
  unknownKernelCapabilities
} from "#meshrix/authorization-engine";
import {
  createMemoryCapabilityKeyBindingStore,
  createSealedCapabilityKernelStore
} from "./opaque-capability-key-store.mjs";

function runCommandJson({ command, args = [], env = {}, input = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Opaque capability key helper timed out: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", (error) => {
      if (isClosedPipeError(error)) {
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Opaque capability key helper failed with exit code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        reject(new Error(`Opaque capability key helper returned invalid JSON: ${error.message}`));
      }
    });
    try {
      child.stdin.end(`${JSON.stringify(input)}\n`);
    } catch (error) {
      if (!isClosedPipeError(error)) {
        clearTimeout(timeout);
        reject(error);
      }
    }
  });
}

function createMemoryLookupKeySource() {
  let generation = 1;
  let runtimeLookupKeyBase64 = crypto.randomBytes(32).toString("base64");
  let loadCount = 0;
  return {
    async loadRuntimeLookupKey() {
      loadCount += 1;
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        provider: "memory",
        generation,
        runtimeLookupKeyBase64
      };
    },
    async rotateRuntimeLookupKey() {
      generation += 1;
      runtimeLookupKeyBase64 = crypto.randomBytes(32).toString("base64");
      return {
        protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
        provider: "memory",
        generation
      };
    },
    describe() {
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
} = {}) {
  async function request(action, input = {}) {
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
    loadRuntimeLookupKey: () => request("loadRuntimeLookupKey"),
    rotateRuntimeLookupKey: () => request("rotateRuntimeLookupKey"),
    describe: () => request("describe")
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
} = {}) {
  const resolvedBackend = resolveAutoCapabilityKernelBackend(backend);
  const storageBackend = backend === "auto" ? "auto" : resolvedBackend;
  const sealedKernel = !bindingStore && resolvedBackend !== "memory"
    ? createSealedCapabilityKernelStore({ backend: storageBackend, dataDir, alias })
    : null;
  const store = bindingStore ||
    sealedKernel ||
    createMemoryCapabilityKeyBindingStore();
  const keySource = lookupKeySource ||
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
  let runtimeLookupKey = null;
  let runtimeLookupGeneration = 0;
  let runtimeLookupLoadCount = 0;
  let providerMutationQueue = Promise.resolve();

  function enqueueProviderMutation(action) {
    const run = providerMutationQueue.catch(() => {}).then(action);
    providerMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function waitForProviderMutations() {
    await providerMutationQueue.catch(() => {});
  }

  async function getRuntimeLookupKey() {
    if (!runtimeLookupKey) {
      const loaded = await keySource.loadRuntimeLookupKey();
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
  } = {}) {
    return enqueueProviderMutation(async () => {
      const rawKey = text(key || capabilityKey);
      rejectUnknownOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const lookupKey = await getRuntimeLookupKey();
      const keyHash = capabilityKeyHash(lookupKey, rawKey);
      const normalizedCapabilities = canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const record = createKeyRecord({
        ...input,
        keyHash,
        capabilities: normalizedCapabilities,
        trustedCapabilityPermissions: normalizedCapabilities
      });
      const capabilityHashes = normalizedCapabilities.map((capability) => capabilityPermissionHash(lookupKey, capability));
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
  } = {}) {
    const rawKey = text(key || capabilityKey);
    if (!rawKey) {
      return { ok: false, reasonCode: "capability_key_missing" };
    }
    await waitForProviderMutations();
    const requestedCapabilities = requiredCapability ? [requiredCapability] : requiredCapabilities;
    const registeredToolCapabilities = normalizeRegisteredToolCapabilities(requestedCapabilities);
    const trustedRegisteredToolCapabilities = new Set(registeredToolCapabilities);
    const unknownRequired = unknownKernelCapabilities(requestedCapabilities)
      .filter((capability) => !trustedRegisteredToolCapabilities.has(capability));
    if (unknownRequired.length > 0) {
      return {
        ok: false,
        reasonCode: "unknown_capability",
        unknownCapabilities: unknownRequired,
        keyHash: "",
        runtimeLookupGeneration
      };
    }
    const required = canonicalOpaqueCapabilities(requestedCapabilities, registeredToolCapabilities);
    if (required.length === 0) {
      return { ok: false, reasonCode: "capability_required" };
    }
    const lookupKey = await getRuntimeLookupKey();
    const keyHash = capabilityKeyHash(lookupKey, rawKey);
    const recordCheck = validateKeyRecord(await store.get(keyHash), { now, minGrantVersion });
    if (!recordCheck.ok) {
      return { ...recordCheck, keyHash: "", runtimeLookupGeneration };
    }
    const missingCapabilities = [];
    for (const capability of required) {
      const candidateHashes = candidateCapabilitiesFor(capability)
        .map((candidate) => capabilityPermissionHash(lookupKey, candidate));
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
    const decision = {
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

  async function invalidate({ capabilityKey = "", key = "", reason = "" } = {}) {
    return enqueueProviderMutation(async () => {
      const rawKey = text(key || capabilityKey);
      if (!rawKey) {
        return null;
      }
      const lookupKey = await getRuntimeLookupKey();
      const keyHash = capabilityKeyHash(lookupKey, rawKey);
      return store.invalidate(keyHash, reason);
    });
  }

  async function invalidateCredential({ credentialId = "", reason = "" } = {}) {
    return enqueueProviderMutation(async () => {
      const resolvedCredentialId = text(credentialId);
      if (!resolvedCredentialId) {
        return [];
      }
      const records = await store.list({ includeInvalid: false });
      const invalidated = [];
      for (const record of records) {
        if (record.credentialId !== resolvedCredentialId) {
          continue;
        }
        const updated = await store.invalidate(record.keyHash, reason);
        if (updated) {
          invalidated.push(updated);
        }
      }
      return invalidated;
    });
  }

  async function rotateCapabilityKey({ capabilityKey = "", key = "", capabilities = [], trustedCapabilityPermissions = [], reason = "rotated", ...input } = {}) {
    return enqueueProviderMutation(async () => {
      const rawKey = text(key || capabilityKey);
      const lookupKey = await getRuntimeLookupKey();
      const oldHash = capabilityKeyHash(lookupKey, rawKey);
      const existing = await store.get(oldHash);
      if (!existing || existing.status !== "valid") {
        return { ok: false, reasonCode: "capability_key_invalid" };
      }
      rejectUnknownOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      const normalizedCapabilities = canonicalOpaqueCapabilities(capabilities, trustedCapabilityPermissions);
      if (normalizedCapabilities.length === 0) {
        return { ok: false, reasonCode: "capabilities_required_for_rotation" };
      }
      await store.invalidate(oldHash, reason);
      const newCapabilityKey = createCapabilityKey();
      const newHash = capabilityKeyHash(lookupKey, newCapabilityKey);
      const newRecord = createKeyRecord({
        ...existing,
        ...input,
        keyHash: newHash,
        capabilities: normalizedCapabilities,
        trustedCapabilityPermissions: normalizedCapabilities,
        status: "valid",
        issuedAt: nowIso()
      });
      await store.put(newRecord, normalizedCapabilities.map((capability) => capabilityPermissionHash(lookupKey, capability)));
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

  async function describe() {
    await waitForProviderMutations();
    const keySourceDescription = typeof keySource.describe === "function"
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

  async function exportRecoveryPackage(input = {}) {
    await waitForProviderMutations();
    if (typeof store.exportRecoveryPackage !== "function") {
      throw new Error("Capability key provider backend does not support recovery export.");
    }
    return store.exportRecoveryPackage(input);
  }

  async function importRecoveryPackage(input = {}) {
    if (typeof store.importRecoveryPackage !== "function") {
      throw new Error("Capability key provider backend does not support recovery import.");
    }
    return enqueueProviderMutation(async () => {
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
    close() {
      store.close?.();
    }
  });
}

export function createMemoryOpaqueCapabilityKeyProvider(input = {}) {
  return createOpaqueCapabilityKeyProvider({ ...input, backend: "memory" });
}

export function createCommandOpaqueCapabilityKeyProvider(input = {}) {
  return createOpaqueCapabilityKeyProvider({
    ...input,
    backend: input.backend || (process.platform === "darwin" ? "macos-keychain" : "local-file")
  });
}
