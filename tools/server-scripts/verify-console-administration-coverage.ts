#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADMIN_ROUTE_REGISTRY } from "../../apps/console/router/admin-route-registry.ts";
import { listConsoleDomainOperationExecutors } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import {
  CONSOLE_COMPOSITION_SOURCE_PATH
} from "./lib/console-administration-composition-contract.ts";
import {
  evaluateConsoleAdministrationWorkflow,
  evaluatePluginConsoleAuthority
} from "./lib/console-administration-coverage-assertions.ts";
import {
  assertNoReportLeak,
  inspectConsoleComposition,
  operationMap
} from "./lib/console-administration-coverage-helpers.ts";
import {
  CONSOLE_ADMINISTRATION_WORKFLOWS,
  PLUGIN_CONSOLE_AUTHORITIES
} from "./lib/console-administration-workflow-catalog.ts";
import { createPluginDeploymentAuditCatalog } from "./lib/plugin-deployment-audit-catalog.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/console-administration-coverage.json";

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function main() : Promise<any> {
  const pluginAudit: any = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
    const operations: any = operationMap(pluginAudit.operations);
    const pluginConsoleEntries: any = pluginAudit.publicRuntime.consoleEntries;
    const executorFeatureIds: any = new Set<any>(listConsoleDomainOperationExecutors().map((entry?: any) : any => entry.featureId));
    const featureRegistry: any = await readText("packages/foundation/config/frontend-feature-registry.yaml");
    const consoleComposition: any = inspectConsoleComposition(await readText(CONSOLE_COMPOSITION_SOURCE_PATH));
    const pluginConsoleAuthority: any = evaluatePluginConsoleAuthority({
      authorities: PLUGIN_CONSOLE_AUTHORITIES,
      pluginConsoleEntries,
      featureRegistry,
      adminRouteRegistry: ADMIN_ROUTE_REGISTRY
    });
    const pluginConsoleAuthorityReady: any = pluginConsoleAuthority.every((entry?: any) : any => entry.ready);

    const workflowReports: any[] = [];
    for (const workflow of CONSOLE_ADMINISTRATION_WORKFLOWS) {
      workflowReports.push(await evaluateConsoleAdministrationWorkflow({
        workflow,
        repoRoot,
        operations,
        pluginConsoleEntries,
        executorFeatureIds,
        featureRegistry,
        adminRouteRegistry: ADMIN_ROUTE_REGISTRY
      }));
    }

    const failingWorkflows: any = workflowReports.filter((workflow?: any) : any => !workflow.coverageReady);
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:console:administration-coverage-report-1",
      generatedAt: new Date().toISOString(),
      verifier: "tools/server-scripts/verify-console-administration-coverage.ts",
      algorithm: {
        routeResolution: "core routes resolve through the static registry; optional routes resolve through the explicitly enabled plugin console contribution registry",
        operationResolution: "core and optional workflows resolve against the catalog-backed all-plugin active operation set with source evidence from operation id or registered HTTP endpoint",
        executorResolution: "listConsoleDomainOperationExecutors feature-id set membership",
        stateResolution: "workflow-specific UI state scan plus runtime-to-client-to-view machine-readable state contract checks",
        compositionResolution: "explicit controller constructor and route fallback token presence plus forbidden dynamic fallback scan",
        leakControl: "report includes repository-relative paths only and is scanned before write"
      },
      sourceOfTruth: {
        operations: "packages/contracts/src/operations/operation-registry.ts",
        pluginOperations: "packages/server-runtime/src/composition/plugin-contribution-registry.ts",
        featureRegistry: "packages/foundation/config/frontend-feature-registry.yaml",
        routeRegistry: "apps/console/router/admin-route-registry.ts",
        executorRegistry: "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
        consoleComposition: CONSOLE_COMPOSITION_SOURCE_PATH
      },
      summary: {
        workflowCount: workflowReports.length,
        failedWorkflowCount: failingWorkflows.length,
        operationEvidenceCount: workflowReports.reduce((sum?: any, workflow?: any) : any => sum + workflow.operationCoverage.length, 0),
        machineStateContractCount: workflowReports.reduce(
          (sum?: any, workflow?: any) : any => sum + workflow.stateContractCoverage.length,
          0
        ),
        missingEvidenceCount: workflowReports.reduce((sum?: any, workflow?: any) : any => sum + workflow.missing.length, 0),
        compositionFindingCount: consoleComposition.findings.length,
        pluginConsoleAuthorityFindingCount: pluginConsoleAuthority.filter((entry?: any) : any => !entry.ready).length,
        failedWorkflows: failingWorkflows.map((workflow?: any) : any => workflow.id),
        coverageReady: failingWorkflows.length === 0 && consoleComposition.compositionReady && pluginConsoleAuthorityReady,
        releaseReady: failingWorkflows.length === 0 && consoleComposition.compositionReady && pluginConsoleAuthorityReady,
        releaseReadinessDelegatedTo: "tools/server-scripts/verify-platform-acceptance.ts",
        reportLeakScan: true
      },
      consoleComposition,
      pluginConsoleAuthority,
      workflows: workflowReports
    };

    assertNoReportLeak(report);
    await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
    await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (failingWorkflows.length > 0 || !consoleComposition.compositionReady || !pluginConsoleAuthorityReady) {
      const failures: any = failingWorkflows
        .map((workflow?: any) : any => `${workflow.id}: ${workflow.missing.slice(0, 12).join(", ")}`)
        .join("\n");
      const compositionFailures: any = consoleComposition.findings.length > 0
        ? `console-composition: ${consoleComposition.findings.join(", ")}`
        : "";
      const pluginAuthorityFailures: any = pluginConsoleAuthority
        .filter((entry?: any) : any => !entry.ready)
        .map((entry?: any) : any => `${entry.pluginId}:${entry.id}`)
        .join(", ");
      throw new Error(
        `Console administration coverage is incomplete:\n${[
          failures,
          compositionFailures,
          pluginAuthorityFailures ? `plugin-console-authority: ${pluginAuthorityFailures}` : ""
        ].filter(Boolean).join("\n")}`
      );
    }

    console.log(`[console-administration-coverage] ok ${REPORT_PATH}`);
  } finally {
    await pluginAudit.close();
  }
}

await main();
