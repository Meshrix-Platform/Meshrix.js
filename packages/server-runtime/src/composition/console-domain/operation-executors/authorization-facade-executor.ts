
import { AUTHORIZATION_PROTOCOL_VERSION } from "@meshrix/foundation/security/authorization/authorization-engine";
import { SECURITY_PERMISSIONS_PROTOCOL_VERSION } from "@meshrix/foundation/security/security-permissions-provider";
import { protocolPayload, result, workspaceIdFrom } from "./shared.ts";
import { publishAuthorizationGovernanceUpdate } from "./authorization-governance-update.ts";

export async function executeAuthorizationFacadeOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "authorization.subject.resolve",
    "authorization.policy.evaluate",
    "authorization.governance.summary",
    "authorization.organization_governance.get",
    "authorization.organization_governance.import",
    "authorization.organization_governance.preview",
    "authorization.organization_governance.publish",
    "tag_management.tags.list",
    "tag_management.tags.get",
    "tag_management.tags.upsert",
    "tag_management.tags.archive",
    "tag_management.tags.restore",
    "tag_management.projections.list",
    "tag_management.projections.rebuild",
    "tag_management.audit.list",
    "authorization.roles.list",
    "authorization.roles.upsert",
    "authorization.departments.list",
    "authorization.departments.upsert",
    "authorization.teams.list",
    "authorization.teams.upsert",
    "authorization.users.policies.list",
    "authorization.users.policy.upsert",
    "authorization.agent_groups.list",
    "authorization.agent_groups.upsert",
    "authorization.agents.bindings.list",
    "authorization.agents.binding.upsert",
    "authorization.approvals.list",
    "authorization.approvals.upsert",
    "authorization.approvals.revoke",
    "authorization.receipts.list",
    "authorization.loan_records.list",
    "authorization.denied_requests.list",
    "workspace.asset.policy.set",
    "workspace.asset.permission.check"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const securityPermissions: any = context.securityPermissions;

  if (id === "authorization.subject.resolve") {
    if (!securityPermissions || typeof securityPermissions.resolveSubject !== "function") {
      return result(503, { error: "授权主体解析接口不可用。" });
    }
    const subject: any = securityPermissions.resolveSubject({
      subject: input.subject,
      actor: input.actor,
      authSession: context.authSession
    });
    return result(200, protocolPayload({
      protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
      subject
    }));
  }

  if (id === "authorization.policy.evaluate") {
    if (!securityPermissions || typeof securityPermissions.evaluatePolicy !== "function") {
      return result(503, { error: "授权策略裁决接口不可用。" });
    }
    const decision: any = securityPermissions.evaluatePolicy({
      operation: input.operation || {
        id: input.operationId || id,
        requiredScopes: input.requiredScopes || [],
        safety: input.safety || { risk: input.risk || "read_only" },
        readOnly: input.readOnly !== false
      },
      tool: input.tool || null,
      grant: input.grant || null,
      profile: input.profile || null,
      subject: input.subject || null,
      authSession: context.authSession,
      request: context.request,
      input,
      governanceRequired: input.governanceRequired === true,
      context: {
        resource: input.resource,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        repoId: input.repoId,
        targetProvider: input.targetProvider || input.provider,
        agentId: input.agentId,
        profileId: input.profileId || input.agentProfileId,
        agentProfileId: input.agentProfileId || input.profileId,
        boundUserId: input.boundUserId,
        userId: input.userId,
        teamIds: input.teamIds,
        departmentIds: input.departmentIds,
        requestedAction: input.requestedAction,
        requestedEgress: input.requestedEgress
      }
    });
    return result(200, protocolPayload({
      protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
      decision
    }));
  }

  if (id === "authorization.governance.summary") {
    if (!securityPermissions || typeof securityPermissions.getGovernanceSummary !== "function") {
      return result(503, { error: "统一权限治理存储不可用。" });
    }
    return result(200, protocolPayload({
      protocolVersion: SECURITY_PERMISSIONS_PROTOCOL_VERSION,
      governance: securityPermissions.getGovernanceSummary()
    }));
  }

  if (id === "authorization.organization_governance.get") {
    if (!securityPermissions?.getOrganizationGovernance ||
        !securityPermissions?.listOrganizationGovernanceTemplates) {
      return result(503, {
        code: "organization_governance_unavailable",
        error: "组织治理存储不可用。"
      });
    }
    try {
      const snapshot: any = securityPermissions.getOrganizationGovernance();
      return result(200, protocolPayload({
        snapshot,
        templates: securityPermissions.listOrganizationGovernanceTemplates()
      }));
    } catch (error: any) {
      return organizationGovernanceErrorResult(error);
    }
  }

  if (id === "authorization.organization_governance.import") {
    if (!securityPermissions?.importOrganizationGovernance) {
      return result(503, {
        code: "organization_governance_unavailable",
        error: "组织治理存储不可用。"
      });
    }
    try {
      return result(200, protocolPayload({
        draft: securityPermissions.importOrganizationGovernance(input)
      }));
    } catch (error: any) {
      return organizationGovernanceErrorResult(error);
    }
  }

  if (id === "authorization.organization_governance.preview") {
    if (!securityPermissions?.previewOrganizationGovernance) {
      return result(503, {
        code: "organization_governance_unavailable",
        error: "组织治理存储不可用。"
      });
    }
    try {
      const preview: any = securityPermissions.previewOrganizationGovernance(input);
      return result(200, protocolPayload({ preview }));
    } catch (error: any) {
      return organizationGovernanceErrorResult(error);
    }
  }

  if (id === "authorization.organization_governance.publish") {
    if (!securityPermissions?.publishOrganizationGovernance) {
      return result(503, {
        code: "organization_governance_unavailable",
        error: "组织治理存储不可用。"
      });
    }
    let snapshot: any;
    try {
      snapshot = securityPermissions.publishOrganizationGovernance(input);
    } catch (error: any) {
      return organizationGovernanceErrorResult(error);
    }
    try {
      await publishAuthorizationGovernanceUpdate({
        context: { ...context, authSession: null },
        operationId: id,
        entityType: "organization-governance",
        eventType: "published",
        entity: { id: "organization-governance", revision: snapshot.revision }
      });
    } catch {
      // The canonical aggregate is already committed. Optional refresh event
      // failure must not turn that durable result into a blindly retryable error.
    }
    return result(200, protocolPayload({ snapshot }));
  }

  if (id === "tag_management.tags.list") {
    const items: any = securityPermissions?.listTags?.({
      kind: input.kind || "",
      status: input.status || "",
      includeArchived: input.includeArchived !== false && input.includeArchived !== "false" && input["include-archived"] !== "false",
      parentTagId: input.parentTagId ?? input["parent-tag-id"]
    }) || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "tag_management.tags.get") {
    const tag: any = securityPermissions?.getTag?.(input.tagId || input.id || "");
    return tag
      ? result(200, protocolPayload({ tag }))
      : result(404, { error: "标签不存在。" });
  }

  if (id === "tag_management.tags.upsert") {
    if (!securityPermissions?.upsertTag) {
      return result(503, { error: "标签管理存储不可用。" });
    }
    const tag: any = securityPermissions.upsertTag(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "tag",
      eventType: "upsert",
      entity: tag
    });
    return result(200, protocolPayload({ tag, ...governanceUpdate }));
  }

  if (id === "tag_management.tags.archive") {
    if (!securityPermissions?.archiveTag) {
      return result(503, { error: "标签管理存储不可用。" });
    }
    const tag: any = securityPermissions.archiveTag(input.tagId || input.id || "", input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "tag",
      eventType: "archive",
      entity: tag
    });
    return result(200, protocolPayload({ tag, ...governanceUpdate }));
  }

  if (id === "tag_management.tags.restore") {
    if (!securityPermissions?.restoreTag) {
      return result(503, { error: "标签管理存储不可用。" });
    }
    const tag: any = securityPermissions.restoreTag(input.tagId || input.id || "");
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "tag",
      eventType: "restore",
      entity: tag
    });
    return result(200, protocolPayload({ tag, ...governanceUpdate }));
  }

  if (id === "tag_management.projections.list") {
    const items: any = securityPermissions?.listTagProjections?.({
      entityType: input.entityType || input["entity-type"] || "",
      kind: input.kind || "",
      includeArchived: input.includeArchived !== false && input.includeArchived !== "false" && input["include-archived"] !== "false"
    }) || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "tag_management.projections.rebuild") {
    if (!securityPermissions?.rebuildTagProjections) {
      return result(503, { error: "标签管理存储不可用。" });
    }
    const rebuild: any = securityPermissions.rebuildTagProjections();
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "tag-projection",
      eventType: "rebuild",
      entity: rebuild
    });
    return result(200, protocolPayload({ rebuild, ...governanceUpdate }));
  }

  if (id === "tag_management.audit.list") {
    const items: any = securityPermissions?.listTagEvents?.({
      limit: input.limit || 100,
      tagId: input.tagId || input["tag-id"] || "",
      eventType: input.eventType || input["event-type"] || ""
    }) || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.roles.list") {
    const items: any = securityPermissions?.listGovernanceRoles?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.roles.upsert") {
    if (!securityPermissions?.upsertGovernanceRole) {
      return result(503, { error: "权限角色存储不可用。" });
    }
    const role: any = securityPermissions.upsertGovernanceRole(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "role",
      eventType: "upserted",
      entity: role
    });
    return result(200, protocolPayload({ role, ...governanceUpdate }));
  }

  if (id === "authorization.departments.list") {
    const items: any = securityPermissions?.listGovernanceDepartments?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.departments.upsert") {
    if (!securityPermissions?.upsertGovernanceDepartment) {
      return result(503, { error: "权限部门存储不可用。" });
    }
    const department: any = securityPermissions.upsertGovernanceDepartment(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "department",
      eventType: "upserted",
      entity: department
    });
    return result(200, protocolPayload({ department, ...governanceUpdate }));
  }

  if (id === "authorization.teams.list") {
    const items: any = securityPermissions?.listGovernanceTeams?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.teams.upsert") {
    if (!securityPermissions?.upsertGovernanceTeam) {
      return result(503, { error: "权限团队存储不可用。" });
    }
    const team: any = securityPermissions.upsertGovernanceTeam(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "team",
      eventType: "upserted",
      entity: team
    });
    return result(200, protocolPayload({ team, ...governanceUpdate }));
  }

  if (id === "authorization.users.policies.list") {
    const items: any = securityPermissions?.listGovernanceUserPolicies?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.users.policy.upsert") {
    if (!securityPermissions?.upsertGovernanceUserPolicy) {
      return result(503, { error: "用户授权策略存储不可用。" });
    }
    const userPolicy: any = securityPermissions.upsertGovernanceUserPolicy(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "user-policy",
      eventType: "upserted",
      entity: userPolicy
    });
    return result(200, protocolPayload({ userPolicy, ...governanceUpdate }));
  }

  if (id === "authorization.agent_groups.list") {
    const items: any = securityPermissions?.listGovernanceAgentGroups?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.agent_groups.upsert") {
    if (!securityPermissions?.upsertGovernanceAgentGroup) {
      return result(503, { error: "智能体分组存储不可用。" });
    }
    const agentGroup: any = securityPermissions.upsertGovernanceAgentGroup(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "agent-group",
      eventType: "upserted",
      entity: agentGroup
    });
    return result(200, protocolPayload({ agentGroup, ...governanceUpdate }));
  }

  if (id === "authorization.agents.bindings.list") {
    const items: any = securityPermissions?.listGovernanceAgentBindings?.() || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.agents.binding.upsert") {
    if (!securityPermissions?.upsertGovernanceAgentBinding) {
      return result(503, { error: "智能体绑定存储不可用。" });
    }
    const agentBinding: any = securityPermissions.upsertGovernanceAgentBinding(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "agent-binding",
      eventType: "upserted",
      entity: agentBinding
    });
    return result(200, protocolPayload({ agentBinding, ...governanceUpdate }));
  }

  if (id === "authorization.approvals.list") {
    const items: any = securityPermissions?.listGovernanceApprovals?.({
      userId: input.userId || input["user-id"] || "",
      agentId: input.agentId || input["agent-id"] || "",
      includeRevoked: input.includeRevoked === true || input.includeRevoked === "true" || input["include-revoked"] === "true"
    }) || [];
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.approvals.upsert") {
    if (!securityPermissions?.upsertGovernanceApproval) {
      return result(503, { error: "审批授权存储不可用。" });
    }
    const approval: any = securityPermissions.upsertGovernanceApproval(input);
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "approval",
      eventType: "upserted",
      entity: approval
    });
    return result(200, protocolPayload({ approval, ...governanceUpdate }));
  }

  if (id === "authorization.approvals.revoke") {
    if (!securityPermissions?.revokeGovernanceApproval) {
      return result(503, { error: "审批授权存储不可用。" });
    }
    const approval: any = securityPermissions.revokeGovernanceApproval(input.approvalId || input.id, input.reason || "");
    if (!approval) {
      return result(404, { error: "审批授权不存在。" });
    }
    const governanceUpdate: any = await publishAuthorizationGovernanceUpdate({
      context,
      operationId: id,
      entityType: "approval",
      eventType: "revoked",
      entity: approval
    });
    return result(200, protocolPayload({ approval, ...governanceUpdate }));
  }

  if (id === "authorization.receipts.list") {
    if (!securityPermissions || typeof securityPermissions.listReceipts !== "function") {
      return result(503, { error: "授权回执存储不可用。" });
    }
    const items: any = securityPermissions.listReceipts({
      limit: input.limit || 100,
      subjectId: input.subjectId || input["subject-id"] || ""
    });
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.loan_records.list") {
    if (!securityPermissions || typeof securityPermissions.listLoanRecords !== "function") {
      return result(503, { error: "授权借用记录存储不可用。" });
    }
    const items: any = securityPermissions.listLoanRecords({
      limit: input.limit || 100,
      subjectId: input.subjectId || input["subject-id"] || ""
    });
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "authorization.denied_requests.list") {
    if (!securityPermissions || typeof securityPermissions.listDeniedRequests !== "function") {
      return result(503, { error: "授权拒绝请求存储不可用。" });
    }
    const items: any = securityPermissions.listDeniedRequests({
      limit: input.limit || 100,
      subjectId: input.subjectId || input["subject-id"] || "",
      tenantId: input.tenantId || input["tenant-id"] || "",
      workspaceId: input.workspaceId || input["workspace-id"] || "",
      operationId: input.operationId || input["operation-id"] || "",
      toolId: input.toolId || input["tool-id"] || "",
      reasonCode: input.reasonCode || input["reason-code"] || ""
    });
    return result(200, protocolPayload({ items, count: items.length }));
  }

  if (id === "workspace.asset.policy.set") {
    if (!securityPermissions || typeof securityPermissions.setWorkspaceAssetPolicy !== "function") {
      return result(503, { error: "工作空间资产策略 provider 不可用。" });
    }
    const policy: any = securityPermissions.setWorkspaceAssetPolicy({
      ...input,
      workspaceId: workspaceIdFrom(input)
    });
    return result(200, protocolPayload({ policy }));
  }

  if (id === "workspace.asset.permission.check") {
    if (!securityPermissions || typeof securityPermissions.checkWorkspaceAssetPermission !== "function") {
      return result(503, { error: "授权策略裁决接口不可用。" });
    }
    const decision: any = securityPermissions.checkWorkspaceAssetPermission({
      ...input,
      request: context.request,
      authSession: context.authSession
    });
    return result(200, protocolPayload({ decision }));
  }

  return null;
}

function organizationGovernanceErrorResult(error: any): any {
  const code: any = String(error?.code || "organization_governance_unavailable");
  if (code === "organization_governance_invalid") {
    return result(400, {
      code,
      error: "组织治理架构无效。",
      issues: Array.isArray(error?.issues) ? error.issues.slice(0, 64) : []
    });
  }
  if (code === "organization_governance_revision_conflict") {
    return result(409, {
      code,
      error: "组织治理架构已更新。",
      currentRevision: Number(error?.currentRevision || 0)
    });
  }
  if (code === "organization_governance_template_not_found") {
    return result(404, { code, error: "组织治理模板不存在。" });
  }
  if (code === "organization_governance_collision") {
    return result(409, { code, error: "组织治理模板与非模板管理的权限记录冲突。" });
  }
  return result(503, {
    code: "organization_governance_unavailable",
    error: "组织治理存储不可用。"
  });
}
