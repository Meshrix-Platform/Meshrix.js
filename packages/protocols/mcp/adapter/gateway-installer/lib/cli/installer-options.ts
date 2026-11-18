import { MCP_SERVER_NAME as DEFAULT_NATIVE_SERVER_NAME } from "@meshrix/client-adapter-kit";
import { DEFAULT_TOKEN_ENV } from "./constants.ts";
import { normalizeBaseUrl, option } from "./basic-utils.ts";
import { explicitBaseUrl } from "./discovery.ts";
import { assertSafeEnvName } from "./connector-process.ts";
import { detectHostOs } from "./scan-local.ts";

export function installerOptions(options?: any) : any {
  const tokenEnv: any = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
  const serverName = String(option(options, "server-name", DEFAULT_NATIVE_SERVER_NAME));
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(serverName) || ["constructor", "prototype"].includes(serverName)) {
    throw new Error("Invalid MCP registration name. Use letters, digits, underscores or hyphens.");
  }
  return {
    hostOs: detectHostOs(),
    serverName,
    credentialRef: { kind: "env", name: tokenEnv },
    baseUrl: normalizeBaseUrl(option(options, "resolved-url", explicitBaseUrl(options))),
    tokenEnv,
    executionLocation: String(option(options, "execution-location", "local")),
    remoteKind: String(option(options, "remote-kind", "")),
    clientCommand: String(option(options, "client-command", "")).trim(),
    clientConfigPath: String(option(options, "client-config", "")).trim(),
    clientConfigRoot: String(option(options, "client-config-root", "")).trim()
  };
}

export function hasExplicitTarget(options?: any) : any {
  return Object.hasOwn(options, "target");
}

export function canUseInstallTui(options?: any) : any {
  return !hasExplicitTarget(options)
    && !options.json
    && process.stdin.isTTY
    && process.stdout.isTTY;
}

export function canUseUninstallTui(options?: any) : any {
  return canUseInstallTui(options);
}
