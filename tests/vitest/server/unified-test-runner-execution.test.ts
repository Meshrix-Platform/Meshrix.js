import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  profileInherits,
  resolveExecutionTimeout,
  runSuiteProcess,
  timeoutMsForSuite
} from "../../lib/unified-test-runner-execution.ts";

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
