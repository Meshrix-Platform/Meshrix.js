import { describe, expect, it } from "vitest";

import {
  CONTROLLED_EXECUTION_LEAF_SPECS,
  reduceControlledExecutionConvergence
} from "../../../tools/server-scripts/lib/controlled-execution-convergence-reducer.mjs";

const revision = "a".repeat(40);
const treeDigest = `sha256:${"b".repeat(64)}`;

function sourceContext(verifier = "tools/server-scripts/verify-controlled-execution-convergence.mjs") {
  return {
    sourceRevision: revision,
    sourceTreeDigest: treeDigest,
    verifier,
    verifierDigest: `sha256:${"c".repeat(64)}`,
    commandId: "controlled-execution-convergence-final"
  };
}

function binding(plan, finalNodeId = "fixture-final") {
  return {
    plan,
    finalNodeId,
    receiptDigest: "d".repeat(64),
    checkpointDigest: "e".repeat(64),
    sourceRevision: revision,
    repositoryRevision: revision,
    repositoryTreeDigest: treeDigest,
    proofProvider: "pactium.operation-proof-substrate",
    proofVerified: true,
    privacySafe: true,
    profiles: ["local", "ha", "scale", "regional-dr"],
  };
}

function leaf(spec) {
  const report = {
    schemaVersion: spec.schemaVersion,
    verifier: spec.verifier,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceContext: sourceContext(spec.verifier),
    summary: { reportLeakScan: true }
  };
  let target = report;
  for (const key of spec.readyPath.slice(0, -1)) target = target[key] ||= {};
  target[spec.readyPath.at(-1)] = true;
  if (spec.key === "oci") {
    report.checks = { linuxRuntime: true, independentInstancesDestroyed: true };
  }
  return report;
}

function fixture() {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceContext: sourceContext(),
    plan: {
      directory: "end-to-end-release/current-baseline",
      finalNodeId: "fixture-final",
      status: "completed",
      requirements: Array.from({ length: 11 }, (_, index) => `REQ-${index}`),
      criteriaChecked: true
    },
    planReceipt: binding("end-to-end-release/current-baseline"),
    leafReports: Object.fromEntries(CONTROLLED_EXECUTION_LEAF_SPECS.map((spec) => [spec.key, leaf(spec)]))
  };
}

describe("controlled execution convergence reducer", () => {
  it("accepts only the exact current receipt and leaf evidence set", () => {
    const report = reduceControlledExecutionConvergence(fixture());
    expect(report.summary).toEqual({
      controlledExecutionConvergenceReady: true,
      baselineReceiptProfileCount: 4,
      leafReportCount: 4,
      reportLeakScan: true
    });
  });

  for (const [name, mutate, message] of [
    ["missing leaf", (input) => { delete input.leafReports.custody; }, "leaf report is missing"],
    ["pending plan", (input) => { input.plan.status = "pending"; }, "final node is not completed"],
    ["stale source", (input) => { input.leafReports.launcher.sourceContext.sourceTreeDigest = `sha256:${"0".repeat(64)}`; }, "source tree is stale"],
    ["mismatched verifier", (input) => { input.leafReports.sandbox.verifier = "unexpected"; }, "verifier is mismatched"],
    ["privacy unsafe", (input) => {
      input.leafReports.custody.privatePath = ["", "Users", "example", "private"].join("/");
    }, "privacy-unsafe"],
    ["missing proof", (input) => { input.planReceipt.proofVerified = false; }, "is not current"],
    ["non-Linux provider", (input) => { input.leafReports.oci.checks.linuxRuntime = false; }, "not verified on Linux"],
    ["incomplete cleanup", (input) => { input.leafReports.oci.checks.independentInstancesDestroyed = false; }, "cleanup is incomplete"]
  ]) {
    it(`rejects ${name}`, () => {
      const input = fixture();
      mutate(input);
      expect(() => reduceControlledExecutionConvergence(input)).toThrow(message);
    });
  }
});
