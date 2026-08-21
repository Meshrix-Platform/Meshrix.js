import { createHash } from "node:crypto";

import { canonicalJson } from "../../../../packages/contracts/src/serialization/canonical-json.ts";

export const RELEASE_DEPLOYMENT_RECEIPT_SCHEMA =
  "v0.0.1:meshrix:release-deployment-receipt-1";
export const STABLE_AUTHORITY_MANIFEST_SCHEMA =
  "v0.0.1:meshrix:stable-authority-manifest-1";
export const RELEASE_AUTHORITY_MANIFEST_SCHEMA =
  "v0.0.1:meshrix:release-authority-manifest-1";
export const RELEASE_DEPLOYMENT_CLAIM = "release-deployment-verified";
export const FUNCTIONAL_CLAIM = "functional-complete";
export const RUNTIME_UI_TARGET = "runtime-ui";
export const UBUNTU_RUNNER = "ubuntu-24.04";
export const RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA = "meshrix.release-deployment.aggregate/1";
export const RELEASE_DEPLOYMENT_SCENARIOS = Object.freeze([
  "success",
  "concurrency",
  "cancellation",
  "provider-fault",
]);
export const SCENARIO_BUDGETS: Readonly<Record<string, any>> = Object.freeze({
  success: Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 10_000 }),
  concurrency: Object.freeze({ requests: 16, concurrency: 4, timeoutMs: 10_000 }),
  cancellation: Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 10_000, cancelAfterMs: 200 }),
  "provider-fault": Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 10_000 }),
});
export const MAX_MODEL_OPERATIONS = 32;
export const MAX_IN_FLIGHT = 4;
export const MAX_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_AGGREGATE_BYTES = 256 * 1024;
export const MAX_RECORDED_LATENCY_MS = 60_000;
export const HISTOGRAM_BUCKETS_MS = Object.freeze([
  50, 100, 250, 500, 1000, 2000, 4000, 8000, 10_000,
]);
export const RECEIPT_RETAINED_FIELDS = Object.freeze([
  "cacheRetention",
  "candidateDigest",
  "capacityCertified",
  "claim",
  "cleanup",
  "externalBoundary",
  "functionalReceiptDigest",
  "histogramBuckets",
  "privacy",
  "processSeparation",
  "releaseDeploymentVerified",
  "runner",
  "runtimeUiTarget",
  "scenarios",
  "schemaVersion",
  "sourceRevision",
  "status",
  "violationCodes",
]);

const SCENARIO_KEYS = Object.freeze([
  "anthropic",
  "bucketCounts",
  "completed",
  "discardedBytes",
  "expectedFault",
  "expectedRequests",
  "issued",
  "latency",
  "openAi",
  "overflow",
  "successful",
  "timeoutOrCancellation",
  "unexpectedFailure",
]);
const LATENCY_KEYS = Object.freeze(["maxMs", "p50Ms", "p95Ms", "p99Ms"]);
const PROCESS_KEYS = Object.freeze(["controller", "driver", "fixture", "reducer", "service"]);
const PRIVACY_KEYS = Object.freeze(["containsRuntimeValues", "retainedFields"]);
const CACHE_KEYS = Object.freeze(["buildCachePreserved", "dependencyCachePreserved"]);

export function sha256(value: any): string {
  return createHash("sha256").update(value).digest("hex");
}

export function prefixedSha256(value: any): string {
  return `sha256:${sha256(value)}`;
}

