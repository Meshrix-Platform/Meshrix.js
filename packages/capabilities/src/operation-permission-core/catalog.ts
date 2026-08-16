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
} from "./catalog-data.ts";

export {
  OPERATION_PERMISSION_API_PREFIX,
  OPERATION_PERMISSION_PROFILES,
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS
} from "./catalog-data.ts";

function riskRank(risk: any = "read_only") : any {
  return RISK_RANK[String(risk || "read_only")] ?? RISK_RANK.read_only;
}

function toolsetAllowsRisk(toolsetId?: any, risk: any = "read_only") : any {
  const declaredRisk: any = TOOLSET_BY_ID.get(toolsetId)?.maxRisk || "read_only";
  return riskRank(risk) <= riskRank(declaredRisk);
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

const DYNAMIC_TOOLSET_IDS_BY_FEATURE: Readonly<Record<string, any>> = Object.freeze({
  "upstream-gateway": Object.freeze([
    "meshrix.gateway.read",
    "meshrix.gateway.write",
    "meshrix.gateway.maintain"
  ])
});

function dynamicToolsetIds(activeFeatureSet: any = null) : any {
  if (!activeFeatureSet) return [];
  return uniqueStrings(
    [...activeFeatureSet].flatMap((featureId?: any) : any => DYNAMIC_TOOLSET_IDS_BY_FEATURE[featureId] || [])
  );
}


function fingerprint(value?: any) : any {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function operationScope(operation?: any) : any {
  return uniqueStrings(operation.requiredScopes || [])[0] || "";
}

function operationFeatureActive(operation: Record<string, any> = {}, activeFeatureSet: any = null) : any {
  if (!activeFeatureSet) {
    return true;
  }
  const featureId: any = String(operation.featureId || operationFeatureId(operation) || "core-platform").trim() || "core-platform";
  return activeFeatureSet.has(featureId);
}

function normalizeRisk(operation: Record<string, any> = {}) : any {
  if (operation.destructive) {
    return "destructive";
  }
  const risk: any = String(operation.safety?.risk || "").trim();
  if (risk && RISK_RANK[risk] !== undefined) {
    return risk;
  }
  return operation.readOnly === false ? "safe_write" : "read_only";
}

function operationTimeoutMs(operation: Record<string, any> = {}, fallback: any = 30_000) : any {
  const raw: any = operation.execution?.timeoutMs ??
    operation.target?.timeoutMs ??
    operation.safety?.timeoutMs ??
    operation.timeoutMs ??
    fallback;
  const value: any = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(100, Math.min(Math.trunc(value), 300_000));
}

function inferToolsets(operation?: any, scopes: any = [], toolId: any = "", risk: any = "read_only") : any {
  const toolsets: any = new Set<any>([
    ...uniqueStrings(operation.toolsets || []),
    ...scopes.map((scope?: any) : any => TOOLSET_BY_SCOPE[scope]).filter(Boolean)
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
  return [...toolsets].filter((toolsetId?: any) : any => !TOOLSET_BY_ID.has(toolsetId) || toolsetAllowsRisk(toolsetId, risk));
}

function normalizeHttpEndpoint(operation: Record<string, any> = {}) : any {
  const method: any = String(operation.http?.method || "POST").toUpperCase();
  const path: any = String(operation.http?.path || "");
  const query: any = Array.isArray(operation.http?.query) && operation.http.query.length
    ? `?${operation.http.query.map((item?: any) : any => `${item.name.toUpperCase()}=${item.name}`).join("&")}`
    : "";
  return { method, endpoint: `${path}${query}` };
}

function summarizeToolGroups(tools: any = [], toolsets: any = OPERATION_PERMISSION_TOOLSETS) : any {
  return toolsets
    .map((toolset?: any) : any => {
      const groupTools: any = tools.filter((tool?: any) : any => tool.toolsets?.includes(toolset.id));
      if (!groupTools.length) {
        return null;
      }
      const maxRisk: any = groupTools.reduce(
        (max?: any, tool?: any) : any => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max),
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
        activeToolCount: groupTools.filter((tool?: any) : any => tool.status === "active").length,
        internalToolCount: groupTools.filter((tool?: any) : any => tool.status === "internal").length,
        writeToolCount: groupTools.filter((tool?: any) : any => tool.readOnly === false).length,
        sampleToolIds: groupTools.slice(0, 6).map((tool?: any) : any => tool.id)
      };
    })
    .filter(Boolean)
    .sort((left?: any, right?: any) : any => {
      if (left.defaultForAgents !== right.defaultForAgents) {
        return left.defaultForAgents ? -1 : 1;
      }
      return String(left.label || "").localeCompare(String(right.label || ""));
    });
}

function projectActiveCatalogDirectories(tools: any = [], profiles: any = [], { retainedToolsetIds = [] }: Record<string, any> = {}) : any {
  const activeToolIds: any = new Set<any>(tools.map((tool?: any) : any => tool.id));
  const retainedToolsetIdSet: any = new Set<any>(uniqueStrings(retainedToolsetIds));
  const retainedScopeIds: any = OPERATION_PERMISSION_TOOLSETS
    .filter((toolset?: any) : any => retainedToolsetIdSet.has(toolset.id))
    .flatMap((toolset?: any) : any => toolset.requiredScopes || []);
  const activeScopeIds: any = new Set<any>([
    ...tools.flatMap((tool?: any) : any => tool.requiredScopes || []),
    ...retainedScopeIds
  ]);
  const directlyUsedToolsetIds: any = new Set<any>(tools.flatMap((tool?: any) : any => tool.toolsets || []));
  const requestedProfileToolsetIds: any = new Set<any>(
    profiles.flatMap((profile?: any) : any => uniqueStrings(profile?.toolsets || []))
  );
  const configuredToolsetIds: any = new Set<any>(OPERATION_PERMISSION_TOOLSETS.map((toolset?: any) : any => toolset.id));
  const pluginToolsets: any = [...directlyUsedToolsetIds]
    .filter((toolsetId?: any) : any => !configuredToolsetIds.has(toolsetId))
    .map((toolsetId?: any) : any => {
      const ownedTools: any = tools.filter((tool?: any) : any => tool.ownerKind === "plugin" && tool.toolsets.includes(toolsetId));
      if (ownedTools.length === 0) return null;
      return Object.freeze({
        id: toolsetId,
        label: toolsetId,
        description: "Plugin-owned toolset.",
        requiredScopes: Object.freeze(uniqueStrings(ownedTools.flatMap((tool?: any) : any => tool.requiredScopes || []))),
        defaultForAgents: false,
        grantable: true,
        maxRisk: ownedTools.reduce((highest?: any, tool?: any) : any => riskRank(tool.risk) > riskRank(highest) ? tool.risk : highest, "read_only")
      });
    }).filter(Boolean);
  const toolsets: any = [...OPERATION_PERMISSION_TOOLSETS, ...pluginToolsets]
    .filter((toolset?: any) : any => {
      if (directlyUsedToolsetIds.has(toolset.id)) return true;
      if (retainedToolsetIdSet.has(toolset.id)) return true;
      return requestedProfileToolsetIds.has(toolset.id) &&
        (toolset.requiredScopes || []).some((scope?: any) : any => activeScopeIds.has(scope));
    })
    .map((toolset?: any) : any => Object.freeze({
      ...toolset,
      requiredScopes: Object.freeze(
        uniqueStrings(toolset.requiredScopes || []).filter((scope?: any) : any => activeScopeIds.has(scope))
      )
    }));
  const activeToolsetIds: any = new Set<any>(toolsets.map((toolset?: any) : any => toolset.id));
  const configuredScopeIds: any = new Set<any>(OPERATION_PERMISSION_SCOPES.map((scope?: any) : any => scope.id));
  const scopes: any[] = [
    ...OPERATION_PERMISSION_SCOPES.filter((scope?: any) : any => activeScopeIds.has(scope.id)),
    ...[...activeScopeIds].filter((scopeId?: any) : any => !configuredScopeIds.has(scopeId)).map((scopeId?: any) : any => Object.freeze({
      id: scopeId,
      label: scopeId,
      description: "Plugin-owned operation scope."
    }))
  ];
  const projectedProfiles: any = profiles
    .map((profile?: any) : any => ({
      ...profile,
      toolsets: uniqueStrings(profile?.toolsets || []).filter((toolset?: any) : any => activeToolsetIds.has(toolset)),
      toolAllow: uniqueStrings(profile?.toolAllow || []).filter((toolId?: any) : any => activeToolIds.has(toolId)),
      toolDeny: uniqueStrings(profile?.toolDeny || []).filter((toolId?: any) : any => activeToolIds.has(toolId))
    }))
    .filter((profile?: any) : any => profile.toolsets.length > 0 || profile.toolAllow.length > 0);
  return {
    scopes: Object.freeze(scopes),
    toolsets: Object.freeze(toolsets),
    profiles: Object.freeze(projectedProfiles)
  };
}

function validateToolDefinitions(tools: any = [], operationsById: any = new Map<any, any>(), { scopes = [], toolsets = [] }: Record<string, any> = {}) : any {
  const ids: any = new Set<any>();
  const validScopes: any = new Set<any>(scopes.map((scope?: any) : any => scope.id));
  const validToolsets: any = new Set<any>(toolsets.map((toolset?: any) : any => toolset.id));
  const toolsetById: any = new Map<any, any>(toolsets.map((toolset?: any) : any => [toolset.id, toolset]));
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
    const unsafeToolsets: any = (tool.toolsets || []).filter((toolset?: any) : any => {
      const declaredRisk: any = toolsetById.get(toolset)?.maxRisk || "read_only";
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

export function scopesToToolsets(scopes: any = []) : any {
  return uniqueStrings(scopes.map((scope?: any) : any => TOOLSET_BY_SCOPE[scope]).filter(Boolean));
}

export function toolsetsToScopes(toolsets: any = []) : any {
  const selected: any = new Set<any>(toolsets);
  const scopes: any[] = [];
  for (const toolset of OPERATION_PERMISSION_TOOLSETS) {
    if (!selected.has(toolset.id)) {
      continue;
    }
    scopes.push(...(toolset.requiredScopes || []));
  }
  return uniqueStrings(scopes);
}


export function createToolCatalog({ operations = [], activeFeatureIds = null, profiles = [] }: Record<string, any> = {}) : any {
  const operationsById: any = new Map<any, any>(operations.map((operation?: any) : any => [operation.id, operation]));
  const activeFeatureSet: any = activeFeatureIds === null || activeFeatureIds === undefined
    ? null
    : new Set<any>(uniqueStrings(activeFeatureIds));
  const tools: any[] = [];
  for (const operation of operations) {
    if (!operationFeatureActive(operation, activeFeatureSet)) {
      continue;
    }
    const toolId: any = operation.toolId || TOOL_ID_BY_OPERATION_ID[operation.id];
    if (!toolId) {
      continue;
    }
    if (INTERNAL_OPERATION_IDS_HIDDEN_FROM_TOOL_CATALOG.has(operation.id)) {
      continue;
    }
    const operationScopes: any = uniqueStrings(operation.requiredScopes || []);
    const explicitScopes: any = operationScopes;
    const scope: any = operationScope(operation);
    const requiredScopes: any = explicitScopes.length
      ? explicitScopes
      : uniqueStrings([
          ...(scope ? [scope] : [])
        ]);
    const { method, endpoint } = normalizeHttpEndpoint(operation);
    const risk: any = normalizeRisk(operation);
    const requiresApproval: any = operation.destructive === true || risk === "destructive" || operation.safety?.requiresConfirmation === true;
    const pluginOwnerId: any = String(operation.pluginId || "").trim();
    const tool: Record<string, any> = {
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
      operationId: operation.id,
      trafficModel: operation.trafficModel,
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
      concurrency: operation.concurrency,
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
  const directories: any = projectActiveCatalogDirectories(
    tools,
    Array.isArray(profiles) ? profiles : [],
    {
      retainedToolsetIds: [
        ...dynamicToolsetIds(activeFeatureSet),
        "meshrix.uploads.write"
      ]
    }
  );
  const catalog: Record<string, any> = {
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
      scopes: directories.scopes.map((scope?: any) : any => scope.id),
      toolsets: directories.toolsets.map((toolset?: any) : any => ({
        id: toolset.id,
        requiredScopes: toolset.requiredScopes,
        maxRisk: toolset.maxRisk
      })),
      tools: tools.map((tool?: any) : any => ({
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

export function createToolCatalogRegistry({ operations = [], activeFeatureIds = null, profiles = [] }: Record<string, any> = {}) : any {
  let effectiveProfiles: any = profiles;
  let catalog: any = createToolCatalog({ operations, activeFeatureIds, profiles: effectiveProfiles });
  let toolsById: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.id, tool]));
  let toolsByOperationId: any = new Map<any, any>(catalog.tools.filter((tool?: any) : any => tool.operationId).map((tool?: any) : any => [tool.operationId, tool]));

  function refresh(nextOperations: any = operations, options: Record<string, any> = {}) : any {
    const nextProfiles: any = options.profiles || effectiveProfiles;
    const nextCatalog: any = createToolCatalog({ operations: nextOperations, activeFeatureIds, profiles: nextProfiles });
    const nextToolsById: any = new Map<any, any>(nextCatalog.tools.map((tool?: any) : any => [tool.id, tool]));
    const nextToolsByOperationId: any = new Map<any, any>(nextCatalog.tools.filter((tool?: any) : any => tool.operationId).map((tool?: any) : any => [tool.operationId, tool]));
    operations = nextOperations;
    effectiveProfiles = nextProfiles;
    catalog = nextCatalog;
    toolsById = nextToolsById;
    toolsByOperationId = nextToolsByOperationId;
    return catalog;
  }

  function listTools(filters: Record<string, any> = {}) : any {
    return catalog.tools.filter((tool?: any) : any => {
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

  function resolveToolset(input: Record<string, any> = {}) : any {
    const requestedToolsets: any = uniqueStrings(input.toolsets || input.toolsetIds || input.toolset || []);
    const requestedScopes: any = uniqueStrings(input.scopes || input.scopeIds || input.scope || []);
    const catalogToolsetsById: any = new Map<any, any>(catalog.toolsets.map((toolset?: any) : any => [toolset.id, toolset]));
    const scopeSelectedToolsets: any = catalog.toolsets
      .filter((toolset?: any) : any => {
        const required: any = uniqueStrings(toolset.requiredScopes || []);
        return required.length > 0 && required.every((scope?: any) : any => requestedScopes.includes(scope));
      })
      .map((toolset?: any) : any => toolset.id);
    const requestedCombined: any = [...new Set<any>([...requestedToolsets, ...scopeSelectedToolsets])]
      .filter((toolsetId?: any) : any => catalogToolsetsById.has(toolsetId));
    const allow: any = new Set<any>(uniqueStrings(input.toolAllow || []));
    const deny: any = new Set<any>(uniqueStrings(input.toolDeny || []));
    const selected: any = new Set<any>(requestedCombined);
    const tools: any = catalog.tools.filter((tool?: any) : any => {
      if (deny.has(tool.id)) {
        return false;
      }
      if (allow.size > 0 && !allow.has(tool.id)) {
        return false;
      }
      return tool.toolsets.some((toolset?: any) : any => selected.has(toolset));
    });
    const declaredMaxRisk: any = [...selected].reduce((max?: any, toolsetId?: any) : any => {
      const risk: any = catalogToolsetsById.get(toolsetId)?.maxRisk || "read_only";
      return riskRank(risk) > riskRank(max) ? risk : max;
    }, "read_only");
    return {
      toolsets: [...selected],
      tools,
      toolIds: tools.map((tool?: any) : any => tool.id),
      requiredScopes: uniqueStrings([
        ...[...selected].flatMap((toolsetId?: any) : any => catalogToolsetsById.get(toolsetId)?.requiredScopes || []),
        ...tools.flatMap((tool?: any) : any => tool.requiredScopes)
      ]),
      maxRisk: tools.reduce((max?: any, tool?: any) : any => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max), declaredMaxRisk)
    };
  }

  return {
    refresh,
    getCatalog: () : any => catalog,
    listTools,
    getTool: (toolId?: any) : any => toolsById.get(String(toolId || "")) || null,
    getToolByOperationId: (operationId?: any) : any => toolsByOperationId.get(String(operationId || "")) || null,
    listScopes: () : any => catalog.scopes,
    listToolsets: () : any => catalog.toolsets,
    listProfiles: () : any => catalog.profiles,
    resolveToolset
  };
}
