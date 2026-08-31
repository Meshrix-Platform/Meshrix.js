import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "@meshrix/foundation/config/server-config";

type UnknownRecord = Record<string, unknown>;

interface WorkspacePolicy extends UnknownRecord {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  departmentId: string;
  dataClass: string;
  sensitivity: string;
  ownerSubjectIds: string[];
  allowedSubjectIds: string[];
  externalCollaboratorIds: string[];
  allowedActions: string[];
  copyPolicy: string;
  exportAllowed: boolean;
  checkoutAllowed: boolean;
  retention: UnknownRecord & { retainUntil: string; disposalAction: string };
  legalHold: UnknownRecord & { enabled: boolean };
}

interface GovernanceRegistry extends UnknownRecord {
  schemaVersion: string;
  protocolVersion: string;
  updatedAt: string;
  policies: Record<string, WorkspacePolicy>;
  shareGrants: Record<string, UnknownRecord>;
  incompleteUnshares: Record<string, UnknownRecord>;
  auditEvents: UnknownRecord[];
}

interface GovernanceSubject extends UnknownRecord {
  subjectId: string;
  organizationId: string;
  projectIds: string[];
  clearance: string;
  external: boolean;
  roles: string[];
}

interface GovernanceEvaluation extends UnknownRecord {
  action: string;
  subject: GovernanceSubject;
  allowed: boolean;
  reasons: string[];
  obligations: UnknownRecord[];
}

export interface WorkspaceGovernanceService {
  readonly protocolVersion: typeof WORKSPACE_GOVERNANCE_PROTOCOL_VERSION;
  describe(): Promise<UnknownRecord>;
  upsertPolicy(input?: UnknownRecord): Promise<UnknownRecord>;
  evaluate(input?: UnknownRecord): Promise<GovernanceEvaluation>;
  createShareGrant(input?: UnknownRecord, trusted?: UnknownRecord): Promise<UnknownRecord>;
  revokeShareGrants(input?: UnknownRecord): Promise<UnknownRecord>;
  findIncompleteUnshare(input?: UnknownRecord): Promise<UnknownRecord | null>;
  recordIncompleteUnshare(input?: UnknownRecord): Promise<UnknownRecord>;
  markIncompleteUnshareStage(input?: UnknownRecord): Promise<UnknownRecord>;
  completeIncompleteUnshare(input?: UnknownRecord): Promise<UnknownRecord>;
}

export const WORKSPACE_GOVERNANCE_PROTOCOL_VERSION = "v0.0.1:workspace:governance-1" as const;

const REGISTRY_FILE = path.join("workspace-governance", "registry.json");
const DATA_CLASS_RANK: Readonly<Record<string, number>> = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
  secret: 4
});
const VALID_COPY_POLICIES = new Set(["deny", "sameProject", "withApproval", "allow"]);
const DESTRUCTIVE_ACTIONS = new Set(["delete", "purge", "expire", "retention.dispose"]);
const EGRESS_ACTIONS = new Set(["download", "export", "checkout", "copy", "share"]);

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown, fallback: UnknownRecord = {}): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : fallback;
}

function recordMap(value: unknown): Record<string, UnknownRecord> {
  const source = asObject(value);
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, UnknownRecord] =>
      Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]))
  );
}

