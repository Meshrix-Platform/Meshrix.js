export const IDENTITY_RUNTIME_OPERATION_DEFINITIONS = Object.freeze([
{
      id: "auth.roles.get",
      feature: "auth",
      label: "读取控制台角色",
      target: { controller: "system", method: "handleAuthRole" },
      http: { method: "POST", path: "/api/auth/roles/:roleId", localInForwardMode: true },
      rpc: {
        method: "auth.roles.get",
        params: [{ name: "roleId", aliases: ["role-id", "id"], required: true }]
      },
      cli: {
        command: ["auth", "roles", "get"],
        usage: "auth roles get --id ROLE_ID",
        pathParams: { roleId: ["role-id", "id"] }
      },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.oidc.get",
      feature: "auth",
      label: "读取 OIDC 配置",
      target: { controller: "system", method: "handleAuthOidc" },
      http: { method: "GET", path: "/api/auth/oidc", localInForwardMode: true },
      rpc: { method: "auth.oidc.get" },
      cli: { command: ["auth", "oidc"], usage: "auth oidc" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.oidc.set",
      feature: "auth",
      label: "保存 OIDC 配置",
      target: { controller: "system", method: "handleAuthOidc" },
      http: { method: "POST", path: "/api/auth/oidc", localInForwardMode: true },
      rpc: { method: "auth.oidc.set", body: "params" },
      cli: { command: ["auth", "oidc", "set"], usage: "auth oidc set --body oidc.json" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.audit",
      feature: "auth",
      label: "系统执行日志",
      target: { controller: "system", method: "handleAuthAudit" },
      http: {
        method: "GET",
        path: "/api/auth/audit",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "userId", aliases: ["user-id", "userId"] },
    { name: "status", aliases: ["status"] },
    { name: "traceId", aliases: ["trace-id", "traceId"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "auth.audit",
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "userId", aliases: ["user-id", "userId"] },
    { name: "status", aliases: ["status"] },
    { name: "traceId", aliases: ["trace-id", "traceId"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
        ]
      },
      cli: { command: ["auth", "audit"], usage: "auth audit [--limit 100]" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.audit.export",
      feature: "auth",
      label: "导出脱敏系统审计",
      target: { controller: "system", method: "handleAuthAuditExport" },
      http: {
        method: "GET",
        path: "/api/auth/audit/export",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "operationId", aliases: ["operation-id", "operationId"] },
    { name: "userId", aliases: ["user-id", "userId"] },
    { name: "status", aliases: ["status"] },
    { name: "traceId", aliases: ["trace-id", "traceId"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "auth.audit.export",
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "operationId", aliases: ["operation-id", "operationId"] },
    { name: "userId", aliases: ["user-id", "userId"] },
    { name: "status", aliases: ["status"] },
    { name: "traceId", aliases: ["trace-id", "traceId"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
        ]
      },
      cli: { command: ["auth", "audit", "export"], usage: "auth audit export [--trace-id TRACE_ID] [--tenant-id TENANT_ID]" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.audit.retention.get",
      feature: "auth",
      label: "读取审计保留策略",
      target: { controller: "system", method: "handleAuthAuditRetention" },
      http: { method: "GET", path: "/api/auth/audit/retention", localInForwardMode: true },
      rpc: { method: "auth.audit.retention.get" },
      cli: { command: ["auth", "audit", "retention"], usage: "auth audit retention" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.audit.retention.set",
      feature: "auth",
      label: "设置审计保留策略",
      target: { controller: "system", method: "handleAuthAuditRetention" },
      http: { method: "POST", path: "/api/auth/audit/retention", localInForwardMode: true },
      rpc: { method: "auth.audit.retention.set", body: "params" },
      cli: { command: ["auth", "audit", "retention", "set"], usage: "auth audit retention set --body retention.json" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.audit.prune",
      feature: "auth",
      label: "按保留策略清理审计",
      target: { controller: "system", method: "handleAuthAuditPrune" },
      http: { method: "POST", path: "/api/auth/audit/prune", localInForwardMode: true },
      rpc: { method: "auth.audit.prune", body: "params" },
      cli: { command: ["auth", "audit", "prune"], usage: "auth audit prune --body prune.json" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "observability.trace.get",
      feature: "auth",
      label: "读取 trace drill-down",
      target: { controller: "system", method: "handleObservabilityTraceGet" },
      http: {
        method: "GET",
        path: "/api/observability/traces/:traceId",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "observability.trace.get",
        params: [{ name: "traceId", aliases: ["trace-id", "id"], required: true }],
        query: [{ name: "limit", aliases: ["limit"] },
    { name: "tenantId", aliases: ["tenant-id", "tenantId"] }]
      },
      cli: {
        command: ["observability", "trace", "get"],
        usage: "observability trace get --id TRACE_ID",
        pathParams: { traceId: ["trace-id", "id"] }
      },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.sessions",
      feature: "auth",
      label: "控制台会话列表",
      target: { controller: "system", method: "handleAuthSessions" },
      http: { method: "GET", path: "/api/auth/sessions", localInForwardMode: true },
      rpc: { method: "auth.sessions" },
      cli: { command: ["auth", "sessions"], usage: "auth sessions" },
      requiredScopes: ["auth:admin"]
    },
{
      id: "auth.sessions.rotate",
      feature: "auth",
      label: "轮换当前控制台会话 token",
      target: { controller: "system", method: "handleAuthRotateSession" },
      http: { method: "POST", path: "/api/auth/sessions/rotate", localInForwardMode: true },
      rpc: { method: "auth.sessions.rotate" },
      cli: { command: ["auth", "sessions", "rotate"], usage: "auth sessions rotate" },
      requiredScopes: ["console:read"]
    },
{
      id: "auth.sessions.revoke",
      feature: "auth",
      label: "撤销控制台会话",
      target: { controller: "system", method: "handleAuthRevokeSession" },
      http: { method: "POST", path: "/api/auth/sessions/:sessionId/revoke", localInForwardMode: true },
      rpc: {
        method: "auth.sessions.revoke",
        params: [{ name: "sessionId", aliases: ["session-id", "id"], required: true }]
      },
      cli: {
        command: ["auth", "sessions", "revoke"],
        usage: "auth sessions revoke --id SESSION_ID",
        pathParams: { sessionId: ["session-id", "id"] }
      },
      requiredScopes: ["auth:admin"]
    },
{
      id: "process_identity.bootstrap_claim",
      feature: "auth",
      label: "认领客户端本地服务端运行时并签发客户端身份包",
      target: { controller: "system", method: "handleProcessIdentityBootstrapClaim" },
      http: { method: "POST", path: "/api/process-identity/bootstrap/claim", localInForwardMode: true },
      rpc: { method: "process_identity.bootstrap_claim", body: "params" },
      cli: {
        command: ["process-identity", "bootstrap", "claim"],
        usage: "process-identity bootstrap claim --body claim.json"
      },
      public: true,
      inputSchema: {
        type: "object",
        required: ["defaultIdentityHash"],
        additionalProperties: false,
        properties: {
          claimToken: { type: "string" },
          clientId: { type: "string" },
          installationId: { type: "string" },
          clientFingerprint: {
            type: "object",
            properties: {
              fingerprintId: { type: "string" },
              machineInstanceId: { type: "string" },
              appInstanceId: { type: "string" },
              runtimeInstanceId: { type: "string" },
              fingerprintHash: { type: "string" }
            }
          },
          processKeyId: { type: "string" },
          processPublicKeyPem: { type: "string" },
          processPublicKeySpkiBase64: { type: "string" },
          defaultIdentityHash: { type: "string" },
          nonce: { type: "string" },
          capabilities: { type: "array" }
        }
      },
      safety: { risk: "safe_write", requiresConfirmation: false },
      aspects: ["security", "process-identity", "bootstrap", "client-local-runtime"],
      log: { recordInput: false, redaction: "secret" }
    },
{
      id: "process_identity.package.rotate",
      feature: "auth",
      label: "轮换客户端进程身份包",
      target: { controller: "system", method: "handleProcessIdentityPackageRotate" },
      http: { method: "POST", path: "/api/process-identity/package/rotate", localInForwardMode: true },
      rpc: { method: "process_identity.package.rotate", body: "params" },
      cli: {
        command: ["process-identity", "package", "rotate"],
        usage: "process-identity package rotate --body rotation.json"
      },
      requiredScopes: ["runtime:admin"],
      processIdentity: {
        required: true,
        authorizes: true,
        requireBinding: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          processKeyId: { type: "string" },
          processPublicKeyPem: { type: "string" },
          processPublicKeySpkiBase64: { type: "string" },
          reason: { type: "string" },
          nonce: { type: "string" }
        }
      },
      safety: { risk: "safe_write", requiresConfirmation: false },
      aspects: ["security", "process-identity", "rotation", "client-local-runtime"],
      log: { recordInput: false, redaction: "secret" }
    },
{
      id: "process_identity.package.revoke",
      feature: "auth",
      label: "撤销客户端进程身份包",
      target: { controller: "system", method: "handleProcessIdentityPackageRevoke" },
      http: { method: "POST", path: "/api/process-identity/package/revoke", localInForwardMode: true },
      rpc: { method: "process_identity.package.revoke", body: "params" },
      cli: {
        command: ["process-identity", "package", "revoke"],
        usage: "process-identity package revoke --body revoke.json"
      },
      requiredScopes: ["runtime:admin"],
      processIdentity: {
        required: true,
        authorizes: true,
        requireBinding: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string" },
          endpoint: { type: "string" },
          ownerSubjectRef: { type: "string" },
          ownerArtifactId: { type: "string" },
          ownerArtifactDigestSha256: { type: "string" }
        }
      },
      safety: { risk: "safe_write", requiresConfirmation: false },
      aspects: ["security", "process-identity", "revocation", "owner-bound-artifact"],
      log: { recordInput: false, redaction: "secret" }
    },
{
      id: "discovery.check_in",
      feature: "discovery",
      label: "客户端迁移登记",
      target: { controller: "system", method: "handleDiscoveryCheckIn" },
      http: { method: "POST", path: "/api/discovery/check-in", localInForwardMode: true },
      rpc: { method: "discovery.check_in", body: "params" },
      cli: { command: ["discovery", "check-in"], usage: "discovery check-in --body check-in.json" }
    },
{
      id: "discovery.clients",
      feature: "discovery",
      label: "客户端配置对齐列表",
      target: { controller: "system", method: "handleListDiscoveryClients" },
      http: { method: "GET", path: "/api/discovery/clients", localInForwardMode: true },
      rpc: { method: "discovery.clients" },
      cli: { command: ["discovery", "clients"], usage: "discovery clients" }
    },
{
      id: "discovery.clients.alignment_command",
      feature: "discovery",
      label: "向客户端发布配置对齐指令",
      target: { controller: "system", method: "handleRequestClientAlignmentCommand" },
      http: {
        method: "POST",
        path: "/api/discovery/clients/:clientId/alignment-command",
        localInForwardMode: true
      },
      rpc: {
        method: "discovery.clients.alignment_command",
        body: "params",
        params: [{ name: "clientId", aliases: ["client-id", "id"], required: true }]
      },
      cli: {
        command: ["discovery", "clients", "alignment-command"],
        usage: "discovery clients alignment-command --client-id CLIENT_ID",
        pathParams: { clientId: ["client-id", "id"] }
      },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "discovery.get_config",
      feature: "discovery",
      label: "读取服务发现配置",
      target: { controller: "system", method: "handleGetDiscoveryConfig" },
      http: { method: "GET", path: "/api/discovery/config" },
      rpc: { method: "discovery.get_config" },
      cli: { command: ["discovery", "get"], aliases: [["discovery"]], usage: "discovery get" },
      requiredScopes: ["console:read"]
    },
{
      id: "discovery.set_config",
      feature: "discovery",
      label: "保存服务发现配置",
      target: { controller: "system", method: "handleSetDiscoveryConfig" },
      http: { method: "POST", path: "/api/discovery/config" },
      rpc: { method: "discovery.set_config", body: "params" },
      cli: { command: ["discovery", "set"], usage: "discovery set --body discovery.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.info",
      feature: "runtime",
      label: "运行时信息",
      target: { controller: "system", method: "handleGetRuntimeInfo" },
      http: { method: "GET", path: "/api/runtime/info" },
      rpc: { method: "runtime.info" },
      cli: { command: ["runtime"], usage: "runtime" },
      requiredScopes: ["console:read"]
    },
{
      id: "runtime.assembly.build",
      feature: "runtime",
      label: "生成运行时装配清单",
      target: { controller: "system", method: "handleBuildRuntimeAssembly" },
      http: { method: "POST", path: "/api/runtime/assembly/build" },
      rpc: { method: "runtime.assembly.build", body: "params" },
      cli: { command: ["runtime", "assembly", "build"], usage: "runtime assembly build --body request.json" },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "safe_write", requiresConfirmation: false }
    },
{
      id: "runtime.path_browse",
      feature: "runtime",
      label: "服务端路径浏览",
      target: { controller: "system", method: "handleBrowseServerPath" },
      http: { method: "POST", path: "/api/runtime/path-browse", localInForwardMode: true },
      rpc: { method: "runtime.path_browse", body: "params" },
      cli: { command: ["runtime", "path-browse"], usage: "runtime path-browse --body request.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.mounts",
      feature: "runtime",
      label: "读取挂载配置",
      target: { controller: "system", method: "handleGetMounts" },
      http: { method: "GET", path: "/api/runtime/mounts" },
      rpc: { method: "runtime.mounts" },
      cli: { command: ["runtime", "mounts"], aliases: [["mounts"]], usage: "runtime mounts" },
      requiredScopes: ["console:read"]
    },
{
      id: "runtime.external_gateway",
      feature: "runtime",
      label: "读取外置网关配置",
      target: { controller: "system", method: "handleGetExternalGateway" },
      http: { method: "GET", path: "/api/runtime/external-gateway" },
      rpc: { method: "runtime.external_gateway" },
      cli: { command: ["runtime", "external-gateway"], usage: "runtime external-gateway" },
      requiredScopes: ["console:read"]
    },
{
      id: "runtime.external_gateway.validate",
      feature: "runtime",
      label: "校验外置网关配置",
      target: { controller: "system", method: "handleValidateExternalGateway" },
      http: { method: "POST", path: "/api/runtime/external-gateway/validate" },
      rpc: { method: "runtime.external_gateway.validate", body: "params" },
      cli: { command: ["runtime", "external-gateway", "validate"], usage: "runtime external-gateway validate --body profile.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.external_gateway.apply",
      feature: "runtime",
      label: "启用外置网关配置",
      target: { controller: "system", method: "handleApplyExternalGateway" },
      http: { method: "POST", path: "/api/runtime/external-gateway/apply" },
      rpc: { method: "runtime.external_gateway.apply", body: "params" },
      cli: { command: ["runtime", "external-gateway", "apply"], usage: "runtime external-gateway apply --body profile.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.external_gateway.switch_direct",
      feature: "runtime",
      label: "切换为内置网关流控",
      target: { controller: "system", method: "handleSwitchExternalGatewayDirect" },
      http: { method: "POST", path: "/api/runtime/external-gateway/direct" },
      rpc: { method: "runtime.external_gateway.switch_direct", body: "params" },
      cli: { command: ["runtime", "external-gateway", "direct"], usage: "runtime external-gateway direct --body generation.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.set_mounts",
      feature: "runtime",
      label: "保存挂载配置",
      target: { controller: "system", method: "handleSetMounts" },
      http: { method: "POST", path: "/api/runtime/mounts" },
      rpc: { method: "runtime.set_mounts", body: "params" },
      cli: { command: ["mounts", "set"], usage: "mounts set --body mount-config.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "runtime.reload_mounts",
      feature: "runtime",
      label: "重载挂载配置",
      target: { controller: "system", method: "handleReloadMounts" },
      http: { method: "POST", path: "/api/runtime/mounts/reload" },
      rpc: { method: "runtime.reload_mounts", body: "params" },
      cli: { command: ["mounts", "reload"], usage: "mounts reload [--body settings.json]" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "settings.get",
      feature: "settings",
      label: "读取服务设置",
      target: { controller: "system", method: "handleGetSettings" },
      http: { method: "GET", path: "/api/settings" },
      rpc: { method: "settings.get" },
      cli: { command: ["settings", "get"], aliases: [["settings"]], usage: "settings get" },
      requiredScopes: ["console:read"]
    },
{
      id: "settings.set",
      feature: "settings",
      label: "保存服务设置",
      target: { controller: "system", method: "handleSetSettings" },
      http: { method: "POST", path: "/api/settings" },
      rpc: { method: "settings.set", body: "params" },
      cli: { command: ["settings", "set"], usage: "settings set --body settings.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "settings.model_probe",
      feature: "settings",
      label: "探测模型连通性",
      target: { controller: "system", method: "handleProbeModel" },
      http: { method: "POST", path: "/api/settings/model-probe" },
      rpc: { method: "settings.model_probe", body: "params" },
      cli: {
        command: ["settings", "probe-model"],
        usage: "settings probe-model --provider PROVIDER [--body settings.json]",
        bodyParams: [
          { name: "provider", aliases: ["provider", "model-provider"], required: true }
        ]
      },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "agent_gateway.call",
      feature: "agent_gateway",
      label: "调用智能体模型接入点",
      target: { controller: "system", method: "handleAgentGatewayCall" },
      http: { method: "POST", path: "/api/agent-gateway/call" },
      rpc: { method: "agent_gateway.call", body: "params" },
      cli: {
        command: ["agent-gateway", "call"],
        usage: "agent-gateway call --question QUESTION [--workspace-id WORKSPACE_ID] [--agent-session-id SESSION_ID] [--tool-grant-id GRANT_ID] [--agent-name NAME] [--plugin-list a,b]",
        bodyParams: [
          { name: "agentName", aliases: ["agent-name", "agentName"] },
    { name: "pluginList", aliases: ["plugin-list", "pluginList"] },
    { name: "question", aliases: ["question", "q"], required: true },
    { name: "sessionId", aliases: ["session-id", "sessionId"] },
    { name: "agentSessionId", aliases: ["agent-session-id", "agentSessionId", "session-thread-id", "sessionThreadId"] },
    { name: "clientUid", aliases: ["client-uid", "clientUid"] },
    { name: "modelAlias", aliases: ["model-alias", "modelAlias", "alias", "model"] },
    { name: "contextProfileId", aliases: ["context-profile", "context-profile-id", "contextProfileId"] },
    { name: "toolGrantId", aliases: ["tool-grant-id", "toolGrantId", "grant-id", "grantId"] },
    { name: "workspaceId", aliases: ["workspace-id", "workspaceId"] },
    { name: "userId", aliases: ["user-id", "userId"] },
    { name: "projectId", aliases: ["project-id", "projectId"] },
    { name: "engine", aliases: ["engine"] }
        ]
      },
      requiredScopes: ["model:call"],
      inputSchema: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          query: { type: "string" },
          agentName: { type: "string" },
          modelAlias: { type: "string" },
          workspaceId: { type: "string" },
          agentSessionId: { type: "string" },
          toolGrantId: { type: "string" },
          messages: { type: "array" }
        }
      },
      log: { recordInput: false },
      audit: { recordInput: false, metadataOnly: true }
    }]);
