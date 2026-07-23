import fs from "node:fs/promises";
import { operationFeatureId } from "../../../../contracts/src/operations/operation-feature-resolution.mjs";
import {
  DEFAULT_EDITION,
  FEATURE_MANIFEST,
  objectFromEntries,
  uniqueStrings
} from "./feature-manifest-data.mjs";

export { operationFeatureId };
export {
  DEFAULT_EDITION,
  FEATURE_MANIFEST
} from "./feature-manifest-data.mjs";

export function getFeatureEntries() {
  return FEATURE_MANIFEST.features.map((feature) => ({ ...feature }));
}

export function getFeatureMap() {
  return new Map(FEATURE_MANIFEST.features.map((feature) => [feature.featureId, feature]));
}

function splitFeatureList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  return uniqueStrings(String(value || "").split(","));
}

async function readJsonFileIfPresent(filePath) {
  if (!filePath) {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function loadFeatureProfile(profilePath) {
  return readJsonFileIfPresent(profilePath);
}

function normalizeProfileInput(profile = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return {};
  }
  return profile;
}

export function resolveEdition(edition = DEFAULT_EDITION) {
  const editionId = String(edition || DEFAULT_EDITION).trim() || DEFAULT_EDITION;
  const definition = FEATURE_MANIFEST.editions[editionId];
  if (!definition) {
    throw new Error(`Unknown edition: ${editionId}`);
  }
  return Object.freeze({
    edition: editionId,
    definition,
    label: definition.label || editionId,
    includes: Object.freeze(uniqueStrings(definition.includes || []))
  });
}

export function resolveFeatureRuntime({
  edition = DEFAULT_EDITION,
  profile = {},
  enableFeatures = [],
  disableFeatures = [],
  now = new Date()
} = {}) {
  const normalizedProfile = normalizeProfileInput(profile);
  const editionSelection = resolveEdition(normalizedProfile.edition || edition || DEFAULT_EDITION);
  const selectedEdition = editionSelection.edition;

  const featureMap = getFeatureMap();
  const required = FEATURE_MANIFEST.features
    .filter((feature) => feature.required)
    .map((feature) => feature.featureId);
  const baseIncludes = [
    ...required,
    ...(editionSelection.definition?.includes || []),
    ...splitFeatureList(normalizedProfile.features),
    ...splitFeatureList(normalizedProfile.enableFeatures),
    ...splitFeatureList(enableFeatures)
  ];
  const disabled = new Set([
    ...splitFeatureList(normalizedProfile.disableFeatures),
    ...splitFeatureList(disableFeatures)
  ]);

  for (const featureId of disabled) {
    const feature = featureMap.get(featureId);
    if (feature?.required) {
      throw new Error(`Required feature cannot be disabled: ${featureId}`);
    }
  }

  const active = new Set();
  const reasons = {};

  function addFeature(featureId, reason = "selected", requiredBy = "") {
    if (!featureId) {
      return;
    }
    if (disabled.has(featureId)) {
      if (requiredBy) {
        throw new Error(`Feature dependency cannot be disabled: ${requiredBy} depends on ${featureId}`);
      }
      return;
    }
    const feature = featureMap.get(featureId);
    if (!feature) {
      throw new Error(`Unknown feature: ${featureId}`);
    }
    if (feature.pluginId) {
      throw new Error(`Plugin-owned feature ${featureId} must be selected through runtime.enabledPlugins.`);
    }
    if (active.has(featureId)) {
      return;
    }
    active.add(featureId);
    reasons[featureId] = reasons[featureId] || reason;
    for (const dependencyId of feature.dependsOn || []) {
      addFeature(dependencyId, `dependency of ${featureId}`, featureId);
    }
  }

  for (const featureId of baseIncludes) {
    addFeature(featureId, "edition/profile");
  }

  for (const featureId of required) {
    addFeature(featureId, "required core");
  }

  for (const featureId of active) {
    const feature = featureMap.get(featureId);
    for (const conflictId of feature?.conflictsWith || []) {
      if (active.has(conflictId)) {
        throw new Error(`Feature conflict: ${featureId} conflicts with ${conflictId}`);
      }
    }
  }

  const activeFeatureIds = [...active].sort();
  const disabledFeatureIds = FEATURE_MANIFEST.features
    .map((feature) => feature.featureId)
    .filter((featureId) => !active.has(featureId))
    .sort();
  const disabledReasons = objectFromEntries(disabledFeatureIds.map((featureId) => [
    featureId,
    disabled.has(featureId) ? "disabled by profile" : "not included in preset/profile"
  ]));

  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    edition: selectedEdition,
    profileName: String(normalizedProfile.name || selectedEdition),
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    activeFeatureIds,
    disabledFeatureIds,
    requiredFeatureIds: required.sort(),
    activeFeatures: activeFeatureIds.map((featureId) => publicFeatureDefinition(featureMap.get(featureId), reasons[featureId])),
    disabledFeatures: disabledFeatureIds.map((featureId) => publicFeatureDefinition(featureMap.get(featureId), disabledReasons[featureId])),
    reasons,
    disabledReasons,
    groups: summarizeFeatureGroups(activeFeatureIds, disabledFeatureIds, featureMap)
  };
}

