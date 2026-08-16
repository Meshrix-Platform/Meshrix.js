import { createAuthorizationEngine } from "#meshrix/foundation/security/authorization/authorization-engine";
import {
  assertConsumedGovernedExecutionPermit,
  consumeGovernedExecutionPermit,
  digestGovernedExecutionPrincipal,
  digestGovernedExecutionRequest,
  mintGovernedExecutionPermit
} from "#meshrix/foundation/security/governed-execution-permit-authority";
import {
  SERVICE_COLLABORATION_CANCELLATION_STATES,
  SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS,
  SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY,
  SERVICE_COLLABORATION_EFFECT_RESULT_STATES,
  SERVICE_COLLABORATION_FAMILIES,
  SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS,
  SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY,
  assertEffectCommandFamily,
  containsForbiddenKeys,
  createEffectCommand,
  effectRetryAllowed,
  lookupFactIsAuthority
} from "@meshrix/contracts/service-collaboration-contract";

type UnknownRecord = Record<string, unknown>;
type EffectSink = (input: Readonly<UnknownRecord>) => unknown | Promise<unknown>;
type AuthorizationRevalidator = (input: Readonly<UnknownRecord>) => unknown | Promise<unknown>;

interface EffectBinding extends UnknownRecord {
  effectId: string;
  idempotency: string;
  principalLookup: string;
  grantLookup: string;
  targetRef: string;
  policyRef: string;
  approvalLookup: string;
  audienceRef: string;
  requestRef: string;
  auditRef: string;
  compensationRef: string | null;
}

interface CurrentEffectAuthorization extends UnknownRecord {
  allowed: boolean;
  reasonCode: string;
  principalLookup: string;
  grantLookup: string;
  targetRef: string;
  policyRef: string;
  approvalLookup: string;
  audienceRef: string;
  requestRef: string;
  grantRevision: string;
  policyRevision: string;
  approvalRevision: string;
  riskRevision: string;
  workloadGeneration: string;
  subject: Readonly<{ type: string; subjectId: string; tenantId: string; generation: string }>;
}

interface EffectRecord extends EffectBinding {
  command: UnknownRecord;
  resultState: string;
  cancellationState: string;
  authorizationReResolved: boolean;
  reasonCode: string;
}

interface RuntimeOptions {
  revalidateAuthorization?: AuthorizationRevalidator | null;
  performExternalEffect?: EffectSink | null;
  now?: number | (() => number);
}

interface EffectResult extends UnknownRecord {
  ok: boolean;
  binding?: Readonly<EffectBinding>;
  reasonCode?: string;
}

export interface ExplicitEffectCommandRuntime {
  readonly family: typeof EXPLICIT_EFFECT_COMMAND_FAMILY;
  readonly documentFamily: typeof EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY;
  readonly families: readonly unknown[];
  readonly permitAuthority: string;
  readonly capacityCertified: false;
  bind(input?: UnknownRecord): EffectResult;
  execute(input?: UnknownRecord): Promise<EffectResult>;
  retry(input?: UnknownRecord): EffectResult;
  cancel(input?: UnknownRecord): EffectResult;
  compensate(input?: UnknownRecord): Promise<Readonly<UnknownRecord>>;
  inspect(effectId?: unknown): EffectResult | null;
  mergeIntoChangeSet: typeof mergeEffectCommandIntoChangeSet;
  rejectCrdtMerge: typeof rejectCrdtEffectMerge;
}

export const EXPLICIT_EFFECT_COMMAND_FAMILY = "effect-command" as const;
export const EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY = "document-state" as const;
export const EXPLICIT_EFFECT_COMMAND_OPERATION_ID = "collaboration.effect" as const;
export const EXPLICIT_EFFECT_COMMAND_AUDIENCE = "service-collaboration-effect-command" as const;
export const EXPLICIT_EFFECT_COMMAND_TRANSPORT = "effect-command" as const;
export const EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY =
  "packages/foundation/src/security/governed-execution-permit-authority.ts";
