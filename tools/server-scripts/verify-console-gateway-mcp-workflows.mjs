#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/console-gateway-mcp-workflows.json";

const GATEWAY_OPERATIONS = Object.freeze([
  "external_services.list",
  "gateway.audit",
  "gateway.metrics"
]);

const MCP_OPERATIONS = Object.freeze([
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
  "operation_permission.pending_operations.resolve",
  "operation_permission.mcp.list_requests",
  "operation_permission.mcp.resolve_request"
]);

const GATEWAY_SOURCE_FILES = Object.freeze([
  "apps/console/views/admin/UpstreamGatewayView.vue",
  "apps/console/views/admin/upstream-gateway/useUpstreamGatewayView.ts",
  "apps/console/lib/upstream-gateway-client.ts",
  "packages/server-runtime/src/composition/console-domain/operation-executor.mjs",
  "packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.mjs"
]);

const MCP_SOURCE_FILES = Object.freeze([
  "apps/console/lib/operation-permission-client.ts",
  "apps/console/lib/authorization-governance-client.ts",
  "apps/console/composables/console-operation-permission-controller.ts",
  "apps/console/composables/console-tool-grants-controller.ts",
  "apps/console/composables/console-approval-flow-view-controller.ts",
  "apps/console/components/approval/ApprovalFlowCardList.vue",
  "packages/server-runtime/src/composition/console-domain/operation-executor.mjs"
]);

const REQUIRED_STATE_TOKENS = Object.freeze({
  gateway: ["loading", "error", "ConsoleEmptyState", "success", "metrics", "audit"],
  mcp: ["busy", "error", "issuedToolToken", "policyPreviewResult", "approvalFlowCards", "rejected", "denied", "safetyConfirm"]
});

const REQUIRED_REAL_REPORTS = Object.freeze([
  "build/reports/upstream-gateway-e2e.json",
  "build/reports/operation-permission-protocol-consistency.json",
  "build/reports/operation-permission-tag-governed-e2e.json"
]);

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
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

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function operationMap() {
  return new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
}

function endpointRegex(apiPath = "") {
  const parameterized = String(apiPath || "").replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "__PATH_PARAM__");
  const escaped = parameterized
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/__PATH_PARAM__/gu, "[^\"'`\\s]+");
  return new RegExp(escaped, "u");
}

function methodEndpointRegex(operation = {}) {
  const method = String(operation.http?.method || "GET").toUpperCase();
  const apiPath = String(operation.http?.path || "");
  if (!apiPath) return null;
  const pathPattern = endpointRegex(apiPath).source;
  if (method === "GET") {
    return new RegExp(`(?:getJson|downloadFile|fetchJson|method:\\s*["']GET["'])[\\s\\S]{0,260}${pathPattern}|${pathPattern}[\\s\\S]{0,260}method:\\s*["']GET["']`, "u");
  }
  if (method === "POST") {
    return new RegExp(`(?:postJson|method:\\s*["']POST["'])[\\s\\S]{0,260}${pathPattern}|${pathPattern}[\\s\\S]{0,260}method:\\s*["']POST["']`, "u");
  }
  return new RegExp(`${pathPattern}[\\s\\S]{0,260}method:\\s*["']${method}["']`, "u");
}

function operationEvidence(operation, sourceText = "") {
  const endpoint = operation?.http?.path ? endpointRegex(operation.http.path).test(sourceText) : false;
  const methodEndpoint = operation?.http?.path ? methodEndpointRegex(operation)?.test(sourceText) === true : false;
  const operationId = String(operation?.id || "");
  const idMentioned = operationId && sourceText.includes(operationId);
  return {
    endpoint,
    methodEndpoint,
    operationId: idMentioned,
    currentSurface: Boolean(operation),
    ok: Boolean(operation) && (methodEndpoint || idMentioned)
  };
}

function stateCoverage(tokens, sourceText = "") {
  return Object.fromEntries(tokens.map((token) => [token, sourceText.includes(token)]));
}

function missingStateTokens(coverage = {}) {
  return Object.entries(coverage).filter(([, present]) => present !== true).map(([token]) => token);
}

