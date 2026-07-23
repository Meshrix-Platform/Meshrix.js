import { canonicalJson } from "@lico/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

import {
  resolvePluginRuntimeModuleUrl,
  validatePluginDeployment
} from "./plugin-registry.mjs";
import { pluginOwnerGenerationDigest } from "./plugin-artifact-authority.mjs";
import { createPluginVerifierHooks } from "./plugin-verifier-runner.mjs";

export const PLUGIN_ACTIVATION_EXPORT = "activatePlugin";
export const PLUGIN_LIFECYCLE_RECOVERY_EXPORT = "recoverPluginLifecycle";
const PLUGIN_LIFECYCLE_LEDGER_SCHEMA = "licomesh.plugin-lifecycle-ledger/1";
const PLUGIN_LIFECYCLE_LEDGER_FIELDS = new Set([
  "schemaVersion", "pluginId", "state", "operation", "idempotencyKey", "requestDigest", "generation"
]);

function validateLifecycleLedger(ledger, pluginId) {
  if (ledger === null || ledger === undefined) return null;
  if (!isPlainObject(ledger) || Object.keys(ledger).some((field) => !PLUGIN_LIFECYCLE_LEDGER_FIELDS.has(field)) ||
      ledger.schemaVersion !== PLUGIN_LIFECYCLE_LEDGER_SCHEMA || ledger.pluginId !== pluginId ||
      !["active", "removal_pending", "inactive", "uninstalled"].includes(ledger.state) ||
      !Number.isSafeInteger(ledger.generation) || ledger.generation < 1) {
    throw new Error(`Plugin ${pluginId} lifecycle ledger is invalid.`);
  }
  if (ledger.state !== "active" &&
      (!new Set(["disable", "uninstall"]).has(ledger.operation) || !String(ledger.idempotencyKey || "").trim() ||
       !/^[a-f0-9]{64}$/u.test(String(ledger.requestDigest || "")))) {
    throw new Error(`Plugin ${pluginId} lifecycle ledger is invalid.`);
  }
  return Object.freeze({ ...ledger });
}
export const PLUGIN_CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

export class PluginRuntimeActivationError extends Error {
  constructor(pluginId, stage, reasonCode = "plugin_activation_failed") {
    super(`Plugin ${pluginId} failed during ${stage}.`);
    this.name = "PluginRuntimeActivationError";
    this.code = "PLUGIN_RUNTIME_ACTIVATION_FAILED";
    this.pluginId = pluginId;
    this.stage = stage;
    this.reasonCode = /^[a-z][a-z0-9_]{0,127}$/u.test(String(reasonCode || ""))
      ? String(reasonCode)
      : "plugin_activation_failed";
  }
}

export class PluginRuntimeCloseError extends Error {
  constructor() {
    super("Plugin runtime resource shutdown did not complete cleanly.");
    this.name = "PluginRuntimeCloseError";
    this.code = "PLUGIN_RUNTIME_CLOSE_FAILED";
  }
}

export class PluginLifecycleTransitionError extends Error {
  constructor(code, pluginId, operation, generation, dependentPluginIds = []) {
    super("Plugin lifecycle transition did not complete.");
    this.name = "PluginLifecycleTransitionError";
    this.code = code;
    this.pluginId = pluginId;
    this.operation = operation;
    this.generation = generation;
    if (dependentPluginIds.length > 0) this.dependentPluginIds = Object.freeze(dependentPluginIds.slice(0, 32));
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function immutableInput(value) {
  const seen = new WeakSet();
  const visit = (entry) => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new TypeError("Plugin lifecycle input must not contain cycles.");
      seen.add(entry);
      const output = Object.freeze(entry.map(visit));
      seen.delete(entry);
      return output;
    }
    if (isPlainObject(entry)) {
      if (seen.has(entry)) throw new TypeError("Plugin lifecycle input must not contain cycles.");
      seen.add(entry);
      const output = Object.freeze(Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)])));
      seen.delete(entry);
      return output;
    }
    throw new TypeError("Plugin lifecycle input must be JSON-compatible.");
  };
  return visit(isPlainObject(value) ? value : {});
}

function assertRuntimeResultShape(pluginId, result) {
  if (!isPlainObject(result)) {
    throw new Error(`Plugin ${pluginId} activation must return an object.`);
  }
  for (const field of Object.keys(result)) {
    if (!new Set(["id", "mounts", "contributions", "lifecycle", "subscribeContributionChanges", "close"]).has(field)) {
      throw new Error(`Plugin ${pluginId} activation returned unsupported field ${field}.`);
    }
  }
  if (result.id !== pluginId) {
    throw new Error(`Plugin activation identity does not match ${pluginId}.`);
  }
  if (!isPlainObject(result.mounts)) {
    throw new Error(`Plugin ${pluginId} activation mounts must be an object.`);
  }
  if (typeof result.close !== "function") {
    throw new Error(`Plugin ${pluginId} activation must return close().`);
  }
  if (result.subscribeContributionChanges !== undefined && typeof result.subscribeContributionChanges !== "function") {
    throw new Error(`Plugin ${pluginId} contribution subscription must be a function.`);
  }
  if (result.lifecycle !== undefined &&
      (!isPlainObject(result.lifecycle) || Object.keys(result.lifecycle).some((field) => !["prepareTransition", "abortPreparedTransition", "transition"].includes(field)) ||
       (result.lifecycle.prepareTransition !== undefined && typeof result.lifecycle.prepareTransition !== "function") ||
       (result.lifecycle.abortPreparedTransition !== undefined && typeof result.lifecycle.abortPreparedTransition !== "function") ||
       ((result.lifecycle.prepareTransition === undefined) !== (result.lifecycle.abortPreparedTransition === undefined)) ||
       typeof result.lifecycle.transition !== "function")) {
    throw new Error(`Plugin ${pluginId} lifecycle must expose transition().`);
  }
}

