import { createUpstreamMcpSessionManager } from "./upstream-mcp-session-manager.mjs";

export {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_JSONRPC_VERSION,
  UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION
} from "./upstream-mcp-transport-common.mjs";
export { createUpstreamMcpSessionManager } from "./upstream-mcp-session-manager.mjs";

const defaultSessionManager = createUpstreamMcpSessionManager();

export async function listUpstreamMcpTools(config = {}, options = {}) {
  return defaultSessionManager.listTools(config, options);
}

export async function callUpstreamMcpTool(
  config = {},
  { name = "", arguments: toolArguments = {} } = {},
  options = {}
) {
  return defaultSessionManager.callTool(config, {
    name,
    arguments: toolArguments
  }, options);
}

export async function closeDefaultUpstreamMcpSessions() {
  await defaultSessionManager.close();
}
