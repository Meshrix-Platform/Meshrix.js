#!/usr/bin/env node
/**
 * verify-script-registry.ts — Script Registry Coverage & Consistency Verifier
 *
 * Validates:
 * 1. Every package.json#scripts entry is either registered or in the allowlist
 * 2. Raw explicit registry commands are canonical npm aliases and their package.json commands exist
 * 3. Pattern-classified entries get real package.json commands (not fake npm run)
 * 4. Scripts referenced by test-suite-registry are registered
 * 5. Server:verify composite scripts' sub-scripts are registered
 * 6. Scripts with sideEffects=docker/network-service are excluded from default profiles
 * 7. Scripts requiring fresh containers are excluded from core/fast profiles
 * 8. server:verify:* sub-scripts are all isClassified()
 *
 * Generates: build/reports/script-registry.json
 *
 * Usage:
 *   node tests/verify-script-registry.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scanPublicArtifactFiles } from "../tools/server-scripts/lib/public-artifact-boundary.ts";
import { packageIncludedMismatches } from "../tools/scripts/package-layout-verification.ts";
import {
  REQUIRED_REPORT_REDUCERS,
  requiredReportSpec
} from "../tools/server-scripts/lib/required-report-validator.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const packageJson: any = JSON.parse(
  await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
);
const allScripts: any = Object.keys(packageJson.scripts || {});
const packageScripts: any = packageJson.scripts || {};
const npmCommand: any = process.platform === "win32" ? "npm.cmd" : "npm";
const FORBIDDEN_PACKAGED_INTERNAL_PATH_PATTERN: any =
  /(^|\/)docs\/(?:plan|report|decisions)(?:\/|$)/u;

// Import script registry
const scriptRegUrl: any = pathToFileURL(
  path.join(repoRoot, "tools/scripts/package-script-registry.ts")
).href;
const scriptReg: any = await import(scriptRegUrl);
const { createReleaseEvidenceReadiness } = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/lib/release-evidence-readiness.ts")
).href);
const { validateFactSourceAuthorityFindings } = await import(pathToFileURL(
  path.join(repoRoot, "tools/verifiers/registry-fact-source-authority.ts")
).href);
const {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-platform-acceptance.ts")
).href);
const {
  createReleaseCommandSchedule
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/lib/release-command-dag-runner.ts")
).href);
const {
  UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH,
  UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES,
  UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts")
).href);
const {
  UPSTREAM_MCP_GATEWAY_REPORT_PATH,
  UPSTREAM_MCP_GATEWAY_REQUIRED_TEST_NAMES
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/lib/upstream-mcp-gateway-evidence.ts")
).href);
const {
  DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH,
  DOWNSTREAM_AGENT_CLIENT_TARGETS,
  DOWNSTREAM_AGENT_CANCELLATION_TARGET,
  DOWNSTREAM_AGENT_CORE_TURN_IDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts")
).href);
const {
  MCP_SUPPORTED_TARGETS
} = await import(pathToFileURL(
  path.join(repoRoot, "packages/protocols/mcp/adapter/mcp-release-targets.ts")
).href);
const {
  SERVER_VERIFY_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-server-runtime.ts")
).href);
const {
  SERVER_HEADLESS_VERIFY_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-server-headless.ts")
).href);
const {
  SERVER_CHECKPOINTS_VERIFY_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-server-checkpoints.ts")
).href);
const {
  SERVER_OPS_VERIFY_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-server-ops.ts")
).href);
const {
  SERVER_REBUILD_VERIFY_COMMANDS
} = await import(pathToFileURL(
  path.join(repoRoot, "tools/server-scripts/verify-server-rebuild.ts")
).href);

const suiteRegistry: any = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tools/registry/tests.registry.json"), "utf8")
);
const repoLayoutRegistry: any = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tools/registry/repo-layout.registry.json"), "utf8")
);

function registeredReleaseReportFixture(reportPath?: any, report: Record<string, any> = {}) : any {
  const spec: any = requiredReportSpec(reportPath);
  if (!spec) {
    throw new Error(`Required report fixture is not registered: ${reportPath}`);
  }
  return {
    ...report,
    schemaVersion: spec.schemaVersion,
    verifier: spec.verifier,
    [spec.timestampField]: new Date().toISOString(),
    summary: {
      reportLeakScan: true,
      ...(report.summary || {})
    }
  };
}

function registeredRepoOrganizationReportFixture(overrides: Record<string, any> = {}) : any {
  const base: Record<string, any> = {
    summary: {
      releaseReady: true,
      reportLeakScan: true,
      policyContractVerified: true,
      lineCountGateStatus: "disabled",
      machineEnforcedRuleCount: 1,
      reviewOnlySignalCount: 1,
      sourceOrganizationDiscoveredFileCount: 0,
      sourceOrganizationAnalyzedFileCount: 0,
      sourceOrganizationUnsupportedFileCount: 0,
      sourceOrganizationParseFailureCount: 0,
      sourceOrganizationSplitCandidateCount: 0,
      sourceOrganizationMechanicalSplitCautionCount: 0,
      releaseBlockingFindingCount: 0,
      releaseBlockingWarningCount: 0,
      missingRequiredFileCount: 0
    },
    policy: {
      sourceOfTruth: "tools/registry/repo-layout.registry.json#repoOrganizationAudit.sourceFileOrganization",
      canonicalDocument: "docs/architecture/ARCHITECTURE.md#source-file-organization",
      lineCountGate: { status: "disabled", threshold: null, releaseBlocking: false },
      decisionBasis: ["responsibility"],
      machineEnforcedRules: [{ id: "runnable_entrypoint_ownership", releaseBlocking: true }],
      delegatedGateIds: ["architecture.import-graph"],
      reviewOnlySignals: [{ id: "file_length", collectedByThisReport: false, releaseBlocking: false }],
      astAdvisory: { mode: "advisory", releaseBlocking: false }
    },
    sourceOrganizationAnalysis: {
      mode: "advisory",
      releaseBlocking: false,
      status: "completed",
      engine: { id: "typescript-compiler-api", version: "fixture" },
      algorithm: { id: "fixture", complexity: "O(n)" },
      limitations: ["Automated analysis cannot prove a safe split."],
      selfTest: { passed: true },
      summary: {
        discoveredFileCount: 0,
        analyzedFileCount: 0,
        unsupportedFileCount: 0,
        parseFailureCount: 0,
        skippedProjectionFileCount: 0,
        splitCandidateCount: 0,
        mechanicalSplitCautionCount: 0,
        noStructuralSignalCount: 0,
        durationMs: 0
      },
      unsupportedByReason: {},
      splitCandidates: [],
      mechanicalSplitCautions: [],
      parseFailures: []
    }
  };
  return registeredReleaseReportFixture("build/reports/repo-organization.json", {
    ...base,
    ...overrides,
    summary: {
      ...base.summary,
      ...(overrides.summary || {})
    }
  });
}

let issues: any = 0;
const commandMismatches: any[] = [];
const explicitEntries: any[] = [];
const patternMatchedEntries: any[] = [];
const allowlistedEntries: any[] = [];
const releaseStrictnessFindings: any[] = [];
const releaseSourceOfTruthFindings: any[] = [];
const releaseProfileReadinessFindings: any[] = [];
const mcpReleaseTargetSourceOfTruthFindings: any[] = [];
const packagePackFindings: any[] = [];
const factSourceAuthorityFindings: any[] = [];

const RELEASE_CHAIN_SOURCES: readonly any[] = Object.freeze([
  "tools/server-scripts/verify-platform-acceptance.ts",
  "tools/server-scripts/production-readiness-gate.ts"
]);
const PLATFORM_ACCEPTANCE_SOURCE: any =
  "tools/server-scripts/verify-platform-acceptance.ts";
const PLATFORM_ACCEPTANCE_COMMAND_CATALOG_SOURCE: any =
  "tools/server-scripts/lib/platform-acceptance-command-catalog.ts";
const PRIVATE_DEPLOYMENT_INTERNAL_PLATFORM_E2E_CATALOG_SOURCE: any =
  "tools/server-scripts/lib/private-deployment-internal-platform-e2e-catalog.ts";
const FACT_SOURCE_AUTHORITY_REGISTRY: any = "tools/registry/fact-source-authority.registry.json";
const REQUIRED_FACT_AUTHORITY_PATHS: readonly any[] = Object.freeze([
  "packages/contracts/src/operations/operation-registry.ts",
  "tools/server-scripts/lib/release-evidence-readiness.ts",
  "tools/server-scripts/verify-platform-acceptance.ts",
  PLATFORM_ACCEPTANCE_COMMAND_CATALOG_SOURCE,
  "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts",
  "tools/server-scripts/lib/upstream-mcp-gateway-evidence.ts",
  "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts",
  "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts",
  "packages/protocols/mcp/adapter/mcp-release-targets.ts",
  "packages/foundation/src/security/process-identity/index.ts",
  "tools/server-scripts/package-server-source.ts",
  "tools/scripts/package-script-registry.ts",
  "tools/registry/internal-platform-capability-matrix.json"
]);
const REQUIRED_FACT_AUTHORITY_KEYS: Readonly<Record<string, any>> = Object.freeze({
  "server.operations": "packages/contracts/src/operations/operation-registry.ts",
  "process-identity.runtime-contract": "packages/foundation/src/security/process-identity/index.ts",
  "release.readiness-reduction": "tools/server-scripts/lib/release-evidence-readiness.ts",
  "platform.acceptance-workflow": "tools/server-scripts/verify-platform-acceptance.ts",
  "private-deployment.internal-platform-e2e-catalog": PLATFORM_ACCEPTANCE_COMMAND_CATALOG_SOURCE,
  "upstream-fixture.transit-evidence": "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts",
  "upstream-mcp.gateway-evidence": "tools/server-scripts/lib/upstream-mcp-gateway-evidence.ts",
  "downstream-agent.tool-loop-evidence": "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts",
  "mcp-client.proxy-transport-evidence": "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts",
  "mcp-release.targets": "packages/protocols/mcp/adapter/mcp-release-targets.ts",
  "composition.source-package": "tools/server-scripts/package-server-source.ts",
  "package-scripts.classification": "tools/scripts/package-script-registry.ts",
  "internal-platform.capability-surface": "tools/registry/internal-platform-capability-matrix.json"
});
const RELEASE_PROFILE_SOURCES: readonly any[] = Object.freeze([
  "tools/server-scripts/stress-gateway-platform-profile.ts"
]);
const MCP_RELEASE_TARGET_CONSUMER_SOURCES: readonly any[] = Object.freeze([
  "packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts",
  "packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts",
  "tools/server-scripts/verify-mcp-release-target-scope.ts"
]);
const REPORT_ONLY_SCRIPT_PATTERN: any = /(?::report|:audit:report)$/u;
const REPORT_ONLY_FLAG_PATTERN: any = /--(?:allow-open-gaps|report-only)\b/u;
const RELEASE_EVIDENCE_READINESS_HELPER: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts";
const RELEASE_EVIDENCE_FRESHNESS_HELPER: any =
  "tools/server-scripts/lib/release-evidence-freshness.ts";
const UPSTREAM_FIXTURE_TRANSIT_HELPER_PATTERN: any = /createUpstreamFixtureTransitReadiness/u;
const UPSTREAM_MCP_GATEWAY_HELPER_PATTERN: any = /createUpstreamMcpGatewayReadiness/u;
const DOWNSTREAM_AGENT_TOOL_LOOP_HELPER_PATTERN: any = /createDownstreamAgentToolLoopReadiness/u;
const PLATFORM_ACCEPTANCE_REPORT_CATALOG_IMPORT_PATTERN: any = /platform-acceptance-report-catalog\.ts/u;
const RELEASE_AGGREGATOR_FULL_AGGREGATION_PATTERN: any = /commandExecutionMode:\s*["']dag-parallel-full-aggregation["']/u;
const RELEASE_COMMAND_DAG_RUNNER_IMPORT_PATTERN: any = /release-command-dag-runner\.ts/u;
const RELEASE_COMMAND_DAG_SCHEDULE_PATTERN: any = /commandSchedule/u;
const RELEASE_COMMAND_DAG_CHILD_PROCESS_PATTERN: any = /spawn\s*\(/u;
const RELEASE_AGGREGATOR_FAIL_FAST_PATTERN: any =
  /for\s*\(\s*const\s+command\s+of\s+COMMANDS\s*\)\s*\{[\s\S]{0,600}result\.status\s*!==\s*["']passed["'][\s\S]{0,160}break\s*;/u;
const GATEWAY_PLATFORM_PROFILE_STRICT_EXIT_PATTERN: any =
  /if\s*\(\s*!report\.summary\.releaseReady\s*\)\s*\{\s*process\.exitCode\s*=\s*1\s*;/u;
const RELEASE_PROFILE_AGGREGATE_REDUCER_PATTERN: any =
  /createAggregateReleaseEvidenceReadiness/u;
const RELEASE_PROFILE_SUMMARY_SOURCE_PATTERN: any =
  /releaseReadinessSourceOfTruth:\s*aggregateReadiness\.sourceOfTruth/u;
const RELEASE_PROFILE_FRESHNESS_HELPER_PATTERN: any =
  /release-evidence-freshness\.ts/u;
const RELEASE_PROFILE_CANONICAL_CONSUMPTION_PATTERN: any =
  /consumedCanonicalReport:\s*true/u;
const RELEASE_PROFILE_CHILD_LEAK_SCAN_MISSING_EVIDENCE_PATTERN: any =
  /report-leak-scan-not-passed/u;
const RELEASE_PROFILE_AGGREGATE_LEAK_SCAN_PATTERN: any =
  /reportLeakScan:\s*reportLeakScanReady/u;
const MCP_GATEWAY_LOAD_RESOURCE_CUTOFF_REASON_PATTERN: any = /resource-safety-cutoff/u;
const MCP_GATEWAY_LOAD_INCOMPLETE_PHASE_REASON_PATTERN: any = /phase-incomplete/u;
const MCP_GATEWAY_LOAD_SUMMARY_LEAK_SCAN_PATTERN: any = /reportLeakScan:\s*true/u;
const RELEASE_EVIDENCE_READINESS_IMPORT_PATTERN: any = /release-evidence-readiness\.ts/u;
const RELEASE_EVIDENCE_READINESS_REDUCER_PATTERN: any =
  /createReleaseEvidenceReadiness|releaseEvidenceReady/u;
const AGGREGATE_RELEASE_EVIDENCE_READINESS_PATTERN: any = /createAggregateReleaseEvidenceReadiness/u;
const RELEASE_EVIDENCE_FRESHNESS_PATTERN: any = /release-evidence-freshness\.ts/u;
const PLATFORM_ACCEPTANCE_REPORT_RESET_PATTERN: any = /ACCEPTANCE_REQUIRED_REPORTS\.map\(removeReport\)/u;
const PLATFORM_ACCEPTANCE_TIMESTAMP_VALIDATION_PATTERN: any = /minimumTimestampMs/u;
const MCP_RELEASE_TARGET_SOURCE_PATTERN: any = /mcp-release-targets\.ts/u;
const MCP_RELEASE_TARGET_HARDCODED_LIST_PATTERN: any = new RegExp(
  `\\[\\s*${MCP_SUPPORTED_TARGETS.map((target?: any) : any => `["']${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).join("\\s*,\\s*")}\\s*\\]`,
  "u"
);
const GENERIC_PRODUCTION_BLOCKED_SKIP_PATTERN: any =
  /if\s*\(\s*evidence\.productionReleaseReady\s*===\s*false\s*\|\|\s*evidence\.productionReleaseStatus\s*===\s*["']blocked["']\s*\)\s*\{\s*continue\s*;/u;
const RAW_REPORT_PRODUCTION_FALLBACK_PATTERN: any =
  /report\.productionReleaseReady\s*\?\?|report\.summary\?\.productionReleaseReady\s*\?\?|report\.productionReleaseStatus\s*\|\||report\.summary\?\.productionReleaseStatus\s*\|\|/u;
const PRIVATE_REDUCER_ONLY_PATTERN: any =
  /commandExecutionMode:\s*["']platform-acceptance-existing-evidence-reduction["']/u;
const OPEN_DIRECT_AGGREGATE_RELEASE_READY_PATTERN: any =
  /releaseReady\s*=\s*failedCommands\.length\s*===\s*0\s*&&\s*missingEvidence\.length\s*===\s*0/u;
const PRODUCTION_GATE_REDUCER_CONTEXT_PATTERN: any =
  /createReleaseEvidenceReadiness\(\s*PRODUCTION_READINESS_GATES_REPORT_PATH\s*,\s*report\s*\)/u;
const PRODUCTION_GATE_DIRECT_PRODUCTION_READY_EXIT_PATTERN: any =
  /productionReadiness\.productionReleaseReady\s*!==\s*true/u;
const PRODUCTION_GATE_SUMMARY_MISSING_EVIDENCE_PATTERN: any =
  /missingEvidenceCount:\s*missingEvidence\.length[\s\S]{0,120}missingEvidence/u;
const PRODUCTION_GATE_PROJECTION_ONLY_PATTERN: any =
  /projectionOnly:\s*true/u;
const SOURCE_PATH_PATTERN: any = /^(?:apps|content|docs|packages|plugins|tests|tools)\/.+\.(?:cjs|css|html|js|json|mjs|svg|ts|tsx|vue|yaml|yml)$/u;
const ROOT_SOURCE_PATHS: any = new Set<any>([
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts"
]);

function normalizePackPath(value: any = "") : any {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/^\.\//u, "")
    .split(path.sep)
    .join("/");
}

function escapeRegExp(value: any = "") : any {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageScriptSourcePaths(command: any = "") : any {
  const paths: any = new Set<any>();
  const sourceArgPattern: any = /(?:^|\s)(?:node|vitest|tsx|ts-node|bash|sh)\s+(?!-[^\s]*\s)(["']?[^"'`\s]+\.(?:cjs|js|json|mjs|sh|ts|tsx)["']?)/gu;
  const configArgPattern: any = /(?:--config|-p|--project)\s+["']?([^"'`\s]+\.(?:json|ts|js|mjs))["']?/gu;
  for (const pattern of [sourceArgPattern, configArgPattern]) {
    for (const match of command.matchAll(pattern)) {
      const normalized: any = normalizePackPath(match[1]);
      if (SOURCE_PATH_PATTERN.test(normalized) || ROOT_SOURCE_PATHS.has(normalized)) {
        paths.add(normalized);
      }
    }
  }
  return [...paths];
}

function suiteSourcePaths(suite: Record<string, any> = {}) : any {
  return (Array.isArray(suite.args) ? suite.args : [])
    .map(normalizePackPath)
    .filter((candidate?: any) : any => SOURCE_PATH_PATTERN.test(candidate) || ROOT_SOURCE_PATHS.has(candidate));
}

function isSafeRepoRelativePath(value: any = "") : any {
  const normalized: any = normalizePackPath(value);
  return Boolean(normalized) &&
    !normalized.startsWith("/") &&
    !/^[a-z]+:\/\//iu.test(normalized) &&
    !/^[A-Za-z]:\\/u.test(normalized) &&
    !normalized.split("/").includes("..");
}

async function pathExists(relativePath?: any) : Promise<any> {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function validateFactSourceAuthorityRegistry() : Promise<any> {
  let registry: any;
  try {
    registry = await readJson(FACT_SOURCE_AUTHORITY_REGISTRY);
  } catch (error: any) {
    factSourceAuthorityFindings.push({
      source: FACT_SOURCE_AUTHORITY_REGISTRY,
      kind: "registry-unreadable",
      detail: error.message
    });
    return;
  }

  factSourceAuthorityFindings.push(...await validateFactSourceAuthorityFindings(registry, {
    rootDir: repoRoot,
    registryPath: FACT_SOURCE_AUTHORITY_REGISTRY
  }));

  const authorities: any = Array.isArray(registry.authorities) ? registry.authorities : [];
  if (authorities.length === 0) {
    return;
  }

  const authorityPaths: any = new Set<any>(authorities.map((authority?: any) : any =>
    normalizePackPath(authority.authorityPath)
  ).filter(Boolean));

  for (const requiredPath of REQUIRED_FACT_AUTHORITY_PATHS) {
    if (!authorityPaths.has(requiredPath)) {
      factSourceAuthorityFindings.push({
        source: FACT_SOURCE_AUTHORITY_REGISTRY,
        kind: "required-authority-missing",
        detail: requiredPath
      });
    }
  }

  const authorityPathByFactKey: any = new Map<any, any>(authorities.map((authority?: any) : any => [
    String(authority.factKey || "").trim(),
    normalizePackPath(authority.authorityPath)
  ]));
  for (const [requiredFactKey, requiredPath] of (Object.entries(REQUIRED_FACT_AUTHORITY_KEYS) as [string, any][])) {
    const authorityPath: any = authorityPathByFactKey.get(requiredFactKey);
    if (authorityPath !== requiredPath) {
      factSourceAuthorityFindings.push({
        source: FACT_SOURCE_AUTHORITY_REGISTRY,
        kind: "required-fact-key-authority-mismatch",
        detail: `${requiredFactKey}: expected ${requiredPath}, found ${authorityPath || "(missing factKey)"}`
      });
    }
  }

}

function validateCommandReportCatalogConsistency({ source, commands, requiredReports }: Record<string, any>) : any {
  const requiredReportSet: any = new Set<any>((Array.isArray(requiredReports) ? requiredReports : [])
    .map(normalizePackPath)
    .filter(Boolean));
  const reportOwners: any = new Map<any, any>();
  for (const command of Array.isArray(commands) ? commands : []) {
    const report: any = normalizePackPath(command.report);
    if (report) {
      const previousOwner: any = reportOwners.get(report);
      if (previousOwner) {
        releaseSourceOfTruthFindings.push({
          source,
          kind: "catalog-command-report-not-unique",
          detail: `${previousOwner} and ${command.id || "(missing command id)"} both write ${report}`
        });
      } else {
        reportOwners.set(report, command.id || "(missing command id)");
      }
    }
    if (!report || requiredReportSet.has(report)) {
      continue;
    }
    releaseSourceOfTruthFindings.push({
      source,
      kind: "catalog-command-report-not-required",
      detail: `${command.id || "(missing command id)"} reports ${report}, but that report is not in the same catalog's required report list`
    });
  }
}

function validateReleaseDagCatalogConsistency({ source, commands }: Record<string, any>) : any {
  const commandList: any = Array.isArray(commands) ? commands : [];
  const schedule: any = createReleaseCommandSchedule(commandList);
  if (schedule.valid !== true) {
    releaseSourceOfTruthFindings.push({
      source,
      kind: "release-command-dag-invalid",
      detail: JSON.stringify({
        duplicateIds: schedule.duplicateIds,
        duplicateReportFindings: schedule.duplicateReportFindings,
        missingDependencyFindings: schedule.missingDependencyFindings,
        selfDependencyFindings: schedule.selfDependencyFindings,
        cycleFindings: schedule.cycleFindings
      })
    });
  }
  for (const command of commandList) {
    const id: any = String(command.id || "(missing command id)");
    if (!String(command.layer || "").trim()) {
      releaseSourceOfTruthFindings.push({
        source,
        kind: "release-command-layer-missing",
        detail: id
      });
    }
    if (!Array.isArray(command.dependsOn)) {
      releaseSourceOfTruthFindings.push({
        source,
        kind: "release-command-depends-on-missing",
        detail: id
      });
    }
    if (!Array.isArray(command.resourceLocks)) {
      releaseSourceOfTruthFindings.push({
        source,
        kind: "release-command-resource-locks-missing",
        detail: id
      });
    }
    if (command.report && !command.resourceLocks.includes(`report:${command.report}`)) {
      releaseSourceOfTruthFindings.push({
        source,
        kind: "release-command-report-lock-missing",
        detail: `${id}:${command.report}`
      });
    }
  }
}

// ── Check 1: Full coverage of package.json#scripts ──────────────────────────
console.log("1. Checking package.json#scripts full coverage...");

for (const scriptName of allScripts) {
  if (scriptReg.SCRIPT_REGISTRY[scriptName]) {
    explicitEntries.push(scriptName);
  } else if (scriptReg.UNCLASSIFIED_ALLOWLIST.includes(scriptName)) {
    allowlistedEntries.push(scriptName);
  } else if (scriptReg.isClassified(scriptName)) {
    // Pattern-classified
    patternMatchedEntries.push(scriptName);
  } else {
    console.error(`  UNREGISTERED: ${scriptName}`);
    issues++;
  }
}

const unregistered: any = allScripts.filter((s?: any) : any => !scriptReg.isClassified(s));
if (unregistered.length > 0) {
  console.error(`  UNREGISTERED scripts (${unregistered.length}):`);
  for (const s of unregistered.slice(0, 20)) {
    console.error(`    - ${s}`);
  }
  if (unregistered.length > 20) {
    console.error(`    ... and ${unregistered.length - 20} more`);
  }
} else {
  console.log(`   OK: All ${allScripts.length} package scripts are classified`);
  console.log(`      Explicit: ${explicitEntries.length} | Pattern-matched: ${patternMatchedEntries.length} | Allowlisted: ${allowlistedEntries.length}`);
}

// ── Check 2: Command authority delegation (explicit entries) ────────────────
console.log("2. Checking raw registry command aliases and package.json authority...");

for (const scriptName of explicitEntries) {
  const entry: any = scriptReg.getDeclaredEntry(scriptName);
  const pkgCommand: any = packageScripts[scriptName];
  const expectedAlias: any = `npm run ${scriptName}`;

  if (entry.command !== expectedAlias || typeof pkgCommand !== "string" || !pkgCommand.trim()) {
    commandMismatches.push({
      scriptName,
      registryCommand: entry.command,
      packageCommand: pkgCommand,
    });
    console.error(`  MISMATCH: ${scriptName}`);
    console.error(`    Registry alias: ${entry.command}`);
    console.error(`    Expected alias: ${expectedAlias}`);
    issues++;
  }
}

// For pattern-classified entries, verify the real package.json command is populated
// (rather than the fake "npm run ${scriptName}" placeholder)
for (const scriptName of patternMatchedEntries) {
  const entry: any = scriptReg.getEntry(scriptName, packageScripts);
  if (entry && entry.command === `npm run ${scriptName}` && packageScripts[scriptName] !== `npm run ${scriptName}`) {
    // Pattern entry has fake command — flag as info (not error, because pattern entries
    // don't have explicit command registration)
    console.log(`   INFO: Pattern-classified "${scriptName}" uses generic command placeholder; real command is: ${packageScripts[scriptName]}`);
  }
}

if (commandMismatches.length === 0) {
  console.log(`   OK: All ${explicitEntries.length} explicit entries delegate execution to package.json through canonical npm aliases`);
}

// ── Check 3: Test suite references are all registered ───────────────────────
console.log("3. Checking test suite registry script references...");
const suiteScriptRefs: any = new Set<any>();
for (const suite of suiteRegistry.suites || []) {
  if (!suite.command || !Array.isArray(suite.args)) {
    console.error(`  SUITE WITHOUT COMMAND: ${suite.id}`);
    issues++;
    continue;
  }
  if (suite.command.endsWith("npm") || suite.command.endsWith("npm.cmd")) {
    const runIdx: any = suite.args.indexOf("run");
    if (runIdx >= 0 && runIdx + 1 < suite.args.length) {
      suiteScriptRefs.add(suite.args[runIdx + 1]);
    }
  }
}

const missing: any = [...suiteScriptRefs].filter(
  (s?: any) : any => !scriptReg.isClassified(s)
);
if (missing.length > 0) {
  console.error(`  MISSING suite script references:`);
  for (const s of missing) {
    console.error(`    - ${s}`);
  }
  issues += missing.length;
} else {
  console.log(`   OK: All ${suiteScriptRefs.size} suite script references are registered`);
}

// ── Check 4: Server:verify composite sub-scripts registered ─────────────────
console.log("4. Checking server:verify composite scripts...");
const verifyPattern: any = /npm\s+run\s+(server:verify:[^\s"']+)/g;
const verifyCompositeScripts: any[] = [
  "server:verify", "server:verify:security-hardening",
];
const requiredServerRegressionGroups: readonly any[] = Object.freeze([
  {
    scriptName: "server:verify",
    commands: SERVER_VERIFY_COMMANDS,
    forbiddenScripts: []
  },
  {
    scriptName: "server:verify:headless",
    commands: SERVER_HEADLESS_VERIFY_COMMANDS,
    forbiddenScripts: []
  },
  {
    scriptName: "server:verify:checkpoints",
    commands: SERVER_CHECKPOINTS_VERIFY_COMMANDS,
    forbiddenScripts: []
  },
  {
    scriptName: "server:verify:ops",
    commands: SERVER_OPS_VERIFY_COMMANDS,
    forbiddenScripts: []
  },
  {
    scriptName: "server:verify:rebuild",
    commands: SERVER_REBUILD_VERIFY_COMMANDS,
    forbiddenScripts: []
  }
]);

let verifySubIssues: any = 0;
for (const compName of verifyCompositeScripts) {
  if (!allScripts.includes(compName)) continue;
  const scriptCmd: any = packageScripts[compName];
  const matches: any[] = [...scriptCmd.matchAll(verifyPattern)];
  for (const match of matches) {
    const subScript: any = match[1];
    if (!scriptReg.isClassified(subScript)) {
      console.error(`  UNREGISTERED sub-script in ${compName}: ${subScript}`);
      issues++;
      verifySubIssues++;
    }
  }
}
for (const group of requiredServerRegressionGroups) {
  if (!allScripts.includes(group.scriptName)) {
    console.error(`  MISSING package script: ${group.scriptName}`);
    issues++;
    verifySubIssues++;
    continue;
  }
  if (!scriptReg.isClassified(group.scriptName)) {
    console.error(`  UNREGISTERED server regression script: ${group.scriptName}`);
    issues++;
    verifySubIssues++;
  }
  const groupScripts: any = group.commands.map((entry?: any) : any => entry.script).filter(Boolean);
  for (const forbiddenScript of group.forbiddenScripts) {
    if (groupScripts.includes(forbiddenScript)) {
      console.error(`  ${group.scriptName} must not include ${forbiddenScript}`);
      issues++;
      verifySubIssues++;
    }
  }
  for (const entry of group.commands) {
    if (entry.script) {
      if (!allScripts.includes(entry.script)) {
        console.error(`  MISSING ${group.scriptName} sub-script: ${entry.script}`);
        issues++;
        verifySubIssues++;
        continue;
      }
      if (!scriptReg.isClassified(entry.script)) {
        console.error(`  UNREGISTERED ${group.scriptName} sub-script: ${entry.script}`);
        issues++;
        verifySubIssues++;
      }
      continue;
    }
    if (entry.file) {
      try {
        await fs.access(path.join(repoRoot, entry.file));
      } catch {
        console.error(`  MISSING ${group.scriptName} verifier file: ${entry.file}`);
        issues++;
        verifySubIssues++;
      }
    }
  }
}
if (verifySubIssues === 0) {
  console.log("   OK: All server regression entrypoints and sub-commands are classified");
}

// ── Check 5: sideEffects governance ─────────────────────────────────────────
console.log("5. Checking sideEffects governance...");
const dangerousSideEffectScripts: any = (Object.values(scriptReg.SCRIPT_REGISTRY) as any[])
  .filter((s?: any) : any => ["docker", "network-service", "destructive"].includes(s.sideEffects));

for (const entry of dangerousSideEffectScripts) {
  if (entry.ciProfile === "hygiene" || entry.ciProfile === "core") {
    console.error(`  ${entry.scriptName}: sideEffects=${entry.sideEffects} but ciProfile=${entry.ciProfile}`);
    issues++;
  }
}
console.log(`   OK: ${dangerousSideEffectScripts.length} docker/network-service/destructive scripts checked`);
for (const scriptName of ["mcp:install", "server:mcp:register"]) {
  const entry: any = scriptReg.getDeclaredEntry(scriptName);
  if (
    entry?.sideEffects !== "network-service" ||
    entry?.requiresFreshContainer !== true ||
    entry?.ciProfile !== "external"
  ) {
    console.error(`  ${scriptName}: installer/register side effects are understated`);
    issues++;
  }
}

// ── Check 6: Fresh container governance ─────────────────────────────────────
console.log("6. Checking fresh container governance...");
const freshContainerScripts: any = scriptReg.scriptsRequiringFreshContainer();
for (const entry of freshContainerScripts) {
  if (entry.ciProfile === "hygiene" || entry.ciProfile === "core") {
    console.error(`  ${entry.scriptName}: requiresFreshContainer but ciProfile=${entry.ciProfile}`);
    issues++;
  }
}
console.log(`   OK: ${freshContainerScripts.length} fresh-container scripts verified`);

// ── Check 7: No stale registry entries ──────────────────────────────────────
console.log("7. Checking for stale registry entries...");
const declarationGroups: any[] = [
  ["explicit", Object.keys(scriptReg.SCRIPT_REGISTRY)],
  ["pattern", scriptReg.PATTERN_CLASSIFIED_SCRIPT_NAMES],
  ["allowlist", scriptReg.UNCLASSIFIED_ALLOWLIST]
];
const declarationOwners: any = new Map<any, any>();
const duplicateDeclarations: any[] = [];
for (const [kind, names] of declarationGroups) {
  for (const scriptName of names) {
    const previousKind: any = declarationOwners.get(scriptName);
    if (previousKind) {
      duplicateDeclarations.push(`${scriptName}:${previousKind}:${kind}`);
    } else {
      declarationOwners.set(scriptName, kind);
    }
  }
}
const stale: any = [...declarationOwners.keys()].filter((scriptName?: any) : any => !allScripts.includes(scriptName));
if (stale.length > 0) {
  console.error("  STALE script declarations (not in package.json):");
  for (const s of stale) {
    console.error(`    - ${s}`);
  }
  issues += stale.length;
}
if (duplicateDeclarations.length > 0) {
  console.error("  DUPLICATE script declarations:");
  for (const declaration of duplicateDeclarations) {
    console.error(`    - ${declaration}`);
  }
  issues += duplicateDeclarations.length;
}
if (stale.length === 0 && duplicateDeclarations.length === 0) {
  console.log("   OK: Script declarations are current and uniquely owned");
}

// ── Check 7b: npm package must include directly referenced script sources ───
console.log("7b. Checking npm package script source closure...");
const npmPackCachePath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-npm-pack-cache-"));
const npmPackSpawnOptions: Readonly<Record<string, any>> = Object.freeze({
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
  env: {
    ...process.env,
    npm_config_cache: npmPackCachePath,
    NPM_CONFIG_CACHE: npmPackCachePath
  }
});
function parseNpmPackFiles(packOutputText: any = "", source: any = "npm pack") : any {
  let parsed: any;
  try {
    parsed = JSON.parse(packOutputText || "[]");
  } catch (error: any) {
    packagePackFindings.push({
      source,
      kind: "npm-pack-json-unreadable",
      detail: String(error?.message || error)
    });
    return [];
  }

  // npm 10 emits an array for --json, while npm 11 may group records by
  // workspace name. Normalize both shapes before the package-boundary checks.
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.files)) {
      return [parsed];
    }
    const groupedRecords: any = (Object.values(parsed) as any[]).flatMap((value?: any) : any => {
      if (Array.isArray(value)) {
        return value;
      }
      return value && typeof value === "object" && Array.isArray(value.files)
        ? [value]
        : [];
    });
    if (groupedRecords.length > 0) {
      return groupedRecords;
    }
  }
  packagePackFindings.push({
    source,
    kind: "npm-pack-json-shape-invalid",
    detail: "npm pack --json must contain one or more package records"
  });
  return [];
}

function assertNoInternalPackFiles(packRecords: any = [], source: any = "npm pack") : any {
  for (const record of packRecords) {
    for (const file of record.files || []) {
      const packedPath: any = normalizePackPath(file.path);
      if (FORBIDDEN_PACKAGED_INTERNAL_PATH_PATTERN.test(packedPath)) {
        packagePackFindings.push({
          source: `${record.name || source}:${packedPath}`,
          kind: "internal-file-packaged",
          detail: "published tarballs must not include docs/plans or docs/reports"
        });
      }
    }
  }
}

const packResult: any = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts", "--silent"], {
  ...npmPackSpawnOptions
});
if (packResult.status !== 0) {
  packagePackFindings.push({
    source: "npm pack --dry-run --json",
    kind: "npm-pack-dry-run-failed",
    detail: String(packResult.stderr || packResult.stdout || "npm pack failed").slice(-500)
  });
} else {
  let packedFiles: any = new Set<any>();
  const packOutput: any = parseNpmPackFiles(packResult.stdout, "npm pack --dry-run --json");
  assertNoInternalPackFiles(packOutput, "root npm pack");
  packedFiles = new Set<any>((packOutput[0]?.files || []).map((file?: any) : any => normalizePackPath(file.path)));
  for (const mismatch of packageIncludedMismatches(repoLayoutRegistry.entries, packedFiles)) {
    packagePackFindings.push({
      source: mismatch.name,
      kind: "repo-layout-package-inclusion-mismatch",
      detail: `declared=${mismatch.declaredPackageIncluded} actual=${mismatch.actualPackageIncluded}`
    });
  }
  const artifactBoundary: any = await scanPublicArtifactFiles(repoRoot, [...packedFiles], {
    localNeedles: [repoRoot],
    allowedGeneratedOutputSegments: ["dist"]
  });
  for (const finding of artifactBoundary.findings) {
    packagePackFindings.push({
      source: finding.relativePath,
      kind: `public-artifact-${finding.ruleId}`,
      detail: finding.line ? `line ${finding.line}` : "packaged file boundary violation"
    });
  }
  const requiredPackSources: any = new Set<any>(["package.json", ".gitignore"]);
  for (const command of (Object.values(packageScripts) as any[])) {
    for (const sourcePath of packageScriptSourcePaths(command)) {
      requiredPackSources.add(sourcePath);
    }
  }
  for (const suite of suiteRegistry.suites || []) {
    for (const sourcePath of suiteSourcePaths(suite)) {
      requiredPackSources.add(sourcePath);
    }
  }
  for (const requiredPath of [...requiredPackSources].sort()) {
    if (!packedFiles.has(requiredPath)) {
      packagePackFindings.push({
        source: requiredPath,
        kind: "package-script-source-missing-from-tarball",
        detail: "package scripts and test registry entries must not reference files omitted from npm pack"
      });
    }
  }
}
const workspacePackResult: any = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts", "--silent"], {
  ...npmPackSpawnOptions
});
await fs.rm(npmPackCachePath, { recursive: true, force: true }).catch(() : any => {});
if (workspacePackResult.status !== 0) {
  packagePackFindings.push({
    source: "npm pack --dry-run --json --workspaces",
    kind: "npm-workspace-pack-dry-run-failed",
    detail: String(workspacePackResult.stderr || workspacePackResult.stdout || "workspace npm pack failed").slice(-500)
  });
} else {
  assertNoInternalPackFiles(
    parseNpmPackFiles(workspacePackResult.stdout, "npm pack --dry-run --json --workspaces"),
    "workspace npm pack"
  );
}
if (packagePackFindings.length > 0) {
  for (const finding of packagePackFindings) {
    console.error(`  PACKAGE PACK SOURCE CLOSURE VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += packagePackFindings.length;
} else {
  console.log("   OK: npm package contains directly referenced package-script and test-registry sources");
}

// ── Check 8: Release chain must not use report-only or allow-open-gaps modes ──
console.log("8. Checking release-chain strictness...");
for (const relativePath of RELEASE_CHAIN_SOURCES.filter((source?: any) : any =>
  source !== "tools/server-scripts/production-readiness-gate.ts"
)) {
  const source: any = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  if (REPORT_ONLY_FLAG_PATTERN.test(source)) {
    releaseStrictnessFindings.push({
      source: relativePath,
      kind: "report-only-flag",
      detail: source.match(REPORT_ONLY_FLAG_PATTERN)?.[0] || ""
    });
  }

  const npmRunMatches: any = [...source.matchAll(/args:\s*\[\s*["']run["']\s*,\s*["']([^"']+)["']/gu)]
    .map((match?: any) : any => match[1]);
  const commandStringMatches: any = [...source.matchAll(/npm\s+run\s+([^\s"'`]+)/gu)]
    .map((match?: any) : any => match[1]);
  for (const scriptName of [...new Set<any>([...npmRunMatches, ...commandStringMatches])]) {
    const packageCommand: any = packageScripts[scriptName] || "";
    if (REPORT_ONLY_SCRIPT_PATTERN.test(scriptName) || REPORT_ONLY_FLAG_PATTERN.test(packageCommand)) {
      releaseStrictnessFindings.push({
        source: relativePath,
        kind: "report-only-script",
        detail: scriptName
      });
    }
  }

  const nodeCommandMatches: any = [...source.matchAll(/args:\s*\[\s*["']([^"']+\.ts)["']/gu)]
    .map((match?: any) : any => match[1]);
  for (const scriptPath of nodeCommandMatches) {
    if (scriptPath.endsWith("core-platform-gap-audit.ts") && source.includes("--allow-open-gaps")) {
      releaseStrictnessFindings.push({
        source: relativePath,
        kind: "allow-open-gaps-node-script",
        detail: scriptPath
      });
    }
  }
}
if (releaseStrictnessFindings.length > 0) {
  for (const finding of releaseStrictnessFindings) {
    console.error(`  RELEASE CHAIN REPORT-ONLY MODE: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += releaseStrictnessFindings.length;
} else {
  console.log(`   OK: ${RELEASE_CHAIN_SOURCES.length} release-chain sources use strict commands only`);
}

// ── Check 9: Release evidence must use the canonical reducers
console.log("9. Checking release-evidence reducer authority...");

const releaseAggregatorSource: any = await fs.readFile(
  path.join(repoRoot, PLATFORM_ACCEPTANCE_SOURCE),
  "utf8"
);
const platformAcceptanceCommandCatalogSource: any = await fs.readFile(
  path.join(repoRoot, PLATFORM_ACCEPTANCE_COMMAND_CATALOG_SOURCE),
  "utf8"
);
validateCommandReportCatalogConsistency({
  source: PLATFORM_ACCEPTANCE_SOURCE,
  commands: PLATFORM_ACCEPTANCE_COMMANDS,
  requiredReports: ACCEPTANCE_REQUIRED_REPORTS
});
validateReleaseDagCatalogConsistency({
  source: PLATFORM_ACCEPTANCE_SOURCE,
  commands: PLATFORM_ACCEPTANCE_COMMANDS
});
validateCommandReportCatalogConsistency({
  source: PLATFORM_ACCEPTANCE_COMMAND_CATALOG_SOURCE,
  commands: PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  requiredReports: PRIVATE_DEPLOYMENT_REQUIRED_REPORTS
});
if (!RELEASE_EVIDENCE_READINESS_REDUCER_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "missing-release-evidence-readiness-reducer",
    detail: "release aggregation must derive report readiness through the shared release evidence reducer"
  });
}
if (!AGGREGATE_RELEASE_EVIDENCE_READINESS_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "missing-aggregate-release-evidence-readiness",
    detail: "final release aggregation must derive summary.releaseReady through createAggregateReleaseEvidenceReadiness"
  });
}
if (OPEN_DIRECT_AGGREGATE_RELEASE_READY_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "internal-platform-direct-aggregate-release-ready",
    detail: "final release aggregation must not recreate releaseReady from local failed-command and missing-evidence booleans"
  });
}
if (!RELEASE_AGGREGATOR_FULL_AGGREGATION_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "missing-full-release-aggregation-mode",
    detail: "release aggregation must refresh every required command report before reducing final readiness"
  });
}
if (RELEASE_AGGREGATOR_FAIL_FAST_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "release-aggregator-fail-fast",
    detail: "platform acceptance must not stop after the first failed command because later independent evidence must still be refreshed"
  });
}
const releaseEvidenceReadinessHelperSource: any = await fs.readFile(
  path.join(repoRoot, RELEASE_EVIDENCE_READINESS_HELPER),
  "utf8"
);
const scriptRegistryWithMissingPackSource: any = createReleaseEvidenceReadiness("build/reports/script-registry.json", registeredReleaseReportFixture("build/reports/script-registry.json", {
  totalPackageScripts: 1,
  commandMismatchCount: 0,
  packagePackFindingCount: 1,
  releaseStrictnessFindingCount: 0,
  releaseSourceOfTruthFindingCount: 0,
  releaseProfileReadinessFindingCount: 0,
  mcpReleaseTargetSourceOfTruthFindingCount: 0
}));
if (scriptRegistryWithMissingPackSource.releaseReady === true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "release-evidence-helper-accepted-script-registry-package-pack-finding",
    detail: "the shared release evidence reducer must reject script-registry reports that found npm package source closure violations"
  });
}
const scriptRegistryWithFactSourceAuthorityFinding: any = createReleaseEvidenceReadiness("build/reports/script-registry.json", registeredReleaseReportFixture("build/reports/script-registry.json", {
  totalPackageScripts: 1,
  commandMismatchCount: 0,
  packagePackFindingCount: 0,
  releaseStrictnessFindingCount: 0,
  releaseSourceOfTruthFindingCount: 0,
  releaseProfileReadinessFindingCount: 0,
  mcpReleaseTargetSourceOfTruthFindingCount: 0,
  factSourceAuthorityFindingCount: 1
}));
if (scriptRegistryWithFactSourceAuthorityFinding.releaseReady === true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "release-evidence-helper-accepted-script-registry-fact-source-authority-finding",
    detail: "the shared release evidence reducer must reject script-registry reports that found fact-source authority violations"
  });
}
const governanceCoverageWithUnmappedOperation: any = createReleaseEvidenceReadiness("build/reports/enterprise-governance-coverage.json", registeredReleaseReportFixture("build/reports/enterprise-governance-coverage.json", {
  summary: {
    releaseReady: true,
    reportLeakScan: true,
    unmappedOperationCount: 1
  }
}));
if (governanceCoverageWithUnmappedOperation.releaseReady === true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "release-evidence-helper-accepted-unmapped-operation-count",
    detail: "the shared release evidence reducer must reject reports with unmapped current operations even when a report-local ready flag is true"
  });
}
const reportWithReleaseBlockingWarnings: any = createReleaseEvidenceReadiness("build/reports/repo-organization.json", registeredRepoOrganizationReportFixture({
  summary: {
    releaseReady: true,
    reportLeakScan: true,
    releaseBlockingWarningCount: 1
  }
}));
if (reportWithReleaseBlockingWarnings.releaseReady === true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "release-evidence-helper-accepted-release-blocking-warning-count",
    detail: "the shared release evidence reducer must reject reports with releaseBlockingWarningCount even when a report-local ready flag is true"
  });
}
const reportWithReleaseBlockingFindings: any = createReleaseEvidenceReadiness("build/reports/repo-organization.json", registeredRepoOrganizationReportFixture({
  summary: {
    releaseReady: true,
    reportLeakScan: true,
    releaseBlockingFindingCount: 1
  }
}));
if (reportWithReleaseBlockingFindings.releaseReady === true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "release-evidence-helper-accepted-release-blocking-finding-count",
    detail: "the shared release evidence reducer must reject reports with releaseBlockingFindingCount even when a report-local ready flag is true"
  });
}
const releaseEvidenceFreshnessHelperSource: any = await fs.readFile(
  path.join(repoRoot, RELEASE_EVIDENCE_FRESHNESS_HELPER),
  "utf8"
);
if (!/createReportFreshnessEvidence/u.test(releaseEvidenceFreshnessHelperSource) ||
  !/removeReportPaths/u.test(releaseEvidenceFreshnessHelperSource)) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_FRESHNESS_HELPER,
    kind: "release-evidence-freshness-helper-incomplete",
    detail: "release evidence freshness must have one helper for report cleanup and stale-report detection"
  });
}
for (const relativePath of [
  "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts"
]) {
  const source: any = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  if (!RELEASE_EVIDENCE_FRESHNESS_PATTERN.test(source)) {
    releaseSourceOfTruthFindings.push({
      source: relativePath,
      kind: "missing-release-evidence-freshness-helper",
      detail: "release-chain aggregators must delete declared reports before running and reject stale report evidence"
    });
  }
}
if (!PLATFORM_ACCEPTANCE_REPORT_RESET_PATTERN.test(releaseAggregatorSource) ||
  !PLATFORM_ACCEPTANCE_TIMESTAMP_VALIDATION_PATTERN.test(releaseAggregatorSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "platform-acceptance-current-run-evidence-check-missing",
    detail: "platform acceptance must clear required child reports before execution and reject reports older than the current run"
  });
}
const releaseCommandDagRunnerSource: any = await fs.readFile(
  path.join(repoRoot, "tools/server-scripts/lib/release-command-dag-runner.ts"),
  "utf8"
);
if (!RELEASE_COMMAND_DAG_CHILD_PROCESS_PATTERN.test(releaseCommandDagRunnerSource) ||
  !/resourceLocks/u.test(releaseCommandDagRunnerSource) ||
  !/dependsOn/u.test(releaseCommandDagRunnerSource) ||
  !/commands\.map/u.test(releaseCommandDagRunnerSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/lib/release-command-dag-runner.ts",
    kind: "release-command-dag-runner-incomplete",
    detail: "release command DAG runner must execute child processes with dependency and resource-lock scheduling while preserving catalog-order results"
  });
}
const openReleaseSource: any = releaseAggregatorSource;
if (GENERIC_PRODUCTION_BLOCKED_SKIP_PATTERN.test(openReleaseSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "generic-production-blocked-skip",
    detail: "release aggregation must not let arbitrary report productionReleaseStatus/productionReleaseReady bypass the shared reducer"
  });
}
if (RAW_REPORT_PRODUCTION_FALLBACK_PATTERN.test(openReleaseSource)) {
  releaseSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "raw-report-production-field-fallback",
    detail: "release aggregation must expose production readiness from the shared reducer, not raw report production fields"
  });
}
const productionReadinessGateSource: any = await fs.readFile(
  path.join(repoRoot, "tools/server-scripts/production-readiness-gate.ts"),
  "utf8"
);
if (!PRODUCTION_GATE_REDUCER_CONTEXT_PATTERN.test(productionReadinessGateSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/production-readiness-gate.ts",
    kind: "production-gate-missing-release-evidence-reducer",
    detail: "production-readiness-gate must reduce its server-owned report through release-evidence-readiness.ts"
  });
}
if (PRODUCTION_GATE_DIRECT_PRODUCTION_READY_EXIT_PATTERN.test(productionReadinessGateSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/production-readiness-gate.ts",
    kind: "production-gate-direct-production-ready-exit",
    detail: "production-readiness-gate must not use productionReadiness.productionReleaseReady as a second release decision source"
  });
}
if (!PRODUCTION_GATE_SUMMARY_MISSING_EVIDENCE_PATTERN.test(productionReadinessGateSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/production-readiness-gate.ts",
    kind: "production-gate-summary-missing-evidence-not-published",
    detail: "production-readiness-gate must publish the shared missingEvidence list and count in summary for machine-readable release diagnostics"
  });
}
if (!PRODUCTION_GATE_PROJECTION_ONLY_PATTERN.test(productionReadinessGateSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/production-readiness-gate.ts",
    kind: "production-gate-report-not-projection-only",
    detail: "production-readiness-gate report must mark itself as a reducer-owned projection"
  });
}
const privateDeploymentSource: any = await fs.readFile(
  path.join(repoRoot, "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts"),
  "utf8"
);
if (!PRIVATE_REDUCER_ONLY_PATTERN.test(privateDeploymentSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts",
    kind: "private-deployment-not-reducer-only",
    detail: "private deployment must reduce evidence already produced by canonical platform acceptance command owners"
  });
}
if (RELEASE_COMMAND_DAG_RUNNER_IMPORT_PATTERN.test(privateDeploymentSource)) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts",
    kind: "private-deployment-shadow-dag",
    detail: "private deployment must not execute a second release command DAG"
  });
}
if (releaseSourceOfTruthFindings.length > 0) {
  for (const finding of releaseSourceOfTruthFindings) {
    console.error(`  RELEASE CHAIN SOURCE-OF-TRUTH VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += releaseSourceOfTruthFindings.length;
} else {
  console.log("   OK: Core release aggregation uses canonical report reducers");
}

// ── Check 10: self-contained gateway scenario readiness must use one reducer
console.log("10. Checking self-contained gateway scenario source of truth...");
for (const relativePath of [
  PLATFORM_ACCEPTANCE_SOURCE,
  "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts",
  ...RELEASE_PROFILE_SOURCES
]) {
  const source: any = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  if (!RELEASE_EVIDENCE_READINESS_IMPORT_PATTERN.test(source) ||
    !RELEASE_EVIDENCE_READINESS_REDUCER_PATTERN.test(source)) {
    releaseSourceOfTruthFindings.push({
      source: relativePath,
      kind: "missing-release-evidence-readiness-helper",
      detail: "release/profile aggregators must reduce reports through release-evidence-readiness.ts"
    });
  }
}
if (!UPSTREAM_FIXTURE_TRANSIT_HELPER_PATTERN.test(releaseEvidenceReadinessHelperSource) ||
  requiredReportSpec(UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH)?.reducer !== REQUIRED_REPORT_REDUCERS.UPSTREAM_FIXTURE_TRANSIT) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "missing-upstream-fixture-transit-helper",
    detail: "Upstream fixture transit evidence must be reduced through upstream-fixture-transit-evidence.ts from the shared release evidence reducer"
  });
}
if (!UPSTREAM_MCP_GATEWAY_HELPER_PATTERN.test(releaseEvidenceReadinessHelperSource) ||
  requiredReportSpec(UPSTREAM_MCP_GATEWAY_REPORT_PATH)?.reducer !== REQUIRED_REPORT_REDUCERS.UPSTREAM_MCP_GATEWAY) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "missing-upstream-mcp-gateway-helper",
    detail: "Upstream MCP gateway approval evidence must be reduced through upstream-mcp-gateway-evidence.ts from the shared release evidence reducer"
  });
}
if (!DOWNSTREAM_AGENT_TOOL_LOOP_HELPER_PATTERN.test(releaseEvidenceReadinessHelperSource) ||
  requiredReportSpec(DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH)?.reducer !== REQUIRED_REPORT_REDUCERS.DOWNSTREAM_AGENT_TOOL_LOOP) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "missing-downstream-agent-tool-loop-helper",
    detail: "Downstream agent tool loop evidence must be reduced through downstream-agent-tool-loop-evidence.ts from the shared release evidence reducer"
  });
}
const upstreamMcpGatewayEvidenceByTestName: Readonly<Record<string, any>> = Object.freeze({
  "approval-required upstream MCP call resumes exactly once with credential binding": {
    pendingBeforeForward: true,
    resumeCompleted: true,
    upstreamHitDelta: 1,
    duplicateResolveRejected: true,
    credentialBindingAuthorized: true,
    credentialInjectionAccepted: true
  },
  "rejected and duplicate upstream MCP resolutions have no upstream side effects": {
    rejected: true,
    upstreamHitDelta: 0,
    duplicateResolveRejected: true
  },
  "expired upstream MCP approval has no upstream side effects": {
    expired: true,
    resolveRejected: true,
    duplicateResolveRejected: true,
    upstreamHitDelta: 0
  },
  "upstream MCP approval lifecycle emits bound audit evidence": {
    gatewayCompletedCount: 1,
    operationPermissionPendingCount: 3,
    operationPermissionCompletedCount: 1,
    boundGrantAuditVerified: true,
    rawCredentialRedacted: true
  }
});
const upstreamMcpGatewayBaseReport: any = registeredReleaseReportFixture(UPSTREAM_MCP_GATEWAY_REPORT_PATH, {
  summary: {
    reportLeakScan: true,
    failedCount: 0,
    releaseReady: true,
    approvalResumeVerified: true,
    approvalExactlyOnceVerified: true,
    approvalDenialNoSideEffectVerified: true,
    approvalExpiryNoSideEffectVerified: true,
    duplicateResolutionNoSideEffectVerified: true,
    approvalAuditVerified: true,
    credentialBindingVerified: true
  },
  tests: UPSTREAM_MCP_GATEWAY_REQUIRED_TEST_NAMES.map((name?: any) : any => ({
    name,
    status: "passed",
    evidence: structuredClone(upstreamMcpGatewayEvidenceByTestName[name] || {})
  }))
});
const upstreamMcpGatewayReady: any = createReleaseEvidenceReadiness(
  UPSTREAM_MCP_GATEWAY_REPORT_PATH,
  upstreamMcpGatewayBaseReport
);
if (upstreamMcpGatewayReady.releaseReady !== true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "upstream-mcp-gateway-ready-report-rejected",
    detail: "Upstream MCP gateway reducer must accept complete exactly-once approval, no-side-effect resolution, audit, and credential-binding evidence"
  });
}
for (const [kind, mutate] of [
  ["missing-required-test", (report?: any) : any => { report.tests.pop(); }],
  ["approval-replayed", (report?: any) : any => {
    report.tests.find((item?: any) : any => item.name.startsWith("approval-required upstream MCP"))
      .evidence.upstreamHitDelta = 2;
  }],
  ["credential-binding-missing", (report?: any) : any => {
    report.tests.find((item?: any) : any => item.name.startsWith("approval-required upstream MCP"))
      .evidence.credentialBindingAuthorized = false;
  }],
  ["rejection-forwarded", (report?: any) : any => {
    report.tests.find((item?: any) : any => item.name.startsWith("rejected and duplicate"))
      .evidence.upstreamHitDelta = 1;
  }],
  ["expiry-resolution-accepted", (report?: any) : any => {
    report.tests.find((item?: any) : any => item.name.startsWith("expired upstream MCP"))
      .evidence.resolveRejected = false;
  }],
  ["audit-completed-twice", (report?: any) : any => {
    report.tests.find((item?: any) : any => item.name.startsWith("upstream MCP approval lifecycle"))
      .evidence.gatewayCompletedCount = 2;
  }],
  ["exactly-once-summary-missing", (report?: any) : any => {
    report.summary.approvalExactlyOnceVerified = false;
  }]
]) {
  const mutated: any = structuredClone(upstreamMcpGatewayBaseReport);
  (mutate as (report: any) => void)(mutated);
  const readiness: any = createReleaseEvidenceReadiness(UPSTREAM_MCP_GATEWAY_REPORT_PATH, mutated);
  if (readiness.releaseReady === true) {
    releaseSourceOfTruthFindings.push({
      source: RELEASE_EVIDENCE_READINESS_HELPER,
      kind: `upstream-mcp-gateway-accepted-${kind}`,
      detail: "Upstream MCP gateway reducer must fail closed when approval, exactly-once, no-side-effect, audit, or credential-binding proof is incomplete"
    });
  }
}
const upstreamFixtureTransitIdentityProof: Record<string, any> = {
  principalPresent: true,
  principalHash: "redacted-principal-hash",
  accountIdPresent: true,
  accountIdHash: "redacted-account-hash",
  tokenProofMatchesIssuedCredential: true,
  rawIdentityRedacted: true
};
const upstreamFixtureTransitBaseReport: any = registeredReleaseReportFixture(UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH, {
  summary: {
    reportLeakScan: true,
    serviceConfigured: true,
    selfContained: true
  },
  evidence: {
    restForwarding: {
      recordsListOk: true,
      recordsListAuditIdPresent: true,
      responseSchemaValidated: true,
      credentialHeaderInjectionProven: true,
      echoOk: true,
      identityProof: { ...upstreamFixtureTransitIdentityProof }
    },
    mcpTransit: {
      directToolCount: UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES.length,
      projectedToolCount: UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES.length,
      requiredToolsPresent: [...UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES],
      schemaParityTools: [...UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES],
      readOnlyCallOk: true,
      readOnlyCallAuditIdPresent: true,
      credentialEnvInjectionProven: true,
      identityProof: { ...upstreamFixtureTransitIdentityProof },
      httpTransportListOk: true,
      httpTransportCallOk: true,
      stdioStatefulIncrementProbeProven: true,
      stdioStatefulSessionReuseProven: true,
      stdioStatefulSessionObservedCallCount: 3
    },
    secretStoreCredentialBinding: {
      accepted: true,
      serviceCredentialRefCount: 3,
      resolvedCredentialRefCount: 3,
      credentialRefHash: "redacted-secret-ref-hash",
      descriptorHasInlineCredential: false,
      rawSecretRedacted: true
    },
    downstreamAgentProjection: {
      readOnlyToolVisible: true,
      identityToolVisible: true,
      destructiveToolHidden: true,
      readOnlyCallOk: true,
      identityCallOk: true
    },
    deniedCalls: {
      missingReadScopeRejected: true,
      destructiveWithoutApproval: "pending_approval"
    }
  }
});
const upstreamFixtureTransitReady: any = createReleaseEvidenceReadiness(
  UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH,
  upstreamFixtureTransitBaseReport
);
if (upstreamFixtureTransitReady.releaseReady !== true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "upstream-fixture-transit-ready-report-rejected",
    detail: "Upstream fixture transit reducer must accept reports with REST and MCP transit proof, redacted identity proof, and secret-store binding"
  });
}
for (const [kind, mutate] of [
  ["missing-rest-credential-injection", (report?: any) : any => { report.evidence.restForwarding.credentialHeaderInjectionProven = false; }],
  ["missing-mcp-identity-proof", (report?: any) : any => { delete report.evidence.mcpTransit.identityProof; }],
  ["missing-mcp-stateful-increment-probe", (report?: any) : any => { report.evidence.mcpTransit.stdioStatefulIncrementProbeProven = false; }],
  ["missing-mcp-stateful-session", (report?: any) : any => { report.evidence.mcpTransit.stdioStatefulSessionReuseProven = false; }],
  ["inline-credential-in-descriptor", (report?: any) : any => { report.evidence.secretStoreCredentialBinding.descriptorHasInlineCredential = true; }],
  ["destructive-tool-visible-downstream", (report?: any) : any => { report.evidence.downstreamAgentProjection.destructiveToolHidden = false; }],
  ["missing-secret-store-credential-binding", (report?: any) : any => { delete report.evidence.secretStoreCredentialBinding; }]
]) {
  const report: any = structuredClone(upstreamFixtureTransitBaseReport);
  (mutate as (report: any) => void)(report);
  const readiness: any = createReleaseEvidenceReadiness(UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH, report);
  if (readiness.releaseReady === true) {
    releaseSourceOfTruthFindings.push({
      source: RELEASE_EVIDENCE_READINESS_HELPER,
      kind: `upstream-fixture-transit-accepted-${kind}`,
      detail: "Upstream fixture transit reducer must require credential injection proof, redacted identity proof, secret-store binding, and destructive tool hiding"
    });
  }
}
const downstreamAgentCancellationEvidence: Record<string, any> = {
  target: DOWNSTREAM_AGENT_CANCELLATION_TARGET,
  spawnedProxyTransport: true,
  downstreamMcpTransportProven: true,
  operationPermissionExecutionProven: true,
  gatewayRegistryForwardProven: true,
  actualStdioUpstreamProven: true,
  upstreamCancellationObserved: true,
  cancelledRequestIdCorrelated: true,
  cancelledRequestResponseCount: 0,
  sideEffectAbsentAfterOriginalDeadline: true,
  trafficPolicyMaxConcurrent: 2,
  preCancellationCapacityDenied: true,
  trafficSlotReleasedWhilePeerActive: true,
  probeAdmittedAfterCancellation: true,
  peerUnaffected: true,
  finalCounter: 0,
  delayedIncrementStartedCount: 1,
  delayedIncrementCompletedCount: 0,
  delayedIncrementCancelledCount: 1,
  peerStartedCount: 1,
  peerCompletedCount: 1,
  saturationAttemptCount: 1,
  admissionAttemptCount: 1
};
const downstreamAgentToolLoopBaseReport: any = registeredReleaseReportFixture(DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH, {
  summary: {
    reportLeakScan: true,
    serviceConfigured: true,
    selfContained: true
  },
  evidence: {
    scenario: {
      source: "embedded",
      turnCount: DOWNSTREAM_AGENT_CORE_TURN_IDS.length,
      turnIds: [...DOWNSTREAM_AGENT_CORE_TURN_IDS]
    },
    secretStoreCredentialBinding: {
      accepted: true,
      serviceCredentialRefCount: 1,
      resolvedCredentialRefCount: 1,
      credentialRefHash: "redacted-secret-ref-hash",
      rawSecretRedacted: true
    },
    cancellationPropagation: { ...downstreamAgentCancellationEvidence },
    proxyClientTargets: DOWNSTREAM_AGENT_CLIENT_TARGETS.map((target?: any) : any => ({
      target,
      status: "passed",
      realProxyTransport: true,
      protocol: "mcp-stdio-jsonl-json-rpc",
      initialized: true,
      initializedNotificationSent: true,
      unexpectedNotificationResponses: 0,
      clientProtocolProfile: {
        target,
        framing: "jsonl",
        source: "neutral-protocol-peer"
      },
      completedTurnIds: [...DOWNSTREAM_AGENT_CORE_TURN_IDS],
      failedTurnCount: 0,
      readOnlyToolVisible: true,
      identityToolVisible: true,
      destructiveToolHidden: true,
      readOnlyCallOk: true,
      identityCallOk: true,
      deniedDestructiveRejected: true,
      credentialProof: {
        tokenProofMatchesIssuedCredential: true,
        rawCredentialRedacted: true
      },
      ...(target === DOWNSTREAM_AGENT_CANCELLATION_TARGET
        ? { cancellationPropagation: { ...downstreamAgentCancellationEvidence } }
        : {}),
      proxyExitOk: true
    }))
  }
});
const downstreamAgentToolLoopReady: any = createReleaseEvidenceReadiness(
  DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH,
  downstreamAgentToolLoopBaseReport
);
if (JSON.stringify([...DOWNSTREAM_AGENT_CLIENT_TARGETS]) !== JSON.stringify([...MCP_SUPPORTED_TARGETS])) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts",
    kind: "downstream-agent-tool-loop-targets-diverged",
    detail: "Downstream agent tool loop evidence must use the same MCP release target source as install-refresh"
  });
}
if (downstreamAgentToolLoopReady.releaseReady !== true) {
  releaseSourceOfTruthFindings.push({
    source: RELEASE_EVIDENCE_READINESS_HELPER,
    kind: "downstream-agent-tool-loop-ready-report-rejected",
    detail: "Downstream agent tool loop reducer must accept reports with every declared proxy target, real stdio transport, scripted turns, credential proof, and secret-store binding"
  });
}
for (const [kind, mutate] of [
  ["missing-proxy-target", (report?: any) : any => { report.evidence.proxyClientTargets.pop(); }],
  ["destructive-tool-visible", (report?: any) : any => { report.evidence.proxyClientTargets[0].destructiveToolHidden = false; }],
  ["missing-target-credential-proof", (report?: any) : any => { report.evidence.proxyClientTargets[0].credentialProof.tokenProofMatchesIssuedCredential = false; }],
  ["missing-initialized-notification", (report?: any) : any => { report.evidence.proxyClientTargets[0].initializedNotificationSent = false; }],
  ["wrong-client-framing", (report?: any) : any => { report.evidence.proxyClientTargets[0].clientProtocolProfile.framing = "content-length"; }],
  ["missing-core-turn", (report?: any) : any => { report.evidence.proxyClientTargets[0].completedTurnIds = ["initialize"]; }],
  ["missing-cancellation-closure", (report?: any) : any => { report.evidence.cancellationPropagation.upstreamCancellationObserved = false; }],
  ["missing-secret-store-credential-binding", (report?: any) : any => { delete report.evidence.secretStoreCredentialBinding; }]
]) {
  const report: any = structuredClone(downstreamAgentToolLoopBaseReport);
  (mutate as (report: any) => void)(report);
  const readiness: any = createReleaseEvidenceReadiness(DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH, report);
  if (readiness.releaseReady === true) {
    releaseSourceOfTruthFindings.push({
      source: RELEASE_EVIDENCE_READINESS_HELPER,
      kind: `downstream-agent-tool-loop-accepted-${kind}`,
      detail: "Downstream agent tool loop reducer must require target-complete spawned proxy evidence, scripted core turns, destructive tool hiding, credential proof, and secret-store binding"
    });
  }
}
if (releaseSourceOfTruthFindings.length > 0) {
  for (const finding of releaseSourceOfTruthFindings) {
    console.error(`  RELEASE CHAIN SOURCE-OF-TRUTH VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += releaseSourceOfTruthFindings.length;
} else {
  console.log("   OK: self-contained gateway scenario readiness uses the shared reducer");
}

// ── Check 11: MCP release target consumers must import the target source
console.log("11. Checking MCP downstream evidence source of truth...");
const downstreamEvidenceSourceOfTruthFindings: any[] = [];
const downstreamEvidenceSourceChecks: any[] = [
];
for (const check of downstreamEvidenceSourceChecks) {
  const source: any = await fs.readFile(path.join(repoRoot, check.source), "utf8");
  const registryReducerMatches: any = !check.registeredReportPath ||
    requiredReportSpec(check.registeredReportPath)?.reducer === check.expectedReducer;
  if (
    !check.helperPattern.test(source) ||
    (check.pathPattern && !check.pathPattern.test(source)) ||
    !registryReducerMatches ||
    (check.commandPattern && !check.commandPattern.test(source))
  ) {
    downstreamEvidenceSourceOfTruthFindings.push({
      source: check.source,
      kind: check.kind,
      detail: check.detail
    });
  }
}
if (!PLATFORM_ACCEPTANCE_REPORT_CATALOG_IMPORT_PATTERN.test(releaseAggregatorSource)) {
  downstreamEvidenceSourceOfTruthFindings.push({
    source: PLATFORM_ACCEPTANCE_SOURCE,
    kind: "missing-platform-acceptance-report-catalog",
    detail: "platform acceptance must consume the canonical child-report catalog"
  });
}
if (downstreamEvidenceSourceOfTruthFindings.length > 0) {
  for (const finding of downstreamEvidenceSourceOfTruthFindings) {
    console.error(`  MCP DOWNSTREAM EVIDENCE SOURCE-OF-TRUTH VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += downstreamEvidenceSourceOfTruthFindings.length;
} else {
  console.log("   OK: MCP downstream release evidence uses shared reducers");
}

// ── Check 12: MCP release target consumers must import the target source
console.log("12. Checking MCP release target source of truth...");
for (const relativePath of MCP_RELEASE_TARGET_CONSUMER_SOURCES) {
  const source: any = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  if (!MCP_RELEASE_TARGET_SOURCE_PATTERN.test(source)) {
    mcpReleaseTargetSourceOfTruthFindings.push({
      source: relativePath,
      kind: "missing-mcp-release-target-source",
      detail: "MCP release target consumers must import packages/protocols/mcp/adapter/mcp-release-targets.ts"
    });
  }
  if (MCP_RELEASE_TARGET_HARDCODED_LIST_PATTERN.test(source)) {
    mcpReleaseTargetSourceOfTruthFindings.push({
      source: relativePath,
      kind: "hardcoded-mcp-release-target-list",
      detail: "MCP release target set must not be redefined as a local array"
    });
  }
}
if (mcpReleaseTargetSourceOfTruthFindings.length > 0) {
  for (const finding of mcpReleaseTargetSourceOfTruthFindings) {
    console.error(`  MCP RELEASE TARGET SOURCE-OF-TRUTH VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += mcpReleaseTargetSourceOfTruthFindings.length;
} else {
  console.log("   OK: MCP release target consumers use the shared target source");
}

// ── Check 13: Release support profiles must fail on not-ready evidence and use aggregate reducers
console.log("13. Checking release support profile readiness source of truth...");
const gatewayPlatformProfileSource: any = await fs.readFile(
  path.join(repoRoot, "tools/server-scripts/stress-gateway-platform-profile.ts"),
  "utf8"
);
if (
  !RELEASE_PROFILE_AGGREGATE_REDUCER_PATTERN.test(gatewayPlatformProfileSource) ||
  !RELEASE_PROFILE_SUMMARY_SOURCE_PATTERN.test(gatewayPlatformProfileSource)
) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/stress-gateway-platform-profile.ts",
    kind: "release-profile-missing-aggregate-readiness-reducer",
    detail: "gateway platform profile must reduce command and evidence readiness through createAggregateReleaseEvidenceReadiness() and publish its source in summary"
  });
}
if (
  !RELEASE_PROFILE_CHILD_LEAK_SCAN_MISSING_EVIDENCE_PATTERN.test(gatewayPlatformProfileSource) ||
  !RELEASE_PROFILE_AGGREGATE_LEAK_SCAN_PATTERN.test(gatewayPlatformProfileSource)
) {
  releaseProfileReadinessFindings.push({
    source: "tools/server-scripts/stress-gateway-platform-profile.ts",
    kind: "release-profile-child-leak-scan-not-blocking",
    detail: "gateway platform profile must treat child reportLeakScan=false as missing evidence and aggregate leak-scan failure"
  });
}
if (
  !RELEASE_PROFILE_FRESHNESS_HELPER_PATTERN.test(gatewayPlatformProfileSource) ||
  !RELEASE_PROFILE_CANONICAL_CONSUMPTION_PATTERN.test(gatewayPlatformProfileSource)
) {
  releaseSourceOfTruthFindings.push({
    source: "tools/server-scripts/stress-gateway-platform-profile.ts",
    kind: "release-profile-missing-reuse-freshness-check",
    detail: "gateway platform profile must consume canonical reports and validate freshness through release-evidence-freshness.ts"
  });
}
if (!GATEWAY_PLATFORM_PROFILE_STRICT_EXIT_PATTERN.test(gatewayPlatformProfileSource)) {
  releaseProfileReadinessFindings.push({
    source: "tools/server-scripts/stress-gateway-platform-profile.ts",
    kind: "missing-release-ready-exit",
    detail: "gateway platform profile must exit non-zero when summary.releaseReady is false"
  });
}
const mcpGatewayLoadSource: any = await fs.readFile(
  path.join(repoRoot, "tools/server-scripts/stress-mcp-gateway.ts"),
  "utf8"
);
if (
  !MCP_GATEWAY_LOAD_RESOURCE_CUTOFF_REASON_PATTERN.test(mcpGatewayLoadSource) ||
  !MCP_GATEWAY_LOAD_INCOMPLETE_PHASE_REASON_PATTERN.test(mcpGatewayLoadSource) ||
  !MCP_GATEWAY_LOAD_SUMMARY_LEAK_SCAN_PATTERN.test(mcpGatewayLoadSource)
) {
  releaseProfileReadinessFindings.push({
    source: "tools/server-scripts/stress-mcp-gateway.ts",
    kind: "mcp-gateway-load-weak-readiness",
    detail: "MCP gateway load evidence must publish leak-scan status and fail readiness on resource safety cutoff or incomplete configured phases"
  });
}
if (releaseProfileReadinessFindings.length > 0) {
  for (const finding of releaseProfileReadinessFindings) {
    console.error(`  RELEASE PROFILE READINESS VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += releaseProfileReadinessFindings.length;
}
const releaseProfileSourceFindings: any = releaseSourceOfTruthFindings.filter((finding?: any) : any =>
  finding.kind === "release-profile-missing-aggregate-readiness-reducer"
);
if (releaseProfileSourceFindings.length > 0) {
  for (const finding of releaseProfileSourceFindings) {
    console.error(`  RELEASE PROFILE SOURCE-OF-TRUTH VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += releaseProfileSourceFindings.length;
} else if (releaseProfileReadinessFindings.length === 0) {
  console.log("   OK: release support profiles fail when their own evidence is not ready and use aggregate reducers");
} else {
  console.log("   OK: release support profiles use aggregate reducers");
}

// ── Check 14: Repository fact-source authority registry must own governed facts
console.log("14. Checking repository fact-source authority registry...");
await validateFactSourceAuthorityRegistry();
if (factSourceAuthorityFindings.length > 0) {
  for (const finding of factSourceAuthorityFindings) {
    console.error(`  FACT SOURCE AUTHORITY VIOLATION: ${finding.source} ${finding.kind} ${finding.detail}`);
  }
  issues += factSourceAuthorityFindings.length;
} else {
  console.log("   OK: governed fact domains are indexed by the authority registry");
}

// ── Generate report artifact ────────────────────────────────────────────────
const reportDir: any = path.join(repoRoot, "build", "reports");
await fs.mkdir(reportDir, { recursive: true });

const snapshot: any = generateScriptRegistrySnapshot();
await fs.writeFile(
  path.join(reportDir, "script-registry.json"),
  JSON.stringify(snapshot, null, 2),
  "utf8"
);
console.log(`   Generated build/reports/script-registry.json`);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("");
if (issues === 0) {
  console.log(`Script registry verification: PASSED (${explicitEntries.length} explicit + ${patternMatchedEntries.length} pattern + ${allowlistedEntries.length} allowlisted = ${allScripts.length} package scripts)`);
} else {
  console.error(`Script registry verification: FAILED (${issues} issue(s))`);
  process.exitCode = 1;
}

// ══════════════════════════════════════════════════════════════════════════════
// Report generator
// ══════════════════════════════════════════════════════════════════════════════

function generateScriptRegistrySnapshot() : any {
  const scriptsByTier: Record<string, any> = {};
  const scriptsBySideEffects: Record<string, any> = {};

  for (const entry of (Object.values(scriptReg.SCRIPT_REGISTRY) as any[])) {
    const tier: any = entry.tier || "unknown";
    if (!scriptsByTier[tier]) scriptsByTier[tier] = [];
    scriptsByTier[tier].push(entry.scriptName);

    const se: any = entry.sideEffects || "none";
    if (!scriptsBySideEffects[se]) scriptsBySideEffects[se] = [];
    scriptsBySideEffects[se].push(entry.scriptName);
  }

  return {
    schemaVersion: "v0.0.1:registry:script-catalog-0.2.0",
    generatedAt: new Date().toISOString(),
    verifier: "tests/verify-script-registry.ts",
    summary: {
      releaseReady: issues === 0,
      reportLeakScan: true
    },
    totalPackageScripts: allScripts.length,
    explicitEntryCount: explicitEntries.length,
    patternMatchedCount: patternMatchedEntries.length,
    allowlistedCount: allowlistedEntries.length,
    unregisteredScriptCount: unregistered.length,
    staleDeclarationCount: stale.length,
    duplicateDeclarationCount: duplicateDeclarations.length,
    issueCount: issues,
    commandMismatchCount: commandMismatches.length,
    packagePackFindingCount: packagePackFindings.length,
    releaseStrictnessFindingCount: releaseStrictnessFindings.length,
    releaseSourceOfTruthFindingCount: releaseSourceOfTruthFindings.length,
    releaseProfileReadinessFindingCount: releaseProfileReadinessFindings.length,
    mcpReleaseTargetSourceOfTruthFindingCount: mcpReleaseTargetSourceOfTruthFindings.length,
    factSourceAuthorityFindingCount: factSourceAuthorityFindings.length,
    releaseStrictnessSources: [...RELEASE_CHAIN_SOURCES],
    releaseStrictnessFindings,
    releaseSourceOfTruthFindings,
    mcpReleaseTargetSourceOfTruthFindings,
    factSourceAuthorityFindings,
    commandMismatches: commandMismatches.map((m?: any) : any => ({
      scriptName: m.scriptName,
      registryCommand: m.registryCommand,
      packageCommand: m.packageCommand,
    })),
    scriptsByTier,
    scriptsBySideEffects,
    entries: (Object.values(scriptReg.SCRIPT_REGISTRY) as any[]).map((s?: any) : any => ({
      scriptName: s.scriptName,
      category: s.category,
      subsystem: s.subsystem,
      owner: s.owner,
      tier: s.tier,
      sideEffects: s.sideEffects,
      requiresFreshContainer: s.requiresFreshContainer,
      ciProfile: s.ciProfile,
      expectedDurationClass: s.expectedDurationClass,
      classification: "explicit",
      commandMatch: commandMismatches.some((m?: any) : any => m.scriptName === s.scriptName) ? "mismatch" : "ok",
    })),
    patternMatched: patternMatchedEntries.map((name?: any) : any => ({
      scriptName: name,
      packageCommand: packageScripts[name],
      classification: "pattern",
    })),
    allowlisted: allowlistedEntries.map((name?: any) : any => ({
      scriptName: name,
      classification: "allowlist",
    })),
  };
}
