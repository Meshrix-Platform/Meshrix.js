import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

import {
  resolvePluginRuntimeModuleUrl,
  validatePluginDeployment
} from "./plugin-registry.ts";
import { pluginOwnerGenerationDigest } from "./plugin-artifact-authority.ts";
import { registerPluginConsoleIsolationVerification } from "./plugin-console-isolation.ts";
import { createPluginVerifierHooks } from "./plugin-verifier-runner.ts";

export const PLUGIN_ACTIVATION_EXPORT: any = "activatePlugin";
export const PLUGIN_LIFECYCLE_RECOVERY_EXPORT: any = "recoverPluginLifecycle";
const PLUGIN_LIFECYCLE_LEDGER_SCHEMA: any = "meshrix.plugin-lifecycle-ledger/1";
const PLUGIN_LIFECYCLE_LEDGER_FIELDS: any = new Set<any>([
  "schemaVersion", "pluginId", "state", "operation", "idempotencyKey", "requestDigest", "generation"
]);

function validateLifecycleLedger(ledger?: any, pluginId?: any) : any {
  if (ledger === null || ledger === undefined) return null;
  if (!isPlainObject(ledger) || Object.keys(ledger).some((field?: any) : any => !PLUGIN_LIFECYCLE_LEDGER_FIELDS.has(field)) ||
      ledger.schemaVersion !== PLUGIN_LIFECYCLE_LEDGER_SCHEMA || ledger.pluginId !== pluginId ||
      !["active", "removal_pending", "inactive", "uninstalled"].includes(ledger.state) ||
      !Number.isSafeInteger(ledger.generation) || ledger.generation < 1) {
    throw new Error(`Plugin ${pluginId} lifecycle ledger is invalid.`);
  }
  if (ledger.state !== "active" &&
      (!new Set<any>(["disable", "uninstall"]).has(ledger.operation) || !String(ledger.idempotencyKey || "").trim() ||
       !/^[a-f0-9]{64}$/u.test(String(ledger.requestDigest || "")))) {
    throw new Error(`Plugin ${pluginId} lifecycle ledger is invalid.`);
  }
  return Object.freeze({ ...ledger });
}
export const PLUGIN_CONTRIBUTION_KINDS: readonly any[] = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "gatewayChannels",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

export class PluginRuntimeActivationError extends Error {
  code: any;
  name: any;
  pluginId: any;
  reasonCode: any;
  stage: any;
  constructor(pluginId?: any, stage?: any, reasonCode: any = "plugin_activation_failed") {
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
  code: any;
  name: any;
  constructor() {
    super("Plugin runtime resource shutdown did not complete cleanly.");
    this.name = "PluginRuntimeCloseError";
    this.code = "PLUGIN_RUNTIME_CLOSE_FAILED";
  }
}

export class PluginLifecycleTransitionError extends Error {
  code: any;
  dependentPluginIds: any;
  generation: any;
  name: any;
  operation: any;
  pluginId: any;
  constructor(code?: any, pluginId?: any, operation?: any, generation?: any, dependentPluginIds: any = []) {
    super("Plugin lifecycle transition did not complete.");
    this.name = "PluginLifecycleTransitionError";
    this.code = code;
    this.pluginId = pluginId;
    this.operation = operation;
    this.generation = generation;
    if (dependentPluginIds.length > 0) this.dependentPluginIds = Object.freeze(dependentPluginIds.slice(0, 32));
  }
}

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function immutableInput(value?: any) : any {
  const seen: any = new WeakSet<object>();
  const visit: any = (entry?: any) : any => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new TypeError("Plugin lifecycle input must not contain cycles.");
      seen.add(entry);
      const output: any = Object.freeze(entry.map(visit));
      seen.delete(entry);
      return output;
    }
    if (isPlainObject(entry)) {
      if (seen.has(entry)) throw new TypeError("Plugin lifecycle input must not contain cycles.");
      seen.add(entry);
      const output: any = Object.freeze(Object.fromEntries((Object.entries(entry) as [string, any][]).map(([key, child]: any[]) : any => [key, visit(child)])));
      seen.delete(entry);
      return output;
    }
    throw new TypeError("Plugin lifecycle input must be JSON-compatible.");
  };
  return visit(isPlainObject(value) ? value : {});
}

