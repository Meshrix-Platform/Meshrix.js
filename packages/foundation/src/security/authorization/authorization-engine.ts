import {
  KERNEL_CAPABILITY_PERMISSIONS,
  listKernelCapabilityPermissions,
  hasCapability,
  requiredCapabilitiesFor
} from "./authorization-capabilities.ts";
import { nowIso, randomId, riskRank, stringSet, uniqueStrings, effectDetails } from "./authorization-engine-common.ts";
import { resolveResourceContext } from "./authorization-resource-context.ts";
import {
  abacDenyDetails,
  grantHasToolset,
  hasConfirmation,
  inferOperationAction,
  ipMatchesRule,
  maxRiskAllowed,
  operationRisk,
  requestOrigin,
  requiredScopesFor,
  resolveAuthorizationSubject,
  sourceIpFromRequest,
  toolsetMisses
} from "./authorization-engine-support.ts";

export const AUTHORIZATION_PROTOCOL_VERSION: any = "v0.0.1:risk-control:authorization-1";

export {
  KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS,
  apiCapabilityId,
  toolExecuteCapabilityId,
  KERNEL_API_CAPABILITY_PERMISSIONS,
  KERNEL_TOOL_CAPABILITY_PERMISSIONS,
  KERNEL_CAPABILITY_WILDCARDS,
  KERNEL_CAPABILITY_PERMISSIONS,
  isKernelCapabilityPermission,
  unknownKernelCapabilities,
  assertKnownKernelCapabilities,
  normalizeKernelCapabilities,
  isRegisteredToolCapabilityPermission,
  normalizeRegisteredToolCapabilities,
  listKernelCapabilityPermissions
} from "./authorization-capabilities.ts";
export { resolveAuthorizationSubject } from "./authorization-engine-support.ts";

function subjectCanUseCapabilityWildcards(subject: Record<string, any> = {}) : any {
  return subject.roleId === "admin" ||
    subject.roleId === "owner" ||
    subject.scopes?.includes("auth:admin");
}

function effectiveSubjectCapabilities(subject: Record<string, any> = {}) : any {
  const capabilities: any = Array.isArray(subject.capabilities) ? subject.capabilities : [];
  if (subjectCanUseCapabilityWildcards(subject)) {
    return capabilities;
  }
  return capabilities.filter((capability?: any) : any => !String(capability || "").trim().endsWith(":*"));
}

function approvedPendingOperationMatches(context: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const approval: any = context?.approvedPendingOperation;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return false;
  }
  if (!["approved", "completed"].includes(String(approval.status || ""))) {
    return false;
  }
  const approvedOperationId: any = String(approval.operationId || "");
  if (approvedOperationId && approvedOperationId !== String(operation.id || "")) {
    return false;
  }
  const approvalScope: any = String(approval.approvalScope || "");
  const requiredApprovalScope: any = String(operation.safety?.approvalScope || "");
  return !requiredApprovalScope || approvalScope === requiredApprovalScope;
}

