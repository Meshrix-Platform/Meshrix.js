/**
 * Canonical platform-acceptance command catalog, ordering, dependencies,
 * blocked exit codes, and report ownership.
 */

import {
  PRIVATE_DEPLOYMENT_INTERNAL_PLATFORM_E2E_REPORT_PATH
} from "./private-deployment-internal-platform-e2e-catalog.ts";
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

const PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS: readonly any[] = Object.freeze([
  command("typecheck", "TypeScript project typecheck", "foundation", npmRun("typecheck"), "", ["types"]),
  command("console-build", "Console production build", "foundation", npmRun("build"), "", ["console", "build"]),
  command("foundation-tests", "Core public foundation gate", "foundation", npmTest(), "build/test-reports/latest.json", ["unit", "public-boundary", "secret-hygiene", "local-info", "registry", "root-hygiene"], {
    exclusive: true,
    ownedReports: [
      "build/reports/local-info-hygiene.json",
      "build/reports/script-registry.json"
    ],
    resourceLocks: [
      "foundation-public-gate"
    ]
  }),
  command("composition-source-package", "Self-contained composition source package", "foundation", npmRun("verify:composition-source-package"), "build/reports/composition-source-package.json", ["source-package", "offline-release", "composition"]),
  command("npm-package-installability", "npm release-set clean-install, CLI, and headless runtime", "foundation", npmRun("verify:npm-package-installability"), "build/reports/npm-package-installability.json", ["release-package-set", "clean-install", "cli", "server-runtime", "cross-platform"], { dependsOn: ["foundation-tests"], resourceLocks: ["container-runtime"] }),
  command("security-alert-lifecycle", "Security alert lifecycle", "foundation", npmRun("verify:security-alert-lifecycle"), "build/reports/security-alert-lifecycle.json", ["security-alerts", "redaction"]),
  command("state-machines", "State machine definition integrity", "foundation", npmRun("server:verify:state-machines"), "build/reports/state-machines/latest.json", ["state-machine", "integrity", "acceptance"]),
  command("capability-acceptance-machines", "Capability acceptance state machine coverage", "foundation", npmRun("verify:capability-acceptance-machines"), "build/reports/capability-acceptance-machines.json", ["state-machine", "capability-plans", "acceptance"], { blockedExitCodes: [2] }),
  command("plugin-runtime", "Plugin runtime manifest registry and mount execution view", "foundation", npmRun("verify:plugin-runtime"), "build/reports/plugin-runtime.json", ["plugin-runtime", "module-system", "mounts"]),
  command("protocol-boundary", "Protocol package runtime dependency boundary", "foundation", npmRun("server:verify:protocol-boundary"), "build/reports/protocol-boundary.json", ["protocols", "architecture-boundary", "runtime-decoupling"]),
  command("docs-registry-consistency", "Registry-governed documentation consistency", "foundation", nodeCommand(["tools/verifiers/verify-generated-docs-consistency.ts"]), "", ["documentation", "registry", "single-source-of-truth"]),
  command("release-acceptance-standards", "Functional and real-machine acceptance boundary", "foundation", npmRun("verify:acceptance:standards"), "", ["acceptance", "functional-completeness", "real-machine-isolation"]),
  command("platform-acceptance-plan", "Platform acceptance plan contract", "foundation", npmRun("verify:acceptance:plan"), "", ["acceptance", "plan"]),
  command("strategy-management", "Strategy Management capability verification", "foundation", npmRun("server:verify:strategy-management"), "build/reports/strategy-management.json", ["strategy-management"]),
  command("model-gateway-service", "Standalone Model Gateway Service verification", "foundation", nodeCommand(["tools/server-scripts/verify-model-gateway-service.ts"]), "", ["model-gateway", "service-boundary"]),
  command("model-gateway-routing", "Model Gateway routing verification", "foundation", nodeCommand(["--test", "services/model-gateway/test/http-service.test.mjs"]), "", ["model-gateway", "routing"]),
  command("model-gateway-admission", "Model Gateway admission verification", "foundation", nodeCommand(["--test", "services/model-gateway/test/admission.test.mjs"]), "", ["model-gateway", "admission"]),
  command("model-gateway-usage-accounting", "Model Gateway usage accounting verification", "foundation", nodeCommand(["--test", "services/model-gateway/test/persistence.test.mjs"]), "", ["model-gateway", "usage-accounting"]),
  command("model-gateway-adapter", "Model Gateway adapter and detachment verification", "foundation", npmRun("server:verify:model-gateway-detachment"), "", ["model-gateway", "adapter", "detachment"]),
  command("gateway-boundary-final", "Mandatory dual-Gateway and detached lifecycle final boundary", "foundation", nodeCommand(["tools/server-scripts/gateway-boundary-final.ts"]), "build/reports/gateway-boundary-final.json", ["gateway", "traffic-model", "console-selection", "detachment", "maintenance"]),
  command("external-gateway-plugin", "External Gateway runtime plugin verification", "foundation", npmRun("server:verify:external-gateway"), "", ["external-gateway", "plugin", "production-controls"]),
  command("agent-self-maintenance-plugin", "Independent Agent self-maintenance plugin verification", "foundation", nodeCommand(["tools/server-scripts/verify-agent-self-maintenance-runtime.ts"]), "", ["agent", "self-maintenance", "plugin"], {
    ownedReports: [
      "build/reports/maintenance-plugin-config-only.json",
      "build/reports/maintenance-plugin-one-way-meshrix-control.json",
      "build/reports/maintenance-plugin-direct-model-gateway.json",
      "build/reports/maintenance-plugin-backend-unreachable.json"
    ]
  }),
  command("integration-task-supervisor", "Optional integration lifecycle isolation", "foundation", npmRun("server:verify:integration-task-supervisor"), "build/reports/integration-task-supervisor.json", ["integration-lifecycle", "startup-isolation", "shutdown-isolation"]),
  command("workspace-asset-management", "Core workspace assets and governance verification", "foundation", nodeCommand(["tools/server-scripts/verify-workspace-asset-management.ts"]), "", ["workspace-assets", "workspace-governance"]),

  command("node-runtime-supply-chain", "Pinned Node runtime supply-chain verification", "downstream-gateway", npmRun("verify:node-runtime-supply-chain"), "build/reports/node-runtime-supply-chain.json", ["downstream-gateway", "runtime-supply-chain", "signature-verification"], { resourceLocks: ["node-runtime-official-download"] }),
  command("mcp-release-portable-assembly", "MCP release portable assembly", "downstream-gateway", npmRun("verify:mcp-release-portable-assembly"), "build/reports/mcp-release-portable-assembly.json", ["downstream-gateway", "release-artifact"], { dependsOn: ["node-runtime-supply-chain"] }),
  command("mcp-installer-convergence", "MCP installer convergence", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-mcp-installer-convergence.ts"]), "build/reports/mcp-installer-convergence.json", ["downstream-gateway", "installer"]),
  command("mcp-release-target-scope", "MCP release target scope", "downstream-gateway", nodeCommand(["tools/server-scripts/verify-mcp-release-target-scope.ts"]), "build/reports/mcp-release-target-scope.json", ["downstream-gateway", "release-targets"]),
  command("downstream-mcp-audit", "Downstream MCP completeness audit", "downstream-gateway", npmRun("verify:downstream-mcp-audit"), "build/reports/downstream-mcp-completeness-audit.json", ["downstream-gateway", "completeness"]),

  command("upstream-service-publishing", "Upstream service publishing", "upstream-gateway", npmRun("verify:upstream-service-publishing"), "build/reports/upstream-service-publishing.json", ["upstream-gateway", "service-publishing", "protocol-delivery"]),
  command("upstream-gateway-e2e", "Governed upstream gateway E2E", "upstream-gateway", npmRun("verify:upstream-gateway"), "build/reports/upstream-gateway-e2e.json", ["upstream-gateway", "local-fixture-upstream"]),
  command("upstream-mcp-gateway", "Upstream MCP gateway E2E", "upstream-gateway", npmRun("verify:upstream-mcp-gateway"), "build/reports/upstream-mcp-gateway-e2e.json", ["upstream-gateway", "mcp"]),
  command("upstream-fixture-transit", "Self-contained upstream fixture REST and MCP transit", "upstream-gateway", npmRun("verify:upstream-fixture-transit"), "build/reports/upstream-fixture-transit.json", ["upstream-gateway", "self-contained-fixture", "credential-injection"]),

  command("production-readiness-gates", "Server security production gates", "platform-capability", nodeCommand(["tools/server-scripts/production-readiness-gate.ts"]), "build/reports/production-readiness-gates.json", ["platform-capability", "security", "server-readiness"], {
    blockedExitCodes: [2],
    resourceLocks: ["production-readiness-reports"]
  }),
  command("path-abstraction-audit", "Path abstraction and sandbox audit", "platform-capability", npmRun("verify:path-abstraction-audit"), "build/reports/path-abstraction-audit.json", ["platform-capability", "path-sandbox"]),
  command("controlled-execution-sandbox", "Controlled execution sandbox contract verification", "platform-capability", npmRun("verify:controlled-execution-sandbox"), "build/reports/controlled-execution-sandbox.json", ["platform-capability", "execution-sandbox", "default-deny", "no-host-fallback"], {
    ownedReports: [
      "build/reports/execution-sandbox-oci-conformance.json",
      "build/reports/opaque-sandbox-custody.json",
      "build/reports/execution-launcher-boundary.json"
    ],
    resourceLocks: ["container-runtime", "foundation-public-gate"]
  }),
  command("controlled-execution-convergence-final", "Controlled Execution Convergence final reduction", "platform-capability", npmRun("verify:controlled-execution-convergence"), "build/reports/controlled-execution-convergence-final.json", ["platform-capability", "execution-sandbox", "exact-release-candidate"], { dependsOn: ["controlled-execution-sandbox"] }),
  command("enterprise-governance-coverage", "Enterprise authorization governance coverage", "platform-capability", npmRun("verify:authorization-governance"), "build/reports/enterprise-governance-coverage.json", ["platform-capability", "authorization", "governance"]),
  command("operation-permission-protocol-consistency", "Operation Permission protocol consistency", "platform-capability", npmRun("verify:operation-permission-protocol-consistency"), "build/reports/operation-permission-protocol-consistency.json", ["platform-capability", "operation-permission"]),
  command("operation-permission-tag-governed-e2e", "Operation Permission tag-governed capability E2E", "platform-capability", npmRun("verify:operation-permission-tag-governed-e2e"), "build/reports/operation-permission-tag-governed-e2e.json", ["platform-capability", "operation-permission", "tag-policy"], { dependsOn: ["controlled-execution-convergence-final"], resourceLocks: ["container-runtime"] }),
  command("operation-permission-domain-model", "Operation Permission domain model", "platform-capability", npmRun("verify:operation-permission-domain-model"), "build/reports/operation-permission-domain-model.json", ["platform-capability", "operation-permission", "domain-model"]),
  command("approval-governance", "Approval governance terminal outcomes", "platform-capability", npmRun("verify:approval-governance"), "build/reports/approval-governance.json", ["platform-capability", "authorization", "approval"]),
  command("audit-retention-redaction", "Enterprise audit retention and redaction", "platform-capability", npmRun("verify:enterprise-audit-retention-redaction"), "build/reports/enterprise-audit-retention-redaction.json", ["platform-capability", "audit", "redaction"]),
  command("observability-semantics", "Observability semantic release gate", "platform-capability", nodeCommand(["tools/server-scripts/verify-observability-semantics.ts", "--gate", "release"]), "build/reports/observability-semantics.json", ["platform-capability", "observability"]),
  command("observability-runtime", "Executive report retention system inspection and production health runtime", "platform-capability", nodeCommand(["tools/server-scripts/verify-observability-runtime-acceptance.ts"]), "build/reports/observability-runtime-acceptance.json", ["platform-capability", "observability", "executive-report", "system-inspection", "production-health"]),
  command("production-health-console", "Production health console verification", "platform-capability", nodeCommand(["tools/server-scripts/verify-production-health-console.ts"]), "", ["platform-capability", "observability", "console"]),
  command("authorization-enforcement", "Enterprise authorization enforcement", "platform-capability", npmRun("verify:enterprise-authorization-enforcement"), "build/reports/enterprise-authorization-enforcement.json", ["platform-capability", "authorization"], { dependsOn: ["enterprise-governance-coverage", "operation-permission-protocol-consistency", "operation-permission-tag-governed-e2e"] }),
  command("observability-coverage", "Enterprise observability coverage", "platform-capability", npmRun("verify:enterprise-observability-coverage"), "build/reports/enterprise-observability-coverage.json", ["platform-capability", "observability"], { dependsOn: ["audit-retention-redaction", "observability-semantics", "observability-runtime", "operation-permission-tag-governed-e2e"] }),
  command("storage-restore", "Storage production restore drill", "platform-capability", nodeCommand(["tools/server-scripts/verify-storage-production-restore-drill.ts"]), "build/reports/storage-production-restore-drill/latest.json", ["platform-capability", "storage", "backup-restore"], { resourceLocks: ["storage-restore"] }),
  command("deployment-container-flow", "Fresh container deployment flow", "platform-capability", nodeCommand(["tools/server-scripts/verify-deployment-container-flow.ts"]), "build/reports/deployment-container-flow.json", ["platform-capability", "deployment", "container"], { dependsOn: ["npm-package-installability"], resourceLocks: ["container-runtime"] }),
  command("job-work-queue", "Job work queue verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-job-work-queue.ts"]), "build/reports/job-work-queue.json", ["platform-capability", "jobs"], { resourceLocks: ["work-queue"] }),
  command("job-work-queue-ceiling-conformance", "Job work queue ceiling conformance verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-job-work-queue-ceiling-conformance.ts"]), "build/reports/job-work-queue-ceiling-conformance.json", ["platform-capability", "jobs", "conformance"], { resourceLocks: ["work-queue"] }),
  command("work-queue-conformance", "Work queue conformance verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-work-queue-conformance.ts"]), "build/reports/work-queue/latest.json", ["platform-capability", "jobs"], { resourceLocks: ["work-queue"] }),
  command("work-queue-process-restart", "Work queue process restart verifier", "platform-capability", nodeCommand(["tools/server-scripts/verify-work-queue-process-restart.ts"]), "build/reports/work-queue-process-restart.json", ["platform-capability", "jobs", "restart"], { resourceLocks: ["work-queue"] }),
  command("upload-workspace-materialization", "Governed upload workspace materialization", "platform-capability", nodeCommand(["tools/server-scripts/verify-upload-workspace-materialization.ts"]), "build/reports/upload-workspace-materialization.json", ["platform-capability", "jobs", "workspace", "authorization"], { resourceLocks: ["work-queue"] }),
  command("console-redundancy", "Console redundancy audit", "platform-capability", npmRun("verify:console-redundancy"), "build/reports/console-redundancy.json", ["platform-capability", "console"]),
  command("console-administration", "Console administration workflow coverage", "platform-capability", npmRun("verify:console-administration-coverage"), "build/reports/console-administration-coverage.json", ["platform-capability", "console"]),
  command("console-admin-browser-visual", "Console admin browser visual coverage", "platform-capability", npmRun("verify:console-admin-browser-visual"), "build/reports/console-admin-browser-visual.json", ["platform-capability", "console", "browser"], { exclusive: true, resourceLocks: ["browser-visual"] }),
  command("console-gateway-mcp", "Console gateway and MCP workflows", "platform-capability", npmRun("verify:console-gateway-mcp-workflows"), "build/reports/console-gateway-mcp-workflows.json", ["platform-capability", "console", "gateway"], { dependsOn: ["upstream-gateway-e2e", "downstream-mcp-audit", "operation-permission-protocol-consistency", "operation-permission-tag-governed-e2e"] }),
  command("repo-organization", "Repository organization boundaries", "platform-capability", npmRun("verify:repo-organization"), "build/reports/repo-organization.json", ["platform-capability", "repository-organization"]),
  command("documentation-convergence", "Core platform documentation convergence", "platform-capability", npmRun("verify:core-platform-documentation-convergence"), "build/reports/core-platform-documentation-convergence.json", ["platform-capability", "documentation"]),
  command("surface-convergence", "Core platform surface convergence", "platform-capability", npmRun("verify:core-platform-surface-convergence"), "build/reports/core-platform-surface-convergence.json", ["platform-capability", "operation-surface"]),
  command("gap-audit", "Core platform gap audit", "platform-capability", npmRun("verify:platform-audit"), "build/reports/core-platform-gap-audit.json", ["platform-capability", "gap-audit"]),

  command("mcp-gateway-load", "MCP gateway load and resource cutoff profile", "profile", npmRun("server:stress:mcp-gateway"), "build/reports/mcp-gateway-load.json", ["profile", "downstream-gateway", "upstream-forwarding", "resource-cutoff"], { dependsOn: ["console-gateway-mcp"], resourceLocks: ["gateway-platform-profile", "container-runtime", "foundation-public-gate"] }),
  command("gateway-platform-profile", "Gateway platform performance profile", "profile", nodeCommand(["tools/server-scripts/stress-gateway-platform-profile.ts"]), "build/reports/gateway-platform-profile.json", ["profile", "downstream-gateway", "upstream-gateway"], { dependsOn: ["production-readiness-gates", "mcp-gateway-load", "upstream-fixture-transit", "path-abstraction-audit"], resourceLocks: ["gateway-platform-profile"] })
]);

