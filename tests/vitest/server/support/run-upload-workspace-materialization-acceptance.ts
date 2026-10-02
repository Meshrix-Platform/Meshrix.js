import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MaterializationAcceptanceError,
  MATERIALIZATION_PROJECT,
  MATERIALIZATION_TEST_PATH,
  sanitizeMaterializationDiagnostic,
  validateMaterializationCollection,
  validateMaterializationRunReport,
  type MaterializationProcessResult
} from "./upload-workspace-materialization-acceptance-contract.ts";

const vitestPath = fileURLToPath(new URL(
  "../../../../node_modules/vitest/vitest.mjs",
  import.meta.url
));
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const CANCELLATION_KILL_GRACE_MS = 1000;

type SignalName = "SIGINT" | "SIGTERM";

export interface AcceptanceSignalSource {
  once(signal: SignalName, listener: () => void): unknown;
  off(signal: SignalName, listener: () => void): unknown;
}

export type AcceptanceSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface MaterializationAcceptanceRuntime {
  cwd?: string;
  platform?: NodeJS.Platform;
  signalSource?: AcceptanceSignalSource;
  spawnImpl?: AcceptanceSpawn;
}

interface CapturedOutput {
  stdout: Buffer[];
  stderr: Buffer[];
  bytes: number;
}

interface VitestCommandResult extends MaterializationProcessResult {
  stderr: string;
}

const spawnProcess: AcceptanceSpawn = (command, args, options) =>
  spawn(command, args, options);

function signalOwnedProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const childPid = child.pid;
  if (process.platform === "linux" && Number.isSafeInteger(childPid) && childPid! > 1) {
    try {
      process.kill(-childPid!, signal);
      return;
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutput(output: string): unknown | null {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

function reportSummary(value: unknown, cwd: string): string {
  if (!isRecord(value)) return "vitest_json_report=malformed";
  const fields = [
    "success",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numFailedTestSuites",
    "numPendingTestSuites"
  ];
  const summary = fields.map((field) => `${field}=${String(value[field])}`);
  const failures = Array.isArray(value.testResults)
    ? value.testResults.flatMap((fileResult) => {
      if (!isRecord(fileResult) || !Array.isArray(fileResult.assertionResults)) return [];
      return fileResult.assertionResults.flatMap((assertion) => {
        if (!isRecord(assertion) || assertion.status === "passed") return [];
        const lines = [`${String(assertion.status)}:${String(assertion.fullName)}`];
        if (Array.isArray(assertion.failureMessages)) {
          for (const message of assertion.failureMessages) {
            if (typeof message === "string") {
              lines.push(sanitizeMaterializationDiagnostic(cwd, [message]));
            }
          }
        }
        return lines;
      });
    })
    : [];
  if (failures.length > 0) summary.push(`non_passed_assertions=${failures.join(" | ")}`);
  return summary.join("\n").slice(0, 64 * 1024);
}

function acceptanceFailure(
  code: ConstructorParameters<typeof MaterializationAcceptanceError>[0],
  cwd: string,
  exitCode: number,
  output: Pick<VitestCommandResult, "stdout" | "stderr"> = { stdout: "", stderr: "" },
  summary = ""
): MaterializationAcceptanceError {
  const diagnostic = sanitizeMaterializationDiagnostic(cwd, [summary, output.stdout, output.stderr]);
  return new MaterializationAcceptanceError(code, exitCode, diagnostic);
}

function runVitestProcess(options: {
  args: string[];
  cwd: string;
  signal: AbortSignal;
  spawnImpl: AcceptanceSpawn;
}): Promise<VitestCommandResult> {
  const { args, cwd, signal, spawnImpl } = options;
  if (signal.aborted) {
    const exitCode = typeof signal.reason === "number" ? signal.reason : 130;
    return Promise.reject(new MaterializationAcceptanceError(
      "materialization_acceptance_cancelled",
      exitCode
    ));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(process.execPath, args, {
        cwd,
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      reject(acceptanceFailure("materialization_acceptance_spawn_failed", cwd, 1));
      return;
    }

    const output: CapturedOutput = { stdout: [], stderr: [], bytes: 0 };
    let spawnFailed = false;
    let outputExceeded = false;
    let terminationRequested = false;
    let terminationTimer: NodeJS.Timeout | null = null;

    const captured = (): VitestCommandResult => ({
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdout: Buffer.concat(output.stdout).toString("utf8"),
      stderr: Buffer.concat(output.stderr).toString("utf8")
    });
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      if (terminationTimer) clearTimeout(terminationTimer);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
    };
    const rejectForStop = (code: "materialization_acceptance_cancelled" | "materialization_acceptance_output_limit"): void => {
      const result = captured();
      const exitCode = code === "materialization_acceptance_cancelled"
        ? typeof signal.reason === "number" ? signal.reason : 130
        : 1;
      cleanup();
      reject(acceptanceFailure(code, cwd, exitCode, result));
    };
    const onError = (): void => {
      spawnFailed = true;
      terminate();
    };
    const onClose = (exitCode: number | null, closeSignal: NodeJS.Signals | null): void => {
      if (terminationTimer) clearTimeout(terminationTimer);
      if (signal.aborted) {
        rejectForStop("materialization_acceptance_cancelled");
        return;
      }
      if (outputExceeded) {
        rejectForStop("materialization_acceptance_output_limit");
        return;
      }
      if (spawnFailed) {
        const result = captured();
        cleanup();
        reject(acceptanceFailure("materialization_acceptance_spawn_failed", cwd, 1, result));
        return;
      }
      const result = captured();
      cleanup();
      resolve({ ...result, exitCode, signal: closeSignal });
    };
    const terminate = (): void => {
      if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
      terminationRequested = true;
      signalOwnedProcessGroup(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalOwnedProcessGroup(child, "SIGKILL");
        }
      }, CANCELLATION_KILL_GRACE_MS);
      terminationTimer.unref?.();
    };
    const onAbort = (): void => terminate();
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - output.bytes;
      if (bytes.length > remaining) {
        if (remaining > 0) target.push(bytes.subarray(0, remaining));
        output.bytes = MAX_CAPTURED_OUTPUT_BYTES;
        outputExceeded = true;
        terminate();
        return;
      }
      output.bytes += bytes.length;
      target.push(bytes);
    };
    const onStdout = (chunk: Buffer | string): void => append(output.stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => append(output.stderr, chunk);

    child.once("error", onError);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!child.stdout || !child.stderr) {
      spawnFailed = true;
      terminate();
    }
  });
}

