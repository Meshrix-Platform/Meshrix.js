import {
  STATIC_SEMANTIC_FAMILY_COUNT,
  resolveAcpPromptRisk
} from "./operation-registry-governed-definitions.mjs";

export const AGENT_SESSION_OPERATION_DEFINITIONS = Object.freeze([
{
      id: "agent_sessions.list",
      feature: "agent_workspace",
      label: "列出团队共享会话线程",
      target: { controller: "system", method: "handleAgentSessions" },
      http: {
        method: "GET",
        path: "/api/agent-sessions",
        query: [
          { name: "status", aliases: ["status"] },
    { name: "workspaceId", aliases: ["workspace-id", "workspaceId"] },
    { name: "limit", aliases: ["limit"] },
    { name: "includeLastEvent", aliases: ["include-last-event", "includeLastEvent"] }
        ],
        coerce: { limit: "number", includeLastEvent: "boolean" }
      },
      rpc: {
        method: "agent_sessions.list",
        query: [
          { name: "status", aliases: ["status"] },
    { name: "workspaceId", aliases: ["workspace-id", "workspaceId"] },
    { name: "limit", aliases: ["limit"] }
        ]
      },
      cli: {
        command: ["agent-sessions"],
        usage: "agent-sessions [--workspace-id WORKSPACE_ID] [--status active] [--limit 100]"
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_sessions.get",
      feature: "agent_workspace",
      label: "读取团队共享会话线程",
      target: { controller: "system", method: "handleAgentSession" },
      http: {
        method: "GET",
        path: "/api/agent-sessions/:sessionId",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }],
        query: [
          { name: "includeEvents", aliases: ["include-events", "includeEvents"] },
    { name: "eventLimit", aliases: ["event-limit", "eventLimit", "limit"] }
        ],
        coerce: { includeEvents: "boolean", eventLimit: "number" }
      },
      rpc: {
        method: "agent_sessions.get",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "get"],
        usage: "agent-sessions get --id SESSION_ID",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_sessions.context.get",
      feature: "agent_workspace",
      label: "读取会话线程运行上下文",
      target: { controller: "system", method: "handleGetAgentSessionContext" },
      http: {
        method: "GET",
        path: "/api/agent-sessions/:sessionId/context",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.context.get",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "context"],
        usage: "agent-sessions context --id SESSION_ID",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_sessions.events.append",
      feature: "agent_workspace",
      label: "追加会话线程事件",
      target: { controller: "system", method: "handleAppendAgentSessionEvent" },
      http: {
        method: "POST",
        path: "/api/agent-sessions/:sessionId/events",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.events.append",
        body: "params",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "events", "append"],
        usage: "agent-sessions events append --id SESSION_ID --body event.json",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_sessions.fork",
      feature: "agent_workspace",
      label: "从会话线程分叉新线程",
      target: { controller: "system", method: "handleForkAgentSession" },
      http: {
        method: "POST",
        path: "/api/agent-sessions/:sessionId/fork",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.fork",
        body: "params",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "fork"],
        usage: "agent-sessions fork --id SESSION_ID --body fork.json",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_sessions.compare",
      feature: "agent_workspace",
      label: "比较会话线程分叉",
      target: { controller: "system", method: "handleCompareAgentSessions" },
      http: {
        method: "POST",
        path: "/api/agent-sessions/:sessionId/compare",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.compare",
        body: "params",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "compare"],
        usage: "agent-sessions compare --id SESSION_ID --body compare.json",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:read"],
      readOnly: true,
      concurrencySafe: true
    },
{
      id: "agent_sessions.merge_proposal",
      feature: "agent_workspace",
      label: "创建会话线程合并提案",
      target: { controller: "system", method: "handleAgentSessionMergeProposal" },
      http: {
        method: "POST",
        path: "/api/agent-sessions/:sessionId/merge-proposal",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.merge_proposal",
        body: "params",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "merge-proposal"],
        usage: "agent-sessions merge-proposal --id SESSION_ID --body proposal.json",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_sessions.archive",
      feature: "agent_workspace",
      label: "归档会话线程",
      target: { controller: "system", method: "handleArchiveAgentSession" },
      http: {
        method: "POST",
        path: "/api/agent-sessions/:sessionId/archive",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      rpc: {
        method: "agent_sessions.archive",
        body: "params",
        params: [{ name: "sessionId", aliases: ["session-id", "sessionId", "id"], required: true }]
      },
      cli: {
        command: ["agent-sessions", "archive"],
        usage: "agent-sessions archive --id SESSION_ID --body archive.json",
        pathParams: { sessionId: ["session-id", "sessionId", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_workspaces.submissions.resolve",
      feature: "agent_workspace",
      label: "审核智能体共享提交",
      target: { controller: "system", method: "handleResolveAgentWorkspaceSubmission" },
      http: { method: "POST", path: "/api/agent-workspaces/:workspaceId/submissions/:submissionId/resolve" },
      rpc: {
        method: "agent_workspaces.submissions.resolve",
        body: "params",
        params: [
          { name: "workspaceId", aliases: ["workspace-id", "workspaceId"], required: true },
    { name: "submissionId", aliases: ["submission-id", "submissionId", "id"], required: true }
        ]
      },
      cli: {
        command: ["agent-workspaces", "submission", "resolve"],
        usage: "agent-workspaces submission resolve --workspace-id WORKSPACE_ID --id SUBMISSION_ID --body resolution.json",
        pathParams: {
          workspaceId: ["workspace-id", "workspaceId"],
          submissionId: ["submission-id", "submissionId", "id"]
        }
      },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.issues.resolve",
      feature: "agent_workspace",
      label: "解决智能体共享空间 issue",
      target: { controller: "system", method: "handleResolveAgentWorkspaceIssue" },
      http: { method: "POST", path: "/api/agent-workspaces/:workspaceId/issues/:issueId/resolve" },
      rpc: {
        method: "agent_workspaces.issues.resolve",
        body: "params",
        params: [
          { name: "workspaceId", aliases: ["workspace-id", "workspaceId"], required: true },
    { name: "issueId", aliases: ["issue-id", "issueId", "id"], required: true }
        ]
      },
      cli: {
        command: ["agent-workspaces", "issue", "resolve"],
        usage: "agent-workspaces issue resolve --workspace-id WORKSPACE_ID --id ISSUE_ID --body resolution.json",
        pathParams: {
          workspaceId: ["workspace-id", "workspaceId"],
          issueId: ["issue-id", "issueId", "id"]
        }
      },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.locks.list",
      feature: "agent_workspace",
      label: "列出智能体共享空间锁",
      target: { controller: "system", method: "handleAgentWorkspaceLocks" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/locks",
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "includeExpired", aliases: ["include-expired", "includeExpired"] }
        ],
        coerce: { limit: "number", includeExpired: "boolean" }
      },
      rpc: {
        method: "agent_workspaces.locks.list",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "includeExpired", aliases: ["include-expired", "includeExpired"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "locks"],
        usage: "agent-workspaces locks --workspace-id WORKSPACE_ID",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.locks.write",
      feature: "agent_workspace",
      label: "获取或释放智能体共享空间锁",
      target: { controller: "system", method: "handleAgentWorkspaceLock" },
      http: { method: "POST", path: "/api/agent-workspaces/:workspaceId/locks" },
      rpc: {
        method: "agent_workspaces.locks.write",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "lock"],
        usage: "agent-workspaces lock --workspace-id WORKSPACE_ID --body lock.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_workspaces.files.list",
      feature: "agent_workspace",
      label: "列出智能体共享工作空间文件路径",
      target: { controller: "system", method: "handleListWorkspaceFiles" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/files",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "folderPath", "folder-path"] },
    { name: "recursive", aliases: ["recursive"] },
    { name: "includeDirectories", aliases: ["include-directories", "includeDirectories"] },
    { name: "includeFiles", aliases: ["include-files", "includeFiles"] },
    { name: "limit", aliases: ["limit"] }
        ],
        coerce: { recursive: "boolean", includeDirectories: "boolean", includeFiles: "boolean", limit: "number" }
      },
      rpc: {
        method: "agent_workspaces.files.list",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "folderPath", "folder-path"] },
    { name: "recursive", aliases: ["recursive"] },
    { name: "includeDirectories", aliases: ["include-directories", "includeDirectories"] },
    { name: "includeFiles", aliases: ["include-files", "includeFiles"] },
    { name: "limit", aliases: ["limit"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "files"],
        usage: "agent-workspaces files --workspace-id WORKSPACE_ID [--path files]",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:read"],
      readOnly: true,
      concurrencySafe: true
    },
{
      id: "agent_workspaces.file.upload",
      feature: "agent_workspace",
      label: "上传文件到智能体共享工作空间",
      target: { controller: "system", method: "handleUploadWorkspaceFile" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/files",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.file.upload",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "files", "upload"],
        usage: "agent-workspaces files upload --workspace-id WORKSPACE_ID --body file.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:write"],
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          folderPath: { type: "string" },
          fileName: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          contentBase64: { type: "string" }
        }
      },
      readOnly: false,
      safety: { risk: "safe_write" }
    },
{
      id: "agent_workspaces.file.stat",
      feature: "agent_workspace",
      label: "查询智能体共享工作空间文件元信息",
      target: { controller: "system", method: "handleGetWorkspaceFile" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/files/stat",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "includeHash", aliases: ["include-hash", "includeHash"] }
        ],
        coerce: { includeHash: "boolean" }
      },
      rpc: {
        method: "agent_workspaces.file.stat",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "includeHash", aliases: ["include-hash", "includeHash"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "files", "stat"],
        usage: "agent-workspaces files stat --workspace-id WORKSPACE_ID --path files/a.txt",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:read"],
      readOnly: true,
      concurrencySafe: true
    },
{
      id: "agent_workspaces.file.download",
      feature: "agent_workspace",
      label: "下载智能体共享工作空间文件内容",
      target: { controller: "system", method: "handleDownloadWorkspaceFile" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/files/download",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "includeText", aliases: ["include-text", "includeText"] },
    { name: "encoding", aliases: ["encoding"] }
        ],
        coerce: { includeText: "boolean" }
      },
      rpc: {
        method: "agent_workspaces.file.download",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "includeText", aliases: ["include-text", "includeText"] },
    { name: "encoding", aliases: ["encoding"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "files", "download"],
        usage: "agent-workspaces files download --workspace-id WORKSPACE_ID --path files/a.txt",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:read"],
      readOnly: true,
      concurrencySafe: true,
      binary: true
    },
{
      id: "agent_workspaces.file.write",
      feature: "agent_workspace",
      label: "覆写智能体共享工作空间文件内容",
      target: { controller: "system", method: "handleWriteWorkspaceFile" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/files/write",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.file.write",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "files", "write"],
        usage: "agent-workspaces files write --workspace-id WORKSPACE_ID --body file.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:write"],
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          contentBase64: { type: "string" },
          encoding: { type: "string" }
        }
      },
      safety: { risk: "safe_write" }
    },
{
      id: "agent_workspaces.file.delete",
      feature: "agent_workspace",
      label: "删除智能体共享工作空间文件或文件夹",
      target: { controller: "system", method: "handleDeleteWorkspaceFile" },
      http: {
        method: "DELETE",
        path: "/api/agent-workspaces/:workspaceId/files",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "recursive", aliases: ["recursive"] }
        ]
      },
      rpc: {
        method: "agent_workspaces.file.delete",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "path", aliases: ["path", "filePath", "file-path"] },
    { name: "recursive", aliases: ["recursive"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "files", "delete"],
        usage: "agent-workspaces files delete --workspace-id WORKSPACE_ID --path files/a.txt [--recursive]",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:write"],
      safety: { risk: "safe_write", requiresConfirmation: true }
    },
]);
