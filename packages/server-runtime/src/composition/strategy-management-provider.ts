import crypto from "node:crypto";

import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";

export const STRATEGY_MANAGEMENT_PROTOCOL_VERSION: any = "v0.0.1:strategy:strategy-management-1";

const STRATEGY_OPERATION_IDS: any = Object.freeze(
  SERVER_API_OPERATIONS
    .filter((operation?: any) : any => String(operation.id || "").startsWith("strategy."))
    .map((operation?: any) : any => operation.id)
    .sort()
);

const MAX_PUBLIC_TEXT_LENGTH: any = 256;
const MAX_PUBLIC_LIST_ITEMS: any = 16;

function compactText(value?: any) : any {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function requireText(value?: any, field?: any) : any {
  const normalized: any = compactText(value);
  if (!normalized) {
    throw new TypeError(`Strategy preview requires ${field}.`);
  }
  return normalized;
}

function optionalText(value?: any) : any {
  const normalized: any = compactText(value);
  return normalized || undefined;
}

function boundedPublicText(value?: any) : any {
  if (typeof value !== "string") return undefined;
  const normalized: any = compactText(value);
  return normalized ? normalized.slice(0, MAX_PUBLIC_TEXT_LENGTH) : undefined;
}

function present(name?: any, value?: any) : any {
  return value === undefined ? {} : { [name]: value };
}

function uniqueStrings(values: any = [], { bounded = false }: Record<string, any> = {}) : any {
  const normalized: any = [...new Set<any>(
    (Array.isArray(values) ? values : [])
      .map(bounded ? boundedPublicText : compactText)
      .filter(Boolean)
  )].sort();
  return Object.freeze(bounded ? normalized.slice(0, MAX_PUBLIC_LIST_ITEMS) : normalized);
}

function riskFrom(input: Record<string, any> = {}) : any {
  return optionalText(input.risk || input.safety?.risk || input.operation?.safety?.risk);
}

function workflowEffect(input: Record<string, any> = {}) : any {
  if (input.blocked === true || input.operation?.safety?.blocked === true) {
    return Object.freeze({ effect: "deny", reasonCode: "workflow_blocked", requiresApproval: false });
  }
  const risk: any = riskFrom(input);
  if (
    input.requiresConfirmation === true ||
    input.operation?.safety?.requiresConfirmation === true ||
    risk === "repair_write" ||
    risk === "destructive"
  ) {
    return Object.freeze({
      effect: "require_confirmation",
      reasonCode: "workflow_confirmation_required",
      requiresApproval: true
    });
  }
  return Object.freeze({ effect: "allow", reasonCode: "workflow_allowed", requiresApproval: false });
}

function queueEffect(input: Record<string, any> = {}) : any {
  if (input.blocked === true || input.queue?.blocked === true || input.operation?.safety?.blocked === true) {
    return Object.freeze({ effect: "deny", allowed: false, reasonCode: "queue_policy_blocked" });
  }
  return Object.freeze({ effect: "allow", allowed: true, reasonCode: "queue_policy_allowed" });
}

function finiteInteger(value?: any, field?: any, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }: Record<string, any> = {}) : any {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Strategy preview requires finite ${field}.`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function routeTarget(input: Record<string, any> = {}) : any {
  const target: any = input.target || {};
  const route: any = input.route || {};
  return Object.freeze({
    routeId: requireText(input.routeId || route.routeId || target.routeId, "routeId"),
    ...present("fromAspect", optionalText(input.fromAspect || input.gatewayId || route.fromAspect)),
    ...present("protocol", optionalText(input.protocol || route.protocol || target.protocol)),
    ...present("routeKind", optionalText(input.routeKind || route.kind || target.kind)),
    ...present("internalCapabilityId", optionalText(
      input.internalCapabilityId ||
      input.platformCapabilityId ||
      target.internalCapabilityId ||
      target.platformCapabilityId ||
      target.capabilityId
    ))
  });
}

function routeEffect(route?: any, input: Record<string, any> = {}) : any {
  if (input.blocked === true || input.route?.blocked === true || input.target?.blocked === true) {
    return Object.freeze({ effect: "deny", reasonCode: "route_blocked", allowed: false });
  }
  if (!route.internalCapabilityId) {
    return Object.freeze({ effect: "deny", reasonCode: "route_target_missing", allowed: false });
  }
  return Object.freeze({ effect: "allow", reasonCode: "route_allowed", allowed: true });
}

function boundedRevision(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const revision: any = Number(value.revision);
  return Object.freeze({
    ...present("protocolVersion", boundedPublicText(value.protocolVersion)),
    ...(Number.isSafeInteger(revision) && revision >= 0 ? { revision } : {}),
    ...present("updatedAt", boundedPublicText(value.updatedAt))
  });
}

function boundedNonnegativeInteger(value?: any) : any {
  const parsed: any = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function publicToolDecision(decision: Record<string, any> = {}, requestedToolId: any = "") : any {
  const governancePolicyRevision: any = boundedRevision(decision.governancePolicyRevision);
  return Object.freeze({
    ...(typeof decision.allowed === "boolean" ? { allowed: decision.allowed } : {}),
    ...present("effect", boundedPublicText(decision.effect)),
    evaluatedLayers: uniqueStrings(decision.evaluatedLayers, { bounded: true }),
    ...present("governancePolicyRevision", governancePolicyRevision),
    ...present("grantPolicyRevision", boundedNonnegativeInteger(decision.grantPolicyRevision)),
    ...present("grantPolicyState", boundedPublicText(decision.grantPolicyState)),
    missingScopes: uniqueStrings(decision.missingScopes, { bounded: true }),
    missingToolsets: uniqueStrings(decision.missingToolsets, { bounded: true }),
    ...present("reasonCode", boundedPublicText(decision.reasonCode)),
    ...present("redactedReason", boundedPublicText(decision.redactedReason)),
    toolId: boundedPublicText(decision.toolId) || boundedPublicText(requestedToolId) || ""
  });
}

export function createStrategyManagementProvider({
  getOperationPermissionPlatform = () : any => null,
  createDecisionId = (policyType?: any) : any => `${policyType}_${crypto.randomUUID()}`,
  now = () : any => new Date().toISOString()
}: Record<string, any> = {}) : any {
  function envelope(policyType?: any, semanticDecision?: any) : any {
    return Object.freeze({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
      policyType,
      decisionId: createDecisionId(policyType),
      ...semanticDecision,
      createdAt: now()
    });
  }

  function describe() : any {
    return Object.freeze({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
      capabilities: STRATEGY_OPERATION_IDS
    });
  }

  function evaluateWorkflowPolicy(input: Record<string, any> = {}) : any {
    const workflowId: any = requireText(input.workflowId, "workflowId");
    const risk: any = riskFrom(input);
    return envelope("workflow-policy", Object.freeze({
      workflowId,
      ...present("stage", optionalText(input.stage || input.action)),
      ...present("risk", risk),
      ...workflowEffect(input)
    }));
  }

  function evaluateAgentPolicy(input: Record<string, any> = {}) : any {
    const roleId: any = requireText(input.roleId, "roleId");
    return envelope("agent-policy", Object.freeze({
      roleId,
      ...present("routeId", optionalText(input.routeId)),
      effect: "allow",
      reasonCode: "agent_policy_allowed"
    }));
  }

  function evaluateRoutePolicy(input: Record<string, any> = {}) : any {
    const route: any = routeTarget(input);
    return envelope("route-policy", Object.freeze({
      ...route,
      evaluatedLayers: Object.freeze(["route_policy", "strategy_management"]),
      ...routeEffect(route, input)
    }));
  }

  function evaluateQueuePolicy(input: Record<string, any> = {}) : any {
    const queueDefinitionId: any = requireText(
      input.queueDefinitionId || input.queueDefinition?.queueDefinitionId,
      "queueDefinitionId"
    );
    const operationId: any = requireText(input.operationId || input.operation?.id, "operationId");
    const risk: any = riskFrom(input);
    const priority: any = finiteInteger(input.priority ?? input.queue?.priority, "priority");
    const maxAttempts: any = finiteInteger(input.maxAttempts ?? input.queue?.maxAttempts, "maxAttempts", {
      min: 1,
      max: 1000
    });
    return envelope("queue-policy", Object.freeze({
      queueDefinitionId,
      operationId,
      ...present("queueLabel", optionalText(input.queueLabel || input.queueDefinition?.label || input.label)),
      ...present("payloadKind", optionalText(input.payloadKind || input.payloadRef?.kind || input.payload?.kind)),
      ...present("risk", risk),
      ...present("priority", priority),
      ...present("maxAttempts", maxAttempts),
      ...present("backpressureStrategy", optionalText(input.backpressureStrategy || input.queue?.backpressureStrategy)),
      ...present("policyVersion", optionalText(input.policyVersion || input.queue?.policyVersion)),
      evaluatedLayers: Object.freeze(["queue_policy", "strategy_management"]),
      ...queueEffect(input)
    }));
  }

  async function evaluateToolPolicy(input: Record<string, any> = {}) : Promise<any> {
    const toolId: any = requireText(input.toolId, "toolId");
    const platform: any = getOperationPermissionPlatform();
    if (typeof platform?.policyEngine?.preview !== "function") {
      return envelope("tool-policy", Object.freeze({
        toolId: compactText(input.toolId),
        effect: "deny",
        allowed: false,
        reasonCode: "authorization_provider_unavailable",
        redactedReason: "Operation Permission preview is unavailable.",
        missingScopes: Object.freeze([]),
        missingToolsets: Object.freeze([]),
        evaluatedLayers: Object.freeze([])
      }));
    }
    const decision: any = await platform.policyEngine.preview({
      ...input,
      toolId
    });
    return envelope("tool-policy", publicToolDecision(decision, toolId));
  }

  return Object.freeze({
    protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
    describe,
    evaluateWorkflowPolicy,
    evaluateAgentPolicy,
    evaluateRoutePolicy,
    evaluateQueuePolicy,
    evaluateToolPolicy
  });
}
