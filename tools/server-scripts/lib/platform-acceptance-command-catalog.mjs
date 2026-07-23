/**
 * Canonical platform-acceptance command catalog, ordering, dependencies,
 * timeouts, blocked exit codes, report ownership, and job budget.
 */

import {
  PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH
} from "./private-deployment-open-platform-e2e-catalog.mjs";
import {
  PLATFORM_ACCEPTANCE_REPORT_PATH
} from "./platform-acceptance-report-catalog.mjs";
import {
  PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS,
  PLATFORM_ACCEPTANCE_PARALLELISM,
  acceptanceCommand as command,
  nodeCommand,
  npmRun,
  npmTest,
  platformAcceptanceJobBudget
} from "./platform-acceptance-contract.mjs";
import { validateRequiredReportSpecCoverage } from "./required-report-validator.mjs";
import {
  estimateReleaseCommandWorstCaseMs
} from "./release-command-dag-runner.mjs";
import { validateReleaseReportCatalogClosure } from "./release-report-provenance.mjs";
import {
  validatePlatformAcceptanceRequirementEvidence
} from "./platform-acceptance-requirement-evidence.mjs";

const REPORT_PATH = PLATFORM_ACCEPTANCE_REPORT_PATH;

const NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS = 55 * 60 * 1000;
const PRODUCTION_READINESS_GATES_TIMEOUT_MS = 125 * 60 * 1000;

const PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS = Object.freeze([
  command("typecheck", "TypeScript project typecheck", "foundation", npmRun("typecheck"), "", ["types"]),
  command("console-build", "Console production build", "foundation", npmRun("build"), "", ["console", "build"]),
  command("foundation-tests", "Core public foundation gate", "foundation", npmTest(), "build/test-reports/latest.json", ["unit", "public-boundary", "secret-hygiene", "local-info", "registry", "root-hygiene"], {
    ownedReports: [
      "build/reports/local-info-hygiene.json",
      "build/reports/script-registry.json"
    ],
    resourceLocks: [
      "foundation-public-gate"
    ]
  }),
  command("better-plan", "Public source documentation boundary", "foundation", npmRun("verify:better-plan"), "build/reports/better-plan.json", ["documentation", "public-boundary", "release-state"]),
  command("composition-source-package", "Self-contained composition source package", "foundation", npmRun("verify:composition-source-package"), "build/reports/composition-source-package.json", ["source-package", "offline-release", "composition"]),
  command("npm-package-installability", "npm release-set clean-install, CLI, and headless runtime", "foundation", npmRun("verify:npm-package-installability"), "build/reports/npm-package-installability.json", ["release-package-set", "clean-install", "cli", "server-runtime", "cross-platform"], { resourceLocks: ["container-runtime"], timeoutMs: NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS }),
  command("security-alert-lifecycle", "Security alert lifecycle", "foundation", npmRun("verify:security-alert-lifecycle"), "build/reports/security-alert-lifecycle.json", ["security-alerts", "redaction"]),
  command("state-machines", "State machine definition integrity", "foundation", npmRun("server:verify:state-machines"), "build/reports/state-machines/latest.json", ["state-machine", "integrity", "acceptance"]),
  command("capability-acceptance-machines", "Capability acceptance state machine coverage", "foundation", npmRun("verify:capability-acceptance-machines"), "build/reports/capability-acceptance-machines.json", ["state-machine", "capability-plans", "acceptance"], { blockedExitCodes: [2] }),
  command("plugin-runtime", "Plugin runtime manifest registry and mount execution view", "foundation", npmRun("verify:plugin-runtime"), "build/reports/plugin-runtime.json", ["plugin-runtime", "module-system", "mounts"]),
  command("protocol-boundary", "Protocol package runtime dependency boundary", "foundation", npmRun("server:verify:protocol-boundary"), "build/reports/protocol-boundary.json", ["protocols", "architecture-boundary", "runtime-decoupling"]),
  command("docs-registry-consistency", "Registry-governed documentation consistency", "foundation", nodeCommand(["tools/verifiers/verify-generated-docs-consistency.mjs"]), "", ["documentation", "registry", "single-source-of-truth"]),
  command("platform-acceptance-plan", "Platform acceptance plan contract", "foundation", npmRun("verify:acceptance:plan"), "", ["acceptance", "plan"], { timeoutMs: 2 * 60 * 1000 }),
  command("maintenance-agent", "Maintenance Agent capability verification", "foundation", npmRun("server:verify:maintenance-agent"), "", ["maintenance-agent"], { timeoutMs: 2 * 60 * 1000 }),
  command("strategy-management", "Strategy Management capability verification", "foundation", npmRun("server:verify:strategy-management"), "build/reports/strategy-management.json", ["strategy-management"], { timeoutMs: 2 * 60 * 1000 }),
  command("agent-gateway", "Agent Gateway capability verification", "foundation", npmRun("server:verify:agent-gateway"), "", ["agent-gateway"], { timeoutMs: 2 * 60 * 1000 }),
  command("model-routing", "Model routing capability verification", "foundation", npmRun("server:verify:model-routing"), "", ["model-routing"], { timeoutMs: 2 * 60 * 1000 }),
  command("workspace-asset-management", "Core workspace assets and governance verification", "foundation", nodeCommand(["tools/server-scripts/verify-workspace-asset-management.mjs"]), "", ["workspace-assets", "workspace-governance"], { timeoutMs: 2 * 60 * 1000 }),

  command("mcp-client-identity-proof", "MCP client process identity proof", "downstream-gateway", npmRun("verify:mcp-client-identity-proof"), "build/reports/mcp-client-identity-proof.json", ["downstream-gateway", "mcp", "process-identity"]),
  command("mcp-process-identity-credential-store", "MCP process identity credential store", "downstream-gateway", npmRun("verify:mcp-process-identity-credential-store"), "build/reports/mcp-process-identity-credential-store.json", ["downstream-gateway", "system-credential-store"]),
  command("node-runtime-supply-chain", "Pinned Node runtime supply-chain verification", "downstream-gateway", npmRun("verify:node-runtime-supply-chain"), "build/reports/node-runtime-supply-chain.json", ["downstream-gateway", "runtime-supply-chain", "signature-verification"], { resourceLocks: ["node-runtime-official-download"] }),
  command("mcp-release-portable-assembly", "MCP release portable assembly", "downstream-gateway", npmRun("verify:mcp-release-portable-assembly"), "build/reports/mcp-release-portable-assembly.json", ["downstream-gateway", "release-artifact"], { dependsOn: ["node-runtime-supply-chain"] }),
  command("mcp-authorization-request-filters", "MCP authorization request filters", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-mcp-authorization-request-filters.mjs"]), "build/reports/mcp-authorization-request-filters.json", ["downstream-gateway", "authorization"], { timeoutMs: 2 * 60 * 1000 }),
  command("mcp-installer-convergence", "MCP installer convergence", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-mcp-installer-convergence.mjs"]), "build/reports/mcp-installer-convergence.json", ["downstream-gateway", "installer"], { timeoutMs: 2 * 60 * 1000 }),
  command("mcp-release-target-scope", "MCP release target scope", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-mcp-release-target-scope.mjs"]), "build/reports/mcp-release-target-scope.json", ["downstream-gateway", "release-targets"], { timeoutMs: 2 * 60 * 1000 }),
  command("downstream-mcp-audit", "Downstream MCP completeness audit", "downstream-gateway", npmRun("verify:downstream-mcp-audit"), "build/reports/downstream-mcp-completeness-audit.json", ["downstream-gateway", "completeness"], { timeoutMs: 2 * 60 * 1000 }),
  command("downstream-mcp-product-e2e", "Downstream MCP product end-to-end", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-downstream-mcp-product-e2e.mjs"]), "build/reports/downstream-mcp-product-e2e.json", ["downstream-gateway", "product-e2e", "authorization"], { timeoutMs: 5 * 60 * 1000, dependsOn: ["downstream-mcp-audit", "mcp-authorization-request-filters"] }),

  command("upstream-service-publishing", "Upstream service publishing", "upstream-gateway", npmRun("verify:upstream-service-publishing"), "build/reports/upstream-service-publishing.json", ["upstream-gateway", "service-publishing", "protocol-delivery"]),
  command("upstream-gateway-e2e", "Governed upstream gateway E2E", "upstream-gateway", npmRun("verify:upstream-gateway"), "build/reports/upstream-gateway-e2e.json", ["upstream-gateway", "local-fixture-upstream"]),
  command("upstream-mcp-gateway", "Upstream MCP gateway E2E", "upstream-gateway", npmRun("verify:upstream-mcp-gateway"), "build/reports/upstream-mcp-gateway-e2e.json", ["upstream-gateway", "mcp"], { timeoutMs: 2 * 60 * 1000 }),
  command("upstream-fixture-transit", "Self-contained upstream fixture REST and MCP transit", "upstream-gateway", npmRun("verify:upstream-fixture-transit"), "build/reports/upstream-fixture-transit.json", ["upstream-gateway", "self-contained-fixture", "credential-injection"], { timeoutMs: 5 * 60 * 1000 }),

  command("production-readiness-gates", "Server security production gates", "platform-capability", nodeCommand(["tools/server-scripts/production-readiness-gate.mjs"]), "build/reports/production-readiness-gates.json", ["platform-capability", "security", "server-readiness"], {
    blockedExitCodes: [2],
    resourceLocks: ["production-readiness-reports"],
    timeoutMs: PRODUCTION_READINESS_GATES_TIMEOUT_MS
  }),
  command("path-abstraction-audit", "Path abstraction and sandbox audit", "platform-capability", npmRun("verify:path-abstraction-audit"), "build/reports/path-abstraction-audit.json", ["platform-capability", "path-sandbox"]),
  command("controlled-execution-sandbox", "Controlled execution sandbox contract verification", "platform-capability", npmRun("verify:controlled-execution-sandbox"), "build/reports/controlled-execution-sandbox.json", ["platform-capability", "execution-sandbox", "default-deny", "no-host-fallback"], {
    ownedReports: [
      "build/reports/execution-sandbox-oci-conformance.json",
      "build/reports/opaque-sandbox-custody.json",
      "build/reports/execution-launcher-boundary.json"
    ],
    resourceLocks: ["container-runtime"]
  }),
  command("controlled-execution-convergence-final", "Controlled Execution Convergence final reduction", "platform-capability", npmRun("verify:controlled-execution-convergence"), "build/reports/controlled-execution-convergence-final.json", ["platform-capability", "execution-sandbox", "current-plan-receipt"], { dependsOn: ["controlled-execution-sandbox"] }),
  command("enterprise-governance-coverage", "Enterprise authorization governance coverage", "platform-capability", npmRun("verify:authorization-governance"), "build/reports/enterprise-governance-coverage.json", ["platform-capability", "authorization", "governance"]),
  command("operation-permission-protocol-consistency", "Operation Permission protocol consistency", "platform-capability", npmRun("verify:operation-permission-protocol-consistency"), "build/reports/operation-permission-protocol-consistency.json", ["platform-capability", "operation-permission"]),
  command("operation-permission-tag-governed-e2e", "Operation Permission tag-governed capability E2E", "platform-capability", npmRun("verify:operation-permission-tag-governed-e2e"), "build/reports/operation-permission-tag-governed-e2e.json", ["platform-capability", "operation-permission", "tag-policy"], { dependsOn: ["controlled-execution-convergence-final"], resourceLocks: ["container-runtime"] }),
  command("operation-permission-domain-model", "Operation Permission domain model", "platform-capability", npmRun("verify:operation-permission-domain-model"), "build/reports/operation-permission-domain-model.json", ["platform-capability", "operation-permission", "domain-model"], { timeoutMs: 2 * 60 * 1000 }),
  command("approval-governance", "Approval governance terminal outcomes", "platform-capability", npmRun("verify:approval-governance"), "build/reports/approval-governance.json", ["platform-capability", "authorization", "approval"], { timeoutMs: 60 * 1000 }),
  command("audit-retention-redaction", "Enterprise audit retention and redaction", "platform-capability", npmRun("verify:enterprise-audit-retention-redaction"), "build/reports/enterprise-audit-retention-redaction.json", ["platform-capability", "audit", "redaction"]),
  command("observability-semantics", "Observability semantic release gate", "platform-capability", nodeCommand(["tools/server-scripts/verify-observability-semantics.mjs", "--gate", "release"]), "build/reports/observability-semantics.json", ["platform-capability", "observability"]),
  command("observability-runtime", "Executive report retention system inspection and production health runtime", "platform-capability", nodeCommand(["tools/server-scripts/verify-observability-runtime-acceptance.mjs"]), "build/reports/observability-runtime-acceptance.json", ["platform-capability", "observability", "executive-report", "system-inspection", "production-health"]),
  command("production-health-console", "Production health console verification", "platform-capability", nodeCommand(["tools/server-scripts/verify-production-health-console.mjs"]), "", ["platform-capability", "observability", "console"], { timeoutMs: 2 * 60 * 1000 }),
  command("authorization-enforcement", "Enterprise authorization enforcement", "platform-capability", npmRun("verify:enterprise-authorization-enforcement"), "build/reports/enterprise-authorization-enforcement.json", ["platform-capability", "authorization"], { dependsOn: ["enterprise-governance-coverage", "operation-permission-protocol-consistency", "operation-permission-tag-governed-e2e"] }),
  command("observability-coverage", "Enterprise observability coverage", "platform-capability", npmRun("verify:enterprise-observability-coverage"), "build/reports/enterprise-observability-coverage.json", ["platform-capability", "observability"], { dependsOn: ["audit-retention-redaction", "observability-semantics", "observability-runtime", "operation-permission-tag-governed-e2e"] }),
  command("storage-restore", "Storage production restore drill", "platform-capability", nodeCommand(["tools/server-scripts/verify-storage-production-restore-drill.mjs"]), "build/reports/storage-production-restore-drill/latest.json", ["platform-capability", "storage", "backup-restore"], { resourceLocks: ["storage-restore"] }),
  command("deployment-container-flow", "Fresh container deployment flow", "platform-capability", nodeCommand(["tools/server-scripts/verify-deployment-container-flow.mjs"]), "build/reports/deployment-container-flow.json", ["platform-capability", "deployment", "container"], { dependsOn: ["npm-package-installability"], resourceLocks: ["container-runtime"] }),
  command("job-work-queue", "Job work queue verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-job-work-queue.mjs"]), "build/reports/job-work-queue.json", ["platform-capability", "jobs"], { resourceLocks: ["work-queue"] }),
  command("job-work-queue-capacity", "Job work queue capacity verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-job-work-queue-capacity.mjs"]), "build/reports/job-work-queue-capacity.json", ["platform-capability", "jobs", "capacity"], { resourceLocks: ["work-queue"] }),
  command("work-queue-conformance", "Work queue conformance verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-work-queue-conformance.mjs"]), "build/reports/work-queue/latest.json", ["platform-capability", "jobs"], { resourceLocks: ["work-queue"] }),
  command("work-queue-process-restart", "Work queue process restart verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-work-queue-process-restart.mjs"]), "build/reports/work-queue-process-restart.json", ["platform-capability", "jobs", "restart"], { resourceLocks: ["work-queue"] }),
  command("upload-workspace-materialization", "Governed upload workspace materialization", "platform-capability", nodeCommand(["tools/server-scripts/verify-upload-workspace-materialization.mjs"]), "build/reports/upload-workspace-materialization.json", ["platform-capability", "jobs", "workspace", "authorization"], { resourceLocks: ["work-queue"] }),
  command("console-redundancy", "Console redundancy audit", "platform-capability", npmRun("verify:console-redundancy"), "build/reports/console-redundancy.json", ["platform-capability", "console"]),
  command("console-administration", "Console administration workflow coverage", "platform-capability", npmRun("verify:console-administration-coverage"), "build/reports/console-administration-coverage.json", ["platform-capability", "console"]),
  command("console-admin-browser-visual", "Console admin browser visual coverage", "platform-capability", npmRun("verify:console-admin-browser-visual"), "build/reports/console-admin-browser-visual.json", ["platform-capability", "console", "browser"], { exclusive: true, resourceLocks: ["browser-visual"] }),
  command("console-gateway-mcp", "Console gateway and MCP workflows", "platform-capability", npmRun("verify:console-gateway-mcp-workflows"), "build/reports/console-gateway-mcp-workflows.json", ["platform-capability", "console", "gateway"], { dependsOn: ["upstream-gateway-e2e", "downstream-mcp-audit", "operation-permission-protocol-consistency", "operation-permission-tag-governed-e2e"] }),
  command("repo-organization", "Repository organization boundaries", "platform-capability", npmRun("verify:repo-organization"), "build/reports/repo-organization.json", ["platform-capability", "repository-organization"]),
  command("documentation-convergence", "Core platform documentation convergence", "platform-capability", npmRun("verify:core-platform-documentation-convergence"), "build/reports/core-platform-documentation-convergence.json", ["platform-capability", "documentation"]),
  command("surface-convergence", "Core platform surface convergence", "platform-capability", npmRun("verify:core-platform-surface-convergence"), "build/reports/core-platform-surface-convergence.json", ["platform-capability", "operation-surface"]),
  command("gap-audit", "Core platform gap audit", "platform-capability", npmRun("verify:platform-audit"), "build/reports/core-platform-gap-audit.json", ["platform-capability", "gap-audit"]),

  command("mcp-gateway-load", "MCP gateway load and resource cutoff profile", "profile", npmRun("server:stress:mcp-gateway"), "build/reports/mcp-gateway-load.json", ["profile", "downstream-gateway", "upstream-forwarding", "resource-cutoff"], { resourceLocks: ["gateway-platform-profile"] }),
  command("gateway-platform-profile", "Gateway platform performance profile", "profile", nodeCommand(["tools/server-scripts/stress-gateway-platform-profile.mjs"]), "build/reports/gateway-platform-profile.json", ["profile", "downstream-gateway", "upstream-gateway"], { dependsOn: ["production-readiness-gates", "mcp-gateway-load", "upstream-fixture-transit", "path-abstraction-audit"], resourceLocks: ["gateway-platform-profile"] })
]);

