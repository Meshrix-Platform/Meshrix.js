import path from "node:path";
import { openSqliteDatabase } from "../../storage/sqlite-database.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.ts";
import { ServerConfig } from "#meshrix/server-config";
import {
  getTagStoreProvider,
  getTagStoreProviderDiagnostic
} from "./tag-store-provider-registry.ts";
import { validateTagStoreProvider } from "./tag-store.port.ts";
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
} from "./authorization-governance-store-support.ts";

function requireTagManagementStore(provider?: any, userDataPath?: any) : any {
  if (!provider || provider.isClosed?.()) {
    const error: Error & Record<string, any> = new Error("Authorization governance requires an active Tag Store provider.");
    error.code = "AUTHORIZATION_TAG_STORE_REQUIRED";
    error.diagnostic = getTagStoreProviderDiagnostic();
    throw error;
  }
  const validation: any = validateTagStoreProvider(provider);
  if (!validation.valid) {
    const error: Error & Record<string, any> = new Error("Authorization governance received an invalid Tag Store provider.");
    error.code = "AUTHORIZATION_TAG_STORE_INVALID";
    error.diagnostic = {
      ...getTagStoreProviderDiagnostic(),
      missingMethods: validation.missing
    };
    throw error;
  }
  const expectedDataPath: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  const expectedRootPath: any = path.join(expectedDataPath, "security", "tag-management");
  const providerDataPath: any = provider.userDataPath ? path.resolve(provider.userDataPath) : "";
  const providerRootPath: any = provider.rootPath ? path.resolve(provider.rootPath) : "";
  if (
    (providerDataPath && providerDataPath !== expectedDataPath) ||
    (!providerDataPath && providerRootPath && providerRootPath !== expectedRootPath)
  ) {
    const error: Error & Record<string, any> = new Error("Authorization governance Tag Store provider is bound to a different data directory.");
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
}: Record<string, any> = {}) : any {
  const resolvedTagManagementStore: any = requireTagManagementStore(
    tagManagementStore || getTagStoreProvider(),
    userDataPath
  );
  const resolvedRoot: any = rootPath ||
    path.join(userDataPath || ServerConfig.getDataDir(), "security", "authorization");
  const databasePath: any = ensurePrivateSqliteLocation(path.join(resolvedRoot, "authorization-governance.sqlite"));
  let db: any = null;
  let userPolicyUpsert: any = null;
  let approvalUpsert: any = null;
  try {
    withPrivateFileCreationMask(() : any => {
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
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }
  let isClosed: any = false;

  function appendEvent(entityType?: any, entityId?: any, eventType?: any, payload: Record<string, any> = {}) : any {
    db.prepare(`
      INSERT INTO authorization_governance_events (event_id, entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomId("authz_gov_event"), entityType, entityId, eventType, stringifyJson(payload, {}), nowIso());
  }

  function getPolicyRevision() : any {
    const row: any = db.prepare(`
      SELECT count(*) AS revision, max(created_at) AS updated_at
      FROM authorization_governance_events
    `).get();
    const tagRevision: any = resolvedTagManagementStore?.getPolicyRevision?.() || null;
    return {
      protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
      revision: Number(row?.revision || 0) + Number(tagRevision?.revision || 0),
      updatedAt: [row?.updated_at || "", tagRevision?.updatedAt || ""].sort().pop() || ""
    };
  }

  function seedBuiltins() : any {
    for (const role of (Object.values(builtinRoles || DEFAULT_ROLES) as any[])) {
      const existing: any = getRole(role.roleId || role.id);
      if (existing && existing.system === false) continue;
      upsertRole({ ...role, system: true, enabled: role.enabled !== false }, { seed: true });
    }
  }

  function upsertRole(input: Record<string, any> = {}, { seed = false }: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.upsertAuthorizationRole(input, {
      suppressEvent: seed
    });
  }

  function getRole(roleId?: any) : any {
    return resolvedTagManagementStore.getAuthorizationRole(roleId);
  }

  function listRoles({ includeDisabled = true }: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.listAuthorizationRoles({ includeDisabled });
  }

  function upsertTeam(input: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.upsertAuthorizationTeam(input);
  }

  function getTeam(teamId?: any) : any {
    return resolvedTagManagementStore.getAuthorizationTeam(teamId);
  }

  function listTeams({ includeDisabled = true }: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.listAuthorizationTeams({ includeDisabled });
  }

  function upsertDepartment(input: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.upsertAuthorizationDepartment(input);
  }

  function getDepartment(departmentId?: any) : any {
    return resolvedTagManagementStore.getAuthorizationDepartment(departmentId);
  }

  function listDepartments({ includeDisabled = true }: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.listAuthorizationDepartments({ includeDisabled });
  }

  function upsertUserPolicy(input: Record<string, any> = {}) : any {
    const existing: any = getUserPolicy(input.userId || input.id);
    const policy: any = normalizeUserPolicy(input, existing || {});
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

  function getUserPolicy(userId?: any) : any {
    return userPolicyFromRow(db.prepare("SELECT * FROM authorization_user_policies WHERE user_id = ?").get(String(userId || "")));
  }

  function listUserPolicies() : any {
    return db.prepare("SELECT * FROM authorization_user_policies ORDER BY user_id ASC").all().map(userPolicyFromRow);
  }

  function upsertAgentGroup(input: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.upsertAuthorizationAgentGroup(input);
  }

  function getAgentGroup(groupId?: any) : any {
    return resolvedTagManagementStore.getAuthorizationAgentGroup(groupId);
  }

  function listAgentGroups({ includeDisabled = true }: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.listAuthorizationAgentGroups({ includeDisabled });
  }

  function upsertAgentBinding(input: Record<string, any> = {}) : any {
    return resolvedTagManagementStore.upsertAuthorizationAgentBinding(input);
  }

  function getAgentBinding(agentId?: any) : any {
    return resolvedTagManagementStore.getAuthorizationAgentBinding(agentId);
  }

  function listAgentBindings() : any {
    return resolvedTagManagementStore.listAuthorizationAgentBindings();
  }

  function upsertApproval(input: Record<string, any> = {}) : any {
    const existing: any = getApproval(input.approvalId || input.id);
    const approval: any = normalizeApproval(input, existing || {});
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

  function getApproval(approvalId?: any) : any {
    return approvalFromRow(db.prepare("SELECT * FROM authorization_approval_grants WHERE approval_id = ?").get(String(approvalId || "")));
  }

  function listApprovals({ userId = "", agentId = "", includeRevoked = false }: Record<string, any> = {}) : any {
    const clauses: any[] = [];
    const params: any[] = [];
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
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM authorization_approval_grants ${where} ORDER BY created_at DESC`).all(...params).map(approvalFromRow);
  }

  function revokeApproval(approvalId?: any, reason: any = "") : any {
    const approval: any = getApproval(approvalId);
    if (!approval) return null;
    const updated: any = upsertApproval({ ...approval, revokedAt: nowIso(), reason: reason || approval.reason });
    appendEvent("approval", approval.approvalId, "revoked", { reason });
    return updated;
  }

  function hasGovernancePolicies() : any {
    const counts: any[] = [
      listDepartments({ includeDisabled: false }).length,
      listTeams({ includeDisabled: false }).length,
      db.prepare("SELECT count(*) AS count FROM authorization_user_policies WHERE enabled = 1").get().count,
      listAgentBindings().filter((binding?: any) : any => binding?.enabled).length,
      listAgentGroups({ includeDisabled: false }).length,
      db.prepare("SELECT count(*) AS count FROM authorization_approval_grants WHERE revoked_at = ''").get().count
    ];
    return counts.some((count?: any) : any => Number(count || 0) > 0);
  }

  function evaluateGovernance(input: Record<string, any> = {}) : any {
    const subject: any = input.subject || {};
    const request: any = inferGovernanceRequest(input);
    const active: any = hasGovernancePolicies();
    if (!request.applies || (!active && input.governanceRequired !== true)) {
      return {
        applicable: false,
        effect: "allow",
        reasonCode: "governance_not_applicable",
        request
      };
    }

    const userId: any = firstString(request.boundUserId, subject.type === "console-user" ? subject.subjectId : "");
    const agentId: any = request.agentId;
    const userPolicy: any = userId ? getUserPolicy(userId) : null;
    const allDepartments: any = listDepartments({ includeDisabled: false });
    const allTeams: any = listTeams({ includeDisabled: false });
    const teamsFromUserPolicy: any = userPolicy?.enabled ? userPolicy.teamIds : [];
    const teamsFromMembership: any = userId
      ? allTeams.filter((team?: any) : any => (team.memberUserIds || []).includes(userId)).map((team?: any) : any => team.teamId)
      : [];
    const teamIds: any = uniqueStrings([...request.teamIds, ...teamsFromUserPolicy, ...teamsFromMembership]);
    const teams: any = teamIds.map(getTeam).filter((team?: any) : any => team?.enabled);
    const departmentsFromUserPolicy: any = userPolicy?.enabled ? userPolicy.departmentIds : [];
    const departmentsFromTeamPolicies: any = teams.flatMap((team?: any) : any => team.departmentIds || []);
    const departmentsFromMembership: any = userId
      ? allDepartments.filter((department?: any) : any => (department.memberUserIds || []).includes(userId)).map((department?: any) : any => department.departmentId)
      : [];
    const departmentsFromTeamMembership: any = allDepartments
      .filter((department?: any) : any => (department.teamIds || []).some((teamId?: any) : any => teamIds.includes(teamId)))
      .map((department?: any) : any => department.departmentId);
    const departmentIds: any = uniqueStrings([
      ...request.departmentIds,
      ...departmentsFromUserPolicy,
      ...departmentsFromTeamPolicies,
      ...departmentsFromMembership,
      ...departmentsFromTeamMembership
    ]);
    const departments: any = departmentIds.map(getDepartment).filter((department?: any) : any => department?.enabled);
    const governedRequest: Record<string, any> = { ...request, teamIds, departmentIds };
    const departmentPolicies: any = departments.flatMap((department?: any) : any => [
      ...(department.resourcePolicies || []),
      ...activeRolePolicies(department.roleIds || [], getRole)
    ]);
    const teamPolicies: any = teams.flatMap((team?: any) : any => [
      ...(team.resourcePolicies || []),
      ...activeRolePolicies(team.roleIds || [], getRole)
    ]);
    const userPolicies: any = userPolicy?.enabled
      ? [
          ...(userPolicy.resourcePolicies || []),
          ...activeRolePolicies(userPolicy.roleIds || [], getRole)
        ]
      : [];
    const departmentPolicyRequired: any = departmentIds.length > 0;
    const teamPolicyRequired: any = teamIds.length > 0;
    const approvals: any = listApprovals({ userId, agentId, includeRevoked: false })
      .filter((approval?: any) : any => isActiveApproval(approval, governedRequest, { userId, agentId }));
    const approvalAllowedForLayer: any = (approvalLayer?: any) : any => approvals
      .filter((approval?: any) : any => isActiveApproval(approval, governedRequest, { userId, agentId, approvalLayer }))
      .some((approval?: any) : any => approval.effect === "allow");
    const departmentExplicitAllowed: any = policiesMatch(departmentPolicies, governedRequest);
    const teamExplicitAllowed: any = policiesMatch(teamPolicies, governedRequest);
    const departmentApprovalAllowed: any = approvalAllowedForLayer("department");
    const teamApprovalAllowed: any = approvalAllowedForLayer("team");
    const userApprovalAllowed: any = approvalAllowedForLayer("user");
    const agentApprovalAllowed: any = approvalAllowedForLayer("agent");
    const departmentAllowed: any = !departmentPolicyRequired || departmentExplicitAllowed || departmentApprovalAllowed;
    const teamAllowed: any = !teamPolicyRequired || teamExplicitAllowed || teamApprovalAllowed;
    const userExplicitAllowed: any = policiesMatch(userPolicies, governedRequest);
    const userAllowed: any = Boolean(userPolicy?.enabled && userExplicitAllowed) || userApprovalAllowed;
    const agentBinding: any = agentId ? getAgentBinding(agentId) : null;
    const groupPolicies: any = (agentBinding?.groupIds || [])
      .map(getAgentGroup)
      .filter((group?: any) : any => group?.enabled)
      .flatMap((group?: any) : any => group.resourcePolicies || []);
    const directUserOperation: any = !agentId && subject.type === "console-user";
    const agentBound: any = directUserOperation || (agentBinding?.enabled && (!userId || !agentBinding.boundUserId || agentBinding.boundUserId === userId));
    const agentAllowed: any = directUserOperation ||
      Boolean(agentBound && (
        policiesMatch(agentBinding?.resourcePolicies || [], governedRequest) ||
        policiesMatch(groupPolicies, governedRequest) ||
        agentApprovalAllowed
      ));

    const snapshot: Record<string, any> = {
      protocolVersion: "v0.0.1:risk-control:governance-1",
      policyRevision: getPolicyRevision(),
      request: governedRequest,
      department: {
        departmentIds,
        matchedDepartmentIds: departments
          .filter((department?: any) : any => policiesMatch([
            ...(department.resourcePolicies || []),
            ...activeRolePolicies(department.roleIds || [], getRole)
          ], governedRequest))
          .map((department?: any) : any => department.departmentId),
        roleIds: uniqueStrings(departments.flatMap((department?: any) : any => department.roleIds || [])),
        required: departmentPolicyRequired,
        explicitAllowed: departmentExplicitAllowed,
        approvalAllowed: departmentApprovalAllowed,
        allowed: departmentAllowed
      },
      team: {
        teamIds,
        matchedTeamIds: teams
          .filter((team?: any) : any => policiesMatch([
            ...(team.resourcePolicies || []),
            ...activeRolePolicies(team.roleIds || [], getRole)
          ], governedRequest))
          .map((team?: any) : any => team.teamId),
        roleIds: uniqueStrings(teams.flatMap((team?: any) : any => team.roleIds || [])),
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
        approvalIds: approvals.map((approval?: any) : any => approval.approvalId),
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
  } catch (error: any) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }

  return {
    close() : any {
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
