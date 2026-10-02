import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  planTestExecutionPhases,
  profileInherits,
  isCachedTestResultReusable,
  mergeInheritedProfileExecution,
  notRunSuiteResult,
  resolveRequiredServiceApplicability,
  runTestPhaseLanes,
  runSuiteProcess,
  summarizeTestResults,
  type TestExecutionPhase,
  type TestSuiteEntry
} from "../../lib/unified-test-runner-execution.ts";

function suite(id: string): TestSuiteEntry {
  return {
    id,
    command: "node",
    args: [`${id}.ts`]
  };
}

afterEach(() => vi.useRealTimers());

describe("unified test runner execution lifecycle", () : any => {
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

  it("inherits the parent phases only when an extending profile declares appended phases", () => {
    const parent = {
      mergeVitestProcesses: true,
      cachePassedResults: true,
      phases: [{ id: "core", lanes: [{ id: "functional", suites: ["core-suite"] }] }]
    };
    const extension = {
      phases: [{ id: "extension", lanes: [{ id: "delivery", suites: ["extension-suite"] }] }]
    };
    expect(mergeInheritedProfileExecution(parent, extension)).toEqual({
      mergeVitestProcesses: true,
      cachePassedResults: true,
      phases: [...parent.phases, ...extension.phases]
    });
    expect(mergeInheritedProfileExecution(parent, { cachePassedResults: false })).toEqual({
      mergeVitestProcesses: true,
      cachePassedResults: false
    });
  });

  it("distinguishes missing required capability from a selected service probe failure", () => {
    expect(resolveRequiredServiceApplicability(["docker"], {
      docker: { status: "unavailable", reasonCode: "docker_daemon_unavailable" }
    })).toEqual({
      status: "not_run",
      requiredService: "docker",
      reasonCode: "docker_daemon_unavailable"
    });
    expect(resolveRequiredServiceApplicability(["oci-conformance-native-image"], {
      "oci-conformance-native-image": { status: "failed", reasonCode: "oci_image_inspect_failed" }
    })).toEqual({
      status: "failed",
      requiredService: "oci-conformance-native-image",
      reasonCode: "oci_image_inspect_failed"
    });
  });

  it("reuses same-candidate side-effect results while validating prepared release archives", async () => {
    const cached = { status: "passed" };
    const temporarySuite = { ...suite("fixture.temp-files"), sideEffects: "temp-files" };
    const rootDir = path.resolve("test-root");
    expect(await isCachedTestResultReusable(temporarySuite, cached, { rootDir })).toBe(true);

    const prepareSuite: TestSuiteEntry = {
      id: "release.npm-package-prepare",
      command: "npm",
      args: ["run", "release:publish-npm", "--", "--prepare", "--artifact-dir", "build/release/npm-set"],
      sideEffects: "build-output"
    };
    const validatePreparedReleaseSet = vi.fn(async () => ({ packages: [] }));
    expect(await isCachedTestResultReusable(prepareSuite, cached, {
      rootDir,
      validatePreparedReleaseSet
    })).toBe(true);
    expect(validatePreparedReleaseSet).toHaveBeenCalledWith({
      rootDir,
      artifactDirectory: path.resolve(rootDir, "build/release/npm-set")
    });

    expect(await isCachedTestResultReusable(prepareSuite, cached, {
      rootDir,
      validatePreparedReleaseSet: async () => { throw new Error("prepared output missing"); }
    })).toBe(false);
  });

  it("records unstarted commands without fabricated execution timestamps", () : any => {
    const result: any = notRunSuiteResult(suite("not-launched"), {
      reason: "runner_interrupted_before_start"
    });

    expect(result).toMatchObject({ id: "not-launched", status: "not_run", reason: "runner_interrupted_before_start" });
    expect(result).not.toHaveProperty("startedAt");
    expect(result).not.toHaveProperty("finishedAt");
    expect(result).not.toHaveProperty("durationMs");
  });

  it("keeps coverage unready for skipped, incomplete, cancelled, dry-run or unclassified results", () : any => {
    expect(summarizeTestResults([
      { status: "passed" }
    ], 2)).toMatchObject({ passed: 1, coverageReady: false, releaseReady: false });
    expect(summarizeTestResults([
      { status: "passed" },
      { status: "skipped" }
    ], 2)).toMatchObject({ passed: 1, skipped: 1, coverageReady: false, releaseReady: false });
    expect(summarizeTestResults([
      { status: "passed" },
      { status: "not_run" }
    ], 2)).toMatchObject({ notRun: 1, coverageReady: false, releaseReady: false });
    expect(summarizeTestResults([
      { status: "cancelled" }
    ], 1)).toMatchObject({ cancelled: 1, coverageReady: false, releaseReady: false });
    expect(summarizeTestResults([
      { status: "passed" },
      { status: "dry-run" }
    ], 2)).toMatchObject({ dryRun: 1, coverageReady: false, releaseReady: false });
    expect(summarizeTestResults([
      { status: "passed" },
      { status: "unknown" }
    ], 2)).toMatchObject({ passed: 1, coverageReady: false, releaseReady: false });
  });

  it("lets a command complete naturally after the former slow-suite budget", async () : Promise<any> => {
    vi.useFakeTimers();
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn(() : any => true);
    const resultPromise: Promise<any> = runSuiteProcess({
      id: "fixture.timeout",
      label: "long running fixture",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      spawnImpl: () : any => child
    });
    const settled = vi.fn();
    void resultPromise.then(settled);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    child.exitCode = 0;
    child.emit("close", 0, null);
    const result: any = await resultPromise;
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    vi.useRealTimers();
  });

  it("cancels an owned process, waits for close, then force-kills after cleanup grace", async () : Promise<any> => {
    vi.useFakeTimers();
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn((signal?: any) : any => {
      if (signal === "SIGKILL") child.signalCode = signal;
      return true;
    });
    const controller = new AbortController();
    const resultPromise: Promise<any> = runSuiteProcess({
      id: "fixture.cancelled",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      signal: controller.signal,
      terminationGraceMs: 10,
      spawnImpl: () : any => child
    });

    controller.abort("SIGINT");
    expect(child.kill.mock.calls.map(([signal]: any[]) : any => signal)).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill.mock.calls.map(([signal]: any[]) : any => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("close", null, "SIGKILL");

    const result: any = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(result.terminationSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.startedAt).toBeTruthy();
    vi.useRealTimers();
  });

  it("preserves a command that already exited when cancellation races its close event", async () => {
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    const resultPromise = runSuiteProcess({
      id: "fixture.completed-before-cancel",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      signal: controller.signal,
      spawnImpl: () => child
    });

    child.exitCode = 0;
    controller.abort("SIGINT");
    child.emit("close", 0, null);

    expect(await resultPromise).toMatchObject({ status: "passed", exitCode: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("records a command that could not start as a failure with its actual spawn error", async () : Promise<any> => {
    const error: any = Object.assign(new Error("spawn denied"), { code: "EACCES" });
    const result: any = await runSuiteProcess({
      id: "fixture.spawn-error",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      spawnImpl: () : never => { throw error; }
    });

    expect(result).toMatchObject({ status: "failed", error: "spawn denied", exitCode: null });
    expect(result.startedAt).toBeTruthy();
  });

  it("keeps the registry command identity while executing a portable Node CLI argv", async () => {
    const entry = { id: "fixture.npm", command: "npm", args: ["run", "build"] };
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn(() => true);
    let actualCommand = "";
    let actualArgs: string[] = [];
    const resultPromise = runSuiteProcess(entry, {
      cwd: process.cwd(),
      executionCommand: process.execPath,
      executionArgs: ["/runtime/npm-cli.js", ...entry.args],
      stdio: ["ignore", 1, 2],
      spawnImpl: (command: string, args: string[]) => {
        actualCommand = command;
        actualArgs = args;
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("close", 0, null);
        });
        return child;
      }
    });

    const result = await resultPromise;
    expect(actualCommand).toBe(process.execPath);
    expect(actualArgs).toEqual(["/runtime/npm-cli.js", "run", "build"]);
    expect(result.command).toBe("npm run build");
    expect(result.status).toBe("passed");
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
      return { id: entry.id, status: "passed" };
    });

    await bothFirstEntriesObserved;
    expect(started).toEqual(["frontend-1", "backend-1"]);
    releaseFirstEntries();
    const outcomes = await execution;

    expect(outcomes.map((lane) => lane.results)).toEqual([
      [
        { id: "frontend-1", status: "passed" },
        { id: "frontend-2", status: "passed" }
      ],
      [
        { id: "backend-1", status: "passed" },
        { id: "backend-2", status: "passed" }
      ]
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
      return { id: entry.id, status: "passed" };
    });

    await buildObserved;
    await Promise.resolve();
    expect(started).toEqual(["build"]);
    releaseBuild();
    await execution;
    expect(started[0]).toBe("build");
    expect(new Set(started.slice(1))).toEqual(new Set(["server-a", "server-b"]));
  });

  it("marks dependent lane entries not_run when a prerequisite fails", async () => {
    const phase = planTestExecutionPhases(
      [suite("build"), suite("server-a"), suite("server-b")],
      [{
        id: "functional",
        lanes: [
          { id: "build", suites: ["build"] },
          { id: "servers", suites: ["server-a", "server-b"], dependsOn: ["build"] }
        ]
      }]
    )[0];
    const executed: string[] = [];
    const outcomes = await runTestPhaseLanes(phase, async (entry, context) => {
      if (context?.blockedBy.length) {
        return { id: entry.id, status: "not_run", blockedBy: context.blockedBy };
      }
      executed.push(entry.id);
      return { id: entry.id, status: entry.id === "build" ? "failed" : "passed" };
    });

    expect(executed).toEqual(["build"]);
    expect(outcomes[1].results).toEqual([
      { id: "server-a", status: "not_run", blockedBy: ["build"] },
      { id: "server-b", status: "not_run", blockedBy: ["build"] }
    ]);
  });
});
