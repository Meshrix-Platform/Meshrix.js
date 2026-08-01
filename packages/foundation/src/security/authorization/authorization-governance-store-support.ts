import crypto from "node:crypto";

export const DEFAULT_ROLES: Readonly<Record<string, any>> = Object.freeze({
  owner: { roleId: "owner", label: "Owner", scopes: [] },
  admin: { roleId: "admin", label: "Admin", scopes: [] },
  operator: { roleId: "operator", label: "Operator", scopes: [] },
  viewer: { roleId: "viewer", label: "Viewer", scopes: [] }
});

const WRITE_ACTION_RE: any = /\.(prepare|upload|write|create|update|delete|move|push|approve|requestChanges|comment|submit|maintain|rebase|merge|abandon|restore|review)\b|:write|:maintain|:approve|:review|:admin/;

export function nowIso() : any {
  return new Date().toISOString();
}

export function randomId(prefix?: any) : any {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson(value?: any, fallback?: any) : any {
  try {
    const parsed: any = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: any, fallback: any = null) : any {
  return JSON.stringify(value ?? fallback);
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function stringsFrom(...values: any[]) : any {
  const output: any[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      output.push(...value);
    } else if (typeof value === "string" && value.includes(",")) {
      output.push(...value.split(","));
    } else if (value !== undefined && value !== null) {
      output.push(value);
    }
  }
  return uniqueStrings(output);
}

export function objectOrNull(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function firstString(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function normalizeId(value?: any, fallbackPrefix?: any) : any {
  const text: any = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  }
  return randomId(fallbackPrefix);
}

export function normalizePolicyList(value: any = []) : any {
  const input: any = Array.isArray(value) ? value : value?.policies || value?.resourcePolicies || [];
  return (Array.isArray(input) ? input : []).map((entry?: any) : any => {
    const resource: any = objectOrNull(entry.resource) || {};
    return {
      resourceType: String(entry.resourceType || entry.type || resource.type || "*").trim() || "*",
      resourceId: String(entry.resourceId || entry.id || entry.repoId || entry.repositoryRef || resource.id || "*").trim() || "*",
      actions: uniqueStrings(entry.actions || entry.action || entry.scopes || []),
      targetProviders: uniqueStrings(entry.targetProviders || entry.providers || entry.provider || entry.targets || []),
      label: String(entry.label || "").trim()
    };
  }).filter((entry?: any) : any => entry.actions.length > 0);
}

export function normalizeUserPolicy(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const userId: any = normalizeId(input.userId || input.subjectId || input.id || fallback.userId, "user");
  const timestamp: any = nowIso();
  return {
    userId,
    roleIds: uniqueStrings(input.roleIds || input.roles || fallback.roleIds || []),
    teamIds: uniqueStrings(input.teamIds || input.teams || fallback.teamIds || []),
    departmentIds: uniqueStrings(input.departmentIds || input.departments || fallback.departmentIds || []),
    enabled: input.enabled !== false,
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || timestamp),
    updatedAt: timestamp
  };
}

export function normalizeApproval(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const approvalId: any = normalizeId(input.approvalId || input.id || fallback.approvalId, "approval");
  const timestamp: any = nowIso();
  return {
    approvalId,
    userId: String(input.userId || input.subjectId || fallback.userId || "").trim(),
    agentId: String(input.agentId || fallback.agentId || "").trim(),
    resourceType: String(input.resourceType || fallback.resourceType || "*").trim() || "*",
    resourceId: String(input.resourceId || input.repoId || input.repositoryRef || fallback.resourceId || "*").trim() || "*",
    actions: uniqueStrings(input.actions || input.action || fallback.actions || []),
    targetProviders: uniqueStrings(input.targetProviders || input.provider || input.providers || fallback.targetProviders || []),
    teamIds: uniqueStrings(input.teamIds || input.teams || fallback.teamIds || []),
    departmentIds: uniqueStrings(input.departmentIds || input.departments || fallback.departmentIds || []),
    approvalLayers: uniqueStrings(input.approvalLayers || input.approvalLayer || input.layers || fallback.approvalLayers || []),
    grantKind: String(input.grantKind || input.kind || fallback.grantKind || "once").trim(),
    effect: String(input.effect || fallback.effect || "allow").trim(),
    expiresAt: String(input.expiresAt || fallback.expiresAt || "").trim(),
    revokedAt: String(input.revokedAt || fallback.revokedAt || "").trim(),
    reason: String(input.reason || fallback.reason || "").trim(),
    createdAt: String(fallback.createdAt || input.createdAt || timestamp),
    updatedAt: timestamp
  };
}

export function ensureSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS authorization_user_policies (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      role_ids_json TEXT NOT NULL DEFAULT '[]',
      team_ids_json TEXT NOT NULL DEFAULT '[]',
      department_ids_json TEXT NOT NULL DEFAULT '[]',
      resource_policies_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorization_approval_grants (
      approval_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      resource_type TEXT NOT NULL DEFAULT '*',
      resource_id TEXT NOT NULL DEFAULT '*',
      actions_json TEXT NOT NULL DEFAULT '[]',
      target_providers_json TEXT NOT NULL DEFAULT '[]',
      team_ids_json TEXT NOT NULL DEFAULT '[]',
      department_ids_json TEXT NOT NULL DEFAULT '[]',
      approval_layers_json TEXT NOT NULL DEFAULT '[]',
      grant_kind TEXT NOT NULL DEFAULT 'once',
      effect TEXT NOT NULL DEFAULT 'allow',
      expires_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorization_governance_events (
      event_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_authorization_approvals_user ON authorization_approval_grants(user_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_approvals_agent ON authorization_approval_grants(agent_id);
  `);
}

export function userPolicyFromRow(row?: any) : any {
  if (!row) return null;
  return {
    userId: row.user_id,
    enabled: Boolean(row.enabled),
    roleIds: parseJson(row.role_ids_json, []),
    teamIds: parseJson(row.team_ids_json, []),
    departmentIds: parseJson(row.department_ids_json, []),
    resourcePolicies: parseJson(row.resource_policies_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function approvalFromRow(row?: any) : any {
  if (!row) return null;
  return {
    approvalId: row.approval_id,
    userId: row.user_id || "",
    agentId: row.agent_id || "",
    resourceType: row.resource_type || "*",
    resourceId: row.resource_id || "*",
    actions: parseJson(row.actions_json, []),
    targetProviders: parseJson(row.target_providers_json, []),
    teamIds: parseJson(row.team_ids_json, []),
    departmentIds: parseJson(row.department_ids_json, []),
    approvalLayers: parseJson(row.approval_layers_json, []),
    grantKind: row.grant_kind || "once",
    effect: row.effect || "allow",
    expiresAt: row.expires_at || "",
    revokedAt: row.revoked_at || "",
    reason: row.reason || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function policyMatches(policy: Record<string, any> = {}, request: Record<string, any> = {}) : any {
  const resourceType: any = String(request.resourceType || "").trim();
  const resourceId: any = String(request.resourceId || "").trim();
  const action: any = String(request.action || "").trim();
  const targetProvider: any = String(request.targetProvider || "").trim();
  const policyType: any = String(policy.resourceType || "*");
  const policyId: any = String(policy.resourceId || "*");
  const actions: any = uniqueStrings(policy.actions || []);
  const targetProviders: any = uniqueStrings(policy.targetProviders || []);
  return (
    (policyType === "*" || policyType === resourceType) &&
    (policyId === "*" || policyId === resourceId) &&
    (actions.includes("*") || actions.includes(action) || actions.includes(request.scopeAction)) &&
    (targetProviders.length === 0 || targetProviders.includes("*") || targetProviders.includes(targetProvider))
  );
}

export function policiesMatch(policies: any = [], request: Record<string, any> = {}) : any {
  return normalizePolicyList(policies).some((policy?: any) : any => policyMatches(policy, request));
}

export function activeRolePolicies(roleIds: any = [], getRole: any = () : any => null) : any {
  return uniqueStrings(roleIds).flatMap((roleId?: any) : any => {
    const role: any = getRole(roleId);
    return role?.enabled ? role.resourcePolicies || [] : [];
  });
}

export function inferScopeAction(operationId: any = "", action: any = "") : any {
  if (action.startsWith("repo:")) return action;
  if (/approve/i.test(operationId)) return "repo:approve";
  if (/review\.(comment|requestChanges)/.test(operationId)) return "repo:review";
  if (/(upload|git_upload|submit|maintain|abandon|rebase|merge|revert)/.test(operationId)) return "repo:maintain";
  if (/(prepare|write|create|update|delete|push|link)/.test(operationId)) return "repo:write";
  return "repo:read";
}

export function inferGovernanceRequest({ operation = {}, tool = null, input = {}, context = {}, subject = {}, grant = null }: Record<string, any> = {}) : any {
  const inputResource: any = objectOrNull(input.resource) || {};
  const contextResource: any = objectOrNull(context.resource) || {};
  const operationId: any = String(operation.id || tool?.operationId || input.operationId || "").trim();
  const rawAction: any = firstString(input.requestedAction, context.requestedAction, input.action, operationId);
  const action: any = rawAction || operationId || "read";
  const resourceType: any = firstString(
    input.resourceType,
    input["resource-type"],
    inputResource.resourceType,
    inputResource.type,
    context.resourceType,
    contextResource.resourceType
  );
  const resourceId: any = firstString(
    input.resourceId,
    inputResource.resourceId,
    inputResource.id,
    context.resourceId,
    contextResource.resourceId,
    "*"
  );
  const targetProvider: any = firstString(
    input.targetProvider,
    input.provider,
    inputResource.targetProvider,
    context.targetProvider,
    contextResource.targetProvider
  );
  const agentId: any = firstString(
    input.agentId,
    input.agentProfileId,
    context.agentId,
    context.profileId,
    context.agentProfileId,
    grant?.metadata?.agentId,
    grant?.metadata?.agentProfileId,
    subject.agentProfileId
  );
  const boundUserId: any = firstString(
    input.boundUserId,
    input.userId,
    context.boundUserId,
    context.userId,
    grant?.metadata?.boundUserId,
    grant?.metadata?.userId,
    subject.type === "console-user" ? subject.subjectId : ""
  );
  return {
    operationId,
    resourceType,
    resourceId,
    targetProvider,
    action,
    scopeAction: inferScopeAction(operationId, action),
    discoveryLike: /^(operation_permission\.catalog|operation_permission\.tools\.list|operation_permission\.toolsets\.list)$/.test(operationId),
    agentId,
    boundUserId,
    teamIds: uniqueStrings([
      ...(subject.teamIds || []),
      ...stringsFrom(input.teamIds, context.teamIds, grant?.metadata?.teamIds)
    ]),
    departmentIds: uniqueStrings([
      ...(subject.departmentIds || []),
      ...stringsFrom(input.departmentIds, context.departmentIds, grant?.metadata?.departmentIds)
    ]),
    applies: Boolean(resourceType),
    writeLike: WRITE_ACTION_RE.test(action) || WRITE_ACTION_RE.test(operationId)
  };
}

export function isActiveApproval(approval: Record<string, any> = {}, request: Record<string, any> = {}, { userId = "", agentId = "", approvalLayer = "" }: Record<string, any> = {}) : any {
  if (!approval || approval.effect === "deny" || approval.revokedAt) return false;
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) return false;
  if (approval.userId && userId && approval.userId !== userId) return false;
  if (approval.agentId && agentId && approval.agentId !== agentId) return false;
  const approvalTeamIds: any = uniqueStrings(approval.teamIds || []);
  const requestTeamIds: any = uniqueStrings(request.teamIds || []);
  if (approvalTeamIds.length > 0 && !approvalTeamIds.some((teamId?: any) : any => requestTeamIds.includes(teamId))) return false;
  const approvalDepartmentIds: any = uniqueStrings(approval.departmentIds || []);
  const requestDepartmentIds: any = uniqueStrings(request.departmentIds || []);
  if (approvalDepartmentIds.length > 0 && !approvalDepartmentIds.some((departmentId?: any) : any => requestDepartmentIds.includes(departmentId))) return false;
  const approvalLayers: any = uniqueStrings(approval.approvalLayers || []);
  if (approvalLayers.length > 0 && approvalLayer && !approvalLayers.includes("*") && !approvalLayers.includes(approvalLayer)) return false;
  return policyMatches({
    resourceType: approval.resourceType,
    resourceId: approval.resourceId,
    actions: approval.actions,
    targetProviders: approval.targetProviders
  }, request);
}
