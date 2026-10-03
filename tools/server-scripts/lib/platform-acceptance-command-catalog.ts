/**
 * Canonical platform-acceptance command catalog, ordering, dependencies,
 * blocked exit codes, and report ownership.
 */

import {
  SINGLE_NODE_INTERNAL_PLATFORM_E2E_REPORT_PATH
} from "./single-node-internal-platform-e2e-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_REPORT_PATH
} from "./platform-acceptance-report-catalog.ts";
import {
  acceptanceCommand as command,
  nodeCommand,
  npmRun,
  npmTest
} from "./platform-acceptance-contract.ts";
import { validateRequiredReportSpecCoverage } from "./required-report-validator.ts";
import { validateReleaseReportCatalogClosure } from "./release-report-provenance.ts";
import {
  validatePlatformAcceptanceRequirementEvidence
} from "./platform-acceptance-requirement-evidence.ts";

const REPORT_PATH: any = PLATFORM_ACCEPTANCE_REPORT_PATH;
// npm publication qualifies Core engineering and the real supported product flows.
// Portable runtimes, independent services and performance experiments keep their
// own explicit workflows; none supplies authority for these npm artifacts.
const PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS: readonly any[] = Object.freeze([
  command("foundation-tests", "Core engineering, architecture and security regression", "foundation", npmTest(), "build/test-reports/latest.json", ["unit", "integration", "architecture", "security", "privacy"], {
    exclusive: true,
    ownedReports: ["build/reports/local-info-hygiene.json", "build/reports/script-registry.json"],
    resourceLocks: ["foundation-public-gate"]
  }),
  command("npm-package-prepare", "Prepare the canonical two-product npm archives", "foundation", {
    command: "npm", args: ["run", "release:publish-npm", "--", "--prepare", "--artifact-dir", "build/release/npm-set"]
  }, "", ["npm", "artifacts"], { dependsOn: ["foundation-tests"], exclusive: true }),
  command("npm-package-installability", "Selected-platform npm package consumer qualification", "platform-capability", {
    command: "npm", args: ["run", "verify:npm-package-installability", "--", "--artifact-dir", "build/release/npm-set"]
  }, "build/reports/npm-package-installability.json", ["npm", "package-consumer", "selected-platform"], {
    dependsOn: ["npm-package-prepare"], exclusive: true, resourceLocks: ["npm-package-qualification"]
  }),
  command("upstream-service-publishing", "Core publishing, authorization and revoked-effect verification", "upstream-gateway", npmRun("verify:upstream-service-publishing"), "build/reports/upstream-service-publishing.json", ["publishing", "authorization", "revocation"], { dependsOn: ["foundation-tests"] }),
  command("upstream-mcp-gateway", "Standard MCP upstream transit", "upstream-gateway", npmRun("verify:upstream-mcp-gateway"), "build/reports/upstream-mcp-gateway-e2e.json", ["mcp", "protocol"], { dependsOn: ["foundation-tests"] }),
  command("console-admin-browser-visual", "Real Console browser and authenticated operation", "platform-capability", npmRun("verify:console-admin-browser-visual"), "build/reports/console-admin-browser-visual.json", ["console", "browser", "authentication"], { dependsOn: ["foundation-tests"], exclusive: true, resourceLocks: ["browser-visual"] }),
  command("storage-restore", "Storage integrity and recovery drill", "platform-capability", nodeCommand(["tools/server-scripts/verify-storage-production-restore-drill.ts"]), "build/reports/storage-production-restore-drill/latest.json", ["storage", "recovery"], { dependsOn: ["foundation-tests"], resourceLocks: ["storage-restore"] })
]);

export const SINGLE_NODE_EVIDENCE_COMMAND_IDS: readonly any[] = Object.freeze([
  "npm-package-installability",
  "upstream-service-publishing",
  "upstream-mcp-gateway",
  "console-admin-browser-visual",
  "storage-restore"
]);

const evidenceCommandById: any = new Map<any, any>(
  PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS.map((entry?: any) : any => [entry.id, entry])
);
const unknownSingleNodeCommandIds: any = SINGLE_NODE_EVIDENCE_COMMAND_IDS
  .filter((commandId?: any) : any => !evidenceCommandById.has(commandId));
