import {
  DEFAULT_REPAIR_APPROVAL_SCOPE,
  MAINTENANCE_AGENT_RISKS,
  READ_ONLY_POST_OPERATION_IDS,
  normalizeRisk,
  riskRank
} from "./operation-policy-constants.ts";

export function inferOperationRisk(operation: Record<string, any> = {}) : string {
  if (operation.readOnly === true || READ_ONLY_POST_OPERATION_IDS.has(operation.id)) return "read_only";
  const method = String(operation.http?.method || "GET").toUpperCase();
  return ["GET", "HEAD", "OPTIONS"].includes(method) ? "read_only" : "safe_write";
}

export function normalizeOperationSafety(safety: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const inferredRisk = inferOperationRisk(operation);
  const risk = normalizeRisk(safety.risk, inferredRisk);
  const isRepairOrHigher = riskRank(risk) >= riskRank("repair_write");
  const hasExplicitConfirmationMarker = Object.prototype.hasOwnProperty.call(safety, "requiresConfirmationExplicit");
  const requiresConfirmationExplicit = hasExplicitConfirmationMarker
    ? safety.requiresConfirmationExplicit === true
    : Object.prototype.hasOwnProperty.call(safety, "requiresConfirmation") && typeof safety.requiresConfirmation === "boolean";
  return {
    risk,
    readOnly: safety.readOnly === undefined ? risk === "read_only" : safety.readOnly === true,
    destructive: safety.destructive === undefined ? risk === "destructive" : safety.destructive === true,
    approvalScope: safety.approvalScope || DEFAULT_REPAIR_APPROVAL_SCOPE,
    requiresConfirmation: requiresConfirmationExplicit ? safety.requiresConfirmation : isRepairOrHigher,
    requiresConfirmationExplicit,
    blocked: safety.blocked === true || risk === "destructive",
    reason: String(safety.reason || ""),
    resolveRisk: typeof safety.resolveRisk === "function" ? safety.resolveRisk : null
  };
}

export function serializableOperationSafety(operation: Record<string, any> = {}) : any {
  const safety = normalizeOperationSafety(operation.safety || {}, operation);
  return {
    risk: safety.risk,
    readOnly: operation.readOnly === true || safety.readOnly === true,
    destructive: operation.destructive === true || safety.destructive === true,
    approvalScope: safety.approvalScope,
    requiresConfirmation: safety.requiresConfirmation,
    blocked: safety.blocked,
    reason: safety.reason,
    dynamicRisk: typeof operation.safety?.resolveRisk === "function",
    knownRisks: MAINTENANCE_AGENT_RISKS
  };
}
