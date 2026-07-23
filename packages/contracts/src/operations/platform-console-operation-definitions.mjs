import {
  STATIC_SEMANTIC_FAMILY_COUNT,
  resolveAcpPromptRisk
} from "./operation-registry-governed-definitions.mjs";

export const PLATFORM_CONSOLE_OPERATION_DEFINITIONS = Object.freeze([
{
      id: "system.health",
      feature: "system",
      label: "健康检查",
      target: { controller: "system", method: "handleHealthz" },
      http: { method: "GET", path: "/api/healthz", localInForwardMode: true },
      rpc: { method: "system.health" },
      cli: { command: ["health"], usage: "health" },
      requiredScopes: ["storage:read"]
    },
{
      id: "system.bootstrap",
      feature: "system",
      label: "客户端启动配置",
      target: { controller: "system", method: "handleBootstrap" },
      http: { method: "GET", path: "/api/bootstrap", localInForwardMode: true },
      rpc: { method: "system.bootstrap" },
      cli: { command: ["bootstrap"], usage: "bootstrap" }
    },
{
      id: "system.interfaces",
      feature: "system",
      label: "接口注册表",
      target: { controller: "system", method: "handleListInterfaces" },
      http: { method: "GET", path: "/api/interfaces", localInForwardMode: true },
      rpc: { method: "system.interfaces" },
      cli: { command: ["interfaces"], usage: "interfaces [--format json|markdown]" },
      requiredScopes: ["console:read"]
    },
{
      id: "appearance_presets.list",
      feature: "system",
      label: "外观方案配置列表",
      target: { controller: "system", method: "handleAppearancePresets" },
      http: { method: "GET", path: "/api/appearance-presets", localInForwardMode: true },
      rpc: { method: "appearance_presets.list" },
      cli: { command: ["appearance-presets"], usage: "appearance-presets" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["appearance-presets", "frontend", "display-preference"],
      inputSchema: { type: "object", required: [], properties: {} }
    },
{
      id: "appearance_presets.import",
      feature: "system",
      label: "导入外观方案配置",
      target: { controller: "system", method: "handleImportAppearancePreset" },
      http: { method: "POST", path: "/api/appearance-presets/import", localInForwardMode: true },
      rpc: { method: "appearance_presets.import", body: "params" },
      cli: { command: ["appearance-presets", "import"], usage: "appearance-presets import --body preset.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["appearance-presets", "frontend", "display-preference"],
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          config: { type: "object" },
          text: { type: "string" }
        }
      },
      safety: { risk: "safe_write" }
    },
{
      id: "production.health",
      feature: "production",
      label: "生产健康总览",
      target: { controller: "system", method: "handleProductionHealth" },
      http: { method: "GET", path: "/api/production/health", localInForwardMode: true },
      rpc: { method: "production.health" },
      cli: { command: ["production", "health"], usage: "production health" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["observability", "production-readiness"]
    },
{
      id: "architecture.live_map",
      feature: "production",
      label: "架构运行状态映射",
      target: { controller: "system", method: "handleArchitectureLiveMap" },
      http: { method: "GET", path: "/api/architecture/live-map", localInForwardMode: true },
      rpc: { method: "architecture.live_map" },
      cli: { command: ["architecture", "live-map"], usage: "architecture live-map" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["architecture-live-map", "production-readiness"]
    },
{
      id: "sample_capability_pack.list",
      feature: "production",
      label: "样例能力包列表",
      target: { controller: "system", method: "handleSampleCapabilityPacks" },
      http: { method: "GET", path: "/api/sample-capability-packs", localInForwardMode: true },
      rpc: { method: "sample_capability_pack.list" },
      cli: { command: ["sample-capability-packs"], usage: "sample-capability-packs" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["sample-capability-pack", "capability-scenarios"]
    },
{
      id: "sample_capability_pack.get",
      feature: "production",
      label: "样例能力包详情",
      target: { controller: "system", method: "handleSampleCapabilityPack" },
      http: { method: "GET", path: "/api/sample-capability-packs/:packId", localInForwardMode: true },
      rpc: { method: "sample_capability_pack.get" },
      cli: { command: ["sample-capability-packs", "get"], usage: "sample-capability-packs get <packId>" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["sample-capability-pack", "capability-scenarios"]
    },
{
      id: "sample_capability_pack.materialize",
      feature: "production",
      label: "生成样例能力包",
      target: { controller: "system", method: "handleSampleCapabilityPackMaterialize" },
      http: { method: "POST", path: "/api/sample-capability-packs/materialize", localInForwardMode: true },
      rpc: { method: "sample_capability_pack.materialize", body: "params" },
      cli: { command: ["sample-capability-packs", "materialize"], usage: "sample-capability-packs materialize --body sample-pack.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["sample-capability-pack", "capability-scenarios"],
      safety: { risk: "safe_write" }
    },
{
      id: "executive_report.list",
      feature: "production",
      label: "管理层报告列表",
      target: { controller: "system", method: "handleExecutiveReport" },
      http: { method: "GET", path: "/api/executive-report", localInForwardMode: true },
      rpc: { method: "executive_report.list" },
      cli: { command: ["executive-report"], usage: "executive-report" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["executive-report", "asset-value"]
    },
{
      id: "executive_report.preview",
      feature: "production",
      label: "管理层报告预览",
      target: { controller: "system", method: "handleExecutiveReportPreview" },
      http: { method: "POST", path: "/api/executive-report/preview", localInForwardMode: true },
      rpc: { method: "executive_report.preview", body: "params" },
      cli: { command: ["executive-report", "preview"], usage: "executive-report preview --body report-input.json" },
      requiredScopes: ["console:read"],
      readOnly: true,
      safety: { risk: "read_only" },
      aspects: ["executive-report", "asset-value"]
    },
{
      id: "executive_report.generate",
      feature: "production",
      label: "生成管理层报告",
      target: { controller: "system", method: "handleExecutiveReportGenerate" },
      http: { method: "POST", path: "/api/executive-report/generate", localInForwardMode: true },
      rpc: { method: "executive_report.generate", body: "params" },
      cli: { command: ["executive-report", "generate"], usage: "executive-report generate --body report-input.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["executive-report", "asset-value"],
      safety: { risk: "safe_write" }
    },
{
      id: "operation_semantics.static_families.list",
      feature: "module_management",
      label: "静态语义族列表",
      target: { controller: "system", method: "handleOperationSemanticsStaticFamiliesList" },
      http: { method: "GET", path: "/api/operation-semantics/static-families", localInForwardMode: true },
      rpc: { method: "operation_semantics.static_families.list" },
      cli: { command: ["operation-semantics", "static-families"], usage: "operation-semantics static-families" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["operation-semantics", "static-semantic-family"],
      metadata: { staticSemanticFamilyCount: STATIC_SEMANTIC_FAMILY_COUNT }
    },
{
      id: "operation_semantics.static_families.get",
      feature: "module_management",
      label: "静态语义族详情",
      target: { controller: "system", method: "handleOperationSemanticsStaticFamiliesGet" },
      http: { method: "POST", path: "/api/operation-semantics/static-families/get", localInForwardMode: true },
      rpc: { method: "operation_semantics.static_families.get", body: "params" },
      cli: { command: ["operation-semantics", "static-families", "get"], usage: "operation-semantics static-families get --body family.json" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["operation-semantics", "static-semantic-family"],
      safety: { risk: "read_only" }
    },
{
      id: "workspace_governance.describe",
      feature: "agent_workspace",
      label: "工作空间组织治理总览",
      target: { controller: "system", method: "handleWorkspaceGovernance" },
      http: { method: "GET", path: "/api/workspace-governance", localInForwardMode: true },
      rpc: { method: "workspace_governance.describe" },
      cli: { command: ["workspace-governance"], usage: "workspace-governance" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["workspace-governance", "organization-policy"]
    },
{
      id: "workspace_governance.policy.set",
      feature: "agent_workspace",
      label: "设置工作空间组织治理策略",
      target: { controller: "system", method: "handleWorkspaceGovernancePolicy" },
      http: { method: "POST", path: "/api/workspace-governance/policies", localInForwardMode: true },
      rpc: { method: "workspace_governance.policy.set", body: "params" },
      cli: { command: ["workspace-governance", "policy", "set"], usage: "workspace-governance policy set --body policy.json" },
      requiredScopes: ["workspace:maintain"],
      aspects: ["workspace-governance", "organization-policy"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "workspace:maintain" }
    },
{
      id: "workspace_governance.evaluate",
      feature: "agent_workspace",
      label: "评估工作空间组织治理策略",
      target: { controller: "system", method: "handleWorkspaceGovernanceEvaluate" },
      http: { method: "POST", path: "/api/workspace-governance/evaluate", localInForwardMode: true },
      rpc: { method: "workspace_governance.evaluate", body: "params" },
      cli: { command: ["workspace-governance", "evaluate"], usage: "workspace-governance evaluate --body request.json" },
      requiredScopes: ["console:read"],
      readOnly: false,
      safety: { risk: "safe_write" },
      aspects: ["workspace-governance", "organization-policy"]
    },
{
      id: "workspace_governance.share_grant",
      feature: "agent_workspace",
      label: "创建工作空间共享授权",
      target: { controller: "system", method: "handleWorkspaceGovernanceShareGrant" },
      http: { method: "POST", path: "/api/workspace-governance/share-grants", localInForwardMode: true },
      rpc: { method: "workspace_governance.share_grant", body: "params" },
      cli: { command: ["workspace-governance", "share-grant"], usage: "workspace-governance share-grant --body grant.json" },
      requiredScopes: ["runtime:admin"],
      aspects: ["workspace-governance", "organization-policy"],
      safety: { risk: "safe_write", requiresConfirmation: true, approvalScope: "runtime:admin" }
    },
{
      id: "events.subscribe",
      feature: "events",
      label: "订阅上游发布事件",
      target: { controller: "system", method: "handleSubscribeEvents" },
      http: {
        method: "GET",
        path: "/api/events",
        localInForwardMode: true,
        query: [
          { name: "cursor", aliases: ["cursor", "since"] },
    { name: "topic", aliases: ["topic", "topics"] },
    { name: "limit", aliases: ["limit"] },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs", "timeout"] },
    { name: "includeSnapshot", aliases: ["include-snapshot", "includeSnapshot", "snapshot"] }
        ],
        coerce: {
          cursor: "number",
          limit: "number",
          timeoutMs: "number",
          includeSnapshot: "boolean"
        }
      },
      rpc: {
        method: "events.subscribe",
        query: [
          { name: "cursor", aliases: ["cursor", "since"] },
    { name: "topic", aliases: ["topic", "topics"] },
    { name: "limit", aliases: ["limit"] },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs", "timeout"] },
    { name: "includeSnapshot", aliases: ["include-snapshot", "includeSnapshot", "snapshot"] }
        ]
      },
      cli: {
        command: ["events", "subscribe"],
        aliases: [["events"]],
        usage: "events subscribe [--cursor N] [--topic jobs.job] [--timeout-ms 10000] [--include-snapshot 1]"
      }
    },
{
      id: "agent_sync.config.get",
      feature: "agent_sync",
      label: "读取智能体客户端同步策略",
      target: { controller: "system", method: "handleAgentSyncConfig" },
      http: { method: "GET", path: "/api/agent-sync/config", localInForwardMode: true },
      rpc: { method: "agent_sync.config.get" },
      cli: { command: ["agent-sync", "config"], usage: "agent-sync config" },
      requiredScopes: ["console:read"]
    },
{
      id: "agent_sync.config.set",
      feature: "agent_sync",
      label: "保存智能体客户端同步策略",
      target: { controller: "system", method: "handleAgentSyncConfig" },
      http: { method: "POST", path: "/api/agent-sync/config", localInForwardMode: true },
      rpc: { method: "agent_sync.config.set", body: "params" },
      cli: { command: ["agent-sync", "config", "set"], usage: "agent-sync config set --body sync.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "agent_sync.publish",
      feature: "agent_sync",
      label: "智能体发布客户端同步事件",
      target: { controller: "system", method: "handleAgentSyncPublish" },
      http: { method: "POST", path: "/api/agent-sync/publish", localInForwardMode: true },
      rpc: { method: "agent_sync.publish", body: "params" },
      cli: {
        command: ["agent-sync", "publish"],
        usage: "agent-sync publish --topic answer --body payload.json --header 'Authorization: <credential>'"
      },
      requiredScopes: ["agent_sync:publish"],
      externalAuth: true,
      externalAuthVerifier: { method: "verifyToolSkillExternalAuth", requiredScopes: ["agent_sync:publish"] }
    },
{
      id: "agent_sync.subscribe",
      feature: "agent_sync",
      label: "客户端订阅智能体同步事件",
      target: { controller: "system", method: "handleAgentSyncSubscribe" },
      http: {
        method: "GET",
        path: "/api/agent-sync/events",
        localInForwardMode: true,
        query: [
          { name: "cursor", aliases: ["cursor", "since"] },
    { name: "topic", aliases: ["topic", "topics"] },
    { name: "limit", aliases: ["limit"] },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs", "timeout"] },
    { name: "includeSnapshot", aliases: ["include-snapshot", "includeSnapshot", "snapshot"] }
        ],
        coerce: {
          cursor: "number",
          limit: "number",
          timeoutMs: "number",
          includeSnapshot: "boolean"
        }
      },
      rpc: {
        method: "agent_sync.subscribe",
        query: [
          { name: "cursor", aliases: ["cursor", "since"] },
    { name: "topic", aliases: ["topic", "topics"] },
    { name: "limit", aliases: ["limit"] },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs", "timeout"] },
    { name: "includeSnapshot", aliases: ["include-snapshot", "includeSnapshot", "snapshot"] }
        ]
      },
      cli: {
        command: ["agent-sync", "subscribe"],
        usage: "agent-sync subscribe [--topic answer] [--cursor N] [--include-snapshot 1]"
      }
    },
{
      id: "system.console_state",
      feature: "system",
      label: "控制台状态",
      target: { controller: "system", method: "handleGetConsoleState" },
      http: { method: "GET", path: "/api/console/state" },
      rpc: { method: "system.console_state" },
      cli: { command: ["console"], usage: "console" },
      requiredScopes: ["console:read"],
      readOnly: true,
      proof: {
        profile: "on-change",
        changeProjection: "console-state-v1"
      },
      audit: {
        write: false,
        metadataOnly: true
      }
    },
{
      id: "maintenance_agent.config.get",
      feature: "maintenance_agent",
      label: "读取维护智能体配置",
      target: { controller: "system", method: "handleMaintenanceAgentConfig" },
      http: { method: "GET", path: "/api/maintenance-agent/config", localInForwardMode: true },
      rpc: { method: "maintenance_agent.config.get" },
      cli: {
        command: ["maintenance-agent", "config"],
        aliases: [["maintenance", "config"]],
        usage: "maintenance-agent config"
      },
      requiredScopes: ["maintenance:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "maintenance_agent.config.set",
      feature: "maintenance_agent",
      label: "保存维护智能体配置",
      target: { controller: "system", method: "handleMaintenanceAgentConfig" },
      http: { method: "POST", path: "/api/maintenance-agent/config", localInForwardMode: true },
      rpc: { method: "maintenance_agent.config.set", body: "params" },
      cli: {
        command: ["maintenance-agent", "config", "set"],
        aliases: [["maintenance", "config", "set"]],
        usage: "maintenance-agent config set --body maintenance-agent.json"
      },
      requiredScopes: ["maintenance:admin"],
      safety: { risk: "repair_write" },
      concurrencyGroup: "maintenance_agent.config",
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "maintenance_agent.chat",
      feature: "maintenance_agent",
      label: "维护智能体对话规划",
      target: { controller: "system", method: "handleMaintenanceAgentChat" },
      http: { method: "POST", path: "/api/maintenance-agent/chat", localInForwardMode: true },
      rpc: { method: "maintenance_agent.chat", body: "params" },
      cli: {
        command: ["maintenance-agent", "chat"],
        aliases: [["maintenance", "chat"]],
        usage: "maintenance-agent chat --message MESSAGE",
        bodyParams: [
          { name: "message", aliases: ["message", "question", "q"], required: true },
    { name: "wait", aliases: ["wait"], type: "boolean" }
        ]
      },
      requiredScopes: ["maintenance:run"],
      safety: { risk: "safe_write" },
      aspects: ["maintenance-agent", "runbook", "planner"],
      log: { recordInput: false },
      audit: { recordInput: false, metadataOnly: true }
    },
{
      id: "maintenance_agent.runs.create",
      feature: "maintenance_agent",
      label: "创建维护智能体运行",
      target: { controller: "system", method: "handleMaintenanceAgentRuns" },
      http: { method: "POST", path: "/api/maintenance-agent/runs", localInForwardMode: true },
      rpc: { method: "maintenance_agent.runs.create", body: "params" },
      cli: {
        command: ["maintenance-agent", "run"],
        aliases: [["maintenance", "run"]],
        usage: "maintenance-agent run --runbook health_smoke",
        bodyParams: [
          { name: "runbook", aliases: ["runbook", "intent"] },
    { name: "wait", aliases: ["wait"], type: "boolean" }
        ]
      },
      requiredScopes: ["maintenance:run"],
      safety: { risk: "safe_write" },
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "maintenance_agent.runs.list",
      feature: "maintenance_agent",
      label: "维护智能体运行列表",
      target: { controller: "system", method: "handleMaintenanceAgentRuns" },
      http: {
        method: "GET",
        path: "/api/maintenance-agent/runs",
        localInForwardMode: true,
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "maintenance_agent.runs.list",
        query: [{ name: "limit", aliases: ["limit"] }]
      },
      cli: {
        command: ["maintenance-agent", "runs"],
        aliases: [["maintenance", "runs"]],
        usage: "maintenance-agent runs [--limit 50]"
      },
      requiredScopes: ["maintenance:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "maintenance_agent.runs.get",
      feature: "maintenance_agent",
      label: "维护智能体运行详情",
      target: { controller: "system", method: "handleMaintenanceAgentRun" },
      http: { method: "GET", path: "/api/maintenance-agent/runs/:runId", localInForwardMode: true },
      rpc: {
        method: "maintenance_agent.runs.get",
        params: [{ name: "runId", aliases: ["run-id", "runId", "id"], required: true }]
      },
      cli: {
        command: ["maintenance-agent", "run", "get"],
        aliases: [["maintenance", "run", "get"]],
        usage: "maintenance-agent run get --id RUN_ID",
        pathParams: { runId: ["run-id", "runId", "id"] }
      },
      requiredScopes: ["maintenance:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "maintenance_agent.runs.approve",
      feature: "maintenance_agent",
      label: "批准维护智能体运行",
      target: { controller: "system", method: "handleMaintenanceAgentApprove" },
      http: { method: "POST", path: "/api/maintenance-agent/runs/:runId/approve", localInForwardMode: true },
      rpc: {
        method: "maintenance_agent.runs.approve",
        body: "params",
        params: [{ name: "runId", aliases: ["run-id", "runId", "id"], required: true }]
      },
      cli: {
        command: ["maintenance-agent", "approve"],
        aliases: [["maintenance", "approve"]],
        usage: "maintenance-agent approve --id RUN_ID --plan-hash HASH",
        pathParams: { runId: ["run-id", "runId", "id"] },
        bodyParams: [
          { name: "planHash", aliases: ["plan-hash", "planHash"], required: true },
    { name: "wait", aliases: ["wait"], type: "boolean" }
        ]
      },
      requiredScopes: ["maintenance:approve"],
      safety: { risk: "repair_write", requiresConfirmation: false },
      aspects: ["maintenance-agent", "runbook", "approval"]
    },
{
      id: "maintenance_agent.runs.cancel",
      feature: "maintenance_agent",
      label: "取消维护智能体运行",
      target: { controller: "system", method: "handleMaintenanceAgentCancel" },
      http: { method: "POST", path: "/api/maintenance-agent/runs/:runId/cancel", localInForwardMode: true },
      rpc: {
        method: "maintenance_agent.runs.cancel",
        body: "params",
        params: [{ name: "runId", aliases: ["run-id", "runId", "id"], required: true }]
      },
      cli: {
        command: ["maintenance-agent", "cancel"],
        aliases: [["maintenance", "cancel"]],
        usage: "maintenance-agent cancel --id RUN_ID",
        pathParams: { runId: ["run-id", "runId", "id"] },
        bodyParams: [{ name: "reason", aliases: ["reason"] }]
      },
      requiredScopes: ["maintenance:run"],
      safety: { risk: "safe_write" },
      aspects: ["maintenance-agent", "runbook"]
    },
{
      id: "auth.session",
      feature: "auth",
      label: "控制台登录状态",
      target: { controller: "system", method: "handleAuthSession" },
      http: { method: "GET", path: "/api/auth/session", localInForwardMode: true },
      rpc: { method: "auth.session" },
      cli: { command: ["auth", "session"], usage: "auth session" }
    },
{
      id: "auth.login",
      feature: "auth",
      label: "控制台登录",
      target: { controller: "system", method: "handleAuthLogin" },
      http: { method: "POST", path: "/api/auth/login", localInForwardMode: true },
      rpc: { method: "auth.login", body: "params" },
      cli: { command: ["auth", "login"], usage: "auth login --body login.json" },
      inputSchema: {
        type: "object",
        required: ["username", "password"],
        additionalProperties: false,
        properties: {
          username: { type: "string", minLength: 1 },
          password: { type: "string", minLength: 1 }
        }
      },
      skipCsrf: true
    },
{
      id: "auth.logout",
      feature: "auth",
      label: "控制台退出",
      target: { controller: "system", method: "handleAuthLogout" },
      http: { method: "POST", path: "/api/auth/logout", localInForwardMode: true },
      rpc: { method: "auth.logout" },
      cli: { command: ["auth", "logout"], usage: "auth logout" },
      requiredScopes: ["console:read"]
    },
{
      id: "auth.users",
      feature: "auth",
      label: "控制台用户列表/创建",
      target: { controller: "system", method: "handleAuthUsers" },
      http: { method: "GET", path: "/api/auth/users", localInForwardMode: true },
      rpc: { method: "auth.users" },
      cli: { command: ["auth", "users"], usage: "auth users" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.users.create",
      feature: "auth",
      label: "创建控制台用户",
      target: { controller: "system", method: "handleAuthUsers" },
      http: { method: "POST", path: "/api/auth/users", localInForwardMode: true },
      rpc: { method: "auth.users.create", body: "params" },
      cli: { command: ["auth", "users", "create"], usage: "auth users create --body user.json" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.users.update",
      feature: "auth",
      label: "更新控制台用户",
      target: { controller: "system", method: "handleAuthUpdateUser" },
      http: { method: "POST", path: "/api/auth/users/:userId", localInForwardMode: true },
      rpc: {
        method: "auth.users.update",
        body: "params",
        params: [{ name: "userId", aliases: ["user-id", "id"], required: true }]
      },
      cli: {
        command: ["auth", "users", "update"],
        usage: "auth users update --id USER_ID --body user.json",
        pathParams: { userId: ["user-id", "id"] }
      },
      requiredScopes: ["auth:admin"]
    }
]);
