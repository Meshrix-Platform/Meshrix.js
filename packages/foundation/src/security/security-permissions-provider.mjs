import crypto from "node:crypto";
import { createAuthorizationEngine } from "#meshrix/authorization-engine";
import {
  buildConsoleOperationAuthorizationContext,
  buildConsoleOperationAuthorizationInput
} from "./auth/console-auth.mjs";
import {
  evaluateUniversalTagPolicy,
  hasUniversalTagPolicyRules
} from "./authorization/universal-tag-policy.mjs";
// Tag management store is injected by composition root; no static import from server-runtime.
// If no store is provided, tag operations will throw "Tag management store is unavailable." (fail-closed).

export const SECURITY_PERMISSIONS_PROTOCOL_VERSION = "v0.0.1:risk-control:permissions-1";

function defaultSummary() {
  return {
    enabled: false,
    bootstrap: {},
    session: {
      authenticated: false,
      csrfToken: "",
      expiresAt: "",
      user: null
    },
    roles: [],
    oidc: {}
  };
}

function workspaceAssetPolicyKey(workspaceId, policyId) {
  return `${String(workspaceId || "default").trim() || "default"}:${String(policyId || "").trim()}`;
}

function defaultGovernancePolicyRevision() {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 0,
    updatedAt: ""
  };
}

