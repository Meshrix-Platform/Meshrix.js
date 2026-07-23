import path from "node:path";
import { openSqliteDatabase } from "../../storage/sqlite-database.mjs";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.mjs";
import { ServerConfig } from "#lico/server-config";
import {
  getTagStoreProvider,
  getTagStoreProviderDiagnostic
} from "./tag-store-provider-registry.mjs";
import { validateTagStoreProvider } from "./tag-store.port.mjs";
import {
  DEFAULT_ROLES,
  activeRolePolicies,
  approvalFromRow,
  ensureSchema,
  firstString,
  inferGovernanceRequest,
  isActiveApproval,
  normalizeApproval,
  normalizeUserPolicy,
  nowIso,
  policiesMatch,
  randomId,
  stringifyJson,
  uniqueStrings,
  userPolicyFromRow
} from "./authorization-governance-store-support.mjs";

function requireTagManagementStore(provider, userDataPath) {
  if (!provider || provider.isClosed?.()) {
    const error = new Error("Authorization governance requires an active Tag Store provider.");
    error.code = "AUTHORIZATION_TAG_STORE_REQUIRED";
    error.diagnostic = getTagStoreProviderDiagnostic();
    throw error;
  }
  const validation = validateTagStoreProvider(provider);
  if (!validation.valid) {
    const error = new Error("Authorization governance received an invalid Tag Store provider.");
    error.code = "AUTHORIZATION_TAG_STORE_INVALID";
    error.diagnostic = {
      ...getTagStoreProviderDiagnostic(),
      missingMethods: validation.missing
    };
    throw error;
  }
  const expectedDataPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const expectedRootPath = path.join(expectedDataPath, "security", "tag-management");
  const providerDataPath = provider.userDataPath ? path.resolve(provider.userDataPath) : "";
  const providerRootPath = provider.rootPath ? path.resolve(provider.rootPath) : "";
  if (
    (providerDataPath && providerDataPath !== expectedDataPath) ||
    (!providerDataPath && providerRootPath && providerRootPath !== expectedRootPath)
  ) {
    const error = new Error("Authorization governance Tag Store provider is bound to a different data directory.");
    error.code = "AUTHORIZATION_TAG_STORE_PATH_MISMATCH";
    throw error;
  }
  return provider;
}

