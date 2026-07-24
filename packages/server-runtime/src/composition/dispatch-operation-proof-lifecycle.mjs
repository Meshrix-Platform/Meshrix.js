import { OPERATION_PROOF_PROFILES } from "#meshrix/contracts/operations/operation-decorators";
import {
  compactStrings,
  firstText,
  idempotencyKeyForProof,
  notifyNarrowTransition,
  operationProofPolicy,
  operationUsesFullProof,
  proofChangeProjectionFromResponse,
  workspaceIdForProof
} from "./dispatch-operation-support.mjs";
import { proofPolicyEvidence, proofWorkspaceEffect, riskControlSubject } from "./dispatch-operation-risk-control.mjs";

export function createDispatchProofLifecycle({
  operationProofSubstrate = null,
  operation,
  operationInput = {},
  transport,
  method,
  url,
  request,
  response,
  traceContext,
  riskControlEnvelope = null,
  getActor = () => null,
  getAuthSession = () => null,
  writeAuditOperation
} = {}) {
  let proofEntry = null;

  function rememberProofEntry(entry) {
    proofEntry = entry || proofEntry;
    if (request && typeof request === "object" && proofEntry) {
      request.__licoOperationProof = proofEntry;
    }
    return proofEntry;
  }

  async function ensureProofLifecycleStarted({ statusCode = 0, reasonCode = "" } = {}) {
    if (!operationProofSubstrate || !operationUsesFullProof(operation)) {
      return null;
    }
    if (proofEntry?.ledgerEventId) {
      return proofEntry;
    }
    const actor = getActor();
    const authSession = getAuthSession();
    if (typeof operationProofSubstrate.beginLifecycle !== "function") {
      throw new Error(`Full proof profile requires beginLifecycle for operation ${operation.id}.`);
    }
    const started = await operationProofSubstrate.beginLifecycle({
      operationId: operation.id,
      workspaceId: workspaceIdForProof(operationInput),
      semantic: `${transport}:${method}:${operation.id}`,
      assetRef: firstText(operationInput.assetRef, operationInput.assetId),
      targetKind: transport,
      targetRef: {
        path: url?.pathname || "",
        method,
        transport
      },
      subject: riskControlSubject({ actor, authSession }),
      risk: {
        risk: operation.safety?.risk || "",
        readOnly: operation.readOnly === true,
        destructive: operation.destructive === true,
        requiredScopes: operation.requiredScopes || []
      },
      idempotencyKey: idempotencyKeyForProof({ operation, input: operationInput, traceContext, transport, method }),
      input: operationInput,
      policyDecision: proofPolicyEvidence({
        operation,
        actor,
        authSession,
        transport,
        method,
        riskControlEnvelope,
        traceContext,
        statusCode,
        reasonCode
      }),
      traceId: traceContext.traceId,
      requestId: traceContext.requestId,
      causalityRefs: compactStrings([traceContext.traceId, traceContext.requestId])
    });
    rememberProofEntry(started);
    notifyNarrowTransition(request, "operation.proof_start", "proof_started");
    return proofEntry;
  }

  async function recordProofReceipt({
    status,
    statusCode = 0,
    outcomeKind = "",
    error = "",
    failed = false,
    denied = false,
    auditRecord = null,
    receiptRefs = []
  } = {}) {
    if (!operationProofSubstrate) {
      return null;
    }
    const policy = operationProofPolicy(operation);
    if (policy.profile === OPERATION_PROOF_PROFILES.EXCLUDED) {
      return null;
    }
    if (typeof operationProofSubstrate.recordReceipt !== "function") {
      throw new Error(`Proof profile ${policy.profile} requires recordReceipt for operation ${operation.id}.`);
    }
    const terminalFailure =
      failed ||
      denied ||
      status === "failed" ||
      status === "denied" ||
      Number(statusCode || 0) >= 400;
    const receiptProfile = terminalFailure
      ? OPERATION_PROOF_PROFILES.RECEIPT
      : policy.profile;
    const change = receiptProfile === OPERATION_PROOF_PROFILES.ON_CHANGE
      ? proofChangeProjectionFromResponse(operation, response)
      : null;
    if (receiptProfile === OPERATION_PROOF_PROFILES.ON_CHANGE && !change) {
      return rememberProofEntry({
        disposition: "projection-missing",
        ledgerEventId: ""
      });
    }
    const actor = getActor();
    const authSession = getAuthSession();
    const recorded = await operationProofSubstrate.recordReceipt({
      profile: receiptProfile,
      operationId: operation.id,
      workspaceId: workspaceIdForProof(operationInput),
      semantic: `${transport}:${method}:${operation.id}`,
      targetKind: transport,
      targetRef: {
        path: url?.pathname || "",
        method,
        transport
      },
      subject: riskControlSubject({ actor, authSession }),
      risk: {
        risk: operation.safety?.risk || "",
        readOnly: operation.readOnly === true,
        destructive: operation.destructive === true,
        requiredScopes: operation.requiredScopes || []
      },
      policyDecision: proofPolicyEvidence({
        operation,
        actor,
        authSession,
        transport,
        method,
        riskControlEnvelope,
        traceContext,
        statusCode,
        reasonCode: outcomeKind || status
      }),
      status,
      statusCode,
      outcomeKind: outcomeKind || status,
      receiptRefs,
      auditId: auditRecord?.auditId || auditRecord?.id || "",
      error,
      failed: terminalFailure && !denied,
      denied,
      traceId: traceContext.traceId,
      requestId: traceContext.requestId,
      causalityRefs: compactStrings([traceContext.traceId, traceContext.requestId]),
      changeKey: change?.changeProjection || operation.id,
      changeProjection: change?.changeProjection || "",
      changeDigest: change?.changeDigest || ""
    });
    rememberProofEntry(recorded);
    notifyNarrowTransition(request, "operation.proof_receipt", "proof_recorded");
    return proofEntry;
  }

  async function finishProofLifecycle({
    status,
    statusCode = 0,
    outcomeKind = "",
    error = "",
    failed = false,
    denied = false,
    auditRecord = null,
    receiptRefs = [],
    result = {}
  } = {}) {
    if (!operationProofSubstrate) {
      return null;
    }
    const policy = operationProofPolicy(operation);
    const terminalFailure =
      failed ||
      denied ||
      status === "failed" ||
      status === "denied" ||
      Number(statusCode || 0) >= 400;
    if (policy.profile !== OPERATION_PROOF_PROFILES.FULL || (terminalFailure && !proofEntry?.ledgerEventId)) {
      return recordProofReceipt({
        status,
        statusCode,
        outcomeKind,
        error,
        failed,
        denied,
        auditRecord,
        receiptRefs
      });
    }
    const entry = proofEntry || await ensureProofLifecycleStarted({
      statusCode,
      reasonCode: outcomeKind || status
    });
    if (!entry?.ledgerEventId) {
      throw new Error(`Full proof profile did not return a ledgerEventId for operation ${operation.id}.`);
    }
    if (typeof operationProofSubstrate?.finishLifecycle !== "function") {
      throw new Error(`Full proof profile requires finishLifecycle for operation ${operation.id}.`);
    }
    const completed = await operationProofSubstrate.finishLifecycle({
      entry,
      ledgerEventId: entry.ledgerEventId,
      status,
      statusCode,
      outcomeKind: outcomeKind || status,
      result,
      receiptRefs,
      auditId: auditRecord?.auditId || auditRecord?.id || "",
      error,
      failed,
      denied,
      workspaceEffectEvidence: proofWorkspaceEffect({
        operation,
        status,
        statusCode,
        auditRecord,
        response,
        error,
        receiptRefs
      }),
      causalityRefs: compactStrings([traceContext.traceId, traceContext.requestId])
    });
    return rememberProofEntry(completed || entry);
  }

  async function finishProofWithAudit(entry = {}, proofPatch = {}) {
    const auditRecord = await writeAuditOperation(entry);
    await finishProofLifecycle({
      status: entry.status === "ok" ? "succeeded" : entry.status,
      statusCode: entry.statusCode || proofPatch.statusCode || 0,
      outcomeKind: proofPatch.outcomeKind || entry.status || "",
      error: entry.error || proofPatch.error || "",
      failed: entry.status === "failed" || proofPatch.failed === true,
      denied: entry.status === "denied" || proofPatch.denied === true,
      auditRecord,
      receiptRefs: proofPatch.receiptRefs || [],
      result: proofPatch.result || {}
    });
    return auditRecord;
  }

  return {
    ensureProofLifecycleStarted,
    finishProofLifecycle,
    finishProofWithAudit
  };
}