export function createSecurityPermissionsProvider({
  consoleAuth = null,
  authorizationEngine = null,
  authorizationStore = null,
  authorizationGovernanceStore = null,
  tagManagementStore = null,
  userDataPath = "",
  processIdentity = null
} = {}) {
  const workspaceAssetPolicies = new Map();
  const resolvedAuthorizationStore =
    authorizationStore ||
    consoleAuth?.authorizationStore ||
    null;
  const resolvedAuthorizationGovernanceStore =
    authorizationGovernanceStore ||
    consoleAuth?.authorizationGovernanceStore ||
    null;
  // Tag store is injected by composition root via server-runtime adapter.
  // No default factory is used — missing store = fail-closed.
  const resolvedTagManagementStore =
    tagManagementStore ||
    resolvedAuthorizationGovernanceStore?.tagManagementStore ||
    consoleAuth?.tagManagementStore ||
    null;
  const resolvedAuthorizationEngine =
    authorizationEngine ||
    consoleAuth?.authorizationEngine ||
    (resolvedAuthorizationStore
      ? createAuthorizationEngine({
          store: resolvedAuthorizationStore,
          governanceStore: resolvedAuthorizationGovernanceStore
        })
      : null);

  function tagPolicyFromInput(input = {}) {
    const nestedInput = input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? input.input
      : {};
    const policy =
      input.tagPolicy ||
      input.context?.tagPolicy ||
      nestedInput.tagPolicy ||
      nestedInput.context?.tagPolicy ||
      null;
    return hasUniversalTagPolicyRules(policy || {}) ? policy : null;
  }

  function evaluateTagPolicy(input = {}, authorizationDecision = null) {
    const tagPolicy = tagPolicyFromInput(input);
    if (!tagPolicy) {
      return authorizationDecision;
    }
    const tagDecision = evaluateUniversalTagPolicy({
      tagStore: resolvedTagManagementStore,
      ...tagPolicy
    });
    const effectivePolicySnapshot = {
      ...(authorizationDecision?.effectivePolicySnapshot || {}),
      tagPolicy: {
        protocolVersion: tagDecision.protocolVersion,
        reasonCode: tagDecision.reasonCode,
        allowed: tagDecision.allowed,
        policyRevision: tagDecision.policyRevision,
        inputPolicyRevision: tagDecision.inputPolicyRevision,
        stale: tagDecision.stale,
        entityRefs: tagDecision.entityRefs,
        matchedDenyTags: tagDecision.matchedDenyTags,
        matchedAllowTags: tagDecision.matchedAllowTags,
        missingRequiredTags: tagDecision.missingRequiredTags
      }
    };
    if (!tagDecision.allowed) {
      return {
        ...(authorizationDecision || {}),
        effect: "deny",
        allowed: false,
        reasonCode: tagDecision.reasonCode,
        redactedReason: tagDecision.redactedReason,
        deniedLayer: "tag_policy",
        tagPolicyDecision: tagDecision,
        effectivePolicySnapshot,
        evaluatedLayers: [...new Set([...(authorizationDecision?.evaluatedLayers || []), "tag_policy"])]
      };
    }
    return {
      ...(authorizationDecision || {}),
      tagPolicyDecision: tagDecision,
      effectivePolicySnapshot,
      evaluatedLayers: [...new Set([...(authorizationDecision?.evaluatedLayers || []), "tag_policy"])]
    };
  }

  async function authorizeOperation(input = {}) {
    if (typeof consoleAuth?.authorizeOperation === "function") {
      return consoleAuth.authorizeOperation(input);
    }
    if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
      return {
        ok: false,
        status: 503,
        error: "授权失败：authorization engine 不可用。",
        session: input.authSession || null,
        authorizationDecision: null,
        bootstrap: { authorizationEngineAvailable: false }
      };
    }
    const operationInput =
      input.input && typeof input.input === "object" && !Array.isArray(input.input)
        ? input.input
        : input.operationInput && typeof input.operationInput === "object" && !Array.isArray(input.operationInput)
          ? input.operationInput
          : {};
    const decision = resolvedAuthorizationEngine.evaluate({
      operation: input.operation || {},
      request: input.request || null,
      authSession: input.authSession || null,
      input: buildConsoleOperationAuthorizationInput({
        input: operationInput,
        method: input.method || "",
        url: input.url || null
      }),
      context: buildConsoleOperationAuthorizationContext({
        context: input.context || {},
        transport: input.transport || "security-permissions-provider"
      }),
      enforceConfirmation: false
    });
    return decision.allowed
      ? {
          ok: true,
          session: input.authSession || null,
          authorizationDecision: decision
        }
      : {
          ok: false,
          status: 403,
          error: decision.missingCapabilities?.length
            ? `权限不足：${decision.missingCapabilities.join(", ")}。`
            : decision.missingScopes?.length
            ? `权限不足：${decision.missingScopes.join(", ")}。`
            : `权限不足：${decision.reasonCode || "authorization_denied"}。`,
          session: input.authSession || null,
          authorizationDecision: decision
        };
  }

  async function verifyProcessIdentity(input = {}) {
    if (!processIdentity || typeof processIdentity.verifySignedRequest !== "function") {
      return {
        ok: false,
        status: 503,
        reasonCode: "process_identity_unavailable",
        error: "Process identity verifier is unavailable."
      };
    }
    return processIdentity.verifySignedRequest(input);
  }

  return Object.freeze({
    protocolVersion: SECURITY_PERMISSIONS_PROTOCOL_VERSION,
    authorizationEngine: resolvedAuthorizationEngine,
    authorizationStore: resolvedAuthorizationStore,
    authorizationGovernanceStore: resolvedAuthorizationGovernanceStore,
    tagManagementStore: resolvedTagManagementStore,
    processIdentity,
    authorizeOperation,
    verifyProcessIdentity,
    getConsoleSummary(request = null) {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    getSummary(request = null) {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    login(input = {}, request = null) {
      if (typeof consoleAuth?.login !== "function") {
        throw new Error("Console authentication login provider is unavailable.");
      }
      return consoleAuth.login(input, request);
    },
    logout(request = null) {
      if (typeof consoleAuth?.logout !== "function") {
        return { ok: true, cookies: [] };
      }
      return consoleAuth.logout(request);
    },
    rotateSession(request = null) {
      if (typeof consoleAuth?.rotateSession !== "function") {
        return { ok: false, status: 503, error: "Console session rotation provider is unavailable." };
      }
      return consoleAuth.rotateSession(request);
    },
    audit(entry = {}) {
      return typeof consoleAuth?.audit === "function" ? consoleAuth.audit(entry) : null;
    },
    roleList() {
      return typeof consoleAuth?.roleList === "function" ? consoleAuth.roleList() : [];
    },
    listUsers() {
      return typeof consoleAuth?.listUsers === "function" ? consoleAuth.listUsers() : [];
    },
    updateUser(userId, input = {}) {
      if (typeof consoleAuth?.updateUser !== "function") {
        return null;
      }
      return consoleAuth.updateUser(userId, input);
    },
    getOidcConfig() {
      return typeof consoleAuth?.getOidcConfig === "function" ? consoleAuth.getOidcConfig() : {};
    },
    setOidcConfig(input = {}) {
      if (typeof consoleAuth?.setOidcConfig !== "function") {
        throw new Error("Console OIDC provider is unavailable.");
      }
      return consoleAuth.setOidcConfig(input);
    },
    listAudit(input = {}) {
      return typeof consoleAuth?.listAudit === "function" ? consoleAuth.listAudit(input) : [];
    },
    listSessions() {
      return typeof consoleAuth?.listSessions === "function" ? consoleAuth.listSessions() : [];
    },
    revokeSession(sessionId) {
      if (typeof consoleAuth?.revokeSession !== "function") {
        return { ok: false };
      }
      return consoleAuth.revokeSession(sessionId);
    },
    resolveSubject(input = {}) {
      return resolvedAuthorizationEngine?.resolveSubject
        ? resolvedAuthorizationEngine.resolveSubject(input)
        : null;
    },
    evaluatePolicy(input = {}) {
      if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
        return {
          effect: "deny",
          allowed: false,
          reasonCode: "authorization_engine_unavailable",
          redactedReason: "Authorization engine is unavailable.",
          evaluatedLayers: ["platform_default"],
          missingScopes: [],
          missingToolsets: [],
          createdAt: new Date().toISOString()
        };
      }
      const authorizationDecision = resolvedAuthorizationEngine.evaluate(input);
      return evaluateTagPolicy(input, authorizationDecision);
    },
    getGovernancePolicyRevision() {
      return resolvedAuthorizationGovernanceStore?.getPolicyRevision?.() ||
        resolvedTagManagementStore?.getPolicyRevision?.() ||
        defaultGovernancePolicyRevision();
    },
    getGovernanceSummary() {
      if (!resolvedAuthorizationGovernanceStore) {
        return {
          policyRevision: defaultGovernancePolicyRevision(),
          roles: [],
          departments: [],
          teams: [],
          userPolicies: [],
          agentBindings: [],
          agentGroups: [],
          approvals: []
        };
      }
      return {
        policyRevision: resolvedAuthorizationGovernanceStore.getPolicyRevision?.() || defaultGovernancePolicyRevision(),
        roles: resolvedAuthorizationGovernanceStore.listRoles?.() || [],
        departments: resolvedAuthorizationGovernanceStore.listDepartments?.() || [],
        teams: resolvedAuthorizationGovernanceStore.listTeams?.() || [],
        userPolicies: resolvedAuthorizationGovernanceStore.listUserPolicies?.() || [],
        agentBindings: resolvedAuthorizationGovernanceStore.listAgentBindings?.() || [],
        agentGroups: resolvedAuthorizationGovernanceStore.listAgentGroups?.() || [],
        approvals: resolvedAuthorizationGovernanceStore.listApprovals?.({ includeRevoked: true }) || []
      };
    },
    listGovernanceRoles(input = {}) {
      return resolvedAuthorizationGovernanceStore?.listRoles?.(input) || [];
    },
    upsertGovernanceRole(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertRole) {
        throw new Error("Authorization governance role store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertRole(input);
    },
    listGovernanceDepartments(input = {}) {
      return resolvedAuthorizationGovernanceStore?.listDepartments?.(input) || [];
    },
    upsertGovernanceDepartment(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertDepartment) {
        throw new Error("Authorization governance department store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertDepartment(input);
    },
    listGovernanceTeams(input = {}) {
      return resolvedAuthorizationGovernanceStore?.listTeams?.(input) || [];
    },
    upsertGovernanceTeam(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertTeam) {
        throw new Error("Authorization governance team store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertTeam(input);
    },
    listGovernanceUserPolicies() {
      return resolvedAuthorizationGovernanceStore?.listUserPolicies?.() || [];
    },
    upsertGovernanceUserPolicy(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertUserPolicy) {
        throw new Error("Authorization governance user policy store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertUserPolicy(input);
    },
    listGovernanceAgentGroups(input = {}) {
      return resolvedAuthorizationGovernanceStore?.listAgentGroups?.(input) || [];
    },
    upsertGovernanceAgentGroup(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentGroup) {
        throw new Error("Authorization governance agent group store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentGroup(input);
    },
    listGovernanceAgentBindings() {
      return resolvedAuthorizationGovernanceStore?.listAgentBindings?.() || [];
    },
    upsertGovernanceAgentBinding(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentBinding) {
        throw new Error("Authorization governance agent binding store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentBinding(input);
    },
    listTags(input = {}) {
      return resolvedTagManagementStore?.listTags?.(input) || [];
    },
    getTag(tagId) {
      return resolvedTagManagementStore?.getTag?.(tagId) || null;
    },
    upsertTag(input = {}) {
      if (!resolvedTagManagementStore?.upsertTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.upsertTag(input);
    },
    archiveTag(tagId, input = {}) {
      if (!resolvedTagManagementStore?.archiveTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.archiveTag(tagId, input);
    },
    restoreTag(tagId) {
      if (!resolvedTagManagementStore?.restoreTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.restoreTag(tagId);
    },
    listTagProjections(input = {}) {
      return resolvedTagManagementStore?.listProjections?.(input) || [];
    },
    rebuildTagProjections() {
      if (!resolvedTagManagementStore?.rebuildProjections) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.rebuildProjections();
    },
    listTagEvents(input = {}) {
      return resolvedTagManagementStore?.listEvents?.(input) || [];
    },
    listToolProfileTags(input = {}) {
      return resolvedTagManagementStore?.listToolProfiles?.(input) || [];
    },
    seedToolProfileTags(profiles = []) {
      return resolvedTagManagementStore?.seedToolProfiles?.(profiles) || { created: 0 };
    },
    listGovernanceApprovals(input = {}) {
      return resolvedAuthorizationGovernanceStore?.listApprovals?.(input) || [];
    },
    upsertGovernanceApproval(input = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertApproval(input);
    },
    revokeGovernanceApproval(approvalId, reason = "") {
      if (!resolvedAuthorizationGovernanceStore?.revokeApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.revokeApproval(approvalId, reason);
    },
    listReceipts(input = {}) {
      return resolvedAuthorizationStore?.listReceipts
        ? resolvedAuthorizationStore.listReceipts(input)
        : [];
    },
    listLoanRecords(input = {}) {
      return resolvedAuthorizationStore?.listLoanRecords
        ? resolvedAuthorizationStore.listLoanRecords(input)
        : [];
    },
    listDeniedRequests(input = {}) {
      return resolvedAuthorizationStore?.listDeniedRequests
        ? resolvedAuthorizationStore.listDeniedRequests(input)
        : [];
    },
    listDecisions(input = {}) {
      return resolvedAuthorizationStore?.listDecisions
        ? resolvedAuthorizationStore.listDecisions(input)
        : [];
    },
    appendReceipt(receipt, metadata = {}) {
      if (!receipt || typeof resolvedAuthorizationStore?.appendReceipt !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendReceipt(receipt, metadata);
    },
    appendLoanRecord(record, metadata = {}) {
      if (!record || typeof resolvedAuthorizationStore?.appendLoanRecord !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendLoanRecord(record, metadata);
    },
    appendDeniedRequest(request = {}) {
      if (!request || typeof resolvedAuthorizationStore?.appendDeniedRequest !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDeniedRequest(request);
    },
    appendDecision(decision = {}) {
      if (!decision || typeof resolvedAuthorizationStore?.appendDecision !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDecision(decision);
    },
    setWorkspaceAssetPolicy(input = {}) {
      const workspaceId = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId = String(input.policyId || input["policy-id"] || "").trim() || `workspace_asset_policy_${crypto.randomUUID()}`;
      const policy = {
        ...input,
        policyId,
        workspaceId,
        updatedAt: new Date().toISOString()
      };
      workspaceAssetPolicies.set(workspaceAssetPolicyKey(workspaceId, policyId), policy);
      return policy;
    },
    getWorkspaceAssetPolicy(input = {}) {
      const workspaceId = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId = String(input.policyId || input["policy-id"] || input.id || "").trim();
      if (!policyId) {
        return null;
      }
      return workspaceAssetPolicies.get(workspaceAssetPolicyKey(workspaceId, policyId)) || null;
    },
    checkWorkspaceAssetPermission(input = {}) {
      if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
        return null;
      }
      return resolvedAuthorizationEngine.evaluate({
        operation: {
          id: "workspace.asset.permission.check",
          requiredScopes: ["workspace:read"],
          safety: { risk: "read_only" },
          readOnly: true
        },
        request: input.request || null,
        authSession: input.authSession || null,
        input,
        context: {
          requestedAction: input.requestedAction || input.action || "read",
          requestedEgress: input.requestedEgress || ""
        }
      });
    }
  });
}
