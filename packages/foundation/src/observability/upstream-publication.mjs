import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  throwIfObservabilityAborted
} from "./observability-budgets.mjs";
import { createBoundedMetricRegistry } from "./metric-registry.mjs";

export const UPSTREAM_PUBLICATION_STAGES = Object.freeze([
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

export const UPSTREAM_PUBLICATION_OUTCOMES = Object.freeze([
  "succeeded",
  "rejected",
  "failed",
  "cancelled",
  "stale",
  "duplicate"
]);

export const UPSTREAM_PUBLICATION_REASONS = Object.freeze([
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

const REQUIRED_PUBLICATION_STAGES = Object.freeze(["compile", "persist", "project", "notify", "pull", "acknowledge"]);
const STAGE_REASONS = Object.freeze({
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
const PARTITION_HASH_PATTERN = /^[a-f0-9]{16,64}$/u;

function boundedInteger(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const error = new Error(`Publishing observation ${field} is invalid.`);
    error.code = "upstream_observation_integer_invalid";
    error.field = field;
    throw error;
  }
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) {
    const error = new Error(`Publishing observation ${field} is not supported.`);
    error.code = "upstream_observation_enum_invalid";
    error.field = field;
    throw error;
  }
  return value;
}

export function normalizeUpstreamPublicationEvent(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowedFields = new Set([
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
  if (Object.keys(source).some((key) => !allowedFields.has(key))) {
    const error = new Error("Publishing observation contains unsupported fields.");
    error.code = "upstream_observation_unknown_field";
    throw error;
  }
  const affected = Array.isArray(source.affectedPartitionHashes) ? source.affectedPartitionHashes : [];
  if (affected.length > OBSERVABILITY_BUDGETS.maxPublicationPartitions) {
    throw new ObservabilityBudgetError("upstream_observation_partition_budget_exceeded");
  }
  if (affected.some((value) => !PARTITION_HASH_PATTERN.test(String(value)))) {
    const error = new Error("Publishing observation partition reference is invalid.");
    error.code = "upstream_observation_partition_invalid";
    throw error;
  }
  const revision = boundedInteger(source.revision, "revision", 1);
  const previousRevision = boundedInteger(source.previousRevision ?? revision - 1, "previousRevision", 0);
  if (previousRevision >= revision) {
    const error = new Error("Publishing observation revision edge is not monotonic.");
    error.code = "upstream_observation_revision_edge_invalid";
    throw error;
  }
  const occurredAt = String(source.occurredAt || "");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    const error = new Error("Publishing observation occurredAt is invalid.");
    error.code = "upstream_observation_timestamp_invalid";
    throw error;
  }
  const stage = enumValue(source.stage, UPSTREAM_PUBLICATION_STAGES, "stage");
  const reason = enumValue(source.reason, UPSTREAM_PUBLICATION_REASONS, "reason");
  if (!STAGE_REASONS[stage].includes(reason)) {
    const error = new Error("Publishing observation reason is not valid for its stage.");
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
    affectedPartitionHashes: Object.freeze([...new Set(affected.map(String))].sort()),
    occurredAt: new Date(occurredAt).toISOString()
  });
}

export function createUpstreamPublicationTracker({ budgets = OBSERVABILITY_BUDGETS } = {}) {
  let partitions = new Map();
  let revisions = new Map();
  let revisionOrder = [];
  const metrics = createBoundedMetricRegistry({
    families: ["upstream_publishing_events"],
    statuses: UPSTREAM_PUBLICATION_OUTCOMES,
    reasons: UPSTREAM_PUBLICATION_REASONS,
    stages: UPSTREAM_PUBLICATION_STAGES
  });

  function observe(input, { signal } = {}) {
    throwIfObservabilityAborted(signal);
    const event = normalizeUpstreamPublicationEvent(input);
    const observedRevisions = event.affectedPartitionHashes.map((key) => partitions.get(key) || 0);
    if (observedRevisions.some((revision) => event.revision < revision)) {
      return Object.freeze({ accepted: false, status: "stale", reason: "stale_revision", revision: event.revision });
    }
    const currentRevision = revisions.get(event.revision);
    if (currentRevision && currentRevision.previousRevision !== event.previousRevision) {
      const error = new Error("Publishing observation revision edge changed within one revision.");
      error.code = "upstream_observation_previous_revision_mismatch";
      throw error;
    }
    if (observedRevisions.some((revision) => revision > 0 && revision !== event.previousRevision && revision !== event.revision)) {
      const error = new Error("Publishing observation previous revision does not match the affected partition.");
      error.code = "upstream_observation_previous_revision_mismatch";
      throw error;
    }
    if (currentRevision?.stages?.has(event.stage)) {
      return Object.freeze({ accepted: false, status: "duplicate", reason: "duplicate_revision", revision: event.revision });
    }
    const stages = new Set(currentRevision?.stages || []);
    const requiredStageIndex = REQUIRED_PUBLICATION_STAGES.indexOf(event.stage);
    if (requiredStageIndex > 0 && !stages.has(REQUIRED_PUBLICATION_STAGES[requiredStageIndex - 1])) {
      const error = new Error("Publishing observation stage order is invalid.");
      error.code = "upstream_observation_stage_order_invalid";
      throw error;
    }
    if (event.stage === "publish" && !REQUIRED_PUBLICATION_STAGES.every((stage) => stages.has(stage))) {
      const error = new Error("Server publication is missing required production stages.");
      error.code = "upstream_observation_publication_incomplete";
      throw error;
    }
    stages.add(event.stage);
    let additionalPartitions = 0;
    for (const partition of event.affectedPartitionHashes) {
      if (!partitions.has(partition)) additionalPartitions += 1;
    }
    if (partitions.size + additionalPartitions > budgets.maxPublicationPartitions) {
      throw new ObservabilityBudgetError("upstream_publication_partition_budget_exceeded");
    }
    const revisionRecord = Object.freeze({
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
    let nextOrder = revisionOrder.includes(event.revision)
      ? [...revisionOrder]
      : [...revisionOrder, event.revision].sort((left, right) => left - right);
    const evictedRevisions = [];
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

  function snapshot() {
    return Object.freeze({
      schemaVersion: "v0.0.1:observability:upstream-publication-1",
      partitionCount: partitions.size,
      revisionCount: revisions.size,
      latestRevision: revisionOrder.at(-1) || 0,
      revisions: Object.freeze(revisionOrder.map((revision) => {
        const item = revisions.get(revision);
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

export function createPublishingObservationSink(options = {}) {
  const tracker = createUpstreamPublicationTracker(options);
  return Object.freeze({
    publish(event, context = {}) {
      return tracker.observe(event, context);
    },
    snapshot: tracker.snapshot
  });
}
