import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  planTestExecutionPhases,
  profileInherits,
  resolveExecutionTimeout,
  runTestPhaseLanes,
  runSuiteProcess,
  type TestExecutionPhase,
  type TestSuiteEntry,
  timeoutMsForSuite
} from "../../lib/unified-test-runner-execution.ts";

function suite(id: string): TestSuiteEntry {
  return {
    id,
    command: "node",
    args: [`${id}.ts`],
    timeoutClass: "fast"
  };
}

describe("unified test runner execution budgets", () : any => {
  it("reuses exact-command results only from the same or an inherited profile", () : any => {
    const profiles: any = {
      core: { extends: null },
      audit: { extends: "core" },
      release: { extends: "audit" },
      cyclicA: { extends: "cyclicB" },
      cyclicB: { extends: "cyclicA" }
    };
    expect(profileInherits(profiles, "core", "core")).toBe(true);
    expect(profileInherits(profiles, "release", "core")).toBe(true);
    expect(profileInherits(profiles, "core", "audit")).toBe(false);
    expect(profileInherits(profiles, "cyclicA", "core")).toBe(false);
  });

  it("resolves suite timeout classes and caps them to the remaining profile budget", () : any => {
    const suiteTimeoutMs: any = timeoutMsForSuite({ id: "fixture.fast", timeoutClass: "fast" });
    expect(resolveExecutionTimeout({ suiteTimeoutMs })).toEqual({
      timeoutMs: suiteTimeoutMs,
      timeoutScope: "suite"
    });
    expect(resolveExecutionTimeout({ suiteTimeoutMs, profileRemainingMs: 25 })).toEqual({
      timeoutMs: 25,
      timeoutScope: "profile"
    });
  });

  it("terminates an over-budget process with TERM followed by KILL and reports the timeout", async () : Promise<any> => {
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn((signal?: any) : any => {
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        queueMicrotask(() : any => child.emit("close", null, signal));
      }
      return true;
    });
    const result: any = await runSuiteProcess({
      id: "fixture.timeout",
      label: "timeout fixture",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      timeoutMs: 10,
      timeoutScope: "suite",
      terminationGraceMs: 10,
      spawnImpl: () : any => child
    });

    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.timeoutScope).toBe("suite");
    expect(result.terminationSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.kill.mock.calls.map(([signal]: any[]) : any => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("unified test runner phase execution", () => {
  it("plans ordered phases and keeps parallel lanes independent", () => {
    const phases = planTestExecutionPhases(
      [suite("environment"), suite("frontend"), suite("backend"), suite("interface")],
      [
        { id: "environment", lanes: [{ id: "preflight", suites: ["environment"] }] },
        {
          id: "functional",
          lanes: [
            { id: "frontend", suites: ["frontend"] },
            { id: "backend", suites: ["backend"] }
          ]
        },
        { id: "interface", lanes: [{ id: "contracts", suites: ["interface"] }] }
      ]
    );

    expect(phases.map((phase) => phase.id)).toEqual(["environment", "functional", "interface"]);
    expect(phases[1].lanes.map((lane) => lane.id)).toEqual(["frontend", "backend"]);
    expect(phases[1].lanes.map((lane) => lane.entries.map((entry) => entry.id))).toEqual([
      ["frontend"],
      ["backend"]
    ]);
  });

  it("rejects incomplete and duplicate phase definitions", () => {
    const entries = [suite("one"), suite("two")];
    expect(() => planTestExecutionPhases(entries, [
      { id: "phase", lanes: [{ id: "lane", suites: ["one"] }] }
    ])).toThrow("omit selected suites: two");
    expect(() => planTestExecutionPhases(entries, [
      { id: "phase", lanes: [{ id: "lane", suites: ["one", "one", "two"] }] }
    ])).toThrow('suite "one" is declared more than once');
    expect(() => planTestExecutionPhases(entries, [
      { id: "phase", lanes: [{ id: "lane", suites: ["one", "unknown"] }] }
    ])).toThrow('references unselected suite "unknown"');
    expect(() => planTestExecutionPhases(entries, [{
      id: "phase",
      lanes: [
        { id: "one", suites: ["one"], dependsOn: ["missing"] },
        { id: "two", suites: ["two"] }
      ]
    }])).toThrow('depends on unknown lane "missing"');
    expect(() => planTestExecutionPhases(entries, [{
      id: "phase",
      lanes: [
        { id: "one", suites: ["one"], dependsOn: ["two"] },
        { id: "two", suites: ["two"], dependsOn: ["one"] }
      ]
    }])).toThrow("lane dependency cycle");
  });

  it("runs lanes concurrently while preserving order inside each lane", async () => {
    let releaseFirstEntries: () => void = () => undefined;
    let observeBothFirstEntries: () => void = () => undefined;
    const firstEntriesReleased = new Promise<void>((resolve) => {
      releaseFirstEntries = resolve;
    });
    const bothFirstEntriesObserved = new Promise<void>((resolve) => {
      observeBothFirstEntries = resolve;
    });
    const started: string[] = [];
    const phase: TestExecutionPhase = {
      id: "functional",
      lanes: [
        { id: "frontend", entries: [suite("frontend-1"), suite("frontend-2")] },
        { id: "backend", entries: [suite("backend-1"), suite("backend-2")] }
      ]
    };

    const execution = runTestPhaseLanes(phase, async (entry) => {
      started.push(entry.id);
      if (started.includes("frontend-1") && started.includes("backend-1")) {
        observeBothFirstEntries();
      }
      if (entry.id.endsWith("-1")) {
        await firstEntriesReleased;
      }
      return entry.id;
    });

    await bothFirstEntriesObserved;
    expect(started).toEqual(["frontend-1", "backend-1"]);
    releaseFirstEntries();
    const outcomes = await execution;

    expect(outcomes.map((lane) => lane.results)).toEqual([
      ["frontend-1", "frontend-2"],
      ["backend-1", "backend-2"]
    ]);
    expect(started.indexOf("frontend-2")).toBeGreaterThan(started.indexOf("frontend-1"));
    expect(started.indexOf("backend-2")).toBeGreaterThan(started.indexOf("backend-1"));
  });

  it("starts dependent lanes only after their prerequisites finish", async () => {
    let releaseBuild: () => void = () => undefined;
    let observeBuild: () => void = () => undefined;
    const buildReleased = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildObserved = new Promise<void>((resolve) => {
      observeBuild = resolve;
    });
    const phase = planTestExecutionPhases(
      [suite("build"), suite("server-a"), suite("server-b")],
      [{
        id: "functional",
        lanes: [
          { id: "build", suites: ["build"] },
          { id: "server-a", suites: ["server-a"], dependsOn: ["build"] },
          { id: "server-b", suites: ["server-b"], dependsOn: ["build"] }
        ]
      }]
    )[0];
    const started: string[] = [];

    const execution = runTestPhaseLanes(phase, async (entry) => {
      started.push(entry.id);
      if (entry.id === "build") {
        observeBuild();
        await buildReleased;
      }
      return entry.id;
    });

    await buildObserved;
    await Promise.resolve();
    expect(started).toEqual(["build"]);
    releaseBuild();
    await execution;
    expect(started[0]).toBe("build");
    expect(new Set(started.slice(1))).toEqual(new Set(["server-a", "server-b"]));
  });
});
