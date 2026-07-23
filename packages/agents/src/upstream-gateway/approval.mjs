import {
  asArray,
  object,
  text
} from "./support.mjs";

export function pendingApproval(service, operation) {
  const requiredApproval = object(operation.requiredApproval);
  const approvalLayers = asArray(requiredApproval.approvalLayers).map(text).filter(Boolean);
  return {
    protocolVersion: service.protocolVersion,
    status: "pending_approval",
    serviceId: service.serviceId,
    operationKey: operation.operationKey,
    requiredScopes: operation.requiredScopes,
    risk: operation.risk,
    escalatable: true,
    requiredApproval,
    approval: {
      required: true,
      escalatable: true,
      approvalScope: operation.approvalScope || operation.requiredScopes[0] || "gateway:write",
      requiredApproval
    },
    approvalLayers
  };
}

export function trustedApprovalForForward(subject = {}, operation = {}) {
  const approved = object(subject.approvedPendingOperation || subject.approvedOperationPermission);
  const status = text(approved.status);
  if (!["approved", "completed"].includes(status)) return null;
  const approvedOperationId = text(approved.operationId);
  // Accept the static forward tool or any projected upstream_operation.* OP tool.
  // Request-scoped resume already binds grant/tool/service before this handler runs.
  if (
    approvedOperationId &&
    approvedOperationId !== "gateway.forward" &&
    !approvedOperationId.startsWith("upstream_operation.")
  ) {
    return null;
  }
  const approvalScope = text(approved.approvalScope);
  const requiredScopes = new Set(asArray(operation.requiredScopes).map(text));
  if (approvalScope && approvalScope !== "gateway:write" && !requiredScopes.has(approvalScope)) {
    return null;
  }
  return approved;
}

export function callerApprovalOverrideFields(input = {}) {
  const fields = [];
  if (Object.prototype.hasOwnProperty.call(input, "approved")) fields.push("approved");
  if (Object.prototype.hasOwnProperty.call(input, "approvalApproved")) fields.push("approvalApproved");
  return fields;
}
