#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.mjs";
import { operationFeatureId } from "../../packages/contracts/src/operations/operation-feature-resolution.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { createPendingOperationRuntime } from "../../packages/capabilities/src/operation-permission-core/runtime-pending.mjs";
import { createOperationPermissionStore } from "../../packages/capabilities/src/operation-permission-core/store.mjs";
import { createAuthorizationGovernanceStore } from "../../packages/foundation/src/security/authorization/authorization-governance-store.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/enterprise-governance-coverage.json";
const MATRIX_PATH = "tools/registry/open-platform-capability-matrix.json";
const CANONICAL_VERIFIER = "tools/server-scripts/verify-authorization-governance.mjs";

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u]
]);

const BOOTSTRAP_OR_PAIRING_OPERATION_PATTERNS = Object.freeze([
  /^auth\.login$/u,
  /^auth\.logout$/u,
  /^process_identity\.bootstrap_/u,
  /^discovery\./u
]);

const PRIVATE_ROOT_PATTERNS = Object.freeze([
  /\bapps\/private\b/iu,
  /\bpackages\/private\b/iu,
  /\bprivate-product\b/iu,
  /\bproprietary-runtime\b/iu,
  /\bmeshrix-private\b/iu
]);

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
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

function isReadOnly(operation = {}, tool = null) {
  return operation.readOnly === true ||
    riskOf(operation, tool) === "read_only" ||
    methodOf(operation) === "GET";
}

function isMutating(operation = {}, tool = null) {
  return !isReadOnly(operation, tool);
}

function isBootstrapOrPairingBoundary(operationId = "") {
  return BOOTSTRAP_OR_PAIRING_OPERATION_PATTERNS.some((pattern) => pattern.test(operationId));
}

function operationMatchesPrefix(operationId = "", prefixes = []) {
  return prefixes.some((prefix) => operationId.startsWith(prefix));
}

function capabilityForOperation(operation = {}, matrix = {}) {
  const operationId = String(operation.id || "");
  const capability = (matrix.capabilities || []).find((entry) =>
    operationMatchesPrefix(operationId, [
      ...(entry.requiredRuntimePrefixes || []),
      ...(entry.knownProtocolPrefixes || [])
    ])
  );
  if (capability) {
    return {
      capabilityId: capability.id,
      title: capability.title || "",
      classification: "enterprise_baseline"
    };
  }
  const feature = String(operation.feature || "");
  const platformSupportFeatures = new Set([
    "agent_gateway",
    "agent_management",
    "agent_memory",
    "agent_sync",
    "agent_workspace",
    "auth",
    "context_runtime",
    "discovery",
    "events",
    "maintenance_agent",
    "module_management",
    "production",
    "raw_objects",
    "runtime",
    "settings",
    "strategy_management",
    "system",
    "uploads"
  ]);
  if (platformSupportFeatures.has(feature)) {
    return {
      capabilityId: feature || "platform-core",
      title: "Platform Support",
      classification: "platform_support"
    };
  }
  return {
    capabilityId: String(operation.feature || "unclassified"),
    title: "Unclassified Current Operation",
    classification: "current_unclassified"
  };
}

function approvalCoverage(operation = {}, tool = null) {
  const risk = riskOf(operation, tool);
  const safety = operation.safety && typeof operation.safety === "object" ? operation.safety : {};
  const requiresConfirmation = safety.requiresConfirmation === true ||
    safety.requiresConfirmationExplicit === true ||
    risk === "destructive";
  const approvalScope = String(safety.approvalScope || "");
  const highRisk = ["repair_write", "destructive"].includes(risk);
  return {
    risk,
    requiresConfirmation,
    approvalScope,
    policyPresent: Boolean(operation.safety || tool?.risk),
    highRiskApprovalGatePresent: highRisk ? Boolean(requiresConfirmation || approvalScope) : true
  };
}

function auditCoverage(operation = {}, tool = null) {
  const explicitAudit = operation.audit && typeof operation.audit === "object" ? operation.audit : null;
  const explicitLog = operation.log && typeof operation.log === "object" ? operation.log : null;
  return {
    policy: tool ? "operation_permission_tool_audit" : explicitAudit ? "operation_registry_audit" : explicitLog ? "operation_registry_log" : "",
    recordInput: explicitAudit?.recordInput ?? explicitLog?.recordInput ?? false,
    metadataOnly: explicitAudit?.metadataOnly === true || tool !== null,
    present: Boolean(tool || explicitAudit || explicitLog)
  };
}

