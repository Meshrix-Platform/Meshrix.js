import {
  ASSET_OPERATION_SCHEMA,
  ASSET_QUERY,
  FILE_QUERY,
  WORKSPACE_ID_QUERY,
  protocolOperation,
  schema,
  workspaceAssetOperation
} from "./protocol-operation-builders.ts";

export const AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
protocolOperation({
    id: "readiness.baseline.status",
    feature: "system",
    label: "运行基线状态",
    targetMethod: "handleReadinessBaselineStatus",
    method: "GET",
    path: "/api/readiness/baseline/status",
    scopes: ["console:read"],
    readOnly: true,
    inputSchema: schema([], {
      includePorts: { type: "boolean" }
    })
  }),
protocolOperation({
    id: "authorization.subject.resolve",
    feature: "tag_management",
    label: "解析授权主体",
    targetMethod: "handleAuthorizationSubjectResolve",
    method: "POST",
    path: "/api/authorization/subject/resolve",
    scopes: ["auth:admin"],
    inputSchema: schema([], {
      subject: { type: "object" },
      actor: { type: "object" }
    })
  }),
protocolOperation({
    id: "authorization.policy.evaluate",
    feature: "tag_management",
    label: "统一授权策略裁决",
    targetMethod: "handleAuthorizationPolicyEvaluate",
    method: "POST",
    path: "/api/authorization/policy/evaluate",
    scopes: ["auth:admin"],
    inputSchema: schema([], {
      operationId: { type: "string" },
      operation: { type: "object" },
      tool: { type: "object" },
      subject: { type: "object" },
      resource: { type: "object" },
      requestedAction: { type: "string" },
      requestedEgress: { type: "string" }
    })
  }),
protocolOperation({
    id: "authorization.governance.summary",
    feature: "auth",
    label: "统一权限治理摘要",
    targetMethod: "handleAuthorizationGovernanceSummary",
    method: "GET",
    path: "/api/authorization/governance",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "tag_management.tags.list",
    feature: "tag_management",
    label: "列出标签",
    targetMethod: "handleTagManagementTagsList",
    method: "GET",
    path: "/api/tag-management/v1/tags",
    query: [
      { name: "kind", aliases: ["kind"] },
  { name: "status", aliases: ["status"] },
  { name: "includeArchived", aliases: ["include-archived", "includeArchived"] },
  { name: "parentTagId", aliases: ["parent-tag-id", "parentTagId"] }
    ],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "tag_management.tags.get",
    feature: "tag_management",
    label: "读取标签",
    targetMethod: "handleTagManagementTagGet",
    method: "GET",
    path: "/api/tag-management/v1/tags/:tagId",
    params: [{ name: "tagId", aliases: ["tag-id", "tagId", "id"], required: true }],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "tag_management.tags.upsert",
    feature: "tag_management",
    label: "保存标签",
    targetMethod: "handleTagManagementTagUpsert",
    method: "POST",
    path: "/api/tag-management/v1/tags",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin",
    inputSchema: schema(["tagId", "kind", "label"], {
      tagId: { type: "string" },
      kind: { type: "string" },
      label: { type: "string" },
      description: { type: "string" },
      parentTagId: { type: "string" },
      enabled: { type: "boolean" },
      scopePrerequisites: { type: "array", items: { type: "string" } },
      metadata: { type: "object" }
    })
  }),