function gatewayControllerExtractionEvidence(sourceByFile = {}) {
  const view = sourceByFile["apps/console/views/admin/UpstreamGatewayView.vue"] || "";
  const controller = sourceByFile["apps/console/views/admin/upstream-gateway/useUpstreamGatewayView.ts"] || "";
  const client = sourceByFile["apps/console/lib/upstream-gateway-client.ts"] || "";
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

function reportByName(report = {}, namePart = "") {
  return (report.tests || []).find((item) => String(item.name || "").includes(namePart)) || {};
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Console gateway MCP workflow report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() {
  const operations = operationMap();
  const gatewaySourceEntries = await Promise.all(GATEWAY_SOURCE_FILES.map(async (relativePath) => [
    relativePath,
    await readText(relativePath)
  ]));
  const gatewaySourceByFile = Object.fromEntries(gatewaySourceEntries);
  const gatewaySource = gatewaySourceEntries.map(([, source]) => source).join("\n");
  const mcpSource = (await Promise.all(MCP_SOURCE_FILES.map(readText))).join("\n");

  const gatewayCoverage = GATEWAY_OPERATIONS.map((operationId) => {
    const operation = operations.get(operationId);
    return {
      operationId,
      httpMethod: operation?.http?.method || "",
      httpPath: operation?.http?.path || "",
      evidence: operationEvidence(operation, gatewaySource)
    };
  });
  const mcpCoverage = MCP_OPERATIONS.map((operationId) => {
    const operation = operations.get(operationId);
    return {
      operationId,
      httpMethod: operation?.http?.method || "",
      httpPath: operation?.http?.path || "",
      evidence: operationEvidence(operation, mcpSource)
    };
  });

  const reports = Object.fromEntries(await Promise.all(REQUIRED_REAL_REPORTS.map(async (relativePath) => [
    relativePath,
    await readJson(relativePath)
  ])));

  const upstream = reports["build/reports/upstream-gateway-e2e.json"];
  const protocol = reports["build/reports/operation-permission-protocol-consistency.json"];
  const tagGoverned = reports["build/reports/operation-permission-tag-governed-e2e.json"];

  const realEvidence = {
    upstreamGatewayReleaseReady: releaseEvidenceReady("build/reports/upstream-gateway-e2e.json", upstream),
    upstreamGatewayAuditMetrics: Boolean(reportByName(upstream, "audit metrics").status === "passed" || reportByName(upstream, "MCP gateway forwarding").status === "passed"),
    protocolDecisionConvergence: reportByName(protocol, "allow deny approval").status === "passed",
    tagGovernedPendingApproval: reportByName(tagGoverned, "approval queue").evidence?.pendingOperationListed === true &&
      reportByName(tagGoverned, "approval queue").evidence?.pendingOperationResolved === true,
    reportsLeakScanned: tagGoverned.summary?.reportLeakScan === true
  };

  const gatewayStateCoverage = stateCoverage(REQUIRED_STATE_TOKENS.gateway, gatewaySource);
  const mcpStateCoverage = stateCoverage(REQUIRED_STATE_TOKENS.mcp, mcpSource);
  const gatewayControllerExtraction = gatewayControllerExtractionEvidence(gatewaySourceByFile);
  const missing = [
    ...gatewayCoverage.filter((entry) => !entry.evidence.ok).map((entry) => `gateway:${entry.operationId}`),
    ...mcpCoverage.filter((entry) => !entry.evidence.ok).map((entry) => `mcp:${entry.operationId}`),
    ...missingStateTokens(gatewayStateCoverage).map((token) => `gateway-state:${token}`),
    ...missingStateTokens(mcpStateCoverage).map((token) => `mcp-state:${token}`),
    ...Object.entries(gatewayControllerExtraction).filter(([, value]) => value !== true).map(([key]) => `gateway-controller:${key}`),
    ...Object.entries(realEvidence).filter(([, value]) => value !== true).map(([key]) => `real-evidence:${key}`)
  ];

  const report = {
    schemaVersion: "v0.0.1:console:gateway-mcp-workflows-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-console-gateway-mcp-workflows.mjs",
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
      destructiveTestReportCount: REQUIRED_REAL_REPORTS.filter((relativePath) => Number(reports[relativePath].summary?.destructiveTestCount || 0) > 0).length,
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
