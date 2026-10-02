import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MATERIALIZATION_PROJECT,
  MATERIALIZATION_TEST_COUNT,
  MATERIALIZATION_TEST_PATH,
  MATERIALIZATION_SUITE_PREFIX,
  validateMaterializationCollection,
  validateMaterializationRunReport,
  type MaterializationRunReport
} from "./support/upload-workspace-materialization-acceptance-contract.ts";
import {
  runUploadWorkspaceMaterializationAcceptance,
  type AcceptanceSpawn
} from "./support/run-upload-workspace-materialization-acceptance.ts";
import {
  exitCrashChildWhenOwnerDisconnects,
  terminateOwnedCrashChild,
  type CrashChildExit
} from "./support/upload-workspace-materialization-crash-lifecycle.ts";

interface TestCase {
  file: string;
  projectName: string;
  name: string;
}

interface TestAssertion {
  fullName: string;
  status: string;
}

function collectedCases(): TestCase[] {
  return Array.from({ length: MATERIALIZATION_TEST_COUNT }, (_, index) => ({
    file: MATERIALIZATION_TEST_PATH,
    projectName: MATERIALIZATION_PROJECT,
    name: `${MATERIALIZATION_SUITE_PREFIX}case ${String(index + 1).padStart(2, "0")}`
  }));
}

function normalizedName(testCase: TestCase): string {
  return testCase.name.split(" > ").join(" ");
}

function reportFor(cases: readonly TestCase[], cwd: string): MaterializationRunReport {
  const assertions: TestAssertion[] = cases.map((testCase) => ({
    fullName: normalizedName(testCase),
    status: "passed"
  }));
  return {
    success: true,
    numTotalTests: MATERIALIZATION_TEST_COUNT,
    numPassedTests: MATERIALIZATION_TEST_COUNT,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [{
      name: path.resolve(cwd, MATERIALIZATION_TEST_PATH),
      status: "passed",
      assertionResults: assertions
    }]
  };
}

function makeFakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
    killSignals: NodeJS.Signals[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killSignals.push(signal);
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => closeChild(child, null, signal));
    }
    return true;
  };
  return child;
}

function fakeChildProcess(
  output: string,
  exitCode: number | null = 0,
  closeSignal: NodeJS.Signals | null = null,
  stderrOutput = ""
) {
  const child = makeFakeChildProcess();
  let endedStreams = 0;
  const onEnd = () => {
    endedStreams += 1;
    if (endedStreams === 2) closeChild(child, exitCode, closeSignal);
  };
  child.stdout.once("end", onEnd);
  child.stderr.once("end", onEnd);
  queueMicrotask(() => {
    child.stdout.end(output);
    child.stderr.end(stderrOutput);
  });
  return child;
}

function heldChildProcess() {
  return makeFakeChildProcess();
}

function closeChild(
  child: ReturnType<typeof fakeChildProcess>,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): void {
  child.exitCode = exitCode;
  child.signalCode = signal;
  if (!child.stdout.writableEnded) child.stdout.end();
  if (!child.stderr.writableEnded) child.stderr.end();
  setImmediate(() => child.emit("close", exitCode, signal));
}

