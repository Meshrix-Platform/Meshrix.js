export const MCP_CLIENT_ADAPTER_PROTOCOL = "v0.0.1:meshrix:client-adapter-json-stdio-1";

function trustedAdapter(target, label) {
  const version = "0.0.1";
  const packageName = `@meshrix/agent-${target}-adapter`;
  return Object.freeze({
    target,
    label,
    priority: true,
    locations: Object.freeze(["local"]),
    adapter: Object.freeze({
      packageName,
      version,
      coordinate: `${packageName}@${version}`,
      entrypoint: "adapter.mjs",
      protocol: MCP_CLIENT_ADAPTER_PROTOCOL,
      source: "npm",
      trustPolicy: "npm-exact-coordinate",
      // Populated by the signed Plugins release index once the package is
      // published. The runner enforces it whenever it is present.
      integrity: ""
    })
  });
}

// This catalog is an allowlist, not an implementation registry. Client-specific
// discovery and lifecycle behavior lives in the exact external package named by
// each coordinate.
export const MCP_CLIENT_TARGETS = Object.freeze([
  trustedAdapter("openclaw", "OpenClaw"),
  trustedAdapter("codex", "Codex"),
  trustedAdapter("claude-code", "Claude Code"),
  trustedAdapter("antigravity", "Antigravity"),
  trustedAdapter("opencode", "OpenCode"),
  trustedAdapter("pi", "Pi"),
  trustedAdapter("kimi", "Kimi CLI")
]);

export const MCP_SUPPORTED_TARGETS = Object.freeze(MCP_CLIENT_TARGETS.map((item) => item.target));
export const MCP_PRIORITY_INSTALL_TARGETS = Object.freeze(
  MCP_CLIENT_TARGETS.filter((item) => item.priority === true).map((item) => item.target)
);
export const MCP_PRIORITY_INSTALL_TARGET = MCP_PRIORITY_INSTALL_TARGETS.join(",");
export const MCP_TARGET_LABELS = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item) => [item.target, item.label])
));
export const MCP_TARGET_INSTALL_MODES = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item) => [item.target, "external-client-adapter"])
));
export const MCP_TARGET_LOCATIONS = Object.freeze(Object.fromEntries(
  MCP_CLIENT_TARGETS.map((item) => [item.target, item.locations])
));

export function mcpClientAdapterForTarget(target) {
  return MCP_CLIENT_TARGETS.find((item) => item.target === target)?.adapter || null;
}

export function mcpSupportedTargetDetails() {
  return MCP_CLIENT_TARGETS.map(({ target, label, priority, locations, adapter }) => ({
    target,
    label,
    priority,
    installMode: "external-client-adapter",
    locations: [...locations],
    adapter: { ...adapter }
  }));
}

export function mcpPublicSupportedTargetDetails() {
  return MCP_CLIENT_TARGETS.map(({ target, label, priority, locations }) => ({
    target,
    label,
    priority,
    installMode: "external-client-adapter",
    locations: [...locations]
  }));
}
