import { clientIpFromRequest, normalizeIpAddress } from "#meshrix/trusted-client-ip";
import { subjectCapabilities } from "./authorization-capabilities.ts";
import {
  deniedOutsideAllowed,
  effectDetails,
  firstString,
  objectOrNull,
  riskRank,
  stringSet,
  stringsFrom,
  uniqueStrings
} from "./authorization-engine-common.ts";

interface AuthzRecord extends Record<string, unknown> {
  metadata?: AuthzRecord;
  user?: AuthzRecord;
  safety?: AuthzRecord;
  headers?: Record<string, unknown>;
  scopes?: string[];
  toolsets?: string[];
  abac?: Record<string, string | string[] | ReadonlySet<string>>;
}
export type CompiledIpPredicate =
  | { kind: "exact"; ip: string }
  | { kind: "range"; base: number; bits: number; mask: number };
export type CompiledIpRule =
  | { ok: false }
  | { ok: true; predicate: CompiledIpPredicate };

export function hasConfirmation(input: AuthzRecord = {}, request: AuthzRecord | null = null) {
  if (input?.confirm === true || input?.confirmed === true) {
    return true;
  }
  const header = String(
    request?.headers?.["x-meshrix-confirm"] ||
      request?.headers?.["x-meshrix-safety-confirm"] ||
      ""
  ).toLowerCase();
  return ["1", "true", "yes"].includes(header);
}

export function requestOrigin(request?: AuthzRecord | null): string {
  const origin = String(request?.headers?.origin || "").trim();
  if (origin) {
    return origin.replace(/\/+$/, "");
  }
  const referer = String(request?.headers?.referer || "").trim();
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return "";
    }
  }
  return "";
}

export function sourceIpFromRequest(request?: Parameters<typeof clientIpFromRequest>[0]) {
  return clientIpFromRequest(request);
}

function normalizeIp(value?: unknown) {
  return normalizeIpAddress(value);
}

function ipv4ToInt(value?: unknown): number | null {
  const parts = normalizeIp(value).split(".");
  if (parts.length !== 4) {
    return null;
  }
  let output = 0;
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) {
      return null;
    }
    output = (output << 8) + number;
  }
  return output >>> 0;
}

export function compileIpRule(rule?: unknown): CompiledIpRule {
  const normalizedRule = String(rule || "").trim();
  if (!normalizedRule) {
    return { ok: false };
  }
  if (!normalizedRule.includes("/")) {
    const normalizedIp = normalizeIp(normalizedRule);
    if (!normalizedIp) {
      return { ok: false };
    }
    return { ok: true, predicate: { kind: "exact", ip: normalizedIp } };
  }
  const [base, bitsText] = normalizedRule.split("/");
  const bits = Number(bitsText);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return { ok: false };
  }
  return {
    ok: true,
    predicate: {
      kind: "range",
      base: baseInt,
      bits,
      mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    }
  };
}

export function ipMatchesRule(ip?: unknown, rule?: unknown): boolean {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) {
    return false;
  }
  const compiled = compileIpRule(rule);
  if (!compiled.ok) {
    return false;
  }
  const predicate = compiled.predicate;
  if (predicate.kind === "exact") {
    return normalizedIp === predicate.ip;
  }
  const ipInt = ipv4ToInt(normalizedIp);
  if (ipInt === null) {
    return false;
  }
  return (ipInt & predicate.mask) === (predicate.base & predicate.mask);
}

export function ipMatchesPredicate(ip: unknown, predicate?: CompiledIpPredicate | null): boolean {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp || !predicate) {
    return false;
  }
  if (predicate.kind === "exact") {
    return normalizedIp === predicate.ip;
  }
  const ipInt = ipv4ToInt(normalizedIp);
  if (ipInt === null) {
    return false;
  }
  return (ipInt & predicate.mask) === (predicate.base & predicate.mask);
}

export function maxRiskAllowed(
  profile: AuthzRecord | null = null,
  grant: AuthzRecord | null = null,
  subject: AuthzRecord | null = null,
  fallback: unknown = "safe_write"
): unknown {
  const candidates = [
    profile?.maxRisk,
    grant?.maxRisk,
    grant?.metadata?.maxRisk,
    subject?.maxRisk
  ].filter(Boolean);
  if (candidates.length === 0) {
    return fallback;
  }
  return candidates.reduce((lowest, item) =>
    riskRank(item) < riskRank(lowest) ? item : lowest
  );
}

