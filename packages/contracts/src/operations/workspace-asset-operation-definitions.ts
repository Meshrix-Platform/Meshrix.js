import {
  ASSET_OPERATION_SCHEMA,
  ASSET_QUERY,
  FILE_QUERY,
  WORKSPACE_ID_QUERY,
  protocolOperation,
  schema,
  workspaceBindingSchema,
  workspaceAssetOperation
} from "./protocol-operation-builders.ts";

const WORKSPACE_CHECKPOINT_RESTORE_SCHEMA: any = schema(["treeId", "nodeId"], {
  treeId: { type: "string" },
  nodeId: { type: "string" },
  workspaceId: { type: "string" },
  mode: { type: "string" },
  reason: { type: "string" }
});

const WORKSPACE_CHECKPOINT_DIFF_SCHEMA: any = schema([], {
  treeId: { type: "string" },
  fromTreeId: { type: "string" },
  toTreeId: { type: "string" },
  fromNodeId: { type: "string" },
  toNodeId: { type: "string" }
});

const WORKSPACE_CHECKPOINT_SCOPE_SCHEMA: any = schema(["treeId", "nodeId"], {
  treeId: { type: "string" },
  nodeId: { type: "string" }
});

const WORKSPACE_OPERATION_REVERT_SCHEMA: any = schema([], {
  auditId: { type: "string" },
  workspaceId: { type: "string" },
  treeId: { type: "string" },
  nodeId: { type: "string" },
  operationId: { type: "string" },
  status: { type: "string" },
  limit: { type: "integer" },
  reason: { type: "string" },
  dryRun: { type: "boolean" },
  preview: { type: "boolean" }
});

export const WORKSPACE_ASSET_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
protocolOperation({
    id: "workspace.contribution.revoke",
    feature: "agent_workspace",
    label: "撤销 workspace 贡献资产",
    targetMethod: "handleWorkspaceContributionRevoke",
    path: "/api/workspace/contributions/:contributionId/revoke",
    params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: workspaceBindingSchema()
  }),
protocolOperation({
    id: "workspace.proposal.create",
    feature: "agent_workspace",
    label: "创建 workspace 提案",
    targetMethod: "handleWorkspaceProposalCreate",
    path: "/api/workspace/proposals/create",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: schema(["workspaceId", "title"], {
      workspaceId: { type: "string" },
      runId: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      proposal: { type: "object" },
      evidenceRefs: { type: "array" }
    })
  }),
protocolOperation({
    id: "workspace.proposal.apply",
    feature: "agent_workspace",
    label: "审核并应用 workspace 提案",
    targetMethod: "handleWorkspaceProposalApply",
    path: "/api/workspace/proposals/apply",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: schema(["workspaceId", "proposalId"], {
      workspaceId: { type: "string" },
      proposalId: { type: "string" },
      submissionId: { type: "string" },
      resolution: { type: "string" },
      note: { type: "string" },
      decision: { type: "object" }
    })
  }),
protocolOperation({
    id: "workspace.asset.policy.set",
    feature: "agent_workspace",
    label: "设置 workspace 资产策略",
    targetMethod: "handleWorkspaceAssetPolicySet",
    path: "/api/workspace/assets/policy",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      additionalProperties: true,
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 256 }
      }
    }
  }),
protocolOperation({
    id: "workspace.asset.permission.check",
    feature: "agent_workspace",
    label: "检查 workspace 资产权限",
    targetMethod: "handleWorkspaceAssetPermissionCheck",
    path: "/api/workspace/assets/permission/check",
    scopes: ["workspace:read"]
  }),
workspaceAssetOperation({
    id: "workspace.asset.target.connect",
    label: "连接 workspace 资产目标",
    targetMethod: "handleWorkspaceAssetTargetConnect",
    path: "/api/workspace/assets/targets/connect",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.list",
    label: "列出 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetList",
    method: "GET",
    path: "/api/workspace/assets",
    query: ASSET_QUERY,
    coerce: { limit: "number" },
    scopes: ["workspace:read"],
    readOnly: true,
    inputSchema: schema([], {
      workspaceId: { type: "string" },
      targetKind: { type: "string" },
      assetRef: { type: "string" },
      path: { type: "string" },
      provider: { type: "string" },
      repoId: { type: "string" },
      limit: { type: "number" }
    })
  }),
workspaceAssetOperation({
    id: "workspace.asset.read",
    label: "读取 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetRead",
    method: "GET",
    path: "/api/workspace/assets/read",
    query: [
      ...ASSET_QUERY,
      { name: "includeText", aliases: ["include-text", "includeText"] },
  { name: "encoding", aliases: ["encoding"] }
    ],
    scopes: ["workspace:read"],
    readOnly: true
  }),
