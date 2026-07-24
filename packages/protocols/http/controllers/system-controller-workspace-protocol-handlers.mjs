export function createSystemControllerWorkspaceProtocolHandlers({
  sendConsoleDomainOperation,
  protocolPayload,
  operationAuditStore,
  checkpointTreeApi,
  agentWorkspace,
  accessControlContext = () => ({})
}) {
  return {
    async handleWorkspaceAuditQuery({ operation, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.audit.query",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { operationAuditStore },
        errorMessage: "查询 workspace 审计失败。"
      });
    },
    async handleWorkspaceOperationHistory({ operation, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.operation.history",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { operationAuditStore },
        errorMessage: "查询 workspace 操作历史失败。"
      });
    },
    async handleWorkspaceAssetTargetConnect({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.target.connect",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "连接 workspace 资产目标失败。"
      });
    },
    async handleWorkspaceAssetList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "列出 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetRead({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.read",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "读取 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetSubmit({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.submit",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "提交 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetMutate({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.mutate",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "变更 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetSyncPlan({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.sync.plan",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "生成 workspace 统一资产同步计划失败。"
      });
    },
    async handleWorkspaceAssetSyncApply({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.sync.apply",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "应用 workspace 统一资产同步计划失败。"
      });
    },
    async handleWorkspaceAssetImport({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.import",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "导入 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetExport({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.export",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "导出 workspace 统一资产失败。"
      });
    },
    async handleWorkspaceAssetReviewComment({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.review.comment",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "评论 workspace 统一资产评审失败。"
      });
    },
    async handleWorkspaceAssetReviewRequestChanges({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.review.requestChanges",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "要求 workspace 统一资产修改失败。"
      });
    },
    async handleWorkspaceAssetReviewApprove({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.review.approve",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "批准 workspace 统一资产评审失败。"
      });
    },
    async handleWorkspaceAssetCheckpoint({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.checkpoint",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "创建 workspace 统一资产 checkpoint 失败。"
      });
    },
    async handleWorkspaceAssetLineage({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.lineage",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "查询 workspace 统一资产血缘失败。"
      });
    },
    async handleWorkspaceAssetReceiptGet({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.receipt.get",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "读取 workspace 统一资产凭证失败。"
      });
    },
    async handleWorkspaceAssetBackfill({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.backfill",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, checkpointTreeApi, operationAuditStore, authSession },
        errorMessage: "重建 workspace 统一资产目录失败。"
      });
    },
    async handleWorkspaceCheckpointTreeList({ operation, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.tree.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { checkpointTreeApi },
        errorMessage: "列出 workspace checkpoint tree 失败。"
      });
    },
    async handleWorkspaceCheckpointNodeGet({ operation, treeId, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.node.get",
        input: { treeId },
        response,
        context: { checkpointTreeApi },
        errorMessage: "读取 workspace checkpoint 节点失败。"
      });
    },
    async handleWorkspaceCheckpointDiff({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.diff",
        input: protocolPayload(requestBody),
        response,
        context: { checkpointTreeApi },
        errorMessage: "生成 workspace checkpoint diff 失败。"
      });
    },
    async handleWorkspaceCheckpointRestorePreview({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.restore.preview",
        input: protocolPayload(requestBody),
        response,
        context: { checkpointTreeApi, agentWorkspace, authSession },
        errorMessage: "预览 workspace checkpoint 恢复失败。"
      });
    },
    async handleWorkspaceCheckpointRestore({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.restore",
        input: protocolPayload(requestBody),
        response,
        context: { checkpointTreeApi, agentWorkspace, authSession },
        errorMessage: "恢复 workspace checkpoint 失败。"
      });
    },
    async handleWorkspaceCheckpointScopeQuery({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.checkpoint.scope.query",
        input: protocolPayload(requestBody),
        response,
        context: { checkpointTreeApi },
        errorMessage: "查询 workspace checkpoint 影响范围失败。"
      });
    },
    async handleWorkspaceOperationRevertScope({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.operation.revert.scope",
        input: protocolPayload(requestBody),
        response,
        context: { operationAuditStore, checkpointTreeApi, agentWorkspace, authSession },
        errorMessage: "预览 workspace 操作回滚范围失败。"
      });
    },
    async handleWorkspaceOperationRevertApply({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.operation.revert.apply",
        input: protocolPayload(requestBody),
        response,
        context: { operationAuditStore, checkpointTreeApi, agentWorkspace, authSession },
        errorMessage: "执行 workspace 操作回滚失败。"
      });
    },
    async handleWorkspaceProposalCreate({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.proposal.create",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "创建 workspace 提案失败。"
      });
    },
    async handleWorkspaceProposalApply({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.proposal.apply",
        input: protocolPayload(requestBody),
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "审核并应用 workspace 提案失败。"
      });
    }
  };
}
