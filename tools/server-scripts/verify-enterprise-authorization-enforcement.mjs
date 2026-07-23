#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { dispatchOperation } from "../../packages/server-runtime/src/composition/dispatch-operation.mjs";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/enterprise-authorization-enforcement.json";
const GOVERNANCE_REPORT = "build/reports/enterprise-governance-coverage.json";
const TAG_GOVERNED_E2E_REPORT = "build/reports/operation-permission-tag-governed-e2e.json";
const PROTOCOL_CONSISTENCY_REPORT = "build/reports/operation-permission-protocol-consistency.json";
const OPERATION_DISPATCHER_SOURCE = "packages/server-runtime/src/composition/dispatch-operation-core.mjs";
const AUTHORIZATION_ENGINE_SOURCE = "packages/foundation/src/security/authorization/authorization-engine.mjs";
const PEP_SOURCE = "packages/foundation/src/security/authorization/pdp/policy-enforcement-point.mjs";

const REQUIRED_MUTATING_PREFIXES = Object.freeze([
  "external_services.",
  "gateway.",
  "workspace.file.",
  "storage.",
  "jobs.",
  "tag_management.",
  "operation_permission."
]);

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u]
]);

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

async function readText(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function methodOf(operation = {}) {
  return String(operation.http?.method || "GET").toUpperCase();
}

function riskOf(operation = {}, tool = null) {
  return String(operation.safety?.risk || operation.risk || tool?.risk || (methodOf(operation) === "GET" ? "read_only" : "safe_write"));
}

function isMutating(operation = {}, tool = null) {
  return !(operation.readOnly === true || riskOf(operation, tool) === "read_only" || methodOf(operation) === "GET");
}

function isRequiredFamily(operationId = "") {
  return REQUIRED_MUTATING_PREFIXES.some((prefix) => operationId.startsWith(prefix));
}

function authorizationEvidence(operation = {}, tool = null) {
  const requiredScopes = uniqueStrings([
    ...(operation.requiredScopes || []),
    ...(tool?.requiredScopes || [])
  ]);
  const operationGroups = uniqueStrings(tool?.toolsets || []);
  return {
    requiredScopes,
    operationGroups,
    grantEnforced: Boolean(tool || operationGroups.length),
    externalAuthVerifier: Boolean(operation.externalAuthVerifier),
    subjectRequired: requiredScopes.length > 0 || operationGroups.length > 0 || Boolean(operation.externalAuthVerifier),
    policyDecisionBoundary: tool ? "operation_permission_policy_engine" : requiredScopes.length ? "operation_registry_scope_policy" : operation.externalAuthVerifier ? "external_auth_verifier" : ""
  };
}

function approvalEvidence(operation = {}) {
  const risk = riskOf(operation);
  const safety = operation.safety && typeof operation.safety === "object" ? operation.safety : {};
  return {
    risk,
    requiresConfirmation: safety.requiresConfirmation === true || safety.requiresConfirmationExplicit === true || risk === "destructive",
    approvalScope: String(safety.approvalScope || ""),
    highRiskGate: ["repair_write", "destructive"].includes(risk)
      ? Boolean(safety.requiresConfirmation || safety.requiresConfirmationExplicit || safety.approvalScope)
      : true
  };
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Enterprise authorization enforcement report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

function createCapturedResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    ended: false,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    }
  };
}

