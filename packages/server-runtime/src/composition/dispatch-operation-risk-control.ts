import { getTraceContext, traceDetails } from "#meshrix/foundation/observability/trace-context";
import {
  RISK_CONTROL_BOUNDARY_IDS,
  RISK_CONTROL_ENVIRONMENT_IDS,
  RISK_CONTROL_POINTS,
  appendRiskControlGateRecord,
  createRiskControlOperationEnvelope,
  digestRiskControlValue
} from "#meshrix/foundation/security/risk-control/index";
import {
  actorFromInput,
  arrayOf,
  compactStrings,
  firstText,
  operationProofPolicy,
  requestIdFromRequest
} from "./dispatch-operation-support.ts";

const RISK_CONTROL_BY_ID: any = new Map<any, any>(RISK_CONTROL_POINTS.map((control?: any) : any => [control.controlId, control]));

export const DISPATCHER_RISK_CONTROL_IDS: Readonly<Record<string, any>> = Object.freeze({
  admit: "client.registration.admit",
  externalBind: "client.agent-identity.bind",
  consoleBind: "client.operator-identity.bind",
  externalAuthorize: "client.mcp-grant.authorize",
  operationAuthorize: "client.operation-permission.authorize",
  platformAuthorize: "platform.capability-kernel.authorize",
  approve: "client.high-risk-confirmation.approve",
  execute: "platform.operation-proof.execute",
  auditRecover: "platform.audit.audit"
});

export function cleanRiskControlValue(value?: any, depth: any = 0) : any {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (depth > 6) {
    return "[truncated-depth]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item?: any) : any => cleanRiskControlValue(item, depth + 1))
      .filter((item?: any) : any => item !== undefined);
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length
    };
  }
  const output: Record<string, any> = {};
  for (const [key, nested] of (Object.entries(value) as [string, any][]).slice(0, 50)) {
    const cleaned: any = cleanRiskControlValue(nested, depth + 1);
    if (cleaned !== undefined) {
      output[key] = cleaned;
    }
  }
  return output;
}

export function riskControlInputHash({ operation, transport, method, input }: Record<string, any>) : any {
  return digestRiskControlValue("v0.0.1:strategy:risk-control-operation-input-1", {
    operationId: operation?.id || "",
    transport,
    method,
    input: input ?? null
  });
}

export function riskControlSubject({ actor = null, authSession = null }: Record<string, any> = {}) : any {
  const user: any = authSession?.user || actor?.user || actor || {};
  const subjectType: any =
    actor?.type ||
    user.type ||
    (user.roleId === "tool-grant" ? "tool-grant" : user.userId ? "console-user" : "anonymous");
  const subject: Record<string, any> = {
    type: subjectType,
    userId: firstText(user.userId, actor?.userId),
    subjectId: firstText(user.subjectId, actor?.subjectId, user.userId, actor?.userId),
    roleId: firstText(user.roleId, actor?.roleId),
    tenantId: firstText(user.tenantId, actor?.tenantId),
    orgId: firstText(user.orgId, actor?.orgId),
    grantId: firstText(user.grantId, actor?.grantId, user.roleId === "tool-grant" ? user.userId : ""),
    scopes: compactStrings([...arrayOf(user.scopes), ...arrayOf(actor?.scopes)]),
    capabilities: compactStrings([...arrayOf(user.capabilities), ...arrayOf(actor?.capabilities)]),
    toolsets: compactStrings([...arrayOf(user.toolsets), ...arrayOf(actor?.toolsets)])
  };
  return cleanRiskControlValue(subject);
}

export function riskControlResource({ operation, transport, method, url, statusCode = 0 }: Record<string, any>) : any {
  return cleanRiskControlValue({
    operationId: operation?.id || "",
    feature: operation?.feature || "",
    transport,
    method,
    path: url?.pathname || "",
    statusCode: Number(statusCode || 0) || 0,
    risk: operation?.safety?.risk || "",
    readOnly: operation?.readOnly === true,
    requiredScopes: compactStrings(operation?.requiredScopes || [])
  });
}

export function riskControlEnvironment({ control, transport }: Record<string, any>) : any {
  return {
    boundaryId: control?.owner?.boundaryId || RISK_CONTROL_BOUNDARY_IDS.PLATFORM_SELF,
    environmentId: control?.owner?.environmentId || RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    transport
  };
}

export function riskControlById(controlId?: any) : any {
  const control: any = RISK_CONTROL_BY_ID.get(controlId);
  if (!control) {
    throw new Error(`Risk Control point is not registered: ${controlId}`);
  }
  return control;
}

export function createDispatcherRiskControlEnvelope({
  request,
  operation,
  traceContext,
  transport,
  method,
  input
}: Record<string, any>) : any {
  const envelope: any = createRiskControlOperationEnvelope({
    operationId: operation.id,
    traceId: traceContext.traceId,
    inputHash: riskControlInputHash({ operation, transport, method, input })
  });
  if (request && typeof request === "object") {
    request.__meshrixRiskControl = envelope;
  }
  return envelope;
}

