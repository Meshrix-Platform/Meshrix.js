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
  const results: any = PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => ({
    id: command.id,
    status: "passed"
  }));
  const reportEvidence: any = Object.fromEntries(PLATFORM_ACCEPTANCE_COMMANDS
    .flatMap((command?: any) : any => command.ownedReports || [])
    .map((reportPath?: any) : any => [reportPath, {
      validationPassed: true,
      releaseReady: true,
      reportLeakScan: true,
      reducerSourceOfTruth: "fixture-reducer"
    }]));
  return { results, reportEvidence };
}

describe("platform acceptance requirement evidence", () : any => {
  it("closes the exact 30 Core and 13 publishing requirement labels", () : any => {
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS).toHaveLength(43);
    expect(new Set<any>(PLATFORM_ACCEPTANCE_REQUIREMENTS).size).toBe(43);
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS[0]).toBe("REQ-REL-001");
    expect(PLATFORM_ACCEPTANCE_REQUIREMENTS.at(-1)).toBe("REQ-USP-013");
    expect(validatePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS
    })).toMatchObject({ valid: true, requirementCount: 43, reasons: [] });
  });

  it("reduces every label from passed command-owned reports and aggregate facts", () : any => {
    const { results, reportEvidence } = currentInputs();
    const reduction: any = reducePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      results,
      reportEvidence,
      aggregateFacts: {
        ledgerAnchorReady: true,
        candidateIdentityReady: true,
        commandDagReady: true,
        inventoryReady: true,
        privacyReady: true
      }
    });
    expect(reduction).toMatchObject({
      requirementCount: 43,
      readyCount: 43,
      ready: true
    });
  });

  it("fails the exact affected labels when a report or aggregate proof is missing", () : any => {
    const { results, reportEvidence } = currentInputs();
    reportEvidence["build/reports/strategy-management.json"].releaseReady = false;
    const reduction: any = reducePlatformAcceptanceRequirementEvidence({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      results,
      reportEvidence,
      aggregateFacts: {
        ledgerAnchorReady: false,
        candidateIdentityReady: true,
        commandDagReady: true,
        inventoryReady: true,
        privacyReady: true
      }
    });
    expect(reduction.ready).toBe(false);
    expect(reduction.nodes.find((node?: any) : any => node.requirement === "REQ-REL-007")?.ready).toBe(false);
    expect(reduction.nodes.find((node?: any) : any => node.requirement === "REQ-REL-021")?.ready).toBe(false);
  });
});