protocolOperation({
    id: "tag_management.tags.archive",
    feature: "tag_management",
    label: "归档标签",
    targetMethod: "handleTagManagementTagArchive",
    method: "POST",
    path: "/api/tag-management/v1/tags/:tagId/archive",
    params: [{ name: "tagId", aliases: ["tag-id", "tagId", "id"], required: true }],
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "tag_management.tags.restore",
    feature: "tag_management",
    label: "恢复标签",
    targetMethod: "handleTagManagementTagRestore",
    method: "POST",
    path: "/api/tag-management/v1/tags/:tagId/restore",
    params: [{ name: "tagId", aliases: ["tag-id", "tagId", "id"], required: true }],
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "tag_management.projections.list",
    feature: "tag_management",
    label: "列出标签投影",
    targetMethod: "handleTagManagementProjectionsList",
    method: "GET",
    path: "/api/tag-management/v1/projections",
    query: [
      { name: "entityType", aliases: ["entity-type", "entityType"] },
  { name: "kind", aliases: ["kind"] },
  { name: "includeArchived", aliases: ["include-archived", "includeArchived"] }
    ],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "tag_management.projections.rebuild",
    feature: "tag_management",
    label: "重建标签投影",
    targetMethod: "handleTagManagementProjectionsRebuild",
    method: "POST",
    path: "/api/tag-management/v1/projections/rebuild",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "tag_management.audit.list",
    feature: "tag_management",
    label: "列出标签审计事件",
    targetMethod: "handleTagManagementAuditList",
    method: "GET",
    path: "/api/tag-management/v1/audit",
    query: [
      { name: "limit", aliases: ["limit"] },
  { name: "tagId", aliases: ["tag-id", "tagId"] },
  { name: "eventType", aliases: ["event-type", "eventType"] }
    ],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.roles.list",
    feature: "auth",
    label: "列出权限角色",
    targetMethod: "handleAuthorizationRolesList",
    method: "GET",
    path: "/api/authorization/roles",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.roles.upsert",
    feature: "auth",
    label: "保存权限角色",
    targetMethod: "handleAuthorizationRoleUpsert",
    method: "POST",
    path: "/api/authorization/roles",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.departments.list",
    feature: "auth",
    label: "列出权限部门",
    targetMethod: "handleAuthorizationDepartmentsList",
    method: "GET",
    path: "/api/authorization/departments",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.departments.upsert",
    feature: "auth",
    label: "保存权限部门",
    targetMethod: "handleAuthorizationDepartmentUpsert",
    method: "POST",
    path: "/api/authorization/departments",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.teams.list",
    feature: "auth",
    label: "列出权限团队",
    targetMethod: "handleAuthorizationTeamsList",
    method: "GET",
    path: "/api/authorization/teams",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.teams.upsert",
    feature: "auth",
    label: "保存权限团队",
    targetMethod: "handleAuthorizationTeamUpsert",
    method: "POST",
    path: "/api/authorization/teams",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.users.policies.list",
    feature: "auth",
    label: "列出用户授权策略",
    targetMethod: "handleAuthorizationUserPoliciesList",
    method: "GET",
    path: "/api/authorization/users/policies",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.users.policy.upsert",
    feature: "auth",
    label: "保存用户授权策略",
    targetMethod: "handleAuthorizationUserPolicyUpsert",
    method: "POST",
    path: "/api/authorization/users/policy",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.agent_groups.list",
    feature: "auth",
    label: "列出智能体分组",
    targetMethod: "handleAuthorizationAgentGroupsList",
    method: "GET",
    path: "/api/authorization/agent-groups",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.agent_groups.upsert",
    feature: "auth",
    label: "保存智能体分组",
    targetMethod: "handleAuthorizationAgentGroupUpsert",
    method: "POST",
    path: "/api/authorization/agent-groups",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.agents.bindings.list",
    feature: "auth",
    label: "列出智能体绑定",
    targetMethod: "handleAuthorizationAgentBindingsList",
    method: "GET",
    path: "/api/authorization/agents/bindings",
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.agents.binding.upsert",
    feature: "auth",
    label: "保存智能体绑定",
    targetMethod: "handleAuthorizationAgentBindingUpsert",
    method: "POST",
    path: "/api/authorization/agents/binding",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.approvals.list",
    feature: "auth",
    label: "列出智能体审批",
    targetMethod: "handleAuthorizationApprovalsList",
    method: "GET",
    path: "/api/authorization/approvals",
    query: [
      { name: "userId", aliases: ["user-id", "userId"] },
  { name: "agentId", aliases: ["agent-id", "agentId"] },
  { name: "includeRevoked", aliases: ["include-revoked", "includeRevoked"] }
    ],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.approvals.upsert",
    feature: "auth",
    label: "保存智能体审批",
    targetMethod: "handleAuthorizationApprovalUpsert",
    method: "POST",
    path: "/api/authorization/approvals",
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.approvals.revoke",
    feature: "auth",
    label: "撤销智能体审批",
    targetMethod: "handleAuthorizationApprovalRevoke",
    method: "POST",
    path: "/api/authorization/approvals/:approvalId/revoke",
    params: [{ name: "approvalId", aliases: ["approval-id", "id"], required: true }],
    scopes: ["auth:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "auth:admin"
  }),
protocolOperation({
    id: "authorization.receipts.list",
    feature: "auth",
    label: "列出授权回执",
    targetMethod: "handleAuthorizationReceiptsList",
    method: "GET",
    path: "/api/authorization/receipts",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "subjectId", aliases: ["subject-id", "subjectId"] }],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.loan_records.list",
    feature: "auth",
    label: "列出授权借用记录",
    targetMethod: "handleAuthorizationLoanRecordsList",
    method: "GET",
    path: "/api/authorization/loan-records",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "subjectId", aliases: ["subject-id", "subjectId"] }],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "authorization.denied_requests.list",
    feature: "auth",
    label: "列出授权拒绝请求",
    targetMethod: "handleAuthorizationDeniedRequestsList",
    method: "GET",
    path: "/api/authorization/denied-requests",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "subjectId", aliases: ["subject-id", "subjectId"] }],
    scopes: ["auth:admin"]
  }),
protocolOperation({
    id: "workspace.info",
    feature: "agent_workspace",
    label: "读取 workspace 信息",
    targetMethod: "handleWorkspaceProtocolInfo",
    method: "GET",
    path: "/api/workspace/info",
    query: WORKSPACE_ID_QUERY,
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.file.upload",
    feature: "agent_workspace",
    label: "上传 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFileUpload",
    path: "/api/workspace/files/upload",
    scopes: ["storage:write"],
    risk: "safe_write",
    inputSchema: schema(["workspaceId"], {
      workspaceId: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      contentBase64: { type: "string" }
    })
  }),
