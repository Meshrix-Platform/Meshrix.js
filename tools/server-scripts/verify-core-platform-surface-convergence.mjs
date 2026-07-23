#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import {
  FEATURE_MANIFEST,
  filterOperationsForFeatures,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { mcpOutletForTool } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.mjs";
import { createPluginDeploymentAuditCatalog } from "./lib/plugin-deployment-audit-catalog.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MATRIX_PATH = "tools/registry/open-platform-capability-matrix.json";
const REPORT_PATH = "build/reports/core-platform-surface-convergence.json";

const BASELINE_CAPABILITY_FEATURES = Object.freeze({
  "upstream-gateway": ["upstream-gateway"],
  "downstream-mcp": ["downstream-mcp", "operation-permission-core"],
  "strategy-management": ["strategy-management"],
  "enterprise-governance": ["security-permissions", "tag-management", "operation-permission-core", "devops-core"],
  "console-administration": ["console-shell"],
  "container-deployment": ["devops-core"],
  storage: ["storage-core"],
  jobs: ["work-queue-core"],
  "agent-gateway-model-routing": ["agent-gateway"]
});

const REQUIRED_PUBLIC_BASELINE_FEATURES = Object.freeze([
  "operation-permission-core",
  "downstream-mcp",
  "upstream-gateway",
  "agent-memory",
  "strategy-management",
  "tag-management",
  "security-permissions",
  "devops-core",
  "storage-core",
  "work-queue-core",
  "console-shell",
  "agent-gateway"
]);

