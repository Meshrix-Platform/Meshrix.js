import { isDeepStrictEqual } from "node:util";

import { decorateServerApiOperations } from "#lico/contracts/operations/operation-decorators";
import { operationFeatureId } from "#lico/contracts/operations/operation-feature-resolution";
import {
  pluginManifestArtifactIdentity,
  readPluginArtifactFile
} from "#lico/foundation/module-system/plugin-registry";
import { validateExecutableStateMachineDefinition } from "#lico/foundation/workflow/state-machine/engine/state-machine-core";
import { registerPlatformService } from "./platform-registry.mjs";
import { PLUGIN_HOST_PORT_CONTRACT } from "./plugin-artifact-core-contract.mjs";

export const PLUGIN_HOST_PORT_NAMES = Object.freeze(Object.keys(PLUGIN_HOST_PORT_CONTRACT));

const HOST_PORT_NAMES = new Set(PLUGIN_HOST_PORT_NAMES);
const CORE_MCP_OUTLETS = new Set(["lico.discovery", "lico.gateway"]);
const MCP_OUTLET_PATTERN = /^lico\.[A-Za-z][A-Za-z0-9]*$/u;
const CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function immutableSnapshot(value, label, seen = new WeakMap(), active = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value === undefined
  ) return value;
  if (typeof value === "function") {
    if (seen.has(value)) return seen.get(value);
    const callable = function (...args) {
      return Reflect.apply(value, this, args);
    };
    seen.set(value, callable);
    return Object.freeze(callable);
  }
  if (typeof value !== "object") throw new Error(`${label} must contain snapshot-safe values.`);
  if (seen.has(value)) {
    if (active.has(value)) throw new Error(`${label} must not contain cyclic values.`);
    return seen.get(value);
  }
  active.add(value);
  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    for (const entry of value) output.push(immutableSnapshot(entry, label, seen, active));
    active.delete(value);
    return Object.freeze(output);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain only plain objects and arrays.`);
  const output = {};
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    output[key] = immutableSnapshot(value[key], label, seen, active);
  }
  active.delete(value);
  return Object.freeze(output);
}

function snapshotContributions(contributions) {
  const snapshot = {};
  for (const kind of CONTRIBUTION_KINDS) {
    const value = contributions[kind] ?? {};
    if (!isPlainObject(value)) throw new Error(`Plugin ${kind} contributions are required.`);
    snapshot[kind] = immutableSnapshot(value, `Plugin ${kind} contributions`);
  }
  return Object.freeze(snapshot);
}

function readonlyMap(source) {
  const facade = {
    get size() {
      return source.size;
    },
    get: source.get.bind(source),
    has: source.has.bind(source),
    keys: source.keys.bind(source),
    values: source.values.bind(source),
    entries: source.entries.bind(source),
    forEach(callback, thisArg) {
      for (const [key, value] of source) callback.call(thisArg, value, key, facade);
    },
    [Symbol.iterator]: source[Symbol.iterator].bind(source)
  };
  return Object.freeze(facade);
}

function assertFields(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label} contains unsupported field ${field}.`);
  }
}

function jsonSafeValue(value, label, depth = 0) {
  if (depth > 12) throw new Error(`${label} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => jsonSafeValue(entry, label, depth + 1)));
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain only JSON-safe values.`);
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, jsonSafeValue(entry, label, depth + 1)])));
}

function capabilityOperationList(value, label) {
  const operations = stringList(value, label);
  if (operations.length === 0) throw new Error(`${label} must not be empty.`);
  return Object.freeze(operations);
}

function normalizeMcpCapabilityFamily(value, outlet, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertFields(value, new Set([
    "id",
    "title",
    "protocol",
    "mcpOutlet",
    "discoveryTool",
    "summary",
    "nativeAcpPreferred",
    "degradedCliPolicy",
    "templateOperation",
    "templateIds",
    "primaryFlow",
    "canViewOperations",
    "canOperateOperations"
  ]), label);
  const family = Object.fromEntries([
    "id",
    "title",
    "protocol",
    "mcpOutlet",
    "discoveryTool",
    "summary",
    "degradedCliPolicy",
    "templateOperation"
  ].map((field) => [field, String(value[field] || "").trim()]));
  if (Object.values(family).some((entry) => !entry)) {
    throw new Error(`${label} requires all declared string fields.`);
  }
  if (family.mcpOutlet !== outlet) throw new Error(`${label} mcpOutlet must match ${outlet}.`);
  if (typeof value.nativeAcpPreferred !== "boolean") {
    throw new Error(`${label} nativeAcpPreferred must be a boolean.`);
  }
  if (!Array.isArray(value.primaryFlow) || value.primaryFlow.length === 0) {
    throw new Error(`${label} primaryFlow must be a non-empty array.`);
  }
  return Object.freeze({
    ...family,
    nativeAcpPreferred: value.nativeAcpPreferred,
    templateIds: capabilityOperationList(value.templateIds, `${label} templateIds`),
    primaryFlow: jsonSafeValue(value.primaryFlow, `${label} primaryFlow`),
    canViewOperations: capabilityOperationList(value.canViewOperations, `${label} canViewOperations`),
    canOperateOperations: capabilityOperationList(value.canOperateOperations, `${label} canOperateOperations`)
  });
}