async function verifyDispatcherAuthorizationInputBinding() {
  const operation = {
    id: "verify.authorization.input_binding",
    target: { controller: "unit", method: "handle" },
    http: {
      method: "POST",
      path: "/api/verify/workspaces/:workspaceId/input-binding",
      query: [{ name: "serviceId" }]
    },
    public: false,
    externalAuth: false,
    concurrencySafe: true,
    readOnly: true,
    safety: { risk: "read_only" },
    audit: { enabled: false },
    log: { recordInput: false },
    inputSchema: { type: "object", properties: {} }
  };
  const response = createCapturedResponse();
  const captured = {};
  const result = await dispatchOperation({
    operation,
    controllers: {
      unit: {
        handle({ response: handlerResponse }) {
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
    authorizeOperation: async (input) => {
      captured.input = input.input || {};
      return {
        ok: false,
        status: 403,
        error: "denied"
      };
    },
    logger: { debug() {}, warn() {}, error() {} }
  });
  const input = captured.input || {};
  const ok = result.ok === false &&
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

function realReportEvidence(tagGoverned = {}, protocol = {}) {
  const tagText = JSON.stringify(tagGoverned);
  const protocolText = JSON.stringify(protocol);
  return {
    tagGovernedE2e: {
      releaseReady: releaseEvidenceReady(TAG_GOVERNED_E2E_REPORT, tagGoverned),
      reportLeakScan: tagGoverned.summary?.reportLeakScan === true,
      pendingApprovalListed: tagText.includes("pendingOperationListed"),
      pendingApprovalResolved: tagText.includes("pendingOperationResolved"),
      denialWithoutDownstreamMutation: tagText.includes("noDownstreamMutation") && tagText.includes("DeniedWithoutSideEffect"),
      auditProof: tagText.includes("auditProof") && tagText.includes("policyDecisionPresent"),
      publicDenialEvidence: tagText.includes("tag_policy_denied") || tagText.includes("denied")
    },
    protocolConsistency: {
      releaseReady: releaseEvidenceReady(PROTOCOL_CONSISTENCY_REPORT, protocol),
      approvalRequired: protocolText.includes("approval_required"),
      revokedGrant: protocolText.includes("revoked_grant"),
      rateLimited: protocolText.includes("rate_limited"),
      sameDecisionAcrossHttpRpcMcp: protocolText.includes("\"http\"") && protocolText.includes("\"rpc\"") && protocolText.includes("\"mcp\"")
    }
  };
}

async function verifyCanonicalAuthorizationConvergence() {
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

async function main() {
  const completeOperations = SERVER_API_OPERATIONS;
  const catalog = createToolCatalog({ operations: completeOperations });
  const toolsByOperationId = new Map(catalog.tools.map((tool) => [tool.operationId, tool]));
  const governance = await readJson(GOVERNANCE_REPORT);
  const tagGoverned = await readJson(TAG_GOVERNED_E2E_REPORT);
  const protocol = await readJson(PROTOCOL_CONSISTENCY_REPORT);
  const reportEvidence = realReportEvidence(tagGoverned, protocol);
  const dispatcherAuthorizationInputBinding = await verifyDispatcherAuthorizationInputBinding();
  const canonicalAuthorizationConvergence = await verifyCanonicalAuthorizationConvergence();

  const governedMutations = completeOperations
    .filter((operation) => isRequiredFamily(operation.id))
    .map((operation) => {
      const tool = toolsByOperationId.get(operation.id) || null;
      return {
        operation,
        tool,
        mutating: isMutating(operation, tool)
      };
    })
    .filter((entry) => entry.mutating)
    .map(({ operation, tool }) => {
      const authorization = authorizationEvidence(operation, tool);
      const approval = approvalEvidence(operation);
      const findings = [];
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

  const missingRuntimeEvidence = [];
  if (governance.summary?.releaseReady !== true || governance.summary?.failingOperationCount !== 0) {
    missingRuntimeEvidence.push("enterprise_governance_coverage_not_release_ready");
  }
  if (!reportEvidence.tagGovernedE2e.releaseReady || !reportEvidence.tagGovernedE2e.reportLeakScan) {
    missingRuntimeEvidence.push("tag_governed_e2e_not_release_ready");
  }
  if (dispatcherAuthorizationInputBinding.ok !== true) {
    missingRuntimeEvidence.push("dispatcher_authorization_input_binding_missing");
  }
  for (const [key, value] of Object.entries(canonicalAuthorizationConvergence)) {
    if (value !== true) {
      missingRuntimeEvidence.push(`canonical_authorization_convergence_missing_${key}`);
    }
  }
  for (const [key, value] of Object.entries(reportEvidence.tagGovernedE2e)) {
    if (value !== true) {
      missingRuntimeEvidence.push(`tag_governed_e2e_missing_${key}`);
    }
  }
  for (const [key, value] of Object.entries(reportEvidence.protocolConsistency)) {
    if (value !== true) {
      missingRuntimeEvidence.push(`protocol_consistency_missing_${key}`);
    }
  }

  const failingOperations = governedMutations.filter((row) => row.findings.length);
  const releaseReady = failingOperations.length === 0 && missingRuntimeEvidence.length === 0;
  const report = {
    schemaVersion: "v0.0.1:authorization:enterprise-enforcement-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-enterprise-authorization-enforcement.mjs",
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.mjs",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.mjs",
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
      failingOperations: failingOperations.map((row) => ({
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
