const WORKSPACE_QUERY = Object.freeze([
  { name: "workspaceId", aliases: ["workspace-id", "workspaceId", "workspace"] }
]);
const SKILL_PARAMS = Object.freeze([
  { name: "skillId", aliases: ["skill-id", "skillId", "contribution-id", "contributionId", "id"], required: true }
]);
const RUN_PARAMS = Object.freeze([
  { name: "executionRef", aliases: ["execution-ref", "executionRef"], required: true }
]);

function inputSchema(required = []) {
  return {
    type: "object",
    additionalProperties: true,
    required,
    properties: {
      skillId: { type: "string" },
      workspaceId: { type: "string" },
      title: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
      declaredPermissions: { type: "array", items: { type: "string" } },
      reason: { type: "string" }
    }
  };
}

function submitInputSchema() {
  const schema = inputSchema([
    "title",
    "skillManifestRef",
    "license",
    "declaredPermissions",
    "packageBundleBase64"
  ]);
  return {
    ...schema,
    properties: {
      ...schema.properties,
      skillManifestRef: { type: "string", minLength: 1, maxLength: 1024 },
      license: { type: "string", minLength: 1, maxLength: 128 },
      packageBundleBase64: { type: "string", minLength: 4, maxLength: 1398104 }
    }
  };
}

function sandboxInputSchema({ statusOnly = false } = {}) {
  if (statusOnly) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["executionRef"],
      properties: { executionRef: { type: "string", minLength: 1, maxLength: 256 } }
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "skillId",
      "workspaceId",
      "outputs",
      "capabilities",
      "resources",
      "idempotencyKey",
      "deadlineAt"
    ],
    properties: {
      skillId: { type: "string", minLength: 1, maxLength: 256 },
      workspaceId: { type: "string", minLength: 1, maxLength: 256 },
      args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 4096 } },
      workingDirectory: { type: "string", maxLength: 512 },
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["schema", "maxFiles", "maxBytes", "allowedTypes"],
        properties: {
          schema: { type: "string", minLength: 1, maxLength: 256 },
          maxFiles: { type: "integer", minimum: 1 },
          maxBytes: { type: "integer", minimum: 1 },
          allowedTypes: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } }
        }
      },
      capabilities: {
        type: "object",
        additionalProperties: false,
        required: ["filesystem", "network", "tools", "secretRefs", "clock", "randomness", "subprocesses"],
        properties: {
          filesystem: { type: "array", maxItems: 16, items: { type: "string", maxLength: 128 } },
          network: { type: "array", maxItems: 32, items: { type: "string", maxLength: 256 } },
          tools: { type: "array", maxItems: 32, items: { type: "string", maxLength: 256 } },
          secretRefs: { type: "array", maxItems: 32, items: { type: "string", maxLength: 256 } },
          clock: { type: "boolean" },
          randomness: { type: "boolean" },
          subprocesses: { type: "integer", minimum: 0 }
        }
      },
      resources: {
        type: "object",
        additionalProperties: false,
        required: [
          "wallTimeMs",
          "cpuMillis",
          "memoryBytes",
          "processes",
          "fileDescriptors",
          "diskBytes",
          "inodes",
          "fileCount",
          "outputBytes",
          "logBytes",
          "networkBytes",
          "toolCalls"
        ],
        properties: Object.fromEntries([
          "wallTimeMs",
          "cpuMillis",
          "memoryBytes",
          "processes",
          "fileDescriptors",
          "diskBytes",
          "inodes",
          "fileCount",
          "outputBytes",
          "logBytes",
          "networkBytes",
          "toolCalls"
        ].map((name) => [name, { type: "integer", minimum: 1 }]))
      },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 512 },
      deadlineAt: { type: "string", minLength: 1, maxLength: 64 }
    }
  };
}

function skillHubResource(id, risk) {
  return Object.freeze({
    capabilityDomain: "skill_hub",
    resourceKind: "skill",
    capabilityVerb: id.split(".").at(-1).replace(/_/gu, "-"),
    effectKind: risk === "read_only" ? "read" : risk.replace(/_/gu, "-"),
    fieldMap: Object.freeze({})
  });
}

function definition({
  id,
  method = "POST",
  path,
  label,
  scopes,
  risk = "read_only",
  params = [],
  query = [],
  required = [],
  schema = undefined,
  audit = undefined,
  log = undefined
}) {
  const normalizedMethod = method.toUpperCase();
  const bodyBound = !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const command = id.split(".");
  return Object.freeze({
    id,
    feature: "skill_hub",
    featureId: "skill-hub",
    label,
    description: `Skill Hub operation for ${id}.`,
    target: { controller: "plugin", method: "execute" },
    http: { method: normalizedMethod, path, query, localInForwardMode: true },
    rpc: bodyBound
      ? { method: id, body: "params", params }
      : { method: id, params, query },
    cli: {
      command,
      usage: bodyBound ? `${command.join(" ")} --body request.json` : command.join(" ")
    },
    requiredScopes: scopes,
    toolsets: ["meshrix.agent.workspace"],
    readOnly: risk === "read_only",
    concurrencySafe: risk === "read_only",
    safety: {
      risk,
      requiresConfirmation: risk === "repair_write",
      approvalScope: risk === "repair_write" ? "workspace:maintain" : undefined
    },
    risk,
    aspects: ["skill-hub", "workspace-contribution", "mcp", "dispatch", "authorization", "safety", "audit", "operation-proof"],
    resource: skillHubResource(id, risk),
    resourceContext: skillHubResource(id, risk),
    proof: { binding: "proof-bound", lifecycle: "two-stage", substrate: "operation-proof-substrate" },
    inputSchema: schema || inputSchema(required),
    ...(audit ? { audit } : {}),
    ...(log ? { log } : {})
  });
}