export function applyPluginDeploymentFeatures(featureRuntime = {}, deployment = {}) {
  const featureMap = getFeatureMap();
  const active = new Set(featureRuntime.activeFeatureIds || []);
  const reasons = { ...(featureRuntime.reasons || {}) };
  const loadedPlugins = Array.isArray(deployment.loadedPlugins) ? deployment.loadedPlugins : [];
  const loadedPluginIds = new Set(loadedPlugins.map((plugin) => plugin.id));

  for (const plugin of loadedPlugins) {
    for (const featureId of plugin.features || []) {
      const feature = featureMap.get(featureId);
      if (!feature || feature.pluginId !== plugin.id) {
        throw new Error(`Plugin ${plugin.id} claims unowned feature ${featureId}.`);
      }
      for (const dependencyId of feature.dependsOn || []) {
        const dependency = featureMap.get(dependencyId);
        if (dependency?.pluginId && !loadedPluginIds.has(dependency.pluginId)) {
          throw new Error(`Plugin feature ${featureId} requires disabled plugin feature ${dependencyId}.`);
        }
        if (!dependency?.pluginId && !active.has(dependencyId)) {
          throw new Error(`Plugin feature ${featureId} requires inactive core feature ${dependencyId}.`);
        }
      }
      active.add(featureId);
      reasons[featureId] = `enabled plugin ${plugin.id}`;
    }
  }

  const activeFeatureIds = [...active].sort();
  const disabledFeatureIds = FEATURE_MANIFEST.features
    .map((feature) => feature.featureId)
    .filter((featureId) => !active.has(featureId))
    .sort();
  const disabledReasons = objectFromEntries(disabledFeatureIds.map((featureId) => {
    const feature = featureMap.get(featureId);
    return [
      featureId,
      feature?.pluginId
        ? `plugin ${feature.pluginId} is not enabled by runtime.enabledPlugins`
        : featureRuntime.disabledReasons?.[featureId] || "not included in preset/profile"
    ];
  }));

  return {
    ...featureRuntime,
    activeFeatureIds,
    disabledFeatureIds,
    activeFeatures: activeFeatureIds.map((featureId) => publicFeatureDefinition(featureMap.get(featureId), reasons[featureId])),
    disabledFeatures: disabledFeatureIds.map((featureId) => publicFeatureDefinition(featureMap.get(featureId), disabledReasons[featureId])),
    reasons,
    disabledReasons,
    groups: summarizeFeatureGroups(activeFeatureIds, disabledFeatureIds, featureMap)
  };
}

function summarizeFeatureGroups(activeFeatureIds, disabledFeatureIds, featureMap) {
  const groups = {};
  for (const group of FEATURE_MANIFEST.groups) {
    groups[group] = { active: [], disabled: [] };
  }
  for (const featureId of activeFeatureIds) {
    const group = featureMap.get(featureId)?.group || "custom";
    groups[group] = groups[group] || { active: [], disabled: [] };
    groups[group].active.push(featureId);
  }
  for (const featureId of disabledFeatureIds) {
    const group = featureMap.get(featureId)?.group || "custom";
    groups[group] = groups[group] || { active: [], disabled: [] };
    groups[group].disabled.push(featureId);
  }
  return groups;
}

