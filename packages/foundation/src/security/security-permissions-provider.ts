import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createAuthorizationEngine } from "#meshrix/authorization-engine";
import {
  buildConsoleOperationAuthorizationContext,
  buildConsoleOperationAuthorizationInput
} from "./auth/console-auth.ts";
import {
  evaluateUniversalTagPolicy,
  hasUniversalTagPolicyRules
} from "./authorization/universal-tag-policy.ts";
// Tag management store is injected by composition root; no static import from server-runtime.
// If no store is provided, tag operations will throw "Tag management store is unavailable." (fail-closed).

export const SECURITY_PERMISSIONS_PROTOCOL_VERSION: any = "v0.0.1:risk-control:permissions-1";

const PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS: readonly any[] = Object.freeze([
  "generation",
  "subjectId",
  "tenantId",
  "type"
]);
const PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS: readonly any[] = Object.freeze([
  "approvalRevision",
  "grantRevision",
  "policyRevision",
  "riskRevision",
  "workloadGeneration"
]);
const PROTECTED_SINK_AUTHORITY_PHASES: any = new Set<any>([
  "admission",
  "execution",
  "final-protected-sink"
]);

function securityDigest(value?: any) : any {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function hasExactKeys(value?: any, keys?: any) : any {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function hasExactProtectedSinkAuthority(value?: any) : any {
  return (
    hasExactKeys(value, ["context", "subject"]) &&
    hasExactKeys(value.subject, PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS) &&
    hasExactKeys(value.context, PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS) &&
    [...PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS].every(
      (key?: any) : any => typeof value.subject[key] === "string" && value.subject[key].trim()
    ) &&
    [...PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS].every(
      (key?: any) : any => typeof value.context[key] === "string" && value.context[key].trim()
    )
  );
}

function requiresProtectedSinkAuthority(input: Record<string, any> = {}) : any {
  const operationId: any = String(input.operation?.id || "").trim();
  const phase: any = String(
    input.phase || input.context?.authorizationPhase || ""
  ).trim();
  return (
    PROTECTED_SINK_AUTHORITY_PHASES.has(phase) &&
    (
      operationId === "gateway.forward" ||
      operationId === "jobs.upload_workspace_materialize" ||
      operationId.startsWith("upstream_operation.")
    )
  );
}

function defaultSummary() : any {
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

function workspaceAssetPolicyKey(workspaceId?: any, policyId?: any) : any {
  return `${String(workspaceId || "default").trim() || "default"}:${String(policyId || "").trim()}`;
}

function defaultGovernancePolicyRevision() : any {
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
  organizationGovernanceService = null,
  tagManagementStore = null,
  userDataPath = "",
  processIdentity = null
}: Record<string, any> = {}) : any {
  const workspaceAssetPolicies: any = new Map<any, any>();
  const resolvedAuthorizationStore: any =
    authorizationStore ||
    consoleAuth?.authorizationStore ||
    null;
  const resolvedAuthorizationGovernanceStore: any =
    authorizationGovernanceStore ||
    consoleAuth?.authorizationGovernanceStore ||
    null;
  const resolvedOrganizationGovernanceService: any = organizationGovernanceService || null;
  // Tag store is injected by composition root via server-runtime adapter.
  // No default factory is used — missing store = fail-closed.
  const resolvedTagManagementStore: any =
    tagManagementStore ||
    resolvedAuthorizationGovernanceStore?.tagManagementStore ||
    consoleAuth?.tagManagementStore ||
    null;
  const resolvedAuthorizationEngine: any =
    authorizationEngine ||
    consoleAuth?.authorizationEngine ||
    (resolvedAuthorizationStore
      ? createAuthorizationEngine({
          store: resolvedAuthorizationStore,
          governanceStore: resolvedAuthorizationGovernanceStore
        })
      : null);
  const custodyAuthorizationReceipts: any = new WeakMap<object, any>();
  const hasDeferredConsoleAuthority: any =
    typeof consoleAuth?.captureDeferredProtectedSinkAuthority === "function" &&
    typeof consoleAuth?.revalidateDeferredProtectedSinkAuthority === "function" &&
    typeof consoleAuth?.revokeDeferredProtectedSinkAuthority === "function";

  function denyDeferredAuthority(
    reasonCode: any = "deferred_protected_sink_authority_unavailable"
  ) : any {
    return Object.freeze({
      allowed: false,
      reasonCode,
      revoked: false
    });
  }

  function closedResourceBinding(value?: any) : any {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    try {
      const normalized: any = JSON.parse(JSON.stringify(value));
      return Object.freeze(normalized);
    } catch {
      return null;
    }
  }

  async function revalidateDeferred(input: Record<string, any> = {}) : Promise<any> {
    if (!hasDeferredConsoleAuthority) {
      return denyDeferredAuthority();
    }
    const current: any =
      await consoleAuth.revalidateDeferredProtectedSinkAuthority(input);
    if (current?.allowed !== true || current?.revoked === true) {
      return Object.freeze({
        allowed: false,
        reasonCode:
          current?.reasonCode ||
          "deferred_protected_sink_authority_denied",
        revoked: current?.revoked === true
      });
    }
    const requestedResourceBinding: any =
      closedResourceBinding(input.resourceBinding);
    if (!requestedResourceBinding) {
      return Object.freeze({ ...current });
    }
    const resourceBinding: any = closedResourceBinding({
      ...requestedResourceBinding,
      ownerBindingDigest: securityDigest({
        subjectId: current.subject.subjectId,
        tenantId: current.subject.tenantId,
        userId: current.subject.subjectId
      })
    });
    if (!resourceBinding) {
      return denyDeferredAuthority(
        "deferred_protected_sink_authority_denied"
      );
    }
    const resourceBindingDigest: any = securityDigest(resourceBinding);
    const decisionRef: any = securityDigest({
      authorityBindingDigest: current.authorityBindingDigest,
      authorityRef: input.authorityRef,
      context: current.context,
      requestDigest: input.requestDigest,
      resourceBindingDigest
    });
    const custodyAuthorizationReceipt: Readonly<Record<string, any>> = Object.freeze({
      decisionRef,
      grantRevision: current.context.grantRevision,
      policyRevision: current.context.policyRevision,
      resourceBindingDigest
    });
    custodyAuthorizationReceipts.set(
      custodyAuthorizationReceipt,
      Object.freeze({
        authorityBindingDigest: input.authorityBindingDigest,
        authorityRef: input.authorityRef,
        input: Object.freeze({ ...(input.input || {}) }),
        operation: input.operation,
        requestDigest: input.requestDigest,
        resourceBinding,
        resourceBindingDigest
      })
    );
    return Object.freeze({
      ...current,
      custodyAuthorizationReceipt
    });
  }

  const deferredProtectedSinkAuthorityPort: Readonly<Record<string, any>> = Object.freeze({
    async capture(input: Record<string, any> = {}) : Promise<any> {
      if (!hasDeferredConsoleAuthority) {
        throw Object.assign(
          new Error("Durable protected sink authority source is unavailable."),
          {
            code: "deferred_protected_sink_authority_unavailable",
            statusCode: 503
          }
        );
      }
      return consoleAuth.captureDeferredProtectedSinkAuthority(input);
    },
    revalidate: revalidateDeferred,
    async revoke(input: Record<string, any> = {}) : Promise<any> {
      if (!hasDeferredConsoleAuthority) {
        return Object.freeze({ revoked: false });
      }
      return consoleAuth.revokeDeferredProtectedSinkAuthority(input);
    },
    async reauthorizeCustodyRead(input: Record<string, any> = {}) : Promise<any> {
      const receipt: any = input.authorizationReceipt;
      if (
        !receipt ||
        (typeof receipt !== "object" && typeof receipt !== "function")
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const state: any = custodyAuthorizationReceipts.get(receipt);
      custodyAuthorizationReceipts.delete(receipt);
      if (!state) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const descriptor: any = state.resourceBinding?.descriptor;
      const observedResourceBinding: any = closedResourceBinding({
        descriptor: {
          byteCount: Number(input.byteCount),
          contentDigest: String(input.contentDigest || ""),
          custodyRef: String(input.custodyRef || ""),
          envelopeDigest: String(input.envelopeDigest || ""),
          resourceRef: String(input.resourceRef || ""),
          state: "sealed_no_run"
        },
        expectedWorkspaceRevision:
          state.resourceBinding.expectedWorkspaceRevision,
        logicalTarget: state.resourceBinding.logicalTarget,
        ownerBindingDigest: String(
          input.ownerBindingDigest || ""
        ),
        targetStateDigest: state.resourceBinding.targetStateDigest,
        workspaceId: state.resourceBinding.workspaceId
      });
      if (
        input.audience !== "upload-custody-read" ||
        !descriptor ||
        !observedResourceBinding ||
        securityDigest(observedResourceBinding) !==
          state.resourceBindingDigest ||
        receipt.resourceBindingDigest !== state.resourceBindingDigest
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const current: any = await revalidateDeferred({
        authorityBindingDigest: state.authorityBindingDigest,
        authorityRef: state.authorityRef,
        input: state.input,
        operation: state.operation,
        requestDigest: state.requestDigest
      });
      if (
        current?.allowed !== true ||
        current.context?.policyRevision !== receipt.policyRevision ||
        current.context?.grantRevision !== receipt.grantRevision
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      return Object.freeze({
        allowed: true,
        currentGrantRevision: current.context.grantRevision,
        currentPolicyRevision: current.context.policyRevision,
        decisionRef: receipt.decisionRef,
        evidenceRef: `authority-evidence:${securityDigest({
          decisionRef: receipt.decisionRef,
          resourceBindingDigest: state.resourceBindingDigest
        })}`,
        revoked: false
      });
    }
  });

  function tagPolicyFromInput(input: Record<string, any> = {}) : any {
    const nestedInput: any = input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? input.input
      : {};
    const policy: any =
      input.tagPolicy ||
      input.context?.tagPolicy ||
      nestedInput.tagPolicy ||
      nestedInput.context?.tagPolicy ||
      null;
    return hasUniversalTagPolicyRules(policy || {}) ? policy : null;
  }

  function evaluateTagPolicy(input: Record<string, any> = {}, authorizationDecision: any = null) : any {
    const tagPolicy: any = tagPolicyFromInput(input);
    if (!tagPolicy) {
      return authorizationDecision;
    }
    const tagDecision: any = evaluateUniversalTagPolicy({
      tagStore: resolvedTagManagementStore,
      ...tagPolicy
    });
    const effectivePolicySnapshot: Record<string, any> = {
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
        evaluatedLayers: [...new Set<any>([...(authorizationDecision?.evaluatedLayers || []), "tag_policy"])]
      };
    }
    return {
      ...(authorizationDecision || {}),
      tagPolicyDecision: tagDecision,
      effectivePolicySnapshot,
      evaluatedLayers: [...new Set<any>([...(authorizationDecision?.evaluatedLayers || []), "tag_policy"])]
    };
  }

  async function authorizeOperation(input: Record<string, any> = {}) : Promise<any> {
    if (typeof consoleAuth?.authorizeOperation === "function") {
      const authorization: any = await consoleAuth.authorizeOperation(input);
      if (
        authorization?.ok === true &&
        requiresProtectedSinkAuthority(input) &&
        !hasExactProtectedSinkAuthority(
          authorization.protectedSinkAuthority
        )
      ) {
        return {
          ok: false,
          status: 403,
          reasonCode: "final_protected_sink_authority_unavailable",
          error: "Current protected sink authority facts are unavailable.",
          session: authorization.session || null,
          authorizationDecision:
            authorization.authorizationDecision || null
        };
      }
      return authorization;
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
    const operationInput: any =
      input.input && typeof input.input === "object" && !Array.isArray(input.input)
        ? input.input
        : input.operationInput && typeof input.operationInput === "object" && !Array.isArray(input.operationInput)
          ? input.operationInput
          : {};
    const decision: any = resolvedAuthorizationEngine.evaluate({
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
      ? requiresProtectedSinkAuthority(input)
        ? {
            ok: false,
            status: 503,
            reasonCode: "protected_sink_authority_source_unavailable",
            error: "Durable protected sink authority source is unavailable.",
            session: input.authSession || null,
            authorizationDecision: decision
          }
        : {
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

  async function verifyProcessIdentity(input: Record<string, any> = {}) : Promise<any> {
    if (!processIdentity || typeof processIdentity.verifySignedRequest !== "function") {
      return {
        ok: false,
        status: 503,
        reasonCode: "process_identity_unavailable",
        error: "Process identity verifier is unavailable."
      };
    }
    const verification: any = await processIdentity.verifySignedRequest(input);
    if (
      verification?.ok !== true ||
      typeof processIdentity.revalidateVerifiedRequest !== "function"
    ) {
      return verification;
    }
    return {
      ...verification,
      revalidateAuthorization: () : any => processIdentity.revalidateVerifiedRequest({
        verification,
        operation: input.operation || {}
      })
    };
  }

  return Object.freeze({
    protocolVersion: SECURITY_PERMISSIONS_PROTOCOL_VERSION,
    deferredProtectedSinkAuthorityPort,
    authorizationEngine: resolvedAuthorizationEngine,
    authorizationStore: resolvedAuthorizationStore,
    authorizationGovernanceStore: resolvedAuthorizationGovernanceStore,
    tagManagementStore: resolvedTagManagementStore,
    processIdentity,
    authorizeOperation,
    verifyProcessIdentity,
    getConsoleSummary(request: any = null) : any {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    getSummary(request: any = null) : any {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    login(input: Record<string, any> = {}, request: any = null) : any {
      if (typeof consoleAuth?.login !== "function") {
        throw new Error("Console authentication login provider is unavailable.");
      }
      return consoleAuth.login(input, request);
    },
    logout(request: any = null) : any {
      if (typeof consoleAuth?.logout !== "function") {
        return { ok: true, cookies: [] };
      }
      return consoleAuth.logout(request);
    },
    rotateSession(request: any = null) : any {
      if (typeof consoleAuth?.rotateSession !== "function") {
        return { ok: false, status: 503, error: "Console session rotation provider is unavailable." };
      }
      return consoleAuth.rotateSession(request);
    },
    audit(entry: Record<string, any> = {}) : any {
      return typeof consoleAuth?.audit === "function" ? consoleAuth.audit(entry) : null;
    },
    roleList() : any {
      return typeof consoleAuth?.roleList === "function" ? consoleAuth.roleList() : [];
    },
    listUsers() : any {
      return typeof consoleAuth?.listUsers === "function" ? consoleAuth.listUsers() : [];
    },
    updateUser(userId?: any, input: Record<string, any> = {}) : any {
      if (typeof consoleAuth?.updateUser !== "function") {
        return null;
      }
      return consoleAuth.updateUser(userId, input);
    },
    getOidcConfig() : any {
      return typeof consoleAuth?.getOidcConfig === "function" ? consoleAuth.getOidcConfig() : {};
    },
    setOidcConfig(input: Record<string, any> = {}) : any {
      if (typeof consoleAuth?.setOidcConfig !== "function") {
        throw new Error("Console OIDC provider is unavailable.");
      }
      return consoleAuth.setOidcConfig(input);
    },
    listAudit(input: Record<string, any> = {}) : any {
      return typeof consoleAuth?.listAudit === "function" ? consoleAuth.listAudit(input) : [];
    },
    listSessions() : any {
      return typeof consoleAuth?.listSessions === "function" ? consoleAuth.listSessions() : [];
    },
    revokeSession(sessionId?: any) : any {
      if (typeof consoleAuth?.revokeSession !== "function") {
        return { ok: false };
      }
      return consoleAuth.revokeSession(sessionId);
    },
    resolveSubject(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationEngine?.resolveSubject
        ? resolvedAuthorizationEngine.resolveSubject(input)
        : null;
    },
    evaluatePolicy(input: Record<string, any> = {}) : any {
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
      const authorizationDecision: any = resolvedAuthorizationEngine.evaluate(input);
      return evaluateTagPolicy(input, authorizationDecision);
    },
    getGovernancePolicyRevision() : any {
      return resolvedAuthorizationGovernanceStore?.getPolicyRevision?.() ||
        resolvedTagManagementStore?.getPolicyRevision?.() ||
        defaultGovernancePolicyRevision();
    },
    getGovernanceSummary() : any {
      if (!resolvedAuthorizationGovernanceStore) {
        return {
          policyRevision: defaultGovernancePolicyRevision(),
          roles: [],
          departments: [],
          teams: [],
          userPolicies: [],
          agentBindings: [],
          agentGroups: [],
          approvals: [],
          apiKeyRecoveryAssignments: []
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
        approvals: resolvedAuthorizationGovernanceStore.listApprovals?.({ includeRevoked: true }) || [],
        apiKeyRecoveryAssignments: resolvedAuthorizationGovernanceStore.listApiKeyRecoveryAssignments?.() || []
      };
    },
    getOrganizationGovernance() : any {
      if (!resolvedOrganizationGovernanceService?.getOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.getOrganizationGovernance();
    },
    listOrganizationGovernanceTemplates() : any {
      if (!resolvedOrganizationGovernanceService?.listOrganizationGovernanceTemplates) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.listOrganizationGovernanceTemplates();
    },
    importOrganizationGovernance(input: Record<string, any> = {}) : any {
      if (!resolvedOrganizationGovernanceService?.importOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.importOrganizationGovernance(input);
    },
    previewOrganizationGovernance(input: Record<string, any> = {}) : any {
      if (!resolvedOrganizationGovernanceService?.previewOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.previewOrganizationGovernance(input);
    },
    publishOrganizationGovernance(input: Record<string, any> = {}) : any {
      if (!resolvedOrganizationGovernanceService?.publishOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.publishOrganizationGovernance(input);
    },
    listGovernanceRoles(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationGovernanceStore?.listRoles?.(input) || [];
    },
    upsertGovernanceRole(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertRole) {
        throw new Error("Authorization governance role store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertRole(input);
    },
    listGovernanceDepartments(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationGovernanceStore?.listDepartments?.(input) || [];
    },
    upsertGovernanceDepartment(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertDepartment) {
        throw new Error("Authorization governance department store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertDepartment(input);
    },
    listGovernanceTeams(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationGovernanceStore?.listTeams?.(input) || [];
    },
    upsertGovernanceTeam(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertTeam) {
        throw new Error("Authorization governance team store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertTeam(input);
    },
    listGovernanceUserPolicies() : any {
      return resolvedAuthorizationGovernanceStore?.listUserPolicies?.() || [];
    },
    upsertGovernanceUserPolicy(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertUserPolicy) {
        throw new Error("Authorization governance user policy store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertUserPolicy(input);
    },
    listGovernanceAgentGroups(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationGovernanceStore?.listAgentGroups?.(input) || [];
    },
    upsertGovernanceAgentGroup(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentGroup) {
        throw new Error("Authorization governance agent group store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentGroup(input);
    },
    listGovernanceAgentBindings() : any {
      return resolvedAuthorizationGovernanceStore?.listAgentBindings?.() || [];
    },
    upsertGovernanceAgentBinding(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentBinding) {
        throw new Error("Authorization governance agent binding store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentBinding(input);
    },
    listTags(input: Record<string, any> = {}) : any {
      return resolvedTagManagementStore?.listTags?.(input) || [];
    },
    getTag(tagId?: any) : any {
      return resolvedTagManagementStore?.getTag?.(tagId) || null;
    },
    upsertTag(input: Record<string, any> = {}) : any {
      if (!resolvedTagManagementStore?.upsertTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.upsertTag(input);
    },
    archiveTag(tagId?: any, input: Record<string, any> = {}) : any {
      if (!resolvedTagManagementStore?.archiveTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.archiveTag(tagId, input);
    },
    restoreTag(tagId?: any) : any {
      if (!resolvedTagManagementStore?.restoreTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.restoreTag(tagId);
    },
    listTagProjections(input: Record<string, any> = {}) : any {
      return resolvedTagManagementStore?.listProjections?.(input) || [];
    },
    rebuildTagProjections() : any {
      if (!resolvedTagManagementStore?.rebuildProjections) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.rebuildProjections();
    },
    listTagEvents(input: Record<string, any> = {}) : any {
      return resolvedTagManagementStore?.listEvents?.(input) || [];
    },
    listToolProfileTags(input: Record<string, any> = {}) : any {
      return resolvedTagManagementStore?.listToolProfiles?.(input) || [];
    },
    seedToolProfileTags(profiles: any = []) : any {
      return resolvedTagManagementStore?.seedToolProfiles?.(profiles) || { created: 0 };
    },
    listGovernanceApprovals(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationGovernanceStore?.listApprovals?.(input) || [];
    },
    getGovernanceApproval(approvalId?: any) : any {
      return resolvedAuthorizationGovernanceStore?.getApproval?.(approvalId) || null;
    },
    upsertGovernanceApproval(input: Record<string, any> = {}) : any {
      if (!resolvedAuthorizationGovernanceStore?.upsertApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertApproval(input);
    },
    revokeGovernanceApproval(approvalId?: any, reason: any = "") : any {
      if (!resolvedAuthorizationGovernanceStore?.revokeApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.revokeApproval(approvalId, reason);
    },
    listReceipts(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationStore?.listReceipts
        ? resolvedAuthorizationStore.listReceipts(input)
        : [];
    },
    listLoanRecords(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationStore?.listLoanRecords
        ? resolvedAuthorizationStore.listLoanRecords(input)
        : [];
    },
    listDeniedRequests(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationStore?.listDeniedRequests
        ? resolvedAuthorizationStore.listDeniedRequests(input)
        : [];
    },
    listDecisions(input: Record<string, any> = {}) : any {
      return resolvedAuthorizationStore?.listDecisions
        ? resolvedAuthorizationStore.listDecisions(input)
        : [];
    },
    appendReceipt(receipt?: any, metadata: Record<string, any> = {}) : any {
      if (!receipt || typeof resolvedAuthorizationStore?.appendReceipt !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendReceipt(receipt, metadata);
    },
    appendLoanRecord(record?: any, metadata: Record<string, any> = {}) : any {
      if (!record || typeof resolvedAuthorizationStore?.appendLoanRecord !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendLoanRecord(record, metadata);
    },
    appendDeniedRequest(request: Record<string, any> = {}) : any {
      if (!request || typeof resolvedAuthorizationStore?.appendDeniedRequest !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDeniedRequest(request);
    },
    appendDecision(decision: Record<string, any> = {}) : any {
      if (!decision || typeof resolvedAuthorizationStore?.appendDecision !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDecision(decision);
    },
    setWorkspaceAssetPolicy(input: Record<string, any> = {}) : any {
      const workspaceId: any = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId: any = String(input.policyId || input["policy-id"] || "").trim() || `workspace_asset_policy_${crypto.randomUUID()}`;
      const policy: Record<string, any> = {
        ...input,
        policyId,
        workspaceId,
        updatedAt: new Date().toISOString()
      };
      workspaceAssetPolicies.set(workspaceAssetPolicyKey(workspaceId, policyId), policy);
      return policy;
    },
    getWorkspaceAssetPolicy(input: Record<string, any> = {}) : any {
      const workspaceId: any = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId: any = String(input.policyId || input["policy-id"] || input.id || "").trim();
      if (!policyId) {
        return null;
      }
      return workspaceAssetPolicies.get(workspaceAssetPolicyKey(workspaceId, policyId)) || null;
    },
    checkWorkspaceAssetPermission(input: Record<string, any> = {}) : any {
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
