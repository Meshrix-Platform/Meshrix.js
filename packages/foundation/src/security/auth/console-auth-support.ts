import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { MESHRIX_ROOT_ORGANIZATION_ID } from "../authorization/organization-model.ts";
import { isTrustedProxyAddress } from "../trusted-client-ip.ts";


const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keyLength: number
) => Promise<Buffer>;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_ROLE_CONFIG_PATH = path.resolve(
  moduleDir,
  "../../../config/entity-config/auth/console-roles.json"
);
export const CONSOLE_SCOPE_CONFIG_DIR = path.resolve(
  moduleDir,
  "../../../config/entity-config/tools/scopes"
);

export const CONSOLE_SESSION_COOKIE = "meshrix_console_session";
export const CONSOLE_CSRF_COOKIE = "meshrix_console_csrf";

type UnknownRecord = Record<string, unknown>;
export interface GovernanceRecord extends UnknownRecord {
  roleId: string;
  label?: string;
  scopes: string[];
}
interface ConfiguredRole extends UnknownRecord {
  roleId?: string;
  id?: string;
  label?: string;
  scopes: unknown[];
}
type FeatureScopeGrants = Record<string, Record<string, readonly string[]>>;
interface ConsoleRoleConfig extends UnknownRecord {
  roles: ConfiguredRole[];
  featureScopeGrants?: FeatureScopeGrants;
}

interface RequestLike {
  headers?: Record<string, string | readonly string[] | undefined>;
  socket?: { remoteAddress?: string; encrypted?: boolean };
}

function uniqueConfigStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((value)  => String(value || "").trim()).filter(Boolean))];
}

function readJsonConfig<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function configuredScopeIds(): string[] {
  try {
    const ids = fs
      .readdirSync(CONSOLE_SCOPE_CONFIG_DIR, { withFileTypes: true })
      .filter((entry)  => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json")
      .flatMap((entry)  => {
        const filePath = path.join(CONSOLE_SCOPE_CONFIG_DIR, entry.name);
        let scopeConfig;
        try {
          scopeConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
          throw new Error(`Console scope configuration is invalid: ${entry.name}`);
        }
        const id = typeof scopeConfig?.id === "string" ? scopeConfig.id.trim() : "";
        if (!id) throw new Error(`Console scope configuration has no id: ${entry.name}`);
        return [id];
      });
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Console scope configuration is missing or contains duplicate ids.");
    }
    return ids;
  } catch {
    throw new Error("Console scope configuration failed closed.");
  }
}

export const CONSOLE_SCOPES = Object.freeze(uniqueConfigStrings(configuredScopeIds()));

