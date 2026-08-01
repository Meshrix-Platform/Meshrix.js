import { spawn } from "node:child_process";
import os from "node:os";

const DEFAULT_MAX_BUFFER_BYTES: any = 4 * 1024 * 1024;

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function commandId(command: Record<string, any> = {}) : any {
  return String(command.id || "").trim();
}

class CappedTextBuffer {
  byteLength: any;
  chunks: any;
  maxBytes: any;
  constructor(maxBytes: any = DEFAULT_MAX_BUFFER_BYTES) {
    this.maxBytes = normalizedPositiveInteger(maxBytes, DEFAULT_MAX_BUFFER_BYTES);
    this.chunks = [];
    this.byteLength = 0;
  }

  append(value: any = "") : any {
    let chunk: any = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    if (chunk.byteLength >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.byteLength - this.maxBytes)];
      this.byteLength = this.maxBytes;
      return;
    }
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    while (this.byteLength > this.maxBytes && this.chunks.length > 0) {
      const overflow: any = this.byteLength - this.maxBytes;
      const first: any = this.chunks[0];
      if (first.byteLength <= overflow) {
        this.chunks.shift();
        this.byteLength -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.byteLength -= overflow;
      }
    }
  }

  text() : any {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }
}

function normalizedPositiveInteger(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsed));
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(asArray(values).map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function releaseCommandLocks(command: Record<string, any> = {}) : any {
  const locks: any = uniqueStrings(command.resourceLocks);
  if (command.exclusive === true) {
    locks.push("__release_dag_exclusive__");
  }
  return uniqueStrings(locks);
}

function releaseCommandBlockedExitCodes(command: Record<string, any> = {}) : any {
  return [...new Set<any>(asArray(command.blockedExitCodes)
    .map(Number)
    .filter((value?: any) : any => Number.isInteger(value) && value === 2))];
}

export function createReleaseCommandDeadlockDiagnostic({
  completedCommandIds = [],
  heldLocks = [],
  lockLastOwners = {},
  pendingCommands = [],
  runningCommands = []
}: Record<string, any> = {}) : any {
  const completed: any = new Set<any>(uniqueStrings(completedCommandIds));
  const held: any = new Set<any>(uniqueStrings(heldLocks));
  const runningLockOwner: any = new Map<any, any>();
  const normalizedRunning: any = asArray(runningCommands).map((entry: Record<string, any> = {}) : any => {
    const id: any = commandId(entry);
    const locks: any = releaseCommandLocks(entry);
    for (const lock of locks) {
      runningLockOwner.set(lock, id);
    }
    return { id, locks };
  });
  const lastOwner: any = lockLastOwners instanceof Map
    ? lockLastOwners
    : new Map<any, any>((Object.entries(lockLastOwners || {}) as [string, any][]));
  const pending: any = asArray(pendingCommands).map((command: Record<string, any> = {}) : any => {
    const id: any = commandId(command);
    const neededLocks: any = releaseCommandLocks(command);
    const waitingOnLocks: any = neededLocks
      .filter((lock?: any) : any => held.has(lock))
      .map((lock?: any) : any => ({
        lock,
        owner: runningLockOwner.get(lock) || lastOwner.get(lock) || "unknown"
      }));
    const waitingOnDependencies: any = uniqueStrings(command.dependsOn)
      .filter((dependencyId?: any) : any => !completed.has(dependencyId));
    return { id, neededLocks, waitingOnDependencies, waitingOnLocks };
  });
  return {
    code: "release-command-dag-deadlock",
    pending,
    running: normalizedRunning,
    heldLocks: [...held]
  };
}

function formatReleaseCommandDeadlock(diagnostic?: any) : any {
  const pending: any = diagnostic.pending.map((entry?: any) : any => {
    const parts: any[] = [];
    if (entry.waitingOnDependencies.length > 0) {
      parts.push(`waiting-on-deps:[${entry.waitingOnDependencies.join(",")}]`);
    }
    if (entry.waitingOnLocks.length > 0) {
      parts.push(`waiting-on-locks:[${entry.waitingOnLocks.map(({ lock, owner }: Record<string, any>) : any => `${lock}(held-by:${owner})`).join(",")}]`);
    }
    return `${entry.id}{needs-locks:[${entry.neededLocks.join(",")}]${parts.length > 0 ? ` ${parts.join(" ")}` : ""}}`;
  });
  const running: any = diagnostic.running
    .map((entry?: any) : any => `${entry.id}{holds-locks:[${entry.locks.join(",")}]}`);
  return `Release command DAG deadlock — no progress possible. ` +
    `pending=${pending.join("; ")} | ` +
    `running=[${running.join(", ")}] | ` +
    `heldLocks=[${diagnostic.heldLocks.join(",")}]`;
}

export function createReleaseCommandSchedule(commands: any = []) : any {
  const ids: any = new Set<any>();
  const duplicateIds: any[] = [];
  const missingDependencyFindings: any[] = [];
  const selfDependencyFindings: any[] = [];
  const duplicateReportFindings: any[] = [];
  const reportOwner: any = new Map<any, any>();
  const layerCounts: any = new Map<any, any>();
  const lockCounts: any = new Map<any, any>();

  for (const command of commands) {
    const id: any = commandId(command);
    if (!id) {
      duplicateIds.push("(missing-id)");
      continue;
    }
    if (ids.has(id)) {
      duplicateIds.push(id);
    }
    ids.add(id);
    const layer: any = String(command.layer || "default");
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
    for (const lock of uniqueStrings(command.resourceLocks)) {
      lockCounts.set(lock, (lockCounts.get(lock) || 0) + 1);
    }
    for (const report of uniqueStrings([
      command.report,
      ...(command.ownedReports || [])
    ])) {
      const previousOwner: any = reportOwner.get(report);
      if (previousOwner) {
        duplicateReportFindings.push(`${previousOwner}:${id}:${report}`);
      } else {
        reportOwner.set(report, id);
      }
    }
  }

  const visiting: any = new Set<any>();
  const visited: any = new Set<any>();
  const cycleFindings: any[] = [];
  const byId: any = new Map<any, any>(commands.map((command?: any) : any => [commandId(command), command]));

  function visit(id?: any, stack: any = []) : any {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      cycleFindings.push([...stack, id].join("->"));
      return;
    }
    visiting.add(id);
    const command: any = byId.get(id);
    for (const dependency of uniqueStrings(command?.dependsOn)) {
      if (dependency === id) {
        selfDependencyFindings.push(id);
      } else if (!byId.has(dependency)) {
        missingDependencyFindings.push(`${id}:${dependency}`);
      } else {
        visit(dependency, [...stack, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const command of commands) {
    visit(commandId(command));
  }

  return {
    mode: "dag-parallel-full-aggregation",
    commandCount: commands.length,
    layerCounts: Object.fromEntries([...layerCounts.entries()].sort(([a]: any[], [b]: any[]) : any => a.localeCompare(b))),
    resourceLockCounts: Object.fromEntries([...lockCounts.entries()].sort(([a]: any[], [b]: any[]) : any => a.localeCompare(b))),
    commandIds: commands.map(commandId),
    duplicateIds,
    duplicateReportFindings,
    missingDependencyFindings,
    selfDependencyFindings,
    cycleFindings,
    valid: duplicateIds.length === 0 &&
      duplicateReportFindings.length === 0 &&
      missingDependencyFindings.length === 0 &&
      selfDependencyFindings.length === 0 &&
      cycleFindings.length === 0
  };
}

export function defaultReleaseCommandParallelism(env: any = process.env) : any {
  const fallback: any = Math.min(4, Math.max(2, os.availableParallelism?.() || os.cpus().length || 2));
  return normalizedPositiveInteger(
    env.MESHRIX_RELEASE_PARALLELISM || env.MESHRIX_PRIVATE_E2E_PARALLELISM,
    fallback
  );
}

function releaseCommandTimeoutMs(command?: any, defaultTimeoutMs?: any, env: any = process.env) : any {
  return Math.max(
    1,
    Number(command.timeoutMs || env.MESHRIX_RELEASE_COMMAND_TIMEOUT_MS || defaultTimeoutMs) ||
      Number(defaultTimeoutMs || 1)
  );
}

export function estimateReleaseCommandWorstCaseMs(commands: any = [], options: Record<string, any> = {}) : any {
  const schedule: any = createReleaseCommandSchedule(commands);
  if (!schedule.valid) {
    throw new Error("Cannot estimate an invalid release command DAG.");
  }
  const env: any = options.env || {};
  const maxParallel: any = normalizedPositiveInteger(
    options.maxParallel,
    defaultReleaseCommandParallelism(env)
  );
  const idOrder: any = new Map<any, any>(commands.map((command?: any, index?: any) : any => [commandId(command), index]));
  const pending: any = new Map<any, any>(commands.map((command?: any) : any => [commandId(command), command]));
  const running: any = new Map<any, any>();
  const completed: any = new Set<any>();
  const heldLocks: any = new Set<any>();
  let elapsedMs: any = 0;

  function dependenciesSatisfied(command: Record<string, any> = {}) : any {
    return uniqueStrings(command.dependsOn).every((dependency?: any) : any => completed.has(dependency));
  }

  function locksAvailable(command: Record<string, any> = {}) : any {
    const locks: any = releaseCommandLocks(command);
    if (locks.includes("__release_dag_exclusive__") && running.size > 0) return false;
    if (heldLocks.has("__release_dag_exclusive__")) return false;
    return locks.every((lock?: any) : any => !heldLocks.has(lock));
  }

  while (completed.size < commands.length) {
    const startable: any = [...pending.values()]
      .filter((command?: any) : any => dependenciesSatisfied(command) && locksAvailable(command))
      .sort((left?: any, right?: any) : any => (idOrder.get(commandId(left)) || 0) - (idOrder.get(commandId(right)) || 0));
    for (const command of startable) {
      if (running.size >= maxParallel) break;
      if (!locksAvailable(command)) continue;
      const id: any = commandId(command);
      pending.delete(id);
      const locks: any = releaseCommandLocks(command);
      for (const lock of locks) heldLocks.add(lock);
      running.set(id, {
        finishesAtMs: elapsedMs + releaseCommandTimeoutMs(command, options.defaultTimeoutMs, env),
        locks
      });
    }
    if (running.size === 0) {
      throw new Error("Cannot estimate a release command DAG that makes no progress.");
    }
    const [finishedId, finished] = [...running.entries()].sort((left?: any, right?: any) : any =>
      left[1].finishesAtMs - right[1].finishesAtMs ||
      (idOrder.get(left[0]) || 0) - (idOrder.get(right[0]) || 0)
    )[0];
    elapsedMs = finished.finishesAtMs;
    running.delete(finishedId);
    for (const lock of finished.locks) heldLocks.delete(lock);
    completed.add(finishedId);
  }

  return Object.freeze({
    commandCount: commands.length,
    maxParallel,
    timeoutMs: elapsedMs
  });
}

export async function runReleaseCommandDag({
  beforeStart = async () : Promise<any> => {},
  commands = [],
  defaultTimeoutMs,
  env = process.env,
  logPrefix = "release-dag",
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  maxParallel = defaultReleaseCommandParallelism(env),
  redactTail = (value: any = "") : any => String(value || "").slice(-2400),
  repoRoot,
  resolveCommand
}: Record<string, any>) : Promise<any> {
  const schedule: any = createReleaseCommandSchedule(commands);
  if (!schedule.valid) {
    throw new Error(`Invalid release command DAG: ${JSON.stringify({
      duplicateIds: schedule.duplicateIds,
      duplicateReportFindings: schedule.duplicateReportFindings,
      missingDependencyFindings: schedule.missingDependencyFindings,
      selfDependencyFindings: schedule.selfDependencyFindings,
      cycleFindings: schedule.cycleFindings
    })}`);
  }
  if (typeof resolveCommand !== "function") {
    throw new Error("runReleaseCommandDag requires resolveCommand(command)");
  }

  const idOrder: any = new Map<any, any>(commands.map((command?: any, index?: any) : any => [commandId(command), index]));
  const pending: any = new Map<any, any>(commands.map((command?: any) : any => [commandId(command), command]));
  const running: any = new Map<any, any>();
  const completed: any = new Map<any, any>();
  const heldLocks: any = new Set<any>();
  const lockLastOwner: any = new Map<any, any>();
  const effectiveMaxParallel: any = normalizedPositiveInteger(maxParallel, 1);

  function locksFor(command: Record<string, any> = {}) : any {
    return releaseCommandLocks(command);
  }

  function dependenciesSatisfied(command: Record<string, any> = {}) : any {
    return uniqueStrings(command.dependsOn).every((dependency?: any) : any => completed.has(dependency));
  }

  function nonPassingDependencies(command: Record<string, any> = {}) : any {
    return uniqueStrings(command.dependsOn).filter((dependency?: any) : any => {
      const result: any = completed.get(dependency);
      return result && result.status !== "passed";
    });
  }

  function locksAvailable(command: Record<string, any> = {}) : any {
    const locks: any = locksFor(command);
    if (locks.includes("__release_dag_exclusive__") && running.size > 0) {
      return false;
    }
    if (heldLocks.has("__release_dag_exclusive__")) {
      return false;
    }
    return locks.every((lock?: any) : any => !heldLocks.has(lock));
  }

  function startableCommands() : any {
    return [...pending.values()]
      .filter((command?: any) : any => dependenciesSatisfied(command) && nonPassingDependencies(command).length === 0 && locksAvailable(command))
      .sort((a?: any, b?: any) : any => (idOrder.get(commandId(a)) || 0) - (idOrder.get(commandId(b)) || 0));
  }

  function dependencyResult(command: Record<string, any> = {}, dependencyIds: any = []) : any {
    const blocked: any = dependencyIds.length > 0 && dependencyIds.every((dependencyId?: any) : any =>
      completed.get(dependencyId)?.status === "blocked"
    );
    const dependencyResults: any = dependencyIds.map((dependencyId?: any) : any => completed.get(dependencyId));
    return {
      id: commandId(command),
      label: command.label,
      command: "",
      report: command.report || "",
      covers: command.covers,
      layer: command.layer || "",
      parallelGroup: command.parallelGroup || command.layer || "",
      dependsOn: uniqueStrings(command.dependsOn),
      resourceLocks: uniqueStrings(command.resourceLocks),
      blockedExitCodes: releaseCommandBlockedExitCodes(command),
      exclusive: command.exclusive === true,
      status: blocked ? "blocked" : "skipped",
      exitCode: blocked ? 2 : 1,
      signal: "",
      timedOut: false,
      timeoutMs: 0,
      durationMs: 0,
      startedAt: "",
      finishedAt: new Date().toISOString(),
      reasonChain: dependencyResults.flatMap((result?: any) : any => [
        `dependency:${result?.id || "unknown"}:${result?.status || "missing"}`,
        ...(result?.reasonChain || [])
      ]),
      ownerChain: uniqueStrings([
        commandId(command),
        ...dependencyResults.flatMap((result?: any) : any => result?.ownerChain || [result?.id])
      ]),
      errorTail: blocked
        ? `Blocked because dependency command(s) are blocked: ${dependencyIds.join(", ")}`
        : `Skipped because dependency command(s) did not pass: ${dependencyIds.join(", ")}`
    };
  }

  async function runOne(command?: any) : Promise<any> {
    const id: any = commandId(command);
    const startedAt: any = new Date();
    const startedMs: any = Date.now();
    const timeoutMs: any = releaseCommandTimeoutMs(command, defaultTimeoutMs, env);
    const metadata: Record<string, any> = {
      id,
      label: command.label,
      command: "",
      report: command.report || "",
      covers: command.covers,
      layer: command.layer || "",
      parallelGroup: command.parallelGroup || command.layer || "",
      dependsOn: uniqueStrings(command.dependsOn),
      resourceLocks: uniqueStrings(command.resourceLocks),
      blockedExitCodes: releaseCommandBlockedExitCodes(command),
      exclusive: command.exclusive === true,
      startedAt: startedAt.toISOString(),
      ownerChain: [id]
    };

    try {
      await beforeStart(command);
    } catch (error: any) {
      return {
        ...metadata,
        command: "",
        status: "failed",
        exitCode: 1,
        signal: "",
        timedOut: false,
        timeoutMs,
        durationMs: Date.now() - startedMs,
        finishedAt: new Date().toISOString(),
        errorTail: redactTail(error?.message || error),
        reasonChain: ["before-start-failed"]
      };
    }

    const resolved: any = resolveCommand(command);
    const executable: any = resolved.executable || resolved.command;
    const args: any = asArray(resolved.args);
    const displayCommand: any = resolved.displayCommand || [resolved.command || executable, ...args].join(" ");
    metadata.command = displayCommand;
    console.log(`[${logPrefix}] RUN ${id} layer=${metadata.layer || "default"}`);

    return await new Promise((resolve?: any) : any => {
      const stdout: any = new CappedTextBuffer(maxBufferBytes);
      const stderr: any = new CappedTextBuffer(maxBufferBytes);
      let processError: any = null;
      let timedOut: any = false;
      let killTimer: any = null;
      let settled: any = false;
      const useProcessGroup: any = process.platform !== "win32";
      const terminate: any = (signal?: any) : any => {
        try {
          if (useProcessGroup && child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          try {
            child.kill(signal);
          } catch {
            // The process may already be gone.
          }
        }
      };
      const finish: any = ({ code = 1, signal = "" }: Record<string, any> = {}) : any => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        const durationMs: any = Date.now() - startedMs;
        const passed: any = code === 0 && timedOut === false;
        const blocked: any = !passed && timedOut === false && metadata.blockedExitCodes.includes(code);
        const status: any = passed ? "passed" : blocked ? "blocked" : "failed";
        console.log(`[${logPrefix}] ${passed ? "OK" : blocked ? "BLOCKED" : "FAIL"} ${id} (${durationMs}ms${timedOut ? ", timed out" : ""})`);
        resolve({
          ...metadata,
          status,
          exitCode: timedOut ? 124 : code,
          signal: signal || "",
          timedOut,
          timeoutMs,
          durationMs,
          finishedAt: new Date().toISOString(),
          reasonChain: passed
            ? []
            : [timedOut ? "command-timeout" : blocked ? `command-blocked-exit:${code}` : `command-failed-exit:${code}`],
          errorTail: passed ? "" : redactTail(`${processError?.message || ""}\n${stderr.text()}\n${stdout.text()}`)
        });
      };
      const child: any = spawn(executable, args, {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: useProcessGroup,
        windowsHide: true
      });
      const timer: any = setTimeout(() : any => {
        timedOut = true;
        terminate("SIGTERM");
        killTimer = setTimeout(() : any => {
          terminate("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: 124, signal: "SIGKILL" });
        }, 5000);
      }, timeoutMs);
      child.stdout?.on("data", (chunk?: any) : any => {
        stdout.append(chunk);
      });
      child.stderr?.on("data", (chunk?: any) : any => {
        stderr.append(chunk);
      });
      child.on("error", (error?: any) : any => {
        processError = error;
      });
      child.on("close", (code?: any, signal?: any) : any => {
        finish({ code: Number(code ?? 1), signal });
      });
    });
  }

  while (completed.size < commands.length) {
    let progressed: any = false;
    for (const command of [...pending.values()]) {
      if (!dependenciesSatisfied(command)) {
        continue;
      }
      const dependencyFailures: any = nonPassingDependencies(command);
      if (dependencyFailures.length === 0) {
        continue;
      }
      const id: any = commandId(command);
      pending.delete(id);
      const result: any = dependencyResult(command, dependencyFailures);
      completed.set(id, result);
      progressed = true;
      console.log(`[${logPrefix}] ${result.status === "blocked" ? "BLOCKED" : "SKIP"} ${id} dependency=${dependencyFailures.join(",")}`);
    }

    for (const command of startableCommands()) {
      if (running.size >= effectiveMaxParallel) {
        break;
      }
      if (!locksAvailable(command)) {
        continue;
      }
      const id: any = commandId(command);
      pending.delete(id);
      const locks: any = locksFor(command);
      for (const lock of locks) {
        heldLocks.add(lock);
        lockLastOwner.set(lock, id);
      }
      const promise: any = runOne(command).then((result?: any) : any => ({ id, result, locks }));
      running.set(id, { promise, locks });
      progressed = true;
    }

    if (running.size === 0) {
      if (progressed) {
        continue;
      }
      const diagnostic: any = createReleaseCommandDeadlockDiagnostic({
        completedCommandIds: [...completed.keys()],
        heldLocks: [...heldLocks],
        lockLastOwners: lockLastOwner,
        pendingCommands: [...pending.values()],
        runningCommands: [...running.entries()].map(([id, entry]: any[]) : any => ({
          id,
          resourceLocks: entry.locks.filter((lock?: any) : any => lock !== "__release_dag_exclusive__"),
          exclusive: entry.locks.includes("__release_dag_exclusive__")
        }))
      });
      const error: Error & Record<string, any> = new Error(formatReleaseCommandDeadlock(diagnostic));
      error.code = diagnostic.code;
      error.diagnostic = diagnostic;
      throw error;
    }

    const { id, result, locks } = await Promise.race([...running.values()].map((entry?: any) : any => entry.promise));
    running.delete(id);
    for (const lock of locks) {
      heldLocks.delete(lock);
    }
    completed.set(id, result);
  }

  const results: any = commands.map((command?: any) : any => completed.get(commandId(command)));
  return {
    results,
    schedule: {
      ...schedule,
      maxParallel: effectiveMaxParallel,
      executedCommandCount: results.length,
      allCommandsExecuted: results.length === commands.length
    }
  };
}
