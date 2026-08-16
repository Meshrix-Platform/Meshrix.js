import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createAuthorizationEngine } from "#meshrix/authorization-engine";
import type { AuthorizationStore } from "./authorization/authorization-store.ts";
import type { TagStoreProvider, TagStoreRecord } from "./authorization/tag-store.port.ts";
import {
  buildConsoleOperationAuthorizationContext,
  buildConsoleOperationAuthorizationInput
} from "./auth/console-auth.ts";
import {
  evaluateUniversalTagPolicy,
  hasUniversalTagPolicyRules
} from "./authorization/universal-tag-policy.ts";
// Tag management store is injected by composition root; no static import from server-runtime.
// If no store is provided, tag operations will throw "Tag management store is unavailable." (fail-closed).

export type ProviderRecord = Record<string, unknown>;
type AuthorizationEngine = ReturnType<typeof createAuthorizationEngine>;

export interface AuthorizationStoreFacade {
  appendDecision(decision?: ProviderRecord): Promise<unknown> | unknown;
  appendReceipt?(record?: ProviderRecord, metadata?: ProviderRecord): Promise<unknown> | unknown;
  appendLoanRecord?(record?: ProviderRecord, metadata?: ProviderRecord): Promise<unknown> | unknown;
  appendDeniedRequest?(record?: ProviderRecord): Promise<unknown> | unknown;
  listDecisions?(input?: ProviderRecord): Promise<unknown> | unknown;
  listReceipts?(input?: ProviderRecord): Promise<unknown> | unknown;
  listLoanRecords?(input?: ProviderRecord): Promise<unknown> | unknown;
  listDeniedRequests?(input?: ProviderRecord): Promise<unknown> | unknown;
}

export interface AuthorizationGovernanceStoreFacade extends ProviderRecord {
  evaluateGovernance(input?: ProviderRecord): ProviderRecord;
  tagManagementStore?: TagStoreProvider | null;
  getPolicyRevision?(): unknown;
  listRoles?(input?: ProviderRecord): unknown;
  upsertRole?(input: ProviderRecord): unknown;
  listDepartments?(input?: ProviderRecord): unknown;
  upsertDepartment?(input: ProviderRecord): unknown;
  listTeams?(input?: ProviderRecord): unknown;
  upsertTeam?(input: ProviderRecord): unknown;
  listUserPolicies?(): unknown;
  upsertUserPolicy?(input: ProviderRecord): unknown;
  listAgentGroups?(input?: ProviderRecord): unknown;
  upsertAgentGroup?(input: ProviderRecord): unknown;
  listAgentBindings?(): unknown;
  upsertAgentBinding?(input: ProviderRecord): unknown;
  listApprovals?(input?: ProviderRecord): unknown;
  getApproval?(approvalId: string): unknown;
  upsertApproval?(input: ProviderRecord): unknown;
  revokeApproval?(approvalId: string, reason: string): unknown;
  listApiKeyRecoveryAssignments?(): unknown;
}

interface OrganizationGovernanceServiceFacade {
  getOrganizationGovernance(): unknown;
  listOrganizationGovernanceTemplates(): unknown;
  importOrganizationGovernance(input?: unknown): unknown;
  previewOrganizationGovernance(input?: unknown): unknown;
  publishOrganizationGovernance(input?: ProviderRecord): unknown;
}

interface ProcessIdentityVerification extends ProviderRecord {
  ok?: boolean;
}

export interface ProcessIdentityServiceFacade {
  verifySignedRequest(input?: ProviderRecord): Promise<ProcessIdentityVerification>;
  revalidateVerifiedRequest?(input?: ProviderRecord): Promise<unknown>;
}

interface ConsoleAuthorizationResult extends ProviderRecord {
  ok?: boolean;
  session?: unknown;
  authorizationDecision?: unknown;
  protectedSinkAuthority?: unknown;
}

interface ConsoleAuthFacade {
  authorizationStore?: AuthorizationStoreFacade | null;
  authorizationGovernanceStore?: AuthorizationGovernanceStoreFacade | null;
  tagManagementStore?: TagStoreProvider | null;
  authorizationEngine?: AuthorizationEngine | null;
  captureDeferredProtectedSinkAuthority?(input?: ProviderRecord): Promise<DeferredAuthorityDecision>;
  revalidateDeferredProtectedSinkAuthority?(input?: ProviderRecord): Promise<DeferredAuthorityDecision>;
  revokeDeferredProtectedSinkAuthority?(input?: ProviderRecord): Promise<ProviderRecord>;
  authorizeOperation?(input?: ProviderRecord): Promise<ConsoleAuthorizationResult>;
  getSummary?(request?: object | null): unknown;
  login?(input?: ProviderRecord, request?: object | null): unknown;
  logout?(request?: object | null): unknown;
  rotateSession?(request?: object | null): unknown;
  audit?(entry?: ProviderRecord): unknown;
  roleList?(): unknown;
  listUsers?(): unknown;
  updateUser?(userId?: string, input?: ProviderRecord): unknown;
  getOidcConfig?(): unknown;
  setOidcConfig?(input?: ProviderRecord): unknown;
  listAudit?(input?: ProviderRecord): unknown;
  listSessions?(): unknown;
  revokeSession?(sessionId?: string): unknown;
}