function normalizeMcpOutletDescriptor(value, outlet, label) {
  if (!isPlainObject(value)) throw new Error(`${label} requires an outletDescriptor.`);
  assertFields(
    value,
    new Set(["toolName", "title", "description", "architectureCategory", "annotations", "exchangeReceipt", "capabilityFamily"]),
    `${label} outletDescriptor`
  );
  const descriptor = {
    toolName: String(value.toolName || "").trim(),
    title: String(value.title || "").trim(),
    description: String(value.description || "").trim(),
    architectureCategory: String(value.architectureCategory || "").trim()
  };
  if (descriptor.toolName !== outlet) {
    throw new Error(`${label} outletDescriptor toolName must match outlet ${outlet}.`);
  }
  if (!descriptor.title || !descriptor.description || !descriptor.architectureCategory) {
    throw new Error(`${label} outletDescriptor requires title, description, and architectureCategory.`);
  }
  if (!isPlainObject(value.annotations)) {
    throw new Error(`${label} outletDescriptor annotations are required.`);
  }
  assertFields(value.annotations, new Set(["readOnlyHint", "destructiveHint"]), `${label} outletDescriptor annotations`);
  if (typeof value.annotations.readOnlyHint !== "boolean" || typeof value.annotations.destructiveHint !== "boolean") {
    throw new Error(`${label} outletDescriptor annotations must be booleans.`);
  }
  descriptor.annotations = Object.freeze({
    readOnlyHint: value.annotations.readOnlyHint,
    destructiveHint: value.annotations.destructiveHint
  });
  if (value.exchangeReceipt !== undefined) {
    descriptor.exchangeReceipt = jsonSafeValue(value.exchangeReceipt, `${label} outletDescriptor exchangeReceipt`);
  }
  if (value.capabilityFamily !== undefined) {
    descriptor.capabilityFamily = normalizeMcpCapabilityFamily(
      value.capabilityFamily,
      outlet,
      `${label} outletDescriptor capabilityFamily`
    );
  }
  return Object.freeze(descriptor);
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const output = value.map((entry) => String(entry || "").trim());
  if (output.some((entry) => !entry) || new Set(output).size !== output.length) {
    throw new Error(`${label} must contain unique non-empty strings.`);
  }
  return output;
}

function requiredHostPorts(implementation, label) {
  const ports = stringList(implementation.requiredHostPorts, `${label} requiredHostPorts`);
  for (const port of ports) {
    if (!HOST_PORT_NAMES.has(port)) throw new Error(`${label} requests unsupported host port ${port}.`);
  }
  return Object.freeze(ports);
}

function manifestIndex(manifests = []) {
  return new Map(manifests.map((manifest) => [manifest.id, manifest]));
}

function contributionEntries(contributions, kind) {
  const entries = Object.values(contributions?.[kind] || {});
  for (const entry of entries) {
    if (!entry || entry.kind !== kind || typeof entry.id !== "string" || typeof entry.pluginId !== "string") {
      throw new Error(`Invalid enabled plugin ${kind} contribution record.`);
    }
  }
  return entries;
}

function enabledPluginIds(loadedPlugins = []) {
  return new Set(loadedPlugins.map((plugin) => String(plugin.id || "").trim()).filter(Boolean));
}

const REQUIRED_PLUGIN_RESOURCE_FIELDS = Object.freeze([
  "capabilityDomain",
  "resourceKind",
  "capabilityVerb",
  "effectKind"
]);

function validateExplicitPluginResource(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  for (const field of REQUIRED_PLUGIN_RESOURCE_FIELDS) {
    if (!String(value[field] || "").trim()) {
      throw new Error(`${label} requires explicit ${field}.`);
    }
  }
  if (!isPlainObject(value.fieldMap)) throw new Error(`${label} requires an explicit fieldMap object.`);
  jsonSafeValue(value, label);
}

function validateExplicitPluginOperationMetadata(definition, manifest, operationId) {
  const featureId = String(definition.featureId || "").trim();
  if (!featureId || operationFeatureId(definition) !== featureId) {
    throw new Error(`Plugin operation ${operationId} must declare an explicit featureId.`);
  }
  if (!manifest.features.includes(featureId)) {
    throw new Error(`Plugin operation ${operationId} declares undeclared feature ${featureId}.`);
  }
  const toolsets = stringList(definition.toolsets, `Plugin operation ${operationId} toolsets`);
  if (toolsets.length === 0) {
    throw new Error(`Plugin operation ${operationId} must declare at least one explicit toolset.`);
  }
  validateExplicitPluginResource(definition.resource, `Plugin operation ${operationId} resource`);
  validateExplicitPluginResource(definition.resourceContext, `Plugin operation ${operationId} resourceContext`);
  if (!isDeepStrictEqual(definition.resource, definition.resourceContext)) {
    throw new Error(`Plugin operation ${operationId} resource and resourceContext must match exactly.`);
  }
}

