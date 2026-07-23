import fs from "node:fs/promises";
import path from "node:path";

import { sourceEvidence } from "./console-administration-coverage-helpers.mjs";
import {
  pluginConsoleEntry,
  routePathFromViewKey
} from "./console-administration-plugin-coverage.mjs";

async function fileExists(repoRoot, relativePath) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readText(repoRoot, relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

export function evaluatePluginConsoleAuthority({
  authorities,
  pluginConsoleEntries,
  featureRegistry,
  adminRouteRegistry
}) {
  return authorities.map((expected) => {
    const dynamicEntry = pluginConsoleEntries.find((entry) => (
      entry.pluginId === expected.pluginId && entry.id === expected.id
    ));
    const staticRoutePresent = featureRegistry.includes(`routePath: ${expected.routePath}`) ||
      adminRouteRegistry.some((entry) => (
        entry.viewKey === expected.viewKey || `/admin/${entry.slug}` === expected.routePath
      ));
    const dynamicMatches = Boolean(dynamicEntry) &&
      dynamicEntry.viewKey === expected.viewKey &&
      dynamicEntry.routePath === expected.routePath &&
      dynamicEntry.componentId === expected.componentId;
    return {
      ...expected,
      dynamicMatches,
      staticRoutePresent,
      ready: dynamicMatches && !staticRoutePresent
    };
  });
}

export async function evaluateConsoleAdministrationWorkflow({
  workflow,
  repoRoot,
  operations,
  pluginConsoleEntries,
  executorFeatureIds,
  featureRegistry,
  adminRouteRegistry
}) {
  const dynamicConsoleEntry = pluginConsoleEntry(workflow, pluginConsoleEntries);
  const sourceEntries = await Promise.all(workflow.sourceFiles.map(async (relativePath) => {
    const exists = await fileExists(repoRoot, relativePath);
    return {
      path: relativePath,
      exists,
      text: exists ? await readText(repoRoot, relativePath) : ""
    };
  }));
  const combinedSource = sourceEntries.map((entry) => entry.text).join("\n");

  const routeCoverage = workflow.routePaths.map((routePath) => ({
    routePath,
    inFeatureRegistry: workflow.pluginId
      ? dynamicConsoleEntry?.routePath === routePath
      : featureRegistry.includes(`routePath: ${routePath}`),
    authority: workflow.pluginId ? "plugin-console-contribution" : "frontend-feature-registry"
  }));
  const adminRouteCoverage = workflow.viewKeys.map((viewKey) => ({
    viewKey,
    inAdminRouteRegistry: routePathFromViewKey(viewKey, pluginConsoleEntries, adminRouteRegistry) !== "",
    routePath: routePathFromViewKey(viewKey, pluginConsoleEntries, adminRouteRegistry),
    authority: workflow.pluginId ? "plugin-console-contribution" : "admin-route-registry"
  }));
  const featureCoverage = workflow.featureIds.map((featureId) => ({
    featureId,
    registered: workflow.pluginId
      ? dynamicConsoleEntry?.id === featureId
      : featureRegistry.includes(`featureId: ${featureId}`),
    authority: workflow.pluginId ? "plugin-console-contribution" : "frontend-feature-registry"
  }));
  const actionCoverage = workflow.actionIds.map((actionId) => ({
    actionId,
    registered: featureRegistry.includes(`- ${actionId}`)
  }));
  const executorCoverage = workflow.executorFeatureIds.map((featureId) => ({
    featureId,
    registered: executorFeatureIds.has(featureId)
  }));
  const operationCoverage = workflow.operationIds.map((operationId) => {
    const operation = operations.get(operationId);
    const evidence = operation ? sourceEvidence(operation, combinedSource) : {
      hasOperationId: false,
      hasEndpoint: false,
      hasMethodEndpoint: false,
      ok: false
    };
    return {
      operationId,
      registered: Boolean(operation),
      httpMethod: operation?.http?.method || "",
      httpPath: operation?.http?.path || "",
      rpcMethod: operation?.rpc?.method || "",
      sourceEvidence: evidence
    };
  });
  const stateCoverage = (workflow.stateTokens || []).map((token) => ({
    token,
    present: combinedSource.includes(token)
  }));
  const stateContractCoverage = await Promise.all(
    (workflow.stateContracts || []).map(async (contract) => {
      const exists = await fileExists(repoRoot, contract.sourceFile);
      const sourceText = exists ? await readText(repoRoot, contract.sourceFile) : "";
      const checks = contract.checks.map((check) => ({
        id: check.id,
        present: exists && check.pattern.test(sourceText)
      }));
      return {
        id: contract.id,
        sourceFile: contract.sourceFile,
        exists,
        checks,
        contractReady: exists && checks.every((check) => check.present)
      };
    })
  );
  const verifierCoverage = await Promise.all(workflow.verifierFiles.map(async (relativePath) => ({
    path: relativePath,
    exists: await fileExists(repoRoot, relativePath)
  })));

  const missing = [
    ...sourceEntries.filter((entry) => !entry.exists).map((entry) => `source:${entry.path}`),
    ...routeCoverage.filter((entry) => !entry.inFeatureRegistry).map((entry) => `feature-route:${entry.routePath}`),
    ...adminRouteCoverage.filter((entry) => !entry.inAdminRouteRegistry).map((entry) => `admin-route:${entry.viewKey}`),
    ...featureCoverage.filter((entry) => !entry.registered).map((entry) => `feature:${entry.featureId}`),
    ...actionCoverage.filter((entry) => !entry.registered).map((entry) => `action:${entry.actionId}`),
    ...executorCoverage.filter((entry) => !entry.registered).map((entry) => `executor:${entry.featureId}`),
    ...operationCoverage.filter((entry) => !entry.registered).map((entry) => `operation:${entry.operationId}`),
    ...operationCoverage.filter((entry) => entry.registered && !entry.sourceEvidence.ok).map((entry) => `source-evidence:${entry.operationId}`),
    ...stateCoverage.filter((entry) => !entry.present).map((entry) => `state:${entry.token}`),
    ...stateContractCoverage.filter((entry) => !entry.exists).map((entry) => `state-contract-source:${entry.id}`),
    ...stateContractCoverage.flatMap((entry) => entry.checks
      .filter((check) => !check.present)
      .map((check) => `state-contract:${entry.id}:${check.id}`)),
    ...verifierCoverage.filter((entry) => !entry.exists).map((entry) => `verifier:${entry.path}`)
  ];

  return {
    id: workflow.id,
    title: workflow.title,
    deployment: workflow.pluginId ? {
      pluginId: workflow.pluginId,
      defaultState: "optional-disabled",
      enabledForAudit: true
    } : {
      defaultState: "core-active",
      enabledForAudit: true
    },
    routeCoverage,
    adminRouteCoverage,
    featureCoverage,
    actionCoverage,
    executorCoverage,
    operationCoverage,
    sourceFiles: sourceEntries.map((entry) => ({ path: entry.path, exists: entry.exists })),
    stateCoverage,
    stateContractCoverage,
    verifierCoverage,
    missing,
    coverageReady: missing.length === 0
  };
}
