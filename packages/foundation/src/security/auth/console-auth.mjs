import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  irreversibleSecurityDigest,
  summarizeSecurityValue
} from "../../observability/runtime-logger.mjs";
import { LICO_ROOT_ORGANIZATION_ID } from "../authorization/organization-model.mjs";
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_COOKIE,
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_ATTEMPTS,
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  SESSION_INACTIVITY_TTL_MS,
  SESSION_TTL_MS,
  buildConsoleOperationAuthorizationContext,
  buildConsoleOperationAuthorizationInput,
  cookieHeader,
  createConsoleRoleCatalog,
  hashPassword,
  hashToken,
  normalizePassword,
  normalizeTenantId,
  normalizeUsername,
  nowIso,
  parseCookies,
  parseJson,
  publicUser,
  randomToken,
  safeRequestMethod,
  sameOriginRequest,
  stableId,
  stringifyJson,
  stringsFrom,
  timingSafeStringEqual,
  verifyPassword
} from "./console-auth-support.mjs";
import { createConsoleAuthResources } from "./console-auth-resources.mjs";

const CONSOLE_AUDIT_SECURITY_PROJECTION = "console-audit-security-metadata";
const SECURITY_DIGEST_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/i;
const REASON_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SECURITY_METADATA_KEYS = new Set([
  "byteLength",
  "hashAlgorithm",
  "keyCount",
  "length",
  "metadataOnly",
  "reason",
  "redacted",
  "sha256",
  "type"
]);
const SECURITY_METADATA_TYPES = new Set([
  "array",
  "boolean",
  "buffer",
  "empty",
  "error",
  "identity",
  "number",
  "object",
  "path",
  "stack",
  "string"
]);
const SECURITY_METADATA_REASONS = new Set([
  "absolute-path",
  "error-text",
  "identity",
  "metadata-only",
  "metadata-only-key",
  "sensitive-key"
]);

function freezeSessionSnapshot(value) {
  const pending = [value];
  const visited = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    for (const nested of Object.values(current)) {
      if (nested && typeof nested === "object") pending.push(nested);
    }
    Object.freeze(current);
  }
  return value;
}

export {
  CONSOLE_SESSION_COOKIE,
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SCOPES,
  CONSOLE_ROLES,
  CONSOLE_FEATURE_SCOPE_GRANTS,
  createConsoleRoleCatalog,
  buildConsoleOperationAuthorizationInput,
  buildConsoleOperationAuthorizationContext
} from "./console-auth-support.mjs";

