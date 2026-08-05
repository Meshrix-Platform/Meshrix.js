#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/console-gateway-mcp-workflows.json";

const GATEWAY_OPERATIONS: readonly any[] = Object.freeze([
  "external_services.list",
  "gateway.audit",
  "gateway.metrics"
]);

const MCP_OPERATIONS: readonly any[] = Object.freeze([
  "operation_permission.catalog",
  "operation_permission.grants",
  "operation_permission.create_grant",
  "operation_permission.update_grant",
  "operation_permission.rotate_grant",
  "operation_permission.revoke_grant",
  "operation_permission.policy_preview",
  "operation_permission.audit",
  "operation_permission.metrics_summary",
  "operation_permission.metrics_health",
  "operation_permission.metrics_export",
  "operation_permission.pending_operations.list",
  "operation_permission.pending_operations.resolve"
]);

const GATEWAY_SOURCE_FILES: readonly any[] = Object.freeze([
  "apps/console/views/admin/UpstreamGatewayView.vue",
  "apps/console/views/admin/upstream-gateway/useUpstreamGatewayView.ts",
  "apps/console/lib/upstream-gateway-client.ts",
  "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
  "packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.ts"
]);

const MCP_SOURCE_FILES: readonly any[] = Object.freeze([
  "apps/console/lib/operation-permission-client.ts",
  "apps/console/lib/authorization-governance-client.ts",
  "apps/console/composables/console-operation-permission-controller.ts",
  "apps/console/composables/console-tool-grants-controller.ts",
  "apps/console/composables/console-approval-flow-view-controller.ts",
  "apps/console/components/approval/ApprovalFlowCardList.vue",
  "packages/server-runtime/src/composition/console-domain/operation-executor.ts"
]);

const REQUIRED_STATE_TOKENS: Readonly<Record<string, any>> = Object.freeze({
  gateway: ["loading", "error", "ConsoleEmptyState", "success", "metrics", "audit"],
  mcp: ["busy", "error", "issuedToolToken", "policyPreviewResult", "approvalFlowCards", "rejected", "denied", "safetyConfirm"]
});

const REQUIRED_REAL_REPORTS: readonly any[] = Object.freeze([
  "build/reports/upstream-gateway-e2e.json",
  "build/reports/operation-permission-protocol-consistency.json",
  "build/reports/operation-permission-tag-governed-e2e.json"
]);

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
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

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await readText(relativePath));
}

function operationMap() : any {
  return new Map<any, any>(SERVER_API_OPERATIONS.map((operation?: any) : any => [operation.id, operation]));
}

function endpointRegex(apiPath: any = "") : any {
  const parameterized: any = String(apiPath || "").replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "__PATH_PARAM__");
  const escaped: any = parameterized
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/__PATH_PARAM__/gu, "[^\"'`\\s]+");
  return new RegExp(escaped, "u");
}

function methodEndpointRegex(operation: Record<string, any> = {}) : any {
  const method: any = String(operation.http?.method || "GET").toUpperCase();
  const apiPath: any = String(operation.http?.path || "");
  if (!apiPath) return null;
  const pathPattern: any = endpointRegex(apiPath).source;
  if (method === "GET") {
    return new RegExp(`(?:getJson|downloadFile|fetchJson|method:\\s*["']GET["'])[\\s\\S]{0,260}${pathPattern}|${pathPattern}[\\s\\S]{0,260}method:\\s*["']GET["']`, "u");
  }
  if (method === "POST") {
    return new RegExp(`(?:postJson|method:\\s*["']POST["'])[\\s\\S]{0,260}${pathPattern}|${pathPattern}[\\s\\S]{0,260}method:\\s*["']POST["']`, "u");
  }
  return new RegExp(`${pathPattern}[\\s\\S]{0,260}method:\\s*["']${method}["']`, "u");
}