export const PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS = Object.freeze([
  "surface-convergence",
  "production-readiness-gates",
  "deployment-container-flow",
  "downstream-mcp-audit",
  "downstream-mcp-product-e2e",
  "mcp-release-portable-assembly",
  "npm-package-installability",
  "upstream-fixture-transit",
  "upstream-gateway-e2e",
  "upstream-service-publishing",
  "operation-permission-protocol-consistency",
  "operation-permission-tag-governed-e2e",
  "enterprise-governance-coverage",
  "authorization-enforcement",
  "audit-retention-redaction",
  "observability-semantics",
  "observability-coverage",
  "storage-restore",
  "job-work-queue",
  "work-queue-conformance",
  "work-queue-process-restart",
  "console-administration",
  "console-admin-browser-visual",
  "console-gateway-mcp",
  "gap-audit"
]);

const evidenceCommandById = new Map(
  PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS.map((entry) => [entry.id, entry])
);
const unknownPrivateDeploymentCommandIds = PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS
  .filter((commandId) => !evidenceCommandById.has(commandId));
if (unknownPrivateDeploymentCommandIds.length > 0) {
  throw new Error(
    `Private deployment references unknown platform acceptance commands: ${unknownPrivateDeploymentCommandIds.join(",")}`
  );
}

export const PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS = Object.freeze(
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS.map((commandId) => evidenceCommandById.get(commandId))
);
export const PRIVATE_DEPLOYMENT_REQUIRED_REPORTS = Object.freeze([
  ...new Set(PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS.flatMap((entry) => entry.ownedReports || []))
]);

