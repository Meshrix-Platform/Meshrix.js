import { authorizationPolicy, authorizationSubject, uniqueStrings } from "./runtime-common.ts";

export function toolActorFromAuthorization({
  authorization,
  trustedApproval,
  operation,
  tool
}: Record<string, any>) : any {
  const policy: any = authorizationPolicy(authorization) || {};
  const subject: any = authorizationSubject(authorization);
  const grantScopes: any = uniqueStrings(policy.scopes || subject.scopes || []);
  const operationRequiredScopeSet: any = new Set<any>(operation.requiredScopes || []);
  const approvedScopes: any = trustedApproval
    ? uniqueStrings([trustedApproval.approvalScope, operation.safety?.approvalScope, tool.approvalScope])
        .filter((scope?: any) : any => scope && (!operationRequiredScopeSet.has(scope) || grantScopes.includes(scope)))
    : [];
  const tenantId: any = String(
    subject.tenantId ||
    policy.metadata?.organizationNodeId ||
    policy.metadata?.tenantId ||
    (subject.type === "tool-grant" ? "local" : "")
  );
  return {
    type: subject.type,
    userId: subject.subjectId,
    username: subject.username || subject.subjectId,
    roleId: subject.roleId || subject.type,
    tenantId,
    organizationNodeId: subject.organizationNodeId || "",
    allowedWorkspaceIds: uniqueStrings(policy.allowedWorkspaceIds || subject.allowedWorkspaceIds || []),
    workspaceIds: uniqueStrings(policy.allowedWorkspaceIds || subject.allowedWorkspaceIds || []),
    capabilities: uniqueStrings(policy.capabilities || subject.capabilities || []),
    dynamicCapabilities: uniqueStrings(policy.dynamicCapabilities || policy.capabilities || policy.metadata?.dynamicCapabilities || []),
    maxRisk: String(policy.maxRisk || subject.maxRisk || ""),
    allowedDataClasses: uniqueStrings(policy.allowedDataClasses || subject.allowedDataClasses || []),
    allowedEgress: uniqueStrings(policy.allowedEgress || subject.allowedEgress || []),
    allowedStaticSemanticFamilies: uniqueStrings(policy.allowedStaticSemanticFamilies || subject.allowedStaticSemanticFamilies || []),
    allowedCapabilityDomains: uniqueStrings(policy.allowedCapabilityDomains || subject.allowedCapabilityDomains || []),
    allowedCapabilityVerbs: uniqueStrings(policy.allowedCapabilityVerbs || subject.allowedCapabilityVerbs || []),
    allowedResourceKinds: uniqueStrings(policy.allowedResourceKinds || subject.allowedResourceKinds || []),
    allowedEffectKinds: uniqueStrings(policy.allowedEffectKinds || subject.allowedEffectKinds || []),
    allowedServiceIds: uniqueStrings(policy.allowedServiceIds || policy.metadata?.allowedServiceIds || []),
    allowedSecretBindings: uniqueStrings(policy.allowedSecretBindings || policy.metadata?.allowedSecretBindings || []),
    scopes: uniqueStrings([
      ...grantScopes,
      ...policy.scopeIds || [],
      ...approvedScopes
    ])
  };
}
