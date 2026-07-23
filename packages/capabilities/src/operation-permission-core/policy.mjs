function nowIso() {
  return new Date().toISOString();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function revisionNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function grantPolicyRevision(grant = null) {
  const metadata = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return revisionNumber(grant?.policyRevision || grant?.policy_revision || metadata.policyRevision || metadata.policy_revision);
}

function grantPolicyState(currentRevision = {}, grant = null) {
  const current = revisionNumber(currentRevision?.revision);
  const grantRevision = grantPolicyRevision(grant);
  if (!current) {
    return "unversioned";
  }
  if (!grant) {
    return "no-grant";
  }
  if (!grantRevision) {
    return "stale";
  }
  return grantRevision >= current ? "fresh" : "stale";
}

export function createToolPolicyEngine({
  registry,
  store,
  securityPermissions = null
}) {
  async function evaluateLocal({
    tool,
    grant = null,
    profile = null,
    input = {},
    request = null,
    context = {},
    dryRun = false,
    traceId = "",
    toolExecutionId = ""
  } = {}) {
    const evaluatedLayers = [
      "platform_default",
      "server_policy",
      grant ? "grant_policy" : "",
      profile ? "agent_profile_policy" : "",
      "session_task_policy",
      "runtime_safety_policy"
    ].filter(Boolean);
    const authorizationDecision = (typeof securityPermissions?.evaluatePolicy === "function"
      ? securityPermissions.evaluatePolicy({
          tool,
          grant,
          profile,
          input,
          request,
          context: {
            ...context,
            toolExpected: true
          },
          dryRun,
          traceId,
          toolExecutionId,
          grantRequired: true
        })
      : null) || {
          effect: "deny",
          allowed: false,
          reasonCode: "authorization_provider_unavailable",
          redactedReason: "Security permissions provider is unavailable.",
          missingScopes: [],
          missingToolsets: [],
          evaluatedLayers: [],
          createdAt: nowIso()
        };
    const governancePolicyRevision = securityPermissions?.getGovernancePolicyRevision?.() ||
      authorizationDecision.effectivePolicySnapshot?.policyRevision ||
      null;
    const decision = {
      ...authorizationDecision,
      decisionId: `policy_${cryptoRandomSuffix()}`,
      toolExecutionId,
      traceId,
      toolId: tool?.id || "",
      grantId: grant?.id || "",
      missingScopes: uniqueStrings(authorizationDecision.missingScopes || []),
      missingToolsets: authorizationDecision.effect === "deny"
        ? uniqueStrings(authorizationDecision.missingToolsets || [])
        : [],
      governancePolicyRevision,
      grantPolicyRevision: grantPolicyRevision(grant),
      grantPolicyState: grantPolicyState(governancePolicyRevision, grant),
      evaluatedLayers: uniqueStrings([...(authorizationDecision.evaluatedLayers || []), ...evaluatedLayers]),
      createdAt: authorizationDecision.createdAt || nowIso()
    };

    if (store) {
      if (typeof store.appendPolicyDecisionAnchored === "function") {
        await store.appendPolicyDecisionAnchored(decision);
      } else {
        store.appendPolicyDecision(decision);
      }
    }
    return decision;
  }

  async function evaluate(input = {}) {
    return evaluateLocal(input);
  }

  async function preview(input = {}) {
    const tool = registry.getTool(input.toolId);
    const grant = input.grantId ? store.getRawGrant(input.grantId) : input.grant || null;
    const profile = input.profileId
      ? registry.listProfiles().find((item) => item.id === input.profileId)
      : input.profile || null;
    return evaluate({
      tool,
      grant,
      profile,
      input: input.input || {},
      context: input.context || {},
      dryRun: input.dryRun === true
    });
  }

  return {
    evaluate,
    preview
  };
}

function cryptoRandomSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
