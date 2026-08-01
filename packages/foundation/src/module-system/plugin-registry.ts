import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import path from "node:path";
import { createHash } from "node:crypto";

export const PLUGIN_MANIFEST_SCHEMA_VERSION: any = "v0.0.1:plugin:manifest-1";

const PLUGIN_ID_PATTERN: any = /^[a-z][a-z0-9-]*$/u;
const DEPLOYMENT_PROFILE_ID_PATTERN: any = /^[a-z][a-z0-9._-]*$/u;
const CLAIM_ID_PATTERN: any = /^[a-z][a-zA-Z0-9._-]*$/u;
const MCP_TOOL_ID_PATTERN: any = CLAIM_ID_PATTERN;
const RUNTIME_MODULE_PATTERN: any = /^\.\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ts$/u;
const VERIFIER_SOURCE_PATTERN: any = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ts$/u;
const VERIFIER_WORKLOAD_PATTERN: any = /^plugin_verifier\.[a-z][a-z0-9._-]*$/u;
const TOP_LEVEL_FIELDS: any = new Set<any>([
  "schemaVersion",
  "id",
  "label",
  "version",
  "description",
  "defaultEnabled",
  "dependencies",
  "hostCapabilities",
  "artifactSigningPurposes",
  "features",
  "operations",
  "opaqueInputPreprocessing",
  "hostPathInputPreprocessing",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks",
  "contributionMode",
  "runtime",
  "mounts",
  "mountRouting"
]);
const normalizedManifests: any = new WeakSet<object>();
const manifestDigests: any = new WeakMap<object, any>();
const manifestArtifactSnapshots: any = new WeakMap<object, any>();


function sha256(value?: any) : any {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(value?: any, allowed?: any, label?: any) : any {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`${label} contains unsupported field ${field}.`);
    }
  }
}

function requiredString(value?: any, label?: any) : any {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value?: any, label?: any) : any {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  return value.trim();
}

