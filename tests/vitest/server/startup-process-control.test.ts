import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  forwardSignalToChild,
  inspectManagedProcess,
  signalManagedProcess,
  stopManagedProcesses,
} from "../../../tools/scripts/lib/process-lifecycle.ts";
import {
  launchAgentCleanupArguments,
  listPlatformPortListeners,
  listPlatformProcesses,
  terminatePlatformProcessTree,
  type PlatformCommandResult,
} from "../../../tools/scripts/lib/startup-platform-adapter.ts";
import { isMeshrixServiceProcessOwned } from "../../../tools/scripts/lib/service-process-ownership.ts";
import { stopPids } from "../../../tools/scripts/clean-existing-service.ts";

const projectRootFixture = path.posix.join("/fixture", "meshrix", "project");
const dataDirectoryFixture = path.posix.join("/fixture", "meshrix", "data");
const foreignProjectFixture = path.posix.join("/fixture", "other-project");
const unrelatedProjectFixture = `${projectRootFixture}-unrelated`;
const windowsProjectFixture = path.win32.join("Q:\\", "meshrix-fixture", "project");
const windowsDataFixture = path.win32.join("Q:\\", "meshrix-fixture", "data");
const windowsHomeFixture = path.win32.join("Q:\\", "fixture-home");

function processError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("owned process lifecycle", () => {
  it.skipIf(process.platform === "win32")("lets the cleanup entry finish an actual child's graceful shutdown", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(17)); process.send('ready'); setInterval(() => undefined, 1000)"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      await stopPids([child.pid!], { quiet: true });
      expect(await exited).toEqual([17, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("probes only a positive safe PID and handles invalid and self targets without signaling", () => {
    const kill = vi.fn();

    expect(inspectManagedProcess(42, { selfPid: 8, kill })).toBe("alive");
    expect(inspectManagedProcess(0, { selfPid: 8, kill })).toBe("invalid");
    expect(inspectManagedProcess(-1, { selfPid: 8, kill })).toBe("invalid");
    expect(inspectManagedProcess(Number.MAX_SAFE_INTEGER + 1, { selfPid: 8, kill })).toBe("invalid");
    expect(inspectManagedProcess(8, { selfPid: 8, kill })).toBe("self");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(42, 0);
  });

  it("distinguishes an exited process from one that denies access", () => {
    expect(inspectManagedProcess(42, { selfPid: 8, kill: () => { throw processError("ESRCH"); } })).toBe("exited");
    expect(inspectManagedProcess(42, { selfPid: 8, kill: () => { throw processError("EPERM"); } })).toBe("permission-denied");
    expect(signalManagedProcess(42, "SIGTERM", { selfPid: 8, kill: () => { throw processError("ESRCH"); } })).toBe("already-exited");
    expect(signalManagedProcess(42, "SIGTERM", { selfPid: 8, kill: () => { throw processError("EPERM"); } })).toBe("permission-denied");
  });

  it("keeps graceful cleanup when the process exits and uses force only when it remains alive", async () => {
    let state: "alive" | "exited" = "alive";
    const signals: NodeJS.Signals[] = [];
    const graceful = await stopManagedProcesses([42], {
      selfPid: 8,
      inspect: () => state,
      signalTree: (_pid, signal) => {
        signals.push(signal);
        state = "exited";
        return "sent";
      },
      wait: async () => undefined,
      gracefulWaitMs: 250,
      pollIntervalMs: 250,
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(graceful.terminated).toEqual([42]);

    state = "alive";
    signals.length = 0;
    const forced = await stopManagedProcesses([42, 42], {
      selfPid: 8,
      inspect: () => state,
      signalTree: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") state = "exited";
        return "sent";
      },
      wait: async () => undefined,
      gracefulWaitMs: 0,
      pollIntervalMs: 1,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(forced.forceSignalled).toEqual([42]);
  });

  it("moves directly to force cleanup when the platform rejects graceful termination", async () => {
    let state: "alive" | "exited" = "alive";
    const signals: NodeJS.Signals[] = [];
    const wait = vi.fn(async () => undefined);
    const result = await stopManagedProcesses([42], {
      selfPid: 8,
      inspect: () => state,
      signalTree: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") state = "exited";
        return signal === "SIGTERM" ? "failed" : "sent";
      },
      wait,
      gracefulWaitMs: 5_000,
      pollIntervalMs: 250,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(wait).not.toHaveBeenCalled();
    expect(result.gracefulFailed).toEqual([42]);
    expect(result.forceSignalled).toEqual([42]);
  });

  it("surfaces a failed force cleanup instead of reporting termination", async () => {
    await expect(stopManagedProcesses([42], {
      selfPid: 8,
      inspect: () => "alive",
      signalTree: () => "failed",
      wait: async () => undefined,
      gracefulWaitMs: 0,
      pollIntervalMs: 1,
    })).rejects.toThrow("managed_process_force_termination_failed");
  });

  it("does not force-signal a process when access is denied", async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await stopManagedProcesses([42], {
      selfPid: 8,
      inspect: () => "permission-denied",
      signalTree: (_pid, signal) => {
        signals.push(signal);
        return "sent";
      },
      wait: async () => undefined,
      gracefulWaitMs: 10,
      pollIntervalMs: 5,
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(result.permissionDenied).toEqual([42]);
    expect(result.forceSignalled).toEqual([]);
  });

  it("forwards a signal to an actual child and observes its exit", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => process.exit(17)); setInterval(() => undefined, 1000)",
    ], { stdio: "ignore", windowsHide: true });
    await once(child, "spawn");

    expect(forwardSignalToChild(child, "SIGTERM")).toBe("sent");
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect(signal === "SIGTERM" || code === 17).toBe(true);
  });
});

describe("startup platform adapters", () => {
  it("uses process-tree taskkill only for a validated owned Windows PID", () => {
    const run = vi.fn((_command: string, _args: readonly string[]): PlatformCommandResult => ({ status: 0, stdout: "" }));
    const result = terminatePlatformProcessTree(42, "SIGTERM", {
      platform: "win32",
      selfPid: 8,
      inspect: () => "alive",
      run,
    });

    expect(result).toBe("sent");
    expect(run).toHaveBeenCalledWith("taskkill.exe", ["/PID", "42", "/T"]);
    expect(terminatePlatformProcessTree(8, "SIGTERM", { platform: "win32", selfPid: 8, run })).toBe("self");
    expect(terminatePlatformProcessTree(0, "SIGTERM", { platform: "win32", selfPid: 8, run })).toBe("invalid");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected graceful taskkill so the lifecycle owner can use force cleanup", () => {
    const run = vi.fn((_command: string, _args: readonly string[]): PlatformCommandResult => ({ status: 1, stdout: "" }));
    expect(terminatePlatformProcessTree(42, "SIGTERM", {
      platform: "win32",
      selfPid: 8,
      inspect: () => "alive",
      run,
    })).toBe("failed");
    expect(run).toHaveBeenCalledWith("taskkill.exe", ["/PID", "42", "/T"]);
  });

  it("uses taskkill force mode only for an explicit force signal", () => {
    const run = vi.fn((_command: string, _args: readonly string[]): PlatformCommandResult => ({ status: 0, stdout: "" }));
    expect(terminatePlatformProcessTree(42, "SIGKILL", {
      platform: "win32",
      selfPid: 8,
      inspect: () => "alive",
      run,
    })).toBe("sent");
    expect(run).toHaveBeenCalledWith("taskkill.exe", ["/PID", "42", "/T", "/F"]);
  });

  it("fails a force taskkill when the owned target remains alive", () => {
    const run = vi.fn((_command: string, _args: readonly string[]): PlatformCommandResult => ({ status: 1, stdout: "" }));
    expect(() => terminatePlatformProcessTree(42, "SIGKILL", {
      platform: "win32",
      selfPid: 8,
      inspect: () => "alive",
      run,
    })).toThrow("startup_process_tree_termination_failed");
  });

  it("selects only the requested port listener PIDs from Windows netstat output", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: [
        "  TCP    0.0.0.0:7228       0.0.0.0:0       LISTENING       314",
        "  TCP    [::]:5173          [::]:0          LISTENING       271",
        "  TCP    127.0.0.1:7228    127.0.0.1:80    ESTABLISHED     314",
      ].join("\n"),
    }));
    expect(listPlatformPortListeners(7228, "win32", run)).toEqual([314]);
    expect(run).toHaveBeenCalledWith("netstat.exe", ["-ano", "-p", "tcp"]);
  });

  it("limits Windows process command-line discovery to the current project and data directory", () => {
    const calls: Array<{ command: string; args: readonly string[]; environment?: NodeJS.ProcessEnv }> = [];
    const run = (command: string, args: readonly string[], environment?: NodeJS.ProcessEnv): PlatformCommandResult => {
      calls.push({ command, args, environment });
      return { status: 0, stdout: JSON.stringify([{ ProcessId: 314, CommandLine: "node start-server.ts" }]) };
    };
    const rows = listPlatformProcesses("win32", run, [windowsProjectFixture, windowsDataFixture]);
    expect(rows).toEqual([{ pid: 314, commandLine: "node start-server.ts" }]);
    expect(calls[0].args.join(" ")).toContain("MESHRIX_PROCESS_DISCOVERY_NEEDLES");
    expect(calls[0].environment?.MESHRIX_PROCESS_DISCOVERY_NEEDLES).toBe(JSON.stringify([windowsProjectFixture, windowsDataFixture]));
    expect(calls[0].args.join(" ")).not.toContain(windowsProjectFixture);
  });

  it("creates LaunchAgent arguments only for macOS", () => {
    const posixHomeFixture = path.posix.join("/fixture", "home");
    expect(launchAgentCleanupArguments("7228", { platform: "win32", homeDirectory: windowsHomeFixture })).toEqual([]);
    expect(launchAgentCleanupArguments("7228", { platform: "linux", homeDirectory: posixHomeFixture })).toEqual([]);
    expect(launchAgentCleanupArguments("7228", { platform: "darwin", homeDirectory: posixHomeFixture })).toEqual([
      "--launch-label", "dev.meshrix.server.7228",
      "--launch-label", "dev.meshrix.background-supervisor",
      "--launch-label", "dev.meshrix.system-inspection",
      "--launch-plist", path.posix.join(posixHomeFixture, "Library", "LaunchAgents", "dev.meshrix.server.7228.plist"),
      "--launch-plist", path.posix.join(posixHomeFixture, "Library", "LaunchAgents", "dev.meshrix.background-supervisor.plist"),
      "--launch-plist", path.posix.join(posixHomeFixture, "Library", "LaunchAgents", "dev.meshrix.system-inspection.plist"),
    ]);
  });
});

