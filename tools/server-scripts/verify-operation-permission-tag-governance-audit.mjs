#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "#lico/contracts/operations/operation-registry";
import { PROTOCOL_OPERATION_DEFINITIONS } from "#lico/contracts/operations/protocol-operation-definitions";
import { operationFeatureId } from "#lico/contracts/operations/operation-feature-resolution";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  handleLicoMcpHttpRequest
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/operation-permission-tag-governance-audit.json";
const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["relay_runtime_id", /relay_session_[A-Za-z0-9_-]+|relay_turn_[A-Za-z0-9_-]+|delegated_mcp_[A-Za-z0-9_-]+/u],
  ["grant_runtime_id", /grant_[a-z0-9]{6,}_[a-f0-9]{8,}/u],
  ["tool_runtime_id", /tool_exec_[A-Za-z0-9_-]+|pending_op_[A-Za-z0-9_-]+/u]
]);

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function relativePath(filePath = "") {
  return path.relative(repoRoot, filePath).replace(/\\/gu, "/");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function createCapturedHttpResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk = "") {
      if (chunk !== undefined && chunk !== null && chunk !== "") {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      this.ended = true;
    }
  };
}

function capturedJson(response) {
  const text = Buffer.concat(response.chunks || []).toString("utf8").trim();
  return text ? JSON.parse(text) : null;
}

async function mcpCapabilityOperations(catalog) {
  const response = createCapturedHttpResponse();
  const requestBody = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: "operation-permission-tag-governance-audit",
    method: "tools/call",
    params: {
      name: MCP_DISCOVERY_TOOL_NAME,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "lico.capabilities.list",
        input: {}
      }
    }
  }));
  const provider = {
    async authorizeRequest() {
      return {
        ok: true,
        status: 200,
        grant: {
          id: "operation-permission-audit-grant",
          label: "operation-permission-audit",
          scopes: [],
          toolsets: [],
          maxRisk: "repair_write",
          metadata: { maxRisk: "repair_write" }
        }
      };
    },
    listVisibleTools() {
      return catalog.tools.filter((tool) => tool.status === "active");
    },
    visibleGrantSummary() {
      return {
        id: "operation-permission-audit-grant",
        label: "operation-permission-audit",
        toolsets: [],
        scopes: [],
        maxRisk: "repair_write"
      };
    }
  };
  await handleLicoMcpHttpRequest({
    request: {
      method: "POST",
      headers: { "user-agent": "operation-permission-tag-governance-audit" },
      socket: { remoteAddress: "127.0.0.1" }
    },
    response,
    requestBody,
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider
  });
  const payload = capturedJson(response);
  if (response.statusCode !== 200 || payload?.error) {
    const rpcCode = String(payload?.error?.data?.code || payload?.error?.code || "unknown");
    throw new Error(
      `MCP capabilities audit call failed (HTTP ${response.statusCode}, RPC ${rpcCode}).`
    );
  }
  const operations = payload?.result?.structuredContent?.operations || [];
  if (!Array.isArray(operations)) {
    throw new Error("MCP capabilities audit did not return operations.");
  }
  return operations;
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readJsonIfPresent(relativePath) {
  try {
    return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
  } catch {
    return {};
  }
}

function reportTest(report = {}, pattern) {
  return [...(report.tests || []), ...(report.destructiveTests || [])]
    .find((test) => pattern.test(String(test.name || "")));
}

function reportTestPassed(report = {}, pattern) {
  return reportTest(report, pattern)?.status === "passed";
}

