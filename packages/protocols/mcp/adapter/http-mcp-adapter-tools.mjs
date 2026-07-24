import {
  CATEGORIZED_TOOL_NAMES,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "./http-mcp-adapter-constants.mjs";
import { jsonRpcError } from "./http-mcp-adapter-response.mjs";

export const MCP_OUTLET_METADATA = Object.freeze({
  [MCP_DISCOVERY_TOOL_NAME]: { toolName: MCP_DISCOVERY_TOOL_NAME, architectureCategory: "Discovery" },
  [MCP_GATEWAY_TOOL_NAME]: { toolName: MCP_GATEWAY_TOOL_NAME, architectureCategory: "Gateway" }
});

const PLUGIN_MCP_OUTLET_PATTERN = /^meshrix\.[A-Za-z][A-Za-z0-9]*$/u;

export function mcpOutletMetadata(toolName = "", tool = {}) {
  const normalized = String(toolName || "").trim();
  const core = MCP_OUTLET_METADATA[normalized];
  if (core) return core;
  if (!PLUGIN_MCP_OUTLET_PATTERN.test(normalized)) {
    throw new Error(`Unsupported MCP outlet binding: ${normalized}.`);
  }
  const descriptor = tool.mcpOutletDescriptor || tool._meta?.mcpOutletDescriptor;
  if (
    !descriptor ||
    String(descriptor.toolName || "").trim() !== normalized ||
    !String(descriptor.title || "").trim() ||
    !String(descriptor.description || "").trim() ||
    !String(descriptor.architectureCategory || "").trim() ||
    typeof descriptor.annotations?.readOnlyHint !== "boolean" ||
    typeof descriptor.annotations?.destructiveHint !== "boolean"
  ) {
    throw new Error(`Plugin MCP outlet ${normalized} requires a validated outlet descriptor.`);
  }
  return descriptor;
}

export function mcpOutletForTool(tool = {}) {
  const explicitOutlet = String(tool.mcpOutlet || tool._meta?.mcpOutlet || "").trim();
  if (explicitOutlet) {
    return mcpOutletMetadata(explicitOutlet, tool);
  }
  const id = String(tool.operationId || tool.id || tool.name || "").trim();
  if (/^(operation_permission\.|gateway\.|external_services\.)/i.test(id)) {
    return MCP_OUTLET_METADATA[MCP_GATEWAY_TOOL_NAME];
  }
  return MCP_OUTLET_METADATA[MCP_DISCOVERY_TOOL_NAME];
}

export function mcpOutletSummary(operations = []) {
  const outlets = {
    [MCP_DISCOVERY_TOOL_NAME]: {
      ...MCP_OUTLET_METADATA[MCP_DISCOVERY_TOOL_NAME],
      operationCount: 0,
      operations: []
    }
  };
  for (const operation of operations) {
    const toolName = operation?._meta?.mcpOutlet || MCP_DISCOVERY_TOOL_NAME;
    const outlet = outlets[toolName] || (outlets[toolName] = {
      ...mcpOutletMetadata(toolName, operation),
      operationCount: 0,
      operations: []
    });
    outlet.operationCount += 1;
    outlet.operations.push(operation.name);
  }
  return outlets;
}

export function mcpCapabilityFamilies({ operations = [] } = {}) {
  return Object.fromEntries(Object.values(mcpOutletSummary(operations))
    .filter((outlet) => !CATEGORIZED_TOOL_NAMES.has(outlet.toolName) && outlet.operationCount > 0 && outlet.capabilityFamily)
    .map((outlet) => {
      const {
        canViewOperations = [],
        canOperateOperations = [],
        ...family
      } = outlet.capabilityFamily;
      const visibleOperations = [...outlet.operations];
      const visible = new Set(visibleOperations);
      const key = outlet.toolName.replace(/^meshrix\./u, "");
      return [key, {
        ...family,
        available: true,
        canView: canViewOperations.some((operation) => visible.has(operation)),
        canOperate: canOperateOperations.every((operation) => visible.has(operation)),
        visibleOperations
      }];
    }));
}

export function mcpToolForOperation({ operation = "", toolSkillManagementProvider, authorization = null } = {}) {
  const operationId = String(operation || "").trim();
  if (!operationId || typeof toolSkillManagementProvider?.listVisibleTools !== "function") {
    return null;
  }
  return toolSkillManagementProvider
    .listVisibleTools({ authorization })
    .find((tool) =>
      tool.id === operationId ||
        tool.operationId === operationId ||
        tool.name === operationId
    ) || null;
}

export function mcpOutletForOperation({ operation = "", toolSkillManagementProvider, authorization = null } = {}) {
  const operationId = String(operation || "").trim();
  if (operationId === "meshrix.mcp.version" || operationId === "meshrix.version" || operationId === "meshrix.capabilities.list") {
    return MCP_OUTLET_METADATA[MCP_DISCOVERY_TOOL_NAME];
  }
  const tool = mcpToolForOperation({ operation: operationId, toolSkillManagementProvider, authorization });
  return tool ? mcpOutletForTool(tool) : null;
}

export function operationOutletMismatchError({ id, operation, requestedTool, expectedOutlet }) {
  return {
    httpStatus: 200,
    body: jsonRpcError(id, -32602, `Operation ${operation} must be called through ${expectedOutlet.toolName}, not ${requestedTool}.`, {
      code: "operation_outlet_mismatch",
      operation,
      requestedTool,
      expectedTool: expectedOutlet.toolName,
      architectureCategory: expectedOutlet.architectureCategory,
      discoveryTool: MCP_DISCOVERY_TOOL_NAME,
      discoveryOperation: "meshrix.capabilities.list",
      stableToolName: MCP_STABLE_TOOL_NAME,
      example: {
        name: expectedOutlet.toolName,
        arguments: {
          apiVersion: MCP_INTERFACE_VERSION,
          operation,
          input: {}
        }
      }
    })
  };
}

export function publicMcpTool(tool) {
  const inputSchema = publicMcpInputSchema(tool.inputSchema || { type: "object" });
  const outlet = mcpOutletForTool(tool);
  const workspaceHint = schemaMentionsWorkspaceId(tool.inputSchema)
    ? " MCP clients should use workspaceRef, workspaceIndex, or workspaceName instead of internal workspaceId."
    : "";
  const scopeHint = (tool.requiredScopes || []).length > 0
    ? ` Requires scope: ${tool.requiredScopes.join(", ")}.`
    : "";
  const riskHint = tool.risk && tool.risk !== "read_only"
    ? ` Risk: ${tool.risk}.`
    : "";
  return {
    name: tool.id,
    title: tool.label || tool.id,
    description: `${tool.description || tool.label || tool.id}${scopeHint}${riskHint}${workspaceHint}`,
    inputSchema,
    annotations: {
      readOnlyHint: tool.readOnly !== false,
      destructiveHint: tool.destructive === true
    },
    _meta: {
      operationId: tool.operationId || tool.id,
      mcpOutlet: outlet.toolName,
      architectureCategory: outlet.architectureCategory,
      ...(MCP_OUTLET_METADATA[outlet.toolName] ? {} : { mcpOutletDescriptor: outlet }),
      ...(outlet.exchangeReceipt ? { exchangeReceipt: outlet.exchangeReceipt } : {}),
      toolsets: tool.toolsets || [],
      requiredScopes: tool.requiredScopes || [],
      risk: tool.risk || "read_only"
    }
  };
}

function schemaMentionsWorkspaceId(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(schemaMentionsWorkspaceId);
  }
  return Object.entries(value).some(([key, child]) =>
    /workspaceId$/i.test(key) || schemaMentionsWorkspaceId(child)
  );
}

