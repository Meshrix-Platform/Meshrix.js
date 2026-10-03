import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

export function sourceNodeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  const current = String(childEnv.NODE_OPTIONS || "").trim();
  if (!/(?:^|\s)--conditions(?:=|\s+)source(?:\s|$)/u.test(current)) {
    childEnv.NODE_OPTIONS = `${current} --conditions=source`.trim();
  }
  return childEnv;
}

export interface TestSuiteEntry {
  id: string;
  label?: string;
  /** Registry `package` field, which scopes the inputs whose content decides reuse. */
  package?: string;
  command: string;
  args: string[];
  platforms?: string[];
  sideEffects?: string;
  flakePolicy?: string;
  requiredServices?: string[];
  childSuiteIds?: string[];
}

export interface ServiceCapability {
  status: "available" | "unavailable" | "failed";
  reasonCode?: string;
}

export type SuiteApplicability =
  | { status: "available" }
  | { status: "not_run"; requiredService: string; reasonCode: string }
  | { status: "failed"; requiredService: string; reasonCode: string };

export function resolveRequiredServiceApplicability(
  requiredServices: readonly string[] = [],
  capabilities: Readonly<Record<string, ServiceCapability>> = {}
): SuiteApplicability {
  let unavailable: SuiteApplicability | null = null;
  for (const requiredService of requiredServices) {
    const capability = capabilities[requiredService];
    if (!capability) {
      return { status: "failed", requiredService, reasonCode: "service_capability_unknown" };
    }
    if (capability.status === "failed") {
      return {
        status: "failed",
        requiredService,
        reasonCode: capability.reasonCode || "service_probe_failed"
      };
    }
    if (capability.status === "unavailable" && !unavailable) {
      unavailable = {
        status: "not_run",
        requiredService,
        reasonCode: capability.reasonCode || "capability_missing"
      };
    }
  }
  return unavailable ?? { status: "available" };
}

/**
 * Whether a previously passed result may stand in for running the suite again.
 *
 * Reuse requires the inputs recorded with that result to match the suite's current
 * inputs. A worktree does not have to be clean: an unrelated edit leaves a suite's own
 * inputs unchanged, and the fingerprint recognises that. A result without a recorded
 * input fingerprint cannot be shown to be current, so it is never reused.
 */
export async function isCachedTestResultReusable(
  entry: TestSuiteEntry,
  result: { status?: string; inputFingerprint?: string } | null | undefined,
  {
    rootDir,
    inputFingerprint,
    validatePreparedReleaseSet
  }: {
    rootDir: string;
    inputFingerprint?: string;
    validatePreparedReleaseSet?: (options: { rootDir: string; artifactDirectory: string }) => Promise<unknown>;
  }
): Promise<boolean> {
  if (result?.status !== "passed") return false;
  if (typeof inputFingerprint !== "string" || inputFingerprint.length === 0) return false;
  if (result.inputFingerprint !== inputFingerprint) return false;
  const isReleaseSetPreparation = entry.command === "npm"
    && entry.args.includes("release:publish-npm")
    && entry.args.includes("--prepare");
  if (!isReleaseSetPreparation) return true;
  if (typeof validatePreparedReleaseSet !== "function") return false;

  const artifactFlag = entry.args.indexOf("--artifact-dir");
  const artifactDirectory = artifactFlag >= 0 ? entry.args[artifactFlag + 1] : undefined;
  if (!artifactDirectory || artifactDirectory.startsWith("--")) return false;
  try {
    await validatePreparedReleaseSet({
      rootDir,
      artifactDirectory: path.resolve(rootDir, artifactDirectory)
    });
    return true;
  } catch {
    return false;
  }
}

export function mergeInheritedProfileExecution(
  parentExecution: Readonly<Record<string, any>> = {},
  profileExecution: Readonly<Record<string, any>> = {}
): Record<string, any> {
  const merged = { ...parentExecution, ...profileExecution };
  if (Array.isArray(profileExecution.phases)) {
    merged.phases = [
      ...(Array.isArray(parentExecution.phases) ? parentExecution.phases : []),
      ...profileExecution.phases
    ];
  } else {
    delete merged.phases;
  }
  return merged;
}

