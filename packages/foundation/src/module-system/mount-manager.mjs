import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import path from "node:path";
import fs from "node:fs/promises";

import {
  loadMountConfig,
  mergeMountRouting,
  normalizeMountModules,
  normalizeMountRouting
} from "./mount-config.mjs";
import {
  loadPluginRegistry,
  normalizeEnabledPluginIds
} from "./plugin-registry.mjs";
import { activatePluginDeployment } from "./plugin-runtime.mjs";
import { createPluginDataCapability } from "./plugin-data-capability.mjs";
import {
  HOST_OPAQUE_PAYLOAD_TTL_MS,
  createHostOpaquePayloadCustody
} from "./opaque-payload-custody.mjs";
import { createPluginLifecycleStatePort } from "./plugin-lifecycle-state-port.mjs";
import { normalizePluginArtifactTrustedPublicKeys } from "./plugin-artifact-trust.mjs";
import { createIsolatedPluginProcessHost } from "./isolated-plugin-process-host.mjs";

export class MountManagerStartupRollbackError extends Error {
  constructor() {
    super("Mount manager startup rollback did not complete cleanly.");
    this.name = "MountManagerStartupRollbackError";
    this.code = "MOUNT_MANAGER_STARTUP_ROLLBACK_FAILED";
  }
}

function normalizeProfile(value) {
  return value === "minimal" ? "minimal" : "default";
}

function normalizeDeploymentProfileId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]*$/u.test(value)) {
    throw new Error("runtime.deploymentProfileId must be a valid plugin deployment profile id.");
  }
  return value;
}

function immutableConfigurationSnapshot(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Plugin configuration must not contain cycles.");
    seen.add(value);
    const snapshot = value.map((entry) => immutableConfigurationSnapshot(entry, seen));
    seen.delete(value);
    return Object.freeze(snapshot);
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Plugin configuration must contain only JSON-compatible values.");
    }
    if (seen.has(value)) throw new TypeError("Plugin configuration must not contain cycles.");
    seen.add(value);
    const snapshot = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      snapshot[key] = immutableConfigurationSnapshot(entry, seen);
    }
    seen.delete(value);
    return Object.freeze(snapshot);
  }
  throw new TypeError("Plugin configuration must contain only JSON-compatible values.");
}


export function normalizeRuntimeOptions(runtimeOptions = {}) {
  const testHooks =
    runtimeOptions.testHooks && typeof runtimeOptions.testHooks === "object"
      ? { jobDelayMs: Number(runtimeOptions.testHooks.jobDelayMs || 0) }
      : {};
  const cwd = String(runtimeOptions.cwd || process.cwd()).trim();
  if (!cwd) throw new TypeError("Runtime cwd is required.");
  const pluginConfigurations = runtimeOptions.pluginConfigurations === undefined
    ? {}
    : runtimeOptions.pluginConfigurations;
  if (!pluginConfigurations || typeof pluginConfigurations !== "object" || Array.isArray(pluginConfigurations)) {
    throw new TypeError("runtime.pluginConfigurations must be an object when provided.");
  }
  const normalizedPluginConfigurations = {};
  for (const [pluginId, configuration] of Object.entries(pluginConfigurations)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(pluginId)) {
      throw new Error(`Invalid plugin configuration id: ${pluginId}.`);
    }
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new TypeError(`Plugin configuration ${pluginId} must be an object.`);
    }
    normalizedPluginConfigurations[pluginId] = immutableConfigurationSnapshot(configuration);
  }

  return {
    profile: normalizeProfile(runtimeOptions.profile),
    cwd: path.resolve(cwd),
    mountModules: normalizeMountModules(runtimeOptions.mountModules),
    mountRouting: normalizeMountRouting(runtimeOptions.mountRouting),
    enabledPlugins: normalizeEnabledPluginIds(runtimeOptions.enabledPlugins),
    deploymentProfileId: normalizeDeploymentProfileId(runtimeOptions.deploymentProfileId),
    pluginConfigurations: Object.freeze(normalizedPluginConfigurations),
    pluginArtifactTrustedPublicKeys: normalizePluginArtifactTrustedPublicKeys(
      runtimeOptions.pluginArtifactTrustedPublicKeys === undefined ? {} : runtimeOptions.pluginArtifactTrustedPublicKeys
    ),
    featureRuntime: runtimeOptions.featureRuntime || null,
    testHooks
  };
}

