const stringValue: Readonly<Record<string, any>> = Object.freeze({ type: "string", minLength: 1, maxLength: 512 });
const booleanValue: Readonly<Record<string, any>> = Object.freeze({ type: "boolean" });
const numberValue: Readonly<Record<string, any>> = Object.freeze({ type: "number" });

function closedObject(properties: Record<string, any> = {}, required: any = []) : any {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required,
    properties: Object.freeze(properties)
  });
}

const safetyInput: any = closedObject({
  risk: stringValue,
  blocked: booleanValue,
  requiresConfirmation: booleanValue
});
const operationInput: any = closedObject({ id: stringValue, safety: safetyInput });
const strategyCommonInput: Readonly<Record<string, any>> = Object.freeze({
  risk: stringValue,
  blocked: booleanValue,
  operationId: stringValue,
  operation: operationInput
});
const arbitraryToolInput: Readonly<Record<string, any>> = Object.freeze({ type: "object" });
const toolExecutionInput: any = closedObject({
  toolId: stringValue,
  input: arbitraryToolInput,
  confirm: booleanValue,
  idempotencyKey: stringValue
}, ["toolId"]);
const toolBatchCallInput: any = closedObject({
  toolId: stringValue,
  input: arbitraryToolInput,
  confirm: booleanValue,
  idempotencyKey: stringValue
}, ["toolId"]);
const toolBatchInput: any = closedObject({
  calls: Object.freeze({ type: "array", items: toolBatchCallInput, minItems: 1, maxItems: 100 }),
  atomic: booleanValue
}, ["calls"]);
const grantMutationInput: any = closedObject({
  grantId: stringValue,
  label: stringValue,
  type: stringValue,
  enabled: booleanValue,
  profileId: stringValue,
  scopes: Object.freeze({ type: "array", items: stringValue }),
  toolsets: Object.freeze({ type: "array", items: stringValue }),
  toolAllow: Object.freeze({ type: "array", items: stringValue }),
  toolDeny: Object.freeze({ type: "array", items: stringValue }),
  capabilities: Object.freeze({ type: "array", items: stringValue }),
  maxRisk: stringValue,
  maxUses: numberValue,
  expiresAt: stringValue,
  rateLimit: Object.freeze({ type: "object" }),
  metadata: Object.freeze({ type: "object" }),
  allowedWorkspaceIds: Object.freeze({ type: "array", items: stringValue }),
  allowedDataClasses: Object.freeze({ type: "array", items: stringValue }),
  allowedEgress: Object.freeze({ type: "array", items: stringValue }),
  allowedServiceIds: Object.freeze({ type: "array", items: stringValue }),
  allowedSecretBindings: Object.freeze({ type: "array", items: stringValue }),
  reason: stringValue
});

