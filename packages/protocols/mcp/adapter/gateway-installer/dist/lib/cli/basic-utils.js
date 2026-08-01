import { SUPPORTED_TARGETS, TARGET_ALIASES, TARGET_INSTALL_MODES, TARGET_LABELS } from "./constants.js";
export function usage() {
    const priorityTargets = SUPPORTED_TARGETS.join(",");
    return [
        "Usage:",
        "  meshrix-mcp register",
        "  meshrix-mcp install",
        "  meshrix-mcp install --target auto",
        `  meshrix-mcp install --target ${priorityTargets}`,
        "  meshrix-mcp uninstall",
        `  meshrix-mcp uninstall --target ${priorityTargets}`,
        "  meshrix-mcp scan --json",
        "  meshrix-mcp discover-local --json",
        "  meshrix-mcp doctor",
        "  meshrix-mcp proxy --target opencode",
        "  meshrix-mcp fetch --artifact <url-or-id> --out <path> --target opencode",
        "  meshrix-mcp discover",
        "  meshrix-mcp server-config --set --url http://host:port --name local",
        "  meshrix-mcp server-config --switch local",
        "  meshrix-mcp server-config --refresh",
        "  meshrix-mcp server-config --reset",
        "",
        "Options:",
        "  --target LIST                 Comma-separated targets for non-interactive install. Use auto for detected clients.",
        `                                Supported targets: ${SUPPORTED_TARGETS.join(", ")}.`,
        "  --url URL                     Explicit Meshrix base URL. Still requires signed MCP handshake.",
        "  --scan-ports LIST            Local ports to scan when --url is omitted. Default: 7228-7237.",
        "  --token-stdin                 Read token from stdin.",
        "  --token-env NAME              Token environment variable. Default: MESHRIX_MCP_TOKEN.",
        "  --no-auto-token               Require an explicit token instead of requesting a local grant.",
        "  --no-verify                   Skip post-install MCP HTTP verification.",
        "  --json                        Emit JSON.",
        "  --pretty                      Pretty-print JSON output.",
        "  --no-env                      Do not publish launchctl environment variables during register.",
        "  --discovery-file PATH         Registry file used by register/discover-local. Default: ~/.meshrix/mcp/servers.json.",
        "  --auto-update                 Enable automatic push updates when installing (non-interactive mode).",
        "  --client-command COMMAND      Explicit local client command or path for one selected target.",
        "  --adapter-cache PATH          Verified external adapter cache. Default: ~/.meshrix/mcp/client-adapters.",
        "  --artifact URL_OR_ID          Gateway artifact URL or id downloaded by fetch.",
        "  --out PATH                    Output file written by fetch. Must not already exist.",
        "  --toolsets LIST               Explicit grant toolsets requested during device authorization.",
        "                                Default: server read-only toolsets (no widening without this flag).",
        "  --scopes LIST                 Explicit grant scopes requested during device authorization.",
        "  --max-risk VALUE              Grant risk acknowledgment: read_only, safe_write, repair_write, destructive.",
        "  --upstream-capability LIST    cap:upstream:<service>:<operation> capabilities requested for the grant.",
        "  --allowed-service LIST        Upstream service ids the grant may use.",
        "",
        "Interactive install:",
        "  When --target is omitted in a TTY, install opens a multi-select menu.",
        "  Use Up/Down or j/k to move, Space to toggle, a to toggle detected clients, Enter to install.",
        "",
        "Interactive uninstall:",
        "  When --target is omitted in a TTY, uninstall scans the same clients and opens a multi-select removal menu."
    ].join("\n");
}
export function parseArgs(argv) {
    const options = {};
    const positionals = [];
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (!item.startsWith("--")) {
            positionals.push(item);
            continue;
        }
        const keyValue = item.slice(2);
        const equalIndex = keyValue.indexOf("=");
        const key = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
        const inlineValue = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
        if (key === "token") {
            throw new Error("Raw tokens are not accepted in process arguments. Use --token-stdin or --token-env.");
        }
        if (key === "help" ||
            key === "json" ||
            key === "pretty" ||
            key === "token-stdin" ||
            key === "no-verify" ||
            key === "no-auto-token" ||
            key === "no-scan" ||
            key === "set" ||
            key === "refresh" ||
            key === "reset" ||
            key === "list") {
            options[key] = true;
            continue;
        }
        const next = argv[index + 1];
        const value = inlineValue !== null ? inlineValue : !next || next.startsWith("--") ? true : next;
        if (inlineValue === null && value !== true) {
            index += 1;
        }
        options[key] = value;
    }
    return {
        command: positionals[0] || "",
        options
    };
}
export function option(options, name, fallback = "") {
    return options[name] === undefined ? fallback : options[name];
}
export function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}
export function normalizeTarget(value) {
    const raw = String(value || "").trim().toLowerCase();
    return TARGET_ALIASES.get(raw) || raw;
}
export function mcpUrlForTarget(baseUrl, target) {
    const normalizedTarget = normalizeTarget(target);
    return normalizedTarget ? `${baseUrl}/mcp?mcpTarget=${encodeURIComponent(normalizedTarget)}` : `${baseUrl}/mcp`;
}
export function mcpTargetHeaders(target) {
    const normalizedTarget = normalizeTarget(target);
    return normalizedTarget ? { "X-Meshrix-MCP-Target": normalizedTarget } : {};
}
export function parseTargets(rawTarget) {
    const values = String(rawTarget || "codex").split(",").map(normalizeTarget).filter(Boolean);
    const deduped = [...new Set(values)];
    for (const target of deduped) {
        if (!SUPPORTED_TARGETS.includes(target)) {
            throw new Error(`Unsupported install target. Supported targets: ${SUPPORTED_TARGETS.join(", ")}.`);
        }
    }
    return deduped;
}
export function isAutoTargetRequest(rawTarget) {
    const target = normalizeTarget(rawTarget);
    return ["auto", "detected", "all-detected"].includes(target);
}
export function targetLabel(target) {
    return TARGET_LABELS[target] || target;
}
export function targetInstallMode(target) {
    return TARGET_INSTALL_MODES[target] || "meshrix-mcp-client-install";
}
export function notDetectedTargetDetail(target) {
    return `${targetLabel(target)} was not detected by its trusted external adapter.`;
}
//# sourceMappingURL=basic-utils.js.map