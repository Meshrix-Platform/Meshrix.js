import crypto from "node:crypto";

export interface GovernanceRecord extends Record<string, unknown> {
  id?: string; userId?: string; subjectId?: string; roleId?: string; teamId?: string;
  departmentId?: string; approvalId?: string; agentId?: string;
  enabled?: boolean; system?: boolean; effect?: string; boundUserId?: string;
  memberUserIds?: string[]; groupIds?: string[]; roleIds?: string[];
  metadata?: GovernanceRecord;
  resource?: GovernanceRecord;
  policies?: unknown[];
  resourcePolicies?: GovernanceRecord[];
  scopes?: string[];
  teamIds?: string[];
  departmentIds?: string[];
}
export interface UserPolicyRecord extends GovernanceRecord {
  userId: string; enabled: boolean; roleIds: string[]; teamIds: string[];
  departmentIds: string[]; resourcePolicies: GovernanceRecord[];
  createdAt: string; updatedAt: string;
}
export interface ApprovalRecord extends GovernanceRecord {
  approvalId: string; userId: string; agentId: string; resourceType: string;
  resourceId: string; actions: string[]; targetProviders: string[];
  teamIds: string[]; departmentIds: string[]; approvalLayers: string[];
  grantKind: string; effect: string; expiresAt: string; revokedAt: string;
  reason: string; createdAt: string; updatedAt: string;
}
interface GovernanceRequestInput extends GovernanceRecord {
  operation?: GovernanceRecord; tool?: GovernanceRecord | null; input?: GovernanceRecord;
  context?: GovernanceRecord; subject?: GovernanceRecord; grant?: GovernanceRecord | null;
}
interface SqliteStatement { all(...params: unknown[]): GovernanceRecord[]; run(...params: unknown[]): unknown }
interface SqliteDatabase {
  exec(sql: string): unknown;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(action: (database?: SqliteDatabase) => T): () => T;
}

export const DEFAULT_ROLES: Readonly<Record<string, GovernanceRecord>> = Object.freeze({
  owner: { roleId: "owner", label: "Owner", scopes: [] },
  maintainer: { roleId: "maintainer", label: "Maintainer", scopes: [] },
  viewer: { roleId: "viewer", label: "Viewer", scopes: [] }
});

