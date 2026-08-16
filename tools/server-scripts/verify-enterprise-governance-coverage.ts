#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.ts";
import { operationFeatureId } from "../../packages/contracts/src/operations/operation-feature-resolution.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { createPendingOperationRuntime } from "../../packages/capabilities/src/operation-permission-core/runtime-pending.ts";
import { createOperationPermissionStore } from "../../packages/capabilities/src/operation-permission-core/store.ts";
import { createAuthorizationGovernanceStore } from "../../packages/foundation/src/security/authorization/authorization-governance-store.ts";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/enterprise-governance-coverage.json";
const MATRIX_PATH: any = "tools/registry/internal-platform-capability-matrix.json";
const CANONICAL_VERIFIER: any = "tools/server-scripts/verify-authorization-governance.ts";

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u]
]);

const BOOTSTRAP_OR_PAIRING_OPERATION_PATTERNS: readonly any[] = Object.freeze([
  /^auth\.login$/u,
  /^auth\.logout$/u,
  /^process_identity\.bootstrap_/u,
  /^discovery\./u
]);

const PRIVATE_ROOT_PATTERNS: readonly any[] = Object.freeze([
  /\bapps\/private\b/iu,
  /\bpackages\/private\b/iu,
  /\bprivate-product\b/iu,
  /\bproprietary-runtime\b/iu,
  /\bmeshrix-private\b/iu
]);

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
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

function isReadOnly(operation: Record<string, any> = {}, tool: any = null) : any {
  return operation.readOnly === true ||
    riskOf(operation, tool) === "read_only" ||
    methodOf(operation) === "GET";
}

function isMutating(operation: Record<string, any> = {}, tool: any = null) : any {
  return !isReadOnly(operation, tool);
}

function isBootstrapOrPairingBoundary(operationId: any = "") : any {
  return BOOTSTRAP_OR_PAIRING_OPERATION_PATTERNS.some((pattern?: any) : any => pattern.test(operationId));
}

function operationMatchesPrefix(operationId: any = "", prefixes: any = []) : any {
  return prefixes.some((prefix?: any) : any => operationId.startsWith(prefix));
}

function capabilityForOperation(operation: Record<string, any> = {}, matrix: Record<string, any> = {}) : any {
  const operationId: any = String(operation.id || "");
  const capability: any = (matrix.capabilities || []).find((entry?: any) : any =>
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
  const feature: any = String(operation.feature || "");
  const platformSupportFeatures: any = new Set<any>([
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

function approvalCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  const risk: any = riskOf(operation, tool);
  const safety: any = operation.safety && typeof operation.safety === "object" ? operation.safety : {};
  const requiresConfirmation: any = safety.requiresConfirmation === true ||
    safety.requiresConfirmationExplicit === true ||
    risk === "destructive";
  const approvalScope: any = String(safety.approvalScope || "");
  const highRisk: any = ["repair_write", "destructive"].includes(risk);
  return {
    risk,
    requiresConfirmation,
    approvalScope,
    policyPresent: Boolean(operation.safety || tool?.risk),
    highRiskApprovalGatePresent: highRisk ? Boolean(requiresConfirmation || approvalScope) : true
  };
}

function auditCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  const explicitAudit: any = operation.audit && typeof operation.audit === "object" ? operation.audit : null;
  const explicitLog: any = operation.log && typeof operation.log === "object" ? operation.log : null;
  return {
    policy: tool ? "operation_permission_tool_audit" : explicitAudit ? "operation_registry_audit" : explicitLog ? "operation_registry_log" : "",
    recordInput: explicitAudit?.recordInput ?? explicitLog?.recordInput ?? false,
    metadataOnly: explicitAudit?.metadataOnly === true || tool !== null,
    present: Boolean(tool || explicitAudit || explicitLog)
  };
}

function metricsCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  return {
    policy: tool ? "operation_permission_tool_metrics" : operation.http?.path ? "http_request_metrics" : operation.rpc?.method ? "rpc_request_metrics" : "",
    present: Boolean(tool || operation.http?.path || operation.rpc?.method)
  };
}

function traceCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  return {
    policy: tool ? "operation_permission_trace_id" : operation.http?.path ? "http_request_trace" : operation.rpc?.method ? "rpc_request_trace" : "",
    present: Boolean(tool || operation.http?.path || operation.rpc?.method)
  };
}

function redactionCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  const explicitAudit: any = operation.audit && typeof operation.audit === "object" ? operation.audit : null;
  const explicitLog: any = operation.log && typeof operation.log === "object" ? operation.log : null;
  const redaction: any = String(explicitLog?.redaction || "");
  return {
    policy: tool ? "operation_permission_public_redaction" : redaction || (explicitAudit || explicitLog ? "operation_registry_redaction" : ""),
    recordInputDisabled: explicitAudit?.recordInput === false || explicitLog?.recordInput === false || tool !== null,
    present: Boolean(tool || explicitAudit || explicitLog)
  };
}

