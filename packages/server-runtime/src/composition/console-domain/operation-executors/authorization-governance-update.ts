
import { publishProtocolEvent } from "./shared.ts";

export function publicActorFromSession(authSession: any = null) : any {
  const user: any = authSession?.user && typeof authSession.user === "object" ? authSession.user : {};
  return {
    userId: String(user.userId || "").trim(),
    username: String(user.username || "").trim(),
    roleId: String(user.roleId || "").trim()
  };
}

export function governanceEntityId(entityType?: any, entity: Record<string, any> = {}) : any {
  const source: any = entity && typeof entity === "object" && !Array.isArray(entity) ? entity : {};
  const keys: any = {
    role: ["roleId", "id"],
    department: ["departmentId", "id"],
    team: ["teamId", "id"],
    "user-policy": ["userId", "subjectId", "id"],
    "agent-group": ["groupId", "id"],
    "agent-binding": ["agentId", "profileId", "id"],
    approval: ["approvalId", "id"]
  }[entityType] || ["id"];
  for (const key of keys) {
    const value: any = String(source[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function governanceStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return [...new Set<any>(value.map((item?: any) : any => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return governanceStringList(value.split(","));
  }
  return [];
}

export function governanceAffectedSubjects(entityType?: any, entity: Record<string, any> = {}) : any {
  const source: any = entity && typeof entity === "object" && !Array.isArray(entity) ? entity : {};
  return {
    roleIds: entityType === "role" ? [source.roleId].filter(Boolean) : [],
    departmentIds: entityType === "department" ? [source.departmentId].filter(Boolean) : governanceStringList(source.departmentIds),
    teamIds: entityType === "team" ? [source.teamId].filter(Boolean) : governanceStringList(source.teamIds),
    userIds: [source.userId, source.boundUserId, ...governanceStringList(source.memberUserIds)].filter(Boolean),
    agentIds: [source.agentId].filter(Boolean),
    agentGroupIds: entityType === "agent-group" ? [source.groupId].filter(Boolean) : governanceStringList(source.groupIds),
    approvalIds: entityType === "approval" ? [source.approvalId].filter(Boolean) : []
  };
}

export async function publishAuthorizationGovernanceUpdate({
  context,
  operationId,
  entityType,
  eventType,
  entity
}: Record<string, any>) : Promise<any> {
  const securityPermissions: any = context.securityPermissions;
  const policyRevision: any = securityPermissions?.getGovernancePolicyRevision?.() || null;
  const entityId: any = governanceEntityId(entityType, entity);
  const payload: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: "v0.0.1:risk-control:governance-update-1",
    operationId,
    mutation: {
      entityType,
      entityId,
      eventType
    },
    affectedSubjects: governanceAffectedSubjects(entityType, entity),
    policyRevision,
    refresh: {
      required: true,
      reasonCode: "governance_policy_revision_changed",
      gatewayPolicyReloadRequired: true,
      grantRefreshRequired: true,
      staleGrantBehavior: "existing grants remain usable only through live policy evaluation until reissued or rotated"
    },
    actor: publicActorFromSession(context.authSession)
  };
  const governanceEvent: any = await publishProtocolEvent(
    context.protocolEventBus,
    "authorization.governance.updated",
    payload,
    { type: "authorization.governance.updated" }
  );
  const tagManagementEvent: any = entityType === "tag" || entityType === "tag-projection"
    ? await publishProtocolEvent(
        context.protocolEventBus,
        "tag_management.updated",
        payload,
        { type: "tag_management.updated" }
      )
    : null;
  const permissionsEvent: any = await publishProtocolEvent(
    context.protocolEventBus,
    "permissions.updated",
    {
      ...payload,
      sourceTopic: "authorization.governance.updated"
    },
    { type: "permissions.updated" }
  );
  return {
    policyRevision,
    refresh: payload.refresh,
    events: {
      governance: governanceEvent
        ? { id: governanceEvent.id, offset: governanceEvent.offset, topic: governanceEvent.topic }
        : null,
      tagManagement: tagManagementEvent
        ? { id: tagManagementEvent.id, offset: tagManagementEvent.offset, topic: tagManagementEvent.topic }
        : null,
      permissions: permissionsEvent
        ? { id: permissionsEvent.id, offset: permissionsEvent.offset, topic: permissionsEvent.topic }
        : null
    }
  };
}
