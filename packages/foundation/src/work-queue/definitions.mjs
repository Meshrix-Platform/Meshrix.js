export const QUEUE_DEFINITION_STATES = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  DEPRECATED: "deprecated"
});

export function normalizeStructuredQueueScope(scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Queue scope must be a structured object.");
  }
  const normalized = {};
  for (const key of ["tenantId", "workspaceId", "projectId", "deploymentId"]) {
    const value = String(scope[key] || "").trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.freeze(normalized);
}

export function normalizeQueueLabel(value) {
  const label = String(value || "").trim();
  if (!label) {
    throw new Error("Queue label is required.");
  }
  return label;
}

export function assertQueueDefinitionCanEnqueue(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("Queue definition is required.");
  }
  if (!definition.queueDefinitionId) {
    throw new Error("Queue definition id is required.");
  }
  const state = definition.lifecycleState || QUEUE_DEFINITION_STATES.ACTIVE;
  if (state === QUEUE_DEFINITION_STATES.DISABLED) {
    throw new Error("Queue definition is disabled.");
  }
  if (state === QUEUE_DEFINITION_STATES.DEPRECATED && definition.allowDeprecatedEnqueue !== true) {
    throw new Error("Queue definition is deprecated.");
  }
  if (state !== QUEUE_DEFINITION_STATES.ACTIVE &&
      state !== QUEUE_DEFINITION_STATES.DISABLED &&
      state !== QUEUE_DEFINITION_STATES.DEPRECATED) {
    throw new Error(`Unknown queue definition lifecycle state: ${state}`);
  }
  return true;
}
