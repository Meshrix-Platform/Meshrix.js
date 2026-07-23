import { spawn } from "node:child_process";
import os from "node:os";

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function commandId(command = {}) {
  return String(command.id || "").trim();
}

class CappedTextBuffer {
  constructor(maxBytes = DEFAULT_MAX_BUFFER_BYTES) {
    this.maxBytes = normalizedPositiveInteger(maxBytes, DEFAULT_MAX_BUFFER_BYTES);
    this.chunks = [];
    this.byteLength = 0;
  }

  append(value = "") {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    if (chunk.byteLength >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.byteLength - this.maxBytes)];
      this.byteLength = this.maxBytes;
      return;
    }
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    while (this.byteLength > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.byteLength - this.maxBytes;
      const first = this.chunks[0];
      if (first.byteLength <= overflow) {
        this.chunks.shift();
        this.byteLength -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.byteLength -= overflow;
      }
    }
  }

  text() {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }
}

function normalizedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsed));
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function releaseCommandLocks(command = {}) {
  const locks = uniqueStrings(command.resourceLocks);
  if (command.exclusive === true) {
    locks.push("__release_dag_exclusive__");
  }
  return uniqueStrings(locks);
}

function releaseCommandBlockedExitCodes(command = {}) {
  return [...new Set(asArray(command.blockedExitCodes)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value === 2))];
}

export function createReleaseCommandDeadlockDiagnostic({
  completedCommandIds = [],
  heldLocks = [],
  lockLastOwners = {},
  pendingCommands = [],
  runningCommands = []
} = {}) {
  const completed = new Set(uniqueStrings(completedCommandIds));
  const held = new Set(uniqueStrings(heldLocks));
  const runningLockOwner = new Map();
  const normalizedRunning = asArray(runningCommands).map((entry = {}) => {
    const id = commandId(entry);
    const locks = releaseCommandLocks(entry);
    for (const lock of locks) {
      runningLockOwner.set(lock, id);
    }
    return { id, locks };
  });
  const lastOwner = lockLastOwners instanceof Map
    ? lockLastOwners
    : new Map(Object.entries(lockLastOwners || {}));
  const pending = asArray(pendingCommands).map((command = {}) => {
    const id = commandId(command);
    const neededLocks = releaseCommandLocks(command);
    const waitingOnLocks = neededLocks
      .filter((lock) => held.has(lock))
      .map((lock) => ({
        lock,
        owner: runningLockOwner.get(lock) || lastOwner.get(lock) || "unknown"
      }));
    const waitingOnDependencies = uniqueStrings(command.dependsOn)
      .filter((dependencyId) => !completed.has(dependencyId));
    return { id, neededLocks, waitingOnDependencies, waitingOnLocks };
  });
  return {
    code: "release-command-dag-deadlock",
    pending,
    running: normalizedRunning,
    heldLocks: [...held]
  };
}

function formatReleaseCommandDeadlock(diagnostic) {
  const pending = diagnostic.pending.map((entry) => {
    const parts = [];
    if (entry.waitingOnDependencies.length > 0) {
      parts.push(`waiting-on-deps:[${entry.waitingOnDependencies.join(",")}]`);
    }
    if (entry.waitingOnLocks.length > 0) {
      parts.push(`waiting-on-locks:[${entry.waitingOnLocks.map(({ lock, owner }) => `${lock}(held-by:${owner})`).join(",")}]`);
    }
    return `${entry.id}{needs-locks:[${entry.neededLocks.join(",")}]${parts.length > 0 ? ` ${parts.join(" ")}` : ""}}`;
  });
  const running = diagnostic.running
    .map((entry) => `${entry.id}{holds-locks:[${entry.locks.join(",")}]}`);
  return `Release command DAG deadlock — no progress possible. ` +
    `pending=${pending.join("; ")} | ` +
    `running=[${running.join(", ")}] | ` +
    `heldLocks=[${diagnostic.heldLocks.join(",")}]`;
}

