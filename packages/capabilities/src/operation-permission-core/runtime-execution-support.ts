import { nowIso } from "./runtime-common.ts";

export function appendAuthorizationDecision(securityPermissions?: any, decision: Record<string, any> = {}) : any {
  if (!securityPermissions || typeof securityPermissions.appendDecision !== "function") {
    return;
  }
  securityPermissions.appendDecision({
    protocolVersion: "v0.0.1:risk-control:authorization-1",
    allowed: false,
    effect: "deny",
    evaluatedLayers: ["tool_token_authorization"],
    createdAt: nowIso(),
    ...decision
  });
}
