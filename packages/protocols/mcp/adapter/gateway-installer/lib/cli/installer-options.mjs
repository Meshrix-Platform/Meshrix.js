import path from "node:path";

import { DEFAULT_TOKEN_ENV } from "./constants.mjs";
import { normalizeBaseUrl, option } from "./basic-utils.mjs";
import { defaultClientAdapterCacheRoot } from "./client-adapter-runner.mjs";
import { explicitBaseUrl } from "./discovery.mjs";
import { assertSafeEnvName } from "./connector-process.mjs";
import { detectHostOs } from "./scan-local.mjs";

export function installerOptions(options) {
  const tokenEnv = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
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
      process.env.LICO_MCP_ADAPTER_CACHE || defaultClientAdapterCacheRoot()
    )))
  };
}

export function hasExplicitTarget(options) {
  return Object.hasOwn(options, "target");
}

export function canUseInstallTui(options) {
  return !hasExplicitTarget(options)
    && !options.json
    && process.stdin.isTTY
    && process.stdout.isTTY;
}

export function canUseUninstallTui(options) {
  return canUseInstallTui(options);
}