export function inferOperationAction(operation: AuthzRecord = {}, tool: AuthzRecord | null = null): string {
  if (operation?.action) {
    return String(operation.action);
  }
  const operationId = String(operation?.id || tool?.operationId || "");
  if (!operationId) {
    return tool?.readOnly === false ? "write" : "read";
  }
  const last = operationId.split(".").filter(Boolean).pop() || "";
  if (["list", "get", "read", "download", "query", "evaluate", "preview", "history", "info"].includes(last)) {
    return "read";
  }
  return "write";
}

export function operationRisk(operation: AuthzRecord = {}, tool: AuthzRecord | null = null): string {
  return String(tool?.risk || operation?.safety?.risk || operation?.risk || (operation?.readOnly === false ? "safe_write" : "read_only"));
}

export function requiredScopesFor(operation: AuthzRecord = {}, tool: AuthzRecord | null = null): string[] {
  return uniqueStrings([
    ...(Array.isArray(operation?.requiredScopes) ? operation.requiredScopes : []),
    ...(Array.isArray(tool?.requiredScopes) ? tool.requiredScopes : [])
  ]);
}

export function subjectScopes(
  subject: AuthzRecord = {}, actor: AuthzRecord | null = null,
  authSession: AuthzRecord | null = null, grant: AuthzRecord | null = null
): string[] {
  return uniqueStrings([
    ...(Array.isArray(subject.scopes) ? subject.scopes : []),
    ...(Array.isArray(actor?.scopes) ? actor.scopes : []),
    ...(Array.isArray(actor?.user?.scopes) ? actor.user.scopes : []),
    ...(Array.isArray(authSession?.user?.scopes) ? authSession.user.scopes : []),
    ...(Array.isArray(grant?.scopes) ? grant.scopes : [])
  ]);
}

export function grantHasToolset(grant: AuthzRecord | null = null, tool: AuthzRecord | null = null): boolean {
  if (!tool || !grant?.toolsets?.length) {
    return true;
  }
  return (tool.toolsets || []).some((toolset) => grant.toolsets?.includes(toolset));
}

export function toolsetMisses(grant: AuthzRecord | null = null, tool: AuthzRecord | null = null): string[] {
  if (!tool || !grant?.toolsets?.length) {
    return [];
  }
  const grantToolsets = stringSet(grant.toolsets);
  return uniqueStrings(tool.toolsets || []).filter((toolset) => !grantToolsets.has(toolset));
}

function subjectHasTenantBypass(subject: AuthzRecord = {}): boolean {
  return subject.roleId === "owner" || subject.scopes?.includes("auth:admin") === true;
}

function subjectHasResourceBoundaryBypass(subject: AuthzRecord = {}): boolean {
  return subject.roleId === "owner" ||
    subject.scopes?.includes("auth:admin") === true;
}

