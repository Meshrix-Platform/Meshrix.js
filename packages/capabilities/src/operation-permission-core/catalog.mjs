import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import { operationFeatureId } from "@meshrix/contracts/operations/operation-feature-resolution";
import {
  INTERNAL_OPERATION_IDS_HIDDEN_FROM_TOOL_CATALOG,
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS,
  RISK_RANK,
  TOOL_ALIAS_IDS_BY_OPERATION_ID,
  TOOL_ID_BY_OPERATION_ID,
  TOOLSET_BY_ID,
  TOOLSET_BY_SCOPE
} from "./catalog-data.mjs";

export {
  OPERATION_PERMISSION_API_PREFIX,
  OPERATION_PERMISSION_PROFILES,
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS
} from "./catalog-data.mjs";

function riskRank(risk = "read_only") {
  return RISK_RANK[String(risk || "read_only")] ?? RISK_RANK.read_only;
}

function toolsetAllowsRisk(toolsetId, risk = "read_only") {
  const declaredRisk = TOOLSET_BY_ID.get(toolsetId)?.maxRisk || "read_only";
  return riskRank(risk) <= riskRank(declaredRisk);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

const DYNAMIC_TOOLSET_IDS_BY_FEATURE = Object.freeze({
  "upstream-gateway": Object.freeze([
    "meshrix.gateway.read",
    "meshrix.gateway.write",
    "meshrix.gateway.maintain"
  ])
});

function dynamicToolsetIds(activeFeatureSet = null) {
  if (!activeFeatureSet) return [];
  return uniqueStrings(
    [...activeFeatureSet].flatMap((featureId) => DYNAMIC_TOOLSET_IDS_BY_FEATURE[featureId] || [])
  );
}


function fingerprint(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function operationScope(operation) {
  return uniqueStrings(operation.requiredScopes || [])[0] || "";
}

function operationFeatureActive(operation = {}, activeFeatureSet = null) {
  if (!activeFeatureSet) {
    return true;
  }
  const featureId = String(operation.featureId || operationFeatureId(operation) || "core-platform").trim() || "core-platform";
  return activeFeatureSet.has(featureId);
}

function normalizeRisk(operation = {}) {
  if (operation.destructive) {
    return "destructive";
  }
  const risk = String(operation.safety?.risk || "").trim();
  if (risk && RISK_RANK[risk] !== undefined) {
    return risk;
  }
  return operation.readOnly === false ? "safe_write" : "read_only";
}

function operationTimeoutMs(operation = {}, fallback = 30_000) {
  const raw = operation.execution?.timeoutMs ??
    operation.target?.timeoutMs ??
    operation.safety?.timeoutMs ??
    operation.timeoutMs ??
    fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(100, Math.min(Math.trunc(value), 300_000));
}

function inferToolsets(operation, scopes = [], toolId = "", risk = "read_only") {
  const toolsets = new Set([
    ...uniqueStrings(operation.toolsets || []),
    ...scopes.map((scope) => TOOLSET_BY_SCOPE[scope]).filter(Boolean)
  ]);
  if (toolId.startsWith("meshrix.runtime.")) {
    if (operation.id === "runtime.info" || operation.id === "runtime.mounts") {
      toolsets.add("meshrix.runtime.read");
    } else {
      toolsets.add("meshrix.runtime.maintain");
    }
  }
  if (toolId.startsWith("meshrix.architecture.")) {
    toolsets.add("meshrix.runtime.read");
  }
  if (toolId.startsWith("meshrix.sampleCapabilityPack.")) {
    toolsets.add(operation.id === "sample_capability_pack.materialize" ? "meshrix.runtime.maintain" : "meshrix.runtime.read");
  }
  if (toolId.startsWith("meshrix.gateway.")) {
    if (scopes.includes("gateway:admin")) {
      toolsets.add("meshrix.gateway.admin");
    } else if (scopes.includes("gateway:maintain")) {
      toolsets.add("meshrix.gateway.maintain");
    } else if (scopes.includes("gateway:write")) {
      toolsets.add("meshrix.gateway.write");
    } else {
      toolsets.add("meshrix.gateway.read");
    }
  }
  if (toolId.startsWith("meshrix.storageBackups.")) {
    toolsets.add(
      operation.id === "storage.backups.list" || operation.id === "storage.backups.restore_preview"
        ? "meshrix.runtime.read"
        : "meshrix.runtime.maintain"
    );
  }
  if (toolId.startsWith("meshrix.executiveReport.")) {
    toolsets.add(operation.id === "executive_report.generate" ? "meshrix.runtime.maintain" : "meshrix.runtime.read");
  }
  if (
    toolId.startsWith("meshrix.agentWorkspace.") ||
    toolId.startsWith("meshrix.workspace.") ||
    toolId.startsWith("meshrix.agentSession.") ||
    toolId.startsWith("meshrix.workspaceGovernance.")
  ) {
    toolsets.add("meshrix.agent.workspace");
  }
  if (toolId.includes(".renderMarkdown")) {
    toolsets.add("meshrix.result.export");
  }
  if (operation.id === "agent_sync.publish") {
    toolsets.add("meshrix.agent.sync.publish");
  }
  return [...toolsets].filter((toolsetId) => !TOOLSET_BY_ID.has(toolsetId) || toolsetAllowsRisk(toolsetId, risk));
}

function normalizeHttpEndpoint(operation = {}) {
  const method = String(operation.http?.method || "POST").toUpperCase();
  const path = String(operation.http?.path || "");
  const query = Array.isArray(operation.http?.query) && operation.http.query.length
    ? `?${operation.http.query.map((item) => `${item.name.toUpperCase()}=${item.name}`).join("&")}`
    : "";
  return { method, endpoint: `${path}${query}` };
}

function createInternalToolDefinition({
  id,
  label,
  description,
  owner = "meshrix",
  source = "handler-backed",
  handlerId,
  featureId = "core-platform",
  toolsets,
  requiredScopes,
  risk = "read_only",
  inputSchema = { type: "object" },
  tags = []
}) {
  const writeCapable = risk !== "read_only";
  const approvalRequired = risk === "repair_write" || risk === "destructive";
  return {
    id,
    version: "1",
    label,
    description,
    owner,
    ownerKind: "core",
    ownerId: "core-platform",
    source,
    featureId,
    operationId: "",
    handlerId,
    transport: {
      internal: true
    },
    toolsets: uniqueStrings(toolsets),
    requiredScopes: uniqueStrings(requiredScopes),
    inputSchema,
    outputSchema: { type: "object" },
    risk,
    readOnly: !writeCapable,
    destructive: risk === "destructive",
    concurrencySafe: risk === "read_only",
    requiresApproval: approvalRequired,
    approvalScope: approvalRequired ? "operation:approve" : "",
    timeoutMs: 30_000,
    maxResultBytes: 2 * 1024 * 1024,
    redactionPolicy: {
      input: "default",
      output: "summary"
    },
    auditPolicy: {
      enabled: true,
      recordInput: true,
      recordOutput: false
    },
    telemetryPolicy: {
      enabled: true
    },
    status: "internal",
    tags: uniqueStrings([source, featureId, risk, ...tags])
  };
}

function createInternalToolDefinitions() {
  return [
    ...[
      ["system.health", "System health", "meshrix.runtime.read", "storage:read", "read_only"],
      ["runtime.info", "Runtime info", "meshrix.runtime.read", "storage:read", "read_only"],
      ["storage.summary", "Storage summary", "meshrix.storage.read", "storage:read", "read_only"],
      ["storage.doctor", "Storage doctor", "meshrix.runtime.read", "storage:read", "read_only"],
      ["storage.reconcile", "Storage reconcile", "meshrix.runtime.maintain", "runtime:admin", "repair_write"],
      ["jobs.list", "Jobs list", "meshrix.jobs.read", "jobs:read", "read_only"],
      ["jobs.failed_review", "Failed jobs review", "meshrix.jobs.read", "jobs:read", "read_only"],
      ["runtime.reload_mounts", "Runtime reload mounts", "meshrix.runtime.maintain", "runtime:admin", "repair_write"]
    ].map(([toolName, label, toolset, scope, risk]) =>
      createInternalToolDefinition({
        id: `maintenance-agent.${toolName}`,
        label: `Maintenance agent ${label}`,
        description: `Run ${label.toLowerCase()} through the MaintenanceAgent internal tool registry.`,
        handlerId: `MaintenanceAgent.${toolName}`,
        toolsets: [toolset],
        requiredScopes: [scope],
        risk,
        featureId: "maintenance-agent-runbooks",
        tags: ["maintenance-agent"]
      })
    )
  ];
}

function summarizeToolGroups(tools = [], toolsets = OPERATION_PERMISSION_TOOLSETS) {
  return toolsets
    .map((toolset) => {
      const groupTools = tools.filter((tool) => tool.toolsets?.includes(toolset.id));
      if (!groupTools.length) {
        return null;
      }
      const maxRisk = groupTools.reduce(
        (max, tool) => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max),
        "read_only"
      );
      return {
        id: toolset.id,
        label: toolset.label || toolset.id,
        description: toolset.description || "",
        toolsetId: toolset.id,
        requiredScopes: uniqueStrings(toolset.requiredScopes || []),
        defaultForAgents: toolset.defaultForAgents === true,
        grantable: toolset.grantable !== false,
        maxRisk,
        toolCount: groupTools.length,
        activeToolCount: groupTools.filter((tool) => tool.status === "active").length,
        internalToolCount: groupTools.filter((tool) => tool.status === "internal").length,
        writeToolCount: groupTools.filter((tool) => tool.readOnly === false).length,
        sampleToolIds: groupTools.slice(0, 6).map((tool) => tool.id)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.defaultForAgents !== right.defaultForAgents) {
        return left.defaultForAgents ? -1 : 1;
      }
      return String(left.label || "").localeCompare(String(right.label || ""));
    });
}

function projectActiveCatalogDirectories(tools = [], profiles = [], { retainedToolsetIds = [] } = {}) {
  const activeToolIds = new Set(tools.map((tool) => tool.id));
  const retainedToolsetIdSet = new Set(uniqueStrings(retainedToolsetIds));
  const retainedScopeIds = OPERATION_PERMISSION_TOOLSETS
    .filter((toolset) => retainedToolsetIdSet.has(toolset.id))
    .flatMap((toolset) => toolset.requiredScopes || []);
  const activeScopeIds = new Set([
    ...tools.flatMap((tool) => tool.requiredScopes || []),
    ...retainedScopeIds
  ]);
  const directlyUsedToolsetIds = new Set(tools.flatMap((tool) => tool.toolsets || []));
  const requestedProfileToolsetIds = new Set(
    profiles.flatMap((profile) => uniqueStrings(profile?.toolsets || []))
  );
  const configuredToolsetIds = new Set(OPERATION_PERMISSION_TOOLSETS.map((toolset) => toolset.id));
  const pluginToolsets = [...directlyUsedToolsetIds]
    .filter((toolsetId) => !configuredToolsetIds.has(toolsetId))
    .map((toolsetId) => {
      const ownedTools = tools.filter((tool) => tool.ownerKind === "plugin" && tool.toolsets.includes(toolsetId));
      if (ownedTools.length === 0) return null;
      return Object.freeze({
        id: toolsetId,
        label: toolsetId,
        description: "Plugin-owned toolset.",
        requiredScopes: Object.freeze(uniqueStrings(ownedTools.flatMap((tool) => tool.requiredScopes || []))),
        defaultForAgents: false,
        grantable: true,
        maxRisk: ownedTools.reduce((highest, tool) => riskRank(tool.risk) > riskRank(highest) ? tool.risk : highest, "read_only")
      });
    }).filter(Boolean);
  const toolsets = [...OPERATION_PERMISSION_TOOLSETS, ...pluginToolsets]
    .filter((toolset) => {
      if (directlyUsedToolsetIds.has(toolset.id)) return true;
      if (retainedToolsetIdSet.has(toolset.id)) return true;
      return requestedProfileToolsetIds.has(toolset.id) &&
        (toolset.requiredScopes || []).some((scope) => activeScopeIds.has(scope));
    })
    .map((toolset) => Object.freeze({
      ...toolset,
      requiredScopes: Object.freeze(
        uniqueStrings(toolset.requiredScopes || []).filter((scope) => activeScopeIds.has(scope))
      )
    }));
  const activeToolsetIds = new Set(toolsets.map((toolset) => toolset.id));
  const configuredScopeIds = new Set(OPERATION_PERMISSION_SCOPES.map((scope) => scope.id));
  const scopes = [
    ...OPERATION_PERMISSION_SCOPES.filter((scope) => activeScopeIds.has(scope.id)),
    ...[...activeScopeIds].filter((scopeId) => !configuredScopeIds.has(scopeId)).map((scopeId) => Object.freeze({
      id: scopeId,
      label: scopeId,
      description: "Plugin-owned operation scope."
    }))
  ];
  const projectedProfiles = profiles
    .map((profile) => ({
      ...profile,
      toolsets: uniqueStrings(profile?.toolsets || []).filter((toolset) => activeToolsetIds.has(toolset)),
      toolAllow: uniqueStrings(profile?.toolAllow || []).filter((toolId) => activeToolIds.has(toolId)),
      toolDeny: uniqueStrings(profile?.toolDeny || []).filter((toolId) => activeToolIds.has(toolId))
    }))
    .filter((profile) => profile.toolsets.length > 0 || profile.toolAllow.length > 0);
  return {
    scopes: Object.freeze(scopes),
    toolsets: Object.freeze(toolsets),
    profiles: Object.freeze(projectedProfiles)
  };
}

function validateToolDefinitions(tools = [], operationsById = new Map(), { scopes = [], toolsets = [] } = {}) {
  const ids = new Set();
  const validScopes = new Set(scopes.map((scope) => scope.id));
  const validToolsets = new Set(toolsets.map((toolset) => toolset.id));
  const toolsetById = new Map(toolsets.map((toolset) => [toolset.id, toolset]));
  for (const tool of tools) {
    if (!tool.id) {
      throw new Error("Tool definition is missing id.");
    }
    if (ids.has(tool.id)) {
      throw new Error(`Duplicate tool id: ${tool.id}`);
    }
    ids.add(tool.id);
    if (tool.operationId && !operationsById.has(tool.operationId)) {
      throw new Error(`Tool ${tool.id} references unknown operation: ${tool.operationId}`);
    }
    for (const scope of tool.requiredScopes || []) {
      if (!validScopes.has(scope)) {
        throw new Error(`Tool ${tool.id} references unknown scope: ${scope}`);
      }
    }
    for (const toolset of tool.toolsets || []) {
      if (!validToolsets.has(toolset)) {
        throw new Error(`Tool ${tool.id} references unknown toolset: ${toolset}`);
      }
    }
    if (!tool.toolsets?.length) {
      throw new Error(`Tool ${tool.id} must belong to at least one toolset.`);
    }
    const unsafeToolsets = (tool.toolsets || []).filter((toolset) => {
      const declaredRisk = toolsetById.get(toolset)?.maxRisk || "read_only";
      return riskRank(tool.risk) > riskRank(declaredRisk);
    });
    if (unsafeToolsets.length > 0) {
      throw new Error(`Tool ${tool.id} risk ${tool.risk} exceeds declared toolset risk for ${unsafeToolsets.join(", ")}.`);
    }
    if (tool.readOnly === false && tool.auditPolicy?.enabled !== true) {
      throw new Error(`Write-capable tool ${tool.id} must enable audit.`);
    }
    if ((tool.destructive || tool.requiresApproval) && !tool.approvalScope) {
      throw new Error(`Approval-capable tool ${tool.id} must declare approvalScope.`);
    }
  }
}

export function scopesToToolsets(scopes = []) {
  return uniqueStrings(scopes.map((scope) => TOOLSET_BY_SCOPE[scope]).filter(Boolean));
}

export function toolsetsToScopes(toolsets = []) {
  const selected = new Set(toolsets);
  const scopes = [];
  for (const toolset of OPERATION_PERMISSION_TOOLSETS) {
    if (!selected.has(toolset.id)) {
      continue;
    }
    scopes.push(...(toolset.requiredScopes || []));
  }
  return uniqueStrings(scopes);
}


export function createToolCatalog({ operations = [], activeFeatureIds = null, profiles = [] } = {}) {
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  const activeFeatureSet = activeFeatureIds === null || activeFeatureIds === undefined
    ? null
    : new Set(uniqueStrings(activeFeatureIds));
  const tools = [];
  for (const operation of operations) {
    if (!operationFeatureActive(operation, activeFeatureSet)) {
      continue;
    }
    const toolId = operation.toolId || TOOL_ID_BY_OPERATION_ID[operation.id];
    if (!toolId) {
      continue;
    }
    if (INTERNAL_OPERATION_IDS_HIDDEN_FROM_TOOL_CATALOG.has(operation.id)) {
      continue;
    }
    const operationScopes = uniqueStrings(operation.requiredScopes || []);
    const explicitScopes = operationScopes;
    const scope = operationScope(operation);
    const requiredScopes = explicitScopes.length
      ? explicitScopes
      : uniqueStrings([
          ...(scope ? [scope] : [])
        ]);
    const { method, endpoint } = normalizeHttpEndpoint(operation);
    const risk = normalizeRisk(operation);
    const requiresApproval = operation.destructive === true || risk === "destructive" || operation.safety?.requiresConfirmation === true;
    const pluginOwnerId = String(operation.pluginId || "").trim();
    const tool = {
      id: toolId,
      version: "1",
      label: String(operation.label || toolId),
      description: String(operation.description || operation.label || toolId),
      owner: pluginOwnerId || "meshrix",
      ownerKind: pluginOwnerId ? "plugin" : "core",
      ownerId: pluginOwnerId || "core-platform",
      source: "operation-backed",
      featureId: operation.featureId || "",
      feature: "",
      aspects: [...(operation.aspects || [])],
      mcpOutlet: String(operation._meta?.mcpOutlet || ""),
      mcpOutletDescriptor: operation._meta?.mcpOutletDescriptor || null,
      upstreamProjectedOperation: operation._meta?.upstreamProjectedOperation === true,
      sourceRevision: Number(operation._meta?.sourceRevision || 0),
      sourceDigest: String(operation._meta?.sourceDigest || ""),
      serviceId: String(operation._meta?.serviceId || ""),
      serviceRevision: Number(operation._meta?.serviceRevision || 0),
      operationKey: String(operation._meta?.operationKey || ""),
      protocol: String(operation._meta?.protocol || ""),
      dynamicCapability: operation._meta?.dynamicCapability || null,
      resourceContext: operation._meta?.resourceContext || null,
      operationId: operation.id,
      handlerId: operation.target?.method || "",
      deprecated: operation.deprecated === true,
      replacementService: operation.replacementService || "",
      replacementOperationPrefix: operation.replacementOperationPrefix || "",
      lifecycle: operation.lifecycle || {},
      transport: {
        http: {
          method,
          path: operation.http?.path || "",
          query: operation.http?.query || []
        },
        rpc: operation.rpc || null,
        cli: operation.cli || null,
        binary: operation.binary === true
      },
      toolsets: inferToolsets(operation, requiredScopes, toolId, risk),
      requiredScopes,
      resourceContext: operation.resourceContext && typeof operation.resourceContext === "object" && !Array.isArray(operation.resourceContext)
        ? operation.resourceContext
        : operation._meta?.resourceContext && typeof operation._meta.resourceContext === "object" && !Array.isArray(operation._meta.resourceContext)
          ? operation._meta.resourceContext
          : undefined,
      inputSchema: operation.inputSchema || { type: "object" },
      outputSchema: operation.binary ? { type: "binary" } : { type: "object" },
      risk,
      readOnly: operation.readOnly !== false,
      destructive: operation.destructive === true || risk === "destructive",
      concurrencySafe: operation.concurrencySafe === true,
      requiresApproval,
      approvalScope: requiresApproval ? operation.safety?.approvalScope || "operation:approve" : "",
      timeoutMs: operationTimeoutMs(operation),
      maxResultBytes: operation.binary ? 32 * 1024 * 1024 : 2 * 1024 * 1024,
      redactionPolicy: {
        input: "default",
        output: operation.audit?.recordOutput === true ? "default" : "summary"
      },
      auditPolicy: {
        enabled: true,
        recordInput: operation.audit?.recordInput !== false,
        recordOutput: operation.audit?.recordOutput === true
      },
      telemetryPolicy: {
        enabled: true
      },
      status: "active",
      queueStatus: operation.queueStatus || "",
      queueLabel: operation.queueLabel || "",
      taskType: operation.taskType || "",
      tags: uniqueStrings([
        operation.featureId || "",
        operation.feature,
        operation.binary ? "binary" : "",
        risk
      ])
    };
    tools.push(tool);
    for (const aliasId of TOOL_ALIAS_IDS_BY_OPERATION_ID[operation.id] || []) {
      tools.push({
        ...tool,
        id: aliasId,
        label: `${tool.label} (${aliasId})`,
        tags: uniqueStrings([...tool.tags, "alias"])
      });
    }
  }
  tools.push(
    ...createInternalToolDefinitions().filter((tool) =>
      !activeFeatureSet || activeFeatureSet.has(tool.featureId || "core-platform")
    )
  );
  const directories = projectActiveCatalogDirectories(
    tools,
    Array.isArray(profiles) ? profiles : [],
    { retainedToolsetIds: dynamicToolsetIds(activeFeatureSet) }
  );
  const catalog = {
    schemaVersion: "v0.0.1:schema:definition-1",
    generatedAt: new Date().toISOString(),
    scopes: directories.scopes,
    toolsets: directories.toolsets,
    toolGroups: summarizeToolGroups(tools, directories.toolsets),
    profiles: directories.profiles,
    tools
  };
  validateToolDefinitions(tools, operationsById, directories);
  return {
    ...catalog,
    fingerprint: fingerprint({
      scopes: directories.scopes.map((scope) => scope.id),
      toolsets: directories.toolsets.map((toolset) => ({
        id: toolset.id,
        requiredScopes: toolset.requiredScopes,
        maxRisk: toolset.maxRisk
      })),
      tools: tools.map((tool) => ({
        id: tool.id,
        version: tool.version,
        operationId: tool.operationId,
        toolsets: tool.toolsets,
        scopes: tool.requiredScopes,
        risk: tool.risk,
        inputSchema: tool.inputSchema || null,
        transport: tool.transport || null,
        lifecycle: tool.lifecycle || null,
        ownerKind: tool.ownerKind,
        ownerId: tool.ownerId,
        sourceRevision: tool.sourceRevision || 0,
        sourceDigest: tool.sourceDigest || "",
        dynamicCapability: tool.dynamicCapability || null
      }))
    })
  };
}

export function createToolCatalogRegistry({ operations = [], activeFeatureIds = null, profiles = [] } = {}) {
  let effectiveProfiles = profiles;
  let catalog = createToolCatalog({ operations, activeFeatureIds, profiles: effectiveProfiles });
  let toolsById = new Map(catalog.tools.map((tool) => [tool.id, tool]));
  let toolsByOperationId = new Map(catalog.tools.filter((tool) => tool.operationId).map((tool) => [tool.operationId, tool]));

  function refresh(nextOperations = operations, options = {}) {
    const nextProfiles = options.profiles || effectiveProfiles;
    const nextCatalog = createToolCatalog({ operations: nextOperations, activeFeatureIds, profiles: nextProfiles });
    const nextToolsById = new Map(nextCatalog.tools.map((tool) => [tool.id, tool]));
    const nextToolsByOperationId = new Map(nextCatalog.tools.filter((tool) => tool.operationId).map((tool) => [tool.operationId, tool]));
    operations = nextOperations;
    effectiveProfiles = nextProfiles;
    catalog = nextCatalog;
    toolsById = nextToolsById;
    toolsByOperationId = nextToolsByOperationId;
    return catalog;
  }

  function listTools(filters = {}) {
    return catalog.tools.filter((tool) => {
      if (filters.status && tool.status !== filters.status) {
        return false;
      }
      if (filters.toolset && !tool.toolsets.includes(filters.toolset)) {
        return false;
      }
      if (filters.scope && !tool.requiredScopes.includes(filters.scope)) {
        return false;
      }
      if (filters.risk && tool.risk !== filters.risk) {
        return false;
      }
      if (filters.owner && tool.owner !== filters.owner) {
        return false;
      }
      return true;
    });
  }

  function resolveToolset(input = {}) {
    const requestedToolsets = uniqueStrings(input.toolsets || input.toolsetIds || input.toolset || []);
    const requestedScopes = uniqueStrings(input.scopes || input.scopeIds || input.scope || []);
    const catalogToolsetsById = new Map(catalog.toolsets.map((toolset) => [toolset.id, toolset]));
    const scopeSelectedToolsets = catalog.toolsets
      .filter((toolset) => {
        const required = uniqueStrings(toolset.requiredScopes || []);
        return required.length > 0 && required.every((scope) => requestedScopes.includes(scope));
      })
      .map((toolset) => toolset.id);
    const requestedCombined = [...new Set([...requestedToolsets, ...scopeSelectedToolsets])]
      .filter((toolsetId) => catalogToolsetsById.has(toolsetId));
    const allow = new Set(uniqueStrings(input.toolAllow || []));
    const deny = new Set(uniqueStrings(input.toolDeny || []));
    const selected = new Set(requestedCombined);
    const tools = catalog.tools.filter((tool) => {
      if (deny.has(tool.id)) {
        return false;
      }
      if (allow.size > 0 && !allow.has(tool.id)) {
        return false;
      }
      return tool.toolsets.some((toolset) => selected.has(toolset));
    });
    const declaredMaxRisk = [...selected].reduce((max, toolsetId) => {
      const risk = catalogToolsetsById.get(toolsetId)?.maxRisk || "read_only";
      return riskRank(risk) > riskRank(max) ? risk : max;
    }, "read_only");
    return {
      toolsets: [...selected],
      tools,
      toolIds: tools.map((tool) => tool.id),
      requiredScopes: uniqueStrings([
        ...[...selected].flatMap((toolsetId) => catalogToolsetsById.get(toolsetId)?.requiredScopes || []),
        ...tools.flatMap((tool) => tool.requiredScopes)
      ]),
      maxRisk: tools.reduce((max, tool) => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max), declaredMaxRisk)
    };
  }

  return {
    refresh,
    getCatalog: () => catalog,
    listTools,
    getTool: (toolId) => toolsById.get(String(toolId || "")) || null,
    getToolByOperationId: (operationId) => toolsByOperationId.get(String(operationId || "")) || null,
    listScopes: () => catalog.scopes,
    listToolsets: () => catalog.toolsets,
    listProfiles: () => catalog.profiles,
    resolveToolset
  };
}
