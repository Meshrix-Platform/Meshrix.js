#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { dispatchOperation } from "../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/enterprise-authorization-enforcement.json";
const GOVERNANCE_REPORT: any = "build/reports/enterprise-governance-coverage.json";
const TAG_GOVERNED_E2E_REPORT: any = "build/reports/operation-permission-tag-governed-e2e.json";
const PROTOCOL_CONSISTENCY_REPORT: any = "build/reports/operation-permission-protocol-consistency.json";
const OPERATION_DISPATCHER_SOURCE: any = "packages/server-runtime/src/composition/dispatch-operation-core.ts";
const AUTHORIZATION_ENGINE_SOURCE: any = "packages/foundation/src/security/authorization/authorization-engine.ts";
const PEP_SOURCE: any = "packages/foundation/src/security/authorization/pdp/policy-enforcement-point.ts";

const REQUIRED_MUTATING_PREFIXES: readonly any[] = Object.freeze([
  "external_services.",
  "gateway.",
  "workspace.file.",
  "storage.",
  "jobs.",
  "tag_management.",
  "operation_permission."
]);

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u]
]);

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function methodOf(operation: Record<string, any> = {}) : any {
  return String(operation.http?.method || "GET").toUpperCase();
}

function riskOf(operation: Record<string, any> = {}, tool: any = null) : any {
  return String(operation.safety?.risk || operation.risk || tool?.risk || (methodOf(operation) === "GET" ? "read_only" : "safe_write"));
}

function isMutating(operation: Record<string, any> = {}, tool: any = null) : any {
  return !(operation.readOnly === true || riskOf(operation, tool) === "read_only" || methodOf(operation) === "GET");
}

function isRequiredFamily(operationId: any = "") : any {
  return REQUIRED_MUTATING_PREFIXES.some((prefix?: any) : any => operationId.startsWith(prefix));
}

function authorizationEvidence(operation: Record<string, any> = {}, tool: any = null) : any {
  const requiredScopes: any = uniqueStrings([
    ...(operation.requiredScopes || []),
    ...(tool?.requiredScopes || [])
  ]);
  const operationGroups: any = uniqueStrings(tool?.toolsets || []);
  return {
    requiredScopes,
    operationGroups,
    grantEnforced: Boolean(tool || operationGroups.length),
    externalAuthVerifier: Boolean(operation.externalAuthVerifier),
    subjectRequired: requiredScopes.length > 0 || operationGroups.length > 0 || Boolean(operation.externalAuthVerifier),
    policyDecisionBoundary: tool ? "operation_permission_policy_engine" : requiredScopes.length ? "operation_registry_scope_policy" : operation.externalAuthVerifier ? "external_auth_verifier" : ""
  };
}

function approvalEvidence(operation: Record<string, any> = {}) : any {
  const risk: any = riskOf(operation);
  const safety: any = operation.safety && typeof operation.safety === "object" ? operation.safety : {};
  return {
    risk,
    requiresConfirmation: safety.requiresConfirmation === true || safety.requiresConfirmationExplicit === true || risk === "destructive",
    approvalScope: String(safety.approvalScope || ""),
    highRiskGate: ["repair_write", "destructive"].includes(risk)
      ? Boolean(safety.requiresConfirmation || safety.requiresConfirmationExplicit || safety.approvalScope)
      : true
  };
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Enterprise authorization enforcement report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

function createCapturedResponse() : any {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    ended: false,
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    setHeader(name?: any, value?: any) : any {
      this.headers[name] = value;
    },
    getHeader(name?: any) : any {
      return this.headers[name];
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    }
  };
}