interface PermissionsProviderOptions {
  consoleAuth?: ConsoleAuthFacade | null;
  authorizationEngine?: AuthorizationEngine | null;
  authorizationStore?: Readonly<AuthorizationStore> | AuthorizationStoreFacade | null;
  authorizationGovernanceStore?: AuthorizationGovernanceStoreFacade | null;
  organizationGovernanceService?: OrganizationGovernanceServiceFacade | null;
  tagManagementStore?: TagStoreProvider | null;
  userDataPath?: string;
  processIdentity?: ProcessIdentityServiceFacade | null;
}

export interface SecurityPermissionsProvider {
  readonly protocolVersion: typeof SECURITY_PERMISSIONS_PROTOCOL_VERSION;
  readonly deferredProtectedSinkAuthorityPort: Readonly<{
    capture(input?: PermissionInput): Promise<unknown>;
    revalidate(input?: PermissionInput): Promise<unknown>;
    revoke(input?: PermissionInput): Promise<unknown>;
    reauthorizeCustodyRead(input?: PermissionInput): Promise<unknown>;
  }>;
  readonly authorizationEngine: AuthorizationEngine | null;
  readonly authorizationStore: AuthorizationStoreFacade | null;
  readonly authorizationGovernanceStore: AuthorizationGovernanceStoreFacade | null;
  readonly tagManagementStore: TagStoreProvider | null;
  readonly processIdentity: ProcessIdentityServiceFacade | null;
  authorizeOperation(input?: PermissionInput): Promise<unknown>;
  verifyProcessIdentity(input?: PermissionInput): Promise<unknown>;
  getConsoleSummary(request?: object | null): unknown;
  getSummary(request?: object | null): unknown;
  login(input?: ProviderRecord, request?: object | null): unknown;
  logout(request?: object | null): unknown;
  rotateSession(request?: object | null): unknown;
  audit(entry?: ProviderRecord): unknown;
  roleList(): unknown;
  listUsers(): unknown;
  updateUser(userId?: string, input?: ProviderRecord): unknown;
  getOidcConfig(): unknown;
  setOidcConfig(input?: ProviderRecord): unknown;
  listAudit(input?: ProviderRecord): unknown;
  listSessions(): unknown;
  revokeSession(sessionId?: string): unknown;
  resolveSubject(input?: ProviderRecord): unknown;
  evaluatePolicy(input?: PermissionInput): Promise<unknown>;
  getGovernancePolicyRevision(): unknown;
  getGovernanceSummary(): unknown;
  getOrganizationGovernance(): unknown;
  listOrganizationGovernanceTemplates(): unknown;
  importOrganizationGovernance(input?: ProviderRecord): unknown;
  previewOrganizationGovernance(input?: ProviderRecord): unknown;
  publishOrganizationGovernance(input?: ProviderRecord): unknown;
  listGovernanceRoles(input?: ProviderRecord): unknown;
  upsertGovernanceRole(input?: ProviderRecord): unknown;
  listGovernanceDepartments(input?: ProviderRecord): unknown;
  upsertGovernanceDepartment(input?: ProviderRecord): unknown;
  listGovernanceTeams(input?: ProviderRecord): unknown;
  upsertGovernanceTeam(input?: ProviderRecord): unknown;
  listGovernanceUserPolicies(): unknown;
  upsertGovernanceUserPolicy(input?: ProviderRecord): unknown;
  listGovernanceAgentGroups(input?: ProviderRecord): unknown;
  upsertGovernanceAgentGroup(input?: ProviderRecord): unknown;
  listGovernanceAgentBindings(): unknown;
  upsertGovernanceAgentBinding(input?: ProviderRecord): unknown;
  listTags(input?: TagStoreRecord): unknown;
  getTag(tagId?: string): unknown;
  upsertTag(input?: TagStoreRecord): unknown;
  archiveTag(tagId?: string, input?: TagStoreRecord): unknown;
  restoreTag(tagId?: string): unknown;
  listTagProjections(input?: TagStoreRecord): unknown;
  rebuildTagProjections(): unknown;
  listTagEvents(input?: TagStoreRecord): unknown;
  listToolProfileTags(input?: TagStoreRecord): unknown;
  seedToolProfileTags(profiles?: TagStoreRecord[]): unknown;
  listGovernanceApprovals(input?: ProviderRecord): unknown;
  getGovernanceApproval(approvalId?: string): unknown;
  upsertGovernanceApproval(input?: ProviderRecord): unknown;
  revokeGovernanceApproval(approvalId?: string, reason?: string): unknown;
  listReceipts(input?: ProviderRecord): unknown;
  listLoanRecords(input?: ProviderRecord): unknown;
  listDeniedRequests(input?: ProviderRecord): unknown;
  listDecisions(input?: ProviderRecord): unknown;
  appendReceipt(receipt?: ProviderRecord, metadata?: ProviderRecord): unknown;
  appendLoanRecord(record?: ProviderRecord, metadata?: ProviderRecord): unknown;
  appendDeniedRequest(request?: ProviderRecord): unknown;
  appendDecision(decision?: ProviderRecord): unknown;
  setWorkspaceAssetPolicy(input?: ProviderRecord): ProviderRecord;
  getWorkspaceAssetPolicy(input?: ProviderRecord): ProviderRecord | null;
  checkWorkspaceAssetPermission(input?: PermissionInput): Promise<unknown>;
}

