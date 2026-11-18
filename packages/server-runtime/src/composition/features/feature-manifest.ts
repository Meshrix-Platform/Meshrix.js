import fs from "node:fs/promises";
import { operationFeatureId } from "#meshrix/contracts/operations/operation-feature-resolution";
import {
  DEFAULT_EDITION,
  FEATURE_MANIFEST,
  objectFromEntries,
  uniqueStrings
} from "./feature-manifest-data.ts";

export { operationFeatureId };
export {
  DEFAULT_EDITION,
  FEATURE_MANIFEST
} from "./feature-manifest-data.ts";

export function getFeatureEntries() : any {
  return FEATURE_MANIFEST.features.map((feature?: any) : any => ({ ...feature }));
}

export function getFeatureMap() : any {
  return new Map<any, any>(FEATURE_MANIFEST.features.map((feature?: any) : any => [feature.featureId, feature]));
}

function splitFeatureList(value?: any) : any {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  return uniqueStrings(String(value || "").split(","));
}

async function readJsonFileIfPresent(filePath?: any) : Promise<any> {
  if (!filePath) {
    return null;
  }
  const raw: any = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function loadFeatureProfile(profilePath?: any) : Promise<any> {
  return readJsonFileIfPresent(profilePath);
}

function normalizeProfileInput(profile: Record<string, any> = {}) : any {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return {};
  }
  return profile;
}

