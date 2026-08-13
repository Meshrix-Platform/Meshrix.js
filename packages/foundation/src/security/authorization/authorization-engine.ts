import {
  KERNEL_CAPABILITY_PERMISSIONS,
  listKernelCapabilityPermissions,
  hasCapability,
  requiredCapabilitiesFor
} from "./authorization-capabilities.ts";
import crypto from "node:crypto";
import { createWeightedLruCache } from "pactium";
import { firstString, nowIso, randomId, riskRank, stringSet, stringsFrom, uniqueStrings, effectDetails } from "./authorization-engine-common.ts";
import { resolveResourceContext } from "./authorization-resource-context.ts";
import {
  abacDenyDetails,
  compileIpRule,
  grantHasToolset,
  hasConfirmation,
  inferOperationAction,
  ipMatchesPredicate,
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
  return subject.roleId === "owner" ||
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

export const AUTHORIZATION_COMPILER_PROTOCOL_VERSION: any = "v0.0.1:risk-control:authorization-compiler-1";
export const AUTHORIZATION_COMPILER_CACHE_DEFAULT_LIMIT: any = 256;
export const AUTHORIZATION_COMPILER_CACHE_DEFAULT_WEIGHT_LIMIT: any = 8 * 1024 * 1024;

function compiledFactsStructuralWeight(value: any) : number {
  const stack: any[] = [value];
  const visited: Set<object> = new Set();
  let weight: number = 0;
  while (stack.length > 0) {
    const current: any = stack.pop();
    if (current === null || current === undefined) {
      weight += 4;
      continue;
    }
    if (typeof current === "string") {
      weight += 16 + Buffer.byteLength(current, "utf8");
      continue;
    }
    if (typeof current === "number" || typeof current === "bigint") {
      weight += 8;
      continue;
    }
    if (typeof current === "boolean") {
      weight += 4;
      continue;
    }
    if ((typeof current !== "object" && typeof current !== "function") || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof Set) {
      weight += 48 + current.size * 16;
      for (const item of current) stack.push(item);
      continue;
    }
    if (Array.isArray(current)) {
      weight += 32 + current.length * 8;
      for (const item of current) stack.push(item);
      continue;
    }
    const entries: any[] = Object.entries(current);
    weight += 48 + entries.length * 16;
    for (const [key, item] of entries) {
      weight += Buffer.byteLength(key, "utf8");
      stack.push(item);
    }
  }
  return Math.max(1, weight);
}

const COMPILED_FACT_REVISION_KEYS: readonly string[] = Object.freeze([
  "revision",
  "version",
  "generation",
  "sourceRevision",
  "catalogRevision",
  "updatedAt"
]);
const COMPILED_FACT_IDENTITY_KEYS: readonly string[] = Object.freeze([
  "id",
  "subjectId",
  "userId",
  "operationId",
  "profileId",
  "username"
]);

function firstFactField(fact: Record<string, any>, keys: readonly string[]) : string {
  for (const key of keys) {
    const value: any = fact[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value);
    }
  }
  return "";
}

function exactFactDescriptor(label: string, fact: any = null) : readonly string[] | null {
  if (fact === null || fact === undefined) {
    return Object.freeze([label, "none", "none"]);
  }
  if (typeof fact !== "object" || Array.isArray(fact)) {
    return null;
  }
  const identity: string = firstFactField(fact, COMPILED_FACT_IDENTITY_KEYS);
  const revision: string = firstFactField(fact, COMPILED_FACT_REVISION_KEYS);
  return identity && revision
    ? Object.freeze([label, identity, revision])
    : null;
}

function exactCompiledFactKey(input: Record<string, any> = {}) : string | null {
  const descriptors: Array<readonly string[] | null> = [
    exactFactDescriptor("policy", input.grant || input.restriction || null),
    exactFactDescriptor("profile", input.profile || null),
    exactFactDescriptor("subject", input.subject || null),
    exactFactDescriptor("actor", input.actor || null),
    exactFactDescriptor("session-user", input.authSession?.user || null),
    exactFactDescriptor("tool", input.tool || null)
  ];
  if (descriptors.some((descriptor) => descriptor === null)) {
    return null;
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(descriptors))
    .digest("hex");
}