export const EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED = false as const;
export const EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON = "owner_profile_not_authorized" as const;
export const EXPLICIT_EFFECT_COMMAND_MAX_RECORDS = 4_096;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const REQUIRED_LOOKUP_KEYS = Object.freeze([
  "principalLookup",
  "grantLookup",
  "targetRef",
  "policyRef",
  "approvalLookup",
  "audienceRef",
  "requestRef"
]) satisfies readonly string[];
const CURRENT_REVISION_KEYS = Object.freeze([
  "grantRevision",
  "policyRevision",
  "approvalRevision",
  "riskRevision",
  "workloadGeneration"
]) satisfies readonly string[];

function text(value?: unknown, maxBytes = 128): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function opaqueId(value?: unknown): string {
  const normalized = text(value);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : "";
}

function requiredOpaque(value: unknown, field: string): string {
  const normalized = opaqueId(value);
  if (!normalized) {
    deny("effect_command_binding_incomplete", `Effect Command requires ${field}.`);
  }
  return normalized;
}

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, statusCode: 403, retryable: false });
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function includesValue(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

function usesLookupFactAsAuthority(input: UnknownRecord = {}): boolean {
  const source = text(input.authoritySource || input.authorizationSource);
  if (source && includesValue(SERVICE_COLLABORATION_LOOKUP_FACTS, source)) return true;
  if (input.usePriorApprovalAsAuthority === true) return true;
  if (input.priorApproval === true && input.revalidationPerformed !== true) return true;
  return false;
}

function usesStrategyPreviewAsAuthority(input: UnknownRecord = {}): boolean {
  return Boolean(
    input.strategyPreview ||
    input.previewDecision ||
    input.dryRunResult ||
    input.dryRunOnly === true && input.usePreviewAsAuthority === true
  );
}

function copiedReResolutionIsProof(input: UnknownRecord = {}): boolean {
  return input.authorizationReResolved === true && input.revalidationPerformed !== true && input.skipRevalidation === true;
}

function currentAuthorizationDenied(input: UnknownRecord = {}): Readonly<{ allowed: false; reasonCode: string }> | null {
  if (usesLookupFactAsAuthority(input)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "prior_approval_is_not_authority"
    });
  }
  if (usesStrategyPreviewAsAuthority(input)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "strategy_preview_is_not_execution_credential"
    });
  }
  if (copiedReResolutionIsProof(input)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "copied_authorization_is_not_authority"
    });
  }
  return null;
}

export function createExplicitEffectCommandInput(value: UnknownRecord = {}): Readonly<UnknownRecord> {
  const current = createCurrentEffectAuthorization(value);
  const authorization = isPlainObject(value.authorization) ? value.authorization : {};
  return Object.freeze({
    family: EXPLICIT_EFFECT_COMMAND_FAMILY,
    effectId: requiredOpaque(value.effectId || "eff.sc.1", "effectId"),
    idempotency: includesValue(SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY, value.idempotency)
      ? String(value.idempotency)
      : "idempotent",
    principalLookup: current.principalLookup,
    grantLookup: current.grantLookup,
    targetRef: current.targetRef,
    policyRef: current.policyRef,
    approvalLookup: current.approvalLookup,
    audienceRef: current.audienceRef,
    requestRef: current.requestRef,
    auditRef: requiredOpaque(value.auditRef || "audt.sc.1", "auditRef"),
    compensationRef: value.compensationRef === undefined ? null : value.compensationRef,
    cancellationState: value.cancellationState,
    authorization: Object.freeze({
      ...current,
      ...authorization,
      usePriorApprovalAsAuthority: value.usePriorApprovalAsAuthority === true ||
        authorization.usePriorApprovalAsAuthority === true,
      usePreviewAsAuthority: value.usePreviewAsAuthority === true ||
        authorization.usePreviewAsAuthority === true,
      strategyPreview: value.strategyPreview || authorization.strategyPreview,
      previewDecision: value.previewDecision || authorization.previewDecision,
      dryRunResult: value.dryRunResult || authorization.dryRunResult
    })
  });
}