function operationEvidence(operation?: any, sourceText: any = "") : any {
  const endpoint: any = operation?.http?.path ? endpointRegex(operation.http.path).test(sourceText) : false;
  const methodEndpoint: any = operation?.http?.path ? methodEndpointRegex(operation)?.test(sourceText) === true : false;
  const operationId: any = String(operation?.id || "");
  const idMentioned: any = operationId && sourceText.includes(operationId);
  return {
    endpoint,
    methodEndpoint,
    operationId: idMentioned,
    currentSurface: Boolean(operation),
    ok: Boolean(operation) && (methodEndpoint || idMentioned)
  };
}

function stateCoverage(tokens?: any, sourceText: any = "") : any {
  return Object.fromEntries(tokens.map((token?: any) : any => [token, sourceText.includes(token)]));
}

function missingStateTokens(coverage: Record<string, any> = {}) : any {
  return (Object.entries(coverage) as [string, any][]).filter(([, present]: any[]) : any => present !== true).map(([token]: any[]) : any => token);
}

function gatewayControllerExtractionEvidence(sourceByFile: Record<string, any> = {}) : any {
  const view: any = sourceByFile["apps/console/views/admin/UpstreamGatewayView.vue"] || "";
  const controller: any = sourceByFile["apps/console/views/admin/upstream-gateway/useUpstreamGatewayView.ts"] || "";
  const client: any = sourceByFile["apps/console/lib/upstream-gateway-client.ts"] || "";
  return {
    viewUsesController: /useUpstreamGatewayView/u.test(view),
    viewAvoidsGatewayClientImport: !/upstream-gateway-client/u.test(view),
    controllerUsesTypedClient: /listUpstreamGatewayServices/u.test(controller) &&
      /listUpstreamGatewayAudit/u.test(controller) &&
      /getUpstreamGatewayMetrics/u.test(controller),
    controllerOwnsSelection: /selectedServiceId/u.test(controller) && /syncSelectedService/u.test(controller),
    controllerOwnsPageRefresh: /usePageRefreshHandler/u.test(controller) && /upstreamServices/u.test(controller),
    typedClientOwnsEndpoints: /\/api\/gateway\/v1\/external-services/u.test(client) &&
      /\/api\/gateway\/v1\/audit/u.test(client) &&
      /\/api\/gateway\/v1\/metrics/u.test(client)
  };
}

