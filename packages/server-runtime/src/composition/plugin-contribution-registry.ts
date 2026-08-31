import { isDeepStrictEqual } from "node:util";

import { decorateServerApiOperations } from "#meshrix/contracts/operations/operation-decorators";
import { operationFeatureId } from "#meshrix/contracts/operations/operation-feature-resolution";
import { assertPluginGatewayChannelContribution } from "@meshrix/contracts/plugins/gateway-channel-contract";
import {
  pluginManifestArtifactIdentity,
  readPluginArtifactFile
} from "#meshrix/foundation/module-system/plugin-registry";
import {
  PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
  PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT
} from "#meshrix/foundation/module-system/plugin-console-isolation";
import { validateExecutableStateMachineDefinition } from "#meshrix/foundation/workflow/state-machine/engine/state-machine-core";
import { registerPlatformService } from "./platform-registry.ts";
import { PLUGIN_HOST_PORT_CONTRACT } from "./plugin-artifact-core-contract.ts";

export const PLUGIN_HOST_PORT_NAMES: any = Object.freeze(Object.keys(PLUGIN_HOST_PORT_CONTRACT));

const HOST_PORT_NAMES: any = new Set<any>(PLUGIN_HOST_PORT_NAMES);
const CORE_MCP_OUTLETS: any = new Set<any>(["meshrix.discovery", "meshrix.gateway"]);
const MCP_OUTLET_PATTERN: any = /^meshrix\.[A-Za-z][A-Za-z0-9]*$/u;
const CONTRIBUTION_KINDS: readonly any[] = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "gatewayChannels",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function immutableSnapshot(value?: any, label?: any, seen: any = new WeakMap<object, any>(), active: any = new WeakSet<object>()) : any {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value === undefined
  ) return value;
  if (typeof value === "function") {
    if (seen.has(value)) return seen.get(value);
    const callable: any = function (this: any, ...args: any[]) : any {
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
    const output: any[] = [];
    seen.set(value, output);
    for (const entry of value) output.push(immutableSnapshot(entry, label, seen, active));
    active.delete(value);
    return Object.freeze(output);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain only plain objects and arrays.`);
  const output: Record<string, any> = {};
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    output[key] = immutableSnapshot(value[key], label, seen, active);
  }
  active.delete(value);
  return Object.freeze(output);
}

function snapshotContributions(contributions?: any) : any {
  const snapshot: Record<string, any> = {};
  for (const kind of CONTRIBUTION_KINDS) {
    const value: any = contributions[kind] ?? {};
    if (!isPlainObject(value)) throw new Error(`Plugin ${kind} contributions are required.`);
    snapshot[kind] = immutableSnapshot(value, `Plugin ${kind} contributions`);
  }
  return Object.freeze(snapshot);
}

function readonlyMap(source?: any) : any {
  const facade: Record<string, any> = {
    get size() : any {
      return source.size;
    },
    get: source.get.bind(source),
    has: source.has.bind(source),
    keys: source.keys.bind(source),
    values: source.values.bind(source),
    entries: source.entries.bind(source),
    forEach(callback?: any, thisArg?: any) : any {
      for (const [key, value] of source) callback.call(thisArg, value, key, facade);
    },
    [Symbol.iterator]: source[Symbol.iterator].bind(source)
  };
  return Object.freeze(facade);
}

function assertFields(value?: any, allowed?: any, label?: any) : any {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label} contains unsupported field ${field}.`);
  }
}

function jsonSafeValue(value?: any, label?: any, depth: any = 0) : any {
  if (depth > 12) throw new Error(`${label} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry?: any) : any => jsonSafeValue(entry, label, depth + 1)));
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain only JSON-safe values.`);
  return Object.freeze(Object.fromEntries((Object.entries(value) as [string, any][])
    .map(([key, entry]: any[]) : any => [key, jsonSafeValue(entry, label, depth + 1)])));
}

function capabilityOperationList(value?: any, label?: any) : any {
  const operations: any = stringList(value, label);
  if (operations.length === 0) throw new Error(`${label} must not be empty.`);
  return Object.freeze(operations);
}