function reportEvidence(report = {}, pattern) {
  return reportTest(report, pattern)?.evidence || {};
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Operation Permission audit report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() {
  const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const toolsByOperationId = new Map(catalog.tools.map((tool) => [tool.operationId, tool]));
  const protocolIds = new Set(PROTOCOL_OPERATION_DEFINITIONS.map((operation) => operation.id));
  const serverById = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
  const mcpOperations = await mcpCapabilityOperations(catalog);
  const mcpByOperationId = new Map(
    mcpOperations
      .filter((operation) => operation?._meta?.operationId)
      .map((operation) => [operation._meta.operationId, operation])
  );
  const consoleExecutorText = await readText(repoPath("packages/server-runtime/src/composition/console-domain/operation-executor.mjs"));
  const verifierText = await readText(repoPath("tools/server-scripts/verify-tag-management.mjs"));
  const universalVerifierText = await readText(repoPath("tools/server-scripts/verify-operation-permission-universal-tag-policy.mjs"));
  const protocolConsistencyVerifierText = await readText(repoPath("tools/server-scripts/verify-operation-permission-protocol-consistency.mjs"));
  const tagGovernedE2eVerifierText = await readText(repoPath("tools/server-scripts/verify-operation-permission-tag-governed-e2e.mjs"));
  const tagGovernedE2eReport = await readJsonIfPresent("build/reports/operation-permission-tag-governed-e2e.json");
  const generatedOperationsText = await readText(repoPath("packages/contracts/src/generated/operations.generated.mjs"));
  const generatedCapabilitiesText = await readText(repoPath("packages/foundation/src/security/authorization/generated-capabilities.mjs"));

  const tagOperationIds = SERVER_API_OPERATIONS
    .filter((operation) => operation.id.startsWith("tag_management."))
    .map((operation) => operation.id)
    .sort();
  const tagOperations = tagOperationIds.map((operationId) => {
    const operation = serverById.get(operationId);
    const tool = toolsByOperationId.get(operationId);
    const mcp = mcpByOperationId.get(operationId);
    return {
      operationId,
      serverOperation: Boolean(operation),
      protocolDefinition: protocolIds.has(operationId),
      generatedOperationArtifact: generatedOperationsText.includes(operationId),
      generatedCapabilityArtifact: generatedCapabilitiesText.includes(`cap:api:${operationId}`) ||
        generatedCapabilitiesText.includes(operationId),
      featureId: operation ? operationFeatureId(operation) : "",
      http: {
        present: Boolean(operation?.http?.path),
        method: operation?.http?.method || "",
        path: operation?.http?.path || ""
      },
      rpc: {
        present: Boolean(operation?.rpc?.method),
        method: operation?.rpc?.method || ""
      },
      operationPermissionCatalog: {
        present: Boolean(tool),
        toolId: tool?.id || "",
        requiredScopes: uniqueStrings(tool?.requiredScopes || []),
        risk: tool?.risk || ""
      },
      mcp: {
        present: Boolean(mcp),
        name: mcp?.name || "",
        outlet: mcp?._meta?.mcpOutlet || ""
      },
      consoleRoute: consoleExecutorText.includes(`"${operationId}"`),
      authorizationPolicy: {
        requiredScopes: uniqueStrings(operation?.requiredScopes || []),
        usesAdminScope: uniqueStrings(operation?.requiredScopes || []).includes("auth:admin")
      },
      verifierCoverage: verifierText.includes(operationId)
    };
  });

  const missingCoverage = tagOperations.flatMap((entry) => {
    const missing = [];
    for (const [key, value] of Object.entries({
      serverOperation: entry.serverOperation,
      protocolDefinition: entry.protocolDefinition,
      generatedOperationArtifact: entry.generatedOperationArtifact,
      generatedCapabilityArtifact: entry.generatedCapabilityArtifact,
      http: entry.http.present,
      rpc: entry.rpc.present,
      operationPermissionCatalog: entry.operationPermissionCatalog.present,
      mcp: entry.mcp.present,
      consoleRoute: entry.consoleRoute,
      authorizationPolicy: entry.authorizationPolicy.usesAdminScope,
      verifierCoverage: entry.verifierCoverage
    })) {
      if (!value) {
        missing.push({ operationId: entry.operationId, surface: key });
      }
    }
    return missing;
  });

  const universalTagPolicyCoverage = {
    verifier: "tools/server-scripts/verify-operation-permission-universal-tag-policy.mjs",
    evaluator: universalVerifierText.includes("evaluateUniversalTagPolicy"),
    inheritedAllowAdmission: universalVerifierText.includes("inheritedAllowAdmission"),
    denyTagPrecedence: universalVerifierText.includes("denyTagPrecedence"),
    requiredTagMissingDenial: universalVerifierText.includes("requiredTagMissingDenial"),
    staleRevisionDenial: universalVerifierText.includes("staleRevisionDenial"),
    denyTagRevocation: universalVerifierText.includes("denyTagRevocation"),
    providerEnforcement: universalVerifierText.includes("securityPermissionsProviderEnforcesTagPolicy"),
    governedEntities: [
      "role-admin-review",
      "external-service-forward",
      "document-controlled",
      "workspace-file",
      "upstream-service",
      "governed-object",
      "org-private",
      "admin-console"
    ].every((needle) => universalVerifierText.includes(needle))
  };
  const missingUniversalTagPolicyCoverage = Object.entries(universalTagPolicyCoverage)
    .filter(([key, value]) => key !== "verifier" && value !== true)
    .map(([key]) => key);
  const protocolConsistencyCoverage = {
    verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.mjs",
    realHttpServer: protocolConsistencyVerifierText.includes("startHttpServer"),
    generatedRegistryCheck: protocolConsistencyVerifierText.includes("verifyRegistration"),
    httpExecute: protocolConsistencyVerifierText.includes("operationHttp"),
    rpcExecute: protocolConsistencyVerifierText.includes("operationRpc"),
    mcpToolsCall: protocolConsistencyVerifierText.includes("callMcp"),
    consolePassthrough: protocolConsistencyVerifierText.includes("JSON-RPC console passthrough") ||
      protocolConsistencyVerifierText.includes("operationRpc"),
    allowDecision: protocolConsistencyVerifierText.includes("\"allow\""),
    denyDecision: protocolConsistencyVerifierText.includes("\"deny\""),
    approvalRequiredDecision: protocolConsistencyVerifierText.includes("approval_required"),
    stalePolicyDecision: protocolConsistencyVerifierText.includes("hasStalePolicy"),
    revokedGrantDecision: protocolConsistencyVerifierText.includes("revoked_grant"),
    rateLimitDecision: protocolConsistencyVerifierText.includes("rate_limited"),
    unauthorizedDiscoveryHidden: protocolConsistencyVerifierText.includes("admin operation leaked") ||
      protocolConsistencyVerifierText.includes("config mutation operation leaked")
  };
  const missingProtocolConsistencyCoverage = Object.entries(protocolConsistencyCoverage)
    .filter(([key, value]) => key !== "verifier" && value !== true)
    .map(([key]) => key);
  const setupEvidence = reportEvidence(tagGovernedE2eReport, /setup tags projections/u);
  const allowEvidence = reportEvidence(tagGovernedE2eReport, /allow-tag admission/u);
  const discoveryEvidence = reportEvidence(tagGovernedE2eReport, /MCP discovery/u);
  const approvalEvidence = reportEvidence(tagGovernedE2eReport, /approval queue/u);
  const bypassEvidence = reportEvidence(tagGovernedE2eReport, /wrong outlet/u);
  const auditMetricsEvidence = reportEvidence(tagGovernedE2eReport, /audit metrics/u);
  const denyEvidence = reportEvidence(tagGovernedE2eReport, /deny-tag rejection/u);
  const tagGovernedE2eCoverage = {
    verifier: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.mjs",
    report: "build/reports/operation-permission-tag-governed-e2e.json",
    realHttpServer: tagGovernedE2eVerifierText.includes("startHttpServer") || tagGovernedE2eReport.summary?.releaseReady === true,
    upstreamFixture: tagGovernedE2eVerifierText.includes("startFixtureServer") || setupEvidence.gateway?.loadedFromPublishedManifest === true,
    allowTagAdmission: tagGovernedE2eVerifierText.includes("tag_policy_allowed") ||
      Object.values(allowEvidence).some((entry) => entry?.tagPolicy?.reasonCode === "tag_policy_allowed"),
    destructiveDenyTagRejection: tagGovernedE2eVerifierText.includes("destructiveTest") &&
      tagGovernedE2eVerifierText.includes("tag_policy_denied") ||
      reportTestPassed(tagGovernedE2eReport, /deny-tag rejection/u),
    governedCapabilityFamilies: [
      "upstreamService",
      "workspace",
      "consoleAdmin"
    ].every((needle) => tagGovernedE2eVerifierText.includes(needle) || allowEvidence[needle] || denyEvidence[needle]),
    mcpDiscoveryAuthorization: tagGovernedE2eVerifierText.includes("verifyMcpDiscoveryAuthorizationRefresh"),
    grantDiscoveryRefresh: discoveryEvidence.writeVisibleAfterGrantUpdate === true,
    tagPolicyDiscoveryRefresh: discoveryEvidence.adminHiddenAfterTagPolicyUpdate === true,
    pendingApprovalListedAndResolved: tagGovernedE2eVerifierText.includes("pendingOperationListed") &&
      tagGovernedE2eVerifierText.includes("pendingOperationResolved") ||
      (approvalEvidence.pendingOperationListed === true && approvalEvidence.pendingOperationResolved === true),
    bypassPrevention: tagGovernedE2eVerifierText.includes("wrongOutletDenied") &&
      tagGovernedE2eVerifierText.includes("insufficientGrantDenied") &&
      tagGovernedE2eVerifierText.includes("noDownstreamMutation") ||
      (bypassEvidence.wrongOutletDenied === true && bypassEvidence.insufficientGrantDenied === true && bypassEvidence.noDownstreamMutation === true),
    auditProof: ["ok", "denied", "pending_approval"].every((status) =>
      (auditMetricsEvidence.auditStatuses || []).includes(status)
    ) && Object.values(auditMetricsEvidence.auditToolCoverage || {}).every((covered) => covered === true),
    metricsCoverage: Number(auditMetricsEvidence.metricStatuses?.ok || 0) > 0 &&
      Number(auditMetricsEvidence.metricStatuses?.denied || 0) > 0 &&
      Number(auditMetricsEvidence.metricStatuses?.pendingApproval || 0) > 0 &&
      Object.values(auditMetricsEvidence.metricToolCoverage || {}).every((covered) => covered === true),
    cleanup: tagGovernedE2eVerifierText.includes("denyTagArchived") &&
      tagGovernedE2eVerifierText.includes("gatewayServicesConfigManaged") &&
      tagGovernedE2eVerifierText.includes("grantsRevoked") ||
      Boolean(auditMetricsEvidence.cleanup),
    reportLeakScan: tagGovernedE2eVerifierText.includes("reportLeakScan") ||
      tagGovernedE2eReport.summary?.reportLeakScan === true
  };
  const missingTagGovernedE2eCoverage = Object.entries(tagGovernedE2eCoverage)
    .filter(([key, value]) => key !== "verifier" && key !== "report" && value !== true)
    .map(([key]) => key);
  const auditReady = missingCoverage.length === 0 &&
    missingUniversalTagPolicyCoverage.length === 0 &&
    missingProtocolConsistencyCoverage.length === 0 &&
    missingTagGovernedE2eCoverage.length === 0;

  const report = {
    schemaVersion: "v0.0.1:operation-permission:tag-governance-audit-1",
    generatedAt: new Date().toISOString(),
    auditReady,
    releaseReady: auditReady,
    tagManagement: {
      operationCount: tagOperations.length,
      operations: tagOperations,
      missingCoverage
    },
    universalTagPolicy: {
      ...universalTagPolicyCoverage,
      missingCoverage: missingUniversalTagPolicyCoverage
    },
    protocolConsistency: {
      ...protocolConsistencyCoverage,
      missingCoverage: missingProtocolConsistencyCoverage
    },
    tagGovernedE2e: {
      ...tagGovernedE2eCoverage,
      missingCoverage: missingTagGovernedE2eCoverage
    },
    currentChecks: {
      missingTagSurfaceFailsAudit: missingCoverage.length === 0,
      missingUniversalTagPolicyCoverageFailsAudit: missingUniversalTagPolicyCoverage.length === 0,
      missingTagGovernedE2eCoverageFailsAudit: missingTagGovernedE2eCoverage.length === 0,
      reportLeakScan: true
    }
  };
  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!report.auditReady) {
    console.error(`[operation-permission-tag-governance-audit] report=${REPORT_PATH}`);
    for (const missing of missingCoverage.slice(0, 20)) {
      console.error(`- missing_tag_surface: ${missing.operationId} ${missing.surface}`);
    }
    process.exit(1);
  }
  console.log(`[operation-permission-tag-governance-audit] report=${REPORT_PATH}`);
  console.log(`[operation-permission-tag-governance-audit] tagOperations=${tagOperations.length} auditReady=true releaseReady=${report.releaseReady}`);
}

await main();
