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
} from "./dispatch-operation-support.ts";
import { proofPolicyEvidence, proofWorkspaceEffect, riskControlSubject } from "./dispatch-operation-risk-control.ts";

let proofLifecycleStartCount: any = 0;
let proofReceiptCount: any = 0;
let proofSettlementCount: any = 0;

export function getProofLifecycleRefactorInstrumentation() : any {
  return {
    schemaVersion: "v0.0.1:operation:proof-lifecycle-instrumentation-1",
    proofLifecycleStartCount,
    proofReceiptCount,
    proofSettlementCount
  };
}

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
  getActor = () : any => null,
  getAuthSession = () : any => null,
  writeAuditOperation
}: Record<string, any> = {}) : any {
  let proofEntry: any = null;

  function rememberProofEntry(entry?: any) : any {
    proofEntry = entry || proofEntry;
    if (request && typeof request === "object" && proofEntry) {
      request.__meshrixOperationProof = proofEntry;
    }
    return proofEntry;
  }

  async function ensureProofLifecycleStarted({ statusCode = 0, reasonCode = "", required = false }: Record<string, any> = {}) : Promise<any> {
    if (!operationProofSubstrate) {
      if (required) {
        throw Object.assign(
          new Error(`Protected operation ${operation.id} requires the proof substrate.`),
          { code: "operation_proof_substrate_required", statusCode: 503 }
        );
      }
      return null;
    }
    if (!required && !operationUsesFullProof(operation)) {
      return null;
    }
    if (proofEntry?.ledgerEventId) {
      return proofEntry;
    }
    const actor: any = getActor();
    const authSession: any = getAuthSession();
    if (typeof operationProofSubstrate.beginLifecycle !== "function") {
      throw new Error(`Full proof profile requires beginLifecycle for operation ${operation.id}.`);
    }
    const started: any = await operationProofSubstrate.beginLifecycle({
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
    proofLifecycleStartCount += 1;
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
  }: Record<string, any> = {}) : Promise<any> {
    if (!operationProofSubstrate) {
      return null;
    }
    const policy: any = operationProofPolicy(operation);
    if (policy.profile === OPERATION_PROOF_PROFILES.EXCLUDED) {
      return null;
    }
    if (typeof operationProofSubstrate.recordReceipt !== "function") {
      throw new Error(`Proof profile ${policy.profile} requires recordReceipt for operation ${operation.id}.`);
    }
    const terminalFailure: any =
      failed ||
      denied ||
      status === "failed" ||
      status === "denied" ||
      Number(statusCode || 0) >= 400;
    const receiptProfile: any = terminalFailure
      ? OPERATION_PROOF_PROFILES.RECEIPT
      : policy.profile;
    const change: any = receiptProfile === OPERATION_PROOF_PROFILES.ON_CHANGE
      ? proofChangeProjectionFromResponse(operation, response)
      : null;
    if (receiptProfile === OPERATION_PROOF_PROFILES.ON_CHANGE && !change) {
      return rememberProofEntry({
        disposition: "projection-missing",
        ledgerEventId: ""
      });
    }
    const actor: any = getActor();
    const authSession: any = getAuthSession();
    const recorded: any = await operationProofSubstrate.recordReceipt({
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
    proofReceiptCount += 1;
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
  }: Record<string, any> = {}) : Promise<any> {
    if (!operationProofSubstrate) {
      return null;
    }
    const policy: any = operationProofPolicy(operation);
    const terminalFailure: any =
      failed ||
      denied ||
      status === "failed" ||
      status === "denied" ||
      Number(statusCode || 0) >= 400;
    if (
      (!proofEntry?.ledgerEventId && policy.profile !== OPERATION_PROOF_PROFILES.FULL) ||
      (terminalFailure && !proofEntry?.ledgerEventId)
    ) {
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
    const entry: any = proofEntry || await ensureProofLifecycleStarted({
      statusCode,
      reasonCode: outcomeKind || status
    });
    if (!entry?.ledgerEventId) {
      throw new Error(`Full proof profile did not return a ledgerEventId for operation ${operation.id}.`);
    }
    if (typeof operationProofSubstrate?.finishLifecycle !== "function") {
      throw new Error(`Full proof profile requires finishLifecycle for operation ${operation.id}.`);
    }
    const completed: any = await operationProofSubstrate.finishLifecycle({
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
    proofSettlementCount += 1;
    return rememberProofEntry(completed || entry);
  }

  async function finishProofWithAudit(entry: Record<string, any> = {}, proofPatch: Record<string, any> = {}) : Promise<any> {
    const auditRecord: any = await writeAuditOperation(entry);
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