function publicFeatureDefinition(feature = {}, reason = "") {
  return {
    featureId: feature.featureId,
    label: feature.label || feature.featureId,
    group: feature.group || "custom",
    pluginId: feature.pluginId || "",
    required: feature.required === true,
    defaultEnabled: feature.defaultEnabled === true,
    dependsOn: [...(feature.dependsOn || [])],
    conflictsWith: [...(feature.conflictsWith || [])],
    lifecycle: feature.lifecycle || null,
    reason
  };
}

export async function resolveFeatureRuntimeFromEnv({
  args = {},
  runtimeOptions = {},
  env = process.env
} = {}) {
  const profilePath =
    args["feature-profile"] ||
    args.featureProfile ||
    runtimeOptions.featureProfile ||
    env.LICO_FEATURE_PROFILE ||
    "";
  const profile = await loadFeatureProfile(profilePath);
  return resolveFeatureRuntime({
    edition:
      args.edition ||
      runtimeOptions.edition ||
      env.LICO_EDITION ||
      DEFAULT_EDITION,
    profile: profile || {},
    enableFeatures: [
      ...splitFeatureList(args.features),
      ...splitFeatureList(args.enableFeatures),
      ...splitFeatureList(runtimeOptions.features),
      ...splitFeatureList(runtimeOptions.enableFeatures),
      ...splitFeatureList(env.LICO_FEATURES)
    ],
    disableFeatures: [
      ...splitFeatureList(args["without-features"]),
      ...splitFeatureList(args.disableFeatures),
      ...splitFeatureList(runtimeOptions.disableFeatures),
      ...splitFeatureList(env.LICO_DISABLED_FEATURES)
  ]
});
}

export function decorateOperationsWithFeatures(operations = []) {
  return operations.map((operation) => ({
    ...operation,
    featureId: operationFeatureId(operation)
  }));
}

export function filterOperationsForFeatures(operations = [], featureRuntime = null) {
  if (!featureRuntime || !Array.isArray(featureRuntime.activeFeatureIds)) {
    return decorateOperationsWithFeatures(operations);
  }
  const active = new Set(featureRuntime.activeFeatureIds);
  return decorateOperationsWithFeatures(operations)
    .filter((operation) => active.has(operation.featureId));
}

export function publicFeatureRuntime(featureRuntime, operations = []) {
  const activeOperations = filterOperationsForFeatures(operations, featureRuntime);
  return {
    schemaVersion: featureRuntime?.schemaVersion || "v0.0.1:schema:definition-1",
    edition: featureRuntime?.edition || DEFAULT_EDITION,
    profileName: featureRuntime?.profileName || "",
    generatedAt: featureRuntime?.generatedAt || "",
    activeFeatureIds: [...(featureRuntime?.activeFeatureIds || [])],
    disabledFeatureIds: [...(featureRuntime?.disabledFeatureIds || [])],
    activeFeatures: [...(featureRuntime?.activeFeatures || [])],
    disabledFeatures: [...(featureRuntime?.disabledFeatures || [])],
    groups: featureRuntime?.groups || {},
    operations: {
      total: operations.length,
      active: activeOperations.length,
      disabled: Math.max(0, operations.length - activeOperations.length)
    }
  };
}