export function abacDenyDetails({
  subject = {}, grant = null, profile = null, resource = {}, compiled = null
}: {
  subject?: AuthzRecord; grant?: AuthzRecord | null; profile?: AuthzRecord | null;
  resource?: AuthzRecord; compiled?: AuthzRecord | null;
} = {}) {
  const compiledAbac = compiled?.abac || null;
  const policyString = (compiledKey: string, ...dynamic: unknown[]): string =>
    firstString(compiledAbac?.[compiledKey], ...dynamic);
  const allowedValues = (compiledKey: string, ...dynamic: unknown[]): string[] => {
    const compiledValue = compiledAbac?.[compiledKey];
    return compiledValue instanceof Set ? [...compiledValue] : stringsFrom(compiledValue, ...dynamic);
  };
  const countOf = (value?: readonly unknown[] | ReadonlySet<unknown>) =>
    Array.isArray(value) ? value.length : (value as ReadonlySet<unknown> | undefined)?.size ?? 0;
  const tenantPolicy = policyString("tenantId", subject.tenantId, grant?.tenantId, grant?.metadata?.tenantId, profile?.tenantId);
  if (
    resource.tenantId &&
    tenantPolicy &&
    tenantPolicy !== resource.tenantId &&
    !subjectHasTenantBypass(subject)
  ) {
    return effectDetails("deny", "tenant_mismatch", "Requested tenant is outside the subject boundary.");
  }

  const allowedWorkspaceIds = allowedValues(
    "allowedWorkspaceIds",
    subject.allowedWorkspaceIds,
    grant?.allowedWorkspaceIds,
    grant?.metadata?.allowedWorkspaceIds,
    profile?.allowedWorkspaceIds
  );
  if (deniedOutsideAllowed([resource.workspaceId, resource.workspaceIds], allowedWorkspaceIds)) {
    return effectDetails("deny", "workspace_not_allowed", "Requested workspace is outside the allowed workspace set.");
  }

  const hasResourceBoundaryBypass = subjectHasResourceBoundaryBypass(subject);
  const accountPolicy = policyString("accountId", subject.accountId, grant?.accountId, grant?.metadata?.accountId, profile?.accountId);
  const allowedAccountIds = allowedValues(
    "allowedAccountIds",
    subject.allowedAccountIds,
    grant?.allowedAccountIds,
    grant?.metadata?.allowedAccountIds,
    profile?.allowedAccountIds
  );
  if (resource.accountBoundaryRequired && !resource.accountId && !hasResourceBoundaryBypass) {
    return effectDetails("deny", "account_resource_missing", "Requested operation requires an account resource boundary.");
  }
  if (resource.accountId && (resource.accountBoundaryRequired || accountPolicy || countOf(allowedAccountIds) > 0) && !hasResourceBoundaryBypass) {
    if (!accountPolicy && countOf(allowedAccountIds) === 0) {
      return effectDetails("deny", "account_boundary_missing", "Subject has no account boundary for this resource.");
    }
    if (accountPolicy && accountPolicy !== resource.accountId) {
      return effectDetails("deny", "account_mismatch", "Requested account is outside the subject boundary.");
    }
    if (deniedOutsideAllowed([resource.accountId], allowedAccountIds)) {
      return effectDetails("deny", "account_not_allowed", "Requested account is outside the allowed account set.");
    }
  }

  const endpointPolicy = policyString("endpointId", subject.endpointId, grant?.endpointId, grant?.metadata?.endpointId, profile?.endpointId);
  const allowedEndpointIds = allowedValues(
    "allowedEndpointIds",
    subject.allowedEndpointIds,
    grant?.allowedEndpointIds,
    grant?.metadata?.allowedEndpointIds,
    profile?.allowedEndpointIds
  );
  if (resource.endpointBoundaryRequired && !resource.endpointId && !hasResourceBoundaryBypass) {
    return effectDetails("deny", "endpoint_resource_missing", "Requested operation requires an endpoint resource boundary.");
  }
  if (resource.endpointBoundaryRequired && resource.endpointId && !hasResourceBoundaryBypass) {
    if (!endpointPolicy && countOf(allowedEndpointIds) === 0) {
      return effectDetails("deny", "endpoint_boundary_missing", "Subject has no endpoint boundary for this resource.");
    }
    if (endpointPolicy && endpointPolicy !== resource.endpointId) {
      return effectDetails("deny", "endpoint_mismatch", "Requested endpoint is outside the subject boundary.");
    }
    if (deniedOutsideAllowed([resource.endpointId], allowedEndpointIds)) {
      return effectDetails("deny", "endpoint_not_allowed", "Requested endpoint is outside the allowed endpoint set.");
    }
  }

  const mailboxPolicy = policyString(
    "opaqueMailboxId",
    subject.opaqueMailboxId,
    grant?.opaqueMailboxId,
    grant?.metadata?.opaqueMailboxId,
    profile?.opaqueMailboxId
  );
  const allowedMailboxIds = allowedValues(
    "allowedMailboxIds",
    subject.allowedOpaqueMailboxIds,
    subject.allowedMailboxIds,
    grant?.allowedOpaqueMailboxIds,
    grant?.allowedMailboxIds,
    grant?.metadata?.allowedOpaqueMailboxIds,
    grant?.metadata?.allowedMailboxIds,
    profile?.allowedOpaqueMailboxIds,
    profile?.allowedMailboxIds
  );
  if (resource.mailboxBoundaryRequired && !resource.opaqueMailboxId && !hasResourceBoundaryBypass) {
    return effectDetails("deny", "mailbox_resource_missing", "Requested operation requires a mailbox resource boundary.");
  }
  if (resource.mailboxBoundaryRequired && resource.opaqueMailboxId && !hasResourceBoundaryBypass) {
    if (!mailboxPolicy && countOf(allowedMailboxIds) === 0) {
      return effectDetails("deny", "mailbox_boundary_missing", "Subject has no mailbox boundary for this resource.");
    }
    if (mailboxPolicy && mailboxPolicy !== resource.opaqueMailboxId) {
      return effectDetails("deny", "mailbox_mismatch", "Requested mailbox is outside the subject boundary.");
    }
    if (deniedOutsideAllowed([resource.opaqueMailboxId], allowedMailboxIds)) {
      return effectDetails("deny", "mailbox_not_allowed", "Requested mailbox is outside the allowed mailbox set.");
    }
  }

  const allowedDataClasses = allowedValues(
    "allowedDataClasses",
    subject.allowedDataClasses,
    grant?.allowedDataClasses,
    grant?.metadata?.allowedDataClasses,
    profile?.allowedDataClasses
  );
  if (deniedOutsideAllowed([resource.dataClass], allowedDataClasses)) {
    return effectDetails("deny", "data_class_not_allowed", "Requested data class is outside the allowed data classes.");
  }
  const deniedDataClass = deniedOutsideAllowed([resource.dataClasses], allowedDataClasses);
  if (deniedDataClass) {
    return effectDetails("deny", "data_class_not_allowed", "Requested semantic data class is outside the allowed data classes.");
  }

  const allowedEgress = allowedValues(
    "allowedEgress",
    subject.allowedEgress,
    grant?.allowedEgress,
    grant?.metadata?.allowedEgress,
    profile?.allowedEgress
  );
  if (deniedOutsideAllowed([resource.requestedEgress, resource.requestedEgresses], allowedEgress)) {
    return effectDetails("deny", "egress_not_allowed", "Requested egress is outside the allowed egress set.");
  }

  const semanticChecks: ReadonlyArray<readonly [string, string, string, string, string]> = [
    ["staticSemanticFamilyId", "staticSemanticFamilyIds", "allowedStaticSemanticFamilies", "static_semantic_family_not_allowed", "Requested static semantic family is outside the allowed set."],
    ["capabilityDomain", "capabilityDomains", "allowedCapabilityDomains", "capability_domain_not_allowed", "Requested capability domain is outside the allowed set."],
    ["capabilityVerb", "capabilityVerbs", "allowedCapabilityVerbs", "capability_verb_not_allowed", "Requested capability verb is outside the allowed set."],
    ["resourceKind", "resourceKinds", "allowedResourceKinds", "resource_kind_not_allowed", "Requested resource kind is outside the allowed set."],
    ["effectKind", "effectKinds", "allowedEffectKinds", "effect_kind_not_allowed", "Requested effect kind is outside the allowed set."],
    ["serviceId", "serviceIds", "allowedServiceIds", "service_not_allowed", "Requested external service is outside the allowed service set."],
    ["secretBindingId", "secretBindingIds", "allowedSecretBindings", "secret_binding_not_allowed", "Requested secret binding is outside the allowed secret binding set."]
  ];
  for (const [resourceKey, resourceListKey, allowedKey, reasonCode, reason] of semanticChecks) {
    const allowed = allowedValues(allowedKey, subject[allowedKey], grant?.[allowedKey], grant?.metadata?.[allowedKey], profile?.[allowedKey]);
    if (deniedOutsideAllowed([resource[resourceKey], resource[resourceListKey]], allowed)) {
      return effectDetails("deny", reasonCode, reason);
    }
  }

  return null;
}

