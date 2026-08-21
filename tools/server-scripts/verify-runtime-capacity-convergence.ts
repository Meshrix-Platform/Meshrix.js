#!/usr/bin/env node
/*
 * Runtime capacity and concurrency convergence verifier.
 *
 * Every focused stage (cap-00 through cap-18) has a deterministic oracle:
 * repeated synthetic workloads produce identical counters, conformance
 * results never certify capacity, reports contain only bounded privacy-safe
 * counters and reason codes, and each migration removes the superseded path
 * once. Capacity certification is reserved for the immutable profile gate.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertConformanceNeverCertifies,
  replayCatalogDeterminism,
  RUNTIME_CAPACITY_WORKLOAD_CATALOG,
  runOpenLoopWorkload
} from "../../tools/verifiers/runtime-capacity-workload-catalog.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier: any = "tools/server-scripts/verify-runtime-capacity-convergence.ts";
const REPORT_DIR: any = "build/reports/runtime-capacity-convergence";
const REPORT_RELATIVE_PATH: any = `${REPORT_DIR}/convergence.json`;
const REPORT_SCHEMA_VERSION: any = "v0.0.1:runtime:capacity-convergence-report-1";
const STAGE_RECEIPT_SCHEMA_VERSION: any = "v0.0.1:runtime:capacity-stage-receipt-1";
const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";

const STAGE_REGISTRY: readonly any[] = Object.freeze([
  "cap-00",
  "cap-01",
  "cap-02",
  "cap-03",
  "cap-04",
  "cap-05",
  "cap-06a",
  "cap-06b",
  "cap-07",
  "cap-08",
  "cap-09",
  "cap-10a",
  "cap-10b",
  "cap-11",
  "cap-12",
  "cap-13-queue",
  "cap-13-evidence",
  "cap-13-authorization",
  "cap-13-measured",
  "cap-14a",
  "cap-14b",
  "cap-14c",
  "cap-15",
  "cap-16",
  "cap-17",
  "cap-18-migrations",
  "cap-18-profile",
  "cap-18-contract",
  "cap-18",
  "pactium-release"
]);

/* M7 profile drivers are declared-environment capacity drivers, not small
 * correctness fixtures; they stay and their certification is governed by the
 * CAP-18 immutable profile gate. */
const CAPACITY_NAME_ALLOWLIST: readonly any[] = Object.freeze([
  "tools/server-scripts/verify-runtime-capacity-convergence.ts",
  "tools/verifiers/runtime-capacity-workload-catalog.ts",
  "tests/vitest/server/runtime-capacity-catalog-conformance.test.ts",
  "tests/vitest/server/external-gateway-plugin.test.ts",
  "tests/vitest/server/runtime-capacity-work-queue-dispatch-conformance.test.ts",
  "tests/vitest/server/runtime-capacity-execution-fence-conformance.test.ts",
  "tests/vitest/server/runtime-capacity-fair-claim-conformance.test.ts",
  "tests/vitest/server/runtime-capacity-retention-conformance.test.ts",
  "tools/server-scripts/verify-m7-ha-capacity.ts",
  "tools/server-scripts/verify-m7-scale-capacity.ts",
  "tools/server-scripts/verify-m7-regional-dr-capacity.ts",
  "tools/server-scripts/lib/ha-profile-capacity-child.ts",
  "tools/server-scripts/lib/scale-profile-capacity-child.ts"
]);

const CONFORMANCE_REPORT_PATHS: readonly any[] = Object.freeze([
  "build/reports/job-work-queue-ceiling-conformance.json",
  "build/reports/runtime-refactor-convergence/convergence.json"
]);