function revisionOf(fact: any = null) : string {
  return fact && typeof fact === "object"
    ? firstFactField(fact, COMPILED_FACT_REVISION_KEYS)
    : "";
}

function normalizeOriginEntry(value: any) : any {
  const raw: any = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return "";
  }
  let parsed: any;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    return "";
  }
  return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
}

function hasCompiledCapability(capabilitySet: any, capability: any = "") : any {
  const capabilityId: any = String(capability || "").trim();
  if (!capabilityId) {
    return true;
  }
  if (capabilitySet.has("cap:*") || capabilitySet.has(capabilityId)) {
    return true;
  }
  if (capabilityId.startsWith("cap:api:") && capabilitySet.has("cap:api:*")) {
    return true;
  }
  if (capabilityId.startsWith("cap:tool:") && capabilitySet.has("cap:tool:*")) {
    return true;
  }
  return false;
}

function compileAbacFacts(subject: Record<string, any> = {}, grant: any = null, profile: any = null) : any {
  const abacSet: any = (...values: any[]) : any => stringSet(stringsFrom(...values));
  return Object.freeze({
    tenantId: firstString(subject.tenantId, grant?.tenantId, grant?.metadata?.tenantId, profile?.tenantId),
    accountId: firstString(subject.accountId, grant?.accountId, grant?.metadata?.accountId, profile?.accountId),
    endpointId: firstString(subject.endpointId, grant?.endpointId, grant?.metadata?.endpointId, profile?.endpointId),
    opaqueMailboxId: firstString(
      subject.opaqueMailboxId,
      grant?.opaqueMailboxId,
      grant?.metadata?.opaqueMailboxId,
      profile?.opaqueMailboxId
    ),
    allowedWorkspaceIds: abacSet(
      subject.allowedWorkspaceIds,
      grant?.allowedWorkspaceIds,
      grant?.metadata?.allowedWorkspaceIds,
      profile?.allowedWorkspaceIds
    ),
    allowedAccountIds: abacSet(
      subject.allowedAccountIds,
      grant?.allowedAccountIds,
      grant?.metadata?.allowedAccountIds,
      profile?.allowedAccountIds
    ),
    allowedEndpointIds: abacSet(
      subject.allowedEndpointIds,
      grant?.allowedEndpointIds,
      grant?.metadata?.allowedEndpointIds,
      profile?.allowedEndpointIds
    ),
    allowedMailboxIds: abacSet(
      subject.allowedOpaqueMailboxIds,
      subject.allowedMailboxIds,
      grant?.allowedOpaqueMailboxIds,
      grant?.allowedMailboxIds,
      grant?.metadata?.allowedOpaqueMailboxIds,
      grant?.metadata?.allowedMailboxIds,
      profile?.allowedOpaqueMailboxIds,
      profile?.allowedMailboxIds
    ),
    allowedDataClasses: abacSet(
      subject.allowedDataClasses,
      grant?.allowedDataClasses,
      grant?.metadata?.allowedDataClasses,
      profile?.allowedDataClasses
    ),
    allowedEgress: abacSet(
      subject.allowedEgress,
      grant?.allowedEgress,
      grant?.metadata?.allowedEgress,
      profile?.allowedEgress
    ),
    allowedStaticSemanticFamilies: abacSet(
      subject.allowedStaticSemanticFamilies,
      grant?.allowedStaticSemanticFamilies,
      grant?.metadata?.allowedStaticSemanticFamilies,
      profile?.allowedStaticSemanticFamilies
    ),
    allowedCapabilityDomains: abacSet(
      subject.allowedCapabilityDomains,
      grant?.allowedCapabilityDomains,
      grant?.metadata?.allowedCapabilityDomains,
      profile?.allowedCapabilityDomains
    ),
    allowedCapabilityVerbs: abacSet(
      subject.allowedCapabilityVerbs,
      grant?.allowedCapabilityVerbs,
      grant?.metadata?.allowedCapabilityVerbs,
      profile?.allowedCapabilityVerbs
    ),
    allowedResourceKinds: abacSet(
      subject.allowedResourceKinds,
      grant?.allowedResourceKinds,
      grant?.metadata?.allowedResourceKinds,
      profile?.allowedResourceKinds
    ),
    allowedEffectKinds: abacSet(
      subject.allowedEffectKinds,
      grant?.allowedEffectKinds,
      grant?.metadata?.allowedEffectKinds,
      profile?.allowedEffectKinds
    ),
    allowedServiceIds: abacSet(
      subject.allowedServiceIds,
      grant?.allowedServiceIds,
      grant?.metadata?.allowedServiceIds,
      profile?.allowedServiceIds
    ),
    allowedSecretBindings: abacSet(
      subject.allowedSecretBindings,
      grant?.allowedSecretBindings,
      grant?.metadata?.allowedSecretBindings,
      profile?.allowedSecretBindings
    )
  });
}