function metricsCoverage(operation = {}, tool = null) {
  return {
    policy: tool ? "operation_permission_tool_metrics" : operation.http?.path ? "http_request_metrics" : operation.rpc?.method ? "rpc_request_metrics" : "",
    present: Boolean(tool || operation.http?.path || operation.rpc?.method)
  };
}

function traceCoverage(operation = {}, tool = null) {
  return {
    policy: tool ? "operation_permission_trace_id" : operation.http?.path ? "http_request_trace" : operation.rpc?.method ? "rpc_request_trace" : "",
    present: Boolean(tool || operation.http?.path || operation.rpc?.method)
  };
}

function redactionCoverage(operation = {}, tool = null) {
  const explicitAudit = operation.audit && typeof operation.audit === "object" ? operation.audit : null;
  const explicitLog = operation.log && typeof operation.log === "object" ? operation.log : null;
  const redaction = String(explicitLog?.redaction || "");
  return {
    policy: tool ? "operation_permission_public_redaction" : redaction || (explicitAudit || explicitLog ? "operation_registry_redaction" : ""),
    recordInputDisabled: explicitAudit?.recordInput === false || explicitLog?.recordInput === false || tool !== null,
    present: Boolean(tool || explicitAudit || explicitLog)
  };
}

function trafficCoverage(operation = {}) {
  const hasTrafficInput = Boolean(operation.inputSchema?.properties?.trafficPolicy);
  const gatewayOperation = String(operation.id || "").startsWith("gateway.") ||
    String(operation.id || "").startsWith("external_services.");
  return {
    present: hasTrafficInput || gatewayOperation,
    policy: hasTrafficInput ? "operation_input_traffic_policy" : gatewayOperation ? "gateway_runtime_traffic_controls" : ""
  };
}

function authorizationCoverage(operation = {}, tool = null) {
  const requiredScopes = uniqueStrings([
    ...(operation.requiredScopes || []),
    ...(tool?.requiredScopes || [])
  ]);
  const toolsets = uniqueStrings(tool?.toolsets || []);
  const bootstrapBoundary = isBootstrapOrPairingBoundary(operation.id);
  const externalAuthVerifier = operation.externalAuthVerifier && typeof operation.externalAuthVerifier === "object";
  const subjectResolution =
    requiredScopes.length > 0 ? "scope_policy" :
    toolsets.length > 0 ? "grant_toolset_policy" :
    externalAuthVerifier ? "external_auth_verifier" :
    bootstrapBoundary ? "bootstrap_or_pairing_boundary" :
    "";
  return {
    subjectResolution,
    requiredScopes,
    operationGroups: toolsets,
    grantEnforced: Boolean(tool || toolsets.length > 0),
    bootstrapBoundary,
    externalAuthVerifier,
    present: Boolean(subjectResolution)
  };
}

function operationFindings(row = {}) {
  const findings = [];
  const mutating = row.readOnly === false;
  if (mutating && !row.authorization.present) {
    findings.push("mutating_operation_missing_authorization");
  }
  if (mutating && !row.approval.policyPresent) {
    findings.push("mutating_operation_missing_safety_policy");
  }
  if (mutating && !row.approval.highRiskApprovalGatePresent) {
    findings.push("high_risk_operation_missing_approval_or_confirmation");
  }
  if (mutating && !row.audit.present) {
    findings.push("mutating_operation_missing_audit_policy");
  }
  if (mutating && !row.metrics.present) {
    findings.push("mutating_operation_missing_metrics_policy");
  }
  if (mutating && !row.trace.present) {
    findings.push("mutating_operation_missing_trace_policy");
  }
  if (mutating && !row.redaction.present) {
    findings.push("mutating_operation_missing_redaction_policy");
  }
  if (row.capability.classification === "current_unclassified") {
    findings.push("operation_not_mapped_to_enterprise_or_platform_support_capability");
  }
  return findings;
}