export interface TestExecutionContext {
  blockedBy: readonly string[];
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
  executeEntry: (entry: TestSuiteEntry, context?: TestExecutionContext) => Promise<Result>
): Promise<TestExecutionLaneResult<Result>[]> {
  const laneById = new Map(phase.lanes.map((lane) => [lane.id, lane]));
  const executions = new Map<string, Promise<TestExecutionLaneResult<Result>>>();
  const executeLane = (lane: TestExecutionLane): Promise<TestExecutionLaneResult<Result>> => {
    const existing = executions.get(lane.id);
    if (existing) return existing;
    const execution = Promise.resolve().then(async () => {
      const dependencyOutcomes = await Promise.all((lane.dependsOn ?? []).map((dependencyId) =>
        executeLane(laneById.get(dependencyId)!)
      ));
      const blockedBy = dependencyOutcomes
        .filter((outcome) => outcome.results.some((result: any) => {
          const status = result && typeof result === "object" ? result.status : undefined;
          return status !== undefined && status !== "passed" && status !== "dry-run";
        }))
        .map((outcome) => outcome.id);
      const results: Result[] = [];
      for (const entry of lane.entries) {
        results.push(await executeEntry(entry, { blockedBy }));
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

export const TEST_PROCESS_TERMINATION_GRACE_MS = 1000;

function commandResultIdentity(entry: TestSuiteEntry): Record<string, any> {
  return {
    id: entry.id,
    label: entry.label || entry.id,
    command: [entry.command, ...entry.args].join(" "),
    childSuiteIds: entry.childSuiteIds ?? [entry.id]
  };
}

export function notRunSuiteResult(
  entry: TestSuiteEntry,
  { reason, blockedBy = [] }: { reason: string; blockedBy?: readonly string[] }
): Record<string, any> {
  return {
    ...commandResultIdentity(entry),
    status: "not_run",
    reason,
    ...(blockedBy.length > 0 ? { blockedBy: [...blockedBy] } : {})
  };
}

export function summarizeTestResults(
  results: readonly { status: string }[],
  expectedProcessCount: number
): Record<string, any> {
  const summary: Record<string, any> = {
    passed: 0,
    failed: 0,
    skipped: 0,
    dryRun: 0,
    cancelled: 0,
    notRun: 0
  };
  for (const result of results) {
    if (result.status === "passed") summary.passed += 1;
    else if (result.status === "failed") summary.failed += 1;
    else if (result.status === "skipped") summary.skipped += 1;
    else if (result.status === "dry-run") summary.dryRun += 1;
    else if (result.status === "cancelled") summary.cancelled += 1;
    else if (result.status === "not_run") summary.notRun += 1;
  }
  const classifiedResultCount = summary.passed + summary.failed + summary.skipped
    + summary.dryRun + summary.cancelled + summary.notRun;
  summary.coverageReady = results.length === expectedProcessCount
    && classifiedResultCount === results.length
    && summary.passed > 0
    && summary.failed === 0
    && summary.skipped === 0
    && summary.cancelled === 0
    && summary.notRun === 0
    && summary.dryRun === 0;
  summary.releaseReady = summary.coverageReady;
  return summary;
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
  signal,
  terminationGraceMs = TEST_PROCESS_TERMINATION_GRACE_MS,
  spawnImpl = nodeSpawn,
  stdio = "inherit",
  executionCommand = entry?.command,
  executionArgs = entry?.args
}: Record<string, any> = {}) : any {
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error("terminationGraceMs must be a positive integer.");
  }
  if (signal?.aborted) {
    return Promise.resolve(notRunSuiteResult(entry, { reason: "runner_interrupted_before_start" }));
  }

  return new Promise((resolve?: any) : any => {
    const startedAt: any = new Date();
    const terminationSignals: any[] = [];
    let settled: any = false;
    let cancelled = false;
    let forceKillTimer: any = null;
    let child: any;
    let cancel: () => void = () => undefined;

    const cleanup = () : any => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", cancel);
    };

    const finish: any = ({ exitCode = null, signal = null, error = null }: Record<string, any> = {}) : any => {
      if (settled) return;
      settled = true;
      cleanup();
      const finishedAt: any = new Date();
      resolve({
        ...commandResultIdentity(entry),
        status: cancelled ? "cancelled" : !error && exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
        ...(error ? { error: String(error.message || error) } : {}),
        terminationSignals,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime()
      });
    };

    try {
      child = spawnImpl(executionCommand, executionArgs, {
        cwd,
        env,
        stdio,
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error: any) {
      finish({ error });
      return;
    }

    child.once("close", (exitCode?: any, signal?: any) : any => finish({ exitCode, signal }));
    child.once("error", (error?: any) : any => finish({ error }));

    cancel = () : any => {
      if (settled || cancelled) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      terminationSignals.push("SIGTERM");
      sendProcessTreeSignal(child, "SIGTERM");
      forceKillTimer = setTimeout(() : any => {
        if (settled) return;
        terminationSignals.push("SIGKILL");
        sendProcessTreeSignal(child, "SIGKILL");
      }, terminationGraceMs);
    };

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
