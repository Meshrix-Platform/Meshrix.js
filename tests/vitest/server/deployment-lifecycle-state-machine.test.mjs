import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyMachineDefinition } from "../../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.mjs";

const DEFINITION_PATH = path.resolve(
  import.meta.dirname,
  "../../../packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json"
);

function definition(filePath = DEFINITION_PATH) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function lifecycleDefinition(name) {
  return definition(path.resolve(
    import.meta.dirname,
    `../../../packages/foundation/src/workflow/state-machine/definitions/${name}.json`
  ));
}

describe("deployment lifecycle state machine", () => {
  it("covers assembly through resume, rollback, and failure with a total verified matrix", () => {
    const machine = definition();
    const report = verifyMachineDefinition(machine, {
      throwOnError: false,
      relativePath: "packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json"
    });

    expect(report.ok).toBe(true);
    expect(machine.states.map(({ id }) => id)).toEqual([
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

  it("guards every legal rollback and binds each recovery proof to a reproducible report", () => {
    const machine = definition();
    const legalRollbackCells = machine.totalMatrix.filter((cell) =>
      ["rollback_requested", "rollback_applied"].includes(cell.event) &&
      cell.result === "legal_transition"
    );

    expect(legalRollbackCells).not.toHaveLength(0);
    expect(legalRollbackCells.every((cell) =>
      cell.requiredGuards.includes("policyAllowed") &&
      cell.requiredGuards.includes("require_admin")
    )).toBe(true);
    expect(machine.proofMappings.map(({ params }) => params.reportPath)).toEqual(expect.arrayContaining([
      "build/reports/deployment-container-flow.json",
      "build/reports/plugin-runtime.json",
      "build/reports/storage-production-restore-drill/latest.json",
      "build/reports/work-queue/latest.json"
    ]));
  });
});

describe("operational capability lifecycle state machines", () => {
  it.each([
    [
      "alert.lifecycle",
      ["rule_loaded", "firing", "acknowledged", "resolved", "suppressed", "notification_failed", "archived"]
    ],
    [
      "storage.backup.lifecycle",
      ["scheduled", "snapshotting", "verifying", "retained", "restore_previewed", "restored", "expired", "failed"]
    ]
  ])("verifies %s with the required state coverage", (name, expectedStates) => {
    const machine = lifecycleDefinition(name);
    const report = verifyMachineDefinition(machine, {
      throwOnError: false,
      relativePath: `packages/foundation/src/workflow/state-machine/definitions/${name}.json`
    });

    expect(report.ok).toBe(true);
    expect(machine.states.map(({ id }) => id)).toEqual(expectedStates);
    expect(machine.totalMatrix).toHaveLength(machine.states.length * machine.events.length);
    expect(machine.proofObligations).toHaveLength(machine.proofMappings.length);
  });

  it("requires policy and administrator guards before storage restore apply", () => {
    const machine = lifecycleDefinition("storage.backup.lifecycle");
    const restore = machine.totalMatrix.find((cell) =>
      cell.from === "restore_previewed" && cell.event === "restore_applied"
    );

    expect(restore).toMatchObject({
      result: "legal_transition",
      to: "restored",
      requiredGuards: ["policyAllowed", "require_admin"]
    });
  });
});
