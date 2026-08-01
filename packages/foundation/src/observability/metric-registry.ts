import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  throwIfObservabilityAborted
} from "./observability-budgets.ts";

function sortedUnique(values: any = [], field: any = "dimension") : any {
  if (!Array.isArray(values) || values.length > OBSERVABILITY_BUDGETS.maxMetricVocabularyValues) {
    throw new ObservabilityBudgetError("observability_metric_vocabulary_budget_exceeded");
  }
  const normalized: any = [...new Set<any>(values.map(String))].sort();
  if (
    normalized.length > OBSERVABILITY_BUDGETS.maxMetricVocabularyValues ||
    normalized.some((value?: any) : any => !value || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value))
  ) {
    const error: Error & Record<string, any> = new Error(`Metric ${field} vocabulary is invalid or oversized.`);
    error.code = "observability_metric_vocabulary_rejected";
    throw error;
  }
  return Object.freeze(normalized);
}

function finiteNumber(value?: any, field?: any) : any {
  const number: any = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error: Error & Record<string, any> = new Error(`${field} must be a finite non-negative number.`);
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
}: Record<string, any> = {}) : any {
  const vocabulary: Readonly<Record<string, any>> = Object.freeze({
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
  const buckets: any = [...new Set<any>(durationBucketsMs.map(Number))].sort((left?: any, right?: any) : any => left - right);
  if (buckets.length > OBSERVABILITY_BUDGETS.maxMetricBuckets || buckets.some((value?: any) : any => !Number.isFinite(value) || value <= 0)) {
    throw new ObservabilityBudgetError("observability_metric_bucket_budget_exceeded");
  }
  let series: any = new Map<any, any>();

  function assertMember(value?: any, allowed?: any, field?: any, optional: any = false) : any {
    const normalized: any = String(value || "");
    if (optional && !normalized) return "";
    if (!allowed.includes(normalized)) {
      const error: Error & Record<string, any> = new Error(`Metric ${field} is not in the server-owned vocabulary.`);
      error.code = "observability_metric_dimension_rejected";
      error.field = field;
      throw error;
    }
    return normalized;
  }

  function record(input: Record<string, any> = {}, { signal }: Record<string, any> = {}) : any {
    throwIfObservabilityAborted(signal);
    const dimensions: Readonly<Record<string, any>> = Object.freeze({
      family: assertMember(input.family, vocabulary.families, "family"),
      status: assertMember(input.status, vocabulary.statuses, "status"),
      reason: assertMember(input.reason, vocabulary.reasons, "reason"),
      stage: assertMember(input.stage, vocabulary.stages, "stage", true)
    });
    const key: any = [dimensions.family, dimensions.status, dimensions.reason, dimensions.stage].join("\u001f");
    const current: any = series.get(key);
    if (!current && series.size >= maxSeries) {
      throw new ObservabilityBudgetError("observability_metric_series_budget_exceeded");
    }
    const count: any = finiteNumber(input.count ?? 1, "count");
    const durationMs: any = input.durationMs === undefined ? null : finiteNumber(input.durationMs, "durationMs");
    const next: Record<string, any> = {
      dimensions,
      count: Number(current?.count || 0) + count,
      durationCount: Number(current?.durationCount || 0),
      durationSumMs: Number(current?.durationSumMs || 0),
      durationBuckets: [...(current?.durationBuckets || buckets.map(() : any => 0))]
    };
    if (durationMs !== null) {
      next.durationCount += 1;
      next.durationSumMs += durationMs;
      for (let index: any = 0; index < buckets.length; index += 1) {
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
    const recorded: Readonly<Record<string, any>> = Object.freeze({ ...next, durationBuckets: Object.freeze(next.durationBuckets) });
    series.set(key, recorded);
    return recorded;
  }

  function snapshot() : any {
    return Object.freeze({
      vocabulary,
      durationBucketsMs: Object.freeze([...buckets]),
      maxSeries,
      seriesCount: series.size,
      series: Object.freeze([...series.values()].sort((left?: any, right?: any) : any => {
        const a: any = (Object.values(left.dimensions) as any[]).join("\u001f");
        const b: any = (Object.values(right.dimensions) as any[]).join("\u001f");
        return a.localeCompare(b);
      }))
    });
  }

  return Object.freeze({ record, snapshot });
}
