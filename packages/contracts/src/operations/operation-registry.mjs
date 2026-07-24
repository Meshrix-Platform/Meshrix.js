import {
  decorateServerApiOperations,
  serializableOperationSafety
} from "./operation-decorators.mjs";
import { OPERATION_REGISTRY_GOVERNED_DEFINITIONS } from "./operation-registry-governed-definitions.mjs";
import { AGENT_SESSION_OPERATION_DEFINITIONS } from "./agent-session-operation-definitions.mjs";
import { CONTEXT_JOB_OPERATION_DEFINITIONS } from "./context-job-operation-definitions.mjs";
import { IDENTITY_RUNTIME_OPERATION_DEFINITIONS } from "./identity-runtime-operation-definitions.mjs";
import { PERMISSION_OBSERVABILITY_OPERATION_DEFINITIONS } from "./permission-observability-operation-definitions.mjs";
import { PLATFORM_CONSOLE_OPERATION_DEFINITIONS } from "./platform-console-operation-definitions.mjs";
import { STORAGE_WORKSPACE_OPERATION_DEFINITIONS } from "./storage-workspace-operation-definitions.mjs";
import { STRATEGY_PERMISSION_OPERATION_DEFINITIONS } from "./strategy-permission-operation-definitions.mjs";
import { WORKSPACE_CONTEXT_OPERATION_DEFINITIONS } from "./workspace-context-operation-definitions.mjs";

const SERVER_API_OPERATION_DEFINITIONS = [
  ...OPERATION_REGISTRY_GOVERNED_DEFINITIONS,
  ...PLATFORM_CONSOLE_OPERATION_DEFINITIONS,
  ...IDENTITY_RUNTIME_OPERATION_DEFINITIONS,
  ...STRATEGY_PERMISSION_OPERATION_DEFINITIONS,
  ...PERMISSION_OBSERVABILITY_OPERATION_DEFINITIONS,
  ...STORAGE_WORKSPACE_OPERATION_DEFINITIONS,
  ...AGENT_SESSION_OPERATION_DEFINITIONS,
  ...WORKSPACE_CONTEXT_OPERATION_DEFINITIONS,
  ...CONTEXT_JOB_OPERATION_DEFINITIONS
];
export const SERVER_API_OPERATIONS = decorateServerApiOperations(SERVER_API_OPERATION_DEFINITIONS);

export const SERVER_NON_OPERATION_API_CAPABILITIES = Object.freeze([
  {
    operationId: "mcp.request",
    risk: "read_only",
    description: "Local MCP process-identity request capability; not exposed as an HTTP/RPC operation."
  }
]);

export function listInterfaceCatalog(operations = SERVER_API_OPERATIONS) {
  return operations.map((operation) => ({
    id: operation.id,
    feature: operation.feature,
    label: operation.label,
    description: operation.description || operation.label || operation.id,
    target: `${operation.target.controller}.${operation.target.method}`,
    targetBinding: operation.target,
    http: `${operation.http.method} ${operation.http.path}`,
    httpBinding: operation.http,
    httpHeaderContract: operation.http?.headerContract || null,
    httpResponseContract: operation.http?.responseContract || null,
    rpc: operation.rpc?.method || "",
    rpcBinding: operation.rpc || null,
    cli: operation.cli?.usage || "",
    cliBinding: operation.cli || null,
    aliases: (operation.cli?.aliases || []).map((tokens) => tokens.join(" ")),
    localInForwardMode: Boolean(operation.http.localInForwardMode),
    binary: Boolean(operation.binary),
    aspects: operation.aspects || [],
    safety: serializableOperationSafety(operation),
    requiredScopes: operation.requiredScopes || [],
    readOnly: operation.readOnly === true,
    destructive: operation.destructive === true,
    public: operation.public === true,
    externalAuth: operation.externalAuth === true,
    processIdentity: operation.processIdentity || null,
    concurrencySafe: operation.concurrencySafe === true,
    audit: operation.audit || {},
    log: operation.log || {},
    deprecated: operation.deprecated === true,
    replacementService: operation.replacementService || "",
    replacementOperationPrefix: operation.replacementOperationPrefix || "",
    lifecycle: operation.lifecycle || {},
    queueStatus: operation.queueStatus || "",
    queueLabel: operation.queueLabel || "",
    taskType: operation.taskType || "",
    inputSchema: operation.inputSchema || {}
  }));
}

function normalizeCliTokens(tokens) {
  return (tokens || []).map((token) => String(token || "").trim()).filter(Boolean);
}

export function getCliEntries(operation) {
  const entries = [];
  if (operation.cli?.command) {
    entries.push({
      operation,
      tokens: normalizeCliTokens(operation.cli.command)
    });
  }
  for (const alias of operation.cli?.aliases || []) {
    entries.push({
      operation,
      tokens: normalizeCliTokens(alias)
    });
  }
  return entries;
}

export function findCliOperation(tokens, operations = SERVER_API_OPERATIONS) {
  const normalizedTokens = normalizeCliTokens(tokens);
  const entries = operations
    .flatMap(getCliEntries)
    .filter((entry) => entry.tokens.length > 0)
    .sort((left, right) => right.tokens.length - left.tokens.length);

  return entries.find((entry) =>
    entry.tokens.every((token, index) => normalizedTokens[index] === token)
  ) || null;
}

function getArgValue(args, aliases) {
  for (const alias of aliases || []) {
    const value = args[alias];
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      if (last !== undefined && last !== true && last !== "") {
        return last;
      }
      continue;
    }
    if (value !== undefined && value !== true && value !== "") {
      return value;
    }
  }
  return undefined;
}

function defaultParamAliases(name) {
  const kebab = String(name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const aliases = [name, kebab];
  if (name.endsWith("Id")) {
    aliases.push("id");
  }
  return [...new Set(aliases)];
}

export function buildApiPathForCliOperation(operation, args) {
  const pathParamAliases = operation.cli?.pathParams || {};
  const apiPath = operation.http.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const value = getArgValue(args, pathParamAliases[name] || defaultParamAliases(name));
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Operation ${operation.id}: --${defaultParamAliases(name)[1] || name} is required`
      );
    }
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams();
  for (const queryParam of operation.http.query || []) {
    const value = getArgValue(args, queryParam.aliases || [queryParam.name]);
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(queryParam.name, String(item));
      }
      continue;
    }
    query.set(queryParam.name, String(value));
  }
  const queryText = query.toString();
  return queryText ? `${apiPath}?${queryText}` : apiPath;
}

function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function formatInterfaceCatalogMarkdown(operations = SERVER_API_OPERATIONS) {
  const rows = listInterfaceCatalog(operations);
  return [
    "| 功能ID | 功能层 | 功能目标 | HTTP接口 | RPC方法 | 命令行参数 | 风险 | 只读 | 并发安全 | 审计 | 权限 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      [
        row.id,
        row.feature,
        row.target,
        row.http,
        row.rpc,
        row.aliases.length > 0 ? `${row.cli}<br>alias: ${row.aliases.join(", ")}` : row.cli,
        `${row.safety.risk}${row.safety.dynamicRisk ? " (dynamic)" : ""}`,
        row.readOnly ? "yes" : "no",
        row.concurrencySafe ? "yes" : "no",
        row.audit?.enabled === false ? "disabled" : (row.audit?.write ? "write" : "read"),
        row.requiredScopes.join(", ")
      ].map(escapeMarkdownCell).join(" | ")
    ).map((line) => `| ${line} |`)
  ].join("\n");
}
