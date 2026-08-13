import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  irreversibleSecurityDigest,
  summarizeSecurityValue
} from "../../observability/runtime-logger.ts";
import { MESHRIX_ROOT_ORGANIZATION_ID } from "../authorization/organization-model.ts";
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
} from "./console-auth-support.ts";
import { createConsoleAuthResources } from "./console-auth-resources.ts";

const CONSOLE_AUDIT_SECURITY_PROJECTION: any = "console-audit-security-metadata";
const PROTECTED_SINK_AUTHORITY_PROTOCOL: any =
  "v0.0.1:final-protected-sink:console-authority-1";
const DEFERRED_PROTECTED_SINK_AUTHORITY_PROTOCOL: any =
  "v0.0.1:final-protected-sink:deferred-console-authority-1";
const PROTECTED_SINK_AUTHORITY_PHASES: any = new Set<any>([
  "admission",
  "execution",
  "final-protected-sink"
]);
const SECURITY_DIGEST_PATTERN: any = /^hmac-sha256:[a-f0-9]{64}$/i;
const REASON_CODE_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SECURITY_METADATA_KEYS: any = new Set<any>([
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
const SECURITY_METADATA_TYPES: any = new Set<any>([
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
const SECURITY_METADATA_REASONS: any = new Set<any>([
  "absolute-path",
  "error-text",
  "identity",
  "metadata-only",
  "metadata-only-key",
  "sensitive-key"
]);

function authorityDigest(domain?: any, facts?: any) : any {
  return `sha256:${crypto
    .createHash("sha256")
    .update(
      `${PROTECTED_SINK_AUTHORITY_PROTOCOL}\0${String(domain || "")}\0${JSON.stringify(facts)}`,
      "utf8"
    )
    .digest("hex")}`;
}

function sha256Canonical(value?: any) : any {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function deferredRequestDigest(operationId?: any, input?: any) : any {
  return sha256Canonical({
    schemaVersion: DEFERRED_PROTECTED_SINK_AUTHORITY_PROTOCOL,
    operationId,
    input
  });
}

function exactNonEmptyText(value?: any) : any {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function exactText(value?: any) : any {
  return typeof value === "string" ? value : null;
}

function exactIsoTimestamp(value?: any, { allowEmpty = false }: Record<string, any> = {}) : any {
  if (typeof value !== "string") return null;
  if (!value && allowEmpty) return "";
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function exactJsonArray(value?: any) : any {
  if (typeof value !== "string") return null;
  try {
    const parsed: any = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exactJsonObject(value?: any) : any {
  if (typeof value !== "string") return null;
  try {
    const parsed: any = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function stableStrings(values?: any) : any {
  if (
    !Array.isArray(values) ||
    values.some((value?: any) : any => typeof value !== "string")
  ) {
    return null;
  }
  return [...new Set<any>(values.map((value?: any) : any => value.trim()).filter(Boolean))].sort();
}

function durableSessionAuthoritySource({ row, tokenHash, role }: Record<string, any>) : any {
  const sessionId: any = exactNonEmptyText(row?.session_id);
  const userId: any = exactNonEmptyText(row?.user_id);
  const tenantId: any = exactNonEmptyText(row?.tenant_id);
  const orgId: any = exactNonEmptyText(row?.org_id);
  const roleId: any = exactNonEmptyText(row?.role_id);
  const sessionCreatedAt: any = exactIsoTimestamp(row?.created_at);
  const sessionExpiresAt: any = exactIsoTimestamp(row?.expires_at);
  const userCreatedAt: any = exactIsoTimestamp(row?.user_created_at);
  const userUpdatedAt: any = exactIsoTimestamp(row?.user_updated_at);
  const currentTokenHash: any = exactNonEmptyText(tokenHash);
  const userAgentHash: any = exactText(row?.user_agent_hash);
  const teamIds: any = exactJsonArray(row?.team_ids_json);
  const departmentIds: any = exactJsonArray(row?.department_ids_json);
  const allowedWorkspaceIds: any = exactJsonArray(row?.allowed_workspace_ids_json);
  const allowedDataClasses: any = exactJsonArray(row?.allowed_data_classes_json);
  const allowedEgress: any = exactJsonArray(row?.allowed_egress_json);
  const attributes: any = exactJsonObject(row?.attributes_json);
  const stableTeamIds: any = stableStrings(teamIds);
  const stableDepartmentIds: any = stableStrings(departmentIds);
  const stableAllowedWorkspaceIds: any = stableStrings(allowedWorkspaceIds);
  const stableAllowedDataClasses: any = stableStrings(allowedDataClasses);
  const stableAllowedEgress: any = stableStrings(allowedEgress);
  const roleScopes: any = stableStrings(role?.scopes);
  if (
    !sessionId ||
    !userId ||
    !tenantId ||
    !orgId ||
    !roleId ||
    !sessionCreatedAt ||
    !sessionExpiresAt ||
    !userCreatedAt ||
    !userUpdatedAt ||
    !currentTokenHash ||
    userAgentHash === null ||
    !stableTeamIds ||
    !stableDepartmentIds ||
    !stableAllowedWorkspaceIds ||
    !stableAllowedDataClasses ||
    !stableAllowedEgress ||
    !attributes ||
    !roleScopes ||
    row?.enabled !== 1 ||
    role?.roleId !== roleId ||
    role?.enabled === false
  ) {
    return null;
  }
  return Object.freeze({
    session: Object.freeze({
      createdAt: sessionCreatedAt,
      expiresAt: sessionExpiresAt,
      sessionId,
      tokenHash: currentTokenHash,
      userAgentHash
    }),
    user: Object.freeze({
      allowedDataClasses: Object.freeze(stableAllowedDataClasses),
      allowedEgress: Object.freeze(stableAllowedEgress),
      allowedWorkspaceIds: Object.freeze(stableAllowedWorkspaceIds),
      attributes,
      createdAt: userCreatedAt,
      departmentIds: Object.freeze(stableDepartmentIds),
      enabled: true,
      orgId,
      roleId,
      roleScopes: Object.freeze(roleScopes),
      teamIds: Object.freeze(stableTeamIds),
      tenantId,
      updatedAt: userUpdatedAt,
      userId
    })
  });
}

function governancePolicyAuthorityFacts(revision?: any) : any {
  if (
    !revision ||
    typeof revision !== "object" ||
    Array.isArray(revision) ||
    !Object.prototype.hasOwnProperty.call(revision, "protocolVersion") ||
    !Object.prototype.hasOwnProperty.call(revision, "revision") ||
    !Object.prototype.hasOwnProperty.call(revision, "updatedAt")
  ) {
    return null;
  }
  const protocolVersion: any = exactNonEmptyText(revision.protocolVersion);
  const revisionNumber: any = Number(revision.revision);
  const updatedAt: any = exactIsoTimestamp(revision.updatedAt, { allowEmpty: true });
  if (
    !protocolVersion ||
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 0 ||
    updatedAt === null
  ) {
    return null;
  }
  return Object.freeze({
    protocolVersion,
    revision: revisionNumber,
    updatedAt
  });
}

function truthyApprovalFlag(value?: any) : any {
  return value === true ||
    value === 1 ||
    ["1", "true", "yes"].includes(
      String(value || "").trim().toLowerCase()
    );
}

function operationApprovalAuthorityFacts({ operation, input, request }: Record<string, any>) : any {
  const safety: any = operation?.safety;
  if (
    !safety ||
    typeof safety !== "object" ||
    Array.isArray(safety) ||
    !Object.prototype.hasOwnProperty.call(safety, "requiresConfirmation") ||
    typeof safety.requiresConfirmation !== "boolean"
  ) {
    return null;
  }
  const operationId: any = exactNonEmptyText(operation?.id);
  const risk: any = exactNonEmptyText(safety.risk);
  const approvalScope: any = exactText(safety.approvalScope);
  if (!operationId || !risk || approvalScope === null) return null;
  const requiresIndependentApproval: any =
    operation?.requiresApproval === true ||
    safety.requiresApproval === true ||
    operation?.destructive === true ||
    safety.destructive === true ||
    safety.blocked === true ||
    risk === "destructive";
  if (requiresIndependentApproval) {
    // This producer has no durable pending-operation receipt authority. Never
    // reinterpret request confirmation as a stronger approval.
    return null;
  }
  if (safety.requiresConfirmation === false) {
    return Object.freeze({
      approvalScope,
      operationId,
      requiresConfirmation: false,
      risk,
      state: "not-required"
    });
  }
  const confirmation: Readonly<Record<string, any>> = Object.freeze({
    confirm: truthyApprovalFlag(input?.confirm),
    nestedSafetyConfirm: truthyApprovalFlag(input?.safety?.confirm),
    safetyConfirm: truthyApprovalFlag(input?.safetyConfirm),
    safetyHeader: truthyApprovalFlag(
      request?.headers?.["x-meshrix-safety-confirm"]
    ),
    standardHeader: truthyApprovalFlag(
      request?.headers?.["x-meshrix-confirm"]
    )
  });
  if (!(Object.values(confirmation) as any[]).some(Boolean)) return null;
  return Object.freeze({
    approvalScope,
    confirmation,
    operationId,
    requiresConfirmation: true,
    risk,
    state: "confirmed"
  });
}

function durableApprovalIntentFacts(approval?: any) : any {
  if (!approval) return null;
  return Object.freeze({
    approvalScope: approval.approvalScope,
    confirmed:
      approval.state === "not-required" ||
      (Object.values(approval.confirmation || {}) as any[]).some(Boolean),
    operationId: approval.operationId,
    requiresConfirmation: approval.requiresConfirmation,
    risk: approval.risk,
    state: approval.state
  });
}

function operationRiskAuthorityFacts({ operation, authorizationDecision }: Record<string, any>) : any {
  const safety: any = operation?.safety;
  const operationId: any = exactNonEmptyText(operation?.id);
  const risk: any = exactNonEmptyText(safety?.risk);
  const decisionOperationId: any = exactNonEmptyText(authorizationDecision?.operationId);
  const decisionRisk: any = exactNonEmptyText(authorizationDecision?.resource?.risk);
  const effect: any = exactNonEmptyText(authorizationDecision?.effect);
  const reasonCode: any = exactNonEmptyText(authorizationDecision?.reasonCode);
  const action: any = exactNonEmptyText(authorizationDecision?.action);
  const approvalScope: any = exactText(safety?.approvalScope);
  if (
    !operationId ||
    !risk ||
    typeof operation?.readOnly !== "boolean" ||
    !Object.prototype.hasOwnProperty.call(safety, "requiresConfirmation") ||
    typeof safety?.requiresConfirmation !== "boolean" ||
    approvalScope === null ||
    !decisionOperationId ||
    decisionOperationId !== operationId ||
    !decisionRisk ||
    decisionRisk !== risk ||
    !effect ||
    !reasonCode ||
    !action ||
    authorizationDecision?.allowed !== true
  ) {
    return null;
  }
  return Object.freeze({
    action,
    approvalScope,
    blocked: safety.blocked === true,
    decisionRisk,
    destructive: safety.destructive === true,
    effect,
    operationDestructive: operation.destructive === true,
    operationId,
    readOnly: operation.readOnly,
    reasonCode,
    requiresApproval:
      operation?.requiresApproval === true || safety?.requiresApproval === true,
    requiresConfirmation: safety.requiresConfirmation,
    requiresConfirmationExplicit:
      safety.requiresConfirmationExplicit === true,
    risk
  });
}

function isProtectedSinkOperation(operation?: any) : any {
  const operationId: any = String(operation?.id || "").trim();
  return operationId === "jobs.upload_workspace_materialize" ||
    operationId === "gateway.forward" ||
    operationId.startsWith("upstream_operation.");
}

function freezeSessionSnapshot(value?: any) : any {
  const pending: any[] = [value];
  const visited: any = new WeakSet<object>();
  while (pending.length > 0) {
    const current: any = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    for (const nested of (Object.values(current) as any[])) {
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
} from "./console-auth-support.ts";

export function createConsoleAuth({ userDataPath, activeFeatureIds = [], featureScopeGrants = {}, tagManagementStore = null }: Record<string, any>) : any {
  let consoleRoles: any = createConsoleRoleCatalog({ activeFeatureIds, featureScopeGrants });
  const resources: any = createConsoleAuthResources({ userDataPath, consoleRoles, tagManagementStore });
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
  const requestSessionCache: any = new WeakMap<object, any>();
  const sessionAuthoritySources: any = new WeakMap<object, any>();

  const recordFailedLoginStmt: any = db.prepare(`
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
  const completeSuccessfulLoginStmt: any = db.prepare(`
    UPDATE console_users
    SET last_login_at = ?, updated_at = ?, failed_attempts = 0, locked_until = ''
    WHERE user_id = ?
      AND enabled = 1
      AND password_hash = ?
      AND salt = ?
      AND (COALESCE(locked_until, '') = '' OR locked_until <= ?)
  `);
  const insertConsoleSessionStmt: any = db.prepare(`
    INSERT INTO console_sessions (
      session_id, user_id, token_hash, user_agent_hash, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const commitSuccessfulLogin: any = db.transaction(({
    userRow,
    sessionId,
    tokenHash,
    userAgentHash,
    createdAt,
    expiresAt
  }: Record<string, any>) : any => {
    const updated: any = completeSuccessfulLoginStmt.run(
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

  function auditIdentityRef(value?: any, kind: any = "identity") : any {
    const text: any = String(value || "").trim();
    if (!text || SECURITY_DIGEST_PATTERN.test(text)) {
      return text;
    }
    return irreversibleSecurityDigest(text, {
      projectionKey: _csrfSecret,
      namespace: `console-audit:${kind}`
    });
  }

  function safeAuditReasonCode(value?: any, fallback: any = "") : any {
    const text: any = String(value || "").trim();
    return REASON_CODE_PATTERN.test(text) ? text : fallback;
  }

  function securityAuditProjection(value?: any, type: any = "target") : any {
    return {
      projection: CONSOLE_AUDIT_SECURITY_PROJECTION,
      type,
      summary: summarizeSecurityValue(value, {
        key: type === "target" ? "payload" : type,
        projectionKey: _csrfSecret
      })
    };
  }

  function securityAuditErrorProjection(error?: any, reasonCode: any = "") : any {
    const inferredReasonCode: any =
      safeAuditReasonCode(reasonCode) ||
      (String(error || "") ? "console_audit_error" : "");
    return {
      ...securityAuditProjection(String(error || ""), "error"),
      reasonCode: inferredReasonCode
    };
  }

  function parseSecurityAuditProjection(value?: any, type: any = "target") : any {
    const parsed: any = parseJson(value, null);
    const summary: any = parsed?.summary;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.projection === CONSOLE_AUDIT_SECURITY_PROJECTION &&
      parsed.type === type &&
      summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      Object.keys(parsed).every((key?: any) : any =>
        (type === "error"
          ? ["projection", "reasonCode", "summary", "type"]
          : ["projection", "summary", "type"]
        ).includes(key)
      ) &&
      summary.metadataOnly === true &&
      Object.keys(summary).every((key?: any) : any => SECURITY_METADATA_KEYS.has(key)) &&
      SECURITY_METADATA_TYPES.has(summary.type) &&
      /^[a-f0-9]{16}$/i.test(summary.sha256 || "") &&
      summary.hashAlgorithm === "hmac-sha256" &&
      (!summary.reason || SECURITY_METADATA_REASONS.has(summary.reason)) &&
      ["byteLength", "keyCount", "length"].every((key?: any) : any =>
        summary[key] === undefined || (Number.isInteger(summary[key]) && summary[key] >= 0)
      ) &&
      (summary.redacted === undefined || typeof summary.redacted === "boolean") &&
      (type !== "error" || !parsed.reasonCode || safeAuditReasonCode(parsed.reasonCode) === parsed.reasonCode)
    ) {
      return parsed;
    }
    return null;
  }

  function computeCsrfToken(rawSessionToken?: any) : any {
    return "csrf_" + crypto
      .createHmac("sha256", _csrfSecret)
      .update(String(rawSessionToken || ""))
      .digest("base64url");
  }

  function hasUsers() : any {
    return Number(countUsersStmt.get()?.count || 0) > 0;
  }

  function resolveRole(roleId: any = "viewer") : any {
    return authorizationGovernanceStore.getRole(roleId) ||
      consoleRoles[roleId] ||
      authorizationGovernanceStore.getRole("viewer") ||
      consoleRoles.viewer;
  }

  function normalizeConsoleRole(value?: any) : any {
    const roleId: any = String(value || "viewer").trim();
    const role: any = resolveRole(roleId);
    if (!role || role.roleId !== roleId || role.enabled === false) {
      throw new Error(`未知角色：${roleId}`);
    }
    return roleId;
  }

  function publicUserWithGovernanceRole(row?: any) : any {
    const user: any = publicUser(row, consoleRoles);
    if (!user) {
      return null;
    }
    const role: any = resolveRole(user.roleId);
    return {
      ...user,
      roleLabel: role.label,
      scopes: role.scopes || []
    };
  }

  async function ensureInitialOwner() : Promise<any> {
    if (hasUsers()) {
      return { created: false };
    }

    const username: any = "owner";
    const password: any = randomToken("sap_");
    const user: any = await createUser({
      username,
      displayName: "Owner",
      password,
      roleId: "owner",
      orgId: MESHRIX_ROOT_ORGANIZATION_ID,
      enabled: true
    });
    return {
      created: true,
      user,
      username,
      password
    };
  }

  function getBootstrapStatus() : any {
    return {
      required: false,
      tokenPrefix: "",
      tokenFilePath: ""
    };
  }

  function roleList() : any {
    return authorizationGovernanceStore.listRoles();
  }

  function refreshActiveFeatureIds(nextActiveFeatureIds: any = []) : any {
    const nextRoles: any = createConsoleRoleCatalog({ activeFeatureIds: nextActiveFeatureIds, featureScopeGrants });
    for (const role of (Object.values(nextRoles) as any[])) {
      const existing: any = authorizationGovernanceStore.getRole(role.roleId);
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

  function sessionFromToken(token?: any, request: any = null, allowInactivityRetry: any = true) : any {
    if (!token) {
      return null;
    }
    const tokenHash: any = hashToken(token);
    const row: any = getSessionByTokenHashStmt.get(tokenHash);
    if (!row || !row.enabled) {
      return null;
    }
    const currentTimeMs: any = Date.now();
    const expiresAtMs: any = Date.parse(row.expires_at);
    const lastSeenMs: any = Date.parse(row.last_seen_at);
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
      const deleted: any = deleteSessionByStateStmt.run(
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
    const role: any = resolveRole(row.role_id);
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
      const incomingUaHash: any = hashToken(request?.headers?.["user-agent"] || "");
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
    const csrfToken: any = computeCsrfToken(token);
    const session: any = freezeSessionSnapshot({
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
        tenantId: row.tenant_id,
        orgId: row.org_id,
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
    const authoritySource: any = durableSessionAuthoritySource({
      row,
      role,
      tokenHash
    });
    if (authoritySource) sessionAuthoritySources.set(session, authoritySource);
    return session;
  }

  function getSessionFromRequest(request?: any, { fresh = false }: Record<string, any> = {}) : any {
    const cacheableRequest: any = request !== null &&
      (typeof request === "object" || typeof request === "function");
    if (!fresh && cacheableRequest && requestSessionCache.has(request)) {
      const cachedSession: any = requestSessionCache.get(request);
      if (!cachedSession) return null;
      const expiresAtMs: any = Date.parse(cachedSession.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        requestSessionCache.set(request, null);
        return null;
      }
      return cachedSession;
    }
    const cookies: any = parseCookies(request);
    const cookieToken: any = cookies[CONSOLE_SESSION_COOKIE] || "";
    const session: any = sessionFromToken(cookieToken, request);
    if (cacheableRequest) requestSessionCache.set(request, session);
    return session;
  }

  function sessionAuthorityRevision(session?: any) : any {
    const source: any = sessionAuthoritySources.get(session);
    return source
      ? authorityDigest("durable-session-authority-source", source)
      : "";
  }

  function protectedSinkAuthorityFromSource({
    source,
    operation,
    input,
    request,
    authorizationDecision,
    governancePolicyRevision
  }: Record<string, any>) : any {
    const policy: any = governancePolicyAuthorityFacts(governancePolicyRevision);
    const approval: any = operationApprovalAuthorityFacts({
      operation,
      input,
      request
    });
    const durableApproval: any = durableApprovalIntentFacts(approval);
    const risk: any = operationRiskAuthorityFacts({
      operation,
      authorizationDecision
    });
    if (!source || !policy || !durableApproval || !risk) return null;
    const subjectGeneration: any = authorityDigest(
      "console-user-generation",
      source.user
    );
    return Object.freeze({
      subject: Object.freeze({
        generation: subjectGeneration,
        subjectId: source.user.userId,
        tenantId: source.user.tenantId,
        type: "console-user"
      }),
      context: Object.freeze({
        approvalRevision: authorityDigest(
          "operation-approval-revision",
          durableApproval
        ),
        grantRevision: authorityDigest(
          "console-session-grant-revision",
          Object.freeze({
            session: source.session,
            subjectGeneration
          })
        ),
        policyRevision: authorityDigest(
          "governance-policy-revision",
          policy
        ),
        riskRevision: authorityDigest(
          "operation-risk-revision",
          risk
        ),
        workloadGeneration: authorityDigest(
          "console-session-workload-generation",
          Object.freeze({
            createdAt: source.session.createdAt,
            sessionId: source.session.sessionId,
            subjectGeneration,
            tokenHash: source.session.tokenHash
          })
        )
      })
    });
  }

  function protectedSinkAuthority(input?: any) : any {
    return protectedSinkAuthorityFromSource({
      ...input,
      source: sessionAuthoritySources.get(input.session)
    });
  }

  const readDeferredAuthorityStmt: any = db.prepare(`
    SELECT authority_ref, session_id, operation_id, request_digest,
           approval_intent_digest, issued_at, expires_at, revoked_at,
           reason_code
    FROM console_deferred_protected_sink_authorities
    WHERE authority_ref = ?
  `);
  const readDeferredSessionStmt: any = db.prepare(`
    SELECT s.session_id, s.user_id, s.token_hash, s.user_agent_hash,
           s.created_at, s.last_seen_at, s.expires_at,
           u.username, u.display_name, u.role_id, u.enabled,
           u.tenant_id, u.org_id, u.team_ids_json,
           u.department_ids_json, u.allowed_workspace_ids_json,
           u.allowed_data_classes_json, u.allowed_egress_json,
           u.attributes_json, u.created_at AS user_created_at,
           u.updated_at AS user_updated_at, u.last_login_at
    FROM console_sessions s
    JOIN console_users u ON u.user_id = s.user_id
    WHERE s.session_id = ?
  `);
  const insertDeferredAuthorityStmt: any = db.prepare(`
    INSERT INTO console_deferred_protected_sink_authorities (
      authority_ref, session_id, operation_id, request_digest,
      approval_intent_digest, issued_at, expires_at, revoked_at,
      reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '')
  `);
  const revokeDeferredAuthorityStmt: any = db.prepare(`
    UPDATE console_deferred_protected_sink_authorities
    SET revoked_at = CASE WHEN revoked_at = '' THEN ? ELSE revoked_at END,
        reason_code = CASE WHEN revoked_at = '' THEN ? ELSE reason_code END
    WHERE authority_ref = ?
  `);

  function currentDeferredSession(sessionId?: any) : any {
    const row: any = readDeferredSessionStmt.get(sessionId);
    if (!row || row.enabled !== 1 || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    const role: any = resolveRole(row.role_id);
    const source: any = durableSessionAuthoritySource({
      row,
      role,
      tokenHash: row.token_hash
    });
    if (!source) return null;
    return Object.freeze({
      role,
      row,
      source,
      session: freezeSessionSnapshot({
        sessionId: row.session_id,
        expiresAt: row.expires_at,
        user: {
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name || row.username,
          roleId: row.role_id,
          roleLabel: role.label,
          scopes: [...role.scopes],
          tenantId: row.tenant_id,
          orgId: row.org_id,
          teamIds: parseJson(row.team_ids_json, []),
          departmentIds: parseJson(row.department_ids_json, []),
          allowedWorkspaceIds: parseJson(
            row.allowed_workspace_ids_json,
            []
          ),
          allowedDataClasses: parseJson(
            row.allowed_data_classes_json,
            []
          ),
          allowedEgress: parseJson(row.allowed_egress_json, []),
          attributes: parseJson(row.attributes_json, {}),
          enabled: true,
          createdAt: row.user_created_at,
          updatedAt: row.user_updated_at,
          lastLoginAt: row.last_login_at || ""
        }
      })
    });
  }

  async function evaluateDeferredCurrentAuthority({
    operation,
    input,
    sessionState
  }: Record<string, any>) : Promise<any> {
    const governancePolicyRevision: any =
      authorizationGovernanceStore.getPolicyRevision();
    const authorizationDecision: any = await authorizationEngine.evaluate({
      operation,
      request: null,
      authSession: sessionState.session,
      input: buildConsoleOperationAuthorizationInput({
        input,
        method: "POST",
        url: { pathname: "/api/jobs/upload-workspace-materializations" }
      }),
      context: buildConsoleOperationAuthorizationContext({
        context: {
          authorizationPhase: "final-protected-sink"
        }
      }),
      enforceConfirmation: false
    });
    if (authorizationDecision?.allowed !== true) return null;
    const authority: any = protectedSinkAuthorityFromSource({
      source: sessionState.source,
      operation,
      input,
      request: null,
      authorizationDecision,
      governancePolicyRevision
    });
    const approval: any = durableApprovalIntentFacts(
      operationApprovalAuthorityFacts({
        operation,
        input,
        request: null
      })
    );
    if (!authority || !approval) return null;
    return Object.freeze({
      approvalIntentDigest: sha256Canonical(approval),
      authority,
      authorityBindingDigest: sha256Canonical(authority),
      authorizationDecision
    });
  }

  async function captureDeferredProtectedSinkAuthority({
    request,
    authSession,
    operation,
    input
  }: Record<string, any> = {}) : Promise<any> {
    const operationId: any = exactNonEmptyText(operation?.id);
    if (
      operationId !== "jobs.upload_workspace_materialize" ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      throw Object.assign(
        new Error("Deferred protected sink authority input is invalid."),
        {
          code: "deferred_protected_sink_authority_invalid",
          statusCode: 403
        }
      );
    }
    const authorization: any = await authorizeOperation({
      request,
      operation,
      method: String(request?.method || "POST"),
      url: new URL(
        String(request?.url || "/api/jobs/upload-workspace-materializations"),
        "http://console.local"
      ),
      input,
      context: {
        authorizationPhase: "admission"
      },
      phase: "admission"
    });
    const authorizedSession: any = authorization?.session;
    if (
      authorization?.ok !== true ||
      !authorizedSession ||
      authorizedSession.sessionId !== authSession?.sessionId ||
      !sessionAuthorityRevision(authSession) ||
      sessionAuthorityRevision(authSession) !==
        sessionAuthorityRevision(authorizedSession) ||
      !authorization.protectedSinkAuthority
    ) {
      throw Object.assign(
        new Error("Deferred protected sink authority capture was denied."),
        {
          code: "deferred_protected_sink_authority_denied",
          statusCode: 403
        }
      );
    }
    const approval: any = durableApprovalIntentFacts(
      operationApprovalAuthorityFacts({
        operation,
        input,
        request
      })
    );
    if (!approval) {
      throw Object.assign(
        new Error("Deferred protected sink approval intent is unavailable."),
        {
          code: "deferred_protected_sink_authority_denied",
          statusCode: 403
        }
      );
    }
    const authorityRef: any =
      `deferred-authority:${crypto.randomBytes(24).toString("base64url")}`;
    const requestDigest: any = deferredRequestDigest(operationId, input);
    const approvalIntentDigest: any = sha256Canonical(approval);
    const authorityBindingDigest: any = sha256Canonical(
      authorization.protectedSinkAuthority
    );
    const issuedAt: any = nowIso();
    const expiresAt: any = new Date(
      Math.min(
        Date.parse(authorizedSession.expiresAt),
        Date.now() + SESSION_TTL_MS
      )
    ).toISOString();
    db.prepare(`
      DELETE FROM console_deferred_protected_sink_authorities
      WHERE expires_at <= ? OR revoked_at != ''
    `).run(issuedAt);
    insertDeferredAuthorityStmt.run(
      authorityRef,
      authorizedSession.sessionId,
      operationId,
      requestDigest,
      approvalIntentDigest,
      issuedAt,
      expiresAt
    );
    return Object.freeze({
      approvalIntentDigest,
      authorityBindingDigest,
      authorityRef,
      requestDigest
    });
  }

  async function revalidateDeferredProtectedSinkAuthority({
    authorityRef,
    operation,
    input,
    requestDigest,
    authorityBindingDigest
  }: Record<string, any> = {}) : Promise<any> {
    const row: any = readDeferredAuthorityStmt.get(
      exactNonEmptyText(authorityRef)
    );
    const operationId: any = exactNonEmptyText(operation?.id);
    const currentRequestDigest: any =
      operationId && input && typeof input === "object" && !Array.isArray(input)
        ? deferredRequestDigest(operationId, input)
        : "";
    if (
      !row ||
      row.operation_id !== operationId ||
      row.request_digest !== requestDigest ||
      row.request_digest !== currentRequestDigest ||
      row.revoked_at ||
      Date.parse(row.expires_at) <= Date.now()
    ) {
      return Object.freeze({
        allowed: false,
        reasonCode: "deferred_protected_sink_authority_unavailable",
        revoked: Boolean(row?.revoked_at)
      });
    }
    const sessionState: any = currentDeferredSession(row.session_id);
    const current: any = sessionState
      ? await evaluateDeferredCurrentAuthority({
          operation,
          input,
          sessionState
        })
      : null;
    if (
      !current ||
      current.approvalIntentDigest !== row.approval_intent_digest ||
      current.authorityBindingDigest !== authorityBindingDigest
    ) {
      return Object.freeze({
        allowed: false,
        reasonCode: "deferred_protected_sink_authority_changed",
        revoked: false
      });
    }
    return Object.freeze({
      allowed: true,
      approvalIntentDigest: current.approvalIntentDigest,
      authorityBindingDigest: current.authorityBindingDigest,
      authorizationDecision: current.authorizationDecision,
      context: current.authority.context,
      revoked: false,
      subject: current.authority.subject
    });
  }

  async function revokeDeferredProtectedSinkAuthority({
    authorityRef,
    reason = "deferred_authority_revoked"
  }: Record<string, any> = {}) : Promise<any> {
    const reasonCode: any = String(reason || "")
      .trim()
      .replace(/[^A-Za-z0-9._:-]/gu, "_")
      .slice(0, 160) || "deferred_authority_revoked";
    const result: any = revokeDeferredAuthorityStmt.run(
      nowIso(),
      reasonCode,
      exactNonEmptyText(authorityRef)
    );
    return Object.freeze({
      revoked: Number(result.changes || 0) === 1
    });
  }

  async function createUser(input: Record<string, any> = {}) : Promise<any> {
    const username: any = normalizeUsername(input.username);
    const normalizedCredential: any = normalizePassword(input.password || input.newPassword);
    const roleId: any = normalizeConsoleRole(input.roleId || "viewer");
    const userId: any = stableId("console_user", username, Date.now(), crypto.randomUUID());
    const { salt, passwordHash } = await hashPassword(normalizedCredential);
    const createdAt: any = nowIso();
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
      String(input.orgId || MESHRIX_ROOT_ORGANIZATION_ID).trim(),
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

  async function login(input: Record<string, any> = {}, request?: any) : Promise<any> {
    const username: any = normalizeUsername(input.username);
    const password: any = String(input.password || "");
    const userRow: any = getUserByUsernameStmt.get(username);
    if (!userRow || !userRow.enabled) {
      // Constant-time guard: don't reveal whether username exists.
      await verifyPassword("__sentinel__", "salt", "hash").catch(() : any => {});
      throw new Error("用户名或密码错误。");
    }

    // Check lockout before touching the password.
    const lockedUntil: any = userRow.locked_until ? new Date(userRow.locked_until).getTime() : 0;
    if (lockedUntil > Date.now()) {
      const remainingMin: any = Math.ceil((lockedUntil - Date.now()) / 60_000);
      throw new Error(`账户已被临时锁定，请 ${remainingMin} 分钟后重试。`);
    }

    const ok: any = await verifyPassword(password, userRow.salt, userRow.password_hash);
    if (!ok) {
      const failedAt: any = nowIso();
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

    const token: any = randomToken();
    // M-3: CSRF is HMAC-derived from the session token — not stored in DB
    const csrfToken: any = computeCsrfToken(token);
    const sessionId: any = stableId("console_session", userRow.user_id, Date.now(), crypto.randomUUID());
    const createdAt: any = nowIso();
    const expiresAt: any = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const committed: any = commitSuccessfulLogin({
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
    fsp.unlink(path.join(rootPath, "initial-credentials.txt")).catch(() : any => {});

    const session: any = sessionFromToken(token);
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

  function logout(request?: any) : any {
    const cookies: any = parseCookies(request);
    const token: any = cookies[CONSOLE_SESSION_COOKIE] || "";
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

  function rotateSession(request?: any) : any {
    const cookies: any = parseCookies(request);
    const currentToken: any = cookies[CONSOLE_SESSION_COOKIE] || "";
    const currentSession: any = sessionFromToken(currentToken, request);
    if (!currentSession) {
      return { ok: false, status: 401, error: "控制台未登录。" };
    }
    const token: any = randomToken();
    const csrfToken: any = computeCsrfToken(token);
    const rotatedAt: any = nowIso();
    const expiresAt: any = new Date(Date.now() + SESSION_TTL_MS).toISOString();
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
    const session: any = sessionFromToken(token, request);
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

  async function updateUser(userId?: any, patch: Record<string, any> = {}) : Promise<any> {
    const normalizedUserId: any = String(userId || "");
    if (!getUserByIdStmt.get(normalizedUserId)) return null;

    const normalizedPatch: Record<string, any> = {
      displayName: patch.displayName !== undefined ? String(patch.displayName || "").trim() : undefined,
      roleId: patch.roleId !== undefined ? normalizeConsoleRole(patch.roleId) : undefined,
      enabled: patch.enabled !== undefined ? (patch.enabled === false ? 0 : 1) : undefined,
      tenantId: patch.tenantId !== undefined ? normalizeTenantId(patch.tenantId) : undefined,
      orgId: patch.orgId !== undefined
        ? String(patch.orgId || MESHRIX_ROOT_ORGANIZATION_ID).trim()
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
    const credential: any = patch.password || patch.newPassword
      ? await hashPassword(normalizePassword(patch.password || patch.newPassword))
      : null;

    const commitUpdate: any = db.transaction(() : any => {
      const current: any = getUserByIdStmt.get(normalizedUserId);
      if (!current) return null;
      const updates: Record<string, any> = {
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
    const updatedRow: any = typeof commitUpdate.immediate === "function"
      ? commitUpdate.immediate()
      : commitUpdate();
    return publicUserWithGovernanceRole(updatedRow);
  }

  function listUsers() : any {
    return listUsersStmt.all().map(publicUserWithGovernanceRole);
  }

  function listSessions() : any {
    return db.prepare(`
      SELECT s.session_id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, u.username, u.role_id
      FROM console_sessions s
      JOIN console_users u ON u.user_id = s.user_id
      ORDER BY s.last_seen_at DESC
      LIMIT 200
    `).all().map((row?: any) : any => ({
      sessionId: row.session_id,
      userId: row.user_id,
      username: row.username,
      roleId: row.role_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at
    }));
  }

  function revokeSession(sessionId?: any) : any {
    const result: any = deleteSessionByIdStmt.run(String(sessionId || ""));
    return { ok: Number(result.changes || 0) > 0 };
  }

  function getOidcConfig() : any {
    const row: any = db.prepare("SELECT * FROM console_oidc_config WHERE config_id = 'default'").get();
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

  function setOidcConfig(input: Record<string, any> = {}) : any {
    const current: any = getOidcConfig();
    const clientSecret: any = String(input.clientSecret || "").trim();
    const next: Record<string, any> = {
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

  function audit(input: Record<string, any> = {}) : any {
    if (!hasUsers()) {
      return;
    }
    const user: any = input.user || {};
    const targetProjection: any = securityAuditProjection(input.target || {}, "target");
    const errorProjection: any = securityAuditErrorProjection(input.error, input.reasonCode);
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

  function listAudit({ limit = 100, userId = "", status = "" }: Record<string, any> = {}) : any {
    const safeLimit: any = Math.max(1, Math.min(Number(limit || 100), 500));
    const clauses: any[] = [];
    const params: any[] = [];
    if (userId) {
      clauses.push("user_id = ?");
      params.push(auditIdentityRef(userId, "user-id"));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    }
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT * FROM console_audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, safeLimit).map((row?: any) : any => {
      const targetProjection: any = parseSecurityAuditProjection(row.target_json, "target") ||
        securityAuditProjection({}, "target");
      const errorProjection: any = parseSecurityAuditProjection(row.error, "error") ||
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

  async function authorizeOperation({
    request,
    operation,
    method,
    url,
    input = {},
    context = {},
    phase = ""
  }: Record<string, any> = {}) : Promise<any> {
    const publicAccess: any = operation?.public === true;
    const authorizationPhase: any = String(
      phase || context?.authorizationPhase || ""
    ).trim();
    const protectedSinkAuthorityPhase: any =
      PROTECTED_SINK_AUTHORITY_PHASES.has(authorizationPhase) &&
      isProtectedSinkOperation(operation);
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
    const session: any = getSessionFromRequest(request, {
      fresh: protectedSinkAuthorityPhase
    });
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
    const governancePolicyRevisionBefore: any =
      authorizationGovernanceStore.getPolicyRevision();
    const policyFactsBefore: any =
      governancePolicyAuthorityFacts(governancePolicyRevisionBefore);
    const authorizationDecision: any = await authorizationEngine.evaluate({
      operation,
      request,
      authSession: session,
      input: buildConsoleOperationAuthorizationInput({ input, method, url }),
      context: buildConsoleOperationAuthorizationContext({ context }),
      enforceConfirmation: false
    });
    const governancePolicyRevision: any =
      authorizationGovernanceStore.getPolicyRevision();
    const policyFactsAfter: any =
      governancePolicyAuthorityFacts(governancePolicyRevision);
    if (
      protectedSinkAuthorityPhase &&
      (
        !policyFactsBefore ||
        !policyFactsAfter ||
        authorityDigest("governance-policy-revision", policyFactsBefore) !==
          authorityDigest("governance-policy-revision", policyFactsAfter)
      )
    ) {
      return {
        ok: false,
        status: 503,
        reasonCode: "authorization_policy_changed",
        error: "Authorization policy changed during revalidation.",
        session,
        authorizationDecision
      };
    }
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
      const missingScopes: any = authorizationDecision.missingScopes || [];
      const missingCapabilities: any = authorizationDecision.missingCapabilities || [];
      const scopeSuffix: any = missingCapabilities.length > 0
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
    const needsCsrf: any =
      !operation?.skipCsrf &&
      !safeRequestMethod(method);
    if (needsCsrf) {
      const csrf: any = String(request?.headers?.["x-meshrix-csrf"] || "").trim();
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
    let currentSession: any = session;
    if (protectedSinkAuthorityPhase) {
      currentSession = getSessionFromRequest(request, { fresh: true });
      if (
        !currentSession ||
        !sessionAuthorityRevision(session) ||
        sessionAuthorityRevision(session) !==
          sessionAuthorityRevision(currentSession)
      ) {
        return {
          ok: false,
          status: 403,
          reasonCode: "console_session_authority_changed",
          error: "Console session authority changed during revalidation.",
          session: currentSession,
          authorizationDecision
        };
      }
    }
    const currentProtectedSinkAuthority: any = protectedSinkAuthority({
      session: currentSession,
      operation,
      input,
      request,
      authorizationDecision,
      governancePolicyRevision
    });
    if (protectedSinkAuthorityPhase && !currentProtectedSinkAuthority) {
      return {
        ok: false,
        status: 403,
        reasonCode: "final_protected_sink_authority_unavailable",
        error: "Current protected sink authority facts are unavailable.",
        session: currentSession,
        authorizationDecision
      };
    }
    return {
      ok: true,
      session: currentSession,
      authorizationDecision,
      governancePolicyRevision,
      ...(currentProtectedSinkAuthority
        ? { protectedSinkAuthority: currentProtectedSinkAuthority }
        : {})
    };
  }

  function getSummary(request: any = null) : any {
    const session: any = request ? getSessionFromRequest(request) : null;
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
    captureDeferredProtectedSinkAuthority,
    revalidateDeferredProtectedSinkAuthority,
    revokeDeferredProtectedSinkAuthority,
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