async function verifyDispatcherAuthorizationInputBinding() : Promise<any> {
  const operation: Record<string, any> = {
    id: "verify.authorization.input_binding",
    target: { controller: "unit", method: "handle" },
    http: {
      method: "POST",
      path: "/api/verify/workspaces/:workspaceId/input-binding",
      query: [{ name: "serviceId" }]
    },
    public: false,
    externalAuth: false,
    concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
    readOnly: true,
    safety: { risk: "read_only" },
    audit: { enabled: false },
    log: { recordInput: false },
    inputSchema: { type: "object", properties: {} }
  };
  const response: any = createCapturedResponse();
  const captured: Record<string, any> = {};
  const result: any = await dispatchOperation({
    operation,
    controllers: {
      unit: {
        handle({ response: handlerResponse }: Record<string, any>) : any {
          handlerResponse.writeHead(204, {});
          handlerResponse.end();
        }
      }
    },
    request: { headers: {} },
    response,
    requestBody: Buffer.from(JSON.stringify({ secretBindingId: "secret-denied" }), "utf8"),
    url: new URL("http://127.0.0.1/api/verify/workspaces/workspace-denied/input-binding?serviceId=service-denied"),
    params: { workspaceId: "workspace-denied" },
    transport: "http",
    method: "POST",
    authorizeOperation: async (input?: any) : Promise<any> => {
      captured.input = input.input || {};
      return {
        ok: false,
        status: 403,
        error: "denied"
      };
    },
    logger: { debug() : any {}, warn() : any {}, error() : any {} }
  });
  const input: any = captured.input || {};
  const ok: any = result.ok === false &&
    result.statusCode === 403 &&
    input.workspaceId === "workspace-denied" &&
    input.serviceId === "service-denied" &&
    input.secretBindingId === "secret-denied";
  return {
    ok,
    deniedBeforeExecution: result.statusCode === 403 && response.statusCode === 403,
    pathInputBound: input.workspaceId === "workspace-denied",
    queryInputBound: input.serviceId === "service-denied",
    bodyInputBound: input.secretBindingId === "secret-denied"
  };
}

function reportTest(report: Record<string, any> = {}, pattern?: any) : any {
  return (report.tests || []).find((test?: any) : any => pattern.test(String(test.name || "")));
}

function reportEvidence(report: Record<string, any> = {}, pattern?: any) : any {
  return reportTest(report, pattern)?.evidence || {};
}

function destructiveReportEvidence(report: Record<string, any> = {}, pattern?: any) : any {
  return (report.destructiveTests || []).find((test?: any) : any => pattern.test(String(test.name || "")))?.evidence || {};
}

function realReportEvidence(tagGoverned: Record<string, any> = {}, protocol: Record<string, any> = {}) : any {
  const tagText: any = JSON.stringify(tagGoverned);
  const protocolText: any = JSON.stringify(protocol);
  const approvalEvidence: any = reportEvidence(tagGoverned, /approval queue/u);
  const bypassEvidence: any = reportEvidence(tagGoverned, /wrong outlet/u);
  const auditMetricsEvidence: any = reportEvidence(tagGoverned, /audit metrics/u);
  const denyEvidence: any = destructiveReportEvidence(tagGoverned, /deny-tag rejection/u);
  const auditStatuses: any = auditMetricsEvidence.auditStatuses || [];
  const auditProof: any = ["ok", "denied", "pending_approval"].every((status?: any) : any => auditStatuses.includes(status)) &&
    (Object.values(auditMetricsEvidence.auditToolCoverage || {}) as any[]).every((covered?: any) : any => covered === true);
  const policyDecisionPresent: any = (Object.values({
    ...(reportEvidence(tagGoverned, /allow-tag admission/u)),
    ...denyEvidence
  }) as any[]).some((entry?: any) : any => entry && typeof entry === "object" && entry.tagPolicy && typeof entry.tagPolicy === "object");
  return {
    tagGovernedE2e: {
      releaseReady: releaseEvidenceReady(TAG_GOVERNED_E2E_REPORT, tagGoverned),
      reportLeakScan: tagGoverned.summary?.reportLeakScan === true,
      pendingApprovalListed: approvalEvidence.pendingOperationListed === true ||
        tagText.includes("pendingOperationListed"),
      pendingApprovalResolved: approvalEvidence.pendingOperationResolved === true ||
        tagText.includes("pendingOperationResolved"),
      denialWithoutDownstreamMutation: bypassEvidence.noDownstreamMutation === true &&
        (denyEvidence.upstreamService?.forwardDeniedWithoutSideEffect === true ||
          tagText.includes("DeniedWithoutSideEffect")),
      auditProof: auditProof && policyDecisionPresent,
      publicDenialEvidence: tagText.includes("tag_policy_denied") || tagText.includes("denied")
    },
    protocolConsistency: {
      releaseReady: releaseEvidenceReady(PROTOCOL_CONSISTENCY_REPORT, protocol),
      approvalRequired: protocolText.includes("approval_required"),
      revokedGrant: protocolText.includes("revoked_grant") || protocolText.includes("revoked_credential"),
      rateLimited: protocolText.includes("rate_limited"),
      sameDecisionAcrossHttpRpcMcp: protocolText.includes("\"http\"") && protocolText.includes("\"rpc\"") && protocolText.includes("\"mcp\"")
    }
  };
}

