import { sendJson } from "#meshrix/foundation/http/http-response";
import { OPERATION_PROOF_PROFILES } from "#meshrix/contracts/operations/operation-decorators";

// Literal field names used in dispatch proof lifecycle instrumentation.
export const OP_DISPATCH_OTEL_ATTRIBUTES: Readonly<Record<string, any>> = Object.freeze({
  "service.name": "meshrix-server",
  "service.version": "0.0.1",
  "meshrix.operation.id": null,
  "meshrix.workspace.id": null,
  "meshrix.capability.id": null,
  "meshrix.receipt.id": null,
});

export function coerceValue(value?: any, type?: any) : any {
  if (type === "number") {
    return Number(value || 0);
  }
  if (type === "boolean") {
    return value === true || value === "1" || value === "true" || value === "yes";
  }
  return value;
}

export function parseJsonObject(value?: any) : any {
  if (!value) {
    return {};
  }
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) {
      return {};
    }
    return parseJsonObject(value.toString("utf8"));
  }
  if (typeof value === "string") {
    const text: any = value.trim();
    if (!text) {
      return {};
    }
    try {
      const parsed: any = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function firstText(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function compactStrings(values: any = [], limit: any = 50) : any {
  return [...new Set<any>((Array.isArray(values) ? values : [])
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean))]
    .slice(0, limit);
}

export function arrayOf(value?: any) : any {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null || value === "" ? [] : [value];
}

export function actorFromAuthSession(authSession?: any) : any {
  if (!authSession?.user) {
    return { type: "anonymous" };
  }
  const user: any = authSession.user;
  return {
    type: user.type || (user.roleId === "tool-grant" ? "tool-grant" : "console-user"),
    user
  };
}

export function actorFromInput({ actor = null, authSession = null }: Record<string, any> = {}) : any {
  if (actor) {
    return actor;
  }
  return actorFromAuthSession(authSession);
}

export function requestIdFromRequest(request?: any) : any {
  return request?.__meshrixTraceContext?.requestId || request?.__meshrixRequestId || "";
}

export function operationEventName(transport?: any, suffix?: any) : any {
  return `operation.${transport || "internal"}.${suffix}`;
}

export function sendOperationDenied(response?: any, status?: any, payload?: any) : any {
  if (response?.headersSent || response?.ended) {
    return;
  }
  sendJson(response, status, payload);
}

export function logOperation(logger?: any, level?: any, event?: any, details: Record<string, any> = {}) : any {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, details);
}

export function notifyNarrowTransition(request?: any, event?: any, toStatus?: any) : any {
  if (typeof request?.onNarrowTransition === "function") {
    request.onNarrowTransition(event, toStatus);
  }
}

export function notifySideEffectStart(request?: any) : any {
  if (typeof request?.onSideEffectStart === "function") {
    request.onSideEffectStart();
  }
}

export function operationProofPolicy(operation: Record<string, any> = {}) : any {
  const profile: any = operation.proof?.profile || (
    operation.readOnly === true
      ? OPERATION_PROOF_PROFILES.RECEIPT
      : OPERATION_PROOF_PROFILES.FULL
  );
  return {
    profile,
    exclusionReason: operation.proof?.exclusionReason || "",
    changeProjection: operation.proof?.changeProjection || ""
  };
}

export function operationUsesFullProof(operation: Record<string, any> = {}) : any {
  return operationProofPolicy(operation).profile === OPERATION_PROOF_PROFILES.FULL;
}

const PROOF_CHANGE_DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;

export function proofChangeProjectionFromResponse(operation: Record<string, any> = {}, response: any = null) : any {
  const policy: any = operationProofPolicy(operation);
  const supplied: any = response?.__meshrixProofChangeProjection;
  if (!supplied) {
    return null;
  }
  const suppliedObject: any = supplied && typeof supplied === "object" && !Array.isArray(supplied)
    ? supplied
    : {};
  const changeProjection: any = firstText(
    suppliedObject.changeProjection,
    suppliedObject.projection,
    policy.changeProjection
  );
  if (!changeProjection || changeProjection !== policy.changeProjection) {
    return null;
  }
  const changeDigest: any = firstText(
    typeof supplied === "string" ? supplied : "",
    suppliedObject.changeDigest,
    suppliedObject.digest
  ).toLowerCase();
  if (!PROOF_CHANGE_DIGEST_PATTERN.test(changeDigest)) {
    return null;
  }
  return { changeProjection, changeDigest };
}

export function workspaceIdForProof(input: Record<string, any> = {}) : any {
  return firstText(
    input.workspaceId,
    input.workspace,
    input.ownerId,
    input.projectId,
    input.registryWorkspaceId,
    input.contributionRegistryWorkspaceId,
    "default"
  );
}

export function idempotencyKeyForProof({ operation, input = {}, traceContext, transport, method }: Record<string, any> = {}) : any {
  return firstText(
    input.idempotencyKey,
    input["idempotency-key"],
    input.requestId,
    traceContext?.requestId,
    traceContext?.traceId,
    `${transport || "internal"}:${method || ""}:${operation?.id || "operation"}:${Date.now()}`
  );
}

export function externalAuthVerifierConfig(operation: Record<string, any> = {}) : any {
  const verifier: any = operation.externalAuthVerifier;
  if (typeof verifier === "string") {
    return { method: verifier };
  }
  if (verifier && typeof verifier === "object" && !Array.isArray(verifier)) {
    return verifier;
  }
  return {};
}

export function externalAuthDeniedPayload(operation?: any, verification?: any, traceId?: any) : any {
  const status: any = Number(verification?.status || verification?.statusCode || 401) || 401;
  const reasonCode: any =
    verification?.reasonCode ||
    verification?.code ||
    (status === 401 ? operation.externalAuthMissingCode : "external_auth_denied");
  const error: any = verification?.error || verification?.message || "External authentication denied.";
  const payload: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    error: {
      code: reasonCode,
      message: error
    },
    traceId
  };
  if (Array.isArray(verification?.missingScopes) && verification.missingScopes.length > 0) {
    payload.error.missingScopes = verification.missingScopes;
  }
  if (Array.isArray(verification?.missingCapabilities) && verification.missingCapabilities.length > 0) {
    payload.error.missingCapabilities = verification.missingCapabilities;
  }
  return payload;
}