function uniqueStringList(value?: any, label?: any, { normalize = (item?: any) : any => item }: Record<string, any> = {}) : any {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const output: any[] = [];
  const seen: any = new Set<any>();
  for (const entry of value) {
    const item: any = normalize(requiredString(entry, `${label} entry`));
    if (seen.has(item)) {
      throw new Error(`${label} contains duplicate entry ${item}.`);
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function normalizePluginId(value?: any, label: any = "plugin id") : any {
  const id: any = requiredString(value, label);
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: ${id}.`);
  }
  return id;
}

function normalizeClaimId(value?: any, label?: any) : any {
  const id: any = requiredString(value, label);
  if (!CLAIM_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: ${id}.`);
  }
  return id;
}

function normalizeMcpToolId(value?: any, label?: any) : any {
  const id: any = requiredString(value, label);
  if (!MCP_TOOL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: ${id}.`);
  }
  return id;
}

function normalizeRoute(route?: any, index?: any) : any {
  if (!isPlainObject(route)) {
    throw new Error(`Plugin route ${index} must be an object.`);
  }
  assertAllowedFields(route, new Set<any>(["id", "path", "kind"]), `Plugin route ${index}`);
  return Object.freeze({
    id: normalizeClaimId(route.id, `plugin route ${index} id`),
    path: optionalString(route.path, `plugin route ${index} path`),
    kind: optionalString(route.kind, `plugin route ${index} kind`)
  });
}

function normalizeVerifierHook(hook?: any, index?: any) : any {
  if (!isPlainObject(hook)) {
    throw new Error(`Plugin verifier hook ${index} must be an object.`);
  }
  assertAllowedFields(hook, new Set<any>(["id", "workloadKind", "source", "report"]), `Plugin verifier hook ${index}`);
  const workloadKind: any = requiredString(hook.workloadKind, `plugin verifier hook ${index} workloadKind`);
  const source: any = requiredString(hook.source, `plugin verifier hook ${index} source`);
  if (!VERIFIER_WORKLOAD_PATTERN.test(workloadKind)) {
    throw new Error(`Plugin verifier hook ${index} workloadKind must be a dedicated plugin_verifier.* configured workload.`);
  }
  if (
    !VERIFIER_SOURCE_PATTERN.test(source) ||
    !source.startsWith("verifiers/") ||
    source.includes("\\") ||
    source.split("/").some((segment?: any) : any => segment === ".." || segment === "")
  ) {
    throw new Error(`Plugin verifier hook ${index} source must be a normalized artifact-relative verifiers/*.ts path.`);
  }
  return Object.freeze({
    id: normalizeClaimId(hook.id, `plugin verifier hook ${index} id`),
    workloadKind,
    source,
    report: optionalString(hook.report, `plugin verifier hook ${index} report`)
  });
}

function normalizeRuntime(value?: any) : any {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new Error("Plugin runtime must be an object when provided.");
  }
  assertAllowedFields(value, new Set<any>(["module"]), "Plugin runtime");
  const module: any = requiredString(value.module, "Plugin runtime module");
  const normalizedModule: any = `./${path.posix.normalize(module.slice(2))}`;
  if (
    !RUNTIME_MODULE_PATTERN.test(module) ||
    module.includes("\\") ||
    module.split("/").includes("..") ||
    normalizedModule !== module
  ) {
    throw new Error("Plugin runtime module must be a normalized relative .ts path inside the plugin directory.");
  }
  return Object.freeze({ module });
}

function normalizeMounts(value?: any) : any {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) {
    throw new Error("Plugin mounts must be an object when provided.");
  }
  const output: Record<string, any> = {};
  for (const [rawName, rawMount] of (Object.entries(value) as [string, any][])) {
    const name: any = normalizeClaimId(rawName, "plugin mount name");
    if (!isPlainObject(rawMount)) {
      throw new Error(`Plugin mount ${name} must be an object.`);
    }
    assertAllowedFields(rawMount, new Set<any>(["id", "kind"]), `Plugin mount ${name}`);
    output[name] = Object.freeze({
      id: rawMount.id === undefined ? name : normalizeClaimId(rawMount.id, `plugin mount ${name} id`),
      kind: requiredString(rawMount.kind, `plugin mount ${name} kind`)
    });
  }
  return Object.freeze(output);
}

function normalizeRouteTarget(value?: any, label?: any) : any {
  if (typeof value === "string") {
    return Object.freeze({ mountName: normalizeClaimId(value, `${label} mount`), action: "" });
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label} must target a mount.`);
  }
  assertAllowedFields(value, new Set<any>(["mountName", "action"]), label);
  return Object.freeze({
    mountName: normalizeClaimId(value.mountName, `${label} mountName`),
    action: optionalString(value.action, `${label} action`)
  });
}

function normalizeRouteMap(value?: any, label?: any, normalizeKey?: any) : any {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const output: Record<string, any> = {};
  for (const [rawKey, target] of (Object.entries(value) as [string, any][])) {
    const key: any = normalizeKey(requiredString(rawKey, `${label} key`));
    if (!key) throw new Error(`${label} contains an empty key.`);
    output[key] = normalizeRouteTarget(target, `${label} ${key}`);
  }
  return Object.freeze(output);
}

function normalizeMountRouting(value?: any, mounts?: any) : any {
  if (value === undefined) {
    return Object.freeze({
      kindRoutes: Object.freeze({}),
      extensionRoutes: Object.freeze({}),
      mediaTypeRoutes: Object.freeze({})
    });
  }
  if (!isPlainObject(value)) {
    throw new Error("Plugin mountRouting must be an object when provided.");
  }
  assertAllowedFields(
    value,
    new Set<any>(["kindRoutes", "extensionRoutes", "mediaTypeRoutes"]),
    "Plugin mountRouting"
  );
  const routing: Readonly<Record<string, any>> = Object.freeze({
    kindRoutes: normalizeRouteMap(value.kindRoutes, "Plugin kindRoutes", (key?: any) : any => key),
    extensionRoutes: normalizeRouteMap(
      value.extensionRoutes,
      "Plugin extensionRoutes",
      (key?: any) : any => (key.startsWith(".") ? key : `.${key}`).toLowerCase()
    ),
    mediaTypeRoutes: normalizeRouteMap(
      value.mediaTypeRoutes,
      "Plugin mediaTypeRoutes",
      (key?: any) : any => key.toLowerCase()
    )
  });
  for (const routeMap of (Object.values(routing) as any[])) {
    for (const target of (Object.values(routeMap) as any[])) {
      if (!Object.hasOwn(mounts, target.mountName)) {
        throw new Error(`Plugin mount route targets undeclared mount ${target.mountName}.`);
      }
    }
  }
  return routing;
}

function publicManifest(manifest?: any) : any {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    label: manifest.label,
    version: manifest.version,
    description: manifest.description,
    defaultEnabled: false,
    dependencies: Object.freeze([...manifest.dependencies]),
    hostCapabilities: Object.freeze([...manifest.hostCapabilities]),
    artifactSigningPurposes: Object.freeze([...manifest.artifactSigningPurposes]),
    features: Object.freeze([...manifest.features]),
    operations: Object.freeze([...manifest.operations]),
    opaqueInputPreprocessing: manifest.opaqueInputPreprocessing,
    hostPathInputPreprocessing: manifest.hostPathInputPreprocessing,
    routes: Object.freeze([...manifest.routes]),
    mcpTools: Object.freeze([...manifest.mcpTools]),
    consoleEntries: Object.freeze([...manifest.consoleEntries]),
    stateMachines: Object.freeze([...manifest.stateMachines]),
    verifierHooks: Object.freeze([...manifest.verifierHooks]),
    contributionMode: manifest.contributionMode,
    runtime: manifest.runtime,
    mounts: manifest.mounts,
    mountRouting: manifest.mountRouting
  });
}

const OPAQUE_INPUT_PREPROCESSING_SCHEMA: any = "v0.0.1:plugin:opaque-input-preprocessing-1";
const OPAQUE_INPUT_HANDLE_SCHEMA: any = "v0.0.1:plugin:opaque-input-handle-1";
const OPAQUE_INPUT_FIELD_PATTERN: any = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const OPAQUE_INPUT_MEDIA_TYPE_PATTERN: any = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const MAX_OPAQUE_INPUT_BYTES: any = 256 * 1024 * 1024;

function normalizeOpaqueInputPreprocessing(value?: any, operationIds?: any) : any {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new Error("Plugin opaqueInputPreprocessing must be an object.");
  const output: Record<string, any> = {};
  for (const [operationId, declarations] of (Object.entries(value) as [string, any][])) {
    if (!operationIds.includes(operationId)) {
      throw new Error(`Plugin opaque input preprocessing targets undeclared operation ${operationId}.`);
    }
    if (!Array.isArray(declarations) || declarations.length < 1 || declarations.length > 8) {
      throw new Error(`Plugin opaque input preprocessing for ${operationId} must contain one to eight declarations.`);
    }
    const sources: any = new Set<any>();
    const targets: any = new Set<any>();
    output[operationId] = Object.freeze(declarations.map((declaration?: any, index?: any) : any => {
      const label: any = `Plugin opaque input preprocessing ${operationId}[${index}]`;
      if (!isPlainObject(declaration)) throw new Error(`${label} must be an object.`);
      assertAllowedFields(declaration, new Set<any>([
        "schemaVersion", "encoding", "sourceField", "targetField", "mediaType", "maxBytes",
        "outputSchemaVersion"
      ]), label);
      if (declaration.schemaVersion !== OPAQUE_INPUT_PREPROCESSING_SCHEMA ||
          declaration.outputSchemaVersion !== OPAQUE_INPUT_HANDLE_SCHEMA ||
          declaration.encoding !== "base64") {
        throw new Error(`${label} has an unsupported schema or encoding.`);
      }
      const sourceField: any = requiredString(declaration.sourceField, `${label} sourceField`);
      const targetField: any = requiredString(declaration.targetField, `${label} targetField`);
      const mediaType: any = requiredString(declaration.mediaType, `${label} mediaType`).toLowerCase();
      const maxBytes: any = Number(declaration.maxBytes);
      if (!OPAQUE_INPUT_FIELD_PATTERN.test(sourceField) || !OPAQUE_INPUT_FIELD_PATTERN.test(targetField) ||
          sourceField === targetField || sources.has(sourceField) || targets.has(targetField)) {
        throw new Error(`${label} has invalid or duplicate fields.`);
      }
      if (!OPAQUE_INPUT_MEDIA_TYPE_PATTERN.test(mediaType)) throw new Error(`${label} mediaType is invalid.`);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OPAQUE_INPUT_BYTES) {
        throw new Error(`${label} maxBytes is invalid.`);
      }
      sources.add(sourceField);
      targets.add(targetField);
      return Object.freeze({
        schemaVersion: OPAQUE_INPUT_PREPROCESSING_SCHEMA,
        encoding: "base64",
        sourceField,
        targetField,
        mediaType,
        maxBytes,
        outputSchemaVersion: OPAQUE_INPUT_HANDLE_SCHEMA
      });
    }));
  }
  return Object.freeze(output);
}

const HOST_PATH_INPUT_PREPROCESSING_SCHEMA: any = "v0.0.1:plugin:host-path-input-preprocessing-1";

function normalizeHostPathInputPreprocessing(value?: any, operationIds?: any) : any {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new Error("Plugin hostPathInputPreprocessing must be an object.");
  const output: Record<string, any> = {};
  for (const [operationId, declarations] of (Object.entries(value) as [string, any][])) {
    if (!operationIds.includes(operationId)) {
      throw new Error(`Plugin host path input preprocessing targets undeclared operation ${operationId}.`);
    }
    if (!Array.isArray(declarations) || declarations.length !== 1) {
      throw new Error(`Plugin host path input preprocessing for ${operationId} must contain exactly one declaration.`);
    }
    const declaration: any = declarations[0];
    const label: any = `Plugin host path input preprocessing ${operationId}[0]`;
    if (!isPlainObject(declaration)) throw new Error(`${label} must be an object.`);
    assertAllowedFields(declaration, new Set<any>(["schemaVersion", "kind", "sourceField", "targetField"]), label);
    const sourceField: any = requiredString(declaration.sourceField, `${label} sourceField`);
    const targetField: any = requiredString(declaration.targetField, `${label} targetField`);
    if (declaration.schemaVersion !== HOST_PATH_INPUT_PREPROCESSING_SCHEMA ||
        declaration.kind !== "local-directory-selection" ||
        !OPAQUE_INPUT_FIELD_PATTERN.test(sourceField) || !OPAQUE_INPUT_FIELD_PATTERN.test(targetField) ||
        sourceField === targetField) {
      throw new Error(`${label} is invalid.`);
    }
    output[operationId] = Object.freeze([Object.freeze({
      schemaVersion: HOST_PATH_INPUT_PREPROCESSING_SCHEMA,
      kind: "local-directory-selection",
      sourceField,
      targetField
    })]);
  }
  return Object.freeze(output);
}

export function normalizePluginManifest(manifest: Record<string, any> = {}, {
  artifactSnapshot = null
}: Record<string, any> = {}) : any {
  if (!isPlainObject(manifest)) {
    throw new Error("Plugin manifest must be a JSON object.");
  }
  assertAllowedFields(manifest, TOP_LEVEL_FIELDS, "Plugin manifest");
  if (manifest.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Plugin manifest schemaVersion must be ${PLUGIN_MANIFEST_SCHEMA_VERSION}.`);
  }
  if (manifest.defaultEnabled !== undefined && manifest.defaultEnabled !== false) {
    throw new Error("Plugins require explicit deployment selection; defaultEnabled must be false when provided.");
  }
  const id: any = normalizePluginId(manifest.id);
  const mounts: any = normalizeMounts(manifest.mounts);
  const operations: any = uniqueStringList(manifest.operations, "Plugin operations", {
    normalize: (item?: any) : any => normalizeClaimId(item, "plugin operation")
  });
  const normalized: any = publicManifest({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    label: requiredString(manifest.label, "Plugin label"),
    version: requiredString(manifest.version, "Plugin version"),
    description: optionalString(manifest.description, "Plugin description"),
    dependencies: uniqueStringList(manifest.dependencies, "Plugin dependencies", {
      normalize: (item?: any) : any => normalizePluginId(item, "plugin dependency")
    }),
    hostCapabilities: uniqueStringList(manifest.hostCapabilities, "Plugin host capabilities", {
      normalize: (item?: any) : any => {
        if (!["owner-process-identity", "controlled-execution", "protected-recovery", "downstream-client-aspect", "outbound-egress-policy"].includes(item)) {
          throw new Error(`Plugin host capability ${item} is unsupported.`);
        }
        return item;
      }
    }),
    artifactSigningPurposes: uniqueStringList(manifest.artifactSigningPurposes, "Plugin artifact signing purposes", {
      normalize: (item?: any) : any => {
        const purpose: any = requiredString(item, "Plugin artifact signing purpose");
        if (!purpose.startsWith(`plugin-artifact.${id}.`) || !/^[a-z0-9._-]+$/u.test(purpose)) {
          throw new Error(`Plugin artifact signing purpose ${purpose} is invalid.`);
        }
        return purpose;
      }
    }),
    features: uniqueStringList(manifest.features, "Plugin features"),
    operations,
    opaqueInputPreprocessing: normalizeOpaqueInputPreprocessing(manifest.opaqueInputPreprocessing, operations),
    hostPathInputPreprocessing: normalizeHostPathInputPreprocessing(manifest.hostPathInputPreprocessing, operations),
    routes: Array.isArray(manifest.routes)
      ? manifest.routes.map((route?: any, index?: any) : any => normalizeRoute(route, index))
      : manifest.routes === undefined
        ? []
        : (() : any => { throw new Error("Plugin routes must be an array."); })(),
    mcpTools: uniqueStringList(manifest.mcpTools, "Plugin MCP tools", {
      normalize: (item?: any) : any => normalizeMcpToolId(item, "plugin MCP tool")
    }),
    consoleEntries: uniqueStringList(manifest.consoleEntries, "Plugin console entries", {
      normalize: (item?: any) : any => normalizeClaimId(item, "plugin console entry")
    }),
    stateMachines: uniqueStringList(manifest.stateMachines, "Plugin state machines", {
      normalize: (item?: any) : any => normalizeClaimId(item, "plugin state machine")
    }),
    verifierHooks: Array.isArray(manifest.verifierHooks)
      ? manifest.verifierHooks.map((hook?: any, index?: any) : any => normalizeVerifierHook(hook, index))
      : manifest.verifierHooks === undefined
        ? []
        : (() : any => { throw new Error("Plugin verifierHooks must be an array."); })(),
    contributionMode: optionalString(manifest.contributionMode, "Plugin contributionMode") || "exact",
    runtime: normalizeRuntime(manifest.runtime),
    mounts,
    mountRouting: normalizeMountRouting(manifest.mountRouting, mounts)
  });
  if (!["exact", "selected"].includes(normalized.contributionMode)) {
    throw new Error("Plugin contributionMode must be exact or selected.");
  }
  if (normalized.dependencies.includes(id)) {
    throw new Error(`Plugin ${id} cannot depend on itself.`);
  }
  if (artifactSnapshot) manifestArtifactSnapshots.set(normalized, artifactSnapshot);
  normalizedManifests.add(normalized);
  manifestDigests.set(normalized, sha256(canonicalJson(normalized)));
  return normalized;
}

export async function discoverPluginManifests({
  artifactAuthority
}: Record<string, any> = {}) : Promise<any> {
  if (artifactAuthority?.id !== "PluginArtifactAuthority" || typeof artifactAuthority.discover !== "function") {
    throw new TypeError("Plugin discovery requires the canonical Host artifact authority.");
  }
  const snapshots: any = await artifactAuthority.discover();
  const manifests: any[] = [];
  for (const snapshot of snapshots) {
    let manifest: any;
    try {
      manifest = await snapshot.readManifest();
    } catch {
      throw new Error(`Plugin artifact manifest ${snapshot.pluginId} is not valid JSON.`);
    }
    const normalized: any = normalizePluginManifest(manifest, {
      artifactSnapshot: snapshot
    });
    if (normalized.id !== snapshot.pluginId || normalized.version !== snapshot.version ||
        canonicalJson([...normalized.dependencies].sort()) !== canonicalJson(snapshot.dependencyClosure.map((entry?: any) : any => entry.pluginId))) {
      throw new Error(`Plugin artifact ${snapshot.pluginId} manifest does not match its signed snapshot.`);
    }
    manifests.push(normalized);
  }
  return manifests;
}

function assertUniqueClaim(index?: any, claimId?: any, pluginId?: any, claimKind?: any) : any {
  const existing: any = index.get(claimId);
  if (existing) {
    throw new Error(`Duplicate plugin ${claimKind} claim ${claimId}: ${existing} and ${pluginId}.`);
  }
  index.set(claimId, pluginId);
}

function validateDependencyGraph(plugins?: any) : any {
  const visiting: any = new Set<any>();
  const visited: any = new Set<any>();
  function visit(id?: any) : any {
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    const plugin: any = plugins.get(id);
    visiting.add(id);
    for (const dependencyId of [...plugin.dependencies].sort()) {
      if (!plugins.has(dependencyId)) {
        throw new Error(`Plugin ${id} depends on unregistered plugin ${dependencyId}.`);
      }
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...plugins.keys()].sort()) visit(id);
}

export function normalizeEnabledPluginIds(value?: any) : any {
  if (value === undefined) return [];
  return uniqueStringList(value, "Enabled plugin ids", {
    normalize: (item?: any) : any => normalizePluginId(item, "enabled plugin id")
  });
}

function normalizeDeploymentProfileId(value?: any) : any {
  if (value === undefined || value === null) return null;
  const id: any = requiredString(value, "Plugin deployment profile id");
  if (!DEPLOYMENT_PROFILE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid plugin deployment profile id: ${id}.`);
  }
  return id;
}

function deploymentProfilePayload({
  id,
  enabledPluginIds,
  configuredPluginIds,
  pluginIdentities,
  dependencyOrder
}: Record<string, any>) : any {
  return {
    id,
    enabledPluginIds,
    configuredPluginIds,
    pluginIdentities,
    dependencyOrder
  };
}

export function validatePluginDeployment(deployment?: any) : any {
  if (!isPlainObject(deployment) || !Array.isArray(deployment.loadedPlugins)) {
    throw new TypeError("Plugin deployment is required.");
  }
  const enabledPluginIds: any = normalizeEnabledPluginIds(deployment.enabledPluginIds);
  const configuredPluginIds: any = normalizeEnabledPluginIds(deployment.configuredPluginIds);
  const enabledSet: any = new Set<any>(enabledPluginIds);
  const loadedIds: any = deployment.loadedPlugins.map((plugin?: any) : any => normalizePluginId(plugin?.id));
  if (new Set<any>(loadedIds).size !== loadedIds.length ||
      enabledSet.size !== loadedIds.length ||
      loadedIds.some((id?: any) : any => !enabledSet.has(id))) {
    throw new Error("Plugin deployment loaded set does not match its enabled selection.");
  }
  const loadedBefore: any = new Set<any>();
  for (const plugin of deployment.loadedPlugins) {
    for (const dependencyId of plugin.dependencies) {
      if (!enabledSet.has(dependencyId) || !loadedBefore.has(dependencyId)) {
        throw new Error(`Plugin deployment order does not satisfy ${plugin.id} dependency ${dependencyId}.`);
      }
    }
    loadedBefore.add(plugin.id);
  }

  const profile: any = deployment.deploymentProfile;
  if (profile === undefined || profile === null) return deployment;
  if (!isPlainObject(profile)) throw new TypeError("Plugin deployment profile must be an object.");
  const profileId: any = normalizeDeploymentProfileId(profile.id);
  const profileEnabledIds: any = normalizeEnabledPluginIds(profile.enabledPluginIds);
  const profileConfiguredIds: any = normalizeEnabledPluginIds(profile.configuredPluginIds);
  const dependencyOrder: any = normalizeEnabledPluginIds(profile.dependencyOrder);
  if (!Array.isArray(profile.pluginIdentities)) {
    throw new TypeError("Plugin deployment profile identities must be an array.");
  }
  const pluginIdentities: any = deployment.loadedPlugins.map((plugin?: any, index?: any) : any => {
    const identity: any = profile.pluginIdentities[index];
    const manifestDigest: any = manifestDigests.get(plugin);
    const artifactSnapshot: any = manifestArtifactSnapshots.get(plugin) || null;
    if (!isPlainObject(identity) || !manifestDigest || identity.id !== plugin.id ||
        identity.version !== plugin.version || identity.manifestDigest !== manifestDigest ||
        identity.artifactDigest !== (artifactSnapshot?.artifactDigest || null) ||
        identity.artifactGeneration !== (artifactSnapshot?.generation || null) ||
        identity.artifactKeyId !== (artifactSnapshot?.keyId || null) ||
        identity.coreContractDigest !== (artifactSnapshot?.coreContractDigest || null)) {
      throw new Error("Plugin deployment profile identity does not match the loaded plugin manifest.");
    }
    return {
      id: identity.id,
      version: identity.version,
      manifestDigest: identity.manifestDigest,
      artifactDigest: identity.artifactDigest,
      artifactGeneration: identity.artifactGeneration,
      artifactKeyId: identity.artifactKeyId,
      coreContractDigest: identity.coreContractDigest
    };
  });
  if (profile.pluginIdentities.length !== pluginIdentities.length ||
      canonicalJson(profileEnabledIds) !== canonicalJson(enabledPluginIds) ||
      canonicalJson(profileConfiguredIds) !== canonicalJson(configuredPluginIds) ||
      canonicalJson(dependencyOrder) !== canonicalJson(loadedIds)) {
    throw new Error("Plugin deployment profile does not match the deployment selection.");
  }
  const expectedDigest: any = sha256(canonicalJson(deploymentProfilePayload({
    id: profileId,
    enabledPluginIds,
    configuredPluginIds,
    pluginIdentities,
    dependencyOrder: loadedIds
  })));
  if (profile.digest !== expectedDigest) {
    throw new Error("Plugin deployment profile digest does not match its bound deployment.");
  }
  return deployment;
}

function deploymentOrder(plugins?: any, selected?: any) : any {
  const ordered: any[] = [];
  const visited: any = new Set<any>();
  function visit(id?: any) : any {
    if (visited.has(id)) return;
    const plugin: any = plugins.get(id);
    for (const dependencyId of [...plugin.dependencies].sort()) visit(dependencyId);
    visited.add(id);
    ordered.push(plugin);
  }
  for (const id of [...selected].sort()) visit(id);
  return ordered;
}

function routeClaimEntries(manifest?: any) : any {
  return [
    ...Object.keys(manifest.mountRouting.kindRoutes).map((key?: any) : any => [`kind:${key}`, "mount route"]),
    ...Object.keys(manifest.mountRouting.extensionRoutes).map((key?: any) : any => [`extension:${key}`, "mount route"]),
    ...Object.keys(manifest.mountRouting.mediaTypeRoutes).map((key?: any) : any => [`media-type:${key}`, "mount route"])
  ];
}

export function createPluginRegistry(manifests: any = []) : any {
  if (!Array.isArray(manifests)) throw new Error("Plugin manifests must be an array.");
  const plugins: any = new Map<any, any>();
  const featureClaims: any = new Map<any, any>();
  const operationClaims: any = new Map<any, any>();
  const toolClaims: any = new Map<any, any>();
  const routeClaims: any = new Map<any, any>();
  const consoleClaims: any = new Map<any, any>();
  const stateMachineClaims: any = new Map<any, any>();
  const verifierHookClaims: any = new Map<any, any>();
  const mountClaims: any = new Map<any, any>();
  const mountIdClaims: any = new Map<any, any>();
  const mountRouteClaims: any = new Map<any, any>();

  for (const source of manifests) {
    const manifest: any = normalizedManifests.has(source)
      ? source
      : normalizePluginManifest(source);
    if (plugins.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}.`);
    plugins.set(manifest.id, manifest);
    for (const featureId of manifest.features) {
      assertUniqueClaim(featureClaims, featureId, manifest.id, "feature");
    }
    for (const operationId of manifest.operations) {
      assertUniqueClaim(operationClaims, operationId, manifest.id, "operation");
    }
    for (const toolId of manifest.mcpTools) {
      assertUniqueClaim(toolClaims, toolId, manifest.id, "MCP tool");
    }
    for (const route of manifest.routes) {
      assertUniqueClaim(routeClaims, route.id, manifest.id, "route");
    }
    for (const entryId of manifest.consoleEntries) {
      assertUniqueClaim(consoleClaims, entryId, manifest.id, "console entry");
    }
    for (const stateMachineId of manifest.stateMachines) {
      assertUniqueClaim(stateMachineClaims, stateMachineId, manifest.id, "state machine");
    }
    for (const verifierHook of manifest.verifierHooks) {
      assertUniqueClaim(verifierHookClaims, verifierHook.id, manifest.id, "verifier hook");
    }
    for (const mountName of Object.keys(manifest.mounts)) {
      assertUniqueClaim(mountClaims, mountName, manifest.id, "mount");
      assertUniqueClaim(mountIdClaims, manifest.mounts[mountName].id, manifest.id, "mount id");
    }
    for (const [claim, kind] of routeClaimEntries(manifest)) {
      assertUniqueClaim(mountRouteClaims, claim, manifest.id, kind);
    }
  }
  validateDependencyGraph(plugins);
  for (const manifest of plugins.values()) {
    const snapshot: any = manifestArtifactSnapshots.get(manifest);
    if (!snapshot) continue;
    for (const dependency of snapshot.dependencyClosure) {
      const dependencyManifest: any = plugins.get(dependency.pluginId);
      const dependencySnapshot: any = dependencyManifest ? manifestArtifactSnapshots.get(dependencyManifest) : null;
      if (!dependencySnapshot || dependencyManifest.version !== dependency.version ||
          dependencySnapshot.artifactDigest !== dependency.artifactDigest ||
          dependencySnapshot.generation !== dependency.generation) {
        throw new Error(`Plugin ${manifest.id} signed dependency closure does not match installed artifacts.`);
      }
    }
  }

  function resolveDeployment({
    enabledPluginIds,
    configuredPluginIds,
    deploymentProfileId
  }: Record<string, any> = {}) : any {
    const explicit: any = new Set<any>(normalizeEnabledPluginIds(enabledPluginIds));
    const configured: any = new Set<any>(normalizeEnabledPluginIds(configuredPluginIds));
    const profileId: any = normalizeDeploymentProfileId(deploymentProfileId);
    for (const id of explicit) {
      const plugin: any = plugins.get(id);
      if (!plugin) throw new Error(`Deployment selected unknown plugin: ${id}.`);
      for (const dependencyId of plugin.dependencies) {
        if (!explicit.has(dependencyId)) {
          throw new Error(`Deployment selected ${id} without required plugin dependency ${dependencyId}.`);
        }
      }
    }
    for (const id of configured) {
      if (!plugins.has(id)) {
        throw new Error(`Deployment configured unknown plugin: ${id}.`);
      }
    }
    const loadedPlugins: any = deploymentOrder(plugins, explicit);
    const enabledIds: any = [...explicit].sort();
    const configuredIds: any = [...configured].sort();
    const pluginIdentities: any = loadedPlugins.map((plugin?: any) : any => Object.freeze({
      id: plugin.id,
      version: plugin.version,
      manifestDigest: manifestDigests.get(plugin),
      artifactDigest: manifestArtifactSnapshots.get(plugin)?.artifactDigest || null,
      artifactGeneration: manifestArtifactSnapshots.get(plugin)?.generation || null,
      artifactKeyId: manifestArtifactSnapshots.get(plugin)?.keyId || null,
      coreContractDigest: manifestArtifactSnapshots.get(plugin)?.coreContractDigest || null
    }));
    const dependencyOrder: any = loadedPlugins.map((plugin?: any) : any => plugin.id);
    const deploymentProfile: any = profileId === null
      ? null
      : Object.freeze({
          id: profileId,
          digest: sha256(canonicalJson(deploymentProfilePayload({
            id: profileId,
            enabledPluginIds: enabledIds,
            configuredPluginIds: configuredIds,
            pluginIdentities,
            dependencyOrder
          }))),
          enabledPluginIds: Object.freeze(enabledIds),
          configuredPluginIds: Object.freeze(configuredIds),
          pluginIdentities: Object.freeze(pluginIdentities),
          dependencyOrder: Object.freeze(dependencyOrder)
        });
    const deployment: Readonly<Record<string, any>> = Object.freeze({
      deploymentProfile,
      enabledPluginIds: Object.freeze(enabledIds),
      configuredPluginIds: Object.freeze(configuredIds),
      loadedPlugins: Object.freeze(loadedPlugins),
      disabledPluginIds: Object.freeze([...plugins.keys()].filter((id?: any) : any => !explicit.has(id)).sort())
    });
    validatePluginDeployment(deployment);
    return deployment;
  }

  return Object.freeze({
    featureClaims,
    operationClaims,
    toolClaims,
    routeClaims,
    consoleClaims,
    stateMachineClaims,
    verifierHookClaims,
    mountClaims,
    mountIdClaims,
    mountRouteClaims,
    listPlugins() : any {
      return [...plugins.values()].sort((left?: any, right?: any) : any => left.id.localeCompare(right.id));
    },
    getPlugin(id?: any) : any {
      return plugins.get(String(id || "").trim()) || null;
    },
    resolveDeployment
  });
}

export async function resolvePluginRuntimeModuleUrl(manifest?: any) : Promise<any> {
  if (!manifest?.runtime) return null;
  const artifactSnapshot: any = manifestArtifactSnapshots.get(manifest);
  if (!artifactSnapshot || typeof artifactSnapshot.resolveRuntimeModule !== "function") {
    throw new Error(`Plugin ${manifest.id} signed artifact snapshot is unavailable.`);
  }
  return artifactSnapshot.resolveRuntimeModule(manifest.runtime.module);
}

export function pluginManifestArtifactIdentity(manifest?: any) : any {
  const snapshot: any = manifestArtifactSnapshots.get(manifest);
  if (!normalizedManifests.has(manifest) || !snapshot) {
    throw new Error(`Plugin ${manifest?.id || "unknown"} signed artifact snapshot is unavailable.`);
  }
  return Object.freeze({
    pluginId: snapshot.pluginId,
    version: snapshot.version,
    artifactDigest: snapshot.artifactDigest,
    generation: snapshot.generation,
    keyId: snapshot.keyId,
    coreContractDigest: snapshot.coreContractDigest
  });
}

export async function readPluginArtifactFile(manifest?: any, filePath?: any) : Promise<any> {
  const snapshot: any = manifestArtifactSnapshots.get(manifest);
  if (!normalizedManifests.has(manifest) || !snapshot || typeof snapshot.readFile !== "function") {
    throw new Error(`Plugin ${manifest?.id || "unknown"} signed artifact file authority is unavailable.`);
  }
  return snapshot.readFile(filePath);
}

export async function resolvePluginVerifierHookSourceUrl(manifest?: any, hookId?: any) : Promise<any> {
  const id: any = String(hookId || "").trim();
  const declaration: any = normalizedManifests.has(manifest) && id
    ? manifest.verifierHooks.find((hook?: any) : any => hook.id === id)
    : null;
  if (!declaration) {
    throw new Error(`Plugin ${manifest?.id || "unknown"} verifier hook source is not declared.`);
  }
  const artifactSnapshot: any = manifestArtifactSnapshots.get(manifest);
  if (!artifactSnapshot || typeof artifactSnapshot.resolveRuntimeModule !== "function") {
    throw new Error(`Plugin ${manifest.id} signed artifact snapshot is unavailable.`);
  }
  return artifactSnapshot.resolveRuntimeModule(declaration.source);
}

export async function loadPluginRegistry({
  artifactAuthority
}: Record<string, any> = {}) : Promise<any> {
  return createPluginRegistry(await discoverPluginManifests({ artifactAuthority }));
}
