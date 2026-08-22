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

export interface TestExecutionLaneDefinition {
  id: string;
  label?: string;
  suites: string[];
  dependsOn?: string[];
}

export interface TestExecutionPhaseDefinition {
  id: string;
  label?: string;
  lanes: TestExecutionLaneDefinition[];
}

export interface TestExecutionLane {
  id: string;
  label?: string;
  entries: TestSuiteEntry[];
  dependsOn?: string[];
}

export interface TestExecutionPhase {
  id: string;
  label?: string;
  lanes: TestExecutionLane[];
}

export interface TestExecutionLaneResult<Result> {
  id: string;
  label?: string;
  dependsOn?: string[];
  results: Result[];
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

export function planTestExecutionPhases(
  entries: readonly TestSuiteEntry[],
  definitions: readonly TestExecutionPhaseDefinition[] | null | undefined,
  {
    mergeVitestProcesses = false,
    shard = null
  }: {
    mergeVitestProcesses?: boolean;
    shard?: TestShard | null;
  } = {}
): TestExecutionPhase[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  if (entryById.size !== entries.length) {
    throw new Error("Selected test suites must have unique IDs.");
  }

  const planLane = (lane: TestExecutionLane): TestExecutionLane => {
    const plannedEntries = mergeVitestProcesses
      ? mergeCompatibleSuiteProcesses(lane.entries)
      : lane.entries.map((entry) => ({ ...entry, args: [...entry.args] }));
    return {
      ...lane,
      entries: plannedEntries.map((entry) => applyVitestShard(entry, shard))
    };
  };

  if (!definitions || definitions.length === 0) {
    return [{
      id: "default",
      label: "Selected test suites",
      lanes: [planLane({ id: "default", entries: [...entries] })]
    }];
  }

  const phaseIds = new Set<string>();
  const referencedSuiteIds = new Set<string>();
  const phases: TestExecutionPhase[] = definitions.map((phase) => {
    if (phaseIds.has(phase.id)) {
      throw new Error(`Execution phase "${phase.id}" is declared more than once.`);
    }
    phaseIds.add(phase.id);
    const laneIds = new Set<string>();
    const lanes = phase.lanes.map((lane) => {
      if (laneIds.has(lane.id)) {
        throw new Error(`Execution lane "${phase.id}/${lane.id}" is declared more than once.`);
      }
      laneIds.add(lane.id);
      const laneEntries = lane.suites.map((suiteId) => {
        const entry = entryById.get(suiteId);
        if (!entry) {
          throw new Error(`Execution lane "${phase.id}/${lane.id}" references unselected suite "${suiteId}".`);
        }
        if (referencedSuiteIds.has(suiteId)) {
          throw new Error(`Execution suite "${suiteId}" is declared more than once.`);
        }
        referencedSuiteIds.add(suiteId);
        return entry;
      });
      return planLane({
        id: lane.id,
        label: lane.label,
        dependsOn: [...(lane.dependsOn ?? [])],
        entries: laneEntries
      });
    });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    for (const lane of lanes) {
      for (const dependencyId of lane.dependsOn ?? []) {
        if (!laneById.has(dependencyId)) {
          throw new Error(`Execution lane "${phase.id}/${lane.id}" depends on unknown lane "${dependencyId}".`);
        }
        if (dependencyId === lane.id) {
          throw new Error(`Execution lane "${phase.id}/${lane.id}" cannot depend on itself.`);
        }
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (laneId: string): void => {
      if (visited.has(laneId)) return;
      if (visiting.has(laneId)) {
        throw new Error(`Execution phase "${phase.id}" contains a lane dependency cycle at "${laneId}".`);
      }
      visiting.add(laneId);
      for (const dependencyId of laneById.get(laneId)?.dependsOn ?? []) visit(dependencyId);
      visiting.delete(laneId);
      visited.add(laneId);
    };
    for (const lane of lanes) visit(lane.id);
    return { id: phase.id, label: phase.label, lanes };
  });

  const unplannedSuiteIds = entries
    .map((entry) => entry.id)
    .filter((suiteId) => !referencedSuiteIds.has(suiteId));
  if (unplannedSuiteIds.length > 0) {
    throw new Error(`Execution phases omit selected suites: ${unplannedSuiteIds.join(", ")}.`);
  }
  return phases;
}

export async function runTestPhaseLanes<Result>(
  phase: TestExecutionPhase,
  executeEntry: (entry: TestSuiteEntry) => Promise<Result>
): Promise<TestExecutionLaneResult<Result>[]> {
  const laneById = new Map(phase.lanes.map((lane) => [lane.id, lane]));
  const executions = new Map<string, Promise<TestExecutionLaneResult<Result>>>();
  const executeLane = (lane: TestExecutionLane): Promise<TestExecutionLaneResult<Result>> => {
    const existing = executions.get(lane.id);
    if (existing) return existing;
    const execution = Promise.resolve().then(async () => {
      await Promise.all((lane.dependsOn ?? []).map((dependencyId) =>
        executeLane(laneById.get(dependencyId)!)
      ));
      const results: Result[] = [];
      for (const entry of lane.entries) {
        results.push(await executeEntry(entry));
      }
      return {
        id: lane.id,
        label: lane.label,
        dependsOn: lane.dependsOn,
        results
      };
    });
    executions.set(lane.id, execution);
    return execution;
  };
  return Promise.all(phase.lanes.map(executeLane));
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
