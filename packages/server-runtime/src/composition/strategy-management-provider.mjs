import crypto from "node:crypto";

import { SERVER_API_OPERATIONS } from "#lico/operation-registry";

export const STRATEGY_MANAGEMENT_PROTOCOL_VERSION = "v0.0.1:strategy:strategy-management-1";

const STRATEGY_OPERATION_IDS = Object.freeze(
  SERVER_API_OPERATIONS
    .filter((operation) => String(operation.id || "").startsWith("strategy."))
    .map((operation) => operation.id)
    .sort()
);

const MAX_PUBLIC_TEXT_LENGTH = 256;
const MAX_PUBLIC_LIST_ITEMS = 16;

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function requireText(value, field) {
  const normalized = compactText(value);
  if (!normalized) {
    throw new TypeError(`Strategy preview requires ${field}.`);
  }
  return normalized;
}

function optionalText(value) {
  const normalized = compactText(value);
  return normalized || undefined;
}

function boundedPublicText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = compactText(value);
  return normalized ? normalized.slice(0, MAX_PUBLIC_TEXT_LENGTH) : undefined;
}

function present(name, value) {
  return value === undefined ? {} : { [name]: value };
}

function uniqueStrings(values = [], { bounded = false } = {}) {
  const normalized = [...new Set(
    (Array.isArray(values) ? values : [])
      .map(bounded ? boundedPublicText : compactText)
      .filter(Boolean)
  )].sort();
  return Object.freeze(bounded ? normalized.slice(0, MAX_PUBLIC_LIST_ITEMS) : normalized);
}

function riskFrom(input = {}) {
  return optionalText(input.risk || input.safety?.risk || input.operation?.safety?.risk);
}

function workflowEffect(input = {}) {
  if (input.blocked === true || input.operation?.safety?.blocked === true) {
    return Object.freeze({ effect: "deny", reasonCode: "workflow_blocked", requiresApproval: false });
  }
  const risk = riskFrom(input);
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

function queueEffect(input = {}) {
  if (input.blocked === true || input.queue?.blocked === true || input.operation?.safety?.blocked === true) {
    return Object.freeze({ effect: "deny", allowed: false, reasonCode: "queue_policy_blocked" });
  }
  return Object.freeze({ effect: "allow", allowed: true, reasonCode: "queue_policy_allowed" });
}

function finiteInteger(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Strategy preview requires finite ${field}.`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function routeTarget(input = {}) {
  const target = input.target || {};
  const route = input.route || {};
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

function routeEffect(route, input = {}) {
  if (input.blocked === true || input.route?.blocked === true || input.target?.blocked === true) {
    return Object.freeze({ effect: "deny", reasonCode: "route_blocked", allowed: false });
  }
  if (!route.internalCapabilityId) {
    return Object.freeze({ effect: "deny", reasonCode: "route_target_missing", allowed: false });
  }
  return Object.freeze({ effect: "allow", reasonCode: "route_allowed", allowed: true });
}

function boundedRevision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const revision = Number(value.revision);
  return Object.freeze({
    ...present("protocolVersion", boundedPublicText(value.protocolVersion)),
    ...(Number.isSafeInteger(revision) && revision >= 0 ? { revision } : {}),
    ...present("updatedAt", boundedPublicText(value.updatedAt))
  });
}

function boundedNonnegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function publicToolDecision(decision = {}, requestedToolId = "") {
  const governancePolicyRevision = boundedRevision(decision.governancePolicyRevision);
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
  getOperationPermissionPlatform = () => null,
  createDecisionId = (policyType) => `${policyType}_${crypto.randomUUID()}`,
  now = () => new Date().toISOString()
} = {}) {
  function envelope(policyType, semanticDecision) {
    return Object.freeze({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
      policyType,
      decisionId: createDecisionId(policyType),
      ...semanticDecision,
      createdAt: now()
    });
  }

  function describe() {
    return Object.freeze({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
      capabilities: STRATEGY_OPERATION_IDS
    });
  }

  function evaluateWorkflowPolicy(input = {}) {
    const workflowId = requireText(input.workflowId, "workflowId");
    const risk = riskFrom(input);
    return envelope("workflow-policy", Object.freeze({
      workflowId,
      ...present("stage", optionalText(input.stage || input.action)),
      ...present("risk", risk),
      ...workflowEffect(input)
    }));
  }

  function evaluateAgentPolicy(input = {}) {
    const roleId = requireText(input.roleId, "roleId");
    return envelope("agent-policy", Object.freeze({
      roleId,
      ...present("routeId", optionalText(input.routeId || input.modelRouting?.routeId)),
      effect: "allow",
      reasonCode: "agent_policy_allowed"
    }));
  }

  function evaluateRoutePolicy(input = {}) {
    const route = routeTarget(input);
    return envelope("route-policy", Object.freeze({
      ...route,
      evaluatedLayers: Object.freeze(["route_policy", "strategy_management"]),
      ...routeEffect(route, input)
    }));
  }

  function evaluateQueuePolicy(input = {}) {
    const queueDefinitionId = requireText(
      input.queueDefinitionId || input.queueDefinition?.queueDefinitionId,
      "queueDefinitionId"
    );
    const operationId = requireText(input.operationId || input.operation?.id, "operationId");
    const risk = riskFrom(input);
    const priority = finiteInteger(input.priority ?? input.queue?.priority, "priority");
    const maxAttempts = finiteInteger(input.maxAttempts ?? input.queue?.maxAttempts, "maxAttempts", {
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

  async function evaluateToolPolicy(input = {}) {
    const toolId = requireText(input.toolId, "toolId");
    const platform = getOperationPermissionPlatform();
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
    const decision = await platform.policyEngine.preview({
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
