import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { MemoryLockManager } from "@meshrix/foundation/concurrency/lock-manager";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createOperationRouteIndex } from "../../../packages/server-runtime/src/routing/operation-route-index.ts";
import * as authSupport from "../../../packages/foundation/src/security/auth/console-auth-support.ts";
import { createSystemController } from "../../../packages/protocols/http/controllers/system-controller.ts";
import { dispatchRegisteredHttpOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-http.ts";
import { dispatchRpcOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-rpc.ts";
import { createCapturedResponse, parseCapturedResult } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { executeConsoleAuthOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/console-auth-executor.ts";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildConsoleOperationAuthorizationInput,
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_COOKIE,
  createConsoleRoleCatalog,
  createConsoleAuth
} from "../../../packages/foundation/src/security/auth/console-auth.ts";
import {
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  SESSION_INACTIVITY_TTL_MS
} from "../../../packages/foundation/src/security/auth/console-auth-support.ts";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import {
  parseInitialOwnerCredential,
  readPrivateOwnerCredentialFile
} from "../../../tools/server-scripts/console-auth.ts";

async function withTempAuth(callback?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-auth-"));
  const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
  const auth: any = createConsoleAuth({ userDataPath, tagManagementStore });
  try {
    return await callback(auth, userDataPath);
  } finally {
    await auth.close();
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
}: Record<string, any> = {}) : any {
  const headers: Record<string, any> = {
    host,
    "user-agent": userAgent
  };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-meshrix-csrf"] = csrf;
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

function cookieMap(setCookies: any = []) : any {
  return Object.fromEntries(setCookies.map((cookie?: any) : any => {
    const [name, value = ""] = String(cookie).split(";", 1)[0].split("=");
    return [decodeURIComponent(name), decodeURIComponent(value)];
  }));
}

function authCookieHeader(loginResult?: any) : any {
  const cookies: any = cookieMap(loginResult.cookies);
  return [
    `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(cookies[CONSOLE_SESSION_COOKIE])}`,
    `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(cookies[CONSOLE_CSRF_COOKIE])}`
  ].join("; ");
}

function credentialFor(label?: any) : any {
  return [label, "fixture", "credential"].join("-");
}

function collectObjectKeys(value: unknown, keys = new Set<string>()) : Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(child, keys);
    }
  }
  return keys;
}

const PLUGIN_FEATURE_SCOPE_GRANTS: Readonly<Record<string, any>> = Object.freeze({
  "sample-feature": Object.freeze({
    maintainer: ["sample_plugin:read", "sample_plugin:write"],
    viewer: ["sample_plugin:read"]
  })
});