function declaredContributionIds(manifest, kind) {
  if (kind === "routes" || kind === "verifierHooks") {
    return manifest[kind].map((entry) => entry.id).sort();
  }
  return [...manifest[kind]].sort();
}

function normalizeContributionValue(manifest, kind, id, value) {
  const implementation = typeof value === "function"
    ? value
    : isPlainObject(value)
      ? Object.freeze({ ...value })
      : null;
  if (!implementation) {
    throw new Error(`Plugin ${manifest.id} ${kind} contribution ${id} must be a function or plain object.`);
  }
  return Object.freeze({
    id,
    kind,
    pluginId: manifest.id,
    implementation
  });
}

function normalizeRuntimeContributions(manifest, value, { hostVerifierHooks = null } = {}) {
  const source = value === undefined ? {} : value;
  if (!isPlainObject(source)) {
    throw new Error(`Plugin ${manifest.id} activation contributions must be an object.`);
  }
  for (const kind of Object.keys(source)) {
    if (!PLUGIN_CONTRIBUTION_KINDS.includes(kind)) {
      throw new Error(`Plugin ${manifest.id} activation returned unsupported contribution kind ${kind}.`);
    }
  }
  const output = {};
  for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
    const implementations = source[kind] === undefined ? {} : source[kind];
    if (!isPlainObject(implementations)) {
      throw new Error(`Plugin ${manifest.id} ${kind} contributions must be an object.`);
    }
    const declaredIds = declaredContributionIds(manifest, kind);
    const returnedIds = Object.keys(implementations).sort();
    const returnedSet = new Set(returnedIds);
    const invented = returnedIds.some((id) => !declaredIds.includes(id));
    const exactMismatch = declaredIds.length !== returnedIds.length ||
      declaredIds.some((id, index) => id !== returnedIds[index]);
    if (invented || (manifest.contributionMode !== "selected" && exactMismatch)) {
      throw new Error(`Plugin ${manifest.id} runtime ${kind} contributions do not match its manifest.`);
    }
    output[kind] = Object.freeze(Object.fromEntries(declaredIds.filter((id) => returnedSet.has(id)).map((id) => {
      if (kind === "verifierHooks") {
        const declaration = implementations[id];
        if (!isPlainObject(declaration) || Object.keys(declaration).length !== 0) {
          throw new Error(`Plugin ${manifest.id} verifier hook ${id} must be an empty Host-executed declaration.`);
        }
        return [id, normalizeContributionValue(manifest, kind, id, hostVerifierHooks?.[id] || declaration)];
      }
      return [id, normalizeContributionValue(manifest, kind, id, implementations[id])];
    })));
  }
  return Object.freeze(output);
}

function normalizeRuntimeMounts(manifest, mounts) {
  const declaredNames = Object.keys(manifest.mounts).sort();
  const returnedNames = Object.keys(mounts).sort();
  if (
    declaredNames.length !== returnedNames.length ||
    declaredNames.some((name, index) => name !== returnedNames[index])
  ) {
    throw new Error(`Plugin ${manifest.id} runtime mounts do not match its manifest.`);
  }
  const output = {};
  for (const name of declaredNames) {
    const provider = mounts[name];
    if (!isPlainObject(provider)) {
      throw new Error(`Plugin ${manifest.id} mount ${name} must be an object.`);
    }
    const declaration = manifest.mounts[name];
    const providerId = String(provider.id || declaration.id).trim();
    const kind = String(provider.kind || declaration.kind).trim();
    const claimedPluginId = String(provider.pluginId || manifest.id).trim();
    if (providerId !== declaration.id || kind !== declaration.kind || claimedPluginId !== manifest.id) {
      throw new Error(`Plugin ${manifest.id} mount ${name} does not match its manifest declaration.`);
    }
    output[name] = Object.freeze({
      ...provider,
      id: declaration.id,
      name,
      kind: declaration.kind,
      pluginId: manifest.id,
      enabled: true
    });
  }
  return Object.freeze(output);
}

async function runClosers(closers) {
  let failed = false;
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  return !failed;
}

