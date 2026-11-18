const WORKSPACE_PARAMS = Object.freeze([
  { name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }
]);

function sharedSpaceResource(id, risk) {
  const fileResource = /^sharedspace\.(?:file|item|directory)\./u.test(id);
  return Object.freeze({
    capabilityDomain: "shared_space",
    resourceKind: fileResource ? "file" : "shared_space",
    capabilityVerb: id.split(".").at(-1).replace(/_/gu, "-"),
    effectKind: risk === "read_only" ? "read" : risk.replace(/_/gu, "-"),
    fieldMap: Object.freeze({})
  });
}

function definition({ id, method = "POST", path, label, scopes, risk = "read_only", approvalScope = "", query = [], inputSchema = {} }) {
  const normalizedMethod = method.toUpperCase();
  const bodyBound = !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const command = id.split(".");
  return Object.freeze({
    id,
    feature: "shared_space",
    featureId: "local-sharedspace",
    label,
    description: `Shared Space operation for ${id}.`,
    target: { controller: "plugin", method: "execute" },
    http: { method: normalizedMethod, path, params: WORKSPACE_PARAMS, query, localInForwardMode: true },
    rpc: { method: id, body: "params", params: WORKSPACE_PARAMS },
    cli: {
      command,
      usage: bodyBound ? `${command.join(" ")} --workspace-id WORKSPACE_ID --body request.json` : `${command.join(" ")} --workspace-id WORKSPACE_ID`
    },
    requiredScopes: scopes,
    toolsets: ["meshrix.agent.workspace"],
    readOnly: risk === "read_only",
    concurrencySafe: risk === "read_only",
    safety: {
      risk,
      requiresConfirmation: risk === "repair_write" || risk === "destructive",
      ...(approvalScope ? { approvalScope } : {})
    },
    risk,
    aspects: ["shared-space", "workspace-asset", "mcp", "dispatch", "authorization", "safety", "audit", "operation-proof"],
    resource: sharedSpaceResource(id, risk),
    resourceContext: sharedSpaceResource(id, risk),
    proof: { binding: "proof-bound", lifecycle: "two-stage", substrate: "operation-proof-substrate" },
    inputSchema: {
      type: "object",
      required: ["workspaceId", ...(inputSchema.required || [])],
      additionalProperties: true,
      properties: {
        workspaceId: { type: "string" },
        mountRef: { type: "string" },
        path: { type: "string" },
        sourcePath: { type: "string" },
        targetPath: { type: "string" },
        content: { type: "string" },
        contentBase64: { type: "string" },
        recursive: { type: "boolean" },
        overwrite: { type: "boolean" },
        dryRun: { type: "boolean" },
        deleteExtraneous: { type: "boolean" },
        maxFiles: { type: "number" },
        ...inputSchema.properties
      }
    }
  });
}

function sandboxDefinition({ id, method = "POST", path, label, scopes, risk = "read_only", approvalScope = "", query = [], required = [], properties = {} }) {
  const operation = definition({ id, method, path, label, scopes, risk, approvalScope, query });
  return Object.freeze({
    ...operation,
    aspects: Object.freeze([...operation.aspects, "controlled-execution-sandbox", "immutable-input", "quarantined-output"]),
    inputSchema: Object.freeze({
      type: "object",
      required: Object.freeze(["workspaceId", ...required]),
      additionalProperties: false,
      properties: Object.freeze({ workspaceId: { type: "string" }, ...properties })
    })
  });
}

const RUN_REF = Object.freeze({ type: "string" });
const PROPOSAL_REF = Object.freeze({ type: "string" });
const DIGEST = Object.freeze({ type: "string", pattern: "^[a-f0-9]{64}$" });