describe("console auth boundary behavior", () : any => {
  it("admits a supplied initial owner credential without replacing it on resume", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const password: any = credentialFor("supplied-owner");
      const created: any = await auth.ensureInitialOwner({ username: "Owner", password });
      expect(created).toMatchObject({
        created: true,
        username: "owner"
      });
      expect(created).not.toHaveProperty("password");
      await expect(auth.login({ username: "owner", password }, makeRequest())).resolves.toMatchObject({
        session: { user: { username: "owner" } }
      });
      await expect(auth.ensureInitialOwner({ username: "owner", password: credentialFor("replacement") }))
        .resolves.toEqual({ created: false });
      await expect(auth.login({ username: "owner", password }, makeRequest())).resolves.toBeTruthy();
    });
  });

  it("blocks common passwords only when credentials are created or reset", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await expect(auth.ensureInitialOwner({ username: "owner", password: "Password123" }))
        .rejects.toThrow(/密码过于常见/u);
      await expect(auth.createUser({ username: "new-user", password: "Welcome1234" }))
        .rejects.toThrow(/密码过于常见/u);
      expect(auth.listUsers()).toHaveLength(0);

      const strongPassword = credentialFor("password-manager-owner");
      const initial: any = await auth.ensureInitialOwner({ username: "owner", password: strongPassword });
      await expect(auth.updateUser(initial.user.userId, { newPassword: "QwertyUiop" }))
        .rejects.toThrow(/密码过于常见/u);
      await expect(auth.login({ username: "owner", password: strongPassword }, makeRequest()))
        .resolves.toMatchObject({ session: { user: { username: "owner" } } });

      const legacyPassword = "Password123";
      const legacyCredential = await authSupport.hashPassword(legacyPassword);
      auth.db.prepare(`
        INSERT INTO console_users (
          user_id, username, password_hash, salt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-weak-password-fixture",
        "legacy-user",
        legacyCredential.passwordHash,
        legacyCredential.salt,
        new Date().toISOString(),
        new Date().toISOString()
      );
      await expect(auth.login({ username: "legacy-user", password: legacyPassword }, makeRequest()))
        .resolves.toMatchObject({ session: { user: { username: "legacy-user" } } });
    });
  });

  it("denies malformed supplied owner credentials before creating an account", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await expect(auth.ensureInitialOwner({ username: "maintainer", password: credentialFor("denied") }))
        .rejects.toThrow(/normalize to owner/u);
      expect(auth.listUsers()).toHaveLength(0);
      await expect(auth.ensureInitialOwner({ username: "owner", password: "short" })).rejects.toThrow(/10-256/u);
      expect(auth.listUsers()).toHaveLength(0);
    });
  });

  it("accepts only a bounded owner-only regular credential file", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-owner-input-"));
    const validPath: any = path.join(root, "owner.json");
    const linkPath: any = path.join(root, "owner-link.json");
    try {
      const value: any = { username: "owner", password: credentialFor("private-owner") };
      const bytes: any = Buffer.from(JSON.stringify(value));
      expect(parseInitialOwnerCredential(bytes)).toEqual(value);
      await fs.writeFile(validPath, bytes, { mode: 0o600 });
      expect(await readPrivateOwnerCredentialFile(validPath)).toEqual(value);
      await fs.symlink(validPath, linkPath);
      await expect(readPrivateOwnerCredentialFile(linkPath)).rejects.toThrow(/file_unsafe/u);
      await fs.chmod(validPath, 0o644);
      await expect(readPrivateOwnerCredentialFile(validPath)).rejects.toThrow(/file_unsafe/u);
      expect(() : any => parseInitialOwnerCredential(Buffer.from(JSON.stringify({ ...value, extra: true })))).toThrow(/credential_invalid/u);
      expect(() : any => parseInitialOwnerCredential(Buffer.from(JSON.stringify({ username: "owner", password: "short" })))).toThrow(/credential_invalid/u);
      expect(() : any => parseInitialOwnerCredential(Buffer.alloc(8193, 0x61))).toThrow(/credential_invalid/u);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects owner passwords in argv without disclosing them", async () : Promise<any> => {
    const secret: any = credentialFor("argv-owner-secret");
    const result: any = spawnSync(process.execPath, [
      "--conditions=source",
      path.resolve("tools/server-scripts/console-auth.ts"),
      "init-owner",
      "--password",
      secret
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("imports the initial owner only through bounded stdin and returns fixed status", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-owner-stdin-"));
    const secret: any = credentialFor("stdin-owner-secret");
    const input: any = Buffer.from(JSON.stringify({ username: "owner", password: secret }), "utf8");
    const args: any[] = [
      "--conditions=source",
      path.resolve("tools/server-scripts/console-auth.ts"),
      "init-owner",
      "--credential-stdin",
      "--data-dir",
      root
    ];
    try {
      const created: any = spawnSync(process.execPath, args, {
        encoding: "utf8",
        input,
        timeout: 30_000
      });
      expect(created.status).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({
        status: "created",
        reason: "initial_owner_created"
      });
      expect(`${created.stdout}${created.stderr}${args.join(" ")}`).not.toContain(secret);

      const resumed: any = spawnSync(process.execPath, args, {
        encoding: "utf8",
        input,
        timeout: 30_000
      });
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout)).toEqual({
        status: "already-initialized",
        reason: "owner_exists"
      });
      expect(`${resumed.stdout}${resumed.stderr}`).not.toContain(secret);
    } finally {
      input.fill(0);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("projects plugin-owned role scopes only for active features", () : any => {
    const inactiveRoles: any = createConsoleRoleCatalog({ activeFeatureIds: [] });
    for (const role of (Object.values(inactiveRoles) as any[])) {
      expect(role.scopes.some((scope?: any) : any => scope.startsWith("sample_plugin:"))).toBe(false);
    }

    const activeRoles: any = createConsoleRoleCatalog({ activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS });
    expect(activeRoles.maintainer.scopes).toEqual(expect.arrayContaining([
      "sample_plugin:read",
      "sample_plugin:write"
    ]));
    expect(activeRoles.viewer.scopes).toContain("sample_plugin:read");
  });

  it("removes persisted builtin plugin scopes when the feature is disabled on restart", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-role-restart-"));
    const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
    let auth: any;
    try {
      auth = createConsoleAuth({ userDataPath, activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
      expect(auth.roleList().find((role?: any) : any => role.roleId === "viewer")?.scopes)
        .toContain("sample_plugin:read");
      await auth.close();
      auth = null;

      auth = createConsoleAuth({ userDataPath, activeFeatureIds: [], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
      expect(auth.roleList().flatMap((role?: any) : any => role.scopes || [])
        .some((scope?: any) : any => String(scope).startsWith("sample_plugin:"))).toBe(false);
    } finally {
      await auth?.close?.();
      tagManagementStore.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("removes persisted builtin plugin scopes during a lifecycle refresh", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-role-refresh-"));
    const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
    const auth: any = createConsoleAuth({ userDataPath, activeFeatureIds: ["sample-feature"], featureScopeGrants: PLUGIN_FEATURE_SCOPE_GRANTS, tagManagementStore });
    try {
      expect(auth.roleList().flatMap((role?: any) : any => role.scopes || []))
        .toContain("sample_plugin:read");
      auth.refreshActiveFeatureIds([]);
      expect(auth.roleList().flatMap((role?: any) : any => role.scopes || [])
        .some((scope?: any) : any => String(scope).startsWith("sample_plugin:"))).toBe(false);
    } finally {
      await auth.close();
      tagManagementStore.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("builds authorization input from operation input and trusted transport facts", () : any => {
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

  it("bootstraps the owner, logs in, rotates and logs out sessions", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      expect(auth.hasUsers()).toBe(false);
      expect(auth.getSummary().enabled).toBe(false);

      const initial: any = await auth.ensureInitialOwner();
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

      const loginResult: any = await auth.login({
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

      const cookie: any = authCookieHeader(loginResult);
      const summary: any = auth.getSummary(makeRequest({ cookie }));
      expect(summary.session).toMatchObject({
        authenticated: true,
        csrfToken: loginResult.csrfToken
      });
      expect(auth.listSessions()).toHaveLength(1);

      const rotated: any = auth.rotateSession(makeRequest({ cookie }));
      expect(rotated).toMatchObject({ ok: true });
      expect(rotated.csrfToken).not.toBe(loginResult.csrfToken);
      expect(auth.listSessions()).toHaveLength(1);

      const oldSession: any = auth.getSessionFromRequest(makeRequest({ cookie }));
      expect(oldSession).toBeNull();

      const logout: any = auth.logout(makeRequest({ cookie: authCookieHeader(rotated) }));
      expect(logout).toMatchObject({ ok: true });
      expect(logout.cookies.join("\n")).toContain("Max-Age=0");
      expect(auth.listSessions()).toHaveLength(0);
      expect(auth.rotateSession(makeRequest({ cookie: authCookieHeader(rotated) }))).toMatchObject({
        ok: false,
        status: 401
      });
    });
  });

  it("omits oidc and role policy from an anonymous session summary", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const initial: any = await auth.ensureInitialOwner();
      auth.setOidcConfig({
        enabled: true,
        issuer: "https://issuer.example.invalid",
        clientId: "console-client",
        redirectUri: "https://console.example.invalid/oidc/callback",
        allowedDomains: ["example.invalid"],
        roleMapping: { group: "owner" }
      });

      const anonymous: any = auth.getSummary(makeRequest());
      expect(anonymous.session).toMatchObject({ authenticated: false, user: null });
      expect(anonymous).not.toHaveProperty("roles");
      expect(anonymous).not.toHaveProperty("oidc");
      const anonymousKeys: any = collectObjectKeys(anonymous);
      expect(anonymousKeys.has("oidc")).toBe(false);
      expect(anonymousKeys.has("scopes")).toBe(false);
      expect(anonymousKeys.has("resourcePolicies")).toBe(false);
      expect(JSON.stringify(anonymous)).not.toContain("issuer.example.invalid");
      expect(JSON.stringify(anonymous)).not.toContain("console-client");
      expect(auth.getOidcConfig()).toMatchObject({
        enabled: true,
        issuer: "https://issuer.example.invalid",
        clientId: "console-client"
      });

      const viewer: any = await auth.createUser({
        username: "session.viewer",
        password: credentialFor("session-viewer"),
        roleId: "viewer"
      });
      const viewerLogin: any = await auth.login({
        username: viewer.username,
        password: credentialFor("session-viewer")
      }, makeRequest());
      const viewerSummary: any = auth.getSummary(makeRequest({
        cookie: authCookieHeader(viewerLogin)
      }));
      expect(viewerSummary).not.toHaveProperty("oidc");
      expect(viewerSummary.roles).toHaveLength(3);
      expect(viewerSummary.roles).toEqual(expect.arrayContaining([
        { roleId: "owner", label: "Owner" },
        { roleId: "maintainer", label: "Maintainer" },
        { roleId: "viewer", label: "Viewer" }
      ]));
      for (const role of viewerSummary.roles) {
        expect(Object.keys(role).sort()).toEqual(["label", "roleId"]);
      }

      const ownerLogin: any = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      const ownerSummary: any = auth.getSummary(makeRequest({
        cookie: authCookieHeader(ownerLogin)
      }));
      expect(collectObjectKeys(ownerSummary).has("oidc")).toBe(false);
      expect(ownerSummary.roles.find((role?: any) : any => role.roleId === "owner")?.scopes)
        .toContain("auth:admin");
      expect(ownerSummary.roles.find((role?: any) : any => role.roleId === "viewer"))
        .toHaveProperty("resourcePolicies");
    });
  });

  it("reuses one request session snapshot and coalesces activity writes", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const initial: any = await auth.ensureInitialOwner();
      const loginResult: any = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      const cookie: any = authCookieHeader(loginResult);
      const sessionId: any = loginResult.session.sessionId;
      const staleLastSeenAt: any = new Date(
        Date.now() - SESSION_ACTIVITY_WRITE_INTERVAL_MS - 1_000
      ).toISOString();
      auth.db.prepare(
        "UPDATE console_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run(staleLastSeenAt, sessionId);

      const request: any = makeRequest({ cookie });
      const first: any = auth.getSessionFromRequest(request);
      const touchedLastSeenAt: any = auth.db.prepare(
        "SELECT last_seen_at FROM console_sessions WHERE session_id = ?"
      ).get(sessionId).last_seen_at;
      expect(Date.parse(touchedLastSeenAt)).toBeGreaterThan(Date.parse(staleLastSeenAt));
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.user)).toBe(true);
      expect(Object.isFrozen(first.user.scopes)).toBe(true);
      expect(Object.isFrozen(first.user.attributes)).toBe(true);
      expect(auth.getSessionFromRequest(request)).toBe(first);

      const nextRequestSession: any = auth.getSessionFromRequest(makeRequest({ cookie }));
      expect(nextRequestSession).not.toBe(first);
      expect(auth.db.prepare(
        "SELECT last_seen_at FROM console_sessions WHERE session_id = ?"
      ).get(sessionId).last_seen_at).toBe(touchedLastSeenAt);
      expect(auth.revokeSession(sessionId)).toEqual({ ok: true });
      expect(auth.getSessionFromRequest(request)).toBe(first);
      expect(auth.getSessionFromRequest(makeRequest({ cookie }))).toBeNull();
    });
  });

  it("rechecks hard expiry on a request snapshot cache hit", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const initial: any = await auth.ensureInitialOwner();
      const loginResult: any = await auth.login({
        username: initial.username,
        password: initial.password
      }, makeRequest());
      const cookie: any = authCookieHeader(loginResult);
      const expiresAt: any = new Date(Date.now() + 300).toISOString();
      auth.db.prepare(
        "UPDATE console_sessions SET expires_at = ? WHERE session_id = ?"
      ).run(expiresAt, loginResult.session.sessionId);
      const request: any = makeRequest({ cookie });
      expect(auth.getSessionFromRequest(request)).not.toBeNull();
      await new Promise((resolve?: any) : any => setTimeout(resolve, 350));
      expect(auth.getSessionFromRequest(request)).toBeNull();
    });
  });

  it("fails closed for inactive or malformed persisted session times", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const initial: any = await auth.ensureInitialOwner();
      const operator: any = await auth.createUser({
        username: "session.operator",
        password: credentialFor("session-operator"),
        roleId: "maintainer"
      });
      const inactiveLogin: any = await auth.login({
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

      const malformedActivityLogin: any = await auth.login({
        username: operator.username,
        password: credentialFor("session-operator")
      }, makeRequest());
      auth.db.prepare(
        "UPDATE console_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run("invalid-session-time", malformedActivityLogin.session.sessionId);
      expect(auth.getSessionFromRequest(makeRequest({
        cookie: authCookieHeader(malformedActivityLogin)
      }))).toBeNull();

      const ownerLogin: any = await auth.login({
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

  it("does not let ten concurrent guesses lock a known account or another user", async () => {
    await withTempAuth(async (auth: any) => {
      const initial = await auth.ensureInitialOwner();
      const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => auth.login({
        username: initial.username, password: credentialFor("concurrent-wrong")
      }, makeRequest({ remoteAddress: "10.0.0.21" }))));
      expect(attempts.every(({ status }) => status === "rejected")).toBe(true);
      const ok = await auth.login({ username: initial.username, password: initial.password }, makeRequest({ remoteAddress: "10.0.0.21" }));
      expect(ok.session?.user?.username).toBe(initial.username);
      expect(auth.listSessions()).toHaveLength(1);
    });
  });

  it("recovers after nine mistakes on the same source and ignores historical account locks", async () => {
    await withTempAuth(async (auth: any, userDataPath: string) => {
      const initial = await auth.ensureInitialOwner();
      const request = makeRequest({ remoteAddress: "10.0.0.31" });
      for (let index = 0; index < 9; index++) {
        await expect(auth.login({ username: initial.username, password: credentialFor("mistake") }, request)).rejects.toThrow("用户名或密码错误。");
      }
      auth.db.exec("ALTER TABLE console_users ADD COLUMN locked_until TEXT NOT NULL DEFAULT ''; ALTER TABLE console_users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0");
      auth.db.prepare("UPDATE console_users SET locked_until = ?, failed_attempts = 10 WHERE username = ?")
        .run("2099-01-01T00:00:00.000Z", initial.username);
      const ok = await auth.login({ username: initial.username, password: initial.password }, request);
      expect(ok.session?.user?.username).toBe(initial.username);
      await auth.close();
      const reopened = createConsoleAuth({ userDataPath, tagManagementStore: auth.tagManagementStore });
      try {
        const restored: any = await reopened.login({ username: initial.username, password: initial.password }, request);
        expect(restored.session.user.username).toBe(initial.username);
        expect(reopened.db.prepare("SELECT locked_until FROM console_users WHERE username = ?").get(initial.username).locked_until).toBe("2099-01-01T00:00:00.000Z");
      } finally { await reopened.close(); }
    });
  });

  it("unifies real HTTP/RPC login routes, denies before scrypt and restores cookies/retry", async () => {
    await withTempAuth(async (auth: any, userDataPath: string) => {
      const initial = await auth.ensureInitialOwner();
      const proof = createOperationProofSubstrate({ dataDir: path.join(userDataPath, "proof-fixture"), signerSecret: "synthetic-test-signer-material".repeat(3), evidencePolicy: "development" });
      const lockManager = new MemoryLockManager();
      const controllers = { system: createSystemController({ userDataPath, securityPermissions: auth,
        consoleDomainServices: { executeConsoleDomainOperation: executeConsoleAuthOperation, uploadSessionStore: { resolveUploadSessionFiles() {}, deleteUploadSession() {} } },
        settingsPort: { loadSettings: () => ({}), saveSettings: () => {}, normalizeSettings: (value: any) => value, getSettingsPath: () => "" },
        discoveryPort: { saveDiscoveryConfig: () => {} }, getListenUrl: () => "http://console.local", getDiscoveryState: () => ({})
      }) };
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const invoke = async (rpc: boolean, password: string, username = initial.username) => {
        const request: any = makeRequest({ remoteAddress: "10.0.0.51", method: "POST" });
        request.url = rpc ? "/api/rpc" : "/api/auth/login";
        const response = createCapturedResponse();
        const input = { username, password };
        const common = { operations: SERVER_API_OPERATIONS, routeIndex: createOperationRouteIndex(SERVER_API_OPERATIONS), controllers, request, response,
          authorizeOperation: (value: any) => auth.authorizeOperation(value), operationProofSubstrate: proof, lockManager, logger, concurrencyScope: "login-budget-production" };
        if (rpc) await dispatchRpcOperation({ ...common, requestBody: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "auth.login", params: input })) });
        else await dispatchRegisteredHttpOperation({ ...common, method: "POST", url: new URL("http://console.local/api/auth/login"), requestBody: Buffer.from(JSON.stringify(input)) });
        return { response, payload: parseCapturedResult({ captured: response, operation: {} }) };
      };
      const started = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(started);
      try {
        for (let index = 0; index < 40; index++) {
          const result = await invoke(Boolean(index % 2), credentialFor("budget-wrong"), index % 3 ? initial.username : "missing-user");
          expect(index % 2 ? result.payload.error?.code : result.response.statusCode, `transport index ${index}`).toBe(401);
        }
        const verify = vi.spyOn(authSupport, "verifyPassword");
        const rejected = await invoke(true, initial.password);
        expect(rejected.payload.error?.code).toBe(429);
        expect(rejected.response.getHeader("Retry-After")).toBe("60");
        expect(verify).not.toHaveBeenCalled();
        verify.mockRestore();
        vi.setSystemTime(started + 60_001);
        const recovered = await invoke(true, initial.password);
        expect(recovered.payload.error).toBeUndefined();
        expect(recovered.payload.result.session?.user?.username).toBe(initial.username);
        expect(recovered.response.getHeader("Set-Cookie")).toHaveLength(2);
      } finally { vi.useRealTimers(); await lockManager.destroy(); await proof.close(); }
    });
  });

  it("does not charge successful shared-NAT users against the guessing quota", async () => {
    await withTempAuth(async (auth: any) => {
      const initial = await auth.ensureInitialOwner();
      const peer = await auth.createUser({ username: "nat.peer", password: credentialFor("nat-peer"), roleId: "viewer" });
      const request = makeRequest({ remoteAddress: "10.0.0.61" });
      for (let index = 0; index < 45; index++) {
        const result = await auth.login(index % 2 ? { username: peer.username, password: credentialFor("nat-peer") } : { username: initial.username, password: initial.password }, request);
        expect(result.session?.user).toBeTruthy();
      }
      expect(auth.listSessions().length).toBeGreaterThan(40);
    });
  });

  it("preserves concurrent restrictions while committing a password change atomically", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await auth.ensureInitialOwner();
      const user: any = await auth.createUser({
        username: "concurrent.operator",
        displayName: "Concurrent Operator",
        password: credentialFor("concurrent-old"),
        roleId: "maintainer"
      });
      const loginResult: any = await auth.login({
        username: user.username,
        password: credentialFor("concurrent-old")
      }, makeRequest());

      const passwordUpdate: any = auth.updateUser(user.userId, {
        password: credentialFor("concurrent-new")
      });
      const restrictionUpdate: any = auth.updateUser(user.userId, {
        displayName: "Restricted Operator",
        roleId: "viewer",
        enabled: false
      });
      await Promise.all([passwordUpdate, restrictionUpdate]);

      expect(auth.listUsers().find((item?: any) : any => item.userId === user.userId)).toMatchObject({
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
    async () : Promise<any> => {
      const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-auth-private-modes-"));
      let auth: any = null;
      let tagManagementStore: any = null;
      const previousMask: any = process.umask(0o022);
      try {
        await fs.chmod(userDataPath, 0o755);
        tagManagementStore = createTagStoreAdapter({ userDataPath });
        auth = createConsoleAuth({ userDataPath, tagManagementStore });
      } finally {
        process.umask(previousMask);
      }
      try {
        await auth.ensureInitialOwner();
        await auth.authorizationStore.listDecisions({ limit: 1 });
        for (const directoryPath of [
          path.join(userDataPath, "auth"),
          path.join(userDataPath, "security", "authorization")
        ]) {
          expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
        }
        const sqliteFiles: any = [
          ...(await fs.readdir(path.join(userDataPath, "auth"))).map((name?: any) : any => path.join(userDataPath, "auth", name)),
          ...(await fs.readdir(path.join(userDataPath, "security", "authorization")))
            .map((name?: any) : any => path.join(userDataPath, "security", "authorization", name))
        ].filter((filePath?: any) : any => /\.sqlite(?:-(?:wal|shm|journal))?$/u.test(filePath));
        expect(sqliteFiles.length).toBeGreaterThanOrEqual(3);
        for (const filePath of sqliteFiles) {
          expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
        }
      } finally {
        await auth?.close?.();
        tagManagementStore?.close?.();
        await fs.rm(userDataPath, { recursive: true, force: true });
      }
    }
  );

  it("creates, updates, disables and revokes user sessions", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await auth.ensureInitialOwner();
      await expect(auth.createUser({
        username: "x",
        password: credentialFor("short-username")
      })).rejects.toThrow("用户名需为 3-80 位");

      const user: any = await auth.createUser({
        username: "Operator.User",
        displayName: "Operator",
        password: credentialFor("operator"),
        roleId: "maintainer",
        tenantId: "tenant:one",
        teamIds: "alpha,beta,alpha",
        allowedWorkspaceIds: ["ws-1", "ws-2", "ws-1"],
        allowedDataClasses: ["public"],
        allowedEgress: ["https://example.test"],
        attributes: { region: "cn" }
      });
      expect(user).toMatchObject({
        username: "operator.user",
        roleId: "maintainer",
        tenantId: "tenant:one",
        teamIds: ["alpha", "beta"],
        allowedWorkspaceIds: ["ws-1", "ws-2"],
        attributes: { region: "cn" }
      });

      const loginResult: any = await auth.login({
        username: "operator.user",
        password: credentialFor("operator")
      }, makeRequest());
      expect(auth.listSessions()).toHaveLength(1);

      const updated: any = await auth.updateUser(user.userId, {
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
      expect(auth.listUsers().map((item?: any) : any => item.username)).toContain("operator.user");
      expect(auth.revokeSession("missing-session")).toEqual({ ok: false });
    });
  });

  it("authorizes public, authenticated, denied and CSRF-guarded operations", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const publicBeforeSetup: any = await auth.authorizeOperation({
        request: makeRequest(),
        operation: { id: "public.status", public: true },
        method: "GET",
        url: new URL("http://console.local/api/status")
      });
      expect(publicBeforeSetup).toMatchObject({ ok: true, setupMode: true });

      const initial: any = await auth.ensureInitialOwner();
      const viewer: any = await auth.createUser({
        username: "viewer",
        password: credentialFor("viewer"),
        roleId: "viewer"
      });
      expect(viewer.scopes).toContain("console:read");
      const loginResult: any = await auth.login({
        username: "viewer",
        password: credentialFor("viewer")
      }, makeRequest());
      const cookie: any = authCookieHeader(loginResult);

      expect(await auth.authorizeOperation({
        request: makeRequest(),
        operation: { id: "private.read" },
        method: "GET",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 401
      });

      expect(await auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation: { id: "private.read", requiredScopes: ["console:read"] },
        method: "GET",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({ ok: true });

      expect(await auth.authorizeOperation({
        request: makeRequest({ cookie }),
        operation: { id: "admin.write", requiredScopes: ["auth:admin"] },
        method: "GET",
        url: new URL("http://console.local/api/admin")
      })).toMatchObject({
        ok: false,
        status: 403
      });

      expect(await auth.authorizeOperation({
        request: makeRequest({ cookie, method: "POST", origin: "http://evil.test" }),
        operation: { id: "private.write", requiredScopes: ["console:read"] },
        method: "POST",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 403,
        error: "请求来源校验失败。"
      });

      expect(await auth.authorizeOperation({
        request: makeRequest({ cookie, method: "POST", origin: "http://console.local" }),
        operation: { id: "private.write", requiredScopes: ["console:read"] },
        method: "POST",
        url: new URL("http://console.local/api/private")
      })).toMatchObject({
        ok: false,
        status: 403,
        error: "CSRF 校验失败。"
      });

      expect(await auth.authorizeOperation({
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

      const ownerLogin: any = await auth.login({
        username: "owner",
        password: initial.password
      }, makeRequest());
      expect(await auth.authorizeOperation({
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

  it("enforces ABAC workspace boundaries from operation input", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await auth.ensureInitialOwner();
      await auth.createUser({
        username: "workspace.viewer",
        password: credentialFor("workspace-viewer"),
        roleId: "viewer",
        tenantId: "tenant-a",
        allowedWorkspaceIds: ["ws-allowed"]
      });
      const loginResult: any = await auth.login({
        username: "workspace.viewer",
        password: credentialFor("workspace-viewer")
      }, makeRequest());
      const cookie: any = authCookieHeader(loginResult);
      const operation: Record<string, any> = {
        id: "workspace.file.read",
        requiredScopes: ["workspace:read"],
        resource: {
          resourceKind: "file",
          capabilityVerb: "read"
        }
      };

      const denied: any = await auth.authorizeOperation({
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

      expect(await auth.authorizeOperation({
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

  it("persists OIDC config and audit filters", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      const initial: any = await auth.ensureInitialOwner();
      const loginResult: any = await auth.login({
        username: "owner",
        password: initial.password
      }, makeRequest());
      const user: any = loginResult.session.user;

      expect(auth.getOidcConfig()).toMatchObject({
        enabled: false,
        clientSecretConfigured: false,
        allowedDomains: []
      });
      const oidc: any = auth.setOidcConfig({
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

      const auditPathNeedle: any = "/api/audit/private-path-62e8";
      const auditTargetNeedle: any = "private-audit-target-48d3";
      const auditTargetKeyNeedle: any = "private-audit-key-14b7";
      const auditClientNeedle: any = "private-audit-client-71a5";
      const auditErrorNeedle: any = "private-audit-error-39f4";
      const auditAbsolutePathNeedle: any = path.join(
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
      const auditItems: any = auth.listAudit({ status: "denied", userId: user.userId });
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

      const persistedAuditText: any = JSON.stringify(auth.db.prepare(`
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
      expect(auth.roleList().map((role?: any) : any => role.roleId)).toContain("owner");
    });
  });

  it("removes expired Console audit rows while retaining recent events", async () : Promise<any> => {
    await withTempAuth(async (auth?: any) : Promise<any> => {
      await auth.ensureInitialOwner({
        username: "owner",
        password: credentialFor("audit-retention-owner")
      });
      const expiredAuditId = "fixture-expired-console-audit";
      auth.db.prepare(`
        INSERT INTO console_audit_log (audit_id, created_at)
        VALUES (?, ?)
      `).run(expiredAuditId, new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString());

      auth.audit({
        operationId: "console.audit.retention.fixture",
        action: "read",
        status: "ok"
      });

      expect(auth.db.prepare(`
        SELECT audit_id FROM console_audit_log WHERE audit_id = ?
      `).get(expiredAuditId)).toBeUndefined();
      expect(auth.listAudit().some((item?: any) : any => item.operationId === "console.audit.retention.fixture"))
        .toBe(true);
    });
  });

});
