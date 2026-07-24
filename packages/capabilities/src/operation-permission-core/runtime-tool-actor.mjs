import { uniqueStrings } from "./runtime-common.mjs";

export function toolActorFromAuthorization({
  authorization,
  trustedApproval,
  operation,
  tool
}) {
  const grant = authorization.grant;
  const grantScopes = uniqueStrings(grant.scopes || []);
  const operationRequiredScopeSet = new Set(operation.requiredScopes || []);
  const approvedScopes = trustedApproval
    ? uniqueStrings([trustedApproval.approvalScope, operation.safety?.approvalScope, tool.approvalScope])
        .filter((scope) => scope && (!operationRequiredScopeSet.has(scope) || grantScopes.includes(scope)))
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