export function resolveAuthorizationSubject({
  subject = null,
  actor = null,
  authSession = null,
  grant = null
}: {
  subject?: AuthzRecord | null; actor?: AuthzRecord | null;
  authSession?: AuthzRecord | null; grant?: AuthzRecord | null;
} = {}) {
  const user = authSession?.user || actor?.user || null;
  const metadata = objectOrNull(subject?.metadata) || objectOrNull(grant?.metadata) || {};
  const attributes: Record<string, unknown> = {
    ...objectOrNull(user?.attributes),
    ...objectOrNull(actor?.attributes),
    ...objectOrNull(subject?.attributes),
    ...objectOrNull(metadata.attributes)
  };
  if (subject && typeof subject === "object" && !Array.isArray(subject)) {
    return {
      type: subject.type || subject.subjectType || (grant ? "tool-grant" : user ? "console-user" : "subject"),
      subjectId: String(subject.subjectId || subject.userId || subject.id || user?.userId || grant?.id || ""),
      username: String(subject.username || user?.username || grant?.label || ""),
      roleId: String(subject.roleId || user?.roleId || ""),
      scopes: uniqueStrings(subjectScopes(subject, actor, authSession, grant)),
      capabilities: subjectCapabilities(subject, actor, authSession, grant),
      agentProfileId: String(subject.agentProfileId || subject.profileId || ""),
      maxRisk: subject.maxRisk || "",
      tenantId: firstString(subject.tenantId, user?.tenantId, grant?.tenantId, metadata.tenantId),
      accountId: firstString(subject.accountId, user?.accountId, grant?.accountId, metadata.accountId, user?.userId),
      endpointId: firstString(subject.endpointId, user?.endpointId, grant?.endpointId, metadata.endpointId),
      opaqueMailboxId: firstString(
        subject.opaqueMailboxId,
        subject.mailboxId,
        user?.opaqueMailboxId,
        user?.mailboxId,
        grant?.opaqueMailboxId,
        grant?.mailboxId,
        metadata.opaqueMailboxId,
        metadata.mailboxId
      ),
      orgId: firstString(subject.orgId, user?.orgId, grant?.orgId, metadata.orgId),
      teamIds: stringsFrom(subject.teamIds, user?.teamIds, grant?.teamIds, metadata.teamIds),
      departmentIds: stringsFrom(subject.departmentIds, user?.departmentIds, grant?.departmentIds, metadata.departmentIds),
      allowedAccountIds: stringsFrom(
        subject.allowedAccountIds,
        user?.allowedAccountIds,
        grant?.allowedAccountIds,
        metadata.allowedAccountIds
      ),
      allowedEndpointIds: stringsFrom(
        subject.allowedEndpointIds,
        user?.allowedEndpointIds,
        grant?.allowedEndpointIds,
        metadata.allowedEndpointIds
      ),
      allowedOpaqueMailboxIds: stringsFrom(
        subject.allowedOpaqueMailboxIds,
        subject.allowedMailboxIds,
        user?.allowedOpaqueMailboxIds,
        user?.allowedMailboxIds,
        grant?.allowedOpaqueMailboxIds,
        grant?.allowedMailboxIds,
        metadata.allowedOpaqueMailboxIds,
        metadata.allowedMailboxIds
      ),
      allowedWorkspaceIds: stringsFrom(
        subject.allowedWorkspaceIds,
        user?.allowedWorkspaceIds,
        grant?.allowedWorkspaceIds,
        metadata.allowedWorkspaceIds
      ),
      allowedDataClasses: stringsFrom(
        subject.allowedDataClasses,
        user?.allowedDataClasses,
        grant?.allowedDataClasses,
        metadata.allowedDataClasses
      ),
      allowedEgress: stringsFrom(subject.allowedEgress, user?.allowedEgress, grant?.allowedEgress, metadata.allowedEgress),
      allowedStaticSemanticFamilies: stringsFrom(subject.allowedStaticSemanticFamilies, user?.allowedStaticSemanticFamilies, grant?.allowedStaticSemanticFamilies, metadata.allowedStaticSemanticFamilies),
      allowedCapabilityDomains: stringsFrom(subject.allowedCapabilityDomains, user?.allowedCapabilityDomains, grant?.allowedCapabilityDomains, metadata.allowedCapabilityDomains),
      allowedCapabilityVerbs: stringsFrom(subject.allowedCapabilityVerbs, user?.allowedCapabilityVerbs, grant?.allowedCapabilityVerbs, metadata.allowedCapabilityVerbs),
      allowedResourceKinds: stringsFrom(subject.allowedResourceKinds, user?.allowedResourceKinds, grant?.allowedResourceKinds, metadata.allowedResourceKinds),
      allowedEffectKinds: stringsFrom(subject.allowedEffectKinds, user?.allowedEffectKinds, grant?.allowedEffectKinds, metadata.allowedEffectKinds),
      allowedServiceIds: stringsFrom(subject.allowedServiceIds, user?.allowedServiceIds, grant?.allowedServiceIds, metadata.allowedServiceIds),
      allowedSecretBindings: stringsFrom(subject.allowedSecretBindings, user?.allowedSecretBindings, grant?.allowedSecretBindings, metadata.allowedSecretBindings),
      attributes
    };
  }
  if (grant) {
    return {
      type: "tool-grant",
      subjectId: String(grant.id || ""),
      username: String(grant.label || grant.id || ""),
      roleId: "tool-grant",
      scopes: uniqueStrings(grant.scopes || []),
      capabilities: subjectCapabilities({}, actor, authSession, grant),
      agentProfileId: "",
      maxRisk: grant.maxRisk || grant.metadata?.maxRisk || "",
      tenantId: firstString(grant.tenantId, metadata.tenantId),
      accountId: firstString(grant.accountId, metadata.accountId),
      endpointId: firstString(grant.endpointId, metadata.endpointId),
      opaqueMailboxId: firstString(grant.opaqueMailboxId, grant.mailboxId, metadata.opaqueMailboxId, metadata.mailboxId),
      orgId: firstString(grant.orgId, metadata.orgId),
      teamIds: stringsFrom(grant.teamIds, metadata.teamIds),
      departmentIds: stringsFrom(grant.departmentIds, metadata.departmentIds),
      allowedAccountIds: stringsFrom(grant.allowedAccountIds, metadata.allowedAccountIds),
      allowedEndpointIds: stringsFrom(grant.allowedEndpointIds, metadata.allowedEndpointIds),
      allowedOpaqueMailboxIds: stringsFrom(
        grant.allowedOpaqueMailboxIds,
        grant.allowedMailboxIds,
        metadata.allowedOpaqueMailboxIds,
        metadata.allowedMailboxIds
      ),
      allowedWorkspaceIds: stringsFrom(grant.allowedWorkspaceIds, metadata.allowedWorkspaceIds),
      allowedDataClasses: stringsFrom(grant.allowedDataClasses, metadata.allowedDataClasses),
      allowedEgress: stringsFrom(grant.allowedEgress, metadata.allowedEgress),
      allowedStaticSemanticFamilies: stringsFrom(grant.allowedStaticSemanticFamilies, metadata.allowedStaticSemanticFamilies),
      allowedCapabilityDomains: stringsFrom(grant.allowedCapabilityDomains, metadata.allowedCapabilityDomains),
      allowedCapabilityVerbs: stringsFrom(grant.allowedCapabilityVerbs, metadata.allowedCapabilityVerbs),
      allowedResourceKinds: stringsFrom(grant.allowedResourceKinds, metadata.allowedResourceKinds),
      allowedEffectKinds: stringsFrom(grant.allowedEffectKinds, metadata.allowedEffectKinds),
      allowedServiceIds: stringsFrom(grant.allowedServiceIds, metadata.allowedServiceIds),
      allowedSecretBindings: stringsFrom(grant.allowedSecretBindings, metadata.allowedSecretBindings),
      attributes
    };
  }
  if (user) {
    return {
      type: "console-user",
      subjectId: String(user.userId || user.username || ""),
      username: String(user.username || user.userId || ""),
      roleId: String(user.roleId || ""),
      scopes: uniqueStrings(user.scopes || []),
      capabilities: subjectCapabilities({}, actor, authSession, grant),
      agentProfileId: "",
      maxRisk: "",
      tenantId: firstString(user.tenantId),
      accountId: firstString(user.accountId, user.userId),
      endpointId: firstString(user.endpointId),
      opaqueMailboxId: firstString(user.opaqueMailboxId, user.mailboxId),
      orgId: firstString(user.orgId),
      teamIds: stringsFrom(user.teamIds),
      departmentIds: stringsFrom(user.departmentIds),
      allowedAccountIds: stringsFrom(user.allowedAccountIds),
      allowedEndpointIds: stringsFrom(user.allowedEndpointIds),
      allowedOpaqueMailboxIds: stringsFrom(
        user.allowedOpaqueMailboxIds,
        user.allowedMailboxIds
      ),
      allowedWorkspaceIds: stringsFrom(user.allowedWorkspaceIds),
      allowedDataClasses: stringsFrom(user.allowedDataClasses),
      allowedEgress: stringsFrom(user.allowedEgress),
      allowedStaticSemanticFamilies: stringsFrom(user.allowedStaticSemanticFamilies),
      allowedCapabilityDomains: stringsFrom(user.allowedCapabilityDomains),
      allowedCapabilityVerbs: stringsFrom(user.allowedCapabilityVerbs),
      allowedResourceKinds: stringsFrom(user.allowedResourceKinds),
      allowedEffectKinds: stringsFrom(user.allowedEffectKinds),
      allowedServiceIds: stringsFrom(user.allowedServiceIds),
      allowedSecretBindings: stringsFrom(user.allowedSecretBindings),
      attributes
    };
  }
  if (actor) {
    return {
      type: actor.type || "actor",
      subjectId: String(actor.userId || actor.subjectId || actor.id || actor.username || ""),
      username: String(actor.username || actor.label || ""),
      roleId: String(actor.roleId || ""),
      scopes: uniqueStrings(actor.scopes || []),
      capabilities: subjectCapabilities({}, actor, authSession, grant),
      agentProfileId: String(actor.agentProfileId || ""),
      maxRisk: actor.maxRisk || "",
      tenantId: firstString(actor.tenantId),
      accountId: firstString(actor.accountId, actor.userId),
      endpointId: firstString(actor.endpointId),
      opaqueMailboxId: firstString(actor.opaqueMailboxId, actor.mailboxId),
      orgId: firstString(actor.orgId),
      teamIds: stringsFrom(actor.teamIds),
      departmentIds: stringsFrom(actor.departmentIds),
      allowedAccountIds: stringsFrom(actor.allowedAccountIds),
      allowedEndpointIds: stringsFrom(actor.allowedEndpointIds),
      allowedOpaqueMailboxIds: stringsFrom(
        actor.allowedOpaqueMailboxIds,
        actor.allowedMailboxIds
      ),
      allowedWorkspaceIds: stringsFrom(actor.allowedWorkspaceIds),
      allowedDataClasses: stringsFrom(actor.allowedDataClasses),
      allowedEgress: stringsFrom(actor.allowedEgress),
      allowedStaticSemanticFamilies: stringsFrom(actor.allowedStaticSemanticFamilies),
      allowedCapabilityDomains: stringsFrom(actor.allowedCapabilityDomains),
      allowedCapabilityVerbs: stringsFrom(actor.allowedCapabilityVerbs),
      allowedResourceKinds: stringsFrom(actor.allowedResourceKinds),
      allowedEffectKinds: stringsFrom(actor.allowedEffectKinds),
      allowedServiceIds: stringsFrom(actor.allowedServiceIds),
      allowedSecretBindings: stringsFrom(actor.allowedSecretBindings),
      attributes
    };
  }
  return {
    type: "anonymous",
    subjectId: "",
    username: "",
    roleId: "",
    scopes: [],
    capabilities: [],
    agentProfileId: "",
    maxRisk: "",
    tenantId: "",
    accountId: "",
    endpointId: "",
    opaqueMailboxId: "",
    orgId: "",
    teamIds: [],
    departmentIds: [],
    allowedAccountIds: [],
    allowedEndpointIds: [],
    allowedOpaqueMailboxIds: [],
    allowedWorkspaceIds: [],
    allowedDataClasses: [],
    allowedEgress: [],
    allowedStaticSemanticFamilies: [],
    allowedCapabilityDomains: [],
    allowedCapabilityVerbs: [],
    allowedResourceKinds: [],
    allowedEffectKinds: [],
    allowedServiceIds: [],
    allowedSecretBindings: [],
    attributes: {}
  };
}
