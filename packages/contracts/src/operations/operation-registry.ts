import {
  decorateServerApiOperations,
  serializableOperationSafety
} from "./operation-decorators.ts";
import { OPERATION_REGISTRY_GOVERNED_DEFINITIONS } from "./operation-registry-governed-definitions.ts";
import { AGENT_SESSION_OPERATION_DEFINITIONS } from "./agent-session-operation-definitions.ts";
import { CONTEXT_JOB_OPERATION_DEFINITIONS } from "./context-job-operation-definitions.ts";
import { IDENTITY_RUNTIME_OPERATION_DEFINITIONS } from "./identity-runtime-operation-definitions.ts";
import { PERMISSION_OBSERVABILITY_OPERATION_DEFINITIONS } from "./permission-observability-operation-definitions.ts";
import { PLATFORM_CONSOLE_OPERATION_DEFINITIONS } from "./platform-console-operation-definitions.ts";
import { STORAGE_WORKSPACE_OPERATION_DEFINITIONS } from "./storage-workspace-operation-definitions.ts";
import { STRATEGY_PERMISSION_OPERATION_DEFINITIONS } from "./strategy-permission-operation-definitions.ts";
import { WORKSPACE_CONTEXT_OPERATION_DEFINITIONS } from "./workspace-context-operation-definitions.ts";

const SERVER_API_OPERATION_DEFINITIONS: any[] = [
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
export const SERVER_API_OPERATIONS: any = decorateServerApiOperations(SERVER_API_OPERATION_DEFINITIONS);

export const SERVER_NON_OPERATION_API_CAPABILITIES: readonly any[] = Object.freeze([
  {
    operationId: "mcp.request",
    risk: "read_only",
    description: "Local MCP process-identity request capability; not exposed as an HTTP/RPC operation."
  }
]);

export function listInterfaceCatalog(operations: any = SERVER_API_OPERATIONS) : any {
  return operations.map((operation?: any) : any => ({
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
    aliases: (operation.cli?.aliases || []).map((tokens?: any) : any => tokens.join(" ")),
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
    concurrency: operation.concurrency,
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

function normalizeCliTokens(tokens?: any) : any {
  return (tokens || []).map((token?: any) : any => String(token || "").trim()).filter(Boolean);
}

export function getCliEntries(operation?: any) : any {
  const entries: any[] = [];
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

export function findCliOperation(tokens?: any, operations: any = SERVER_API_OPERATIONS) : any {
  const normalizedTokens: any = normalizeCliTokens(tokens);
  const entries: any = operations
    .flatMap(getCliEntries)
    .filter((entry?: any) : any => entry.tokens.length > 0)
    .sort((left?: any, right?: any) : any => right.tokens.length - left.tokens.length);

  return entries.find((entry?: any) : any =>
    entry.tokens.every((token?: any, index?: any) : any => normalizedTokens[index] === token)
  ) || null;
}

function getArgValue(args?: any, aliases?: any) : any {
  for (const alias of aliases || []) {
    const value: any = args[alias];
    if (Array.isArray(value)) {
      const last: any = value[value.length - 1];
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

function defaultParamAliases(name?: any) : any {
  const kebab: any = String(name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const aliases: any[] = [name, kebab];
  if (name.endsWith("Id")) {
    aliases.push("id");
  }
  return [...new Set<any>(aliases)];
}

export function buildApiPathForCliOperation(operation?: any, args?: any) : any {
  const pathParamAliases: any = operation.cli?.pathParams || {};
  const apiPath: any = operation.http.path.replace(/:([A-Za-z0-9_]+)/g, (_?: any, name?: any) : any => {
    const value: any = getArgValue(args, pathParamAliases[name] || defaultParamAliases(name));
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Operation ${operation.id}: --${defaultParamAliases(name)[1] || name} is required`
      );
    }
    return encodeURIComponent(String(value));
  });
  const query: any = new URLSearchParams();
  for (const queryParam of operation.http.query || []) {
    const value: any = getArgValue(args, queryParam.aliases || [queryParam.name]);
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
  const queryText: any = query.toString();
  return queryText ? `${apiPath}?${queryText}` : apiPath;
}

function escapeMarkdownCell(value?: any) : any {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function formatInterfaceCatalogMarkdown(operations: any = SERVER_API_OPERATIONS) : any {
  const rows: any = listInterfaceCatalog(operations);
  return [
    "| 功能ID | 功能层 | 功能目标 | HTTP接口 | RPC方法 | 命令行参数 | 风险 | 只读 | 并发安全 | 审计 | 权限 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row?: any) : any =>
      [
        row.id,
        row.feature,
        row.target,
        row.http,
        row.rpc,
        row.aliases.length > 0 ? `${row.cli}<br>alias: ${row.aliases.join(", ")}` : row.cli,
        `${row.safety.risk}${row.safety.dynamicRisk ? " (dynamic)" : ""}`,
        row.readOnly ? "yes" : "no",
        `${row.concurrency.workloadClass}:${row.concurrency.maxParallel}`,
        row.audit?.enabled === false ? "disabled" : (row.audit?.write ? "write" : "read"),
        row.requiredScopes.join(", ")
      ].map(escapeMarkdownCell).join(" | ")
    ).map((line?: any) : any => `| ${line} |`)
  ].join("\n");
}
