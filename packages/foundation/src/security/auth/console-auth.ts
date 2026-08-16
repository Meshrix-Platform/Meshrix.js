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
import {
  createConsoleAuthResources,
  type ConsoleAuthResourceOptions,
  type ConsoleAuthResources,
  type ConsoleSessionDbRow,
  type ConsoleUserDbRow
} from "./console-auth-resources.ts";

const CONSOLE_AUDIT_SECURITY_PROJECTION = "console-audit-security-metadata";
const PROTECTED_SINK_AUTHORITY_PROTOCOL =
  "v0.0.1:final-protected-sink:console-authority-1";
const DEFERRED_PROTECTED_SINK_AUTHORITY_PROTOCOL =
  "v0.0.1:final-protected-sink:deferred-console-authority-1";
const PROTECTED_SINK_AUTHORITY_PHASES = new Set([
  "admission",
  "execution",
  "final-protected-sink"
]);
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

interface HttpRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string; encrypted?: boolean };
}

interface SafetyFacts extends Record<string, unknown> {
  risk?: unknown;
  approvalScope?: unknown;
  requiresConfirmation?: unknown;
  requiresConfirmationExplicit?: unknown;
  requiresApproval?: unknown;
  destructive?: unknown;
  blocked?: unknown;
  confirm?: unknown;
}

interface OperationFacts extends Record<string, unknown> {
  id?: string;
  public?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresApproval?: boolean;
  authorizationPhase?: unknown;
  skipCsrf?: boolean;
  safety?: SafetyFacts;
}

interface DecisionFacts extends Record<string, unknown> {
  allowed?: boolean;
  operationId?: unknown;
  effect?: unknown;
  reasonCode?: unknown;
  action?: unknown;
  resource?: { risk?: unknown };
}

interface ApprovalFacts extends Record<string, unknown> {
  approvalScope?: unknown;
  state?: unknown;
  confirmation?: Record<string, unknown>;
  operationId?: unknown;
  requiresConfirmation?: unknown;
  risk?: unknown;
}

interface ConsoleInput extends Record<string, unknown> {
  confirm?: unknown;
  safetyConfirm?: unknown;
  safety?: SafetyFacts;
}

interface ConsoleSessionUser extends Record<string, unknown> {
  userId: string;
  username: string;
  displayName: string;
  roleId: string;
  scopes: string[];
  tenantId: string;
  orgId: string;
}

interface ConsoleSession extends Record<string, unknown> {
  sessionId: string;
  csrfToken?: string;
  expiresAt: string;
  user: ConsoleSessionUser;
}

interface DurableAuthoritySource extends Record<string, unknown> {
  session: Record<string, unknown>;
  user: Record<string, unknown>;
}

interface RoleFacts extends Record<string, unknown> {
  roleId: string;
  label?: string;
  scopes?: string[];
  enabled?: boolean;
  system?: boolean;
}

interface DeferredAuthorityRow {
  authority_ref: string;
  session_id: string;
  operation_id: string;
  request_digest: string;
  approval_intent_digest: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string;
  reason_code: string;
}

interface DeferredSessionState {
  role: RoleFacts;
  row: ConsoleSessionDbRow;
  source: DurableAuthoritySource;
  session: ConsoleSession;
}

interface ProtectedSinkInput {
  session: ConsoleSession;
  operation: OperationFacts;
  input: ConsoleInput;
  request?: HttpRequestLike | null;
  authorizationDecision: DecisionFacts;
  governancePolicyRevision?: unknown;
}

interface DeferredCaptureInput {
  request?: HttpRequestLike;
  authSession?: ConsoleSession;
  operation?: OperationFacts;
  input?: ConsoleInput;
}

interface DeferredRevalidationInput {
  authorityRef?: unknown;
  operation?: OperationFacts;
  input?: ConsoleInput;
  requestDigest?: unknown;
  authorityBindingDigest?: unknown;
}

interface DeferredRevocationInput {
  authorityRef?: unknown;
  reason?: unknown;
}

