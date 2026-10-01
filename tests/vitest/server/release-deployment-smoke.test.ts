import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
import { classifyReleaseDeploymentEnvironment } from "../../../tools/server-scripts/lib/release-deployment/authority.ts";
import { reduceDeploymentEvidence } from "../../../tools/server-scripts/reduce-release-deployment.ts";
import { standardClientHeaders } from "../../../tools/server-scripts/release-deployment-driver.ts";
import {
  releaseDriverFailureCode,
  standardMcpClientAudience,
} from "../../../tools/server-scripts/verify-release-deployment.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SHA_REVISION = "a".repeat(40);
const SHA_CANDIDATE = "b".repeat(64);
const SHA_FUNCTIONAL = "c".repeat(64);
const EXECUTION_ENVIRONMENT = Object.freeze({
  architecture: "x64",
  nodeVersion: "24.16.0",
  platform: "linux",
  runner: "ubuntu-24.04",
  runnerEnvironment: "github-hosted",
});

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
    executionEnvironment: { ...EXECUTION_ENVIRONMENT },
    schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
    externalBoundary: true,
    scenarios: Object.fromEntries(RELEASE_DEPLOYMENT_SCENARIOS.map((scenario) => [
      scenario,
      scenarioAggregate(scenario),
    ])),
  };
}

