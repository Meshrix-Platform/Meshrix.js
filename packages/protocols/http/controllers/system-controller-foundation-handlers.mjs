export function createSystemControllerFoundationHandlers({
  sendConsoleDomainOperation,
  protocolPayload,
  workspaceIdFrom,
  authorizationFacadeContext,
  accessControlContext,
  getToolSkillManagementProvider = () => null,
  getStrategyManagementProvider = () => null,
  agentWorkspace,
  runtime
}) {
  async function sendAuthorizationOperation({
    operation,
    operationId,
    input = {},
    response,
    authSession,
    request = null,
    errorMessage
  }) {
    await sendConsoleDomainOperation({
      operationId: operation?.id || operationId,
      input,
      response,
      context: authorizationFacadeContext(authSession, request ? { request } : {}),
      errorMessage
    });
  }

  return {
    async handleAuthorizationSubjectResolve({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "authorization.subject.resolve",
        input: protocolPayload(requestBody),
        response,
        context: authorizationFacadeContext(authSession),
        errorMessage: "解析授权主体失败。"
      });
    },
    async handleAuthorizationPolicyEvaluate({ operation, request, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "authorization.policy.evaluate",
        input: protocolPayload(requestBody),
        response,
        context: authorizationFacadeContext(authSession, { request }),
        errorMessage: "统一授权策略裁决失败。"
      });
    },
    async handleAuthorizationGovernanceSummary({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.governance.summary",
        response,
        authSession,
        errorMessage: "读取统一权限治理摘要失败。"
      });
    },
    async handleTagManagementTagsList({ operation, url, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.tags.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        authSession,
        errorMessage: "读取标签列表失败。"
      });
    },
    async handleTagManagementTagGet({ operation, tagId, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.tags.get",
        input: { tagId },
        response,
        authSession,
        errorMessage: "读取标签失败。"
      });
    },
    async handleTagManagementTagUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.tags.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存标签失败。"
      });
    },
    async handleTagManagementTagArchive({ operation, tagId, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.tags.archive",
        input: {
          ...protocolPayload(requestBody),
          tagId
        },
        response,
        authSession,
        errorMessage: "归档标签失败。"
      });
    },
    async handleTagManagementTagRestore({ operation, tagId, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.tags.restore",
        input: { tagId },
        response,
        authSession,
        errorMessage: "恢复标签失败。"
      });
    },
    async handleTagManagementProjectionsList({ operation, url, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.projections.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        authSession,
        errorMessage: "读取标签投影失败。"
      });
    },
    async handleTagManagementProjectionsRebuild({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.projections.rebuild",
        response,
        authSession,
        errorMessage: "重建标签投影失败。"
      });
    },
    async handleTagManagementAuditList({ operation, url, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "tag_management.audit.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        authSession,
        errorMessage: "读取标签审计失败。"
      });
    },
    async handleAuthorizationRolesList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.roles.list",
        response,
        authSession,
        errorMessage: "读取权限角色失败。"
      });
    },
    async handleAuthorizationRoleUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.roles.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存权限角色失败。"
      });
    },
    async handleAuthorizationDepartmentsList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.departments.list",
        response,
        authSession,
        errorMessage: "读取权限部门失败。"
      });
    },
    async handleAuthorizationDepartmentUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.departments.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存权限部门失败。"
      });
    },
    async handleAuthorizationTeamsList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.teams.list",
        response,
        authSession,
        errorMessage: "读取权限团队失败。"
      });
    },
    async handleAuthorizationTeamUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.teams.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存权限团队失败。"
      });
    },
    async handleAuthorizationUserPoliciesList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.users.policies.list",
        response,
        authSession,
        errorMessage: "读取用户授权策略失败。"
      });
    },
    async handleAuthorizationUserPolicyUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.users.policy.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存用户授权策略失败。"
      });
    },
    async handleAuthorizationAgentGroupsList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.agent_groups.list",
        response,
        authSession,
        errorMessage: "读取智能体分组失败。"
      });
    },
    async handleAuthorizationAgentGroupUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.agent_groups.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存智能体分组失败。"
      });
    },
    async handleAuthorizationAgentBindingsList({ operation, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.agents.bindings.list",
        response,
        authSession,
        errorMessage: "读取智能体绑定失败。"
      });
    },
    async handleAuthorizationAgentBindingUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.agents.binding.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存智能体绑定失败。"
      });
    },
    async handleAuthorizationApprovalsList({ operation, url, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.approvals.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        authSession,
        errorMessage: "读取智能体审批失败。"
      });
    },
    async handleAuthorizationApprovalUpsert({ operation, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.approvals.upsert",
        input: protocolPayload(requestBody),
        response,
        authSession,
        errorMessage: "保存智能体审批失败。"
      });
    },
    async handleAuthorizationApprovalRevoke({ operation, approvalId, requestBody, response, authSession }) {
      await sendAuthorizationOperation({
        operation,
        operationId: "authorization.approvals.revoke",
        input: {
          ...protocolPayload(requestBody),
          approvalId
        },
        response,
        authSession,
        errorMessage: "撤销智能体审批失败。"
      });
    },
    async handleAuthorizationReceiptsList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "authorization.receipts.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: authorizationFacadeContext(authSession),
        errorMessage: "读取授权回执失败。"
      });
    },
    async handleAuthorizationLoanRecordsList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "authorization.loan_records.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: authorizationFacadeContext(authSession),
        errorMessage: "读取授权借用记录失败。"
      });
    },
    async handleAuthorizationDeniedRequestsList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "authorization.denied_requests.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: authorizationFacadeContext(authSession),
        errorMessage: "读取授权拒绝请求失败。"
      });
    },
    async handleCreateMcpAuthorizationRequest({ operation, request, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "operation_permission.mcp.request_authorization",
        input: protocolPayload(requestBody),
        response,
        context: { toolSkillManagementProvider: getToolSkillManagementProvider(), request },
        errorMessage: "MCP Authorization API request failed."
      });
    },
    async handleListMcpAuthorizationRequests({ operation, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "operation_permission.mcp.list_requests",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { toolSkillManagementProvider: getToolSkillManagementProvider() },
        errorMessage: "MCP Authorization API list failed."
      });
    },
    async handleResolveMcpAuthorizationRequest({ operation, requestId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "operation_permission.mcp.resolve_request",
        input: {
          ...protocolPayload(requestBody),
          requestId
        },
        response,
        context: { toolSkillManagementProvider: getToolSkillManagementProvider(), authSession },
        errorMessage: "MCP Authorization API resolve failed."
      });
    },
    async handleOperationPermissionPassthrough({ operation, request, requestBody, url, response, params = {}, operationLock = null, signal = null }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "operation_permission.http.passthrough",
        input: {
          ...protocolPayload(requestBody, url),
          ...(params && typeof params === "object" ? params : {})
        },
        response,
        context: {
          toolSkillManagementProvider: getToolSkillManagementProvider(),
          strategyManagementProvider: getStrategyManagementProvider(),
          request,
          response,
          requestBody,
          url,
          method: operation?.http?.method || request?.method || "GET",
          signal: operationLock?.signal || signal || null
        },
        errorMessage: "Operation Permission API request failed."
      });
    },
    async handleSecurityAlertsOperation({ operation, requestBody, url, response, authSession, params = {} }) {
      const method = String(operation?.http?.method || "GET").toUpperCase();
      const payload = ["GET", "HEAD", "OPTIONS"].includes(method)
        ? protocolPayload(Buffer.alloc(0), url)
        : protocolPayload(requestBody, url);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "security_alerts.list",
        input: {
          ...payload,
          ...(params && typeof params === "object" ? params : {})
        },
        response,
        context: accessControlContext(authSession, {}),
        errorMessage: "Security alerts operation failed."
      });
    },
    async handleUpstreamGatewayOperation({
      operation,
      request,
      requestBody,
      url,
      response,
      authSession,
      params = {},
      operationLock = null,
      signal = null
    }) {
      const method = String(operation?.http?.method || "POST").toUpperCase();
      const rawPublishingCommand = operation?.http?.rawJsonBytes === true;
      const payload = rawPublishingCommand
        ? { ...(params && typeof params === "object" ? params : {}) }
        : ["GET", "HEAD", "OPTIONS"].includes(method)
        ? protocolPayload(Buffer.alloc(0), url)
        : protocolPayload(requestBody, url);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "gateway.operation",
        input: {
          ...payload,
          ...(params && typeof params === "object" ? params : {})
        },
        response,
        context: accessControlContext(authSession, {
          ...params,
          request,
          rawRequestBody: rawPublishingCommand ? requestBody : null,
          signal: operationLock?.signal || signal || null
        }),
        errorMessage: "上游网关操作失败。"
      });
    },
    async handleWorkspaceProtocolInfo({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.info",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取 workspace 信息失败。"
      });
    },
    async handleWorkspaceProtocolFileUpload({ operation, requestBody, response, authSession }) {
      const payload = protocolPayload(requestBody);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.file.upload",
        input: {
          ...payload,
          workspaceId: workspaceIdFrom(payload)
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "上传 workspace 文件失败。"
      });
    },
    async handleWorkspaceProtocolFileList({ operation, url, response, authSession }) {
      const payload = protocolPayload(Buffer.alloc(0), url);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.file.list",
        input: {
          ...payload,
          workspaceId: workspaceIdFrom(payload)
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "列出 workspace 文件失败。"
      });
    },
    async handleWorkspaceProtocolFileDownload({ operation, url, response, authSession }) {
      const payload = protocolPayload(Buffer.alloc(0), url);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.file.download",
        input: {
          ...payload,
          workspaceId: workspaceIdFrom(payload)
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "下载 workspace 文件失败。"
      });
    },
    async handleWorkspaceProtocolFileWrite({ operation, requestBody, response, authSession }) {
      const payload = protocolPayload(requestBody);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.file.write",
        input: {
          ...payload,
          workspaceId: workspaceIdFrom(payload)
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "写入 workspace 文件失败。"
      });
    },
    async handleWorkspaceProtocolFilePatch({ operation, requestBody, response, authSession }) {
      const payload = protocolPayload(requestBody);
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.file.patch",
        input: {
          ...payload,
          workspaceId: workspaceIdFrom(payload)
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "补丁更新 workspace 文件失败。"
      });
    },
    async handleWorkspaceContributionSubmit({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.submit",
        input: protocolPayload(requestBody),
        response,
        context: accessControlContext(authSession),
        errorMessage: "提交贡献失败。"
      });
    },
    async handleWorkspaceContributionList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: accessControlContext(authSession),
        errorMessage: "读取贡献列表失败。"
      });
    },
    async handleWorkspaceContributionLeaderboard({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.leaderboard",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: accessControlContext(authSession),
        errorMessage: "读取贡献排行榜失败。"
      });
    },
    async handleWorkspaceContributionStats({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.stats",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: accessControlContext(authSession),
        errorMessage: "读取贡献统计失败。"
      });
    },
    async handleWorkspaceContributionReport({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.report",
        input: protocolPayload(requestBody),
        response,
        context: accessControlContext(authSession),
        errorMessage: "生成贡献报告失败。"
      });
    },
    async handleWorkspaceContributionAssetsList({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.assets.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: accessControlContext(authSession),
        errorMessage: "读取贡献资产列表失败。"
      });
    },
    async handleWorkspaceContributionPermissionRequest({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.permission.request",
        input: {
          ...protocolPayload(requestBody),
          contributionId
        },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "请求贡献权限失败。"
      });
    },
    async handleWorkspaceContributionPermissionGrant({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.permission.grant",
        input: {
          ...protocolPayload(requestBody),
          contributionId
        },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "授予贡献权限失败。"
      });
    },
    async handleWorkspaceContributionScan({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.scan",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "扫描贡献失败。"
      });
    },
    async handleWorkspaceContributionReview({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.review",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "审核贡献失败。"
      });
    },
    async handleWorkspaceContributionPreview({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.preview",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "生成贡献预览失败。"
      });
    },
    async handleWorkspaceContributionPublish({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.publish",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "发布贡献失败。"
      });
    },
    async handleWorkspaceContributionAdopt({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.adopt",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "采用贡献失败。"
      });
    },
    async handleWorkspaceContributionReject({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.reject",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "拒绝贡献失败。"
      });
    },
    async handleWorkspaceContributionRequestChanges({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.request_changes",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "要求修改贡献失败。"
      });
    },
    async handleWorkspaceContributionRevoke({ operation, contributionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.contribution.revoke",
        input: { ...protocolPayload(requestBody), contributionId },
        response,
        context: accessControlContext(authSession, { contributionId }),
        errorMessage: "撤销贡献失败。"
      });
    },
    async handleWorkspaceAssetPolicySet({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.policy.set",
        input: protocolPayload(requestBody),
        response,
        context: authorizationFacadeContext(authSession),
        errorMessage: "设置工作空间资产策略失败。"
      });
    },
    async handleWorkspaceAssetPermissionCheck({ operation, request, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "workspace.asset.permission.check",
        input: protocolPayload(requestBody),
        response,
        context: authorizationFacadeContext(authSession, { request }),
        errorMessage: "检查工作空间资产权限失败。"
      });
    }
  };
}