function mountModuleField(entry, field, fallback = "") {
  return typeof entry === "object" && entry
    ? String(entry[field] || fallback || "").trim()
    : String(fallback || "").trim();
}

function createConfiguredMounts(runtimeOptions = {}, builtinMountProviders = {}) {
  const mounts = {};
  for (const [name, entry] of Object.entries(runtimeOptions.mountModules || {})) {
    const enabled = typeof entry === "object" && entry ? entry.enabled !== false : true;
    if (!enabled) continue;
    const pluginId = mountModuleField(entry, "pluginId");
    if (pluginId) {
      throw new Error(`Configured mount ${name} cannot claim plugin ownership; plugin mounts come from plugin manifests.`);
    }
    const providerId = mountModuleField(entry, "provider") || mountModuleField(entry, "kind", name);
    const provider = builtinMountProviders[name] || builtinMountProviders[providerId] || null;
    if (!provider || typeof provider !== "object") {
      throw new Error(`Configured mount ${name} has no registered runtime provider.`);
    }
    mounts[name] = Object.freeze({
      ...provider,
      id: mountModuleField(entry, "id", provider.id || name) || name,
      name,
      kind: mountModuleField(entry, "kind", provider.kind || name) || name,
      pluginId: "",
      enabled: true
    });
  }
  return mounts;
}

function mergeDistinctRouting(base = {}, patch = {}) {
  const left = normalizeMountRouting(base);
  const right = normalizeMountRouting(patch);
  const output = { kindRoutes: {}, extensionRoutes: {}, mediaTypeRoutes: {} };
  for (const routeType of Object.keys(output)) {
    output[routeType] = { ...left[routeType] };
    for (const [key, target] of Object.entries(right[routeType])) {
      if (Object.hasOwn(output[routeType], key)) {
        throw new Error(`Mount routing conflict for ${routeType} ${key}.`);
      }
      output[routeType][key] = target;
    }
  }
  return output;
}

function combineMounts(pluginMounts, configuredMounts) {
  const output = { ...pluginMounts };
  for (const [name, mount] of Object.entries(configuredMounts)) {
    if (Object.hasOwn(output, name)) {
      throw new Error(`Configured mount ${name} conflicts with an enabled plugin mount.`);
    }
    output[name] = mount;
  }
  return Object.freeze(output);
}

function validateRouteTargets(routing, mounts) {
  for (const routeMap of Object.values(routing)) {
    for (const target of Object.values(routeMap)) {
      if (!mounts[target.mountName]) {
        throw new Error(`Mount route targets unavailable mount ${target.mountName}.`);
      }
    }
  }
}

function routeForInput(routing, input = {}) {
  const kind = String(input.kind || input.sourceKind || "").trim();
  const extension = String(input.extension || input.ext || "").trim().toLowerCase();
  const normalizedExtension = extension
    ? extension.startsWith(".") ? extension : `.${extension}`
    : "";
  const mediaType = String(input.mediaType || input.mimeType || "").trim().toLowerCase();
  return (kind && routing.kindRoutes[kind]) ||
    (normalizedExtension && routing.extensionRoutes[normalizedExtension]) ||
    (mediaType && routing.mediaTypeRoutes[mediaType]) ||
    null;
}

