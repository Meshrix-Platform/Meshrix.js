export const WORKSPACE_CONTEXT_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
{
      id: "agent_workspaces.file.move",
      feature: "agent_workspace",
      label: "移动/重命名智能体共享工作空间文件",
      target: { controller: "system", method: "handleMoveWorkspaceFile" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/files/move",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.file.move",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "files", "move"],
        usage: "agent-workspaces files move --workspace-id WORKSPACE_ID --body move.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["storage:write"],
      inputSchema: {
        type: "object",
        required: ["sourcePath", "targetPath"],
        properties: {
          sourcePath: { type: "string" },
          targetPath: { type: "string" },
          overwrite: { type: "boolean" }
        }
      },
      safety: { risk: "safe_write", requiresConfirmation: true }
    },
{
      id: "agent_workspaces.context.get",
      feature: "agent_workspace",
      label: "获取工作空间完整运行上下文（继承链解析）",
      target: { controller: "system", method: "handleGetWorkspaceContext" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/context",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.context.get" },
      cli: {
        command: ["agent-workspaces", "context"],
        usage: "agent-workspaces context --workspace-id WORKSPACE_ID",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.context_bundle.export",
      feature: "agent_workspace",
      label: "导出工作空间上下文压缩包",
      target: { controller: "system", method: "handleExportWorkspaceContextBundle" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/context-bundle",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "format", aliases: ["format"] },
    { name: "compress", aliases: ["compress"] },
    { name: "compressedOnly", aliases: ["compressed-only", "compressedOnly"] },
    { name: "includePrivate", aliases: ["include-private", "includePrivate", "private"] },
    { name: "maxItems", aliases: ["max-items", "maxItems", "limit"] },
    { name: "contentPreviewChars", aliases: ["content-preview-chars", "contentPreviewChars"] }
        ],
        coerce: {
          includePrivate: "boolean",
          compressedOnly: "boolean",
          maxItems: "number",
          contentPreviewChars: "number"
        }
      },
      rpc: {
        method: "agent_workspaces.context_bundle.export",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }],
        query: [
          { name: "format", aliases: ["format"] },
    { name: "compress", aliases: ["compress"] },
    { name: "compressedOnly", aliases: ["compressed-only", "compressedOnly"] },
    { name: "includePrivate", aliases: ["include-private", "includePrivate", "private"] },
    { name: "maxItems", aliases: ["max-items", "maxItems", "limit"] },
    { name: "contentPreviewChars", aliases: ["content-preview-chars", "contentPreviewChars"] }
        ]
      },
      cli: {
        command: ["agent-workspaces", "context-bundle"],
        usage: "agent-workspaces context-bundle --workspace-id WORKSPACE_ID [--format compressed]",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.context_bundle.restore",
      feature: "agent_workspace",
      label: "恢复工作空间上下文压缩包",
      target: { controller: "system", method: "handleRestoreWorkspaceContextBundle" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/context-bundle/restore",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: {
        method: "agent_workspaces.context_bundle.restore",
        body: "params",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      cli: {
        command: ["agent-workspaces", "context-bundle", "restore"],
        usage: "agent-workspaces context-bundle restore --workspace-id WORKSPACE_ID --body bundle.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.chain.get",
      feature: "agent_workspace",
      label: "读取工作空间继承链与解析后的资源范围",
      target: { controller: "system", method: "handleGetWorkspaceChain" },
      http: {
        method: "GET",
        path: "/api/agent-workspaces/:workspaceId/chain",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.chain.get" },
      cli: {
        command: ["agent-workspaces", "chain"],
        usage: "agent-workspaces chain --workspace-id WORKSPACE_ID",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:read"]
    },
{
      id: "agent_workspaces.parent.set",
      feature: "agent_workspace",
      label: "设置工作空间继承父级",
      target: { controller: "system", method: "handleSetWorkspaceParent" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/parent",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.parent.set" },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.profile.hotswap",
      feature: "agent_workspace",
      label: "热切换工作空间 profile（模型/工具/上下文/资源范围）",
      target: { controller: "system", method: "handleHotSwapWorkspaceProfile" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/profile",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.profile.hotswap" },
      cli: {
        command: ["agent-workspaces", "profile"],
        usage: "agent-workspaces profile --workspace-id WORKSPACE_ID --body profile.json",
        pathParams: { workspaceId: ["workspace-id", "workspaceId", "id"] }
      },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.sources.set",
      feature: "agent_workspace",
      label: "设置工作空间自有本地资源列表",
      target: { controller: "system", method: "handleSetWorkspaceOwnedSources" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/sources",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.sources.set" },
      requiredScopes: ["workspace:maintain"]
    },
{
      id: "agent_workspaces.share",
      feature: "agent_workspace",
      label: "将当前工作空间的资源访问权共享给另一工作空间",
      target: { controller: "system", method: "handleShareWorkspace" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/share",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.share" },
      requiredScopes: ["workspace:maintain"],
      aspects: ["workspace-governance", "share-grant"],
      safety: {
        risk: "repair_write",
        requiresConfirmation: true,
        approvalScope: "workspace:maintain"
      }
    },
{
      id: "agent_workspaces.unshare",
      feature: "agent_workspace",
      label: "撤销工作空间的访问共享",
      target: { controller: "system", method: "handleUnshareWorkspace" },
      http: {
        method: "POST",
        path: "/api/agent-workspaces/:workspaceId/unshare",
        params: [{ name: "workspaceId", aliases: ["workspace-id", "workspaceId", "id"], required: true }]
      },
      rpc: { method: "agent_workspaces.unshare" },
      requiredScopes: ["workspace:maintain"],
      aspects: ["workspace-governance", "share-grant"],
      safety: { risk: "safe_write", requiresConfirmation: false }
    },
{
      id: "context.profiles.get",
      feature: "context_runtime",
      label: "读取上下文预算 profile",
      target: { controller: "system", method: "handleContextProfiles" },
      http: { method: "GET", path: "/api/context/profiles" },
      rpc: { method: "context.profiles.get" },
      cli: { command: ["context", "profiles"], usage: "context profiles" },
      requiredScopes: ["console:read"]
    },
{
      id: "context.profiles.set",
      feature: "context_runtime",
      label: "保存上下文预算 profile",
      target: { controller: "system", method: "handleContextProfiles" },
      http: { method: "POST", path: "/api/context/profiles" },
      rpc: { method: "context.profiles.set", body: "params" },
      cli: { command: ["context", "profiles", "set"], usage: "context profiles set --body profiles.json" },
      requiredScopes: ["runtime:admin"]
    }]);
