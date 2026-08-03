import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MESHRIX_ROOT_ORGANIZATION_ID } from "../authorization/organization-model.ts";
import { isTrustedProxyAddress } from "../trusted-client-ip.ts";


const scryptAsync: any = promisify(crypto.scrypt);
const moduleDir: any = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_ROLE_CONFIG_PATH: any = path.resolve(
  moduleDir,
  "../../../config/entity-config/auth/console-roles.json"
);
export const CONSOLE_SCOPE_CONFIG_DIR: any = path.resolve(
  moduleDir,
  "../../../config/entity-config/tools/scopes"
);

export const CONSOLE_SESSION_COOKIE: any = "meshrix_console_session";
export const CONSOLE_CSRF_COOKIE: any = "meshrix_console_csrf";

function uniqueConfigStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function readJsonConfig(filePath?: any, fallback?: any) : any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function configuredScopeIds() : any {
  try {
    const ids: any = fs
      .readdirSync(CONSOLE_SCOPE_CONFIG_DIR, { withFileTypes: true })
      .filter((entry?: any) : any => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json")
      .flatMap((entry?: any) : any => {
        const filePath: any = path.join(CONSOLE_SCOPE_CONFIG_DIR, entry.name);
        let scopeConfig: any;
        try {
          scopeConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
          throw new Error(`Console scope configuration is invalid: ${entry.name}`);
        }
        const id: any = typeof scopeConfig?.id === "string" ? scopeConfig.id.trim() : "";
        if (!id) throw new Error(`Console scope configuration has no id: ${entry.name}`);
        return [id];
      });
    if (ids.length === 0 || new Set<any>(ids).size !== ids.length) {
      throw new Error("Console scope configuration is missing or contains duplicate ids.");
    }
    return ids;
  } catch {
    throw new Error("Console scope configuration failed closed.");
  }
}

export const CONSOLE_SCOPES: any = Object.freeze(uniqueConfigStrings(configuredScopeIds()));

const CONFIGURED_CONSOLE_ROLE_CONFIG: any = readJsonConfig(
  CONSOLE_ROLE_CONFIG_PATH,
  null
);
if (
  !CONFIGURED_CONSOLE_ROLE_CONFIG ||
  !Array.isArray(CONFIGURED_CONSOLE_ROLE_CONFIG.roles) ||
  CONFIGURED_CONSOLE_ROLE_CONFIG.roles.length === 0
) {
  throw new Error("Console role configuration failed closed.");
}
const configuredRoleIds: any = new Set<any>();
for (const role of CONFIGURED_CONSOLE_ROLE_CONFIG.roles) {
  const roleId: any = String(role?.roleId || role?.id || "").trim();
  if (!roleId || configuredRoleIds.has(roleId) || !Array.isArray(role?.scopes)) {
    throw new Error("Console role configuration contains an invalid role.");
  }
  configuredRoleIds.add(roleId);
  for (const scope of role.scopes) {
    const normalizedScope: any = String(scope || "").trim();
    if (!["*", "$all"].includes(normalizedScope) && !CONSOLE_SCOPES.includes(normalizedScope)) {
      throw new Error(`Console role configuration references an unknown scope: ${normalizedScope}`);
    }
  }
}
for (const requiredRoleId of ["owner", "maintainer", "viewer"]) {
  if (!configuredRoleIds.has(requiredRoleId)) {
    throw new Error(`Console role configuration is missing required role: ${requiredRoleId}`);
  }
}

function normalizeFeatureScopeGrants(value: Record<string, any> = {}) : any {
  const normalized: Record<string, any> = {};
  for (const [featureId, roleGrants] of (Object.entries(value && typeof value === "object" ? value : {}) as [string, any][])) {
    const normalizedFeatureId: any = String(featureId || "").trim();
    if (!normalizedFeatureId || !roleGrants || typeof roleGrants !== "object" || Array.isArray(roleGrants)) continue;
    normalized[normalizedFeatureId] = Object.freeze(Object.fromEntries(
      (Object.entries(roleGrants) as [string, any][]).map(([roleId, scopes]: any[]) : any => [
        String(roleId || "").trim(),
        Object.freeze(uniqueConfigStrings(Array.isArray(scopes) ? scopes : []))
      ]).filter(([roleId]: any[]) : any => Boolean(roleId))
    ));
  }
  return Object.freeze(normalized);
}

export const CONSOLE_FEATURE_SCOPE_GRANTS: any = normalizeFeatureScopeGrants(
  CONFIGURED_CONSOLE_ROLE_CONFIG.featureScopeGrants || {}
);

const FEATURE_GOVERNED_CONSOLE_SCOPES: any = new Set<any>(
  (Object.values(CONSOLE_FEATURE_SCOPE_GRANTS) as any[])
    .flatMap((roleGrants?: any) : any => (Object.values(roleGrants) as any[]))
    .flat()
);

function normalizeConfiguredRole(input: Record<string, any> = {}, fallback: any = null, availableScopes: any = CONSOLE_SCOPES) : any {
  const roleId: any = String(input.roleId || input.id || fallback?.roleId || "").trim();
  if (!roleId) return null;
  const availableScopeSet: any = new Set<any>(availableScopes);
  const rawScopes: any = Array.isArray(input.scopes) ? input.scopes : fallback?.scopes || [];
  const scopes: any = rawScopes.some((scope?: any) : any => ["*", "$all"].includes(String(scope || "").trim()))
    ? [...availableScopeSet]
    : uniqueConfigStrings(rawScopes).filter((scope?: any) : any => availableScopeSet.has(scope));
  return Object.freeze({
    roleId,
    label: String(input.label || fallback?.label || roleId).trim(),
    scopes: Object.freeze(scopes)
  });
}

export function createConsoleRoleCatalog({ activeFeatureIds = [], featureScopeGrants = CONSOLE_FEATURE_SCOPE_GRANTS }: Record<string, any> = {}) : any {
  const roleConfig: any = CONFIGURED_CONSOLE_ROLE_CONFIG;
  const normalizedFeatureScopeGrants: any = normalizeFeatureScopeGrants(featureScopeGrants);
  const featureGovernedScopes: any = new Set<any>((Object.values(normalizedFeatureScopeGrants) as any[])
    .flatMap((roleGrants?: any) : any => (Object.values(roleGrants) as any[])).flat());
  const activeFeatureSet: any = new Set<any>(
    (Array.isArray(activeFeatureIds) ? activeFeatureIds : [])
      .map((featureId?: any) : any => String(featureId || "").trim())
      .filter(Boolean)
  );
  const activeScopes: any = uniqueConfigStrings([
    ...CONSOLE_SCOPES.filter((scope?: any) : any => !FEATURE_GOVERNED_CONSOLE_SCOPES.has(scope) && !featureGovernedScopes.has(scope)),
    ...[...activeFeatureSet].flatMap((featureId?: any) : any =>
      (Object.values(normalizedFeatureScopeGrants[featureId] || {}) as any[]).flat()
    )
  ]);
  const roles: any = roleConfig.roles;
  const normalized: Record<string, any> = {};
  for (const role of roles) {
    const roleId: any = String(role?.roleId || role?.id || "").trim();
    const featureScopes: any = [...activeFeatureSet].flatMap((featureId?: any) : any =>
      normalizedFeatureScopeGrants[featureId]?.[roleId] || []
    );
    const normalizedRole: any = normalizeConfiguredRole({
      ...role,
      scopes: Array.isArray(role?.scopes) && role.scopes.some((scope?: any) : any => ["*", "$all"].includes(String(scope || "").trim()))
        ? role.scopes
        : [...(Array.isArray(role?.scopes) ? role.scopes : []), ...featureScopes]
    }, null, activeScopes);
    if (normalizedRole) {
      normalized[normalizedRole.roleId] = normalizedRole;
    }
  }
  return Object.freeze(normalized);
}

export const CONSOLE_ROLES: any = createConsoleRoleCatalog();

export const SESSION_TTL_MS: any = 1000 * 60 * 60 * 12;
// L-2: inactivity timeout for non-owner sessions (2 hours idle → expire)
export const SESSION_INACTIVITY_TTL_MS: any = 1000 * 60 * 60 * 2;
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS: any = 1000 * 60;
export const TOKEN_PREFIX: any = "sac_";
export const LOGIN_MAX_ATTEMPTS: any = 10;
export const LOGIN_LOCKOUT_MS: any = 1000 * 60 * 15; // 15 minutes

export function nowIso() : any {
  return new Date().toISOString();
}

export function randomToken(prefix: any = TOKEN_PREFIX) : any {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function stableId(prefix: any, ...parts: any[]) : any {
  const digest: any = crypto
    .createHash("sha256")
    .update(parts.map((part?: any) : any => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export function hashToken(value?: any) : any {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeUsername(value?: any) : any {
  const username: any = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,80}$/.test(username)) {
    throw new Error("用户名需为 3-80 位字母、数字、点、下划线、短横线或 @。");
  }
  return username;
}

export function normalizePassword(value?: any) : any {
  const password: any = String(value || "");
  if (password.length < 10 || password.length > 256) {
    throw new Error("密码长度需为 10-256 位。");
  }
  return password;
}

export function parseJson(value?: any, fallback?: any) : any {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: any, fallback: Record<string, any> = {}) : any {
  return JSON.stringify(value ?? fallback);
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function stringsFrom(value: any = []) : any {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }
  return [];
}

export function objectOrEmpty(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function buildConsoleOperationAuthorizationInput({
  input = {},
  method = "",
  url = null
}: Record<string, any> = {}) : any {
  const operationInput: any = objectOrEmpty(input);
  return {
    ...operationInput,
    method: String(method || ""),
    path: String(url?.pathname || "")
  };
}

export function buildConsoleOperationAuthorizationContext({
  context = {},
  transport = "console-http"
}: Record<string, any> = {}) : any {
  const operationContext: any = objectOrEmpty(context);
  return {
    ...operationContext,
    transport: String(operationContext.transport || transport || "console-http")
  };
}

export function normalizeTenantId(value?: any) : any {
  const tenantId: any = String(value || "default").trim() || "default";
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(tenantId)) {
    throw new Error("tenantId 只能包含字母、数字、点、下划线、短横线、冒号，长度 1-120。");
  }
  return tenantId;
}

export function parseCookies(request?: any) : any {
  const header: any = String(request?.headers?.cookie || "");
  return Object.fromEntries(
    header
      .split(";")
      .map((item?: any) : any => item.trim())
      .filter(Boolean)
      .map((item?: any) : any => {
        const index: any = item.indexOf("=");
        if (index < 0) {
          return [decodeURIComponent(item), ""];
        }
        return [
          decodeURIComponent(item.slice(0, index)),
          decodeURIComponent(item.slice(index + 1))
        ];
      })
  );
}

// Accept x-forwarded-* headers only from explicitly configured proxy IPs.
// Direct loopback callers are not implicitly proxies.
export function isTrustedProxy(request?: any) : any {
  return isTrustedProxyAddress(request?.socket?.remoteAddress || "");
}

function singleForwardedHeader(value: any = "") : any {
  const text: any = Array.isArray(value) ? value.join(",") : String(value || "");
  const entries: any = text.split(",").map((entry?: any) : any => entry.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : "";
}

export function isSecureRequest(request?: any) : any {
  // M-4: honor MESHRIX_COOKIE_SECURE env var (always|auto|never)
  const envSetting: any = String(process.env.MESHRIX_COOKIE_SECURE || "auto").trim().toLowerCase();
  if (envSetting === "always" || envSetting === "1" || envSetting === "true") return true;
  if (envSetting === "never" || envSetting === "0" || envSetting === "false") return false;
  // "auto": use socket TLS or trust HTTPS from a trusted proxy
  if (request?.socket?.encrypted) return true;
  if (isTrustedProxy(request)) {
    return singleForwardedHeader(request?.headers?.["x-forwarded-proto"]).toLowerCase() === "https";
  }
  return false;
}

export function safeRequestMethod(method?: any) : any {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

export function requestTargetOrigin(request?: any) : any {
  const protocol: any = isSecureRequest(request) ? "https" : "http";
  // M-2: only accept x-forwarded-host from verified trusted proxy connections
  const forwardedHost: any = isTrustedProxy(request)
    ? singleForwardedHeader(request?.headers?.["x-forwarded-host"])
    : "";
  const host: any = String(forwardedHost || request?.headers?.host || "127.0.0.1").trim();
  return `${protocol}://${host}`;
}

export function normalizeOrigin(value?: any) : any {
  const text: any = String(value || "").trim();
  if (!text || text === "null") {
    return "";
  }
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

export function sameOriginRequest(request?: any) : any {
  const targetOrigin: any = normalizeOrigin(requestTargetOrigin(request));
  const origin: any = normalizeOrigin(request?.headers?.origin || "");
  if (origin) {
    return origin === targetOrigin;
  }
  const referer: any = normalizeOrigin(request?.headers?.referer || "");
  return !referer || referer === targetOrigin;
}

export function cookieHeader(name?: any, value?: any, request?: any, options: Record<string, any> = {}) : any {
  const parts: any[] = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict"
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function publicUser(row?: any, roles: any = CONSOLE_ROLES) : any {
  if (!row) {
    return null;
  }
  const role: any = roles[row.role_id] || roles.viewer;
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    roleId: row.role_id,
    roleLabel: role.label,
    scopes: role.scopes,
    tenantId: row.tenant_id || "default",
    orgId: row.org_id || MESHRIX_ROOT_ORGANIZATION_ID,
    teamIds: parseJson(row.team_ids_json, []),
    departmentIds: parseJson(row.department_ids_json, []),
    allowedWorkspaceIds: parseJson(row.allowed_workspace_ids_json, []),
    allowedDataClasses: parseJson(row.allowed_data_classes_json, []),
    allowedEgress: parseJson(row.allowed_egress_json, []),
    attributes: parseJson(row.attributes_json, {}),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || ""
  };
}

export async function hashPassword(password?: any) : Promise<any> {
  const salt: any = crypto.randomBytes(16).toString("base64url");
  const derived: any = await scryptAsync(password, salt, 64);
  return {
    salt,
    passwordHash: Buffer.from(derived).toString("base64")
  };
}

export async function verifyPassword(password?: any, salt?: any, passwordHash?: any) : Promise<any> {
  const derived: any = await scryptAsync(String(password || ""), String(salt || ""), 64);
  const left: any = Buffer.from(derived);
  const right: any = Buffer.from(String(passwordHash || ""), "base64");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function timingSafeStringEqual(leftValue?: any, rightValue?: any) : any {
  const left: any = crypto.createHash("sha256").update(String(leftValue || ""), "utf8").digest();
  const right: any = crypto.createHash("sha256").update(String(rightValue || ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function ensureSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS console_users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      role_id TEXT NOT NULL DEFAULT 'viewer',
      password_hash TEXT NOT NULL DEFAULT '',
      salt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      org_id TEXT NOT NULL DEFAULT '',
      team_ids_json TEXT NOT NULL DEFAULT '[]',
      department_ids_json TEXT NOT NULL DEFAULT '[]',
      allowed_workspace_ids_json TEXT NOT NULL DEFAULT '[]',
      allowed_data_classes_json TEXT NOT NULL DEFAULT '[]',
      allowed_egress_json TEXT NOT NULL DEFAULT '[]',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL DEFAULT '',
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT NOT NULL DEFAULT ''
    );`
  );

  db.exec(`

    CREATE TABLE IF NOT EXISTS console_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES console_users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS console_deferred_protected_sink_authorities (
      authority_ref TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      approval_intent_digest TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(session_id) REFERENCES console_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS console_audit_log (
      audit_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      target_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS console_oidc_config (
      config_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      issuer TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT '',
      client_secret_configured INTEGER NOT NULL DEFAULT 0,
      client_secret_hash TEXT NOT NULL DEFAULT '',
      redirect_uri TEXT NOT NULL DEFAULT '',
      allowed_domains_json TEXT NOT NULL DEFAULT '[]',
      role_mapping_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_console_sessions_user ON console_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_console_sessions_expires ON console_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_console_deferred_authority_session
      ON console_deferred_protected_sink_authorities(session_id);
    CREATE INDEX IF NOT EXISTS idx_console_deferred_authority_expires
      ON console_deferred_protected_sink_authorities(expires_at);
    CREATE INDEX IF NOT EXISTS idx_console_audit_created ON console_audit_log(created_at);
  `);

  const migrationVersion: any = Number(db.pragma("user_version", { simple: true }) || 0);
  if (migrationVersion < 1) {
    db.transaction(() : any => {
      db.prepare(`
        UPDATE console_users
        SET role_id = 'maintainer'
        WHERE role_id IN ('admin', 'operator')
      `).run();
      const oidcRows: any[] = db.prepare(`
        SELECT config_id, role_mapping_json
        FROM console_oidc_config
      `).all();
      const updateOidcRoleMapping: any = db.prepare(`
        UPDATE console_oidc_config
        SET role_mapping_json = ?
        WHERE config_id = ?
      `);
      for (const row of oidcRows) {
        const mapping: any = parseJson(row.role_mapping_json, {});
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
        let changed: any = false;
        const migrated: Record<string, any> = {};
        for (const [claim, roleId] of Object.entries(mapping)) {
          const normalizedRoleId: any = ["admin", "operator"].includes(String(roleId || ""))
            ? "maintainer"
            : roleId;
          migrated[claim] = normalizedRoleId;
          changed ||= normalizedRoleId !== roleId;
        }
        if (changed) updateOidcRoleMapping.run(stringifyJson(migrated, {}), row.config_id);
      }
      db.pragma("user_version = 1");
    })();
  }
}