export function evaluateAuthorizationPolicy({
  operation = {},
  tool = null,
  grant = null,
  profile = null,
  subject = null,
  actor = null,
  authSession = null,
  input = {},
  request = null,
  context = {},
  dryRun = false,
  traceId = "",
  toolExecutionId = "",
  grantRequired = false,
  enforceConfirmation = true,
  store = null,
  governanceStore = null,
  governanceRequired = false
}: Record<string, any> = {}) : any {
  const resolvedSubject: any = resolveAuthorizationSubject({ subject, actor, authSession, grant });
  const resourceContext: any = resolveResourceContext({ operation, tool, input, context });
  const requiredScopes: any = requiredScopesFor(operation, tool);
  const requiredCapabilities: any = requiredCapabilitiesFor(operation, tool);
  const scopeSet: any = stringSet(resolvedSubject.scopes);
  const missingScopes: any = requiredScopes.filter((scope?: any) : any => !scopeSet.has(scope));
  const capabilityMode: any = requiredCapabilities.length > 0 && resolvedSubject.capabilities.length > 0;
  const subjectCapabilitiesForDecision: any = effectiveSubjectCapabilities(resolvedSubject);
  const missingCapabilities: any = capabilityMode
    ? requiredCapabilities.filter((capability?: any) : any => !hasCapability(subjectCapabilitiesForDecision, capability))
    : [];
  const effectiveMissingScopes: any = capabilityMode ? [] : missingScopes;
  const missingToolsets: any = toolsetMisses(grant, tool);
  const risk: any = operationRisk(operation, tool);
  const evaluatedLayers: any = uniqueStrings([
    "authorization_subject",
    requiredCapabilities.length > 0 ? "operation_capability_policy" : "",
    "operation_scope_policy",
    tool ? "tool_catalog_policy" : "",
    grant ? "grant_policy" : "",
    profile ? "agent_profile_policy" : "",
    resourceContext.tenantId ? "tenant_boundary_policy" : "",
    resourceContext.accountId || resourceContext.accountBoundaryRequired ? "account_boundary_policy" : "",
    resourceContext.endpointId || resourceContext.endpointBoundaryRequired ? "endpoint_boundary_policy" : "",
    resourceContext.opaqueMailboxId || resourceContext.mailboxBoundaryRequired ? "mailbox_boundary_policy" : "",
    resourceContext.workspaceId ||
      resourceContext.workspaceIds?.length ||
      resourceContext.dataClass ||
      resourceContext.dataClasses?.length ||
      resourceContext.requestedEgress ||
      resourceContext.requestedEgresses?.length ||
      resourceContext.serviceId ||
      resourceContext.serviceIds?.length ||
      resourceContext.secretBindingId ||
      resourceContext.secretBindingIds?.length ||
      resourceContext.staticSemanticFamilyId ||
      resourceContext.capabilityDomain ||
      resourceContext.capabilityVerb ||
      resourceContext.resourceKind ||
      resourceContext.effectKind
      ? "abac_resource_policy"
      : "",
    "runtime_safety_policy"
  ]);
  let details: any = effectDetails("allow", "allowed", "Request allowed.");
  const governanceDecision: any = governanceStore && typeof governanceStore.evaluateGovernance === "function"
    ? governanceStore.evaluateGovernance({
        operation,
        tool,
        grant,
        profile,
        subject: resolvedSubject,
        input,
        request,
        context,
        governanceRequired
      })
    : null;
  const abacDetails: any = abacDenyDetails({
    subject: resolvedSubject,
    grant,
    profile,
    resource: resourceContext
  });

  if (governanceDecision?.applicable && governanceDecision.effect === "deny") {
    details = effectDetails("deny", governanceDecision.reasonCode, governanceDecision.redactedReason, {
      deniedLayer: governanceDecision.deniedLayer || "governance",
      effectivePolicySnapshot: governanceDecision.effectivePolicySnapshot || null
    });
  } else if (governanceDecision?.applicable && governanceDecision.effect === "needsApproval") {
    details = effectDetails("needsApproval", governanceDecision.reasonCode, governanceDecision.redactedReason, {
      deniedLayer: governanceDecision.deniedLayer || "governance",
      requiredApproval: governanceDecision.requiredApproval || null,
      effectivePolicySnapshot: governanceDecision.effectivePolicySnapshot || null
    });
  } else if (governanceDecision?.applicable && governanceDecision.effect === "allow") {
    details = effectDetails("allow", governanceDecision.reasonCode || "governance_allowed", "Request allowed by governance policy.", {
      effectivePolicySnapshot: governanceDecision.effectivePolicySnapshot || null
    });
  } else if (tool === null && context?.toolExpected === true) {
    details = effectDetails("deny", "unknown_tool", "Tool is not registered.");
  } else if (abacDetails) {
    details = abacDetails;
  } else if (tool && tool.status !== "active") {
    details = effectDetails("deny", "tool_inactive", "Tool is inactive.");
  } else if (grantRequired && !grant) {
    details = effectDetails("deny", "missing_grant", "No grant was provided.");
  } else if (grant?.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
    details = effectDetails("deny", "grant_expired", "Grant is expired.");
  } else if (Number(grant?.maxUses || 0) > 0 && Number(grant?.useCount || 0) >= Number(grant?.maxUses || 0)) {
    details = effectDetails("deny", "grant_max_uses", "Grant has exceeded its maximum use count.");
  } else if (
    grant?.allowedOrigins?.length > 0 &&
    (!requestOrigin(request) || !grant.allowedOrigins.map((item?: any) : any => String(item || "").replace(/\/+$/, "")).includes(requestOrigin(request)))
  ) {
    details = effectDetails("deny", "origin_not_allowed", "Request origin is not allowed by grant.");
  } else if (
    grant?.allowedCidrs?.length > 0 &&
    !grant.allowedCidrs.some((rule?: any) : any => ipMatchesRule(sourceIpFromRequest(request), rule))
  ) {
    details = effectDetails("deny", "cidr_not_allowed", "Request source address is not allowed by grant.");
  } else if (context?.grantRateLimited === true || context?.rateLimited === true) {
    details = effectDetails("deny", "rate_limited", "Grant rate limit has been exceeded.");
  } else if (operation?.externalAuth === true && context?.externalAuthVerified !== true) {
    details = effectDetails("deny", "external_auth_not_verified", "External authentication has not been verified by the dispatcher.");
  } else if (operation?.public === true) {
    details = effectDetails("allow", "allowed_public", "Public operation.");
  } else if (operation?.externalAuth === true && context?.externalAuthVerified === true) {
    details = effectDetails("allow", "allowed_external_auth_verified", "Externally authenticated operation.");
  } else if (missingCapabilities.length > 0) {
    details = effectDetails("deny", "missing_capabilities", "Credential is missing required capabilities.");
  } else if (effectiveMissingScopes.length > 0) {
    details = effectDetails("deny", "missing_scopes", "Subject is missing required scopes.");
  } else if (!grantHasToolset(grant, tool)) {
    details = effectDetails("deny", "missing_toolsets", "Grant is missing a toolset that contains this tool.");
  } else if (tool?.id && grant?.toolDeny?.includes(tool.id)) {
    details = effectDetails("deny", "tool_denied", "Grant denies this tool.");
  } else if (tool?.id && grant?.toolAllow?.length > 0 && !grant.toolAllow.includes(tool.id)) {
    details = effectDetails("deny", "tool_not_allowed", "Tool is not in the grant allowlist.");
  } else if (tool?.id && profile?.toolDeny?.includes(tool.id)) {
    details = effectDetails("deny", "profile_tool_denied", "Agent profile denies this tool.");
  } else if (tool?.id && profile?.toolAllow?.length > 0 && !profile.toolAllow.includes(tool.id)) {
    details = effectDetails("deny", "profile_tool_not_allowed", "Tool is not in the profile allowlist.");
  } else if (riskRank(risk) > riskRank(maxRiskAllowed(
    profile,
    grant,
    resolvedSubject,
    grantRequired || grant || tool ? "safe_write" : "destructive"
  ))) {
    details = effectDetails("deny", "risk_exceeds_policy", "Requested risk exceeds effective policy.");
  } else if (
    (risk === "destructive" || tool?.destructive || tool?.requiresApproval || operation?.requiresApproval === true || operation?.safety?.requiresApproval === true) &&
    !approvedPendingOperationMatches(context, operation)
  ) {
    details = effectDetails("require_approval", "approval_receipt_required", "Operation requires an approval receipt.");
  } else if (enforceConfirmation && (tool?.destructive || tool?.requiresApproval || operation?.safety?.requiresConfirmation) && !hasConfirmation(input, request)) {
    details = effectDetails("require_confirmation", "confirmation_required", "Request requires confirmation.");
  } else if (dryRun) {
    details = effectDetails("dry_run_only", "dry_run", "Dry-run requested.");
  }

  const decision: Record<string, any> = {
    protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
    decisionId: randomId("authz_decision"),
    auditId: randomId("authz_audit"),
    toolExecutionId,
    traceId,
    operationId: String(operation?.id || tool?.operationId || ""),
    toolId: String(tool?.id || ""),
    grantId: String(grant?.id || ""),
    subject: resolvedSubject,
    resource: {
      operationId: String(operation?.id || tool?.operationId || ""),
      toolId: String(tool?.id || ""),
      feature: String(operation?.feature || tool?.featureId || ""),
      risk,
      tenantId: resourceContext.tenantId,
      accountId: resourceContext.accountId,
      endpointId: resourceContext.endpointId,
      opaqueMailboxId: resourceContext.opaqueMailboxId,
      accountBoundaryRequired: resourceContext.accountBoundaryRequired === true,
      endpointBoundaryRequired: resourceContext.endpointBoundaryRequired === true,
      mailboxBoundaryRequired: resourceContext.mailboxBoundaryRequired === true,
      workspaceId: resourceContext.workspaceId,
      workspaceIds: resourceContext.workspaceIds || [],
      dataClass: resourceContext.dataClass,
      dataClasses: resourceContext.dataClasses || [],
      serviceId: resourceContext.serviceId || "",
      serviceIds: resourceContext.serviceIds || [],
      secretBindingId: resourceContext.secretBindingId || "",
      secretBindingIds: resourceContext.secretBindingIds || [],
      staticSemanticFamilyId: resourceContext.staticSemanticFamilyId || "",
      capabilityDomain: resourceContext.capabilityDomain || "",
      capabilityVerb: resourceContext.capabilityVerb || "",
      resourceKind: resourceContext.resourceKind || "",
      effectKind: resourceContext.effectKind || ""
    },
    action: String(input.requestedAction || context.requestedAction || inferOperationAction(operation, tool)),
    requestedEgress: resourceContext.requestedEgress,
    requestedEgresses: resourceContext.requestedEgresses || [],
    effect: details.effect,
    allowed: ["allow", "dry_run_only"].includes(details.effect),
    reasonCode: details.reasonCode,
    redactedReason: details.redactedReason,
    deniedLayer: details.deniedLayer || "",
    effectivePolicySnapshot: details.effectivePolicySnapshot || governanceDecision?.effectivePolicySnapshot || null,
    requiredCapabilities,
    subjectCapabilities: resolvedSubject.capabilities,
    missingCapabilities: uniqueStrings(missingCapabilities),
    requiredScopes,
    subjectScopes: resolvedSubject.scopes,
    missingScopes: uniqueStrings(effectiveMissingScopes),
    missingToolsets: details.effect === "deny" ? uniqueStrings(missingToolsets) : [],
    requiredApproval: details.requiredApproval || (details.effect === "require_approval" ? { reasonCode: details.reasonCode } : null),
    requiredConfirmation: details.effect === "require_confirmation",
    evaluatedLayers,
    tenant: {
      subjectTenantId: resolvedSubject.tenantId || "",
      resourceTenantId: resourceContext.tenantId || "",
      orgId: resolvedSubject.orgId || "",
      teamIds: resolvedSubject.teamIds || [],
      departmentIds: resolvedSubject.departmentIds || []
    },
    abac: {
      workspaceId: resourceContext.workspaceId || "",
      workspaceIds: resourceContext.workspaceIds || [],
      accountId: resourceContext.accountId || "",
      endpointId: resourceContext.endpointId || "",
      opaqueMailboxId: resourceContext.opaqueMailboxId || "",
      accountBoundaryRequired: resourceContext.accountBoundaryRequired === true,
      endpointBoundaryRequired: resourceContext.endpointBoundaryRequired === true,
      mailboxBoundaryRequired: resourceContext.mailboxBoundaryRequired === true,
      allowedAccountIds: resolvedSubject.allowedAccountIds || [],
      allowedEndpointIds: resolvedSubject.allowedEndpointIds || [],
      allowedOpaqueMailboxIds: resolvedSubject.allowedOpaqueMailboxIds || [],
      dataClass: resourceContext.dataClass || "",
      dataClasses: resourceContext.dataClasses || [],
      requestedEgress: resourceContext.requestedEgress || "",
      requestedEgresses: resourceContext.requestedEgresses || [],
      serviceId: resourceContext.serviceId || "",
      serviceIds: resourceContext.serviceIds || [],
      secretBindingId: resourceContext.secretBindingId || "",
      secretBindingIds: resourceContext.secretBindingIds || [],
      staticSemanticFamilyId: resourceContext.staticSemanticFamilyId || "",
      capabilityDomain: resourceContext.capabilityDomain || "",
      capabilityVerb: resourceContext.capabilityVerb || "",
      resourceKind: resourceContext.resourceKind || "",
      effectKind: resourceContext.effectKind || "",
      allowedWorkspaceIds: resolvedSubject.allowedWorkspaceIds || [],
      allowedDataClasses: resolvedSubject.allowedDataClasses || [],
      allowedEgress: resolvedSubject.allowedEgress || [],
      allowedStaticSemanticFamilies: resolvedSubject.allowedStaticSemanticFamilies || [],
      allowedCapabilityDomains: resolvedSubject.allowedCapabilityDomains || [],
      allowedCapabilityVerbs: resolvedSubject.allowedCapabilityVerbs || [],
      allowedResourceKinds: resolvedSubject.allowedResourceKinds || [],
      allowedEffectKinds: resolvedSubject.allowedEffectKinds || [],
      allowedServiceIds: resolvedSubject.allowedServiceIds || [],
      allowedSecretBindings: resolvedSubject.allowedSecretBindings || []
    },
    createdAt: nowIso()
  };

  if (store && typeof store.appendDecision === "function") {
    store.appendDecision(decision);
  }
  return decision;
}

export function createAuthorizationEngine({ store = null, governanceStore = null }: Record<string, any> = {}) : any {
  return {
    protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
    capabilityPermissions: KERNEL_CAPABILITY_PERMISSIONS,
    listCapabilityPermissions: listKernelCapabilityPermissions,
    resolveSubject: resolveAuthorizationSubject,
    evaluate: (input: Record<string, any> = {}) : any => evaluateAuthorizationPolicy({ ...input, store, governanceStore })
  };
}
