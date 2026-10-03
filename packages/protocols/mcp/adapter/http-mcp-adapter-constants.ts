export const MCP_PROTOCOL_VERSION: any = "2026-07-28";
export const DEFAULT_TIMEOUT_MS: any = 300_000;
export const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
export const MCP_TOOLSET_VERSION: any = "2026-05-25.1";
export const MCP_DISCOVERY_TOOL_NAME: any = "meshrix.discovery";
export const MCP_GATEWAY_TOOL_NAME: any = "meshrix.gateway";
export const MCP_STABLE_TOOL_NAME: any = MCP_DISCOVERY_TOOL_NAME;

export const CATEGORIZED_TOOL_NAMES: any = new Set<any>([
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
]);

export const MCP_SERVER_NAME: any = "meshrix-mcp-server";
export const MCP_NPM_PACKAGE_NAME: any = "meshrix.js";
export const MCP_NPM_PACKAGE_VERSION: any = "0.0.1";
export const MCP_SERVER_VERSION: any = MCP_NPM_PACKAGE_VERSION;
export const MESHRIX_MCP_URL_ENV: any = "MESHRIX_MCP_URL";
export const MESHRIX_MCP_DISCOVERY_URL_ENV: any = "MESHRIX_MCP_DISCOVERY_URL";
export const MESHRIX_MCP_DISCOVERY_FILE_ENV: any = "MESHRIX_MCP_DISCOVERY_FILE";
export const MESHRIX_MCP_DISCOVERY_FILE: any = "~/.meshrix/mcp/servers.json";
