import {
  asArray,
  object,
  text
} from "./support.ts";

export function pendingApproval(service?: any, operation?: any) : any {
  const requiredApproval: any = object(operation.requiredApproval);
  const approvalLayers: any = asArray(requiredApproval.approvalLayers).map(text).filter(Boolean);
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

export function trustedApprovalForForward(subject: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const approved: any = object(subject.approvedPendingOperation || subject.approvedOperationPermission);
  const status: any = text(approved.status);
  if (!["approved", "completed"].includes(status)) return null;
  const approvedOperationId: any = text(approved.operationId);
  // Accept the static forward tool or any projected upstream_operation.* OP tool.
  // Request-scoped resume already binds grant/tool/service before this handler runs.
  if (
    approvedOperationId &&
    approvedOperationId !== "gateway.forward" &&
    !approvedOperationId.startsWith("upstream_operation.")
  ) {
    return null;
  }
  const approvalScope: any = text(approved.approvalScope);
  const requiredScopes: any = new Set<any>(asArray(operation.requiredScopes).map(text));
  if (approvalScope && approvalScope !== "gateway:write" && !requiredScopes.has(approvalScope)) {
    return null;
  }
  return approved;
}

export function callerApprovalOverrideFields(input: Record<string, any> = {}) : any {
  const fields: any[] = [];
  if (Object.prototype.hasOwnProperty.call(input, "approved")) fields.push("approved");
  if (Object.prototype.hasOwnProperty.call(input, "approvalApproved")) fields.push("approvalApproved");
  return fields;
}