const WRITE_ACTION_RE = /\.(prepare|upload|write|create|update|delete|move|push|approve|requestChanges|comment|submit|maintain|rebase|merge|abandon|restore|review)\b|:write|:maintain|:approve|:review|:admin/;

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix?: unknown): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson<T>(value: unknown, fallback: T): unknown | T {
  try {
    const parsed: unknown = JSON.parse(String(value || ""));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: unknown, fallback: unknown = null): string {
  return JSON.stringify(value ?? fallback);
}

export function uniqueStrings(values: unknown = []): string[] {
  const entries = Array.isArray(values) ? values : [];
  return [...new Set(entries.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function stringsFrom(...values: unknown[]): string[] {
  const output: unknown[] = [];
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

export function objectOrNull(value?: unknown): GovernanceRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as GovernanceRecord
    : null;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function normalizeId(value?: unknown, fallbackPrefix?: unknown): string {
  const text = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  }
  return randomId(fallbackPrefix);
}

export function normalizePolicyList(value: unknown = []) {
  const source = objectOrNull(value);
  const input = Array.isArray(value) ? value : source?.policies || source?.resourcePolicies || [];
  return (Array.isArray(input) ? input : []).map((value: unknown) => {
    const entry = objectOrNull(value) || {};
    const resource = objectOrNull(entry.resource) || {};
    return {
      resourceType: String(entry.resourceType || entry.type || resource.type || "*").trim() || "*",
      resourceId: String(entry.resourceId || entry.id || entry.repoId || entry.repositoryRef || resource.id || "*").trim() || "*",
      actions: uniqueStrings(entry.actions || entry.action || entry.scopes || []),
      targetProviders: uniqueStrings(entry.targetProviders || entry.providers || entry.provider || entry.targets || []),
      label: String(entry.label || "").trim()
    };
  }).filter((entry) => entry.actions.length > 0);
}

export function normalizeUserPolicy(input: GovernanceRecord = {}, fallback: GovernanceRecord = {}): UserPolicyRecord {
  const userId = normalizeId(input.userId || input.subjectId || input.id || fallback.userId, "user");
  const timestamp = nowIso();
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

export function normalizeApproval(input: GovernanceRecord = {}, fallback: GovernanceRecord = {}): ApprovalRecord {
  const approvalId = normalizeId(input.approvalId || input.id || fallback.approvalId, "approval");
  const timestamp = nowIso();
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

export function ensureSchema(db: SqliteDatabase): void {
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

    CREATE TABLE IF NOT EXISTS authorization_api_key_recovery_assignments (
      assignment_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      root_node_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action = 'operation_permission.api_keys.manage'),
      enabled INTEGER NOT NULL DEFAULT 1,
      server_authored INTEGER NOT NULL CHECK(server_authored = 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_recovery_subject_root
      ON authorization_api_key_recovery_assignments(subject_id, root_node_id, action);

    CREATE INDEX IF NOT EXISTS idx_authorization_approvals_user ON authorization_approval_grants(user_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_approvals_agent ON authorization_approval_grants(agent_id);
  `);

  const migrationVersion = Number(db.pragma("user_version", { simple: true }) || 0);
  if (migrationVersion < 1) {
    db.transaction(() => {
      const rows = db.prepare(`
        SELECT user_id, role_ids_json
        FROM authorization_user_policies
      `).all();
      const updateRoles = db.prepare(`
        UPDATE authorization_user_policies
        SET role_ids_json = ?
        WHERE user_id = ?
      `);
      for (const row of rows) {
        const roleIds = parseJson(row.role_ids_json, []);
        if (!Array.isArray(roleIds)) continue;
        const migrated = uniqueStrings(roleIds.map((roleId) =>
          ["admin", "operator"].includes(String(roleId || "")) ? "maintainer" : roleId));
        if (JSON.stringify(migrated) !== JSON.stringify(roleIds)) {
          updateRoles.run(stringifyJson(migrated, []), row.user_id);
        }
      }
      db.pragma("user_version = 1");
    })();
  }
}

export function userPolicyFromRow(row?: GovernanceRecord | null): UserPolicyRecord | null {
  if (!row) return null;
  return {
    userId: String(row.user_id || ""),
    enabled: Boolean(row.enabled),
    roleIds: uniqueStrings(parseJson(row.role_ids_json, [])),
    teamIds: uniqueStrings(parseJson(row.team_ids_json, [])),
    departmentIds: uniqueStrings(parseJson(row.department_ids_json, [])),
    resourcePolicies: normalizePolicyList(parseJson(row.resource_policies_json, [])),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

export function approvalFromRow(row?: GovernanceRecord | null): ApprovalRecord | null {
  if (!row) return null;
  return {
    approvalId: String(row.approval_id || ""),
    userId: String(row.user_id || ""),
    agentId: String(row.agent_id || ""),
    resourceType: String(row.resource_type || "*"),
    resourceId: String(row.resource_id || "*"),
    actions: uniqueStrings(parseJson(row.actions_json, [])),
    targetProviders: uniqueStrings(parseJson(row.target_providers_json, [])),
    teamIds: uniqueStrings(parseJson(row.team_ids_json, [])),
    departmentIds: uniqueStrings(parseJson(row.department_ids_json, [])),
    approvalLayers: uniqueStrings(parseJson(row.approval_layers_json, [])),
    grantKind: String(row.grant_kind || "once"),
    effect: String(row.effect || "allow"),
    expiresAt: String(row.expires_at || ""),
    revokedAt: String(row.revoked_at || ""),
    reason: String(row.reason || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

export function policyMatches(policy: GovernanceRecord = {}, request: GovernanceRecord = {}) {
  const resourceType = String(request.resourceType || "").trim();
  const resourceId = String(request.resourceId || "").trim();
  const action = String(request.action || "").trim();
  const targetProvider = String(request.targetProvider || "").trim();
  const policyType = String(policy.resourceType || "*");
  const policyId = String(policy.resourceId || "*");
  const actions = uniqueStrings(policy.actions || []);
  const targetProviders = uniqueStrings(policy.targetProviders || []);
  return (
    (policyType === "*" || policyType === resourceType) &&
    (policyId === "*" || policyId === resourceId) &&
    (actions.includes("*") || actions.includes(action) || actions.includes(String(request.scopeAction || ""))) &&
    (targetProviders.length === 0 || targetProviders.includes("*") || targetProviders.includes(targetProvider))
  );
}

export function policiesMatch(policies: unknown = [], request: GovernanceRecord = {}) {
  return normalizePolicyList(policies).some((policy) => policyMatches(policy, request));
}

export function activeRolePolicies(
  roleIds: unknown = [],
  getRole: (roleId: string) => GovernanceRecord | null = () => null
) {
  return uniqueStrings(roleIds).flatMap((roleId) => {
    const role = getRole(roleId);
    return role?.enabled ? role.resourcePolicies || [] : [];
  });
}

export function inferScopeAction(operationId: unknown = "", action: unknown = "") {
  const operation = String(operationId || "");
  const requestedAction = String(action || "");
  if (requestedAction.startsWith("repo:")) return requestedAction;
  if (/approve/i.test(operation)) return "repo:approve";
  if (/review\.(comment|requestChanges)/.test(operation)) return "repo:review";
  if (/(upload|git_upload|submit|maintain|abandon|rebase|merge|revert)/.test(operation)) return "repo:maintain";
  if (/(prepare|write|create|update|delete|push|link)/.test(operation)) return "repo:write";
  return "repo:read";
}

export function inferGovernanceRequest({ operation = {}, tool = null, input = {}, context = {}, subject = {}, grant = null }: GovernanceRequestInput = {}) {
  const inputResource = objectOrNull(input.resource) || {};
  const contextResource = objectOrNull(context.resource) || {};
  const operationResource = objectOrNull(operation?.resource) || {};
  const operationResourceContext = objectOrNull(operation?.resourceContext) || {};
  const toolResource = objectOrNull(tool?.resource) || {};
  const toolResourceContext = objectOrNull(tool?.resourceContext) || {};
  const operationId = String(operation.id || tool?.operationId || input.operationId || "").trim();
  const rawAction = firstString(input.requestedAction, context.requestedAction, input.action, operationId);
  const action = rawAction || operationId || "read";
  const resourceType = firstString(
    input.resourceType,
    input["resource-type"],
    inputResource.resourceType,
    inputResource.type,
    context.resourceType,
    contextResource.resourceType,
    // Declarative resource metadata falls back so an input that omits the
    // resource type cannot detach a governed operation from its governance.
    operationResourceContext.resourceType,
    operationResource.resourceType,
    operationResource.type,
    toolResourceContext.resourceType,
    toolResource.resourceType,
    toolResource.type
  );
  const resourceId = firstString(
    input.resourceId,
    inputResource.resourceId,
    inputResource.id,
    context.resourceId,
    contextResource.resourceId,
    "*"
  );
  const targetProvider = firstString(
    input.targetProvider,
    input.provider,
    inputResource.targetProvider,
    context.targetProvider,
    contextResource.targetProvider
  );
  const agentId = firstString(
    input.agentId,
    input.agentProfileId,
    context.agentId,
    context.profileId,
    context.agentProfileId,
    grant?.metadata?.agentId,
    grant?.metadata?.agentProfileId,
    subject.agentProfileId
  );
  const boundUserId = firstString(
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

export function isActiveApproval(
  approval: GovernanceRecord = {}, request: GovernanceRecord = {},
  { userId = "", agentId = "", approvalLayer = "" }: { userId?: string; agentId?: string; approvalLayer?: string } = {}
) {
  if (!approval || approval.effect === "deny" || approval.revokedAt) return false;
  if (approval.expiresAt && Date.parse(String(approval.expiresAt)) <= Date.now()) return false;
  if (approval.userId && userId && approval.userId !== userId) return false;
  if (approval.agentId && agentId && approval.agentId !== agentId) return false;
  const approvalTeamIds = uniqueStrings(approval.teamIds || []);
  const requestTeamIds = uniqueStrings(request.teamIds || []);
  if (approvalTeamIds.length > 0 && !approvalTeamIds.some((teamId) => requestTeamIds.includes(teamId))) return false;
  const approvalDepartmentIds = uniqueStrings(approval.departmentIds || []);
  const requestDepartmentIds = uniqueStrings(request.departmentIds || []);
  if (approvalDepartmentIds.length > 0 && !approvalDepartmentIds.some((departmentId) => requestDepartmentIds.includes(departmentId))) return false;
  const approvalLayers = uniqueStrings(approval.approvalLayers || []);
  if (approvalLayers.length > 0 && approvalLayer && !approvalLayers.includes("*") && !approvalLayers.includes(approvalLayer)) return false;
  return policyMatches({
    resourceType: approval.resourceType,
    resourceId: approval.resourceId,
    actions: approval.actions,
    targetProviders: approval.targetProviders
  }, request);
}