function publicMcpInputSchema(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(publicMcpInputSchema);
  }
  const next = { ...value };
  if (Array.isArray(next.required)) {
    next.required = next.required.filter((item) => {
      const key = String(item || "");
      return !/workspaceId$/i.test(key) && !isLocalProcessSchemaKey(key);
    });
  }
  if (next.properties && typeof next.properties === "object" && !Array.isArray(next.properties)) {
    const properties = {};
    for (const [key, child] of Object.entries(next.properties)) {
      if (isLocalProcessSchemaKey(key)) {
        continue;
      }
      if (/workspaceId$/i.test(key)) {
        const refKey = key.replace(/Id$/i, "Ref");
        properties[refKey] = {
          type: "string",
          description: "Meshrix MCP workspace reference, for example 'workspace-1'. Discover it with operation 'meshrix.agentWorkspace.list'."
        };
        if (key === "workspaceId") {
          properties.workspaceIndex = {
            type: "integer",
            description: "Meshrix MCP workspace index from operation 'meshrix.agentWorkspace.list', for example 1."
          };
          properties["workspace-index"] = {
            type: "integer",
            description: "Alias for workspaceIndex. Meshrix MCP workspace index from operation 'meshrix.agentWorkspace.list', for example 1."
          };
          properties.workspaceName = {
            type: "string",
            description: "Workspace title/name from operation 'meshrix.agentWorkspace.list'."
          };
          properties["workspace-name"] = {
            type: "string",
            description: "Alias for workspaceName. Workspace title/name from operation 'meshrix.agentWorkspace.list'."
          };
        }
        continue;
      }
      properties[key] = publicMcpInputSchema(child);
    }
    next.properties = properties;
  }
  for (const key of ["items", "oneOf", "anyOf", "allOf"]) {
    if (next[key]) {
      next[key] = publicMcpInputSchema(next[key]);
    }
  }
  return next;
}

