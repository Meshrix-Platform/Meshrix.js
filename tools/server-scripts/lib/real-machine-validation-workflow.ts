import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensurePrivateDir,
  writePrivateFileAtomic,
} from "../../../packages/foundation/src/storage/private-file-atomic.ts";
import {
  assertNoSensitiveReportLeak,
  reportPayloadDigest,
} from "./sensitive-report-scan.ts";

export const REAL_MACHINE_VALIDATION_SCHEMA: any =
  "v0.0.1:meshrix:real-machine-validation-state-1";
export const REAL_MACHINE_PHASE_RECEIPT_SCHEMA: any =
  "v0.0.1:meshrix:real-machine-validation-phase-receipt-1";
export const REAL_MACHINE_REDUCED_RECEIPT_SCHEMA: any =
  "v0.0.1:meshrix:real-machine-validation-receipt-1";
export const REAL_MACHINE_VALIDATION_PHASES: readonly any[] = Object.freeze([
  "prepare",
  "start",
  "verify",
  "stop",
  "cleanup",
  "reduce",
]);
export const REAL_MACHINE_OPERATIONAL_PHASES: any = Object.freeze(
  REAL_MACHINE_VALIDATION_PHASES.filter((phase?: any) : any => phase !== "reduce"),
);
export const REAL_MACHINE_VALIDATION_TARGETS: Readonly<Record<string, any>> = Object.freeze({
  "native-linux-x64": Object.freeze({
    platform: "linux",
    architectures: Object.freeze(["x64"]),
  }),
  "native-linux-arm64": Object.freeze({
    platform: "linux",
    architectures: Object.freeze(["arm64"]),
  }),
  "native-macos-arm64": Object.freeze({
    platform: "darwin",
    architectures: Object.freeze(["arm64"]),
  }),
  "native-windows-x64": Object.freeze({
    platform: "win32",
    architectures: Object.freeze(["x64"]),
  }),
  "public-cloud-single-node": Object.freeze({
    platform: "linux",
    architectures: Object.freeze(["x64", "arm64"]),
  }),
  "clean-host-recovery": Object.freeze({
    platform: "linux",
    architectures: Object.freeze(["x64", "arm64"]),
  }),
});
export const REAL_MACHINE_TARGET_COMMAND_MANIFESTS: any = Object.freeze(
  Object.fromEntries(Object.keys(REAL_MACHINE_VALIDATION_TARGETS).map((target?: any) : any => [
    target,
    `tools/server-scripts/real-machine-targets/${target}.commands.json`,
  ])),
);

const SAFE_ID_PATTERN: any = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SHA256_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const GIT_COMMIT_PATTERN: any = /^[a-f0-9]{40}$/u;
const SAFE_CHECK_KEY_PATTERN: any = /^[a-z][a-zA-Z0-9]{0,63}$/u;
const STATE_FILE: any = "state.json";
const REDUCED_RECEIPT_FILE: any = "receipt.json";
const DEFAULT_LOCK_TIMEOUT_MS: any = 5_000;
const DEFAULT_STALE_LOCK_MS: any = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS: any = 15 * 60_000;

function workflowError(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

function requireCondition(condition?: any, code?: any) : any {
  if (!condition) throw workflowError(code);
}

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha256(value?: any) : any {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalValue(value?: any) : any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key?: any) : any => [key, canonicalValue(value[key])]),
  );
}

