import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  throwIfObservabilityAborted
} from "./observability-budgets.mjs";

function sortedUnique(values = [], field = "dimension") {
  if (!Array.isArray(values) || values.length > OBSERVABILITY_BUDGETS.maxMetricVocabularyValues) {
    throw new ObservabilityBudgetError("observability_metric_vocabulary_budget_exceeded");
  }
  const normalized = [...new Set(values.map(String))].sort();
  if (
    normalized.length > OBSERVABILITY_BUDGETS.maxMetricVocabularyValues ||
    normalized.some((value) => !value || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value))
  ) {
    const error = new Error(`Metric ${field} vocabulary is invalid or oversized.`);
    error.code = "observability_metric_vocabulary_rejected";
    throw error;
  }
  return Object.freeze(normalized);
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${field} must be a finite non-negative number.`);
    error.code = "observability_metric_value_invalid";
    throw error;
  }
  return number;
}

export function createBoundedMetricRegistry({
  families = [],
  statuses = [],
  reasons = [],
  stages = [],
  durationBucketsMs = [10, 50, 100, 250, 500, 1_000, 2_500, 5_000],
  maxSeries = OBSERVABILITY_BUDGETS.maxMetricSeries
} = {}) {
  const vocabulary = Object.freeze({
    families: sortedUnique(families, "family"),
    statuses: sortedUnique(statuses, "status"),
    reasons: sortedUnique(reasons, "reason"),
    stages: sortedUnique(stages, "stage")
  });
  if (!Array.isArray(durationBucketsMs) || durationBucketsMs.length > OBSERVABILITY_BUDGETS.maxMetricBuckets) {
    throw new ObservabilityBudgetError("observability_metric_bucket_budget_exceeded");
  }
  if (!Number.isSafeInteger(maxSeries) || maxSeries < 1 || maxSeries > OBSERVABILITY_BUDGETS.maxMetricSeries) {
    throw new ObservabilityBudgetError("observability_metric_series_budget_invalid");
  }
  const buckets = [...new Set(durationBucketsMs.map(Number))].sort((left, right) => left - right);
  if (buckets.length > OBSERVABILITY_BUDGETS.maxMetricBuckets || buckets.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new ObservabilityBudgetError("observability_metric_bucket_budget_exceeded");
  }
  let series = new Map();

  function assertMember(value, allowed, field, optional = false) {
    const normalized = String(value || "");
    if (optional && !normalized) return "";
    if (!allowed.includes(normalized)) {
      const error = new Error(`Metric ${field} is not in the server-owned vocabulary.`);
      error.code = "observability_metric_dimension_rejected";
      error.field = field;
      throw error;
    }
    return normalized;
  }

  function record(input = {}, { signal } = {}) {
    throwIfObservabilityAborted(signal);
    const dimensions = Object.freeze({
      family: assertMember(input.family, vocabulary.families, "family"),
      status: assertMember(input.status, vocabulary.statuses, "status"),
      reason: assertMember(input.reason, vocabulary.reasons, "reason"),
      stage: assertMember(input.stage, vocabulary.stages, "stage", true)
    });
    const key = [dimensions.family, dimensions.status, dimensions.reason, dimensions.stage].join("\u001f");
    const current = series.get(key);
    if (!current && series.size >= maxSeries) {
      throw new ObservabilityBudgetError("observability_metric_series_budget_exceeded");
    }
    const count = finiteNumber(input.count ?? 1, "count");
    const durationMs = input.durationMs === undefined ? null : finiteNumber(input.durationMs, "durationMs");
    const next = {
      dimensions,
      count: Number(current?.count || 0) + count,
      durationCount: Number(current?.durationCount || 0),
      durationSumMs: Number(current?.durationSumMs || 0),
      durationBuckets: [...(current?.durationBuckets || buckets.map(() => 0))]
    };
    if (durationMs !== null) {
      next.durationCount += 1;
      next.durationSumMs += durationMs;
      for (let index = 0; index < buckets.length; index += 1) {
        if (durationMs <= buckets[index]) next.durationBuckets[index] += 1;
      }
    }
    if (
      !Number.isSafeInteger(next.count) ||
      !Number.isSafeInteger(next.durationCount) ||
      !Number.isFinite(next.durationSumMs)
    ) {
      throw new ObservabilityBudgetError("observability_metric_accumulator_budget_exceeded");
    }
    const recorded = Object.freeze({ ...next, durationBuckets: Object.freeze(next.durationBuckets) });
    series.set(key, recorded);
    return recorded;
  }

  function snapshot() {
    return Object.freeze({
      vocabulary,
      durationBucketsMs: Object.freeze([...buckets]),
      maxSeries,
      seriesCount: series.size,
      series: Object.freeze([...series.values()].sort((left, right) => {
        const a = Object.values(left.dimensions).join("\u001f");
        const b = Object.values(right.dimensions).join("\u001f");
        return a.localeCompare(b);
      }))
    });
  }

  return Object.freeze({ record, snapshot });
}
