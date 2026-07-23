#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import {
  filterOperationsForFeatures,
  resolveFeatureRuntime,
} from "../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import {
  MCP_CLIENT_TARGETS,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { mcpOutletForTool } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.mjs";
import { MCP_SUPPORTED_TARGETS } from "../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";
import { assertNoLeak as assertNoSensitiveLeak } from "../server-scripts/lib/report-evidence-safety.mjs";
import { createPluginDeploymentAuditCatalog } from "../server-scripts/lib/plugin-deployment-audit-catalog.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_MATRIX_PATH = "tools/registry/open-platform-capability-matrix.json";
const DEFAULT_REPORT_PATH = "build/reports/core-platform-gap-audit.json";

const STATUS_PRIORITY = Object.freeze([
  "missing",
  "disconnected",
  "non_current",
  "non_runnable",
  "partial",
  "implemented"
]);

const CRITICAL_STATUSES = new Set([
  "missing",
  "disconnected",
  "non_current",
  "non_runnable"
]);

function parseArgs(argv) {
  const options = {
    allowOpenGaps: false,
    matrix: DEFAULT_MATRIX_PATH,
    report: DEFAULT_REPORT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node tools/verifiers/core-platform-gap-audit.mjs
  node tools/verifiers/core-platform-gap-audit.mjs --allow-open-gaps

Options:
  --allow-open-gaps  Write the report and exit 0 even when release-blocking gaps exist.
  --matrix <path>    Capability matrix JSON path. Defaults to ${DEFAULT_MATRIX_PATH}.
  --report <path>    Report JSON path. Defaults to ${DEFAULT_REPORT_PATH}.`);
}

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/^\.?\//u, "");
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

async function readTextIfExists(relativePath) {
  try {
    return await fs.readFile(repoPath(relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function exists(relativePath) {
  try {
    await fs.stat(repoPath(relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function operationMatches(operation, prefixes = [], ids = []) {
  const operationId = String(operation?.id || operation?.operationId || "");
  return ids.includes(operationId) || prefixes.some((prefix) => operationId.startsWith(prefix));
}

function byPrefixes(items, prefixes = [], ids = []) {
  return items.filter((item) => operationMatches(item, prefixes, ids));
}

function summarizeOperation(operation) {
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

function summarizeTool(tool) {
  return {
    id: tool.id,
    operationId: tool.operationId || "",
    toolsets: tool.toolsets || [],
    requiredScopes: tool.requiredScopes || [],
    risk: tool.risk || "",
    status: tool.status || ""
  };
}

function outletForTool(tool) {
  return mcpOutletForTool(tool).toolName;
}

function countByOutlet(tools) {
  const counts = {
    [MCP_DISCOVERY_TOOL_NAME]: 1,
    [MCP_GATEWAY_TOOL_NAME]: 0
  };
  for (const tool of tools) {
    const outlet = outletForTool(tool);
    counts[outlet] = (counts[outlet] || 0) + 1;
  }
  return counts;
}

function statusFromFindings(findings) {
  if (findings.length === 0) {
    return "implemented";
  }
  const statuses = new Set(findings.map((finding) => finding.status));
  for (const status of STATUS_PRIORITY) {
    if (statuses.has(status)) {
      return status;
    }
  }
  return "partial";
}

function addFinding(findings, {
  status,
  severity = "critical",
  code,
  message,
  evidence = {},
  remediationPlan = ""
}) {
  findings.push({
    status,
    severity,
    code,
    message,
    evidence,
    remediationPlan
  });
}

function sourceReference(capability) {
  return {
    capabilityId: capability.id,
    publicDocs: capability.docs || [],
    requirementRows: capability.requirementRows || []
  };
}

function remediationReference(capability) {
  return unique([
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ])[0] || "";
}

function scanTextForAny(text, values) {
  return unique(values).filter((value) => text.includes(value));
}

async function buildConsoleEvidence(capability, pluginRuntime = null) {
  const expected = capability.expectedConsoleFeatures || [];
  if (capability.pluginId) {
    const entries = (pluginRuntime?.consoleEntries || [])
      .filter((entry) => entry.pluginId === capability.pluginId)
      .map((entry) => entry.id);
    return {
      expected,
      matched: expected.filter((entryId) => entries.includes(entryId)),
      sources: [`plugins/${capability.pluginId}/plugin.json`, `plugins/${capability.pluginId}/runtime.mjs`]
    };
  }
  const featureRegistry = await readTextIfExists("packages/foundation/config/frontend-feature-registry.yaml");
  const adminRegistry = await readTextIfExists("apps/console/router/admin-route-registry.mjs");
  const routeRegistry = await readTextIfExists("apps/console/router/routes.ts");
  const combined = [featureRegistry, adminRegistry, routeRegistry].join("\n");
  return {
    expected,
    matched: scanTextForAny(combined, expected),
    sources: [
      "packages/foundation/config/frontend-feature-registry.yaml",
      "apps/console/router/admin-route-registry.mjs",
      "apps/console/router/routes.ts"
    ]
  };
}

async function buildVerifierEvidence(capability, testsRegistry) {
  const scripts = capability.verifierScripts || [];
  const scriptStates = [];
  for (const script of scripts) {
    scriptStates.push({
      path: script,
      exists: await exists(script)
    });
  }
  const suiteMatches = [];
  for (const suite of testsRegistry.suites || []) {
    const args = (suite.args || []).map((arg) => String(arg));
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

function buildMcpTargetEvidence(capability) {
  const allowedTargets = capability.allowedMcpTargets === "$MCP_SUPPORTED_TARGETS"
    ? MCP_SUPPORTED_TARGETS
    : capability.allowedMcpTargets || [];
  const allowed = new Set(allowedTargets);
  if (!allowed.size) {
    return null;
  }
  const targets = MCP_CLIENT_TARGETS.map((target) => ({
    target: target.target,
    priority: target.priority === true
  }));
  const unexpected = targets.filter((target) => !allowed.has(target.target));
  const missing = [...allowed].filter((target) => !targets.some((item) => item.target === target));
  const unexpectedPriority = unexpected.filter((target) => target.priority);
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
  pluginRuntime
}) {
  const requiredPrefixes = capability.requiredRuntimePrefixes || [];
  const requiredIds = capability.requiredRuntimeIds || [];
  const knownProtocolPrefixes = capability.knownProtocolPrefixes || [];
  const requiredEdges = new Set(capability.requiredEdges || []);
  const findings = [];

  const sourceFiles = unique([
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ]);
  const remediation = remediationReference(capability);
  const sourceFileStates = [];
  for (const file of sourceFiles) {
    sourceFileStates.push({
      path: normalizeRelativePath(file),
      exists: await exists(file)
    });
  }
  for (const missingSource of sourceFileStates.filter((item) => !item.exists)) {
    addFinding(findings, {
      status: "missing",
      code: "source_file_missing",
      message: `${capability.title} references missing source file ${missingSource.path}.`,
      evidence: { path: missingSource.path },
      remediationPlan: remediation
    });
  }

  const serverOperations = byPrefixes(operations, requiredPrefixes, requiredIds);
  const protocolOperations = byPrefixes(protocolDefinitions, unique([...requiredPrefixes, ...knownProtocolPrefixes]), []);
  const runtimeOperationIds = new Set(serverOperations.map((operation) => operation.id));
  const catalogMatches = catalogTools.filter((tool) => runtimeOperationIds.has(tool.operationId));
  const httpRoutes = serverOperations.filter((operation) => operation.http?.path);
  const consoleEvidence = await buildConsoleEvidence(capability, pluginRuntime);
  const verifierEvidence = await buildVerifierEvidence(capability, testsRegistry);
  const mcpOutletCounts = countByOutlet(catalogTools);
  const mcpTargetEvidence = buildMcpTargetEvidence(capability);

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
    const protocolCount = protocolDefinitions.filter((operation) => operation.id.startsWith(prefix)).length;
    const serverCount = operations.filter((operation) => operation.id.startsWith(prefix)).length;
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
    const missingRoutes = serverOperations
      .filter((operation) => !operation.http?.path)
      .map((operation) => operation.id);
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
      const visibleCount = mcpOutletCounts[outlet] || 0;
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
    const missingConsole = consoleEvidence.expected.filter((feature) => !consoleEvidence.matched.includes(feature));
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
    const missingVerifierScripts = verifierEvidence.scripts.filter((script) => !script.exists).map((script) => script.path);
    const existingVerifierScripts = verifierEvidence.scripts.filter((script) => script.exists).map((script) => script.path);
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
        message: `${capability.title} MCP adapter target metadata does not match the open platform release scope.`,
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

  const status = statusFromFindings(findings);
  return {
    id: capability.id,
    title: capability.title,
    deployment: capability.pluginId ? {
      pluginId: capability.pluginId,
      defaultState: "optional-disabled",
      enabledForAudit: true
    } : {
      defaultState: "core-active",
      enabledForAudit: true
    },
    status,
    statuses: unique(status === "implemented" ? ["implemented"] : findings.map((finding) => finding.status)),
    source: sourceReference(capability),
    evidence: {
      sourceFiles: sourceFileStates,
      requiredRuntimePrefixes: requiredPrefixes,
      serverOperations: serverOperations.map(summarizeOperation),
      protocolDefinitions: protocolOperations.map(summarizeOperation),
      toolCatalog: catalogMatches.map(summarizeTool),
      httpRoutes: httpRoutes.map((operation) => ({
        operationId: operation.id,
        method: String(operation.http.method || "GET").toUpperCase(),
        path: operation.http.path
      })),
      mcpOutlets: (capability.mcpOutlets || []).map((outlet) => ({
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

function summarizeReport(capabilities) {
  const statusCounts = {};
  const findingCounts = {};
  let criticalFindings = 0;
  for (const capability of capabilities) {
    statusCounts[capability.status] = (statusCounts[capability.status] || 0) + 1;
    for (const finding of capability.findings) {
      findingCounts[finding.status] = (findingCounts[finding.status] || 0) + 1;
      if (finding.severity === "critical" && CRITICAL_STATUSES.has(finding.status)) {
        criticalFindings += 1;
      }
    }
  }
  return {
    capabilityCount: capabilities.length,
    statusCounts,
    findingCounts,
    criticalFindings,
    releaseReady: criticalFindings === 0
  };
}

function assertNoAbsolutePaths(value) {
  const text = JSON.stringify(value);
  const absolutePathPattern = /(?:^|["\s])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u;
  if (absolutePathPattern.test(text)) {
    throw new Error("Core platform gap audit report contains a local absolute path.");
  }
}

async function writeJsonAtomic(relativePath, data) {
  const targetPath = repoPath(relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const matrix = await readJson(options.matrix);
  if (!Array.isArray(matrix.capabilities) || matrix.capabilities.length === 0) {
    throw new Error(`${options.matrix} must define at least one capability.`);
  }

  const testsRegistry = await readJson("tools/registry/tests.registry.json");
  const coreFeatureRuntime = resolveFeatureRuntime({
    edition: "core",
    now: new Date("2026-07-01T00:00:00.000Z")
  });
  const coreOperations = filterOperationsForFeatures(SERVER_API_OPERATIONS, coreFeatureRuntime);
  const coreCatalog = createToolCatalog({ operations: coreOperations });
  const pluginAudit = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
  const capabilities = [];
  for (const capability of matrix.capabilities) {
    const usePluginDeployment = Boolean(capability.pluginId);
    capabilities.push(await auditCapability({
      capability,
      operations: usePluginDeployment ? pluginAudit.operations : coreOperations,
      protocolDefinitions: PROTOCOL_OPERATION_DEFINITIONS,
      catalogTools: usePluginDeployment ? pluginAudit.tools : coreCatalog.tools,
      testsRegistry,
      pluginRuntime: pluginAudit.publicRuntime
    }));
  }

  const report = {
    schemaVersion: "v0.0.1:platform:gap-audit-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/verifiers/core-platform-gap-audit.mjs",
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
  console.log(`[core-platform-gap-audit] capabilities=${summary.capabilityCount} criticalFindings=${summary.criticalFindings} releaseReady=${summary.releaseReady}`);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