export function createConsoleAuth({ userDataPath, activeFeatureIds = [], featureScopeGrants = {}, tagManagementStore = null }) {
  let consoleRoles = createConsoleRoleCatalog({ activeFeatureIds, featureScopeGrants });
  const resources = createConsoleAuthResources({ userDataPath, consoleRoles, tagManagementStore });
  const {
    rootPath,
    db,
    authorizationStore,
    authorizationGovernanceStore,
    authorizationEngine,
    csrfSecret: _csrfSecret,
    getUserByUsernameStmt,
    getUserByIdStmt,
    listUsersStmt,
    countUsersStmt,
    getSessionByTokenHashStmt,
    deleteSessionByIdStmt,
    deleteSessionByStateStmt,
    touchSessionActivityStmt
  } = resources;
  const requestSessionCache = new WeakMap();

  const recordFailedLoginStmt = db.prepare(`
    UPDATE console_users
    SET failed_attempts = CASE
          WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN 0
          ELSE COALESCE(failed_attempts, 0) + 1
        END,
        locked_until = CASE
          WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN ?
          ELSE ''
        END,
        updated_at = ?
    WHERE user_id = ?
      AND enabled = 1
      AND password_hash = ?
      AND salt = ?
      AND (COALESCE(locked_until, '') = '' OR locked_until <= ?)
  `);
  const completeSuccessfulLoginStmt = db.prepare(`
    UPDATE console_users
    SET last_login_at = ?, updated_at = ?, failed_attempts = 0, locked_until = ''
    WHERE user_id = ?
      AND enabled = 1
      AND password_hash = ?
      AND salt = ?
      AND (COALESCE(locked_until, '') = '' OR locked_until <= ?)
  `);
  const insertConsoleSessionStmt = db.prepare(`
    INSERT INTO console_sessions (
      session_id, user_id, token_hash, user_agent_hash, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const commitSuccessfulLogin = db.transaction(({
    userRow,
    sessionId,
    tokenHash,
    userAgentHash,
    createdAt,
    expiresAt
  }) => {
    const updated = completeSuccessfulLoginStmt.run(
      createdAt,
      createdAt,
      userRow.user_id,
      userRow.password_hash,
      userRow.salt,
      createdAt
    );
    if (updated.changes !== 1) return false;
    insertConsoleSessionStmt.run(
      sessionId,
      userRow.user_id,
      tokenHash,
      userAgentHash,
      createdAt,
      createdAt,
      expiresAt
    );
    return true;
  });

  function auditIdentityRef(value, kind = "identity") {
    const text = String(value || "").trim();
    if (!text || SECURITY_DIGEST_PATTERN.test(text)) {
      return text;
    }
    return irreversibleSecurityDigest(text, {
      projectionKey: _csrfSecret,
      namespace: `console-audit:${kind}`
    });
  }

  function safeAuditReasonCode(value, fallback = "") {
    const text = String(value || "").trim();
    return REASON_CODE_PATTERN.test(text) ? text : fallback;
  }

  function securityAuditProjection(value, type = "target") {
    return {
      projection: CONSOLE_AUDIT_SECURITY_PROJECTION,
      type,
      summary: summarizeSecurityValue(value, {
        key: type === "target" ? "payload" : type,
        projectionKey: _csrfSecret
      })
    };
  }

  function securityAuditErrorProjection(error, reasonCode = "") {
    const inferredReasonCode =
      safeAuditReasonCode(reasonCode) ||
      (String(error || "") ? "console_audit_error" : "");
    return {
      ...securityAuditProjection(String(error || ""), "error"),
      reasonCode: inferredReasonCode
    };
  }

  function parseSecurityAuditProjection(value, type = "target") {
    const parsed = parseJson(value, null);
    const summary = parsed?.summary;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.projection === CONSOLE_AUDIT_SECURITY_PROJECTION &&
      parsed.type === type &&
      summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      Object.keys(parsed).every((key) =>
        (type === "error"
          ? ["projection", "reasonCode", "summary", "type"]
          : ["projection", "summary", "type"]
        ).includes(key)
      ) &&
      summary.metadataOnly === true &&
      Object.keys(summary).every((key) => SECURITY_METADATA_KEYS.has(key)) &&
      SECURITY_METADATA_TYPES.has(summary.type) &&
      /^[a-f0-9]{16}$/i.test(summary.sha256 || "") &&
      summary.hashAlgorithm === "hmac-sha256" &&
      (!summary.reason || SECURITY_METADATA_REASONS.has(summary.reason)) &&
      ["byteLength", "keyCount", "length"].every((key) =>
        summary[key] === undefined || (Number.isInteger(summary[key]) && summary[key] >= 0)
      ) &&
      (summary.redacted === undefined || typeof summary.redacted === "boolean") &&
      (type !== "error" || !parsed.reasonCode || safeAuditReasonCode(parsed.reasonCode) === parsed.reasonCode)
    ) {
      return parsed;
    }
    return null;
  }

  function computeCsrfToken(rawSessionToken) {
    return "csrf_" + crypto
      .createHmac("sha256", _csrfSecret)
      .update(String(rawSessionToken || ""))
      .digest("base64url");
  }

  function hasUsers() {
    return Number(countUsersStmt.get()?.count || 0) > 0;
  }

  function resolveRole(roleId = "viewer") {
    return authorizationGovernanceStore.getRole(roleId) ||
      consoleRoles[roleId] ||
      authorizationGovernanceStore.getRole("viewer") ||
      consoleRoles.viewer;
  }

  function normalizeConsoleRole(value) {
    const roleId = String(value || "viewer").trim();
    const role = resolveRole(roleId);
    if (!role || role.roleId !== roleId || role.enabled === false) {
      throw new Error(`未知角色：${roleId}`);
    }
    return roleId;
  }

  function publicUserWithGovernanceRole(row) {
    const user = publicUser(row, consoleRoles);
    if (!user) {
      return null;
    }
    const role = resolveRole(user.roleId);
    return {
      ...user,
      roleLabel: role.label,
      scopes: role.scopes || []
    };
  }

  async function ensureInitialOwner() {
    if (hasUsers()) {
      return { created: false };
    }

    const username = "owner";
    const password = randomToken("sap_");
    const user = await createUser({
      username,
      displayName: "Owner",
      password,
      roleId: "owner",
      orgId: LICO_ROOT_ORGANIZATION_ID,
      enabled: true
    });
    return {
      created: true,
      user,
      username,
      password
    };
  }

  function getBootstrapStatus() {
    return {
      required: false,
      tokenPrefix: "",
      tokenFilePath: ""
    };
  }

  function roleList() {
    return authorizationGovernanceStore.listRoles();
  }

  function refreshActiveFeatureIds(nextActiveFeatureIds = []) {
    const nextRoles = createConsoleRoleCatalog({ activeFeatureIds: nextActiveFeatureIds, featureScopeGrants });
    for (const role of Object.values(nextRoles)) {
      const existing = authorizationGovernanceStore.getRole(role.roleId);
      if (existing?.system === false) continue;
      authorizationGovernanceStore.upsertRole({
        ...role,
        system: true,
        enabled: existing?.enabled !== false
      }, { seed: true });
    }
    consoleRoles = nextRoles;
    requestSessionCache.clear?.();
    return Object.freeze({ ok: true, roles: Object.freeze(roleList()) });
  }

  function sessionFromToken(token, request = null, allowInactivityRetry = true) {
    if (!token) {
      return null;
    }
    const tokenHash = hashToken(token);
    const row = getSessionByTokenHashStmt.get(tokenHash);
    if (!row || !row.enabled) {
      return null;
    }
    const currentTimeMs = Date.now();
    const expiresAtMs = Date.parse(row.expires_at);
    const lastSeenMs = Date.parse(row.last_seen_at);
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(lastSeenMs)) {
      deleteSessionByStateStmt.run(
        row.session_id,
        tokenHash,
        row.expires_at,
        row.last_seen_at
      );
      return null;
    }
    if (expiresAtMs <= currentTimeMs) {
      deleteSessionByStateStmt.run(
        row.session_id,
        tokenHash,
        row.expires_at,
        row.last_seen_at
      );
      return null;
    }
    // L-2: inactivity timeout for non-owner sessions
    if (
      row.role_id !== "owner" &&
      currentTimeMs - lastSeenMs > SESSION_INACTIVITY_TTL_MS
    ) {
      const deleted = deleteSessionByStateStmt.run(
        row.session_id,
        tokenHash,
        row.expires_at,
        row.last_seen_at
      );
      if (Number(deleted.changes || 0) === 0 && allowInactivityRetry) {
        return sessionFromToken(token, request, false);
      }
      return null;
    }
    const role = resolveRole(row.role_id);
    if (currentTimeMs - lastSeenMs >= SESSION_ACTIVITY_WRITE_INTERVAL_MS) {
      touchSessionActivityStmt.run(
        new Date(currentTimeMs).toISOString(),
        row.session_id,
        tokenHash,
        row.last_seen_at
      );
    }
    // L-1: soft-validate user-agent binding (audit suspicious mismatches, do not hard-reject
    // to avoid breaking legitimate users whose UA changes between requests)
    if (request && row.user_agent_hash) {
      const incomingUaHash = hashToken(request?.headers?.["user-agent"] || "");
      if (incomingUaHash !== row.user_agent_hash) {
        audit({
          user: {
            userId: row.user_id,
            username: row.username
          },
          operationId: "auth.session",
          action: "user-agent-mismatch",
          method: String(request?.method || "GET"),
          path: String(request?.url || ""),
          status: "warning",
          reasonCode: "user_agent_mismatch",
          error: "user-agent mismatch",
          target: {
            userAgentHashMismatch: true,
            storedUserAgentHash: row.user_agent_hash,
            incomingUserAgentHash: incomingUaHash
          }
        });
      }
    }
    // M-3: CSRF token is derived via HMAC from the raw session token — never stored
    // in the DB, so DB read-access cannot expose valid CSRF tokens.
    const csrfToken = computeCsrfToken(token);
    return freezeSessionSnapshot({
      sessionId: row.session_id,
      csrfToken,
      expiresAt: row.expires_at,
      user: {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name || row.username,
        roleId: row.role_id,
        roleLabel: role.label,
        scopes: [...role.scopes],
        tenantId: row.tenant_id || "default",
        orgId: row.org_id || LICO_ROOT_ORGANIZATION_ID,
        teamIds: parseJson(row.team_ids_json, []),
        departmentIds: parseJson(row.department_ids_json, []),
        allowedWorkspaceIds: parseJson(row.allowed_workspace_ids_json, []),
        allowedDataClasses: parseJson(row.allowed_data_classes_json, []),
        allowedEgress: parseJson(row.allowed_egress_json, []),
        attributes: parseJson(row.attributes_json, {}),
        enabled: Boolean(row.enabled),
        createdAt: row.user_created_at,
        updatedAt: row.user_updated_at,
        lastLoginAt: row.last_login_at || ""
      }
    });
  }

  function getSessionFromRequest(request) {
    const cacheableRequest = request !== null &&
      (typeof request === "object" || typeof request === "function");
    if (cacheableRequest && requestSessionCache.has(request)) {
      const cachedSession = requestSessionCache.get(request);
      if (!cachedSession) return null;
      const expiresAtMs = Date.parse(cachedSession.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        requestSessionCache.set(request, null);
        return null;
      }
      return cachedSession;
    }
    const cookies = parseCookies(request);
    const cookieToken = cookies[CONSOLE_SESSION_COOKIE] || "";
    const session = sessionFromToken(cookieToken, request);
    if (cacheableRequest) requestSessionCache.set(request, session);
    return session;
  }

  async function createUser(input = {}) {
    const username = normalizeUsername(input.username);
    const normalizedCredential = normalizePassword(input.password || input.newPassword);
    const roleId = normalizeConsoleRole(input.roleId || "viewer");
    const userId = stableId("console_user", username, Date.now(), crypto.randomUUID());
    const { salt, passwordHash } = await hashPassword(normalizedCredential);
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO console_users (
        user_id, username, display_name, role_id, password_hash, salt, enabled,
        tenant_id, org_id, team_ids_json, department_ids_json, allowed_workspace_ids_json,
        allowed_data_classes_json, allowed_egress_json, attributes_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      username,
      String(input.displayName || username).trim(),
      roleId,
      passwordHash,
      salt,
      input.enabled === false ? 0 : 1,
      normalizeTenantId(input.tenantId),
      String(input.orgId || LICO_ROOT_ORGANIZATION_ID).trim(),
      stringifyJson(stringsFrom(input.teamIds)),
      stringifyJson(stringsFrom(input.departmentIds)),
      stringifyJson(stringsFrom(input.allowedWorkspaceIds)),
      stringifyJson(stringsFrom(input.allowedDataClasses)),
      stringifyJson(stringsFrom(input.allowedEgress)),
      stringifyJson(input.attributes && typeof input.attributes === "object" ? input.attributes : {}),
      createdAt,
      createdAt
    );
    return publicUserWithGovernanceRole(getUserByIdStmt.get(userId));
  }

  async function login(input = {}, request) {
    const username = normalizeUsername(input.username);
    const password = String(input.password || "");
    const userRow = getUserByUsernameStmt.get(username);
    if (!userRow || !userRow.enabled) {
      // Constant-time guard: don't reveal whether username exists.
      await verifyPassword("__sentinel__", "salt", "hash").catch(() => {});
      throw new Error("用户名或密码错误。");
    }

    // Check lockout before touching the password.
    const lockedUntil = userRow.locked_until ? new Date(userRow.locked_until).getTime() : 0;
    if (lockedUntil > Date.now()) {
      const remainingMin = Math.ceil((lockedUntil - Date.now()) / 60_000);
      throw new Error(`账户已被临时锁定，请 ${remainingMin} 分钟后重试。`);
    }

    const ok = await verifyPassword(password, userRow.salt, userRow.password_hash);
    if (!ok) {
      const failedAt = nowIso();
      recordFailedLoginStmt.run(
        LOGIN_MAX_ATTEMPTS,
        LOGIN_MAX_ATTEMPTS,
        new Date(Date.now() + LOGIN_LOCKOUT_MS).toISOString(),
        failedAt,
        userRow.user_id,
        userRow.password_hash,
        userRow.salt,
        failedAt
      );
      throw new Error("用户名或密码错误。");
    }

    const token = randomToken();
    // M-3: CSRF is HMAC-derived from the session token — not stored in DB
    const csrfToken = computeCsrfToken(token);
    const sessionId = stableId("console_session", userRow.user_id, Date.now(), crypto.randomUUID());
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const committed = commitSuccessfulLogin({
      userRow,
      sessionId,
      tokenHash: hashToken(token),
      userAgentHash: hashToken(request?.headers?.["user-agent"] || ""),
      createdAt,
      expiresAt
    });
    if (!committed) {
      throw new Error("用户名或密码错误。");
    }

    // H-1: delete the initial-credentials file now that the owner has logged in
    fsp.unlink(path.join(rootPath, "initial-credentials.txt")).catch(() => {});

    const session = sessionFromToken(token);
    return {
      session,
      csrfToken,
      cookies: [
        cookieHeader(CONSOLE_SESSION_COOKIE, token, request, {
          httpOnly: true,
          maxAge: Math.floor(SESSION_TTL_MS / 1000)
        }),
        cookieHeader(CONSOLE_CSRF_COOKIE, csrfToken, request, {
          httpOnly: false,
          maxAge: Math.floor(SESSION_TTL_MS / 1000)
        })
      ]
    };
  }

  function logout(request) {
    const cookies = parseCookies(request);
    const token = cookies[CONSOLE_SESSION_COOKIE] || "";
    if (token) {
      db.prepare("DELETE FROM console_sessions WHERE token_hash = ?").run(hashToken(token));
    }
    return {
      ok: true,
      cookies: [
        cookieHeader(CONSOLE_SESSION_COOKIE, "", request, { httpOnly: true, maxAge: 0 }),
        cookieHeader(CONSOLE_CSRF_COOKIE, "", request, { httpOnly: false, maxAge: 0 })
      ]
    };
  }

  function rotateSession(request) {
    const cookies = parseCookies(request);
    const currentToken = cookies[CONSOLE_SESSION_COOKIE] || "";
    const currentSession = sessionFromToken(currentToken, request);
    if (!currentSession) {
      return { ok: false, status: 401, error: "控制台未登录。" };
    }
    const token = randomToken();
    const csrfToken = computeCsrfToken(token);
    const rotatedAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare(`
      UPDATE console_sessions
      SET token_hash = ?, last_seen_at = ?, expires_at = ?
      WHERE session_id = ?
    `).run(
      hashToken(token),
      rotatedAt,
      expiresAt,
      currentSession.sessionId
    );
    const session = sessionFromToken(token, request);
    return {
      ok: true,
      session,
      csrfToken,
      rotatedAt,
      cookies: [
        cookieHeader(CONSOLE_SESSION_COOKIE, token, request, {
          httpOnly: true,
          maxAge: Math.floor(SESSION_TTL_MS / 1000)
        }),
        cookieHeader(CONSOLE_CSRF_COOKIE, csrfToken, request, {
          httpOnly: false,
          maxAge: Math.floor(SESSION_TTL_MS / 1000)
        })
      ]
    };
  }

  async function updateUser(userId, patch = {}) {
    const normalizedUserId = String(userId || "");
    if (!getUserByIdStmt.get(normalizedUserId)) return null;

    const normalizedPatch = {
      displayName: patch.displayName !== undefined ? String(patch.displayName || "").trim() : undefined,
      roleId: patch.roleId !== undefined ? normalizeConsoleRole(patch.roleId) : undefined,
      enabled: patch.enabled !== undefined ? (patch.enabled === false ? 0 : 1) : undefined,
      tenantId: patch.tenantId !== undefined ? normalizeTenantId(patch.tenantId) : undefined,
      orgId: patch.orgId !== undefined
        ? String(patch.orgId || LICO_ROOT_ORGANIZATION_ID).trim()
        : undefined,
      teamIds: patch.teamIds !== undefined ? stringsFrom(patch.teamIds) : undefined,
      departmentIds: patch.departmentIds !== undefined ? stringsFrom(patch.departmentIds) : undefined,
      allowedWorkspaceIds: patch.allowedWorkspaceIds !== undefined
        ? stringsFrom(patch.allowedWorkspaceIds)
        : undefined,
      allowedDataClasses: patch.allowedDataClasses !== undefined
        ? stringsFrom(patch.allowedDataClasses)
        : undefined,
      allowedEgress: patch.allowedEgress !== undefined ? stringsFrom(patch.allowedEgress) : undefined,
      attributes: patch.attributes && typeof patch.attributes === "object" && !Array.isArray(patch.attributes)
        ? patch.attributes
        : undefined
    };
    const credential = patch.password || patch.newPassword
      ? await hashPassword(normalizePassword(patch.password || patch.newPassword))
      : null;

    const commitUpdate = db.transaction(() => {
      const current = getUserByIdStmt.get(normalizedUserId);
      if (!current) return null;
      const updates = {
        displayName: normalizedPatch.displayName !== undefined
          ? (normalizedPatch.displayName || current.username)
          : current.display_name,
        roleId: normalizedPatch.roleId ?? current.role_id,
        enabled: normalizedPatch.enabled ?? current.enabled,
        tenantId: normalizedPatch.tenantId ?? current.tenant_id,
        orgId: normalizedPatch.orgId ?? current.org_id,
        teamIds: normalizedPatch.teamIds ?? parseJson(current.team_ids_json, []),
        departmentIds: normalizedPatch.departmentIds ?? parseJson(current.department_ids_json, []),
        allowedWorkspaceIds: normalizedPatch.allowedWorkspaceIds ?? parseJson(current.allowed_workspace_ids_json, []),
        allowedDataClasses: normalizedPatch.allowedDataClasses ?? parseJson(current.allowed_data_classes_json, []),
        allowedEgress: normalizedPatch.allowedEgress ?? parseJson(current.allowed_egress_json, []),
        attributes: normalizedPatch.attributes ?? parseJson(current.attributes_json, {}),
        passwordHash: credential?.passwordHash || current.password_hash,
        salt: credential?.salt || current.salt
      };
      db.prepare(`
        UPDATE console_users
        SET display_name = ?, role_id = ?, enabled = ?, password_hash = ?, salt = ?,
            tenant_id = ?, org_id = ?, team_ids_json = ?, department_ids_json = ?, allowed_workspace_ids_json = ?,
            allowed_data_classes_json = ?, allowed_egress_json = ?, attributes_json = ?, updated_at = ?
        WHERE user_id = ?
      `).run(
        updates.displayName,
        updates.roleId,
        updates.enabled,
        updates.passwordHash,
        updates.salt,
        updates.tenantId,
        updates.orgId,
        stringifyJson(updates.teamIds, []),
        stringifyJson(updates.departmentIds, []),
        stringifyJson(updates.allowedWorkspaceIds, []),
        stringifyJson(updates.allowedDataClasses, []),
        stringifyJson(updates.allowedEgress, []),
        stringifyJson(updates.attributes, {}),
        nowIso(),
        current.user_id
      );
      if (credential) {
        db.prepare("DELETE FROM console_sessions WHERE user_id = ?").run(current.user_id);
      }
      return getUserByIdStmt.get(current.user_id);
    });
    const updatedRow = typeof commitUpdate.immediate === "function"
      ? commitUpdate.immediate()
      : commitUpdate();
    return publicUserWithGovernanceRole(updatedRow);
  }

  function listUsers() {
    return listUsersStmt.all().map(publicUserWithGovernanceRole);
  }

  function listSessions() {
    return db.prepare(`
      SELECT s.session_id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, u.username, u.role_id
      FROM console_sessions s
      JOIN console_users u ON u.user_id = s.user_id
      ORDER BY s.last_seen_at DESC
      LIMIT 200
    `).all().map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      username: row.username,
      roleId: row.role_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at
    }));
  }

  function revokeSession(sessionId) {
    const result = deleteSessionByIdStmt.run(String(sessionId || ""));
    return { ok: Number(result.changes || 0) > 0 };
  }

  function getOidcConfig() {
    const row = db.prepare("SELECT * FROM console_oidc_config WHERE config_id = 'default'").get();
    return {
      enabled: Boolean(row?.enabled),
      issuer: row?.issuer || "",
      clientId: row?.client_id || "",
      clientSecretConfigured: Boolean(row?.client_secret_configured),
      redirectUri: row?.redirect_uri || "",
      allowedDomains: parseJson(row?.allowed_domains_json, []),
      roleMapping: parseJson(row?.role_mapping_json, {}),
      updatedAt: row?.updated_at || ""
    };
  }

  function setOidcConfig(input = {}) {
    const current = getOidcConfig();
    const clientSecret = String(input.clientSecret || "").trim();
    const next = {
      enabled: input.enabled === true,
      issuer: String(input.issuer || "").trim(),
      clientId: String(input.clientId || "").trim(),
      clientSecretConfigured: clientSecret ? true : current.clientSecretConfigured,
      clientSecretHash: clientSecret ? hashToken(clientSecret) : "",
      redirectUri: String(input.redirectUri || "").trim(),
      allowedDomains: Array.isArray(input.allowedDomains) ? input.allowedDomains.map(String) : [],
      roleMapping: input.roleMapping && typeof input.roleMapping === "object" ? input.roleMapping : {}
    };
    db.prepare(`
      INSERT INTO console_oidc_config (
        config_id, enabled, issuer, client_id, client_secret_configured, client_secret_hash,
        redirect_uri, allowed_domains_json, role_mapping_json, updated_at
      ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        enabled = excluded.enabled,
        issuer = excluded.issuer,
        client_id = excluded.client_id,
        client_secret_configured = excluded.client_secret_configured,
        client_secret_hash = CASE
          WHEN excluded.client_secret_hash != '' THEN excluded.client_secret_hash
          ELSE console_oidc_config.client_secret_hash
        END,
        redirect_uri = excluded.redirect_uri,
        allowed_domains_json = excluded.allowed_domains_json,
        role_mapping_json = excluded.role_mapping_json,
        updated_at = excluded.updated_at
    `).run(
      next.enabled ? 1 : 0,
      next.issuer,
      next.clientId,
      next.clientSecretConfigured ? 1 : 0,
      next.clientSecretHash,
      next.redirectUri,
      stringifyJson(next.allowedDomains, []),
      stringifyJson(next.roleMapping, {}),
      nowIso()
    );
    return getOidcConfig();
  }

  function audit(input = {}) {
    if (!hasUsers()) {
      return;
    }
    const user = input.user || {};
    const targetProjection = securityAuditProjection(input.target || {}, "target");
    const errorProjection = securityAuditErrorProjection(input.error, input.reasonCode);
    db.prepare(`
      INSERT INTO console_audit_log (
        audit_id, user_id, username, operation_id, action, method, path, status, target_json, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stableId("audit", Date.now(), crypto.randomUUID()),
      auditIdentityRef(user.userId, "user-id"),
      auditIdentityRef(user.username, "username"),
      input.operationId || "",
      input.action || "",
      input.method || "",
      auditIdentityRef(input.path, "path"),
      input.status || "",
      stringifyJson(targetProjection),
      stringifyJson(errorProjection),
      nowIso()
    );
  }

  function listAudit({ limit = 100, userId = "", status = "" } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit || 100), 500));
    const clauses = [];
    const params = [];
    if (userId) {
      clauses.push("user_id = ?");
      params.push(auditIdentityRef(userId, "user-id"));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT * FROM console_audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, safeLimit).map((row) => {
      const targetProjection = parseSecurityAuditProjection(row.target_json, "target") ||
        securityAuditProjection({}, "target");
      const errorProjection = parseSecurityAuditProjection(row.error, "error") ||
        securityAuditErrorProjection("");
      return {
        auditId: row.audit_id,
        userId: row.user_id,
        username: row.username,
        operationId: row.operation_id,
        action: row.action,
        method: row.method,
        path: row.path,
        status: row.status,
        target: targetProjection.summary || {},
        reasonCode: errorProjection.reasonCode || "",
        error: errorProjection.reasonCode || "",
        createdAt: row.created_at
      };
    });
  }

  function authorizeOperation({ request, operation, method, url, input = {}, context = {} }) {
    const publicAccess = operation?.public === true;
    if (!safeRequestMethod(method) && !sameOriginRequest(request)) {
      audit({
        operationId: operation?.id || "",
        action: "origin",
        method,
        path: url?.pathname || "",
        status: "denied",
        reasonCode: "origin_mismatch",
        error: "origin mismatch"
      });
      return {
        ok: false,
        status: 403,
        error: "请求来源校验失败。"
      };
    }
    if (!hasUsers()) {
      return publicAccess
        ? { ok: true, setupMode: true, session: null }
        : {
            ok: false,
            status: 401,
            error: "控制台未初始化。",
            bootstrap: getBootstrapStatus()
          };
    }
    if (publicAccess) {
      return { ok: true, session: getSessionFromRequest(request) };
    }
    const session = getSessionFromRequest(request);
    if (!session) {
      audit({
        operationId: operation?.id || "",
        action: "authorize",
        method,
        path: url?.pathname || "",
        status: "denied",
        reasonCode: "unauthenticated",
        error: "unauthenticated"
      });
      return {
        ok: false,
        status: 401,
        error: "控制台未登录。",
        bootstrap: getBootstrapStatus()
      };
    }
    const authorizationDecision = authorizationEngine.evaluate({
      operation,
      request,
      authSession: session,
      input: buildConsoleOperationAuthorizationInput({ input, method, url }),
      context: buildConsoleOperationAuthorizationContext({ context }),
      enforceConfirmation: false
    });
    if (!authorizationDecision.allowed) {
      audit({
        user: session.user,
        operationId: operation?.id || "",
        action: "authorize",
        method,
        path: url?.pathname || "",
        status: "denied",
        reasonCode: authorizationDecision.reasonCode || "authorization_denied",
        error: authorizationDecision.reasonCode || "authorization denied"
      });
      const missingScopes = authorizationDecision.missingScopes || [];
      const missingCapabilities = authorizationDecision.missingCapabilities || [];
      const scopeSuffix = missingCapabilities.length > 0
        ? `：${missingCapabilities.join(", ")}`
        : missingScopes.length > 0
        ? `：${missingScopes.join(", ")}`
        : "";
      return {
        ok: false,
        status: 403,
        error: `权限不足${scopeSuffix}。`,
        session,
        authorizationDecision
      };
    }
    const needsCsrf =
      !operation?.skipCsrf &&
      !safeRequestMethod(method);
    if (needsCsrf) {
      const csrf = String(request?.headers?.["x-lico-csrf"] || "").trim();
      if (!csrf || !timingSafeStringEqual(csrf, session.csrfToken)) {
        audit({
          user: session.user,
          operationId: operation?.id || "",
          action: "csrf",
          method,
          path: url?.pathname || "",
          status: "denied",
          reasonCode: "csrf_mismatch",
          error: "csrf mismatch"
        });
        return {
          ok: false,
          status: 403,
          error: "CSRF 校验失败。",
          session
        };
      }
    }
    return {
      ok: true,
      session,
      authorizationDecision,
      governancePolicyRevision: authorizationGovernanceStore.getPolicyRevision()
    };
  }

  function getSummary(request = null) {
    const session = request ? getSessionFromRequest(request) : null;
    return {
      enabled: hasUsers(),
      bootstrap: getBootstrapStatus(),
      session: session
        ? {
            authenticated: true,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
            user: session.user
          }
        : {
            authenticated: false,
            csrfToken: "",
            expiresAt: "",
            user: null
          },
      roles: roleList(),
      oidc: getOidcConfig()
    };
  }

  return {
    rootPath,
    db,
    authorizationStore,
    authorizationGovernanceStore,
    tagManagementStore: authorizationGovernanceStore.tagManagementStore || null,
    authorizationEngine,
    ensureInitialOwner,
    getBootstrapStatus,
    hasUsers,
    authorizeOperation,
    getSessionFromRequest,
    getSummary,
    login,
    logout,
    rotateSession,
    listUsers,
    createUser,
    updateUser,
    listSessions,
    revokeSession,
    roleList,
    refreshActiveFeatureIds,
    getOidcConfig,
    setOidcConfig,
    audit,
    listAudit,
    close: resources.close
  };
}

export default createConsoleAuth;
