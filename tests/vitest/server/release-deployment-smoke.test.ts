import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HISTOGRAM_BUCKETS_MS,
  RECEIPT_RETAINED_FIELDS,
  RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
  RELEASE_DEPLOYMENT_RECEIPT_SCHEMA,
  RELEASE_DEPLOYMENT_SCENARIOS,
  SCENARIO_BUDGETS,
  createReleaseDeploymentReceipt,
  validateDriverAggregate,
  validateReleaseDeploymentReceipt,
  validateScenarioAggregate,
} from "../../../tools/server-scripts/lib/release-deployment/contract.ts";
import { reduceDeploymentEvidence } from "../../../tools/server-scripts/reduce-release-deployment.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SHA_REVISION = "a".repeat(40);
const SHA_CANDIDATE = "b".repeat(64);
const SHA_FUNCTIONAL = "c".repeat(64);

function scenarioAggregate(scenario: string, attempts = SCENARIO_BUDGETS[scenario].requests): any {
  const successful = scenario === "success" || scenario === "concurrency";
  return {
    anthropic: successful ? attempts / 2 : 0,
    bucketCounts: HISTOGRAM_BUCKETS_MS.map((_boundary, index) => index === 0 ? attempts / 2 : attempts),
    completed: attempts,
    discardedBytes: attempts * 128,
    expectedFault: scenario === "provider-fault" ? attempts : 0,
    expectedRequests: attempts,
    issued: attempts,
    latency: { maxMs: 80, p50Ms: 40, p95Ms: 80, p99Ms: 80 },
    openAi: successful ? attempts / 2 : attempts,
    overflow: 0,
    successful: successful ? attempts : 0,
    timeoutOrCancellation: scenario === "cancellation" ? attempts : 0,
    unexpectedFailure: 0,
  };
}

function aggregate(): any {
  return {
    schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
    externalBoundary: true,
    scenarios: Object.fromEntries(RELEASE_DEPLOYMENT_SCENARIOS.map((scenario) => [
      scenario,
      scenarioAggregate(scenario),
    ])),
  };
}

describe("release deployment smoke", () => {
  it("accepts only complete deterministic outcomes before latency interpretation", () => {
    const complete = aggregate();
    expect(validateDriverAggregate(complete)).toEqual([]);

    const incomplete = structuredClone(complete);
    incomplete.scenarios.success.completed -= 1;
    expect(validateDriverAggregate(incomplete)[0]).toBe("success:scenario_workload_incomplete");

    const wrongSuccess = structuredClone(complete);
    wrongSuccess.scenarios.success.successful -= 1;
    wrongSuccess.scenarios.success.unexpectedFailure += 1;
    expect(validateDriverAggregate(wrongSuccess))
      .toContain("success:scenario_success_outcome_invalid");

    const wrongFault = structuredClone(complete);
    wrongFault.scenarios["provider-fault"].expectedFault = 0;
    wrongFault.scenarios["provider-fault"].successful = 4;
    expect(validateDriverAggregate(wrongFault))
      .toContain("provider-fault:scenario_provider_fault_outcome_invalid");
  });

  it("rejects histogram overflow and nested extra fields", () => {
    const valid = scenarioAggregate("success");
    expect(validateScenarioAggregate(valid, "success")).toEqual([]);
    const overflow = structuredClone(valid);
    overflow.overflow = 1;
    overflow.successful -= 1;
    expect(validateScenarioAggregate(overflow, "success"))
      .toContain("scenario_success_outcome_invalid");
    const extra = { ...valid, rawResponse: "not durable" };
    expect(validateScenarioAggregate(extra, "success"))
      .toEqual(["scenario_aggregate_fields_invalid"]);

    const wrongBudget = structuredClone(valid);
    wrongBudget.expectedRequests += 1;
    expect(validateScenarioAggregate(wrongBudget, "success"))
      .toContain("scenario_workload_budget_invalid");

    const unboundedBytes = structuredClone(valid);
    unboundedBytes.discardedBytes = Number.MAX_SAFE_INTEGER;
    expect(validateScenarioAggregate(unboundedBytes, "success"))
      .toContain("scenario_discarded_bytes_invalid");

    const invalidLatency = structuredClone(valid);
    invalidLatency.latency.p50Ms = invalidLatency.latency.maxMs + 1;
    expect(validateScenarioAggregate(invalidLatency, "success"))
      .toContain("scenario_latency_invalid");
  });

  it("creates a closed privacy-safe cleanup receipt without capacity authority", () => {
    const value = aggregate();
    const receipt = createReleaseDeploymentReceipt({
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
      scenarios: value.scenarios,
      cleanupVerified: true,
    });
    expect(validateReleaseDeploymentReceipt(receipt)).toEqual([]);
    expect(receipt.schemaVersion).toBe(RELEASE_DEPLOYMENT_RECEIPT_SCHEMA);
    expect(receipt.privacy.retainedFields).toEqual([...RECEIPT_RETAINED_FIELDS].sort());
    expect(receipt.capacityCertified).toBe(false);
    expect(receipt.releaseDeploymentVerified).toBe(true);
    expect(receipt.violationCodes).toEqual([]);

    const nestedLeak = structuredClone(receipt);
    nestedLeak.privacy.runtimePath = "private";
    expect(validateReleaseDeploymentReceipt(nestedLeak))
      .toContain("release_deployment_receipt_privacy_invalid");
    const processLeak = structuredClone(receipt);
    processLeak.processSeparation.driverPid = 123;
    expect(validateReleaseDeploymentReceipt(processLeak))
      .toContain("release_deployment_process_separation_invalid");
    const latencyLeak = structuredClone(receipt);
    latencyLeak.scenarios.success.latency.samples = [1, 2, 3];
    expect(validateReleaseDeploymentReceipt(latencyLeak))
      .toContain("success:scenario_latency_invalid");
  });

  it("fails reduction for incomplete work, unexpected outcomes, and unverified cleanup", async () => {
    const incomplete = aggregate();
    incomplete.scenarios.cancellation.issued -= 1;
    await expect(reduceDeploymentEvidence({
      aggregate: incomplete,
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
      cleanupVerified: true,
    })).rejects.toMatchObject({ code: "cancellation:scenario_workload_incomplete" });

    const unexpected = aggregate();
    unexpected.scenarios["provider-fault"].expectedFault -= 1;
    unexpected.scenarios["provider-fault"].unexpectedFailure += 1;
    await expect(reduceDeploymentEvidence({
      aggregate: unexpected,
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
      cleanupVerified: true,
    })).rejects.toMatchObject({ code: "provider-fault:scenario_provider_fault_outcome_invalid" });

    await expect(reduceDeploymentEvidence({
      aggregate: aggregate(),
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
      cleanupVerified: false,
    })).rejects.toMatchObject({ code: "release_reducer_cleanup_unverified" });
  });

  it("keeps reducer, driver, controller, and fixture self-tests process isolated", () => {
    for (const script of [
      "tools/server-scripts/reduce-release-deployment.ts",
      "tools/server-scripts/release-deployment-driver.ts",
      "tools/server-scripts/verify-release-deployment.ts",
      "services/model-gateway/test/fixture-provider.mjs",
    ]) {
      const result = spawnSync(process.execPath, [script, "--self-test"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('"ok":true');
    }
  });
});
