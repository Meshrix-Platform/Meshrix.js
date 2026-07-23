const WORK_QUEUE_OBSERVATION_SCHEMA_VERSION = "v0.0.1:workflow:queue-observation-projection-1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const INTERRUPTED_STATES = new Set(["failed", "expired"]);

function toText(value) {
  return String(value ?? "").trim();
}

function asLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(parsed));
}

function projectItem(item = {}) {
  const state = toText(item.state || "unknown");
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

function normalizeStateCounts(observation = {}) {
  const counts = new Map();
  for (const entry of Array.isArray(observation.stateCounts) ? observation.stateCounts : []) {
    const state = toText(entry?.state);
    if (!state) continue;
    counts.set(state, Math.max(0, Number(entry?.count || 0)));
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

export function projectQueueObservation(observation = {}) {
  const sourceItems = observation.workItem
    ? [observation.workItem]
    : Array.isArray(observation.items) ? observation.items : [];
  const items = Object.freeze(sourceItems.map(projectItem));
  const stateCounts = normalizeStateCounts(observation);
  const totalCount = Object.values(stateCounts).reduce((sum, count) => sum + count, 0);
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

export function createWorkQueueObservationProjection({ getJobWorkflowProvider = () => null } = {}) {
  return Object.freeze({
    async inspect(input = {}) {
      const provider = getJobWorkflowProvider();
      if (typeof provider?.inspectWorkQueue !== "function") {
        return projectQueueObservation();
      }
      const observation = await provider.inspectWorkQueue({
        limit: asLimit(input.limit)
      });
      return projectQueueObservation(observation);
    }
  });
}