export function createCurrentEffectAuthorization(value: UnknownRecord = {}): Readonly<CurrentEffectAuthorization> {
  const subject = isPlainObject(value.subject) ? value.subject : {};
  const grant = isPlainObject(value.grant) ? value.grant : {};
  return Object.freeze({
    allowed: value.allowed !== false,
    reasonCode: text(value.reasonCode) || "allowed",
    principalLookup: requiredOpaque(value.principalLookup || subject.subjectId || "prin.sc.1", "principalLookup"),
    grantLookup: requiredOpaque(value.grantLookup || grant.id || "gr.sc.1", "grantLookup"),
    targetRef: requiredOpaque(value.targetRef || "tgt.sc.1", "targetRef"),
    policyRef: requiredOpaque(value.policyRef || "pol.sc.1", "policyRef"),
    approvalLookup: requiredOpaque(value.approvalLookup || "apr.sc.1", "approvalLookup"),
    audienceRef: requiredOpaque(value.audienceRef || "aud.sc.1", "audienceRef"),
    requestRef: requiredOpaque(value.requestRef || "req.sc.1", "requestRef"),
    grantRevision: requiredOpaque(value.grantRevision || grant.revision || "rev.grant.1", "grantRevision"),
    policyRevision: requiredOpaque(value.policyRevision || "rev.policy.1", "policyRevision"),
    approvalRevision: requiredOpaque(value.approvalRevision || "rev.approval.1", "approvalRevision"),
    riskRevision: requiredOpaque(value.riskRevision || "rev.risk.1", "riskRevision"),
    workloadGeneration: requiredOpaque(value.workloadGeneration || subject.generation || "gen.sc.1", "workloadGeneration"),
    subject: Object.freeze({
      type: requiredOpaque(subject.type || "workload", "subject.type"),
      subjectId: requiredOpaque(subject.subjectId || value.principalLookup || "prin.sc.1", "subject.subjectId"),
      tenantId: requiredOpaque(subject.tenantId || "ten.sc.1", "subject.tenantId"),
      generation: requiredOpaque(subject.generation || value.workloadGeneration || "gen.sc.1", "subject.generation")
    })
  });
}

function createDefaultRevalidator(): AuthorizationRevalidator {
  const engine = createAuthorizationEngine();
  return async (input: Readonly<UnknownRecord> = {}) => {
    const blocked = currentAuthorizationDenied(input);
    if (blocked) return blocked;
    const current = createCurrentEffectAuthorization(input);
    const decision = await engine.evaluate({
      operation: Object.freeze({
        id: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
        public: false,
        readOnly: false
      }),
      subject: current.subject,
      grant: isPlainObject(input.grant) ? input.grant : null,
      enforceConfirmation: true,
      dryRun: false
    });
    if (decision?.allowed !== true) {
      return Object.freeze({
        allowed: false,
        reasonCode: text(decision?.reasonCode) || "execution_authorization_denied"
      });
    }
    return current;
  };
}

function commandProjection(value: UnknownRecord = {}): Readonly<UnknownRecord> {
  return Object.freeze({
    family: value.family,
    effectId: value.effectId,
    idempotency: value.idempotency,
    principalLookup: value.principalLookup,
    grantLookup: value.grantLookup,
    targetRef: value.targetRef,
    policyRef: value.policyRef,
    approvalLookup: value.approvalLookup,
    audienceRef: value.audienceRef,
    requestRef: value.requestRef,
    cancellationState: value.cancellationState,
    resultState: value.resultState,
    auditRef: value.auditRef,
    compensationRef: value.compensationRef
  });
}

function bindLookups(value: UnknownRecord = {}): Readonly<EffectBinding> {
  const bound: Record<string, string> = {};
  for (const key of REQUIRED_LOOKUP_KEYS) {
    bound[key] = requiredOpaque(value[key], key);
  }
  return Object.freeze({
    principalLookup: bound.principalLookup,
    grantLookup: bound.grantLookup,
    targetRef: bound.targetRef,
    policyRef: bound.policyRef,
    approvalLookup: bound.approvalLookup,
    audienceRef: bound.audienceRef,
    requestRef: bound.requestRef,
    effectId: requiredOpaque(value.effectId, "effectId"),
    idempotency: includesValue(SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY, value.idempotency)
      ? String(value.idempotency)
      : deny("effect_command_idempotency_required", "Effect Command requires idempotent or explicit non_idempotent."),
    auditRef: requiredOpaque(value.auditRef || `audt.${value.effectId}`, "auditRef"),
    compensationRef: value.compensationRef == null ? null : requiredOpaque(value.compensationRef, "compensationRef")
  });
}