function canonicalDigest(value?: any) : any {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function safeId(value?: any, code?: any) : any {
  const normalized: any = String(value || "").trim();
  requireCondition(SAFE_ID_PATTERN.test(normalized), code);
  return normalized;
}

export function normalizeCandidateDigest(value?: any) : any {
  const normalized: any = String(value || "").trim();
  requireCondition(
    SHA256_PATTERN.test(normalized),
    "real_machine_candidate_digest_invalid",
  );
  return normalized;
}

export function validateRealMachineTarget({
  target,
  architecture,
  runtimePlatform = process.platform,
  runtimeArchitecture = process.arch,
}: Record<string, any> = {}) : any {
  const selectedTarget: any = String(target || "").trim();
  const contract: any = REAL_MACHINE_VALIDATION_TARGETS[selectedTarget];
  requireCondition(contract, "real_machine_target_invalid");
  const selectedArchitecture: any = String(architecture || "").trim();
  requireCondition(
    contract.architectures.includes(selectedArchitecture),
    "real_machine_architecture_invalid",
  );
  requireCondition(
    runtimePlatform === contract.platform,
    "real_machine_runtime_platform_mismatch",
  );
  requireCondition(
    runtimeArchitecture === selectedArchitecture,
    "real_machine_runtime_architecture_mismatch",
  );
  return Object.freeze({
    target: selectedTarget,
    platform: contract.platform,
    architecture: selectedArchitecture,
  });
}

export async function validateFunctionalPlatformAcceptanceReport(
  reportPath?: any,
  { candidateDigest = "", currentSourceRevision = "" }: Record<string, any> = {},
) : Promise<any> {
  const selectedPath: any = String(reportPath || "").trim();
  requireCondition(
    path.isAbsolute(selectedPath),
    "real_machine_functional_report_path_invalid",
  );
  const stat: any = await fs.lstat(selectedPath).catch(() : any => null);
  requireCondition(
    stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024,
    "real_machine_functional_report_unavailable",
  );
  const bytes: any = await fs.readFile(selectedPath);
  let report: any;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw workflowError("real_machine_functional_report_invalid");
  }
  requireCondition(
    report?.schemaVersion === "v0.0.1:acceptance:platform-report-2" &&
      report?.acceptanceStandard === "functional-completeness" &&
      report?.claim === "functional-complete" &&
      report?.status === "accepted" &&
      report?.selectedProfile === "enterprise-single-node" &&
      report?.summary?.releaseReady === true &&
      report?.summary?.reportLeakScan === true,
    "real_machine_functional_acceptance_required",
  );
  assertNoSensitiveReportLeak(report, "functional platform acceptance report");

  if (candidateDigest) normalizeCandidateDigest(candidateDigest);
  const selectedRevision: any = String(currentSourceRevision || "").trim();
  requireCondition(
    GIT_COMMIT_PATTERN.test(selectedRevision),
    "real_machine_checkout_source_revision_invalid",
  );
  requireCondition(
    GIT_COMMIT_PATTERN.test(String(report.sourceRevision || "")),
    "real_machine_functional_source_revision_missing",
  );
  requireCondition(
    report.sourceRevision === selectedRevision,
    "real_machine_functional_source_revision_mismatch",
  );
  return Object.freeze({
    reportDigest: sha256(bytes),
    sourceRevision: selectedRevision,
  });
}

async function currentGitRevision(cwd: any = process.cwd()) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: any[] = [];
    let bytes: any = 0;
    child.stdout.on("data", (chunk?: any) : any => {
      bytes += chunk.length;
      if (bytes <= 256) chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode?: any) : any => {
      const revision: any = Buffer.concat(chunks).toString("utf8").trim();
      if (exitCode !== 0 || bytes > 256 || !GIT_COMMIT_PATTERN.test(revision)) {
        reject(workflowError("real_machine_checkout_source_revision_invalid"));
      } else {
        resolve(revision);
      }
    });
  });
}

function runPaths(stateRoot?: any, runId?: any) : any {
  requireCondition(
    typeof stateRoot === "string" && path.isAbsolute(stateRoot),
    "real_machine_state_root_invalid",
  );
  const selectedRunId: any = safeId(runId, "real_machine_run_id_invalid");
  const root: any = path.resolve(stateRoot);
  const runRoot: any = path.join(root, selectedRunId);
  return Object.freeze({
    root,
    runRoot,
    state: path.join(runRoot, STATE_FILE),
    reducedReceipt: path.join(runRoot, REDUCED_RECEIPT_FILE),
    lock: path.join(root, `.${selectedRunId}.lock`),
    phaseReceipt(phase?: any) : any {
      return path.join(runRoot, `${phase}.json`);
    },
  });
}

async function readJson(filePath?: any, missingCode?: any) : Promise<any> {
  let text: any;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") throw workflowError(missingCode);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw workflowError("real_machine_state_corrupt");
  }
}

