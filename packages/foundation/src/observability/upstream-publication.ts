import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  throwIfObservabilityAborted
} from "./observability-budgets.ts";
import { createBoundedMetricRegistry } from "./metric-registry.ts";

export const UPSTREAM_PUBLICATION_STAGES: readonly any[] = Object.freeze([
  "compile",
  "persist",
  "project",
  "notify",
  "pull",
  "acknowledge",
  "reconnect",
  "rollback",
  "publish"
]);

export const UPSTREAM_PUBLICATION_OUTCOMES: readonly any[] = Object.freeze([
  "succeeded",
  "rejected",
  "failed",
  "cancelled",
  "stale",
  "duplicate"
]);

export const UPSTREAM_PUBLICATION_REASONS: readonly any[] = Object.freeze([
  "accepted",
  "validation_rejected",
  "persistence_failed",
  "snapshot_rejected",
  "projection_failed",
  "notification_failed",
  "pull_failed",
  "acknowledgement_failed",
  "rollback_applied",
  "reconnect_required",
  "server_published",
  "cancelled",
  "stale_revision",
  "duplicate_revision"
]);

const REQUIRED_PUBLICATION_STAGES: readonly any[] = Object.freeze(["compile", "persist", "project", "notify", "pull", "acknowledge"]);
const STAGE_REASONS: Readonly<Record<string, any>> = Object.freeze({
  compile: Object.freeze(["accepted", "validation_rejected", "cancelled"]),
  persist: Object.freeze(["accepted", "persistence_failed", "cancelled"]),
  project: Object.freeze(["accepted", "snapshot_rejected", "projection_failed", "cancelled"]),
  notify: Object.freeze(["accepted", "notification_failed", "cancelled"]),
  pull: Object.freeze(["accepted", "pull_failed", "cancelled"]),
  acknowledge: Object.freeze(["accepted", "acknowledgement_failed", "cancelled"]),
  rollback: Object.freeze(["rollback_applied", "cancelled"]),
  reconnect: Object.freeze(["reconnect_required", "cancelled"]),
  publish: Object.freeze(["server_published", "cancelled"])
});
const PARTITION_HASH_PATTERN: any = /^[a-f0-9]{16,64}$/u;

function boundedInteger(value?: any, field?: any, min: any = 0, max: any = Number.MAX_SAFE_INTEGER) : any {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const error: Error & Record<string, any> = new Error(`Publishing observation ${field} is invalid.`);
    error.code = "upstream_observation_integer_invalid";
    error.field = field;
    throw error;
  }
  return value;
}

function enumValue(value?: any, allowed?: any, field?: any) : any {
  if (!allowed.includes(value)) {
    const error: Error & Record<string, any> = new Error(`Publishing observation ${field} is not supported.`);
    error.code = "upstream_observation_enum_invalid";
    error.field = field;
    throw error;
  }
  return value;
}

export function normalizeUpstreamPublicationEvent(input: Record<string, any> = {}) : any {
  const source: any = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowedFields: any = new Set<any>([
    "stage",
    "outcome",
    "reason",
    "revision",
    "previousRevision",
    "durationMs",
    "lagMs",
    "affectedPartitionHashes",
    "occurredAt"
  ]);
  if (Object.keys(source).some((key?: any) : any => !allowedFields.has(key))) {
    const error: Error & Record<string, any> = new Error("Publishing observation contains unsupported fields.");
    error.code = "upstream_observation_unknown_field";
    throw error;
  }
  const affected: any = Array.isArray(source.affectedPartitionHashes) ? source.affectedPartitionHashes : [];
  if (affected.length > OBSERVABILITY_BUDGETS.maxPublicationPartitions) {
    throw new ObservabilityBudgetError("upstream_observation_partition_budget_exceeded");
  }
  if (affected.some((value?: any) : any => !PARTITION_HASH_PATTERN.test(String(value)))) {
    const error: Error & Record<string, any> = new Error("Publishing observation partition reference is invalid.");
    error.code = "upstream_observation_partition_invalid";
    throw error;
  }
  const revision: any = boundedInteger(source.revision, "revision", 1);
  const previousRevision: any = boundedInteger(source.previousRevision ?? revision - 1, "previousRevision", 0);
  if (previousRevision >= revision) {
    const error: Error & Record<string, any> = new Error("Publishing observation revision edge is not monotonic.");
    error.code = "upstream_observation_revision_edge_invalid";
    throw error;
  }
  const occurredAt: any = String(source.occurredAt || "");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    const error: Error & Record<string, any> = new Error("Publishing observation occurredAt is invalid.");
    error.code = "upstream_observation_timestamp_invalid";
    throw error;
  }
  const stage: any = enumValue(source.stage, UPSTREAM_PUBLICATION_STAGES, "stage");
  const reason: any = enumValue(source.reason, UPSTREAM_PUBLICATION_REASONS, "reason");
  if (!STAGE_REASONS[stage].includes(reason)) {
    const error: Error & Record<string, any> = new Error("Publishing observation reason is not valid for its stage.");
    error.code = "upstream_observation_stage_reason_invalid";
    throw error;
  }
  return Object.freeze({
    stage,
    outcome: enumValue(source.outcome, UPSTREAM_PUBLICATION_OUTCOMES, "outcome"),
    reason,
    revision,
    previousRevision,
    durationMs: boundedInteger(source.durationMs ?? 0, "durationMs", 0, OBSERVABILITY_BUDGETS.maxCycleDurationMs),
    lagMs: boundedInteger(source.lagMs ?? 0, "lagMs", 0, 24 * 60 * 60 * 1_000),
    affectedPartitionHashes: Object.freeze([...new Set<any>(affected.map(String))].sort()),
    occurredAt: new Date(occurredAt).toISOString()
  });
}