export interface PermissionInput extends ProviderRecord {
  operation?: ProviderRecord;
  context?: ProviderRecord;
  input?: ProviderRecord;
  operationInput?: ProviderRecord;
  request?: ProviderRecord | null;
  authSession?: ProviderRecord | null;
  phase?: unknown;
  method?: unknown;
  url?: URL | null;
  transport?: unknown;
  tagPolicy?: ProviderRecord | null;
  resourceBinding?: ProviderRecord;
  authorizationReceipt?: CustodyAuthorizationReceipt;
}

interface AuthorizationDecision extends ProviderRecord {
  effect?: unknown;
  allowed?: unknown;
  reasonCode?: unknown;
  redactedReason?: unknown;
  deniedLayer?: unknown;
  evaluatedLayers?: unknown;
  effectivePolicySnapshot?: unknown;
  missingCapabilities?: unknown;
  missingScopes?: unknown;
}

interface ProtectedSinkAuthority extends ProviderRecord {
  subject: Record<string, string>;
  context: Record<string, string>;
}

export interface DeferredAuthorityDecision extends ProviderRecord {
  allowed?: boolean;
  revoked?: boolean;
  reasonCode?: string;
  authorityBindingDigest?: string;
  subject?: Record<string, string>;
  context?: Record<string, string>;
}

interface CustodyAuthorizationState {
  authorityBindingDigest: unknown;
  authorityRef: unknown;
  input: Readonly<ProviderRecord>;
  operation?: ProviderRecord;
  requestDigest: unknown;
  resourceBinding: ProviderRecord;
  resourceBindingDigest: string;
}

interface CustodyAuthorizationReceipt extends ProviderRecord {
  decisionRef: string;
  grantRevision: unknown;
  policyRevision: unknown;
  resourceBindingDigest: string;
}

export const SECURITY_PERMISSIONS_PROTOCOL_VERSION = "v0.0.1:risk-control:permissions-1";

const PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS = Object.freeze([
  "generation",
  "subjectId",
  "tenantId",
  "type"
]);
const PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS = Object.freeze([
  "approvalRevision",
  "grantRevision",
  "policyRevision",
  "riskRevision",
  "workloadGeneration"
]);
const PROTECTED_SINK_AUTHORITY_PHASES = new Set<string>([
  "admission",
  "execution",
  "final-protected-sink"
]);