const parsedConsoleRoleConfig = readJsonConfig<ConsoleRoleConfig | null>(
  CONSOLE_ROLE_CONFIG_PATH,
  null
);
if (
  !parsedConsoleRoleConfig ||
  !Array.isArray(parsedConsoleRoleConfig.roles) ||
  parsedConsoleRoleConfig.roles.length === 0
) {
  throw new Error("Console role configuration failed closed.");
}
const CONFIGURED_CONSOLE_ROLE_CONFIG: ConsoleRoleConfig = parsedConsoleRoleConfig;
const configuredRoleIds = new Set<string>();
for (const role of CONFIGURED_CONSOLE_ROLE_CONFIG.roles) {
  const roleId = String(role?.roleId || role?.id || "").trim();
  if (!roleId || configuredRoleIds.has(roleId) || !Array.isArray(role?.scopes)) {
    throw new Error("Console role configuration contains an invalid role.");
  }
  configuredRoleIds.add(roleId);
  for (const scope of role.scopes) {
    const normalizedScope = String(scope || "").trim();
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

function normalizeFeatureScopeGrants(value: Record<string, unknown> = {}): FeatureScopeGrants {
  const normalized: FeatureScopeGrants = {};
  for (const [featureId, roleGrants] of (Object.entries(value && typeof value === "object" ? value : {}) as [string, unknown][])) {
    const normalizedFeatureId = String(featureId || "").trim();
    if (!normalizedFeatureId || !roleGrants || typeof roleGrants !== "object" || Array.isArray(roleGrants)) continue;
    normalized[normalizedFeatureId] = Object.freeze(Object.fromEntries(
      (Object.entries(roleGrants) as [string, unknown][]).map(([roleId, scopes])  => [
        String(roleId || "").trim(),
        Object.freeze(uniqueConfigStrings(Array.isArray(scopes) ? scopes : []))
      ]).filter(([roleId])  => Boolean(roleId))
    ));
  }
  return Object.freeze(normalized);
}

export const CONSOLE_FEATURE_SCOPE_GRANTS = normalizeFeatureScopeGrants(
  CONFIGURED_CONSOLE_ROLE_CONFIG.featureScopeGrants || {}
);

const FEATURE_GOVERNED_CONSOLE_SCOPES = new Set(
  Object.values(CONSOLE_FEATURE_SCOPE_GRANTS)
    .flatMap((roleGrants) => Object.values(roleGrants))
    .flat()
);

function normalizeConfiguredRole(
  input: Record<string, unknown> = {},
  fallback: GovernanceRecord | null = null,
  availableScopes: readonly string[] = CONSOLE_SCOPES
): GovernanceRecord | null {
  const roleId = String(input.roleId || input.id || fallback?.roleId || "").trim();
  if (!roleId) return null;
  const availableScopeSet = new Set(availableScopes);
  const rawScopes = Array.isArray(input.scopes) ? input.scopes : fallback?.scopes || [];
  const scopes = rawScopes.some((scope)  => ["*", "$all"].includes(String(scope || "").trim()))
    ? [...availableScopeSet]
    : uniqueConfigStrings(rawScopes).filter((scope)  => availableScopeSet.has(scope));
  return Object.freeze({
    roleId,
    label: String(input.label || fallback?.label || roleId).trim(),
    scopes: [...scopes]
  });
}

export function createConsoleRoleCatalog({
  activeFeatureIds = [],
  featureScopeGrants = CONSOLE_FEATURE_SCOPE_GRANTS
}: { activeFeatureIds?: unknown[]; featureScopeGrants?: FeatureScopeGrants } = {}): Readonly<Record<string, GovernanceRecord>> {
  const roleConfig = CONFIGURED_CONSOLE_ROLE_CONFIG;
  const normalizedFeatureScopeGrants = normalizeFeatureScopeGrants(featureScopeGrants);
  const featureGovernedScopes = new Set(Object.values(normalizedFeatureScopeGrants)
    .flatMap((roleGrants) => Object.values(roleGrants)).flat());
  const activeFeatureSet = new Set(
    (Array.isArray(activeFeatureIds) ? activeFeatureIds : [])
      .map((featureId)  => String(featureId || "").trim())
      .filter(Boolean)
  );
  const activeScopes = uniqueConfigStrings([
    ...CONSOLE_SCOPES.filter((scope)  => !FEATURE_GOVERNED_CONSOLE_SCOPES.has(scope) && !featureGovernedScopes.has(scope)),
    ...[...activeFeatureSet].flatMap((featureId)  =>
      (Object.values(normalizedFeatureScopeGrants[featureId] || {}) as unknown[]).flat()
    )
  ]);
  const roles = roleConfig.roles;
  const normalized: Record<string, GovernanceRecord> = {};
  for (const role of roles) {
    const roleId = String(role?.roleId || role?.id || "").trim();
    const featureScopes = [...activeFeatureSet].flatMap((featureId)  =>
      normalizedFeatureScopeGrants[featureId]?.[roleId] || []
    );
    const normalizedRole = normalizeConfiguredRole({
      ...role,
      scopes: Array.isArray(role?.scopes) && role.scopes.some((scope)  => ["*", "$all"].includes(String(scope || "").trim()))
        ? role.scopes
        : [...(Array.isArray(role?.scopes) ? role.scopes : []), ...featureScopes]
    }, null, activeScopes);
    if (normalizedRole) {
      normalized[normalizedRole.roleId] = normalizedRole;
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

export function nowIso()  {
  return new Date().toISOString();
}

export function randomToken(prefix = TOKEN_PREFIX): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function stableId(prefix: string, ...parts: readonly unknown[]): string {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map((part)  => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export function hashToken(value?: unknown): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeUsername(value?: unknown): string {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,80}$/.test(username)) {
    throw new Error("用户名需为 3-80 位字母、数字、点、下划线、短横线或 @。");
  }
  return username;
}

export function normalizePassword(value?: unknown): string {
  const password = String(value || "");
  if (password.length < 10 || password.length > 256) {
    throw new Error("密码长度需为 10-256 位。");
  }
  return password;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: unknown): string;
export function stringifyJson<T>(value: unknown, fallback: T): string;
export function stringifyJson(value?: unknown, fallback: unknown = {}): string {
  return JSON.stringify(value ?? fallback);
}

export function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((value)  => String(value || "").trim()).filter(Boolean))];
}

export function stringsFrom(value: unknown = []): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }
  return [];
}

export function objectOrEmpty(value?: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

export function buildConsoleOperationAuthorizationInput({
  input = {},
  method = "",
  url = null
}: { input?: unknown; method?: unknown; url?: URL | null } = {})  {
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
}: Record<string, unknown> = {})  {
  const operationContext = objectOrEmpty(context);
  return {
    ...operationContext,
    transport: String(operationContext.transport || transport || "console-http")
  };
}

export function normalizeTenantId(value?: unknown): string {
  const tenantId = String(value || "default").trim() || "default";
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(tenantId)) {
    throw new Error("tenantId 只能包含字母、数字、点、下划线、短横线、冒号，长度 1-120。");
  }
  return tenantId;
}

