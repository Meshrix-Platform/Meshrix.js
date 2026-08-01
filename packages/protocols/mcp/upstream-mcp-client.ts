import { createUpstreamMcpSessionManager } from "./upstream-mcp-session-manager.ts";

export {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_JSONRPC_VERSION,
  UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION
} from "./upstream-mcp-transport-common.ts";
export { createUpstreamMcpSessionManager } from "./upstream-mcp-session-manager.ts";

const defaultSessionManager: any = createUpstreamMcpSessionManager();

export async function listUpstreamMcpTools(config: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
  return defaultSessionManager.listTools(config, options);
}

export async function callUpstreamMcpTool(
  config: Record<string, any> = {},
  { name = "", arguments: toolArguments = {} }: Record<string, any> = {},
  options: Record<string, any> = {}
) : Promise<any> {
  return defaultSessionManager.callTool(config, {
    name,
    arguments: toolArguments
  }, options);
}

export async function closeDefaultUpstreamMcpSessions() : Promise<any> {
  await defaultSessionManager.close();
}
