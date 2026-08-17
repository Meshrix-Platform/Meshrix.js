#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "./lib/release-evidence-readiness.ts";
import { assertNoSensitiveReportLeak } from "./lib/sensitive-report-scan.ts";
import { PRODUCTION_READINESS_GATES_REPORT_PATH } from "./lib/production-readiness-gates-evidence.ts";
import {
  defaultReleaseCommandParallelism,
  runReleaseCommandDag
} from "./lib/release-command-dag-runner.ts";
import { liveReadinessExitCode } from "./lib/live-readiness-exit-code.ts";
const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PRODUCTION_READINESS_GATE_TIMEOUT_MS: any = 12 * 60 * 1000;

export const PRODUCTION_READINESS_GATES: readonly any[] = Object.freeze([
  {
    id: "local-stdio-interface-lockdown",
    label: "Local stdio interface lockdown",
    owner: "security-boundary",
    verifier: "tools/server-scripts/verify-security-local-stdio-lockdown.ts",
    command: process.execPath,
    args: ["--conditions=source", "tools/server-scripts/verify-security-local-stdio-lockdown.ts"]
  },
  {
    id: "risk-control-model",
    label: "Risk Control operation model",
    owner: "security-boundary",
    verifier: "tools/server-scripts/verify-risk-control-model.ts",
    command: process.execPath,
    args: ["--conditions=source", "tools/server-scripts/verify-risk-control-model.ts"]
  }

]);

function productionGateParallelism(env: any = process.env) : any {
  const configured: any = Number(
    env.MESHRIX_PRODUCTION_READINESS_PARALLELISM || env.MESHRIX_ACCEPTANCE_PARALLELISM || ""
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.trunc(configured));
  }
  return defaultReleaseCommandParallelism(env);
}

function redactedTail(value: any = "") : any {
  return String(value || "")
    .replace(/\/Users\/[^\s'"]+/gu, "<local-path>")
    .replace(/\/private\/[^\s'"]+/gu, "<local-path>")
    .replace(/\/var\/folders\/[^\s'"]+/gu, "<local-path>")
    .replace(/[A-Za-z]:\\[^\s"]+/gu, "<local-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]+\b/gu, "[redacted]")
    .slice(-1000);
}

function buildMissingEvidence(gateResults?: any) : any {
  return gateResults
    .filter((result?: any) : any => result.status === "blocked")
    .map((result?: any) : any => `gate-blocked:${result.id}`);
}

function createProductionGateAggregateReadiness(gateResults?: any, missingEvidence?: any) : any {
  const failedGates: any = gateResults.filter((result?: any) : any => result.status === "failed");
  return createAggregateReleaseEvidenceReadiness({
    allCommandsExecuted: gateResults.length === PRODUCTION_READINESS_GATES.length,
    failedCommandCount: failedGates.length,
    failedCommands: failedGates.map((result?: any) : any => result.id),
    missingEvidenceCount: missingEvidence.length,
    missingEvidence,
    reportLeakScan: true
  });
}

function buildProductionReadinessGateReport({
  startedAt,
  finishedAt,
  gateResults,
  missingEvidence,
  aggregateReadiness,
  gateSchedule
}: Record<string, any>) : any {
  const failedGates: any = gateResults.filter((result?: any) : any => result.status === "failed");
  const blockedGates: any = gateResults.filter((result?: any) : any => result.status === "blocked");
  const coreBlocked: any = aggregateReadiness.releaseReady !== true &&
    failedGates.length === 0 && missingEvidence.length > 0;
  return {
    schemaVersion: "v0.0.1:release:production-readiness-gates-report-1",
    projectionOnly: true,
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verifier: "tools/server-scripts/production-readiness-gate.ts",
    algorithm: {
      commandExecution: "Run server security verifiers as real Node processes through a bounded parallel DAG and aggregate only after every gate finishes.",
      boundary: "This report reduces only Core-owned server security evidence. Optional plugin and downstream product evidence remain outside this reducer."
    },
    gateSchedule,
    gates: gateResults.map((result?: any) : any => {
      const gate: any = PRODUCTION_READINESS_GATES.find((candidate?: any) : any => candidate.id === result.id) || {};
      return {
        id: result.id,
        owner: gate.owner || "",
        verifier: gate.verifier || "",
        status: result.status,
        exitCode: result.exitCode
      };
    }),
    summary: {
      totalGateCount: PRODUCTION_READINESS_GATES.length,
      executedGateCount: gateResults.length,
      allGatesExecuted: gateResults.length === PRODUCTION_READINESS_GATES.length,
      failedGateCount: failedGates.length,
      failedGates: failedGates.map((result?: any) : any => result.id),
      blockedGateCount: blockedGates.length,
      blockedGates: blockedGates.map((result?: any) : any => result.id),
      missingEvidenceCount: missingEvidence.length,
      missingEvidence,
      releaseReady: aggregateReadiness.releaseReady === true,
      blocked: coreBlocked,
      liveStatus: aggregateReadiness.releaseReady === true ? "passed" : coreBlocked ? "blocked" : "failed",
      releaseReadinessSourceOfTruth: aggregateReadiness.sourceOfTruth,
      releaseReadinessReasons: aggregateReadiness.reasons || [],
      reportLeakScan: true
    }
  };
}

async function writeProductionReadinessGateReport(report?: any) : Promise<any> {
  assertNoSensitiveReportLeak(report, "production readiness gate report");
  await fs.mkdir(path.join(repoRoot, path.dirname(PRODUCTION_READINESS_GATES_REPORT_PATH)), {
    recursive: true
  });
  await fs.writeFile(
    path.join(repoRoot, PRODUCTION_READINESS_GATES_REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const startedAt: any = new Date();
  const { results: rawGateResults, schedule: gateSchedule } = await runReleaseCommandDag({
    commands: PRODUCTION_READINESS_GATES.map((gate?: any) : any => ({
      ...gate,
      layer: `production.${gate.owner}`,
      parallelGroup: `production.${gate.owner}`,
      dependsOn: [],
      resourceLocks: [],
      // Preserve objective blockers as blocked (exit 2), not ordinary failures.
      blockedExitCodes: [2]
    })),
    defaultTimeoutMs: DEFAULT_PRODUCTION_READINESS_GATE_TIMEOUT_MS,
    env: process.env,
    logPrefix: "production-readiness",
    maxParallel: productionGateParallelism(process.env),
    redactTail: redactedTail,
    repoRoot,
    resolveCommand: (gate?: any) : any => ({
      executable: gate.command,
      args: gate.args,
      displayCommand: gate.verifier
    })
  });
  const gateResults: any = rawGateResults.map((result?: any) : any => ({
    id: result.id,
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    durationMs: result.durationMs
  }));
  const missingEvidence: any = buildMissingEvidence(gateResults);
  const aggregateReadiness: any = createProductionGateAggregateReadiness(gateResults, missingEvidence);
  const finishedAt: any = new Date();
  const report: any = buildProductionReadinessGateReport({
    startedAt,
    finishedAt,
    gateResults,
    missingEvidence,
    aggregateReadiness,
    gateSchedule
  });
  await writeProductionReadinessGateReport(report);
  const reportReadiness: any = createReleaseEvidenceReadiness(
    PRODUCTION_READINESS_GATES_REPORT_PATH,
    report
  );
  console.log(
    `[production-readiness] releaseReady=${report.summary.releaseReady} ` +
    `report=${PRODUCTION_READINESS_GATES_REPORT_PATH}`
  );
  const exitCode: any = liveReadinessExitCode(reportReadiness);
  if (exitCode !== 0) process.exit(exitCode);
}
