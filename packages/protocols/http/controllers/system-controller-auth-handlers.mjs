export function createSystemControllerAuthHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  securityPermissions,
  operationAuditStore,
  appendConsoleOperationLog
}) {
  return {
    async handleAuthSession({ operation, request, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.session",
        response,
        context: { securityPermissions, request },
        errorMessage: "读取控制台登录状态失败。"
      });
    },
    async handleAuthLogin({ operation, request, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.login",
        input: parseJsonBody(requestBody),
        response,
        context: { securityPermissions, request, appendConsoleOperationLog },
        errorMessage: "登录失败。"
      });
    },
    async handleAuthLogout({ operation, request, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.logout",
        response,
        context: { securityPermissions, request, authSession, appendConsoleOperationLog },
        errorMessage: "退出登录失败。"
      });
    },
    async handleAuthUsers({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0 ? "auth.users.create" : "auth.users"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { securityPermissions },
        errorMessage: "读取控制台用户失败。"
      });
    },
    async handleAuthUpdateUser({ operation, userId, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.users.update",
        input: {
          ...parseJsonBody(requestBody),
          userId
        },
        response,
        context: { securityPermissions, authSession },
        errorMessage: "更新用户失败。"
      });
    },
    async handleAuthRole({ operation, roleId, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.roles.get",
        input: { roleId },
        response,
        context: { securityPermissions },
        errorMessage: "读取角色失败。"
      });
    },
    async handleAuthOidc({ operation, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0 ? "auth.oidc.set" : "auth.oidc.get"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { securityPermissions, authSession },
        errorMessage: "OIDC 操作失败。"
      });
    },
    async handleAuthAudit({ operation, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.audit",
        input: {
          limit: Number(url.searchParams.get("limit") || 100),
          operationId: url.searchParams.get("operationId") || url.searchParams.get("operation-id") || "",
          userId: url.searchParams.get("userId") || url.searchParams.get("user-id") || "",
          status: url.searchParams.get("status") || "",
          traceId: url.searchParams.get("traceId") || url.searchParams.get("trace-id") || "",
          tenantId: url.searchParams.get("tenantId") || url.searchParams.get("tenant-id") || "",
          createdFrom: url.searchParams.get("createdFrom") || url.searchParams.get("created-from") || "",
          createdTo: url.searchParams.get("createdTo") || url.searchParams.get("created-to") || ""
        },
        response,
        context: { securityPermissions, operationAuditStore },
        errorMessage: "读取认证审计失败。"
      });
    },
    async handleAuthAuditExport({ operation, url, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.audit.export",
        input: {
          limit: Number(url.searchParams.get("limit") || 100),
          operationId: url.searchParams.get("operationId") || url.searchParams.get("operation-id") || "",
          userId: url.searchParams.get("userId") || url.searchParams.get("user-id") || "",
          status: url.searchParams.get("status") || "",
          traceId: url.searchParams.get("traceId") || url.searchParams.get("trace-id") || "",
          tenantId: url.searchParams.get("tenantId") || url.searchParams.get("tenant-id") || "",
          createdFrom: url.searchParams.get("createdFrom") || url.searchParams.get("created-from") || "",
          createdTo: url.searchParams.get("createdTo") || url.searchParams.get("created-to") || ""
        },
        response,
        context: { securityPermissions, operationAuditStore, authSession },
        errorMessage: "导出认证审计失败。"
      });
    },
    async handleAuthAuditRetention({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0 ? "auth.audit.retention.set" : "auth.audit.retention.get"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { securityPermissions, operationAuditStore, authSession },
        errorMessage: "审计保留策略操作失败。"
      });
    },
    async handleAuthAuditPrune({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.audit.prune",
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { securityPermissions, operationAuditStore, authSession },
        errorMessage: "审计清理失败。"
      });
    },
    async handleObservabilityTraceGet({ operation, traceId, url, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "observability.trace.get",
        input: {
          traceId,
          limit: Number(url.searchParams.get("limit") || 200),
          tenantId: url.searchParams.get("tenantId") || url.searchParams.get("tenant-id") || ""
        },
        response,
        context: { securityPermissions, operationAuditStore },
        errorMessage: "读取 trace 详情失败。"
      });
    },
    async handleAuthSessions({ operation, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.sessions",
        response,
        context: { securityPermissions },
        errorMessage: "读取控制台会话失败。"
      });
    },
    async handleAuthRotateSession({ operation, request, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.sessions.rotate",
        response,
        context: { securityPermissions, request, authSession, appendConsoleOperationLog },
        errorMessage: "轮换控制台会话失败。"
      });
    },
    async handleAuthRevokeSession({ operation, sessionId, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "auth.sessions.revoke",
        input: { sessionId },
        response,
        context: { securityPermissions, authSession },
        errorMessage: "撤销控制台会话失败。"
      });
    }
  };
}