export function resolveEdition(edition: any = DEFAULT_EDITION) : any {
  const editionId: any = String(edition || DEFAULT_EDITION).trim() || DEFAULT_EDITION;
  const definition: any = FEATURE_MANIFEST.editions[editionId];
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
}: Record<string, any> = {}) : any {
  const normalizedProfile: any = normalizeProfileInput(profile);
  const editionSelection: any = resolveEdition(normalizedProfile.edition || edition || DEFAULT_EDITION);
  const selectedEdition: any = editionSelection.edition;

  const featureMap: any = getFeatureMap();
  const required: any = FEATURE_MANIFEST.features
    .filter((feature?: any) : any => feature.required)
    .map((feature?: any) : any => feature.featureId);
  const baseIncludes: any[] = [
    ...required,
    ...(editionSelection.definition?.includes || []),
    ...splitFeatureList(normalizedProfile.features),
    ...splitFeatureList(normalizedProfile.enableFeatures),
    ...splitFeatureList(enableFeatures)
  ];
  const disabled: any = new Set<any>([
    ...splitFeatureList(normalizedProfile.disableFeatures),
    ...splitFeatureList(disableFeatures)
  ]);

  for (const featureId of disabled) {
    const feature: any = featureMap.get(featureId);
    if (feature?.required) {
      throw new Error(`Required feature cannot be disabled: ${featureId}`);
    }
  }

  const active: any = new Set<any>();
  const reasons: Record<string, any> = {};

  function addFeature(featureId?: any, reason: any = "selected", requiredBy: any = "") : any {
    if (!featureId) {
      return;
    }
    if (disabled.has(featureId)) {
      if (requiredBy) {
        throw new Error(`Feature dependency cannot be disabled: ${requiredBy} depends on ${featureId}`);
      }
      return;
    }
    const feature: any = featureMap.get(featureId);
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
    const feature: any = featureMap.get(featureId);
    for (const conflictId of feature?.conflictsWith || []) {
      if (active.has(conflictId)) {
        throw new Error(`Feature conflict: ${featureId} conflicts with ${conflictId}`);
      }
    }
  }

  const activeFeatureIds: any = [...active].sort();
  const disabledFeatureIds: any = FEATURE_MANIFEST.features
    .map((feature?: any) : any => feature.featureId)
    .filter((featureId?: any) : any => !active.has(featureId))
    .sort();
  const disabledReasons: any = objectFromEntries(disabledFeatureIds.map((featureId?: any) : any => [
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
    activeFeatures: activeFeatureIds.map((featureId?: any) : any => publicFeatureDefinition(featureMap.get(featureId), reasons[featureId])),
    disabledFeatures: disabledFeatureIds.map((featureId?: any) : any => publicFeatureDefinition(featureMap.get(featureId), disabledReasons[featureId])),
    reasons,
    disabledReasons,
    groups: summarizeFeatureGroups(activeFeatureIds, disabledFeatureIds, featureMap)
  };
}

export function applyPluginDeploymentFeatures(featureRuntime: Record<string, any> = {}, deployment: Record<string, any> = {}) : any {
  const featureMap: any = getFeatureMap();
  const active: any = new Set<any>(featureRuntime.activeFeatureIds || []);
  const reasons: Record<string, any> = { ...(featureRuntime.reasons || {}) };
  const loadedPlugins: any = Array.isArray(deployment.loadedPlugins) ? deployment.loadedPlugins : [];
  const loadedPluginIds: any = new Set<any>(loadedPlugins.map((plugin?: any) : any => plugin.id));

  for (const plugin of loadedPlugins) {
    for (const featureId of plugin.features || []) {
      const feature: any = featureMap.get(featureId);
      if (!feature || feature.pluginId !== plugin.id) {
        throw new Error(`Plugin ${plugin.id} claims unowned feature ${featureId}.`);
      }
      for (const dependencyId of feature.dependsOn || []) {
        const dependency: any = featureMap.get(dependencyId);
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

  const activeFeatureIds: any = [...active].sort();
  const disabledFeatureIds: any = FEATURE_MANIFEST.features
    .map((feature?: any) : any => feature.featureId)
    .filter((featureId?: any) : any => !active.has(featureId))
    .sort();
  const disabledReasons: any = objectFromEntries(disabledFeatureIds.map((featureId?: any) : any => {
    const feature: any = featureMap.get(featureId);
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
    activeFeatures: activeFeatureIds.map((featureId?: any) : any => publicFeatureDefinition(featureMap.get(featureId), reasons[featureId])),
    disabledFeatures: disabledFeatureIds.map((featureId?: any) : any => publicFeatureDefinition(featureMap.get(featureId), disabledReasons[featureId])),
    reasons,
    disabledReasons,
    groups: summarizeFeatureGroups(activeFeatureIds, disabledFeatureIds, featureMap)
  };
}

function summarizeFeatureGroups(activeFeatureIds?: any, disabledFeatureIds?: any, featureMap?: any) : any {
  const groups: Record<string, any> = {};
  for (const group of FEATURE_MANIFEST.groups) {
    groups[group] = { active: [], disabled: [] };
  }
  for (const featureId of activeFeatureIds) {
    const group: any = featureMap.get(featureId)?.group || "custom";
    groups[group] = groups[group] || { active: [], disabled: [] };
    groups[group].active.push(featureId);
  }
  for (const featureId of disabledFeatureIds) {
    const group: any = featureMap.get(featureId)?.group || "custom";
    groups[group] = groups[group] || { active: [], disabled: [] };
    groups[group].disabled.push(featureId);
  }
  return groups;
}

function publicFeatureDefinition(feature: Record<string, any> = {}, reason: any = "") : any {
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
}: Record<string, any> = {}) : Promise<any> {
  const profilePath: any =
    args["feature-profile"] ||
    args.featureProfile ||
    runtimeOptions.featureProfile ||
    env.MESHRIX_FEATURE_PROFILE ||
    "";
  const profile: any = await loadFeatureProfile(profilePath);
  return resolveFeatureRuntime({
    edition:
      args.edition ||
      runtimeOptions.edition ||
      env.MESHRIX_EDITION ||
      DEFAULT_EDITION,
    profile: profile || {},
    enableFeatures: [
      ...splitFeatureList(args.features),
      ...splitFeatureList(args.enableFeatures),
      ...splitFeatureList(runtimeOptions.features),
      ...splitFeatureList(runtimeOptions.enableFeatures),
      ...splitFeatureList(env.MESHRIX_FEATURES)
    ],
    disableFeatures: [
      ...splitFeatureList(args["without-features"]),
      ...splitFeatureList(args.disableFeatures),
      ...splitFeatureList(runtimeOptions.disableFeatures),
      ...splitFeatureList(env.MESHRIX_DISABLED_FEATURES)
  ]
});
}

export function decorateOperationsWithFeatures(operations: any = []) : any {
  return operations.map((operation?: any) : any => ({
    ...operation,
    featureId: operationFeatureId(operation)
  }));
}

export function filterOperationsForFeatures(operations: any = [], featureRuntime: any = null) : any {
  if (!featureRuntime || !Array.isArray(featureRuntime.activeFeatureIds)) {
    return decorateOperationsWithFeatures(operations);
  }
  const active: any = new Set<any>(featureRuntime.activeFeatureIds);
  return decorateOperationsWithFeatures(operations)
    .filter((operation?: any) : any => active.has(operation.featureId));
}

export function publicFeatureRuntime(featureRuntime?: any, operations: any = []) : any {
  const activeOperations: any = filterOperationsForFeatures(operations, featureRuntime);
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

export function validateFeatureManifest({ operations = [], clientModules = [], validateClientModules = true }: Record<string, any> = {}) : any {
  const featureMap: any = getFeatureMap();
  const errors: any[] = [];
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

  const featureIds: any = new Set<any>(FEATURE_MANIFEST.features.map((feature?: any) : any => feature.featureId));
  const operationCoverage: any = decorateOperationsWithFeatures(operations);
  for (const operation of operationCoverage) {
    if (!featureIds.has(operation.featureId)) {
      errors.push(`Operation ${operation.id} resolved to unknown feature ${operation.featureId}.`);
    }
  }

  const normalizedClientModules: any = Array.isArray(clientModules)
    ? clientModules
    : (Object.entries(clientModules || {}) as [string, any][]).map(([id, module]: any[]) : any => ({ id, ...(module || {}) }));
  if (validateClientModules) {
    const clientModuleIds: any = new Set<any>(normalizedClientModules.map((module?: any) : any => module.id));
    for (const feature of FEATURE_MANIFEST.features) {
      for (const moduleId of feature.client?.modules || []) {
        if (!clientModuleIds.has(moduleId)) {
          errors.push(`Feature ${feature.featureId} references unknown client module ${moduleId}.`);
        }
      }
    }
  }

  for (const [editionId, edition] of (Object.entries(FEATURE_MANIFEST.editions) as [string, any][])) {
    for (const featureId of edition.includes || []) {
      if (!featureMap.has(featureId)) {
        errors.push(`Edition ${editionId} includes unknown feature ${featureId}.`);
      }
    }
  }
  if (errors.length) {
    const error: Error & Record<string, any> = new Error(`FeatureManifest validation failed:\n${errors.map((item?: any) : any => `- ${item}`).join("\n")}`);
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

export function activeClientModuleIds(featureRuntime: Record<string, any> = {}) : any {
  const featureMap: any = getFeatureMap();
  const moduleIds: any = new Set<any>();
  for (const featureId of featureRuntime.activeFeatureIds || []) {
    for (const moduleId of featureMap.get(featureId)?.client?.modules || []) {
      moduleIds.add(moduleId);
    }
  }
  return [...moduleIds].sort();
}

export function collectPackagePlan(featureRuntime: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const featureMap: any = getFeatureMap();
  const surface: any = String(options.surface || "all").trim() || "all";
  const includeClientSurface: any = surface !== "server";
  const includeWebSurface: any = surface !== "server";
  const includePaths: any = new Set<any>();
  const excludePaths: any = new Set<any>();
  const removePaths: any = new Set<any>();
  const tests: any = new Set<any>();
  const serverModules: any = new Set<any>();
  const mounts: any = new Set<any>();
  const webPanels: any = new Set<any>();
  const webNavItems: any = new Set<any>();
  const eventTopics: any = new Set<any>();
  const clientModules: any = new Set<any>(includeClientSurface ? activeClientModuleIds(featureRuntime) : []);

  for (const featureId of featureRuntime.activeFeatureIds || []) {
    const feature: any = featureMap.get(featureId);
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
    const feature: any = featureMap.get(featureId);
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