export function createReleaseCommandSchedule(commands = []) {
  const ids = new Set();
  const duplicateIds = [];
  const missingDependencyFindings = [];
  const selfDependencyFindings = [];
  const duplicateReportFindings = [];
  const reportOwner = new Map();
  const layerCounts = new Map();
  const lockCounts = new Map();

  for (const command of commands) {
    const id = commandId(command);
    if (!id) {
      duplicateIds.push("(missing-id)");
      continue;
    }
    if (ids.has(id)) {
      duplicateIds.push(id);
    }
    ids.add(id);
    const layer = String(command.layer || "default");
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
    for (const lock of uniqueStrings(command.resourceLocks)) {
      lockCounts.set(lock, (lockCounts.get(lock) || 0) + 1);
    }
    for (const report of uniqueStrings([
      command.report,
      ...(command.ownedReports || [])
    ])) {
      const previousOwner = reportOwner.get(report);
      if (previousOwner) {
        duplicateReportFindings.push(`${previousOwner}:${id}:${report}`);
      } else {
        reportOwner.set(report, id);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const cycleFindings = [];
  const byId = new Map(commands.map((command) => [commandId(command), command]));

  function visit(id, stack = []) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      cycleFindings.push([...stack, id].join("->"));
      return;
    }
    visiting.add(id);
    const command = byId.get(id);
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
    layerCounts: Object.fromEntries([...layerCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    resourceLockCounts: Object.fromEntries([...lockCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
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

export function defaultReleaseCommandParallelism(env = process.env) {
  const fallback = Math.min(4, Math.max(2, os.availableParallelism?.() || os.cpus().length || 2));
  return normalizedPositiveInteger(
    env.LICO_RELEASE_PARALLELISM || env.LICO_PRIVATE_E2E_PARALLELISM,
    fallback
  );
}

function releaseCommandTimeoutMs(command, defaultTimeoutMs, env = process.env) {
  return Math.max(
    1,
    Number(command.timeoutMs || env.LICO_RELEASE_COMMAND_TIMEOUT_MS || defaultTimeoutMs) ||
      Number(defaultTimeoutMs || 1)
  );
}

export function estimateReleaseCommandWorstCaseMs(commands = [], options = {}) {
  const schedule = createReleaseCommandSchedule(commands);
  if (!schedule.valid) {
    throw new Error("Cannot estimate an invalid release command DAG.");
  }
  const env = options.env || {};
  const maxParallel = normalizedPositiveInteger(
    options.maxParallel,
    defaultReleaseCommandParallelism(env)
  );
  const idOrder = new Map(commands.map((command, index) => [commandId(command), index]));
  const pending = new Map(commands.map((command) => [commandId(command), command]));
  const running = new Map();
  const completed = new Set();
  const heldLocks = new Set();
  let elapsedMs = 0;

  function dependenciesSatisfied(command = {}) {
    return uniqueStrings(command.dependsOn).every((dependency) => completed.has(dependency));
  }

  function locksAvailable(command = {}) {
    const locks = releaseCommandLocks(command);
    if (locks.includes("__release_dag_exclusive__") && running.size > 0) return false;
    if (heldLocks.has("__release_dag_exclusive__")) return false;
    return locks.every((lock) => !heldLocks.has(lock));
  }

  while (completed.size < commands.length) {
    const startable = [...pending.values()]
      .filter((command) => dependenciesSatisfied(command) && locksAvailable(command))
      .sort((left, right) => (idOrder.get(commandId(left)) || 0) - (idOrder.get(commandId(right)) || 0));
    for (const command of startable) {
      if (running.size >= maxParallel) break;
      if (!locksAvailable(command)) continue;
      const id = commandId(command);
      pending.delete(id);
      const locks = releaseCommandLocks(command);
      for (const lock of locks) heldLocks.add(lock);
      running.set(id, {
        finishesAtMs: elapsedMs + releaseCommandTimeoutMs(command, options.defaultTimeoutMs, env),
        locks
      });
    }
    if (running.size === 0) {
      throw new Error("Cannot estimate a release command DAG that makes no progress.");
    }
    const [finishedId, finished] = [...running.entries()].sort((left, right) =>
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
  beforeStart = async () => {},
  commands = [],
  defaultTimeoutMs,
  env = process.env,
  logPrefix = "release-dag",
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  maxParallel = defaultReleaseCommandParallelism(env),
  redactTail = (value = "") => String(value || "").slice(-2400),
  repoRoot,
  resolveCommand
}) {
  const schedule = createReleaseCommandSchedule(commands);
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

  const idOrder = new Map(commands.map((command, index) => [commandId(command), index]));
  const pending = new Map(commands.map((command) => [commandId(command), command]));
  const running = new Map();
  const completed = new Map();
  const heldLocks = new Set();
  const lockLastOwner = new Map();
  const effectiveMaxParallel = normalizedPositiveInteger(maxParallel, 1);

  function locksFor(command = {}) {
    return releaseCommandLocks(command);
  }

  function dependenciesSatisfied(command = {}) {
    return uniqueStrings(command.dependsOn).every((dependency) => completed.has(dependency));
  }

  function nonPassingDependencies(command = {}) {
    return uniqueStrings(command.dependsOn).filter((dependency) => {
      const result = completed.get(dependency);
      return result && result.status !== "passed";
    });
  }

  function locksAvailable(command = {}) {
    const locks = locksFor(command);
    if (locks.includes("__release_dag_exclusive__") && running.size > 0) {
      return false;
    }
    if (heldLocks.has("__release_dag_exclusive__")) {
      return false;
    }
    return locks.every((lock) => !heldLocks.has(lock));
  }

  function startableCommands() {
    return [...pending.values()]
      .filter((command) => dependenciesSatisfied(command) && nonPassingDependencies(command).length === 0 && locksAvailable(command))
      .sort((a, b) => (idOrder.get(commandId(a)) || 0) - (idOrder.get(commandId(b)) || 0));
  }

  function dependencyResult(command = {}, dependencyIds = []) {
    const blocked = dependencyIds.length > 0 && dependencyIds.every((dependencyId) =>
      completed.get(dependencyId)?.status === "blocked"
    );
    const dependencyResults = dependencyIds.map((dependencyId) => completed.get(dependencyId));
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
      reasonChain: dependencyResults.flatMap((result) => [
        `dependency:${result?.id || "unknown"}:${result?.status || "missing"}`,
        ...(result?.reasonChain || [])
      ]),
      ownerChain: uniqueStrings([
        commandId(command),
        ...dependencyResults.flatMap((result) => result?.ownerChain || [result?.id])
      ]),
      errorTail: blocked
        ? `Blocked because dependency command(s) are blocked: ${dependencyIds.join(", ")}`
        : `Skipped because dependency command(s) did not pass: ${dependencyIds.join(", ")}`
    };
  }

  async function runOne(command) {
    const id = commandId(command);
    const startedAt = new Date();
    const startedMs = Date.now();
    const timeoutMs = releaseCommandTimeoutMs(command, defaultTimeoutMs, env);
    const metadata = {
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
    } catch (error) {
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

    const resolved = resolveCommand(command);
    const executable = resolved.executable || resolved.command;
    const args = asArray(resolved.args);
    const displayCommand = resolved.displayCommand || [resolved.command || executable, ...args].join(" ");
    metadata.command = displayCommand;
    console.log(`[${logPrefix}] RUN ${id} layer=${metadata.layer || "default"}`);

    return await new Promise((resolve) => {
      const stdout = new CappedTextBuffer(maxBufferBytes);
      const stderr = new CappedTextBuffer(maxBufferBytes);
      let processError = null;
      let timedOut = false;
      let killTimer = null;
      let settled = false;
      const useProcessGroup = process.platform !== "win32";
      const terminate = (signal) => {
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
      const finish = ({ code = 1, signal = "" } = {}) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        const durationMs = Date.now() - startedMs;
        const passed = code === 0 && timedOut === false;
        const blocked = !passed && timedOut === false && metadata.blockedExitCodes.includes(code);
        const status = passed ? "passed" : blocked ? "blocked" : "failed";
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
      const child = spawn(executable, args, {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: useProcessGroup,
        windowsHide: true
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        killTimer = setTimeout(() => {
          terminate("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: 124, signal: "SIGKILL" });
        }, 5000);
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout.append(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr.append(chunk);
      });
      child.on("error", (error) => {
        processError = error;
      });
      child.on("close", (code, signal) => {
        finish({ code: Number(code ?? 1), signal });
      });
    });
  }

  while (completed.size < commands.length) {
    let progressed = false;
    for (const command of [...pending.values()]) {
      if (!dependenciesSatisfied(command)) {
        continue;
      }
      const dependencyFailures = nonPassingDependencies(command);
      if (dependencyFailures.length === 0) {
        continue;
      }
      const id = commandId(command);
      pending.delete(id);
      const result = dependencyResult(command, dependencyFailures);
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
      const id = commandId(command);
      pending.delete(id);
      const locks = locksFor(command);
      for (const lock of locks) {
        heldLocks.add(lock);
        lockLastOwner.set(lock, id);
      }
      const promise = runOne(command).then((result) => ({ id, result, locks }));
      running.set(id, { promise, locks });
      progressed = true;
    }

    if (running.size === 0) {
      if (progressed) {
        continue;
      }
      const diagnostic = createReleaseCommandDeadlockDiagnostic({
        completedCommandIds: [...completed.keys()],
        heldLocks: [...heldLocks],
        lockLastOwners: lockLastOwner,
        pendingCommands: [...pending.values()],
        runningCommands: [...running.entries()].map(([id, entry]) => ({
          id,
          resourceLocks: entry.locks.filter((lock) => lock !== "__release_dag_exclusive__"),
          exclusive: entry.locks.includes("__release_dag_exclusive__")
        }))
      });
      const error = new Error(formatReleaseCommandDeadlock(diagnostic));
      error.code = diagnostic.code;
      error.diagnostic = diagnostic;
      throw error;
    }

    const { id, result, locks } = await Promise.race([...running.values()].map((entry) => entry.promise));
    running.delete(id);
    for (const lock of locks) {
      heldLocks.delete(lock);
    }
    completed.set(id, result);
  }

  const results = commands.map((command) => completed.get(commandId(command)));
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
