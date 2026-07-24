import {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS
} from "./mcp-release-targets.mjs";

export {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS
};

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MCP_LOCAL_AUTHORIZATION_MAX_BODY_BYTES = 128 * 1024;
export const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
export const MCP_TOOLSET_VERSION = "2026-05-25.1";
export const MCP_DISCOVERY_TOOL_NAME = "meshrix.discovery";
export const MCP_GATEWAY_TOOL_NAME = "meshrix.gateway";
export const MCP_STABLE_TOOL_NAME = MCP_DISCOVERY_TOOL_NAME;

export const CATEGORIZED_TOOL_NAMES = new Set([
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
]);

export const MCP_SERVER_NAME = "meshrix-mcp-server";
export const MCP_SERVER_VERSION = "0.0.1";
export const MCP_CONNECTOR_PACKAGE_NAME = "meshrix-mcp-connector";
export const MCP_CONNECTOR_VERSION = "0.0.1";
export const MCP_CONNECTOR_GITHUB_REPO = "LicoLand/Meshrix";
export const MESHRIX_MCP_URL_ENV = "MESHRIX_MCP_URL";
export const MESHRIX_MCP_DISCOVERY_URL_ENV = "MESHRIX_MCP_DISCOVERY_URL";
export const MESHRIX_MCP_DISCOVERY_FILE_ENV = "MESHRIX_MCP_DISCOVERY_FILE";
export const MESHRIX_MCP_DISCOVERY_FILE = "~/.meshrix/mcp/servers.json";
export const MCP_BOOTSTRAP_INSTALL_SCRIPT = "meshrix-mcp-install.sh";
export const MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN = "meshrix-mcp-install.zh-CN.sh";
export const MCP_BOOTSTRAP_UNINSTALL_SCRIPT = "meshrix-mcp-uninstall.sh";
export const MCP_BOOTSTRAP_WINDOWS_INSTALL_SCRIPT = "meshrix-mcp-install.ps1";
export const MCP_BOOTSTRAP_WINDOWS_UNINSTALL_SCRIPT = "meshrix-mcp-uninstall.ps1";