interface SessionListRow {
  session_id: string;
  user_id: string;
  username: string;
  role_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

interface OidcConfigRow {
  enabled: number;
  issuer: string;
  client_id: string;
  client_secret_configured: number;
  redirect_uri: string;
  allowed_domains_json: string;
  role_mapping_json: string;
  updated_at: string;
}

interface AuditRow {
  audit_id: string;
  user_id: string;
  username: string;
  operation_id: string;
  action: string;
  method: string;
  path: string;
  status: string;
  target_json: string;
  error: string;
  created_at: string;
}

interface AuditInput extends Record<string, unknown> {
  user?: Partial<ConsoleSessionUser>;
  reasonCode?: unknown;
}

interface AuditQuery {
  limit?: number;
  userId?: string;
  status?: string;
}

interface AuthorizationInput {
  request?: HttpRequestLike | null;
  operation?: OperationFacts;
  method?: string;
  url?: URL | null;
  input?: ConsoleInput;
  context?: Record<string, unknown>;
  phase?: string;
}

interface AuthorizationResult {
  ok: boolean;
  status?: number;
  error?: string;
  setupMode?: boolean;
  bootstrap?: ReturnType<typeof getEmptyBootstrapStatus>;
  reasonCode?: string;
  session?: ConsoleSession | null;
  authorizationDecision?: DecisionFacts;
  governancePolicyRevision?: unknown;
  protectedSinkAuthority?: Readonly<Record<string, unknown>>;
}

function getEmptyBootstrapStatus() {
  return { required: false, tokenPrefix: "", tokenFilePath: "" };
}

function authorityDigest(domain?: unknown, facts?: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(
      `${PROTECTED_SINK_AUTHORITY_PROTOCOL}\0${String(domain || "")}\0${JSON.stringify(facts)}`,
      "utf8"
    )
    .digest("hex")}`;
}

function sha256Canonical(value?: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function deferredRequestDigest(operationId?: unknown, input?: unknown): string {
  return sha256Canonical({
    schemaVersion: DEFERRED_PROTECTED_SINK_AUTHORITY_PROTOCOL,
    operationId,
    input
  });
}

function exactNonEmptyText(value?: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function exactText(value?: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function exactIsoTimestamp(value?: unknown, { allowEmpty = false }: { allowEmpty?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  if (!value && allowEmpty) return "";
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function exactJsonArray(value?: unknown): unknown[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exactJsonObject(value?: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stableStrings(values?: unknown): string[] | null {
  if (
    !Array.isArray(values) ||
    values.some((value)  => typeof value !== "string")
  ) {
    return null;
  }
  return [...new Set(values.map((value)  => value.trim()).filter(Boolean))].sort();
}

function durableSessionAuthoritySource({
  row,
  tokenHash,
  role
}: {
  row: ConsoleSessionDbRow;
  tokenHash: unknown;
  role: RoleFacts | null;
}): Readonly<DurableAuthoritySource> | null {
  const sessionId = exactNonEmptyText(row?.session_id);
  const userId = exactNonEmptyText(row?.user_id);
  const tenantId = exactNonEmptyText(row?.tenant_id);
  const orgId = exactNonEmptyText(row?.org_id);
  const roleId = exactNonEmptyText(row?.role_id);
  const sessionCreatedAt = exactIsoTimestamp(row?.created_at);
  const sessionExpiresAt = exactIsoTimestamp(row?.expires_at);
  const userCreatedAt = exactIsoTimestamp(row?.user_created_at);
  const userUpdatedAt = exactIsoTimestamp(row?.user_updated_at);
  const currentTokenHash = exactNonEmptyText(tokenHash);
  const userAgentHash = exactText(row?.user_agent_hash);
  const teamIds = exactJsonArray(row?.team_ids_json);
  const departmentIds = exactJsonArray(row?.department_ids_json);
  const allowedWorkspaceIds = exactJsonArray(row?.allowed_workspace_ids_json);
  const allowedDataClasses = exactJsonArray(row?.allowed_data_classes_json);
  const allowedEgress = exactJsonArray(row?.allowed_egress_json);
  const attributes = exactJsonObject(row?.attributes_json);
  const stableTeamIds = stableStrings(teamIds);
  const stableDepartmentIds = stableStrings(departmentIds);
  const stableAllowedWorkspaceIds = stableStrings(allowedWorkspaceIds);
  const stableAllowedDataClasses = stableStrings(allowedDataClasses);
  const stableAllowedEgress = stableStrings(allowedEgress);
  const roleScopes = stableStrings(role?.scopes);
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

function governancePolicyAuthorityFacts(revision?: unknown) {
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
  const revisionRecord = revision as Record<string, unknown>;
  const protocolVersion = exactNonEmptyText(revisionRecord.protocolVersion);
  const revisionNumber = Number(revisionRecord.revision);
  const updatedAt = exactIsoTimestamp(revisionRecord.updatedAt, { allowEmpty: true });
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

function truthyApprovalFlag(value?: unknown): boolean {
  return value === true ||
    value === 1 ||
    ["1", "true", "yes"].includes(
      String(value || "").trim().toLowerCase()
    );
}

function operationApprovalAuthorityFacts({ operation, input, request }: {
  operation: OperationFacts;
  input: ConsoleInput;
  request?: HttpRequestLike | null;
}) {
  const safety = operation?.safety;
  if (
    !safety ||
    typeof safety !== "object" ||
    Array.isArray(safety) ||
    !Object.prototype.hasOwnProperty.call(safety, "requiresConfirmation") ||
    typeof safety.requiresConfirmation !== "boolean"
  ) {
    return null;
  }
  const operationId = exactNonEmptyText(operation?.id);
  const risk = exactNonEmptyText(safety.risk);
  const approvalScope = exactText(safety.approvalScope);
  if (!operationId || !risk || approvalScope === null) return null;
  const requiresIndependentApproval =
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
  const confirmation: Readonly<Record<string, unknown>> = Object.freeze({
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
  if (!(Object.values(confirmation) as unknown[]).some(Boolean)) return null;
  return Object.freeze({
    approvalScope,
    confirmation,
    operationId,
    requiresConfirmation: true,
    risk,
    state: "confirmed"
  });
}

function durableApprovalIntentFacts(approval?: ApprovalFacts | null) {
  if (!approval) return null;
  return Object.freeze({
    approvalScope: approval.approvalScope,
    confirmed:
      approval.state === "not-required" ||
      (Object.values(approval.confirmation || {}) as unknown[]).some(Boolean),
    operationId: approval.operationId,
    requiresConfirmation: approval.requiresConfirmation,
    risk: approval.risk,
    state: approval.state
  });
}

function operationRiskAuthorityFacts({ operation, authorizationDecision }: {
  operation: OperationFacts;
  authorizationDecision: DecisionFacts;
}) {
  const safety = operation?.safety;
  const operationId = exactNonEmptyText(operation?.id);
  const risk = exactNonEmptyText(safety?.risk);
  const decisionOperationId = exactNonEmptyText(authorizationDecision?.operationId);
  const decisionRisk = exactNonEmptyText(authorizationDecision?.resource?.risk);
  const effect = exactNonEmptyText(authorizationDecision?.effect);
  const reasonCode = exactNonEmptyText(authorizationDecision?.reasonCode);
  const action = exactNonEmptyText(authorizationDecision?.action);
  const approvalScope = exactText(safety?.approvalScope);
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

function isProtectedSinkOperation(operation?: OperationFacts): boolean {
  const operationId = String(operation?.id || "").trim();
  return operationId === "jobs.upload_workspace_materialize" ||
    operationId === "gateway.forward" ||
    operationId.startsWith("upstream_operation.");
}

function freezeSessionSnapshot<T>(value: T): T {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    for (const nested of (Object.values(current) as unknown[])) {
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

export type ConsoleAuthOptions = Omit<ConsoleAuthResourceOptions, "consoleRoles"> & {
  consoleRoles?: ConsoleAuthResourceOptions["consoleRoles"];
  activeFeatureIds?: unknown[];
  featureScopeGrants?: Record<string, Record<string, readonly string[]>>;
};

export type ConsoleAuthDatabase = ConsoleAuthResources["db"];

interface ConsoleAuthContract {
  rootPath: string;
  db: ConsoleAuthDatabase;
  authorizationStore: ConsoleAuthResources["authorizationStore"];
  authorizationGovernanceStore: ConsoleAuthResources["authorizationGovernanceStore"];
  tagManagementStore: unknown;
  authorizationEngine: ConsoleAuthResources["authorizationEngine"];
  ensureInitialOwner(): Promise<Record<string, unknown>>;
  getBootstrapStatus(): ReturnType<typeof getEmptyBootstrapStatus>;
  hasUsers(): boolean;
  authorizeOperation(input?: AuthorizationInput): Promise<AuthorizationResult>;
  captureDeferredProtectedSinkAuthority(
    input?: DeferredCaptureInput
  ): Promise<Readonly<Record<string, unknown>>>;
  revalidateDeferredProtectedSinkAuthority(
    input?: DeferredRevalidationInput
  ): Promise<Readonly<Record<string, unknown>>>;
  revokeDeferredProtectedSinkAuthority(
    input?: DeferredRevocationInput
  ): Promise<Readonly<{ revoked: boolean }>>;
  getSessionFromRequest(
    request?: HttpRequestLike | null,
    options?: { fresh?: boolean }
  ): ConsoleSession | null;
  getSummary(request?: HttpRequestLike | null): Record<string, unknown>;
  login(
    input?: Record<string, unknown>,
    request?: HttpRequestLike
  ): Promise<Record<string, unknown>>;
  logout(request?: HttpRequestLike): Record<string, unknown>;
  rotateSession(request?: HttpRequestLike): Record<string, unknown>;
  listUsers(): Array<Record<string, unknown> | null>;
  createUser(input?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateUser(
    userId?: unknown,
    patch?: Record<string, unknown>
  ): Promise<Record<string, unknown> | null>;
  listSessions(): Array<Record<string, unknown>>;
  revokeSession(sessionId?: unknown): { ok: boolean };
  roleList(): unknown[];
  refreshActiveFeatureIds(nextActiveFeatureIds?: unknown[]): Readonly<Record<string, unknown>>;
  getOidcConfig(): Record<string, unknown>;
  setOidcConfig(input?: Record<string, unknown>): Record<string, unknown>;
  audit(input?: AuditInput): void;
  listAudit(query?: AuditQuery): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function createConsoleAuthImplementation({
  userDataPath,
  activeFeatureIds = [],
  featureScopeGrants = {},
  tagManagementStore = null
}: ConsoleAuthOptions): {
  db: ConsoleAuthDatabase;
  api: Omit<ConsoleAuthContract, "db">;
} {
  let consoleRoles = createConsoleRoleCatalog({ activeFeatureIds, featureScopeGrants });
  const resources = createConsoleAuthResources({ userDataPath, consoleRoles, tagManagementStore });
  const db: ConsoleAuthDatabase = resources.db;
  const {
    rootPath,
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
  let requestSessionCache = new WeakMap<object, ConsoleSession | null>();
  const sessionAuthoritySources = new WeakMap<object, DurableAuthoritySource>();

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
  }: {
    userRow: ConsoleUserDbRow;
    sessionId: string;
    tokenHash: string;
    userAgentHash: string;
    createdAt: string;
    expiresAt: string;
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

  function auditIdentityRef(value?: unknown, kind = "identity"): string {
    const text = String(value || "").trim();
    if (!text || SECURITY_DIGEST_PATTERN.test(text)) {
      return text;
    }
    return irreversibleSecurityDigest(text, {
      projectionKey: _csrfSecret,
      namespace: `console-audit:${kind}`
    });
  }

  function safeAuditReasonCode(value?: unknown, fallback = ""): string {
    const text = String(value || "").trim();
    return REASON_CODE_PATTERN.test(text) ? text : fallback;
  }

  function securityAuditProjection(value?: unknown, type = "target") {
    return {
      projection: CONSOLE_AUDIT_SECURITY_PROJECTION,
      type,
      summary: summarizeSecurityValue(value, {
        key: type === "target" ? "payload" : type,
        projectionKey: _csrfSecret
      })
    };
  }

  function securityAuditErrorProjection(error?: unknown, reasonCode?: unknown) {
    const inferredReasonCode =
      safeAuditReasonCode(reasonCode) ||
      (String(error || "") ? "console_audit_error" : "");
    return {
      ...securityAuditProjection(String(error || ""), "error"),
      reasonCode: inferredReasonCode
    };
  }

  function parseSecurityAuditProjection(value?: unknown, type = "target") {
    const parsedValue = parseJson<unknown>(value, null);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) return null;
    const parsed = parsedValue as Record<string, unknown>;
    const summary = parsed.summary && typeof parsed.summary === "object" && !Array.isArray(parsed.summary)
      ? parsed.summary as Record<string, unknown>
      : null;
    if (
      parsed.projection === CONSOLE_AUDIT_SECURITY_PROJECTION &&
      parsed.type === type &&
      summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      Object.keys(parsed).every((key)  =>
        (type === "error"
          ? ["projection", "reasonCode", "summary", "type"]
          : ["projection", "summary", "type"]
        ).includes(key)
      ) &&
      summary.metadataOnly === true &&
      Object.keys(summary).every((key)  => SECURITY_METADATA_KEYS.has(key)) &&
      SECURITY_METADATA_TYPES.has(String(summary.type || "")) &&
      /^[a-f0-9]{16}$/i.test(String(summary.sha256 || "")) &&
      summary.hashAlgorithm === "hmac-sha256" &&
      (!summary.reason || SECURITY_METADATA_REASONS.has(String(summary.reason))) &&
      ["byteLength", "keyCount", "length"].every((key)  =>
        summary[key] === undefined ||
          (typeof summary[key] === "number" && Number.isInteger(summary[key]) && summary[key] >= 0)
      ) &&
      (summary.redacted === undefined || typeof summary.redacted === "boolean") &&
      (type !== "error" || !parsed.reasonCode || safeAuditReasonCode(parsed.reasonCode) === parsed.reasonCode)
    ) {
      return parsed;
    }
    return null;
  }

  function computeCsrfToken(rawSessionToken?: unknown): string {
    return "csrf_" + crypto
      .createHmac("sha256", _csrfSecret)
      .update(String(rawSessionToken || ""))
      .digest("base64url");
  }

  function hasUsers()  {
    return Number(countUsersStmt.get()?.count || 0) > 0;
  }

  function resolveRole(roleId = "viewer"): RoleFacts {
    const role = authorizationGovernanceStore.getRole(roleId) ||
      consoleRoles[roleId] ||
      authorizationGovernanceStore.getRole("viewer") ||
      consoleRoles.viewer;
    if (!role || typeof role.roleId !== "string") {
      throw new Error(`Console role is unavailable: ${roleId}`);
    }
    return role as RoleFacts;
  }

  function normalizeConsoleRole(value?: unknown): string {
    const roleId = String(value || "viewer").trim();
    const role = resolveRole(roleId);
    if (!role || role.roleId !== roleId || role.enabled === false) {
      throw new Error(`未知角色：${roleId}`);
    }
    return roleId;
  }

  function publicUserWithGovernanceRole(row?: ConsoleUserDbRow | null) {
    const user = publicUser(row, consoleRoles);
    if (!user) {
      return null;
    }
    const role = resolveRole(user.roleId);
    return {
      ...user,
      roleLabel: role.label || role.roleId,
      scopes: role.scopes || []
    };
  }

  async function ensureInitialOwner()  {
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

  function getBootstrapStatus()  {
    return {
      required: false,
      tokenPrefix: "",
      tokenFilePath: ""
    };
  }

  function roleList()  {
    return authorizationGovernanceStore.listRoles();
  }

  function refreshActiveFeatureIds(nextActiveFeatureIds = [])  {
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
    requestSessionCache = new WeakMap<object, ConsoleSession | null>();
    return Object.freeze({ ok: true, roles: Object.freeze(roleList()) });
  }

  function sessionFromToken(
    token?: unknown,
    request: HttpRequestLike | null = null,
    allowInactivityRetry = true
  ): ConsoleSession | null {
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
    const session = freezeSessionSnapshot({
      sessionId: row.session_id,
      csrfToken,
      expiresAt: row.expires_at,
      user: {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name || row.username,
        roleId: row.role_id,
        roleLabel: role.label,
        scopes: [...(role.scopes || [])],
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
    const authoritySource = durableSessionAuthoritySource({
      row,
      role,
      tokenHash
    });
    if (authoritySource) sessionAuthoritySources.set(session, authoritySource);
    return session;
  }

  function getSessionFromRequest(
    request?: HttpRequestLike | null,
    { fresh = false }: { fresh?: boolean } = {}
  ): ConsoleSession | null {
    const cacheableRequest = request !== null &&
      (typeof request === "object" || typeof request === "function");
    if (!fresh && cacheableRequest && requestSessionCache.has(request)) {
      const cachedSession = requestSessionCache.get(request);
      if (!cachedSession) return null;
      const expiresAtMs = Date.parse(cachedSession.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        requestSessionCache.set(request, null);
        return null;
      }
      return cachedSession;
    }
    const cookies = parseCookies(request ?? undefined);
    const cookieToken = cookies[CONSOLE_SESSION_COOKIE] || "";
    const session = sessionFromToken(cookieToken, request);
    if (cacheableRequest && request) requestSessionCache.set(request, session);
    return session;
  }

  function sessionAuthorityRevision(session: ConsoleSession): string {
    const source = sessionAuthoritySources.get(session);
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
  }: {
    source: DurableAuthoritySource | null;
    operation: OperationFacts;
    input: ConsoleInput;
    request?: HttpRequestLike | null;
    authorizationDecision: DecisionFacts;
    governancePolicyRevision?: unknown;
  }) {
    const policy = governancePolicyAuthorityFacts(governancePolicyRevision);
    const approval = operationApprovalAuthorityFacts({
      operation,
      input,
      request
    });
    const durableApproval = durableApprovalIntentFacts(approval);
    const risk = operationRiskAuthorityFacts({
      operation,
      authorizationDecision
    });
    if (!source || !policy || !durableApproval || !risk) return null;
    const subjectGeneration = authorityDigest(
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

  function protectedSinkAuthority(input: ProtectedSinkInput) {
    return protectedSinkAuthorityFromSource({
      ...input,
      source: sessionAuthoritySources.get(input.session) ?? null
    });
  }

  const readDeferredAuthorityStmt = db.prepare<unknown[], DeferredAuthorityRow>(`
    SELECT authority_ref, session_id, operation_id, request_digest,
           approval_intent_digest, issued_at, expires_at, revoked_at,
           reason_code
    FROM console_deferred_protected_sink_authorities
    WHERE authority_ref = ?
  `);
  const readDeferredSessionStmt = db.prepare<unknown[], ConsoleSessionDbRow>(`
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
  const insertDeferredAuthorityStmt = db.prepare(`
    INSERT INTO console_deferred_protected_sink_authorities (
      authority_ref, session_id, operation_id, request_digest,
      approval_intent_digest, issued_at, expires_at, revoked_at,
      reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '')
  `);
  const revokeDeferredAuthorityStmt = db.prepare(`
    UPDATE console_deferred_protected_sink_authorities
    SET revoked_at = CASE WHEN revoked_at = '' THEN ? ELSE revoked_at END,
        reason_code = CASE WHEN revoked_at = '' THEN ? ELSE reason_code END
    WHERE authority_ref = ?
  `);

