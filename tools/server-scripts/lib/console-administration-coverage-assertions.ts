import fs from "node:fs/promises";
import path from "node:path";

import { sourceEvidence } from "./console-administration-coverage-helpers.ts";
import {
  pluginConsoleEntry,
  routePathFromViewKey
} from "./console-administration-plugin-coverage.ts";

async function fileExists(repoRoot?: any, relativePath?: any) : Promise<any> {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readText(repoRoot?: any, relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

export function evaluatePluginConsoleAuthority({
  authorities,
  pluginConsoleEntries,
  featureRegistry,
  adminRouteRegistry
}: Record<string, any>) : any {
  return authorities.map((expected?: any) : any => {
    const dynamicEntry: any = pluginConsoleEntries.find((entry?: any) : any => (
      entry.pluginId === expected.pluginId && entry.id === expected.id
    ));
    const staticRoutePresent: any = featureRegistry.includes(`routePath: ${expected.routePath}`) ||
      adminRouteRegistry.some((entry?: any) : any => (
        entry.viewKey === expected.viewKey || `/admin/${entry.slug}` === expected.routePath
      ));
    const dynamicMatches: any = Boolean(dynamicEntry) &&
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
}: Record<string, any>) : Promise<any> {
  const dynamicConsoleEntry: any = pluginConsoleEntry(workflow, pluginConsoleEntries);
  const sourceEntries: any = await Promise.all(workflow.sourceFiles.map(async (relativePath?: any) : Promise<any> => {
    const exists: any = await fileExists(repoRoot, relativePath);
    return {
      path: relativePath,
      exists,
      text: exists ? await readText(repoRoot, relativePath) : ""
    };
  }));
  const combinedSource: any = sourceEntries.map((entry?: any) : any => entry.text).join("\n");

  const routeCoverage: any = workflow.routePaths.map((routePath?: any) : any => ({
    routePath,
    inFeatureRegistry: workflow.pluginId
      ? dynamicConsoleEntry?.routePath === routePath
      : featureRegistry.includes(`routePath: ${routePath}`),
    authority: workflow.pluginId ? "plugin-console-contribution" : "frontend-feature-registry"
  }));
  const adminRouteCoverage: any = workflow.viewKeys.map((viewKey?: any) : any => ({
    viewKey,
    inAdminRouteRegistry: routePathFromViewKey(viewKey, pluginConsoleEntries, adminRouteRegistry) !== "",
    routePath: routePathFromViewKey(viewKey, pluginConsoleEntries, adminRouteRegistry),
    authority: workflow.pluginId ? "plugin-console-contribution" : "admin-route-registry"
  }));
  const featureCoverage: any = workflow.featureIds.map((featureId?: any) : any => ({
    featureId,
    registered: workflow.pluginId
      ? dynamicConsoleEntry?.id === featureId
      : featureRegistry.includes(`featureId: ${featureId}`),
    authority: workflow.pluginId ? "plugin-console-contribution" : "frontend-feature-registry"
  }));
  const actionCoverage: any = workflow.actionIds.map((actionId?: any) : any => ({
    actionId,
    registered: featureRegistry.includes(`- ${actionId}`)
  }));
  const executorCoverage: any = workflow.executorFeatureIds.map((featureId?: any) : any => ({
    featureId,
    registered: executorFeatureIds.has(featureId)
  }));
  const operationCoverage: any = workflow.operationIds.map((operationId?: any) : any => {
    const operation: any = operations.get(operationId);
    const evidence: any = operation ? sourceEvidence(operation, combinedSource) : {
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
  const stateCoverage: any = (workflow.stateTokens || []).map((token?: any) : any => ({
    token,
    present: combinedSource.includes(token)
  }));
  const stateContractCoverage: any = await Promise.all(
    (workflow.stateContracts || []).map(async (contract?: any) : Promise<any> => {
      const exists: any = await fileExists(repoRoot, contract.sourceFile);
      const sourceText: any = exists ? await readText(repoRoot, contract.sourceFile) : "";
      const checks: any = contract.checks.map((check?: any) : any => ({
        id: check.id,
        present: exists && check.pattern.test(sourceText)
      }));
      return {
        id: contract.id,
        sourceFile: contract.sourceFile,
        exists,
        checks,
        contractReady: exists && checks.every((check?: any) : any => check.present)
      };
    })
  );
  const verifierCoverage: any = await Promise.all(workflow.verifierFiles.map(async (relativePath?: any) : Promise<any> => ({
    path: relativePath,
    exists: await fileExists(repoRoot, relativePath)
  })));

  const missing: any[] = [
    ...sourceEntries.filter((entry?: any) : any => !entry.exists).map((entry?: any) : any => `source:${entry.path}`),
    ...routeCoverage.filter((entry?: any) : any => !entry.inFeatureRegistry).map((entry?: any) : any => `feature-route:${entry.routePath}`),
    ...adminRouteCoverage.filter((entry?: any) : any => !entry.inAdminRouteRegistry).map((entry?: any) : any => `admin-route:${entry.viewKey}`),
    ...featureCoverage.filter((entry?: any) : any => !entry.registered).map((entry?: any) : any => `feature:${entry.featureId}`),
    ...actionCoverage.filter((entry?: any) : any => !entry.registered).map((entry?: any) : any => `action:${entry.actionId}`),
    ...executorCoverage.filter((entry?: any) : any => !entry.registered).map((entry?: any) : any => `executor:${entry.featureId}`),
    ...operationCoverage.filter((entry?: any) : any => !entry.registered).map((entry?: any) : any => `operation:${entry.operationId}`),
    ...operationCoverage.filter((entry?: any) : any => entry.registered && !entry.sourceEvidence.ok).map((entry?: any) : any => `source-evidence:${entry.operationId}`),
    ...stateCoverage.filter((entry?: any) : any => !entry.present).map((entry?: any) : any => `state:${entry.token}`),
    ...stateContractCoverage.filter((entry?: any) : any => !entry.exists).map((entry?: any) : any => `state-contract-source:${entry.id}`),
    ...stateContractCoverage.flatMap((entry?: any) : any => entry.checks
      .filter((check?: any) : any => !check.present)
      .map((check?: any) : any => `state-contract:${entry.id}:${check.id}`)),
    ...verifierCoverage.filter((entry?: any) : any => !entry.exists).map((entry?: any) : any => `verifier:${entry.path}`)
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
    sourceFiles: sourceEntries.map((entry?: any) : any => ({ path: entry.path, exists: entry.exists })),
    stateCoverage,
    stateContractCoverage,
    verifierCoverage,
    missing,
    coverageReady: missing.length === 0
  };
}
