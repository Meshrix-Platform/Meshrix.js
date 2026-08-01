export const MCP_PORTABLE_TARGETS: readonly any[] = Object.freeze([
  "macos-arm64",
  "macos-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "windows-arm64"
]);

export const MCP_RELEASE_TARGETS: readonly any[] = Object.freeze([
  "macos-arm64"
]);

export const MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET: Readonly<Record<string, any>> = Object.freeze({
  "macos-arm64": "macos-arm64",
  "macos-x64": "macos-x64",
  "linux-x64": "linux-x86_64",
  "linux-arm64": "linux-arm64",
  "windows-x64": "windows-x64",
  "windows-arm64": "windows-arm64"
});

export function normalizeMcpPortableTargets(value: any = null) : any {
  const targets: any = value === null
    ? [...MCP_RELEASE_TARGETS]
    : String(value).split(",").map((target?: any) : any => target.trim()).filter(Boolean);
  const uniqueTargets: any[] = [...new Set<any>(targets)];
  if (
    uniqueTargets.length === 0 ||
    uniqueTargets.some((target?: any) : any => !MCP_PORTABLE_TARGETS.includes(target))
  ) {
    throw new Error("mcp_release_platform_not_supported");
  }
  return uniqueTargets;
}