function compileAuthorizationFacts(input: Record<string, any> = {}) : any {
  const grant: any = input.grant || null;
  const restriction: any = input.restriction || null;
  const policy: any = grant || restriction;
  const resolvedSubject: any = input.resolvedSubject ||
    resolveAuthorizationSubject({
      subject: input.subject || null,
      actor: input.actor || null,
      authSession: input.authSession || null,
      grant
    });
  const tool: any = input.tool || null;
  const profile: any = input.profile || null;
  const grantRequired: any = input.grantRequired === true;
  const allowedOrigins: any[] = [];
  const rawOrigins: any = Array.isArray(policy?.allowedOrigins) ? policy.allowedOrigins : [];
  for (const raw of rawOrigins) {
    const origin: any = normalizeOriginEntry(raw);
    if (!origin) {
      return { ok: false, reasonCode: "malformed_credential_origin", message: "Credential contains a malformed allowed origin." };
    }
    allowedOrigins.push(origin);
  }
  const allowedCidrs: any[] = [];
  const rawCidrs: any = Array.isArray(policy?.allowedCidrs) ? policy.allowedCidrs : [];
  for (const raw of rawCidrs) {
    const compiled: any = compileIpRule(raw);
    if (!compiled.ok) {
      return { ok: false, reasonCode: "malformed_credential_cidr", message: "Credential contains a malformed CIDR rule." };
    }
    allowedCidrs.push(compiled.predicate);
  }
  let maxUses: any = 0;
  const rawMaxUses: any = policy?.maxUses;
  if (rawMaxUses !== undefined && rawMaxUses !== null && String(rawMaxUses).trim() !== "") {
    maxUses = Number(rawMaxUses);
    if (!Number.isSafeInteger(maxUses) || maxUses < 0) {
      return { ok: false, reasonCode: "malformed_credential_max_uses", message: "Credential contains a malformed maximum use count." };
    }
  }
  const grantToolsets: any = stringSet(policy?.toolsets);
  const toolToolsets: any = uniqueStrings(tool?.toolsets || []);
  const missingToolsets: any = !policy?.toolsets?.length
    ? []
    : toolToolsets.filter((toolset?: any) : any => !grantToolsets.has(toolset));
  const facts: Record<string, any> = {
    schemaVersion: AUTHORIZATION_COMPILER_PROTOCOL_VERSION,
    subject: resolvedSubject,
    scopeSet: stringSet(resolvedSubject.scopes),
    capabilitySet: stringSet(effectiveSubjectCapabilities(resolvedSubject)),
    effectiveCapabilities: effectiveSubjectCapabilities(resolvedSubject),
    grantToolsets,
    toolToolsets,
    missingToolsets,
    allowedOrigins,
    allowedCidrs,
    maxUses,
    maxRisk: maxRiskAllowed(
      profile,
      policy,
      resolvedSubject,
      grantRequired || policy || tool ? "safe_write" : "destructive"
    ),
    toolDeny: uniqueStrings(policy?.toolDeny || []),
    toolAllow: uniqueStrings(policy?.toolAllow || []),
    profileToolDeny: uniqueStrings(profile?.toolDeny || []),
    profileToolAllow: uniqueStrings(profile?.toolAllow || []),
    abac: compileAbacFacts(resolvedSubject, policy, profile),
    key: String(input.compiledFactKey || ""),
    policyRevision: revisionOf(policy),
    credentialRevision: revisionOf(restriction || grant),
    subjectRevision: revisionOf(input.subject || null),
    profileRevision: revisionOf(profile),
    catalogRevision: revisionOf(tool)
  };
  return { ok: true, facts: Object.freeze(facts) };
}

