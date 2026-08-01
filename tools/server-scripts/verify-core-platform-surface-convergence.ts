#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.ts";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import {
  FEATURE_MANIFEST,
  filterOperationsForFeatures,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import { mcpOutletForTool } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.ts";
import { createPluginDeploymentAuditCatalog } from "./lib/plugin-deployment-audit-catalog.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MATRIX_PATH: any = "tools/registry/open-platform-capability-matrix.json";
const REPORT_PATH: any = "build/reports/core-platform-surface-convergence.json";

const BASELINE_CAPABILITY_FEATURES: Readonly<Record<string, any>> = Object.freeze({
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

const REQUIRED_PUBLIC_BASELINE_FEATURES: readonly any[] = Object.freeze([
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

function capabilityBoundary(capability?: any, coreActiveFeatures?: any) : any {
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
    const enabled: any = coreActiveFeatures.has(featureId);
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

const PRIVATE_ROOT_PATTERNS: readonly any[] = Object.freeze([
  ["private_app_root", /\bapps\/private\b/iu],
  ["private_package_root", /\bpackages\/private\b/iu],
  ["private_product_root", /\bprivate-product\b/iu],
  ["proprietary_runtime", /\bproprietary-runtime\b/iu],
  ["private_repo_name", /\bmeshrix-private\b/iu]
]);

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function readTextIfExists(relativePath?: any) : Promise<any> {
  try {
    return await readText(relativePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await readText(relativePath));
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

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function operationMatches(operation?: any, prefixes: any = [], ids: any = []) : any {
  const operationId: any = String(operation?.id || "");
  return ids.includes(operationId) || prefixes.some((prefix?: any) : any => operationId.startsWith(prefix));
}

function operationsByCapability(capability?: any, operations?: any) : any {
  return operations.filter((operation?: any) : any =>
    operationMatches(operation, capability.requiredRuntimePrefixes || [], capability.requiredRuntimeIds || [])
  );
}

function protocolByCapability(capability?: any) : any {
  const prefixes: any = uniqueStrings([
    ...(capability.requiredRuntimePrefixes || []),
    ...(capability.knownProtocolPrefixes || [])
  ]);
  return PROTOCOL_OPERATION_DEFINITIONS.filter((operation?: any) : any =>
    prefixes.some((prefix?: any) : any => String(operation.id || "").startsWith(prefix))
  );
}

function featureIdsForCapability(capability?: any) : any {
  return BASELINE_CAPABILITY_FEATURES[capability.id] || [];
}

function outletForTool(tool?: any) : any {
  return mcpOutletForTool(tool).toolName;
}

function countMcpOutlets(tools?: any) : any {
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

function suiteMatchesScript(suite?: any, script?: any) : any {
  return (suite.args || []).map(String).includes(script);
}

async function sourceFileStates(capability?: any) : Promise<any> {
  const sourceFiles: any = uniqueStrings([
    capability.plan,
    ...(capability.docs || []),
    ...(capability.requiredFiles || [])
  ]);
  const states: any[] = [];
  for (const file of sourceFiles) {
    states.push({ path: file, exists: await exists(file) });
  }
  return states;
}

async function consoleFeatureEvidence(capability?: any, pluginRuntime: any = null) : Promise<any> {
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
  const sources: readonly any[] = Object.freeze([
    "packages/foundation/config/frontend-feature-registry.yaml",
    "apps/console/router/admin-route-registry.ts",
    "apps/console/router/routes.ts",
    "apps/console/composables/useConsole.ts"
  ]);
  const combined: any = (await Promise.all(sources.map(readTextIfExists))).join("\n");
  return {
    expected,
    matched: expected.filter((featureId?: any) : any => combined.includes(featureId)),
    sources
  };
}

async function verifierEvidence(capability?: any, testsRegistry?: any) : Promise<any> {
  const scripts: any = capability.verifierScripts || [];
  const scriptStates: any[] = [];
  for (const script of scripts) {
    scriptStates.push({ path: script, exists: await exists(script) });
  }
  const testSuites: any[] = [];
  for (const suite of testsRegistry.suites || []) {
    for (const script of scripts) {
      if (suiteMatchesScript(suite, script)) {
        testSuites.push({ suiteId: suite.id, script });
      }
    }
  }
  return { scripts: scriptStates, testSuites };
}

function buildEditionEvidence() : any {
  const manifestFeatureIds: any = new Set<any>(FEATURE_MANIFEST.features.map((feature?: any) : any => feature.featureId));
  const editions: Record<string, any> = {};
  for (const edition of ["core", "standard", "integrations"]) {
    const runtime: any = resolveFeatureRuntime({ edition, now: new Date("2026-07-01T00:00:00.000Z") });
    const active: any = new Set<any>(runtime.activeFeatureIds);
    editions[edition] = {
      activeBaselineFeatures: REQUIRED_PUBLIC_BASELINE_FEATURES.filter((featureId?: any) : any => active.has(featureId)),
      missingBaselineFeatures: REQUIRED_PUBLIC_BASELINE_FEATURES.filter((featureId?: any) : any => !active.has(featureId))
    };
  }
  return {
    manifestFeatureCount: manifestFeatureIds.size,
    editions
  };
}

function privateBoundaryFindings(values: any = []) : any {
  const findings: any[] = [];
  for (const value of values) {
    const text: any = String(value || "");
    for (const [kind, pattern] of PRIVATE_ROOT_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ kind, value: text });
      }
    }
  }
  return findings;
}

async function publicBoundaryEvidence(matrix?: any) : Promise<any> {
  const featurePackagePaths: any = FEATURE_MANIFEST.features.flatMap((feature?: any) : any => feature.package?.includePaths || []);
  const matrixPaths: any = (matrix.capabilities || []).flatMap((capability?: any) : any => [
    capability.plan,
    ...(capability.docs || []),
    ...(capability.requiredFiles || []),
    ...(capability.verifierScripts || [])
  ]);
  const frontendText: any = await readTextIfExists("packages/foundation/config/frontend-feature-registry.yaml");
  const findings: any = privateBoundaryFindings([
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

function requiredEdgeFailures(capability?: any, edges?: any) : any {
  const required: any = new Set<any>(capability.requiredEdges || []);
  const failures: any[] = [];
  if (required.has("sourceFiles") && edges.docs <= 0) failures.push("sourceFiles");
  if (required.has("serverOperations") && edges.serverOperations <= 0) failures.push("serverOperations");
  if (required.has("toolCatalog") && edges.operationCatalog <= 0) failures.push("toolCatalog");
  if (required.has("mcpOutlet") && edges.mcpOutlet <= 0) failures.push("mcpOutlet");
  if (required.has("httpRoutes") && edges.httpRoutes <= 0) failures.push("httpRoutes");
  if (required.has("console") && edges.console <= 0) failures.push("console");
  if (required.has("verifier") && edges.verifier <= 0) failures.push("verifier");
  return failures;
}

function orphanSurfaceFailures(capability?: any, edges?: any) : any {
  const activeEdges: any = (Object.entries(edges) as [string, any][])
    .filter(([, count]: any[]) : any => Number(count || 0) > 0)
    .map(([edge]: any[]) : any => edge);
  const nonDocEdges: any = activeEdges.filter((edge?: any) : any => edge !== "docs");
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
}: Record<string, any>) : Promise<any> {
  const sourceFiles: any = await sourceFileStates(capability);
  const explicitPluginDeployment: any = Boolean(capability.pluginId);
  const selectedOperations: any = explicitPluginDeployment ? pluginAudit.operations : coreActiveOperations;
  const selectedCatalogTools: any = explicitPluginDeployment ? pluginAudit.tools : coreCatalogTools;
  const serverOperations: any = operationsByCapability(capability, selectedOperations);
  const activeCoreOperations: any = operationsByCapability(capability, coreActiveOperations);
  const protocolDefinitions: any = protocolByCapability(capability);
  const serverOperationIds: any = new Set<any>(serverOperations.map((operation?: any) : any => operation.id));
  const catalogMatches: any = selectedCatalogTools.filter((tool?: any) : any => serverOperationIds.has(tool.operationId));
  const httpRoutes: any = serverOperations.filter((operation?: any) : any => operation.http?.path);
  const mcpOutletCounts: any = countMcpOutlets(selectedCatalogTools);
  const console: any = await consoleFeatureEvidence(capability, pluginAudit.publicRuntime);
  const verifiers: any = await verifierEvidence(capability, testsRegistry);
  const featureIds: any = featureIdsForCapability(capability);
  const featureManifest: any = featureIds.map((featureId?: any) : any => ({
    featureId,
    declared: manifestFeatureIds.has(featureId),
    activeInCore: coreActiveFeatures.has(featureId),
    activeInExplicitDeployment: pluginAudit.featureRuntime.activeFeatureIds.includes(featureId)
  }));
  const requestedMcpOutlets: any = capability.mcpOutlets || [];
  const concreteMcpOutletCount: any = requestedMcpOutlets
    .filter((outlet?: any) : any => outlet === MCP_DISCOVERY_TOOL_NAME || Number(mcpOutletCounts[outlet] || 0) > 0)
    .length;

  const edges: Record<string, any> = {
    docs: sourceFiles.filter((item?: any) : any => item.exists).length,
    featureManifest: featureManifest.filter((item?: any) : any => item.declared && (
      explicitPluginDeployment ? item.activeInExplicitDeployment : item.activeInCore
    )).length,
    serverOperations: serverOperations.length,
    activeCoreOperations: activeCoreOperations.length,
    protocolDefinitions: protocolDefinitions.length,
    operationCatalog: catalogMatches.length,
    httpRoutes: httpRoutes.length,
    mcpOutlet: concreteMcpOutletCount,
    console: console.expected.length === 0 ? 0 : console.matched.length,
    verifier: verifiers.scripts.filter((item?: any) : any => item.exists).length
  };

  const missing: any[] = [
    ...sourceFiles.filter((item?: any) : any => !item.exists).map((item?: any) : any => `source:${item.path}`),
    ...featureManifest.filter((item?: any) : any => !item.declared).map((item?: any) : any => `feature-declared:${item.featureId}`),
    ...featureManifest.filter((item?: any) : any => item.declared && !(
      explicitPluginDeployment ? item.activeInExplicitDeployment : item.activeInCore
    )).map((item?: any) : any => `${explicitPluginDeployment ? "feature-active-explicit-plugin-deployment" : "feature-active-core"}:${item.featureId}`),
    ...console.expected.filter((featureId?: any) : any => !console.matched.includes(featureId)).map((featureId?: any) : any => `console:${featureId}`),
    ...verifiers.scripts.filter((item?: any) : any => !item.exists).map((item?: any) : any => `verifier:${item.path}`),
    ...requiredEdgeFailures(capability, edges).map((edge?: any) : any => `required-edge:${edge}`),
    ...orphanSurfaceFailures(capability, edges)
  ];

  if (!explicitPluginDeployment && (capability.requiredRuntimePrefixes || capability.requiredRuntimeIds) && serverOperations.length > 0 && activeCoreOperations.length === 0) {
    missing.push("active-core-operation-filter");
  }
  for (const prefix of capability.knownProtocolPrefixes || []) {
    const protocolCount: any = protocolDefinitions.filter((operation?: any) : any => String(operation.id || "").startsWith(prefix)).length;
    const serverCount: any = serverOperations.filter((operation?: any) : any => String(operation.id || "").startsWith(prefix)).length;
    if (protocolCount > 0 && serverCount === 0) {
      missing.push(`protocol-only:${prefix}`);
    }
  }

  const boundary: any = capabilityBoundary(capability, coreActiveFeatures);
  return {
    id: capability.id,
    title: capability.title,
    capabilityClass: boundary.capabilityClass,
    enabled: boundary.enabled,
    coreBlocking: boundary.coreBlocking,
    activationSource: boundary.activationSource,
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
    mcpOutlets: requestedMcpOutlets.map((outlet?: any) : any => ({
      name: outlet,
      visibleOperationCount: mcpOutletCounts[outlet] || 0
    })),
    console,
    verifiers,
    missing,
    surfaceReady: missing.length === 0
  };
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Core platform surface convergence report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() : Promise<any> {
  const matrix: any = await readJson(MATRIX_PATH);
  for (const capability of matrix.capabilities || []) {
    if (!new Set<any>(["core", "detachable-core", "external-plugin"]).has(capability.capabilityClass) ||
        (capability.capabilityClass === "detachable-core" && !capability.activationFeatureId)) {
      throw new Error(`${MATRIX_PATH} contains an invalid capability boundary for ${capability.id || "unknown"}.`);
    }
  }
  const testsRegistry: any = await readJson("tools/registry/tests.registry.json");
  const coreRuntime: any = resolveFeatureRuntime({ edition: "core", now: new Date("2026-07-01T00:00:00.000Z") });
  const coreActiveOperations: any = filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime);
  const coreCatalog: any = createToolCatalog({ operations: coreActiveOperations });
  const pluginAudit: any = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
  const manifestFeatureIds: any = new Set<any>(FEATURE_MANIFEST.features.map((feature?: any) : any => feature.featureId));
  const coreActiveFeatures: any = new Set<any>(coreRuntime.activeFeatureIds);
  const editionEvidence: any = buildEditionEvidence();
  const publicBoundary: any = await publicBoundaryEvidence(matrix);

  const capabilities: any[] = [];
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

  const missingBaselineFeatures: any = (Object.entries(editionEvidence.editions) as [string, any][])
    .flatMap(([edition, value]: any[]) : any => value.missingBaselineFeatures.map((featureId?: any) : any => `${edition}:${featureId}`));
  const failedCapabilities: any = capabilities.filter((capability?: any) : any => !capability.surfaceReady);
  const coreBlockingFailedCapabilities: any = failedCapabilities.filter((capability?: any) : any => capability.coreBlocking);
  const structuralCoverageReady: any = missingBaselineFeatures.length === 0 &&
    publicBoundary.findingCount === 0 &&
    coreBlockingFailedCapabilities.length === 0;
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:platform:surface-convergence-report-2",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-core-platform-surface-convergence.ts",
    sourceOfTruth: {
      capabilityMatrix: MATRIX_PATH,
      featureManifest: "packages/server-runtime/src/composition/features/feature-manifest.ts",
      operationRegistry: "packages/contracts/src/operations/operation-registry.ts",
      protocolDefinitions: "packages/contracts/src/operations/protocol-operation-definitions.ts",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.ts",
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
      coreBlockingFailedCapabilityCount: coreBlockingFailedCapabilities.length,
      missingBaselineFeatureCount: missingBaselineFeatures.length,
      privateBoundaryFindingCount: publicBoundary.findingCount,
      missingBaselineFeatures,
      failedCapabilities: failedCapabilities.map((capability?: any) : any => ({
        id: capability.id,
        missing: capability.missing
      })),
      structuralCoverageReady,
      behavioralReadinessClaimed: false,
      releaseReadinessClaimed: false,
      disabledDetachableCapabilityCount: capabilities.filter((capability?: any) : any =>
        capability.capabilityClass === "detachable-core" && capability.enabled !== true
      ).length,
      externalPluginCapabilityCount: capabilities.filter((capability?: any) : any =>
        capability.capabilityClass === "external-plugin"
      ).length,
      reportLeakScan: true
    }
  };

  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!structuralCoverageReady) {
    console.error(`[core-platform-surface-convergence] report=${REPORT_PATH}`);
    for (const feature of missingBaselineFeatures.slice(0, 30)) {
      console.error(`- baseline:${feature}`);
    }
    for (const capability of coreBlockingFailedCapabilities.slice(0, 20)) {
      console.error(`- ${capability.id}: ${capability.missing.join(",")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[core-platform-surface-convergence] capabilities=${capabilities.length} structuralCoverageReady=true report=${REPORT_PATH}`);
  } finally {
    await pluginAudit.close();
  }
}

await main();
