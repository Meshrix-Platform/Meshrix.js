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
} from "../../mcp-release-targets.mjs";

export const packageJson = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));

// Literal field names used in MCP gateway instrumentation.
export const MCP_OTEL_ATTRIBUTES = Object.freeze({
  "service.name": "licomesh-server",
  "service.version": "0.0.1",
  "mcp.method.name": null,
});

export const isChinese = (() => {
  const lang = String(process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "").toLowerCase();
  if (lang.includes("zh")) {
    return true;
  }
  try {
    if (os.platform() === "darwin") {
      const output = execSync("defaults read -g AppleLanguages 2>/dev/null", { encoding: "utf8" });
      if (output && /zh-/i.test(output)) {
        return true;
      }
    } else if (os.platform() === "win32") {
      const output = execSync("powershell -NoProfile -Command \"[System.Globalization.CultureInfo]::CurrentCulture.Name\" 2>$null", { encoding: "utf8" });
      if (output && /zh-/i.test(output)) {
        return true;
      }
    }
  } catch (error) {
    // Silently ignore command failures and fall back
  }
  return false;
})();

export function msg(en, zh) {
  return isChinese ? zh : en;
}

export const DEFAULT_TOKEN_ENV = "LICO_MCP_TOKEN";
export const MCP_SERVER_NAME = "lico";
export const MCP_STABLE_TOOL_NAME = "lico.discovery";
export const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
export const BOOTSTRAP_INSTALL_SCRIPT = "lico-mcp-install.sh";
export const BOOTSTRAP_INSTALL_SCRIPT_ZH_CN = "lico-mcp-install.zh-CN.sh";
export const HTTP_TIMEOUT_MS = 300000;
export const SUPPORTED_TARGETS = MCP_SUPPORTED_TARGETS;
export const PRIORITY_INSTALL_TARGETS = MCP_PRIORITY_INSTALL_TARGETS;
export const PRIORITY_INSTALL_TARGET = MCP_PRIORITY_INSTALL_TARGET;
export const LICO_MCP_URL_ENV = "LICO_MCP_URL";
export const LICO_MCP_DISCOVERY_URL_ENV = "LICO_MCP_DISCOVERY_URL";
export const LICO_MCP_DISCOVERY_FILE_ENV = "LICO_MCP_DISCOVERY_FILE";
export const DEFAULT_DISCOVERY_REGISTRY = path.join(os.homedir(), ".lico", "mcp", "servers.json");
export const PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION = "LICO-PROCESS-IDENTITY-V1";
export const CLIENT_FINGERPRINT_VERSION = "v0.0.1:client:fingerprint-1";
export const DEFAULT_SCAN_PORTS = [7228, 7229, 7230, 7231, 7232, 7233, 7234, 7235, 7236, 7237];
export const TARGET_ALIASES = new Map([
  ["open-code", "opencode"]
]);
export const TARGET_LABELS = MCP_TARGET_LABELS;
export const TARGET_INSTALL_MODES = MCP_TARGET_INSTALL_MODES;
export const TARGET_LOCATIONS = MCP_TARGET_LOCATIONS;
export const SCAN_COMMAND_TIMEOUT_MS = 3000;
export const REMOTE_SCAN_COMMAND_TIMEOUT_MS = 8000;
export const INSTALL_COMMAND_TIMEOUT_MS = positiveIntegerEnv("LICO_MCP_INSTALL_COMMAND_TIMEOUT_MS", 120000);
export const PACKAGE_MANAGER_DISCOVERY_ENV = Object.freeze({
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  HOMEBREW_NO_ENV_HINTS: "1"
});
export const HOST_PLATFORM = Object.freeze({
  MACOS: "darwin",
  LINUX: "linux",
  WINDOWS: "win32"
});
export const PACKAGE_SOURCE_KIND = Object.freeze({
  STATIC_DIRS: "static-dirs",
  COMMAND_DIR: "command-dir",
  VERSIONED_DIRS: "versioned-dirs",
  COMMAND_PATHS: "command-paths",
  COMMAND_PREFIX_DIRS: "command-prefix-dirs"
});
export function supportedTargetDetails() {
  return mcpSupportedTargetDetails();
}

export function sharedHubContract({ mcpUrl = "", vmMcpUrl = "" } = {}) {
  return {
    canonicalMcpUrl: mcpUrl,
    vmMcpUrl,
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

export function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