export function createAuthorizationGovernanceStore({
  userDataPath = "",
  rootPath = "",
  builtinRoles = DEFAULT_ROLES,
  tagManagementStore = null
} = {}) {
  const resolvedTagManagementStore = requireTagManagementStore(
    tagManagementStore || getTagStoreProvider(),
    userDataPath
  );
  const resolvedRoot = rootPath ||
    path.join(userDataPath || ServerConfig.getDataDir(), "security", "authorization");
  const databasePath = ensurePrivateSqliteLocation(path.join(resolvedRoot, "authorization-governance.sqlite"));
  let db = null;
  let userPolicyUpsert = null;
  let approvalUpsert = null;
  try {
    withPrivateFileCreationMask(() => {
      db = openSqliteDatabase(databasePath);
      ensureSchema(db);
      ensurePrivateSqliteLocation(databasePath);
    });
    userPolicyUpsert = db.prepare(`
      INSERT INTO authorization_user_policies (
        user_id, enabled, role_ids_json, team_ids_json, department_ids_json, resource_policies_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        role_ids_json = excluded.role_ids_json,
        team_ids_json = excluded.team_ids_json,
        department_ids_json = excluded.department_ids_json,
        resource_policies_json = excluded.resource_policies_json,
        updated_at = excluded.updated_at
    `);
    approvalUpsert = db.prepare(`
      INSERT INTO authorization_approval_grants (
        approval_id, user_id, agent_id, resource_type, resource_id, actions_json, target_providers_json,
        team_ids_json, department_ids_json, approval_layers_json, grant_kind, effect, expires_at, revoked_at,
        reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        user_id = excluded.user_id,
        agent_id = excluded.agent_id,
        resource_type = excluded.resource_type,
        resource_id = excluded.resource_id,
        actions_json = excluded.actions_json,
        target_providers_json = excluded.target_providers_json,
        team_ids_json = excluded.team_ids_json,
        department_ids_json = excluded.department_ids_json,
        approval_layers_json = excluded.approval_layers_json,
        grant_kind = excluded.grant_kind,
        effect = excluded.effect,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `);
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }
  let isClosed = false;

  function appendEvent(entityType, entityId, eventType, payload = {}) {
    db.prepare(`
      INSERT INTO authorization_governance_events (event_id, entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomId("authz_gov_event"), entityType, entityId, eventType, stringifyJson(payload, {}), nowIso());
  }

  function getPolicyRevision() {
    const row = db.prepare(`
      SELECT count(*) AS revision, max(created_at) AS updated_at
      FROM authorization_governance_events
    `).get();
    const tagRevision = resolvedTagManagementStore?.getPolicyRevision?.() || null;
    return {
      protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
      revision: Number(row?.revision || 0) + Number(tagRevision?.revision || 0),
      updatedAt: [row?.updated_at || "", tagRevision?.updatedAt || ""].sort().pop() || ""
    };
  }

  function seedBuiltins() {
    for (const role of Object.values(builtinRoles || DEFAULT_ROLES)) {
      const existing = getRole(role.roleId || role.id);
      if (existing && existing.system === false) continue;
      upsertRole({ ...role, system: true, enabled: role.enabled !== false }, { seed: true });
    }
  }

  function upsertRole(input = {}, { seed = false } = {}) {
    return resolvedTagManagementStore.upsertAuthorizationRole(input, {
      suppressEvent: seed
    });
  }

  function getRole(roleId) {
    return resolvedTagManagementStore.getAuthorizationRole(roleId);
  }

  function listRoles({ includeDisabled = true } = {}) {
    return resolvedTagManagementStore.listAuthorizationRoles({ includeDisabled });
  }

  function upsertTeam(input = {}) {
    return resolvedTagManagementStore.upsertAuthorizationTeam(input);
  }

  function getTeam(teamId) {
    return resolvedTagManagementStore.getAuthorizationTeam(teamId);
  }

  function listTeams({ includeDisabled = true } = {}) {
    return resolvedTagManagementStore.listAuthorizationTeams({ includeDisabled });
  }

  function upsertDepartment(input = {}) {
    return resolvedTagManagementStore.upsertAuthorizationDepartment(input);
  }

  function getDepartment(departmentId) {
    return resolvedTagManagementStore.getAuthorizationDepartment(departmentId);
  }

  function listDepartments({ includeDisabled = true } = {}) {
    return resolvedTagManagementStore.listAuthorizationDepartments({ includeDisabled });
  }

  function upsertUserPolicy(input = {}) {
    const existing = getUserPolicy(input.userId || input.id);
    const policy = normalizeUserPolicy(input, existing || {});
    userPolicyUpsert.run(
      policy.userId,
      policy.enabled ? 1 : 0,
      stringifyJson(policy.roleIds, []),
      stringifyJson(policy.teamIds, []),
      stringifyJson(policy.departmentIds, []),
      stringifyJson(policy.resourcePolicies, []),
      policy.createdAt,
      policy.updatedAt
    );
    appendEvent("user-policy", policy.userId, existing ? "update" : "create", policy);
    return policy;
  }

  function getUserPolicy(userId) {
    return userPolicyFromRow(db.prepare("SELECT * FROM authorization_user_policies WHERE user_id = ?").get(String(userId || "")));
  }

  function listUserPolicies() {
    return db.prepare("SELECT * FROM authorization_user_policies ORDER BY user_id ASC").all().map(userPolicyFromRow);
  }

  function upsertAgentGroup(input = {}) {
    return resolvedTagManagementStore.upsertAuthorizationAgentGroup(input);
  }

  function getAgentGroup(groupId) {
    return resolvedTagManagementStore.getAuthorizationAgentGroup(groupId);
  }

  function listAgentGroups({ includeDisabled = true } = {}) {
    return resolvedTagManagementStore.listAuthorizationAgentGroups({ includeDisabled });
  }

  function upsertAgentBinding(input = {}) {
    return resolvedTagManagementStore.upsertAuthorizationAgentBinding(input);
  }

  function getAgentBinding(agentId) {
    return resolvedTagManagementStore.getAuthorizationAgentBinding(agentId);
  }

  function listAgentBindings() {
    return resolvedTagManagementStore.listAuthorizationAgentBindings();
  }

  function upsertApproval(input = {}) {
    const existing = getApproval(input.approvalId || input.id);
    const approval = normalizeApproval(input, existing || {});
    approvalUpsert.run(
      approval.approvalId,
      approval.userId,
      approval.agentId,
      approval.resourceType,
      approval.resourceId,
      stringifyJson(approval.actions, []),
      stringifyJson(approval.targetProviders, []),
      stringifyJson(approval.teamIds, []),
      stringifyJson(approval.departmentIds, []),
      stringifyJson(approval.approvalLayers, []),
      approval.grantKind,
      approval.effect,
      approval.expiresAt,
      approval.revokedAt,
      approval.reason,
      approval.createdAt,
      approval.updatedAt
    );
    appendEvent("approval", approval.approvalId, existing ? "update" : "create", approval);
    return approval;
  }

  function getApproval(approvalId) {
    return approvalFromRow(db.prepare("SELECT * FROM authorization_approval_grants WHERE approval_id = ?").get(String(approvalId || "")));
  }

  function listApprovals({ userId = "", agentId = "", includeRevoked = false } = {}) {
    const clauses = [];
    const params = [];
    if (userId) {
      clauses.push("user_id = ?");
      params.push(String(userId));
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(String(agentId));
    }
    if (!includeRevoked) {
      clauses.push("revoked_at = ''");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM authorization_approval_grants ${where} ORDER BY created_at DESC`).all(...params).map(approvalFromRow);
  }

  function revokeApproval(approvalId, reason = "") {
    const approval = getApproval(approvalId);
    if (!approval) return null;
    const updated = upsertApproval({ ...approval, revokedAt: nowIso(), reason: reason || approval.reason });
    appendEvent("approval", approval.approvalId, "revoked", { reason });
    return updated;
  }

  function hasGovernancePolicies() {
    const counts = [
      listDepartments({ includeDisabled: false }).length,
      listTeams({ includeDisabled: false }).length,
      db.prepare("SELECT count(*) AS count FROM authorization_user_policies WHERE enabled = 1").get().count,
      listAgentBindings().filter((binding) => binding?.enabled).length,
      listAgentGroups({ includeDisabled: false }).length,
      db.prepare("SELECT count(*) AS count FROM authorization_approval_grants WHERE revoked_at = ''").get().count
    ];
    return counts.some((count) => Number(count || 0) > 0);
  }

  function evaluateGovernance(input = {}) {
    const subject = input.subject || {};
    const request = inferGovernanceRequest(input);
    const active = hasGovernancePolicies();
    if (!request.applies || (!active && input.governanceRequired !== true)) {
      return {
        applicable: false,
        effect: "allow",
        reasonCode: "governance_not_applicable",
        request
      };
    }

    const userId = firstString(request.boundUserId, subject.type === "console-user" ? subject.subjectId : "");
    const agentId = request.agentId;
    const userPolicy = userId ? getUserPolicy(userId) : null;
    const allDepartments = listDepartments({ includeDisabled: false });
    const allTeams = listTeams({ includeDisabled: false });
    const teamsFromUserPolicy = userPolicy?.enabled ? userPolicy.teamIds : [];
    const teamsFromMembership = userId
      ? allTeams.filter((team) => (team.memberUserIds || []).includes(userId)).map((team) => team.teamId)
      : [];
    const teamIds = uniqueStrings([...request.teamIds, ...teamsFromUserPolicy, ...teamsFromMembership]);
    const teams = teamIds.map(getTeam).filter((team) => team?.enabled);
    const departmentsFromUserPolicy = userPolicy?.enabled ? userPolicy.departmentIds : [];
    const departmentsFromTeamPolicies = teams.flatMap((team) => team.departmentIds || []);
    const departmentsFromMembership = userId
      ? allDepartments.filter((department) => (department.memberUserIds || []).includes(userId)).map((department) => department.departmentId)
      : [];
    const departmentsFromTeamMembership = allDepartments
      .filter((department) => (department.teamIds || []).some((teamId) => teamIds.includes(teamId)))
      .map((department) => department.departmentId);
    const departmentIds = uniqueStrings([
      ...request.departmentIds,
      ...departmentsFromUserPolicy,
      ...departmentsFromTeamPolicies,
      ...departmentsFromMembership,
      ...departmentsFromTeamMembership
    ]);
    const departments = departmentIds.map(getDepartment).filter((department) => department?.enabled);
    const governedRequest = { ...request, teamIds, departmentIds };
    const departmentPolicies = departments.flatMap((department) => [
      ...(department.resourcePolicies || []),
      ...activeRolePolicies(department.roleIds || [], getRole)
    ]);
    const teamPolicies = teams.flatMap((team) => [
      ...(team.resourcePolicies || []),
      ...activeRolePolicies(team.roleIds || [], getRole)
    ]);
    const userPolicies = userPolicy?.enabled
      ? [
          ...(userPolicy.resourcePolicies || []),
          ...activeRolePolicies(userPolicy.roleIds || [], getRole)
        ]
      : [];
    const departmentPolicyRequired = departmentIds.length > 0;
    const teamPolicyRequired = teamIds.length > 0;
    const approvals = listApprovals({ userId, agentId, includeRevoked: false })
      .filter((approval) => isActiveApproval(approval, governedRequest, { userId, agentId }));
    const approvalAllowedForLayer = (approvalLayer) => approvals
      .filter((approval) => isActiveApproval(approval, governedRequest, { userId, agentId, approvalLayer }))
      .some((approval) => approval.effect === "allow");
    const departmentExplicitAllowed = policiesMatch(departmentPolicies, governedRequest);
    const teamExplicitAllowed = policiesMatch(teamPolicies, governedRequest);
    const departmentApprovalAllowed = approvalAllowedForLayer("department");
    const teamApprovalAllowed = approvalAllowedForLayer("team");
    const userApprovalAllowed = approvalAllowedForLayer("user");
    const agentApprovalAllowed = approvalAllowedForLayer("agent");
    const departmentAllowed = !departmentPolicyRequired || departmentExplicitAllowed || departmentApprovalAllowed;
    const teamAllowed = !teamPolicyRequired || teamExplicitAllowed || teamApprovalAllowed;
    const userExplicitAllowed = policiesMatch(userPolicies, governedRequest);
    const userAllowed = Boolean(userPolicy?.enabled && userExplicitAllowed) || userApprovalAllowed;
    const agentBinding = agentId ? getAgentBinding(agentId) : null;
    const groupPolicies = (agentBinding?.groupIds || [])
      .map(getAgentGroup)
      .filter((group) => group?.enabled)
      .flatMap((group) => group.resourcePolicies || []);
    const directUserOperation = !agentId && subject.type === "console-user";
    const agentBound = directUserOperation || (agentBinding?.enabled && (!userId || !agentBinding.boundUserId || agentBinding.boundUserId === userId));
    const agentAllowed = directUserOperation ||
      Boolean(agentBound && (
        policiesMatch(agentBinding?.resourcePolicies || [], governedRequest) ||
        policiesMatch(groupPolicies, governedRequest) ||
        agentApprovalAllowed
      ));

    const snapshot = {
      protocolVersion: "v0.0.1:risk-control:governance-1",
      policyRevision: getPolicyRevision(),
      request: governedRequest,
      department: {
        departmentIds,
        matchedDepartmentIds: departments
          .filter((department) => policiesMatch([
            ...(department.resourcePolicies || []),
            ...activeRolePolicies(department.roleIds || [], getRole)
          ], governedRequest))
          .map((department) => department.departmentId),
        roleIds: uniqueStrings(departments.flatMap((department) => department.roleIds || [])),
        required: departmentPolicyRequired,
        explicitAllowed: departmentExplicitAllowed,
        approvalAllowed: departmentApprovalAllowed,
        allowed: departmentAllowed
      },
      team: {
        teamIds,
        matchedTeamIds: teams
          .filter((team) => policiesMatch([
            ...(team.resourcePolicies || []),
            ...activeRolePolicies(team.roleIds || [], getRole)
          ], governedRequest))
          .map((team) => team.teamId),
        roleIds: uniqueStrings(teams.flatMap((team) => team.roleIds || [])),
        required: teamPolicyRequired,
        explicitAllowed: teamExplicitAllowed,
        approvalAllowed: teamApprovalAllowed,
        allowed: teamAllowed
      },
      user: {
        userId,
        policyPresent: Boolean(userPolicy),
        roleIds: userPolicy?.roleIds || [],
        explicitAllowed: Boolean(userPolicy?.enabled && userExplicitAllowed),
        approvalIds: approvals.map((approval) => approval.approvalId),
        approvalAllowed: userApprovalAllowed,
        allowed: userAllowed
      },
      agent: {
        agentId,
        bindingPresent: Boolean(agentBinding),
        boundUserId: agentBinding?.boundUserId || "",
        groupIds: agentBinding?.groupIds || [],
        approvalAllowed: agentApprovalAllowed,
        allowed: agentAllowed
      }
    };

    if (!userId && agentId && !agentBinding && request.discoveryLike && !request.writeLike) {
      return {
        applicable: true,
        effect: "allow",
        reasonCode: "agent_readonly_discovery_allowed",
        effectivePolicySnapshot: snapshot
      };
    }

    if (!departmentAllowed) {
      return {
        applicable: true,
        effect: "needsApproval",
        deniedLayer: "department",
        reasonCode: "department_approval_required",
        redactedReason: "Department approval is required for this resource action.",
        requiredApproval: {
          userId,
          agentId,
          resourceType: governedRequest.resourceType,
          resourceId: governedRequest.resourceId,
          actions: [governedRequest.action, governedRequest.scopeAction].filter(Boolean),
          targetProviders: governedRequest.targetProvider ? [governedRequest.targetProvider] : [],
          teamIds,
          departmentIds,
          approvalLayers: ["department"],
          grantKinds: ["once", "timed", "permanent"]
        },
        effectivePolicySnapshot: snapshot
      };
    }
    if (!teamAllowed) {
      return {
        applicable: true,
        effect: "needsApproval",
        deniedLayer: "team",
        reasonCode: "team_approval_required",
        redactedReason: "Team approval is required for this resource action.",
        requiredApproval: {
          userId,
          agentId,
          resourceType: governedRequest.resourceType,
          resourceId: governedRequest.resourceId,
          actions: [governedRequest.action, governedRequest.scopeAction].filter(Boolean),
          targetProviders: governedRequest.targetProvider ? [governedRequest.targetProvider] : [],
          teamIds,
          departmentIds,
          approvalLayers: ["team"],
          grantKinds: ["once", "timed", "permanent"]
        },
        effectivePolicySnapshot: snapshot
      };
    }
    if (!userAllowed) {
      return {
        applicable: true,
        effect: "needsApproval",
        deniedLayer: "user",
        reasonCode: "user_approval_required",
        redactedReason: "User approval is required for this resource action.",
        requiredApproval: {
          userId,
          agentId,
          resourceType: governedRequest.resourceType,
          resourceId: governedRequest.resourceId,
          actions: [governedRequest.action, governedRequest.scopeAction].filter(Boolean),
          targetProviders: governedRequest.targetProvider ? [governedRequest.targetProvider] : [],
          teamIds,
          departmentIds,
          approvalLayers: ["user"],
          grantKinds: ["once", "timed", "permanent"]
        },
        effectivePolicySnapshot: snapshot
      };
    }
    if (!agentBound) {
      return {
        applicable: true,
        effect: "deny",
        deniedLayer: "agent",
        reasonCode: "agent_not_bound_to_user",
        redactedReason: "Agent is not bound to the requested user.",
        effectivePolicySnapshot: snapshot
      };
    }
    if (request.writeLike && !agentAllowed) {
      return {
        applicable: true,
        effect: "needsApproval",
        deniedLayer: "agent",
        reasonCode: "agent_approval_required",
        redactedReason: "Agent approval is required for this resource action.",
        requiredApproval: {
          userId,
          agentId,
          resourceType: governedRequest.resourceType,
          resourceId: governedRequest.resourceId,
          actions: [governedRequest.action, governedRequest.scopeAction].filter(Boolean),
          targetProviders: governedRequest.targetProvider ? [governedRequest.targetProvider] : [],
          teamIds,
          departmentIds,
          approvalLayers: ["agent"],
          grantKinds: ["once", "timed", "permanent"]
        },
        effectivePolicySnapshot: snapshot
      };
    }
    return {
      applicable: true,
      effect: "allow",
      reasonCode: "governance_allowed",
      effectivePolicySnapshot: snapshot
    };
  }

  try {
    seedBuiltins();
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }

  return {
    close() {
      if (isClosed) {
        return;
      }
      isClosed = true;
      db.close();
    },
    tagManagementStore: resolvedTagManagementStore,
    listRoles,
    getRole,
    upsertRole,
    listTeams,
    getTeam,
    upsertTeam,
    listDepartments,
    getDepartment,
    upsertDepartment,
    listUserPolicies,
    getUserPolicy,
    upsertUserPolicy,
    listAgentGroups,
    getAgentGroup,
    upsertAgentGroup,
    listAgentBindings,
    getAgentBinding,
    upsertAgentBinding,
    listApprovals,
    getApproval,
    upsertApproval,
    revokeApproval,
    getPolicyRevision,
    hasGovernancePolicies,
    evaluateGovernance
  };
}
