import { describe, expect, it } from "vitest";

import {
  createReleaseCommandDeadlockDiagnostic,
  createReleaseCommandSchedule,
  runReleaseCommandDag
} from "../../../tools/server-scripts/lib/release-command-dag-runner.ts";

function fixtureCommand(id?: any, source?: any, overrides: Record<string, any> = {}) : any {
  return {
    id,
    label: id,
    layer: "fixture",
    source,
    ...overrides
  };
}

async function run(commands?: any, overrides: Record<string, any> = {}) : Promise<any> {
  return runReleaseCommandDag({
    commands,
    env: { ...process.env },
    maxParallel: 4,
    repoRoot: process.cwd(),
    resolveCommand(command?: any) : any {
      return {
        executable: process.execPath,
        args: ["-e", command.source],
        displayCommand: `node fixture:${command.id}`
      };
    },
    ...overrides
  });
}

describe("release command DAG runner", () : any => {
  it("rejects duplicate ids, reports, missing dependencies, self-dependencies, and cycles", () : any => {
    const schedule: any = createReleaseCommandSchedule([
      fixtureCommand("duplicate", "", { report: "build/reports/shared.json" }),
      fixtureCommand("duplicate", "", { report: "build/reports/shared.json" }),
      fixtureCommand("missing", "", { dependsOn: ["absent"] }),
      fixtureCommand("self", "", { dependsOn: ["self"] }),
      fixtureCommand("cycle-a", "", { dependsOn: ["cycle-b"] }),
      fixtureCommand("cycle-b", "", { dependsOn: ["cycle-a"] })
    ]);

    expect(schedule.valid).toBe(false);
    expect(schedule.duplicateIds).toContain("duplicate");
    expect(schedule.duplicateReportFindings).toHaveLength(1);
    expect(schedule.missingDependencyFindings).toContain("missing:absent");
    expect(schedule.selfDependencyFindings).toContain("self");
    expect(schedule.cycleFindings).not.toHaveLength(0);
  });

  it("rejects duplicate ownership across primary and additional reports", () : any => {
    const schedule: any = createReleaseCommandSchedule([
      fixtureCommand("primary-owner", "", {
        report: "build/reports/primary.json",
        ownedReports: ["build/reports/additional.json"]
      }),
      fixtureCommand("additional-owner", "", {
        ownedReports: ["build/reports/primary.json"]
      }),
      fixtureCommand("second-additional-owner", "", {
        report: "build/reports/additional.json"
      })
    ]);

    expect(schedule.valid).toBe(false);
    expect(schedule.duplicateReportFindings).toHaveLength(2);
  });

  it("serializes commands that share a resource lock and preserves catalog order", async () : Promise<any> => {
    const commands: any[] = [
      fixtureCommand("first", "setTimeout(() => {}, 80)", { resourceLocks: ["shared-report"] }),
      fixtureCommand("second", "setTimeout(() => {}, 10)", { resourceLocks: ["shared-report"] })
    ];

    const result: any = await run(commands);

    expect(result.results.map(({ id }: Record<string, any>) : any => id)).toEqual(["first", "second"]);
    expect(result.results.every(({ status }: Record<string, any>) : any => status === "passed")).toBe(true);
    expect(Date.parse(result.results[1].startedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.results[0].finishedAt)
    );
  });

  it("skips failed dependants while still aggregating independent commands", async () : Promise<any> => {
    const result: any = await run([
      fixtureCommand("failed", "process.exit(7)"),
      fixtureCommand("dependant", "process.exit(0)", { dependsOn: ["failed"] }),
      fixtureCommand("independent", "process.exit(0)")
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({ id: "failed", status: "failed", exitCode: 7 }),
      expect.objectContaining({ id: "dependant", status: "skipped", exitCode: 1 }),
      expect.objectContaining({ id: "independent", status: "passed", exitCode: 0 })
    ]);
    expect(result.schedule).toMatchObject({
      executedCommandCount: 3,
      allCommandsExecuted: true
    });
  });

  it("recognizes only an explicitly declared exit code 2 as blocked", async () : Promise<any> => {
    const result: any = await run([
      fixtureCommand("declared-blocker", "process.exit(2)", { blockedExitCodes: [2] }),
      fixtureCommand("undeclared-blocker", "process.exit(2)"),
      fixtureCommand("ordinary-failure", "process.exit(1)", { blockedExitCodes: [2] }),
      fixtureCommand("unsupported-blocker-code", "process.exit(3)", { blockedExitCodes: [3] })
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({ id: "declared-blocker", status: "blocked", exitCode: 2 }),
      expect.objectContaining({ id: "undeclared-blocker", status: "failed", exitCode: 2 }),
      expect.objectContaining({ id: "ordinary-failure", status: "failed", exitCode: 1 }),
      expect.objectContaining({ id: "unsupported-blocker-code", status: "failed", exitCode: 3 })
    ]);
  });

  it("propagates a blocked dependency without suppressing independent commands", async () : Promise<any> => {
    const result: any = await run([
      fixtureCommand("blocked", "process.exit(2)", { blockedExitCodes: [2] }),
      fixtureCommand("blocked-dependant", "process.exit(0)", { dependsOn: ["blocked"] }),
      fixtureCommand("blocked-chain", "process.exit(0)", { dependsOn: ["blocked-dependant"] }),
      fixtureCommand("independent", "process.exit(0)")
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({ id: "blocked", status: "blocked", exitCode: 2 }),
      expect.objectContaining({ id: "blocked-dependant", status: "blocked", exitCode: 2, ownerChain: ["blocked-dependant", "blocked"] }),
      expect.objectContaining({ id: "blocked-chain", status: "blocked", exitCode: 2, ownerChain: ["blocked-chain", "blocked-dependant", "blocked"] }),
      expect.objectContaining({ id: "independent", status: "passed", exitCode: 0 })
    ]);
  });

  it("caps captured output by bytes without repeatedly copying the full stream", async () : Promise<any> => {
    const result: any = await run([
      fixtureCommand("noisy", "process.stdout.write('x'.repeat(10000)); process.exit(9)")
    ], {
      maxBufferBytes: 64,
      redactTail: (value?: any) : any => value
    });

    expect(result.results[0]).toMatchObject({ status: "failed", exitCode: 9 });
    expect(Buffer.byteLength(result.results[0].errorTail, "utf8")).toBeLessThanOrEqual(66);
  });

  it("runs the greedy lock and exclusive schedule without wall-clock budgets", async () : Promise<any> => {
    const commands: any[] = [
      fixtureCommand("first", "setTimeout(() => {}, 30)"),
      fixtureCommand("second", "setTimeout(() => {}, 10)"),
      fixtureCommand("exclusive", "setTimeout(() => {}, 5)", { exclusive: true }),
      fixtureCommand("third", "setTimeout(() => {}, 10)")
    ];

    const starts: any[] = [];
    const result: any = await run(commands, {
      beforeStart: async (command?: any) : Promise<any> => starts.push(command.id),
      maxParallel: 2
    });
    expect(result.results.every(({ status }: Record<string, any>) : any => status === "passed")).toBe(true);
    expect(starts).toEqual(["first", "second", "exclusive", "third"]);
  });

  it("reports exact pending dependencies, needed locks, held locks, and owners", () : any => {
    const diagnostic: any = createReleaseCommandDeadlockDiagnostic({
      completedCommandIds: ["complete"],
      heldLocks: ["report-lock"],
      lockLastOwners: { "report-lock": "producer" },
      pendingCommands: [
        fixtureCommand("consumer", "", {
          dependsOn: ["complete", "missing"],
          resourceLocks: ["report-lock", "other-lock"]
        })
      ],
      runningCommands: [fixtureCommand("producer", "", { resourceLocks: ["report-lock"] })]
    });

    expect(diagnostic).toEqual({
      code: "release-command-dag-deadlock",
      pending: [{
        id: "consumer",
        neededLocks: ["report-lock", "other-lock"],
        waitingOnDependencies: ["missing"],
        waitingOnLocks: [{ lock: "report-lock", owner: "producer" }]
      }],
      running: [{ id: "producer", locks: ["report-lock"] }],
      heldLocks: ["report-lock"]
    });
  });
});