  function currentDeferredSession(sessionId?: unknown): DeferredSessionState | null {
    const row = readDeferredSessionStmt.get(sessionId);
    if (!row || row.enabled !== 1 || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    const role = resolveRole(row.role_id);
    const source = durableSessionAuthoritySource({
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
          scopes: [...(role.scopes || [])],
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
  }: {
    operation: OperationFacts;
    input: ConsoleInput;
    sessionState: DeferredSessionState;
  }) {
    const governancePolicyRevision =
      authorizationGovernanceStore.getPolicyRevision();
    const authorizationDecision = await authorizationEngine.evaluate({
      operation,
      request: null,
      authSession: sessionState.session,
      input: buildConsoleOperationAuthorizationInput({
        input,
        method: "POST",
        url: new URL("http://127.0.0.1/api/jobs/upload-workspace-materializations")
      }),
      context: buildConsoleOperationAuthorizationContext({
        context: {
          authorizationPhase: "final-protected-sink"
        }
      }),
      enforceConfirmation: false
    });
    if (authorizationDecision?.allowed !== true) return null;
    const authority = protectedSinkAuthorityFromSource({
      source: sessionState.source,
      operation,
      input,
      request: null,
      authorizationDecision,
      governancePolicyRevision
    });
    const approval = durableApprovalIntentFacts(
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
  }: DeferredCaptureInput = {})  {
    const operationId = exactNonEmptyText(operation?.id);
    if (
      operationId !== "jobs.upload_workspace_materialize" ||
      !operation ||
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
    const authorization = await authorizeOperation({
      request: request
        ? {
            method: request.method,
            url: request.url,
            headers: request.headers,
            socket: request.socket
          }
        : null,
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
    const authorizedSession = authorization?.session;
    if (
      authorization?.ok !== true ||
      !authSession ||
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
    const approval = durableApprovalIntentFacts(
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
    const authorityRef =
      `deferred-authority:${crypto.randomBytes(24).toString("base64url")}`;
    const requestDigest = deferredRequestDigest(operationId, input);
    const approvalIntentDigest = sha256Canonical(approval);
    const authorityBindingDigest = sha256Canonical(
      authorization.protectedSinkAuthority
    );
    const issuedAt = nowIso();
    const expiresAt = new Date(
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
  }: DeferredRevalidationInput = {})  {
    const row = readDeferredAuthorityStmt.get(
      exactNonEmptyText(authorityRef)
    );
    const operationId = exactNonEmptyText(operation?.id);
    const currentRequestDigest =
      operationId && input && typeof input === "object" && !Array.isArray(input)
        ? deferredRequestDigest(operationId, input)
        : "";
    if (
      !row ||
      !operation ||
      !input ||
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
    const sessionState = currentDeferredSession(row.session_id);
    const current = sessionState
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
  }: DeferredRevocationInput = {})  {
    const reasonCode = String(reason || "")
      .trim()
      .replace(/[^A-Za-z0-9._:-]/gu, "_")
      .slice(0, 160) || "deferred_authority_revoked";
    const result = revokeDeferredAuthorityStmt.run(
      nowIso(),
      reasonCode,
      exactNonEmptyText(authorityRef)
    );
    return Object.freeze({
      revoked: Number(result.changes || 0) === 1
    });
  }

  async function createUser(input: Record<string, unknown> = {})  {
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

  async function login(
    input: Record<string, unknown> = {},
    request?: HttpRequestLike
  )  {
    const username = normalizeUsername(input.username);
    const password = String(input.password || "");
    const userRow = getUserByUsernameStmt.get(username);
    if (!userRow || !userRow.enabled) {
      // Constant-time guard: don't reveal whether username exists.
      await verifyPassword("__sentinel__", "salt", "hash").catch(()  => {});
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
    fsp.unlink(path.join(rootPath, "initial-credentials.txt")).catch(()  => {});

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

  function logout(request?: HttpRequestLike)  {
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

  function rotateSession(request?: HttpRequestLike)  {
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

  async function updateUser(userId?: unknown, patch: Record<string, unknown> = {})  {
    const normalizedUserId = String(userId || "");
    if (!getUserByIdStmt.get(normalizedUserId)) return null;

    const normalizedPatch: Record<string, unknown> = {
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
    const credential = patch.password || patch.newPassword
      ? await hashPassword(normalizePassword(patch.password || patch.newPassword))
      : null;

    const commitUpdate = db.transaction(()  => {
      const current = getUserByIdStmt.get(normalizedUserId);
      if (!current) return null;
      const updates: Record<string, unknown> = {
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

  function listUsers()  {
    return listUsersStmt.all().map(publicUserWithGovernanceRole);
  }

  function listSessions()  {
    return db.prepare<unknown[], SessionListRow>(`
      SELECT s.session_id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, u.username, u.role_id
      FROM console_sessions s
      JOIN console_users u ON u.user_id = s.user_id
      ORDER BY s.last_seen_at DESC
      LIMIT 200
    `).all().map((row)  => ({
      sessionId: row.session_id,
      userId: row.user_id,
      username: row.username,
      roleId: row.role_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at
    }));
  }

  function revokeSession(sessionId?: unknown)  {
    const result = deleteSessionByIdStmt.run(String(sessionId || ""));
    return { ok: Number(result.changes || 0) > 0 };
  }

  function getOidcConfig()  {
    const row = db.prepare<unknown[], OidcConfigRow>(
      "SELECT * FROM console_oidc_config WHERE config_id = 'default'"
    ).get();
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

  function setOidcConfig(input: Record<string, unknown> = {})  {
    const current = getOidcConfig();
    const clientSecret = String(input.clientSecret || "").trim();
    const next: Record<string, unknown> = {
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

  function audit(input: AuditInput = {})  {
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

  function listAudit({ limit = 100, userId = "", status = "" }: AuditQuery = {})  {
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
    return db.prepare<unknown[], AuditRow>(`
      SELECT * FROM console_audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, safeLimit).map((row)  => {
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

  async function authorizeOperation({
    request,
    operation = {},
    method = "",
    url = null,
    input = {},
    context = {},
    phase = ""
  }: AuthorizationInput = {}): Promise<AuthorizationResult>  {
    const publicAccess = operation.public === true;
    const authorizationPhase = String(
      phase || context?.authorizationPhase || ""
    ).trim();
    const protectedSinkAuthorityPhase =
      PROTECTED_SINK_AUTHORITY_PHASES.has(authorizationPhase) &&
      isProtectedSinkOperation(operation);
    if (!safeRequestMethod(method) && !sameOriginRequest(request ?? undefined)) {
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
    const session = getSessionFromRequest(request, {
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
    const governancePolicyRevisionBefore =
      authorizationGovernanceStore.getPolicyRevision();
    const policyFactsBefore =
      governancePolicyAuthorityFacts(governancePolicyRevisionBefore);
    const authorizationDecision = await authorizationEngine.evaluate({
      operation,
      request: request
        ? {
            method: request.method,
            url: request.url,
            headers: request.headers,
            socket: request.socket
          }
        : null,
      authSession: session,
      input: buildConsoleOperationAuthorizationInput({ input, method, url }),
      context: buildConsoleOperationAuthorizationContext({ context }),
      enforceConfirmation: false
    });
    const governancePolicyRevision =
      authorizationGovernanceStore.getPolicyRevision();
    const policyFactsAfter =
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
      const missingScopes = Array.isArray(authorizationDecision.missingScopes)
        ? authorizationDecision.missingScopes
        : [];
      const missingCapabilities = Array.isArray(authorizationDecision.missingCapabilities)
        ? authorizationDecision.missingCapabilities
        : [];
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
      const csrf = String(request?.headers?.["x-meshrix-csrf"] || "").trim();
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
    let currentSession: ConsoleSession | null = session;
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
    const currentProtectedSinkAuthority = protectedSinkAuthority({
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

  function getSummary(request: HttpRequestLike | null = null)  {
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
    db,
    api: {
      rootPath,
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
    }
  };
}

export function createConsoleAuth(options: ConsoleAuthOptions): ConsoleAuthContract {
  const { api, db } = createConsoleAuthImplementation(options);
  return { ...api, db };
}

export default createConsoleAuth;
