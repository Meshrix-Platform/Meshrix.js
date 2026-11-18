// Shared managed-endpoint constants and error helper. This leaf module keeps
// domain.ts and task-service.ts acyclic: both consume these primitives without
// importing each other.

export const MANAGED_QUEUE_DEFINITION_PREFIX = "meshrix.managed-endpoint.tasks";
export const MANAGED_WORKER_POLL_MAX_WAIT_MS = 60_000;

export function managedError(code: string, message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { code, statusCode });
}

export function managedQueueDefinitionId(endpointId: string): string {
  return `${MANAGED_QUEUE_DEFINITION_PREFIX}.${endpointId}`;
}