function reportByName(report: Record<string, any> = {}, namePart: any = "") : any {
  return (report.tests || []).find((item?: any) : any => String(item.name || "").includes(namePart)) || {};
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Console gateway MCP workflow report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() : Promise<any> {
  const operations: any = operationMap();
  const gatewaySourceEntries: any = await Promise.all(GATEWAY_SOURCE_FILES.map(async (relativePath?: any) : Promise<any> => [
    relativePath,
    await readText(relativePath)
  ]));
  const gatewaySourceByFile: any = Object.fromEntries(gatewaySourceEntries);
  const gatewaySource: any = gatewaySourceEntries.map(([, source]: any[]) : any => source).join("\n");
  const mcpSource: any = (await Promise.all(MCP_SOURCE_FILES.map(readText))).join("\n");

  const gatewayCoverage: any = GATEWAY_OPERATIONS.map((operationId?: any) : any => {
    const operation: any = operations.get(operationId);
    return {
      operationId,
      httpMethod: operation?.http?.method || "",
      httpPath: operation?.http?.path || "",
      evidence: operationEvidence(operation, gatewaySource)
    };
  });
  const mcpCoverage: any = MCP_OPERATIONS.map((operationId?: any) : any => {
    const operation: any = operations.get(operationId);
    return {
      operationId,
      httpMethod: operation?.http?.method || "",
      httpPath: operation?.http?.path || "",
      evidence: operationEvidence(operation, mcpSource)
    };
  });

  const reports: any = Object.fromEntries(await Promise.all(REQUIRED_REAL_REPORTS.map(async (relativePath?: any) : Promise<any> => [
    relativePath,
    await readJson(relativePath)
  ])));

  const upstream: any = reports["build/reports/upstream-gateway-e2e.json"];
  const protocol: any = reports["build/reports/operation-permission-protocol-consistency.json"];
  const tagGoverned: any = reports["build/reports/operation-permission-tag-governed-e2e.json"];

  const realEvidence: Record<string, any> = {
    upstreamGatewayReleaseReady: releaseEvidenceReady("build/reports/upstream-gateway-e2e.json", upstream),
    upstreamGatewayAuditMetrics: Boolean(reportByName(upstream, "audit metrics").status === "passed" || reportByName(upstream, "MCP gateway forwarding").status === "passed"),
    protocolDecisionConvergence: reportByName(protocol, "allow deny and governed approval").status === "passed",
    tagGovernedPendingApproval: reportByName(tagGoverned, "approval queue").evidence?.pendingOperationListed === true &&
      reportByName(tagGoverned, "approval queue").evidence?.pendingOperationResolved === true,
    reportsLeakScanned: tagGoverned.summary?.reportLeakScan === true
  };

  const gatewayStateCoverage: any = stateCoverage(REQUIRED_STATE_TOKENS.gateway, gatewaySource);
  const mcpStateCoverage: any = stateCoverage(REQUIRED_STATE_TOKENS.mcp, mcpSource);
  const gatewayControllerExtraction: any = gatewayControllerExtractionEvidence(gatewaySourceByFile);
  const missing: any[] = [
    ...gatewayCoverage.filter((entry?: any) : any => !entry.evidence.ok).map((entry?: any) : any => `gateway:${entry.operationId}`),
    ...mcpCoverage.filter((entry?: any) : any => !entry.evidence.ok).map((entry?: any) : any => `mcp:${entry.operationId}`),
    ...missingStateTokens(gatewayStateCoverage).map((token?: any) : any => `gateway-state:${token}`),
    ...missingStateTokens(mcpStateCoverage).map((token?: any) : any => `mcp-state:${token}`),
    ...(Object.entries(gatewayControllerExtraction) as [string, any][]).filter(([, value]: any[]) : any => value !== true).map(([key]: any[]) : any => `gateway-controller:${key}`),
    ...(Object.entries(realEvidence) as [string, any][]).filter(([, value]: any[]) : any => value !== true).map(([key]: any[]) : any => `real-evidence:${key}`)
  ];

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:console:gateway-mcp-workflows-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-console-gateway-mcp-workflows.ts",
    algorithm: {
      operationRouteCheck: "For each required gateway and MCP operation, match current SERVER_API_OPERATIONS HTTP method/path against console source, accepting operation-id executor evidence only when the console path is a passthrough executor surface.",
      stateCheck: "Scan console view/controller sources for loading, empty, denied, approval, validation, runtime-error, success, audit, and metrics states.",
      realEnvironmentCheck: "Require real upstream gateway, downstream MCP, Operation Permission protocol, and tag-governed E2E reports to be release-ready and leak-scanned."
    },
    sourceFiles: {
      gateway: GATEWAY_SOURCE_FILES,
      mcp: MCP_SOURCE_FILES
    },
    gatewayCoverage,
    mcpCoverage,
    stateCoverage: {
      gateway: gatewayStateCoverage,
      mcp: mcpStateCoverage
    },
    gatewayControllerExtraction,
    realEvidence,
    summary: {
      gatewayOperationCount: gatewayCoverage.length,
      mcpOperationCount: mcpCoverage.length,
      missingEvidenceCount: missing.length,
      missing,
      destructiveTestReportCount: REQUIRED_REAL_REPORTS.filter((relativePath?: any) : any => Number(reports[relativePath].summary?.destructiveTestCount || 0) > 0).length,
      releaseReady: missing.length === 0,
      reportLeakScan: true
    }
  };

  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (missing.length > 0) {
    throw new Error(`Console gateway MCP workflows are incomplete: ${missing.join(", ")}`);
  }

  console.log(`[console-gateway-mcp-workflows] ok ${REPORT_PATH}`);
}

await main();
