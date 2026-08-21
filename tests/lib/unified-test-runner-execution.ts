import { spawn as nodeSpawn } from "node:child_process";

export interface TestSuiteEntry {
  id: string;
  label?: string;
  command: string;
  args: string[];
  timeoutClass: string;
  sideEffects?: string;
  flakePolicy?: string;
  requiredServices?: string[];
  childSuiteIds?: string[];
}

export interface TestShard {
  index: number;
  count: number;
}

export function profileInherits(
  configs: Readonly<Record<string, { extends?: string | null }>>,
  profile: string,
  ancestor: string
): boolean {
  const visited = new Set<string>();
  let current: string | null = profile;
  while (current && !visited.has(current)) {
    if (current === ancestor) return true;
    visited.add(current);
    current = configs[current]?.extends || null;
  }
  return false;
}

function isVitestEntry(entry: TestSuiteEntry): boolean {
  return entry.command === "npm"
    && entry.args[0] === "run"
    && entry.args[1] === "vitest"
    && entry.args[2] === "--";
}

function mergeCompatibilityKey(entry: TestSuiteEntry): string | null {
  if (!isVitestEntry(entry)) return null;
  return JSON.stringify([
    entry.timeoutClass,
    entry.sideEffects ?? "none",
    entry.flakePolicy ?? "fail",
    [...(entry.requiredServices ?? [])].sort()
  ]);
}

export function mergeCompatibleSuiteProcesses(entries: readonly TestSuiteEntry[]): TestSuiteEntry[] {
  const planned: TestSuiteEntry[] = [];
  const mergeTargetByKey = new Map<string, number>();
  for (const entry of entries) {
    const key = mergeCompatibilityKey(entry);
    const targetIndex = key === null ? undefined : mergeTargetByKey.get(key);
    if (targetIndex === undefined) {
      planned.push({ ...entry, args: [...entry.args] });
      if (key !== null) mergeTargetByKey.set(key, planned.length - 1);
      continue;
    }
    const previous = planned[targetIndex];
    const childSuiteIds = [...(previous.childSuiteIds ?? [previous.id]), entry.id];
    const testArgs = [...new Set([...previous.args.slice(3), ...entry.args.slice(3)])];
    planned[targetIndex] = {
      ...previous,
      id: `merged:${childSuiteIds.join("+")}`,
      label: `Merged Vitest suites (${childSuiteIds.length})`,
      args: ["run", "vitest", "--", ...testArgs],
      childSuiteIds
    };
  }
  return planned;
}

export function parseTestShard(value: string | null | undefined): TestShard | null {
  const match = /^(\d+)\/(\d+)$/u.exec(String(value ?? "").trim());
  if (!match) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    throw new Error("Test shard must use the form <index>/<count>.");
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 2 || index < 1 || index > count) {
    throw new Error("Test shard index must be between 1 and count, and count must be at least 2.");
  }
  return { index, count };
}

export function applyVitestShard(entry: TestSuiteEntry, shard: TestShard | null): TestSuiteEntry {
  if (!shard || !isVitestEntry(entry)) return entry;
  return {
    ...entry,
    args: [...entry.args, `--shard=${shard.index}/${shard.count}`]
  };
}

export const TEST_SUITE_TIMEOUT_MS: Readonly<Record<string, any>> = Object.freeze({
  fast: 2 * 60 * 1000,
  standard: 15 * 60 * 1000,
  slow: 60 * 60 * 1000
});

export const TEST_SUITE_TERMINATION_GRACE_MS: any = 1000;

function positiveInteger(value?: any, label?: any) : any {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function timeoutMsForSuite(entry: Record<string, any> = {}) : any {
  const timeoutClass: any = String(entry.timeoutClass || "").trim();
  const timeoutMs: any = TEST_SUITE_TIMEOUT_MS[timeoutClass];
  if (!timeoutMs) {
    throw new Error(`Suite "${entry.id || "<unknown>"}" has unsupported timeoutClass "${timeoutClass || "<missing>"}".`);
  }
  return timeoutMs;
}

export function resolveExecutionTimeout({ suiteTimeoutMs, profileRemainingMs = null }: Record<string, any> = {}) : any {
  const declaredSuiteTimeoutMs: any = positiveInteger(suiteTimeoutMs, "suiteTimeoutMs");
  if (profileRemainingMs === null || profileRemainingMs === undefined) {
    return {
      timeoutMs: declaredSuiteTimeoutMs,
      timeoutScope: "suite"
    };
  }
  const remainingMs: any = positiveInteger(profileRemainingMs, "profileRemainingMs");
  return remainingMs <= declaredSuiteTimeoutMs
    ? { timeoutMs: remainingMs, timeoutScope: "profile" }
    : { timeoutMs: declaredSuiteTimeoutMs, timeoutScope: "suite" };
}

function sendProcessTreeSignal(child?: any, signal?: any) : any {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") {
      return false;
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

export function runSuiteProcess(entry?: any, {
  cwd,
  env = process.env,
  timeoutMs,
  timeoutScope = "suite",
  terminationGraceMs = TEST_SUITE_TERMINATION_GRACE_MS,
  spawnImpl = nodeSpawn
}: Record<string, any> = {}) : any {
  const effectiveTimeoutMs: any = positiveInteger(timeoutMs, "timeoutMs");
  const effectiveTerminationGraceMs: any = positiveInteger(terminationGraceMs, "terminationGraceMs");

  return new Promise((resolve?: any) : any => {
    const startedAt: any = new Date();
    const terminationSignals: any[] = [];
    let settled: any = false;
    let timedOut: any = false;
    let timeoutTimer: any = null;
    let forceKillTimer: any = null;
    const child: any = spawnImpl(entry.command, entry.args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    const finish: any = ({ exitCode = null, signal = null, error = null }: Record<string, any> = {}) : any => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const finishedAt: any = new Date();
      resolve({
        id: entry.id,
        label: entry.label || entry.id,
        command: [entry.command, ...entry.args].join(" "),
        status: !timedOut && exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
        ...(error ? { error: String(error.message || error) } : {}),
        timedOut,
        timeoutMs: effectiveTimeoutMs,
        timeoutScope: timedOut ? timeoutScope : null,
        terminationSignals,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime()
      });
    };

    child.once("close", (exitCode?: any, signal?: any) : any => finish({ exitCode, signal }));
    child.once("error", (error?: any) : any => finish({ error }));

    timeoutTimer = setTimeout(() : any => {
      if (settled) return;
      timedOut = true;
      terminationSignals.push("SIGTERM");
      sendProcessTreeSignal(child, "SIGTERM");
      forceKillTimer = setTimeout(() : any => {
        if (settled) return;
        terminationSignals.push("SIGKILL");
        sendProcessTreeSignal(child, "SIGKILL");
      }, effectiveTerminationGraceMs);
    }, effectiveTimeoutMs);
  });
}