function lookupsMatch(bound: UnknownRecord, current: UnknownRecord): boolean {
  return REQUIRED_LOOKUP_KEYS.every((key) => bound[key] === current[key]);
}

function privacySafeAudit(record: UnknownRecord = {}): Readonly<UnknownRecord> {
  return Object.freeze({
    auditRef: record.auditRef,
    effectId: record.effectId,
    family: EXPLICIT_EFFECT_COMMAND_FAMILY,
    idempotency: record.idempotency,
    cancellationState: record.cancellationState,
    resultState: record.resultState,
    currentFactsReResolved: record.authorizationReResolved === true || record.currentFactsReResolved === true,
    compensationRef: record.compensationRef ?? null,
    reversesExternalEffect: false,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
  });
}

export function changeSetHidesEffectCommand(changeSet?: unknown): boolean {
  if (!isPlainObject(changeSet)) return false;
  if (changeSet.family === EXPLICIT_EFFECT_COMMAND_FAMILY) return true;
  if (changeSet.effectId || changeSet.effectCommand) return true;
  const operations: unknown[] = Array.isArray(changeSet.operations) ? changeSet.operations : [];
  return operations.some((operation) => (
    isPlainObject(operation) && (
      operation.family === EXPLICIT_EFFECT_COMMAND_FAMILY ||
      Boolean(operation.effectId) ||
      Boolean(operation.effectCommand)
    )
  ));
}

export function mergeEffectCommandIntoChangeSet(_effect?: unknown, changeSet?: unknown): Readonly<UnknownRecord> {
  return Object.freeze({
    ok: false,
    merged: false,
    hidden: changeSetHidesEffectCommand(changeSet),
    familySeparated: true,
    reasonCode: "effect_hidden_in_merge",
    reversesExternalEffect: false,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
  });
}

export function rejectCrdtEffectMerge(value?: unknown): Readonly<UnknownRecord> {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  const crdt = keys.some((key) => includesValue(SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS, key));
  return Object.freeze({
    ok: false,
    merged: false,
    crdtRejected: crdt || containsForbiddenKeys(value) === true,
    reasonCode: "effect_crdt_merge_forbidden",
    reversesExternalEffect: SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
  });
}

export function compensateUnownedExternalEffect(value: UnknownRecord = {}): Readonly<UnknownRecord> {
  return Object.freeze({
    ok: false,
    compensated: false,
    owned: false,
    reversesExternalEffect: false,
    originalEffectId: opaqueId(value.effectId) || null,
    reasonCode: "unowned_external_effect",
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
  });
}

function retryFence(record?: EffectRecord | null): Readonly<UnknownRecord> {
  if (!record) {
    return Object.freeze({
      allowed: false,
      retried: false,
      invokedSink: false,
      reasonCode: "effect_not_owned"
    });
  }
  if (SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY !== false) {
    deny("silent_uncertain_retry_forbidden", "Uncertain Effect Commands must not be retried silently.");
  }
  if (record.resultState === "uncertain") {
    return Object.freeze({
      allowed: false,
      retried: false,
      invokedSink: false,
      reasonCode: "conflict.effect_uncertain",
      resultState: record.resultState
    });
  }
  if (record.resultState === "cancelled" || record.idempotency !== "idempotent") {
    return Object.freeze({
      allowed: false,
      retried: false,
      invokedSink: false,
      reasonCode: "conflict.effect_not_retryable",
      resultState: record.resultState
    });
  }
  return Object.freeze({
    allowed: effectRetryAllowed(record.command) === true,
    retried: false,
    invokedSink: false,
    reasonCode: "effect_idempotent_replay",
    resultState: record.resultState
  });
}