function createRetryableCloser(closers, createError) {
  let remaining = [...closers].reverse();
  let closePromise = null;
  return () => {
    if (remaining.length === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const failed = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw createError();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  };
}

function createPluginRecord(
  manifest,
  mounts,
  contributionProvider,
  lifecycle,
  closers,
  lifecycleStatePort = null,
  persistedLifecycle = null,
  artifactAuthorityPort = null,
  artifactSnapshot = null,
  hostVerifierHooks = null,
  subscribeContributionChanges = null
) {
  const close = createRetryableCloser(closers, () => new PluginRuntimeCloseError());
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    manifest,
    mounts,
    lifecycle,
    lifecycleStatePort,
    persistedLifecycle,
    artifactAuthorityPort,
    artifactSnapshot,
    get contributions() {
      return normalizeRuntimeContributions(manifest, contributionProvider(), { hostVerifierHooks });
    },
    subscribeContributionChanges(listener) {
      if (typeof listener !== "function") throw new TypeError("Plugin contribution listener must be a function.");
      if (typeof subscribeContributionChanges !== "function") return () => {};
      return subscribeContributionChanges((contributions) => listener(Object.freeze({
        pluginId: manifest.id,
        contributions: normalizeRuntimeContributions(manifest, {
          ...contributions,
          verifierHooks: Object.freeze(Object.fromEntries(
            manifest.verifierHooks.map((hook) => [hook.id, Object.freeze({})])
          ))
        }, { hostVerifierHooks })
      })));
    },
    close
  });
}

function mergeRuntimeContributions(records) {
  const output = Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind) => [kind, {}]));
  for (const record of records) {
    for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
      for (const [id, implementation] of Object.entries(record.contributions[kind])) {
        if (Object.hasOwn(output[kind], id)) {
          throw new Error(`Enabled plugins contain duplicate ${kind} contribution ${id}.`);
        }
        output[kind][id] = implementation;
      }
    }
  }
  return Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind) => [
    kind,
    Object.freeze(output[kind])
  ])));
}

function mergeRuntimeRouting(manifests) {
  const output = {
    kindRoutes: {},
    extensionRoutes: {},
    mediaTypeRoutes: {}
  };
  for (const manifest of manifests) {
    for (const routeType of Object.keys(output)) {
      for (const [key, target] of Object.entries(manifest.mountRouting[routeType])) {
        if (Object.hasOwn(output[routeType], key)) {
          throw new Error(`Enabled plugins contain duplicate ${routeType} route ${key}.`);
        }
        output[routeType][key] = target;
      }
    }
  }
  return Object.freeze({
    kindRoutes: Object.freeze(output.kindRoutes),
    extensionRoutes: Object.freeze(output.extensionRoutes),
    mediaTypeRoutes: Object.freeze(output.mediaTypeRoutes)
  });
}

function publicDeployment(deployment, records) {
  const activeIds = new Set(records.map((record) => record.id));
  const profile = deployment.deploymentProfile === null || deployment.deploymentProfile === undefined
    ? null
    : Object.freeze({
        id: deployment.deploymentProfile.id,
        digest: deployment.deploymentProfile.digest,
        enabledPluginIds: Object.freeze([...deployment.deploymentProfile.enabledPluginIds]),
        configuredPluginIds: Object.freeze([...deployment.deploymentProfile.configuredPluginIds]),
        pluginIdentities: Object.freeze(deployment.deploymentProfile.pluginIdentities.map((identity) => (
          Object.freeze({ ...identity })
        ))),
        dependencyOrder: Object.freeze([...deployment.deploymentProfile.dependencyOrder])
      });
  return Object.freeze({
    deploymentProfile: profile,
    enabledPluginIds: Object.freeze([...deployment.enabledPluginIds].filter((id) => activeIds.has(id))),
    configuredPluginIds: Object.freeze([...(deployment.configuredPluginIds || [])]),
    loadedPlugins: Object.freeze(records.map((record) => Object.freeze({
      id: record.id,
      version: record.version
    }))),
    disabledPluginIds: Object.freeze([...new Set([
      ...deployment.disabledPluginIds,
      ...deployment.enabledPluginIds.filter((id) => !activeIds.has(id))
    ])].sort())
  });
}

