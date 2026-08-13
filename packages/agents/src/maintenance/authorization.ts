const AUTHORIZATION_PROTOCOL_VERSION: any =
  "v0.0.1:maintenance-agent:workload-authorization-1";
const DEFAULT_AUTHORIZATION_TTL_MS: any = 15 * 60 * 1000;
const MAX_AUTHORIZATION_TTL_MS: any = 60 * 60 * 1000;
const SHA256_HEX: any = /^[a-f0-9]{64}$/u;

function text(value?: any) : any {
  return String(value || "").trim();
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>((Array.isArray(values) ? values : [])
    .map((value?: any) : any => text(value))
    .filter(Boolean))].sort();
}

function revision(value?: any) : any {
  const parsed: any = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function controlledError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function grantPolicyRevision(grant: Record<string, any> = {}) : any {
  return revision(grant.policyRevision || grant.metadata?.policyRevision);
}

function governanceRevisionFromAuthorization(authorization: Record<string, any> = {}) : any {
  return revision(
    authorization.policy?.governancePolicyRevision?.revision ||
    authorization.governancePolicyRevision?.revision
  );
}

function boundedExpiry({ grant, authorization, nowMs, ttlMs }: Record<string, any>) : any {
  const candidates: any = [
    nowMs + ttlMs,
    Date.parse(text(grant.expiresAt)),
    Date.parse(text(authorization.approvedPendingOperation?.expiresAt))
  ].filter((value?: any) : any => Number.isFinite(value) && value > nowMs);
  if (candidates.length === 0) {
    throw controlledError(
      "maintenance_authorization_expiry_missing",
      "Maintenance execution authorization requires a current expiry."
    );
  }
  return new Date(Math.min(...candidates)).toISOString();
}

function requireCurrentGrant(grant?: any, requiredScope?: any) : any {
  if (
    !grant ||
    !text(grant.id) ||
    grant.enabled === false ||
    text(grant.revokedAt) ||
    grant.policyIntegrity?.valid === false ||
    grant.ownerIntegrity?.valid === false
  ) {
    throw controlledError(
      "maintenance_grant_inactive",
      "Maintenance execution Grant is not active."
    );
  }
  if (text(grant.expiresAt) && Date.parse(grant.expiresAt) <= Date.now()) {
    throw controlledError(
      "maintenance_grant_expired",
      "Maintenance execution Grant has expired."
    );
  }
  const scopes: any = uniqueStrings(grant.scopes);
  if (!scopes.includes(requiredScope)) {
    throw controlledError(
      "maintenance_grant_scope_denied",
      "Maintenance execution Grant does not contain the required scope."
    );
  }
  if (!text(grant.projectionFingerprint)) {
    throw controlledError(
      "maintenance_grant_projection_missing",
      "Maintenance execution Grant has no current policy projection."
    );
  }
  if (!grantPolicyRevision(grant)) {
    throw controlledError(
      "maintenance_grant_revision_missing",
      "Maintenance execution Grant has no policy revision."
    );
  }
  return scopes;
}

export function createMaintenanceAuthorizationAuthority({
  operationPermissionStore,
  getGovernancePolicyRevision,
  now = () : any => Date.now(),
  authorizationTtlMs = DEFAULT_AUTHORIZATION_TTL_MS
}: Record<string, any> = {}) : any {
  if (!operationPermissionStore || typeof operationPermissionStore.getGrant !== "function") {
    throw new TypeError("Maintenance authorization requires the current Grant store.");
  }
  if (typeof getGovernancePolicyRevision !== "function") {
    throw new TypeError("Maintenance authorization requires the current governance policy revision.");
  }
  const ttlMs: any = Math.max(
    1,
    Math.min(MAX_AUTHORIZATION_TTL_MS, Number(authorizationTtlMs) || DEFAULT_AUTHORIZATION_TTL_MS)
  );

  async function capture({
    operationAuthorization,
    configuredGrantId = "",
    requiredScope = "maintenance:run",
    plannedOperationIds = [],
    planHash = ""
  }: Record<string, any> = {}) : Promise<any> {
    const authorization: any = operationAuthorization &&
      typeof operationAuthorization === "object" &&
      !Array.isArray(operationAuthorization)
      ? operationAuthorization
      : {};
    const authorizedGrant: any = authorization.grant || {};
    const grantId: any = text(authorizedGrant.id || configuredGrantId);
    const configured: any = Boolean(text(configuredGrantId));
    if ((!configured && authorization.ok !== true) || !grantId) {
      throw controlledError(
        "maintenance_current_grant_required",
        "Maintenance execution requires an authorized current Grant."
      );
    }
    const grant: any = await operationPermissionStore.getGrant(grantId);
    const scopes: any = requireCurrentGrant(grant, requiredScope);
    if (
      text(authorizedGrant.projectionFingerprint) &&
      text(authorizedGrant.projectionFingerprint) !== text(grant.projectionFingerprint)
    ) {
      throw controlledError(
        "maintenance_grant_projection_changed",
        "Maintenance execution Grant changed before admission."
      );
    }
    const currentGovernance: any = await Promise.resolve(getGovernancePolicyRevision());
    const currentGovernanceRevision: any = revision(currentGovernance?.revision);
    const authorizedGovernanceRevision: any = configured
      ? currentGovernanceRevision
      : governanceRevisionFromAuthorization(authorization);
    if (
      !currentGovernanceRevision ||
      !authorizedGovernanceRevision ||
      currentGovernanceRevision !== authorizedGovernanceRevision
    ) {
      throw controlledError(
        "maintenance_policy_revision_stale",
        "Maintenance execution policy revision is not current."
      );
    }
    const nowMs: any = now();
    const normalizedPlanHash: any = text(planHash).toLowerCase();
    if (!SHA256_HEX.test(normalizedPlanHash)) {
      throw controlledError(
        "maintenance_plan_hash_invalid",
        "Maintenance execution authorization requires the exact plan hash."
      );
    }
    return Object.freeze({
      protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
      workloadPrincipal: Object.freeze({
        subjectType: "agent-profile",
        subjectId: "maintenance-agent",
        agentId: "maintenance-agent",
        profileId: "maintenance-agent"
      }),
      grant: Object.freeze({
        grantId,
        projectionFingerprint: text(grant.projectionFingerprint),
        policyRevision: grantPolicyRevision(grant),
        updatedAt: text(grant.updatedAt)
      }),
      policy: Object.freeze({
        decisionId: configured
          ? "configured-maintenance-workload-grant"
          : text(authorization.policy?.decisionId),
        governanceRevision: currentGovernanceRevision
      }),
      scope: Object.freeze({
        requiredScope,
        grantedScopes: Object.freeze(scopes),
        plannedOperationIds: Object.freeze(uniqueStrings(plannedOperationIds))
      }),
      planHash: normalizedPlanHash,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: boundedExpiry({ grant, authorization, nowMs, ttlMs })
    });
  }

  async function revalidate(
    binding?: any,
    { requiredScope = "maintenance:run", planHash = "" }: Record<string, any> = {}
  ) : Promise<any> {
    if (
      !binding ||
      binding.protocolVersion !== AUTHORIZATION_PROTOCOL_VERSION ||
      text(binding.scope?.requiredScope) !== requiredScope ||
      text(binding.workloadPrincipal?.subjectId) !== "maintenance-agent" ||
      text(binding.workloadPrincipal?.profileId) !== "maintenance-agent" ||
      !SHA256_HEX.test(text(binding.planHash).toLowerCase()) ||
      text(binding.planHash).toLowerCase() !== text(planHash).toLowerCase()
    ) {
      throw controlledError(
        "maintenance_authorization_binding_invalid",
        "Maintenance execution authorization binding is invalid."
      );
    }
    const expiresAtMs: any = Date.parse(text(binding.expiresAt));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
      throw controlledError(
        "maintenance_authorization_expired",
        "Maintenance execution authorization has expired."
      );
    }
    const grant: any = await operationPermissionStore.getGrant(text(binding.grant?.grantId));
    requireCurrentGrant(grant, requiredScope);
    if (
      text(grant.projectionFingerprint) !== text(binding.grant?.projectionFingerprint) ||
      grantPolicyRevision(grant) !== revision(binding.grant?.policyRevision) ||
      text(grant.updatedAt) !== text(binding.grant?.updatedAt)
    ) {
      throw controlledError(
        "maintenance_grant_changed",
        "Maintenance execution Grant changed after admission."
      );
    }
    const currentGovernance: any = await Promise.resolve(getGovernancePolicyRevision());
    if (
      revision(currentGovernance?.revision) !== revision(binding.policy?.governanceRevision)
    ) {
      throw controlledError(
        "maintenance_policy_changed",
        "Maintenance execution policy changed after admission."
      );
    }
    return Object.freeze({
      ok: true,
      workloadPrincipal: binding.workloadPrincipal,
      grant,
      binding
    });
  }

  return Object.freeze({
    protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
    capture,
    revalidate
  });
}
