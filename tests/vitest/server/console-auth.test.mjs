import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildConsoleOperationAuthorizationInput,
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_COOKIE,
  createConsoleRoleCatalog,
  createConsoleAuth
} from "../../../packages/foundation/src/security/auth/console-auth.mjs";
import {
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  SESSION_INACTIVITY_TTL_MS
} from "../../../packages/foundation/src/security/auth/console-auth-support.mjs";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

async function withTempAuth(callback) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-auth-"));
  const tagManagementStore = createTagStoreAdapter({ userDataPath });
  const auth = createConsoleAuth({ userDataPath, tagManagementStore });
  try {
    return await callback(auth, userDataPath);
  } finally {
    auth.close();
    tagManagementStore.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function makeRequest({
  cookie = "",
  csrf = "",
  host = "console.local",
  method = "GET",
  origin = "",
  referer = "",
  remoteAddress = "127.0.0.1",
  secure = false,
  userAgent = "vitest-agent",
  url = "/api/console"
} = {}) {
  const headers = {
    host,
    "user-agent": userAgent
  };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-lico-csrf"] = csrf;
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  return {
    headers,
    method,
    socket: {
      encrypted: secure,
      remoteAddress
    },
    url
  };
}

function cookieMap(setCookies = []) {
  return Object.fromEntries(setCookies.map((cookie) => {
    const [name, value = ""] = String(cookie).split(";", 1)[0].split("=");
    return [decodeURIComponent(name), decodeURIComponent(value)];
  }));
}

function authCookieHeader(loginResult) {
  const cookies = cookieMap(loginResult.cookies);
  return [
    `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(cookies[CONSOLE_SESSION_COOKIE])}`,
    `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(cookies[CONSOLE_CSRF_COOKIE])}`
  ].join("; ");
}

function credentialFor(label) {
  return [label, "fixture", "credential"].join("-");
}

const PLUGIN_FEATURE_SCOPE_GRANTS = Object.freeze({
  "sample-feature": Object.freeze({
    admin: ["sample_plugin:read", "sample_plugin:write", "sample_plugin:admin"],
    operator: ["sample_plugin:read", "sample_plugin:write"],
    viewer: ["sample_plugin:read"]
  })
});

describe("console auth boundary behavior", () => {
  it("projects plugin-owned role scopes only for active features", () => {
    const inactiveRoles = createConsoleRoleCatalog({ activeFeatureIds: [] });
    for (const role of Object.values(inactiveRoles)) {
      expect(role.scopes.some((scope) => scope.startsWith("sample_plugin:"))).toBe(false);
    }

    const activeRoles = createConsoleRoleCatalog({ activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS });
    expect(activeRoles.admin.scopes).toEqual(expect.arrayContaining([
      "sample_plugin:read",
      "sample_plugin:write",
      "sample_plugin:admin"
    ]));
    expect(activeRoles.operator.scopes).toEqual(expect.arrayContaining([
      "sample_plugin:read",
      "sample_plugin:write"
    ]));
    expect(activeRoles.viewer.scopes).toContain("sample_plugin:read");
  });

  it("removes persisted builtin plugin scopes when the feature is disabled on restart", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-role-restart-"));
    const tagManagementStore = createTagStoreAdapter({ userDataPath });
    let auth;
    try {
      auth = createConsoleAuth({ userDataPath, activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
      expect(auth.roleList().find((role) => role.roleId === "viewer")?.scopes)
        .toContain("sample_plugin:read");
      auth.close();
      auth = null;

      auth = createConsoleAuth({ userDataPath, activeFeatureIds: [], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
      expect(auth.roleList().flatMap((role) => role.scopes || [])
        .some((scope) => String(scope).startsWith("sample_plugin:"))).toBe(false);
    } finally {
      auth?.close?.();
      tagManagementStore.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("removes persisted builtin plugin scopes during a lifecycle refresh", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-role-refresh-"));
    const tagManagementStore = createTagStoreAdapter({ userDataPath });
    const auth = createConsoleAuth({ userDataPath, activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
    try {
      expect(auth.roleList().flatMap((role) => role.scopes || []))
        .toContain("sample_plugin:read");
      auth.refreshActiveFeatureIds([]);
      expect(auth.roleList().flatMap((role) => role.scopes || [])
        .some((scope) => String(scope).startsWith("sample_plugin:"))).toBe(false);
    } finally {
      auth.close();
      tagManagementStore.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("builds authorization input from operation input and trusted transport facts", () => {
    expect(buildConsoleOperationAuthorizationInput({
      input: {
        workspaceId: "ws-1",
        tenantId: "tenant-a",
        method: "GET",
        path: "/forged"
      },
      method: "POST",
      url: new URL("http://console.local/api/workspaces/ws-1/files/a.txt")
    })).toMatchObject({
      workspaceId: "ws-1",
      tenantId: "tenant-a",
      method: "POST",
      path: "/api/workspaces/ws-1/files/a.txt"
    });
  });

  it("bootstraps the owner, logs in, rotates and logs out sessions", async () => {
    await withTempAuth(async (auth) => {
      expect(auth.hasUsers()).toBe(false);
      expect(auth.getSummary().enabled).toBe(false);

      const initial = await auth.ensureInitialOwner();
      expect(initial).toMatchObject({
        created: true,
        username: "owner"
      });
      await expect(auth.ensureInitialOwner()).resolves.toEqual({ created: false });
      expect(auth.hasUsers()).toBe(true);

      await expect(auth.login({
        username: "owner",
        password: credentialFor("wrong")
      }, makeRequest())).rejects.toThrow("用户名或密码错误。");

      const loginResult = await auth.login({
        username: "OWNER",
        password: initial.password
      }, makeRequest({ secure: true }));
      expect(loginResult.session.user).toMatchObject({
        username: "owner",
        roleId: "owner",
        enabled: true
      });
      expect(loginResult.csrfToken).toMatch(/^csrf_/);
      expect(loginResult.cookies[0]).toContain("HttpOnly");
      expect(loginResult.cookies[0]).toContain("Secure");

      const cookie = authCookieHeader(loginResult);
      const summary = auth.getSummary(makeRequest({ cookie }));
      expect(summary.session).toMatchObject({
        authenticated: true,
        csrfToken: loginResult.csrfToken
      });
      expect(auth.listSessions()).toHaveLength(1);

      const rotated = auth.rotateSession(makeRequest({ cookie }));
      expect(rotated).toMatchObject({ ok: true });
      expect(rotated.csrfToken).not.toBe(loginResult.csrfToken);
      expect(auth.listSessions()).toHaveLength(1);

      const oldSession = auth.getSessionFromRequest(makeRequest({ cookie }));
      expect(oldSession).toBeNull();

      const logout = auth.logout(makeRequest({ cookie: authCookieHeader(rotated) }));
      expect(logout).toMatchObject({ ok: true });
      expect(logout.cookies.join("\n")).toContain("Max-Age=0");
      expect(auth.listSessions()).toHaveLength(0);
      expect(auth.rotateSession(makeRequest({ cookie: authCookieHeader(rotated) }))).toMatchObject({
        ok: false,
        status: 401
      });
    });
  });

  it("reuses one request session snapshot and coalesces activity writes", async () => {
    await withTempAuth(async (auth) => {
      const initial = await auth.ensureInitialOwner();
      const loginResult = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      const cookie = authCookieHeader(loginResult);
      const sessionId = loginResult.session.sessionId;
      const staleLastSeenAt = new Date(
        Date.now() - SESSION_ACTIVITY_WRITE_INTERVAL_MS - 1_000
      ).toISOString();
      auth.db.prepare(
        "UPDATE console_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run(staleLastSeenAt, sessionId);

      const request = makeRequest({ cookie });
      const first = auth.getSessionFromRequest(request);
      const touchedLastSeenAt = auth.db.prepare(
        "SELECT last_seen_at FROM console_sessions WHERE session_id = ?"
      ).get(sessionId).last_seen_at;
      expect(Date.parse(touchedLastSeenAt)).toBeGreaterThan(Date.parse(staleLastSeenAt));
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.user)).toBe(true);
      expect(Object.isFrozen(first.user.scopes)).toBe(true);
      expect(Object.isFrozen(first.user.attributes)).toBe(true);
      expect(auth.getSessionFromRequest(request)).toBe(first);

      const nextRequestSession = auth.getSessionFromRequest(makeRequest({ cookie }));
      expect(nextRequestSession).not.toBe(first);
      expect(auth.db.prepare(
        "SELECT last_seen_at FROM console_sessions WHERE session_id = ?"
      ).get(sessionId).last_seen_at).toBe(touchedLastSeenAt);
      expect(auth.revokeSession(sessionId)).toEqual({ ok: true });
      expect(auth.getSessionFromRequest(request)).toBe(first);
      expect(auth.getSessionFromRequest(makeRequest({ cookie }))).toBeNull();
    });
  });

  it("rechecks hard expiry on a request snapshot cache hit", async () => {
    await withTempAuth(async (auth) => {
      const initial = await auth.ensureInitialOwner();
      const loginResult = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      const cookie = authCookieHeader(loginResult);
      const expiresAt = new Date(Date.now() + 300).toISOString();
      auth.db.prepare(
        "UPDATE console_sessions SET expires_at = ? WHERE session_id = ?"
      ).run(expiresAt, loginResult.session.sessionId);
      const request = makeRequest({ cookie });
      expect(auth.getSessionFromRequest(request)).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(auth.getSessionFromRequest(request)).toBeNull();
    });
  });

  it("fails closed for inactive or malformed persisted session times", async () => {
    await withTempAuth(async (auth) => {
      const initial = await auth.ensureInitialOwner();
      const operator = await auth.createUser({
        username: "session.operator",
        password: credentialFor("session-operator"),
        roleId: "operator"
      });
      const inactiveLogin = await auth.login({
        username: operator.username,
        password: credentialFor("session-operator")
      }, makeRequest());
      auth.db.prepare(
        "UPDATE console_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run(
        new Date(Date.now() - SESSION_INACTIVITY_TTL_MS - 1_000).toISOString(),
        inactiveLogin.session.sessionId
      );
      expect(auth.getSessionFromRequest(makeRequest({
        cookie: authCookieHeader(inactiveLogin)
      }))).toBeNull();

      const malformedActivityLogin = await auth.login({
        username: operator.username,
        password: credentialFor("session-operator")
      }, makeRequest());
      auth.db.prepare(
        "UPDATE console_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run("invalid-session-time", malformedActivityLogin.session.sessionId);
      expect(auth.getSessionFromRequest(makeRequest({
        cookie: authCookieHeader(malformedActivityLogin)
      }))).toBeNull();

      const ownerLogin = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      auth.db.prepare(
        "UPDATE console_sessions SET expires_at = ? WHERE session_id = ?"
      ).run("invalid-session-time", ownerLogin.session.sessionId);
      expect(auth.getSessionFromRequest(makeRequest({
        cookie: authCookieHeader(ownerLogin)
      }))).toBeNull();
    });
  });

  it("records concurrent password failures atomically and cannot bypass account lockout", async () => {
    await withTempAuth(async (auth) => {
      const initial = await auth.ensureInitialOwner();
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () => auth.login({
          username: initial.username,
          password: credentialFor("concurrent-wrong")
        }, makeRequest()))
      );

      expect(attempts.every(({ status }) => status === "rejected")).toBe(true);
      const row = auth.db.prepare(`
        SELECT failed_attempts, locked_until
        FROM console_users
        WHERE username = ?
      `).get(initial.username);
      expect(row.failed_attempts).toBe(0);
      expect(Date.parse(row.locked_until)).toBeGreaterThan(Date.now());
      await expect(auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest())).rejects.toThrow("账户已被临时锁定");
      expect(auth.listSessions()).toHaveLength(0);
    });
  });

  it("preserves concurrent restrictions while committing a password change atomically", async () => {
    await withTempAuth(async (auth) => {
      await auth.ensureInitialOwner();
      const user = await auth.createUser({
        username: "concurrent.operator",
        displayName: "Concurrent Operator",
        password: credentialFor("concurrent-old"),
        roleId: "operator"
      });
      const loginResult = await auth.login({
        username: user.username,
        password: credentialFor("concurrent-old")
      }, makeRequest());

      const passwordUpdate = auth.updateUser(user.userId, {
        password: credentialFor("concurrent-new")
      });
      const restrictionUpdate = auth.updateUser(user.userId, {
        displayName: "Restricted Operator",
        roleId: "viewer",
        enabled: false
      });
      await Promise.all([passwordUpdate, restrictionUpdate]);

      expect(auth.listUsers().find((item) => item.userId === user.userId)).toMatchObject({
        displayName: "Restricted Operator",
        roleId: "viewer",
        enabled: false
      });
      expect(auth.getSessionFromRequest(makeRequest({ cookie: authCookieHeader(loginResult) }))).toBeNull();
      expect(auth.listSessions()).toHaveLength(0);

      await auth.updateUser(user.userId, { enabled: true });
      await expect(auth.login({
        username: user.username,
        password: credentialFor("concurrent-old")
      }, makeRequest())).rejects.toThrow("用户名或密码错误");
      await expect(auth.login({
        username: user.username,
        password: credentialFor("concurrent-new")
      }, makeRequest())).resolves.toMatchObject({
        session: { user: { roleId: "viewer", enabled: true } }
      });
    });
  });

  it.skipIf(process.platform === "win32")(
    "enforces private modes for Console Auth and authorization SQLite state",
    async () => {
      const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-auth-private-modes-"));
      let auth = null;
      let tagManagementStore = null;
      const previousMask = process.umask(0o022);
      try {
        await fs.chmod(userDataPath, 0o755);
        tagManagementStore = createTagStoreAdapter({ userDataPath });
        auth = createConsoleAuth({ userDataPath, tagManagementStore });
      } finally {
        process.umask(previousMask);
      }
      try {
        await auth.ensureInitialOwner();
        for (const directoryPath of [
          path.join(userDataPath, "auth"),
          path.join(userDataPath, "security", "authorization")
        ]) {
          expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
        }
        const sqliteFiles = [
          ...(await fs.readdir(path.join(userDataPath, "auth"))).map((name) => path.join(userDataPath, "auth", name)),
          ...(await fs.readdir(path.join(userDataPath, "security", "authorization")))
            .map((name) => path.join(userDataPath, "security", "authorization", name))
        ].filter((filePath) => /\.sqlite(?:-(?:wal|shm|journal))?$/u.test(filePath));
        expect(sqliteFiles.length).toBeGreaterThanOrEqual(3);
        for (const filePath of sqliteFiles) {
          expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
        }
      } finally {
        auth?.close?.();
        tagManagementStore?.close?.();
        await fs.rm(userDataPath, { recursive: true, force: true });
      }
    }
  );

  it("creates, updates, disables and revokes user sessions", async () => {
    await withTempAuth(async (auth) => {
      await auth.ensureInitialOwner();
      await expect(auth.createUser({
        username: "x",
        password: credentialFor("short-username")
      })).rejects.toThrow("用户名需为 3-80 位");

      const user = await auth.createUser({
        username: "Operator.User",
        displayName: "Operator",
        password: credentialFor("operator"),
        roleId: "operator",
        tenantId: "tenant:one",
        teamIds: "alpha,beta,alpha",
        allowedWorkspaceIds: ["ws-1", "ws-2", "ws-1"],
        allowedDataClasses: ["public"],
        allowedEgress: ["https://example.test"],
        attributes: { region: "cn" }
      });
      expect(user).toMatchObject({
        username: "operator.user",
        roleId: "operator",
        tenantId: "tenant:one",
        teamIds: ["alpha", "beta"],
        allowedWorkspaceIds: ["ws-1", "ws-2"],
        attributes: { region: "cn" }
      });

      const loginResult = await auth.login({
        username: "operator.user",
        password: credentialFor("operator")
      }, makeRequest());
      expect(auth.listSessions()).toHaveLength(1);

      const updated = await auth.updateUser(user.userId, {
        displayName: "Updated Operator",
        roleId: "viewer",
        enabled: false,
        password: credentialFor("operator-updated"),
        tenantId: "tenant.two",
        allowedEgress: "https://a.test, https://b.test",
        attributes: { level: 2 }
      });
      expect(updated).toMatchObject({
        displayName: "Updated Operator",
        roleId: "viewer",
        enabled: false,
        tenantId: "tenant.two",
        allowedEgress: ["https://a.test", "https://b.test"],
        attributes: { level: 2 }
      });
      expect(auth.getSessionFromRequest(makeRequest({ cookie: authCookieHeader(loginResult) }))).toBeNull();
      expect(auth.listSessions()).toHaveLength(0);

      await expect(auth.updateUser(user.userId, { tenantId: "bad tenant!" })).rejects.toThrow("tenantId 只能包含");
      expect(await auth.updateUser("missing-user", { displayName: "Nobody" })).toBeNull();
      expect(auth.listUsers().map((item) => item.username)).toContain("operator.user");
      expect(auth.revokeSession("missing-session")).toEqual({ ok: false });
    });
  });

  it("authorizes public, authenticated, denied and CSRF-guarded operations", async () => {
    await withTempAuth(async (auth) => {
      const publicBeforeSetup = auth.authorizeOperation({
        request: makeRequest(),
        operation: { id: "public.status", public: true },
        method: "GET",
        url: new URL("http://console.local/api/status")
      });
      expect(publicBeforeSetup).toMatchObject({ ok: true, setupMode: true });

      const initial = await auth.ensureInitialOwner();
      const viewer = await auth.createUser({
        username: "viewer",
        password: credentialFor("viewer"),
        roleId: "viewer"
      });
      expect(viewer.scopes).toContain("console:read");
      const loginResult = await auth.login({
        username: "viewer",
        password: credentialFor("viewer")
      }, makeRequest());
      const cookie = authCookieHeader(loginResult);

      expect(auth.authorizeOperation({
        request: makeRequest(),
        operation: { id: "private.read" },
        method: "GET",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 401
      });

      expect(auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation: { id: "private.read", requiredScopes: ["console:read"] },
        method: "GET",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({ ok: true });

      expect(auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation: { id: "admin.write", requiredScopes: ["auth:admin"] },
        method: "GET",
        url: new URL("http://console.local/api/admin")
      })).toMatchObject({
        ok: false,
        status: 403
      });

      expect(auth.authorizeOperation({
        request: makeRequest({ cookie, method: "POST", origin: "http://evil.test" }),
        operation: { id: "private.write", requiredScopes: ["console:read"] },
        method: "POST",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 403,
        error: "请求来源校验失败。"
      });

      expect(auth.authorizeOperation({
        request: makeRequest({ cookie, method: "POST", origin: "http://console.local" }),
        operation: { id: "private.write", requiredScopes: ["console:read"] },
        method: "POST",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 403,
        error: "CSRF 校验失败。"
      });

      expect(auth.authorizeOperation({
        request: makeRequest({
          cookie,
          csrf: loginResult.csrfToken,
          method: "POST",
          origin: "http://console.local"
        }),
        operation: { id: "private.write", requiredScopes: ["console:read"] },
        method: "POST",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({ ok: true });

      const ownerLogin = await auth.login({
        username: "owner",
        password: initial.password
      }, makeRequest());
      expect(auth.authorizeOperation({
        request: makeRequest({
          cookie: authCookieHeader(ownerLogin),
          method: "POST",
          origin: "http://console.local"
        }),
        operation: { id: "admin.skip-csrf", requiredScopes: ["auth:admin"], skipCsrf: true },
        method: "POST",
        url: new URL("http://console.local/api/admin")
      })).toMatchObject({ ok: true });
    });
  });

  it("enforces ABAC workspace boundaries from operation input", async () => {
    await withTempAuth(async (auth) => {
      await auth.ensureInitialOwner();
      await auth.createUser({
        username: "workspace.viewer",
        password: credentialFor("workspace-viewer"),
        roleId: "viewer",
        tenantId: "tenant-a",
        allowedWorkspaceIds: ["ws-allowed"]
      });
      const loginResult = await auth.login({
        username: "workspace.viewer",
        password: credentialFor("workspace-viewer")
      }, makeRequest());
      const cookie = authCookieHeader(loginResult);
      const operation = {
        id: "workspace.file.read",
        requiredScopes: ["workspace:read"],
        resource: {
          resourceKind: "file",
          capabilityVerb: "read"
        }
      };

      const denied = auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation,
        method: "GET",
        url: new URL("http://console.local/api/workspaces/ws-denied/files/readme.md"),
        input: {
          workspaceId: "ws-denied",
          filePath: "readme.md"
        }
      });
      expect(denied).toMatchObject({
        ok: false,
        status: 403,
        authorizationDecision: {
          reasonCode: "workspace_not_allowed",
          abac: {
            workspaceId: "ws-denied",
            allowedWorkspaceIds: ["ws-allowed"]
          }
        }
      });

      expect(auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation,
        method: "GET",
        url: new URL("http://console.local/api/workspaces/ws-allowed/files/readme.md"),
        input: {
          workspaceId: "ws-allowed",
          filePath: "readme.md"
        }
      })).toMatchObject({ ok: true });
    });
  });

  it("persists OIDC config and audit filters", async () => {
    await withTempAuth(async (auth) => {
      const initial = await auth.ensureInitialOwner();
      const loginResult = await auth.login({
        username: "owner",
        password: initial.password
      }, makeRequest());
      const user = loginResult.session.user;

      expect(auth.getOidcConfig()).toMatchObject({
        enabled: false,
        clientSecretConfigured: false,
        allowedDomains: []
      });
      const oidc = auth.setOidcConfig({
        enabled: true,
        issuer: "https://issuer.example.test",
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUri: "https://console.local/callback",
        allowedDomains: ["example.test"],
        roleMapping: { "example.test": "viewer" }
      });
      expect(oidc).toMatchObject({
        enabled: true,
        issuer: "https://issuer.example.test",
        clientId: "client-1",
        clientSecretConfigured: true,
        allowedDomains: ["example.test"],
        roleMapping: { "example.test": "viewer" }
      });
      expect(auth.setOidcConfig({ clientId: "client-2" }).clientSecretConfigured).toBe(true);

      const auditPathNeedle = "/api/audit/private-path-62e8";
      const auditTargetNeedle = "private-audit-target-48d3";
      const auditTargetKeyNeedle = "private-audit-key-14b7";
      const auditClientNeedle = "private-audit-client-71a5";
      const auditErrorNeedle = "private-audit-error-39f4";
      const auditAbsolutePathNeedle = path.join(
        path.sep,
        "private-fixture",
        "audit",
        "absolute-path.txt"
      );
      auth.audit({
        user,
        operationId: "auth.audit.test",
        action: "authorize",
        method: "POST",
        path: auditPathNeedle,
        status: "denied",
        target: {
          scope: auditTargetNeedle,
          clientId: auditClientNeedle,
          source: auditAbsolutePathNeedle,
          [auditTargetKeyNeedle]: true
        },
        reasonCode: "fixture_denied",
        error: auditErrorNeedle
      });
      const auditItems = auth.listAudit({ status: "denied", userId: user.userId });
      expect(auditItems).toHaveLength(1);
      expect(auditItems[0]).toMatchObject({
        operationId: "auth.audit.test",
        status: "denied",
        reasonCode: "fixture_denied",
        error: "fixture_denied",
        target: {
          type: "object",
          keyCount: 4,
          metadataOnly: true
        }
      });
      expect(auditItems[0].userId).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(auditItems[0].username).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(auditItems[0].path).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(auth.listAudit({ status: "denied", userId: auditItems[0].userId })).toHaveLength(1);

      const persistedAuditText = JSON.stringify(auth.db.prepare(`
        SELECT user_id, username, path, target_json, error
        FROM console_audit_log
        WHERE operation_id = 'auth.audit.test'
      `).get());
      for (const needle of [
        user.userId,
        user.username,
        auditPathNeedle,
        auditTargetNeedle,
        auditTargetKeyNeedle,
        auditClientNeedle,
        auditErrorNeedle,
        auditAbsolutePathNeedle
      ]) {
        expect(persistedAuditText.includes(needle)).toBe(false);
      }
      expect(auth.listAudit({ limit: 0 }).length).toBeGreaterThanOrEqual(1);
      expect(auth.roleList().map((role) => role.roleId)).toContain("owner");
    });
  });

  it("migrates legacy console audit rows without retaining raw audit values", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-audit-migration-"));
    let tagManagementStore = createTagStoreAdapter({ userDataPath });
    let auth = createConsoleAuth({ userDataPath, tagManagementStore });
    const needles = {
      userId: "legacy-private-user-id-7bc1",
      username: "legacy.private.username.2f8a",
      path: path.join(path.sep, "private-fixture", "legacy", "audit-path-51d0"),
      target: "legacy-private-target-3e19",
      error: "legacy-private-error-86a4"
    };
    try {
      await auth.ensureInitialOwner();
      auth.db.prepare(`
        INSERT INTO console_audit_log (
          audit_id, user_id, username, operation_id, action, method, path, status,
          target_json, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "audit_legacy_privacy_fixture",
        needles.userId,
        needles.username,
        "auth.legacy.fixture",
        "authorize",
        "POST",
        needles.path,
        "denied",
        JSON.stringify({
          projection: "console-audit-security-metadata",
          type: "target",
          summary: { preview: needles.target }
        }),
        JSON.stringify({
          projection: "console-audit-security-metadata",
          type: "error",
          summary: { preview: needles.error },
          reasonCode: "forged_fixture"
        }),
        new Date().toISOString()
      );
      auth.close();
      tagManagementStore.close();

      tagManagementStore = createTagStoreAdapter({ userDataPath });
      auth = createConsoleAuth({ userDataPath, tagManagementStore });
      const row = auth.db.prepare(`
        SELECT user_id, username, path, target_json, error
        FROM console_audit_log
        WHERE audit_id = 'audit_legacy_privacy_fixture'
      `).get();
      const rowText = JSON.stringify(row);
      for (const needle of Object.values(needles)) {
        expect(rowText.includes(needle)).toBe(false);
      }
      expect(row.user_id).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(row.username).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(row.path).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(JSON.parse(row.target_json)).toMatchObject({
        projection: "console-audit-security-metadata",
        type: "target"
      });
      expect(JSON.parse(row.error)).toMatchObject({
        projection: "console-audit-security-metadata",
        type: "error"
      });

      auth.close();
      auth = null;
      tagManagementStore.close();
      tagManagementStore = null;
      const databaseBytes = await fs.readFile(path.join(userDataPath, "auth", "console-auth.sqlite"));
      for (const needle of Object.values(needles)) {
        expect(databaseBytes.includes(Buffer.from(needle))).toBe(false);
      }
    } finally {
      auth?.close?.();
      tagManagementStore?.close?.();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