export function parseCookies(request?: RequestLike): Record<string, string> {
  const header = String(request?.headers?.cookie || "");
  return Object.fromEntries(
    header
      .split(";")
      .map((item)  => item.trim())
      .filter(Boolean)
      .map((item)  => {
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
export function isTrustedProxy(request?: RequestLike): boolean {
  return isTrustedProxyAddress(request?.socket?.remoteAddress || "");
}

function singleForwardedHeader(value: string | readonly string[] | undefined = ""): string {
  const text = Array.isArray(value) ? value.join(",") : String(value || "");
  const entries = text.split(",").map((entry)  => entry.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : "";
}

export function isSecureRequest(request?: RequestLike): boolean {
  // M-4: honor MESHRIX_COOKIE_SECURE env var (always|auto|never)
  const envSetting = String(process.env.MESHRIX_COOKIE_SECURE || "auto").trim().toLowerCase();
  if (envSetting === "always" || envSetting === "1" || envSetting === "true") return true;
  if (envSetting === "never" || envSetting === "0" || envSetting === "false") return false;
  // "auto": use socket TLS or trust HTTPS from a trusted proxy
  if (request?.socket?.encrypted) return true;
  if (isTrustedProxy(request)) {
    return singleForwardedHeader(request?.headers?.["x-forwarded-proto"]).toLowerCase() === "https";
  }
  return false;
}

export function safeRequestMethod(method?: unknown): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

export function requestTargetOrigin(request?: RequestLike): string {
  const protocol = isSecureRequest(request) ? "https" : "http";
  // M-2: only accept x-forwarded-host from verified trusted proxy connections
  const forwardedHost = isTrustedProxy(request)
    ? singleForwardedHeader(request?.headers?.["x-forwarded-host"])
    : "";
  const host = String(forwardedHost || request?.headers?.host || "127.0.0.1").trim();
  return `${protocol}://${host}`;
}

export function normalizeOrigin(value?: unknown): string {
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

export function sameOriginRequest(request?: RequestLike): boolean {
  const targetOrigin = normalizeOrigin(requestTargetOrigin(request));
  const origin = normalizeOrigin(request?.headers?.origin || "");
  if (origin) {
    return origin === targetOrigin;
  }
  const referer = normalizeOrigin(request?.headers?.referer || "");
  return !referer || referer === targetOrigin;
}

export function cookieHeader(
  name: string,
  value: string,
  request?: RequestLike,
  options: { httpOnly?: boolean; maxAge?: number } = {}
): string {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict"
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (typeof options.maxAge === "number" && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

interface ConsoleUserRow extends UnknownRecord {
  user_id: string;
  username: string;
  display_name?: string;
  role_id: string;
  tenant_id?: string;
  org_id?: string;
  team_ids_json?: string;
  department_ids_json?: string;
  allowed_workspace_ids_json?: string;
  allowed_data_classes_json?: string;
  allowed_egress_json?: string;
  attributes_json?: string;
  enabled?: number | boolean;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string;
}

export function publicUser(
  row?: ConsoleUserRow | null,
  roles: Readonly<Record<string, GovernanceRecord>> = CONSOLE_ROLES
) {
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

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scryptAsync(password, salt, 64);
  return {
    salt,
    passwordHash: Buffer.from(derived).toString("base64")
  };
}

export async function verifyPassword(
  password?: unknown,
  salt?: unknown,
  passwordHash?: unknown
): Promise<boolean> {
  const derived = await scryptAsync(String(password || ""), String(salt || ""), 64);
  const left = Buffer.from(derived);
  const right = Buffer.from(String(passwordHash || ""), "base64");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function timingSafeStringEqual(leftValue?: unknown, rightValue?: unknown): boolean {
  const left = crypto.createHash("sha256").update(String(leftValue || ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(rightValue || ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function ensureSchema(db: Database.Database): void {
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

  const migrationVersion = Number(db.pragma("user_version", { simple: true }) || 0);
  if (migrationVersion < 1) {
    db.transaction(()  => {
      db.prepare(`
        UPDATE console_users
        SET role_id = 'maintainer'
        WHERE role_id IN ('admin', 'operator')
      `).run();
      const oidcRows = db.prepare(`
        SELECT config_id, role_mapping_json
        FROM console_oidc_config
      `).all() as Array<{ config_id: string; role_mapping_json: string }>;
      const updateOidcRoleMapping = db.prepare(`
        UPDATE console_oidc_config
        SET role_mapping_json = ?
        WHERE config_id = ?
      `);
      for (const row of oidcRows) {
        const mapping = parseJson(row.role_mapping_json, {});
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
        let changed = false;
        const migrated: Record<string, unknown> = {};
        for (const [claim, roleId] of Object.entries(mapping)) {
          const normalizedRoleId = ["admin", "operator"].includes(String(roleId || ""))
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