export function validateFeatureManifest({ operations = [], clientModules = [], validateClientModules = true } = {}) {
  const featureMap = getFeatureMap();
  const errors = [];
  for (const feature of FEATURE_MANIFEST.features) {
    if (!feature.featureId) {
      errors.push("Feature is missing featureId.");
    }
    if (feature.dependsOn) {
      for (const dependencyId of feature.dependsOn) {
        if (!featureMap.has(dependencyId)) {
          errors.push(`Feature ${feature.featureId} depends on unknown feature ${dependencyId}.`);
        }
      }
    }
    if (feature.conflictsWith) {
      for (const conflictId of feature.conflictsWith) {
        if (!featureMap.has(conflictId)) {
          errors.push(`Feature ${feature.featureId} conflicts with unknown feature ${conflictId}.`);
        }
      }
    }
  }

  const featureIds = new Set(FEATURE_MANIFEST.features.map((feature) => feature.featureId));
  const operationCoverage = decorateOperationsWithFeatures(operations);
  for (const operation of operationCoverage) {
    if (!featureIds.has(operation.featureId)) {
      errors.push(`Operation ${operation.id} resolved to unknown feature ${operation.featureId}.`);
    }
  }

  const normalizedClientModules = Array.isArray(clientModules)
    ? clientModules
    : Object.entries(clientModules || {}).map(([id, module]) => ({ id, ...(module || {}) }));
  if (validateClientModules) {
    const clientModuleIds = new Set(normalizedClientModules.map((module) => module.id));
    for (const feature of FEATURE_MANIFEST.features) {
      for (const moduleId of feature.client?.modules || []) {
        if (!clientModuleIds.has(moduleId)) {
          errors.push(`Feature ${feature.featureId} references unknown client module ${moduleId}.`);
        }
      }
    }
  }

  for (const [editionId, edition] of Object.entries(FEATURE_MANIFEST.editions)) {
    for (const featureId of edition.includes || []) {
      if (!featureMap.has(featureId)) {
        errors.push(`Edition ${editionId} includes unknown feature ${featureId}.`);
      }
    }
  }
  if (errors.length) {
    const error = new Error(`FeatureManifest validation failed:\n${errors.map((item) => `- ${item}`).join("\n")}`);
    error.errors = errors;
    throw error;
  }
  return {
    ok: true,
    operationCount: operations.length,
    clientModuleCount: normalizedClientModules.length,
    featureCount: FEATURE_MANIFEST.features.length
  };
}

export function activeClientModuleIds(featureRuntime = {}) {
  const featureMap = getFeatureMap();
  const moduleIds = new Set();
  for (const featureId of featureRuntime.activeFeatureIds || []) {
    for (const moduleId of featureMap.get(featureId)?.client?.modules || []) {
      moduleIds.add(moduleId);
    }
  }
  return [...moduleIds].sort();
}

export function collectPackagePlan(featureRuntime = {}, options = {}) {
  const featureMap = getFeatureMap();
  const surface = String(options.surface || "all").trim() || "all";
  const includeClientSurface = surface !== "server";
  const includeWebSurface = surface !== "server";
  const includePaths = new Set();
  const excludePaths = new Set();
  const removePaths = new Set();
  const tests = new Set();
  const serverModules = new Set();
  const mounts = new Set();
  const webPanels = new Set();
  const webNavItems = new Set();
  const eventTopics = new Set();
  const clientModules = new Set(includeClientSurface ? activeClientModuleIds(featureRuntime) : []);

  for (const featureId of featureRuntime.activeFeatureIds || []) {
    const feature = featureMap.get(featureId);
    for (const item of feature?.package?.includePaths || []) includePaths.add(item);
    for (const item of feature?.package?.excludePaths || []) excludePaths.add(item);
    for (const item of feature?.tests?.suites || []) tests.add(item);
    for (const item of feature?.server?.modules || []) serverModules.add(item);
    for (const item of feature?.server?.mounts || []) mounts.add(item);
    for (const item of feature?.server?.eventTopics || []) eventTopics.add(item);
    if (includeWebSurface) {
      for (const item of feature?.server?.webPanels || []) webPanels.add(item);
      for (const item of feature?.web?.panels || []) webPanels.add(item);
      for (const item of feature?.web?.navItems || []) webNavItems.add(item);
    }
  }
  for (const featureId of featureRuntime.disabledFeatureIds || []) {
    const feature = featureMap.get(featureId);
    for (const item of feature?.package?.removePaths || feature?.package?.excludePaths || []) {
      removePaths.add(item);
    }
  }

  return {
    edition: featureRuntime.edition,
    surface,
    activeFeatureIds: [...(featureRuntime.activeFeatureIds || [])],
    includePaths: [...includePaths].sort(),
    excludePaths: [...excludePaths].sort(),
    removePaths: [...removePaths].sort(),
    tests: [...tests].sort(),
    serverModules: [...serverModules].sort(),
    mounts: [...mounts].sort(),
    webPanels: [...webPanels].sort(),
    webNavItems: [...webNavItems].sort(),
    eventTopics: [...eventTopics].sort(),
    clientModules: [...clientModules].sort()
  };
}