export const SHARED_SPACE_OPERATION_DEFINITIONS = Object.freeze([
  definition({ id: "sharedspace.localDir.connect", path: "/api/agent-workspaces/:workspaceId/local-dir/connect", label: "Connect a controlled local directory", scopes: ["storage:write"], risk: "safe_write", inputSchema: { required: ["sourcePath"] } }),
  definition({ id: "sharedspace.localDir.list", method: "GET", path: "/api/agent-workspaces/:workspaceId/local-dir/mounts", label: "List controlled local directories", scopes: ["storage:read"] }),
  definition({ id: "sharedspace.item.list", method: "GET", path: "/api/agent-workspaces/:workspaceId/sharedspace/items", label: "List Shared Space items", scopes: ["storage:read"], query: [{ name: "mountRef", aliases: ["mount-ref", "mountId"] }, { name: "path", aliases: ["folderPath", "folder-path"] }, { name: "recursive" }, { name: "includeDirectories", aliases: ["include-directories"] }, { name: "includeFiles", aliases: ["include-files"] }, { name: "includeHash", aliases: ["include-hash"] }, { name: "limit" }] }),
  definition({ id: "sharedspace.item.stat", method: "GET", path: "/api/agent-workspaces/:workspaceId/sharedspace/items/stat", label: "Read Shared Space item metadata", scopes: ["storage:read"], query: [{ name: "mountRef", aliases: ["mount-ref", "mountId"] }, { name: "path", aliases: ["filePath", "file-path"] }, { name: "includeHash", aliases: ["include-hash"] }] }),
  definition({ id: "sharedspace.file.read", method: "GET", path: "/api/agent-workspaces/:workspaceId/sharedspace/files/read", label: "Read a Shared Space file", scopes: ["storage:read"], query: [{ name: "mountRef", aliases: ["mount-ref", "mountId"] }, { name: "path", aliases: ["filePath", "file-path"] }, { name: "includeText", aliases: ["include-text"] }, { name: "encoding" }] }),
  definition({ id: "sharedspace.file.write", path: "/api/agent-workspaces/:workspaceId/sharedspace/files/write", label: "Write a Shared Space file", scopes: ["storage:write"], risk: "safe_write", inputSchema: { required: ["path"] } }),
  definition({ id: "sharedspace.directory.create", path: "/api/agent-workspaces/:workspaceId/sharedspace/directories", label: "Create a Shared Space directory", scopes: ["storage:write"], risk: "safe_write", inputSchema: { required: ["path"] } }),
  definition({ id: "sharedspace.item.delete", method: "DELETE", path: "/api/agent-workspaces/:workspaceId/sharedspace/items", label: "Delete a Shared Space item", scopes: ["storage:write", "workspace:maintain"], risk: "repair_write", approvalScope: "workspace:maintain", inputSchema: { required: ["path"] } }),
  definition({ id: "sharedspace.item.move", path: "/api/agent-workspaces/:workspaceId/sharedspace/items/move", label: "Move a Shared Space item", scopes: ["storage:write"], risk: "safe_write", inputSchema: { required: ["sourcePath", "targetPath"] } }),
  definition({ id: "sharedspace.sync.plan", path: "/api/agent-workspaces/:workspaceId/local-dir/sync/plan", label: "Plan a Shared Space synchronization", scopes: ["storage:read"] }),
  definition({ id: "sharedspace.sync.apply", path: "/api/agent-workspaces/:workspaceId/local-dir/sync/apply", label: "Apply a Shared Space synchronization", scopes: ["storage:write"], risk: "safe_write" }),
  sandboxDefinition({
    id: "sharedspace.snapshot.create",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/snapshots",
    label: "Create an immutable Shared Space snapshot",
    scopes: ["storage:read"],
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" }, mountRef: { type: "string" } }
        }
      }
    }
  }),
  sandboxDefinition({
    id: "sharedspace.sandbox.input.seal",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/sandbox/opaque-inputs",
    label: "Seal a Shared Space sandbox input into opaque core custody",
    scopes: ["storage:write"],
    risk: "safe_write",
    required: ["contentBase64"],
    properties: {
      contentBase64: { type: "string", minLength: 4, maxLength: 357913944 }
    }
  }),
  sandboxDefinition({
    id: "sharedspace.sandbox.runOpaque",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/sandbox/opaque-runs",
    label: "Run a workload with explicitly promoted opaque Shared Space inputs",
    scopes: ["workspace:read", "storage:read"],
    risk: "safe_write",
    required: ["inputDigest", "promotionDigest", "opaqueInputs", "workloadKind", "workloadDigest", "runtimeKind", "entryPoint", "outputs", "capabilities", "resources", "idempotencyKey", "deadlineAt"],
    properties: {
      inputDigest: { type: "string" },
      promotionDigest: { type: "string" },
      opaqueInputs: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "custodyRef", "digest", "envelopeDigest"],
          properties: {
            path: { type: "string" },
            custodyRef: { type: "string" },
            digest: { type: "string" },
            envelopeDigest: { type: "string" }
          }
        }
      },
      workloadKind: { type: "string" }, workloadDigest: { type: "string" }, runtimeKind: { type: "string" }, entryPoint: { type: "string" },
      arguments: { type: "array", maxItems: 64, items: { type: "string" } }, workingDirectory: { type: "string" },
      capabilities: { type: "object" }, resources: { type: "object" }, outputs: { type: "object" },
      idempotencyKey: { type: "string" }, deadlineAt: { type: "string" }
    }
  }),
  sandboxDefinition({
    id: "sharedspace.sandbox.run",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/sandbox/runs",
    label: "Run a workload with an immutable Shared Space snapshot",
    scopes: ["workspace:read", "storage:read"],
    risk: "safe_write",
    required: ["snapshotHandle", "snapshotDigest", "workloadKind", "workloadDigest", "runtimeKind", "entryPoint", "outputs", "capabilities", "resources", "idempotencyKey", "deadlineAt"],
    properties: {
      snapshotHandle: { type: "string" },
      snapshotDigest: { type: "string" },
      workloadKind: { type: "string" },
      workloadDigest: { type: "string" },
      runtimeKind: { type: "string" },
      entryPoint: { type: "string" },
      arguments: { type: "array", maxItems: 64, items: { type: "string" } },
      workingDirectory: { type: "string" },
      capabilities: {
        type: "object",
        additionalProperties: false,
        required: ["filesystem", "network", "tools", "secretRefs", "clock", "randomness", "subprocesses"],
        properties: {
          filesystem: { type: "array", items: { type: "string" } }, network: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } }, secretRefs: { type: "array", items: { type: "string" } },
          clock: { type: "boolean" }, randomness: { type: "boolean" }, subprocesses: { type: "number" }
        }
      },
      resources: {
        type: "object",
        additionalProperties: false,
        required: ["wallTimeMs", "cpuMillis", "memoryBytes", "processes", "fileDescriptors", "diskBytes", "inodes", "fileCount", "outputBytes", "logBytes", "networkBytes", "toolCalls"],
        properties: Object.fromEntries(["wallTimeMs", "cpuMillis", "memoryBytes", "processes", "fileDescriptors", "diskBytes", "inodes", "fileCount", "outputBytes", "logBytes", "networkBytes", "toolCalls"].map((key) => [key, { type: "number" }]))
      },
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["schema", "maxFiles", "maxBytes", "allowedTypes"],
        properties: {
          schema: { type: "string" }, maxFiles: { type: "number" }, maxBytes: { type: "number" },
          allowedTypes: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } }
        }
      },
      idempotencyKey: { type: "string" }, deadlineAt: { type: "string" }
    }
  }),
  sandboxDefinition({
    id: "sharedspace.sandbox.cancel",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/sandbox/runs/cancel",
    label: "Cancel a Shared Space sandbox run",
    scopes: ["workspace:maintain"],
    risk: "safe_write",
    required: ["runRef"],
    properties: { runRef: RUN_REF, reason: { type: "string" } }
  }),
  sandboxDefinition({
    id: "sharedspace.sandbox.status",
    method: "GET",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/sandbox/runs/status",
    label: "Read a Shared Space sandbox run status",
    scopes: ["workspace:read"],
    query: [{ name: "runRef", aliases: ["run-ref"] }],
    required: ["runRef"],
    properties: { runRef: RUN_REF }
  }),
  sandboxDefinition({
    id: "sharedspace.output.preview",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/output-proposals/preview",
    label: "Preview quarantined Shared Space output",
    scopes: ["workspace:read"],
    required: ["runRef"],
    properties: { runRef: RUN_REF, proposalRef: PROPOSAL_REF, targetPath: { type: "string" } }
  }),
  sandboxDefinition({
    id: "sharedspace.output.approve",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/output-proposals/approve",
    label: "Approve a Shared Space output proposal",
    scopes: ["storage:write", "workspace:maintain"],
    risk: "repair_write",
    approvalScope: "workspace:maintain",
    required: ["proposalRef", "previewDigest", "outputDigest", "policyDigest"],
    properties: {
      proposalRef: PROPOSAL_REF,
      previewDigest: DIGEST,
      outputDigest: DIGEST,
      policyDigest: DIGEST
    }
  }),
  sandboxDefinition({
    id: "sharedspace.output.commit",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/output-proposals/commit",
    label: "Commit an approved Shared Space output proposal",
    scopes: ["storage:write", "workspace:maintain"],
    risk: "repair_write",
    approvalScope: "workspace:maintain",
    required: ["proposalRef", "previewDigest", "outputDigest", "policyDigest"],
    properties: {
      proposalRef: PROPOSAL_REF,
      previewDigest: DIGEST,
      outputDigest: DIGEST,
      policyDigest: DIGEST
    }
  }),
  sandboxDefinition({
    id: "sharedspace.output.reject",
    path: "/api/agent-workspaces/:workspaceId/sharedspace/output-proposals/reject",
    label: "Reject a Shared Space output proposal",
    scopes: ["workspace:maintain"],
    risk: "safe_write",
    required: ["proposalRef"],
    properties: { proposalRef: PROPOSAL_REF, reason: { type: "string" } }
  })
]);

export const PLUGIN_OPERATION_DEFINITIONS = SHARED_SPACE_OPERATION_DEFINITIONS;

export const PLUGIN_MCP_TOOL_BINDINGS = Object.freeze(Object.fromEntries(
  SHARED_SPACE_OPERATION_DEFINITIONS.map((operation) => [
    operation.id.replace(/^sharedspace/u, "meshrix.sharedspace"),
    Object.freeze({
      operationId: operation.id,
      outlet: SHARED_SPACE_MCP_OUTLET,
      outletDescriptor: SHARED_SPACE_MCP_OUTLET_DESCRIPTOR
    })
  ])
));

export function sharedSpaceRouteId(operationId) {
  return `${operationId}.http`;
}
import {
  SHARED_SPACE_MCP_OUTLET,
  SHARED_SPACE_MCP_OUTLET_DESCRIPTOR
} from "../runtime/shared-space-mcp.mjs";
