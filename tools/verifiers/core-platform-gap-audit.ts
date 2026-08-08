#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.ts";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import {
  filterOperationsForFeatures,
  resolveFeatureRuntime,
} from "../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import { mcpOutletForTool } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.ts";
import { MCP_SUPPORTED_TARGETS } from "../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import { assertNoLeak as assertNoSensitiveLeak } from "../server-scripts/lib/report-evidence-safety.ts";
import { createPluginDeploymentAuditCatalog } from "../server-scripts/lib/plugin-deployment-audit-catalog.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_MATRIX_PATH: any = "tools/registry/internal-platform-capability-matrix.json";
const DEFAULT_REPORT_PATH: any = "build/reports/core-platform-gap-audit.json";

const STATUS_PRIORITY: readonly any[] = Object.freeze([
  "missing",
  "disconnected",
  "non_current",
  "non_runnable",
  "partial",
  "implemented"
]);

const CRITICAL_STATUSES: any = new Set<any>([
  "missing",
  "disconnected",
  "non_current",
  "non_runnable"
]);

function capabilityBoundary(capability?: any, activeFeatureIds?: any) : any {
  if (capability.capabilityClass === "external-plugin") {
    return {
      capabilityClass: "external-plugin",
      enabled: Boolean(capability.pluginId),
      coreBlocking: false,
      activationSource: capability.pluginId ? "explicit-plugin-audit-deployment" : "external-contribution-not-selected"
    };
  }
  if (capability.capabilityClass === "detachable-core") {
    const featureId: any = String(capability.activationFeatureId || "");
    const enabled: any = activeFeatureIds.has(featureId);
    return {
      capabilityClass: "detachable-core",
      enabled,
      coreBlocking: enabled,
      activationSource: `core-feature:${featureId}`
    };
  }
  return {
    capabilityClass: "core",
    enabled: true,
    coreBlocking: true,
    activationSource: "core-platform"
  };
}

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    allowOpenGaps: false,
    matrix: DEFAULT_MATRIX_PATH,
    report: DEFAULT_REPORT_PATH
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (arg === "--allow-open-gaps") {
      options.allowOpenGaps = true;
      continue;
    }
    if (arg === "--matrix") {
      options.matrix = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--matrix=")) {
      options.matrix = arg.slice("--matrix=".length);
      continue;
    }
    if (arg === "--report") {
      options.report = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.report = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function takeValue(argv?: any, index?: any, flag?: any) : any {
  const value: any = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() : any {
  console.log(`Usage:
  node tools/verifiers/core-platform-gap-audit.ts
  node tools/verifiers/core-platform-gap-audit.ts --allow-open-gaps

Options:
  --allow-open-gaps  Write the report and exit 0 even when release-blocking gaps exist.
  --matrix <path>    Capability matrix JSON path. Defaults to ${DEFAULT_MATRIX_PATH}.
  --report <path>    Report JSON path. Defaults to ${DEFAULT_REPORT_PATH}.`);
}

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

function normalizeRelativePath(value?: any) : any {
  return String(value || "").replace(/\\/gu, "/").replace(/^\.?\//u, "");
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

async function readTextIfExists(relativePath?: any) : Promise<any> {
  try {
    return await fs.readFile(repoPath(relativePath), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function exists(relativePath?: any) : Promise<any> {
  try {
    await fs.stat(repoPath(relativePath));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function unique(values?: any) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function operationMatches(operation?: any, prefixes: any = [], ids: any = []) : any {
  const operationId: any = String(operation?.id || operation?.operationId || "");
  return ids.includes(operationId) || prefixes.some((prefix?: any) : any => operationId.startsWith(prefix));
}

function byPrefixes(items?: any, prefixes: any = [], ids: any = []) : any {
  return items.filter((item?: any) : any => operationMatches(item, prefixes, ids));
}

function summarizeOperation(operation?: any) : any {
  return {
    id: operation.id,
    feature: operation.feature || "",
    featureId: operation.featureId || "",
    http: operation.http?.path
      ? {
          method: String(operation.http.method || "GET").toUpperCase(),
          path: operation.http.path
        }
      : null,
    rpc: operation.rpc?.method || "",
    requiredScopes: operation.requiredScopes || [],
    target: operation.target?.method || "",
    risk: operation.safety?.risk || operation.risk || ""
  };
}

function summarizeTool(tool?: any) : any {
  return {
    id: tool.id,
    operationId: tool.operationId || "",
    toolsets: tool.toolsets || [],
    requiredScopes: tool.requiredScopes || [],
    risk: tool.risk || "",
    status: tool.status || ""
  };
}

function outletForTool(tool?: any) : any {
  return mcpOutletForTool(tool).toolName;
}

function countByOutlet(tools?: any) : any {
  const counts: Record<string, any> = {
    [MCP_DISCOVERY_TOOL_NAME]: 1,
    [MCP_GATEWAY_TOOL_NAME]: 0
  };
  for (const tool of tools) {
    const outlet: any = outletForTool(tool);
    counts[outlet] = (counts[outlet] || 0) + 1;
  }
  return counts;
}

function statusFromFindings(findings?: any) : any {
  if (findings.length === 0) {
    return "implemented";
  }
  const statuses: any = new Set<any>(findings.map((finding?: any) : any => finding.status));
  for (const status of STATUS_PRIORITY) {
    if (statuses.has(status)) {
      return status;
    }
  }
  return "partial";
}

function addFinding(findings: any, {
  status,
  severity = "critical",
  code,
  message,
  evidence = {},
  remediationPlan = ""
}: Record<string, any>) : any {
  findings.push({
    status,
    severity,
    code,
    message,
    evidence,
    remediationPlan
  });
}

function sourceReference(capability?: any) : any {
  return {
    capabilityId: capability.id,
    publicDocs: capability.docs || [],
    requirementRows: capability.requirementRows || []
  };
}

function remediationReference(capability?: any) : any {
  return unique([
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ])[0] || "";
}

function scanTextForAny(text?: any, values?: any) : any {
  return unique(values).filter((value?: any) : any => text.includes(value));
}

async function buildConsoleEvidence(capability?: any, pluginRuntime: any = null) : Promise<any> {
  const expected: any = capability.expectedConsoleFeatures || [];
  if (capability.pluginId) {
    const entries: any = (pluginRuntime?.consoleEntries || [])
      .filter((entry?: any) : any => entry.pluginId === capability.pluginId)
      .map((entry?: any) : any => entry.id);
    return {
      expected,
      matched: expected.filter((entryId?: any) : any => entries.includes(entryId)),
      sources: [`plugins/${capability.pluginId}/plugin.json`, `plugins/${capability.pluginId}/runtime.ts`]
    };
  }
  const featureRegistry: any = await readTextIfExists("packages/foundation/config/frontend-feature-registry.yaml");
  const adminRegistry: any = await readTextIfExists("apps/console/router/admin-route-registry.ts");
  const routeRegistry: any = await readTextIfExists("apps/console/router/routes.ts");
  const combined: any = [featureRegistry, adminRegistry, routeRegistry].join("\n");
  return {
    expected,
    matched: scanTextForAny(combined, expected),
    sources: [
      "packages/foundation/config/frontend-feature-registry.yaml",
      "apps/console/router/admin-route-registry.ts",
      "apps/console/router/routes.ts"
    ]
  };
}

async function buildVerifierEvidence(capability?: any, testsRegistry?: any) : Promise<any> {
  const scripts: any = capability.verifierScripts || [];
  const scriptStates: any[] = [];
  for (const script of scripts) {
    scriptStates.push({
      path: script,
      exists: await exists(script)
    });
  }
  const suiteMatches: any[] = [];
  for (const suite of testsRegistry.suites || []) {
    const args: any = (suite.args || []).map((arg?: any) : any => String(arg));
    for (const script of scripts) {
      if (args.includes(script)) {
        suiteMatches.push({
          suiteId: suite.id,
          script
        });
      }
    }
  }
  return {
    scripts: scriptStates,
    testSuites: suiteMatches
  };
}

function buildMcpTargetEvidence(capability?: any) : any {
  const allowedTargets: any = capability.allowedMcpTargets === "$MCP_SUPPORTED_TARGETS"
    ? MCP_SUPPORTED_TARGETS
    : capability.allowedMcpTargets || [];
  const allowed: any = new Set<any>(allowedTargets);
  if (!allowed.size) {
    return null;
  }
  const targets: any = MCP_CLIENT_TARGETS.map((target?: any) : any => ({
    target: target.target,
    priority: target.priority === true
  }));
  const unexpected: any = targets.filter((target?: any) : any => !allowed.has(target.target));
  const missing: any = [...allowed].filter((target?: any) : any => !targets.some((item?: any) : any => item.target === target));
  const unexpectedPriority: any = unexpected.filter((target?: any) : any => target.priority);
  return {
    allowed: [...allowed],
    targets,
    unexpected,
    missing,
    unexpectedPriority
  };
}

async function auditCapability({
  capability,
  operations,
  protocolDefinitions,
  catalogTools,
  testsRegistry,
  pluginRuntime,
  activeFeatureIds
}: Record<string, any>) : Promise<any> {
  const requiredPrefixes: any = capability.requiredRuntimePrefixes || [];
  const requiredIds: any = capability.requiredRuntimeIds || [];
  const knownProtocolPrefixes: any = capability.knownProtocolPrefixes || [];
  const requiredEdges: any = new Set<any>(capability.requiredEdges || []);
  const findings: any[] = [];

  const sourceFiles: any = unique([
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ]);
  const remediation: any = remediationReference(capability);
  const sourceFileStates: any[] = [];
  for (const file of sourceFiles) {
    sourceFileStates.push({
      path: normalizeRelativePath(file),
      exists: await exists(file)
    });
  }
  for (const missingSource of sourceFileStates.filter((item?: any) : any => !item.exists)) {
    addFinding(findings, {
      status: "missing",
      code: "source_file_missing",
      message: `${capability.title} references missing source file ${missingSource.path}.`,
      evidence: { path: missingSource.path },
      remediationPlan: remediation
    });
  }

  const serverOperations: any = byPrefixes(operations, requiredPrefixes, requiredIds);
  const protocolOperations: any = byPrefixes(protocolDefinitions, unique([...requiredPrefixes, ...knownProtocolPrefixes]), []);
  const runtimeOperationIds: any = new Set<any>(serverOperations.map((operation?: any) : any => operation.id));
  const catalogMatches: any = catalogTools.filter((tool?: any) : any => runtimeOperationIds.has(tool.operationId));
  const httpRoutes: any = serverOperations.filter((operation?: any) : any => operation.http?.path);
  const consoleEvidence: any = await buildConsoleEvidence(capability, pluginRuntime);
  const verifierEvidence: any = await buildVerifierEvidence(capability, testsRegistry);
  const mcpOutletCounts: any = countByOutlet(catalogTools);
  const mcpTargetEvidence: any = buildMcpTargetEvidence(capability);

  if (requiredEdges.has("serverOperations") && (requiredPrefixes.length || requiredIds.length) && serverOperations.length === 0) {
    addFinding(findings, {
      status: "missing",
      code: "server_operations_missing",
      message: `${capability.title} has no operation contributions in the audited deployment for required prefixes or ids.`,
      evidence: {
        requiredRuntimePrefixes: requiredPrefixes,
        requiredRuntimeIds: requiredIds,
        protocolDefinitionCount: protocolOperations.length
      },
      remediationPlan: remediation
    });
  }

  for (const prefix of knownProtocolPrefixes) {
    const protocolCount: any = protocolDefinitions.filter((operation?: any) : any => operation.id.startsWith(prefix)).length;
    const serverCount: any = operations.filter((operation?: any) : any => operation.id.startsWith(prefix)).length;
    if (protocolCount > 0 && serverCount === 0) {
      addFinding(findings, {
        status: "disconnected",
        code: "protocol_only_operations",
        message: `${capability.title} has protocol definitions for ${prefix} but no matching current server operations.`,
        evidence: {
          prefix,
          protocolCount,
          serverCount
        },
        remediationPlan: remediation
      });
    }
  }

  if (requiredEdges.has("toolCatalog") && serverOperations.length > 0 && catalogMatches.length === 0) {
    addFinding(findings, {
      status: "disconnected",
      code: "catalog_projection_missing",
      message: `${capability.title} has current server operations but no operation-backed Operation Permission catalog projection.`,
      evidence: {
        serverOperationCount: serverOperations.length,
        catalogProjectionCount: catalogMatches.length
      },
      remediationPlan: remediation
    });
  }

  if (requiredEdges.has("httpRoutes") && serverOperations.length > 0 && httpRoutes.length < serverOperations.length) {
    const missingRoutes: any = serverOperations
      .filter((operation?: any) : any => !operation.http?.path)
      .map((operation?: any) : any => operation.id);
    addFinding(findings, {
      status: "partial",
      severity: "warning",
      code: "http_route_coverage_partial",
      message: `${capability.title} has current operations without HTTP route metadata.`,
      evidence: {
        serverOperationCount: serverOperations.length,
        httpRouteCount: httpRoutes.length,
        missingRoutes: missingRoutes.slice(0, 20)
      },
      remediationPlan: remediation
    });
  }

  if (requiredEdges.has("mcpOutlet")) {
    for (const outlet of capability.mcpOutlets || []) {
      const visibleCount: any = mcpOutletCounts[outlet] || 0;
      if (outlet !== MCP_DISCOVERY_TOOL_NAME && visibleCount === 0) {
        addFinding(findings, {
          status: "non_runnable",
          code: "mcp_outlet_empty",
          message: `${capability.title} requires MCP outlet ${outlet}, but the audited deployment catalog has no concrete operation-backed tools for that outlet.`,
          evidence: {
            outlet,
            visibleOperationCount: visibleCount
          },
          remediationPlan: remediation
        });
      }
    }
  }

  if (requiredEdges.has("console") && consoleEvidence.expected.length > 0) {
    const missingConsole: any = consoleEvidence.expected.filter((feature?: any) : any => !consoleEvidence.matched.includes(feature));
    if (missingConsole.length > 0) {
      addFinding(findings, {
        status: "partial",
        severity: "warning",
        code: "console_feature_missing",
        message: `${capability.title} is missing expected console feature registrations.`,
        evidence: {
          missingConsole,
          matchedConsole: consoleEvidence.matched,
          sources: consoleEvidence.sources
        },
        remediationPlan: remediation
      });
    }
  }

  if (requiredEdges.has("verifier")) {
    const missingVerifierScripts: any = verifierEvidence.scripts.filter((script?: any) : any => !script.exists).map((script?: any) : any => script.path);
    const existingVerifierScripts: any = verifierEvidence.scripts.filter((script?: any) : any => script.exists).map((script?: any) : any => script.path);
    if (missingVerifierScripts.length > 0 || existingVerifierScripts.length === 0) {
      addFinding(findings, {
        status: "non_runnable",
        code: "verifier_missing",
        message: `${capability.title} lacks one or more required verifier scripts.`,
        evidence: {
          missingVerifierScripts,
          existingVerifierScripts
        },
        remediationPlan: remediation
      });
    }
    if (existingVerifierScripts.length > 0 && verifierEvidence.testSuites.length === 0) {
      addFinding(findings, {
        status: "partial",
        severity: "warning",
        code: "verifier_not_registered",
        message: `${capability.title} has verifier scripts that are not wired into the unified test registry.`,
        evidence: {
          existingVerifierScripts
        },
        remediationPlan: remediation
      });
    }
  }

  if (mcpTargetEvidence) {
    if (mcpTargetEvidence.unexpected.length > 0 || mcpTargetEvidence.missing.length > 0) {
      addFinding(findings, {
        status: "non_current",
        code: "mcp_target_scope_mismatch",
        message: `${capability.title} MCP adapter target metadata does not match the internal platform release scope.`,
        evidence: {
          allowed: mcpTargetEvidence.allowed,
          unexpected: mcpTargetEvidence.unexpected,
          missing: mcpTargetEvidence.missing,
          unexpectedPriority: mcpTargetEvidence.unexpectedPriority
        },
        remediationPlan: remediation
      });
    }
  }

  const status: any = statusFromFindings(findings);
  const boundary: any = capabilityBoundary(capability, activeFeatureIds);
  return {
    id: capability.id,
    title: capability.title,
    capabilityClass: boundary.capabilityClass,
    enabled: boundary.enabled,
    coreBlocking: boundary.coreBlocking,
    activationSource: boundary.activationSource,
    status,
    statuses: unique(status === "implemented" ? ["implemented"] : findings.map((finding?: any) : any => finding.status)),
    source: sourceReference(capability),
    evidence: {
      sourceFiles: sourceFileStates,
      requiredRuntimePrefixes: requiredPrefixes,
      serverOperations: serverOperations.map(summarizeOperation),
      protocolDefinitions: protocolOperations.map(summarizeOperation),
      toolCatalog: catalogMatches.map(summarizeTool),
      httpRoutes: httpRoutes.map((operation?: any) : any => ({
        operationId: operation.id,
        method: String(operation.http.method || "GET").toUpperCase(),
        path: operation.http.path
      })),
      mcpOutlets: (capability.mcpOutlets || []).map((outlet?: any) : any => ({
        name: outlet,
        visibleOperationCount: mcpOutletCounts[outlet] || 0
      })),
      console: consoleEvidence,
      verifiers: verifierEvidence,
      mcpTargets: mcpTargetEvidence
    },
    findings
  };
}

function summarizeReport(capabilities?: any) : any {
  const statusCounts: Record<string, any> = {};
  const findingCounts: Record<string, any> = {};
  let criticalFindings: any = 0;
  for (const capability of capabilities) {
    statusCounts[capability.status] = (statusCounts[capability.status] || 0) + 1;
    for (const finding of capability.findings) {
      findingCounts[finding.status] = (findingCounts[finding.status] || 0) + 1;
      if (capability.coreBlocking && finding.severity === "critical" && CRITICAL_STATUSES.has(finding.status)) {
        criticalFindings += 1;
      }
    }
  }
  return {
    capabilityCount: capabilities.length,
    statusCounts,
    findingCounts,
    criticalFindings,
    structuralCoverageReady: criticalFindings === 0,
    behavioralReadinessClaimed: false,
    releaseReadinessClaimed: false,
    disabledDetachableCapabilityCount: capabilities.filter((capability?: any) : any =>
      capability.capabilityClass === "detachable-core" && capability.enabled !== true
    ).length,
    externalPluginCapabilityCount: capabilities.filter((capability?: any) : any =>
      capability.capabilityClass === "external-plugin"
    ).length
  };
}

function assertNoAbsolutePaths(value?: any) : any {
  const text: any = JSON.stringify(value);
  const absolutePathPattern: any = /(?:^|["\s])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u;
  if (absolutePathPattern.test(text)) {
    throw new Error("Core platform gap audit report contains a local absolute path.");
  }
}

async function writeJsonAtomic(relativePath?: any, data?: any) : Promise<any> {
  const targetPath: any = repoPath(relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath: any = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const matrix: any = await readJson(options.matrix);
  if (!Array.isArray(matrix.capabilities) || matrix.capabilities.length === 0) {
    throw new Error(`${options.matrix} must define at least one capability.`);
  }
  for (const capability of matrix.capabilities) {
    if (!new Set<any>(["core", "detachable-core", "external-plugin"]).has(capability.capabilityClass) ||
        (capability.capabilityClass === "detachable-core" && !capability.activationFeatureId)) {
      throw new Error(`${options.matrix} contains an invalid capability boundary for ${capability.id || "unknown"}.`);
    }
  }

  const testsRegistry: any = await readJson("tools/registry/tests.registry.json");
  const coreFeatureRuntime: any = resolveFeatureRuntime({
    edition: "core",
    now: new Date("2026-07-01T00:00:00.000Z")
  });
  const coreOperations: any = filterOperationsForFeatures(SERVER_API_OPERATIONS, coreFeatureRuntime);
  const coreCatalog: any = createToolCatalog({ operations: coreOperations });
  const pluginAudit: any = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
  const capabilities: any[] = [];
  for (const capability of matrix.capabilities) {
    const usePluginDeployment: any = Boolean(capability.pluginId);
    capabilities.push(await auditCapability({
      capability,
      operations: usePluginDeployment ? pluginAudit.operations : coreOperations,
      protocolDefinitions: PROTOCOL_OPERATION_DEFINITIONS,
      catalogTools: usePluginDeployment ? pluginAudit.tools : coreCatalog.tools,
      testsRegistry,
      pluginRuntime: pluginAudit.publicRuntime,
      activeFeatureIds: new Set<any>(coreFeatureRuntime.activeFeatureIds)
    }));
  }

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:platform:gap-audit-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/verifiers/core-platform-gap-audit.ts",
    matrix: normalizeRelativePath(options.matrix),
    algorithms: [
      "core-active catalog scan",
      "explicit all-plugin deployment contribution scan",
      "protocol-to-runtime cross-check",
      "operation-to-tool catalog projection check",
      "MCP outlet concrete-operation count",
      "console feature string-index check",
      "verifier script and test-registry edge check",
      "missing-edge status reduction"
    ],
    summary: {
      ...summarizeReport(capabilities),
      reportLeakScan: true
    },
    capabilities
  };
  assertNoSensitiveLeak(report, "core platform gap audit report");
  assertNoAbsolutePaths(report);
  await writeJsonAtomic(options.report, report);

  const { summary } = report;
  console.log(`[core-platform-gap-audit] report=${normalizeRelativePath(options.report)}`);
  console.log(`[core-platform-gap-audit] capabilities=${summary.capabilityCount} criticalFindings=${summary.criticalFindings} structuralCoverageReady=${summary.structuralCoverageReady}`);
  for (const capability of capabilities) {
    if (capability.status !== "implemented") {
      console.log(`- ${capability.id}: ${capability.status} (${capability.findings.length} findings)`);
    }
  }

  if (!options.allowOpenGaps && summary.criticalFindings > 0) {
    process.exitCode = 1;
  }
  } finally {
    await pluginAudit.close();
  }
}

main().catch((error?: any) : any => {
  console.error(error);
  process.exitCode = 1;
});
