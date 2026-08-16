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

export const EXPLICIT_EFFECT_COMMAND_FAMILY: any = "effect-command";
export const EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY: any = "document-state";
export const EXPLICIT_EFFECT_COMMAND_OPERATION_ID: any = "collaboration.effect";
export const EXPLICIT_EFFECT_COMMAND_AUDIENCE: any = "service-collaboration-effect-command";
export const EXPLICIT_EFFECT_COMMAND_TRANSPORT: any = "effect-command";
export const EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY: any =
  "packages/foundation/src/security/governed-execution-permit-authority.ts";
export const EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED: any = false;
export const EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON: any = "owner_profile_not_authorized";
export const EXPLICIT_EFFECT_COMMAND_MAX_RECORDS: any = 4_096;

const IDENTITY_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const REQUIRED_LOOKUP_KEYS: readonly any[] = Object.freeze([
  "principalLookup",
  "grantLookup",
  "targetRef",
  "policyRef",
  "approvalLookup",
  "audienceRef",
  "requestRef"
]);
const CURRENT_REVISION_KEYS: readonly any[] = Object.freeze([
  "grantRevision",
  "policyRevision",
  "approvalRevision",
  "riskRevision",
  "workloadGeneration"
]);

function text(value?: any, maxBytes: any = 128) : any {
  if (typeof value !== "string") return "";
  const normalized: any = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function opaqueId(value?: any) : any {
  const normalized: any = text(value);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : "";
}

function requiredOpaque(value?: any, field?: any) : any {
  const normalized: any = opaqueId(value);
  if (!normalized) {
    deny("effect_command_binding_incomplete", `Effect Command requires ${field}.`);
  }
  return normalized;
}

function deny(code?: any, message?: any) : any {
  throw Object.assign(new Error(message), { code, statusCode: 403, retryable: false });
}

function isPlainObject(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usesLookupFactAsAuthority(input: Record<string, any> = {}) : any {
  const source: any = text(input.authoritySource || input.authorizationSource);
  if (source && SERVICE_COLLABORATION_LOOKUP_FACTS.includes(source)) return true;
  if (input.usePriorApprovalAsAuthority === true) return true;
  if (input.priorApproval === true && input.revalidationPerformed !== true) return true;
  return false;
}

function usesStrategyPreviewAsAuthority(input: Record<string, any> = {}) : any {
  return Boolean(
    input.strategyPreview ||
    input.previewDecision ||
    input.dryRunResult ||
    input.dryRunOnly === true && input.usePreviewAsAuthority === true
  );
}

function copiedReResolutionIsProof(input: Record<string, any> = {}) : any {
  return input.authorizationReResolved === true && input.revalidationPerformed !== true && input.skipRevalidation === true;
}

function currentAuthorizationDenied(input: Record<string, any> = {}) : any {
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

export function createExplicitEffectCommandInput(value: Record<string, any> = {}) : any {
  const current: any = createCurrentEffectAuthorization(value);
  return Object.freeze({
    family: EXPLICIT_EFFECT_COMMAND_FAMILY,
    effectId: requiredOpaque(value.effectId || "eff.sc.1", "effectId"),
    idempotency: SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY.includes(value.idempotency)
      ? value.idempotency
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
      ...(isPlainObject(value.authorization) ? value.authorization : {}),
      usePriorApprovalAsAuthority: value.usePriorApprovalAsAuthority === true ||
        value.authorization?.usePriorApprovalAsAuthority === true,
      usePreviewAsAuthority: value.usePreviewAsAuthority === true ||
        value.authorization?.usePreviewAsAuthority === true,
      strategyPreview: value.strategyPreview || value.authorization?.strategyPreview,
      previewDecision: value.previewDecision || value.authorization?.previewDecision,
      dryRunResult: value.dryRunResult || value.authorization?.dryRunResult
    })
  });
}

export function createCurrentEffectAuthorization(value: Record<string, any> = {}) : any {
  const subject: any = isPlainObject(value.subject) ? value.subject : {};
  return Object.freeze({
    allowed: value.allowed !== false,
    reasonCode: text(value.reasonCode) || "allowed",
    principalLookup: requiredOpaque(value.principalLookup || subject.subjectId || "prin.sc.1", "principalLookup"),
    grantLookup: requiredOpaque(value.grantLookup || value.grant?.id || "gr.sc.1", "grantLookup"),
    targetRef: requiredOpaque(value.targetRef || "tgt.sc.1", "targetRef"),
    policyRef: requiredOpaque(value.policyRef || "pol.sc.1", "policyRef"),
    approvalLookup: requiredOpaque(value.approvalLookup || "apr.sc.1", "approvalLookup"),
    audienceRef: requiredOpaque(value.audienceRef || "aud.sc.1", "audienceRef"),
    requestRef: requiredOpaque(value.requestRef || "req.sc.1", "requestRef"),
    grantRevision: requiredOpaque(value.grantRevision || value.grant?.revision || "rev.grant.1", "grantRevision"),
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

function createDefaultRevalidator() : any {
  const engine: any = createAuthorizationEngine();
  return async (input: Record<string, any> = {}) : Promise<any> => {
    const blocked: any = currentAuthorizationDenied(input);
    if (blocked) return blocked;
    const current: any = createCurrentEffectAuthorization(input);
    const decision: any = await engine.evaluate({
      operation: Object.freeze({
        id: EXPLICIT_EFFECT_COMMAND_OPERATION_ID,
        public: false,
        readOnly: false
      }),
      subject: current.subject,
      grant: input.grant || null,
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

function commandProjection(value: Record<string, any> = {}) : any {
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

function bindLookups(value: Record<string, any> = {}) : any {
  const bound: Record<string, any> = {};
  for (const key of REQUIRED_LOOKUP_KEYS) {
    bound[key] = requiredOpaque(value[key], key);
  }
  return Object.freeze({
    ...bound,
    effectId: requiredOpaque(value.effectId, "effectId"),
    idempotency: SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY.includes(value.idempotency)
      ? value.idempotency
      : deny("effect_command_idempotency_required", "Effect Command requires idempotent or explicit non_idempotent."),
    auditRef: requiredOpaque(value.auditRef || `audt.${value.effectId}`, "auditRef"),
    compensationRef: value.compensationRef == null ? null : requiredOpaque(value.compensationRef, "compensationRef")
  });
}

function lookupsMatch(bound?: any, current?: any) : any {
  return REQUIRED_LOOKUP_KEYS.every((key?: any) : any => bound[key] === current[key]);
}

function privacySafeAudit(record: Record<string, any> = {}) : any {
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

export function changeSetHidesEffectCommand(changeSet?: any) : any {
  if (!isPlainObject(changeSet)) return false;
  if (changeSet.family === EXPLICIT_EFFECT_COMMAND_FAMILY) return true;
  if (changeSet.effectId || changeSet.effectCommand) return true;
  const operations: any = Array.isArray(changeSet.operations) ? changeSet.operations : [];
  return operations.some((operation?: any) : any => (
    isPlainObject(operation) && (
      operation.family === EXPLICIT_EFFECT_COMMAND_FAMILY ||
      Boolean(operation.effectId) ||
      Boolean(operation.effectCommand)
    )
  ));
}

export function mergeEffectCommandIntoChangeSet(_effect?: any, changeSet?: any) : any {
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

export function rejectCrdtEffectMerge(value?: any) : any {
  const keys: any = isPlainObject(value) ? Object.keys(value) : [];
  const crdt: any = keys.some((key?: any) : any => SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS.includes(key));
  return Object.freeze({
    ok: false,
    merged: false,
    crdtRejected: crdt || containsForbiddenKeys(value) === true,
    reasonCode: "effect_crdt_merge_forbidden",
    reversesExternalEffect: SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
  });
}

export function compensateUnownedExternalEffect(value: Record<string, any> = {}) : any {
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

function retryFence(record?: any) : any {
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
}: Record<string, any> = {}) : any {
  const records: any = new Map<any, any>();
  const resolveAuthorization: any = typeof revalidateAuthorization === "function"
    ? revalidateAuthorization
    : createDefaultRevalidator();
  if (typeof performExternalEffect !== "function") {
    throw new TypeError("Explicit Effect Commands require an external-effect sink.");
  }

  function stored(effectId?: any) : any {
    return records.get(effectId) || null;
  }

  function remember(record?: any) : any {
    if (!records.has(record.effectId) && records.size >= EXPLICIT_EFFECT_COMMAND_MAX_RECORDS) {
      deny("effect_command_backpressure", "Explicit Effect Command capacity is exhausted.");
    }
    records.set(record.effectId, record);
    return record;
  }

  function project(record?: any, extras: Record<string, any> = {}) : any {
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
      reasonCode: extras.reasonCode || record?.reasonCode || "ok",
      audit: record ? privacySafeAudit(record) : extras.audit || null,
      capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
      permitAuthority: EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY
    });
  }

  function denied(reasonCode?: any, extras: Record<string, any> = {}) : any {
    return project(extras.record || null, {
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

  async function currentAuthority(input: Record<string, any> = {}) : Promise<any> {
    const facts: any = isPlainObject(input.authorization) ? input.authorization : input;
    const blocked: any = currentAuthorizationDenied(facts);
    if (blocked) return blocked;
    let decision: any;
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
    if (decision?.allowed !== true) {
      return Object.freeze({
        allowed: false,
        reasonCode: text(decision?.reasonCode) || "execution_authorization_denied"
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

  function toCommand(bound?: any, resultState?: any, cancellationState: any = "none") : any {
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
    });
  }

  function bind(input: Record<string, any> = {}) : any {
    const command: any = commandProjection(input);
    if (command.family && command.family !== EXPLICIT_EFFECT_COMMAND_FAMILY) {
      return denied("effect_family_separated", { effectId: opaqueId(command.effectId) });
    }
    if (containsForbiddenKeys(command)) {
      return denied(
        SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS.some((key?: any) : any => Object.hasOwn(command, key))
          ? "effect_crdt_merge_forbidden"
          : "effect_privacy_forbidden",
        { effectId: opaqueId(command.effectId) }
      );
    }
    try {
      const bound: any = bindLookups(command);
      return Object.freeze({
        ok: true,
        family: EXPLICIT_EFFECT_COMMAND_FAMILY,
        binding: bound,
        authorizationReResolved: false,
        reversesExternalEffect: false,
        capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
      });
    } catch (error: any) {
      return denied(text(error?.code) || "effect_command_binding_incomplete", {
        effectId: opaqueId(command.effectId)
      });
    }
  }

  async function execute(input: Record<string, any> = {}) : Promise<any> {
    const boundResult: any = bind(input);
    if (boundResult.ok !== true) return boundResult;
    const bound: any = boundResult.binding;
    const existing: any = stored(bound.effectId);
    if (existing) {
      const fence: any = retryFence(existing);
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
      const command: any = toCommand(bound, "cancelled", "cancelled");
      assertEffectCommandFamily(command);
      const record: any = remember(Object.freeze({
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

    const authority: any = await currentAuthority({
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

    const requestDigest: any = digestGovernedExecutionRequest({
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
    const principal: any = Object.freeze({
      type: authority.subject.type,
      subjectId: authority.subject.subjectId,
      tenantId: authority.subject.tenantId,
      generation: authority.subject.generation
    });
    const resource: any = Object.freeze({
      targetRef: bound.targetRef,
      grantRevision: authority.grantRevision,
      policyRevision: authority.policyRevision,
      approvalRevision: authority.approvalRevision,
      riskRevision: authority.riskRevision,
      workloadGeneration: authority.workloadGeneration
    });
    const clock: any = Number(typeof now === "function" ? now() : now);
    let permitReceipt: any = null;
    try {
      const permit: any = mintGovernedExecutionPermit({
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
    } catch (error: any) {
      return denied(text(error?.code) || "governed_execution_permit_required", {
        effectId: bound.effectId,
        authorizationReResolved: true
      });
    }

    let sinkResult: any;
    try {
      sinkResult = await performExternalEffect(Object.freeze({
        family: EXPLICIT_EFFECT_COMMAND_FAMILY,
        effectId: bound.effectId,
        idempotency: bound.idempotency,
        targetRef: bound.targetRef,
        permitReceipt,
        principalDigest: digestGovernedExecutionPrincipal(principal),
        currentRevisions: Object.freeze(Object.fromEntries(
          CURRENT_REVISION_KEYS.map((key?: any) : any => [key, authority[key]])
        ))
      }));
    } catch {
      const command: any = toCommand(bound, "uncertain", "none");
      assertEffectCommandFamily(command);
      const record: any = remember(Object.freeze({
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

    const resultState: any = SERVICE_COLLABORATION_EFFECT_RESULT_STATES.includes(sinkResult?.resultState)
      ? sinkResult.resultState
      : "accepted";
    const command: any = toCommand(
      bound,
      resultState,
      SERVICE_COLLABORATION_CANCELLATION_STATES.includes(sinkResult?.cancellationState)
        ? sinkResult.cancellationState
        : "none"
    );
    assertEffectCommandFamily(command);
    const record: any = remember(Object.freeze({
      ...bound,
      command,
      resultState,
      cancellationState: command.cancellationState,
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

  function retry(input: Record<string, any> = {}) : any {
    const effectId: any = opaqueId(input.effectId);
    const existing: any = stored(effectId);
    if (input.silent === true || input.automatic === true) {
      return denied("silent_uncertain_retry_forbidden", {
        record: existing,
        effectId,
        owned: Boolean(existing)
      });
    }
    const fence: any = retryFence(existing);
    if (!existing) return denied("unowned_external_effect", { effectId, owned: false });
    return project(existing, {
      ok: fence.reasonCode === "effect_idempotent_replay",
      invokedSink: false,
      permitConsumed: false,
      retryAllowed: fence.allowed === true,
      reasonCode: fence.reasonCode
    });
  }

  function cancel(input: Record<string, any> = {}) : any {
    const effectId: any = requiredOpaque(input.effectId, "effectId");
    const existing: any = stored(effectId);
    if (!existing) return denied("unowned_external_effect", { effectId, owned: false });
    if (existing.resultState === "accepted" || existing.resultState === "terminal" || existing.resultState === "uncertain") {
      return project(existing, {
        ok: false,
        invokedSink: false,
        retryAllowed: false,
        reasonCode: "effect_already_settled"
      });
    }
    const command: any = toCommand(existing, "cancelled", "cancelled");
    const record: any = remember(Object.freeze({
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

  async function compensate(input: Record<string, any> = {}) : Promise<any> {
    const originalId: any = opaqueId(input.effectId);
    const existing: any = stored(originalId);
    if (!existing) {
      return Object.freeze({
        ...compensateUnownedExternalEffect({ effectId: originalId }),
        invokedSink: false,
        permitConsumed: false,
        retryAllowed: false,
        authorizationReResolved: false
      });
    }
    const compensationId: any = requiredOpaque(input.compensationEffectId || `eff.comp.${existing.effectId}`, "compensationEffectId");
    const compensation: any = await execute({
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
    inspect(effectId?: any) : any {
      const record: any = stored(opaqueId(effectId));
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

export const EXPLICIT_EFFECT_COMMAND_PRIVACY_FORBIDDEN_KEYS: any = SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS;
export const EXPLICIT_EFFECT_COMMAND_CRDT_FORBIDDEN_KEYS: any = SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS;
