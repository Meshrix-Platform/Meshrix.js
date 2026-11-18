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
const stringArray: Readonly<Record<string, any>> = Object.freeze({ type: "array", items: stringValue, maxItems: 256 });
const apiKeyPolicyInput: any = closedObject({
  protocol: stringValue,
  serviceIds: stringArray,
  capabilityIds: stringArray,
  toolsetIds: stringArray,
  allowedTools: stringArray,
  deniedTools: stringArray,
  scopeIds: stringArray,
  maximumRisk: stringValue,
  audience: closedObject({
    serverAudience: stringValue,
    targetIds: stringArray,
    connectorPackageIds: stringArray
  }, ["serverAudience", "targetIds", "connectorPackageIds"]),
  resources: closedObject({
    mode: stringValue,
    workspaceIds: stringArray,
    dataClassifications: stringArray,
    egressClasses: stringArray,
    semanticFamilies: stringArray,
    capabilityDomains: stringArray,
    capabilityVerbs: stringArray,
    resourceKinds: stringArray,
    effectKinds: stringArray,
    secretBindingIds: stringArray,
    allowedOrigins: stringArray,
    allowedCidrs: stringArray
  }, [
    "mode", "workspaceIds", "dataClassifications", "egressClasses", "semanticFamilies",
    "capabilityDomains", "capabilityVerbs", "resourceKinds", "effectKinds", "secretBindingIds",
    "allowedOrigins", "allowedCidrs"
  ]),
  processIdentity: Object.freeze({ type: "object", additionalProperties: false, properties: {
    mode: stringValue,
    allowedPublicKeyFingerprints: stringArray
  }, required: ["mode"] }),
  limits: closedObject({
    maxUses: numberValue,
    requestsPerWindow: numberValue,
    windowSeconds: numberValue,
    maxConcurrentEffects: numberValue
  }, ["maxUses", "requestsPerWindow", "windowSeconds", "maxConcurrentEffects"]),
  catalogFingerprint: stringValue
}, [
  "protocol", "serviceIds", "capabilityIds", "toolsetIds", "allowedTools", "deniedTools",
  "scopeIds", "maximumRisk", "audience", "resources", "processIdentity", "limits", "catalogFingerprint"
]);
const apiKeyCreateInput: any = closedObject({
  workloadDisplayName: stringValue,
  organizationNodeId: stringValue,
  expiresAt: stringValue,
  policy: apiKeyPolicyInput
}, ["workloadDisplayName", "organizationNodeId", "expiresAt", "policy"]);
const apiKeyRevisionInput: any = closedObject({ expectedLifecycleRevision: numberValue }, ["expectedLifecycleRevision"]);
const apiKeyRevokeInput: any = closedObject({
  expectedLifecycleRevision: numberValue,
  reasonCode: stringValue
}, ["expectedLifecycleRevision", "reasonCode"]);

export const STRATEGY_PERMISSION_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([






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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
        agentId: stringValue
      }, ["roleId"]),
      readOnly: true,
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "agent-policy"]
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
      safety: { risk: "read_only", requiresConfirmation: false },
      aspects: ["strategy-management", "tool-policy", "operation-permission"]
    },
{
      id: "operation_permission.api_keys.issuer_scopes",
      feature: "operation_permission",
      label: "读取 API Key 签发范围",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/api-keys/issuer-scopes", localInForwardMode: true },
      rpc: { method: "operation_permission.api_keys.issuer_scopes", syntheticPath: "/api/operation-permission/v1/api-keys/issuer-scopes" },
      requiredScopes: ["console:read"],
      inputSchema: closedObject(),
      readOnly: true,
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.api_keys.list",
      feature: "operation_permission",
      label: "列出 API Key",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/api-keys",
        localInForwardMode: true,
        query: [
          { name: "status", aliases: ["status"] },
          { name: "organizationNodeId", aliases: ["organizationNodeId", "organization-node-id"] },
          { name: "cursor", aliases: ["cursor"] },
          { name: "limit", aliases: ["limit"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: { method: "operation_permission.api_keys.list", syntheticPath: "/api/operation-permission/v1/api-keys" },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.api_keys.create",
      feature: "operation_permission",
      label: "创建 API Key",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/api-keys", localInForwardMode: true },
      rpc: { method: "operation_permission.api_keys.create", syntheticPath: "/api/operation-permission/v1/api-keys", body: "params" },
      requiredScopes: ["auth:admin"],
      inputSchema: apiKeyCreateInput,
      safety: { risk: "repair_write" }
    },
{
      id: "operation_permission.api_keys.rotate",
      feature: "operation_permission",
      label: "轮换 API Key",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/api-keys/:keyId/rotate", localInForwardMode: true },
      rpc: { method: "operation_permission.api_keys.rotate", syntheticPath: "/api/operation-permission/v1/api-keys/:keyId/rotate", params: [{ name: "keyId", aliases: ["keyId", "key-id", "id"], required: true }], body: "params" },
      requiredScopes: ["auth:admin"],
      inputSchema: apiKeyRevisionInput,
      safety: { risk: "repair_write" }
    },
{
      id: "operation_permission.api_keys.revoke",
      feature: "operation_permission",
      label: "吊销 API Key",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/api-keys/:keyId/revoke", localInForwardMode: true },
      rpc: { method: "operation_permission.api_keys.revoke", syntheticPath: "/api/operation-permission/v1/api-keys/:keyId/revoke", params: [{ name: "keyId", aliases: ["keyId", "key-id", "id"], required: true }], body: "params" },
      requiredScopes: ["auth:admin"],
      inputSchema: apiKeyRevokeInput,
      safety: { risk: "repair_write" }
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
      concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
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
