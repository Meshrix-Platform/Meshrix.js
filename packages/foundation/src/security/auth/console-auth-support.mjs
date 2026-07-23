import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LICO_ROOT_ORGANIZATION_ID } from "../authorization/organization-model.mjs";
import { isTrustedProxyAddress } from "../trusted-client-ip.mjs";


const scryptAsync = promisify(crypto.scrypt);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_ROLE_CONFIG_PATH = path.resolve(
  moduleDir,
  "../../../config/entity-config/auth/console-roles.json"
);
export const CONSOLE_SCOPE_CONFIG_DIR = path.resolve(
  moduleDir,
  "../../../config/entity-config/tools/scopes"
);

export const CONSOLE_SESSION_COOKIE = "lico_console_session";
export const CONSOLE_CSRF_COOKIE = "lico_console_csrf";

const FALLBACK_CONSOLE_SCOPES = [
  "console:read",
  "gateway:read",
  "workspace:read",
  "storage:read",
  "gateway:write",
  "workspace:write",
  "storage:write",
  "gateway:maintain",
  "workspace:maintain",
  "gateway:admin",
  "jobs:read",
  "jobs:write",
  "maintenance:read",
  "maintenance:run",
  "maintenance:approve",
  "maintenance:admin",
  "repo:read",
  "repo:write",
  "repo:review",
  "repo:approve",
  "repo:maintain",
  "repo:admin",
  "model:call",
  "runtime:admin",
  "auth:admin"
];

const FALLBACK_CONSOLE_ROLE_CONFIG = Object.freeze({
  featureScopeGrants: {},
  roles: [
    { roleId: "owner", label: "Owner", scopes: ["$all"] },
    {
      roleId: "admin",
      label: "Admin",
      scopes: [
        "console:read",
        "gateway:read",
        "workspace:read",
        "storage:read",
        "gateway:write",
        "workspace:write",
        "storage:write",
        "gateway:maintain",
        "workspace:maintain",
        "gateway:admin",
        "jobs:read",
        "jobs:write",
        "maintenance:read",
        "maintenance:run",
        "maintenance:approve",
        "maintenance:admin",
        "repo:read",
        "repo:write",
        "repo:review",
        "repo:approve",
        "repo:maintain",
        "model:call"
      ]
    },
    {
      roleId: "operator",
      label: "Operator",
      scopes: [
        "console:read",
        "gateway:read",
        "workspace:read",
        "storage:read",
        "gateway:write",
        "workspace:write",
        "storage:write",
        "gateway:maintain",
        "workspace:maintain",
        "jobs:read",
        "jobs:write",
        "maintenance:read",
        "maintenance:run",
        "maintenance:approve",
        "model:call"
      ]
    },
    {
      roleId: "viewer",
      label: "Viewer",
      scopes: [
        "console:read",
        "gateway:read",
        "workspace:read",
        "storage:read",
        "jobs:read"
      ]
    }
  ]
});

function uniqueConfigStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function readJsonConfig(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function configuredScopeIds() {
  try {
    return fs
      .readdirSync(CONSOLE_SCOPE_CONFIG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json")
      .flatMap((entry) => {
        const scopeConfig = readJsonConfig(path.join(CONSOLE_SCOPE_CONFIG_DIR, entry.name), null);
        return typeof scopeConfig?.id === "string" ? [scopeConfig.id] : [];
      });
  } catch {
    return [];
  }
}

export const CONSOLE_SCOPES = Object.freeze(uniqueConfigStrings([
  ...FALLBACK_CONSOLE_SCOPES,
  ...configuredScopeIds()
]));

const CONFIGURED_CONSOLE_ROLE_CONFIG = readJsonConfig(
  CONSOLE_ROLE_CONFIG_PATH,
  FALLBACK_CONSOLE_ROLE_CONFIG
);

function normalizeFeatureScopeGrants(value = {}) {
  const normalized = {};
  for (const [featureId, roleGrants] of Object.entries(value && typeof value === "object" ? value : {})) {
    const normalizedFeatureId = String(featureId || "").trim();
    if (!normalizedFeatureId || !roleGrants || typeof roleGrants !== "object" || Array.isArray(roleGrants)) continue;
    normalized[normalizedFeatureId] = Object.freeze(Object.fromEntries(
      Object.entries(roleGrants).map(([roleId, scopes]) => [
        String(roleId || "").trim(),
        Object.freeze(uniqueConfigStrings(Array.isArray(scopes) ? scopes : []))
      ]).filter(([roleId]) => Boolean(roleId))
    ));
  }
  return Object.freeze(normalized);
}

export const CONSOLE_FEATURE_SCOPE_GRANTS = normalizeFeatureScopeGrants(
  CONFIGURED_CONSOLE_ROLE_CONFIG?.featureScopeGrants || FALLBACK_CONSOLE_ROLE_CONFIG.featureScopeGrants
);

const FEATURE_GOVERNED_CONSOLE_SCOPES = new Set(
  Object.values(CONSOLE_FEATURE_SCOPE_GRANTS)
    .flatMap((roleGrants) => Object.values(roleGrants))
    .flat()
);

function normalizeConfiguredRole(input = {}, fallback = null, availableScopes = CONSOLE_SCOPES) {
  const roleId = String(input.roleId || input.id || fallback?.roleId || "").trim();
  if (!roleId) return null;
  const availableScopeSet = new Set(availableScopes);
  const rawScopes = Array.isArray(input.scopes) ? input.scopes : fallback?.scopes || [];
  const scopes = rawScopes.some((scope) => ["*", "$all"].includes(String(scope || "").trim()))
    ? [...availableScopeSet]
    : uniqueConfigStrings(rawScopes).filter((scope) => availableScopeSet.has(scope));
  return Object.freeze({
    roleId,
    label: String(input.label || fallback?.label || roleId).trim(),
    scopes: Object.freeze(scopes)
  });
}

export function createConsoleRoleCatalog({ activeFeatureIds = [], featureScopeGrants = CONSOLE_FEATURE_SCOPE_GRANTS } = {}) {
  const roleConfig = CONFIGURED_CONSOLE_ROLE_CONFIG;
  const normalizedFeatureScopeGrants = normalizeFeatureScopeGrants(featureScopeGrants);
  const featureGovernedScopes = new Set(Object.values(normalizedFeatureScopeGrants)
    .flatMap((roleGrants) => Object.values(roleGrants)).flat());
  const activeFeatureSet = new Set(
    (Array.isArray(activeFeatureIds) ? activeFeatureIds : [])
      .map((featureId) => String(featureId || "").trim())
      .filter(Boolean)
  );
  const activeScopes = uniqueConfigStrings([
    ...CONSOLE_SCOPES.filter((scope) => !FEATURE_GOVERNED_CONSOLE_SCOPES.has(scope) && !featureGovernedScopes.has(scope)),
    ...[...activeFeatureSet].flatMap((featureId) =>
      Object.values(normalizedFeatureScopeGrants[featureId] || {}).flat()
    )
  ]);
  const fallbackRoles = Object.fromEntries(
    FALLBACK_CONSOLE_ROLE_CONFIG.roles.map((role) => [role.roleId, role])
  );
  const roles = Array.isArray(roleConfig?.roles) ? roleConfig.roles : FALLBACK_CONSOLE_ROLE_CONFIG.roles;
  const normalized = {};
  for (const role of roles) {
    const roleId = String(role?.roleId || role?.id || "").trim();
    const featureScopes = [...activeFeatureSet].flatMap((featureId) =>
      normalizedFeatureScopeGrants[featureId]?.[roleId] || []
    );
    const normalizedRole = normalizeConfiguredRole({
      ...role,
      scopes: Array.isArray(role?.scopes) && role.scopes.some((scope) => ["*", "$all"].includes(String(scope || "").trim()))
        ? role.scopes
        : [...(Array.isArray(role?.scopes) ? role.scopes : []), ...featureScopes]
    }, fallbackRoles[roleId], activeScopes);
    if (normalizedRole) {
      normalized[normalizedRole.roleId] = normalizedRole;
    }
  }
  for (const fallbackRole of FALLBACK_CONSOLE_ROLE_CONFIG.roles) {
    if (!normalized[fallbackRole.roleId]) {
      const featureScopes = [...activeFeatureSet].flatMap((featureId) =>
        normalizedFeatureScopeGrants[featureId]?.[fallbackRole.roleId] || []
      );
      normalized[fallbackRole.roleId] = normalizeConfiguredRole({
        ...fallbackRole,
        scopes: fallbackRole.scopes.some((scope) => ["*", "$all"].includes(String(scope || "").trim()))
          ? fallbackRole.scopes
          : [...fallbackRole.scopes, ...featureScopes]
      }, null, activeScopes);
    }
  }
  return Object.freeze(normalized);
}

export const CONSOLE_ROLES = createConsoleRoleCatalog();

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
// L-2: inactivity timeout for non-owner sessions (2 hours idle → expire)
export const SESSION_INACTIVITY_TTL_MS = 1000 * 60 * 60 * 2;
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 1000 * 60;
export const TOKEN_PREFIX = "sac_";
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_LOCKOUT_MS = 1000 * 60 * 15; // 15 minutes

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(prefix = TOKEN_PREFIX) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function stableId(prefix, ...parts) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,80}$/.test(username)) {
    throw new Error("用户名需为 3-80 位字母、数字、点、下划线、短横线或 @。");
  }
  return username;
}