function assertRuntimeResultShape(pluginId?: any, result?: any) : any {
  if (!isPlainObject(result)) {
    throw new Error(`Plugin ${pluginId} activation must return an object.`);
  }
  for (const field of Object.keys(result)) {
    if (!new Set<any>(["id", "mounts", "contributions", "lifecycle", "subscribeContributionChanges", "close", "activation", "confinement", "snapshot"]).has(field)) {
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
      (!isPlainObject(result.lifecycle) || Object.keys(result.lifecycle).some((field?: any) : any => !["prepareTransition", "abortPreparedTransition", "transition"].includes(field)) ||
       (result.lifecycle.prepareTransition !== undefined && typeof result.lifecycle.prepareTransition !== "function") ||
       (result.lifecycle.abortPreparedTransition !== undefined && typeof result.lifecycle.abortPreparedTransition !== "function") ||
       ((result.lifecycle.prepareTransition === undefined) !== (result.lifecycle.abortPreparedTransition === undefined)) ||
       typeof result.lifecycle.transition !== "function")) {
    throw new Error(`Plugin ${pluginId} lifecycle must expose transition().`);
  }
}

function declaredContributionIds(manifest?: any, kind?: any) : any {
  if (kind === "routes" || kind === "verifierHooks") {
    return manifest[kind].map((entry?: any) : any => entry.id).sort();
  }
  return [...manifest[kind]].sort();
}

function normalizeContributionValue(manifest?: any, kind?: any, id?: any, value?: any) : any {
  const implementation: any = typeof value === "function"
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

function normalizeRuntimeContributions(manifest?: any, value?: any, { hostVerifierHooks = null }: Record<string, any> = {}) : any {
  const source: any = value === undefined ? {} : value;
  if (!isPlainObject(source)) {
    throw new Error(`Plugin ${manifest.id} activation contributions must be an object.`);
  }
  for (const kind of Object.keys(source)) {
    if (!PLUGIN_CONTRIBUTION_KINDS.includes(kind)) {
      throw new Error(`Plugin ${manifest.id} activation returned unsupported contribution kind ${kind}.`);
    }
  }
  const output: Record<string, any> = {};
  for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
    const declaredIds: any = declaredContributionIds(manifest, kind);
    const rawImplementations: any = source[kind] === undefined ? {} : source[kind];
    const implementations: any = kind === "gatewayChannels" && rawImplementations?.kind === "gatewayChannels"
      && declaredIds.length === 1
      ? { [declaredIds[0]]: rawImplementations }
      : rawImplementations;
    if (!isPlainObject(implementations)) {
      throw new Error(`Plugin ${manifest.id} ${kind} contributions must be an object.`);
    }
    const returnedIds: any = Object.keys(implementations).sort();
    const returnedSet: any = new Set<any>(returnedIds);
    const invented: any = returnedIds.some((id?: any) : any => !declaredIds.includes(id));
    const exactMismatch: any = declaredIds.length !== returnedIds.length ||
      declaredIds.some((id?: any, index?: any) : any => id !== returnedIds[index]);
    if (invented || (manifest.contributionMode !== "selected" && exactMismatch)) {
      throw new Error(`Plugin ${manifest.id} runtime ${kind} contributions do not match its manifest.`);
    }
    output[kind] = Object.freeze(Object.fromEntries(declaredIds.filter((id?: any) : any => returnedSet.has(id)).map((id?: any) : any => {
      if (kind === "verifierHooks") {
        const declaration: any = implementations[id];
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

function normalizeRuntimeMounts(manifest?: any, mounts?: any) : any {
  const declaredNames: any = Object.keys(manifest.mounts).sort();
  const returnedNames: any = Object.keys(mounts).sort();
  if (
    declaredNames.length !== returnedNames.length ||
    declaredNames.some((name?: any, index?: any) : any => name !== returnedNames[index])
  ) {
    throw new Error(`Plugin ${manifest.id} runtime mounts do not match its manifest.`);
  }
  const output: Record<string, any> = {};
  for (const name of declaredNames) {
    const provider: any = mounts[name];
    if (!isPlainObject(provider)) {
      throw new Error(`Plugin ${manifest.id} mount ${name} must be an object.`);
    }
    const declaration: any = manifest.mounts[name];
    const providerId: any = String(provider.id || declaration.id).trim();
    const kind: any = String(provider.kind || declaration.kind).trim();
    const claimedPluginId: any = String(provider.pluginId || manifest.id).trim();
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

async function runClosers(closers?: any) : Promise<any> {
  let failed: any = false;
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  return !failed;
}

function createRetryableCloser(closers?: any, createError?: any) : any {
  let remaining: any = [...closers].reverse();
  let closePromise: any = null;
  return () : any => {
    if (remaining.length === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () : Promise<any> => {
      const failed: any[] = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw createError();
    })().finally(() : any => {
      closePromise = null;
    });
    return closePromise;
  };
}

function createPluginRecord(
  manifest?: any,
  mounts?: any,
  contributionProvider?: any,
  lifecycle?: any,
  closers?: any,
  lifecycleStatePort: any = null,
  persistedLifecycle: any = null,
  artifactAuthorityPort: any = null,
  artifactSnapshot: any = null,
  hostVerifierHooks: any = null,
  subscribeContributionChanges: any = null
) : any {
  const close: any = createRetryableCloser(closers, () : any => new PluginRuntimeCloseError());
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
    get contributions() : any {
      return normalizeRuntimeContributions(manifest, contributionProvider(), { hostVerifierHooks });
    },
    subscribeContributionChanges(listener?: any) : any {
      if (typeof listener !== "function") throw new TypeError("Plugin contribution listener must be a function.");
      if (typeof subscribeContributionChanges !== "function") return () : any => {};
      return subscribeContributionChanges((contributions?: any) : any => listener(Object.freeze({
        pluginId: manifest.id,
        contributions: normalizeRuntimeContributions(manifest, {
          ...contributions,
          verifierHooks: Object.freeze(Object.fromEntries(
            manifest.verifierHooks.map((hook?: any) : any => [hook.id, Object.freeze({})])
          ))
        }, { hostVerifierHooks })
      })));
    },
    close
  });
}

function mergeRuntimeContributions(records?: any) : any {
  const output: any = Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, {}]));
  for (const record of records) {
    for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
      for (const [id, implementation] of (Object.entries(record.contributions[kind]) as [string, any][])) {
        if (Object.hasOwn(output[kind], id)) {
          throw new Error(`Enabled plugins contain duplicate ${kind} contribution ${id}.`);
        }
        output[kind][id] = implementation;
      }
    }
  }
  return Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind?: any) : any => [
    kind,
    Object.freeze(output[kind])
  ])));
}