describe("release deployment smoke", () => {
  it("runs cancellation only after every scenario that requires a live response", () => {
    expect(RELEASE_DEPLOYMENT_SCENARIOS.at(-1)).toBe("cancellation");
    expect(RELEASE_DEPLOYMENT_SCENARIOS.indexOf("provider-fault"))
      .toBeLessThan(RELEASE_DEPLOYMENT_SCENARIOS.indexOf("cancellation"));
  });

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

  it("projects a bounded receipt contract without capacity authority", () => {
    const value = aggregate();
    const receipt = createReleaseDeploymentReceipt({
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
      executionEnvironment: value.executionEnvironment,
      scenarios: value.scenarios,
    });
    expect(validateReleaseDeploymentReceipt(receipt)).toEqual([]);
    expect(receipt.schemaVersion).toBe(RELEASE_DEPLOYMENT_RECEIPT_SCHEMA);
    expect(receipt.privacy.retainedFields).toEqual([...RECEIPT_RETAINED_FIELDS].sort());
    expect(receipt.capacityCertified).toBe(false);
    expect(receipt.executionEnvironment).toEqual(EXECUTION_ENVIRONMENT);
    expect(RECEIPT_RETAINED_FIELDS).not.toContain("runner");
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
    const runnerMismatch = structuredClone(receipt);
    runnerMismatch.executionEnvironment.runner = "debian-12";
    expect(validateReleaseDeploymentReceipt(runnerMismatch))
      .toContain("release_deployment_environment_runner_invalid");
    const duplicateRunner = { ...receipt, runner: "ubuntu-24.04" };
    expect(validateReleaseDeploymentReceipt(duplicateRunner))
      .toContain("release_deployment_receipt_fields_invalid");
    const localPreparation = structuredClone(receipt);
    localPreparation.executionEnvironment.runnerEnvironment = "local";
    expect(validateReleaseDeploymentReceipt(localPreparation)).toEqual([]);
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
    })).rejects.toMatchObject({ code: "cancellation:scenario_workload_incomplete" });

    const unexpected = aggregate();
    unexpected.scenarios["provider-fault"].expectedFault -= 1;
    unexpected.scenarios["provider-fault"].unexpectedFailure += 1;
    await expect(reduceDeploymentEvidence({
      aggregate: unexpected,
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
    })).rejects.toMatchObject({ code: "provider-fault:scenario_provider_fault_outcome_invalid" });

    await expect(reduceDeploymentEvidence({
      aggregate: aggregate(),
      sourceRevision: SHA_REVISION,
      candidateDigest: SHA_CANDIDATE,
      functionalReceiptDigest: SHA_FUNCTIONAL,
    })).rejects.toMatchObject({ code: "release_reducer_cleanup_state_invalid" });

    const resourceId = "00000000-0000-4000-8000-000000000001";
    const cleanupStatePath = path.join(os.tmpdir(), `meshrix-release-cleanup-test-${randomUUID()}.json`);
    const cleanupState = {
      backupVolume: `meshrix-release-backup-${resourceId}`,
      candidateDigest: "d".repeat(64),
      containerName: `meshrix-release-smoke-${resourceId}`,
      dataVolume: `meshrix-release-data-${resourceId}`,
      fixtureContainerName: `meshrix-release-fixture-${resourceId}`,
      imageName: `meshrix-release-smoke:${resourceId}`,
      networkName: `meshrix-release-network-${resourceId}`,
      resourceId,
      schemaVersion: "meshrix.release-deployment.cleanup/2",
      sourceRevision: SHA_REVISION,
      tempRoot: path.join(os.tmpdir(), `meshrix-release-deployment-${resourceId}`),
    };
    await fs.writeFile(cleanupStatePath, JSON.stringify(cleanupState));
    try {
      await expect(reduceDeploymentEvidence({
        aggregate: aggregate(),
        sourceRevision: SHA_REVISION,
        candidateDigest: SHA_CANDIDATE,
        functionalReceiptDigest: SHA_FUNCTIONAL,
        cleanupStatePath,
      })).rejects.toMatchObject({ code: "release_reducer_cleanup_candidate_mismatch" });
    } finally {
      await fs.rm(cleanupStatePath, { force: true });
    }
  });

  it("derives local and GitHub-hosted Ubuntu runtimes while rejecting unsupported and forged contexts", () => {
    const supported = classifyReleaseDeploymentEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.16.0",
      osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
      githubActions: "true",
      runnerEnvironment: "github-hosted",
      runnerOs: "Linux",
      runnerArchitecture: "X64",
    });
    expect(supported).toEqual(EXECUTION_ENVIRONMENT);
    expect(classifyReleaseDeploymentEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.16.0",
      osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
    })).toEqual({ ...EXECUTION_ENVIRONMENT, runnerEnvironment: "local" });

    expect(() => classifyReleaseDeploymentEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.16.0",
      osRelease: 'ID=debian\nVERSION_ID="12"\n',
      githubActions: "true",
      runnerEnvironment: "github-hosted",
      runnerOs: "Linux",
      runnerArchitecture: "X64",
    })).toThrowError(expect.objectContaining({ code: "release_deployment_environment_runner_invalid" }));

    expect(() => classifyReleaseDeploymentEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.16.0",
      osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
      githubActions: "true",
      runnerEnvironment: "self-hosted",
      runnerOs: "Linux",
      runnerArchitecture: "X64",
    })).toThrowError(expect.objectContaining({ code: "release_deployment_environment_runner_context_invalid" }));

    expect(() => classifyReleaseDeploymentEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.16.0",
      osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
      runnerEnvironment: "github-hosted",
      runnerOs: "Linux",
      runnerArchitecture: "X64",
    })).toThrowError(expect.objectContaining({ code: "release_deployment_environment_runner_context_invalid" }));
  });

  it("uses an unbranded standard MCP client identity", () => {
    expect(standardClientHeaders("synthetic-credential")).toEqual({
      "X-Meshrix.js-Api-Key": "synthetic-credential",
    });
    expect(standardMcpClientAudience("server-a")).toEqual({
      serverAudience: "server-a",
      targetIds: [],
      connectorPackageIds: [],
    });
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

  it("rejects the removed caller-authored cleanup flag", () => {
    const result = spawnSync(process.execPath, [
      "tools/server-scripts/reduce-release-deployment.ts",
      "--input", "unused.json",
      "--source-revision", SHA_REVISION,
      "--candidate-digest", SHA_CANDIDATE,
      "--functional-receipt-digest", SHA_FUNCTIONAL,
      "--cleanup-verified",
      "true",
      "--cleanup-state", "unused-cleanup.json",
      "--output", "unused-output.json",
    ], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('"code":"release_reducer_argument_invalid"');
  });

  it("retains only fixed driver failure codes for controller diagnostics", () => {
    expect(releaseDriverFailureCode('{"ok":false,"code":"success:scenario_success_outcome_invalid"}\n'))
      .toBe("release_deployment_driver_success_scenario_success_outcome_invalid");
    expect(releaseDriverFailureCode('{"ok":false,"code":"provider-fault:scenario_provider_fault_outcome_invalid"}\n'))
      .toBe("release_deployment_driver_provider_fault_scenario_provider_fault_outcome_invalid");
    expect(releaseDriverFailureCode('{"ok":false,"code":"provider-fault:scenario_provider_fault_outcome_invalid","diagnosticCode":"provider_fault_jsonrpc_error"}\n'))
      .toBe("release_deployment_driver_provider_fault_jsonrpc_error");
    expect(releaseDriverFailureCode("private runtime data"))
      .toBe("release_deployment_driver_failed");
  });
});