function normalizeOperationContributions({ contributions, manifests, loadedPlugins }) {
  const manifestsById = manifestIndex(manifests);
  const enabledIds = enabledPluginIds(loadedPlugins);
  const records = new Map();
  for (const record of contributionEntries(contributions, "operations")) {
    if (!enabledIds.has(record.pluginId)) throw new Error(`Disabled plugin ${record.pluginId} published an operation.`);
    const manifest = manifestsById.get(record.pluginId);
    if (!manifest?.operations?.includes(record.id)) {
      throw new Error(`Plugin ${record.pluginId} operation ${record.id} is not declared by its manifest.`);
    }
    const implementation = record.implementation;
    assertFields(
      implementation,
      new Set(["definition", "execute", "verifyExternalAuth", "requiredHostPorts", "opaqueInputPreprocessing", "hostPathInputPreprocessing"]),
      `Plugin operation ${record.id}`
    );
    if (!isPlainObject(implementation.definition) || implementation.definition.id !== record.id) {
      throw new Error(`Plugin operation ${record.id} must provide its matching definition.`);
    }
    if (typeof implementation.execute !== "function") {
      throw new Error(`Plugin operation ${record.id} must provide execute().`);
    }
    if (
      implementation.verifyExternalAuth !== undefined &&
      typeof implementation.verifyExternalAuth !== "function"
    ) {
      throw new Error(`Plugin operation ${record.id} verifyExternalAuth must be a function.`);
    }
    if (implementation.definition.externalAuth === true && typeof implementation.verifyExternalAuth !== "function") {
      throw new Error(`External-auth plugin operation ${record.id} must provide verifyExternalAuth().`);
    }
    validateExplicitPluginOperationMetadata(implementation.definition, manifest, record.id);
    const manifestOpaqueInputs = manifest.opaqueInputPreprocessing?.[record.id] || [];
    const implementationOpaqueInputs = implementation.opaqueInputPreprocessing === undefined
      ? []
      : jsonSafeValue(
          implementation.opaqueInputPreprocessing,
          `Plugin operation ${record.id} opaqueInputPreprocessing`
        );
    if (!isDeepStrictEqual(implementationOpaqueInputs, manifestOpaqueInputs)) {
      throw new Error(`Plugin operation ${record.id} opaque input preprocessing must match its manifest.`);
    }
    const manifestHostPathInputs = manifest.hostPathInputPreprocessing?.[record.id] || [];
    const implementationHostPathInputs = implementation.hostPathInputPreprocessing === undefined
      ? []
      : jsonSafeValue(
          implementation.hostPathInputPreprocessing,
          `Plugin operation ${record.id} hostPathInputPreprocessing`
        );
    if (!isDeepStrictEqual(implementationHostPathInputs, manifestHostPathInputs)) {
      throw new Error(`Plugin operation ${record.id} host path input preprocessing must match its manifest.`);
    }
    const normalizedHostPorts = requiredHostPorts(implementation, `Plugin operation ${record.id}`);
    if (manifestOpaqueInputs.length > 0 && !normalizedHostPorts.includes("opaqueArtifactCustody")) {
      throw new Error(`Plugin operation ${record.id} opaque input preprocessing requires opaqueArtifactCustody.`);
    }
    if (manifestHostPathInputs.length > 0 && !normalizedHostPorts.includes("agentWorkspace")) {
      throw new Error(`Plugin operation ${record.id} host path input preprocessing requires agentWorkspace.`);
    }
    records.set(record.id, Object.freeze({
      ...record,
      implementation: Object.freeze({
        ...implementation,
        opaqueInputPreprocessing: manifestOpaqueInputs,
        hostPathInputPreprocessing: manifestHostPathInputs,
        requiredHostPorts: normalizedHostPorts
      })
    }));
  }
  return records;
}

