#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "../server-scripts/lib/report-evidence-safety.ts";
import { sanitizeVerificationLog } from "../server-scripts/localize-verify-failure.ts";
import { loadReleaseDefinition } from "../server-scripts/lib/release-metadata.ts";
import { sanitizeSensitiveReport } from "../server-scripts/lib/sensitive-report-scan.ts";
import {
  runSuiteProcess,
  sourceNodeEnvironment,
  type TestSuiteEntry
} from "../../tests/lib/unified-test-runner-execution.ts";
export { sourceNodeEnvironment } from "../../tests/lib/unified-test-runner-execution.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENGINEERING_PROFILE = "engineering-public";
const NODE_SOURCE_CONDITION = "--conditions=source";

export interface LocalCiOptions {
  scope: "engineering" | "release";
  reportPath: string | null;
  help: boolean;
}

function repositoryRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const resolved = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, resolved);
  if (
    !value.trim() ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.posix.normalize(normalized) === "."
  ) {
    throw new Error("local_ci_report_path_invalid");
  }
  return relative.split(path.sep).join("/");
}

export function parseLocalCiArguments(argv: readonly string[]): LocalCiOptions {
  let scope: LocalCiOptions["scope"] = "engineering";
  let reportPath: string | null = null;
  let help = false;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--scope" || argument === "--report") {
      if (seen.has(argument)) throw new Error("local_ci_duplicate_option");
      seen.add(argument);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("local_ci_option_value_missing");
      if (argument === "--scope") {
        if (value !== "engineering" && value !== "release") throw new Error("local_ci_scope_invalid");
        scope = value;
      } else {
        reportPath = repositoryRelativePath(value);
      }
      continue;
    }
    if (argument.startsWith("--scope=") || argument.startsWith("--report=")) {
      const separator = argument.indexOf("=");
      const flag = argument.slice(0, separator);
      const value = argument.slice(separator + 1);
      if (seen.has(flag)) throw new Error("local_ci_duplicate_option");
      seen.add(flag);
      if (!value) throw new Error("local_ci_option_value_missing");
      if (flag === "--scope") {
        if (value !== "engineering" && value !== "release") throw new Error("local_ci_scope_invalid");
        scope = value;
      } else {
        reportPath = repositoryRelativePath(value);
      }
      continue;
    }
    throw new Error("local_ci_argument_unknown");
  }

  return { scope, reportPath, help };
}

interface SuiteResult {
  id: string;
  profile?: string;
  childSuiteIds?: string[];
  status: string;
  reasonCode?: string;
  requiredService?: string;
  notRunReason?: string;
  blockedBy?: string[];
  phaseId?: string;
  laneId?: string;
  cached?: boolean;
  durationMs?: number;
  exitCode?: number | null;
  evidence?: string[];
}

const OPTIONAL_CAPABILITY_REASONS = new Set([
  "docker_cli_missing",
  "docker_context_unavailable",
  "docker_context_not_local",
  "docker_daemon_unavailable",
  "docker_daemon_not_linux",
  "docker_architecture_unsupported",
  "docker_architecture_mismatch",
  "docker_unavailable",
  "oci_image_platform_mismatch",
  "podman_cli_missing",
  "external_endpoint_not_opted_in",
  "platform_unavailable"
]);

function hasOptionalCapabilityGap(result: SuiteResult): boolean {
  return result.status === "not_run"
    && OPTIONAL_CAPABILITY_REASONS.has(String(result.reasonCode || ""))
    && (Boolean(result.requiredService) || result.reasonCode === "platform_unavailable");
}

function laneKey(phaseId: string | undefined, laneId: string | undefined): string {
  return `${phaseId || ""}/${laneId || ""}`;
}

