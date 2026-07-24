export function createSystemControllerWorkspaceRuntimeHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  protocolPayload,
  contextRuntime,
  agentWorkspace,
  userDataPath
}) {
  return {
    async handleContextProfiles({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0 ? "context.profiles.set" : "context.profiles.get"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "上下文 profile 操作失败。"
      });
    },
    async handleContextPreview({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.preview",
        input: parseJsonBody(requestBody),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "上下文预览失败。"
      });
    },
    async handleContextCompactionPreview({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.compaction.preview",
        input: parseJsonBody(requestBody),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "上下文压缩预览失败。"
      });
    },
    async handleContextCompactionRun({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.compaction.run",
        input: parseJsonBody(requestBody),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "上下文压缩运行失败。"
      });
    },
    async handleContextCompactionRecords({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.compaction.records",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "读取上下文压缩记录失败。"
      });
    },
    async handleContextSessionMemory({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.session_memory.get",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "读取上下文会话记忆失败。"
      });
    },
    async handleContextSessionMemoryClear({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.session_memory.clear",
        input: parseJsonBody(requestBody),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "清理上下文会话记忆失败。"
      });
    },
    async handleContextBuildRecords({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.build_records",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "读取上下文编译记录失败。"
      });
    },
    async handleContextEvaluationRuns({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "context.evaluation.runs.create",
        input: parseJsonBody(requestBody),
        response,
        context: { contextRuntime, agentWorkspace, authSession },
        errorMessage: "上下文 replay 评估失败。"
      });
    },
    async handleAgentWorkspaces({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { userDataPath, agentWorkspace, authSession },
        errorMessage: "读取智能体工作空间失败。"
      });
    },
    async handleAgentWorkspace({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.get",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { userDataPath, agentWorkspace, authSession },
        errorMessage: "读取智能体工作空间失败。"
      });
    },
    async handleAgentSessions({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.list",
        input: protocolPayload(Buffer.alloc(0), url),
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取会话线程失败。"
      });
    },
    async handleAgentSession({ operation, sessionId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.get",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取会话线程失败。"
      });
    },
    async handleGetAgentSessionContext({ operation, sessionId, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.context.get",
        input: { sessionId },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取会话线程上下文失败。"
      });
    },
    async handleAppendAgentSessionEvent({ operation, sessionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.events.append",
        input: {
          ...parseJsonBody(requestBody),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "追加会话线程事件失败。"
      });
    },
    async handleForkAgentSession({ operation, sessionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.fork",
        input: {
          ...parseJsonBody(requestBody),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "会话分叉失败。"
      });
    },
    async handleCompareAgentSessions({ operation, sessionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.compare",
        input: {
          ...parseJsonBody(requestBody),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "会话比较失败。"
      });
    },
    async handleAgentSessionMergeProposal({ operation, sessionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.merge_proposal",
        input: {
          ...parseJsonBody(requestBody),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "会话合并提案失败。"
      });
    },
    async handleArchiveAgentSession({ operation, sessionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sessions.archive",
        input: {
          ...parseJsonBody(requestBody),
          sessionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "会话归档失败。"
      });
    },
    async handleResolveAgentWorkspaceSubmission({ operation, workspaceId, submissionId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.submissions.resolve",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId,
          submissionId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "审核共享提交失败。"
      });
    },
    async handleResolveAgentWorkspaceIssue({ operation, workspaceId, issueId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.issues.resolve",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId,
          issueId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "解决共享空间 issue 失败。"
      });
    },
    async handleCreateAgentWorkspace({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.create",
        input: parseJsonBody(requestBody),
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "创建智能体工作空间失败。"
      });
    },
    async handleDeleteAgentWorkspace({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.delete",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "删除智能体工作空间失败。"
      });
    },
    async handleAgentWorkspaceLocks({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.locks.list",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取智能体工作空间锁失败。"
      });
    },
    async handleAgentWorkspaceLock({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.locks.write",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "写入智能体工作空间锁失败。"
      });
    },
    async handleGetWorkspaceContext({ operation, workspaceId, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.context.get",
        input: { workspaceId },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取工作空间上下文失败。"
      });
    },
    async handleExportWorkspaceContextBundle({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.context_bundle.export",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "导出工作空间上下文包失败。"
      });
    },
    async handleRestoreWorkspaceContextBundle({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.context_bundle.restore",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "恢复工作空间上下文包失败。"
      });
    },
    async handleGetWorkspaceChain({ operation, workspaceId, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.chain.get",
        input: { workspaceId },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "读取工作空间继承链失败。"
      });
    },
    async handleSetWorkspaceParent({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.parent.set",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "设置工作空间父级失败。"
      });
    },
    async handleHotSwapWorkspaceProfile({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.profile.hotswap",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "热切换工作空间 profile 失败。"
      });
    },
    async handleSetWorkspaceOwnedSources({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.sources.set",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "设置工作空间本地资源失败。"
      });
    },
    async handleShareWorkspace({ operation, workspaceId, targetWorkspaceId, requestBody, response, authSession, request }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.share",
        input: {
          ...parseJsonBody(requestBody),
          ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
          workspaceId
        },
        response,
        context: {
          userDataPath,
          agentWorkspace,
          authSession,
          operationAuthorization: request?.__licoToolRuntimeAuthorization || null
        },
        errorMessage: "共享工作空间失败。"
      });
    },
    async handleUnshareWorkspace({ operation, workspaceId, targetWorkspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.unshare",
        input: {
          ...parseJsonBody(requestBody),
          ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
          workspaceId
        },
        response,
        context: { userDataPath, agentWorkspace, authSession },
        errorMessage: "撤销工作空间共享失败。"
      });
    },
    async handleCreateWorkspaceFolder({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.folder.create",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "创建工作空间文件夹失败。"
      });
    },
    async handleListWorkspaceFiles({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.files.list",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "列出工作空间文件失败。"
      });
    },
    async handleGetWorkspaceFile({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.stat",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "查询工作空间文件失败。"
      });
    },
    async handleDownloadWorkspaceFile({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.download",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "下载工作空间文件失败。"
      });
    },
    async handleUploadWorkspaceFile({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.upload",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "上传工作空间文件失败。"
      });
    },
    async handleWriteWorkspaceFile({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.write",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "写入工作空间文件失败。"
      });
    },
    async handleDeleteWorkspaceFile({ operation, workspaceId, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.delete",
        input: {
          ...protocolPayload(Buffer.alloc(0), url),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "删除工作空间文件失败。"
      });
    },
    async handleMoveWorkspaceFile({ operation, workspaceId, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_workspaces.file.move",
        input: {
          ...parseJsonBody(requestBody),
          workspaceId
        },
        response,
        context: { agentWorkspace, authSession },
        errorMessage: "移动工作空间文件失败。"
      });
    },
  };
}
