import path from "node:path";

import { DEFAULT_TOKEN_ENV } from "./constants.ts";
import { normalizeBaseUrl, option } from "./basic-utils.ts";
import { defaultClientAdapterCacheRoot } from "./client-adapter-runner.ts";
import { explicitBaseUrl } from "./discovery.ts";
import { assertSafeEnvName } from "./connector-process.ts";
import { detectHostOs } from "./scan-local.ts";

export function installerOptions(options?: any) : any {
  const tokenEnv: any = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
  return {
    hostOs: detectHostOs(),
    baseUrl: normalizeBaseUrl(option(options, "resolved-url", explicitBaseUrl(options))),
    tokenEnv,
    executionLocation: String(option(options, "execution-location", "local")),
    remoteKind: String(option(options, "remote-kind", "")),
    clientCommand: String(option(options, "client-command", "")).trim(),
    adapterCacheRoot: path.resolve(String(option(
      options,
      "adapter-cache",
      process.env.MESHRIX_MCP_ADAPTER_CACHE || defaultClientAdapterCacheRoot()
    )))
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
