export const DEFAULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({})
});

export function schema(required = [], properties = {}) {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties
  };
}

export function protocolOperation({
  id,
  feature,
  label,
  description = "",
  targetMethod,
  method = "POST",
  path = "",
  query = [],
  coerce = {},
  params = [],
  scopes = [],
  risk = "read_only",
  readOnly = undefined,
  requiresConfirmation = false,
  approvalScope = "",
  inputSchema = DEFAULT_SCHEMA,
  aliases = [],
  deprecated = false,
  replacementService = "",
  replacementOperationPrefix = "",
  lifecycle = {},
  aspects = []
}) {
  const command = id.split(".");
  const normalizedMethod = String(method || "POST").toUpperCase();
  const bodyBound = !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const httpPath = path || `/api/protocol/${command.join("/")}`;
  return {
    id,
    feature,
    label,
    description: description || `Protocol operation for ${id}.`,
    aliases,
    target: { controller: "system", method: targetMethod },
    http: { method: normalizedMethod, path: httpPath, query, coerce, localInForwardMode: true },
    rpc: bodyBound
      ? { method: id, body: "params", params }
      : { method: id, params, query },
    cli: {
      command,
      usage: bodyBound
        ? `${command.join(" ")} --body request.json`
        : `${command.join(" ")}`
    },
    requiredScopes: scopes,
    inputSchema,
    safety: {
      risk,
      requiresConfirmation,
      requiresConfirmationExplicit: true,
      approvalScope: approvalScope || (risk === "read_only" ? "" : scopes[0] || "maintenance:approve")
    },
    deprecated: deprecated === true,
    replacementService,
    replacementOperationPrefix,
    lifecycle,
    aspects,
    ...(readOnly === undefined ? {} : { readOnly })
  };
}

export const WORKSPACE_ID_QUERY = [
  { name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"] }
];

export const FILE_QUERY = [
  ...WORKSPACE_ID_QUERY,
  { name: "path", aliases: ["path", "filePath", "file-path"] },
  { name: "limit", aliases: ["limit"] },
  { name: "recursive", aliases: ["recursive"] }
];

export const WORKSPACE_ASSET_OPERATION_ASPECTS = Object.freeze([
  "workspace-asset-operation",
  "resource-operation",
  "mcp"
]);

export const ASSET_QUERY = [
  ...WORKSPACE_ID_QUERY,
  { name: "targetKind", aliases: ["target-kind", "targetKind", "kind"] },
  { name: "assetRef", aliases: ["asset-ref", "assetRef", "assetId", "asset-id"] },
  { name: "path", aliases: ["path", "filePath", "file-path"] },
  { name: "provider", aliases: ["provider"] },
  { name: "repoId", aliases: ["repo-id", "repoId"] },
  { name: "limit", aliases: ["limit"] }
];

export const ASSET_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string" },
    provider: { type: "string" },
    path: { type: "string" },
    repoId: { type: "string" },
    repositoryRef: { type: "string" },
    branch: { type: "string" }
  }
};

export const ASSET_CONTENT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    content: { type: "string" },
    contentBase64: { type: "string" },
    uploadSessionId: { type: "string" },
    payloadRefs: { type: "array" },
    diff: { type: "string" },
    files: { type: "array" }
  }
};

export const ASSET_OPERATION_SCHEMA = schema(["workspaceId"], {
  workspaceId: { type: "string" },
  semantic: { type: "string" },
  submitKind: { type: "string" },
  assetRef: { type: "string" },
  target: ASSET_TARGET_SCHEMA,
  content: ASSET_CONTENT_SCHEMA,
  policy: { type: "object" },
  source: { type: "object" },
  mutation: { type: "object" },
  review: { type: "object" },
  checkpoint: { type: "object" },
  receiptRef: { type: "string" },
  idempotencyKey: { type: "string" },
  dryRun: { type: "boolean" },
  overwrite: { type: "boolean" },
  confirm: { type: "boolean" }
});

export function workspaceAssetOperation(options = {}) {
  return protocolOperation({
    feature: "agent_workspace",
    aspects: WORKSPACE_ASSET_OPERATION_ASPECTS,
    ...options
  });
}
