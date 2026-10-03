import { describe, expect, it } from "vitest";

import {
  PLATFORM_ACCEPTANCE_COMMANDS
} from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  reducePlatformAcceptanceRequirementEvidence,
  validatePlatformAcceptanceRequirementEvidence
} from "../../../tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts";

function currentInputs() : any {
  const runId: string = "synthetic-run-a";
  const candidateDigest: string = "sha256:synthetic-a";
  const results: any = PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => ({
    id: command.id,
    status: "passed"
  }));
  const reportEvidence: any = Object.fromEntries(PLATFORM_ACCEPTANCE_COMMANDS
    .flatMap((command?: any) : any => command.ownedReports || [])
    .map((reportPath?: any) : any => [reportPath, {
      validationPassed: true,
      factsReady: true,
      reportLeakScan: true,
      reducerSourceOfTruth: "fixture-reducer",
      runId,
      candidateDigest,
      commandId: PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any => command.ownedReports?.includes(reportPath))?.id
    }]));
  return { results, reportEvidence, runId, candidateDigest };
}

describe("platform acceptance requirement evidence", () : any => {
  it("binds the supported npm product acceptance requirements", () : any => {
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS).toHaveLength(7);
    expect(new Set<any>(PLATFORM_ACCEPTANCE_REQUIREMENTS).size).toBe(7);
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS[0]).toBe("core-engineering");
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS.at(-1)).toBe("candidate-evidence");
    expect(validatePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS
    })).toMatchObject({ valid: true, requirementCount: 7, reasons: [] });
  });

  it("reduces every label from passed command-owned reports and aggregate facts", () : any => {
    const { results, reportEvidence, runId, candidateDigest } = currentInputs();
    const reduction: any = reducePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      results,
      reportEvidence,
      runId,
      candidateDigest,
      aggregateFacts: {
        ledgerAnchorReady: true,
        candidateIdentityReady: true,
        commandDagReady: true,
        inventoryReady: true,
        privacyReady: true
      }
    });
    expect(reduction).toMatchObject({
      requirementCount: 7,
      readyCount: 7,
      ready: true
    });
  });

  it("fails the exact affected labels when a report or aggregate proof is missing", () : any => {
    const { results, reportEvidence, runId, candidateDigest } = currentInputs();
    reportEvidence["build/reports/npm-package-installability.json"].factsReady = false;
    const reduction: any = reducePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      results,
      reportEvidence,
      runId,
      candidateDigest,
      aggregateFacts: {
        ledgerAnchorReady: false,
        candidateIdentityReady: true,
        commandDagReady: true,
        inventoryReady: true,
        privacyReady: true
      }
    });
    expect(reduction.ready).toBe(false);
    expect(reduction.nodes.find((node?: any) : any => node.requirement === "candidate-evidence")?.ready).toBe(false);
    expect(reduction.nodes.find((node?: any) : any => node.requirement === "npm-artifacts")?.ready).toBe(false);
  });

  it("[GC-060 GC-061 partial] rejects mismatched candidate fields, forged ready flags and skipped owners", () : any => {
    const baseline: any = currentInputs();
    const base = () : any => reducePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      ...baseline,
      aggregateFacts: { ledgerAnchorReady: true, candidateIdentityReady: true, commandDagReady: true, inventoryReady: true, privacyReady: true }
    });
    expect(base().ready).toBe(true);
    const target: string = "build/reports/npm-package-installability.json";
    const strategy: any = PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any => command.ownedReports?.includes(target));
    const report: any = baseline.reportEvidence[target];
    report.runId = "stale-run";
    expect(base().nodes.find((node?: any) : any => node.requirement === "npm-artifacts").ready).toBe(false);
    report.runId = baseline.runId;
    report.candidateDigest = "sha256:unrelated";
    expect(base().nodes.find((node?: any) : any => node.requirement === "npm-artifacts").ready).toBe(false);
    report.candidateDigest = baseline.candidateDigest;
    report.factsReady = false;
    report.releaseReady = true;
    expect(base().nodes.find((node?: any) : any => node.requirement === "npm-artifacts").ready).toBe(false);
    report.factsReady = true;
    baseline.results.find((result?: any) : any => result.id === strategy.id).status = "skipped";
    expect(base().nodes.find((node?: any) : any => node.requirement === "npm-artifacts").ready).toBe(false);
    baseline.results.find((result?: any) : any => result.id === strategy.id).status = "passed";
    expect(reducePlatformAcceptanceRequirementEvidence({ commands: PLATFORM_ACCEPTANCE_COMMANDS, results: baseline.results, reportEvidence: baseline.reportEvidence, aggregateFacts: { ledgerAnchorReady: true } }).ready).toBe(false);
  });
});