function asArray(value?: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

function requiredWorkspaceBinding(value: unknown, field = "workspaceId"): string {
  if (typeof value !== "string") {
    throw Object.assign(new TypeError(`${field} must be a non-empty string.`), {
      code: "workspace_binding_invalid"
    });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw Object.assign(new TypeError(`${field} must be a non-empty string.`), {
      code: "workspace_binding_invalid"
    });
  }
  return normalized;
}

function uniqueStrings(value: unknown = []): string[] {
  return [...new Set(asArray(value).map(text).filter(Boolean))];
}


function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 18)}`;
}

async function readJson(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: unknown) {
    if (asObject(error).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function registryPath(userDataPath = ""): string {
  return path.join(userDataPath || ServerConfig.getDataDir(), REGISTRY_FILE);
}

function emptyRegistry(): GovernanceRegistry {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
    updatedAt: nowIso(),
    policies: {},
    shareGrants: {},
    incompleteUnshares: {},
    auditEvents: []
  };
}

function normalizeDataClass(value?: unknown): string {
  const normalized = text(value || "internal");
  return Object.prototype.hasOwnProperty.call(DATA_CLASS_RANK, normalized) ? normalized : "internal";
}

function normalizeRetentionPolicy(value: unknown = {}): WorkspacePolicy["retention"] {
  const retention = asObject(value);
  return {
    policyId: text(retention.policyId || "default"),
    ttlDays: Math.max(0, Number(retention.ttlDays || 0)),
    retainUntil: text(retention.retainUntil || ""),
    disposalAction: text(retention.disposalAction || "review"),
    archiveBeforeDispose: retention.archiveBeforeDispose !== false
  };
}

function normalizeLegalHold(value: unknown = {}): WorkspacePolicy["legalHold"] {
  const legalHold = asObject(value);
  return {
    enabled: legalHold.enabled === true,
    holdIds: uniqueStrings(legalHold.holdIds || legalHold.holdId),
    reason: text(legalHold.reason || ""),
    retainUntilReleased: legalHold.retainUntilReleased !== false
  };
}

export function normalizeWorkspaceGovernancePolicy(input: UnknownRecord = {}): WorkspacePolicy {
  const source = asObject(input);
  const sharePolicy = asObject(source.sharePolicy);
  const workspaceId = requiredWorkspaceBinding(source.workspaceId);
  const copyPolicy = text(source.copyPolicy || sharePolicy.copyPolicy || "sameProject");
  const normalized: WorkspacePolicy = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
    workspaceId,
    organizationId: text(source.organizationId || source.orgId || ""),
    projectId: text(source.projectId || ""),
    departmentId: text(source.departmentId || ""),
    dataClass: normalizeDataClass(source.dataClass),
    sensitivity: text(source.sensitivity || ""),
    ownerSubjectIds: uniqueStrings(source.ownerSubjectIds || source.owners),
    allowedSubjectIds: uniqueStrings(source.allowedSubjectIds || source.subjectIds),
    externalCollaboratorIds: uniqueStrings(source.externalCollaboratorIds || source.externalCollaborators),
    allowedActions: uniqueStrings(source.allowedActions || ["discover", "read", "cite", "copyToContext"]),
    copyPolicy: VALID_COPY_POLICIES.has(copyPolicy) ? copyPolicy : "sameProject",
    exportAllowed: source.exportAllowed === true,
    checkoutAllowed: source.checkoutAllowed === true,
    retention: normalizeRetentionPolicy(source.retention),
    legalHold: normalizeLegalHold(source.legalHold),
    createdAt: text(source.createdAt || nowIso()),
    updatedAt: text(source.updatedAt || nowIso()),
    metadata: asObject(source.metadata)
  };
  return normalized;
}

function dataClassRank(value?: unknown): number {
  return DATA_CLASS_RANK[normalizeDataClass(value)] ?? DATA_CLASS_RANK.internal;
}

function subjectRecord(input: UnknownRecord = {}): GovernanceSubject {
  const subject = asObject(input.subject || input);
  return {
    subjectId: text(subject.subjectId || subject.userId || subject.agentId || input.subjectId || ""),
    organizationId: text(subject.organizationId || input.organizationId || ""),
    projectIds: uniqueStrings(subject.projectIds || subject.projectId || input.projectIds || input.projectId),
    clearance: normalizeDataClass(subject.clearance || subject.dataClassClearance || "internal"),
    external: subject.external === true || input.external === true,
    roles: uniqueStrings(subject.roles || input.roles)
  };
}

function retentionExpired(policy: WorkspacePolicy, now = new Date()): boolean {
  const retainUntil = text(policy.retention.retainUntil || "");
  if (retainUntil) {
    const date = new Date(retainUntil);
    return Number.isFinite(date.getTime()) && date.getTime() < now.getTime();
  }
  return false;
}

function approvalRevision(value: unknown = {}): { grantPolicyRevision: number; governancePolicyRevision: number } {
  const source = asObject(value);
  return {
    grantPolicyRevision: Number(source.grantPolicyRevision || 0),
    governancePolicyRevision: Number(source.governancePolicyRevision || 0)
  };
}

function evaluateCanonicalApproval(approvalFact: unknown, binding: UnknownRecord = {}, now = new Date()): string {
  const fact = asObject(approvalFact);
  const expected = asObject(binding);
  if (!text(fact.pendingOperationId)) return "copy_requires_approval";
  if (fact.status !== "approved") {
    return ["completed", "failed", "rejected", "cancelled", "canceled"].includes(text(fact.status))
      ? "approval_replayed"
      : "approval_not_approved";
  }
  const expiresAt = text(fact.expiresAt);
  if (!expiresAt || !Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= now.getTime()) {
    return "approval_stale";
  }
  for (const field of ["actorId", "operationId", "workspaceId", "targetWorkspaceId", "grantId"]) {
    if (!text(expected[field]) || text(fact[field]) !== text(expected[field])) return "approval_binding_mismatch";
  }
  const actualRevision = approvalRevision(fact.policyRevision);
  const expectedRevision = approvalRevision(expected.policyRevision);
  const actualRevisionSource = asObject(fact.policyRevision);
  const expectedRevisionSource = asObject(expected.policyRevision);
  if (
    !Object.hasOwn(actualRevisionSource, "grantPolicyRevision") ||
    !Object.hasOwn(actualRevisionSource, "governancePolicyRevision") ||
    !Object.hasOwn(expectedRevisionSource, "grantPolicyRevision") ||
    !Object.hasOwn(expectedRevisionSource, "governancePolicyRevision") ||
    actualRevision.grantPolicyRevision < 0 ||
    actualRevision.governancePolicyRevision < 0 ||
    actualRevision.grantPolicyRevision !== expectedRevision.grantPolicyRevision ||
    actualRevision.governancePolicyRevision !== expectedRevision.governancePolicyRevision
  ) {
    return "approval_policy_revision_mismatch";
  }
  return "";
}

function evaluatePolicy(policy: WorkspacePolicy, request: UnknownRecord = {}, trusted: UnknownRecord = {}): GovernanceEvaluation {
  const action = text(request.action || "read");
  const subject = subjectRecord(request);
  const targetWorkspaceId = text(request.targetWorkspaceId || request.destinationWorkspaceId || "");
  const targetProjectId = text(request.targetProjectId || request.destinationProjectId || "");
  const now = request.now ? new Date(String(request.now)) : new Date();
  const reasons: string[] = [];
  const obligations: UnknownRecord[] = [];

  const subjectIsOwner = policy.ownerSubjectIds.includes(subject.subjectId);
  const subjectIsAllowed = policy.allowedSubjectIds.includes(subject.subjectId);
  const subjectIsExternalListed = policy.externalCollaboratorIds.includes(subject.subjectId);
  if (policy.organizationId && subject.organizationId && policy.organizationId !== subject.organizationId && !subjectIsExternalListed) {
    reasons.push("organization_mismatch");
  }
  if (subject.external && !subjectIsExternalListed) {
    reasons.push("external_collaborator_not_listed");
  }
  if (!subjectIsOwner && !subjectIsAllowed && !subjectIsExternalListed) {
    reasons.push("subject_not_allowed");
  }
  if (dataClassRank(subject.clearance) < dataClassRank(policy.dataClass)) {
    reasons.push("insufficient_data_class_clearance");
  }
  if (!policy.allowedActions.includes(action) && !subjectIsOwner) {
    reasons.push("action_not_allowed");
  }
  if (EGRESS_ACTIONS.has(action) && action === "export" && !policy.exportAllowed && !subjectIsOwner) {
    reasons.push("export_not_allowed");
  }
  if (EGRESS_ACTIONS.has(action) && action === "checkout" && !policy.checkoutAllowed && !subjectIsOwner) {
    reasons.push("checkout_not_allowed");
  }
  if (DESTRUCTIVE_ACTIONS.has(action) && policy.legalHold.enabled) {
    reasons.push("legal_hold_blocks_destructive_action");
  }
  if (retentionExpired(policy, now)) {
    obligations.push({
      type: "retention_expired",
      disposalAction: policy.retention.disposalAction,
      blockedByLegalHold: policy.legalHold.enabled
    });
    if (action !== "retention.dispose" && !policy.legalHold.enabled) {
      obligations.push({ type: "retention_review_required" });
    }
  }
  if (["copy", "share"].includes(action) && targetWorkspaceId && targetWorkspaceId !== policy.workspaceId) {
    if (policy.copyPolicy === "deny") {
      reasons.push("cross_workspace_copy_denied");
    } else if (policy.copyPolicy === "sameProject" && targetProjectId && targetProjectId !== policy.projectId) {
      reasons.push("target_project_mismatch");
    } else if (policy.copyPolicy === "withApproval") {
      const approvalReason = evaluateCanonicalApproval(
        trusted.approvalFact,
        asObject(trusted.approvalBinding),
        now
      );
      if (approvalReason) reasons.push(approvalReason);
    }
  }

  return {
    protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
    workspaceId: policy.workspaceId,
    organizationId: policy.organizationId,
    projectId: policy.projectId,
    dataClass: policy.dataClass,
    action,
    subject,
    allowed: reasons.length === 0,
    reasons,
    obligations,
    evaluatedAt: nowIso()
  };
}

function publicRegistry(registry: GovernanceRegistry = emptyRegistry()): UnknownRecord {
  return {
    schemaVersion: registry.schemaVersion,
    protocolVersion: registry.protocolVersion,
    updatedAt: registry.updatedAt,
    policies: Object.values(registry.policies || {}),
    shareGrants: Object.values(registry.shareGrants || {}),
    incompleteUnshares: Object.values(registry.incompleteUnshares || {}),
    auditEvents: registry.auditEvents || []
  };
}

export function createWorkspaceGovernanceRegistry({ userDataPath = "" }: { userDataPath?: string } = {}): WorkspaceGovernanceService {
  const filePath = registryPath(userDataPath);
  let mutationTail: Promise<void> = Promise.resolve();

  function enqueueMutation<T>(task: () => T | Promise<T>): Promise<T> {
    const current = mutationTail.then(task, task);
    mutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  async function afterMutations<T>(task: () => T | Promise<T>): Promise<T> {
    await mutationTail;
    return task();
  }

  async function readRegistry(): Promise<GovernanceRegistry> {
    const loaded = asObject(await readJson(filePath, emptyRegistry()));
    return {
      ...emptyRegistry(),
      ...loaded,
      policies: asObject(loaded.policies) as Record<string, WorkspacePolicy>,
      shareGrants: recordMap(loaded.shareGrants),
      incompleteUnshares: recordMap(loaded.incompleteUnshares),
      auditEvents: asArray(loaded.auditEvents).filter((event): event is UnknownRecord => Boolean(event) && typeof event === "object" && !Array.isArray(event))
    };
  }

  async function writeRegistry(registry: GovernanceRegistry): Promise<GovernanceRegistry> {
    const next: GovernanceRegistry = {
      ...registry,
      protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
      updatedAt: nowIso()
    };
    await writeJson(filePath, next);
    return next;
  }

  function audit(registry: GovernanceRegistry, eventType: string, payload: UnknownRecord = {}): UnknownRecord {
    const workspaceId = requiredWorkspaceBinding(payload.workspaceId);
    const event: UnknownRecord = {
      auditId: stableId("workspace_governance_audit", { eventType, payload, nonce: crypto.randomUUID() }),
      eventType,
      workspaceId,
      payload,
      createdAt: nowIso()
    };
    registry.auditEvents.push(event);
    return event;
  }

  const api: WorkspaceGovernanceService = {
    protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
    async describe(): Promise<UnknownRecord> {
      return publicRegistry(await readRegistry());
    },
    async upsertPolicy(input: UnknownRecord = {}): Promise<UnknownRecord> {
      const policy = normalizeWorkspaceGovernancePolicy(input);
      const registry = await readRegistry();
      registry.policies[policy.workspaceId] = {
        ...registry.policies[policy.workspaceId],
        ...policy,
        updatedAt: nowIso()
      };
      const event = audit(registry, "workspace_governance.policy.upserted", {
        workspaceId: policy.workspaceId,
        organizationId: policy.organizationId,
        projectId: policy.projectId,
        dataClass: policy.dataClass
      });
      await writeRegistry(registry);
      return {
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        policy: registry.policies[policy.workspaceId],
        audit: event
      };
    },
    async evaluate(input: UnknownRecord = {}): Promise<GovernanceEvaluation> {
      const workspaceId = requiredWorkspaceBinding(input.workspaceId);
      const registry = await readRegistry();
      const policy = registry.policies[workspaceId] || normalizeWorkspaceGovernancePolicy({ workspaceId });
      if (requiredWorkspaceBinding(policy.workspaceId) !== workspaceId) {
        throw Object.assign(new Error("Workspace governance policy binding conflicts with persisted state."), {
          code: "workspace_binding_invalid"
        });
      }
      const evaluation = evaluatePolicy(policy, input);
      audit(registry, "workspace_governance.evaluated", {
        workspaceId,
        action: evaluation.action,
        subjectId: evaluation.subject.subjectId,
        allowed: evaluation.allowed,
        reasons: evaluation.reasons
      });
      await writeRegistry(registry);
      return evaluation;
    },
    async createShareGrant(input: UnknownRecord = {}, trusted: UnknownRecord = {}): Promise<UnknownRecord> {
      const workspaceId = requiredWorkspaceBinding(input.workspaceId);
      const targetWorkspaceId = requiredWorkspaceBinding(input.targetWorkspaceId, "targetWorkspaceId");
      const registry = await readRegistry();
      const policy = registry.policies[workspaceId] || normalizeWorkspaceGovernancePolicy({ workspaceId });
      if (requiredWorkspaceBinding(policy.workspaceId) !== workspaceId) {
        throw Object.assign(new Error("Workspace governance policy binding conflicts with persisted state."), {
          code: "workspace_binding_invalid"
        });
      }
      const evaluation = evaluatePolicy(policy, {
        ...input,
        workspaceId,
        targetWorkspaceId,
        action: input.action || "share"
      }, trusted);
      if (!evaluation.allowed) {
        return {
          protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
          granted: false,
          evaluation
        };
      }
      const shareGrantId = stableId("workspace_share_grant", {
          workspaceId,
          granteeId: input.granteeId,
          targetWorkspaceId,
          actions: input.actions
        });
      const grant: UnknownRecord = {
        shareGrantId,
        workspaceId,
        organizationId: policy.organizationId,
        projectId: policy.projectId,
        granteeId: text(input.granteeId || evaluation.subject.subjectId),
        targetWorkspaceId,
        actions: uniqueStrings(input.actions || [evaluation.action]),
        dataClass: policy.dataClass,
        retention: policy.retention,
        legalHold: policy.legalHold,
        expiresAt: text(input.expiresAt || ""),
        createdAt: nowIso()
      };
      registry.shareGrants[shareGrantId] = grant;
      const event = audit(registry, "workspace_governance.share_granted", grant);
      await writeRegistry(registry);
      return {
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        granted: true,
        shareGrant: grant,
        evaluation,
        audit: event
      };
    },
    async revokeShareGrants(input: UnknownRecord = {}): Promise<UnknownRecord> {
      const shareGrantId = text(input.shareGrantId || input.grantId || "");
      const workspaceId = Object.hasOwn(input, "workspaceId")
        ? requiredWorkspaceBinding(input.workspaceId)
        : "";
      const targetWorkspaceId = Object.hasOwn(input, "targetWorkspaceId")
        ? requiredWorkspaceBinding(input.targetWorkspaceId, "targetWorkspaceId")
        : "";
      const granteeId = text(input.granteeId || "");
      if (!shareGrantId && (!workspaceId || !targetWorkspaceId)) {
        throw new Error("Share grant revocation requires shareGrantId or workspaceId and targetWorkspaceId.");
      }
      const registry = await readRegistry();
      const matches = Object.values(registry.shareGrants).filter((grant) => {
        if (shareGrantId) return grant.shareGrantId === shareGrantId;
        return grant.workspaceId === workspaceId &&
          grant.targetWorkspaceId === targetWorkspaceId &&
          (!granteeId || grant.granteeId === granteeId);
      });
      if (shareGrantId && matches.length === 0) {
        return {
          protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
          revoked: false,
          revokedCount: 0,
          audit: null
        };
      }
      const validatedMatches = matches.map((grant) => {
        const storedWorkspaceId = requiredWorkspaceBinding(grant.workspaceId);
        const storedTargetWorkspaceId = requiredWorkspaceBinding(grant.targetWorkspaceId, "targetWorkspaceId");
        const storedShareGrantId = requiredWorkspaceBinding(grant.shareGrantId, "shareGrantId");
        if (
          (workspaceId && workspaceId !== storedWorkspaceId) ||
          (targetWorkspaceId && targetWorkspaceId !== storedTargetWorkspaceId)
        ) {
          throw Object.assign(new Error("Share grant revocation binding conflicts with persisted state."), {
            code: "workspace_binding_invalid"
          });
        }
        return { grant, storedWorkspaceId, storedTargetWorkspaceId, storedShareGrantId };
      });
      for (const match of validatedMatches) delete registry.shareGrants[match.storedShareGrantId];
      const event = audit(registry, "workspace_governance.share_revoked", {
        workspaceId: workspaceId || validatedMatches[0]?.storedWorkspaceId,
        targetWorkspaceId: targetWorkspaceId || validatedMatches[0]?.storedTargetWorkspaceId,
        actorId: text(input.actorId || ""),
        reason: text(input.reason || ""),
        revokedCount: validatedMatches.length
      });
      await writeRegistry(registry);
      return {
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        revoked: validatedMatches.length > 0,
        revokedCount: validatedMatches.length,
        audit: event
      };
    },
    async findIncompleteUnshare(input: UnknownRecord = {}): Promise<UnknownRecord | null> {
      const registry = await readRegistry();
      const idempotencyKey = text(input.idempotencyKey || "");
      if (!idempotencyKey) throw new Error("Incomplete unshare lookup requires idempotencyKey.");
      const recordId = stableId("workspace_incomplete_unshare", { idempotencyKey });
      return registry.incompleteUnshares[recordId] || null;
    },
    async recordIncompleteUnshare(input: UnknownRecord = {}): Promise<UnknownRecord> {
      const workspaceId = requiredWorkspaceBinding(input.workspaceId);
      const targetWorkspaceId = requiredWorkspaceBinding(input.targetWorkspaceId, "targetWorkspaceId");
      const granteeId = text(input.granteeId || targetWorkspaceId);
      const idempotencyKey = text(input.idempotencyKey || "");
      if (!idempotencyKey) {
        throw new Error("Incomplete unshare requires workspace, target, and idempotencyKey.");
      }
      const registry = await readRegistry();
      const recordId = stableId("workspace_incomplete_unshare", { idempotencyKey });
      const existing = registry.incompleteUnshares[recordId];
      if (existing && (
        existing.workspaceId !== workspaceId ||
        existing.targetWorkspaceId !== targetWorkspaceId ||
        existing.granteeId !== granteeId
      )) {
        throw new Error("Incomplete unshare idempotency binding conflicts.");
      }
      if (existing) {
        return {
          protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
          record: existing,
          created: false,
          advanced: false
        };
      }
      const record: UnknownRecord = {
        recordId,
        idempotencyKey,
        workspaceId,
        targetWorkspaceId,
        granteeId,
        stage: "intent_persisted",
        actorId: text(input.actorId || ""),
        reason: text(input.reason || "workspace_unshared"),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      registry.incompleteUnshares[recordId] = record;
      const event = audit(registry, "workspace_governance.unshare_intent_persisted", {
        recordId,
        workspaceId,
        targetWorkspaceId,
        stage: record.stage
      });
      await writeRegistry(registry);
      return { protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION, record, created: true, advanced: true, audit: event };
    },
    async markIncompleteUnshareStage(input: UnknownRecord = {}): Promise<UnknownRecord> {
      const registry = await readRegistry();
      const idempotencyKey = text(input.idempotencyKey || "");
      const stage = text(input.stage || "");
      if (!idempotencyKey || !["acl_removal_in_progress", "acl_removed_grant_pending"].includes(stage)) {
        throw new Error("Incomplete unshare stage transition is invalid.");
      }
      const recordId = stableId("workspace_incomplete_unshare", { idempotencyKey });
      const record = registry.incompleteUnshares[recordId];
      if (!record) throw new Error("Incomplete unshare intent is missing.");
      const workspaceId = requiredWorkspaceBinding(record.workspaceId);
      const targetWorkspaceId = requiredWorkspaceBinding(record.targetWorkspaceId, "targetWorkspaceId");
      const transitions: Record<string, string> = {
        intent_persisted: "acl_removal_in_progress",
        acl_removal_in_progress: "acl_removed_grant_pending"
      };
      if (record.stage === stage) {
        return { protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION, record, advanced: false };
      }
      if (transitions[text(record.stage)] !== stage) {
        throw new Error("Incomplete unshare stage transition conflicts with persisted state.");
      }
      const updated: UnknownRecord = { ...record, stage, updatedAt: nowIso() };
      registry.incompleteUnshares[recordId] = updated;
      const event = audit(registry, "workspace_governance.unshare_stage_advanced", {
        recordId,
        workspaceId,
        targetWorkspaceId,
        stage
      });
      await writeRegistry(registry);
      return { protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION, record: updated, advanced: true, audit: event };
    },
    async completeIncompleteUnshare(input: UnknownRecord = {}): Promise<UnknownRecord> {
      const registry = await readRegistry();
      const idempotencyKey = text(input.idempotencyKey || "");
      if (!idempotencyKey) throw new Error("Incomplete unshare completion requires idempotencyKey.");
      const recordId = stableId("workspace_incomplete_unshare", { idempotencyKey });
      const record = registry.incompleteUnshares[recordId];
      if (!record) return { protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION, completed: false, recordId };
      const workspaceId = requiredWorkspaceBinding(record.workspaceId);
      const targetWorkspaceId = requiredWorkspaceBinding(record.targetWorkspaceId, "targetWorkspaceId");
      if (record.stage !== "acl_removed_grant_pending") {
        throw new Error("Incomplete unshare ACL removal is not complete.");
      }
      const matches = Object.values(registry.shareGrants).filter((grant) =>
        grant.workspaceId === workspaceId &&
        grant.targetWorkspaceId === targetWorkspaceId &&
        (!record.granteeId || grant.granteeId === record.granteeId)
      );
      const shareGrantIds = matches.map((grant) => requiredWorkspaceBinding(grant.shareGrantId, "shareGrantId"));
      for (const shareGrantId of shareGrantIds) delete registry.shareGrants[shareGrantId];
      delete registry.incompleteUnshares[recordId];
      const event = audit(registry, "workspace_governance.unshare_reconciled", {
        recordId,
        workspaceId,
        targetWorkspaceId,
        revokedCount: matches.length
      });
      await writeRegistry(registry);
      return {
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        completed: true,
        recordId,
        revoked: matches.length > 0,
        revokedCount: matches.length,
        audit: event
      };
    }
  };
  return Object.freeze({
    protocolVersion: api.protocolVersion,
    describe: () => afterMutations(() => api.describe()),
    upsertPolicy: (input?: UnknownRecord) => enqueueMutation(() => api.upsertPolicy(input)),
    evaluate: (input?: UnknownRecord) => enqueueMutation(() => api.evaluate(input)),
    createShareGrant: (input?: UnknownRecord, trusted?: UnknownRecord) =>
      enqueueMutation(() => api.createShareGrant(input, trusted)),
    revokeShareGrants: (input?: UnknownRecord) => enqueueMutation(() => api.revokeShareGrants(input)),
    findIncompleteUnshare: (input?: UnknownRecord) => afterMutations(() => api.findIncompleteUnshare(input)),
    recordIncompleteUnshare: (input?: UnknownRecord) => enqueueMutation(() => api.recordIncompleteUnshare(input)),
    markIncompleteUnshareStage: (input?: UnknownRecord) => enqueueMutation(() => api.markIncompleteUnshareStage(input)),
    completeIncompleteUnshare: (input?: UnknownRecord) => enqueueMutation(() => api.completeIncompleteUnshare(input))
  });
}