describe("service process ownership", () => {
  const context = {
    selfPid: 100,
    projectRoot: projectRootFixture,
    dataDirectory: dataDirectoryFixture,
  };

  it("matches only Meshrix entrypoints that belong to this project or data directory", () => {
    expect(isMeshrixServiceProcessOwned({
      pid: 101,
      commandLine: `node ${projectRootFixture}/tools/server-scripts/start-server.ts`,
    }, context)).toBe(true);
    expect(isMeshrixServiceProcessOwned({
      pid: 102,
      commandLine: `node tools/server-scripts/start-server.ts --data-dir ${dataDirectoryFixture}`,
    }, context)).toBe(true);
    expect(isMeshrixServiceProcessOwned({
      pid: 103,
      commandLine: `node ${foreignProjectFixture}/tools/server-scripts/start-server.ts`,
      workingDirectory: foreignProjectFixture,
    }, context)).toBe(false);
    expect(isMeshrixServiceProcessOwned({
      pid: 104,
      commandLine: `node ${unrelatedProjectFixture}/tools/server-scripts/start-server.ts`,
      workingDirectory: unrelatedProjectFixture,
    }, context)).toBe(false);
    expect(isMeshrixServiceProcessOwned({
      pid: 105,
      commandLine: `node ${foreignProjectFixture}/node_modules/.bin/vite`,
      workingDirectory: foreignProjectFixture,
    }, { ...context, globalClean: true })).toBe(false);
    expect(isMeshrixServiceProcessOwned({
      pid: 100,
      commandLine: `node ${projectRootFixture}/tools/server-scripts/start-server.ts`,
    }, context)).toBe(false);
  });

  it("matches Windows process paths without depending on letter case", () => {
    expect(isMeshrixServiceProcessOwned({
      pid: 106,
      commandLine: `node ${windowsProjectFixture.toUpperCase()}\\tools\\server-scripts\\start-server.ts`,
    }, {
      ...context,
      projectRoot: windowsProjectFixture.toLowerCase(),
      dataDirectory: windowsDataFixture,
      caseInsensitivePaths: true,
    })).toBe(true);
  });
});