function normalizeRoutes({ contributions, manifests, operationRecords }) {
  const manifestsById = manifestIndex(manifests);
  const output = new Map();
  const gatewayRouteIds = new Set();
  const gatewayPaths = new Set();
  for (const record of contributionEntries(contributions, "routes")) {
    const implementation = record.implementation;
    assertFields(implementation, new Set(["operationId", "gateway"]), `Plugin route ${record.id}`);
    const operationId = String(implementation.operationId || "").trim();
    const operationRecord = operationRecords.get(operationId);
    if (!operationRecord || operationRecord.pluginId !== record.pluginId) {
      throw new Error(`Plugin route ${record.id} targets unavailable operation ${operationId}.`);
    }
    const declaration = manifestsById.get(record.pluginId)?.routes?.find((route) => route.id === record.id);
    const definition = operationRecord.implementation.definition;
    if (!declaration || declaration.kind !== "http" || declaration.path !== definition.http?.path) {
      throw new Error(`Plugin route ${record.id} does not match operation ${operationId}.`);
    }
    let gateway = null;
    if (implementation.gateway !== undefined) {
      assertFields(
        implementation.gateway,
        new Set(["routeId", "match", "path", "trafficClass", "streaming", "sticky", "bodyLimit"]),
        `Plugin route ${record.id} gateway descriptor`
      );
      gateway = {
        routeId: String(implementation.gateway.routeId || "").trim(),
        match: String(implementation.gateway.match || "").trim(),
        path: String(implementation.gateway.path || "").trim(),
        trafficClass: String(implementation.gateway.trafficClass || "").trim(),
        streaming: implementation.gateway.streaming === true,
        sticky: implementation.gateway.sticky === true,
        bodyLimit: String(implementation.gateway.bodyLimit || "").trim()
      };
      if (
        !/^[a-z][a-z0-9-]*$/u.test(gateway.routeId) ||
        !["exact", "prefix"].includes(gateway.match) ||
        !gateway.path.startsWith("/") ||
        gateway.path.startsWith("//") ||
        /[?#]/u.test(gateway.path) ||
        gateway.path.split("/").includes("..") ||
        !gateway.trafficClass ||
        !gateway.bodyLimit ||
        (implementation.gateway.streaming !== undefined && typeof implementation.gateway.streaming !== "boolean") ||
        (implementation.gateway.sticky !== undefined && typeof implementation.gateway.sticky !== "boolean") ||
        (gateway.match === "exact" && declaration.path !== gateway.path) ||
        (gateway.match === "prefix" && declaration.path !== gateway.path && !declaration.path.startsWith(`${gateway.path}/`))
      ) {
        throw new Error(`Plugin route ${record.id} gateway descriptor is invalid.`);
      }
      if (gatewayRouteIds.has(gateway.routeId) || gatewayPaths.has(gateway.path)) {
        throw new Error(`Plugin route ${record.id} gateway descriptor conflicts with another enabled plugin route.`);
      }
      gatewayRouteIds.add(gateway.routeId);
      gatewayPaths.add(gateway.path);
      gateway = Object.freeze(gateway);
    }
    output.set(record.id, Object.freeze({ ...record, operationId, gateway }));
  }
  return output;
}

function normalizeMcpTools({ contributions, manifests, operationRecords }) {
  const manifestsById = manifestIndex(manifests);
  const output = new Map();
  const descriptorByOutlet = new Map();
  for (const record of contributionEntries(contributions, "mcpTools")) {
    const implementation = record.implementation;
    assertFields(implementation, new Set(["operationId", "outlet", "outletDescriptor"]), `Plugin MCP tool ${record.id}`);
    const operationId = String(implementation.operationId || "").trim();
    const outlet = String(implementation.outlet || "").trim();
    const operationRecord = operationRecords.get(operationId);
    if (!operationRecord || operationRecord.pluginId !== record.pluginId || !MCP_OUTLET_PATTERN.test(outlet)) {
      throw new Error(`Plugin MCP tool ${record.id} has an invalid operation or outlet.`);
    }
    let outletDescriptor = null;
    if (CORE_MCP_OUTLETS.has(outlet)) {
      if (implementation.outletDescriptor !== undefined) {
        throw new Error(`Plugin MCP tool ${record.id} cannot override core outlet ${outlet}.`);
      }
    } else {
      outletDescriptor = normalizeMcpOutletDescriptor(
        implementation.outletDescriptor,
        outlet,
        `Plugin MCP tool ${record.id}`
      );
      const existing = descriptorByOutlet.get(outlet);
      if (existing && JSON.stringify(existing) !== JSON.stringify(outletDescriptor)) {
        throw new Error(`Plugin MCP outlet ${outlet} has conflicting descriptors.`);
      }
      descriptorByOutlet.set(outlet, outletDescriptor);
    }
    if (!manifestsById.get(record.pluginId)?.mcpTools?.includes(record.id)) {
      throw new Error(`Plugin MCP tool ${record.id} is not declared by its manifest.`);
    }
    output.set(record.id, Object.freeze({ ...record, operationId, outlet, outletDescriptor }));
  }
  return output;
}

function normalizeConsoleEntries({ contributions, manifests, artifactIdentityResolver }) {
  const manifestsById = manifestIndex(manifests);
  const output = new Map();
  for (const record of contributionEntries(contributions, "consoleEntries")) {
    const implementation = record.implementation;
    assertFields(
      implementation,
      new Set([
        "featureId", "viewKey", "routePath", "slotId", "componentId", "label", "requiredScopes",
        "assetPath", "assetExport"
      ]),
      `Plugin console entry ${record.id}`
    );
    const manifest = manifestsById.get(record.pluginId);
    const assetPath = String(implementation.assetPath || "").trim();
    const assetExport = String(implementation.assetExport || "").trim();
    const artifactIdentity = artifactIdentityResolver(manifest);
    const assetPathToken = Buffer.from(assetPath, "utf8").toString("base64url");
    const entryToken = Buffer.from(record.id, "utf8").toString("base64url");
    const normalized = {
      id: record.id,
      pluginId: record.pluginId,
      featureId: String(implementation.featureId || "").trim(),
      viewKey: String(implementation.viewKey || "").trim(),
      routePath: String(implementation.routePath || "").trim(),
      slotId: String(implementation.slotId || "").trim(),
      componentId: String(implementation.componentId || "").trim(),
      label: String(implementation.label || record.id).trim(),
      requiredScopes: Object.freeze(stringList(implementation.requiredScopes, `Plugin console entry ${record.id} requiredScopes`)),
      assetPath,
      assetExport,
      assetUrl: `/api/plugins/v1/console-assets/${record.pluginId}/${artifactIdentity.generation}/${artifactIdentity.artifactDigest.slice(7)}/${entryToken}/${assetPathToken}.mjs`,
      artifactDigest: artifactIdentity.artifactDigest,
      artifactGeneration: artifactIdentity.generation
    };
    const componentPattern = new RegExp(`^${record.pluginId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[A-Za-z0-9][A-Za-z0-9._-]*$`, "u");
    const claimPattern = /^[a-z][a-zA-Z0-9._-]*$/u;
    const routePathValid = !normalized.routePath || (
      normalized.routePath.startsWith("/") &&
      !normalized.routePath.startsWith("//") &&
      !/[?#]/u.test(normalized.routePath) &&
      !normalized.routePath.split("/").includes("..")
    );
    if (
      !manifest?.consoleEntries?.includes(record.id) ||
      !manifest.features.includes(normalized.featureId) ||
      !normalized.viewKey ||
      (Boolean(normalized.routePath) === Boolean(normalized.slotId)) ||
      !routePathValid ||
      !claimPattern.test(normalized.viewKey) ||
      (normalized.slotId && !claimPattern.test(normalized.slotId)) ||
      !componentPattern.test(normalized.componentId) ||
      !/^console\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.mjs$/u.test(normalized.assetPath) ||
      normalized.assetPath.includes("..") || normalized.assetPath.includes("\\") ||
      normalized.assetPath.split("/").some((part) => !part) ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(normalized.assetExport) ||
      artifactIdentity.pluginId !== record.pluginId ||
      !Number.isSafeInteger(artifactIdentity.generation) || artifactIdentity.generation < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifactIdentity.artifactDigest)
    ) {
      throw new Error(`Plugin console entry ${record.id} is invalid.`);
    }
    output.set(record.id, Object.freeze(normalized));
  }
  return output;
}

function publicConsoleEntry(entry) {
  return Object.freeze({
    id: entry.id,
    pluginId: entry.pluginId,
    featureId: entry.featureId,
    viewKey: entry.viewKey,
    routePath: entry.routePath,
    slotId: entry.slotId,
    componentId: entry.componentId,
    label: entry.label,
    requiredScopes: entry.requiredScopes,
    assetUrl: entry.assetUrl,
    assetExport: entry.assetExport,
    artifactDigest: entry.artifactDigest,
    artifactGeneration: entry.artifactGeneration
  });
}

function normalizeStateMachines({ contributions, manifests }) {
  const manifestsById = manifestIndex(manifests);
  const output = new Map();
  for (const record of contributionEntries(contributions, "stateMachines")) {
    const implementation = record.implementation;
    assertFields(implementation, new Set(["definition", "ref"]), `Plugin state machine ${record.id}`);
    if (!manifestsById.get(record.pluginId)?.stateMachines?.includes(record.id)) {
      throw new Error(`Plugin state machine ${record.id} is not declared by its manifest.`);
    }
    const hasDefinition = isPlainObject(implementation.definition);
    const ref = String(implementation.ref || "").trim();
    if (hasDefinition === Boolean(ref)) {
      throw new Error(`Plugin state machine ${record.id} must provide exactly one of definition or ref.`);
    }
    if (hasDefinition) {
      if (implementation.definition.machineId !== record.id) {
        throw new Error(`Plugin state machine ${record.id} definition identity does not match.`);
      }
      const validation = validateExecutableStateMachineDefinition(implementation.definition);
      if (!validation.ok) throw new Error(`Plugin state machine ${record.id} is not executable.`);
    } else if (ref !== record.id) {
      throw new Error(`Plugin state machine ${record.id} ref must match its claim.`);
    }
    output.set(record.id, Object.freeze({ ...record, ref, definition: implementation.definition || null }));
  }
  return output;
}

function normalizeVerifierHooks({ contributions, manifests }) {
  const manifestsById = manifestIndex(manifests);
  const output = new Map();
  for (const record of contributionEntries(contributions, "verifierHooks")) {
    const implementation = record.implementation;
    assertFields(implementation, new Set(["run"]), `Plugin verifier hook ${record.id}`);
    if (implementation.run !== undefined && typeof implementation.run !== "function") {
      throw new Error(`Plugin verifier hook ${record.id} run must be a function.`);
    }
    const declaration = manifestsById.get(record.pluginId)?.verifierHooks?.find((hook) => hook.id === record.id);
    if (!declaration) throw new Error(`Plugin verifier hook ${record.id} is not declared by its manifest.`);
    output.set(record.id, Object.freeze({
      ...record,
      workloadKind: declaration.workloadKind,
      source: declaration.source,
      report: declaration.report || "",
      run: implementation.run || null
    }));
  }
  return output;
}

function publicPluginSummary(plugin = {}) {
  return Object.freeze({
    id: plugin.id,
    version: plugin.version,
    features: Object.freeze([...(plugin.features || [])])
  });
}

export function createPluginContributionRegistry({
  manifests = [],
  loadedPlugins = [],
  contributions = {},
  coreOperations = [],
  activeFeatureIds = [],
  artifactIdentityResolver = pluginManifestArtifactIdentity,
  artifactFileReader = readPluginArtifactFile
} = {}) {
  if (typeof artifactIdentityResolver !== "function" || typeof artifactFileReader !== "function") {
    throw new TypeError("Plugin console assets require artifact identity and file authorities.");
  }
  const admittedContributions = snapshotContributions(contributions);
  const enabledIds = enabledPluginIds(loadedPlugins);
  if (contributionEntries(admittedContributions, "operations").some((entry) => !enabledIds.has(entry.pluginId))) {
    throw new Error("Disabled plugin contributions cannot enter the runtime registry.");
  }
  const operationRecords = normalizeOperationContributions({ contributions: admittedContributions, manifests, loadedPlugins });
  const mcpTools = normalizeMcpTools({ contributions: admittedContributions, manifests, operationRecords });
  const mcpToolByOperation = new Map();
  for (const tool of mcpTools.values()) {
    if (mcpToolByOperation.has(tool.operationId)) {
      throw new Error(`Plugin operation ${tool.operationId} has more than one MCP tool binding.`);
    }
    mcpToolByOperation.set(tool.operationId, tool);
  }
  const pluginFeatureIds = new Set(manifests.flatMap((manifest) => manifest.features || []));
  const claimedOperationIds = new Set(manifests.flatMap((manifest) => manifest.operations || []));
  const conflictingClaim = coreOperations.find((operation) => claimedOperationIds.has(operation.id));
  if (conflictingClaim) {
    throw new Error(`Core operation ${conflictingClaim.id} conflicts with a plugin-owned operation claim.`);
  }
  const misplacedPluginOperation = coreOperations.find((operation) => pluginFeatureIds.has(operationFeatureId(operation)));
  if (misplacedPluginOperation) {
    throw new Error(`Plugin-owned operation ${misplacedPluginOperation.id} remains in the core operation registry.`);
  }
  const core = coreOperations;
  const activeFeatures = new Set(activeFeatureIds);
  const activeCore = core.filter((operation) => activeFeatures.has(operationFeatureId(operation)));
  function buildActiveOperationsSnapshot() {
    const pluginDefinitions = [...operationRecords.values()].map((record) => {
      const mcpTool = mcpToolByOperation.get(record.id) || null;
      return {
        ...record.implementation.definition,
        pluginId: record.pluginId,
        target: { controller: "plugin", method: "executePluginOperation" },
        ...(mcpTool
          ? {
              toolId: mcpTool.id,
              _meta: Object.freeze({
                ...(record.implementation.definition._meta || {}),
                mcpOutlet: mcpTool.outlet,
                ...(mcpTool.outletDescriptor ? { mcpOutletDescriptor: mcpTool.outletDescriptor } : {})
              })
            }
          : {}),
        ...(record.implementation.definition.externalAuth === true
          ? { externalAuthVerifier: { controller: "plugin", method: "verifyPluginExternalAuth" } }
          : {})
      };
    });
    return immutableSnapshot(decorateServerApiOperations([
      ...activeCore,
      ...pluginDefinitions
    ]), "Active plugin operations");
  }
  const activeOperations = buildActiveOperationsSnapshot();
  let currentActiveOperationsSnapshot = activeOperations;
  function invalidateActiveOperationsSnapshot() {
    currentActiveOperationsSnapshot = null;
  }
  const routes = normalizeRoutes({ contributions: admittedContributions, manifests, operationRecords });
  const consoleEntries = normalizeConsoleEntries({
    contributions: admittedContributions,
    manifests,
    artifactIdentityResolver
  });
  const stateMachines = normalizeStateMachines({ contributions: admittedContributions, manifests });
  const verifierHooks = normalizeVerifierHooks({ contributions: admittedContributions, manifests });
  const activePluginIds = new Set(loadedPlugins.map((plugin) => plugin.id));
  const manifestsById = manifestIndex(manifests);
  const consoleAssetsByUrl = new Map();
  function refreshConsoleAssetIndex() {
    consoleAssetsByUrl.clear();
    for (const entry of consoleEntries.values()) {
      if (consoleAssetsByUrl.has(entry.assetUrl)) {
        throw new Error(`Plugin console asset URL is ambiguous: ${entry.assetUrl}.`);
      }
      consoleAssetsByUrl.set(entry.assetUrl, entry);
    }
  }
  refreshConsoleAssetIndex();
  const registeredStateMachineServiceIds = new Map();

  function preparePluginContributionReplacement(pluginId, contributions) {
    const id = String(pluginId || "").trim();
    if (!activePluginIds.has(id)) throw new Error(`Plugin ${id} is not active.`);
    const admitted = snapshotContributions(contributions);
    for (const kind of CONTRIBUTION_KINDS) {
      if (contributionEntries(admitted, kind).some((entry) => entry.pluginId !== id)) {
        throw new Error(`Plugin ${id} contribution replacement contains a foreign owner.`);
      }
    }
    const nextOperations = normalizeOperationContributions({ contributions: admitted, manifests, loadedPlugins });
    const nextMcpTools = normalizeMcpTools({ contributions: admitted, manifests, operationRecords: nextOperations });
    const nextRoutes = normalizeRoutes({ contributions: admitted, manifests, operationRecords: nextOperations });
    const nextConsoleEntries = normalizeConsoleEntries({
      contributions: admitted,
      manifests,
      artifactIdentityResolver
    });
    const nextStateMachines = normalizeStateMachines({ contributions: admitted, manifests });
    const nextVerifierHooks = normalizeVerifierHooks({ contributions: admitted, manifests });
    const replacements = [
      [operationRecords, nextOperations],
      [routes, nextRoutes],
      [mcpTools, nextMcpTools],
      [consoleEntries, nextConsoleEntries],
      [stateMachines, nextStateMachines],
      [verifierHooks, nextVerifierHooks]
    ];
    for (const [current, next] of replacements) {
      for (const [key] of next) {
        const existing = current.get(key);
        if (existing && existing.pluginId !== id) throw new Error(`Plugin contribution ${key} conflicts with another owner.`);
      }
    }
    const previous = replacements.map(([current]) => [...current].filter(([, record]) => record.pluginId === id));
    const previousMcpBindings = [...mcpToolByOperation];
    let committed = false;
    const apply = (sets) => {
      for (let index = 0; index < replacements.length; index += 1) {
        const [current] = replacements[index];
        for (const [key, record] of [...current]) if (record.pluginId === id) current.delete(key);
        for (const [key, record] of sets[index]) current.set(key, record);
      }
      mcpToolByOperation.clear();
      for (const tool of mcpTools.values()) {
        if (mcpToolByOperation.has(tool.operationId)) throw new Error(`Plugin operation ${tool.operationId} has more than one MCP tool binding.`);
        mcpToolByOperation.set(tool.operationId, tool);
      }
      invalidateActiveOperationsSnapshot();
      refreshConsoleAssetIndex();
    };
    return Object.freeze({
      commit() {
        if (!committed) apply(replacements.map(([, next]) => [...next]));
        committed = true;
      },
      rollback() {
        if (!committed) return;
        apply(previous);
        mcpToolByOperation.clear();
        for (const [key, value] of previousMcpBindings) mcpToolByOperation.set(key, value);
        committed = false;
      }
    });
  }

  function deactivatePlugin(pluginId) {
    const id = String(pluginId || "").trim();
    if (!activePluginIds.delete(id)) return Object.freeze({ ok: true, changed: false, pluginId: id });
    for (const records of [operationRecords, routes, mcpTools, consoleEntries, stateMachines, verifierHooks]) {
      for (const [key, record] of records) {
        if (record.pluginId === id) records.delete(key);
      }
    }
    refreshConsoleAssetIndex();
    invalidateActiveOperationsSnapshot();
    return Object.freeze({ ok: true, changed: true, pluginId: id });
  }

  function preparePluginDeactivation(pluginId) {
    const id = String(pluginId || "").trim();
    const snapshots = [operationRecords, routes, mcpTools, consoleEntries, stateMachines, verifierHooks]
      .map((records) => [records, [...records].filter(([, record]) => record.pluginId === id)]);
    const wasActive = activePluginIds.has(id);
    let committed = false;
    return Object.freeze({
      commit() {
        if (!committed) deactivatePlugin(id);
        committed = true;
      },
      rollback() {
        if (!committed) return;
        if (wasActive) activePluginIds.add(id);
        for (const [records, entries] of snapshots) for (const [key, record] of entries) records.set(key, record);
        refreshConsoleAssetIndex();
        invalidateActiveOperationsSnapshot();
        committed = false;
      }
    });
  }

  function currentActiveOperations() {
    if (!currentActiveOperationsSnapshot) {
      currentActiveOperationsSnapshot = buildActiveOperationsSnapshot();
    }
    return currentActiveOperationsSnapshot;
  }

  function requireOperation(operationId) {
    const record = operationRecords.get(String(operationId || "").trim());
    if (!record) throw new Error(`Plugin operation is not enabled: ${String(operationId || "").trim()}.`);
    return record;
  }

  function getConsoleAssetEntry(assetUrl) {
    const entry = consoleAssetsByUrl.get(String(assetUrl || "")) || null;
    return entry ? publicConsoleEntry(entry) : null;
  }

  async function readConsoleAsset(assetUrl) {
    const entry = consoleAssetsByUrl.get(String(assetUrl || ""));
    if (!entry || !activePluginIds.has(entry.pluginId)) return null;
    const manifest = manifestsById.get(entry.pluginId);
    if (!manifest) return null;
    const bytes = await artifactFileReader(manifest, entry.assetPath);
    return Object.freeze({ entry: publicConsoleEntry(entry), bytes: Buffer.from(bytes) });
  }

  return Object.freeze({
    activeOperations,
    operations: readonlyMap(operationRecords),
    routes: readonlyMap(routes),
    mcpTools: readonlyMap(mcpTools),
    consoleEntries: readonlyMap(consoleEntries),
    stateMachines: readonlyMap(stateMachines),
    verifierHooks: readonlyMap(verifierHooks),
    get enabledPlugins() {
      return Object.freeze(loadedPlugins.filter((plugin) => activePluginIds.has(plugin.id)).map(publicPluginSummary));
    },
    deactivatePlugin,
    preparePluginDeactivation,
    preparePluginContributionReplacement,
    currentActiveOperations,
    requireOperation,
    getConsoleAssetEntry,
    readConsoleAsset,
    publicRuntime() {
      return Object.freeze({
        enabledPlugins: Object.freeze(loadedPlugins.filter((plugin) => activePluginIds.has(plugin.id)).map(publicPluginSummary)),
        routes: Object.freeze([...routes.values()].map((entry) => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          operationId: entry.operationId,
          ...(entry.gateway ? { gateway: entry.gateway } : {})
        }))),
        mcpTools: Object.freeze([...mcpTools.values()].map((entry) => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          operationId: entry.operationId,
          outlet: entry.outlet,
          ...(entry.outletDescriptor ? { outletDescriptor: entry.outletDescriptor } : {})
        }))),
        consoleEntries: Object.freeze([...consoleEntries.values()].map(publicConsoleEntry)),
        stateMachines: Object.freeze([...stateMachines.values()].map((entry) => Object.freeze({ id: entry.id, pluginId: entry.pluginId, ref: entry.ref || "", owned: Boolean(entry.definition) }))),
        verifierHooks: Object.freeze([...verifierHooks.values()].map((entry) => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          workloadKind: entry.workloadKind,
          source: entry.source,
          report: entry.report
        })))
      });
    },
    registerStateMachines(platformRegistry, pluginId = "") {
      const owner = String(pluginId || "").trim();
      const registered = [];
      for (const entry of stateMachines.values()) {
        if (owner && entry.pluginId !== owner) continue;
        if (entry.ref) {
          if (!platformRegistry.get(`state-machine.${entry.ref}`)) {
            const service = registerPlatformService(platformRegistry, {
              id: `state-machine.${entry.id}`,
              platform: "state-machine",
              label: `${entry.id} State Machine Reference`,
              kind: "plugin-state-machine-reference",
              ownerFeatureId: entry.pluginId,
              value: Object.freeze({ ref: entry.ref }),
              metadata: { machineId: entry.id, pluginId: entry.pluginId, ref: entry.ref }
            });
            registered.push(service);
          }
          continue;
        }
        const service = registerPlatformService(platformRegistry, {
          id: `state-machine.${entry.id}`,
          platform: "state-machine",
          label: `${entry.id} State Machine`,
          kind: "plugin-state-machine-definition",
          ownerFeatureId: entry.pluginId,
          value: entry.definition,
          metadata: { machineId: entry.id, pluginId: entry.pluginId }
        });
        registered.push(service);
      }
      for (const entry of registered) {
        const ids = registeredStateMachineServiceIds.get(entry.ownerFeatureId) || new Set();
        ids.add(entry.id);
        registeredStateMachineServiceIds.set(entry.ownerFeatureId, ids);
      }
      return Object.freeze(registered);
    },
    refreshStateMachines(platformRegistry, pluginId) {
      const id = String(pluginId || "").trim();
      for (const serviceId of registeredStateMachineServiceIds.get(id) || []) platformRegistry.unregister(serviceId);
      registeredStateMachineServiceIds.delete(id);
      return this.registerStateMachines(platformRegistry, id);
    }
  });
}