function reportCommandFailure(
  result: VitestCommandResult,
  cwd: string,
  report?: unknown
): MaterializationAcceptanceError {
  const summary = report === undefined ? "vitest_command=nonzero_exit" : reportSummary(report, cwd);
  return acceptanceFailure(
    "materialization_acceptance_run_failed",
    cwd,
    1,
    result,
    summary
  );
}

export async function runUploadWorkspaceMaterializationAcceptance(
  runtime: MaterializationAcceptanceRuntime = {}
): Promise<void> {
  const platform = runtime.platform ?? process.platform;
  const cwd = path.resolve(runtime.cwd ?? process.cwd());
  if (platform !== "linux") {
    throw acceptanceFailure("materialization_acceptance_linux_required", cwd, 1);
  }

  const controller = new AbortController();
  const signalSource = runtime.signalSource ?? process;
  const onInterrupt = (): void => controller.abort(130);
  const onTerminate = (): void => controller.abort(143);
  const spawnImpl = runtime.spawnImpl ?? spawnProcess;
  signalSource.once("SIGINT", onInterrupt);
  signalSource.once("SIGTERM", onTerminate);

  try {
    const collectionResult = await runVitestProcess({
      args: [vitestPath, "list", MATERIALIZATION_TEST_PATH, "--project", MATERIALIZATION_PROJECT, "--json"],
      cwd,
      signal: controller.signal,
      spawnImpl
    });
    if (collectionResult.exitCode !== 0 || collectionResult.signal !== null) {
      throw acceptanceFailure(
        "materialization_acceptance_collection_failed",
        cwd,
        1,
        collectionResult,
        `collection_exit_code=${String(collectionResult.exitCode)} collection_signal=${String(collectionResult.signal)}`
      );
    }

    const collection = parseOutput(collectionResult.stdout);
    if (collection === null) {
      throw acceptanceFailure(
        "materialization_acceptance_collection_invalid",
        cwd,
        1,
        collectionResult,
        "collection_json=malformed"
      );
    }

    let expectedNames: readonly string[];
    try {
      expectedNames = validateMaterializationCollection(collection, cwd);
    } catch {
      const count = Array.isArray(collection) ? collection.length : "invalid";
      throw acceptanceFailure(
        "materialization_acceptance_collection_invalid",
        cwd,
        1,
        collectionResult,
        `collection_entry_count=${String(count)}`
      );
    }

    const runResult = await runVitestProcess({
      args: [vitestPath, "run", MATERIALIZATION_TEST_PATH, "--project", MATERIALIZATION_PROJECT, "--reporter=json"],
      cwd,
      signal: controller.signal,
      spawnImpl
    });
    const report = parseOutput(runResult.stdout);
    if (runResult.exitCode !== 0 || runResult.signal !== null) {
      throw reportCommandFailure(runResult, cwd, report ?? undefined);
    }
    if (report === null || !isRecord(report)) {
      throw acceptanceFailure(
        "materialization_acceptance_report_invalid",
        cwd,
        1,
        runResult,
        "vitest_json_report=malformed"
      );
    }
    try {
      validateMaterializationRunReport(report, runResult, expectedNames, cwd);
    } catch {
      throw acceptanceFailure(
        "materialization_acceptance_report_invalid",
        cwd,
        1,
        runResult,
        reportSummary(report, cwd)
      );
    }
  } finally {
    signalSource.off("SIGINT", onInterrupt);
    signalSource.off("SIGTERM", onTerminate);
  }
}

function isDirectInvocation(): boolean {
  return process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectInvocation()) {
  void runUploadWorkspaceMaterializationAcceptance().catch((error: unknown) => {
    const failure = error instanceof MaterializationAcceptanceError
      ? error
      : new MaterializationAcceptanceError("materialization_acceptance_run_failed");
    process.stderr.write(`${failure.code}\n`);
    if (failure.sanitizedDiagnostic) process.stderr.write(`${failure.sanitizedDiagnostic}\n`);
    process.exitCode = failure.exitCode;
  });
}