protocolOperation({
    id: "workspace.file.list",
    feature: "agent_workspace",
    label: "列出 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFileList",
    method: "GET",
    path: "/api/workspace/files",
    query: FILE_QUERY,
    scopes: ["storage:read"]
  }),
protocolOperation({
    id: "workspace.file.download",
    feature: "agent_workspace",
    label: "下载 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFileDownload",
    method: "GET",
    path: "/api/workspace/files/download",
    query: FILE_QUERY,
    scopes: ["storage:read"]
  }),
protocolOperation({
    id: "workspace.file.read",
    feature: "agent_workspace",
    label: "读取 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFileDownload",
    method: "GET",
    path: "/api/workspace/files/read",
    query: FILE_QUERY,
    scopes: ["storage:read"]
  }),
protocolOperation({
    id: "workspace.file.write",
    feature: "agent_workspace",
    label: "写入 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFileWrite",
    path: "/api/workspace/files/write",
    scopes: ["storage:write"],
    risk: "safe_write",
    inputSchema: schema(["workspaceId", "path"], {
      workspaceId: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      contentBase64: { type: "string" }
    })
  }),
protocolOperation({
    id: "workspace.file.patch",
    feature: "agent_workspace",
    label: "补丁更新 workspace 文件",
    targetMethod: "handleWorkspaceProtocolFilePatch",
    path: "/api/workspace/files/patch",
    scopes: ["storage:write"],
    risk: "safe_write",
    inputSchema: schema(["workspaceId", "path"], {
      workspaceId: { type: "string" },
      path: { type: "string" },
      patch: { type: "string" },
      hunks: { type: "array" }
    })
  }),
protocolOperation({
    id: "workspace.contribution.submit",
    feature: "agent_workspace",
    label: "提交 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionSubmit",
    path: "/api/workspace/contributions/submit",
    scopes: ["workspace:write"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.list",
    feature: "agent_workspace",
    label: "列出 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionList",
    method: "GET",
    path: "/api/workspace/contributions",
    query: WORKSPACE_ID_QUERY,
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.contribution.leaderboard",
    feature: "agent_workspace",
    label: "读取 workspace 贡献排行榜",
    targetMethod: "handleWorkspaceContributionLeaderboard",
    method: "GET",
    path: "/api/workspace/contributions/leaderboard",
    query: WORKSPACE_ID_QUERY,
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.contribution.stats",
    feature: "agent_workspace",
    label: "读取 workspace 贡献统计",
    targetMethod: "handleWorkspaceContributionStats",
    method: "GET",
    path: "/api/workspace/contributions/stats",
    query: WORKSPACE_ID_QUERY,
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.contribution.report",
    feature: "agent_workspace",
    label: "生成 workspace 贡献报告",
    targetMethod: "handleWorkspaceContributionReport",
    path: "/api/workspace/contributions/report",
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.contribution.assets.list",
    feature: "agent_workspace",
    label: "列出已物化 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionAssetsList",
    method: "GET",
    path: "/api/workspace/contributions/assets",
    query: WORKSPACE_ID_QUERY,
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.contribution.permission.request",
    feature: "agent_workspace",
    label: "请求 workspace 贡献资产权限",
    targetMethod: "handleWorkspaceContributionPermissionRequest",
    path: "/api/workspace/contributions/:contributionId/permission/request",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:write"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.permission.grant",
    feature: "agent_workspace",
    label: "授予 workspace 贡献资产权限",
    targetMethod: "handleWorkspaceContributionPermissionGrant",
    path: "/api/workspace/contributions/:contributionId/permission/grant",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain"
  }),
protocolOperation({
    id: "workspace.contribution.scan",
    feature: "agent_workspace",
    label: "扫描 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionScan",
    path: "/api/workspace/contributions/:contributionId/scan",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.review",
    feature: "agent_workspace",
    label: "审核 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionReview",
    path: "/api/workspace/contributions/:contributionId/review",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.preview",
    feature: "agent_workspace",
    label: "生成 workspace 贡献资产发布预览",
    targetMethod: "handleWorkspaceContributionPreview",
    path: "/api/workspace/contributions/:contributionId/preview",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.publish",
    feature: "agent_workspace",
    label: "发布 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionPublish",
    path: "/api/workspace/contributions/:contributionId/publish",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain"
  }),
protocolOperation({
    id: "workspace.contribution.adopt",
    feature: "agent_workspace",
    label: "跨 workspace 采用贡献资产",
    targetMethod: "handleWorkspaceContributionAdopt",
    path: "/api/workspace/contributions/:contributionId/adopt",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:write"],
    risk: "safe_write"
  }),
protocolOperation({
    id: "workspace.contribution.reject",
    feature: "agent_workspace",
    label: "拒绝 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionReject",
    path: "/api/workspace/contributions/:contributionId/reject",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "repair_write"
  }),
protocolOperation({
    id: "workspace.contribution.request_changes",
    feature: "agent_workspace",
    label: "要求修改 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionRequestChanges",
    path: "/api/workspace/contributions/:contributionId/request-changes",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "safe_write"
  })
]);