function trafficCoverage(operation: Record<string, any> = {}) : any {
  const hasTrafficInput: any = Boolean(operation.inputSchema?.properties?.trafficPolicy);
  const gatewayOperation: any = String(operation.id || "").startsWith("gateway.") ||
    String(operation.id || "").startsWith("external_services.");
  return {
    present: hasTrafficInput || gatewayOperation,
    policy: hasTrafficInput ? "operation_input_traffic_policy" : gatewayOperation ? "gateway_runtime_traffic_controls" : ""
  };
}

function authorizationCoverage(operation: Record<string, any> = {}, tool: any = null) : any {
  const requiredScopes: any = uniqueStrings([
    ...(operation.requiredScopes || []),
    ...(tool?.requiredScopes || [])
  ]);
  const toolsets: any = uniqueStrings(tool?.toolsets || []);
  const bootstrapBoundary: any = isBootstrapOrPairingBoundary(operation.id);
  const externalAuthVerifier: any = operation.externalAuthVerifier && typeof operation.externalAuthVerifier === "object";
  const subjectResolution: any =
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

function operationFindings(row: Record<string, any> = {}) : any {
  const findings: any[] = [];
  const mutating: any = row.readOnly === false;
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

function privateLeakFindings(values: any = []) : any {
  const findings: any[] = [];
  for (const value of values) {
    const text: any = String(value || "");
    const matched: any = PRIVATE_ROOT_PATTERNS.find((pattern?: any) : any => pattern.test(text));
    if (matched) {
      findings.push({
        value: text,
        pattern: String(matched)
      });
    }
  }
  return findings;
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Enterprise governance coverage report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function verifyLayeredApprovalModel() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-governance-layers-"));
  const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
  const governance: any = createAuthorizationGovernanceStore({
    userDataPath,
    builtinRoles: {},
    tagManagementStore
  });
  const operation: Record<string, any> = {
    id: "gateway.forward",
    safety: { risk: "repair_write" },
    requiredScopes: ["gateway:write"]
  };
  const input: Record<string, any> = {
    resourceType: "repo",
    resourceId: "owner/repo",
    requestedAction: "repo:write",
    targetProvider: "github",
    agentId: "agent-codex",
    boundUserId: "console-user-1"
  };
  const subject: Record<string, any> = {
    type: "console-user",
    subjectId: "console-user-1",
    teamIds: ["team-code"],
    departmentIds: ["department-platform"]
  };
  const baseApproval: Record<string, any> = {
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

    const decisions: any[] = [];
    const evaluate: any = () : any => {
      const decision: any = governance.evaluateGovernance({ operation, input, subject, governanceRequired: true });
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

    const expected: any[] = [
      ["needsApproval", "department_approval_required", "department"],
      ["needsApproval", "team_approval_required", "team"],
      ["needsApproval", "user_approval_required", "user"],
      ["needsApproval", "agent_approval_required", "agent"],
      ["allow", "governance_allowed", ""]
    ];
    const passed: any = expected.every(([effect, reasonCode, layer]: any[], index?: any) : any => {
      const decision: any = decisions[index] || {};
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

async function verifyPendingApprovalRequirementsPersistence() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pending-approval-"));
  const store: any = createOperationPermissionStore({
    userDataPath,
    capabilityKeyProvider: { close() : any {} },
    capabilityBindingGuard: false
  });
  const requiredApproval: Record<string, any> = {
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
    const pending: any = await store.createPendingOperation({
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
    const projectionOnly: any = await store.createPendingOperation({
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
    const listedRows: any = await store.listPendingOperations({ status: "pending", limit: 5 });
    const listed: any = (Array.isArray(listedRows) ? listedRows : [])
      .find((item?: any) : any => item.pendingOperationId === pending.pendingOperationId);
    const loaded: any = await store.getPendingOperation(pending.pendingOperationId, { includeOriginalInput: true });
    const loadedProjectionOnly: any = await store.getPendingOperation(projectionOnly.pendingOperationId, { includeOriginalInput: true });
    const expectedLayers: any[] = ["department", "team"];
    const layerString: any = (value: any = []) : any => JSON.stringify(value);
    const passed: any = layerString(pending.approvalLayers) === layerString(expectedLayers) &&
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
    await store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function verifyPendingApprovalApproverGuard() : Promise<any> {
  const requiredApproval: Record<string, any> = {
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
  const pending: Record<string, any> = {
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
  const resolveCalls: any[] = [];
  let getRawGrantCount: any = 0;
  let approvalWriteCount: any = 0;
  let executeCount: any = 0;
  let grantAvailable: any = true;
  const runtime: any = createPendingOperationRuntime({
    store: {
      getPendingOperation() : any {
        return pending;
      },
      resolvePendingOperation(entry: Record<string, any> = {}) : any {
        resolveCalls.push(entry);
        return { ...pending, status: entry.resolution || pending.status };
      },
      getRawGrant() : any {
        getRawGrantCount += 1;
        return grantAvailable ? { id: pending.grantId, enabled: true } : null;
      },
      appendMetric() : any {}
    },
    async executeTool() : Promise<any> {
      executeCount += 1;
      return {
        ok: true,
        status: 200,
        payload: { schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } }
      };
    },
    async publishEvent() : Promise<any> {},
    securityPermissions: {
      async upsertGovernanceApproval() : Promise<any> {
        approvalWriteCount += 1;
      }
    }
  });

  const unauthorized: any = await runtime({
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
  const unauthorizedGuardPassed: any = unauthorized.status === 403 &&
    unauthorized.payload?.error?.code === "pending_approval_approver_not_authorized" &&
    approvalWriteCount === 0 &&
    resolveCalls.length === 0 &&
    getRawGrantCount === 0 &&
    executeCount === 0;

  grantAvailable = false;
  const unavailableGrant: any = await runtime({
    pendingOperationId: pending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "department-approver",
    approver: {
      userId: "console-user-1",
      departmentIds: ["department-platform"]
    },
    reason: "eligible but grant unavailable"
  });
  const resolutionNames: any = resolveCalls.map((entry?: any) : any => entry.resolution);
  const unavailableGrantGuardPassed: any = unavailableGrant.status === 409 &&
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

async function main() : Promise<any> {
  const layeredApprovalEvidence: any = await verifyLayeredApprovalModel();
  const pendingApprovalEvidence: any = await verifyPendingApprovalRequirementsPersistence();
  const pendingApproverGuardEvidence: any = await verifyPendingApprovalApproverGuard();
  const matrix: any = await readJson(MATRIX_PATH);
  const completeOperations: any = SERVER_API_OPERATIONS;
  const catalog: any = createToolCatalog({ operations: completeOperations });
  const toolsByOperationId: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.operationId, tool]));
  const protocolIds: any = new Set<any>(PROTOCOL_OPERATION_DEFINITIONS.map((operation?: any) : any => operation.id));

  const rows: any = completeOperations.map((operation?: any) : any => {
    const tool: any = toolsByOperationId.get(operation.id) || null;
    const capability: any = capabilityForOperation(operation, matrix);
    const authorization: any = authorizationCoverage(operation, tool);
    const approval: any = approvalCoverage(operation, tool);
    const audit: any = auditCoverage(operation, tool);
    const metrics: any = metricsCoverage(operation, tool);
    const trace: any = traceCoverage(operation, tool);
    const redaction: any = redactionCoverage(operation, tool);
    const traffic: any = trafficCoverage(operation);
    const row: Record<string, any> = {
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

  const mutatingRows: any = rows.filter((row?: any) : any => row.readOnly === false);
  const failingRows: any = rows.filter((row?: any) : any =>
    row.findings.some((finding?: any) : any => finding !== "operation_not_mapped_to_enterprise_or_platform_support_capability")
  );
  const unmappedRows: any = rows.filter((row?: any) : any => row.findings.includes("operation_not_mapped_to_enterprise_or_platform_support_capability"));
  const privateLeaks: any = privateLeakFindings([
    ...rows.flatMap((row?: any) : any => [
      row.operationId,
      row.feature,
      row.featureId,
      row.transport.http?.path,
      row.transport.rpc
    ]),
    ...((matrix.capabilities || []).flatMap((capability?: any) : any => [
      capability.id,
      capability.title,
      capability.plan,
      ...(capability.docs || []),
      ...(capability.requiredRuntimePrefixes || [])
    ]))
  ]);

  const byCapability: any = Object.fromEntries(
    [...new Set<any>(rows.map((row?: any) : any => row.capability.capabilityId))].sort().map((capabilityId?: any) : any => {
      const scopedRows: any = rows.filter((row?: any) : any => row.capability.capabilityId === capabilityId);
      return [
        capabilityId,
        {
          operationCount: scopedRows.length,
          mutatingOperationCount: scopedRows.filter((row?: any) : any => row.readOnly === false).length,
          findingCount: scopedRows.reduce((sum?: any, row?: any) : any => sum + row.findings.length, 0)
        }
      ];
    })
  );

  const releaseReady: any = failingRows.length === 0 &&
    unmappedRows.length === 0 &&
    privateLeaks.length === 0 &&
    layeredApprovalEvidence.passed === true &&
    pendingApprovalEvidence.passed === true &&
    pendingApproverGuardEvidence.passed === true;
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:authorization:enterprise-governance-coverage-report-1",
    generatedAt: new Date().toISOString(),
    verifier: CANONICAL_VERIFIER,
    implementationVerifier: "tools/server-scripts/verify-enterprise-governance-coverage.ts",
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.ts",
      protocolDefinitions: "packages/contracts/src/operations/protocol-operation-definitions.ts",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.ts",
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
      catalogOperationCount: rows.filter((row?: any) : any => row.operationPermissionCatalog).length,
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
      failingOperations: failingRows.map((row?: any) : any => ({
        operationId: row.operationId,
        findings: row.findings
      })),
      unmappedOperations: unmappedRows.map((row?: any) : any => row.operationId)
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
