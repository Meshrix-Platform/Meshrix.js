import {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS
} from "./mcp-release-targets.ts";

export {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS
};

export const MCP_PROTOCOL_VERSION: any = "2025-06-18";
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
export const MCP_SERVER_VERSION: any = "0.0.1";
export const MCP_CONNECTOR_PACKAGE_NAME: any = "meshrix-mcp-connector";
export const MCP_CONNECTOR_VERSION: any = "0.0.1";
export const MCP_CONNECTOR_GITHUB_REPO: any = String(process.env.GITHUB_REPOSITORY || "");
export const MESHRIX_MCP_URL_ENV: any = "MESHRIX_MCP_URL";
export const MESHRIX_MCP_DISCOVERY_URL_ENV: any = "MESHRIX_MCP_DISCOVERY_URL";
export const MESHRIX_MCP_DISCOVERY_FILE_ENV: any = "MESHRIX_MCP_DISCOVERY_FILE";
export const MESHRIX_MCP_DISCOVERY_FILE: any = "~/.meshrix/mcp/servers.json";
export const MCP_BOOTSTRAP_INSTALL_SCRIPT: any = "meshrix-mcp-install.sh";
export const MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN: any = "meshrix-mcp-install.zh-CN.sh";
export const MCP_BOOTSTRAP_UNINSTALL_SCRIPT: any = "meshrix-mcp-uninstall.sh";
export const MCP_BOOTSTRAP_WINDOWS_INSTALL_SCRIPT: any = "meshrix-mcp-install.ps1";
export const MCP_BOOTSTRAP_WINDOWS_UNINSTALL_SCRIPT: any = "meshrix-mcp-uninstall.ps1";