export function evaluateAuthorizationPolicy({
  operation = {},
  tool = null,
  grant = null,
  restriction = null,
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
  governanceStore = null,
  governanceRequired = false,
  compiledFacts = null
}: Record<string, any> = {}) : any {
  const authorizationPolicy: any = grant || restriction;
  const resolvedSubject: any = compiledFacts?.subject || resolveAuthorizationSubject({ subject, actor, authSession, grant });
  const resourceContext: any = resolveResourceContext({ operation, tool, input, context });
  const requiredScopes: any = requiredScopesFor(operation, tool);
  const requiredCapabilities: any = requiredCapabilitiesFor(operation, tool);
  const scopeSet: any = compiledFacts?.scopeSet || stringSet(resolvedSubject.scopes);
  const missingScopes: any = requiredScopes.filter((scope?: any) : any => !scopeSet.has(scope));
  const capabilityMode: any = requiredCapabilities.length > 0 && resolvedSubject.capabilities.length > 0;
  const subjectCapabilitiesForDecision: any = compiledFacts
    ? compiledFacts.effectiveCapabilities
    : effectiveSubjectCapabilities(resolvedSubject);
  const missingCapabilities: any = capabilityMode
    ? requiredCapabilities.filter((capability?: any) : any => compiledFacts
        ? !hasCompiledCapability(compiledFacts.capabilitySet, capability)
        : !hasCapability(subjectCapabilitiesForDecision, capability))
    : [];
  const effectiveMissingScopes: any = capabilityMode ? [] : missingScopes;
  const missingToolsets: any = compiledFacts ? compiledFacts.missingToolsets : toolsetMisses(authorizationPolicy, tool);
  const risk: any = operationRisk(operation, tool);
  const evaluatedLayers: any = uniqueStrings([
    "authorization_subject",
    requiredCapabilities.length > 0 ? "operation_capability_policy" : "",
    "operation_scope_policy",
    tool ? "tool_catalog_policy" : "",
    grant ? "grant_policy" : restriction ? "credential_policy" : "",
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
        restriction,
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
    grant: authorizationPolicy,
    profile,
    resource: resourceContext,
    ...(compiledFacts ? { compiled: compiledFacts } : {})
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
  } else if (grantRequired && !authorizationPolicy) {
    details = effectDetails("deny", "missing_credential", "No authorization credential was provided.");
  } else if (authorizationPolicy?.expiresAt && Date.parse(authorizationPolicy.expiresAt) <= Date.now()) {
    details = effectDetails("deny", "grant_expired", "Grant is expired.");
  } else if (Number(authorizationPolicy?.maxUses || 0) > 0 && Number(authorizationPolicy?.useCount || 0) >= Number(authorizationPolicy?.maxUses || 0)) {
    details = effectDetails("deny", "grant_max_uses", "Grant has exceeded its maximum use count.");
  } else if (
    (compiledFacts ? compiledFacts.allowedOrigins.length : authorizationPolicy?.allowedOrigins?.length || 0) > 0 &&
    (!requestOrigin(request) || !(compiledFacts ? compiledFacts.allowedOrigins : authorizationPolicy.allowedOrigins.map((item?: any) : any => String(item || "").replace(/\/+$/, ""))).includes(requestOrigin(request)))
  ) {
    details = effectDetails("deny", "origin_not_allowed", "Request origin is not allowed by grant.");
  } else if (
    (compiledFacts ? compiledFacts.allowedCidrs.length : authorizationPolicy?.allowedCidrs?.length || 0) > 0 &&
    !(compiledFacts ? compiledFacts.allowedCidrs : authorizationPolicy.allowedCidrs).some((rule?: any) : any =>
      compiledFacts ? ipMatchesPredicate(sourceIpFromRequest(request), rule) : ipMatchesRule(sourceIpFromRequest(request), rule)
    )
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
  } else if (!grantHasToolset(authorizationPolicy, tool)) {
    details = effectDetails("deny", "missing_toolsets", "Grant is missing a toolset that contains this tool.");
  } else if (tool?.id && (compiledFacts ? compiledFacts.toolDeny : authorizationPolicy?.toolDeny || []).includes(tool.id)) {
    details = effectDetails("deny", "tool_denied", "Grant denies this tool.");
  } else if (tool?.id && (compiledFacts ? compiledFacts.toolAllow : authorizationPolicy?.toolAllow || []).length > 0 && !(compiledFacts ? compiledFacts.toolAllow : authorizationPolicy.toolAllow).includes(tool.id)) {
    details = effectDetails("deny", "tool_not_allowed", "Tool is not in the grant allowlist.");
  } else if (tool?.id && (compiledFacts ? compiledFacts.profileToolDeny : profile?.toolDeny || []).includes(tool.id)) {
    details = effectDetails("deny", "profile_tool_denied", "Agent profile denies this tool.");
  } else if (tool?.id && (compiledFacts ? compiledFacts.profileToolAllow : profile?.toolAllow || []).length > 0 && !(compiledFacts ? compiledFacts.profileToolAllow : profile.toolAllow).includes(tool.id)) {
    details = effectDetails("deny", "profile_tool_not_allowed", "Tool is not in the profile allowlist.");
  } else if (riskRank(risk) > riskRank(compiledFacts
    ? compiledFacts.maxRisk
    : maxRiskAllowed(
      profile,
      authorizationPolicy,
      resolvedSubject,
      grantRequired || authorizationPolicy || tool ? "safe_write" : "destructive"
    )
  )) {
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

  return decision;
}

function malformedFactDecision(reasonCode: any, message: any, input: Record<string, any> = {}) : any {
  const grant: any = input.grant || null;
  const subject: any = resolveAuthorizationSubject({
    subject: input.subject || null,
    actor: input.actor || null,
    authSession: input.authSession || null,
    grant
  });
  const decision: Record<string, any> = {
    protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
    decisionId: randomId("authz_decision"),
    auditId: randomId("authz_audit"),
    toolExecutionId: input.toolExecutionId || "",
    traceId: input.traceId || "",
    operationId: String(input.operation?.id || input.tool?.operationId || ""),
    toolId: String(input.tool?.id || ""),
    grantId: String(grant?.id || ""),
    subject,
    resource: {
      operationId: String(input.operation?.id || input.tool?.operationId || ""),
      toolId: String(input.tool?.id || ""),
      feature: String(input.operation?.feature || input.tool?.featureId || ""),
      risk: operationRisk(input.operation || {}, input.tool || null)
    },
    action: String(input.input?.requestedAction || input.context?.requestedAction || inferOperationAction(input.operation || {}, input.tool || null)),
    effect: "deny",
    allowed: false,
    reasonCode,
    redactedReason: message,
    deniedLayer: "authorization_compiler",
    effectivePolicySnapshot: null,
    requiredCapabilities: requiredCapabilitiesFor(input.operation || {}, input.tool || null),
    subjectCapabilities: subject.capabilities,
    missingCapabilities: [],
    requiredScopes: requiredScopesFor(input.operation || {}, input.tool || null),
    subjectScopes: subject.scopes,
    missingScopes: [],
    missingToolsets: [],
    requiredApproval: null,
    requiredConfirmation: false,
    evaluatedLayers: ["authorization_compiler"],
    tenant: {
      subjectTenantId: subject.tenantId || "",
      resourceTenantId: "",
      orgId: subject.orgId || "",
      teamIds: subject.teamIds || [],
      departmentIds: subject.departmentIds || []
    },
    abac: {},
    createdAt: nowIso()
  };
  return decision;
}

export function createAuthorizationEngine({
  store = null,
  governanceStore = null,
  compiledFactsCacheLimit = AUTHORIZATION_COMPILER_CACHE_DEFAULT_LIMIT,
  compiledFactsCacheWeightLimit = AUTHORIZATION_COMPILER_CACHE_DEFAULT_WEIGHT_LIMIT
}: Record<string, any> = {}) : any {
  const cacheLimit: any = Math.max(1, Math.min(Number(compiledFactsCacheLimit) || AUTHORIZATION_COMPILER_CACHE_DEFAULT_LIMIT, 4096));
  const cacheWeightLimit: any = Math.max(
    1024,
    Math.min(Number(compiledFactsCacheWeightLimit) || AUTHORIZATION_COMPILER_CACHE_DEFAULT_WEIGHT_LIMIT, 64 * 1024 * 1024)
  );
  const cache: any = createWeightedLruCache({ maxEntries: cacheLimit, maxWeight: cacheWeightLimit });
  let compiledSnapshotCount: any = 0;
  let cacheHits: any = 0;
  let cacheEvictions: any = 0;
  let cacheOversizeBypasses: any = 0;
  let cacheFailures: any = 0;
  let malformedFactDenials: any = 0;
  let uncachedCompileCount: any = 0;

  function compiledFactsFor(input: Record<string, any> = {}) : any {
    const grant: any = input.grant || null;
    const resolvedSubject: any = resolveAuthorizationSubject({
      subject: input.subject || null,
      actor: input.actor || null,
      authSession: input.authSession || null,
      grant
    });
    const candidateKey: string | null = exactCompiledFactKey(input);
    let cached: any = null;
    try {
      cached = candidateKey ? cache.get(candidateKey) : null;
    } catch {
      cacheFailures += 1;
    }
    if (candidateKey && cached) {
      cacheHits += 1;
      return cached;
    }
    const compiled: any = compileAuthorizationFacts({
      ...input,
      resolvedSubject,
      compiledFactKey: candidateKey || ""
    });
    if (!compiled.ok) {
      malformedFactDenials += 1;
      return compiled;
    }
    compiledSnapshotCount += 1;
    if (!candidateKey) {
      uncachedCompileCount += 1;
      return { ok: true, facts: compiled.facts };
    }
    const cacheEntry: any = { ok: true, facts: compiled.facts };
    const structuralWeight: number = compiledFactsStructuralWeight(compiled.facts);
    const sizeBefore: number = cache.size;
    try {
      cache.set(candidateKey, cacheEntry, structuralWeight);
      if (!cache.has(candidateKey)) {
        cacheOversizeBypasses += 1;
        uncachedCompileCount += 1;
      } else {
        cacheEvictions += Math.max(0, sizeBefore + 1 - cache.size);
      }
    } catch {
      cacheFailures += 1;
      uncachedCompileCount += 1;
    }
    return cacheEntry;
  }

  return {
    protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
    compilerProtocolVersion: AUTHORIZATION_COMPILER_PROTOCOL_VERSION,
    capabilityPermissions: KERNEL_CAPABILITY_PERMISSIONS,
    listCapabilityPermissions: listKernelCapabilityPermissions,
    resolveSubject: resolveAuthorizationSubject,
    async evaluate(input: Record<string, any> = {}) : Promise<any> {
      const compiled: any = compiledFactsFor(input);
      const decision: any = !compiled.ok
        ? malformedFactDecision(compiled.reasonCode, compiled.message, input)
        : evaluateAuthorizationPolicy({ ...input, governanceStore, compiledFacts: compiled.facts });
      if (store && typeof store.appendDecision === "function") {
        await store.appendDecision(decision);
      }
      return decision;
    },
    getRefactorInstrumentation: () : any => ({
      schemaVersion: "v0.0.1:risk-control:authorization-compiler-instrumentation-1",
      compiledSnapshotCount,
      cacheHits,
      cacheEvictions,
      cacheOversizeBypasses,
      cacheFailures,
      malformedFactDenials,
      uncachedCompileCount,
      cacheLimit,
      cacheWeight: cache.weight,
      cacheWeightLimit,
      cacheEntries: cache.size
    })
  };
}