const PRIVATE_ROOT_PATTERNS = Object.freeze([
  ["private_app_root", /\bapps\/private\b/iu],
  ["private_package_root", /\bpackages\/private\b/iu],
  ["private_product_root", /\bprivate-product\b/iu],
  ["proprietary_runtime", /\bproprietary-runtime\b/iu],
  ["private_repo_name", /\blicomesh-private\b/iu]
]);

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function readTextIfExists(relativePath) {
  try {
    return await readText(relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
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

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function operationMatches(operation, prefixes = [], ids = []) {
  const operationId = String(operation?.id || "");
  return ids.includes(operationId) || prefixes.some((prefix) => operationId.startsWith(prefix));
}

function operationsByCapability(capability, operations) {
  return operations.filter((operation) =>
    operationMatches(operation, capability.requiredRuntimePrefixes || [], capability.requiredRuntimeIds || [])
  );
}

function protocolByCapability(capability) {
  const prefixes = uniqueStrings([
    ...(capability.requiredRuntimePrefixes || []),
    ...(capability.knownProtocolPrefixes || [])
  ]);
  return PROTOCOL_OPERATION_DEFINITIONS.filter((operation) =>
    prefixes.some((prefix) => String(operation.id || "").startsWith(prefix))
  );
}

function featureIdsForCapability(capability) {
  return BASELINE_CAPABILITY_FEATURES[capability.id] || [];
}

function outletForTool(tool) {
  return mcpOutletForTool(tool).toolName;
}

function countMcpOutlets(tools) {
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

function suiteMatchesScript(suite, script) {
  return (suite.args || []).map(String).includes(script);
}

async function sourceFileStates(capability) {
  const sourceFiles = uniqueStrings([
    capability.plan,
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ]);
  const states = [];
  for (const file of sourceFiles) {
    states.push({ path: file, exists: await exists(file) });
  }
  return states;
}

async function consoleFeatureEvidence(capability, pluginRuntime = null) {
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
  const sources = Object.freeze([
    "packages/foundation/config/frontend-feature-registry.yaml",
    "apps/console/router/admin-route-registry.mjs",
    "apps/console/router/routes.ts",
    "apps/console/composables/useConsole.ts"
  ]);
  const combined = (await Promise.all(sources.map(readTextIfExists))).join("\n");
  return {
    expected,
    matched: expected.filter((featureId) => combined.includes(featureId)),
    sources
  };
}

async function verifierEvidence(capability, testsRegistry) {
  const scripts = capability.verifierScripts || [];
  const scriptStates = [];
  for (const script of scripts) {
    scriptStates.push({ path: script, exists: await exists(script) });
  }
  const testSuites = [];
  for (const suite of testsRegistry.suites || []) {
    for (const script of scripts) {
      if (suiteMatchesScript(suite, script)) {
        testSuites.push({ suiteId: suite.id, script });
      }
    }
  }
  return { scripts: scriptStates, testSuites };
}

function buildEditionEvidence() {
  const manifestFeatureIds = new Set(FEATURE_MANIFEST.features.map((feature) => feature.featureId));
  const editions = {};
  for (const edition of ["core", "standard", "integrations"]) {
    const runtime = resolveFeatureRuntime({ edition, now: new Date("2026-07-01T00:00:00.000Z") });
    const active = new Set(runtime.activeFeatureIds);
    editions[edition] = {
      activeBaselineFeatures: REQUIRED_PUBLIC_BASELINE_FEATURES.filter((featureId) => active.has(featureId)),
      missingBaselineFeatures: REQUIRED_PUBLIC_BASELINE_FEATURES.filter((featureId) => !active.has(featureId))
    };
  }
  return {
    manifestFeatureCount: manifestFeatureIds.size,
    editions
  };
}

function privateBoundaryFindings(values = []) {
  const findings = [];
  for (const value of values) {
    const text = String(value || "");
    for (const [kind, pattern] of PRIVATE_ROOT_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ kind, value: text });
      }
    }
  }
  return findings;
}

async function publicBoundaryEvidence(matrix) {
  const featurePackagePaths = FEATURE_MANIFEST.features.flatMap((feature) => feature.package?.includePaths || []);
  const matrixPaths = (matrix.capabilities || []).flatMap((capability) => [
    capability.plan,
    ...(capability.docs || []),
    ...(capability.requiredFiles || []),
    ...(capability.verifierScripts || [])
  ]);
  const frontendText = await readTextIfExists("packages/foundation/config/frontend-feature-registry.yaml");
  const findings = privateBoundaryFindings([
    ...featurePackagePaths,
    ...matrixPaths,
    frontendText
  ]);
  return {
    scannedFeaturePackagePaths: featurePackagePaths.length,
    scannedMatrixPaths: matrixPaths.length,
    findingCount: findings.length,
    findings
  };
}

function requiredEdgeFailures(capability, edges) {
  const required = new Set(capability.requiredEdges || []);
  const failures = [];
  if (required.has("sourceFiles") && edges.docs <= 0) failures.push("sourceFiles");
  if (required.has("serverOperations") && edges.serverOperations <= 0) failures.push("serverOperations");
  if (required.has("toolCatalog") && edges.operationCatalog <= 0) failures.push("toolCatalog");
  if (required.has("mcpOutlet") && edges.mcpOutlet <= 0) failures.push("mcpOutlet");
  if (required.has("httpRoutes") && edges.httpRoutes <= 0) failures.push("httpRoutes");
  if (required.has("console") && edges.console <= 0) failures.push("console");
  if (required.has("verifier") && edges.verifier <= 0) failures.push("verifier");
  return failures;
}

function orphanSurfaceFailures(capability, edges) {
  const activeEdges = Object.entries(edges)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([edge]) => edge);
  const nonDocEdges = activeEdges.filter((edge) => edge !== "docs");
  if (capability.requiredEdges?.includes("sourceFiles") && nonDocEdges.includes("verifier")) {
    return [];
  }
  if (nonDocEdges.length <= 1) {
    return [`surface_island:${nonDocEdges[0] || "docs-only"}`];
  }
  return [];
}