export async function activatePluginDeployment({
  deployment,
  artifactAuthority = null,
  createContext = () => ({})
} = {}) {
  validatePluginDeployment(deployment);
  if (typeof createContext !== "function") {
    throw new TypeError("Plugin context factory must be a function.");
  }
  const records = [];
  let activePluginId = "unknown";
  let stage = "manifest validation";
  let activationClosers = [];

  try {
    for (const manifest of deployment.loadedPlugins) {
      activePluginId = manifest.id;
      activationClosers = [];
      let acceptingClosers = true;
      const onClose = (close) => {
        if (!acceptingClosers || typeof close !== "function") {
          throw new TypeError("Plugin activation onClose() accepts functions only during activation.");
        }
        activationClosers.push(close);
      };
      stage = "context construction";
      const context = await createContext(manifest);
      if (!isPlainObject(context)) {
        throw new Error(`Plugin ${manifest.id} context must be an object.`);
      }
      if (context.productionActivation === true &&
          (context.lifecycleStatePort?.id !== "PluginLifecycleStatePort" ||
           typeof context.lifecycleStatePort.runExclusive !== "function")) {
        throw new Error(`Plugin ${manifest.id} production lifecycle state authority is unavailable.`);
      }
      const artifactAuthorityPort = artifactAuthority?.forPlugin?.({
        pluginId: manifest.id,
        lifecycleStatePort: context.lifecycleStatePort
      }) || null;
      const artifactSnapshot = artifactAuthorityPort ? await artifactAuthorityPort.loadSnapshot() : null;
      if (context.productionActivation === true && !artifactSnapshot) {
        throw new Error(`Plugin ${manifest.id} installed artifact snapshot is unavailable.`);
      }
      const ledger = validateLifecycleLedger(
        await context.lifecycleStatePort?.readRecord?.("ledger") || null,
        manifest.id
      );
      if (context.productionActivation === true && !ledger) {
        throw new Error(`Plugin ${manifest.id} production lifecycle ledger is unavailable.`);
      }
      if (context.productionActivation === true &&
          (ledger.pluginId !== artifactSnapshot.pluginId || ledger.generation !== artifactSnapshot.generation)) {
        throw new Error(`Plugin ${manifest.id} production lifecycle ledger does not match its installed artifact.`);
      }
      const pluginContext = { ...context };
      const pluginProcessHost = context.pluginProcessHost || null;
      delete pluginContext.pluginProcessHost;
      if (context.pluginInvocationAuthorizationAuthority !== undefined) {
        if (context.pluginInvocationAuthorizationAuthority?.id !== "PluginInvocationAuthorizationAuthority" ||
            typeof context.pluginInvocationAuthorizationAuthority.registerOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} invocation authorization authority is unavailable.`);
        }
        context.pluginInvocationAuthorizationAuthority.registerOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation
        });
      }
      delete pluginContext.pluginInvocationAuthorizationAuthority;
      const configuredHostCapabilities = new Set(Array.isArray(context.configuration?.hostCapabilities)
        ? context.configuration.hostCapabilities.map((entry) => String(entry || "").trim())
        : []);
      const hostCapabilityGranted = (id) => manifest.hostCapabilities.includes(id) && configuredHostCapabilities.has(id);
      if (context.pluginOwnerProcessIdentityAuthority !== undefined && hostCapabilityGranted("owner-process-identity")) {
        if (context.pluginOwnerProcessIdentityAuthority?.id !== "PluginOwnerProcessIdentityAuthority" ||
            typeof context.pluginOwnerProcessIdentityAuthority.forOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} owner process identity authority is unavailable.`);
        }
        pluginContext.ownerProcessIdentityHost = context.pluginOwnerProcessIdentityAuthority.forOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation
        });
        delete pluginContext.pluginOwnerProcessIdentityAuthority;
      }
      delete pluginContext.pluginOwnerProcessIdentityAuthority;
      if (context.pluginControlledExecutionAuthority !== undefined && hostCapabilityGranted("controlled-execution")) {
        if (context.pluginControlledExecutionAuthority?.id !== "PluginControlledExecutionAuthority" ||
            typeof context.pluginControlledExecutionAuthority.forOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} controlled execution authority is unavailable.`);
        }
        pluginContext.controlledExecutionHost = context.pluginControlledExecutionAuthority.forOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation,
          executionPolicy: context.configuration?.hostCapabilityConfiguration?.["controlled-execution"] || null
        });
        delete pluginContext.pluginControlledExecutionAuthority;
      }
      delete pluginContext.pluginControlledExecutionAuthority;
      if (context.pluginProtectedRecoveryAuthority !== undefined && hostCapabilityGranted("protected-recovery")) {
        if (context.pluginProtectedRecoveryAuthority?.id !== "PluginProtectedRecoveryAuthority" ||
            typeof context.pluginProtectedRecoveryAuthority.forOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} protected recovery authority is unavailable.`);
        }
        pluginContext.protectedRecoveryPort = context.pluginProtectedRecoveryAuthority.forOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation
        });
      }
      delete pluginContext.pluginProtectedRecoveryAuthority;
      if (context.pluginDownstreamClientAspectAuthority !== undefined && hostCapabilityGranted("downstream-client-aspect")) {
        if (context.pluginDownstreamClientAspectAuthority?.id !== "PluginDownstreamClientAspectAuthority" ||
            typeof context.pluginDownstreamClientAspectAuthority.forOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} downstream client aspect authority is unavailable.`);
        }
        pluginContext.downstreamClientAspectHost = context.pluginDownstreamClientAspectAuthority.forOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation,
          configuration: context.configuration?.hostCapabilityConfiguration?.["downstream-client-aspect"] || {}
        });
      }
      delete pluginContext.pluginDownstreamClientAspectAuthority;
      if (context.pluginOutboundEgressAuthority !== undefined && hostCapabilityGranted("outbound-egress-policy")) {
        if (context.pluginOutboundEgressAuthority?.id !== "PluginOutboundEgressAuthority" ||
            typeof context.pluginOutboundEgressAuthority.forOwner !== "function" || !artifactSnapshot) {
          throw new Error(`Plugin ${manifest.id} outbound egress authority is unavailable.`);
        }
        pluginContext.outboundEgressHost = context.pluginOutboundEgressAuthority.forOwner({
          ownerId: manifest.id,
          lifecycleStatePort: context.lifecycleStatePort,
          ownerGenerationDigest: pluginOwnerGenerationDigest({
            pluginId: manifest.id,
            artifactDigest: artifactSnapshot.artifactDigest,
            generation: artifactSnapshot.generation
          }),
          ownerGeneration: artifactSnapshot.generation
        });
      }
      delete pluginContext.pluginOutboundEgressAuthority;
      const exposedContext = Object.freeze(pluginContext);
      const persistedState = String(ledger?.state || "active");
      if (persistedState === "uninstalled") {
        records.push(createPluginRecord(
          manifest,
          Object.freeze({}),
          () => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})]))),
          null,
          [],
          context.lifecycleStatePort,
          ledger,
          artifactAuthorityPort,
          artifactSnapshot
        ));
        continue;
      }
      const dependencyDormant = manifest.dependencies.some((dependencyId) => {
        const dependency = records.find((record) => record.id === dependencyId);
        return !dependency || String(dependency.persistedLifecycle?.state || "active") !== "active";
      });
      if (dependencyDormant) {
        records.push(createPluginRecord(
          manifest,
          Object.freeze({}),
          () => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})]))),
          null,
          [],
          context.lifecycleStatePort,
          Object.freeze({ state: "dependency_blocked", generation: Number(ledger?.generation || 1) }),
          artifactAuthorityPort,
          artifactSnapshot
        ));
        continue;
      }
      stage = "runtime resolution";
      if (!manifest.runtime) throw new Error(`Plugin ${manifest.id} does not declare a runtime module.`);
      const moduleUrl = await resolvePluginRuntimeModuleUrl(manifest);
      let runtimeModule;
      if (context.productionActivation === true) {
        stage = "isolated process host validation";
        if (pluginProcessHost?.id !== "IsolatedPluginProcessHost" ||
            pluginProcessHost.isolation !== "out-of-process" ||
            typeof pluginProcessHost.loadModule !== "function") {
          const error = new Error(`Plugin ${manifest.id} requires an isolated process host.`);
          error.code = "plugin_process_host_required";
          throw error;
        }
        stage = "isolated process module load";
        runtimeModule = await pluginProcessHost.loadModule(Object.freeze({
          pluginId: manifest.id,
          moduleUrl: moduleUrl.href
        }));
        if (typeof pluginProcessHost.close !== "function") {
          throw new Error(`Plugin ${manifest.id} isolated process host does not expose close().`);
        }
        activationClosers.push(() => pluginProcessHost.close());
      } else {
        stage = "development module import";
        runtimeModule = await import(moduleUrl.href);
      }
      if (!isPlainObject(runtimeModule) && Object.prototype.toString.call(runtimeModule) !== "[object Module]") {
        throw new Error(`Plugin ${manifest.id} process host returned an invalid runtime module.`);
      }
      if (persistedState !== "active") {
        const recover = runtimeModule[PLUGIN_LIFECYCLE_RECOVERY_EXPORT];
        let recovery = null;
        if (persistedState !== "uninstalled") {
          if (typeof recover !== "function") throw new Error(`Plugin ${manifest.id} does not export ${PLUGIN_LIFECYCLE_RECOVERY_EXPORT}().`);
          recovery = await recover(Object.freeze({
            manifest,
            context: exposedContext,
            ledger
          }));
          if (!isPlainObject(recovery) || typeof recovery.transition !== "function") {
            throw new Error(`Plugin ${manifest.id} lifecycle recovery contract is invalid.`);
          }
        }
        const dormant = createPluginRecord(
          manifest,
          Object.freeze({}),
          () => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})]))),
          recovery,
          typeof recovery?.close === "function" ? [() => recovery.close()] : [],
        context.lifecycleStatePort,
        ledger,
        artifactAuthorityPort,
        artifactSnapshot
        );
        records.push(dormant);
        continue;
      }
      const activate = runtimeModule[PLUGIN_ACTIVATION_EXPORT];
      if (typeof activate !== "function") {
        throw new Error(`Plugin ${manifest.id} does not export ${PLUGIN_ACTIVATION_EXPORT}().`);
      }
      stage = "activation";
      let result;
      try {
        result = await activate(Object.freeze({
          manifest,
          context: exposedContext,
          onClose
        }));
      } finally {
        acceptingClosers = false;
      }
      if (typeof result?.close === "function") activationClosers.push(() => result.close());
      stage = "activation contract validation";
      assertRuntimeResultShape(manifest.id, result);
      const mounts = normalizeRuntimeMounts(manifest, result.mounts);
      const pluginVerifierHooks = result.contributions?.verifierHooks;
      if (pluginVerifierHooks !== undefined &&
          (!isPlainObject(pluginVerifierHooks) || Object.keys(pluginVerifierHooks).length > 0)) {
        throw new Error(`Plugin ${manifest.id} runtime must not implement Host-owned verifier hooks.`);
      }
      const hostVerifierHooks = manifest.verifierHooks.length > 0
        ? createPluginVerifierHooks(manifest, {
            resolveSource: (source) => {
              if (!artifactSnapshot) throw new Error(`Plugin ${manifest.id} installed verifier source authority is unavailable.`);
              return artifactSnapshot.resolveRuntimeModule(source);
            }
          })
        : null;
      const effectiveContributions = () => Object.freeze({
        ...result.contributions,
        verifierHooks: Object.freeze(Object.fromEntries(
          manifest.verifierHooks.map((hook) => [hook.id, Object.freeze({})])
        ))
      });
      normalizeRuntimeContributions(manifest, effectiveContributions(), { hostVerifierHooks });
      records.push(createPluginRecord(
        manifest,
        mounts,
        effectiveContributions,
        result.lifecycle || null,
        activationClosers,
        context.lifecycleStatePort,
        ledger,
        artifactAuthorityPort,
        artifactSnapshot,
        hostVerifierHooks,
        result.subscribeContributionChanges
      ));
      activationClosers = [];
    }
  } catch (cause) {
    const currentClosed = await runClosers(activationClosers);
    const priorClosed = await runClosers(records.map((record) => () => record.close()));
    const error = new PluginRuntimeActivationError(activePluginId, stage, cause?.code);
    error.cleanupComplete = currentClosed && priorClosed;
    throw error;
  }

  const mounts = {};
  for (const record of records) {
    for (const [name, mount] of Object.entries(record.mounts)) {
      if (Object.hasOwn(mounts, name)) {
        await runClosers(records.map((item) => () => item.close()));
        throw new PluginRuntimeActivationError(record.id, "mount conflict validation");
      }
      mounts[name] = mount;
    }
  }
  let routing;
  let contributions;
  try {
    routing = mergeRuntimeRouting(deployment.loadedPlugins);
    contributions = mergeRuntimeContributions(records);
  } catch {
    await runClosers(records.map((record) => () => record.close()));
    throw new PluginRuntimeActivationError(activePluginId, "deployment contribution validation");
  }
  const lifecycleRecords = new Map(records.map((record) => [record.id, {
    record,
    state: record.persistedLifecycle?.state || "active",
    operation: record.persistedLifecycle?.operation || "",
    idempotencyKey: record.persistedLifecycle?.idempotencyKey || "",
    requestDigest: record.persistedLifecycle?.requestDigest || "",
    admissionExpectedGeneration: 0,
    transitionGeneration: Number(record.persistedLifecycle?.generation || 0),
    receipt: record.persistedLifecycle && ["inactive", "uninstalled"].includes(record.persistedLifecycle.state)
      ? Object.freeze({
          ok: true,
          pluginId: record.id,
          operation: record.persistedLifecycle.operation,
          state: record.persistedLifecycle.state,
          resumed: true,
          generation: record.persistedLifecycle.generation
        })
      : null
  }]));
  const transitionTasks = new Map();
  let lifecycleGeneration = Math.max(1, ...[...lifecycleRecords.values()].map((entry) => entry.transitionGeneration || 0));
  let closing = false;
  const visibleRecords = () => [...lifecycleRecords.values()]
    .filter((entry) => entry.state === "active")
    .map((entry) => entry.record);
  const visibleMounts = () => Object.freeze(Object.fromEntries(visibleRecords().flatMap((record) =>
    Object.entries(record.mounts)
  )));
  const lifecycleTransition = ({
    pluginId, operation, idempotencyKey, expectedGeneration, input = {},
    commitAdmission = null, commitIrreversible = null
  } = {}) => {
    if (closing) throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_CLOSING", String(pluginId || ""), operation, lifecycleGeneration);
    const id = String(pluginId || "").trim();
    const action = String(operation || "").trim();
    const key = String(idempotencyKey || "").trim();
    let inputSnapshot;
    try {
      inputSnapshot = immutableInput(input);
    } catch {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_REQUEST_INVALID", id, action, lifecycleGeneration);
    }
    const requestDigest = createHash("sha256").update(canonicalJson(inputSnapshot)).digest("hex");
    const entry = lifecycleRecords.get(id);
    if (!entry || !["disable", "uninstall"].includes(action) || !key || key.length > 256) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_REQUEST_INVALID", id, action, lifecycleGeneration);
    }
    if (!entry.record.lifecycle) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_UNSUPPORTED", id, action, lifecycleGeneration);
    }
    const activeDependents = [...lifecycleRecords.values()]
      .filter((candidate) => candidate.state === "active" && candidate.record.manifest.dependencies.includes(id))
      .map((candidate) => candidate.record.id)
      .sort();
    if (activeDependents.length > 0) {
      throw new PluginLifecycleTransitionError(
        "PLUGIN_LIFECYCLE_DEPENDENTS_ACTIVE",
        id,
        action,
        lifecycleGeneration,
        activeDependents
      );
    }
    if (entry.state === "uninstalled" || (entry.state === "inactive" && action !== "uninstall")) {
      if (entry.operation === action && entry.idempotencyKey === key && entry.requestDigest === requestDigest) {
        return Promise.resolve(entry.receipt);
      }
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_IDEMPOTENCY_CONFLICT", id, action, lifecycleGeneration);
    }
    if (entry.state === "removal_pending" &&
        (entry.operation !== action || entry.idempotencyKey !== key || entry.requestDigest !== requestDigest)) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_IDEMPOTENCY_CONFLICT", id, action, lifecycleGeneration);
    }
    const requestedGeneration = Number(expectedGeneration);
    if (transitionTasks.has(id)) {
      if (entry.operation === action && entry.idempotencyKey === key && entry.requestDigest === requestDigest &&
          Number.isSafeInteger(requestedGeneration) && requestedGeneration === entry.admissionExpectedGeneration) {
        return transitionTasks.get(id);
      }
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_FENCE_MISMATCH", id, action, lifecycleGeneration);
    }
    if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration !== lifecycleGeneration) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_FENCE_MISMATCH", id, action, lifecycleGeneration);
    }
    const previous = Object.freeze({
      state: entry.state,
      operation: entry.operation,
      idempotencyKey: entry.idempotencyKey,
      requestDigest: entry.requestDigest,
      generation: entry.transitionGeneration || lifecycleGeneration
    });
    const transitionGeneration = lifecycleGeneration + 1;
    entry.operation = action;
    entry.idempotencyKey = key;
    entry.requestDigest = requestDigest;
    entry.admissionExpectedGeneration = requestedGeneration;
    entry.transitionGeneration = transitionGeneration;
    const executeTransition = async () => {
      let prepareAttempted = false;
      let admissionCommitted = false;
      let pendingLedgerAttempted = false;
      try {
        const persisted = validateLifecycleLedger(
          await entry.record.lifecycleStatePort?.readRecord?.("ledger") || null,
          id
        );
        if (persisted && persisted.state !== "active") {
          const sameRequest = persisted.operation === action &&
            persisted.idempotencyKey === key && persisted.requestDigest === requestDigest;
          if (!sameRequest) {
            throw new PluginLifecycleTransitionError(
              "PLUGIN_LIFECYCLE_IDEMPOTENCY_CONFLICT",
              id,
              action,
              persisted.generation
            );
          }
          if (["inactive", "uninstalled"].includes(persisted.state)) {
            entry.state = persisted.state;
            entry.transitionGeneration = persisted.generation;
            lifecycleGeneration = Math.max(lifecycleGeneration, persisted.generation);
            entry.receipt = Object.freeze({
              ok: true,
              pluginId: id,
              operation: action,
              state: persisted.state,
              resumed: true,
              generation: persisted.generation
            });
            return entry.receipt;
          }
        }
        if (typeof entry.record.lifecycle.prepareTransition === "function") {
          prepareAttempted = true;
          const prepared = await entry.record.lifecycle.prepareTransition(Object.freeze({
            operation: action,
            idempotencyKey: key,
            requestDigest,
            generation: transitionGeneration,
            lifecycleLockHeld: true,
            input: inputSnapshot
          }));
          if (prepared?.ok !== true || !/^[a-f0-9]{64}$/u.test(String(prepared.journalDigest || ""))) {
            throw new Error("Plugin lifecycle prepare hook returned an invalid result.");
          }
        }
        pendingLedgerAttempted = true;
        await entry.record.lifecycleStatePort?.writeRecord?.("ledger", {
          schemaVersion: PLUGIN_LIFECYCLE_LEDGER_SCHEMA,
          pluginId: id,
          state: "removal_pending",
          operation: action,
          idempotencyKey: key,
          requestDigest,
          generation: transitionGeneration
        });
        entry.state = "removal_pending";
        await commitAdmission?.();
        admissionCommitted = true;
        lifecycleGeneration = transitionGeneration;
        await commitIrreversible?.();
        const result = await entry.record.lifecycle.transition(Object.freeze({
          operation: action,
          idempotencyKey: key,
          requestDigest,
          generation: transitionGeneration,
          lifecycleLockHeld: true,
          input: inputSnapshot
        }));
        if (result?.ok !== true || result.state !== (action === "disable" ? "inactive" : "removal_ready") ||
            (action === "uninstall" && !/^[a-f0-9]{64}$/u.test(String(result.cleanupReceiptDigest || "")))) {
          throw new Error("Plugin lifecycle hook returned an invalid result.");
        }
        const finalState = action === "disable" ? "inactive" : "uninstalled";
        if (action === "uninstall") {
          const snapshot = entry.record.artifactSnapshot;
          const port = entry.record.artifactAuthorityPort;
          if (!snapshot || port?.id !== "PluginArtifactAuthorityPort" || typeof port.remove !== "function") {
            throw new Error("Plugin artifact removal authority is unavailable.");
          }
          const removal = await port.remove({
            expectedArtifactDigest: snapshot.artifactDigest,
            expectedGeneration: snapshot.generation
          });
          if (removal?.ok !== true || removal.removed !== true) {
            throw new Error("Plugin artifact removal did not complete.");
          }
        }
        entry.state = finalState;
        await entry.record.lifecycleStatePort?.writeRecord?.("ledger", {
          schemaVersion: PLUGIN_LIFECYCLE_LEDGER_SCHEMA,
          pluginId: id,
          state: finalState,
          operation: action,
          idempotencyKey: key,
          requestDigest,
          generation: transitionGeneration
        });
        entry.receipt = Object.freeze({
          ok: true,
          pluginId: id,
          operation: action,
          state: finalState,
          resumed: result.resumed === true,
          generation: transitionGeneration
        });
        return entry.receipt;
      } catch (error) {
        if (prepareAttempted && !admissionCommitted) {
          const recoveryFailures = [];
          try {
            const aborted = await entry.record.lifecycle.abortPreparedTransition?.(Object.freeze({
              operation: action,
              idempotencyKey: key,
              requestDigest,
              generation: transitionGeneration,
              lifecycleLockHeld: true,
              input: inputSnapshot
            }));
            if (typeof entry.record.lifecycle.abortPreparedTransition !== "function" || aborted?.ok !== true) {
              throw new Error("Plugin lifecycle prepare abort hook returned an invalid result.");
            }
          } catch (abortError) {
            recoveryFailures.push(abortError);
          }
          if (pendingLedgerAttempted) {
            try {
              await entry.record.lifecycleStatePort?.writeRecord?.("ledger", {
                schemaVersion: PLUGIN_LIFECYCLE_LEDGER_SCHEMA,
                pluginId: id,
                state: previous.state,
                operation: previous.operation,
                idempotencyKey: previous.idempotencyKey,
                requestDigest: previous.requestDigest,
                generation: previous.generation
              });
            } catch (ledgerRecoveryError) {
              recoveryFailures.push(ledgerRecoveryError);
            }
          }
          if (recoveryFailures.length === 0) {
            entry.state = previous.state;
            entry.operation = previous.operation;
            entry.idempotencyKey = previous.idempotencyKey;
            entry.requestDigest = previous.requestDigest;
            entry.transitionGeneration = previous.generation;
          } else {
            entry.state = "removal_pending";
            const recoveryError = new PluginLifecycleTransitionError(
              "PLUGIN_LIFECYCLE_RECOVERY_REQUIRED",
              id,
              action,
              transitionGeneration
            );
            recoveryError.cause = error;
            recoveryError.recoveryRequired = true;
            throw recoveryError;
          }
        }
        if (error?.code === "PLUGIN_LIFECYCLE_ADMISSION_UPDATE_FAILED") throw error;
        if (error instanceof PluginLifecycleTransitionError) throw error;
        if (entry.state !== previous.state) entry.state = "removal_pending";
        const transitionError = new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_TRANSITION_FAILED", id, action, transitionGeneration);
        transitionError.cause = error;
        throw transitionError;
      }
    };
    const task = Promise.resolve(
      entry.record.lifecycleStatePort?.runExclusive
        ? entry.record.lifecycleStatePort.runExclusive(executeTransition)
        : executeTransition()
    ).finally(() => transitionTasks.delete(id));
    transitionTasks.set(id, task);
    return task;
  };
  const close = createRetryableCloser(
    records.map((record) => () => record.close()),
    () => new PluginRuntimeCloseError()
  );

  return Object.freeze({
    get mounts() {
      return visibleMounts();
    },
    get mountRouting() {
      return mergeRuntimeRouting(visibleRecords().map((record) => record.manifest));
    },
    get contributions() {
      return mergeRuntimeContributions(visibleRecords());
    },
    get plugins() {
      return publicDeployment(deployment, visibleRecords());
    },
    get lifecycleGeneration() {
      return lifecycleGeneration;
    },
    getPluginArtifactGenerationDigest(pluginId) {
      const entry = lifecycleRecords.get(String(pluginId || "").trim());
      const snapshot = entry && ["active", "removal_pending", "inactive"].includes(entry.state)
        ? entry.record.artifactSnapshot
        : null;
      if (!snapshot) return "";
      try {
        return pluginOwnerGenerationDigest({
          pluginId: entry.record.id,
          artifactDigest: snapshot.artifactDigest,
          generation: snapshot.generation
        });
      } catch {
        return "";
      }
    },
    onPluginContributionChange(listener) {
      if (typeof listener !== "function") throw new TypeError("Plugin contribution listener must be a function.");
      const unsubscribers = visibleRecords().map((record) => record.subscribeContributionChanges(listener));
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    transitionPluginLifecycle: lifecycleTransition,
    async close() {
      closing = true;
      await Promise.allSettled([...transitionTasks.values()]);
      return close();
    }
  });
}
