import { MCP_NPM_PACKAGE_VERSION } from "../http-mcp-adapter-constants.ts";

export const MCP_CLIENT_ADAPTER_PROTOCOL: any = "v0.0.1:meshrix:client-adapter-json-stdio-1";

const ADAPTER_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  openclaw: "@meshrix/agent-openclaw-adapter",
  codex: "@meshrix/agent-codex-adapter",
  "claude-code": "@meshrix/agent-claude-code-adapter",
  antigravity: "@meshrix/agent-antigravity-adapter",
  opencode: "@meshrix/agent-opencode-adapter",
  pi: "@meshrix/agent-pi-adapter",
  kimi: "@meshrix/agent-kimi-adapter"
});

function trustedAdapter(target?: any, label?: any) : any {
  const version: any = MCP_NPM_PACKAGE_VERSION;
  const packageName: any = ADAPTER_PACKAGES[target];
  if (!packageName) throw new Error("Client adapter package mapping is incomplete.");
  return Object.freeze({
    target,
    label,
    priority: true,
    locations: Object.freeze(["local"]),
    adapter: Object.freeze({
      packageName,
      version,
      entrypoint: "adapter.mjs",
      protocol: MCP_CLIENT_ADAPTER_PROTOCOL,
      source: "meshrix-root-bundle",
      trustPolicy: "root-private-component"
    })
  });
}

// This catalog identifies the first-party components delivered with meshrix.js.
// Client-specific discovery and lifecycle behavior remains inside each component.
export const MCP_CLIENT_TARGETS: readonly any[] = Object.freeze([
  trustedAdapter("openclaw", "OpenClaw"),
  trustedAdapter("codex", "Codex"),
  trustedAdapter("claude-code", "Claude Code"),
  trustedAdapter("antigravity", "Antigravity"),
  trustedAdapter("opencode", "OpenCode"),
  trustedAdapter("pi", "Pi"),
  trustedAdapter("kimi", "Kimi CLI")
]);

export const MCP_SUPPORTED_TARGETS: any = Object.freeze(MCP_CLIENT_TARGETS.map((item?: any) : any => item.target));
export const MCP_PRIORITY_INSTALL_TARGETS: any = Object.freeze(
  MCP_CLIENT_TARGETS.filter((item?: any) : any => item.priority === true).map((item?: any) : any => item.target)
);
export const MCP_PRIORITY_INSTALL_TARGET: any = MCP_PRIORITY_INSTALL_TARGETS.join(",");
export const MCP_TARGET_LABELS: any = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item?: any) : any => [item.target, item.label])
));
export const MCP_TARGET_INSTALL_MODES: any = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item?: any) : any => [item.target, "external-client-adapter"])
));
export const MCP_TARGET_LOCATIONS: any = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item?: any) : any => [item.target, item.locations])
));

export function mcpClientAdapterForTarget(target?: any) : any {
  return MCP_CLIENT_TARGETS.find((item?: any) : any => item.target === target)?.adapter || null;
}

export function mcpSupportedTargetDetails() : any {
  return MCP_CLIENT_TARGETS.map(({ target, label, priority, locations, adapter }: Record<string, any>) : any => ({
    target,
    label,
    priority,
    installMode: "external-client-adapter",
    locations: [...locations],
    adapter: { ...adapter }
  }));
}

export function mcpPublicSupportedTargetDetails() : any {
  return MCP_CLIENT_TARGETS.map(({ target, label, priority, locations }: Record<string, any>) : any => ({
    target,
    label,
    priority,
    installMode: "external-client-adapter",
    locations: [...locations]
  }));
}