export function createExplicitEffectCommandRuntime({
  revalidateAuthorization = null,
  performExternalEffect = null,
  now = Date.now
}: RuntimeOptions = {}): ExplicitEffectCommandRuntime {
  const records = new Map<string, Readonly<EffectRecord>>();
  const resolveAuthorization: AuthorizationRevalidator = typeof revalidateAuthorization === "function"
    ? revalidateAuthorization
    : createDefaultRevalidator();
  if (typeof performExternalEffect !== "function") {
    throw new TypeError("Explicit Effect Commands require an external-effect sink.");
  }
  const effectSink: EffectSink = performExternalEffect;

  function stored(effectId?: unknown): Readonly<EffectRecord> | null {
    return typeof effectId === "string" ? records.get(effectId) || null : null;
  }

  function remember(record: Readonly<EffectRecord>): Readonly<EffectRecord> {
    if (!records.has(record.effectId) && records.size >= EXPLICIT_EFFECT_COMMAND_MAX_RECORDS) {
      deny("effect_command_backpressure", "Explicit Effect Command capacity is exhausted.");
    }
    records.set(record.effectId, record);
    return record;
  }

  function project(record: Readonly<EffectRecord> | null, extras: UnknownRecord = {}): EffectResult {
    return Object.freeze({
      ok: extras.ok !== false,
      handled: true,
      family: EXPLICIT_EFFECT_COMMAND_FAMILY,
      command: record?.command || null,
      effectId: record?.effectId || extras.effectId || null,
      resultState: record?.resultState || extras.resultState || null,
      cancellationState: record?.cancellationState || extras.cancellationState || "none",
      invokedSink: extras.invokedSink === true,
      permitConsumed: extras.permitConsumed === true,
      retryAllowed: extras.retryAllowed === true,
      authorizationReResolved: extras.authorizationReResolved === true || record?.authorizationReResolved === true,
      reversesExternalEffect: false,
      compensated: extras.compensated === true,
      owned: extras.owned !== false,
      reasonCode: text(extras.reasonCode) || record?.reasonCode || "ok",
      audit: record ? privacySafeAudit(record) : extras.audit || null,
      capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
      permitAuthority: EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY
    });
  }

  function denied(reasonCode: string, extras: UnknownRecord = {}): EffectResult {
    const record = isPlainObject(extras.record) ? extras.record as EffectRecord : null;
    return project(record, {
      ok: false,
      invokedSink: false,
      permitConsumed: extras.permitConsumed === true,
      retryAllowed: false,
      authorizationReResolved: extras.authorizationReResolved === true,
      owned: extras.owned !== false,
      reasonCode,
      effectId: extras.effectId,
      resultState: extras.resultState,
      cancellationState: extras.cancellationState,
      audit: extras.audit
    });
  }

  async function currentAuthority(input: UnknownRecord = {}): Promise<Readonly<CurrentEffectAuthorization> | Readonly<{ allowed: false; reasonCode: string }>> {
    const facts = isPlainObject(input.authorization) ? input.authorization : input;
    const blocked = currentAuthorizationDenied(facts);
    if (blocked) return blocked;
    let decision: unknown;
    try {
      decision = await resolveAuthorization(Object.freeze({
        ...facts,
        phase: "execution",
        revalidationPerformed: true,
        skipRevalidation: false,
        principalLookup: input.principalLookup || facts.principalLookup,
        grantLookup: input.grantLookup || facts.grantLookup,
        targetRef: input.targetRef || facts.targetRef,
        policyRef: input.policyRef || facts.policyRef,
        approvalLookup: input.approvalLookup || facts.approvalLookup,
        audienceRef: input.audienceRef || facts.audienceRef,
        requestRef: input.requestRef || facts.requestRef
      }));
    } catch {
      return Object.freeze({
        allowed: false,
        reasonCode: "execution_authorization_failed"
      });
    }
    if (!isPlainObject(decision) || decision.allowed !== true) {
      return Object.freeze({
        allowed: false,
        reasonCode: text(isPlainObject(decision) ? decision.reasonCode : undefined) || "execution_authorization_denied"
      });
    }
    try {
      return createCurrentEffectAuthorization({ ...input, ...facts, ...decision });
    } catch {
      return Object.freeze({
        allowed: false,
        reasonCode: "execution_authorization_facts_incomplete"
      });
    }
  }

  function toCommand(bound: Readonly<EffectBinding>, resultState: unknown, cancellationState: unknown = "none"): UnknownRecord {
    return createEffectCommand({
      effectId: bound.effectId,
      idempotency: bound.idempotency,
      principalLookup: bound.principalLookup,
      grantLookup: bound.grantLookup,
      targetRef: bound.targetRef,
      policyRef: bound.policyRef,
      approvalLookup: bound.approvalLookup,
      audienceRef: bound.audienceRef,
      requestRef: bound.requestRef,
      cancellationState,
      resultState,
      auditRef: bound.auditRef,
      compensationRef: bound.compensationRef
    }) as UnknownRecord;
  }

  function bind(input: UnknownRecord = {}): EffectResult {
    const command = commandProjection(input);
    if (command.family && command.family !== EXPLICIT_EFFECT_COMMAND_FAMILY) {
      return denied("effect_family_separated", { effectId: opaqueId(command.effectId) });
    }
    if (containsForbiddenKeys(command)) {
      return denied(
        SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS.some((key: string) => Object.hasOwn(command, key))
          ? "effect_crdt_merge_forbidden"
          : "effect_privacy_forbidden",
        { effectId: opaqueId(command.effectId) }
      );
    }
    try {
      const bound = bindLookups(command);
      return Object.freeze({
        ok: true,
        family: EXPLICIT_EFFECT_COMMAND_FAMILY,
        binding: bound,
        authorizationReResolved: false,
        reversesExternalEffect: false,
        capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
      });
    } catch (error: unknown) {
      return denied(text(isPlainObject(error) ? error.code : undefined) || "effect_command_binding_incomplete", {
        effectId: opaqueId(command.effectId)
      });
    }
  }

  async function execute(input: UnknownRecord = {}): Promise<EffectResult> {
    const boundResult = bind(input);
    if (boundResult.ok !== true) return boundResult;
    const bound = boundResult.binding!;
    const existing = stored(bound.effectId);
    if (existing) {
      const fence = retryFence(existing);
      return project(existing, {
        ok: fence.reasonCode === "effect_idempotent_replay",
        invokedSink: false,
        permitConsumed: false,
        retryAllowed: fence.allowed === true && existing.resultState === "accepted",
        authorizationReResolved: false,
        reasonCode: fence.reasonCode
      });
    }
    if (input.cancellationState === "cancelled" || input.cancellationState === "requested") {
      const command = toCommand(bound, "cancelled", "cancelled");
      assertEffectCommandFamily(command);
      const record = remember(Object.freeze({
        ...bound,
        command,
        resultState: "cancelled",
        cancellationState: "cancelled",
        authorizationReResolved: false,
        reasonCode: "effect_cancelled"
      }));
      return project(record, {
        ok: true,
        invokedSink: false,
        permitConsumed: false,
        retryAllowed: false,
        reasonCode: "effect_cancelled"
      });
    }

    const authority = await currentAuthority({
      ...input,
      ...bound
    });
    if (authority.allowed !== true) {
      return denied(authority.reasonCode, { effectId: bound.effectId, authorizationReResolved: true });
    }
    if (!lookupsMatch(bound, authority)) {
      return denied("conflict.authorization_changed", {
        effectId: bound.effectId,
        authorizationReResolved: true
      });
    }

    const requestDigest = digestGovernedExecutionRequest({
      operationId: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
      transport: EXPLICIT_EFFECT_COMMAND_TRANSPORT,
      method: "EFFECT",
      input: Object.freeze({
        effectId: bound.effectId,
        targetRef: bound.targetRef,
        audienceRef: bound.audienceRef,
        requestRef: bound.requestRef,
        idempotency: bound.idempotency
      })
    });
    const principal = Object.freeze({
      type: authority.subject.type,
      subjectId: authority.subject.subjectId,
      tenantId: authority.subject.tenantId,
      generation: authority.subject.generation
    });
    const resource = Object.freeze({
      targetRef: bound.targetRef,
      grantRevision: authority.grantRevision,
      policyRevision: authority.policyRevision,
      approvalRevision: authority.approvalRevision,
      riskRevision: authority.riskRevision,
      workloadGeneration: authority.workloadGeneration
    });
    const clock = Number(typeof now === "function" ? now() : now);
    let permitReceipt: ReturnType<typeof consumeGovernedExecutionPermit> | null = null;
    try {
      const permit = mintGovernedExecutionPermit({
        operationId: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
        audience: EXPLICIT_EFFECT_COMMAND_AUDIENCE,
        principal,
        resource,
        requestDigest,
        proofRef: bound.auditRef,
        authorization: Object.freeze({
          grantLookup: bound.grantLookup,
          policyRef: bound.policyRef
        }),
        approval: Object.freeze({
          approvalLookup: bound.approvalLookup,
          approvalRevision: authority.approvalRevision
        }),
        risk: Object.freeze({
          riskRevision: authority.riskRevision
        }),
        now: clock
      });
      permitReceipt = consumeGovernedExecutionPermit(permit, {
        operationId: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
        audience: EXPLICIT_EFFECT_COMMAND_AUDIENCE,
        requestDigest,
        principal,
        resource
      }, clock);
      assertConsumedGovernedExecutionPermit(permitReceipt, {
        operationId: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
        audience: EXPLICIT_EFFECT_COMMAND_AUDIENCE,
        requestDigest,
        principal
      });
    } catch (error: unknown) {
      return denied(text(isPlainObject(error) ? error.code : undefined) || "governed_execution_permit_required", {
        effectId: bound.effectId,
        authorizationReResolved: true
      });
    }

    let sinkResult: unknown;
    try {
      sinkResult = await effectSink(Object.freeze({
        family: EXPLICIT_EFFECT_COMMAND_FAMILY,
        effectId: bound.effectId,
        idempotency: bound.idempotency,
        targetRef: bound.targetRef,
        permitReceipt,
        principalDigest: digestGovernedExecutionPrincipal(principal),
        currentRevisions: Object.freeze(Object.fromEntries(
          CURRENT_REVISION_KEYS.map((key) => [key, authority[key]])
        ))
      }));
    } catch {
      const command = toCommand(bound, "uncertain", "none");
      assertEffectCommandFamily(command);
      const record = remember(Object.freeze({
        ...bound,
        command,
        resultState: "uncertain",
        cancellationState: "none",
        authorizationReResolved: true,
        reasonCode: "conflict.effect_uncertain"
      }));
      return project(record, {
        ok: false,
        invokedSink: true,
        permitConsumed: true,
        retryAllowed: false,
        authorizationReResolved: true,
        reasonCode: "conflict.effect_uncertain"
      });
    }

    const sinkRecord = isPlainObject(sinkResult) ? sinkResult : {};
    const resultState = includesValue(SERVICE_COLLABORATION_EFFECT_RESULT_STATES, sinkRecord.resultState)
      ? String(sinkRecord.resultState)
      : "accepted";
    const cancellationState = includesValue(SERVICE_COLLABORATION_CANCELLATION_STATES, sinkRecord.cancellationState)
      ? String(sinkRecord.cancellationState)
      : "none";
    const command = toCommand(
      bound,
      resultState,
      cancellationState
    );
    assertEffectCommandFamily(command);
    const record = remember(Object.freeze({
      ...bound,
      command,
      resultState,
      cancellationState,
      authorizationReResolved: true,
      reasonCode: resultState === "uncertain" ? "conflict.effect_uncertain" : "ok"
    }));
    return project(record, {
      ok: resultState !== "uncertain",
      invokedSink: true,
      permitConsumed: true,
      retryAllowed: effectRetryAllowed(command) === true,
      authorizationReResolved: true,
      reasonCode: record.reasonCode
    });
  }

  function retry(input: UnknownRecord = {}): EffectResult {
    const effectId = opaqueId(input.effectId);
    const existing = stored(effectId);
    if (input.silent === true || input.automatic === true) {
      return denied("silent_uncertain_retry_forbidden", {
        record: existing,
        effectId,
        owned: Boolean(existing)
      });
    }
    const fence = retryFence(existing);
    if (!existing) return denied("unowned_external_effect", { effectId, owned: false });
    return project(existing, {
      ok: fence.reasonCode === "effect_idempotent_replay",
      invokedSink: false,
      permitConsumed: false,
      retryAllowed: fence.allowed === true,
      reasonCode: fence.reasonCode
    });
  }

  function cancel(input: UnknownRecord = {}): EffectResult {
    const effectId = requiredOpaque(input.effectId, "effectId");
    const existing = stored(effectId);
    if (!existing) return denied("unowned_external_effect", { effectId, owned: false });
    if (existing.resultState === "accepted" || existing.resultState === "terminal" || existing.resultState === "uncertain") {
      return project(existing, {
        ok: false,
        invokedSink: false,
        retryAllowed: false,
        reasonCode: "effect_already_settled"
      });
    }
    const command = toCommand(existing, "cancelled", "cancelled");
    const record = remember(Object.freeze({
      ...existing,
      command,
      resultState: "cancelled",
      cancellationState: "cancelled",
      reasonCode: "effect_cancelled"
    }));
    return project(record, {
      ok: true,
      invokedSink: false,
      retryAllowed: false,
      reasonCode: "effect_cancelled"
    });
  }

  async function compensate(input: UnknownRecord = {}): Promise<Readonly<UnknownRecord>> {
    const originalId = opaqueId(input.effectId);
    const existing = stored(originalId);
    if (!existing) {
      return Object.freeze({
        ...compensateUnownedExternalEffect({ effectId: originalId }),
        invokedSink: false,
        permitConsumed: false,
        retryAllowed: false,
        authorizationReResolved: false
      });
    }
    const compensationId = requiredOpaque(input.compensationEffectId || `eff.comp.${existing.effectId}`, "compensationEffectId");
    const compensation = await execute({
      effectId: compensationId,
      idempotency: input.idempotency || "non_idempotent",
      principalLookup: existing.principalLookup,
      grantLookup: existing.grantLookup,
      targetRef: existing.targetRef,
      policyRef: existing.policyRef,
      approvalLookup: existing.approvalLookup,
      audienceRef: existing.audienceRef,
      requestRef: existing.requestRef,
      compensationRef: existing.effectId,
      auditRef: requiredOpaque(input.auditRef || `audt.${compensationId}`, "auditRef"),
      authorization: input.authorization
    });
    return Object.freeze({
      ...compensation,
      compensated: compensation.ok === true,
      reversesExternalEffect: false,
      originalEffectId: existing.effectId,
      owned: true,
      reasonCode: compensation.ok === true ? "compensation_issued" : compensation.reasonCode
    });
  }

  return Object.freeze({
    family: EXPLICIT_EFFECT_COMMAND_FAMILY,
    documentFamily: EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY,
    families: SERVICE_COLLABORATION_FAMILIES,
    permitAuthority: EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
    bind,
    execute,
    retry,
    cancel,
    compensate,
    inspect(effectId?: unknown): EffectResult | null {
      const record = stored(opaqueId(effectId));
      return record ? project(record, { ok: true, retryAllowed: effectRetryAllowed(record.command) === true }) : null;
    },
    mergeIntoChangeSet: mergeEffectCommandIntoChangeSet,
    rejectCrdtMerge: rejectCrdtEffectMerge
  });
}

export {
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  containsForbiddenKeys,
  lookupFactIsAuthority,
  privacySafeAudit as createPrivacySafeEffectAudit
};

export const EXPLICIT_EFFECT_COMMAND_PRIVACY_FORBIDDEN_KEYS = SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS;
export const EXPLICIT_EFFECT_COMMAND_CRDT_FORBIDDEN_KEYS = SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS;