const FOCUSED_SUITES_BY_STAGE: Readonly<Record<string, readonly any[]>> = Object.freeze({
  "cap-00": Object.freeze([
    "tests/vitest/server/runtime-capacity-catalog-conformance.test.ts"
  ]),
  "cap-01": Object.freeze([
    "tests/vitest/server/external-gateway-plugin.test.ts"
  ]),
  "cap-02": Object.freeze([
    "tests/vitest/server/runtime-capacity-work-queue-dispatch-conformance.test.ts"
  ]),
  "cap-03": Object.freeze([
    "tests/vitest/server/runtime-capacity-execution-fence-conformance.test.ts"
  ]),
  "cap-04": Object.freeze([
    "tests/vitest/server/runtime-capacity-fair-claim-conformance.test.ts"
  ]),
  "cap-05": Object.freeze([
    "tests/vitest/server/runtime-capacity-retention-conformance.test.ts"
  ]),
  "cap-06a": Object.freeze([
    "tests/vitest/server/http-server-lifecycle-lock-safety.test.ts",
    "tests/vitest/server/operation-dispatch-locking.test.ts"
  ]),
  "cap-06b": Object.freeze([
    "tests/vitest/server/http-request-body-admission.test.ts"
  ]),
  "cap-07": Object.freeze([
    "tests/vitest/server/runtime-event-bus-conformance.test.ts",
    "tests/vitest/server/protocol-event-bus-subscription-and-persistence.test.ts",
    "tests/vitest/server/protocol-event-bus-recovery-and-backpressure.test.ts"
  ]),
  "cap-08": Object.freeze([
    "tests/vitest/server/runtime-lock-manager-conformance.test.ts",
    "tests/vitest/server/lock-manager.test.ts"
  ])
});

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function readTextIfExists(relativePath?: any) : Promise<any> {
  try {
    return await readText(relativePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJsonIfExists(relativePath?: any) : Promise<any> {
  const text: any = await readTextIfExists(relativePath);
  if (!text) return null;
  return JSON.parse(text);
}

async function exists(relativePath?: any) : Promise<any> {
  try {
    await fs.stat(repoPath(relativePath));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findPactiumRoot() : Promise<any> {
  const searchRoot: any = path.resolve(repoRoot, "../..");
  const matches: any[] = [];
  for (const owner of await fs.readdir(searchRoot, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
    const ownerPath: any = path.join(searchRoot, owner.name);
    for (const project of await fs.readdir(ownerPath, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const candidate: any = path.join(ownerPath, project.name);
      try {
        const manifest: any = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
        if (manifest.name === "pactium") matches.push(candidate);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  assert.strictEqual(matches.length, 1, "exactly one sibling package with identity pactium is required");
  return matches[0];
}

async function readPactiumText(relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(await findPactiumRoot(), relativePath), "utf8");
}

function runPactiumTest(relativePath?: any) : any {
  return findPactiumRoot().then((pactiumRoot?: any) : any => {
    const result: any = runCommand(process.execPath, ["--test", relativePath], { cwd: pactiumRoot });
    assert.strictEqual(result.status, 0, `Pactium focused suite failed (${relativePath})\n${result.stdout}\n${result.stderr}`);
    return { suite: relativePath, passed: true, exitCode: result.status, outputBytes: Buffer.byteLength(result.stdout + result.stderr) };
  });
}

function finiteCount(value?: any) : any {
  const number: any = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function runCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const result: any = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source",
      ...(options.env || {})
    }
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

async function runFocusedSuites(stage: any = "") : Promise<any> {
  const suites: any[] = [];
  for (const suitePath of FOCUSED_SUITES_BY_STAGE[stage] || []) {
    const result: any = runCommand(process.execPath, [
      "--conditions=source",
      VITEST_RUNNER,
      "run",
      "--config",
      "vitest.config.ts",
      suitePath
    ]);
    const passed: any = result.status === 0;
    suites.push({
      suite: suitePath,
      passed,
      exitCode: result.status,
      outputBytes: Buffer.byteLength(result.stdout + result.stderr, "utf8")
    });
    assert.ok(passed, `Focused suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  }
  return suites;
}

async function collectFiles(relativeRoot?: any) : Promise<any> {
  const files: any[] = [];
  const pending: any[] = [relativeRoot];
  while (pending.length > 0) {
    const current: any = pending.pop();
    const entries: any = await fs.readdir(repoPath(current), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath: any = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".git"].includes(entry.name)) continue;
        pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

const MISLEADING_FIXTURE_NAME_PATTERN: any = /(?:^|[._-])capacity(?:[._-]|$)/iu;

async function misleadingFixtureNameFindings() : Promise<any> {
  const findings: any[] = [];
  const roots: any[] = [
    "tests/vitest",
    "tools/server-scripts",
    "tools/verifiers"
  ];
  for (const root of roots) {
    for (const relativePath of await collectFiles(root)) {
      if (!/(?:\.test\.ts|\.ts)$/u.test(relativePath)) continue;
      const basename: any = path.basename(relativePath);
      if (!MISLEADING_FIXTURE_NAME_PATTERN.test(basename)) continue;
      if (CAPACITY_NAME_ALLOWLIST.includes(relativePath)) continue;
      findings.push(relativePath);
    }
  }
  return findings;
}

async function conformanceCertificationFindings() : Promise<any> {
  const findings: any[] = [];
  for (const relativePath of CONFORMANCE_REPORT_PATHS) {
    const report: any = await readJsonIfExists(relativePath);
    if (!report) continue;
    if (report.capacityCertified === true) {
      findings.push(`${relativePath}:capacityCertified-true`);
    }
    if (report.summary && report.summary.capacityCertified === true) {
      findings.push(`${relativePath}:summary-capacityCertified-true`);
    }
  }
  return findings;
}

async function stageCap00() : Promise<any> {
  const counters: Record<string, any> = {};
  const replay: any = await replayCatalogDeterminism();
  counters.replayedWorkloads = finiteCount(replay.workloadCount);
  counters.identicalReplays = finiteCount(
    replay.results.filter((result?: any) : any => result.identical).length
  );
  assert.strictEqual(replay.identical, true, "repeated synthetic workloads must produce identical counters");

  const fixtureFindings: any = await misleadingFixtureNameFindings();
  counters.misleadingFixtureNames = finiteCount(fixtureFindings.length);
  assert.strictEqual(fixtureFindings.length, 0, `misleading capacity fixture names present: ${fixtureFindings.join(", ")}`);

  const certFindings: any = await conformanceCertificationFindings();
  counters.certifyingConformanceReports = finiteCount(certFindings.length);
  assert.strictEqual(certFindings.length, 0, `conformance report certifies capacity: ${certFindings.join(", ")}`);

  const suites: any = await runFocusedSuites("cap-00");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);

  assertConformanceNeverCertifies({ capacityCertified: false });

  return {
    stage: "cap-00",
    passed: true,
    counters,
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageNotImplemented(stage: any = "") : Promise<any> {
  return {
    stage,
    passed: false,
    reasonCode: "stage_not_implemented",
    counters: {},
    capacityCertified: false
  };
}


async function stageCap01() : Promise<any> {
  const counters: Record<string, any> = {};
  const suites: any = await runFocusedSuites("cap-01");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);

  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-01",
    passed: true,
    counters,
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap02() : Promise<any> {
  const counters: Record<string, any> = {};
  const findings: any[] = [];
  const queuePortSource: any = await readTextIfExists("packages/server-runtime/src/composition/queue-application-port.ts");
  for (const symbol of ["dispatchChain", "dispatchSerialization"]) {
    if (queuePortSource.includes(symbol)) {
      findings.push(`queue-port-global-serialization:${symbol}`);
    }
  }
  if (!queuePortSource.includes("triggerPending")) {
    findings.push("queue-port-trigger-coalescing-missing");
  }
  if (!queuePortSource.includes("globalReserved")) {
    findings.push("queue-port-global-reservation-missing");
  }
  const workerRuntimeSource: any = await readTextIfExists("packages/foundation/src/work-queue/worker-runtime.ts");
  for (const symbol of ["runOnce", "startPolling"]) {
    if (workerRuntimeSource.includes(symbol)) {
      findings.push(`worker-runtime-bypass:${symbol}`);
    }
  }
  const dispatcherSource: any = await readTextIfExists("packages/foundation/src/work-queue/push-dispatcher.ts");
  if (!dispatcherSource.includes("reserved")) {
    findings.push("push-dispatcher-synchronous-reservation-missing");
  }
  counters.legacyDispatchFindings = finiteCount(findings.length);
  assert.strictEqual(findings.length, 0, `legacy queue dispatch paths present: ${findings.join(", ")}`);

  const suites: any = await runFocusedSuites("cap-02");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);

  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-02",
    passed: true,
    counters,
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap03() : Promise<any> {
  const counters: Record<string, any> = {};
  const findings: any[] = [];
  const storeRuntimePaths: readonly any[] = [
    "packages/foundation/src/work-queue/sqlite-store-runtime.ts",
    "packages/foundation/src/work-queue/postgres-store-runtime.ts"
  ];
  for (const runtimePath of storeRuntimePaths) {
    const runtimeSource: any = await readTextIfExists(runtimePath);
    for (const symbol of ["lease_expired_max_attempts_exhausted", "lease_expired_retry"]) {
      if (runtimeSource.includes(symbol)) {
        findings.push(`lease-expiry-legacy:${symbol}`);
      }
    }
    if (!runtimeSource.includes("IN_DOUBT")) {
      findings.push(`${runtimePath}:in-doubt-missing`);
    }
    if (!runtimeSource.includes("sink_receipt_reconciled")) {
      findings.push(`${runtimePath}:reconcile-missing`);
    }
  }
  const stateMachineSource: any = await readTextIfExists("packages/foundation/src/workflow/state-machine/work-queue/state-machine.ts");
  for (const symbol of ["IN_DOUBT", "termination_acknowledged"]) {
    if (!stateMachineSource.includes(symbol)) {
      findings.push(`state-machine:${symbol}-missing`);
    }
  }
  const workerRuntimeSource: any = await readTextIfExists("packages/foundation/src/work-queue/worker-runtime.ts");
  if (!workerRuntimeSource.includes("markInDoubt")) {
    findings.push("worker-runtime:mark-in-doubt-missing");
  }
  if (!workerRuntimeSource.includes("provablyTerminable")) {
    findings.push("worker-runtime:killable-isolation-missing");
  }
  const schemaPaths: readonly any[] = [
    "packages/foundation/src/work-queue/sqlite-schema.ts",
    "packages/foundation/src/work-queue/postgres-schema.ts"
  ];
  for (const schemaPath of schemaPaths) {
    const schemaSource: any = await readTextIfExists(schemaPath);
    if (!schemaSource.includes("work_queue_sink_fences")) {
      findings.push(`${schemaPath}:sink-fence-table-missing`);
    }
  }
  const zombieFindings: any[] = [];
  const zombieRoots: readonly any[] = [
    "packages/foundation/src/work-queue",
    "packages/server-runtime/src/composition"
  ];
  for (const root of zombieRoots) {
    for (const relativePath of await collectFiles(root)) {
      if (!relativePath.endsWith(".ts")) continue;
      const source: any = await readTextIfExists(relativePath);
      if (/zombie/iu.test(source)) {
        zombieFindings.push(`zombie-pattern:${relativePath}`);
      }
    }
  }
  findings.push(...zombieFindings);
  counters.legacyExecutionFindings = finiteCount(findings.length);
  assert.strictEqual(findings.length, 0, `legacy execution paths present: ${findings.join(", ")}`);

  const suites: any = await runFocusedSuites("cap-03");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);

  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-03",
    passed: true,
    counters,
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap04() : Promise<any> {
  const counters: Record<string, any> = {};
  const findings: any[] = [];
  const statementPath: any = "packages/foundation/src/work-queue/sqlite-statements.ts";
  const statementSource: any = await readTextIfExists(statementPath);
  for (const symbol of [
    "nextFairTenant",
    "nextFairWorkspace",
    "nextFairProject",
    "fairLeafCandidate",
    "getFairnessCursor",
    "upsertFairnessCursor",
    "claimCandidatesBase",
    "lockedCursor",
    "work_queue_fairness_cursors"
  ]) {
    if (statementSource.includes(symbol)) {
      findings.push(`sqlite-statements:legacy-cursor:${symbol}`);
    }
  }
  if (!statementSource.includes("fairRankedCandidate")) {
    findings.push("sqlite-statements:ranked-candidate-missing");
  }
  if (!statementSource.includes("upsertVirtualFinish") || !statementSource.includes("advanceVirtualFinish")) {
    findings.push("sqlite-statements:virtual-finish-projections-missing");
  }

  const storePaths: readonly any[] = [
    "packages/foundation/src/work-queue/sqlite-store.ts",
    "packages/foundation/src/work-queue/postgres-store.ts"
  ];
  for (const storePath of storePaths) {
    const storeSource: any = await readTextIfExists(storePath);
    for (const symbol of [
      "nextFairTenant",
      "nextFairWorkspace",
      "nextFairProject",
      "fairLeafCandidate",
      "lockedCursor",
      "work_queue_fairness_cursors"
    ]) {
      if (storeSource.includes(symbol)) {
        findings.push(`${storePath}:legacy-cursor:${symbol}`);
      }
    }
    for (const symbol of ["advanceVirtualFinish", "virtualFinishCursor", "selectFairCandidate"]) {
      if (!storeSource.includes(symbol)) {
        findings.push(`${storePath}:virtual-finish-${symbol}-missing`);
      }
    }
  }

  const policySource: any = await readTextIfExists("packages/foundation/src/work-queue/policies.ts");
  const serializationSource: any = await readTextIfExists("packages/foundation/src/work-queue/store-serialization.ts");
  for (const [name, source] of [["policies", policySource], ["store-serialization", serializationSource]]) {
    if (source.includes("maxVisits")) {
      findings.push(`${name}:max-visits-config-remaining`);
    }
  }

  const schemaPaths: readonly any[] = [
    "packages/foundation/src/work-queue/sqlite-schema.ts",
    "packages/foundation/src/work-queue/postgres-schema.ts"
  ];
  for (const schemaPath of schemaPaths) {
    const schemaSource: any = await readTextIfExists(schemaPath);
    if (!schemaSource.includes("work_queue_virtual_finish")) {
      findings.push(`${schemaPath}:virtual-finish-table-missing`);
    }
    if (!schemaSource.includes("DROP TABLE IF EXISTS work_queue_fairness_cursors")) {
      findings.push(`${schemaPath}:fairness-cursor-drop-missing`);
    }
  }

  const postgresStore: any = await readTextIfExists("packages/foundation/src/work-queue/postgres-store.ts");
  if (!postgresStore.includes("FOR UPDATE SKIP LOCKED")) {
    findings.push("postgres-store:skip-locked-missing");
  }
  const claimStart: any = postgresStore.indexOf("async claim(");
  const nextOperation: any = ["async expire(", "async complete(", "async retry(", "async fail("]
    .map((marker: any) : any => postgresStore.indexOf(marker))
    .filter((index: any) : any => index > claimStart)
    .sort((a: any, b: any) : any => a - b)[0];
  if (claimStart < 0 || nextOperation <= claimStart) {
    findings.push("postgres-store:claim-body-unresolved");
  } else {
    const claimBody: any = postgresStore.slice(claimStart, nextOperation);
    if (claimBody.includes("lockPartition")) {
      findings.push("postgres-store:claim-per-candidate-lock");
    }
    if (!claimBody.includes("selectFairCandidate")) {
      findings.push("postgres-store:claim-set-based-missing");
    }
  }

  counters.legacyClaimFindings = finiteCount(findings.length);
  assert.strictEqual(findings.length, 0, `legacy claim paths present: ${findings.join(", ")}`);

  const suites: any = await runFocusedSuites("cap-04");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);

  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-04",
    passed: true,
    counters,
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap05() : Promise<any> {
  const counters: Record<string, any> = {};
  const findings: any[] = [];
  for (const runtimePath of [
    "packages/foundation/src/work-queue/sqlite-store-runtime.ts",
    "packages/foundation/src/work-queue/postgres-store-runtime.ts"
  ]) {
    const source: any = await readTextIfExists(runtimePath);
    if (source.includes("maintainRetentionBeforeAppend")) {
      findings.push(`${runtimePath}:per-transition-retention-preflight`);
    }
    for (const symbol of ["maintainRetentionAfterAppend", "pending_transitions", "cleanupBatchSize"]) {
      if (!source.includes(symbol)) findings.push(`${runtimePath}:${symbol}-missing`);
    }
  }
  for (const schemaPath of [
    "packages/foundation/src/work-queue/sqlite-schema.ts",
    "packages/foundation/src/work-queue/postgres-schema.ts"
  ]) {
    const source: any = await readTextIfExists(schemaPath);
    if (!source.includes("work_queue_retention_state")) {
      findings.push(`${schemaPath}:retention-state-missing`);
    }
  }
  counters.retentionFindings = finiteCount(findings.length);
  assert.strictEqual(findings.length, 0, `retention convergence findings: ${findings.join(", ")}`);
  const suites: any = await runFocusedSuites("cap-05");
  counters.focusedSuites = finiteCount(suites.length);
  counters.focusedSuitesPassed = finiteCount(suites.filter((suite?: any) : any => suite.passed).length);
  assertConformanceNeverCertifies({ capacityCertified: false });
  return { stage: "cap-05", passed: true, counters, suiteResults: suites, capacityCertified: false };
}

async function stageCap06a() : Promise<any> {
  const findings: any[] = [];
  const lifecycle: any = await readTextIfExists("apps/server/runtime/http-server-lifecycle.ts");
  for (const symbol of ["maxActiveRequests", "maxActiveCost", "reservedLightCost", "inFlightCost"]) {
    if (!lifecycle.includes(symbol)) findings.push(`http-lifecycle:${symbol}-missing`);
  }
  const routes: any = await readTextIfExists("apps/server/runtime/http-server-routes.ts");
  const beginIndex: any = routes.indexOf("lifecycle.beginRequest");
  const authIndex: any = routes.indexOf("await authenticateRequest");
  if (beginIndex < 0 || (authIndex >= 0 && beginIndex > authIndex)) {
    findings.push("http-routes:admission-not-before-authentication");
  }
  const operationSources: readonly any[] = ["apps", "packages", "tools", "tests"];
  for (const root of operationSources) {
    for (const relativePath of await collectFiles(root)) {
      if (!/\.(?:ts|vue|json)$/u.test(relativePath)) continue;
      if (relativePath === verifier) continue;
      const source: any = await readTextIfExists(relativePath);
      if (/concurrencySafe|concurrencyGroup/u.test(source)) {
        findings.push(`legacy-operation-concurrency:${relativePath}`);
      }
    }
  }
  const decorators: any = await readTextIfExists("packages/contracts/src/operations/operation-decorators.ts");
  for (const symbol of ["workloadClass", "maxParallel", "cost"]) {
    if (!decorators.includes(symbol)) findings.push(`operation-contract:${symbol}-missing`);
  }
  const lockSource: any = await readTextIfExists("packages/server-runtime/src/composition/operation-dispatch-lock.ts");
  if (!lockSource.includes("activeOperationSlots")) findings.push("operation-lock:atomic-slot-reservation-missing");
  const suites: any = await runFocusedSuites("cap-06a");
  assert.strictEqual(findings.length, 0, `transport admission findings: ${findings.join(", ")}`);
  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-06a",
    passed: true,
    counters: { findings: finiteCount(findings.length), focusedSuites: finiteCount(suites.length) },
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap06b() : Promise<any> {
  const findings: any[] = [];
  const httpUtils: any = await readTextIfExists("packages/protocols/http/http-utils.ts");
  for (const symbol of ["retainedMultiplier", "suppliedAdmissionLease", "createReadStream", "pipeline("]) {
    if (!httpUtils.includes(symbol)) findings.push(`http-utils:${symbol}-missing`);
  }
  const staticStart: any = httpUtils.indexOf("export async function serveStaticFile");
  if (staticStart < 0) {
    findings.push("http-utils:static-file-handler-missing");
  } else if (httpUtils.slice(staticStart).includes("fs.readFile(filePath)")) {
    findings.push("http-utils:whole-static-file-buffering-present");
  }
  const routes: any = await readTextIfExists("apps/server/runtime/http-server-routes.ts");
  for (const symbol of ["requestBodyAdmissionLease", "retainedMultiplier", "admissionLease"]) {
    if (!routes.includes(symbol)) findings.push(`http-routes:${symbol}-missing`);
  }
  const suites: any = await runFocusedSuites("cap-06b");
  assert.strictEqual(findings.length, 0, `request body memory findings: ${findings.join(", ")}`);
  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-06b",
    passed: true,
    counters: { findings: finiteCount(findings.length), focusedSuites: finiteCount(suites.length) },
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap07() : Promise<any> {
  const findings: any[] = [];
  const bus: any = await readTextIfExists("packages/protocols/pubsub/event-bus.ts");
  for (const symbol of [
    "waitersByTopic",
    "allTopicWaiters",
    "scheduleHeap",
    "scheduled",
    "registerWaiter",
    "readRecent",
    "recentByteLimit"
  ]) {
    if (!bus.includes(symbol)) findings.push(`event-bus:${symbol}-missing`);
  }
  for (const legacy of ["for (const waiter of waiters) waiter()", "Promise.race([", "function delay("]) {
    if (bus.includes(legacy)) findings.push(`event-bus:legacy-${legacy}`);
  }
  const store: any = await readTextIfExists("packages/server-runtime/src/events/sqlite-protocol-event-store.ts");
  for (const symbol of ["retention_pending", "pruneAtWatermark", "WHERE offset<=?"]) {
    if (!store.includes(symbol)) findings.push(`event-store:${symbol}-missing`);
  }
  if (store.includes("pruneForAdmission")) findings.push("event-store:per-publication-prune-present");
  const suites: any = await runFocusedSuites("cap-07");
  assert.strictEqual(findings.length, 0, `event runtime findings: ${findings.join(", ")}`);
  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-07",
    passed: true,
    counters: { findings: finiteCount(findings.length), focusedSuites: finiteCount(suites.length) },
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap08() : Promise<any> {
  const findings: any[] = [];
  const contract: any = await readTextIfExists("packages/foundation/src/concurrency/lock-manager-contract.ts");
  for (const symbol of ["IntrusiveWaitQueue", "DeadlineScheduler", "maxTotalQueueDepth"]) {
    if (!contract.includes(symbol)) findings.push(`lock-contract:${symbol}-missing`);
  }
  const memory: any = await readTextIfExists("packages/foundation/src/concurrency/lock-manager.ts");
  const sqlite: any = await readTextIfExists("packages/foundation/src/concurrency/sqlite-lock-manager.ts");
  const postgres: any = await readTextIfExists("packages/foundation/src/concurrency/postgres-lock-manager.ts");
  for (const [name, source] of [["memory", memory], ["sqlite", sqlite], ["postgres", postgres]]) {
    if (!source.includes("IntrusiveWaitQueue")) findings.push(`${name}:intrusive-queue-missing`);
    if (!source.includes("DeadlineScheduler")) findings.push(`${name}:shared-deadline-scheduler-missing`);
  }
  for (const legacy of ["queue.items", "queue.pollTimer", "waiter.timer"]) {
    if (sqlite.includes(legacy) || memory.includes(legacy)) findings.push(`lock-runtime:legacy-${legacy}`);
  }
  for (const symbol of [
    "_localQueues",
    "maxTotalQueueDepth",
    "_meshrix_lock_leases",
    "clock_timestamp()",
    "maxPoolCredits",
    "_poolCreditQueue"
  ]) {
    if (!postgres.includes(symbol)) findings.push(`postgres:${symbol}-missing`);
  }
  for (const legacy of ["pg_try_advisory_lock", "pg_advisory_unlock", "entry.client"]) {
    if (postgres.includes(legacy)) findings.push(`postgres:legacy-${legacy}`);
  }
  const queueStatements: any = await readTextIfExists("packages/foundation/src/work-queue/sqlite-statements.ts");
  const pgQueue: any = await readTextIfExists("packages/foundation/src/work-queue/postgres-store.ts");
  if (!queueStatements.includes("work_queue_sink_fences")) findings.push("sqlite-sink-generation-fence-missing");
  if (!pgQueue.includes("work_queue_sink_fences")) findings.push("postgres-sink-generation-fence-missing");
  const suites: any = await runFocusedSuites("cap-08");
  assert.strictEqual(findings.length, 0, `lock runtime findings: ${findings.join(", ")}`);
  assertConformanceNeverCertifies({ capacityCertified: false });
  return {
    stage: "cap-08",
    passed: true,
    counters: { findings: finiteCount(findings.length), focusedSuites: finiteCount(suites.length) },
    suiteResults: suites,
    capacityCertified: false
  };
}

async function stageCap09() : Promise<any> {
  const findings: any[] = [];
  const source: any = await readPactiumText("src/core/append-only-event-log.js");
  for (const symbol of [
    "pactium.segmented-event-log",
    "maxSegmentBytes",
    "event-log-sequence",
    "event-log-event-id",
    "appendEvents",
    "readPage",
    "getEventById"
  ]) {
    if (!source.includes(symbol)) findings.push(`pactium-event-log:${symbol}-missing`);
  }
  if (source.includes('storageKey("event-log", partitionId)')) findings.push("pactium-event-log:whole-array-key-present");
  const suite: any = await runPactiumTest("tests/pactium/runtime-capacity.test.mjs");
  assert.strictEqual(findings.length, 0, `Pactium event log findings: ${findings.join(", ")}`);
  return { stage: "cap-09", passed: true, counters: { findings: 0, focusedSuites: 1 }, suiteResults: [suite], capacityCertified: false };
}

async function stageCap10a() : Promise<any> {
  const findings: any[] = [];
  const source: any = await readPactiumText("src/core/state-commit-store.js");
  for (const symbol of ["mutateIndex", "indexEngine.mutate", "latest.values()", "localeCompare"]) {
    if (!source.includes(symbol)) findings.push(`pactium-state-commit:${symbol}-missing`);
  }
  if (/for \(const mutation of mutations\)[\s\S]{0,500}indexEngine\.(?:put|delete)/u.test(source)) {
    findings.push("pactium-state-commit:per-mutation-root-publication");
  }
  const suite: any = await runPactiumTest("tests/pactium/runtime-capacity.test.mjs");
  assert.strictEqual(findings.length, 0, `Pactium Merkle batch findings: ${findings.join(", ")}`);
  return { stage: "cap-10a", passed: true, counters: { findings: 0, focusedSuites: 1 }, suiteResults: [suite], capacityCertified: false };
}

async function stageCap10b() : Promise<any> {
  const findings: any[] = [];
  const source: any = await readPactiumText("src/core/content-addressed-store.js");
  for (const symbol of ["pactium.cas-pins", "generation", "pinRoot", "unpinRoot", "pin-generation-changed"]) {
    if (!source.includes(symbol)) findings.push(`pactium-cas:${symbol}-missing`);
  }
  const manifest: any = JSON.parse(await readPactiumText("package.json"));
  if (manifest.version !== "0.8.0") findings.push("pactium-package:expected-0.8.0");
  const suite: any = await runPactiumTest("tests/pactium/runtime-capacity.test.mjs");
  assert.strictEqual(findings.length, 0, `Pactium pin findings: ${findings.join(", ")}`);
  return { stage: "cap-10b", passed: true, counters: { findings: 0, focusedSuites: 1 }, suiteResults: [suite], capacityCertified: false };
}

async function stageCap11() : Promise<any> {
  const findings: any[] = [];
  const manifest: any = JSON.parse(await readText("package.json"));
  if (manifest.dependencies?.pactium !== "file:vendor/pactium-0.8.0.tgz") {
    findings.push("meshrix:exact-pactium-artifact-missing");
  }
  const lock: any = await readText("package-lock.json");
  for (const symbol of ["file:vendor/pactium-0.8.0.tgz", '"version": "0.8.0"']) {
    if (!lock.includes(symbol)) findings.push(`meshrix-lock:${symbol}-missing`);
  }
  for (const removedPath of [
    "packages/foundation/src/checkpoint/tree/pactium-substrate-preflight.ts",
    "packages/foundation/src/checkpoint/tree/pactium-canonical-safe.ts"
  ]) {
    if (await exists(removedPath)) findings.push(`removed-wrapper-present:${removedPath}`);
  }
  const ownedRoots: readonly any[] = ["packages/foundation/src/checkpoint/tree", "packages/agents/src/agent-workspace"];
  for (const root of ownedRoots) {
    for (const relativePath of await collectFiles(root)) {
      if (!relativePath.endsWith(".ts")) continue;
      const source: any = await readTextIfExists(relativePath);
      if (/lsmIngest|meshrix-lsm|LSM_SESSION_SCOPE/u.test(source)) findings.push(`legacy-lsm:${relativePath}`);
    }
  }
  const merkleSource: any = await readTextIfExists("packages/foundation/src/checkpoint/tree/merkle-state-substrate.ts");
  for (const symbol of ["createAppendOnlyEventLog", "createContentAddressedStore", "toCanonicalSafeValue", "uploadManifest"]) {
    if (!merkleSource.includes(symbol)) findings.push(`merkle-substrate:${symbol}-missing`);
  }
  const suites: any[] = [];
  for (const suitePath of [
    "tests/vitest/server/merkle-state-substrate.test.ts",
    "tests/vitest/server/pactium-provider-boundary.test.ts"
  ]) {
    const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
    assert.strictEqual(result.status, 0, `CAP-11 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
    suites.push({ suite: suitePath, passed: true, exitCode: result.status, outputBytes: Buffer.byteLength(result.stdout + result.stderr) });
  }
  assert.strictEqual(findings.length, 0, `Meshrix Pactium convergence findings: ${findings.join(", ")}`);
  return { stage: "cap-11", passed: true, counters: { findings: 0, focusedSuites: suites.length }, suiteResults: suites, capacityCertified: false };
}

async function stageCap12() : Promise<any> {
  const findings: any[] = [];
  const source: any = await readTextIfExists("packages/foundation/src/checkpoint/tree/checkpoint-tree-projection.ts");
  for (const symbol of [
    "meshrix.checkpoint-tree.normalized",
    "TREE_META_SCOPE",
    "TREE_NODE_SCOPE",
    "TREE_CHILD_SCOPE",
    "TREE_EVENT_SCOPE",
    "TREE_EVENT_INDEX_SCOPE",
    "loadNormalizedTree"
  ]) {
    if (!source.includes(symbol)) findings.push(`checkpoint:${symbol}-missing`);
  }
  if (source.includes('const TREE_SCOPE: any = "meshrix-checkpoint-tree"')) findings.push("checkpoint:aggregate-tree-scope-present");
  const suites: any[] = [];
  for (const suitePath of [
    "tests/vitest/server/runtime-checkpoint-normalization-conformance.test.ts",
    "tests/vitest/server/checkpoint-tree-projection.test.ts"
  ]) {
    const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
    assert.strictEqual(result.status, 0, `CAP-12 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
    suites.push({ suite: suitePath, passed: true, exitCode: result.status, outputBytes: Buffer.byteLength(result.stdout + result.stderr) });
  }
  assert.strictEqual(findings.length, 0, `checkpoint normalization findings: ${findings.join(", ")}`);
  return { stage: "cap-12", passed: true, counters: { findings: 0, focusedSuites: suites.length }, suiteResults: suites, capacityCertified: false };
}

async function stageCap13(stage?: any) : Promise<any> {
  const findings: any[] = [];
  const lane: any = await readTextIfExists("packages/foundation/src/storage/sqlite-execution-lane.ts");
  for (const symbol of ["Worker", "maxPending", "maxPendingBytes", "deadlineAtMs", "structuredClone", "sqlite_lane_payload_rejected"]) {
    if (!lane.includes(symbol)) findings.push(`sqlite-lane:${symbol}-missing`);
  }
  const worker: any = await readTextIfExists("packages/foundation/src/work-queue/sqlite-store-worker.ts");
  const proxy: any = await readTextIfExists("packages/foundation/src/work-queue/sqlite-store-lane.ts");
  if (!worker.includes("allowed")) findings.push("queue-lane:typed-command-set-missing");
  if (!proxy.includes("createSqliteExecutionLane")) findings.push("queue-lane:proxy-missing");
  const queuePort: any = await readTextIfExists("packages/server-runtime/src/composition/queue-application-port.ts");
  if (!queuePort.includes("createSqliteWorkQueueLane")) findings.push("queue-runtime:worker-lane-not-selected");
  if (stage === "cap-13-evidence") {
    const auditFacade: any = await readTextIfExists("packages/foundation/src/security/operation-audit.ts");
    const auditWorker: any = await readTextIfExists("packages/foundation/src/security/operation-audit-worker.ts");
    const auditOwner: any = await readTextIfExists("packages/foundation/src/security/operation-audit-worker-store.ts");
    const composition: any = await readTextIfExists("packages/server-runtime/src/composition/composition-root.ts");
    if (!auditFacade.includes('owner: "mandatory-evidence-operation-audit"')) findings.push("audit-lane:owner-missing");
    if (!auditFacade.includes("createSqliteExecutionLane")) findings.push("audit-lane:proxy-missing");
    if (/\bdb\s*[,}]/u.test(auditFacade) || auditFacade.includes("createOperationAuditWorkerStore")) {
      findings.push("audit-lane:synchronous-fallback-present");
    }
    if (!auditWorker.includes("COMMANDS") || !auditWorker.includes("deadlineAtMs")) findings.push("audit-lane:typed-worker-missing");
    if (!auditOwner.includes("createOperationAuditWorkerStore")) findings.push("audit-lane:worker-owner-missing");
    if (!composition.includes("createOperationAuditStore") || !composition.includes("operationAuditStore.close")) {
      findings.push("audit-lane:composition-missing");
    }
  }
  if (stage === "cap-13-authorization") {
    const authorizationFacade: any = await readTextIfExists("packages/foundation/src/security/authorization/authorization-store.ts");
    const operationPermissionFacade: any = await readTextIfExists("packages/capabilities/src/operation-permission-core/store.ts");
    const operationPermissionWorker: any = await readTextIfExists("packages/capabilities/src/operation-permission-core/store-worker.ts");
    if (!authorizationFacade.includes('owner: "authorization-evidence"') || !authorizationFacade.includes("createSqliteExecutionLane")) {
      findings.push("authorization-lane:facade-missing");
    }
    if (!operationPermissionFacade.includes('owner: "authorization-operation-permission"') ||
        !operationPermissionFacade.includes("createSqliteExecutionLane") || /\bdb\s*[,}]/u.test(operationPermissionFacade)) {
      findings.push("operation-permission-lane:facade-missing-or-sync-fallback");
    }
    if (!operationPermissionWorker.includes("OPERATION_PERMISSION_STORE_COMMANDS") ||
        !operationPermissionWorker.includes("deadlineAtMs")) {
      findings.push("operation-permission-lane:typed-worker-missing");
    }
  }
  const registry: any = await readJsonIfExists("tools/registry/sqlite-owner-migration.registry.json");
  if (!registry || !Array.isArray(registry.owners) || registry.owners.some((owner?: any) : any => owner.fallback !== false)) {
    findings.push("sqlite-owner-registry:incomplete");
  }
  const suitePath: any = stage === "cap-13-evidence"
    ? "tests/vitest/server/operation-audit-retention.test.ts"
    : "tests/vitest/server/runtime-sqlite-execution-lane-conformance.test.ts";
  // Keep Vitest one process below this synchronous verifier for the audit
  // suite; its thread pool owns nested SQLite workers.
  const result: any = stage === "cap-13-evidence"
    ? runCommand(process.platform === "win32" ? "npm.cmd" : "npm", [
        "run", "vitest", "--", suitePath
      ])
    : runCommand(process.execPath, [
        "--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts",
        suitePath
      ]);
  assert.strictEqual(result.status, 0, `CAP-13 lane suite failed\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(findings.length, 0, `SQLite lane findings: ${findings.join(", ")}`);
  return {
    stage,
    passed: true,
    counters: { findings: 0, focusedSuites: 1, ownersClassified: finiteCount(registry.owners.length) },
    suiteResults: [{ suite: suitePath, passed: true, exitCode: 0, outputBytes: Buffer.byteLength(result.stdout + result.stderr) }],
    capacityCertified: false
  };
}

async function stageCap14(stage?: any) : Promise<any> {
  const findings: any[] = [];
  const dependencySources: readonly any[] = ["package.json", "package-lock.json", "packages/foundation/package.json"];
  for (const relativePath of dependencySources) {
    const source: any = await readTextIfExists(relativePath);
    if (/"p-limit"|from ["']p-limit["']/u.test(source)) findings.push(`p-limit:${relativePath}`);
  }
  const concurrency: any = await readTextIfExists("packages/foundation/src/concurrency/async-concurrency.ts");
  if (!concurrency.includes("new Array(list.length)") || !concurrency.includes("cursor++")) {
    findings.push("async-concurrency:first-party-scheduler-missing");
  }
  const discovery: any = await readTextIfExists("packages/protocols/mcp/adapter/http-mcp-adapter-upstream.ts");
  for (const symbol of ["discoveryConcurrency", "signal?.aborted", "responses[index]"]) {
    if (!discovery.includes(symbol)) findings.push(`mcp-discovery:${symbol}-missing`);
  }
  const session: any = await readTextIfExists("packages/protocols/mcp/upstream-mcp-session-manager.ts");
  for (const symbol of ["maxConcurrentRequests", "maxConcurrentRequestsPerSession", "creating", "closePromise"]) {
    if (!session.includes(symbol)) findings.push(`mcp-session:${symbol}-missing`);
  }
  const stdio: any = await readTextIfExists("packages/protocols/mcp/upstream-mcp-stdio-session.ts");
  for (const symbol of ["maxQueuedWriteBytes", "queuedWriteBytes", 'once("drain"', "writeChain"]) {
    if (!stdio.includes(symbol)) findings.push(`mcp-stdio:${symbol}-missing`);
  }
  const suitePath: any = stage === "cap-14a"
    ? "tests/vitest/server/runtime-refactor-routing-mcp-discovery.test.ts"
    : stage === "cap-14b"
      ? "tests/vitest/server/upstream-mcp-session-manager.test.ts"
      : "tests/vitest/server/upstream-mcp-stdio-launcher.test.ts";
  const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
  assert.strictEqual(result.status, 0, `CAP-14 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(findings.length, 0, `MCP capacity findings: ${findings.join(", ")}`);
  return {
    stage,
    passed: true,
    counters: { findings: 0, focusedSuites: 1 },
    suiteResults: [{ suite: suitePath, passed: true, exitCode: 0, outputBytes: Buffer.byteLength(result.stdout + result.stderr) }],
    capacityCertified: false
  };
}

async function stageCap15() : Promise<any> {
  const findings: any[] = [];
  const source: any = await readTextIfExists("packages/foundation/src/security/authorization/authorization-engine.ts");
  for (const symbol of [
    "createWeightedLruCache",
    "compiledFactsStructuralWeight",
    "compiledFactsCacheWeightLimit",
    "cacheOversizeBypasses",
    "cacheWeightLimit"
  ]) {
    if (!source.includes(symbol)) findings.push(`authorization-cache:${symbol}-missing`);
  }
  if (source.includes("const cache: any = new Map")) findings.push("authorization-cache:entry-only-map-present");
  const pactiumIndex: any = await readPactiumText("src/index.js");
  if (!pactiumIndex.includes("createWeightedLruCache")) findings.push("pactium:weighted-lru-public-export-missing");
  const suitePath: any = "tests/vitest/server/runtime-refactor-authorization-compiler.test.ts";
  const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
  assert.strictEqual(result.status, 0, `CAP-15 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(findings.length, 0, `authorization cache findings: ${findings.join(", ")}`);
  return {
    stage: "cap-15",
    passed: true,
    counters: { findings: 0, focusedSuites: 1 },
    suiteResults: [{ suite: suitePath, passed: true, exitCode: 0, outputBytes: Buffer.byteLength(result.stdout + result.stderr) }],
    capacityCertified: false
  };
}

async function stageCap16() : Promise<any> {
  const findings: any[] = [];
  const projection: any = await readTextIfExists("packages/server-runtime/src/state/context-compact/projection.ts");
  for (const symbol of ["startGroupIndex", "suffixTokens", "totalTokens", "siftUp", "siftDown", "createApiRoundSelectionIndex"]) {
    if (!projection.includes(symbol)) findings.push(`context-compaction:${symbol}-missing`);
  }
  for (const legacy of [
    'candidate.map((message?: any) : any => message.text).join("\\n")',
    'groups = groups.slice(1)',
    ".sort((left?: any, right?: any) : any => right.score"
  ]) {
    if (projection.includes(legacy)) findings.push(`context-compaction:legacy-${legacy}`);
  }
  const runtime: any = await readTextIfExists("packages/server-runtime/src/state/context-compact/index.ts");
  if (runtime.includes('messages.map((message?: any) : any => message.text).join("\\n")')) {
    findings.push("context-compaction:runtime-full-text-rejoin-present");
  }
  const strategies: any = await readTextIfExists("packages/server-runtime/src/state/context-compact/runtime-strategies.ts");
  if (!strategies.includes("const selectionIndex: any = createApiRoundSelectionIndex(messages)")) {
    findings.push("context-compaction:retry-selection-index-not-reused");
  }
  const lane: any = await readTextIfExists("packages/server-runtime/src/state/context-compact/execution-lane.ts");
  for (const symbol of ["CONTEXT_COMPACTION_MAX_INPUT_BYTES", "maxPendingBytes", "deadlineAtMs", "structuredClone"]) {
    if (!lane.includes(symbol)) findings.push(`context-compaction-lane:${symbol}-missing`);
  }
  const suitePath: any = "tests/vitest/server/runtime-context-compaction-linear-conformance.test.ts";
  const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
  assert.strictEqual(result.status, 0, `CAP-16 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(findings.length, 0, `context compaction findings: ${findings.join(", ")}`);
  return {
    stage: "cap-16",
    passed: true,
    counters: { findings: 0, focusedSuites: 1 },
    suiteResults: [{ suite: suitePath, passed: true, exitCode: 0, outputBytes: Buffer.byteLength(result.stdout + result.stderr) }],
    capacityCertified: false
  };
}

async function stageCap17() : Promise<any> {
  const findings: any[] = [];
  const schema: any = await readTextIfExists("packages/capabilities/src/operation-permission-core/store-schema.ts");
  for (const symbol of ["parent_grant_id", "idx_tool_grants_parent_type", "version: 14", "delegated_parent_backfill_invalid"]) {
    if (!schema.includes(symbol)) findings.push(`delegated-grant-schema:${symbol}-missing`);
  }
  const security: any = await readTextIfExists("packages/capabilities/src/operation-permission-core/store-delegated-grant-security.ts");
  for (const symbol of ["WITH RECURSIVE descendants", "childrenByParent", "let head", "graph_incomplete"]) {
    if (!security.includes(symbol)) findings.push(`delegated-grant-runtime:${symbol}-missing`);
  }
  for (const legacy of ["queue.shift()", "SELECT * FROM tool_grants WHERE type = 'delegated-mcp-child'", "metadata?.delegatedMcp?.sourceGrantId"]) {
    if (security.includes(legacy)) findings.push(`delegated-grant-runtime:legacy-${legacy}`);
  }
  const suitePath: any = "tests/vitest/server/runtime-delegated-grant-index-conformance.test.ts";
  const result: any = runCommand(process.execPath, ["--conditions=source", VITEST_RUNNER, "run", "--config", "vitest.config.ts", suitePath]);
  assert.strictEqual(result.status, 0, `CAP-17 suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(findings.length, 0, `delegated grant findings: ${findings.join(", ")}`);
  return {
    stage: "cap-17",
    passed: true,
    counters: { findings: 0, focusedSuites: 1 },
    suiteResults: [{ suite: suitePath, passed: true, exitCode: 0, outputBytes: Buffer.byteLength(result.stdout + result.stderr) }],
    capacityCertified: false
  };
}

async function currentVerifierRevision() : Promise<any> {
  return computeVerifierSourceRevision(repoRoot, [
    verifier,
    "tools/verifiers/runtime-capacity-workload-catalog.ts"
  ]);
}

async function writeStageReceipt(result: Record<string, any> = {}) : Promise<any> {
  const provenance: Record<string, any> = {
    producer: "meshrix-core-runtime-capacity-stage",
    commandId: `runtime-capacity-${String(result.stage || "unknown")}`,
    sourceRevision: await currentVerifierRevision()
  };
  const receipt: any = finalizeSensitiveReport({
    schemaVersion: STAGE_RECEIPT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stage: String(result.stage || ""),
    passed: result.passed === true,
    reasonCode: String(result.reasonCode || ""),
    capacityCertified: result.capacityCertified === true,
    counters: result.counters || {}
  }, { provenance });
  assertNoSensitiveReportLeak(receipt, "runtime capacity stage receipt");
  assertReportProvenance(receipt, provenance);
  await fs.mkdir(repoPath(`${REPORT_DIR}/stages`), { recursive: true });
  await fs.writeFile(
    repoPath(`${REPORT_DIR}/stages/${String(result.stage || "unknown")}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
  return receipt;
}

async function stageCap18Migrations() : Promise<any> {
  const findings: any[] = [];
  const expectedStages: any[] = STAGE_REGISTRY.slice(0, STAGE_REGISTRY.indexOf("cap-18-migrations"));
  const sourceRevision: string = await currentVerifierRevision();
  for (const stage of expectedStages) {
    const receipt: any = await readJsonIfExists(`${REPORT_DIR}/stages/${stage}.json`);
    if (!receipt || receipt.stage !== stage || receipt.passed !== true) {
      findings.push(`focused-receipt:${stage}:missing-or-failed`);
      continue;
    }
    if (receipt.sourceRevision !== sourceRevision) {
      findings.push(`focused-receipt:${stage}:stale`);
    }
    if (receipt.capacityCertified === true) findings.push(`focused-receipt:${stage}:certified-conformance`);
  }
  const removedPaths: readonly string[] = Object.freeze([
    "packages/foundation/src/checkpoint/tree/pactium-substrate-preflight.ts",
    "packages/foundation/src/checkpoint/tree/pactium-canonical-safe.ts"
  ]);
  for (const removedPath of removedPaths) {
    if (await exists(removedPath)) findings.push(`removed-path:${removedPath}`);
  }
  for (const relativePath of ["package.json", "package-lock.json", "packages/foundation/package.json"]) {
    const source: any = await readTextIfExists(relativePath);
    if (/"p-limit"|from ["']p-limit["']/u.test(source)) findings.push(`removed-dependency:${relativePath}:p-limit`);
  }
  for (const root of ["apps", "packages"]) {
    for (const relativePath of await collectFiles(root)) {
      if (!/\.(?:ts|json)$/u.test(relativePath)) continue;
      const source: any = await readTextIfExists(relativePath);
      if (/concurrencySafe|concurrencyGroup/u.test(source)) findings.push(`removed-operation-contract:${relativePath}`);
    }
  }
  assert.strictEqual(findings.length, 0, `CAP-18 migration findings: ${findings.join(", ")}`);
  return {
    stage: "cap-18-migrations",
    passed: true,
    counters: { findings: 0, focusedReceipts: expectedStages.length, removedPaths: removedPaths.length },
    capacityCertified: false
  };
}

async function stageCap18Profile() : Promise<any> {
  const profile: any = await readJsonIfExists("tools/registry/runtime-capacity-profile.registry.json");
  assert.strictEqual(profile?.schemaVersion, "v0.0.1:runtime:capacity-profile-gate-1");
  assert.strictEqual(profile?.privacy?.allowRuntimePayloads, false);
  assert.strictEqual(profile?.privacy?.allowServiceAddresses, false);
  assert.strictEqual(profile?.privacy?.allowMachinePaths, false);
  const closedReplay: any = await replayCatalogDeterminism();
  assert.strictEqual(closedReplay.identical, true);
  let deterministicOpenLoops: number = 0;
  for (const workload of RUNTIME_CAPACITY_WORKLOAD_CATALOG.openLoop) {
    const first: any = await runOpenLoopWorkload(workload);
    const second: any = await runOpenLoopWorkload(workload);
    assert.deepStrictEqual(first.counters, second.counters);
    deterministicOpenLoops += 1;
  }
  if (profile.authorized !== true) {
    assert.strictEqual(profile.capacityCertified, false);
    assert.match(String(profile.nonCertificationReason || ""), /^[a-z][a-z0-9_]{2,80}$/u);
    return {
      stage: "cap-18-profile",
      passed: true,
      reasonCode: profile.nonCertificationReason,
      counters: {
        closedLoopWorkloads: finiteCount(closedReplay.workloadCount),
        openLoopWorkloads: finiteCount(deterministicOpenLoops),
        profileAuthorized: 0
      },
      capacityCertified: false
    };
  }
  throw new Error("authorized_capacity_profile_runner_not_configured");
}

async function stageCap18Contract() : Promise<any> {
  const findings: any[] = [];
  for (const stage of ["cap-18-migrations", "cap-18-profile"]) {
    const receipt: any = await readJsonIfExists(`${REPORT_DIR}/stages/${stage}.json`);
    if (!receipt || receipt.passed !== true) findings.push(`release-receipt:${stage}:missing-or-failed`);
  }
  const manifest: any = JSON.parse(await readText("package.json"));
  if (!String(manifest.scripts?.["verify:runtime-capacity-convergence"] || "").includes("verify-runtime-capacity-convergence.ts")) {
    findings.push("package-script:runtime-capacity-convergence-missing");
  }
  const profile: any = await readJsonIfExists("tools/registry/runtime-capacity-profile.registry.json");
  if (profile?.authorized !== false) findings.push("capacity-profile:authorization-invalid");
  if (profile?.capacityCertified !== false) findings.push("capacity-profile:certification-invalid");
  if (profile?.nonCertificationReason !== "owner_profile_not_authorized") {
    findings.push("capacity-profile:non-certification-reason-invalid");
  }
  assert.strictEqual(findings.length, 0, `CAP-18 contract findings: ${findings.join(", ")}`);
  return {
    stage: "cap-18-contract",
    passed: true,
    counters: { findings: 0, joinedReceipts: 2 },
    capacityCertified: false,
    reasonCode: "owner_profile_not_authorized"
  };
}

async function stagePactiumRelease() : Promise<any> {
  const pactiumRoot: any = await findPactiumRoot();
  const result: any = runCommand("npm", ["run", "verify:release"], { cwd: pactiumRoot });
  assert.strictEqual(result.status, 0, `Pactium release verification failed\n${result.stdout}\n${result.stderr}`);
  return {
    stage: "pactium-release",
    passed: true,
    counters: { releaseGatePassed: 1, outputBytes: Buffer.byteLength(result.stdout + result.stderr) },
    capacityCertified: false
  };
}

async function stageCap18() : Promise<any> {
  const findings: any[] = [];
  const sourceRevision: string = await currentVerifierRevision();
  for (const stage of ["cap-18-migrations", "cap-18-profile", "cap-18-contract"]) {
    const receipt: any = await readJsonIfExists(`${REPORT_DIR}/stages/${stage}.json`);
    if (!receipt || receipt.passed !== true || receipt.sourceRevision !== sourceRevision) {
      findings.push(`cap-18-receipt:${stage}:missing-failed-or-stale`);
    }
  }
  assert.strictEqual(findings.length, 0, `CAP-18 aggregate findings: ${findings.join(", ")}`);
  return {
    stage: "cap-18",
    passed: true,
    reasonCode: "owner_profile_not_authorized",
    counters: { findings: 0, joinedReceipts: 3 },
    capacityCertified: false
  };
}

const STAGE_RUNNERS: Record<string, any> = {
  "cap-00": stageCap00,
  "cap-01": stageCap01,
  "cap-02": stageCap02,
  "cap-03": stageCap03,
  "cap-04": stageCap04,
  "cap-05": stageCap05,
  "cap-06a": stageCap06a,
  "cap-06b": stageCap06b,
  "cap-07": stageCap07,
  "cap-08": stageCap08,
  "cap-09": stageCap09,
  "cap-10a": stageCap10a,
  "cap-10b": stageCap10b,
  "cap-11": stageCap11,
  "cap-12": stageCap12,
  "cap-13-queue": () : any => stageCap13("cap-13-queue"),
  "cap-13-evidence": () : any => stageCap13("cap-13-evidence"),
  "cap-13-authorization": () : any => stageCap13("cap-13-authorization"),
  "cap-13-measured": () : any => stageCap13("cap-13-measured"),
  "cap-14a": () : any => stageCap14("cap-14a"),
  "cap-14b": () : any => stageCap14("cap-14b"),
  "cap-14c": () : any => stageCap14("cap-14c"),
  "cap-15": stageCap15,
  "cap-16": stageCap16,
  "cap-17": stageCap17,
  "cap-18-migrations": stageCap18Migrations,
  "cap-18-profile": stageCap18Profile,
  "cap-18-contract": stageCap18Contract,
  "cap-18": stageCap18,
  "pactium-release": stagePactiumRelease
};

async function runStage(stage: any = "") : Promise<any> {
  if (!STAGE_REGISTRY.includes(stage)) {
    return {
      stage,
      passed: false,
      reasonCode: "unknown_stage",
      counters: {},
      capacityCertified: false
    };
  }
  const runner: any = STAGE_RUNNERS[stage];
  if (!runner) {
    return stageNotImplemented(stage);
  }
  return runner();
}

async function main() : Promise<any> {
  const startedAt: any = new Date();
  const stageOptionIndex: number = process.argv.indexOf("--stage");
  const stageArg: any = process.argv.find((argument?: any) : any => argument.startsWith("--stage=")) ||
    (stageOptionIndex >= 0 ? process.argv[stageOptionIndex + 1] || "" : "");
  const requestedStages: any[] = stageArg
    ? [stageArg.replace(/^--stage=/, "").toLowerCase()]
    : [...STAGE_REGISTRY];
  const results: any[] = [];
  for (const stage of requestedStages) {
    try {
      const result: any = await runStage(stage);
      results.push(result);
      await writeStageReceipt(result);
    } catch (error: any) {
      console.error(`[stage:${stage}] ${error instanceof Error ? error.stack || error.message : String(error)}`);
      const result: any = {
        stage,
        passed: false,
        reasonCode: String(error?.code || "stage_failed"),
        error: error instanceof Error ? error.message : String(error),
        counters: {},
        capacityCertified: false
      };
      results.push(result);
      await writeStageReceipt(result);
    }
  }
  const allPassed: any = results.every((result?: any) : any => result.passed === true);
  const report: Record<string, any> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    verifier,
    stages: results.map((result?: any) : any => ({
      stage: result.stage,
      passed: result.passed === true,
      reasonCode: result.reasonCode || "",
      capacityCertified: result.capacityCertified === true,
      counters: result.counters || {}
    })),
    privacyScan: {
      passed: true
    },
    summary: {
      passed: allPassed,
      stageCount: results.length,
      stagePassCount: results.filter((result?: any) : any => result.passed).length,
      capacityCertified: false,
      reasonCode: allPassed ? "" : "focused_stage_failure"
    }
  };
  const provenance: Record<string, any> = {
    producer: "meshrix-core-runtime-capacity-convergence",
    commandId: "runtime-capacity-convergence",
    sourceRevision: await currentVerifierRevision()
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "runtime capacity convergence report");
  assertReportProvenance(finalized, provenance);
  await fs.mkdir(repoPath(REPORT_DIR), { recursive: true });
  await fs.writeFile(
    repoPath(REPORT_RELATIVE_PATH),
    `${JSON.stringify(finalized, null, 2)}\n`,
    "utf8"
  );
  if (!allPassed) {
    console.error(
      `[runtime-capacity-convergence] failed stages=${JSON.stringify(
        results.filter((result?: any) : any => !result.passed).map((result?: any) : any => result.stage)
      )} reasons=${JSON.stringify(
        results.filter((result?: any) : any => !result.passed).map((result?: any) : any => result.reasonCode)
      )}`
    );
    process.exitCode = 1;
  } else {
    console.log(`[runtime-capacity-convergence] stages=${results.length} passed=${results.length} report=${REPORT_RELATIVE_PATH}`);
  }
}

await main();