export function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 256) {
    throw new Error("密码长度需为 10-256 位。");
  }
  return password;
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function stringsFrom(value = []) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }
  return [];
}

export function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function buildConsoleOperationAuthorizationInput({
  input = {},
  method = "",
  url = null
} = {}) {
  const operationInput = objectOrEmpty(input);
  return {
    ...operationInput,
    method: String(method || ""),
    path: String(url?.pathname || "")
  };
}

export function buildConsoleOperationAuthorizationContext({
  context = {},
  transport = "console-http"
} = {}) {
  const operationContext = objectOrEmpty(context);
  return {
    ...operationContext,
    transport: String(operationContext.transport || transport || "console-http")
  };
}

export function normalizeTenantId(value) {
  const tenantId = String(value || "default").trim() || "default";
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(tenantId)) {
    throw new Error("tenantId 只能包含字母、数字、点、下划线、短横线、冒号，长度 1-120。");
  }
  return tenantId;
}

export function parseCookies(request) {
  const header = String(request?.headers?.cookie || "");
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
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
export function isTrustedProxy(request) {
  return isTrustedProxyAddress(request?.socket?.remoteAddress || "");
}

function singleForwardedHeader(value = "") {
  const text = Array.isArray(value) ? value.join(",") : String(value || "");
  const entries = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : "";
}

export function isSecureRequest(request) {
  // M-4: honor LICO_COOKIE_SECURE env var (always|auto|never)
  const envSetting = String(process.env.LICO_COOKIE_SECURE || "auto").trim().toLowerCase();
  if (envSetting === "always" || envSetting === "1" || envSetting === "true") return true;
  if (envSetting === "never" || envSetting === "0" || envSetting === "false") return false;
  // "auto": use socket TLS or trust HTTPS from a trusted proxy
  if (request?.socket?.encrypted) return true;
  if (isTrustedProxy(request)) {
    return singleForwardedHeader(request?.headers?.["x-forwarded-proto"]).toLowerCase() === "https";
  }
  return false;
}

export function safeRequestMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

export function requestTargetOrigin(request) {
  const protocol = isSecureRequest(request) ? "https" : "http";
  // M-2: only accept x-forwarded-host from verified trusted proxy connections
  const forwardedHost = isTrustedProxy(request)
    ? singleForwardedHeader(request?.headers?.["x-forwarded-host"])
    : "";
  const host = String(forwardedHost || request?.headers?.host || "127.0.0.1").trim();
  return `${protocol}://${host}`;
}

export function normalizeOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text === "null") {
    return "";
  }
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

export function sameOriginRequest(request) {
  const targetOrigin = normalizeOrigin(requestTargetOrigin(request));
  const origin = normalizeOrigin(request?.headers?.origin || "");
  if (origin) {
    return origin === targetOrigin;
  }
  const referer = normalizeOrigin(request?.headers?.referer || "");
  return !referer || referer === targetOrigin;
}

export function cookieHeader(name, value, request, options = {}) {
  const parts = [
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

export function publicUser(row, roles = CONSOLE_ROLES) {
  if (!row) {
    return null;
  }
  const role = roles[row.role_id] || roles.viewer;
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    roleId: row.role_id,
    roleLabel: role.label,
    scopes: role.scopes,
    tenantId: row.tenant_id || "default",
    orgId: row.org_id || LICO_ROOT_ORGANIZATION_ID,
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

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scryptAsync(password, salt, 64);
  return {
    salt,
    passwordHash: Buffer.from(derived).toString("base64")
  };
}

export async function verifyPassword(password, salt, passwordHash) {
  const derived = await scryptAsync(String(password || ""), String(salt || ""), 64);
  const left = Buffer.from(derived);
  const right = Buffer.from(String(passwordHash || ""), "base64");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function timingSafeStringEqual(leftValue, rightValue) {
  const left = crypto.createHash("sha256").update(String(leftValue || ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(rightValue || ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function ensureSchema(db) {
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
    CREATE INDEX IF NOT EXISTS idx_console_audit_created ON console_audit_log(created_at);
  `);
}