function mergeRuntimeRouting(manifests?: any) : any {
  const output: Record<string, any> = {
    kindRoutes: {},
    extensionRoutes: {},
    mediaTypeRoutes: {}
  };
  for (const manifest of manifests) {
    for (const routeType of Object.keys(output)) {
      for (const [key, target] of (Object.entries(manifest.mountRouting[routeType]) as [string, any][])) {
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

function publicDeployment(deployment?: any, records?: any) : any {
  const activeIds: any = new Set<any>(records.map((record?: any) : any => record.id));
  const profile: any = deployment.deploymentProfile === null || deployment.deploymentProfile === undefined
    ? null
    : Object.freeze({
        id: deployment.deploymentProfile.id,
        digest: deployment.deploymentProfile.digest,
        enabledPluginIds: Object.freeze([...deployment.deploymentProfile.enabledPluginIds]),
        configuredPluginIds: Object.freeze([...deployment.deploymentProfile.configuredPluginIds]),
        pluginIdentities: Object.freeze(deployment.deploymentProfile.pluginIdentities.map((identity?: any) : any => (
          Object.freeze({ ...identity })
        ))),
        dependencyOrder: Object.freeze([...deployment.deploymentProfile.dependencyOrder])
      });
  return Object.freeze({
    deploymentProfile: profile,
    enabledPluginIds: Object.freeze([...deployment.enabledPluginIds].filter((id?: any) : any => activeIds.has(id))),
    configuredPluginIds: Object.freeze([...(deployment.configuredPluginIds || [])]),
    loadedPlugins: Object.freeze(records.map((record?: any) : any => Object.freeze({
      id: record.id,
      version: record.version
    }))),
    disabledPluginIds: Object.freeze([...new Set<any>([
      ...deployment.disabledPluginIds,
      ...deployment.enabledPluginIds.filter((id?: any) : any => !activeIds.has(id))
    ])].sort())
  });
}

export async function activatePluginDeployment({
  deployment,
  artifactAuthority = null,
  createContext = () : any => ({})
}: Record<string, any> = {}) : Promise<any> {
  validatePluginDeployment(deployment);
  if (typeof createContext !== "function") {
    throw new TypeError("Plugin context factory must be a function.");
  }
  const records: any[] = [];
  let activePluginId: any = "unknown";
  let stage: any = "manifest validation";
  let activationClosers: any[] = [];

  try {
    for (const manifest of deployment.loadedPlugins) {
      activePluginId = manifest.id;
      activationClosers = [];
      let acceptingClosers: any = true;
      const onClose: any = (close?: any) : any => {
        if (!acceptingClosers || typeof close !== "function") {
          throw new TypeError("Plugin activation onClose() accepts functions only during activation.");
        }
        activationClosers.push(close);
      };
      stage = "context construction";
      const context: any = await createContext(manifest);
      if (!isPlainObject(context)) {
        throw new Error(`Plugin ${manifest.id} context must be an object.`);
      }
      if (context.productionActivation === true &&
          (context.lifecycleStatePort?.id !== "PluginLifecycleStatePort" ||
           typeof context.lifecycleStatePort.runExclusive !== "function")) {
        throw new Error(`Plugin ${manifest.id} production lifecycle state authority is unavailable.`);
      }
      const artifactAuthorityPort: any = artifactAuthority?.forPlugin?.({
        pluginId: manifest.id,
        lifecycleStatePort: context.lifecycleStatePort
      }) || null;
      const artifactSnapshot: any = artifactAuthorityPort ? await artifactAuthorityPort.loadSnapshot() : null;
      if (context.productionActivation === true && !artifactSnapshot) {
        throw new Error(`Plugin ${manifest.id} installed artifact snapshot is unavailable.`);
      }
      const ledger: any = validateLifecycleLedger(
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
      const pluginContext: Record<string, any> = { ...context };
      const pluginProcessHost: any = context.pluginProcessHost || null;
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
      const hostCapabilityDeclared: any = (id?: any) : any => manifest.hostCapabilities.includes(id);
      if (hostCapabilityDeclared("owner-process-identity")) {
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
      if (hostCapabilityDeclared("controlled-execution")) {
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
      if (hostCapabilityDeclared("protected-recovery")) {
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
      if (hostCapabilityDeclared("downstream-client-aspect")) {
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
      if (hostCapabilityDeclared("outbound-egress-policy")) {
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
      if (pluginContext.configuration) {
        const {
          artifactSigningPurposes: _artifactSigningPurposes,
          consoleRoleScopeGrants: _consoleRoleScopeGrants,
          hostCapabilities: _hostCapabilities,
          hostCapabilityConfiguration: _hostCapabilityConfiguration,
          ...pluginConfiguration
        } = pluginContext.configuration;
        pluginContext.configuration = Object.freeze(pluginConfiguration);
      }
      const exposedContext: any = Object.freeze(pluginContext);
      const persistedState: any = String(ledger?.state || "active");
      if (persistedState === "uninstalled") {
        records.push(createPluginRecord(
          manifest,
          Object.freeze({}),
          () : any => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, Object.freeze({})]))),
          null,
          [],
          context.lifecycleStatePort,
          ledger,
          artifactAuthorityPort,
          artifactSnapshot
        ));
        continue;
      }
      const dependencyDormant: any = manifest.dependencies.some((dependencyId?: any) : any => {
        const dependency: any = records.find((record?: any) : any => record.id === dependencyId);
        return !dependency || String(dependency.persistedLifecycle?.state || "active") !== "active";
      });
      if (dependencyDormant) {
        records.push(createPluginRecord(
          manifest,
          Object.freeze({}),
          () : any => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, Object.freeze({})]))),
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
      const moduleUrl: any = await resolvePluginRuntimeModuleUrl(manifest);
      let runtimeModule: any;
      if (context.productionActivation === true) {
        stage = "isolated process host validation";
        if (pluginProcessHost?.id !== "IsolatedPluginProcessHost" ||
            pluginProcessHost.isolation !== "out-of-process" ||
            typeof pluginProcessHost.loadModule !== "function") {
          const error: Error & Record<string, any> = new Error(`Plugin ${manifest.id} requires an isolated process host.`);
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
        activationClosers.push(() : any => pluginProcessHost.close());
      } else {
        stage = "development module import";
        runtimeModule = await import(moduleUrl.href);
      }
      if (!isPlainObject(runtimeModule) && Object.prototype.toString.call(runtimeModule) !== "[object Module]") {
        throw new Error(`Plugin ${manifest.id} process host returned an invalid runtime module.`);
      }
      if (persistedState !== "active") {
        const recover: any = runtimeModule[PLUGIN_LIFECYCLE_RECOVERY_EXPORT];
        let recovery: any = null;
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
        const dormant: any = createPluginRecord(
          manifest,
          Object.freeze({}),
          () : any => Object.freeze(Object.fromEntries(PLUGIN_CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, Object.freeze({})]))),
          recovery,
          typeof recovery?.close === "function" ? [() : any => recovery.close()] : [],
        context.lifecycleStatePort,
        ledger,
        artifactAuthorityPort,
        artifactSnapshot
        );
        records.push(dormant);
        continue;
      }
      const activate: any = runtimeModule[PLUGIN_ACTIVATION_EXPORT];
      if (typeof activate !== "function") {
        throw new Error(`Plugin ${manifest.id} does not export ${PLUGIN_ACTIVATION_EXPORT}().`);
      }
      stage = "activation";
      let result: any;
      try {
        result = await activate(Object.freeze({
          manifest,
          context: exposedContext,
          onClose
        }));
      } finally {
        acceptingClosers = false;
      }
      if (typeof result?.close === "function") activationClosers.push(() : any => result.close());
      stage = "activation contract validation";
      assertRuntimeResultShape(manifest.id, result);
      const mounts: any = normalizeRuntimeMounts(manifest, result.mounts);
      const pluginVerifierHooks: any = result.contributions?.verifierHooks;
      if (pluginVerifierHooks !== undefined &&
          (!isPlainObject(pluginVerifierHooks) || Object.keys(pluginVerifierHooks).length > 0)) {
        throw new Error(`Plugin ${manifest.id} runtime must not implement Host-owned verifier hooks.`);
      }
      const hostVerifierHooks: any = manifest.verifierHooks.length > 0
        ? createPluginVerifierHooks(manifest, {
            resolveSource: (source?: any) : any => {
              if (!artifactSnapshot) throw new Error(`Plugin ${manifest.id} installed verifier source authority is unavailable.`);
              return artifactSnapshot.resolveRuntimeModule(source);
            }
          })
        : null;
      const effectiveContributions: any = () : any => Object.freeze({
        ...result.contributions,
        verifierHooks: Object.freeze(Object.fromEntries(
          manifest.verifierHooks.map((hook?: any) : any => [hook.id, Object.freeze({})])
        ))
      });
      normalizeRuntimeContributions(manifest, effectiveContributions(), { hostVerifierHooks });
      if (manifest.consoleEntries.length > 0) {
        registerPluginConsoleIsolationVerification({
          pluginId: manifest.id,
          enabled: true,
          consoleEntryIds: [...manifest.consoleEntries],
          artifactDigest: artifactSnapshot?.artifactDigest,
          artifactGeneration: artifactSnapshot?.generation,
          ownedToolIds: Object.freeze([...manifest.operations, ...manifest.mcpTools]),
          toolIdsByEntry: Object.freeze(Object.fromEntries(manifest.consoleEntries.map((entryId?: any) : any => {
            const implementation: any = result.contributions?.consoleEntries?.[entryId];
            return [entryId, Array.isArray(implementation?.toolIds) ? implementation.toolIds : []];
          })))
        });
      }
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
  } catch (cause: any) {
    const currentClosed: any = await runClosers(activationClosers);
    const priorClosed: any = await runClosers(records.map((record?: any) : any => () : any => record.close()));
    const error: any = new PluginRuntimeActivationError(activePluginId, stage, cause?.code);
    error.cleanupComplete = currentClosed && priorClosed;
    throw error;
  }

  const mounts: Record<string, any> = {};
  for (const record of records) {
    for (const [name, mount] of (Object.entries(record.mounts) as [string, any][])) {
      if (Object.hasOwn(mounts, name)) {
        await runClosers(records.map((item?: any) : any => () : any => item.close()));
        throw new PluginRuntimeActivationError(record.id, "mount conflict validation");
      }
      mounts[name] = mount;
    }
  }
  let routing: any;
  let contributions: any;
  try {
    routing = mergeRuntimeRouting(deployment.loadedPlugins);
    contributions = mergeRuntimeContributions(records);
  } catch {
    await runClosers(records.map((record?: any) : any => () : any => record.close()));
    throw new PluginRuntimeActivationError(activePluginId, "deployment contribution validation");
  }
  const lifecycleRecords: any = new Map<any, any>(records.map((record?: any) : any => [record.id, {
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
  const transitionTasks: any = new Map<any, any>();
  let lifecycleGeneration: any = Math.max(1, ...[...lifecycleRecords.values()].map((entry?: any) : any => entry.transitionGeneration || 0));
  let closing: any = false;
  const visibleRecords: any = () : any => [...lifecycleRecords.values()]
    .filter((entry?: any) : any => entry.state === "active")
    .map((entry?: any) : any => entry.record);
  const visibleMounts: any = () : any => Object.freeze(Object.fromEntries(visibleRecords().flatMap((record?: any) : any =>
    (Object.entries(record.mounts) as [string, any][])
  )));
  const lifecycleTransition: any = ({
    pluginId, operation, idempotencyKey, expectedGeneration, input = {},
    commitAdmission = null, commitIrreversible = null
  }: Record<string, any> = {}) : any => {
    if (closing) throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_CLOSING", String(pluginId || ""), operation, lifecycleGeneration);
    const id: any = String(pluginId || "").trim();
    const action: any = String(operation || "").trim();
    const key: any = String(idempotencyKey || "").trim();
    let inputSnapshot: any;
    try {
      inputSnapshot = immutableInput(input);
    } catch {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_REQUEST_INVALID", id, action, lifecycleGeneration);
    }
    const requestDigest: any = createHash("sha256").update(canonicalJson(inputSnapshot)).digest("hex");
    const entry: any = lifecycleRecords.get(id);
    if (!entry || !["disable", "uninstall"].includes(action) || !key || key.length > 256) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_REQUEST_INVALID", id, action, lifecycleGeneration);
    }
    if (!entry.record.lifecycle) {
      throw new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_UNSUPPORTED", id, action, lifecycleGeneration);
    }
    const activeDependents: any = [...lifecycleRecords.values()]
      .filter((candidate?: any) : any => candidate.state === "active" && candidate.record.manifest.dependencies.includes(id))
      .map((candidate?: any) : any => candidate.record.id)
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
    const requestedGeneration: any = Number(expectedGeneration);
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
    const previous: Readonly<Record<string, any>> = Object.freeze({
      state: entry.state,
      operation: entry.operation,
      idempotencyKey: entry.idempotencyKey,
      requestDigest: entry.requestDigest,
      generation: entry.transitionGeneration || lifecycleGeneration
    });
    const transitionGeneration: any = lifecycleGeneration + 1;
    entry.operation = action;
    entry.idempotencyKey = key;
    entry.requestDigest = requestDigest;
    entry.admissionExpectedGeneration = requestedGeneration;
    entry.transitionGeneration = transitionGeneration;
    const executeTransition: any = async () : Promise<any> => {
      let prepareAttempted: any = false;
      let admissionCommitted: any = false;
      let pendingLedgerAttempted: any = false;
      try {
        const persisted: any = validateLifecycleLedger(
          await entry.record.lifecycleStatePort?.readRecord?.("ledger") || null,
          id
        );
        if (persisted && persisted.state !== "active") {
          const sameRequest: any = persisted.operation === action &&
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
          const prepared: any = await entry.record.lifecycle.prepareTransition(Object.freeze({
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
        const result: any = await entry.record.lifecycle.transition(Object.freeze({
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
        const finalState: any = action === "disable" ? "inactive" : "uninstalled";
        if (action === "uninstall") {
          const snapshot: any = entry.record.artifactSnapshot;
          const port: any = entry.record.artifactAuthorityPort;
          if (!snapshot || port?.id !== "PluginArtifactAuthorityPort" || typeof port.remove !== "function") {
            throw new Error("Plugin artifact removal authority is unavailable.");
          }
          const removal: any = await port.remove({
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
      } catch (error: any) {
        if (prepareAttempted && !admissionCommitted) {
          const recoveryFailures: any[] = [];
          try {
            const aborted: any = await entry.record.lifecycle.abortPreparedTransition?.(Object.freeze({
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
          } catch (abortError: any) {
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
            } catch (ledgerRecoveryError: any) {
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
            const recoveryError: any = new PluginLifecycleTransitionError(
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
        const transitionError: any = new PluginLifecycleTransitionError("PLUGIN_LIFECYCLE_TRANSITION_FAILED", id, action, transitionGeneration);
        transitionError.cause = error;
        throw transitionError;
      }
    };
    const task: any = Promise.resolve(
      entry.record.lifecycleStatePort?.runExclusive
        ? entry.record.lifecycleStatePort.runExclusive(executeTransition)
        : executeTransition()
    ).finally(() : any => transitionTasks.delete(id));
    transitionTasks.set(id, task);
    return task;
  };
  const close: any = createRetryableCloser(
    records.map((record?: any) : any => () : any => record.close()),
    () : any => new PluginRuntimeCloseError()
  );

  return Object.freeze({
    get mounts() : any {
      return visibleMounts();
    },
    get mountRouting() : any {
      return mergeRuntimeRouting(visibleRecords().map((record?: any) : any => record.manifest));
    },
    get contributions() : any {
      return mergeRuntimeContributions(visibleRecords());
    },
    get plugins() : any {
      return publicDeployment(deployment, visibleRecords());
    },
    get lifecycleGeneration() : any {
      return lifecycleGeneration;
    },
    getPluginArtifactGenerationDigest(pluginId?: any) : any {
      const entry: any = lifecycleRecords.get(String(pluginId || "").trim());
      const snapshot: any = entry && ["active", "removal_pending", "inactive"].includes(entry.state)
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
    onPluginContributionChange(listener?: any) : any {
      if (typeof listener !== "function") throw new TypeError("Plugin contribution listener must be a function.");
      const unsubscribers: any = visibleRecords().map((record?: any) : any => record.subscribeContributionChanges(listener));
      return () : any => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    transitionPluginLifecycle: lifecycleTransition,
    async close() : Promise<any> {
      closing = true;
      await Promise.allSettled([...transitionTasks.values()]);
      return close();
    }
  });
}
