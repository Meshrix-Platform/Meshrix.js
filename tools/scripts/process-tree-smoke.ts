import { fork, type ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectManagedProcess, stopManagedProcesses } from "./lib/process-lifecycle.ts";
import { terminatePlatformProcessTree } from "./lib/startup-platform-adapter.ts";

const fixtureMode = process.argv[2];

function keepAlive(): void {
  setInterval(() => undefined, 1_000);
}

function waitForFixtureMessage(child: ChildProcess): Promise<{ type?: string; leafPid?: number }> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message && typeof message === "object" ? message as { type?: string; leafPid?: number } : {});
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("fixture_start_failed"));
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("fixture_exited_before_ready"));
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

if (fixtureMode === "--fixture-parent") {
  const leaf = fork(fileURLToPath(import.meta.url), ["--fixture-leaf"], {
    execArgv: process.execArgv,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  leaf.once("spawn", () => {
    if (process.send && leaf.pid) process.send({ type: "ready", leafPid: leaf.pid });
  });
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  keepAlive();
} else if (fixtureMode === "--fixture-leaf") {
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  keepAlive();
} else {
  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function waitUntilExited(pids: readonly number[], attempts: number): Promise<number[]> {
    let remaining = [...pids];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      remaining = remaining.filter((pid) => {
        const state = inspectManagedProcess(pid);
        return state === "alive" || state === "permission-denied";
      });
      if (remaining.length === 0) return remaining;
      await wait(200);
    }
    return remaining;
  }

  async function runWindowsProcessTreeSmoke(): Promise<void> {
    if (process.platform !== "win32") {
      console.log("startup_process_tree_smoke=not_run; reason=windows_adapter_only");
      return;
    }

    let parent: ChildProcess | undefined;
    let leafPid: number | undefined;
    let stage = "fixture_start";
    let reason = "none";
    let gracefulTaskkill = "not_attempted";
    let gracefulExit = "unknown";
    let forceFallback = false;
    let fixtureReady = false;
    let fixtureProcessCount = 0;
    let cleaned = false;
    let remainingCount = 0;
    try {
      parent = fork(fileURLToPath(import.meta.url), ["--fixture-parent"], {
        execArgv: process.execArgv,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      fixtureProcessCount = Number.isSafeInteger(parent.pid) ? 1 : 0;
      const ready = await waitForFixtureMessage(parent);
      leafPid = ready?.type === "ready" && Number.isSafeInteger(ready.leafPid) ? ready.leafPid : undefined;
      if (!parent.pid || !leafPid) throw new Error("fixture_start_failed");
      fixtureReady = true;
      fixtureProcessCount = 2;

      stage = "production_tree_stop";
      const stopResult = await stopManagedProcesses([parent.pid], {
        signalTree: (pid, signal) => terminatePlatformProcessTree(pid, signal),
      });
      gracefulTaskkill = stopResult.gracefulFailed.length > 0 ? "nonzero" : "zero";
      forceFallback = stopResult.forceSignalled.length > 0;
      stage = "tree_verification";
      let remaining = await waitUntilExited([parent.pid, leafPid], 25);
      gracefulExit = remaining.length === 0 && !forceFallback ? "completed" : "force_required";

      if (remaining.length > 0) {
        stage = "owned_fixture_fallback_cleanup";
        forceFallback = true;
        for (const pid of remaining) terminatePlatformProcessTree(pid, "SIGKILL");
        remaining = await waitUntilExited(remaining, 25);
      }
      remainingCount = remaining.length;
      cleaned = remainingCount === 0;
    } catch (error) {
      reason = error instanceof Error
        ? ["fixture_start_failed", "fixture_exited_before_ready", "startup_platform_command_failed", "startup_process_tree_termination_failed", "managed_process_force_termination_failed"].includes(error.message)
          ? error.message
          : "unexpected_fixture_error"
        : "unexpected_fixture_error";
    } finally {
      const ownedPids = [parent?.pid, leafPid].filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0);
      for (const pid of ownedPids) {
        if (inspectManagedProcess(pid) === "alive") {
          forceFallback = true;
          try {
            terminatePlatformProcessTree(pid, "SIGKILL");
          } catch {
            reason = reason === "none" ? "final_fixture_cleanup_failed" : reason;
          }
        }
      }
      try {
        remainingCount = (await waitUntilExited(ownedPids, 25)).length;
        cleaned = fixtureReady && remainingCount === 0;
      } catch {
        reason = reason === "none" ? "fixture_cleanup_verification_failed" : reason;
        remainingCount = ownedPids.length;
        cleaned = false;
      }
    }

    const passed = cleaned && reason === "none";
    console.log(`startup_process_tree_smoke=${passed ? "passed" : "failed"}; stage=${stage}; reason=${reason}; graceful_taskkill=${gracefulTaskkill}; graceful_exit=${gracefulExit}; force_fallback=${forceFallback ? "used" : "not_needed"}; fixture_ready=${fixtureReady ? "true" : "false"}; fixture_processes=${fixtureProcessCount}; remaining_processes=${remainingCount}; tree_cleaned=${cleaned ? "true" : "false"}`);
    if (!passed) process.exitCode = 1;
  }

  void runWindowsProcessTreeSmoke().catch(() => {
    console.log("startup_process_tree_smoke=failed; stage=fixture_cleanup; reason=unexpected_fixture_error; fixture_processes=2; tree_cleaned=unknown");
    process.exitCode = 1;
  });
}