if (unknownSingleNodeCommandIds.length > 0) {
  throw new Error(
    `Single-node acceptance references unknown platform acceptance commands: ${unknownSingleNodeCommandIds.join(",")}`
  );
}

export const SINGLE_NODE_EVIDENCE_COMMANDS: any = Object.freeze(
  SINGLE_NODE_EVIDENCE_COMMAND_IDS.map((commandId?: any) : any => evidenceCommandById.get(commandId))
);
export const SINGLE_NODE_REQUIRED_REPORTS: readonly any[] = Object.freeze([
  ...new Set<any>(SINGLE_NODE_EVIDENCE_COMMANDS.flatMap((entry?: any) : any => entry.ownedReports || []))
]);

const SINGLE_NODE_EVIDENCE_REDUCTION: any = command(
  "single-node-internal-platform-e2e",
  "Single-node internal platform evidence reduction",
  "final-regression",
  nodeCommand([
    "tools/server-scripts/verify-single-node-internal-platform-e2e.ts",
    "--reduce-existing"
  ]),
  SINGLE_NODE_INTERNAL_PLATFORM_E2E_REPORT_PATH,
  ["final-regression", "single-node", "internal-platform"],
  {
    blockedExitCodes: [2],
    dependsOn: SINGLE_NODE_EVIDENCE_COMMAND_IDS,
    exclusive: true,
    resourceLocks: ["release-final-regression", "report-tree:build/reports"]
  }
);

export const PLATFORM_ACCEPTANCE_COMMANDS: readonly any[] = Object.freeze([
  ...PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS,
  SINGLE_NODE_EVIDENCE_REDUCTION
]);

const CORE_CLIENT_ADOPTION_MARKERS: readonly any[] = Object.freeze([
  "mcp-proxy-transport",
  "downstream-agent-tool-loop",
  "real-client-targets",
  "real-proxy-transport",
  "real-mcp-client-config"
]);
const coreClientAdoptionCommands: any = PLATFORM_ACCEPTANCE_COMMANDS.filter((entry?: any) : any => {
  const surface: any = JSON.stringify({
    id: entry.id,
    args: entry.args,
    covers: entry.covers,
    resourceLocks: entry.resourceLocks
  });
  return CORE_CLIENT_ADOPTION_MARKERS.some((marker?: any) : any => surface.includes(marker));
});
if (coreClientAdoptionCommands.length > 0) {
  throw new Error(
    `Core platform acceptance must use protocol-owned peers, not client adoption commands: ${coreClientAdoptionCommands.map((entry?: any) : any => entry.id).join(",")}`
  );
}
const requirementEvidenceCoverage: any = validatePlatformAcceptanceRequirementEvidence({
  commands: PLATFORM_ACCEPTANCE_COMMANDS
});
if (requirementEvidenceCoverage.valid !== true) {
  throw new Error(
    `Platform acceptance requirement evidence is invalid: ${requirementEvidenceCoverage.reasons.join(",")}`
  );
}
export const PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE_COVERAGE: any = requirementEvidenceCoverage;

export const ACCEPTANCE_REQUIRED_REPORTS: readonly any[] = Object.freeze([
  ...new Set<any>(PLATFORM_ACCEPTANCE_COMMANDS.flatMap((entry?: any) : any => entry.ownedReports || []))
]);

export const REQUIRED_REPORT_SPEC_COVERAGE: any = validateRequiredReportSpecCoverage(
  ACCEPTANCE_REQUIRED_REPORTS,
  { aggregateReportPath: REPORT_PATH }
);
if (REQUIRED_REPORT_SPEC_COVERAGE.ok !== true) {
  throw new Error(
    `Platform acceptance required-report registry is invalid: ${REQUIRED_REPORT_SPEC_COVERAGE.reasons.join(",")}`
  );
}
validateReleaseReportCatalogClosure({
  commands: PLATFORM_ACCEPTANCE_COMMANDS,
  requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
});
