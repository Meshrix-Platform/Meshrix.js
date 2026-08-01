import { spawn as nodeSpawn } from "node:child_process";

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
