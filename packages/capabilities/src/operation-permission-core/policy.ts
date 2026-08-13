function nowIso() : any {
  return new Date().toISOString();
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function revisionNumber(value?: any) : any {
  const parsed: any = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function grantPolicyRevision(grant: any = null) : any {
  const metadata: any = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return revisionNumber(grant?.policyRevision || grant?.policy_revision || metadata.policyRevision || metadata.policy_revision);
}

function grantPolicyState(currentRevision: Record<string, any> = {}, grant: any = null) : any {
  const current: any = revisionNumber(currentRevision?.revision);
  const grantRevision: any = grantPolicyRevision(grant);
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
}: Record<string, any>) : any {
  async function evaluateLocal({
    tool,
    grant = null,
    restriction = null,
    subject = null,
    credentialKind = "",
    profile = null,
    input = {},
    request = null,
    context = {},
    dryRun = false,
    traceId = "",
    toolExecutionId = ""
  }: Record<string, any> = {}) : Promise<any> {
    const evaluatedLayers: any = [
      "platform_default",
      "server_policy",
      grant ? "grant_policy" : restriction ? "credential_policy" : "",
      profile ? "agent_profile_policy" : "",
      "session_task_policy",
      "runtime_safety_policy"
    ].filter(Boolean);
    const authorizationDecision: any = (typeof securityPermissions?.evaluatePolicy === "function"
      ? await securityPermissions.evaluatePolicy({
          tool,
          grant,
          restriction,
          subject,
          credentialKind,
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
    const governancePolicyRevision: any = securityPermissions?.getGovernancePolicyRevision?.() ||
      authorizationDecision.effectivePolicySnapshot?.policyRevision ||
      null;
    const decision: Record<string, any> = {
      ...authorizationDecision,
      decisionId: `policy_${cryptoRandomSuffix()}`,
      toolExecutionId,
      traceId,
      toolId: tool?.id || "",
      grantId: grant?.id || "",
      credentialId: restriction?.credentialId || "",
      credentialKind: credentialKind || restriction?.credentialKind || "",
      credentialPolicyFingerprint: restriction?.policyFingerprint || "",
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
        await store.appendPolicyDecision(decision);
      }
    }
    return decision;
  }

  async function evaluate(input: Record<string, any> = {}) : Promise<any> {
    return evaluateLocal(input);
  }

  async function preview(input: Record<string, any> = {}) : Promise<any> {
    const tool: any = registry.getTool(input.toolId);
    const grant: any = input.grantId ? await store.getRawGrant(input.grantId) : input.grant || null;
    const profile: any = input.profileId
      ? registry.listProfiles().find((item?: any) : any => item.id === input.profileId)
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

function cryptoRandomSuffix() : any {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
