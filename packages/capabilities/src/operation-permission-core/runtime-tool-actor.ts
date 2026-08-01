import { uniqueStrings } from "./runtime-common.ts";

export function toolActorFromAuthorization({
  authorization,
  trustedApproval,
  operation,
  tool
}: Record<string, any>) : any {
  const grant: any = authorization.grant;
  const grantScopes: any = uniqueStrings(grant.scopes || []);
  const operationRequiredScopeSet: any = new Set<any>(operation.requiredScopes || []);
  const approvedScopes: any = trustedApproval
    ? uniqueStrings([trustedApproval.approvalScope, operation.safety?.approvalScope, tool.approvalScope])
        .filter((scope?: any) : any => scope && (!operationRequiredScopeSet.has(scope) || grantScopes.includes(scope)))
    : [];
  return {
    type: "tool-grant",
    userId: grant.id,
    username: grant.label || grant.id,
    roleId: "tool-grant",
    allowedWorkspaceIds: uniqueStrings(grant.allowedWorkspaceIds || []),
    workspaceIds: uniqueStrings(grant.allowedWorkspaceIds || []),
    dynamicCapabilities: uniqueStrings(grant.dynamicCapabilities || grant.metadata?.dynamicCapabilities || []),
    allowedServiceIds: uniqueStrings(grant.allowedServiceIds || grant.metadata?.allowedServiceIds || []),
    allowedSecretBindings: uniqueStrings(grant.allowedSecretBindings || grant.metadata?.allowedSecretBindings || []),
    scopes: uniqueStrings([
      ...grantScopes,
      ...approvedScopes
    ])
  };
}