interface FakeVitestOutput {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

function spawnQueue(outputs: FakeVitestOutput[]): { spawnImpl: AcceptanceSpawn; calls: { args: string[]; cwd: unknown; detached?: boolean }[] } {
  const calls: { args: string[]; cwd: unknown; detached?: boolean }[] = [];
  const spawnImpl: AcceptanceSpawn = (_command, args, options) => {
    calls.push({ args, cwd: options.cwd, detached: options.detached });
    const output = outputs.shift();
    if (!output) throw new Error("unexpected_spawn_count");
    return fakeChildProcess(output.stdout, output.exitCode, null, output.stderr) as unknown as ReturnType<AcceptanceSpawn>;
  };
  return { spawnImpl, calls };
}

describe("upload workspace materialization acceptance runner", () => {
  it("freezes the complete unique collection for the intended file and serial project", () => {
    const expected = validateMaterializationCollection(collectedCases(), process.cwd());

    expect(expected).toHaveLength(MATERIALIZATION_TEST_COUNT);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(new Set(expected).size).toBe(MATERIALIZATION_TEST_COUNT);
  });

  it.each([
    ["missing case", (cases: TestCase[]) => cases.slice(1)],
    ["duplicate case", (cases: TestCase[]) => [...cases.slice(0, -1), cases[0]]],
    ["wrong file", (cases: TestCase[]) => cases.map((testCase, index) => index === 0 ? { ...testCase, file: "tests/other.test.ts" } : testCase)],
    ["wrong project", (cases: TestCase[]) => cases.map((testCase, index) => index === 0 ? { ...testCase, projectName: "parallel" } : testCase)],
    ["unrelated case", (cases: TestCase[]) => cases.map((testCase, index) => index === 0 ? { ...testCase, name: "unrelated suite > case" } : testCase)]
  ])("rejects a %s collection", (_label, mutate) => {
    expect(() => validateMaterializationCollection(mutate(collectedCases()), process.cwd()))
      .toThrow("materialization_acceptance_collection_invalid");
  });

  it("accepts only the exact collected assertions when the process and report succeed", () => {
    const cases = collectedCases();
    const expected = validateMaterializationCollection(cases, process.cwd());

    expect(() => validateMaterializationRunReport(
      reportFor(cases, process.cwd()),
      { exitCode: 0, signal: null, stdout: "", stderr: "" },
      expected,
      process.cwd()
    )).not.toThrow();
  });

  it.each([
    ["extra assertion", (report: MaterializationRunReport) => {
      const file = (report.testResults as Array<Record<string, unknown>>)[0];
      const assertions = file.assertionResults as TestAssertion[];
      return {
        ...report,
        numTotalTests: MATERIALIZATION_TEST_COUNT + 1,
        numPassedTests: MATERIALIZATION_TEST_COUNT + 1,
        testResults: [{ ...file, assertionResults: [...assertions, assertions[0]] }]
      };
    }],
    ["skipped assertion", (report: MaterializationRunReport) => {
      const file = (report.testResults as Array<Record<string, unknown>>)[0];
      const assertions = file.assertionResults as TestAssertion[];
      return {
        ...report,
        numPassedTests: MATERIALIZATION_TEST_COUNT - 1,
        numPendingTests: 1,
        testResults: [{
          ...file,
          assertionResults: assertions.map((assertion, index) => index === 0 ? { ...assertion, status: "skipped" } : assertion)
        }]
      };
    }],
    ["duplicate assertion identity", (report: MaterializationRunReport) => {
      const file = (report.testResults as Array<Record<string, unknown>>)[0];
      const assertions = file.assertionResults as TestAssertion[];
      return {
        ...report,
        testResults: [{
          ...file,
          assertionResults: assertions.map((assertion, index) =>
            index === 0 ? { ...assertion, fullName: assertions[1].fullName } : assertion
          )
        }]
      };
    }],
    ["different file", (report: MaterializationRunReport) => {
      const file = (report.testResults as Array<Record<string, unknown>>)[0];
      return { ...report, testResults: [{ ...file, name: path.resolve("tests/other.test.ts") }] };
    }]
  ])("rejects a %s report", (_label, mutate) => {
    const cases = collectedCases();
    const expected = validateMaterializationCollection(cases, process.cwd());

    expect(() => validateMaterializationRunReport(
      mutate(reportFor(cases, process.cwd())),
      { exitCode: 0, signal: null, stdout: "", stderr: "" },
      expected,
      process.cwd()
    )).toThrow("materialization_acceptance_report_invalid");
  });

  it("runs one full serial file after collection instead of one Vitest process per case", async () => {
    const cases = collectedCases();
    const { spawnImpl, calls } = spawnQueue([
      { stdout: JSON.stringify(cases) },
      { stdout: JSON.stringify(reportFor(cases, process.cwd())) }
    ]);
    const signalSource = new EventEmitter();

    await runUploadWorkspaceMaterializationAcceptance({
      cwd: process.cwd(),
      platform: "linux",
      signalSource,
      spawnImpl
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("list");
    expect(calls[0].args).toContain(MATERIALIZATION_TEST_PATH);
    expect(calls[0].args).toContain("serial");
    expect(calls[1].args).toContain("run");
    expect(calls[1].args).toContain(MATERIALIZATION_TEST_PATH);
    expect(calls[1].args).toContain("serial");
    expect(calls[1].args).not.toContain("--testNamePattern");
    expect(calls.map((call) => call.detached)).toEqual([true, true]);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("rejects an apparently successful report from a failed Vitest process", async () => {
    const cases = collectedCases();
    const { spawnImpl } = spawnQueue([
      { stdout: JSON.stringify(cases) },
      { stdout: JSON.stringify(reportFor(cases, process.cwd())), exitCode: 1 }
    ]);
    const signalSource = new EventEmitter();

    await expect(runUploadWorkspaceMaterializationAcceptance({
      cwd: process.cwd(),
      platform: "linux",
      signalSource,
      spawnImpl
    })).rejects.toMatchObject({ code: "materialization_acceptance_run_failed" });
  });

  it("cancels the owned full-file process and removes signal handlers", async () => {
    const cases = collectedCases();
    const signalSource = new EventEmitter();
    const calls: string[][] = [];
    let releaseRunProcess: (() => void) | undefined;
    const runProcessStarted = new Promise<void>((resolve) => {
      releaseRunProcess = resolve;
    });
    const runChild: { current: ReturnType<typeof heldChildProcess> | null } = {
      current: null
    };
    const spawnImpl: AcceptanceSpawn = (_command, args) => {
      calls.push(args);
      if (calls.length === 1) {
        return fakeChildProcess(JSON.stringify(cases)) as unknown as ReturnType<AcceptanceSpawn>;
      }
      runChild.current = heldChildProcess();
      releaseRunProcess?.();
      return runChild.current as unknown as ReturnType<AcceptanceSpawn>;
    };

    const pending = runUploadWorkspaceMaterializationAcceptance({
      cwd: process.cwd(),
      platform: "linux",
      signalSource,
      spawnImpl
    });
    await runProcessStarted;
    signalSource.emit("SIGTERM");

    await expect(pending).rejects.toMatchObject({
      code: "materialization_acceptance_cancelled",
      exitCode: 143
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("run");
    expect(calls[1]).not.toContain("--testNamePattern");
    expect(runChild.current?.killSignals).toEqual(["SIGTERM"]);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("observes cancellation raised while the child is being spawned", async () => {
    const cases = collectedCases();
    const signalSource = new EventEmitter();
    const calls: string[][] = [];
    let collectionChild: ReturnType<typeof fakeChildProcess> | undefined;
    const spawnImpl: AcceptanceSpawn = (_command, args) => {
      calls.push(args);
      collectionChild = fakeChildProcess(JSON.stringify(cases));
      signalSource.emit("SIGINT");
      return collectionChild as unknown as ReturnType<AcceptanceSpawn>;
    };

    await expect(runUploadWorkspaceMaterializationAcceptance({
      cwd: process.cwd(),
      platform: "linux",
      signalSource,
      spawnImpl
    })).rejects.toMatchObject({
      code: "materialization_acceptance_cancelled",
      exitCode: 130
    });

    expect(calls).toHaveLength(1);
    expect(collectionChild?.killSignals).toEqual(["SIGTERM"]);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("kills the owned crash group before disconnecting IPC and waits for its real exit", async () => {
    const events: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      connected: boolean;
      disconnect: () => void;
    };
    child.connected = true;
    child.disconnect = () => {
      events.push("disconnect");
      child.connected = false;
    };
    const exited = new Promise<CrashChildExit>((resolve) => {
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve([code, signal]);
      });
    });
    const termination = terminateOwnedCrashChild(child, () => {
      events.push("SIGKILL-owned-group");
      setImmediate(() => child.emit("exit", null, "SIGKILL"));
    }, exited);

    await expect(termination).resolves.toEqual([null, "SIGKILL"]);
    expect(events).toEqual(["SIGKILL-owned-group", "disconnect"]);
  });

  it("exits an owned crash fixture when its parent IPC channel disappears", () => {
    const owner = new EventEmitter();
    const exit = vi.fn();
    exitCrashChildWhenOwnerDisconnects(owner, exit);

    owner.emit("disconnect");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("sanitizes captured diagnostics when the full-file report fails", async () => {
    const cases = collectedCases();
    const report = reportFor(cases, process.cwd());
    report.success = false;
    report.numPassedTests = MATERIALIZATION_TEST_COUNT - 1;
    report.numFailedTests = 1;
    const file = (report.testResults as Array<Record<string, unknown>>)[0];
    const assertions = file.assertionResults as TestAssertion[];
    file.assertionResults = assertions.map((assertion, index) =>
      index === 0 ? { ...assertion, status: "failed" } : assertion
    );

    const authorizationScheme = ["Be", "arer"].join("");
    const syntheticCredential = ["synthetic", "test", "token", "value"].join("-");
    const { spawnImpl } = spawnQueue([
      { stdout: JSON.stringify(cases) },
      {
        stdout: JSON.stringify(report),
        stderr: `Authorization: ${authorizationScheme} ${syntheticCredential}\n`
      }
    ]);
    const signalSource = new EventEmitter();

    let failure: unknown;
    try {
      await runUploadWorkspaceMaterializationAcceptance({
        cwd: process.cwd(),
        platform: "linux",
        signalSource,
        spawnImpl
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "materialization_acceptance_report_invalid" });
    const diagnostic = String((failure as { sanitizedDiagnostic?: unknown } | undefined)?.sanitizedDiagnostic ?? "");
    expect(diagnostic).toContain("numFailedTests=1");
    expect(diagnostic).not.toContain(syntheticCredential);
  });
});
