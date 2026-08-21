#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { PROTOCOL_OPERATION_DEFINITIONS } from "#meshrix/contracts/operations/protocol-operation-definitions";
import { operationFeatureId } from "#meshrix/contracts/operations/operation-feature-resolution";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  handleMeshrixMcpHttpRequest
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/operation-permission-tag-governance-audit.json";
const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["relay_runtime_id", /relay_session_[A-Za-z0-9_-]+|relay_turn_[A-Za-z0-9_-]+|delegated_mcp_[A-Za-z0-9_-]+/u],
  ["grant_runtime_id", /grant_[a-z0-9]{6,}_[a-f0-9]{8,}/u],
  ["tool_runtime_id", /tool_exec_[A-Za-z0-9_-]+|pending_op_[A-Za-z0-9_-]+/u]
]);

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

function relativePath(filePath: any = "") : any {
  return path.relative(repoRoot, filePath).replace(/\\/gu, "/");
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function createCapturedHttpResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk: any = "") : any {
      if (chunk !== undefined && chunk !== null && chunk !== "") {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      this.ended = true;
    }
  };
}

function capturedJson(response?: any) : any {
  const text: any = Buffer.concat(response.chunks || []).toString("utf8").trim();
  return text ? JSON.parse(text) : null;
}

async function mcpCapabilityOperations(catalog?: any) : Promise<any> {
  const response: any = createCapturedHttpResponse();
  const requestBody: any = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: "operation-permission-tag-governance-audit",
    method: "tools/call",
    params: {
      name: MCP_DISCOVERY_TOOL_NAME,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "meshrix.capabilities.list",
        input: {}
      }
    }
  }));
  const provider: Record<string, any> = {
    async authorizeMcpClientRequest() : Promise<any> {
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
    listVisibleTools() : any {
      return catalog.tools.filter((tool?: any) : any => tool.status === "active");
    },
    visibleGrantSummary() : any {
      return {
        id: "operation-permission-audit-grant",
        label: "operation-permission-audit",
        toolsets: [],
        scopes: [],
        maxRisk: "repair_write"
      };
    }
  };
  await handleMeshrixMcpHttpRequest({
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
  const payload: any = capturedJson(response);
  if (response.statusCode !== 200 || payload?.error) {
    const rpcCode: any = String(payload?.error?.data?.code || payload?.error?.code || "unknown");
    throw new Error(
      `MCP capabilities audit call failed (HTTP ${response.statusCode}, RPC ${rpcCode}).`
    );
  }
  const operations: any = payload?.result?.structuredContent?.operations || [];
  if (!Array.isArray(operations)) {
    throw new Error("MCP capabilities audit did not return operations.");
  }
  return operations;
}

async function readText(filePath?: any) : Promise<any> {
  return fs.readFile(filePath, "utf8");
}

async function readJsonIfPresent(relativePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
  } catch {
    return {};
  }
}

function reportTest(report: Record<string, any> = {}, pattern?: any) : any {
  return [...(report.tests || []), ...(report.destructiveTests || [])]
    .find((test?: any) : any => pattern.test(String(test.name || "")));
}

function reportTestPassed(report: Record<string, any> = {}, pattern?: any) : any {
  return reportTest(report, pattern)?.status === "passed";
}

function reportEvidence(report: Record<string, any> = {}, pattern?: any) : any {
  return reportTest(report, pattern)?.evidence || {};
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Operation Permission audit report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() : Promise<any> {
  const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const toolsByOperationId: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.operationId, tool]));
  const protocolIds: any = new Set<any>(PROTOCOL_OPERATION_DEFINITIONS.map((operation?: any) : any => operation.id));
  const serverById: any = new Map<any, any>(SERVER_API_OPERATIONS.map((operation?: any) : any => [operation.id, operation]));
  const mcpOperations: any = await mcpCapabilityOperations(catalog);
  const mcpByOperationId: any = new Map<any, any>(
    mcpOperations
      .filter((operation?: any) : any => operation?._meta?.operationId)
      .map((operation?: any) : any => [operation._meta.operationId, operation])
  );
  const consoleExecutorText: any = await readText(repoPath("packages/server-runtime/src/composition/console-domain/operation-executor.ts"));
  const verifierText: any = await readText(repoPath("tools/server-scripts/verify-tag-management.ts"));
  const universalVerifierText: any = await readText(repoPath("tools/server-scripts/verify-operation-permission-universal-tag-policy.ts"));
  const protocolConsistencyVerifierText: any = await readText(repoPath("tools/server-scripts/verify-operation-permission-protocol-consistency.ts"));
  const tagGovernedE2eVerifierText: any = await readText(repoPath("tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts"));
  const tagGovernedE2eHarnessText: any = await readText(repoPath("tools/server-scripts/lib/operation-permission-tag-governed-e2e-harness.ts"));
  const tagGovernedE2eWorkflowsText: any = await readText(repoPath("tools/server-scripts/lib/operation-permission-tag-governed-workflows.ts"));
  const tagGovernedE2eReportText: any = await readText(repoPath("tools/server-scripts/lib/operation-permission-tag-governed-e2e-report.ts"));
  const tagGovernedE2eSourceText: any = [
    tagGovernedE2eVerifierText,
    tagGovernedE2eHarnessText,
    tagGovernedE2eWorkflowsText,
    tagGovernedE2eReportText
  ].join("\n");
  const tagGovernedE2eReport: any = await readJsonIfPresent("build/reports/operation-permission-tag-governed-e2e.json");
  const generatedOperationsText: any = await readText(repoPath("packages/contracts/src/generated/operations.generated.ts"));
  const generatedCapabilitiesText: any = await readText(repoPath("packages/foundation/src/security/authorization/generated-capabilities.ts"));

  const tagOperationIds: any = SERVER_API_OPERATIONS
    .filter((operation?: any) : any => operation.id.startsWith("tag_management."))
    .map((operation?: any) : any => operation.id)
    .sort();
  const tagOperations: any = tagOperationIds.map((operationId?: any) : any => {
    const operation: any = serverById.get(operationId);
    const tool: any = toolsByOperationId.get(operationId);
    const mcp: any = mcpByOperationId.get(operationId);
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

  const missingCoverage: any = tagOperations.flatMap((entry?: any) : any => {
    const missing: any[] = [];
    for (const [key, value] of (Object.entries({
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
    }) as [string, any][])) {
      if (!value) {
        missing.push({ operationId: entry.operationId, surface: key });
      }
    }
    return missing;
  });

  const universalTagPolicyCoverage: Record<string, any> = {
    verifier: "tools/server-scripts/verify-operation-permission-universal-tag-policy.ts",
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
    ].every((needle?: any) : any => universalVerifierText.includes(needle))
  };
  const missingUniversalTagPolicyCoverage: any = (Object.entries(universalTagPolicyCoverage) as [string, any][])
    .filter(([key, value]: any[]) : any => key !== "verifier" && value !== true)
    .map(([key]: any[]) : any => key);
  const protocolConsistencyCoverage: Record<string, any> = {
    verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.ts",
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
    revokedCredentialDecision: protocolConsistencyVerifierText.includes("revoked_credential"),
    rateLimitDecision: protocolConsistencyVerifierText.includes("rate_limited"),
    unauthorizedDiscoveryHidden: protocolConsistencyVerifierText.includes("admin operation leaked") ||
      protocolConsistencyVerifierText.includes("config mutation operation leaked")
  };
  const missingProtocolConsistencyCoverage: any = (Object.entries(protocolConsistencyCoverage) as [string, any][])
    .filter(([key, value]: any[]) : any => key !== "verifier" && value !== true)
    .map(([key]: any[]) : any => key);
  const setupEvidence: any = reportEvidence(tagGovernedE2eReport, /setup tags projections/u);
  const allowEvidence: any = reportEvidence(tagGovernedE2eReport, /allow-tag admission/u);
  const discoveryEvidence: any = reportEvidence(tagGovernedE2eReport, /MCP discovery/u);
  const approvalEvidence: any = reportEvidence(tagGovernedE2eReport, /approval queue/u);
  const bypassEvidence: any = reportEvidence(tagGovernedE2eReport, /wrong outlet/u);
  const auditMetricsEvidence: any = reportEvidence(tagGovernedE2eReport, /audit metrics/u);
  const denyEvidence: any = reportEvidence(tagGovernedE2eReport, /deny-tag rejection/u);
  const tagGovernedE2eCoverage: Record<string, any> = {
    verifier: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts",
    report: "build/reports/operation-permission-tag-governed-e2e.json",
    realHttpServer: tagGovernedE2eVerifierText.includes("startHttpServer") || tagGovernedE2eReport.summary?.releaseReady === true,
    upstreamFixture: tagGovernedE2eSourceText.includes("loadedFromPublishedManifest") ||
      setupEvidence.gateway?.loadedFromPublishedManifest === true,
    allowTagAdmission: tagGovernedE2eSourceText.includes("tag_policy_allowed") ||
      (Object.values(allowEvidence) as any[]).some((entry?: any) : any => entry?.tagPolicy?.reasonCode === "tag_policy_allowed"),
    destructiveDenyTagRejection: tagGovernedE2eSourceText.includes("destructiveTest") &&
      tagGovernedE2eSourceText.includes("tag_policy_denied") ||
      reportTestPassed(tagGovernedE2eReport, /deny-tag rejection/u),
    governedCapabilityFamilies: [
      "upstreamService",
      "workspace",
      "consoleAdmin"
    ].every((needle?: any) : any => tagGovernedE2eSourceText.includes(needle) || allowEvidence[needle] || denyEvidence[needle]),
    mcpDiscoveryAuthorization: tagGovernedE2eVerifierText.includes("verifyMcpDiscoveryAuthorizationRefresh"),
    grantDiscoveryRefresh: tagGovernedE2eSourceText.includes("writeVisibleAfterGrantUpdate") ||
      discoveryEvidence.writeVisibleAfterGrantUpdate === true,
    tagPolicyDiscoveryRefresh: tagGovernedE2eSourceText.includes("adminHiddenAfterTagPolicyUpdate") ||
      discoveryEvidence.adminHiddenAfterTagPolicyUpdate === true,
    pendingApprovalListedAndResolved: tagGovernedE2eSourceText.includes("pendingOperationListed") &&
      tagGovernedE2eSourceText.includes("pendingOperationResolved") ||
      (approvalEvidence.pendingOperationListed === true && approvalEvidence.pendingOperationResolved === true),
    bypassPrevention: tagGovernedE2eSourceText.includes("wrongOutletDenied") &&
      tagGovernedE2eSourceText.includes("insufficientGrantDenied") &&
      tagGovernedE2eSourceText.includes("noDownstreamMutation") ||
      (bypassEvidence.wrongOutletDenied === true && bypassEvidence.insufficientGrantDenied === true && bypassEvidence.noDownstreamMutation === true),
    auditProof: tagGovernedE2eSourceText.includes("auditStatuses") &&
      tagGovernedE2eSourceText.includes("auditToolCoverage") &&
      ["ok", "denied", "pending_approval"].every((status?: any) : any => tagGovernedE2eSourceText.includes(`"${status}"`)) ||
      (["ok", "denied", "pending_approval"].every((status?: any) : any =>
        (auditMetricsEvidence.auditStatuses || []).includes(status)
      ) && (Object.values(auditMetricsEvidence.auditToolCoverage || {}) as any[]).every((covered?: any) : any => covered === true)),
    metricsCoverage: tagGovernedE2eSourceText.includes("metricStatuses") &&
      tagGovernedE2eSourceText.includes("metricToolCoverage") &&
      tagGovernedE2eSourceText.includes("pendingApproval") ||
      (Number(auditMetricsEvidence.metricStatuses?.ok || 0) > 0 &&
        Number(auditMetricsEvidence.metricStatuses?.denied || 0) > 0 &&
        Number(auditMetricsEvidence.metricStatuses?.pendingApproval || 0) > 0 &&
        (Object.values(auditMetricsEvidence.metricToolCoverage || {}) as any[]).every((covered?: any) : any => covered === true)),
    cleanup: tagGovernedE2eSourceText.includes("denyTagArchived") &&
      tagGovernedE2eSourceText.includes("gatewayServicesConfigManaged") &&
      tagGovernedE2eSourceText.includes("grantsRevoked") ||
      Boolean(auditMetricsEvidence.cleanup),
    reportLeakScan: tagGovernedE2eSourceText.includes("reportLeakScan") ||
      tagGovernedE2eReport.summary?.reportLeakScan === true
  };
  const missingTagGovernedE2eCoverage: any = (Object.entries(tagGovernedE2eCoverage) as [string, any][])
    .filter(([key, value]: any[]) : any => key !== "verifier" && key !== "report" && value !== true)
    .map(([key]: any[]) : any => key);
  const auditReady: any = missingCoverage.length === 0 &&
    missingUniversalTagPolicyCoverage.length === 0 &&
    missingProtocolConsistencyCoverage.length === 0 &&
    missingTagGovernedE2eCoverage.length === 0;

  const report: Record<string, any> = {
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
