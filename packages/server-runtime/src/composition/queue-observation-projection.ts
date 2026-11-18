const WORK_QUEUE_OBSERVATION_SCHEMA_VERSION: any = "v0.0.1:workflow:queue-observation-projection-1";
const DEFAULT_LIMIT: any = 100;
const MAX_LIMIT: any = 1000;
const INTERRUPTED_STATES: any = new Set<any>(["failed", "expired"]);

function toText(value?: any) : any {
  return String(value ?? "").trim();
}

function asLimit(value?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(parsed));
}

function projectItem(item: Record<string, any> = {}) : any {
  const state: any = toText(item.state || "unknown");
  return Object.freeze({
    workItemId: toText(item.workItemId),
    queueDefinitionId: toText(item.queueDefinitionId),
    queueDefinitionVersion: Math.max(0, Number(item.queueDefinitionVersion || 0)),
    observationStatus: INTERRUPTED_STATES.has(state) ? "interrupted" : state,
    state,
    priorityClass: toText(item.priorityClass || "normal"),
    availableAtMs: Math.max(0, Number(item.availableAtMs || 0)),
    expiresAtMs: Math.max(0, Number(item.expiresAtMs || 0)),
    attempt: Math.max(0, Number(item.attempt || 0)),
    maxAttempts: Math.max(0, Number(item.maxAttempts || 0)),
    createdAtMs: Math.max(0, Number(item.createdAtMs || 0)),
    updatedAtMs: Math.max(0, Number(item.updatedAtMs || 0)),
    lastTransitionSeq: Math.max(0, Number(item.lastTransitionSeq || 0))
  });
}

function normalizeStateCounts(observation: Record<string, any> = {}) : any {
  const counts: any = new Map<any, any>();
  for (const entry of Array.isArray(observation.stateCounts) ? observation.stateCounts : []) {
    const state: any = toText(entry?.state);
    if (!state) continue;
    counts.set(state, Math.max(0, Number(entry?.count || 0)));
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right))));
}

export function projectQueueObservation(observation: Record<string, any> = {}) : any {
  const sourceItems: any = observation.workItem
    ? [observation.workItem]
    : Array.isArray(observation.items) ? observation.items : [];
  const items: any = Object.freeze(sourceItems.map(projectItem));
  const stateCounts: any = normalizeStateCounts(observation);
  const totalCount: any = (Object.values(stateCounts) as any[]).reduce((sum?: any, count?: any) : any => sum + count, 0);
  return Object.freeze({
    schemaVersion: WORK_QUEUE_OBSERVATION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    summary: Object.freeze({
      totalCount: totalCount || items.length,
      stateCounts
    }),
    items
  });
}

export function createWorkQueueObservationProjection({ getJobWorkflowProvider = () : any => null }: Record<string, any> = {}) : any {
  return Object.freeze({
    async inspect(input: Record<string, any> = {}) : Promise<any> {
      const provider: any = getJobWorkflowProvider();
      if (typeof provider?.inspectWorkQueue !== "function") {
        return projectQueueObservation();
      }
      const observation: any = await provider.inspectWorkQueue({
        limit: asLimit(input.limit)
      });
      return projectQueueObservation(observation);
    }
  });
}