export const STRATEGY_PERMISSION_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([






{
      id: "model_routing.health",
      feature: "agent_gateway",
      label: "读取模型路由健康和成本台账",
      target: { controller: "system", method: "handleModelRoutingHealth" },
      http: {
        method: "GET",
        path: "/api/model-routing/health",
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: { method: "model_routing.health" },
      cli: {
        command: ["model-routing", "health"],
        usage: "model-routing health [--limit 50]"
      },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["model-routing", "cost-ledger", "circuit-breaker"]
    },
{
      id: "strategy.describe",
      feature: "strategy_management",
      label: "读取策略管理协议能力",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "GET", path: "/api/strategy" },
      rpc: { method: "strategy.describe" },
      cli: { command: ["strategy", "describe"], usage: "strategy describe" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject(),
      readOnly: true,
      concurrencySafe: true,
      aspects: ["strategy-management", "workflow-policy", "agent-policy", "queue-policy"]
    },
{
      id: "strategy.workflow_policy.evaluate",
      feature: "strategy_management",
      label: "评估处理流程策略",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "POST", path: "/api/strategy/workflow-policy/evaluate" },
      rpc: { method: "strategy.workflow_policy.evaluate", body: "params" },
      cli: { command: ["strategy", "workflow-policy", "evaluate"], usage: "strategy workflow-policy evaluate --body payload.json" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject({
        ...strategyCommonInput,
        workflowId: stringValue,
        stage: stringValue,
        action: stringValue,
        requiresConfirmation: booleanValue
      }, ["workflowId"]),
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "workflow-policy"]
    },
{
      id: "strategy.agent_policy.evaluate",
      feature: "strategy_management",
      label: "评估智能体调用策略",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "POST", path: "/api/strategy/agent-policy/evaluate" },
      rpc: { method: "strategy.agent_policy.evaluate", body: "params" },
      cli: { command: ["strategy", "agent-policy", "evaluate"], usage: "strategy agent-policy evaluate --body payload.json" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject({
        roleId: stringValue,
        routeId: stringValue,
        agentId: stringValue,
        modelRouting: closedObject({ routeId: stringValue })
      }, ["roleId"]),
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "agent-policy", "model-routing"]
    },
{
      id: "strategy.route_policy.evaluate",
      feature: "strategy_management",
      label: "评估切面路由策略",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "POST", path: "/api/strategy/route-policy/evaluate" },
      rpc: { method: "strategy.route_policy.evaluate", body: "params" },
      cli: { command: ["strategy", "route-policy", "evaluate"], usage: "strategy route-policy evaluate --body payload.json" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject({
        blocked: booleanValue,
        routeId: stringValue,
        gatewayId: stringValue,
        fromAspect: stringValue,
        protocol: stringValue,
        routeKind: stringValue,
        internalCapabilityId: stringValue,
        platformCapabilityId: stringValue,
        route: closedObject({
          blocked: booleanValue,
          routeId: stringValue,
          fromAspect: stringValue,
          protocol: stringValue,
          kind: stringValue
        }),
        target: closedObject({
          blocked: booleanValue,
          routeId: stringValue,
          protocol: stringValue,
          kind: stringValue,
          internalCapabilityId: stringValue,
          platformCapabilityId: stringValue,
          capabilityId: stringValue
        })
      }, ["routeId"]),
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "route-policy", "upstream-service-aspect", "downstream-client-aspect"]
    },
{
      id: "strategy.queue_policy.evaluate",
      feature: "strategy_management",
      label: "评估队列调度策略",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "POST", path: "/api/strategy/queue-policy/evaluate" },
      rpc: { method: "strategy.queue_policy.evaluate", body: "params" },
      cli: { command: ["strategy", "queue-policy", "evaluate"], usage: "strategy queue-policy evaluate --body payload.json" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject({
        ...strategyCommonInput,
        queueDefinitionId: stringValue,
        queueId: stringValue,
        queueLabel: stringValue,
        label: stringValue,
        payloadKind: stringValue,
        priority: numberValue,
        maxAttempts: numberValue,
        backpressureStrategy: stringValue,
        policyVersion: stringValue,
        queueDefinition: closedObject({ queueDefinitionId: stringValue, label: stringValue }),
        queue: closedObject({
          blocked: booleanValue,
          priority: numberValue,
          maxAttempts: numberValue,
          backpressureStrategy: stringValue,
          policyVersion: stringValue
        }),
        payloadRef: closedObject({ kind: stringValue }),
        payload: closedObject({ kind: stringValue })
      }, ["queueDefinitionId", "operationId"]),
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "queue-policy", "work-queue"]
    },
{
      id: "strategy.tool_policy.preview",
      feature: "strategy_management",
      label: "预览工具调用策略",
      target: { controller: "system", method: "handleStrategyManagement" },
      http: { method: "POST", path: "/api/strategy/tool-policy/preview" },
      rpc: { method: "strategy.tool_policy.preview", body: "params" },
      cli: { command: ["strategy", "tool-policy", "preview"], usage: "strategy tool-policy preview --body payload.json" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject({
        toolId: stringValue,
        grantId: stringValue,
        profileId: stringValue,
        dryRun: booleanValue,
        traceId: stringValue,
        toolExecutionId: stringValue
      }, ["toolId"]),
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "tool-policy", "operation-permission"]
    },
{
      id: "agents.list",
      feature: "agent_management",
      label: "列出可用智能体模型接入点",
      target: { controller: "system", method: "handleAgentRegistry" },
      http: { method: "GET", path: "/api/agents" },
      rpc: { method: "agents.list" },
      cli: {
        command: ["agents", "list"],
        usage: "agents list"
      },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      aspects: ["agent-management", "model-library"]
    },
{
      id: "agents.create",
      feature: "agent_management",
      label: "创建智能体模型配置",
      target: { controller: "system", method: "handleCreateAgent" },
      http: { method: "POST", path: "/api/agents" },
      rpc: { method: "agents.create", body: "params" },
      cli: {
        command: ["agents", "create"],
        usage: "agents create --name NAME --model MODEL [--provider PROVIDER] [--api-key KEY]",
        bodyParams: [
          { name: "provider", aliases: ["provider", "model-provider"] },
    { name: "name", aliases: ["name", "agent-name", "agentName", "label"] },
    { name: "model", aliases: ["model", "model-id", "modelId", "engine"], required: true },
    { name: "baseUrl", aliases: ["base-url", "baseUrl"] },
    { name: "url", aliases: ["url", "endpoint"] },
    { name: "apiKey", aliases: ["api-key", "apiKey", "key"] },
    { name: "token", aliases: ["token"] },
    { name: "tokenHeader", aliases: ["token-header", "tokenHeader"] },
    { name: "tokenPrefix", aliases: ["token-prefix", "tokenPrefix"] },
    { name: "systemPrompt", aliases: ["system-prompt", "systemPrompt", "prompt"] },
    { name: "parameters", aliases: ["parameters", "params"], type: "json" },
    { name: "pluginList", aliases: ["plugin-list", "pluginList", "plugins"], type: "string-list" },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs"], type: "number" }
        ]
      },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" },
      concurrencyGroup: "agent_management.model_library",
      aspects: ["agent-management", "model-library"]
    },
{
      id: "agents.update",
      feature: "agent_management",
      label: "更新智能体模型配置",
      target: { controller: "system", method: "handleUpdateAgent" },
      http: { method: "POST", path: "/api/agents/:agentId" },
      rpc: {
        method: "agents.update",
        body: "params",
        params: [{ name: "agentId", aliases: ["agent-id", "agentId", "id"], required: true }]
      },
      cli: {
        command: ["agents", "update"],
        usage: "agents update --id AGENT_UID [--name NAME] [--model MODEL] [--body patch.json]",
        pathParams: { agentId: ["agent-id", "agentId", "id"] },
        bodyParams: [
          { name: "provider", aliases: ["provider", "model-provider"] },
    { name: "name", aliases: ["name", "agent-name", "agentName", "label"] },
    { name: "model", aliases: ["model", "model-id", "modelId", "engine"] },
    { name: "baseUrl", aliases: ["base-url", "baseUrl"] },
    { name: "url", aliases: ["url", "endpoint"] },
    { name: "apiKey", aliases: ["api-key", "apiKey", "key"] },
    { name: "token", aliases: ["token"] },
    { name: "tokenHeader", aliases: ["token-header", "tokenHeader"] },
    { name: "tokenPrefix", aliases: ["token-prefix", "tokenPrefix"] },
    { name: "systemPrompt", aliases: ["system-prompt", "systemPrompt", "prompt"] },
    { name: "parameters", aliases: ["parameters", "params"], type: "json" },
    { name: "pluginList", aliases: ["plugin-list", "pluginList", "plugins"], type: "string-list" },
    { name: "timeoutMs", aliases: ["timeout-ms", "timeoutMs"], type: "number" }
        ]
      },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" },
      concurrencyGroup: "agent_management.model_library",
      aspects: ["agent-management", "model-library"]
    },
{
      id: "agents.delete",
      feature: "agent_management",
      label: "删除智能体模型配置",
      target: { controller: "system", method: "handleDeleteAgent" },
      http: { method: "DELETE", path: "/api/agents/:agentId" },
      rpc: {
        method: "agents.delete",
        params: [{ name: "agentId", aliases: ["agent-id", "agentId", "id"], required: true }]
      },
      cli: {
        command: ["agents", "delete"],
        usage: "agents delete --id AGENT_UID",
        pathParams: { agentId: ["agent-id", "agentId", "id"] }
      },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" },
      concurrencyGroup: "agent_management.model_library",
      aspects: ["agent-management", "model-library"]
    },
{
      id: "operation_permission.catalog",
      feature: "operation_permission",
      label: "工具管理目录",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/catalog", localInForwardMode: true },
      rpc: {method:"operation_permission.catalog",syntheticPath:"/api/operation-permission/v1/catalog"},
      cli: { command: ["tools", "catalog"], usage: "tools catalog" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.catalog_item",
      feature: "operation_permission",
      label: "工具管理目录项",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/catalog/:toolId", localInForwardMode: true },
      rpc: {method:"operation_permission.catalog_item",syntheticPath:"/api/operation-permission/v1/catalog/:toolId",params:[{name:"toolId",aliases:["toolId","tool-id","id"],required:true}]},
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.toolsets",
      feature: "operation_permission",
      label: "工具集列表",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/toolsets", localInForwardMode: true },
      rpc: {method:"operation_permission.toolsets",syntheticPath:"/api/operation-permission/v1/toolsets"},
      cli: { command: ["tools", "toolsets"], usage: "tools toolsets" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.toolsets_resolve",
      feature: "operation_permission",
      label: "解析工具集",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/toolsets/resolve", localInForwardMode: true },
      rpc: {method:"operation_permission.toolsets_resolve",syntheticPath:"/api/operation-permission/v1/toolsets/resolve",body:"params"},
      cli: { command: ["tools", "toolsets", "resolve"], usage: "tools toolsets resolve --body toolsets.json" },
      requiredScopes: ["console:read"],
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.profiles",
      feature: "operation_permission",
      label: "工具 Agent Profile 列表",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/profiles", localInForwardMode: true },
      rpc: {method:"operation_permission.profiles",syntheticPath:"/api/operation-permission/v1/profiles"},
      cli: { command: ["tools", "profiles"], usage: "tools profiles" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.policy_evaluate",
      feature: "operation_permission",
      label: "评估工具策略",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/policy/evaluate", localInForwardMode: true },
      rpc: {method:"operation_permission.policy_evaluate",syntheticPath:"/api/operation-permission/v1/policy/evaluate",body:"params"},
      requiredScopes: ["console:read"],
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.policy_preview",
      feature: "operation_permission",
      label: "预览工具策略",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/policy/preview", localInForwardMode: true },
      rpc: {method:"operation_permission.policy_preview",syntheticPath:"/api/operation-permission/v1/policy/preview",body:"params"},
      cli: { command: ["tools", "policy", "preview"], usage: "tools policy preview --body preview.json" },
      requiredScopes: ["console:read"],
      inputSchema: {
        type: "object",
        required: ["toolId", "input"],
        additionalProperties: false,
        properties: {
          toolId: { type: "string" },
          input: { type: "object" },
          dryRun: { type: "boolean" },
          grantId: { type: "string" },
          grant: { type: "object" },
          profileId: { type: "string" },
          context: { type: "object" }
        }
      },
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.execute",
      feature: "operation_permission",
      label: "执行工具",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/execute", localInForwardMode: true },
      rpc: {method:"operation_permission.execute",syntheticPath:"/api/operation-permission/v1/execute",body:"params"},
      cli: { command: ["tools", "execute"], usage: "tools execute --tool-id TOOL_ID --body input.json" },
      concurrencySafe: true,
      externalAuth: true,
      externalAuthVerifier: { method: "verifyToolSkillExternalAuth" },
      inputSchema: toolExecutionInput,
      safety: { risk: "safe_write", requiresConfirmation: false }
    },
{
      id: "operation_permission.batch",
      feature: "operation_permission",
      label: "批量执行工具",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/batch", localInForwardMode: true },
      rpc: {method:"operation_permission.batch",syntheticPath:"/api/operation-permission/v1/batch",body:"params"},
      concurrencySafe: true,
      externalAuth: true,
      externalAuthVerifier: { method: "verifyToolSkillExternalAuth" },
      inputSchema: toolBatchInput,
      safety: { risk: "safe_write", requiresConfirmation: false }
    },
{
      id: "operation_permission.dry_run",
      feature: "operation_permission",
      label: "工具 Dry Run",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/dry-run", localInForwardMode: true },
      rpc: {method:"operation_permission.dry_run",syntheticPath:"/api/operation-permission/v1/dry-run",body:"params"},
      cli: { command: ["tools", "dry-run"], usage: "tools dry-run --tool-id TOOL_ID --body input.json" },
      concurrencySafe: true,
      externalAuth: true,
      externalAuthVerifier: { method: "verifyToolSkillExternalAuth" },
      inputSchema: toolExecutionInput,
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.grants",
      feature: "operation_permission",
      label: "工具授权列表",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/grants", localInForwardMode: true },
      rpc: {method:"operation_permission.grants",syntheticPath:"/api/operation-permission/v1/grants"},
      cli: { command: ["tools", "grants"], usage: "tools grants list" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "operation_permission.create_grant",
      feature: "operation_permission",
      label: "创建工具授权",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/grants", localInForwardMode: true },
      rpc: {method:"operation_permission.create_grant",syntheticPath:"/api/operation-permission/v1/grants",body:"params"},
	      cli: { command: ["tools", "grants", "create"], usage: "tools grants create --body grant.json" },
	      requiredScopes: ["runtime:admin"],
	      inputSchema: grantMutationInput,
	      resourceContext: {
	        resourceKind: "operation_permission_grant",
	        fieldMap: {
	          workspaceId: ["allowedWorkspaceIds", "allowed-workspace-ids", "metadata.allowedWorkspaceIds"],
	          dataClasses: ["allowedDataClasses", "allowed-data-classes", "metadata.allowedDataClasses"],
	          requestedEgress: ["allowedEgress", "allowed-egress", "metadata.allowedEgress"],
	          serviceId: ["allowedServiceIds", "allowed-service-ids", "metadata.allowedServiceIds"],
	          secretBindingId: ["allowedSecretBindings", "allowed-secret-bindings", "metadata.allowedSecretBindings"],
	          staticSemanticFamilyId: ["allowedStaticSemanticFamilies", "allowed-static-semantic-families", "metadata.allowedStaticSemanticFamilies"],
	          capabilityDomain: ["allowedCapabilityDomains", "allowed-capability-domains", "metadata.allowedCapabilityDomains"],
	          capabilityVerb: ["allowedCapabilityVerbs", "allowed-capability-verbs", "metadata.allowedCapabilityVerbs"],
	          resourceKind: ["allowedResourceKinds", "allowed-resource-kinds", "metadata.allowedResourceKinds"],
	          effectKind: ["allowedEffectKinds", "allowed-effect-kinds", "metadata.allowedEffectKinds"]
	        }
	      },
	      safety: { risk: "repair_write" }
	    },
{
      id: "operation_permission.update_grant",
      feature: "operation_permission",
      label: "更新工具授权",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/grants/:grantId", localInForwardMode: true },
	      rpc: {method:"operation_permission.update_grant",syntheticPath:"/api/operation-permission/v1/grants/:grantId",params:[{name:"grantId",aliases:["grantId","grant-id","id"],required:true}],body:"params"},
	      requiredScopes: ["runtime:admin"],
	      inputSchema: grantMutationInput,
	      resourceContext: {
	        resourceKind: "operation_permission_grant",
	        fieldMap: {
	          workspaceId: ["allowedWorkspaceIds", "allowed-workspace-ids", "metadata.allowedWorkspaceIds"],
	          dataClasses: ["allowedDataClasses", "allowed-data-classes", "metadata.allowedDataClasses"],
	          requestedEgress: ["allowedEgress", "allowed-egress", "metadata.allowedEgress"],
	          serviceId: ["allowedServiceIds", "allowed-service-ids", "metadata.allowedServiceIds"],
	          secretBindingId: ["allowedSecretBindings", "allowed-secret-bindings", "metadata.allowedSecretBindings"],
	          staticSemanticFamilyId: ["allowedStaticSemanticFamilies", "allowed-static-semantic-families", "metadata.allowedStaticSemanticFamilies"],
	          capabilityDomain: ["allowedCapabilityDomains", "allowed-capability-domains", "metadata.allowedCapabilityDomains"],
	          capabilityVerb: ["allowedCapabilityVerbs", "allowed-capability-verbs", "metadata.allowedCapabilityVerbs"],
	          resourceKind: ["allowedResourceKinds", "allowed-resource-kinds", "metadata.allowedResourceKinds"],
	          effectKind: ["allowedEffectKinds", "allowed-effect-kinds", "metadata.allowedEffectKinds"]
	        }
	      },
	      safety: { risk: "repair_write" }
	    },
{
      id: "operation_permission.rotate_grant",
      feature: "operation_permission",
      label: "轮换工具授权 Token",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/grants/:grantId/rotate", localInForwardMode: true },
      rpc: {method:"operation_permission.rotate_grant",syntheticPath:"/api/operation-permission/v1/grants/:grantId/rotate",params:[{name:"grantId",aliases:["grantId","grant-id","id"],required:true}],body:"params"},
      cli: { command: ["tools", "grants", "rotate"], usage: "tools grants rotate --id GRANT_ID" },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" }
    },
{
      id: "operation_permission.revoke_grant",
      feature: "operation_permission",
      label: "吊销工具授权",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/grants/:grantId/revoke", localInForwardMode: true },
      rpc: {method:"operation_permission.revoke_grant",syntheticPath:"/api/operation-permission/v1/grants/:grantId/revoke",params:[{name:"grantId",aliases:["grantId","grant-id","id"],required:true}],body:"params"},
      cli: { command: ["tools", "grants", "revoke"], usage: "tools grants revoke --id GRANT_ID" },
      requiredScopes: ["runtime:admin"],
      inputSchema: closedObject({ grantId: stringValue, reason: stringValue }, ["grantId"]),
      safety: { risk: "repair_write" }
    }
]);
