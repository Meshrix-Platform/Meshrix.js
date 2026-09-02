export const PLATFORM_ACCEPTANCE_REPORT_PATH: any = "build/reports/platform-acceptance.json";
export const PLATFORM_ACCEPTANCE_RECEIPT_PATH: any = "build/reports/accepted-candidate.json";
export const PLATFORM_ACCEPTANCE_GENERATION_ROOT: any = "build/acceptance-evidence";
export const PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH: any = `${PLATFORM_ACCEPTANCE_GENERATION_ROOT}/current.json`;
export const MCP_RELEASE_PORTABLE_ASSEMBLY_REPORT_PATH: any = "build/reports/mcp-release-portable-assembly.json";
export const LOCAL_INFO_HYGIENE_REPORT_PATH: any = "build/reports/local-info-hygiene.json";

function portableAssemblyPlatformReportPath() : any {
  const platformMap: Record<string, any> = { darwin: "macos", linux: "linux", win32: "windows" };
  const archMap: Record<string, any> = { x64: "x64", arm64: "arm64" };
  const target: any = `${platformMap[process.platform] || process.platform}-${archMap[process.arch] || process.arch}`;
  return `build/reports/mcp-release-portable-assembly-${target}.json`;
}

export const PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST: readonly any[] = Object.freeze([
  "build/reports/architecture-graph.json",
  "build/reports/runtime-resource-discipline.json",
  "build/reports/version-naming/latest.json",
  "build/reports/version-registry/latest.json",
  "build/reports/plugin-bundle-protocol.json",
  "build/reports/npm-artifact-cache.json",
  "build/reports/npm-artifact-cache-interrupted.json",
  portableAssemblyPlatformReportPath()
]);
