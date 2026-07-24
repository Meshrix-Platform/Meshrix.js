#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADMIN_ROUTE_REGISTRY } from "../../apps/console/router/admin-route-registry.mjs";
import { listConsoleDomainOperationExecutors } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";
import {
  CONSOLE_COMPOSITION_SOURCE_PATH
} from "./lib/console-administration-composition-contract.mjs";
import {
  evaluateConsoleAdministrationWorkflow,
  evaluatePluginConsoleAuthority
} from "./lib/console-administration-coverage-assertions.mjs";
import {
  assertNoReportLeak,
  inspectConsoleComposition,
  operationMap
} from "./lib/console-administration-coverage-helpers.mjs";
import {
  CONSOLE_ADMINISTRATION_WORKFLOWS,
  PLUGIN_CONSOLE_AUTHORITIES
} from "./lib/console-administration-workflow-catalog.mjs";
import { createPluginDeploymentAuditCatalog } from "./lib/plugin-deployment-audit-catalog.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/console-administration-coverage.json";

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function main() {
  const pluginAudit = await createPluginDeploymentAuditCatalog({ repoRoot });
  try {
    const operations = operationMap(pluginAudit.operations);
    const pluginConsoleEntries = pluginAudit.publicRuntime.consoleEntries;
    const executorFeatureIds = new Set(listConsoleDomainOperationExecutors().map((entry) => entry.featureId));
    const featureRegistry = await readText("packages/foundation/config/frontend-feature-registry.yaml");
    const consoleComposition = inspectConsoleComposition(await readText(CONSOLE_COMPOSITION_SOURCE_PATH));
    const pluginConsoleAuthority = evaluatePluginConsoleAuthority({
      authorities: PLUGIN_CONSOLE_AUTHORITIES,
      pluginConsoleEntries,
      featureRegistry,
      adminRouteRegistry: ADMIN_ROUTE_REGISTRY
    });
    const pluginConsoleAuthorityReady = pluginConsoleAuthority.every((entry) => entry.ready);

    const workflowReports = [];
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

    const failingWorkflows = workflowReports.filter((workflow) => !workflow.coverageReady);
    const report = {
      schemaVersion: "v0.0.1:console:administration-coverage-report-1",
      generatedAt: new Date().toISOString(),
      verifier: "tools/server-scripts/verify-console-administration-coverage.mjs",
      algorithm: {
        routeResolution: "core routes resolve through the static registry; optional routes resolve through the explicitly enabled plugin console contribution registry",
        operationResolution: "core and optional workflows resolve against the catalog-backed all-plugin active operation set with source evidence from operation id or registered HTTP endpoint",
        executorResolution: "listConsoleDomainOperationExecutors feature-id set membership",
        stateResolution: "workflow-specific UI state scan plus runtime-to-client-to-view machine-readable state contract checks",
        compositionResolution: "explicit controller constructor and route fallback token presence plus forbidden dynamic fallback scan",
        leakControl: "report includes repository-relative paths only and is scanned before write"
      },
      sourceOfTruth: {
        operations: "packages/contracts/src/operations/operation-registry.mjs",
        pluginOperations: "packages/server-runtime/src/composition/plugin-contribution-registry.mjs",
        featureRegistry: "packages/foundation/config/frontend-feature-registry.yaml",
        routeRegistry: "apps/console/router/admin-route-registry.mjs",
        executorRegistry: "packages/server-runtime/src/composition/console-domain/operation-executor.mjs",
        consoleComposition: CONSOLE_COMPOSITION_SOURCE_PATH
      },
      summary: {
        workflowCount: workflowReports.length,
        failedWorkflowCount: failingWorkflows.length,
        operationEvidenceCount: workflowReports.reduce((sum, workflow) => sum + workflow.operationCoverage.length, 0),
        machineStateContractCount: workflowReports.reduce(
          (sum, workflow) => sum + workflow.stateContractCoverage.length,
          0
        ),
        missingEvidenceCount: workflowReports.reduce((sum, workflow) => sum + workflow.missing.length, 0),
        compositionFindingCount: consoleComposition.findings.length,
        pluginConsoleAuthorityFindingCount: pluginConsoleAuthority.filter((entry) => !entry.ready).length,
        failedWorkflows: failingWorkflows.map((workflow) => workflow.id),
        coverageReady: failingWorkflows.length === 0 && consoleComposition.compositionReady && pluginConsoleAuthorityReady,
        releaseReady: failingWorkflows.length === 0 && consoleComposition.compositionReady && pluginConsoleAuthorityReady,
        releaseReadinessDelegatedTo: "tools/server-scripts/verify-platform-acceptance.mjs",
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
      const failures = failingWorkflows
        .map((workflow) => `${workflow.id}: ${workflow.missing.slice(0, 12).join(", ")}`)
        .join("\n");
      const compositionFailures = consoleComposition.findings.length > 0
        ? `console-composition: ${consoleComposition.findings.join(", ")}`
        : "";
      const pluginAuthorityFailures = pluginConsoleAuthority
        .filter((entry) => !entry.ready)
        .map((entry) => `${entry.pluginId}:${entry.id}`)
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
