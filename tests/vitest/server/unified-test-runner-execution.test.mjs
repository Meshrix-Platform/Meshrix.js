import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  resolveExecutionTimeout,
  runSuiteProcess,
  timeoutMsForSuite
} from "../../lib/unified-test-runner-execution.mjs";

describe("unified test runner execution budgets", () => {
  it("resolves suite timeout classes and caps them to the remaining profile budget", () => {
    const suiteTimeoutMs = timeoutMsForSuite({ id: "fixture.fast", timeoutClass: "fast" });
    expect(resolveExecutionTimeout({ suiteTimeoutMs })).toEqual({
      timeoutMs: suiteTimeoutMs,
      timeoutScope: "suite"
    });
    expect(resolveExecutionTimeout({ suiteTimeoutMs, profileRemainingMs: 25 })).toEqual({
      timeoutMs: 25,
      timeoutScope: "profile"
    });
  });

  it("terminates an over-budget process with TERM followed by KILL and reports the timeout", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = null;
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        queueMicrotask(() => child.emit("close", null, signal));
      }
      return true;
    });
    const result = await runSuiteProcess({
      id: "fixture.timeout",
      label: "timeout fixture",
      command: "fixture-command",
      args: []
    }, {
      cwd: process.cwd(),
      timeoutMs: 10,
      timeoutScope: "suite",
      terminationGraceMs: 10,
      spawnImpl: () => child
    });

    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.timeoutScope).toBe("suite");
    expect(result.terminationSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
