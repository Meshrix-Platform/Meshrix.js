import {
  SUPPORTED_TARGETS,
  TARGET_ALIASES,
  TARGET_INSTALL_MODES,
  TARGET_LABELS
} from "./constants.ts";

export const MXAK1_CREDENTIAL_PATTERN: any = /^mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const MXAK1_CREDENTIAL_IN_TEXT_PATTERN: any = /mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u;

export function containsMxak1Credential(value?: any) : any {
  return MXAK1_CREDENTIAL_IN_TEXT_PATTERN.test(String(value || ""));
}

export function usage() : any {
  const priorityTargets: any = SUPPORTED_TARGETS.join(",");
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
    "  --token-stdin                 Read a pre-issued API Key from protected stdin.",
    "  --token-env NAME              API Key environment variable. Default: MESHRIX_MCP_TOKEN.",
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
    "",
    "Interactive install:",
    "  When --target is omitted in a TTY, install opens a multi-select menu.",
    "  Use Up/Down or j/k to move, Space to toggle, a to toggle detected clients, Enter to install.",
    "",
    "Interactive uninstall:",
    "  When --target is omitted in a TTY, uninstall scans the same clients and opens a multi-select removal menu."
  ].join("\n");
}

export function parseArgs(argv?: any) : any {
  const booleanOptions: any = new Set<any>([
    "help", "version", "json", "pretty", "token-stdin", "no-verify", "no-env", "no-scan",
    "auto-update", "set", "refresh", "reset", "list"
  ]);
  const valueOptions: any = new Set<any>([
    "target", "url", "scan-ports", "token-env", "discovery-file", "client-command",
    "adapter-cache", "artifact", "out", "name", "switch", "execution-location", "remote-kind"
  ]);
  const options: Record<string, any> = {};
  const positionals: any[] = [];
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = String(argv[index]);
    if (containsMxak1Credential(item)) {
      throw new Error("Raw API Keys are not accepted in process arguments. Use --token-stdin or --token-env.");
    }
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const keyValue: any = item.slice(2);
    const equalIndex: any = keyValue.indexOf("=");
    const key: any = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue: any = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    if (key === "token") {
      throw new Error("Raw API Keys are not accepted in process arguments. Use --token-stdin or --token-env.");
    }
    if (!booleanOptions.has(key) && !valueOptions.has(key)) {
      throw new Error("Unknown option.");
    }
    if (booleanOptions.has(key)) {
      if (inlineValue !== null) throw new Error(`Option --${key} does not accept a value.`);
      options[key] = true;
      continue;
    }
    const next: any = argv[index + 1];
    const value: any = inlineValue !== null ? inlineValue : !next || next.startsWith("--") ? true : next;
    if (inlineValue === null && value !== true) {
      index += 1;
    }
    if (value === true) throw new Error(`Option --${key} requires a value.`);
    options[key] = value;
  }
  if (positionals.length > 1) {
    throw new Error("Unexpected positional argument. Use documented options.");
  }
  return {
    command: positionals[0] || "",
    options
  };
}

export function option(options?: any, name?: any, fallback: any = "") : any {
  return options[name] === undefined ? fallback : options[name];
}

export function normalizeBaseUrl(value?: any) : any {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function normalizeTarget(value?: any) : any {
  const raw: any = String(value || "").trim().toLowerCase();
  return TARGET_ALIASES.get(raw) || raw;
}

export function mcpUrlForTarget(baseUrl?: any, target?: any) : any {
  const normalizedTarget: any = normalizeTarget(target);
  return normalizedTarget ? `${baseUrl}/mcp?mcpTarget=${encodeURIComponent(normalizedTarget)}` : `${baseUrl}/mcp`;
}

export function mcpTargetHeaders(target?: any) : any {
  const normalizedTarget: any = normalizeTarget(target);
  return normalizedTarget ? { "X-Meshrix-MCP-Target": normalizedTarget } : {};
}

export function parseTargets(rawTarget?: any) : any {
  const values: any = String(rawTarget || "codex").split(",").map(normalizeTarget).filter(Boolean);
  const deduped: any[] = [...new Set<any>(values)];
  for (const target of deduped) {
    if (!SUPPORTED_TARGETS.includes(target)) {
      throw new Error(`Unsupported install target. Supported targets: ${SUPPORTED_TARGETS.join(", ")}.`);
    }
  }
  return deduped;
}

export function isAutoTargetRequest(rawTarget?: any) : any {
  const target: any = normalizeTarget(rawTarget);
  return ["auto", "detected", "all-detected"].includes(target);
}

export function targetLabel(target?: any) : any {
  return TARGET_LABELS[target] || target;
}

export function targetInstallMode(target?: any) : any {
  return TARGET_INSTALL_MODES[target] || "meshrix-mcp-client-install";
}

export function notDetectedTargetDetail(target?: any) : any {
  return `${targetLabel(target)} was not detected by its trusted external adapter.`;
}
