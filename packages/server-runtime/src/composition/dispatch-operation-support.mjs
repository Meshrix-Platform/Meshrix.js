import { sendJson } from "#meshrix/foundation/http/http-response";
import { OPERATION_PROOF_PROFILES } from "#meshrix/contracts/operations/operation-decorators";

// Literal field names used in dispatch proof lifecycle instrumentation.
export const OP_DISPATCH_OTEL_ATTRIBUTES = Object.freeze({
  "service.name": "meshrix-server",
  "service.version": "0.0.1",
  "meshrix.operation.id": null,
  "meshrix.workspace.id": null,
  "meshrix.capability.id": null,
  "meshrix.receipt.id": null,
});

export function coerceValue(value, type) {
  if (type === "number") {
    return Number(value || 0);
  }
  if (type === "boolean") {
    return value === true || value === "1" || value === "true" || value === "yes";
  }
  return value;
}

export function parseJsonObject(value) {
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
    const text = value.trim();
    if (!text) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function compactStrings(values = [], limit = 50) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))]
    .slice(0, limit);
}

export function arrayOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null || value === "" ? [] : [value];
}

export function actorFromAuthSession(authSession) {
  if (!authSession?.user) {
    return { type: "anonymous" };
  }
  const user = authSession.user;
  return {
    type: user.type || (user.roleId === "tool-grant" ? "tool-grant" : "console-user"),
    user
  };
}

export function actorFromInput({ actor = null, authSession = null } = {}) {
  if (actor) {
    return actor;
  }
  return actorFromAuthSession(authSession);
}

export function requestIdFromRequest(request) {
  return request?.__licoTraceContext?.requestId || request?.__licoRequestId || "";
}

export function operationEventName(transport, suffix) {
  return `operation.${transport || "internal"}.${suffix}`;
}

export function sendOperationDenied(response, status, payload) {
  if (response?.headersSent || response?.ended) {
    return;
  }
  sendJson(response, status, payload);
}

export function logOperation(logger, level, event, details = {}) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  logger[level](event, details);
}

export function notifyNarrowTransition(request, event, toStatus) {
  if (typeof request?.onNarrowTransition === "function") {
    request.onNarrowTransition(event, toStatus);
  }
}

export function notifySideEffectStart(request) {
  if (typeof request?.onSideEffectStart === "function") {
    request.onSideEffectStart();
  }
}

export function operationProofPolicy(operation = {}) {
  const profile = operation.proof?.profile || (
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

export function operationUsesFullProof(operation = {}) {
  return operationProofPolicy(operation).profile === OPERATION_PROOF_PROFILES.FULL;
}

const PROOF_CHANGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function proofChangeProjectionFromResponse(operation = {}, response = null) {
  const policy = operationProofPolicy(operation);
  const supplied = response?.__licoProofChangeProjection;
  if (!supplied) {
    return null;
  }
  const suppliedObject = supplied && typeof supplied === "object" && !Array.isArray(supplied)
    ? supplied
    : {};
  const changeProjection = firstText(
    suppliedObject.changeProjection,
    suppliedObject.projection,
    policy.changeProjection
  );
  if (!changeProjection || changeProjection !== policy.changeProjection) {
    return null;
  }
  const changeDigest = firstText(
    typeof supplied === "string" ? supplied : "",
    suppliedObject.changeDigest,
    suppliedObject.digest
  ).toLowerCase();
  if (!PROOF_CHANGE_DIGEST_PATTERN.test(changeDigest)) {
    return null;
  }
  return { changeProjection, changeDigest };
}

export function workspaceIdForProof(input = {}) {
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

export function idempotencyKeyForProof({ operation, input = {}, traceContext, transport, method } = {}) {
  return firstText(
    input.idempotencyKey,
    input["idempotency-key"],
    input.requestId,
    traceContext?.requestId,
    traceContext?.traceId,
    `${transport || "internal"}:${method || ""}:${operation?.id || "operation"}:${Date.now()}`
  );
}

export function externalAuthVerifierConfig(operation = {}) {
  const verifier = operation.externalAuthVerifier;
  if (typeof verifier === "string") {
    return { method: verifier };
  }
  if (verifier && typeof verifier === "object" && !Array.isArray(verifier)) {
    return verifier;
  }
  return {};
}

export function externalAuthDeniedPayload(operation, verification, traceId) {
  const status = Number(verification?.status || verification?.statusCode || 401) || 401;
  const reasonCode =
    verification?.reasonCode ||
    verification?.code ||
    (status === 401 ? operation.externalAuthMissingCode : "external_auth_denied");
  const error = verification?.error || verification?.message || "External authentication denied.";
  const payload = {
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