async function writeJsonAtomic(filePath?: any, value?: any) : Promise<any> {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function withRunLock(
  paths?: any,
  action?: any,
  {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    now = () : any => Date.now(),
  }: Record<string, any> = {},
) : Promise<any> {
  ensurePrivateDir(paths.root);
  const token: any = crypto.randomBytes(24).toString("hex");
  const startedAt: any = now();
  while (true) {
    let handle: any;
    try {
      handle = await fs.open(paths.lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
      await handle.sync();
      await handle.close();
      break;
    } catch (error: any) {
      await handle?.close().catch(() : any => {});
      if (error?.code !== "EEXIST") throw error;
      const stat: any = await fs.stat(paths.lock).catch(() : any => null);
      if (stat && now() - stat.mtimeMs >= staleLockMs) {
        await fs.rm(paths.lock, { force: true });
        continue;
      }
      if (now() - startedAt >= lockTimeoutMs) {
        throw workflowError("real_machine_run_lock_held");
      }
      await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
    }
  }
  try {
    return await action();
  } finally {
    const lock: any = await fs.readFile(paths.lock, "utf8")
      .then(JSON.parse)
      .catch(() : any => null);
    if (lock?.token === token) await fs.rm(paths.lock, { force: true });
  }
}

function validateChecks(value?: any) : any {
  const checks: any = asRecord(value);
  const entries: any = (Object.entries(checks) as [string, any][]);
  requireCondition(entries.length <= 128, "real_machine_command_checks_invalid");
  for (const [key, result] of entries) {
    requireCondition(
      SAFE_CHECK_KEY_PATTERN.test(key) && typeof result === "boolean",
      "real_machine_command_checks_invalid",
    );
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left]: any[], [right]: any[]) : any =>
    left.localeCompare(right))));
}

function normalizedRunnerResult(result: Record<string, any> = {}) : any {
  const selected: any = asRecord(result);
  return Object.freeze({
    exitCode: Number.isInteger(selected.exitCode) ? selected.exitCode : 1,
    timedOut: selected.timedOut === true,
    durationMs: Number.isFinite(Number(selected.durationMs))
      ? Math.max(0, Math.floor(Number(selected.durationMs)))
      : 0,
    checks: validateChecks(selected.checks),
  });
}

function validateCommandSpec(spec: Record<string, any> = {}) : any {
  const selected: any = asRecord(spec);
  requireCondition(
    typeof selected.executable === "string" &&
      selected.executable.trim() &&
      selected.executable.length <= 1024,
    "real_machine_command_invalid",
  );
  requireCondition(
    Array.isArray(selected.args) &&
      selected.args.length <= 256 &&
      selected.args.every((item?: any) : any => typeof item === "string" && item.length <= 8192),
    "real_machine_command_invalid",
  );
  const timeoutMs: any = selected.timeoutMs === undefined
    ? DEFAULT_COMMAND_TIMEOUT_MS
    : Number(selected.timeoutMs);
  requireCondition(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60 * 60_000,
    "real_machine_command_timeout_invalid",
  );
  return Object.freeze({
    executable: selected.executable,
    args: Object.freeze([...selected.args]),
    timeoutMs,
    env: asRecord(selected.env),
    cwd: typeof selected.cwd === "string" && selected.cwd ? selected.cwd : undefined,
  });
}

export function createProcessCommandRunner({
  commands = {},
  baseEnv = process.env,
  cwd = process.cwd(),
  now = () : any => Date.now(),
}: Record<string, any> = {}) : any {
  const commandByPhase: any = Object.fromEntries(
    REAL_MACHINE_OPERATIONAL_PHASES.map((phase?: any) : any => [
      phase,
      commands[phase] ? validateCommandSpec(commands[phase]) : null,
    ]),
  );
  return async ({ phase, context = {} }: Record<string, any>) : Promise<any> => {
    const command: any = commandByPhase[phase];
    requireCondition(command, `real_machine_${phase}_command_missing`);
    const startedAt: any = now();
    const selectedContext: any = asRecord(context);
    const contextEnv: Record<string, any> = {
      MESHRIX_REAL_MACHINE_TARGET: String(selectedContext.target || ""),
      MESHRIX_REAL_MACHINE_PLATFORM: String(selectedContext.platform || ""),
      MESHRIX_REAL_MACHINE_ARCHITECTURE: String(selectedContext.architecture || ""),
      MESHRIX_REAL_MACHINE_CANDIDATE_DIGEST: String(
        selectedContext.candidateDigest || "",
      ),
      MESHRIX_REAL_MACHINE_SOURCE_REVISION: String(
        selectedContext.sourceRevision || "",
      ),
      MESHRIX_REAL_MACHINE_RUN_ID: String(selectedContext.runId || ""),
      MESHRIX_REAL_MACHINE_ENVIRONMENT_ID: String(
        selectedContext.environmentId || "",
      ),
    };
    return new Promise((resolve?: any, reject?: any) : any => {
      const child: any = spawn(command.executable, command.args, {
        cwd: command.cwd || cwd,
        env: { ...baseEnv, ...command.env, ...contextEnv },
        stdio: "ignore",
        windowsHide: true,
      });
      let timedOut: any = false;
      let forceTimer: any;
      const timer: any = setTimeout(() : any => {
        timedOut = true;
        child.kill("SIGTERM");
        forceTimer = setTimeout(() : any => child.kill("SIGKILL"), 5_000);
        forceTimer.unref?.();
      }, command.timeoutMs);
      timer.unref?.();
      child.once("error", (error?: any) : any => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        reject(error);
      });
      child.once("close", (exitCode?: any) : any => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        resolve({
          exitCode: Number.isInteger(exitCode) ? exitCode : 1,
          timedOut,
          durationMs: Math.max(0, now() - startedAt),
          checks: {},
        });
      });
    });
  };
}