async function ensureRealDirectory(directory, { parentRealPath = "", label }) {
  try {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    const secured = await fs.lstat(directory);
    if ((secured.mode & 0o777) !== 0o700) {
      throw new Error(`${label} permissions could not be restricted.`);
    }
  }
  const realPath = await fs.realpath(directory);
  if (parentRealPath) {
    const relative = path.relative(parentRealPath, realPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} resolves outside its parent directory.`);
    }
  }
  return realPath;
}

async function preparePluginDataPath(userDataPath, pluginId) {
  const dataRoot = await fs.realpath(path.resolve(userDataPath));
  const pluginRoot = await ensureRealDirectory(path.join(dataRoot, "plugins"), {
    parentRealPath: dataRoot,
    label: "Plugin data root"
  });
  return ensureRealDirectory(path.join(pluginRoot, pluginId), {
    parentRealPath: pluginRoot,
    label: `Plugin data directory ${pluginId}`
  });
}

async function preparePluginDataCapability(userDataPath, pluginId) {
  return createPluginDataCapability(await preparePluginDataPath(userDataPath, pluginId));
}

function createExecutionView(runtimeOptions, pluginRuntime, builtinMountProviders) {
  const configuredMounts = createConfiguredMounts(runtimeOptions, builtinMountProviders);
  const mounts = combineMounts(pluginRuntime.mounts, configuredMounts);
  const routing = mergeDistinctRouting(pluginRuntime.mountRouting, runtimeOptions.mountRouting);
  validateRouteTargets(routing, mounts);
  const postCommitHooks = [...new Set(Object.values(mounts)
    .flatMap((mount) => [mount.onPostCommit, mount.postCommitHook, mount.onBatchCompleted])
    .filter((hook) => typeof hook === "function"))];
  return Object.freeze({
    mounts,
    contributions: pluginRuntime.contributions,
    postCommitHooks: Object.freeze(postCommitHooks),
    plugins: pluginRuntime.plugins,
    runtimeOptions,
    resolveDocumentRoute(input = {}) {
      const route = routeForInput(routing, input);
      if (!route) return null;
      return Object.freeze({ ...route, mount: mounts[route.mountName] });
    }
  });
}

function assertMountConfigShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Mount config must be an object.");
  }
  for (const field of Object.keys(value)) {
    if (!new Set(["mountModules", "mountRouting"]).has(field)) {
      throw new Error(`Mount config contains unsupported field ${field}.`);
    }
  }
}

export async function createMountManager({
  userDataPath,
  runtimeOptions = {},
  builtinMountProviders = {},
  pluginDeployment: providedPluginDeployment = null,
  registerPluginRuntimeMeasurementSource = null,
  pluginHostPorts = {}
}) {
  let normalizedRuntimeOptions = normalizeRuntimeOptions(runtimeOptions);
  const persistedMountConfig = await loadMountConfig(userDataPath);
  const artifactAuthority = pluginHostPorts.artifactAuthority || null;
  const retiredPluginIds = new Set();
  if (artifactAuthority?.id === "PluginArtifactAuthority") {
    const selectedIds = [...new Set([
      ...normalizedRuntimeOptions.enabledPlugins,
      ...Object.keys(normalizedRuntimeOptions.pluginConfigurations)
    ])];
    for (const id of selectedIds) {
      const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath, pluginId: id });
      const artifactPort = artifactAuthority.forPlugin({ pluginId: id, lifecycleStatePort });
      await artifactPort.recoverRemoval();
      const [ledger, removalJournal] = await Promise.all([
        lifecycleStatePort.readRecord("ledger"),
        lifecycleStatePort.readRecord("artifact-removal-journal")
      ]);
      if (ledger?.state === "removal_pending" && ledger.operation === "uninstall" &&
          removalJournal?.phase === "completed" && removalJournal.pluginId === id) {
        await lifecycleStatePort.runExclusive(() => lifecycleStatePort.writeRecord("ledger", {
          ...ledger,
          state: "uninstalled"
        }));
        retiredPluginIds.add(id);
      } else if (ledger?.state === "uninstalled") {
        retiredPluginIds.add(id);
      }
    }
  }
  if (retiredPluginIds.size > 0) {
    normalizedRuntimeOptions = normalizeRuntimeOptions({
      ...normalizedRuntimeOptions,
      enabledPlugins: normalizedRuntimeOptions.enabledPlugins.filter((id) => !retiredPluginIds.has(id)),
      pluginConfigurations: Object.fromEntries(Object.entries(normalizedRuntimeOptions.pluginConfigurations)
        .filter(([id]) => !retiredPluginIds.has(id)))
    });
  }
  const pluginDeployment = providedPluginDeployment || (await loadPluginRegistry({
    artifactAuthority
  })).resolveDeployment({
    enabledPluginIds: normalizedRuntimeOptions.enabledPlugins,
    configuredPluginIds: Object.keys(normalizedRuntimeOptions.pluginConfigurations),
    deploymentProfileId: normalizedRuntimeOptions.deploymentProfileId
  });
  if (
    !Array.isArray(pluginDeployment?.enabledPluginIds) ||
    !Array.isArray(pluginDeployment?.configuredPluginIds) ||
    !Array.isArray(pluginDeployment?.loadedPlugins)
  ) {
    throw new TypeError("Resolved plugin deployment is required.");
  }
  const expectedPluginIds = [...normalizedRuntimeOptions.enabledPlugins].sort();
  if (
    expectedPluginIds.length !== pluginDeployment.enabledPluginIds.length ||
    expectedPluginIds.some((id, index) => id !== pluginDeployment.enabledPluginIds[index])
  ) {
    throw new Error("Resolved plugin deployment does not match runtime.enabledPlugins.");
  }
  const expectedConfiguredPluginIds = Object.keys(normalizedRuntimeOptions.pluginConfigurations).sort();
  if (
    expectedConfiguredPluginIds.length !== pluginDeployment.configuredPluginIds.length ||
    expectedConfiguredPluginIds.some((id, index) => id !== pluginDeployment.configuredPluginIds[index])
  ) {
    throw new Error("Resolved plugin deployment does not match runtime.pluginConfigurations.");
  }
  if ((pluginDeployment.deploymentProfile?.id || null) !== normalizedRuntimeOptions.deploymentProfileId) {
    throw new Error("Resolved plugin deployment does not match runtime.deploymentProfileId.");
  }
  let pluginRuntime = null;
  let currentRuntimeOptions;
  let generation = 1;
  let mutationTail = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let observedPluginLifecycleGeneration = 1;
  const lifecycleListeners = new Set();
  const lifecycleAdmissions = new Map();

  try {
    pluginRuntime = await activatePluginDeployment({
      deployment: pluginDeployment,
      artifactAuthority,
      createContext: async (manifest) => {
        const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath, pluginId: manifest.id });
        if (artifactAuthority?.id !== "PluginArtifactAuthority" || typeof artifactAuthority.forPlugin !== "function") {
          throw new Error(`Plugin ${manifest.id} canonical artifact authority is unavailable.`);
        }
        const configuredPurposes = Array.isArray(normalizedRuntimeOptions.pluginConfigurations[manifest.id]?.artifactSigningPurposes)
          ? normalizedRuntimeOptions.pluginConfigurations[manifest.id].artifactSigningPurposes
          : [];
        const grantedPurposes = manifest.artifactSigningPurposes.filter((purpose) => configuredPurposes.includes(purpose));
        const artifactSigner = typeof pluginHostPorts.artifactSignerForPlugin === "function" && grantedPurposes.length > 0
          ? await pluginHostPorts.artifactSignerForPlugin({ pluginId: manifest.id, allowedPurposes: grantedPurposes })
          : null;
        if (artifactSigner && artifactSigner.id !== "ArtifactSignerPort") {
          throw new Error(`Plugin ${manifest.id} artifact signer is invalid.`);
        }
        const clock = typeof pluginHostPorts.pluginClockForPlugin === "function"
          ? await pluginHostPorts.pluginClockForPlugin({ pluginId: manifest.id })
          : null;
        if (clock && (clock.id !== "ClockPort" || typeof clock.now !== "function")) {
          throw new Error(`Plugin ${manifest.id} clock port is invalid.`);
        }
        return {
        pluginData: await preparePluginDataCapability(userDataPath, manifest.id),
        lifecycleStatePort,
        opaquePayloadCustody: createHostOpaquePayloadCustody({ ttlMs: HOST_OPAQUE_PAYLOAD_TTL_MS }),
        configuration: normalizedRuntimeOptions.pluginConfigurations[manifest.id] || Object.freeze({}),
        productionActivation: true,
        pluginProcessHost: typeof pluginHostPorts.pluginProcessHostForPlugin === "function"
          ? await pluginHostPorts.pluginProcessHostForPlugin({ pluginId: manifest.id })
          : await createIsolatedPluginProcessHost(),
        ...(clock ? { clock } : {}),
        ...(artifactSigner ? { artifactSigner } : {}),
        ...(pluginHostPorts.pluginInvocationAuthorizationAuthority
          ? { pluginInvocationAuthorizationAuthority: pluginHostPorts.pluginInvocationAuthorizationAuthority }
          : {}),
        ...(pluginHostPorts.pluginOwnerProcessIdentityAuthority
          ? { pluginOwnerProcessIdentityAuthority: pluginHostPorts.pluginOwnerProcessIdentityAuthority }
          : {}),
        ...(pluginHostPorts.pluginControlledExecutionAuthority
          ? { pluginControlledExecutionAuthority: pluginHostPorts.pluginControlledExecutionAuthority }
          : {}),
        ...(pluginHostPorts.pluginProtectedRecoveryAuthority
          ? { pluginProtectedRecoveryAuthority: pluginHostPorts.pluginProtectedRecoveryAuthority }
          : {}),
        ...(pluginHostPorts.pluginDownstreamClientAspectAuthority
          ? { pluginDownstreamClientAspectAuthority: pluginHostPorts.pluginDownstreamClientAspectAuthority }
          : {}),
        ...(pluginHostPorts.pluginOutboundEgressAuthority
          ? { pluginOutboundEgressAuthority: pluginHostPorts.pluginOutboundEgressAuthority }
          : {}),
        ...(typeof registerPluginRuntimeMeasurementSource === "function"
          ? {
              registerRuntimeMeasurementSource(provider) {
                return registerPluginRuntimeMeasurementSource(manifest.id, provider);
              }
            }
          : {})
        };
      }
    });
    currentRuntimeOptions = normalizeRuntimeOptions({
      ...normalizedRuntimeOptions,
      mountModules: {
        ...(persistedMountConfig.mountModules || {}),
        ...(normalizedRuntimeOptions.mountModules || {})
      },
      mountRouting: mergeMountRouting(
        persistedMountConfig.mountRouting || {},
        normalizedRuntimeOptions.mountRouting || {}
      )
    });
    observedPluginLifecycleGeneration = pluginRuntime.lifecycleGeneration;
    createExecutionView(currentRuntimeOptions, pluginRuntime, builtinMountProviders);
  } catch (error) {
    if (pluginRuntime) {
      try {
        await pluginRuntime.close();
      } catch {
        throw new MountManagerStartupRollbackError();
      }
    }
    throw error;
  }

  function assertOpen() {
    if (closing) throw new Error("Mount manager is closing.");
  }

  function enqueueMutation(mutation) {
    assertOpen();
    const task = mutationTail.then(mutation);
    mutationTail = task.catch(() => {});
    return task;
  }

  return Object.freeze({
    get mounts() {
      assertOpen();
      return createExecutionView(currentRuntimeOptions, pluginRuntime, builtinMountProviders).mounts;
    },
    get plugins() {
      return pluginRuntime.plugins;
    },
    get runtimeOptions() {
      return currentRuntimeOptions;
    },
    get generation() {
      return generation;
    },
    createExecutionView() {
      assertOpen();
      return createExecutionView(currentRuntimeOptions, pluginRuntime, builtinMountProviders);
    },
    applyMountConfig(config = {}) {
      assertMountConfigShape(config);
      return enqueueMutation(async () => {
        const candidate = normalizeRuntimeOptions({
          ...currentRuntimeOptions,
          mountModules: normalizeMountModules(config.mountModules),
          mountRouting: normalizeMountRouting(config.mountRouting)
        });
        const view = createExecutionView(candidate, pluginRuntime, builtinMountProviders);
        currentRuntimeOptions = candidate;
        generation += 1;
        return view;
      });
    },
    reloadMounts() {
      return enqueueMutation(async () => {
        const view = createExecutionView(currentRuntimeOptions, pluginRuntime, builtinMountProviders);
        generation += 1;
        return view;
      });
    },
    async refreshMounts() {
      assertOpen();
      await mutationTail;
      assertOpen();
      return createExecutionView(currentRuntimeOptions, pluginRuntime, builtinMountProviders);
    },
    transitionPluginLifecycle(request = {}) {
      const expectedGeneration = Number(request.expectedGeneration);
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== generation) {
        const error = new Error("Mount manager lifecycle generation fence does not match.");
        error.code = "PLUGIN_LIFECYCLE_FENCE_MISMATCH";
        error.generation = generation;
        throw error;
      }
      const admissionKey = canonicalJson([
        String(request.pluginId || "").trim(),
        String(request.operation || "").trim(),
        String(request.idempotencyKey || "").trim(),
        expectedGeneration,
        request.input || {}
      ]);
      if (lifecycleAdmissions.has(admissionKey)) return lifecycleAdmissions.get(admissionKey);
      const admission = enqueueMutation(async () => {
        if (expectedGeneration !== generation) {
          const error = new Error("Mount manager lifecycle generation fence does not match.");
          error.code = "PLUGIN_LIFECYCLE_FENCE_MISMATCH";
          error.generation = generation;
          throw error;
        }
        try {
          const prepared = [];
          const committed = [];
          try {
            for (const listener of lifecycleListeners) {
              const artifactGenerationDigest = pluginRuntime.getPluginArtifactGenerationDigest(
                String(request.pluginId || "").trim()
              );
              const transaction = await listener.prepare(Object.freeze({
                pluginId: String(request.pluginId || "").trim(),
                operation: String(request.operation || "").trim(),
                idempotencyKey: String(request.idempotencyKey || "").trim(),
                artifactGenerationDigest,
                state: "removal_pending"
              }));
              if (!transaction || typeof transaction.commit !== "function" || typeof transaction.rollback !== "function") {
                throw new Error("invalid lifecycle listener transaction");
              }
              prepared.push(transaction);
            }
          } catch {
            for (const transaction of committed.reverse()) {
              try { await transaction.rollback(); } catch { /* preserve admission failure */ }
            }
            const listenerError = new Error("Plugin lifecycle admission update did not complete.");
            listenerError.code = "PLUGIN_LIFECYCLE_ADMISSION_UPDATE_FAILED";
            listenerError.generation = generation;
            throw listenerError;
          }
          const transition = pluginRuntime.transitionPluginLifecycle({
            ...request,
            expectedGeneration: pluginRuntime.lifecycleGeneration,
            async commitAdmission() {
              try {
                for (const transaction of prepared) {
                  await transaction.commit();
                  committed.push(transaction);
                }
              } catch {
                for (const transaction of committed.reverse()) {
                  try { await transaction.rollback(); } catch { /* preserve admission failure */ }
                }
                const listenerError = new Error("Plugin lifecycle admission update did not complete.");
                listenerError.code = "PLUGIN_LIFECYCLE_ADMISSION_UPDATE_FAILED";
                listenerError.generation = generation;
                throw listenerError;
              }
            },
            async commitIrreversible() {
              for (const transaction of prepared) {
                await transaction.commitIrreversible?.();
              }
            }
          });
          const receipt = await transition;
          if (receipt.generation !== observedPluginLifecycleGeneration) {
            observedPluginLifecycleGeneration = receipt.generation;
            generation += 1;
          }
          return Object.freeze({ ...receipt, generation });
        } catch (error) {
          if (Number.isSafeInteger(error?.generation) && error.generation !== observedPluginLifecycleGeneration) {
            observedPluginLifecycleGeneration = error.generation;
            generation += 1;
          }
          error.generation = generation;
          throw error;
        }
      }).finally(() => lifecycleAdmissions.delete(admissionKey));
      lifecycleAdmissions.set(admissionKey, admission);
      return admission;
    },
    onPluginLifecycleTransition(listener) {
      if (!listener || typeof listener.prepare !== "function") throw new TypeError("Plugin lifecycle listener must expose prepare().");
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    onPluginContributionChange(listener) {
      return pluginRuntime.onPluginContributionChange(listener);
    },
    getPluginArtifactGenerationDigest(pluginId) {
      return pluginRuntime.getPluginArtifactGenerationDigest(pluginId);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = mutationTail.then(() => pluginRuntime.close()).catch((error) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  });
}