export const PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS: readonly any[] = Object.freeze([
  "surface-convergence",
  "production-readiness-gates",
  "deployment-container-flow",
  "downstream-mcp-audit",
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
  "integration-task-supervisor",
  "job-work-queue",
  "work-queue-conformance",
  "work-queue-process-restart",
  "console-administration",
  "console-admin-browser-visual",
  "console-gateway-mcp",
  "gap-audit"
]);

const evidenceCommandById: any = new Map<any, any>(
  PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS.map((entry?: any) : any => [entry.id, entry])
);
const unknownPrivateDeploymentCommandIds: any = PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS
  .filter((commandId?: any) : any => !evidenceCommandById.has(commandId));
if (unknownPrivateDeploymentCommandIds.length > 0) {
  throw new Error(
    `Private deployment references unknown platform acceptance commands: ${unknownPrivateDeploymentCommandIds.join(",")}`
  );
}

export const PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS: any = Object.freeze(
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS.map((commandId?: any) : any => evidenceCommandById.get(commandId))
);
export const PRIVATE_DEPLOYMENT_REQUIRED_REPORTS: readonly any[] = Object.freeze([
  ...new Set<any>(PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS.flatMap((entry?: any) : any => entry.ownedReports || []))
]);

const PRIVATE_DEPLOYMENT_EVIDENCE_REDUCTION: any = command(
  "private-deployment-internal-platform-e2e",
  "Private deployment internal platform evidence reduction",
  "final-regression",
  nodeCommand([
    "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts",
    "--reduce-existing"
  ]),
  PRIVATE_DEPLOYMENT_INTERNAL_PLATFORM_E2E_REPORT_PATH,
  ["final-regression", "private-deployment", "internal-platform"],
  {
    blockedExitCodes: [2],
    dependsOn: PRIVATE_DEPLOYMENT_EVIDENCE_COMMAND_IDS,
    exclusive: true,
    resourceLocks: ["release-final-regression", "report-tree:build/reports"]
  }
);

export const PLATFORM_ACCEPTANCE_COMMANDS: readonly any[] = Object.freeze([
  ...PLATFORM_ACCEPTANCE_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_EVIDENCE_REDUCTION
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
