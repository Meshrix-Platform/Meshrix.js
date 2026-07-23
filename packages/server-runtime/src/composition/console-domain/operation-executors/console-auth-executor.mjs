
import { hashClientString } from "@lico/foundation/security/client-strings";
import { appendConsoleLog, errorPayload, result } from "./shared.mjs";

export function loginInputSummary(input = {}, request = null) {
  const username = String(input.username || "").trim().toLowerCase();
  return {
    usernameHash: username ? hashClientString(username, "console.auth.username") : "",
    usernameLength: username.length,
    host: String(request?.headers?.host || ""),
    origin: String(request?.headers?.origin || ""),
    remoteAddressHash: request?.socket?.remoteAddress
      ? hashClientString(request.socket.remoteAddress, "console.auth.remote")
      : "",
    userAgentHash: request?.headers?.["user-agent"]
      ? hashClientString(request.headers["user-agent"], "console.auth.user_agent")
      : ""
  };
}


export async function executeConsoleAuthOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "auth.session",
    "auth.login",
    "auth.logout",
    "auth.users",
    "auth.users.create",
    "auth.users.update",
    "auth.roles.get",
    "auth.oidc.get",
    "auth.oidc.set",
    "auth.audit",
    "auth.audit.export",
    "auth.audit.retention.get",
    "auth.audit.retention.set",
    "auth.audit.prune",
    "auth.sessions",
    "auth.sessions.rotate",
    "auth.sessions.revoke",
    "observability.trace.get"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const authProvider = context.securityPermissions;
  if (!authProvider) {
    return result(503, { error: "控制台认证模块不可用。" });
  }
  const request = context.request || null;
  const authSession = context.authSession || null;

  if (id === "auth.session") {
    return result(200, authProvider.getConsoleSummary
      ? authProvider.getConsoleSummary(request)
      : authProvider.getSummary(request));
  }
  if (id === "auth.login") {
    const inputSummary = loginInputSummary(input, request);
    try {
      const login = await authProvider.login(input, request);
      authProvider.audit({
        user: login.session?.user,
        operationId: "auth.login",
        action: "login",
        method: "POST",
        path: "/api/auth/login",
        status: "ok"
      });
      appendConsoleLog(context, {
        operationId: "auth.login.session",
        event: "console.auth.login.succeeded",
        authSession: login.session,
        status: "ok",
        input: inputSummary,
        output: {
          userId: login.session?.user?.userId || "",
          username: login.session?.user?.username || "",
          roleId: login.session?.user?.roleId || "",
          expiresAt: login.session?.expiresAt || ""
        }
      });
      return result(200, {
        __headers: { "Set-Cookie": login.cookies },
        ok: true,
        session: login.session,
        csrfToken: login.csrfToken,
        roles: authProvider.roleList()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败。";
      const publicMessage = "用户名或密码错误。";
      authProvider.audit({
        operationId: "auth.login",
        action: "login",
        method: "POST",
        path: "/api/auth/login",
        status: "failed",
        target: inputSummary,
        error: message
      });
      appendConsoleLog(context, {
        operationId: "auth.login.session",
        event: "console.auth.login.failed",
        status: "failed",
        input: inputSummary,
        error: message
      });
      return result(401, { error: publicMessage });
    }
  }
  if (id === "auth.logout") {
    const operationResult = authProvider.logout(request);
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.logout",
      action: "logout",
      method: "POST",
      path: "/api/auth/logout",
      status: "ok"
    });
    appendConsoleLog(context, {
      operationId: "auth.logout.session",
      event: "console.auth.logout.succeeded",
      authSession,
      status: "ok",
      input: {
        userId: authSession?.user?.userId || "",
        username: authSession?.user?.username || "",
        roleId: authSession?.user?.roleId || ""
      }
    });
    return result(200, {
      __headers: { "Set-Cookie": operationResult.cookies },
      ok: true
    });
  }
  if (id === "auth.users") {
    return result(200, {
      users: authProvider.listUsers(),
      roles: authProvider.roleList()
    });
  }
  if (id === "auth.users.create") {
    return result(405, {
      error: "用户创建和初始密码设置仅允许在服务端命令行执行。"
    });
  }
  if (id === "auth.users.update") {
    try {
      if (input.password || input.newPassword) {
        return result(405, {
          error: "密码修改仅允许在服务端命令行执行。"
        });
      }
      const userId = String(input.userId || input["user-id"] || input.id || "").trim();
      const user = await authProvider.updateUser(userId, input);
      if (!user) {
        return result(404, { error: "用户不存在。" });
      }
      authProvider.audit({
        user: authSession?.user,
        operationId: "auth.users.update",
        action: "update-user",
        method: "POST",
        path: `/api/auth/users/${userId}`,
        status: "ok",
        target: { userId: user.userId, roleId: user.roleId, enabled: user.enabled }
      });
      return result(200, { user, users: authProvider.listUsers() });
    } catch (error) {
      return result(400, {
        error: error instanceof Error ? error.message : "更新用户失败。"
      });
    }
  }
  if (id === "auth.roles.get") {
    const roleId = String(input.roleId || input["role-id"] || input.id || "").trim();
    const role = authProvider.roleList().find((item) => item.roleId === roleId);
    if (!role) {
      return result(404, { error: "角色不存在。" });
    }
    return result(200, { role });
  }
  if (id === "auth.oidc.get") {
    return result(200, { oidc: authProvider.getOidcConfig() });
  }
  if (id === "auth.oidc.set") {
    const oidc = authProvider.setOidcConfig(input);
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.oidc",
      action: "set-oidc",
      method: "POST",
      path: "/api/auth/oidc",
      status: "ok",
      target: { enabled: oidc.enabled, issuer: oidc.issuer, clientId: oidc.clientId }
    });
    return result(200, { oidc });
  }
  if (id === "auth.audit") {
    const query = {
      limit: Number(input.limit || 100),
      operationId: input.operationId || input["operation-id"] || "",
      userId: input.userId || input["user-id"] || "",
      status: input.status || "",
      traceId: input.traceId || input["trace-id"] || "",
      tenantId: input.tenantId || input["tenant-id"] || "",
      createdFrom: input.createdFrom || input["created-from"] || "",
      createdTo: input.createdTo || input["created-to"] || ""
    };
    if (context.operationAuditStore) {
      return result(200, {
        items: context.operationAuditStore.list(query)
      });
    }
    return result(200, {
      items: authProvider.listAudit({
        limit: query.limit,
        userId: query.userId,
        status: query.status
      })
    });
  }
  if (id === "auth.audit.export") {
    if (!context.operationAuditStore?.exportRedacted) {
      return result(503, { error: "系统审计导出接口不可用。" });
    }
    const exportResult = context.operationAuditStore.exportRedacted({
      limit: Number(input.limit || 100),
      operationId: input.operationId || input["operation-id"] || "",
      userId: input.userId || input["user-id"] || "",
      status: input.status || "",
      traceId: input.traceId || input["trace-id"] || "",
      tenantId: input.tenantId || input["tenant-id"] || "",
      createdFrom: input.createdFrom || input["created-from"] || "",
      createdTo: input.createdTo || input["created-to"] || ""
    });
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.audit.export",
      action: "export-audit",
      method: "GET",
      path: "/api/auth/audit/export",
      status: "ok",
      target: exportResult.manifest
    });
    return result(200, {
      export: {
        manifest: exportResult.manifest,
        items: exportResult.items,
        jsonl: exportResult.jsonl
      }
    });
  }
  if (id === "auth.audit.retention.get") {
    if (!context.operationAuditStore?.getRetentionPolicy) {
      return result(503, { error: "系统审计保留策略接口不可用。" });
    }
    return result(200, { policy: context.operationAuditStore.getRetentionPolicy() });
  }
  if (id === "auth.audit.retention.set") {
    if (!context.operationAuditStore?.setRetentionPolicy) {
      return result(503, { error: "系统审计保留策略接口不可用。" });
    }
    const policy = context.operationAuditStore.setRetentionPolicy({
      retentionDays: input.retentionDays || input["retention-days"],
      maxExportItems: input.maxExportItems || input["max-export-items"],
      maxRecords: input.maxRecords || input["max-records"],
      maxLogicalBytes: input.maxLogicalBytes || input["max-logical-bytes"],
      maxDatabaseBytes: input.maxDatabaseBytes || input["max-database-bytes"],
      cleanupBatchSize: input.cleanupBatchSize || input["cleanup-batch-size"],
      maintenanceEveryAppends: input.maintenanceEveryAppends || input["maintenance-every-appends"],
      updatedBy: authSession?.user || {}
    });
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.audit.retention.set",
      action: "set-audit-retention",
      method: "POST",
      path: "/api/auth/audit/retention",
      status: "ok",
      target: policy
    });
    return result(200, { policy });
  }
  if (id === "auth.audit.prune") {
    if (!context.operationAuditStore?.pruneExpired) {
      return result(503, { error: "系统审计清理接口不可用。" });
    }
    const prune = context.operationAuditStore.pruneExpired({
      retentionDays: input.retentionDays || input["retention-days"]
    });
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.audit.prune",
      action: "prune-audit",
      method: "POST",
      path: "/api/auth/audit/prune",
      status: "ok",
      target: prune
    });
    return result(200, { prune });
  }
  if (id === "observability.trace.get") {
    if (!context.operationAuditStore?.getTrace) {
      return result(503, { error: "trace 查询接口不可用。" });
    }
    const traceId = String(input.traceId || input["trace-id"] || input.id || "").trim();
    const trace = context.operationAuditStore.getTrace(traceId, {
      limit: Number(input.limit || 200),
      tenantId: input.tenantId || input["tenant-id"] || ""
    });
    const authorizationDecisions = authProvider.listDecisions
      ? authProvider.listDecisions({
          traceId,
          limit: Number(input.limit || 200),
          tenantId: input.tenantId || input["tenant-id"] || ""
        })
      : [];
    return result(200, {
      ...trace,
      authorizationDecisions,
      authorizationDecisionCount: authorizationDecisions.length
    });
  }
  if (id === "auth.sessions") {
    return result(200, { sessions: authProvider.listSessions() });
  }
  if (id === "auth.sessions.rotate") {
    const operationResult = authProvider.rotateSession(request);
    if (!operationResult.ok) {
      return result(operationResult.status || 401, { error: operationResult.error || "会话轮换失败。" });
    }
    authProvider.audit({
      user: operationResult.session?.user || authSession?.user,
      operationId: "auth.sessions.rotate",
      action: "rotate-session",
      method: "POST",
      path: "/api/auth/sessions/rotate",
      status: "ok",
      target: {
        sessionId: operationResult.session?.sessionId || "",
        rotatedAt: operationResult.rotatedAt || ""
      }
    });
    appendConsoleLog(context, {
      operationId: "auth.sessions.rotate",
      event: "console.auth.session.rotated",
      authSession: operationResult.session,
      status: "ok",
      input: {
        sessionId: operationResult.session?.sessionId || ""
      }
    });
    return result(200, {
      __headers: { "Set-Cookie": operationResult.cookies },
      ok: true,
      session: operationResult.session,
      csrfToken: operationResult.csrfToken,
      rotatedAt: operationResult.rotatedAt
    });
  }
  if (id === "auth.sessions.revoke") {
    const sessionId = String(input.sessionId || input["session-id"] || input.id || "").trim();
    const operationResult = authProvider.revokeSession(sessionId);
    authProvider.audit({
      user: authSession?.user,
      operationId: "auth.sessions.revoke",
      action: "revoke-session",
      method: "POST",
      path: `/api/auth/sessions/${sessionId}/revoke`,
      status: operationResult.ok ? "ok" : "not_found",
      target: { sessionId }
    });
    return result(operationResult.ok ? 200 : 404, operationResult.ok ? operationResult : { error: "会话不存在。" });
  }

  return null;
}