export const SKILL_HUB_OPERATION_DEFINITIONS = Object.freeze([
  definition({ id: "skill_hub.search", method: "GET", path: "/api/skill-hub/v1/search", label: "Search Skill Hub", scopes: ["workspace:read"], query: [...WORKSPACE_QUERY, { name: "query", aliases: ["q", "search", "query"] }, { name: "limit", aliases: ["limit"] }] }),
  definition({ id: "skill_hub.list", method: "GET", path: "/api/skill-hub/v1/skills", label: "List Skill Hub skills", scopes: ["workspace:read"], query: WORKSPACE_QUERY }),
  definition({ id: "skill_hub.get", method: "GET", path: "/api/skill-hub/v1/skills/:skillId", label: "Read a Skill Hub skill", scopes: ["workspace:read"], params: SKILL_PARAMS, required: ["skillId"] }),
  definition({
    id: "skill_hub.submit",
    path: "/api/skill-hub/v1/skills",
    label: "Submit a Skill Hub skill",
    scopes: ["workspace:write"],
    risk: "safe_write",
    schema: submitInputSchema(),
    audit: { recordInput: false, recordOutput: false, metadataOnly: true },
    log: { recordInput: false, recordOutput: false, redaction: "strict" }
  }),
  definition({ id: "skill_hub.scan", path: "/api/skill-hub/v1/skills/:skillId/scan", label: "Scan a Skill Hub revision in the controlled sandbox", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, schema: sandboxInputSchema() }),
  definition({ id: "skill_hub.build", path: "/api/skill-hub/v1/skills/:skillId/build", label: "Build a Skill Hub revision in the controlled sandbox", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, schema: sandboxInputSchema() }),
  definition({ id: "skill_hub.execute", path: "/api/skill-hub/v1/skills/:skillId/execute", label: "Execute a Skill Hub revision in the controlled sandbox", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, schema: sandboxInputSchema() }),
  definition({ id: "skill_hub.execution.cancel", path: "/api/skill-hub/v1/executions/:executionRef/cancel", label: "Cancel a controlled Skill Hub execution", scopes: ["workspace:write"], risk: "safe_write", params: RUN_PARAMS, schema: sandboxInputSchema({ statusOnly: true }) }),
  definition({ id: "skill_hub.execution.status", method: "GET", path: "/api/skill-hub/v1/executions/:executionRef", label: "Read controlled Skill Hub execution status", scopes: ["workspace:read"], params: RUN_PARAMS, schema: sandboxInputSchema({ statusOnly: true }) }),
  definition({ id: "skill_hub.review", path: "/api/skill-hub/v1/skills/:skillId/review", label: "Review a Skill Hub skill", scopes: ["workspace:maintain"], risk: "safe_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.publish", path: "/api/skill-hub/v1/skills/:skillId/publish", label: "Publish a Skill Hub skill", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.download", method: "GET", path: "/api/skill-hub/v1/skills/:skillId/download", label: "Download a Skill Hub package reference", scopes: ["workspace:read"], params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.install", path: "/api/skill-hub/v1/skills/:skillId/install", label: "Install a Skill Hub skill", scopes: ["workspace:write"], risk: "safe_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.usage.record", path: "/api/skill-hub/v1/skills/:skillId/usage", label: "Record Skill Hub usage", scopes: ["workspace:write"], risk: "safe_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.revoke", path: "/api/skill-hub/v1/skills/:skillId/revoke", label: "Revoke a Skill Hub skill", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.rollback.record", path: "/api/skill-hub/v1/skills/:skillId/rollback", label: "Record a Skill Hub rollback", scopes: ["workspace:write"], risk: "safe_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.stats", method: "GET", path: "/api/skill-hub/v1/stats", label: "Read Skill Hub statistics", scopes: ["workspace:read"], query: WORKSPACE_QUERY }),
  definition({ id: "skill_hub.leaderboard", method: "GET", path: "/api/skill-hub/v1/leaderboard", label: "Read the Skill Hub leaderboard", scopes: ["workspace:read"], query: WORKSPACE_QUERY }),
  definition({ id: "skill_hub.permission.request", path: "/api/skill-hub/v1/skills/:skillId/permission/request", label: "Request Skill Hub permission", scopes: ["workspace:write"], risk: "safe_write", params: SKILL_PARAMS, required: ["skillId"] }),
  definition({ id: "skill_hub.permission.grant", path: "/api/skill-hub/v1/skills/:skillId/permission/grant", label: "Grant Skill Hub permission", scopes: ["workspace:maintain"], risk: "repair_write", params: SKILL_PARAMS, required: ["skillId"] })
]);

export const PLUGIN_OPERATION_DEFINITIONS = SKILL_HUB_OPERATION_DEFINITIONS;

export const PLUGIN_MCP_TOOL_BINDINGS = Object.freeze(Object.fromEntries(
  SKILL_HUB_OPERATION_DEFINITIONS.map((operation) => [
    operation.id.replace(/^skill_hub/u, "meshrix.skillHub"),
    Object.freeze({ operationId: operation.id, outlet: "meshrix.gateway" })
  ])
));

export const SKILL_HUB_OPERATIONS_BY_ID = Object.freeze(Object.fromEntries(
  SKILL_HUB_OPERATION_DEFINITIONS.map((operation) => [operation.id, operation])
));

export function skillHubRouteId(operationId) {
  return `${operationId}.http`;
}
