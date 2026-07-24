
import { publishProtocolEvent } from "./shared.mjs";

export function publicActorFromSession(authSession = null) {
  const user = authSession?.user && typeof authSession.user === "object" ? authSession.user : {};
  return {
    userId: String(user.userId || "").trim(),
    username: String(user.username || "").trim(),
    roleId: String(user.roleId || "").trim()
  };
}

export function governanceEntityId(entityType, entity = {}) {
  const source = entity && typeof entity === "object" && !Array.isArray(entity) ? entity : {};
  const keys = {
    role: ["roleId", "id"],
    department: ["departmentId", "id"],
    team: ["teamId", "id"],
    "user-policy": ["userId", "subjectId", "id"],
    "agent-group": ["groupId", "id"],
    "agent-binding": ["agentId", "profileId", "id"],
    approval: ["approvalId", "id"]
  }[entityType] || ["id"];
  for (const key of keys) {
    const value = String(source[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function governanceStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return governanceStringList(value.split(","));
  }
  return [];
}

export function governanceAffectedSubjects(entityType, entity = {}) {
  const source = entity && typeof entity === "object" && !Array.isArray(entity) ? entity : {};
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
}) {
  const securityPermissions = context.securityPermissions;
  const policyRevision = securityPermissions?.getGovernancePolicyRevision?.() || null;
  const entityId = governanceEntityId(entityType, entity);
  const payload = {
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
  const governanceEvent = await publishProtocolEvent(
    context.protocolEventBus,
    "authorization.governance.updated",
    payload,
    { type: "authorization.governance.updated" }
  );
  const tagManagementEvent = entityType === "tag" || entityType === "tag-projection"
    ? await publishProtocolEvent(
        context.protocolEventBus,
        "tag_management.updated",
        payload,
        { type: "tag_management.updated" }
      )
    : null;
  const permissionsEvent = await publishProtocolEvent(
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