async function buildCapabilityReport({
  capability,
  testsRegistry,
  coreCatalogTools,
  coreActiveOperations,
  pluginAudit,
  manifestFeatureIds,
  coreActiveFeatures
}) {
  const sourceFiles = await sourceFileStates(capability);
  const explicitPluginDeployment = Boolean(capability.pluginId);
  const selectedOperations = explicitPluginDeployment ? pluginAudit.operations : coreActiveOperations;
  const selectedCatalogTools = explicitPluginDeployment ? pluginAudit.tools : coreCatalogTools;
  const serverOperations = operationsByCapability(capability, selectedOperations);
  const activeCoreOperations = operationsByCapability(capability, coreActiveOperations);
  const protocolDefinitions = protocolByCapability(capability);
  const serverOperationIds = new Set(serverOperations.map((operation) => operation.id));
  const catalogMatches = selectedCatalogTools.filter((tool) => serverOperationIds.has(tool.operationId));
  const httpRoutes = serverOperations.filter((operation) => operation.http?.path);
  const mcpOutletCounts = countMcpOutlets(selectedCatalogTools);
  const console = await consoleFeatureEvidence(capability, pluginAudit.publicRuntime);
  const verifiers = await verifierEvidence(capability, testsRegistry);
  const featureIds = featureIdsForCapability(capability);
  const featureManifest = featureIds.map((featureId) => ({
    featureId,
    declared: manifestFeatureIds.has(featureId),
    activeInCore: coreActiveFeatures.has(featureId),
    activeInExplicitDeployment: pluginAudit.featureRuntime.activeFeatureIds.includes(featureId)
  }));
  const requestedMcpOutlets = capability.mcpOutlets || [];
  const concreteMcpOutletCount = requestedMcpOutlets
    .filter((outlet) => outlet === MCP_DISCOVERY_TOOL_NAME || Number(mcpOutletCounts[outlet] || 0) > 0)
    .length;

  const edges = {
    docs: sourceFiles.filter((item) => item.exists).length,
    featureManifest: featureManifest.filter((item) => item.declared && (
      explicitPluginDeployment ? item.activeInExplicitDeployment : item.activeInCore
    )).length,
    serverOperations: serverOperations.length,
    activeCoreOperations: activeCoreOperations.length,
    protocolDefinitions: protocolDefinitions.length,
    operationCatalog: catalogMatches.length,
    httpRoutes: httpRoutes.length,
    mcpOutlet: concreteMcpOutletCount,
    console: console.expected.length === 0 ? 0 : console.matched.length,
    verifier: verifiers.scripts.filter((item) => item.exists).length
  };

  const missing = [
    ...sourceFiles.filter((item) => !item.exists).map((item) => `source:${item.path}`),
    ...featureManifest.filter((item) => !item.declared).map((item) => `feature-declared:${item.featureId}`),
    ...featureManifest.filter((item) => item.declared && !(
      explicitPluginDeployment ? item.activeInExplicitDeployment : item.activeInCore
    )).map((item) => `${explicitPluginDeployment ? "feature-active-explicit-plugin-deployment" : "feature-active-core"}:${item.featureId}`),
    ...console.expected.filter((featureId) => !console.matched.includes(featureId)).map((featureId) => `console:${featureId}`),
    ...verifiers.scripts.filter((item) => !item.exists).map((item) => `verifier:${item.path}`),
    ...requiredEdgeFailures(capability, edges).map((edge) => `required-edge:${edge}`),
    ...orphanSurfaceFailures(capability, edges)
  ];

  if (!explicitPluginDeployment && (capability.requiredRuntimePrefixes || capability.requiredRuntimeIds) && serverOperations.length > 0 && activeCoreOperations.length === 0) {
    missing.push("active-core-operation-filter");
  }
  for (const prefix of capability.knownProtocolPrefixes || []) {
    const protocolCount = protocolDefinitions.filter((operation) => String(operation.id || "").startsWith(prefix)).length;
    const serverCount = serverOperations.filter((operation) => String(operation.id || "").startsWith(prefix)).length;
    if (protocolCount > 0 && serverCount === 0) {
      missing.push(`protocol-only:${prefix}`);
    }
  }

  return {
    id: capability.id,
    title: capability.title,
    deployment: explicitPluginDeployment ? {
      pluginId: capability.pluginId,
      defaultState: "optional-disabled",
      enabledForAudit: true
    } : {
      defaultState: "core-active",
      enabledForAudit: true
    },
    featureManifest,
    edges,
    sourceFiles,
    operationSummary: {
      serverOperationCount: serverOperations.length,
      activeCoreOperationCount: activeCoreOperations.length,
      protocolDefinitionCount: protocolDefinitions.length,
      catalogToolCount: catalogMatches.length,
      httpRouteCount: httpRoutes.length
    },
    mcpOutlets: requestedMcpOutlets.map((outlet) => ({
      name: outlet,
      visibleOperationCount: mcpOutletCounts[outlet] || 0
    })),
    console,
    verifiers,
    missing,
    surfaceReady: missing.length === 0
  };
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Core platform surface convergence report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() {
  const matrix = await readJson(MATRIX_PATH);
  const testsRegistry = await readJson("tools/registry/tests.registry.json");
  const coreRuntime = resolveFeatureRuntime({ edition: "core", now: new Date("2026-07-01T00:00:00.000Z") });
  const coreActiveOperations = filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime);
  const coreCatalog = createToolCatalog({ operations: coreActiveOperations });
  const pluginAudit = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
  const manifestFeatureIds = new Set(FEATURE_MANIFEST.features.map((feature) => feature.featureId));
  const coreActiveFeatures = new Set(coreRuntime.activeFeatureIds);
  const editionEvidence = buildEditionEvidence();
  const publicBoundary = await publicBoundaryEvidence(matrix);

  const capabilities = [];
  for (const capability of matrix.capabilities || []) {
    capabilities.push(await buildCapabilityReport({
      capability,
      testsRegistry,
      coreCatalogTools: coreCatalog.tools,
      coreActiveOperations,
      pluginAudit,
      manifestFeatureIds,
      coreActiveFeatures
    }));
  }

  const missingBaselineFeatures = Object.entries(editionEvidence.editions)
    .flatMap(([edition, value]) => value.missingBaselineFeatures.map((featureId) => `${edition}:${featureId}`));
  const failedCapabilities = capabilities.filter((capability) => !capability.surfaceReady);
  const surfaceReady = missingBaselineFeatures.length === 0 &&
    publicBoundary.findingCount === 0 &&
    failedCapabilities.length === 0;
  const report = {
    schemaVersion: "v0.0.1:platform:surface-convergence-report-2",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-core-platform-surface-convergence.mjs",
    sourceOfTruth: {
      capabilityMatrix: MATRIX_PATH,
      featureManifest: "packages/server-runtime/src/composition/features/feature-manifest.mjs",
      operationRegistry: "packages/contracts/src/operations/operation-registry.mjs",
      protocolDefinitions: "packages/contracts/src/operations/protocol-operation-definitions.mjs",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.mjs",
      frontendFeatureRegistry: "packages/foundation/config/frontend-feature-registry.yaml",
      testRegistry: "tools/registry/tests.registry.json"
    },
    algorithm: {
      editionCheck: "Resolve core, standard, and integrations feature runtimes, require only core-owned baseline features, and record optional plugins as disabled until selected by runtime.enabledPlugins.",
      surfaceGraph: "For core capabilities, inspect the core-active operation catalog. For optional capabilities, activate the catalog-backed all-plugin deployment and inspect its runtime operations, routes, MCP bindings, console entries, verifier hooks, and Operation Permission projection.",
      islandDetection: "Fail a capability when it is represented by only one non-document surface or when a required matrix edge is absent.",
      publicBoundary: "Scan public feature, matrix, and console registry paths for private product roots.",
      leakScan: "Reject local absolute paths, bearer values, secret-looking tokens, runtime ids, raw prompts, and private payload markers in the report."
    },
    editionEvidence,
    publicBoundary,
    capabilities,
    summary: {
      capabilityCount: capabilities.length,
      failedCapabilityCount: failedCapabilities.length,
      missingBaselineFeatureCount: missingBaselineFeatures.length,
      privateBoundaryFindingCount: publicBoundary.findingCount,
      missingBaselineFeatures,
      failedCapabilities: failedCapabilities.map((capability) => ({
        id: capability.id,
        missing: capability.missing
      })),
      surfaceReady,
      releaseReady: surfaceReady,
      coverageReady: surfaceReady,
      reportLeakScan: true
    }
  };

  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!surfaceReady) {
    console.error(`[core-platform-surface-convergence] report=${REPORT_PATH}`);
    for (const feature of missingBaselineFeatures.slice(0, 30)) {
      console.error(`- baseline:${feature}`);
    }
    for (const capability of failedCapabilities.slice(0, 20)) {
      console.error(`- ${capability.id}: ${capability.missing.join(",")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[core-platform-surface-convergence] capabilities=${capabilities.length} surfaceReady=true report=${REPORT_PATH}`);
  } finally {
    await pluginAudit.close();
  }
}

await main();