export function createUpstreamPublicationTracker({ budgets = OBSERVABILITY_BUDGETS }: Record<string, any> = {}) : any {
  let partitions: any = new Map<any, any>();
  let revisions: any = new Map<any, any>();
  let revisionOrder: any[] = [];
  const metrics: any = createBoundedMetricRegistry({
    families: ["upstream_publishing_events"],
    statuses: UPSTREAM_PUBLICATION_OUTCOMES,
    reasons: UPSTREAM_PUBLICATION_REASONS,
    stages: UPSTREAM_PUBLICATION_STAGES
  });

  function observe(input?: any, { signal }: Record<string, any> = {}) : any {
    throwIfObservabilityAborted(signal);
    const event: any = normalizeUpstreamPublicationEvent(input);
    const observedRevisions: any = event.affectedPartitionHashes.map((key?: any) : any => partitions.get(key) || 0);
    if (observedRevisions.some((revision?: any) : any => event.revision < revision)) {
      return Object.freeze({ accepted: false, status: "stale", reason: "stale_revision", revision: event.revision });
    }
    const currentRevision: any = revisions.get(event.revision);
    if (currentRevision && currentRevision.previousRevision !== event.previousRevision) {
      const error: Error & Record<string, any> = new Error("Publishing observation revision edge changed within one revision.");
      error.code = "upstream_observation_previous_revision_mismatch";
      throw error;
    }
    if (observedRevisions.some((revision?: any) : any => revision > 0 && revision !== event.previousRevision && revision !== event.revision)) {
      const error: Error & Record<string, any> = new Error("Publishing observation previous revision does not match the affected partition.");
      error.code = "upstream_observation_previous_revision_mismatch";
      throw error;
    }
    if (currentRevision?.stages?.has(event.stage)) {
      return Object.freeze({ accepted: false, status: "duplicate", reason: "duplicate_revision", revision: event.revision });
    }
    const stages: any = new Set<any>(currentRevision?.stages || []);
    const requiredStageIndex: any = REQUIRED_PUBLICATION_STAGES.indexOf(event.stage);
    if (requiredStageIndex > 0 && !stages.has(REQUIRED_PUBLICATION_STAGES[requiredStageIndex - 1])) {
      const error: Error & Record<string, any> = new Error("Publishing observation stage order is invalid.");
      error.code = "upstream_observation_stage_order_invalid";
      throw error;
    }
    if (event.stage === "publish" && !REQUIRED_PUBLICATION_STAGES.every((stage?: any) : any => stages.has(stage))) {
      const error: Error & Record<string, any> = new Error("Server publication is missing required production stages.");
      error.code = "upstream_observation_publication_incomplete";
      throw error;
    }
    stages.add(event.stage);
    let additionalPartitions: any = 0;
    for (const partition of event.affectedPartitionHashes) {
      if (!partitions.has(partition)) additionalPartitions += 1;
    }
    if (partitions.size + additionalPartitions > budgets.maxPublicationPartitions) {
      throw new ObservabilityBudgetError("upstream_publication_partition_budget_exceeded");
    }
    const revisionRecord: Readonly<Record<string, any>> = Object.freeze({
      revision: event.revision,
      previousRevision: event.previousRevision,
      stages,
      outcome: event.outcome,
      reason: event.reason,
      occurredAt: event.occurredAt,
      affectedPartitionCount: event.affectedPartitionHashes.length,
      durationMs: event.durationMs,
      lagMs: event.lagMs
    });
    let nextOrder: any = revisionOrder.includes(event.revision)
      ? [...revisionOrder]
      : [...revisionOrder, event.revision].sort((left?: any, right?: any) : any => left - right);
    const evictedRevisions: any[] = [];
    while (nextOrder.length > budgets.maxPublicationRevisions) evictedRevisions.push(nextOrder.shift());
    throwIfObservabilityAborted(signal);
    metrics.record({
      family: "upstream_publishing_events",
      status: event.outcome,
      reason: event.reason,
      stage: event.stage,
      durationMs: event.durationMs
    }, { signal });
    for (const partition of event.affectedPartitionHashes) partitions.set(partition, event.revision);
    revisions.set(event.revision, revisionRecord);
    for (const revision of evictedRevisions) revisions.delete(revision);
    revisionOrder = nextOrder;
    return Object.freeze({ accepted: true, status: event.outcome, reason: event.reason, revision: event.revision });
  }

  function snapshot() : any {
    return Object.freeze({
      schemaVersion: "v0.0.1:observability:upstream-publication-1",
      partitionCount: partitions.size,
      revisionCount: revisions.size,
      latestRevision: revisionOrder.at(-1) || 0,
      revisions: Object.freeze(revisionOrder.map((revision?: any) : any => {
        const item: any = revisions.get(revision);
        return Object.freeze({
          revision,
          previousRevision: item.previousRevision,
          stages: Object.freeze([...item.stages].sort()),
          outcome: item.outcome,
          reason: item.reason,
          occurredAt: item.occurredAt,
          affectedPartitionCount: item.affectedPartitionCount,
          durationMs: item.durationMs,
          lagMs: item.lagMs
        });
      })),
      metrics: metrics.snapshot(),
      budgets: Object.freeze({
        maxPublicationPartitions: budgets.maxPublicationPartitions,
        maxPublicationRevisions: budgets.maxPublicationRevisions
      })
    });
  }

  return Object.freeze({ observe, snapshot });
}

export function createPublishingObservationSink(options: Record<string, any> = {}) : any {
  const tracker: any = createUpstreamPublicationTracker(options);
  return Object.freeze({
    publish(event?: any, context: Record<string, any> = {}) : any {
      return tracker.observe(event, context);
    },
    snapshot: tracker.snapshot
  });
}