function securityDigest(value?: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function isRecord(value: unknown): value is ProviderRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is ProviderRecord {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function hasExactProtectedSinkAuthority(value: unknown): value is ProtectedSinkAuthority {
  if (!hasExactKeys(value, ["context", "subject"])) return false;
  const subject = value.subject;
  const context = value.context;
  return (
    hasExactKeys(subject, PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS) &&
    hasExactKeys(context, PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS) &&
    [...PROTECTED_SINK_AUTHORITY_SUBJECT_KEYS].every(
      (key) => typeof subject[key] === "string" && subject[key].trim()
    ) &&
    [...PROTECTED_SINK_AUTHORITY_CONTEXT_KEYS].every(
      (key) => typeof context[key] === "string" && context[key].trim()
    )
  );
}

function requiresProtectedSinkAuthority(input: PermissionInput = {}): boolean {
  const operationId = String(input.operation?.id || "").trim();
  const phase = String(
    input.phase || input.context?.authorizationPhase || ""
  ).trim();
  return (
    PROTECTED_SINK_AUTHORITY_PHASES.has(phase) &&
    (
      operationId === "gateway.forward" ||
      operationId === "jobs.upload_workspace_materialize" ||
      operationId.startsWith("upstream_operation.")
    )
  );
}

function defaultSummary() {
  return {
    enabled: false,
    bootstrap: {},
    session: {
      authenticated: false,
      csrfToken: "",
      expiresAt: "",
      user: null
    },
    roles: [],
    oidc: {}
  };
}

function workspaceAssetPolicyKey(workspaceId?: unknown, policyId?: unknown): string {
  return `${String(workspaceId || "default").trim() || "default"}:${String(policyId || "").trim()}`;
}

function defaultGovernancePolicyRevision() {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 0,
    updatedAt: ""
  };
}

export function createSecurityPermissionsProvider({
  consoleAuth = null,
  authorizationEngine = null,
  authorizationStore = null,
  authorizationGovernanceStore = null,
  organizationGovernanceService = null,
  tagManagementStore = null,
  userDataPath = "",
  processIdentity = null
}: PermissionsProviderOptions = {}): Readonly<SecurityPermissionsProvider> {
  void userDataPath;
  const workspaceAssetPolicies = new Map<string, ProviderRecord>();
  const resolvedAuthorizationStore =
    authorizationStore ||
    consoleAuth?.authorizationStore ||
    null;
  const resolvedAuthorizationGovernanceStore =
    authorizationGovernanceStore ||
    consoleAuth?.authorizationGovernanceStore ||
    null;
  const resolvedOrganizationGovernanceService = organizationGovernanceService || null;
  // Tag store is injected by composition root via server-runtime adapter.
  // No default factory is used — missing store = fail-closed.
  const resolvedTagManagementStore =
    tagManagementStore ||
    resolvedAuthorizationGovernanceStore?.tagManagementStore ||
    consoleAuth?.tagManagementStore ||
    null;
  const resolvedAuthorizationEngine =
    authorizationEngine ||
    consoleAuth?.authorizationEngine ||
    (resolvedAuthorizationStore
      ? createAuthorizationEngine({
          store: resolvedAuthorizationStore,
          governanceStore: resolvedAuthorizationGovernanceStore
        })
      : null);
  const custodyAuthorizationReceipts = new WeakMap<object, CustodyAuthorizationState>();
  const captureDeferredAuthority = consoleAuth?.captureDeferredProtectedSinkAuthority?.bind(consoleAuth) || null;
  const revalidateDeferredAuthority = consoleAuth?.revalidateDeferredProtectedSinkAuthority?.bind(consoleAuth) || null;
  const revokeDeferredAuthority = consoleAuth?.revokeDeferredProtectedSinkAuthority?.bind(consoleAuth) || null;
  const hasDeferredConsoleAuthority = Boolean(
    captureDeferredAuthority && revalidateDeferredAuthority && revokeDeferredAuthority
  );

  function denyDeferredAuthority(
    reasonCode = "deferred_protected_sink_authority_unavailable"
  ) {
    return Object.freeze({
      allowed: false,
      reasonCode,
      revoked: false
    });
  }

  function closedResourceBinding(value?: unknown): ProviderRecord | null {
    if (!isRecord(value)) {
      return null;
    }
    try {
      const normalized: unknown = JSON.parse(JSON.stringify(value));
      return isRecord(normalized) ? Object.freeze(normalized) : null;
    } catch {
      return null;
    }
  }

  async function revalidateDeferred(input: PermissionInput = {}): Promise<DeferredAuthorityDecision> {
    if (!hasDeferredConsoleAuthority || !revalidateDeferredAuthority) {
      return denyDeferredAuthority();
    }
    const current =
      await revalidateDeferredAuthority(input);
    if (current?.allowed !== true || current?.revoked === true) {
      return Object.freeze({
        allowed: false,
        reasonCode:
          current?.reasonCode ||
          "deferred_protected_sink_authority_denied",
        revoked: current?.revoked === true
      });
    }
    const requestedResourceBinding =
      closedResourceBinding(input.resourceBinding);
    if (!requestedResourceBinding) {
      return Object.freeze({ ...current });
    }
    if (!current.subject || !current.context) {
      return denyDeferredAuthority("deferred_protected_sink_authority_denied");
    }
    const resourceBinding = closedResourceBinding({
      ...requestedResourceBinding,
      ownerBindingDigest: securityDigest({
        subjectId: current.subject.subjectId,
        tenantId: current.subject.tenantId,
        userId: current.subject.subjectId
      })
    });
    if (!resourceBinding) {
      return denyDeferredAuthority(
        "deferred_protected_sink_authority_denied"
      );
    }
    const resourceBindingDigest = securityDigest(resourceBinding);
    const decisionRef = securityDigest({
      authorityBindingDigest: current.authorityBindingDigest,
      authorityRef: input.authorityRef,
      context: current.context,
      requestDigest: input.requestDigest,
      resourceBindingDigest
    });
    const custodyAuthorizationReceipt: Readonly<CustodyAuthorizationReceipt> = Object.freeze({
      decisionRef,
      grantRevision: current.context.grantRevision,
      policyRevision: current.context.policyRevision,
      resourceBindingDigest
    });
    custodyAuthorizationReceipts.set(
      custodyAuthorizationReceipt,
      Object.freeze({
        authorityBindingDigest: input.authorityBindingDigest,
        authorityRef: input.authorityRef,
        input: Object.freeze({ ...input.input }),
        operation: input.operation,
        requestDigest: input.requestDigest,
        resourceBinding,
        resourceBindingDigest
      })
    );
    return Object.freeze({
      ...current,
      custodyAuthorizationReceipt
    });
  }

  const deferredProtectedSinkAuthorityPort = Object.freeze({
    async capture(input: PermissionInput = {}) {
      if (!hasDeferredConsoleAuthority || !captureDeferredAuthority) {
        throw Object.assign(
          new Error("Durable protected sink authority source is unavailable."),
          {
            code: "deferred_protected_sink_authority_unavailable",
            statusCode: 503
          }
        );
      }
      return captureDeferredAuthority(input);
    },
    revalidate: revalidateDeferred,
    async revoke(input: PermissionInput = {}) {
      if (!hasDeferredConsoleAuthority || !revokeDeferredAuthority) {
        return Object.freeze({ revoked: false });
      }
      return revokeDeferredAuthority(input);
    },
    async reauthorizeCustodyRead(input: PermissionInput = {}) {
      const receipt = input.authorizationReceipt;
      if (
        !receipt ||
        (typeof receipt !== "object" && typeof receipt !== "function")
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const state = custodyAuthorizationReceipts.get(receipt);
      custodyAuthorizationReceipts.delete(receipt);
      if (!state) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const descriptor = state.resourceBinding.descriptor;
      const observedResourceBinding = closedResourceBinding({
        descriptor: {
          byteCount: Number(input.byteCount),
          contentDigest: String(input.contentDigest || ""),
          custodyRef: String(input.custodyRef || ""),
          envelopeDigest: String(input.envelopeDigest || ""),
          resourceRef: String(input.resourceRef || ""),
          state: "sealed_no_run"
        },
        expectedWorkspaceRevision:
          state.resourceBinding.expectedWorkspaceRevision,
        logicalTarget: state.resourceBinding.logicalTarget,
        ownerBindingDigest: String(
          input.ownerBindingDigest || ""
        ),
        targetStateDigest: state.resourceBinding.targetStateDigest,
        workspaceId: state.resourceBinding.workspaceId
      });
      if (
        input.audience !== "upload-custody-read" ||
        !descriptor ||
        !observedResourceBinding ||
        securityDigest(observedResourceBinding) !==
          state.resourceBindingDigest ||
        receipt.resourceBindingDigest !== state.resourceBindingDigest
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      const current = await revalidateDeferred({
        authorityBindingDigest: state.authorityBindingDigest,
        authorityRef: state.authorityRef,
        input: state.input,
        operation: state.operation,
        requestDigest: state.requestDigest
      });
      if (
        current.allowed !== true ||
        !current.context ||
        current.context?.policyRevision !== receipt.policyRevision ||
        current.context?.grantRevision !== receipt.grantRevision
      ) {
        return denyDeferredAuthority("upload_custody_read_denied");
      }
      return Object.freeze({
        allowed: true,
        currentGrantRevision: current.context.grantRevision,
        currentPolicyRevision: current.context.policyRevision,
        decisionRef: receipt.decisionRef,
        evidenceRef: `authority-evidence:${securityDigest({
          decisionRef: receipt.decisionRef,
          resourceBindingDigest: state.resourceBindingDigest
        })}`,
        revoked: false
      });
    }
  });

  function tagPolicyFromInput(input: PermissionInput = {}): ProviderRecord | null {
    const nestedInput = isRecord(input.input) ? input.input : {};
    const nestedContext = isRecord(nestedInput.context) ? nestedInput.context : {};
    const policy =
      input.tagPolicy ||
      (isRecord(input.context?.tagPolicy) ? input.context.tagPolicy : null) ||
      (isRecord(nestedInput.tagPolicy) ? nestedInput.tagPolicy : null) ||
      (isRecord(nestedContext.tagPolicy) ? nestedContext.tagPolicy : null) ||
      null;
    return hasUniversalTagPolicyRules(policy || {}) ? policy : null;
  }

  function evaluateTagPolicy(input: PermissionInput = {}, authorizationDecision: AuthorizationDecision | null = null): AuthorizationDecision | null {
    const tagPolicy = tagPolicyFromInput(input);
    if (!tagPolicy) {
      return authorizationDecision;
    }
    const tagDecision = evaluateUniversalTagPolicy({
      tagStore: resolvedTagManagementStore,
      ...tagPolicy
    });
    const effectivePolicySnapshot: ProviderRecord = {
      ...(isRecord(authorizationDecision?.effectivePolicySnapshot) ? authorizationDecision.effectivePolicySnapshot : {}),
      tagPolicy: {
        protocolVersion: tagDecision.protocolVersion,
        reasonCode: tagDecision.reasonCode,
        allowed: tagDecision.allowed,
        policyRevision: tagDecision.policyRevision,
        inputPolicyRevision: tagDecision.inputPolicyRevision,
        stale: tagDecision.stale,
        entityRefs: tagDecision.entityRefs,
        matchedDenyTags: tagDecision.matchedDenyTags,
        matchedAllowTags: tagDecision.matchedAllowTags,
        missingRequiredTags: tagDecision.missingRequiredTags
      }
    };
    if (!tagDecision.allowed) {
      return {
        ...authorizationDecision,
        effect: "deny",
        allowed: false,
        reasonCode: tagDecision.reasonCode,
        redactedReason: tagDecision.redactedReason,
        deniedLayer: "tag_policy",
        tagPolicyDecision: tagDecision,
        effectivePolicySnapshot,
        evaluatedLayers: [...new Set([...(Array.isArray(authorizationDecision?.evaluatedLayers) ? authorizationDecision.evaluatedLayers : []), "tag_policy"])]
      };
    }
    return {
      ...authorizationDecision,
      tagPolicyDecision: tagDecision,
      effectivePolicySnapshot,
      evaluatedLayers: [...new Set([...(Array.isArray(authorizationDecision?.evaluatedLayers) ? authorizationDecision.evaluatedLayers : []), "tag_policy"])]
    };
  }

  async function authorizeOperation(input: PermissionInput = {}) {
    if (typeof consoleAuth?.authorizeOperation === "function") {
      const authorization = await consoleAuth.authorizeOperation(input);
      if (
        authorization?.ok === true &&
        requiresProtectedSinkAuthority(input) &&
        !hasExactProtectedSinkAuthority(
          authorization.protectedSinkAuthority
        )
      ) {
        return {
          ok: false,
          status: 403,
          reasonCode: "final_protected_sink_authority_unavailable",
          error: "Current protected sink authority facts are unavailable.",
          session: authorization.session || null,
          authorizationDecision:
            authorization.authorizationDecision || null
        };
      }
      return authorization;
    }
    if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
      return {
        ok: false,
        status: 503,
        error: "授权失败：authorization engine 不可用。",
        session: input.authSession || null,
        authorizationDecision: null,
        bootstrap: { authorizationEngineAvailable: false }
      };
    }
    const operationInput = isRecord(input.input)
      ? input.input
      : isRecord(input.operationInput)
        ? input.operationInput
        : {};
    const decision = await resolvedAuthorizationEngine.evaluate({
      operation: input.operation || {},
      request: input.request || null,
      authSession: input.authSession || null,
      input: buildConsoleOperationAuthorizationInput({
        input: operationInput,
        method: String(input.method || ""),
        url: input.url || null
      }),
      context: buildConsoleOperationAuthorizationContext({
        context: input.context || {},
        transport: String(input.transport || "security-permissions-provider")
      }),
      enforceConfirmation: false
    });
    return decision.allowed
      ? requiresProtectedSinkAuthority(input)
        ? {
            ok: false,
            status: 503,
            reasonCode: "protected_sink_authority_source_unavailable",
            error: "Durable protected sink authority source is unavailable.",
            session: input.authSession || null,
            authorizationDecision: decision
          }
        : {
            ok: true,
            session: input.authSession || null,
            authorizationDecision: decision
          }
      : {
          ok: false,
          status: 403,
          error: Array.isArray(decision.missingCapabilities) && decision.missingCapabilities.length > 0
            ? `权限不足：${decision.missingCapabilities.join(", ")}。`
            : Array.isArray(decision.missingScopes) && decision.missingScopes.length > 0
            ? `权限不足：${decision.missingScopes.join(", ")}。`
            : `权限不足：${decision.reasonCode || "authorization_denied"}。`,
          session: input.authSession || null,
          authorizationDecision: decision
        };
  }

  async function verifyProcessIdentity(input: PermissionInput = {}) {
    if (!processIdentity || typeof processIdentity.verifySignedRequest !== "function") {
      return {
        ok: false,
        status: 503,
        reasonCode: "process_identity_unavailable",
        error: "Process identity verifier is unavailable."
      };
    }
    const verification = await processIdentity.verifySignedRequest(input);
    const revalidateVerifiedRequest = processIdentity.revalidateVerifiedRequest;
    if (
      verification?.ok !== true ||
      typeof revalidateVerifiedRequest !== "function"
    ) {
      return verification;
    }
    return {
      ...verification,
      revalidateAuthorization: () => revalidateVerifiedRequest({
        verification,
        operation: input.operation || {}
      })
    };
  }

  return Object.freeze({
    protocolVersion: SECURITY_PERMISSIONS_PROTOCOL_VERSION,
    deferredProtectedSinkAuthorityPort,
    authorizationEngine: resolvedAuthorizationEngine,
    authorizationStore: resolvedAuthorizationStore,
    authorizationGovernanceStore: resolvedAuthorizationGovernanceStore,
    tagManagementStore: resolvedTagManagementStore,
    processIdentity,
    authorizeOperation,
    verifyProcessIdentity,
    getConsoleSummary(request: object | null = null) {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    getSummary(request: object | null = null) {
      return typeof consoleAuth?.getSummary === "function"
        ? consoleAuth.getSummary(request)
        : defaultSummary();
    },
    login(input: ProviderRecord = {}, request: object | null = null) {
      if (typeof consoleAuth?.login !== "function") {
        throw new Error("Console authentication login provider is unavailable.");
      }
      return consoleAuth.login(input, request);
    },
    logout(request: object | null = null) {
      if (typeof consoleAuth?.logout !== "function") {
        return { ok: true, cookies: [] };
      }
      return consoleAuth.logout(request);
    },
    rotateSession(request: object | null = null) {
      if (typeof consoleAuth?.rotateSession !== "function") {
        return { ok: false, status: 503, error: "Console session rotation provider is unavailable." };
      }
      return consoleAuth.rotateSession(request);
    },
    audit(entry: ProviderRecord = {}) {
      return typeof consoleAuth?.audit === "function" ? consoleAuth.audit(entry) : null;
    },
    roleList() {
      return typeof consoleAuth?.roleList === "function" ? consoleAuth.roleList() : [];
    },
    listUsers() {
      return typeof consoleAuth?.listUsers === "function" ? consoleAuth.listUsers() : [];
    },
    updateUser(userId?: string, input: ProviderRecord = {}) {
      if (typeof consoleAuth?.updateUser !== "function") {
        return null;
      }
      return consoleAuth.updateUser(userId, input);
    },
    getOidcConfig() {
      return typeof consoleAuth?.getOidcConfig === "function" ? consoleAuth.getOidcConfig() : {};
    },
    setOidcConfig(input: ProviderRecord = {}) {
      if (typeof consoleAuth?.setOidcConfig !== "function") {
        throw new Error("Console OIDC provider is unavailable.");
      }
      return consoleAuth.setOidcConfig(input);
    },
    listAudit(input: ProviderRecord = {}) {
      return typeof consoleAuth?.listAudit === "function" ? consoleAuth.listAudit(input) : [];
    },
    listSessions() {
      return typeof consoleAuth?.listSessions === "function" ? consoleAuth.listSessions() : [];
    },
    revokeSession(sessionId?: string) {
      if (typeof consoleAuth?.revokeSession !== "function") {
        return { ok: false };
      }
      return consoleAuth.revokeSession(sessionId);
    },
    resolveSubject(input: ProviderRecord = {}) {
      return resolvedAuthorizationEngine?.resolveSubject
        ? resolvedAuthorizationEngine.resolveSubject(input)
        : null;
    },
    async evaluatePolicy(input: PermissionInput = {}) {
      if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
        return {
          effect: "deny",
          allowed: false,
          reasonCode: "authorization_engine_unavailable",
          redactedReason: "Authorization engine is unavailable.",
          evaluatedLayers: ["platform_default"],
          missingScopes: [],
          missingToolsets: [],
          createdAt: new Date().toISOString()
        };
      }
      const authorizationDecision = await resolvedAuthorizationEngine.evaluate(input);
      return evaluateTagPolicy(input, authorizationDecision);
    },
    getGovernancePolicyRevision() {
      return resolvedAuthorizationGovernanceStore?.getPolicyRevision?.() ||
        resolvedTagManagementStore?.getPolicyRevision?.() ||
        defaultGovernancePolicyRevision();
    },
    getGovernanceSummary() {
      if (!resolvedAuthorizationGovernanceStore) {
        return {
          policyRevision: defaultGovernancePolicyRevision(),
          roles: [],
          departments: [],
          teams: [],
          userPolicies: [],
          agentBindings: [],
          agentGroups: [],
          approvals: [],
          apiKeyRecoveryAssignments: []
        };
      }
      return {
        policyRevision: resolvedAuthorizationGovernanceStore.getPolicyRevision?.() || defaultGovernancePolicyRevision(),
        roles: resolvedAuthorizationGovernanceStore.listRoles?.() || [],
        departments: resolvedAuthorizationGovernanceStore.listDepartments?.() || [],
        teams: resolvedAuthorizationGovernanceStore.listTeams?.() || [],
        userPolicies: resolvedAuthorizationGovernanceStore.listUserPolicies?.() || [],
        agentBindings: resolvedAuthorizationGovernanceStore.listAgentBindings?.() || [],
        agentGroups: resolvedAuthorizationGovernanceStore.listAgentGroups?.() || [],
        approvals: resolvedAuthorizationGovernanceStore.listApprovals?.({ includeRevoked: true }) || [],
        apiKeyRecoveryAssignments: resolvedAuthorizationGovernanceStore.listApiKeyRecoveryAssignments?.() || []
      };
    },
    getOrganizationGovernance() {
      if (!resolvedOrganizationGovernanceService?.getOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.getOrganizationGovernance();
    },
    listOrganizationGovernanceTemplates() {
      if (!resolvedOrganizationGovernanceService?.listOrganizationGovernanceTemplates) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.listOrganizationGovernanceTemplates();
    },
    importOrganizationGovernance(input: ProviderRecord = {}) {
      if (!resolvedOrganizationGovernanceService?.importOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.importOrganizationGovernance(input);
    },
    previewOrganizationGovernance(input: ProviderRecord = {}) {
      if (!resolvedOrganizationGovernanceService?.previewOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.previewOrganizationGovernance(input);
    },
    publishOrganizationGovernance(input: ProviderRecord = {}) {
      if (!resolvedOrganizationGovernanceService?.publishOrganizationGovernance) {
        throw Object.assign(
          new Error("Organization governance store is unavailable."),
          { code: "organization_governance_unavailable", statusCode: 503 }
        );
      }
      return resolvedOrganizationGovernanceService.publishOrganizationGovernance(input);
    },
    listGovernanceRoles(input: ProviderRecord = {}) {
      return resolvedAuthorizationGovernanceStore?.listRoles?.(input) || [];
    },
    upsertGovernanceRole(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertRole) {
        throw new Error("Authorization governance role store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertRole(input);
    },
    listGovernanceDepartments(input: ProviderRecord = {}) {
      return resolvedAuthorizationGovernanceStore?.listDepartments?.(input) || [];
    },
    upsertGovernanceDepartment(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertDepartment) {
        throw new Error("Authorization governance department store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertDepartment(input);
    },
    listGovernanceTeams(input: ProviderRecord = {}) {
      return resolvedAuthorizationGovernanceStore?.listTeams?.(input) || [];
    },
    upsertGovernanceTeam(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertTeam) {
        throw new Error("Authorization governance team store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertTeam(input);
    },
    listGovernanceUserPolicies() {
      return resolvedAuthorizationGovernanceStore?.listUserPolicies?.() || [];
    },
    upsertGovernanceUserPolicy(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertUserPolicy) {
        throw new Error("Authorization governance user policy store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertUserPolicy(input);
    },
    listGovernanceAgentGroups(input: ProviderRecord = {}) {
      return resolvedAuthorizationGovernanceStore?.listAgentGroups?.(input) || [];
    },
    upsertGovernanceAgentGroup(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentGroup) {
        throw new Error("Authorization governance agent group store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentGroup(input);
    },
    listGovernanceAgentBindings() {
      return resolvedAuthorizationGovernanceStore?.listAgentBindings?.() || [];
    },
    upsertGovernanceAgentBinding(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertAgentBinding) {
        throw new Error("Authorization governance agent binding store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertAgentBinding(input);
    },
    listTags(input: TagStoreRecord = {}) {
      return resolvedTagManagementStore?.listTags?.(input) || [];
    },
    getTag(tagId = "") {
      return resolvedTagManagementStore?.getTag?.(tagId) || null;
    },
    upsertTag(input: TagStoreRecord = {}) {
      if (!resolvedTagManagementStore?.upsertTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.upsertTag(input);
    },
    archiveTag(tagId = "", input: TagStoreRecord = {}) {
      if (!resolvedTagManagementStore?.archiveTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.archiveTag(tagId, input);
    },
    restoreTag(tagId = "") {
      if (!resolvedTagManagementStore?.restoreTag) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.restoreTag(tagId);
    },
    listTagProjections(input: TagStoreRecord = {}) {
      return resolvedTagManagementStore?.listProjections?.(input) || [];
    },
    rebuildTagProjections() {
      if (!resolvedTagManagementStore?.rebuildProjections) {
        throw new Error("Tag management store is unavailable.");
      }
      return resolvedTagManagementStore.rebuildProjections();
    },
    listTagEvents(input: TagStoreRecord = {}) {
      return resolvedTagManagementStore?.listEvents?.(input) || [];
    },
    listToolProfileTags(input: TagStoreRecord = {}) {
      return resolvedTagManagementStore?.listToolProfiles?.(input) || [];
    },
    seedToolProfileTags(profiles: TagStoreRecord[] = []) {
      return resolvedTagManagementStore?.seedToolProfiles?.(profiles) || { created: 0 };
    },
    listGovernanceApprovals(input: ProviderRecord = {}) {
      return resolvedAuthorizationGovernanceStore?.listApprovals?.(input) || [];
    },
    getGovernanceApproval(approvalId = "") {
      return resolvedAuthorizationGovernanceStore?.getApproval?.(approvalId) || null;
    },
    upsertGovernanceApproval(input: ProviderRecord = {}) {
      if (!resolvedAuthorizationGovernanceStore?.upsertApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.upsertApproval(input);
    },
    revokeGovernanceApproval(approvalId = "", reason = "") {
      if (!resolvedAuthorizationGovernanceStore?.revokeApproval) {
        throw new Error("Authorization governance approval store is unavailable.");
      }
      return resolvedAuthorizationGovernanceStore.revokeApproval(approvalId, reason);
    },
    listReceipts(input: ProviderRecord = {}) {
      return resolvedAuthorizationStore?.listReceipts
        ? resolvedAuthorizationStore.listReceipts(input)
        : [];
    },
    listLoanRecords(input: ProviderRecord = {}) {
      return resolvedAuthorizationStore?.listLoanRecords
        ? resolvedAuthorizationStore.listLoanRecords(input)
        : [];
    },
    listDeniedRequests(input: ProviderRecord = {}) {
      return resolvedAuthorizationStore?.listDeniedRequests
        ? resolvedAuthorizationStore.listDeniedRequests(input)
        : [];
    },
    listDecisions(input: ProviderRecord = {}) {
      return resolvedAuthorizationStore?.listDecisions
        ? resolvedAuthorizationStore.listDecisions(input)
        : [];
    },
    appendReceipt(receipt?: ProviderRecord, metadata: ProviderRecord = {}) {
      if (!receipt || typeof resolvedAuthorizationStore?.appendReceipt !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendReceipt(receipt, metadata);
    },
    appendLoanRecord(record?: ProviderRecord, metadata: ProviderRecord = {}) {
      if (!record || typeof resolvedAuthorizationStore?.appendLoanRecord !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendLoanRecord(record, metadata);
    },
    appendDeniedRequest(request: ProviderRecord = {}) {
      if (!request || typeof resolvedAuthorizationStore?.appendDeniedRequest !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDeniedRequest(request);
    },
    appendDecision(decision: ProviderRecord = {}) {
      if (!decision || typeof resolvedAuthorizationStore?.appendDecision !== "function") {
        return null;
      }
      return resolvedAuthorizationStore.appendDecision(decision);
    },
    setWorkspaceAssetPolicy(input: ProviderRecord = {}) {
      const workspaceId = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId = String(input.policyId || input["policy-id"] || "").trim() || `workspace_asset_policy_${crypto.randomUUID()}`;
      const policy: ProviderRecord = {
        ...input,
        policyId,
        workspaceId,
        updatedAt: new Date().toISOString()
      };
      workspaceAssetPolicies.set(workspaceAssetPolicyKey(workspaceId, policyId), policy);
      return policy;
    },
    getWorkspaceAssetPolicy(input: ProviderRecord = {}) {
      const workspaceId = String(input.workspaceId || input.workspace || "default").trim() || "default";
      const policyId = String(input.policyId || input["policy-id"] || input.id || "").trim();
      if (!policyId) {
        return null;
      }
      return workspaceAssetPolicies.get(workspaceAssetPolicyKey(workspaceId, policyId)) || null;
    },
    async checkWorkspaceAssetPermission(input: PermissionInput = {}) {
      if (!resolvedAuthorizationEngine || typeof resolvedAuthorizationEngine.evaluate !== "function") {
        return null;
      }
      return await resolvedAuthorizationEngine.evaluate({
        operation: {
          id: "workspace.asset.permission.check",
          requiredScopes: ["workspace:read"],
          safety: { risk: "read_only" },
          readOnly: true
        },
        request: input.request || null,
        authSession: input.authSession || null,
        input,
        context: {
          requestedAction: input.requestedAction || input.action || "read",
          requestedEgress: input.requestedEgress || ""
        }
      });
    }
  });
}