function privateLeakFindings(values = []) {
  const findings = [];
  for (const value of values) {
    const text = String(value || "");
    const matched = PRIVATE_ROOT_PATTERNS.find((pattern) => pattern.test(text));
    if (matched) {
      findings.push({
        value: text,
        pattern: String(matched)
      });
    }
  }
  return findings;
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Enterprise governance coverage report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function verifyLayeredApprovalModel() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-governance-layers-"));
  const tagManagementStore = createTagStoreAdapter({ userDataPath });
  const governance = createAuthorizationGovernanceStore({
    userDataPath,
    builtinRoles: {},
    tagManagementStore
  });
  const operation = {
    id: "gateway.forward",
    safety: { risk: "repair_write" },
    requiredScopes: ["gateway:write"]
  };
  const input = {
    resourceType: "repo",
    resourceId: "owner/repo",
    requestedAction: "repo:write",
    targetProvider: "github",
    agentId: "agent-codex",
    boundUserId: "console-user-1"
  };
  const subject = {
    type: "console-user",
    subjectId: "console-user-1",
    teamIds: ["team-code"],
    departmentIds: ["department-platform"]
  };
  const baseApproval = {
    userId: "console-user-1",
    agentId: "agent-codex",
    resourceType: "repo",
    resourceId: "owner/repo",
    actions: ["repo:write"],
    targetProviders: ["github"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"]
  };
  try {
    governance.upsertDepartment({
      departmentId: "department-platform",
      label: "Platform Department",
      teamIds: ["team-code"],
      memberUserIds: ["console-user-1"]
    });
    governance.upsertTeam({
      teamId: "team-code",
      label: "Code Team",
      departmentIds: ["department-platform"],
      memberUserIds: ["console-user-1"]
    });
    governance.upsertUserPolicy({
      userId: "console-user-1",
      teamIds: ["team-code"],
      departmentIds: ["department-platform"]
    });
    governance.upsertAgentBinding({
      agentId: "agent-codex",
      boundUserId: "console-user-1"
    });

    const decisions = [];
    const evaluate = () => {
      const decision = governance.evaluateGovernance({ operation, input, subject, governanceRequired: true });
      decisions.push({
        effect: decision.effect,
        reasonCode: decision.reasonCode,
        deniedLayer: decision.deniedLayer || "",
        requiredApprovalLayers: decision.requiredApproval?.approvalLayers || []
      });
      return decision;
    };
    evaluate();
    governance.upsertApproval({ ...baseApproval, approvalId: "approval-department", approvalLayers: ["department"] });
    evaluate();
    governance.upsertApproval({ ...baseApproval, approvalId: "approval-team", approvalLayers: ["team"] });
    evaluate();
    governance.upsertApproval({ ...baseApproval, approvalId: "approval-user", approvalLayers: ["user"] });
    evaluate();
    governance.upsertApproval({ ...baseApproval, approvalId: "approval-agent", approvalLayers: ["agent"] });
    evaluate();

    const expected = [
      ["needsApproval", "department_approval_required", "department"],
      ["needsApproval", "team_approval_required", "team"],
      ["needsApproval", "user_approval_required", "user"],
      ["needsApproval", "agent_approval_required", "agent"],
      ["allow", "governance_allowed", ""]
    ];
    const passed = expected.every(([effect, reasonCode, layer], index) => {
      const decision = decisions[index] || {};
      return decision.effect === effect &&
        decision.reasonCode === reasonCode &&
        (layer ? decision.requiredApprovalLayers.includes(layer) : true);
    });
    return {
      passed,
      sourceOfTruth: "authorization-governance-store.evaluateGovernance",
      decisionCount: decisions.length,
      decisions
    };
  } finally {
    governance.close();
    tagManagementStore.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function verifyPendingApprovalRequirementsPersistence() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pending-approval-"));
  const store = createOperationPermissionStore({
    userDataPath,
    capabilityKeyProvider: { close() {} },
    capabilityBindingGuard: false
  });
  const requiredApproval = {
    userId: "console-user-1",
    agentId: "agent-codex",
    resourceType: "repo",
    resourceId: "owner/repo",
    actions: ["repo:write"],
    targetProviders: ["github"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"],
    approvalLayers: ["department", "team"],
    grantKinds: ["once", "timed"]
  };
  try {
    const pending = store.createPendingOperation({
      pendingOperationId: "pending-layered-approval",
      traceId: "trace-layered-approval",
      toolExecutionId: "tool-exec-layered-approval",
      toolId: "meshrix.gateway.forward",
      toolVersion: "v1",
      toolsetIds: ["gateway"],
      operationId: "gateway.forward",
      risk: "repair_write",
      approvalScope: "gateway:write",
      requiredApproval,
      approvalLayers: ["agent"],
      grantId: "grant-layered-approval",
      reasonCode: "department_approval_required",
      riskReason: "Department and team approval required.",
      originalInput: {
        operationKey: "write",
        token: "secret"
      },
      context: { transport: "verifier" }
    });
    const projectionOnly = store.createPendingOperation({
      pendingOperationId: "pending-projection-only-approval",
      traceId: "trace-projection-only-approval",
      toolExecutionId: "tool-exec-projection-only-approval",
      toolId: "meshrix.gateway.forward",
      toolVersion: "v1",
      toolsetIds: ["gateway"],
      operationId: "gateway.forward",
      risk: "repair_write",
      approvalScope: "gateway:write",
      requiredApproval: {
        ...requiredApproval,
        approvalLayers: []
      },
      approvalLayers: ["department"],
      grantId: "grant-projection-only-approval",
      reasonCode: "projection_only_should_not_authorize",
      riskReason: "Projection-only approval layer must not become policy.",
      originalInput: {
        operationKey: "write",
        token: "secret"
      },
      context: { transport: "verifier" }
    });
    const listed = store.listPendingOperations({ status: "pending", limit: 5 })
      .find((item) => item.pendingOperationId === pending.pendingOperationId);
    const loaded = store.getPendingOperation(pending.pendingOperationId, { includeOriginalInput: true });
    const loadedProjectionOnly = store.getPendingOperation(projectionOnly.pendingOperationId, { includeOriginalInput: true });
    const expectedLayers = ["department", "team"];
    const layerString = (value = []) => JSON.stringify(value);
    const passed = layerString(pending.approvalLayers) === layerString(expectedLayers) &&
      layerString(listed?.approvalLayers || []) === layerString(expectedLayers) &&
      layerString(loaded?.requiredApproval?.approvalLayers || []) === layerString(expectedLayers) &&
      layerString(projectionOnly.approvalLayers || []) === "[]" &&
      layerString(loadedProjectionOnly?.requiredApproval?.approvalLayers || []) === "[]" &&
      loaded?.requiredApproval?.resourceType === "repo" &&
      loaded?.requiredApproval?.resourceId === "owner/repo" &&
      loaded?.redactedInput?.token === "<redacted>";
    return {
      passed,
      sourceOfTruth: "authorization-governance-store.evaluateGovernance requiredApproval projected into tool_pending_operations",
      pendingApprovalLayers: pending.approvalLayers,
      listedApprovalLayers: listed?.approvalLayers || [],
      loadedApprovalLayers: loaded?.requiredApproval?.approvalLayers || [],
      callerProjectionIgnored: layerString(pending.approvalLayers) === layerString(expectedLayers),
      projectionOnlyApprovalLayerCount: projectionOnly.approvalLayers?.length || 0,
      requiredApprovalLayerCount: loaded?.requiredApproval?.approvalLayers?.length || 0,
      publicRedactedInput: loaded?.redactedInput?.token === "<redacted>"
    };
  } finally {
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function verifyPendingApprovalApproverGuard() {
  const requiredApproval = {
    userId: "console-user-1",
    agentId: "agent-codex",
    resourceType: "repo",
    resourceId: "owner/repo",
    actions: ["repo:write"],
    targetProviders: ["github"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"],
    approvalLayers: ["department"],
    grantKinds: ["once"]
  };
  const pending = {
    pendingOperationId: "pending-layer-guard",
    status: "pending",
    traceId: "trace-layer-guard",
    toolId: "meshrix.gateway.forward",
    grantId: "grant-layer-guard",
    profileId: "profile-guard",
    context: { transport: "verifier" },
    originalInput: {
      resourceType: "repo",
      resourceId: "owner/repo",
      requestedAction: "repo:write",
      targetProvider: "github"
    },
    risk: "repair_write",
    requiredApproval,
    approvalLayers: ["department"]
  };
  const resolveCalls = [];
  let getRawGrantCount = 0;
  let approvalWriteCount = 0;
  let executeCount = 0;
  let grantAvailable = true;
  const runtime = createPendingOperationRuntime({
    store: {
      getPendingOperation() {
        return pending;
      },
      resolvePendingOperation(entry = {}) {
        resolveCalls.push(entry);
        return { ...pending, status: entry.resolution || pending.status };
      },
      getRawGrant() {
        getRawGrantCount += 1;
        return grantAvailable ? { id: pending.grantId, enabled: true } : null;
      },
      appendMetric() {}
    },
    async executeTool() {
      executeCount += 1;
      return {
        ok: true,
        status: 200,
        payload: { schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } }
      };
    },
    async publishEvent() {},
    securityPermissions: {
      async upsertGovernanceApproval() {
        approvalWriteCount += 1;
      }
    }
  });

  const unauthorized = await runtime({
    pendingOperationId: pending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "runtime-admin",
    approver: {
      userId: "console-user-1",
      roleId: "owner",
      scopes: ["runtime:admin"],
      departmentIds: ["department-other"]
    },
    reason: "not eligible for department layer"
  });
  const unauthorizedGuardPassed = unauthorized.status === 403 &&
    unauthorized.payload?.error?.code === "pending_approval_approver_not_authorized" &&
    approvalWriteCount === 0 &&
    resolveCalls.length === 0 &&
    getRawGrantCount === 0 &&
    executeCount === 0;

  grantAvailable = false;
  const unavailableGrant = await runtime({
    pendingOperationId: pending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "department-approver",
    approver: {
      userId: "console-user-1",
      departmentIds: ["department-platform"]
    },
    reason: "eligible but grant unavailable"
  });
  const resolutionNames = resolveCalls.map((entry) => entry.resolution);
  const unavailableGrantGuardPassed = unavailableGrant.status === 409 &&
    unavailableGrant.payload?.error?.code === "pending_operation_grant_unavailable" &&
    approvalWriteCount === 0 &&
    executeCount === 0 &&
    resolutionNames.includes("failed") &&
    !resolutionNames.includes("approved");

  return {
    passed: unauthorizedGuardPassed && unavailableGrantGuardPassed,
    sourceOfTruth: "pending.requiredApproval.approvalLayers plus authorization session user and governance agent binding",
    unauthorizedRuntimeAdminDenied: unauthorizedGuardPassed,
    unavailableGrantLeavesNoApproval: unavailableGrantGuardPassed,
    governanceApprovalWrites: approvalWriteCount,
    executeCount
  };
}

async function main() {
  const layeredApprovalEvidence = await verifyLayeredApprovalModel();
  const pendingApprovalEvidence = await verifyPendingApprovalRequirementsPersistence();
  const pendingApproverGuardEvidence = await verifyPendingApprovalApproverGuard();
  const matrix = await readJson(MATRIX_PATH);
  const completeOperations = SERVER_API_OPERATIONS;
  const catalog = createToolCatalog({ operations: completeOperations });
  const toolsByOperationId = new Map(catalog.tools.map((tool) => [tool.operationId, tool]));
  const protocolIds = new Set(PROTOCOL_OPERATION_DEFINITIONS.map((operation) => operation.id));

  const rows = completeOperations.map((operation) => {
    const tool = toolsByOperationId.get(operation.id) || null;
    const capability = capabilityForOperation(operation, matrix);
    const authorization = authorizationCoverage(operation, tool);
    const approval = approvalCoverage(operation, tool);
    const audit = auditCoverage(operation, tool);
    const metrics = metricsCoverage(operation, tool);
    const trace = traceCoverage(operation, tool);
    const redaction = redactionCoverage(operation, tool);
    const traffic = trafficCoverage(operation);
    const row = {
      operationId: operation.id,
      feature: operation.feature || "",
      featureId: operationFeatureId(operation),
      capability,
      transport: {
        http: operation.http?.path
          ? { method: methodOf(operation), path: operation.http.path }
          : null,
        rpc: operation.rpc?.method || "",
        protocolDefinition: protocolIds.has(operation.id)
      },
      readOnly: isReadOnly(operation, tool),
      authorization,
      approval,
      audit,
      metrics,
      trace,
      redaction,
      traffic,
      operationPermissionCatalog: tool
        ? {
            toolId: tool.id,
            status: tool.status || "",
            risk: tool.risk || "",
            toolsets: uniqueStrings(tool.toolsets || [])
          }
        : null
    };
    return {
      ...row,
      findings: operationFindings(row)
    };
  });

  const mutatingRows = rows.filter((row) => row.readOnly === false);
  const failingRows = rows.filter((row) =>
    row.findings.some((finding) => finding !== "operation_not_mapped_to_enterprise_or_platform_support_capability")
  );
  const unmappedRows = rows.filter((row) => row.findings.includes("operation_not_mapped_to_enterprise_or_platform_support_capability"));
  const privateLeaks = privateLeakFindings([
    ...rows.flatMap((row) => [
      row.operationId,
      row.feature,
      row.featureId,
      row.transport.http?.path,
      row.transport.rpc
    ]),
    ...((matrix.capabilities || []).flatMap((capability) => [
      capability.id,
      capability.title,
      capability.plan,
      ...(capability.docs || []),
      ...(capability.requiredRuntimePrefixes || [])
    ]))
  ]);

  const byCapability = Object.fromEntries(
    [...new Set(rows.map((row) => row.capability.capabilityId))].sort().map((capabilityId) => {
      const scopedRows = rows.filter((row) => row.capability.capabilityId === capabilityId);
      return [
        capabilityId,
        {
          operationCount: scopedRows.length,
          mutatingOperationCount: scopedRows.filter((row) => row.readOnly === false).length,
          findingCount: scopedRows.reduce((sum, row) => sum + row.findings.length, 0)
        }
      ];
    })
  );

  const releaseReady = failingRows.length === 0 &&
    unmappedRows.length === 0 &&
    privateLeaks.length === 0 &&
    layeredApprovalEvidence.passed === true &&
    pendingApprovalEvidence.passed === true &&
    pendingApproverGuardEvidence.passed === true;
  const report = {
    schemaVersion: "v0.0.1:authorization:enterprise-governance-coverage-report-1",
    generatedAt: new Date().toISOString(),
    verifier: CANONICAL_VERIFIER,
    implementationVerifier: "tools/server-scripts/verify-enterprise-governance-coverage.mjs",
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.mjs",
      protocolDefinitions: "packages/contracts/src/operations/protocol-operation-definitions.mjs",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.mjs",
      capabilityMatrix: MATRIX_PATH
    },
    algorithm: {
      operationEnumeration: "Enumerate the complete current Core operation catalog and join it to protocol definitions and Operation Permission catalog projections.",
      mutatingClassification: "Treat non-read-only and non-read risk operations as mutating, with bootstrap and pairing flows classified separately from grant-governed operations.",
      governanceCoverage: "For every operation, report subject resolution, scopes, operation groups, grants, approval policy, audit policy, metrics policy, trace propagation, redaction policy, and traffic-control evidence.",
      destructiveGate: "Fail release readiness when any mutating non-bootstrap operation lacks authorization, safety, audit, metrics, trace, or redaction evidence, when a current operation is not mapped to an enterprise or platform-support capability, or when private capability roots appear in public platform surfaces."
    },
    summary: {
      operationCount: rows.length,
      mutatingOperationCount: mutatingRows.length,
      readOnlyOperationCount: rows.length - mutatingRows.length,
      catalogOperationCount: rows.filter((row) => row.operationPermissionCatalog).length,
      failingOperationCount: failingRows.length,
      unmappedOperationCount: unmappedRows.length,
      privateLeakCount: privateLeaks.length,
      layeredApprovalReady: layeredApprovalEvidence.passed === true,
      pendingApprovalRequirementsReady: pendingApprovalEvidence.passed === true,
      pendingApprovalApproverGuardReady: pendingApproverGuardEvidence.passed === true,
      releaseReady,
      reportLeakScan: true
    },
    byCapability,
    layeredApprovalEvidence,
    pendingApprovalEvidence,
    pendingApproverGuardEvidence,
    operations: rows,
    destructiveChecks: {
      mutatingOperationsMissingGovernanceFailAudit: failingRows.length === 0,
      departmentTeamUserAgentLayeredApprovals: layeredApprovalEvidence.passed === true,
      pendingApprovalRequirementsPersistence: pendingApprovalEvidence.passed === true,
      pendingApprovalApproverGuard: pendingApproverGuardEvidence.passed === true,
      privateCapabilityRootsFailAudit: privateLeaks.length === 0,
      privateLeaks,
      failingOperations: failingRows.map((row) => ({
        operationId: row.operationId,
        findings: row.findings
      })),
      unmappedOperations: unmappedRows.map((row) => row.operationId)
    }
  };
  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!releaseReady) {
    console.error(`[enterprise-governance-coverage] report=${REPORT_PATH}`);
    for (const row of failingRows.slice(0, 20)) {
      console.error(`- ${row.operationId}: ${row.findings.join(",")}`);
    }
    for (const leak of privateLeaks.slice(0, 20)) {
      console.error(`- private_leak: ${leak.value}`);
    }
    process.exit(1);
  }

  console.log(`[enterprise-governance-coverage] report=${REPORT_PATH}`);
  console.log(`[enterprise-governance-coverage] operations=${rows.length} mutating=${mutatingRows.length} releaseReady=true`);
}

await main();
