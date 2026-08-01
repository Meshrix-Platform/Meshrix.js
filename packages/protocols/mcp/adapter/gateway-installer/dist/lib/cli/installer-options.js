import path from "node:path";
import { DEFAULT_TOKEN_ENV } from "./constants.js";
import { normalizeBaseUrl, option } from "./basic-utils.js";
import { defaultClientAdapterCacheRoot } from "./client-adapter-runner.js";
import { explicitBaseUrl } from "./discovery.js";
import { assertSafeEnvName } from "./connector-process.js";
import { detectHostOs } from "./scan-local.js";
export function installerOptions(options) {
    const tokenEnv = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
    return {
        hostOs: detectHostOs(),
        baseUrl: normalizeBaseUrl(option(options, "resolved-url", explicitBaseUrl(options))),
        tokenEnv,
        executionLocation: String(option(options, "execution-location", "local")),
        remoteKind: String(option(options, "remote-kind", "")),
        clientCommand: String(option(options, "client-command", "")).trim(),
        adapterCacheRoot: path.resolve(String(option(options, "adapter-cache", process.env.MESHRIX_MCP_ADAPTER_CACHE || defaultClientAdapterCacheRoot())))
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
//# sourceMappingURL=installer-options.js.map