function validateState(state?: any, expectedRunId: any = "") : any {
  requireCondition(
    state?.schemaVersion === REAL_MACHINE_VALIDATION_SCHEMA &&
      SAFE_ID_PATTERN.test(String(state.runId || "")) &&
      SAFE_ID_PATTERN.test(String(state.environmentId || "")) &&
      SHA256_PATTERN.test(String(state.candidateDigest || "")) &&
      SHA256_PATTERN.test(String(state.functionalAcceptanceDigest || "")) &&
      GIT_COMMIT_PATTERN.test(String(state.sourceRevision || "")) &&
      REAL_MACHINE_VALIDATION_TARGETS[state.target]?.architectures.includes(
        state.architecture,
      ) &&
      asRecord(state.phases),
    "real_machine_state_invalid",
  );
  if (expectedRunId) {
    requireCondition(state.runId === expectedRunId, "real_machine_state_run_mismatch");
  }
  return state;
}

function phasePrerequisiteReady(state?: any, phase?: any) : any {
  const passed: any = (selectedPhase?: any) : any => state.phases?.[selectedPhase]?.status === "passed";
  if (phase === "start") return passed("prepare") && !passed("stop");
  if (phase === "verify") return passed("start") && !passed("stop");
  if (phase === "stop") return passed("prepare");
  if (phase === "cleanup") return passed("stop");
  return phase === "prepare";
}

function phaseReceiptFacts({ state, phase, result, recordedAt }: Record<string, any>) : any {
  const facts: Record<string, any> = {
    schemaVersion: REAL_MACHINE_PHASE_RECEIPT_SCHEMA,
    runId: state.runId,
    environmentId: state.environmentId,
    target: state.target,
    platform: state.platform,
    architecture: state.architecture,
    candidateDigest: state.candidateDigest,
    functionalAcceptanceDigest: state.functionalAcceptanceDigest,
    sourceRevision: state.sourceRevision,
    phase,
    status: result.exitCode === 0 && result.timedOut !== true ? "passed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    checks: result.checks,
    recordedAt,
  };
  return Object.freeze({
    ...facts,
    receiptDigest: canonicalDigest(facts),
  });
}

function verifyPhaseReceipt(receipt?: any, state?: any, phase?: any) : any {
  const { receiptDigest, ...facts } = asRecord(receipt);
  requireCondition(
    receipt?.schemaVersion === REAL_MACHINE_PHASE_RECEIPT_SCHEMA &&
      receipt?.runId === state.runId &&
      receipt?.environmentId === state.environmentId &&
      receipt?.target === state.target &&
      receipt?.platform === state.platform &&
      receipt?.architecture === state.architecture &&
      receipt?.candidateDigest === state.candidateDigest &&
      receipt?.functionalAcceptanceDigest === state.functionalAcceptanceDigest &&
      receipt?.sourceRevision === state.sourceRevision &&
      receipt?.phase === phase &&
      SHA256_PATTERN.test(String(receiptDigest || "")) &&
      canonicalDigest(facts) === receiptDigest,
    "real_machine_phase_receipt_invalid",
  );
  return receipt;
}

async function existingPassedReceipt(paths?: any, state?: any, phase?: any) : Promise<any> {
  if (state.phases?.[phase]?.status !== "passed") return null;
  const receipt: any = await readJson(
    paths.phaseReceipt(phase),
    "real_machine_phase_receipt_missing",
  );
  verifyPhaseReceipt(receipt, state, phase);
  requireCondition(
    state.phases[phase].receiptDigest === receipt.receiptDigest,
    "real_machine_phase_receipt_state_mismatch",
  );
  return receipt;
}

function publicRunProjection(value?: any) : any {
  return Object.freeze({
    status: value.status,
    phase: value.phase,
    target: value.target,
    architecture: value.architecture,
    candidateDigest: value.candidateDigest,
    receiptDigest: value.receiptDigest,
    idempotent: value.idempotent === true,
  });
}

