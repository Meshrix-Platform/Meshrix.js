import testRegistry from "../../registry/tests.registry.json" with { type: "json" };

export const PLATFORM_ACCEPTANCE_REPORT_PATH: any = "build/reports/platform-acceptance.json";
export const PLATFORM_ACCEPTANCE_RECEIPT_PATH: any = "build/reports/accepted-candidate.json";
export const PLATFORM_ACCEPTANCE_GENERATION_ROOT: any = "build/acceptance-evidence";
export const PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH: any = `${PLATFORM_ACCEPTANCE_GENERATION_ROOT}/current.json`;
export const MCP_RELEASE_PORTABLE_ASSEMBLY_REPORT_PATH: any = "build/reports/mcp-release-portable-assembly.json";
export const LOCAL_INFO_HYGIENE_REPORT_PATH: any = "build/reports/local-info-hygiene.json";

// Foundation acceptance runs core-public. Its auxiliary report paths belong to
// the test registry; allowing their writes does not make them release evidence.
const profiles: Record<string, { suites?: string[]; extends?: string; dynamic?: boolean }> = testRegistry.profiles;
const coreSuiteIds = new Set<string>();
const visitedProfiles = new Set<string>();
for (let profile = "core-public"; profile; profile = profiles[profile].extends || "") {
  if (visitedProfiles.has(profile)) throw new Error(`Circular test profile: ${profile}`);
  visitedProfiles.add(profile);
  for (const suiteId of profiles[profile].suites || []) coreSuiteIds.add(suiteId);
}
const coreReportArtifacts = testRegistry.suites
  .filter((suite) => coreSuiteIds.has(suite.id))
  .flatMap((suite) => suite.artifacts || [])
  .filter((artifact) => artifact.startsWith("build/reports/") && artifact.endsWith(".json"));

export const PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST: readonly string[] = Object.freeze([
  ...new Set(coreReportArtifacts),
  "build/reports/plugin-bundle-protocol.json",
  "build/reports/npm-artifact-cache.json",
  "build/reports/npm-artifact-cache-interrupted.json"
]);