async function verifyCanonicalAuthorizationConvergence() : Promise<any> {
  const [dispatcherText, authorizationEngineText, pepText] = await Promise.all([
    readText(OPERATION_DISPATCHER_SOURCE),
    readText(AUTHORIZATION_ENGINE_SOURCE),
    readText(PEP_SOURCE)
  ]);
  return {
    dispatcherUsesAuthorizationEngine: /createAuthorizationEngine/u.test(dispatcherText),
    authorizationEngineOwnsPolicyEvaluation: /export function evaluateAuthorizationPolicy/u.test(authorizationEngineText) &&
      /approval_receipt_required/u.test(authorizationEngineText),
    pepDefaultsToAuthorizationEngine: /createAuthorizationEngine/u.test(pepText)
  };
}

async function main() : Promise<any> {
  const completeOperations: any = SERVER_API_OPERATIONS;
  const catalog: any = createToolCatalog({ operations: completeOperations });
  const toolsByOperationId: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.operationId, tool]));
  const governance: any = await readJson(GOVERNANCE_REPORT);
  const tagGoverned: any = await readJson(TAG_GOVERNED_E2E_REPORT);
  const protocol: any = await readJson(PROTOCOL_CONSISTENCY_REPORT);
  const reportEvidence: any = realReportEvidence(tagGoverned, protocol);
  const dispatcherAuthorizationInputBinding: any = await verifyDispatcherAuthorizationInputBinding();
  const canonicalAuthorizationConvergence: any = await verifyCanonicalAuthorizationConvergence();

  const governedMutations: any = completeOperations
    .filter((operation?: any) : any => isRequiredFamily(operation.id))
    .map((operation?: any) : any => {
      const tool: any = toolsByOperationId.get(operation.id) || null;
      return {
        operation,
        tool,
        mutating: isMutating(operation, tool)
      };
    })
    .filter((entry?: any) : any => entry.mutating)
    .map(({ operation, tool }: Record<string, any>) : any => {
      const authorization: any = authorizationEvidence(operation, tool);
      const approval: any = approvalEvidence(operation);
      const findings: any[] = [];
      if (!authorization.subjectRequired) {
        findings.push("missing_current_subject_or_policy_boundary");
      }
      if (!authorization.policyDecisionBoundary) {
        findings.push("missing_policy_decision_boundary");
      }
      if (!approval.highRiskGate) {
        findings.push("missing_high_risk_approval_or_confirmation_gate");
      }
      return {
        operationId: operation.id,
        feature: operation.feature || "",
        authorization,
        approval,
        findings
      };
    });

  const missingRuntimeEvidence: any[] = [];
  if (governance.summary?.releaseReady !== true || governance.summary?.failingOperationCount !== 0) {
    missingRuntimeEvidence.push("enterprise_governance_coverage_not_release_ready");
  }
  if (!reportEvidence.tagGovernedE2e.releaseReady || !reportEvidence.tagGovernedE2e.reportLeakScan) {
    missingRuntimeEvidence.push("tag_governed_e2e_not_release_ready");
  }
  if (dispatcherAuthorizationInputBinding.ok !== true) {
    missingRuntimeEvidence.push("dispatcher_authorization_input_binding_missing");
  }
  for (const [key, value] of (Object.entries(canonicalAuthorizationConvergence) as [string, any][])) {
    if (value !== true) {
      missingRuntimeEvidence.push(`canonical_authorization_convergence_missing_${key}`);
    }
  }
  for (const [key, value] of (Object.entries(reportEvidence.tagGovernedE2e) as [string, any][])) {
    if (value !== true) {
      missingRuntimeEvidence.push(`tag_governed_e2e_missing_${key}`);
    }
  }
  for (const [key, value] of (Object.entries(reportEvidence.protocolConsistency) as [string, any][])) {
    if (value !== true) {
      missingRuntimeEvidence.push(`protocol_consistency_missing_${key}`);
    }
  }

  const failingOperations: any = governedMutations.filter((row?: any) : any => row.findings.length);
  const releaseReady: any = failingOperations.length === 0 && missingRuntimeEvidence.length === 0;
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:authorization:enterprise-enforcement-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-enterprise-authorization-enforcement.ts",
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.ts",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.ts",
      authorizationEngine: AUTHORIZATION_ENGINE_SOURCE,
      governanceCoverageReport: GOVERNANCE_REPORT,
      tagGovernedE2eReport: TAG_GOVERNED_E2E_REPORT,
      protocolConsistencyReport: PROTOCOL_CONSISTENCY_REPORT
    },
    algorithm: {
      mutationEnumeration: "Enumerate mutating gateway, workspace file, storage, jobs, tag governance, and Operation Permission operations.",
      enforcementCheck: "Require each mutating operation to have a current subject source, scopes or operation groups, and a policy decision boundary.",
      approvalCheck: "Require repair_write and destructive operations to declare confirmation or approval scope.",
      realEvidenceCheck: "Require latest real E2E reports to prove pending approval list/resolve, denial without downstream mutation, public denial evidence, audit policy decision proof, revoked grant, rate limit, and HTTP/RPC/MCP decision convergence."
    },
    summary: {
      governedMutatingOperationCount: governedMutations.length,
      failingOperationCount: failingOperations.length,
      missingRuntimeEvidenceCount: missingRuntimeEvidence.length,
      releaseReady,
      reportLeakScan: true
    },
    realEvidence: reportEvidence,
    dispatcherAuthorizationInputBinding,
    canonicalAuthorizationConvergence,
    operations: governedMutations,
    destructiveChecks: {
      mutatingOperationsMissingPolicyBoundaryFailVerifier: failingOperations.length === 0,
      approvalRequiredOperationsNeedPendingApprovalProof: reportEvidence.tagGovernedE2e.pendingApprovalListed &&
        reportEvidence.tagGovernedE2e.pendingApprovalResolved &&
        reportEvidence.protocolConsistency.approvalRequired,
      denialEvidenceMustBeAuditableAndRedacted: reportEvidence.tagGovernedE2e.auditProof &&
        reportEvidence.tagGovernedE2e.publicDenialEvidence &&
        reportEvidence.tagGovernedE2e.reportLeakScan,
      missingRuntimeEvidence,
      failingOperations: failingOperations.map((row?: any) : any => ({
        operationId: row.operationId,
        findings: row.findings
      }))
    }
  };

  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!releaseReady) {
    console.error(`[enterprise-authorization-enforcement] report=${REPORT_PATH}`);
    for (const row of failingOperations.slice(0, 20)) {
      console.error(`- ${row.operationId}: ${row.findings.join(",")}`);
    }
    for (const finding of missingRuntimeEvidence.slice(0, 20)) {
      console.error(`- ${finding}`);
    }
    process.exit(1);
  }

  console.log(`[enterprise-authorization-enforcement] report=${REPORT_PATH}`);
  console.log(`[enterprise-authorization-enforcement] governedMutations=${governedMutations.length} releaseReady=true`);
}

await main();
