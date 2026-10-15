import { SERVER_API_OPERATIONS } from "../generated/operations.generated.ts";
import { serializableOperationSafety } from "./operation-safety-projection.ts";

export function listInterfaceCatalog(operations: readonly any[] = SERVER_API_OPERATIONS) : any[] {
  return operations.map((operation: any) => ({
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
    aliases: (operation.cli?.aliases || []).map((tokens: string[]) => tokens.join(" ")),
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
