export const MCP_PORTABLE_TARGETS = Object.freeze([
  "macos-arm64",
  "macos-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "windows-arm64"
]);

export const MCP_RELEASE_TARGETS = Object.freeze([
  "macos-arm64"
]);

export const MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET = Object.freeze({
  "macos-arm64": "macos-arm64",
  "macos-x64": "macos-x64",
  "linux-x64": "linux-x86_64",
  "linux-arm64": "linux-arm64",
  "windows-x64": "windows-x64",
  "windows-arm64": "windows-arm64"
});

export function normalizeMcpPortableTargets(value = null) {
  const targets = value === null
    ? [...MCP_RELEASE_TARGETS]
    : String(value).split(",").map((target) => target.trim()).filter(Boolean);
  const uniqueTargets = [...new Set(targets)];
  if (
    uniqueTargets.length === 0 ||
    uniqueTargets.some((target) => !MCP_PORTABLE_TARGETS.includes(target))
  ) {
    throw new Error("mcp_release_platform_not_supported");
  }
  return uniqueTargets;
}