export function createRealMachineValidationWorkflow({
  stateRoot,
  runId,
  environmentId,
  target,
  architecture,
  candidateDigest,
  functionalAcceptanceReportPath,
  currentSourceRevision = "",
  runtimePlatform = process.platform,
  runtimeArchitecture = process.arch,
  commandRunner,
  clock = () : any => new Date(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
}: Record<string, any> = {}) : any {
  const selectedRunId: any = safeId(runId, "real_machine_run_id_invalid");
  const paths: any = runPaths(stateRoot, selectedRunId);
  const runner: any = commandRunner;
  const nowIso: any = () : any => {
    const value: any = clock();
    const date: any = value instanceof Date ? value : new Date(value);
    requireCondition(
      Number.isFinite(date.getTime()),
      "real_machine_clock_invalid",
    );
    return date.toISOString();
  };

  async function loadState() : Promise<any> {
    return validateState(
      await readJson(paths.state, "real_machine_state_missing"),
      selectedRunId,
    );
  }

  async function executeOperationalPhase(phase?: any) : Promise<any> {
    requireCondition(
      REAL_MACHINE_OPERATIONAL_PHASES.includes(phase),
      "real_machine_phase_invalid",
    );
    return withRunLock(paths, async () : Promise<any> => {
      let state: any;
      if (phase === "prepare") {
        const existing: any = await fs.access(paths.state).then(() : any => true, () : any => false);
        if (existing) {
          state = await loadState();
          const receipt: any = await existingPassedReceipt(paths, state, phase);
          if (receipt) return publicRunProjection({ ...receipt, idempotent: true });
          throw workflowError("real_machine_run_already_initialized");
        }
        const selectedCandidate: any = normalizeCandidateDigest(candidateDigest);
        const selectedEnvironmentId: any = safeId(
          environmentId,
          "real_machine_environment_id_invalid",
        );
        const selectedTarget: any = validateRealMachineTarget({
          target,
          architecture,
          runtimePlatform,
          runtimeArchitecture,
        });
        const functional: any = await validateFunctionalPlatformAcceptanceReport(
          functionalAcceptanceReportPath,
          {
            candidateDigest: selectedCandidate,
            currentSourceRevision: currentSourceRevision ||
              await currentGitRevision(process.cwd()),
          },
        );
        ensurePrivateDir(paths.runRoot);
        state = {
          schemaVersion: REAL_MACHINE_VALIDATION_SCHEMA,
          runId: selectedRunId,
          environmentId: selectedEnvironmentId,
          target: selectedTarget.target,
          platform: selectedTarget.platform,
          architecture: selectedTarget.architecture,
          candidateDigest: selectedCandidate,
          functionalAcceptanceDigest: functional.reportDigest,
          sourceRevision: functional.sourceRevision,
          phases: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        await writeJsonAtomic(paths.state, state);
      } else {
        state = await loadState();
        const receipt: any = await existingPassedReceipt(paths, state, phase);
        if (receipt) return publicRunProjection({ ...receipt, idempotent: true });
        requireCondition(
          state.phases?.[phase]?.status !== "failed",
          "real_machine_phase_previously_failed",
        );
        requireCondition(
          phasePrerequisiteReady(state, phase),
          "real_machine_phase_prerequisite_missing",
        );
      }

      requireCondition(
        typeof runner === "function",
        "real_machine_command_runner_required",
      );
      let result: any;
      try {
        result = normalizedRunnerResult(await runner({
          phase,
          context: Object.freeze({
            runId: state.runId,
            environmentId: state.environmentId,
            target: state.target,
            platform: state.platform,
            architecture: state.architecture,
            candidateDigest: state.candidateDigest,
            sourceRevision: state.sourceRevision,
          }),
        }));
      } catch {
        result = normalizedRunnerResult({ exitCode: 1, checks: {} });
      }
      const receipt: any = phaseReceiptFacts({
        state,
        phase,
        result,
        recordedAt: nowIso(),
      });
      assertNoSensitiveReportLeak(receipt, `real machine ${phase} receipt`);
      await writeJsonAtomic(paths.phaseReceipt(phase), receipt);
      state.phases[phase] = {
        status: receipt.status,
        receiptDigest: receipt.receiptDigest,
      };
      state.updatedAt = nowIso();
      await writeJsonAtomic(paths.state, state);
      requireCondition(
        receipt.status === "passed",
        `real_machine_${phase}_failed`,
      );
      return publicRunProjection(receipt);
    }, {
      lockTimeoutMs,
      staleLockMs,
    });
  }

  async function reduce() : Promise<any> {
    return withRunLock(paths, async () : Promise<any> => {
      const state: any = await loadState();
      const existing: any = await fs.access(paths.reducedReceipt)
        .then(() : any => true, () : any => false);
      if (existing) {
        const receipt: any = await readJson(
          paths.reducedReceipt,
          "real_machine_reduced_receipt_missing",
        );
        assertNoSensitiveReportLeak(receipt, "real machine reduced receipt");
        return Object.freeze({ ...receipt, idempotent: true });
      }
      const phaseReceiptDigests: Record<string, any> = {};
      for (const phase of REAL_MACHINE_OPERATIONAL_PHASES) {
        requireCondition(
          state.phases?.[phase]?.status === "passed",
          "real_machine_reduction_phase_missing",
        );
        const receipt: any = verifyPhaseReceipt(
          await readJson(
            paths.phaseReceipt(phase),
            "real_machine_phase_receipt_missing",
          ),
          state,
          phase,
        );
        requireCondition(
          receipt.receiptDigest === state.phases[phase].receiptDigest,
          "real_machine_phase_receipt_state_mismatch",
        );
        phaseReceiptDigests[phase] = receipt.receiptDigest;
      }
      const executionDigest: any = canonicalDigest({
        runId: state.runId,
        environmentId: state.environmentId,
        target: state.target,
        architecture: state.architecture,
        candidateDigest: state.candidateDigest,
        functionalAcceptanceDigest: state.functionalAcceptanceDigest,
        sourceRevision: state.sourceRevision,
        phaseReceiptDigests,
      });
      const facts: Record<string, any> = {
        schemaVersion: REAL_MACHINE_REDUCED_RECEIPT_SCHEMA,
        acceptanceStandard: "real-machine-validation",
        claim: "real-machine-verified",
        status: "accepted",
        target: state.target,
        platform: state.platform,
        architecture: state.architecture,
        candidateDigest: state.candidateDigest,
        functionalAcceptanceDigest: state.functionalAcceptanceDigest,
        sourceRevision: state.sourceRevision,
        functionalCompletenessRequired: true,
        optionalForFunctionalRelease: true,
        phaseReceiptDigests,
        executionDigest,
        reducedAt: nowIso(),
        privacySafe: true,
        reportLeakScan: true,
      };
      const reduced: Record<string, any> = {
        ...facts,
        receiptDigest: reportPayloadDigest(facts),
      };
      assertNoSensitiveReportLeak(reduced, "real machine reduced receipt");
      await writeJsonAtomic(paths.reducedReceipt, reduced);
      state.phases.reduce = {
        status: "passed",
        receiptDigest: reduced.receiptDigest,
      };
      state.updatedAt = nowIso();
      await writeJsonAtomic(paths.state, state);
      return Object.freeze(reduced);
    }, {
      lockTimeoutMs,
      staleLockMs,
    });
  }

  async function run() : Promise<any> {
    const completed: any[] = [];
    try {
      for (const phase of ["prepare", "start", "verify"]) {
        completed.push(await executeOperationalPhase(phase));
      }
    } catch (error: any) {
      const state: any = await loadState().catch(() : any => null);
      if (state?.phases?.start &&
          state?.phases?.stop?.status !== "passed") {
        await executeOperationalPhase("stop").catch(() : any => {});
      }
      const stoppedState: any = await loadState().catch(() : any => null);
      if (stoppedState?.phases?.stop?.status === "passed" &&
          stoppedState?.phases?.cleanup?.status !== "passed") {
        await executeOperationalPhase("cleanup").catch(() : any => {});
      }
      throw error;
    }
    completed.push(await executeOperationalPhase("stop"));
    completed.push(await executeOperationalPhase("cleanup"));
    const receipt: any = await reduce();
    return Object.freeze({ completed: Object.freeze(completed), receipt });
  }

  return Object.freeze({
    prepare: () : any => executeOperationalPhase("prepare"),
    start: () : any => executeOperationalPhase("start"),
    verify: () : any => executeOperationalPhase("verify"),
    stop: () : any => executeOperationalPhase("stop"),
    cleanup: () : any => executeOperationalPhase("cleanup"),
    reduce,
    run,
    execute(phase?: any) : any {
      return phase === "reduce"
        ? reduce()
        : phase === "run"
          ? run()
          : executeOperationalPhase(phase);
    },
  });
}