export function canonicalDigest(value: any): string {
  return sha256(canonicalJson(value));
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: any, expected: readonly string[]): boolean {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function finiteNonNegative(value: any): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integerNonNegative(value: any): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

export function validateScenarioBudgets(budgets: any = SCENARIO_BUDGETS): any {
  if (!isRecord(budgets) ||
    JSON.stringify(Object.keys(budgets).sort()) !== JSON.stringify([...RELEASE_DEPLOYMENT_SCENARIOS].sort())) {
    fail("release_driver_budget_scenarios_invalid");
  }
  let total = 0;
  for (const scenario of RELEASE_DEPLOYMENT_SCENARIOS) {
    const budget = budgets[scenario];
    const allowed = scenario === "cancellation"
      ? ["cancelAfterMs", "concurrency", "requests", "timeoutMs"]
      : ["concurrency", "requests", "timeoutMs"];
    if (!exactKeys(budget, allowed) ||
      !Number.isSafeInteger(budget.requests) || budget.requests < 1 ||
      !Number.isSafeInteger(budget.concurrency) || budget.concurrency < 1 ||
      budget.requests !== SCENARIO_BUDGETS[scenario].requests ||
      budget.concurrency !== SCENARIO_BUDGETS[scenario].concurrency ||
      budget.concurrency > MAX_IN_FLIGHT || budget.concurrency > budget.requests ||
      !Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs < 1 ||
      budget.timeoutMs > MAX_REQUEST_TIMEOUT_MS ||
      (scenario === "cancellation" && (
        !Number.isSafeInteger(budget.cancelAfterMs) || budget.cancelAfterMs < 1 ||
        budget.cancelAfterMs >= budget.timeoutMs
      ))) {
      fail("release_driver_budget_invalid", `Invalid bounded budget for ${scenario}.`);
    }
    total += budget.requests;
  }
  if (total > MAX_MODEL_OPERATIONS) fail("release_driver_total_budget_exceeded");
  return Object.freeze({ scenarioCount: RELEASE_DEPLOYMENT_SCENARIOS.length, totalOperations: total });
}

export function validateScenarioAggregate(aggregate: any, scenario = ""): string[] {
  const reasons: string[] = [];
  if (!exactKeys(aggregate, SCENARIO_KEYS)) return ["scenario_aggregate_fields_invalid"];
  for (const key of [
    "anthropic", "completed", "discardedBytes", "expectedFault", "expectedRequests",
    "issued", "openAi", "overflow", "successful", "timeoutOrCancellation", "unexpectedFailure",
  ]) {
    if (!integerNonNegative(aggregate[key])) reasons.push(`scenario_aggregate_invalid:${key}`);
  }
  if (reasons.length > 0) return reasons;
  if (aggregate.issued !== aggregate.expectedRequests || aggregate.completed !== aggregate.issued) {
    reasons.push("scenario_workload_incomplete");
  }
  if (scenario && SCENARIO_BUDGETS[scenario] &&
    aggregate.expectedRequests !== SCENARIO_BUDGETS[scenario].requests) {
    reasons.push("scenario_workload_budget_invalid");
  }
  if (aggregate.discardedBytes > aggregate.completed * MAX_RESPONSE_BYTES) {
    reasons.push("scenario_discarded_bytes_invalid");
  }
  const outcomes = aggregate.successful + aggregate.expectedFault + aggregate.unexpectedFailure +
    aggregate.timeoutOrCancellation + aggregate.overflow;
  if (outcomes !== aggregate.completed || aggregate.openAi + aggregate.anthropic !== aggregate.issued) {
    reasons.push("scenario_outcome_counts_invalid");
  }
  if (scenario === "success" || scenario === "concurrency") {
    if (aggregate.successful !== aggregate.issued || aggregate.openAi < 1 || aggregate.anthropic < 1 ||
      aggregate.expectedFault !== 0 || aggregate.unexpectedFailure !== 0 ||
      aggregate.timeoutOrCancellation !== 0 || aggregate.overflow !== 0) {
      reasons.push("scenario_success_outcome_invalid");
    }
  } else if (scenario === "cancellation") {
    if (aggregate.timeoutOrCancellation !== aggregate.issued || aggregate.successful !== 0 ||
      aggregate.expectedFault !== 0 || aggregate.unexpectedFailure !== 0 || aggregate.overflow !== 0) {
      reasons.push("scenario_cancellation_outcome_invalid");
    }
  } else if (scenario === "provider-fault") {
    if (aggregate.expectedFault !== aggregate.issued || aggregate.successful !== 0 ||
      aggregate.timeoutOrCancellation !== 0 || aggregate.unexpectedFailure !== 0 || aggregate.overflow !== 0) {
      reasons.push("scenario_provider_fault_outcome_invalid");
    }
  }
  if (!exactKeys(aggregate.latency, LATENCY_KEYS) ||
    LATENCY_KEYS.some((key) => !finiteNonNegative(aggregate.latency[key]) ||
      aggregate.latency[key] > MAX_RECORDED_LATENCY_MS) ||
    aggregate.latency.maxMs <= 0 ||
    aggregate.latency.p50Ms > aggregate.latency.p95Ms ||
    aggregate.latency.p95Ms > aggregate.latency.p99Ms ||
    aggregate.latency.p99Ms > aggregate.latency.maxMs) {
    reasons.push("scenario_latency_invalid");
  }
  if (!Array.isArray(aggregate.bucketCounts) ||
    aggregate.bucketCounts.length !== HISTOGRAM_BUCKETS_MS.length ||
    aggregate.bucketCounts.some((count: any) => !integerNonNegative(count)) ||
    aggregate.bucketCounts.some((count: number, index: number, values: number[]) =>
      count > aggregate.completed || (index > 0 && count < values[index - 1]))) {
    reasons.push("scenario_histogram_invalid");
  }
  return reasons;
}

export function validateDriverAggregate(aggregate: any): string[] {
  if (!exactKeys(aggregate, ["externalBoundary", "scenarios", "schemaVersion"])) {
    return ["release_driver_aggregate_fields_invalid"];
  }
  const reasons: string[] = [];
  if (aggregate.schemaVersion !== RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA) {
    reasons.push("release_driver_aggregate_schema_invalid");
  }
  if (aggregate.externalBoundary !== true) reasons.push("release_driver_external_boundary_invalid");
  if (!isRecord(aggregate.scenarios) ||
    JSON.stringify(Object.keys(aggregate.scenarios).sort()) !==
      JSON.stringify([...RELEASE_DEPLOYMENT_SCENARIOS].sort())) {
    reasons.push("release_driver_aggregate_scenarios_invalid");
    return reasons;
  }
  for (const scenario of RELEASE_DEPLOYMENT_SCENARIOS) {
    reasons.push(...validateScenarioAggregate(aggregate.scenarios[scenario], scenario)
      .map((reason) => `${scenario}:${reason}`));
  }
  const totalOperations = RELEASE_DEPLOYMENT_SCENARIOS.reduce(
    (total, scenario) => total + Number(aggregate.scenarios[scenario]?.expectedRequests || 0),
    0,
  );
  if (!Number.isSafeInteger(totalOperations) || totalOperations > MAX_MODEL_OPERATIONS) {
    reasons.push("release_driver_total_budget_exceeded");
  }
  return reasons;
}

export function validateReleaseDeploymentReceipt(receipt: any): string[] {
  if (!exactKeys(receipt, RECEIPT_RETAINED_FIELDS)) {
    if (!isRecord(receipt)) return ["release_deployment_receipt_missing"];
    return Object.keys(receipt)
      .filter((key) => !RECEIPT_RETAINED_FIELDS.includes(key))
      .map((key) => `release_deployment_receipt_extra_field:${key}`)
      .concat(["release_deployment_receipt_fields_invalid"]);
  }
  const reasons: string[] = [];
  if (receipt.schemaVersion !== RELEASE_DEPLOYMENT_RECEIPT_SCHEMA) reasons.push("release_deployment_receipt_schema_invalid");
  if (receipt.status !== "accepted") reasons.push("release_deployment_receipt_status_invalid");
  if (receipt.claim !== RELEASE_DEPLOYMENT_CLAIM) reasons.push("release_deployment_receipt_claim_invalid");
  if (!/^[a-f0-9]{40}$/u.test(String(receipt.sourceRevision || ""))) reasons.push("release_deployment_receipt_source_revision_invalid");
  if (!/^[a-f0-9]{64}$/u.test(String(receipt.candidateDigest || ""))) reasons.push("release_deployment_receipt_candidate_digest_invalid");
  if (!/^[a-f0-9]{64}$/u.test(String(receipt.functionalReceiptDigest || ""))) reasons.push("release_deployment_receipt_functional_digest_invalid");
  if (receipt.runtimeUiTarget !== RUNTIME_UI_TARGET) reasons.push("release_deployment_receipt_target_invalid");
  if (receipt.runner !== UBUNTU_RUNNER) reasons.push("release_deployment_receipt_runner_invalid");
  if (receipt.externalBoundary !== true) reasons.push("release_deployment_receipt_external_boundary_invalid");
  if (receipt.releaseDeploymentVerified !== true) reasons.push("release_deployment_receipt_verification_invalid");
  if (!exactKeys(receipt.processSeparation, PROCESS_KEYS) ||
    PROCESS_KEYS.some((role) => receipt.processSeparation[role] !== true)) {
    reasons.push("release_deployment_process_separation_invalid");
  }
  if (!isRecord(receipt.scenarios) ||
    JSON.stringify(Object.keys(receipt.scenarios).sort()) !== JSON.stringify([...RELEASE_DEPLOYMENT_SCENARIOS].sort())) {
    reasons.push("release_deployment_receipt_scenarios_invalid");
  } else {
    for (const scenario of RELEASE_DEPLOYMENT_SCENARIOS) {
      reasons.push(...validateScenarioAggregate(receipt.scenarios[scenario], scenario)
        .map((reason) => `${scenario}:${reason}`));
    }
  }
  if (!Array.isArray(receipt.histogramBuckets) ||
    JSON.stringify(receipt.histogramBuckets) !== JSON.stringify(HISTOGRAM_BUCKETS_MS)) {
    reasons.push("release_deployment_receipt_histogram_invalid");
  }
  if (!exactKeys(receipt.privacy, PRIVACY_KEYS) || receipt.privacy.containsRuntimeValues !== false ||
    !Array.isArray(receipt.privacy.retainedFields) ||
    JSON.stringify([...receipt.privacy.retainedFields].sort()) !== JSON.stringify([...RECEIPT_RETAINED_FIELDS].sort())) {
    reasons.push("release_deployment_receipt_privacy_invalid");
  }
  if (!exactKeys(receipt.cacheRetention, CACHE_KEYS) ||
    receipt.cacheRetention.dependencyCachePreserved !== true ||
    receipt.cacheRetention.buildCachePreserved !== true) {
    reasons.push("release_deployment_receipt_cache_retention_invalid");
  }
  if (!Array.isArray(receipt.violationCodes) || receipt.violationCodes.length !== 0) {
    reasons.push("release_deployment_receipt_violation_codes_invalid");
  }
  if (receipt.cleanup !== true) reasons.push("release_deployment_receipt_cleanup_invalid");
  if (receipt.capacityCertified !== false) reasons.push("release_deployment_receipt_capacity_not_certified");
  return reasons;
}

export function assertReleaseDeploymentReceipt(receipt: any): any {
  const reasons = validateReleaseDeploymentReceipt(receipt);
  if (reasons.length > 0) fail(reasons[0], reasons.join("; "));
  return receipt;
}

export function createReleaseDeploymentReceipt({
  sourceRevision,
  candidateDigest,
  functionalReceiptDigest,
  scenarios,
  cleanupVerified = false,
}: Record<string, any> = {}): any {
  const aggregate = {
    schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
    externalBoundary: true,
    scenarios,
  };
  const aggregateReasons = validateDriverAggregate(aggregate);
  if (aggregateReasons.length > 0) fail(aggregateReasons[0], aggregateReasons.join("; "));
  if (cleanupVerified !== true) fail("release_deployment_cleanup_unverified");
  const receipt = {
    schemaVersion: RELEASE_DEPLOYMENT_RECEIPT_SCHEMA,
    status: "accepted",
    claim: RELEASE_DEPLOYMENT_CLAIM,
    sourceRevision,
    candidateDigest,
    functionalReceiptDigest,
    runtimeUiTarget: RUNTIME_UI_TARGET,
    runner: UBUNTU_RUNNER,
    externalBoundary: true,
    processSeparation: {
      controller: true,
      driver: true,
      fixture: true,
      service: true,
      reducer: true,
    },
    scenarios,
    histogramBuckets: [...HISTOGRAM_BUCKETS_MS],
    violationCodes: [],
    privacy: {
      retainedFields: [...RECEIPT_RETAINED_FIELDS].sort(),
      containsRuntimeValues: false,
    },
    cacheRetention: {
      dependencyCachePreserved: true,
      buildCachePreserved: true,
    },
    releaseDeploymentVerified: true,
    cleanup: true,
    capacityCertified: false,
  };
  return assertReleaseDeploymentReceipt(receipt);
}