const PRIVATE_DEPLOYMENT_EVIDENCE_REDUCTION = command(
  "private-deployment-open-platform-e2e",
  "Private deployment open platform evidence reduction",
  "final-regression",
  nodeCommand([
    "tools/server-scripts/verify-private-deployment-open-platform-e2e.mjs",
    "--reduce-existing"
  ]),
  PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH,
  ["final-regression", "private-deployment", "open-platform"],
  {
    blockedExitCodes: [2],
    dependsOn: PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS,
    exclusive: true,
    resourceLocks: ["release-final-regression", "report-tree:build/reports"],
    timeoutMs: 2 * 60 * 1000
  }
);

export const PLATFORM_ACCEPTANCE_COMMANDS = Object.freeze([
  ...PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_EVIDENCE_REDUCTION
]);

const CORE_CLIENT_ADOPTION_MARKERS = Object.freeze([
  "mcp-proxy-transport",
  "downstream-agent-tool-loop",
  "real-client-targets",
  "real-proxy-transport",
  "real-mcp-client-config"
]);
const coreClientAdoptionCommands = PLATFORM_ACCEPTANCE_COMMANDS.filter((entry) => {
  const surface = JSON.stringify({
    id: entry.id,
    args: entry.args,
    covers: entry.covers,
    resourceLocks: entry.resourceLocks
  });
  return CORE_CLIENT_ADOPTION_MARKERS.some((marker) => surface.includes(marker));
});
if (coreClientAdoptionCommands.length > 0) {
  throw new Error(
    `Core platform acceptance must use protocol-owned peers, not client adoption commands: ${coreClientAdoptionCommands.map((entry) => entry.id).join(",")}`
  );
}
const requirementEvidenceCoverage = validatePlatformAcceptanceRequirementEvidence({
  commands: PLATFORM_ACCEPTANCE_COMMANDS
});
if (requirementEvidenceCoverage.valid !== true) {
  throw new Error(
    `Platform acceptance requirement evidence is invalid: ${requirementEvidenceCoverage.reasons.join(",")}`
  );
}
export const PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE_COVERAGE = requirementEvidenceCoverage;

export const PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE =
  estimateReleaseCommandWorstCaseMs(PLATFORM_ACCEPTANCE_COMMANDS, {
    defaultTimeoutMs: PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS,
    env: {},
    maxParallel: PLATFORM_ACCEPTANCE_PARALLELISM
  });
export const PLATFORM_ACCEPTANCE_JOB_BUDGET_MS = platformAcceptanceJobBudget(
  PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE.timeoutMs
);

export const ACCEPTANCE_REQUIRED_REPORTS = Object.freeze([
  ...new Set(PLATFORM_ACCEPTANCE_COMMANDS.flatMap((entry) => entry.ownedReports || []))
]);

export const REQUIRED_REPORT_SPEC_COVERAGE = validateRequiredReportSpecCoverage(
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
