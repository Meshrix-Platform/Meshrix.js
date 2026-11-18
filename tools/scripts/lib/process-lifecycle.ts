import process from "node:process";

export type ManagedProcessState = "alive" | "exited" | "permission-denied" | "self" | "invalid";
export type ManagedSignalResult = "sent" | "already-exited" | "permission-denied" | "failed" | "self" | "invalid";
export type ProcessSignal = NodeJS.Signals;

type KillProcess = (pid: number, signal: number | ProcessSignal) => void;

export interface ProcessProbeOptions {
  selfPid?: number;
  kill?: KillProcess;
}

export interface StopProcessesOptions {
  selfPid?: number;
  inspect?: (pid: number) => ManagedProcessState;
  signalTree?: (pid: number, signal: ProcessSignal) => ManagedSignalResult;
  gracefulSignal?: ProcessSignal;
  wait?: (milliseconds: number) => Promise<void>;
  gracefulWaitMs?: number;
  pollIntervalMs?: number;
}

export interface StopProcessesResult {
  terminated: number[];
  alreadyExited: number[];
  permissionDenied: number[];
  invalid: number[];
  self: number[];
  forceSignalled: number[];
  gracefulFailed: number[];
}

export function isManagedPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

export function inspectManagedProcess(
  value: unknown,
  { selfPid = process.pid, kill = (pid, signal) => process.kill(pid, signal) }: ProcessProbeOptions = {}
): ManagedProcessState {
  if (!isManagedPid(value)) return "invalid";
  const pid = value;
  if (pid === selfPid) return "self";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "exited";
    if (errorCode(error) === "EPERM") return "permission-denied";
    throw error;
  }
}

export function managedProcessIsAlive(value: unknown, options: ProcessProbeOptions = {}): boolean {
  const state = inspectManagedProcess(value, options);
  return state === "alive" || state === "permission-denied" || state === "self";
}

export function signalManagedProcess(
  value: unknown,
  signal: ProcessSignal,
  { selfPid = process.pid, kill = (pid, selectedSignal) => process.kill(pid, selectedSignal) }: ProcessProbeOptions = {}
): ManagedSignalResult {
  if (!isManagedPid(value)) return "invalid";
  const pid = value;
  if (pid === selfPid) return "self";
  try {
    kill(pid, signal);
    return "sent";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "already-exited";
    if (errorCode(error) === "EPERM") return "permission-denied";
    throw error;
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function stopManagedProcesses(
  values: Iterable<unknown>,
  {
    selfPid = process.pid,
    inspect = (pid) => inspectManagedProcess(pid, { selfPid }),
    signalTree = (pid, signal) => signalManagedProcess(pid, signal, { selfPid }),
    gracefulSignal = "SIGTERM",
    wait = delay,
    gracefulWaitMs = 5_000,
    pollIntervalMs = 250,
  }: StopProcessesOptions = {}
): Promise<StopProcessesResult> {
  const result: StopProcessesResult = {
    terminated: [],
    alreadyExited: [],
    permissionDenied: [],
    invalid: [],
    self: [],
    forceSignalled: [],
    gracefulFailed: [],
  };
  const pids = new Set<number>();

  for (const value of values) {
    if (!isManagedPid(value)) {
      result.invalid.push(typeof value === "number" ? value : Number.NaN);
    } else if (value === selfPid) {
      result.self.push(value);
    } else {
      pids.add(value);
    }
  }

  const gracefulTargets = new Set<number>();
  const forceTargets = new Set<number>();
  for (const pid of pids) {
    const sent = signalTree(pid, gracefulSignal);
    if (sent === "already-exited") result.alreadyExited.push(pid);
    else if (sent === "permission-denied") result.permissionDenied.push(pid);
    else if (sent === "invalid") result.invalid.push(pid);
    else if (sent === "self") result.self.push(pid);
    else {
      if (sent === "failed") {
        result.gracefulFailed.push(pid);
        forceTargets.add(pid);
      } else {
        gracefulTargets.add(pid);
      }
    }
  }

  const interval = Math.max(1, pollIntervalMs);
  const attempts = Math.ceil(Math.max(0, gracefulWaitMs) / interval);
  for (let attempt = 0; attempt < attempts && gracefulTargets.size > 0; attempt += 1) {
    for (const pid of gracefulTargets) {
      const state = inspect(pid);
      if (state === "exited" || state === "invalid") {
        gracefulTargets.delete(pid);
        result.terminated.push(pid);
      } else if (state === "permission-denied") {
        gracefulTargets.delete(pid);
        result.permissionDenied.push(pid);
      }
    }
    if (gracefulTargets.size > 0) await wait(interval);
  }

  for (const pid of gracefulTargets) {
    const state = inspect(pid);
    if (state === "exited" || state === "invalid") {
      result.terminated.push(pid);
      continue;
    }
    if (state === "permission-denied") {
      result.permissionDenied.push(pid);
      continue;
    }
    forceTargets.add(pid);
  }

  for (const pid of forceTargets) {
    const state = inspect(pid);
    if (state === "exited" || state === "invalid") {
      result.terminated.push(pid);
      continue;
    }
    if (state === "permission-denied") {
      result.permissionDenied.push(pid);
      continue;
    }
    const forced = signalTree(pid, "SIGKILL");
    if (forced === "sent") {
      result.forceSignalled.push(pid);
    } else if (forced === "already-exited") {
      result.terminated.push(pid);
    } else if (forced === "permission-denied") {
      result.permissionDenied.push(pid);
    } else if (forced === "invalid") {
      result.invalid.push(pid);
    } else if (forced === "failed") {
      throw new Error("managed_process_force_termination_failed");
    } else {
      result.self.push(pid);
    }
  }

  return result;
}

export function forwardSignalToChild(
  child: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals
): ManagedSignalResult {
  if (!isManagedPid(child.pid)) return "invalid";
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return "already-exited";
  try {
    return child.kill(signal) ? "sent" : "already-exited";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "already-exited";
    if (errorCode(error) === "EPERM") return "permission-denied";
    throw error;
  }
}