export function evaluateEngineeringOutcomes(
  results: readonly SuiteResult[],
  runnerExitCode: number | null,
  { cancelled: executionCancelled = false }: { cancelled?: boolean } = {}
): {
  status: "passed" | "failed" | "cancelled";
  reasonCode?: string;
  passed: number;
  failed: number;
  notRun: number;
  cancelled: number;
  optionalNotRun: number;
} {
  const byLane = new Map<string, SuiteResult[]>();
  for (const result of results) {
    const key = laneKey(result.phaseId, result.laneId);
    const list = byLane.get(key) ?? [];
    list.push(result);
    byLane.set(key, list);
  }

  const optionalLanes = new Set<string>();
  for (let pass = 0; pass < byLane.size; pass += 1) {
    let changed = false;
    for (const [key, laneResults] of byLane) {
      if (optionalLanes.has(key)) continue;
      const onlyOptionalIncomplete = laneResults.every((result) => {
        if (result.status === "passed") return true;
        if (hasOptionalCapabilityGap(result)) return true;
        return result.status === "not_run"
          && result.reasonCode === "prerequisite_lane_incomplete"
          && (result.blockedBy || []).length > 0
          && (result.blockedBy || []).every((blockedLane) => optionalLanes.has(laneKey(result.phaseId, blockedLane)));
      });
      if (onlyOptionalIncomplete) {
        optionalLanes.add(key);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const notRunResults = results.filter((result) => result.status === "not_run");
  const cancelled = results.filter((result) => result.status === "cancelled").length;
  const optionalNotRun = notRunResults.filter((result) => hasOptionalCapabilityGap(result)
    || (result.reasonCode === "prerequisite_lane_incomplete"
      && (result.blockedBy || []).length > 0
      && (result.blockedBy || []).every((blockedLane) => optionalLanes.has(laneKey(result.phaseId, blockedLane))))).length;
  const otherIncomplete = results.length - passed - failed - notRunResults.length - cancelled;

  if (executionCancelled || cancelled > 0) return { status: "cancelled", reasonCode: "runner_cancelled", passed, failed, notRun: notRunResults.length, cancelled: Math.max(1, cancelled), optionalNotRun };
  if (failed > 0 || otherIncomplete > 0 || notRunResults.length !== optionalNotRun || (runnerExitCode !== 0 && (runnerExitCode !== 1 || notRunResults.length === 0)) || passed === 0) {
    return { status: "failed", reasonCode: failed > 0 ? "selected_flow_failed" : "applicable_flow_incomplete", passed, failed, notRun: notRunResults.length, cancelled, optionalNotRun };
  }
  return { status: "passed", passed, failed, notRun: notRunResults.length, cancelled, optionalNotRun };
}

interface ChildExecution {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  durationMs?: number;
  reasonCode?: string;
}

async function executeNodeFlow(args: string[], logPath: string, signal: AbortSignal): Promise<ChildExecution> {
  const file = await fs.open(logPath, "w", 0o600);
  const entry: TestSuiteEntry = {
    id: "local-ci.flow",
    command: process.execPath,
    args: [NODE_SOURCE_CONDITION, ...args]
  };
  try {
    const outcome = await runSuiteProcess(entry, {
      cwd: repoRoot,
      env: sourceNodeEnvironment(),
      signal,
      stdio: ["ignore", file.fd, file.fd]
    });
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      cancelled: signal.aborted || outcome.status === "cancelled",
      ...(Number.isFinite(outcome.durationMs) ? { durationMs: outcome.durationMs } : {}),
      ...(outcome.error ? { reasonCode: "node_process_start_failed" } : {})
    };
  } finally {
    await file.close();
  }
}

async function readJson(filePath: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function gitOutput(args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

function candidateFacts(): Record<string, string | boolean | null> {
  const revision = gitOutput(["rev-parse", "--verify", "HEAD"]);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    revision: revision && /^[a-f0-9]{40,64}$/u.test(revision) ? revision : null,
    workingTree: status.error || status.status !== 0 ? "unknown" : status.stdout.trim() ? "modified" : "clean"
  };
}

function runIdentifier(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
}

function displayPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function saveSanitizedLog(rawLogPath: string, destination: string): Promise<void> {
  const raw = await fs.readFile(rawLogPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await fs.writeFile(destination, sanitizeVerificationLog(raw, repoRoot), { mode: 0o600 });
  await fs.rm(rawLogPath, { force: true });
}

function suiteFlowResults(runnerReport: any, reportPath: string): SuiteResult[] {
  if (!runnerReport || runnerReport.reportLeakScan !== true || !Array.isArray(runnerReport.suites)
    || !Array.isArray(runnerReport.executionProcesses)
    || runnerReport.suites.length !== runnerReport.executionProcesses.length) {
    throw new Error("local_ci_runner_report_invalid");
  }
  return runnerReport.suites.map((result: any) => {
    const status = String(result.status || "unknown");
    const reasonCode = typeof result.reasonCode === "string" ? result.reasonCode
      : status === "failed" ? "command_failed"
        : status === "cancelled" ? "command_cancelled"
          : status === "not_run" ? "not_run_reason_unclassified"
            : status === "passed" ? undefined : "result_unclassified";
    return {
      id: String(result.id || "unknown-suite"),
      childSuiteIds: Array.isArray(result.childSuiteIds) ? result.childSuiteIds.map(String) : [String(result.id || "unknown-suite")],
      status,
      ...(reasonCode ? { reasonCode } : {}),
      ...(typeof result.requiredService === "string" ? { requiredService: result.requiredService } : {}),
      ...(typeof result.notRunReason === "string" ? { notRunReason: result.notRunReason } : {}),
      ...(Array.isArray(result.blockedBy) ? { blockedBy: result.blockedBy.map(String) } : {}),
      ...(typeof result.phaseId === "string" ? { phaseId: result.phaseId } : {}),
      ...(typeof result.laneId === "string" ? { laneId: result.laneId } : {}),
      ...(typeof result.cached === "boolean" ? { cached: result.cached } : {}),
      ...(Number.isFinite(result.durationMs) ? { durationMs: result.durationMs } : {}),
      ...(Number.isInteger(result.exitCode) || result.exitCode === null ? { exitCode: result.exitCode } : {}),
      evidence: [reportPath]
    };
  });
}

async function runTestProfile(profile: string, rawReportPath: string, rawLogPath: string, signal: AbortSignal): Promise<{
  execution: ChildExecution;
  flows: SuiteResult[];
  summary: ReturnType<typeof evaluateEngineeringOutcomes> | null;
  runnerReport?: any;
}> {
  const reportArgument = displayPath(rawReportPath);
  const args = ["tests/run.ts", "--profile", profile, "--continue-on-failure", "--strict-platform", "--report", reportArgument];
  const execution = await executeNodeFlow(args, rawLogPath, signal);
  const runnerReport = await readJson(rawReportPath);
  if (!runnerReport) {
    return { execution, flows: [], summary: null };
  }
  const runnerReportArtifact = path.join(path.dirname(rawLogPath), "test-runner-report.json");
  await writeJsonAtomic(runnerReportArtifact, sanitizeSensitiveReport(runnerReport));
  const flows = suiteFlowResults(runnerReport, displayPath(runnerReportArtifact));
  const summary = evaluateEngineeringOutcomes(flows, execution.exitCode, execution);
  await fs.rm(rawReportPath, { force: true });
  return { execution, flows, summary, runnerReport };
}

async function runReleaseAcceptance(rawLogPath: string, signal: AbortSignal): Promise<{
  execution: ChildExecution;
  flow: SuiteResult;
  profile: string;
}> {
  const definition = await loadReleaseDefinition(repoRoot);
  const profile = String(definition?.acceptance?.profile || "").trim();
  if (!profile) throw new Error("local_ci_release_profile_missing");
  const acceptanceScript = path.join(repoRoot, "tools/server-scripts/verify-platform-acceptance.ts");
  const execution = await executeNodeFlow([
    acceptanceScript,
    "--profile",
    profile
  ], rawLogPath, signal);
  const receiptPath = path.join(repoRoot, "build/reports/accepted-candidate.json");
  const acceptedCandidate = await readJson(receiptPath);
  const passed = execution.exitCode === 0 && !execution.cancelled && acceptedCandidate !== null;
  const flow: SuiteResult = {
    id: "platform-acceptance",
    profile,
    status: execution.cancelled ? "cancelled" : passed ? "passed" : "failed",
    ...(!passed && !execution.cancelled ? { reasonCode: "platform_acceptance_failed" } : {}),
    ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
    ...(passed ? { evidence: ["build/reports/accepted-candidate.json"] } : {})
  };
  return { execution, flow, profile };
}

function currentNativeEnvironment(): Record<string, string> {
  const osName = process.platform === "win32" ? "windows" : process.platform;
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  return {
    os: osName,
    architecture,
    platform: `${osName}/${architecture}`,
    nodeVersion: process.version
  };
}

function helpText(): string {
  return [
    "Meshrix.js local verification",
    "",
    "Usage:",
    "  npm run ci:local",
    "  npm run ci:local -- --scope release",
    "",
    "Options:",
    "  --scope engineering|release  Select ordinary verification or release acceptance preparation.",
    "  --report <repo-relative-path>  Write the structured result to a deterministic path."
  ].join("\n");
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseLocalCiArguments(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const runId = runIdentifier();
  const runDirectory = path.join(repoRoot, "build/local-ci", runId);
  const logDirectory = path.join(runDirectory, "logs");
  const reportRelative = options.reportPath || `build/local-ci/${runId}/results.json`;
  const reportPath = path.resolve(repoRoot, reportRelative);
  const rawLogPath = path.join(runDirectory, ".local-ci-output.raw");
  const rawRunnerReportPath = path.join(runDirectory, ".runner-results.raw.json");
  const sanitizedLogPath = path.join(logDirectory, "verification.log");
  const startedAt = new Date();
  const cancellation = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    receivedSignal = signal;
    cancellation.abort(signal);
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const candidate = candidateFacts();
  let flows: SuiteResult[] = [];
  let execution: ChildExecution | null = null;
  let outcome: ReturnType<typeof evaluateEngineeringOutcomes> | null = null;
  let environmentFacts: any = null;
  let selectedProfile: string | null = options.scope === "engineering" ? DEFAULT_ENGINEERING_PROFILE : null;
  let setupReasonCode: string | null = null;
  const scope = options.scope;
  const startedScope = options.scope;

  try {
    if (scope === "release") {
      const result = await runReleaseAcceptance(rawLogPath, cancellation.signal);
      execution = result.execution;
      flows = [result.flow];
      selectedProfile = result.profile;
      outcome = {
        status: result.flow.status === "cancelled" ? "cancelled" : result.flow.status === "passed" ? "passed" : "failed",
        ...(result.flow.reasonCode ? { reasonCode: result.flow.reasonCode } : {}),
        passed: result.flow.status === "passed" ? 1 : 0,
        failed: result.flow.status === "failed" ? 1 : 0,
        notRun: 0,
        cancelled: result.flow.status === "cancelled" ? 1 : 0,
        optionalNotRun: 0
      };
    } else {
      const profile = DEFAULT_ENGINEERING_PROFILE;
      const result = await runTestProfile(profile, rawRunnerReportPath, rawLogPath, cancellation.signal);
      execution = result.execution;
      flows = result.flows;
      selectedProfile = profile;
      outcome = result.summary;
      if (!result.runnerReport) setupReasonCode = "runner_report_missing";
      if (result.runnerReport?.environment) {
        const observed = result.runnerReport.environment.localExecution;
        environmentFacts = observed ? {
          native: observed.native,
          docker: observed.docker,
          serviceCapabilities: result.runnerReport.environment.serviceCapabilities || {}
        } : { native: currentNativeEnvironment() };
      }
      if (!outcome && execution.cancelled) {
        outcome = { status: "cancelled", reasonCode: "runner_cancelled", passed: 0, failed: 0, notRun: 0, cancelled: 1, optionalNotRun: 0 };
      }
      if (!outcome && !execution.cancelled) {
        outcome = { status: "failed", reasonCode: "runner_report_invalid", passed: 0, failed: 1, notRun: 0, cancelled: 0, optionalNotRun: 0 };
      }
    }
  } catch {
    setupReasonCode = "local_ci_setup_failed";
    if (cancellation.signal.aborted) {
      outcome = { status: "cancelled", reasonCode: "runner_cancelled", passed: 0, failed: 0, notRun: 0, cancelled: 1, optionalNotRun: 0 };
    } else {
      outcome = { status: "failed", reasonCode: setupReasonCode, passed: 0, failed: 1, notRun: 0, cancelled: 0, optionalNotRun: 0 };
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    try {
      await fs.rm(rawRunnerReportPath, { force: true });
    } catch {
      setupReasonCode = "raw_report_cleanup_failed";
      outcome = { status: "failed", reasonCode: setupReasonCode, passed: 0, failed: 1, notRun: 0, cancelled: 0, optionalNotRun: 0 };
    }
    try {
      await saveSanitizedLog(rawLogPath, sanitizedLogPath);
    } catch {
      setupReasonCode = "log_sanitization_failed";
      outcome = { status: "failed", reasonCode: setupReasonCode, passed: 0, failed: 1, notRun: 0, cancelled: 0, optionalNotRun: 0 };
      await fs.rm(rawLogPath, { force: true });
    }
  }

  const finishedAt = new Date();
  const finalSummary = outcome || {
    status: "failed" as const,
    reasonCode: "result_summary_missing",
    passed: 0,
    failed: 1,
    notRun: 0,
    cancelled: 0,
    optionalNotRun: 0
  };
  const report = {
    schemaVersion: "meshrix:local-ci-result:1",
    verifier: "tools/scripts/local-ci.ts",
    runId,
    scope: startedScope,
    profile: selectedProfile,
    candidate,
    executor: { runtime: "node", version: process.version },
    environment: environmentFacts || { native: currentNativeEnvironment() },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    runner: execution ? {
      exitCode: execution.exitCode,
      signal: execution.signal,
      cancelled: execution.cancelled,
      ...(execution.reasonCode ? { reasonCode: execution.reasonCode } : {}),
      ...(receivedSignal ? { receivedSignal } : {})
    } : null,
    summary: {
      ...finalSummary,
      applicableScopeReady: finalSummary.status === "passed",
      coverageReady: finalSummary.status === "passed" && finalSummary.notRun === 0
    },
    flows: flows.map((flow) => ({
      ...flow,
      ...(flow.evidence ? { evidence: flow.evidence } : { evidence: [displayPath(sanitizedLogPath)] })
    })),
    logs: [displayPath(sanitizedLogPath)],
    ...(setupReasonCode ? { setupReasonCode } : {})
  };
  assertNoLeak(report, "local ci report");
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(`[local-ci] ${finalSummary.status}; ${displayPath(reportPath)}\n`);
  process.exitCode = finalSummary.status === "passed" ? 0
    : finalSummary.status === "cancelled" ? receivedSignal === "SIGTERM" ? 143 : 130
      : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("[local-ci] local_ci_setup_failed\n");
    process.exitCode = 1;
  });
}
