export const QUEUE_DEFINITION_STATES: Readonly<Record<string, any>> = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  DEPRECATED: "deprecated"
});

export function normalizeStructuredQueueScope(scope: Record<string, any> = {}) : any {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Queue scope must be a structured object.");
  }
  const normalized: Record<string, any> = {};
  for (const key of ["tenantId", "workspaceId", "projectId", "deploymentId"]) {
    const value: any = String(scope[key] || "").trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.freeze(normalized);
}

export function normalizeQueueLabel(value?: any) : any {
  const label: any = String(value || "").trim();
  if (!label) {
    throw new Error("Queue label is required.");
  }
  return label;
}

export function assertQueueDefinitionCanEnqueue(definition?: any) : any {
  if (!definition || typeof definition !== "object") {
    throw new Error("Queue definition is required.");
  }
  if (!definition.queueDefinitionId) {
    throw new Error("Queue definition id is required.");
  }
  const state: any = definition.lifecycleState || QUEUE_DEFINITION_STATES.ACTIVE;
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
