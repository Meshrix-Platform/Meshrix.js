import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyMachineDefinition } from "../../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.ts";

const DEFINITION_PATH: any = path.resolve(
  import.meta.dirname,
  "../../../packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json"
);

function definition(filePath: any = DEFINITION_PATH) : any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function lifecycleDefinition(name?: any) : any {
  return definition(path.resolve(
    import.meta.dirname,
    `../../../packages/foundation/src/workflow/state-machine/definitions/${name}.json`
  ));
}

describe("deployment lifecycle state machine", () : any => {
  it("covers assembly through resume, rollback, and failure with a total verified matrix", () : any => {
    const machine: any = definition();
    const report: any = verifyMachineDefinition(machine, {
      throwOnError: false,
      relativePath: "packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json"
    });

    expect(report.ok).toBe(true);
    expect(machine.states.map(({ id }: Record<string, any>) : any => id)).toEqual([
      "assembled",
      "configured",
      "started",
      "healthy",
      "degraded",
      "resumed",
      "rollback_prepared",
      "rolled_back",
      "failed"
    ]);
    expect(machine.totalMatrix).toHaveLength(machine.states.length * machine.events.length);
  });

  it("guards every legal rollback and binds each recovery proof to a reproducible report", () : any => {
    const machine: any = definition();
    const legalRollbackCells: any = machine.totalMatrix.filter((cell?: any) : any =>
      ["rollback_requested", "rollback_applied"].includes(cell.event) &&
      cell.result === "legal_transition"
    );

    expect(legalRollbackCells).not.toHaveLength(0);
    expect(legalRollbackCells.every((cell?: any) : any =>
      cell.requiredGuards.includes("policyAllowed") &&
      cell.requiredGuards.includes("require_admin")
    )).toBe(true);
    expect(machine.proofMappings.map(({ params }: Record<string, any>) : any => params.reportPath)).toEqual(expect.arrayContaining([
      "build/reports/deployment-container-flow.json",
      "build/reports/plugin-runtime.json",
      "build/reports/storage-production-restore-drill/latest.json",
      "build/reports/work-queue/latest.json"
    ]));
  });
});

describe("operational capability lifecycle state machines", () : any => {
  it.each([
    [
      "alert.lifecycle",
      ["rule_loaded", "firing", "acknowledged", "resolved", "suppressed", "notification_failed", "archived"]
    ],
    [
      "storage.backup.lifecycle",
      ["scheduled", "snapshotting", "verifying", "retained", "restore_previewed", "restored", "expired", "failed"]
    ]
  ])("verifies %s with the required state coverage", (name?: any, expectedStates?: any) : any => {
    const machine: any = lifecycleDefinition(name);
    const report: any = verifyMachineDefinition(machine, {
      throwOnError: false,
      relativePath: `packages/foundation/src/workflow/state-machine/definitions/${name}.json`
    });

    expect(report.ok).toBe(true);
    expect(machine.states.map(({ id }: Record<string, any>) : any => id)).toEqual(expectedStates);
    expect(machine.totalMatrix).toHaveLength(machine.states.length * machine.events.length);
    expect(machine.proofObligations).toHaveLength(machine.proofMappings.length);
  });

  it("requires policy and administrator guards before storage restore apply", () : any => {
    const machine: any = lifecycleDefinition("storage.backup.lifecycle");
    const restore: any = machine.totalMatrix.find((cell?: any) : any =>
      cell.from === "restore_previewed" && cell.event === "restore_applied"
    );

    expect(restore).toMatchObject({
      result: "legal_transition",
      to: "restored",
      requiredGuards: ["policyAllowed", "require_admin"]
    });
  });
});