function isLocalProcessSchemaKey(key = "") {
  return [
    "args",
    "command",
    "cwd",
    "env",
    "executable",
    "stdioContract",
    "transport"
  ].includes(String(key || ""));
}

function executeToolPayload(result = {}) {
  return result.payload?.result !== undefined ? result.payload.result : result.payload;
}

export function meshrixCategorizedTools({ activeOutlets = CATEGORIZED_TOOL_NAMES, visibleTools = [] } = {}) {
  const enabledOutlets = new Set([
    MCP_DISCOVERY_TOOL_NAME,
    ...activeOutlets
  ]);
  const commonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      apiVersion: {
        type: "string",
        description: "Meshrix MCP interface version expected by the caller.",
        default: MCP_INTERFACE_VERSION,
        enum: [MCP_INTERFACE_VERSION]
      },
      operation: {
        type: "string",
        description: "Concrete Meshrix operation id to execute, for example 'operation_permission.catalog'. Do not use an outlet tool name itself here, such as 'meshrix.discovery' or 'meshrix.gateway'. If unsure, first call tool 'meshrix.discovery' with operation 'meshrix.capabilities.list' and then use one returned operations[].name value."
      },
      input: {
        type: "object",
        description: "Operation input payload.",
        additionalProperties: true,
        default: {}
      },
      subject: {
        type: "object",
        description: "Optional caller subject. If omitted, Meshrix injects the authenticated grant subject.",
        additionalProperties: true
      },
      operatorId: {
        type: "string",
        description: "External agent or operator id that initiated this intent."
      },
      agentProfileId: {
        type: "string",
        description: "Agent profile id used for policy, audit, and reply routing."
      },
      workspaceId: {
        type: "string",
        description: "Workspace id or public workspace reference targeted by this intent."
      },
      traceId: {
        type: "string",
        description: "Caller trace id. Meshrix generates one when omitted."
      },
      idempotencyKey: {
        type: "string",
        description: "Caller idempotency key. Meshrix generates one when omitted."
      },
      intent: {
        type: "string",
        description: "Human or agent intent label for audit and asynchronous replies."
      },
      dryRun: {
        type: "boolean",
        description: "Preview policy and execution effects without mutating state.",
        default: false
      },
      requestedScopes: {
        type: "array",
        description: "Optional scopes the caller believes are needed for this operation.",
        items: { type: "string" },
        default: []
      },
      clientVersion: {
        type: "string",
        description: "Optional client-side integration version for diagnostics."
      }
    }
  };

  const toolMeta = {
    interfaceVersion: MCP_INTERFACE_VERSION,
    toolsetVersion: MCP_TOOLSET_VERSION,
    stableTool: true,
    upgradeNotification: "notifications/tools/list_changed"
  };

  const coreTools = [
    {
      name: MCP_DISCOVERY_TOOL_NAME,
      title: "Meshrix Discovery",
      description: "Discovery outlet/router for capability discovery, tool descriptions, doctor checks, available commands, connection state, and gateway availability. Start here with operation='meshrix.capabilities.list', then use one returned operations[].name as the operation value for a Meshrix outlet.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ...toolMeta,
        architectureCategory: "Discovery"
      }
    },
    {
      name: MCP_GATEWAY_TOOL_NAME,
      title: "Meshrix Gateway",
      description: "Gateway outlet/router for upstream service registrations, toolsets, grants, policy preview, approval, audit, and governed forwarding operations. Do not call operation='meshrix.gateway'. First discover concrete operation ids by calling tool 'meshrix.discovery' with operation='meshrix.capabilities.list'.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: {
        ...toolMeta,
        architectureCategory: "Gateway"
      }
    }
  ];
  const metadataByOutlet = new Map();
  for (const tool of visibleTools) {
    const outlet = mcpOutletForTool(tool);
    if (!CATEGORIZED_TOOL_NAMES.has(outlet.toolName) && !metadataByOutlet.has(outlet.toolName)) {
      metadataByOutlet.set(outlet.toolName, outlet);
    }
  }
  const pluginTools = [...enabledOutlets]
    .filter((toolName) => !CATEGORIZED_TOOL_NAMES.has(toolName))
    .sort((left, right) => left.localeCompare(right))
    .map((toolName) => {
      const outlet = metadataByOutlet.get(toolName) || mcpOutletMetadata(toolName);
      return {
        name: outlet.toolName,
        title: outlet.title,
        description: outlet.description,
        inputSchema: commonSchema,
        annotations: outlet.annotations,
        _meta: {
          ...toolMeta,
          architectureCategory: outlet.architectureCategory,
          ...(outlet.exchangeReceipt ? { exchangeReceipt: outlet.exchangeReceipt } : {}),
          pluginContributed: true
        }
      };
    });
  return [...coreTools, ...pluginTools].filter((tool) => enabledOutlets.has(tool.name));
}
