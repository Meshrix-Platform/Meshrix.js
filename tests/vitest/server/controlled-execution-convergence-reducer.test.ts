import { describe, expect, it } from "vitest";

import {
  CONTROLLED_EXECUTION_LEAF_SPECS,
  reduceControlledExecutionConvergence
} from "../../../tools/server-scripts/lib/controlled-execution-convergence-reducer.ts";
import { buildReleaseCandidateIdentity } from "../../../tools/server-scripts/verify-release-candidate-identity.ts";

const revision: any = "a".repeat(40);
const treeDigest: any = `sha256:${"b".repeat(64)}`;

function sourceContext(verifier: any = "tools/server-scripts/verify-controlled-execution-convergence.ts") : any {
  return {
    sourceRevision: revision,
    sourceTreeDigest: treeDigest,
    verifier,
    verifierDigest: `sha256:${"c".repeat(64)}`,
    commandId: "controlled-execution-convergence-final"
  };
}

function candidate() : any {
  return buildReleaseCandidateIdentity({
    sourceRevision: revision,
    repositoryTreeDigest: `sha256:${"e".repeat(64)}`,
    releaseDefinitionSha256: `sha256:${"1".repeat(64)}`,
    packageLockSha256: `sha256:${"2".repeat(64)}`,
    releasePackages: [{
      manifest_path: "package.json",
      name: "meshrix",
      version: "0.0.1",
      manifest_sha256: "3".repeat(64)
    }],
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: `sha256:${"f".repeat(64)}`,
  });
}

function leaf(spec?: any) : any {
  const report: Record<string, any> = {
    schemaVersion: spec.schemaVersion,
    verifier: spec.verifier,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceContext: sourceContext(spec.verifier),
    summary: { reportLeakScan: true }
  };
  let target: any = report;
  for (const key of spec.readyPath.slice(0, -1)) target = target[key] ||= {};
  target[spec.readyPath.at(-1)] = true;
  if (spec.key === "oci") {
    report.checks = { linuxRuntime: true, independentInstancesDestroyed: true };
  }
  return report;
}

function fixture() : any {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceContext: sourceContext(),
    candidate: candidate(),
    leafReports: Object.fromEntries(CONTROLLED_EXECUTION_LEAF_SPECS.map((spec?: any) : any => [spec.key, leaf(spec)]))
  };
}

describe("controlled execution convergence reducer", () : any => {
  it("accepts only the exact current release candidate and leaf evidence set", () : any => {
    const report: any = reduceControlledExecutionConvergence(fixture());
    expect(report.summary).toEqual({
      controlledExecutionConvergenceReady: true,
      candidateProfileCount: 1,
      leafReportCount: 4,
      reportLeakScan: true
    });
  });

  for (const [name, mutate, message] of [
    ["missing leaf", (input?: any) : any => { delete input.leafReports.custody; }, "leaf report is missing"],
    ["stale source", (input?: any) : any => { input.leafReports.launcher.sourceContext.sourceTreeDigest = `sha256:${"0".repeat(64)}`; }, "source tree is stale"],
    ["mismatched verifier", (input?: any) : any => { input.leafReports.sandbox.verifier = "unexpected"; }, "verifier is mismatched"],
    ["privacy unsafe", (input?: any) : any => {
      input.leafReports.custody.privatePath = ["", "Users", "example", "private"].join("/");
    }, "privacy-unsafe"],
    ["candidate mutation", (input?: any) : any => {
      input.candidate = { ...input.candidate, source_revision: "0".repeat(40) };
    }, "is invalid"],
    ["non-Linux provider", (input?: any) : any => { input.leafReports.oci.checks.linuxRuntime = false; }, "not verified on Linux"],
    ["incomplete cleanup", (input?: any) : any => { input.leafReports.oci.checks.independentInstancesDestroyed = false; }, "cleanup is incomplete"]
  ]) {
    it(`rejects ${name}`, () : any => {
      const input: any = fixture();
      mutate(input);
      expect(() : any => reduceControlledExecutionConvergence(input)).toThrow(message);
    });
  }
});
