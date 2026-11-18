export const QUEUE_DEFINITION_STATES = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  DEPRECATED: "deprecated"
});

export type StructuredQueueScope = Readonly<Partial<Record<"tenantId" | "workspaceId" | "projectId" | "deploymentId", string>>>;

interface QueueDefinitionBoundary {
  queueDefinitionId?: unknown;
  lifecycleState?: unknown;
  allowDeprecatedEnqueue?: unknown;
}

export function normalizeStructuredQueueScope(scope: Record<string, unknown> = {}): StructuredQueueScope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Queue scope must be a structured object.");
  }
  const normalized: Record<string, string> = {};
  for (const key of ["tenantId", "workspaceId", "projectId", "deploymentId"]) {
    const value = String(scope[key] || "").trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.freeze(normalized);
}

export function normalizeQueueLabel(value?: unknown): string {
  const label = String(value || "").trim();
  if (!label) {
    throw new Error("Queue label is required.");
  }
  return label;
}

export function assertQueueDefinitionCanEnqueue(definition?: QueueDefinitionBoundary): true {
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
