export const STORAGE_WORKSPACE_OPERATION_DEFINITIONS = Object.freeze([









{
      id: "operation_permission.mcp.request_authorization",
      feature: "operation_permission",
      label: "MCP 请求授权",
      target: { controller: "system", method: "handleCreateMcpAuthorizationRequest" },
      http: { method: "POST", path: "/api/mcp/authorization/request", localInForwardMode: true },
      rpc: { method: "operation_permission.mcp.request_authorization" },
      cli: { command: ["mcp", "authorization", "request"], usage: "mcp authorization request --body payload.json" },
      requiredScopes: ["runtime:admin"],
      externalAuth: true,
      externalAuthVerifier: { method: "verifyToolSkillExternalAuth", recordUse: true },
      inputSchema: {
        type: "object",
        required: ["claimTokenHash"],
        additionalProperties: false,
        properties: {
          claimTokenHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          targets: { type: "array", items: { type: "string" } },
          connectorVersion: { type: "string" },
          agentProfileId: { type: "string" },
          processIdentity: { type: "object" },
          label: { type: "string" },
          grantMode: { type: "string" },
          toolsets: { type: "array", items: { type: "string" } },
          scopes: { type: "array", items: { type: "string" } },
          maxRisk: { type: "string" },
          metadata: { type: "object" }
        }
      }
    },
{
      id: "operation_permission.mcp.list_requests",
      feature: "operation_permission",
      label: "MCP 授权请求列表",
      target: { controller: "system", method: "handleListMcpAuthorizationRequests" },
      http: { method: "GET", path: "/api/console/mcp/authorization/requests", localInForwardMode: true },
      rpc: { method: "operation_permission.mcp.list_requests" },
      cli: { command: ["mcp", "authorization", "list"], usage: "mcp authorization list" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "operation_permission.mcp.resolve_request",
      feature: "operation_permission",
      label: "处理 MCP 授权请求",
      target: { controller: "system", method: "handleResolveMcpAuthorizationRequest" },
      http: { method: "POST", path: "/api/console/mcp/authorization/requests/:requestId/resolve", localInForwardMode: true },
      rpc: { method: "operation_permission.mcp.resolve_request" },
      cli: { command: ["mcp", "authorization", "resolve"], usage: "mcp authorization resolve --id REQUEST_ID --body payload.json" },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" },
      inputSchema: {
        type: "object",
        required: ["requestId", "resolution"],
        additionalProperties: false,
        properties: {
          requestId: { type: "string" },
          resolution: { type: "string", enum: ["approved", "denied"] },
          reason: { type: "string" }
        }
      }
    },
{
      id: "storage.summary",
      feature: "storage",
      label: "存储摘要",
      target: { controller: "system", method: "handleGetStorageSummary" },
      http: { method: "GET", path: "/api/storage/summary" },
      rpc: { method: "storage.summary" },
      cli: { command: ["storage"], usage: "storage" },
      requiredScopes: ["console:read"]
    },
{
      id: "storage.doctor",
      feature: "storage",
      label: "诊断存储一致性",
      target: { controller: "system", method: "handleStorageDoctor" },
      http: { method: "GET", path: "/api/storage/doctor" },
      rpc: { method: "storage.doctor" },
      cli: { command: ["storage", "doctor"], usage: "storage doctor" },
      requiredScopes: ["console:read"]
    },
{
      id: "storage.reconcile",
      feature: "storage",
      label: "修复存储一致性",
      target: { controller: "system", method: "handleStorageReconcile" },
      http: { method: "POST", path: "/api/storage/reconcile" },
      rpc: { method: "storage.reconcile", body: "params" },
      cli: {
        command: ["storage", "reconcile"],
        usage: "storage reconcile --confirm",
        bodyParams: [
          { name: "apply", aliases: ["apply"], type: "boolean" },
    { name: "pruneOrphanObjects", aliases: ["prune-orphan-objects", "pruneOrphanObjects"], type: "boolean" }
        ]
      },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "storage.backups.list",
      feature: "storage",
      label: "列出存储备份",
      target: { controller: "system", method: "handleStorageBackups" },
      http: { method: "GET", path: "/api/storage/backups" },
      rpc: { method: "storage.backups.list" },
      cli: { command: ["storage", "backups"], usage: "storage backups" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["backup-restore", "storage"]
    },
{
      id: "storage.backups.create",
      feature: "storage",
      label: "创建存储备份",
      target: { controller: "system", method: "handleStorageBackupCreate" },
      http: { method: "POST", path: "/api/storage/backups" },
      rpc: { method: "storage.backups.create", body: "params" },
      cli: { command: ["storage", "backup"], usage: "storage backup --body backup.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["backup-restore", "storage"],
      safety: { risk: "safe_write" }
    },
{
      id: "storage.backups.retention",
      feature: "storage",
      label: "执行存储备份保留策略",
      target: { controller: "system", method: "handleStorageBackupRetention" },
      http: { method: "POST", path: "/api/storage/backups/retention" },
      rpc: { method: "storage.backups.retention", body: "params" },
      cli: { command: ["storage", "retention"], usage: "storage retention --body retention.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["backup-restore", "storage"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "storage:retention" },
      inputSchema: {
        type: "object",
        required: ["policy", "confirm"],
        properties: {
          policy: { type: "object" },
          confirm: { type: "boolean" }
        }
      },
      audit: { recordInput: false, recordOutput: false },
      log: { recordInput: false, redaction: "strict" }
    },
{
      id: "storage.backups.restore_preview",
      feature: "storage",
      label: "预览存储恢复",
      target: { controller: "system", method: "handleStorageBackupRestorePreview" },
      http: { method: "POST", path: "/api/storage/backups/restore-preview" },
      rpc: { method: "storage.backups.restore_preview", body: "params" },
      cli: { command: ["storage", "restore-preview"], usage: "storage restore-preview --body restore.json" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: false,
      aspects: ["backup-restore", "storage"],
      safety: { risk: "read_only" }
    },
{
      id: "storage.backups.restore",
      feature: "storage",
      label: "恢复存储备份",
      target: { controller: "system", method: "handleStorageBackupRestore" },
      http: { method: "POST", path: "/api/storage/backups/restore" },
      rpc: { method: "storage.backups.restore", body: "params" },
      cli: { command: ["storage", "restore"], usage: "storage restore --body restore.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["backup-restore", "storage"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "storage:restore" }
    },
{
      id: "system.background_processes",
      feature: "system",
      label: "后台 Worker 管理进程状态",
      target: { controller: "system", method: "handleGetBackgroundProcesses" },
      http: { method: "GET", path: "/api/system/background-processes", localInForwardMode: true },
      rpc: { method: "system.background_processes" },
      cli: { command: ["system", "background-processes"], usage: "system background-processes" },
      requiredScopes: ["console:read"]
    },
{
      id: "system.checkpoint_trees.list",
      feature: "system",
      label: "长任务 checkpoint tree 列表",
      target: { controller: "system", method: "handleListCheckpointTrees" },
      http: { method: "GET", path: "/api/system/checkpoint-trees", localInForwardMode: true },
      rpc: { method: "system.checkpoint_trees.list" },
      cli: { command: ["system", "checkpoint-trees"], usage: "system checkpoint-trees [--kind KIND] [--owner-id ID]" },
      requiredScopes: ["console:read"]
    },
{
      id: "system.checkpoint_trees.get",
      feature: "system",
      label: "读取长任务 checkpoint tree",
      target: { controller: "system", method: "handleGetCheckpointTree" },
      http: { method: "GET", path: "/api/system/checkpoint-trees/:treeId", localInForwardMode: true },
      rpc: {
        method: "system.checkpoint_trees.get",
        params: [{ name: "treeId", aliases: ["tree-id", "id"], required: true }]
      },
      cli: {
        command: ["system", "checkpoint-tree"],
        usage: "system checkpoint-tree --id CHECKPOINT_TREE_ID",
        pathParams: { treeId: ["tree-id", "id"] }
      },
      requiredScopes: ["console:read"]
    },
{
      id: "system.monitor_alerts.get",
      feature: "system",
      label: "读取监控报警状态",
      target: { controller: "system", method: "handleMonitorAlerts" },
      http: { method: "GET", path: "/api/system/monitor-alerts", localInForwardMode: true },
      rpc: { method: "system.monitor_alerts.get" },
      cli: { command: ["system", "monitor-alerts"], usage: "system monitor-alerts" },
      requiredScopes: ["console:read"]
    },
{
      id: "system.monitor_alerts.set",
      feature: "system",
      label: "保存监控报警配置",
      target: { controller: "system", method: "handleMonitorAlerts" },
      http: { method: "POST", path: "/api/system/monitor-alerts/config", localInForwardMode: true },
      rpc: { method: "system.monitor_alerts.set", body: "params" },
      cli: { command: ["system", "monitor-alerts", "set"], usage: "system monitor-alerts set --body monitor-alerts.json" },
      requiredScopes: ["maintenance:admin"]
    },
{
      id: "system.monitor_alerts.ack",
      feature: "system",
      label: "确认监控报警",
      target: { controller: "system", method: "handleAcknowledgeMonitorAlert" },
      http: { method: "POST", path: "/api/system/monitor-alerts/:alertId/ack", localInForwardMode: true },
      rpc: {
        method: "system.monitor_alerts.ack",
        params: [{ name: "alertId", aliases: ["alert-id", "id"], required: true }]
      },
      cli: {
        command: ["system", "monitor-alerts", "ack"],
        usage: "system monitor-alerts ack --id ALERT_ID",
        pathParams: { alertId: ["alert-id", "id"] }
      },
      requiredScopes: ["maintenance:admin"]
    },
{
      id: "system.background_supervisor.recover",
      feature: "system",
      label: "拉起后台 Worker 管理进程",
      target: { controller: "system", method: "handleRecoverBackgroundSupervisor" },
      http: { method: "POST", path: "/api/system/background-supervisor/recover", localInForwardMode: true },
      rpc: { method: "system.background_supervisor.recover" },
      cli: {
        command: ["system", "background-supervisor", "recover"],
        usage: "system background-supervisor recover"
      },
      requiredScopes: ["maintenance:admin"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "runtime:admin" }
    },
{
      id: "agent_workspaces.create",
      feature: "agent_workspace",
      label: "创建智能体共享工作空间",
      target: { controller: "system", method: "handleCreateAgentWorkspace" },
      http: { method: "POST", path: "/api/agent-workspaces" },
      rpc: { method: "agent_workspaces.create", body: "params" },
      cli: {
        command: ["agent-workspaces", "create"],
        usage: "agent-workspaces create --body workspace.json"
      },
      requiredScopes: ["workspace:write"],
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          metadata: { type: "object" },
          parentWorkspaceId: { type: "string" }
        }
      }
    },
{
      id: "agent_workspaces.list",
      feature: "agent_workspace",
      label: "列出智能体共享工作空间",
      target: { controller: "system", method: "handleAgentWorkspaces" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces",
        query: [
          { name: "status", aliases: ["status"] },
    { name: "limit", aliases: ["limit"] },
    { name: "includeSummary", aliases: ["include-summary", "includeSummary"] }
        ],
        coerce: { limit: "number", includeSummary: "boolean" }
      },
      rpc: {
        method: "agent_workspaces.list",
        query: [
          { name: "status", aliases: ["status"] },
    { name: "limit", aliases: ["limit"] },
    { name: "includeSummary", aliases: ["include-summary", "includeSummary"] }
        ]
      },
      cli: {
        command: ["agent-workspaces"],
        usage: "agent-workspaces [--status active] [--limit 50]"
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.get",
      feature: "agent_workspace",
      label: "读取智能体共享工作空间",
      target: { controller: "system", method: "handleAgentWorkspace" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId",
        query: [{ name: "includePrivate", aliases: ["include-private", "includePrivate", "private"] }],
        coerce: { includePrivate: "boolean" }
      },
      rpc: {
        method: "agent_workspaces.get",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "get"],
        usage: "agent-workspaces get --id WORKSPACE_ID",
        pathParams: { workspaceId: ["workspace-id", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.delete",
      feature: "agent_workspace",
      label: "删除智能体共享工作空间",
      target: { controller: "system", method: "handleDeleteAgentWorkspace" },
      http: {
        method: "DELETE",
        path: "/api/agent-workspaces/:workspaceId",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.delete",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "delete"],
        usage: "agent-workspaces delete --id WORKSPACE_ID",
        pathParams: { workspaceId: ["workspace-id", "id"] }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "agent_workspaces.folder.create",
      feature: "agent_workspace",
      label: "在智能体共享工作空间中创建文件夹",
      target: { controller: "system", method: "handleCreateWorkspaceFolder" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/folders",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.folder.create",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "folders", "create"],
        usage: "agent-workspaces folders create --workspace-id WORKSPACE_ID --body folder.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:write"],
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          folderPath: { type: "string" },
          path: { type: "string" }
        }
      }
    }
]);