export function appendDispatcherRiskGate({
  envelope,
  request,
  operation,
  actor = null,
  authSession = null,
  traceContext,
  transport,
  method,
  url,
  controlId,
  decision = "allow",
  reasonCode = "",
  statusCode = 0,
  details = {}
}: Record<string, any>) : any {
  const targetEnvelope: any = envelope || request?.__meshrixRiskControl;
  if (!targetEnvelope) {
    throw new Error(`Risk Control envelope missing for operation ${operation?.id || ""}.`);
  }
  const control: any = riskControlById(controlId);
  const evidence: any = cleanRiskControlValue({
    type: "operation-dispatcher",
    traceId: traceContext?.traceId || "",
    requestId: traceContext?.requestId || requestIdFromRequest(request),
    statusCode: Number(statusCode || 0) || 0,
    details
  });
  return appendRiskControlGateRecord(targetEnvelope, {
    control,
    decision,
    reasonCode,
    subject: riskControlSubject({ actor, authSession }),
    intent: `${transport || "internal"}:${method || ""}:${operation?.id || ""}`,
    resource: riskControlResource({ operation, transport, method, url, statusCode }),
    environment: riskControlEnvironment({ control, transport }),
    evidence: [evidence]
  });
}

export function proofPolicyEvidence({
  operation,
  actor = null,
  authSession = null,
  transport,
  method,
  riskControlEnvelope = null,
  traceContext = null,
  statusCode = 0,
  reasonCode = ""
}: Record<string, any> = {}) : any {
  return cleanRiskControlValue({
    proofProfile: operationProofPolicy(operation),
    operationId: operation?.id || "",
    transport,
    method,
    statusCode,
    reasonCode,
    subject: riskControlSubject({ actor, authSession }),
    risk: operation?.safety || {},
    requiredScopes: operation?.requiredScopes || [],
    traceId: traceContext?.traceId || "",
    requestId: traceContext?.requestId || "",
    riskControl: {
      protocolVersion: riskControlEnvelope?.protocolVersion || riskControlEnvelope?.schemaVersion || "",
      operationId: riskControlEnvelope?.operationId || operation?.id || "",
      traceId: riskControlEnvelope?.traceId || traceContext?.traceId || "",
      gateCount: Array.isArray(riskControlEnvelope?.gateRecords) ? riskControlEnvelope.gateRecords.length : 0,
      digest:
        riskControlEnvelope?.gateRecords?.at(-1)?.recordDigest ||
        riskControlEnvelope?.operationAnchorDigest ||
        ""
    }
  });
}

export function proofWorkspaceEffect({
  operation,
  status,
  statusCode = 0,
  auditRecord = null,
  response = null,
  error = "",
  receiptRefs = []
}: Record<string, any> = {}) : any {
  const change: any = response?.__meshrixProofChangeProjection;
  return cleanRiskControlValue({
    operationId: operation?.id || "",
    status,
    statusCode,
    auditId: auditRecord?.auditId || auditRecord?.id || "",
    responseEnded: response?.ended === true || response?.headersSent === true,
    changeProjection: firstText(change?.changeProjection),
    changeDigest: firstText(change?.changeDigest),
    changed: change?.changed === true,
    receiptRefs,
    error
  });
}

export function auditOperation({
  operationAuditStore,
  operation,
  transport,
  authSession = null,
  actor = null,
  input = {},
  status,
  startedAt,
  output = undefined,
  error = "",
  riskControlEnvelope = null
}: Record<string, any>) : any {
  const disposition: any = auditOperationDisposition({ operationAuditStore, operation, status });
  if (disposition !== "recorded") {
    return null;
  }
  const trace: any = traceDetails(getTraceContext());
  const metadataOnly: any = operation.audit?.metadataOnly === true;
  return operationAuditStore.append({
    operationId: operation.id,
    transport,
    traceId: trace.traceId,
    requestId: trace.requestId,
    actor: actorFromInput({ actor, authSession }),
    risk: operation.safety?.risk || "",
    readOnly: operation.readOnly === true,
    status,
    durationMs: startedAt ? Date.now() - startedAt : 0,
    input: metadataOnly || operation.audit?.recordInput === false ? {} : input,
    output: !metadataOnly && operation.audit?.recordOutput === true ? output : undefined,
    error,
    riskControl: riskControlEnvelope
  });
}

export function auditOperationDisposition({
  operationAuditStore,
  operation,
  status = ""
}: Record<string, any> = {}) : any {
  if (!operationAuditStore || operation?.audit?.enabled === false) {
    return "disabled";
  }
  const normalizedStatus: any = String(status || "").trim().toLowerCase();
  const successful: any = ["ok", "success", "succeeded", "completed"].includes(normalizedStatus);
  if (successful && operation?.audit?.write === false) {
    return "suppressed";
  }
  return "recorded";
}
