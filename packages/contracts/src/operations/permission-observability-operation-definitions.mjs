export const PERMISSION_OBSERVABILITY_OPERATION_DEFINITIONS = Object.freeze([
{
      id: "operation_permission.audit",
      feature: "operation_permission",
      label: "工具调用记录",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/audit",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "toolId", aliases: ["tool-id", "toolId"] },
    { name: "grantId", aliases: ["grant-id", "grantId"] },
    { name: "status", aliases: ["status"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: {method:"operation_permission.audit",syntheticPath:"/api/operation-permission/v1/audit",query:[{name:"limit",aliases:["limit"]},
    {name:"toolId",aliases:["tool-id","toolId"]},
    {name:"grantId",aliases:["grant-id","grantId"]},
    {name:"status",aliases:["status"]}]},
      cli: { command: ["tools", "audit"], usage: "tools audit [--limit 100]" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.audit_item",
      feature: "operation_permission",
      label: "工具调用详情",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/audit/:toolExecutionId", localInForwardMode: true },
      rpc: {method:"operation_permission.audit_item",syntheticPath:"/api/operation-permission/v1/audit/:toolExecutionId",params:[{name:"toolExecutionId",aliases:["toolExecutionId","tool-execution-id","id"],required:true}]},
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_summary",
      feature: "operation_permission",
      label: "工具指标摘要",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/metrics/summary",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "since", aliases: ["since"] },
    { name: "until", aliases: ["until"] },
    { name: "toolId", aliases: ["toolId", "tool-id"] },
    { name: "route", aliases: ["route"] },
    { name: "transport", aliases: ["transport"] },
    { name: "status", aliases: ["status"] },
    { name: "statusCode", aliases: ["statusCode", "status-code"] },
    { name: "completionStatus", aliases: ["completionStatus", "completion-status"] },
    { name: "bucketSeconds", aliases: ["bucketSeconds", "bucket-seconds"] }
        ],
        coerce: { limit: "number", statusCode: "number", bucketSeconds: "number" }
      },
      rpc: {method:"operation_permission.metrics_summary",syntheticPath:"/api/operation-permission/v1/metrics/summary",query:[{name:"limit",aliases:["limit"]},
    {name:"since",aliases:["since"]},
    {name:"until",aliases:["until"]},
    {name:"toolId",aliases:["toolId","tool-id"]},
    {name:"route",aliases:["route"]},
    {name:"transport",aliases:["transport"]},
    {name:"status",aliases:["status"]},
    {name:"statusCode",aliases:["statusCode","status-code"]},
    {name:"completionStatus",aliases:["completionStatus","completion-status"]},
    {name:"bucketSeconds",aliases:["bucketSeconds","bucket-seconds"]}]},
      cli: { command: ["tools", "metrics"], usage: "tools metrics [--tool-id ID] [--route PATH] [--transport KIND] [--bucket-seconds N]" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_export",
      feature: "operation_permission",
      label: "工具指标导出",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/metrics/export",
        localInForwardMode: true,
        query: [
          { name: "limit", aliases: ["limit"] },
    { name: "since", aliases: ["since"] },
    { name: "until", aliases: ["until"] },
    { name: "kind", aliases: ["kind"] },
    { name: "toolId", aliases: ["toolId", "tool-id"] },
    { name: "route", aliases: ["route"] },
    { name: "transport", aliases: ["transport"] },
    { name: "status", aliases: ["status"] },
    { name: "statusCode", aliases: ["statusCode", "status-code"] },
    { name: "completionStatus", aliases: ["completionStatus", "completion-status"] }
        ],
        coerce: { limit: "number", statusCode: "number" }
      },
      rpc: {method:"operation_permission.metrics_export",syntheticPath:"/api/operation-permission/v1/metrics/export",query:[{name:"limit",aliases:["limit"]},
    {name:"since",aliases:["since"]},
    {name:"until",aliases:["until"]},
    {name:"kind",aliases:["kind"]},
    {name:"toolId",aliases:["toolId","tool-id"]},
    {name:"route",aliases:["route"]},
    {name:"transport",aliases:["transport"]},
    {name:"status",aliases:["status"]},
    {name:"statusCode",aliases:["statusCode","status-code"]},
    {name:"completionStatus",aliases:["completionStatus","completion-status"]}]},
      cli: { command: ["tools", "metrics", "export"], usage: "tools metrics export [--kind all|tool|request] [--output metrics.json]" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_health",
      feature: "operation_permission",
      label: "工具指标健康状态",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/metrics/health",
        localInForwardMode: true,
        query: [
          { name: "windowSeconds", aliases: ["windowSeconds", "window-seconds"] },
    { name: "maxRequestErrorRate", aliases: ["maxRequestErrorRate", "max-request-error-rate"] },
    { name: "maxToolFailureRate", aliases: ["maxToolFailureRate", "max-tool-failure-rate"] },
    { name: "maxDeniedRate", aliases: ["maxDeniedRate", "max-denied-rate"] },
    { name: "minRequests", aliases: ["minRequests", "min-requests"] }
        ],
        coerce: {
          windowSeconds: "number",
          maxRequestErrorRate: "number",
          maxToolFailureRate: "number",
          maxDeniedRate: "number",
          minRequests: "number"
        }
      },
      rpc: {method:"operation_permission.metrics_health",syntheticPath:"/api/operation-permission/v1/metrics/health",query:[{name:"windowSeconds",aliases:["windowSeconds","window-seconds"]},
    {name:"maxRequestErrorRate",aliases:["maxRequestErrorRate","max-request-error-rate"]},
    {name:"maxToolFailureRate",aliases:["maxToolFailureRate","max-tool-failure-rate"]},
    {name:"maxDeniedRate",aliases:["maxDeniedRate","max-denied-rate"]},
    {name:"minRequests",aliases:["minRequests","min-requests"]}]},
      cli: { command: ["tools", "metrics", "health"], usage: "tools metrics health [--window-seconds 300]" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_prometheus",
      feature: "operation_permission",
      label: "工具指标 Prometheus 导出",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/metrics/prometheus",
        localInForwardMode: true,
        query: [
          { name: "windowSeconds", aliases: ["windowSeconds", "window-seconds"] },
    { name: "maxRequestErrorRate", aliases: ["maxRequestErrorRate", "max-request-error-rate"] },
    { name: "maxToolFailureRate", aliases: ["maxToolFailureRate", "max-tool-failure-rate"] },
    { name: "maxDeniedRate", aliases: ["maxDeniedRate", "max-denied-rate"] },
    { name: "minRequests", aliases: ["minRequests", "min-requests"] }
        ],
        coerce: {
          windowSeconds: "number",
          maxRequestErrorRate: "number",
          maxToolFailureRate: "number",
          maxDeniedRate: "number",
          minRequests: "number"
        }
      },
      rpc: {method:"operation_permission.metrics_prometheus",syntheticPath:"/api/operation-permission/v1/metrics/prometheus",query:[{name:"windowSeconds",aliases:["windowSeconds","window-seconds"]},
    {name:"maxRequestErrorRate",aliases:["maxRequestErrorRate","max-request-error-rate"]},
    {name:"maxToolFailureRate",aliases:["maxToolFailureRate","max-tool-failure-rate"]},
    {name:"maxDeniedRate",aliases:["maxDeniedRate","max-denied-rate"]},
    {name:"minRequests",aliases:["minRequests","min-requests"]}]},
      cli: { command: ["tools", "metrics", "prometheus"], usage: "tools metrics prometheus [--window-seconds 300]" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_storage",
      feature: "operation_permission",
      label: "工具指标存储摘要",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "GET", path: "/api/operation-permission/v1/metrics/storage", localInForwardMode: true },
      rpc: {method:"operation_permission.metrics_storage",syntheticPath:"/api/operation-permission/v1/metrics/storage"},
      cli: { command: ["tools", "metrics", "storage"], usage: "tools metrics storage" },
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.metrics_prune",
      feature: "operation_permission",
      label: "工具指标清理",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/metrics/prune", localInForwardMode: true },
      rpc: {method:"operation_permission.metrics_prune",syntheticPath:"/api/operation-permission/v1/metrics/prune",body:"params"},
      cli: { command: ["tools", "metrics", "prune"], usage: "tools metrics prune --confirm --body prune.json" },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write" }
    },
{
      id: "operation_permission.events",
      feature: "operation_permission",
      label: "工具事件",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/events",
        localInForwardMode: true,
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: {method:"operation_permission.events",syntheticPath:"/api/operation-permission/v1/events",query:[{name:"limit",aliases:["limit"]}]},
      requiredScopes: ["console:read"]
    },
{
      id: "operation_permission.pending_operations.list",
      feature: "operation_permission",
      label: "待审批工具操作",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: {
        method: "GET",
        path: "/api/operation-permission/v1/pending-operations",
        localInForwardMode: true,
        query: [
          { name: "status", aliases: ["status"] },
    { name: "limit", aliases: ["limit"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: {method:"operation_permission.pending_operations.list",syntheticPath:"/api/operation-permission/v1/pending-operations",query:[{name:"status",aliases:["status"]},
    {name:"limit",aliases:["limit"]}]},
      cli: { command: ["tools", "pending", "list"], usage: "tools pending list [--status pending]" },
      requiredScopes: ["console:read"],
      safety: { risk: "read_only", requiresConfirmation: false }
    },
{
      id: "operation_permission.pending_operations.resolve",
      feature: "operation_permission",
      label: "审批待执行工具操作",
      target: { controller: "system", method: "handleOperationPermissionPassthrough" },
      http: { method: "POST", path: "/api/operation-permission/v1/pending-operations/:pendingOperationId/resolve", localInForwardMode: true },
      rpc: {method:"operation_permission.pending_operations.resolve",syntheticPath:"/api/operation-permission/v1/pending-operations/:pendingOperationId/resolve",params:[{name:"pendingOperationId",aliases:["pendingOperationId","pending-operation-id","id"],required:true}],body:"params"},
      cli: { command: ["tools", "pending", "resolve"], usage: "tools pending resolve --id PENDING_OPERATION_ID --body decision.json" },
      requiredScopes: ["runtime:admin"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "runtime:admin" },
      inputSchema: {
        type: "object",
        required: ["pendingOperationId", "resolution"],
        additionalProperties: false,
        properties: {
          pendingOperationId: { type: "string" },
          resolution: { type: "string", enum: ["approved", "denied", "cancelled"] },
          reason: { type: "string" },
          resumeInput: { type: "object", additionalProperties: true }
        }
      }
    }]);
