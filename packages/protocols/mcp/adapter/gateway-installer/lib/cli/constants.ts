import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS,
  MCP_SUPPORTED_TARGETS,
  MCP_TARGET_INSTALL_MODES,
  MCP_TARGET_LABELS,
  MCP_TARGET_LOCATIONS,
  mcpSupportedTargetDetails
} from "../../mcp-release-targets.ts";

async function readConnectorPackageJson(): Promise<any> {
  for (const relativePath of ["../../package.json", "../../../package.json"]) {
    try {
      const manifest: any = JSON.parse(
        await fs.readFile(new URL(relativePath, import.meta.url), "utf8")
      );
      if (manifest?.name === "meshrix-mcp-connector") return manifest;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const error: Error & Record<string, any> = new Error("Connector package manifest is unavailable.");
  error.code = "MCP_CONNECTOR_PACKAGE_MANIFEST_MISSING";
  throw error;
}

export const packageJson: any = await readConnectorPackageJson();

// Literal field names used in MCP gateway instrumentation.
export const MCP_OTEL_ATTRIBUTES: Readonly<Record<string, any>> = Object.freeze({
  "service.name": "meshrix-server",
  "service.version": "0.0.1",
  "mcp.method.name": null,
});

export const isChinese: any = (() : any => {
  const lang: any = String(process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "").toLowerCase();
  if (lang.includes("zh")) {
    return true;
  }
  try {
    if (os.platform() === "darwin") {
      const output: any = execSync("defaults read -g AppleLanguages 2>/dev/null", { encoding: "utf8" });
      if (output && /zh-/i.test(output)) {
        return true;
      }
    } else if (os.platform() === "win32") {
      const output: any = execSync("powershell -NoProfile -Command \"[System.Globalization.CultureInfo]::CurrentCulture.Name\" 2>$null", { encoding: "utf8" });
      if (output && /zh-/i.test(output)) {
        return true;
      }
    }
  } catch (error: any) {
    // Silently ignore command failures and fall back
  }
  return false;
})();

export function msg(en?: any, zh?: any) : any {
  return isChinese ? zh : en;
}

export const DEFAULT_TOKEN_ENV: any = "MESHRIX_MCP_TOKEN";
export const MCP_SERVER_NAME: any = "meshrix";
export const MCP_STABLE_TOOL_NAME: any = "meshrix.discovery";
export const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
export const BOOTSTRAP_INSTALL_SCRIPT: any = "meshrix-mcp-install.sh";
export const BOOTSTRAP_INSTALL_SCRIPT_ZH_CN: any = "meshrix-mcp-install.zh-CN.sh";
export const HTTP_TIMEOUT_MS: any = 300000;
export const SUPPORTED_TARGETS: any = MCP_SUPPORTED_TARGETS;
export const PRIORITY_INSTALL_TARGETS: any = MCP_PRIORITY_INSTALL_TARGETS;
export const PRIORITY_INSTALL_TARGET: any = MCP_PRIORITY_INSTALL_TARGET;
export const MESHRIX_MCP_URL_ENV: any = "MESHRIX_MCP_URL";
export const MESHRIX_MCP_DISCOVERY_URL_ENV: any = "MESHRIX_MCP_DISCOVERY_URL";
export const MESHRIX_MCP_DISCOVERY_FILE_ENV: any = "MESHRIX_MCP_DISCOVERY_FILE";
export const DEFAULT_DISCOVERY_REGISTRY: any = path.join(os.homedir(), ".meshrix", "mcp", "servers.json");
export const DEFAULT_SCAN_PORTS: any[] = [7228, 7229, 7230, 7231, 7232, 7233, 7234, 7235, 7236, 7237];
export const TARGET_ALIASES: any = new Map<any, any>([
  ["open-code", "opencode"]
]);
export const TARGET_LABELS: any = MCP_TARGET_LABELS;
export const TARGET_INSTALL_MODES: any = MCP_TARGET_INSTALL_MODES;
export const TARGET_LOCATIONS: any = MCP_TARGET_LOCATIONS;
export const SCAN_COMMAND_TIMEOUT_MS: any = 3000;
export const REMOTE_SCAN_COMMAND_TIMEOUT_MS: any = 8000;
export const INSTALL_COMMAND_TIMEOUT_MS: any = positiveIntegerEnv("MESHRIX_MCP_INSTALL_COMMAND_TIMEOUT_MS", 120000);
export const PACKAGE_MANAGER_DISCOVERY_ENV: Readonly<Record<string, any>> = Object.freeze({
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  HOMEBREW_NO_ENV_HINTS: "1"
});
export const HOST_PLATFORM: Readonly<Record<string, any>> = Object.freeze({
  MACOS: "darwin",
  LINUX: "linux",
  WINDOWS: "win32"
});
export const PACKAGE_SOURCE_KIND: Readonly<Record<string, any>> = Object.freeze({
  STATIC_DIRS: "static-dirs",
  COMMAND_DIR: "command-dir",
  VERSIONED_DIRS: "versioned-dirs",
  COMMAND_PATHS: "command-paths",
  COMMAND_PREFIX_DIRS: "command-prefix-dirs"
});
export function supportedTargetDetails() : any {
  return mcpSupportedTargetDetails();
}

export function sharedHubContract({ mcpUrl = "", vmMcpUrl = "" }: Record<string, any> = {}) : any {
  return {
    canonicalMcpUrl: mcpUrl,
    vmMcpUrl,
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

export function positiveIntegerEnv(name?: any, fallback?: any) : any {
  const value: any = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