workspaceAssetOperation({
    id: "workspace.asset.submit",
    label: "提交 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetSubmit",
    path: "/api/workspace/assets/submit",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.mutate",
    label: "变更 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetMutate",
    path: "/api/workspace/assets/mutate",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.sync.plan",
    label: "生成 workspace 统一资产同步计划",
    targetMethod: "handleWorkspaceAssetSyncPlan",
    path: "/api/workspace/assets/sync/plan",
    scopes: ["workspace:read"],
    risk: "read_only",
    readOnly: true,
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.sync.apply",
    label: "应用 workspace 统一资产同步计划",
    targetMethod: "handleWorkspaceAssetSyncApply",
    path: "/api/workspace/assets/sync/apply",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.import",
    label: "导入 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetImport",
    path: "/api/workspace/assets/import",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.export",
    label: "导出 workspace 统一资产",
    targetMethod: "handleWorkspaceAssetExport",
    path: "/api/workspace/assets/export",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.review.comment",
    label: "评论 workspace 统一资产评审",
    targetMethod: "handleWorkspaceAssetReviewComment",
    path: "/api/workspace/assets/review/comment",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.review.requestChanges",
    label: "要求 workspace 统一资产修改",
    targetMethod: "handleWorkspaceAssetReviewRequestChanges",
    path: "/api/workspace/assets/review/request-changes",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.review.approve",
    label: "批准 workspace 统一资产评审",
    targetMethod: "handleWorkspaceAssetReviewApprove",
    path: "/api/workspace/assets/review/approve",
    scopes: ["workspace:maintain"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.checkpoint",
    label: "创建 workspace 统一资产 checkpoint",
    targetMethod: "handleWorkspaceAssetCheckpoint",
    path: "/api/workspace/assets/checkpoint",
    scopes: ["workspace:write"],
    risk: "safe_write",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.lineage",
    label: "查询 workspace 统一资产血缘",
    targetMethod: "handleWorkspaceAssetLineage",
    path: "/api/workspace/assets/lineage",
    scopes: ["workspace:read"],
    risk: "read_only",
    readOnly: true,
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.receipt.get",
    label: "读取 workspace 统一资产凭证",
    targetMethod: "handleWorkspaceAssetReceiptGet",
    path: "/api/workspace/assets/receipts/get",
    scopes: ["workspace:read"],
    risk: "read_only",
    readOnly: true,
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
workspaceAssetOperation({
    id: "workspace.asset.backfill",
    label: "重建 workspace 统一资产目录",
    targetMethod: "handleWorkspaceAssetBackfill",
    path: "/api/workspace/assets/backfill",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: ASSET_OPERATION_SCHEMA
  }),
protocolOperation({
    id: "workspace.audit.query",
    feature: "agent_workspace",
    label: "查询 workspace 审计",
    targetMethod: "handleWorkspaceAuditQuery",
    method: "GET",
    path: "/api/workspace/audit",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "operationId", aliases: ["operation-id", "operationId"] }],
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.operation.history",
    feature: "agent_workspace",
    label: "查询 workspace 操作历史",
    targetMethod: "handleWorkspaceOperationHistory",
    method: "GET",
    path: "/api/workspace/operations/history",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "operationId", aliases: ["operation-id", "operationId"] }],
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.checkpoint.tree.list",
    feature: "agent_workspace",
    label: "列出 workspace checkpoint tree",
    targetMethod: "handleWorkspaceCheckpointTreeList",
    method: "GET",
    path: "/api/workspace/checkpoints/trees",
    query: [{ name: "limit", aliases: ["limit"] },
  { name: "kind", aliases: ["kind"] },
  { name: "ownerId", aliases: ["owner-id", "ownerId"] }],
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.checkpoint.node.get",
    feature: "agent_workspace",
    label: "读取 workspace checkpoint 节点",
    targetMethod: "handleWorkspaceCheckpointNodeGet",
    method: "GET",
    path: "/api/workspace/checkpoints/nodes/:treeId",
    params: [{ name: "treeId", aliases: ["tree-id", "id"], required: true }],
    scopes: ["workspace:read"]
  }),
protocolOperation({
    id: "workspace.checkpoint.diff",
    feature: "agent_workspace",
    label: "生成 workspace checkpoint diff",
    targetMethod: "handleWorkspaceCheckpointDiff",
    path: "/api/workspace/checkpoints/diff",
    scopes: ["workspace:read"],
    inputSchema: WORKSPACE_CHECKPOINT_DIFF_SCHEMA
  }),
protocolOperation({
    id: "workspace.checkpoint.restore.preview",
    feature: "agent_workspace",
    label: "预览 workspace checkpoint 恢复",
    targetMethod: "handleWorkspaceCheckpointRestorePreview",
    path: "/api/workspace/checkpoints/restore/preview",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: WORKSPACE_CHECKPOINT_RESTORE_SCHEMA
  }),
protocolOperation({
    id: "workspace.checkpoint.restore",
    feature: "agent_workspace",
    label: "恢复 workspace checkpoint",
    targetMethod: "handleWorkspaceCheckpointRestore",
    path: "/api/workspace/checkpoints/restore",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: WORKSPACE_CHECKPOINT_RESTORE_SCHEMA
  }),
protocolOperation({
    id: "workspace.checkpoint.scope.query",
    feature: "agent_workspace",
    label: "查询 workspace checkpoint 影响范围",
    targetMethod: "handleWorkspaceCheckpointScopeQuery",
    path: "/api/workspace/checkpoints/scope/query",
    scopes: ["workspace:read"],
    inputSchema: WORKSPACE_CHECKPOINT_SCOPE_SCHEMA
  }),
protocolOperation({
    id: "workspace.operation.revert.scope",
    feature: "agent_workspace",
    label: "预览 workspace 操作回滚范围",
    targetMethod: "handleWorkspaceOperationRevertScope",
    path: "/api/workspace/operations/revert/scope",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: WORKSPACE_OPERATION_REVERT_SCHEMA
  }),
protocolOperation({
    id: "workspace.operation.revert.apply",
    feature: "agent_workspace",
    label: "执行 workspace 操作回滚",
    targetMethod: "handleWorkspaceOperationRevertApply",
    path: "/api/workspace/operations/revert/apply",
    scopes: ["workspace:maintain"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain",
    inputSchema: WORKSPACE_OPERATION_REVERT_SCHEMA
  })
]);