function normalizeMcpCapabilityFamily(value?: any, outlet?: any, label?: any) : any {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertFields(value, new Set<any>([
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
  const family: any = Object.fromEntries([
    "id",
    "title",
    "protocol",
    "mcpOutlet",
    "discoveryTool",
    "summary",
    "degradedCliPolicy",
    "templateOperation"
  ].map((field?: any) : any => [field, String(value[field] || "").trim()]));
  if ((Object.values(family) as any[]).some((entry?: any) : any => !entry)) {
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

function normalizeMcpOutletDescriptor(value?: any, outlet?: any, label?: any) : any {
  if (!isPlainObject(value)) throw new Error(`${label} requires an outletDescriptor.`);
  assertFields(
    value,
    new Set<any>(["toolName", "title", "description", "architectureCategory", "annotations", "exchangeReceipt", "capabilityFamily"]),
    `${label} outletDescriptor`
  );
  const descriptor: Record<string, any> = {
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
  assertFields(value.annotations, new Set<any>(["readOnlyHint", "destructiveHint"]), `${label} outletDescriptor annotations`);
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

function stringList(value?: any, label?: any) : any {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const output: any = value.map((entry?: any) : any => String(entry || "").trim());
  if (output.some((entry?: any) : any => !entry) || new Set<any>(output).size !== output.length) {
    throw new Error(`${label} must contain unique non-empty strings.`);
  }
  return output;
}

function requiredHostPorts(implementation?: any, label?: any) : any {
  const ports: any = stringList(implementation.requiredHostPorts, `${label} requiredHostPorts`);
  for (const port of ports) {
    if (!HOST_PORT_NAMES.has(port)) throw new Error(`${label} requests unsupported host port ${port}.`);
  }
  return Object.freeze(ports);
}

function manifestIndex(manifests: any = []) : any {
  return new Map<any, any>(manifests.map((manifest?: any) : any => [manifest.id, manifest]));
}

function contributionEntries(contributions?: any, kind?: any) : any {
  const entries: any = (Object.values(contributions?.[kind] || {}) as any[]);
  for (const entry of entries) {
    if (!entry || entry.kind !== kind || typeof entry.id !== "string" || typeof entry.pluginId !== "string") {
      throw new Error(`Invalid enabled plugin ${kind} contribution record.`);
    }
  }
  return entries;
}

function enabledPluginIds(loadedPlugins: any = []) : any {
  return new Set<any>(loadedPlugins.map((plugin?: any) : any => String(plugin.id || "").trim()).filter(Boolean));
}

const REQUIRED_PLUGIN_RESOURCE_FIELDS: readonly any[] = Object.freeze([
  "capabilityDomain",
  "resourceKind",
  "capabilityVerb",
  "effectKind"
]);

function validateExplicitPluginResource(value?: any, label?: any) : any {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  for (const field of REQUIRED_PLUGIN_RESOURCE_FIELDS) {
    if (!String(value[field] || "").trim()) {
      throw new Error(`${label} requires explicit ${field}.`);
    }
  }
  if (!isPlainObject(value.fieldMap)) throw new Error(`${label} requires an explicit fieldMap object.`);
  jsonSafeValue(value, label);
}

function validateExplicitPluginOperationMetadata(definition?: any, manifest?: any, operationId?: any) : any {
  const featureId: any = String(definition.featureId || "").trim();
  if (!featureId || operationFeatureId(definition) !== featureId) {
    throw new Error(`Plugin operation ${operationId} must declare an explicit featureId.`);
  }
  if (!manifest.features.includes(featureId)) {
    throw new Error(`Plugin operation ${operationId} declares undeclared feature ${featureId}.`);
  }
  const toolsets: any = stringList(definition.toolsets, `Plugin operation ${operationId} toolsets`);
  if (toolsets.length === 0) {
    throw new Error(`Plugin operation ${operationId} must declare at least one explicit toolset.`);
  }
  validateExplicitPluginResource(definition.resource, `Plugin operation ${operationId} resource`);
  validateExplicitPluginResource(definition.resourceContext, `Plugin operation ${operationId} resourceContext`);
  if (!isDeepStrictEqual(definition.resource, definition.resourceContext)) {
    throw new Error(`Plugin operation ${operationId} resource and resourceContext must match exactly.`);
  }
}

function normalizeOperationContributions({ contributions, manifests, loadedPlugins }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const enabledIds: any = enabledPluginIds(loadedPlugins);
  const records: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "operations")) {
    if (!enabledIds.has(record.pluginId)) throw new Error(`Disabled plugin ${record.pluginId} published an operation.`);
    const manifest: any = manifestsById.get(record.pluginId);
    if (!manifest?.operations?.includes(record.id)) {
      throw new Error(`Plugin ${record.pluginId} operation ${record.id} is not declared by its manifest.`);
    }
    const implementation: any = record.implementation;
    assertFields(
      implementation,
      new Set<any>(["definition", "execute", "verifyExternalAuth", "requiredHostPorts", "opaqueInputPreprocessing", "hostPathInputPreprocessing"]),
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
    const manifestOpaqueInputs: any = manifest.opaqueInputPreprocessing?.[record.id] || [];
    const implementationOpaqueInputs: any = implementation.opaqueInputPreprocessing === undefined
      ? []
      : jsonSafeValue(
          implementation.opaqueInputPreprocessing,
          `Plugin operation ${record.id} opaqueInputPreprocessing`
        );
    if (!isDeepStrictEqual(implementationOpaqueInputs, manifestOpaqueInputs)) {
      throw new Error(`Plugin operation ${record.id} opaque input preprocessing must match its manifest.`);
    }
    const manifestHostPathInputs: any = manifest.hostPathInputPreprocessing?.[record.id] || [];
    const implementationHostPathInputs: any = implementation.hostPathInputPreprocessing === undefined
      ? []
      : jsonSafeValue(
          implementation.hostPathInputPreprocessing,
          `Plugin operation ${record.id} hostPathInputPreprocessing`
        );
    if (!isDeepStrictEqual(implementationHostPathInputs, manifestHostPathInputs)) {
      throw new Error(`Plugin operation ${record.id} host path input preprocessing must match its manifest.`);
    }
    const normalizedHostPorts: any = requiredHostPorts(implementation, `Plugin operation ${record.id}`);
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

function normalizeRoutes({ contributions, manifests, operationRecords }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const output: any = new Map<any, any>();
  const gatewayRouteIds: any = new Set<any>();
  const gatewayPaths: any = new Set<any>();
  for (const record of contributionEntries(contributions, "routes")) {
    const implementation: any = record.implementation;
    assertFields(implementation, new Set<any>(["operationId", "gateway"]), `Plugin route ${record.id}`);
    const operationId: any = String(implementation.operationId || "").trim();
    const operationRecord: any = operationRecords.get(operationId);
    if (!operationRecord || operationRecord.pluginId !== record.pluginId) {
      throw new Error(`Plugin route ${record.id} targets unavailable operation ${operationId}.`);
    }
    const declaration: any = manifestsById.get(record.pluginId)?.routes?.find((route?: any) : any => route.id === record.id);
    const definition: any = operationRecord.implementation.definition;
    if (!declaration || declaration.kind !== "http" || declaration.path !== definition.http?.path) {
      throw new Error(`Plugin route ${record.id} does not match operation ${operationId}.`);
    }
    let gateway: any = null;
    if (implementation.gateway !== undefined) {
      assertFields(
        implementation.gateway,
        new Set<any>(["routeId", "match", "path", "trafficClass", "streaming", "sticky", "bodyLimit"]),
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

function normalizeMcpTools({ contributions, manifests, operationRecords }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const output: any = new Map<any, any>();
  const descriptorByOutlet: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "mcpTools")) {
    const implementation: any = record.implementation;
    assertFields(implementation, new Set<any>(["operationId", "outlet", "outletDescriptor"]), `Plugin MCP tool ${record.id}`);
    const operationId: any = String(implementation.operationId || "").trim();
    const outlet: any = String(implementation.outlet || "").trim();
    const operationRecord: any = operationRecords.get(operationId);
    if (!operationRecord || operationRecord.pluginId !== record.pluginId || !MCP_OUTLET_PATTERN.test(outlet)) {
      throw new Error(`Plugin MCP tool ${record.id} has an invalid operation or outlet.`);
    }
    let outletDescriptor: any = null;
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
      const existing: any = descriptorByOutlet.get(outlet);
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

function normalizeGatewayChannels({ contributions, manifests, loadedPlugins }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const enabledIds: any = enabledPluginIds(loadedPlugins);
  const output: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "gatewayChannels")) {
    if (!enabledIds.has(record.pluginId)) throw new Error(`Disabled plugin ${record.pluginId} published Gateway channels.`);
    const manifest: any = manifestsById.get(record.pluginId);
    if (!manifest?.gatewayChannels?.includes(record.id)) {
      throw new Error(`Plugin ${record.pluginId} Gateway channel contribution ${record.id} is not declared by its manifest.`);
    }
    const implementation: any = assertPluginGatewayChannelContribution(record.implementation);
    for (const channel of implementation.channels) {
      if (output.has(channel.channelId)) throw new Error(`Gateway channel ${channel.channelId} has more than one owner.`);
      output.set(channel.channelId, Object.freeze({ ...record, implementation, channel }));
    }
  }
  return output;
}

function normalizeConsoleEntries({
  contributions,
  manifests,
  artifactIdentityResolver,
  operationRecords,
  mcpTools
}: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const output: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "consoleEntries")) {
    const implementation: any = record.implementation;
    assertFields(
      implementation,
      new Set<any>([
        "featureId", "viewKey", "routePath", "slotId", "componentId", "label", "requiredScopes",
        "assetPath", "toolIds"
      ]),
      `Plugin console entry ${record.id}`
    );
    const manifest: any = manifestsById.get(record.pluginId);
    const assetPath: any = String(implementation.assetPath || "").trim();
    const artifactIdentity: any = artifactIdentityResolver(manifest);
    const entryToken: any = Buffer.from(record.id, "utf8").toString("base64url");
    const toolIds: any = Object.freeze(stringList(
      implementation.toolIds,
      `Plugin console entry ${record.id} toolIds`
    ));
    const operationIdsByToolId: Record<string, any> = {};
    for (const toolId of toolIds) {
      const operation: any = operationRecords.get(toolId) || null;
      const mcpTool: any = mcpTools.get(toolId) || null;
      const owner: any = operation?.pluginId || mcpTool?.pluginId || "";
      const operationId: any = operation?.id || mcpTool?.operationId || "";
      if (!operationId || owner !== record.pluginId || (operation && mcpTool && mcpTool.operationId !== operation.id)) {
        throw new Error(`Plugin console entry ${record.id} tool ${toolId} is not owned by its plugin.`);
      }
      operationIdsByToolId[toolId] = operationId;
    }
    const sandboxUrl: any = `/api/plugins/v1/console-sandboxes/${record.pluginId}/${artifactIdentity.generation}/${artifactIdentity.artifactDigest.slice(7)}/${entryToken}.html`;
    const invokeUrl: any = `/api/plugins/v1/console-bridges/${record.pluginId}/${artifactIdentity.generation}/${artifactIdentity.artifactDigest.slice(7)}/${entryToken}/invoke`;
    const normalized: Record<string, any> = {
      id: record.id,
      pluginId: record.pluginId,
      featureId: String(implementation.featureId || "").trim(),
      viewKey: String(implementation.viewKey || "").trim(),
      routePath: String(implementation.routePath || "").trim(),
      slotId: String(implementation.slotId || "").trim(),
      componentId: String(implementation.componentId || "").trim(),
      label: String(implementation.label || record.id).trim(),
      requiredScopes: Object.freeze(stringList(implementation.requiredScopes, `Plugin console entry ${record.id} requiredScopes`)),
      toolIds,
      operationIdsByToolId: Object.freeze(operationIdsByToolId),
      assetPath,
      mountExport: PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT,
      sandboxUrl,
      invokeUrl,
      bridgeVersion: PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
      artifactDigest: artifactIdentity.artifactDigest,
      artifactGeneration: artifactIdentity.generation
    };
    const componentPattern: any = new RegExp(`^${record.pluginId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[A-Za-z0-9][A-Za-z0-9._-]*$`, "u");
    const claimPattern: any = /^[a-z][a-zA-Z0-9._-]*$/u;
    const routePathValid: any = !normalized.routePath || (
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
      normalized.assetPath.split("/").some((part?: any) : any => !part) ||
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

function publicConsoleEntry(entry?: any) : any {
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
    sandboxUrl: entry.sandboxUrl,
    bridgeVersion: entry.bridgeVersion,
    artifactDigest: entry.artifactDigest,
    artifactGeneration: entry.artifactGeneration,
    toolIds: entry.toolIds
  });
}

function normalizeStateMachines({ contributions, manifests }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const output: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "stateMachines")) {
    const implementation: any = record.implementation;
    assertFields(implementation, new Set<any>(["definition", "ref"]), `Plugin state machine ${record.id}`);
    if (!manifestsById.get(record.pluginId)?.stateMachines?.includes(record.id)) {
      throw new Error(`Plugin state machine ${record.id} is not declared by its manifest.`);
    }
    const hasDefinition: any = isPlainObject(implementation.definition);
    const ref: any = String(implementation.ref || "").trim();
    if (hasDefinition === Boolean(ref)) {
      throw new Error(`Plugin state machine ${record.id} must provide exactly one of definition or ref.`);
    }
    if (hasDefinition) {
      if (implementation.definition.machineId !== record.id) {
        throw new Error(`Plugin state machine ${record.id} definition identity does not match.`);
      }
      const validation: any = validateExecutableStateMachineDefinition(implementation.definition);
      if (!validation.ok) throw new Error(`Plugin state machine ${record.id} is not executable.`);
    } else if (ref !== record.id) {
      throw new Error(`Plugin state machine ${record.id} ref must match its claim.`);
    }
    output.set(record.id, Object.freeze({ ...record, ref, definition: implementation.definition || null }));
  }
  return output;
}

function normalizeVerifierHooks({ contributions, manifests }: Record<string, any>) : any {
  const manifestsById: any = manifestIndex(manifests);
  const output: any = new Map<any, any>();
  for (const record of contributionEntries(contributions, "verifierHooks")) {
    const implementation: any = record.implementation;
    assertFields(implementation, new Set<any>(["run"]), `Plugin verifier hook ${record.id}`);
    if (implementation.run !== undefined && typeof implementation.run !== "function") {
      throw new Error(`Plugin verifier hook ${record.id} run must be a function.`);
    }
    const declaration: any = manifestsById.get(record.pluginId)?.verifierHooks?.find((hook?: any) : any => hook.id === record.id);
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

function publicPluginSummary(plugin: Record<string, any> = {}) : any {
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
}: Record<string, any> = {}) : any {
  if (typeof artifactIdentityResolver !== "function" || typeof artifactFileReader !== "function") {
    throw new TypeError("Plugin console assets require artifact identity and file authorities.");
  }
  const admittedContributions: any = snapshotContributions(contributions);
  const enabledIds: any = enabledPluginIds(loadedPlugins);
  if (contributionEntries(admittedContributions, "operations").some((entry?: any) : any => !enabledIds.has(entry.pluginId))) {
    throw new Error("Disabled plugin contributions cannot enter the runtime registry.");
  }
  const operationRecords: any = normalizeOperationContributions({ contributions: admittedContributions, manifests, loadedPlugins });
  const mcpTools: any = normalizeMcpTools({ contributions: admittedContributions, manifests, operationRecords });
  const gatewayChannels: any = normalizeGatewayChannels({ contributions: admittedContributions, manifests, loadedPlugins });
  const mcpToolByOperation: any = new Map<any, any>();
  for (const tool of mcpTools.values()) {
    if (mcpToolByOperation.has(tool.operationId)) {
      throw new Error(`Plugin operation ${tool.operationId} has more than one MCP tool binding.`);
    }
    mcpToolByOperation.set(tool.operationId, tool);
  }
  const pluginFeatureIds: any = new Set<any>(manifests.flatMap((manifest?: any) : any => manifest.features || []));
  const claimedOperationIds: any = new Set<any>(manifests.flatMap((manifest?: any) : any => manifest.operations || []));
  const conflictingClaim: any = coreOperations.find((operation?: any) : any => claimedOperationIds.has(operation.id));
  if (conflictingClaim) {
    throw new Error(`Core operation ${conflictingClaim.id} conflicts with a plugin-owned operation claim.`);
  }
  const misplacedPluginOperation: any = coreOperations.find((operation?: any) : any => pluginFeatureIds.has(operationFeatureId(operation)));
  if (misplacedPluginOperation) {
    throw new Error(`Plugin-owned operation ${misplacedPluginOperation.id} remains in the core operation registry.`);
  }
  const core: any = coreOperations;
  const activeFeatures: any = new Set<any>(activeFeatureIds);
  const activeCore: any = core.filter((operation?: any) : any => activeFeatures.has(operationFeatureId(operation)));
  function buildActiveOperationsSnapshot() : any {
    const pluginDefinitions: any = [...operationRecords.values()].map((record?: any) : any => {
      const mcpTool: any = mcpToolByOperation.get(record.id) || null;
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
  const activeOperations: any = buildActiveOperationsSnapshot();
  let currentActiveOperationsSnapshot: any = activeOperations;
  function invalidateActiveOperationsSnapshot() : any {
    currentActiveOperationsSnapshot = null;
  }
  const routes: any = normalizeRoutes({ contributions: admittedContributions, manifests, operationRecords });
  const consoleEntries: any = normalizeConsoleEntries({
    contributions: admittedContributions,
    manifests,
    artifactIdentityResolver,
    operationRecords,
    mcpTools
  });
  const stateMachines: any = normalizeStateMachines({ contributions: admittedContributions, manifests });
  const verifierHooks: any = normalizeVerifierHooks({ contributions: admittedContributions, manifests });
  const activePluginIds: any = new Set<any>(loadedPlugins.map((plugin?: any) : any => plugin.id));
  const manifestsById: any = manifestIndex(manifests);
  const consoleSandboxesByUrl: any = new Map<any, any>();
  const consoleBridgesByUrl: any = new Map<any, any>();
  function refreshConsoleSandboxIndex() : any {
    consoleSandboxesByUrl.clear();
    consoleBridgesByUrl.clear();
    for (const entry of consoleEntries.values()) {
      if (consoleSandboxesByUrl.has(entry.sandboxUrl) || consoleBridgesByUrl.has(entry.invokeUrl)) {
        throw new Error(`Plugin console sandbox URL is ambiguous: ${entry.sandboxUrl}.`);
      }
      consoleSandboxesByUrl.set(entry.sandboxUrl, entry);
      consoleBridgesByUrl.set(entry.invokeUrl, entry);
    }
  }
  refreshConsoleSandboxIndex();
  const registeredStateMachineServiceIds: any = new Map<any, any>();

  function preparePluginContributionReplacement(pluginId?: any, contributions?: any) : any {
    const id: any = String(pluginId || "").trim();
    if (!activePluginIds.has(id)) throw new Error(`Plugin ${id} is not active.`);
    const admitted: any = snapshotContributions(contributions);
    for (const kind of CONTRIBUTION_KINDS) {
      if (contributionEntries(admitted, kind).some((entry?: any) : any => entry.pluginId !== id)) {
        throw new Error(`Plugin ${id} contribution replacement contains a foreign owner.`);
      }
    }
    const nextOperations: any = normalizeOperationContributions({ contributions: admitted, manifests, loadedPlugins });
    const nextMcpTools: any = normalizeMcpTools({ contributions: admitted, manifests, operationRecords: nextOperations });
    const nextGatewayChannels: any = normalizeGatewayChannels({ contributions: admitted, manifests, loadedPlugins });
    const nextRoutes: any = normalizeRoutes({ contributions: admitted, manifests, operationRecords: nextOperations });
    const nextConsoleEntries: any = normalizeConsoleEntries({
      contributions: admitted,
      manifests,
      artifactIdentityResolver,
      operationRecords: nextOperations,
      mcpTools: nextMcpTools
    });
    const nextStateMachines: any = normalizeStateMachines({ contributions: admitted, manifests });
    const nextVerifierHooks: any = normalizeVerifierHooks({ contributions: admitted, manifests });
    const replacements: any[] = [
      [operationRecords, nextOperations],
      [routes, nextRoutes],
      [mcpTools, nextMcpTools],
      [gatewayChannels, nextGatewayChannels],
      [consoleEntries, nextConsoleEntries],
      [stateMachines, nextStateMachines],
      [verifierHooks, nextVerifierHooks]
    ];
    for (const [current, next] of replacements) {
      for (const [key] of next) {
        const existing: any = current.get(key);
        if (existing && existing.pluginId !== id) throw new Error(`Plugin contribution ${key} conflicts with another owner.`);
      }
    }
    const previous: any = replacements.map(([current]: any[]) : any => [...current].filter(([, record]: any[]) : any => record.pluginId === id));
    const previousMcpBindings: any[] = [...mcpToolByOperation];
    let committed: any = false;
    const apply: any = (sets?: any) : any => {
      for (let index: any = 0; index < replacements.length; index += 1) {
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
      refreshConsoleSandboxIndex();
    };
    return Object.freeze({
      commit() : any {
        if (!committed) apply(replacements.map(([, next]: any[]) : any => [...next]));
        committed = true;
      },
      rollback() : any {
        if (!committed) return;
        apply(previous);
        mcpToolByOperation.clear();
        for (const [key, value] of previousMcpBindings) mcpToolByOperation.set(key, value);
        committed = false;
      }
    });
  }

  function deactivatePlugin(pluginId?: any) : any {
    const id: any = String(pluginId || "").trim();
    if (!activePluginIds.delete(id)) return Object.freeze({ ok: true, changed: false, pluginId: id });
    for (const records of [operationRecords, routes, mcpTools, gatewayChannels, consoleEntries, stateMachines, verifierHooks]) {
      for (const [key, record] of records) {
        if (record.pluginId === id) records.delete(key);
      }
    }
    refreshConsoleSandboxIndex();
    invalidateActiveOperationsSnapshot();
    return Object.freeze({ ok: true, changed: true, pluginId: id });
  }

  function preparePluginDeactivation(pluginId?: any) : any {
    const id: any = String(pluginId || "").trim();
    const snapshots: any = [operationRecords, routes, mcpTools, gatewayChannels, consoleEntries, stateMachines, verifierHooks]
      .map((records?: any) : any => [records, [...records].filter(([, record]: any[]) : any => record.pluginId === id)]);
    const wasActive: any = activePluginIds.has(id);
    let committed: any = false;
    return Object.freeze({
      commit() : any {
        if (!committed) deactivatePlugin(id);
        committed = true;
      },
      rollback() : any {
        if (!committed) return;
        if (wasActive) activePluginIds.add(id);
        for (const [records, entries] of snapshots) for (const [key, record] of entries) records.set(key, record);
        refreshConsoleSandboxIndex();
        invalidateActiveOperationsSnapshot();
        committed = false;
      }
    });
  }

  function currentActiveOperations() : any {
    if (!currentActiveOperationsSnapshot) {
      currentActiveOperationsSnapshot = buildActiveOperationsSnapshot();
    }
    return currentActiveOperationsSnapshot;
  }

  function requireOperation(operationId?: any) : any {
    const record: any = operationRecords.get(String(operationId || "").trim());
    if (!record) throw new Error(`Plugin operation is not enabled: ${String(operationId || "").trim()}.`);
    return record;
  }

  function getConsoleSandboxEntry(sandboxUrl?: any) : any {
    const entry: any = consoleSandboxesByUrl.get(String(sandboxUrl || "")) || null;
    return entry ? publicConsoleEntry(entry) : null;
  }

  async function readConsoleSandbox(sandboxUrl?: any) : Promise<any> {
    const entry: any = consoleSandboxesByUrl.get(String(sandboxUrl || ""));
    if (!entry || !activePluginIds.has(entry.pluginId)) return null;
    const manifest: any = manifestsById.get(entry.pluginId);
    if (!manifest) return null;
    const bytes: any = await artifactFileReader(manifest, entry.assetPath);
    return Object.freeze({ entry: publicConsoleEntry(entry), bytes: Buffer.from(bytes) });
  }

  function resolveConsoleBridgeInvocation(invokeUrl?: any, toolId?: any) : any {
    const entry: any = consoleBridgesByUrl.get(String(invokeUrl || "")) || null;
    const id: any = String(toolId || "").trim();
    const operationId: any = entry?.operationIdsByToolId?.[id] || "";
    if (!entry || !activePluginIds.has(entry.pluginId) || !operationId) return null;
    return Object.freeze({ entry: publicConsoleEntry(entry), operationId, toolId: id });
  }

  return Object.freeze({
    activeOperations,
    operations: readonlyMap(operationRecords),
    routes: readonlyMap(routes),
    mcpTools: readonlyMap(mcpTools),
    gatewayChannels: readonlyMap(gatewayChannels),
    consoleEntries: readonlyMap(consoleEntries),
    stateMachines: readonlyMap(stateMachines),
    verifierHooks: readonlyMap(verifierHooks),
    get enabledPlugins() : any {
      return Object.freeze(loadedPlugins.filter((plugin?: any) : any => activePluginIds.has(plugin.id)).map(publicPluginSummary));
    },
    deactivatePlugin,
    preparePluginDeactivation,
    preparePluginContributionReplacement,
    currentActiveOperations,
    requireOperation,
    getConsoleSandboxEntry,
    readConsoleSandbox,
    resolveConsoleBridgeInvocation,
    publicRuntime() : any {
      return Object.freeze({
        enabledPlugins: Object.freeze(loadedPlugins.filter((plugin?: any) : any => activePluginIds.has(plugin.id)).map(publicPluginSummary)),
        routes: Object.freeze([...routes.values()].map((entry?: any) : any => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          operationId: entry.operationId,
          ...(entry.gateway ? { gateway: entry.gateway } : {})
        }))),
        mcpTools: Object.freeze([...mcpTools.values()].map((entry?: any) : any => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          operationId: entry.operationId,
          outlet: entry.outlet,
          ...(entry.outletDescriptor ? { outletDescriptor: entry.outletDescriptor } : {})
        }))),
        consoleEntries: Object.freeze([...consoleEntries.values()].map(publicConsoleEntry)),
        stateMachines: Object.freeze([...stateMachines.values()].map((entry?: any) : any => Object.freeze({ id: entry.id, pluginId: entry.pluginId, ref: entry.ref || "", owned: Boolean(entry.definition) }))),
        verifierHooks: Object.freeze([...verifierHooks.values()].map((entry?: any) : any => Object.freeze({
          id: entry.id,
          pluginId: entry.pluginId,
          workloadKind: entry.workloadKind,
          source: entry.source,
          report: entry.report
        })))
      });
    },
    registerStateMachines(platformRegistry?: any, pluginId: any = "") : any {
      const owner: any = String(pluginId || "").trim();
      const registered: any[] = [];
      for (const entry of stateMachines.values()) {
        if (owner && entry.pluginId !== owner) continue;
        if (entry.ref) {
          if (!platformRegistry.get(`state-machine.${entry.ref}`)) {
            const service: any = registerPlatformService(platformRegistry, {
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
        const service: any = registerPlatformService(platformRegistry, {
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
        const ids: any = registeredStateMachineServiceIds.get(entry.ownerFeatureId) || new Set<any>();
        ids.add(entry.id);
        registeredStateMachineServiceIds.set(entry.ownerFeatureId, ids);
      }
      return Object.freeze(registered);
    },
    refreshStateMachines(platformRegistry?: any, pluginId?: any) : any {
      const id: any = String(pluginId || "").trim();
      for (const serviceId of registeredStateMachineServiceIds.get(id) || []) platformRegistry.unregister(serviceId);
      registeredStateMachineServiceIds.delete(id);
      return this.registerStateMachines(platformRegistry, id);
    }
  });
}
