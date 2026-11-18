import { approvalAlreadySatisfiesPolicy, approvalLayers, policyRevisionSummary } from "./runtime-common.ts";

export async function evaluateCurrentExecutionApproval({
  currentPolicy, trustedApproval, approvalOperationBinding, securityPermissions, context = {}, tool
}: Record<string, any>): Promise<any> {
  const currentPolicySummary = policyRevisionSummary(currentPolicy);
  const capturedApproval = trustedApproval?.status === "approved" &&
    Boolean(trustedApproval.expiresAt) && Date.parse(trustedApproval.expiresAt) > Date.now()
    ? trustedApproval : null;
  const requiredApprovalLayers = approvalLayers(capturedApproval || {});
  const approvalActorId = String(capturedApproval?.requiredApproval?.operationBinding?.approvalActorId || "");
  const resolvedBy = String(capturedApproval?.resolvedBy || context?.approval?.resolvedBy || "");
  const approvalActorCurrent = Boolean(capturedApproval && approvalActorId && resolvedBy && approvalActorId === resolvedBy);
  let governanceApprovalCurrent = requiredApprovalLayers.length === 0 && approvalActorCurrent;
  if (capturedApproval && requiredApprovalLayers.length > 0) {
    if (typeof securityPermissions?.getGovernanceApproval !== "function") {
      return { ok: false, status: 503, reasonCode: "governance_approval_store_unavailable", error: "Governance approval store is unavailable." };
    }
    const current = await securityPermissions.getGovernanceApproval(`pending-${capturedApproval.pendingOperationId}`);
    const layers = approvalLayers(current || {});
    governanceApprovalCurrent = Boolean(
      current?.effect === "allow" && !current.revokedAt && current.expiresAt &&
      Date.parse(current.expiresAt) > Date.now() && approvalActorCurrent &&
      layers.every((layer: any) => requiredApprovalLayers.includes(layer)) &&
      requiredApprovalLayers.every((layer: any) => layers.includes(layer))
    );
  }
  const currentApproval = capturedApproval && governanceApprovalCurrent ? capturedApproval : null;
  const binding = currentApproval?.requiredApproval?.operationBinding;
  if (trustedApproval && (!binding || binding.bindingDigest !== approvalOperationBinding?.bindingDigest ||
      Number(binding.policyRevision?.grantPolicyRevision || 0) !== currentPolicySummary.grantPolicyRevision ||
      Number(binding.policyRevision?.governancePolicyRevision || 0) !== currentPolicySummary.governancePolicyRevision.revision)) {
    return { ok: false, status: 409, reasonCode: "pending_approval_binding_stale", error: "Pending approval no longer matches the current authorization policy." };
  }
  const approvalSatisfiesPolicy = approvalAlreadySatisfiesPolicy(currentPolicy, currentApproval);
  const governanceApprovalSatisfied = ["needsApproval", "require_approval"].includes(currentPolicy.effect) && approvalSatisfiesPolicy;
  const toolApprovalSatisfied = tool.requiresApproval !== true || Boolean(currentApproval);
  const allowed = currentPolicy.effect === "allow" ||
    (currentPolicy.effect === "require_confirmation" && Boolean(currentApproval)) || governanceApprovalSatisfied;
  if (!allowed || !toolApprovalSatisfied) {
    return {
      ok: false, status: currentPolicy.effect === "require_confirmation" ? 409 : 403,
      reasonCode: currentPolicy.reasonCode || "execution_policy_denied",
      error: currentPolicy.redactedReason || "Tool execution policy denied.", authorizationDecision: currentPolicy
    };
  }
  return {
    ok: true,
    authorizationDecision: Object.freeze({
      ...currentPolicy, allowed: true,
      approvalSatisfied: Boolean(currentApproval && (toolApprovalSatisfied || approvalSatisfiesPolicy))
    })
  };
}
