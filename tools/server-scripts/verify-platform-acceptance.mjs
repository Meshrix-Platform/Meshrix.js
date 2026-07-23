#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_ACCEPTANCE_REPORT_PATH
} from "./lib/platform-acceptance-report-catalog.mjs";
import {
  PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS,
  PLATFORM_ACCEPTANCE_STATE_MACHINE,
  commandExecutable,
  commandLine,
  normalizedParallelism,
  parsePlatformAcceptanceArgs as parseArgs,
  requirePlatformAcceptanceProfile
} from "./lib/platform-acceptance-contract.mjs";
export {
  PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS,
  PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS,
  PLATFORM_ACCEPTANCE_PARALLELISM,
  PLATFORM_ACCEPTANCE_STATE_MACHINE
} from "./lib/platform-acceptance-contract.mjs";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  PLATFORM_ACCEPTANCE_JOB_BUDGET_MS,
  PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE,
  REQUIRED_REPORT_SPEC_COVERAGE
} from "./lib/platform-acceptance-command-catalog.mjs";
export {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  PLATFORM_ACCEPTANCE_JOB_BUDGET_MS,
  PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE
} from "./lib/platform-acceptance-command-catalog.mjs";
import {
  acceptanceCriteria,
  aggregateChildReportLeakScan,
  classifyFinalState,
  failedEvidenceStateCommandIds,
  layerStatus,
  reduceCapabilityEvidenceExecution,
  reduceReleaseEvidenceStates,
  validateBlockedCommandResults
} from "./lib/platform-acceptance-reducer.mjs";
import {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./lib/platform-acceptance-ledger-anchor.mjs";
export {
  aggregateChildReportLeakScan,
  failedEvidenceStateCommandIds,
  layerStatus,
  reduceCapabilityEvidenceExecution,
  reduceReleaseEvidenceStates,
  validateBlockedCommandResults
} from "./lib/platform-acceptance-reducer.mjs";
export {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./lib/platform-acceptance-ledger-anchor.mjs";
import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "./lib/release-evidence-readiness.mjs";
import {
  assertNoSensitiveReportLeak,
  sanitizeSensitiveError
} from "./lib/sensitive-report-scan.mjs";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.mjs";
import { reportPayloadDigest } from "../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import {
  ACCEPTANCE_GENERATION_POINTER,
  createAcceptanceGenerationWorkspace,
  publishAcceptanceGeneration,
  removeAcceptanceGenerationWorkspace,
  runAcceptanceGenerationWorker,
  withAcceptanceExecutionLease
} from "./lib/platform-acceptance-generation-store.mjs";
import {
  createReleaseCommandSchedule,
  runReleaseCommandDag
} from "./lib/release-command-dag-runner.mjs";
import {
  createCurrentRunReportDriftAudit,
  snapshotJsonReportFiles
} from "./lib/release-evidence-freshness.mjs";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest,
  stampReleaseReportProvenance
} from "./lib/release-report-provenance.mjs";
import { currentSourceTreeDigest } from "./lib/source-tree-digest.mjs";
import {
  PlatformAcceptancePlanReceiptError,
  verifyPlatformAcceptancePlanReceipts,
} from "./lib/platform-acceptance-plan-receipts.mjs";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE,
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  reducePlatformAcceptanceRequirementEvidence
} from "./lib/platform-acceptance-requirement-evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = PLATFORM_ACCEPTANCE_REPORT_PATH;
const RELEASE_EVIDENCE_INVENTORY = createReleaseEvidenceInventory({
  commands: PLATFORM_ACCEPTANCE_COMMANDS,
  requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
});
const RELEASE_EVIDENCE_INVENTORY_DIGEST = releaseEvidenceInventoryDigest(
  RELEASE_EVIDENCE_INVENTORY
);

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function redactedTail(value = "") {
  return sanitizeError(String(value || ""));
}

function sanitizeError(error) {
  return sanitizeSensitiveError(error).replaceAll("[redacted-path]", "<local-path>");
}

async function acceptanceEvidenceContext({ childReportLeakScan, planReceiptPreflight, selectedProfile }) {
  const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true
  }).stdout?.trim() || "";
  return Object.freeze({
    sourceRevision,
    sourceTreeDigest: currentSourceTreeDigest(repoRoot),
    selectedProfile,
    commandDagDigest: reportPayloadDigest({
      commands: PLATFORM_ACCEPTANCE_COMMANDS.map((command) => ({
        id: command.id,
        dependsOn: command.dependsOn,
        ownedReports: command.ownedReports,
        resourceLocks: command.resourceLocks,
        timeoutMs: command.timeoutMs
      }))
    }),
    ownedReportsInventoryDigest: RELEASE_EVIDENCE_INVENTORY_DIGEST,
    planReceiptSetDigest: planReceiptPreflight.planReceiptSetDigest,
    privacySafe: childReportLeakScan === true
  });
}

async function readReportText(relativePath) {
  try {
    return await fs.readFile(repoPath(relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeReport(relativePath) {
  if (!relativePath) return;
  await fs.rm(repoPath(relativePath), { force: true });
}

async function buildReportEvidence(minimumTimestampMs, expectedProvenanceByPath) {
  const evidence = {};
  const missingReports = [];
  const invalidReports = [];
  const missingEvidence = [];
  for (const reportPath of ACCEPTANCE_REQUIRED_REPORTS) {
    const rawReport = await readReportText(reportPath);
    if (rawReport === null) {
      missingReports.push(reportPath);
      missingEvidence.push(`report-missing:${reportPath}`);
      continue;
    }
    const readiness = createReleaseEvidenceReadiness(reportPath, rawReport, {
      minimumTimestampMs,
      expectedReleaseEvidenceProvenance: expectedProvenanceByPath.get(reportPath)
    });
    evidence[reportPath] = {
      // factsReady is the named-reducer projection; releaseReady remains only as transitional alias.
      factsReady: readiness.releaseReady === true,
      releaseReady: readiness.releaseReady === true,
      coverageReady: readiness.coverageReady === true,
      reportLeakScan: readiness.reportLeakScan === true,
      validationPassed: readiness.requiredReportValidationPassed === true,
      liveStatus: readiness.liveStatus || "",
      sourceOfTruth: readiness.sourceOfTruth || "",
      reducerSourceOfTruth: readiness.reducerSourceOfTruth || readiness.sourceOfTruth || "",
      validationSourceOfTruth: readiness.requiredReportValidationSourceOfTruth || "",
      specSourceOfTruth: readiness.requiredReportSpecSourceOfTruth || "",
      reasons: readiness.reasons || []
    };
    if (readiness.requiredReportValidationPassed !== true) {
      invalidReports.push(reportPath);
    }
    if (readiness.releaseReady !== true) {
      missingEvidence.push(`report-ready:${reportPath}`);
      for (const reason of readiness.reasons || []) {
        missingEvidence.push(`report-ready-reason:${reportPath}:${reason}`);
      }
    }
  }
  return { evidence, missingReports, invalidReports, missingEvidence };
}

async function writeReport(report) {
  assertNoSensitiveReportLeak(report, "platform acceptance report");
  await writePrivateFileAtomic(
    repoPath(REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

export function createPlatformAcceptancePlan(
  schedule = createReleaseCommandSchedule(PLATFORM_ACCEPTANCE_COMMANDS),
  { selectedProfile } = {}
) {
  const generatedAt = new Date().toISOString();
  if (schedule?.valid !== true) throw new Error("Platform acceptance command schedule is invalid.");
  selectedProfile = requirePlatformAcceptanceProfile(selectedProfile);
  return {
    schemaVersion: "v0.0.1:acceptance:platform-report-2",
    status: "planned",
    generatedAt,
    verifier: "tools/server-scripts/verify-platform-acceptance.mjs",
    selectedProfile,
    stateMachine: {
      ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
      currentState: "planned",
      event: "build_plan"
    },
    commandSchedule: schedule,
    declaredWorstCaseEstimate: PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE,
    declaredJobBudgetMs: PLATFORM_ACCEPTANCE_JOB_BUDGET_MS,
    commands: PLATFORM_ACCEPTANCE_COMMANDS.map((item) => ({
      id: item.id,
      label: item.label,
      acceptanceLayer: item.acceptanceLayer,
      report: item.report || "",
      covers: item.covers || [],
      dependsOn: item.dependsOn || [],
      resourceLocks: item.resourceLocks || [],
      ownedReports: item.ownedReports || [],
      blockedExitCodes: item.blockedExitCodes || [],
      exclusive: item.exclusive === true
    })),
    requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
    releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
    releaseEvidenceInventoryDigest: RELEASE_EVIDENCE_INVENTORY_DIGEST,
    requirementEvidence: PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE,
    planReceiptPreflight: {
      consumerPlan: "end-to-end-release/release-acceptance",
      requiredKind: "final_validation",
      verifier: "tools/server-scripts/lib/platform-acceptance-plan-receipts.mjs",
    },
    summary: {
      commandCount: PLATFORM_ACCEPTANCE_COMMANDS.length,
      requiredReportCount: ACCEPTANCE_REQUIRED_REPORTS.length,
      requirementCount: PLATFORM_ACCEPTANCE_REQUIREMENTS.length,
      requiredReportSpecSourceOfTruth: REQUIRED_REPORT_SPEC_COVERAGE.sourceOfTruth,
      releaseReady: false,
      reportLeakScan: true
    }
  };
}

async function runAcceptanceWorker() {
  const { planOnly, selectedProfile } = parseArgs(process.argv.slice(2));
  const schedule = createReleaseCommandSchedule(PLATFORM_ACCEPTANCE_COMMANDS);
  if (planOnly) {
    const report = createPlatformAcceptancePlan(schedule, { selectedProfile });
    assertNoSensitiveReportLeak(report, "platform acceptance plan");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const planReceiptPreflight = await verifyPlatformAcceptancePlanReceipts({
    repoRoot,
    selectedProfile
  });

  const startedAt = new Date();
  const reportTreeBefore = await snapshotJsonReportFiles(repoRoot);
  await Promise.all(ACCEPTANCE_REQUIRED_REPORTS.map(removeReport));
  const commandEnv = {
    ...process.env,
    LICO_ACCEPTANCE_STARTED_AT_MS: String(startedAt.getTime())
  };
  const { results, schedule: executedSchedule } = await runReleaseCommandDag({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    defaultTimeoutMs: PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS,
    env: commandEnv,
    logPrefix: "platform-acceptance",
    maxParallel: normalizedParallelism(commandEnv),
    redactTail: redactedTail,
    repoRoot,
    resolveCommand: (item) => ({
      executable: commandExecutable(item.command),
      args: item.args,
      displayCommand: commandLine(item)
    }),
    beforeStart: async (item) => {
      if (item.report) {
        await removeReport(item.report);
      }
    }
  });
  const reportTreeAfter = await snapshotJsonReportFiles(repoRoot);
  const reportWriteAudit = createCurrentRunReportDriftAudit({
    beforeSnapshot: reportTreeBefore,
    afterSnapshot: reportTreeAfter,
    allowedReports: [...ACCEPTANCE_REQUIRED_REPORTS, REPORT_PATH]
  });

  const expectedProvenanceByPath = await stampReleaseReportProvenance({
    repoRoot,
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    results,
    requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
  });
  const {
    evidence: reportEvidence,
    missingReports,
    invalidReports,
    missingEvidence: reportMissingEvidence
  } = await buildReportEvidence(
    startedAt.getTime(),
    expectedProvenanceByPath
  );

  const blockedResultValidation = validateBlockedCommandResults(results, reportEvidence);
  const evidenceStateReduction = reduceReleaseEvidenceStates({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    results,
    reportEvidence
  });
  const failedResults = results.filter((result) => ["failed", "skipped"].includes(result.status));
  const commandFailureIds = [...new Set([
    ...failedResults.map((result) => result.id),
    ...blockedResultValidation.invalidBlockedCommandIds,
    ...(reportWriteAudit.consistent ? [] : ["unregistered-report-write"])
  ])];
  const capabilityReportText = await readReportText("build/reports/capability-acceptance-machines.json");
  let capabilityEvidenceBindings = [];
  if (capabilityReportText !== null) {
    try {
      capabilityEvidenceBindings = JSON.parse(capabilityReportText).evidenceBindings || [];
    } catch {
      capabilityEvidenceBindings = [];
    }
  }
  const capabilityEvidenceExecution = reduceCapabilityEvidenceExecution({
    bindings: capabilityEvidenceBindings,
    validBlockedCommandIds: blockedResultValidation.validBlockedCommandIds,
    reportEvidence,
    reportWriteAudit,
    results
  });
  const evidenceFailureCommandIds = failedEvidenceStateCommandIds(evidenceStateReduction);
  const failedCommandIds = [...new Set([
    ...commandFailureIds,
    ...evidenceFailureCommandIds,
    ...(capabilityEvidenceExecution.ready ? [] : ["capability-evidence-execution"])
  ])];
  const missingEvidence = [
    ...reportMissingEvidence,
    ...blockedResultValidation.validBlockedCommandIds.map((id) => `command-blocked:${id}`),
    ...evidenceStateReduction.nodes
      .filter((node) => node.state !== "current")
      .map((node) => `evidence-state:${node.commandId}:${node.state}`)
  ];
  const childReportLeakScan = aggregateChildReportLeakScan({
    requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
    reportEvidence,
    missingReports
  });
  let finalPlanReceiptPreflight = null;
  let planReceiptPreflightReady = true;
  try {
    finalPlanReceiptPreflight = await verifyPlatformAcceptancePlanReceipts({
      repoRoot,
      selectedProfile
    });
    if (finalPlanReceiptPreflight.planReceiptSetDigest !== planReceiptPreflight.planReceiptSetDigest) {
      planReceiptPreflightReady = false;
      missingEvidence.push("plan-receipt-set-drift");
    }
  } catch (error) {
    planReceiptPreflightReady = false;
    const code = error instanceof PlatformAcceptancePlanReceiptError
      ? error.code
      : "plan-receipt-preflight-failed";
    if (error instanceof PlatformAcceptancePlanReceiptError && error.classification === "failed") {
      failedCommandIds.push("plan-receipt-preflight");
    } else {
      missingEvidence.push(code);
    }
  }
  const skipLedgerAnchor = String(process.env.LICO_ACCEPTANCE_SKIP_LEDGER_ANCHOR || "").trim() === "1";
  let ledgerAnchor = {
    ledgerEventId: "",
    workspaceId: "",
    recordedAt: "",
    reportDigestCount: 0,
    error: skipLedgerAnchor ? "skipped:LICO_ACCEPTANCE_SKIP_LEDGER_ANCHOR=1" : "",
    verification: null
  };
  if (!skipLedgerAnchor && planReceiptPreflightReady) {
    const { createOperationProofSubstrate } = await import(
      "#lico/foundation/proof/proof-substrate/index"
    );
    const acceptanceLedgerDir = process.env.LICO_ACCEPTANCE_PROOF_LEDGER_DIR
      ? path.resolve(process.env.LICO_ACCEPTANCE_PROOF_LEDGER_DIR)
      : repoPath("build/acceptance-proof-ledger");
    const proofSubstrate = createOperationProofSubstrate({ dataDir: acceptanceLedgerDir });
    try {
      const evidenceContext = await acceptanceEvidenceContext({
        childReportLeakScan,
        planReceiptPreflight,
        selectedProfile
      });
      const releaseId = String(
        process.env.LICO_ACCEPTANCE_RELEASE_ID ||
        `platform-acceptance:${new Date().toISOString()}`
      );
      ledgerAnchor = {
        ...await anchorAcceptanceEvidence({
          proofSubstrate,
          reportEvidence,
          reportPaths: ACCEPTANCE_REQUIRED_REPORTS,
          evidenceContext,
          releaseId,
          repoRoot
        }),
        verification: null
      };
      if (ledgerAnchor.ledgerEventId) {
        ledgerAnchor.verification = await verifyAcceptanceEvidenceAnchor({
          proofSubstrate,
          ledgerEventId: ledgerAnchor.ledgerEventId,
          envelopeId: ledgerAnchor.envelopeId,
          workspaceId: ledgerAnchor.workspaceId,
          expectedReportDigests: ledgerAnchor.reportDigests,
          expectedEvidenceContext: ledgerAnchor.evidenceContext
        });
      }
      if (!ledgerAnchor.ledgerEventId || ledgerAnchor.verification?.ok !== true) {
        missingEvidence.push(
          `acceptance-ledger-anchor:${ledgerAnchor.error || ledgerAnchor.verification?.reason || "anchor_failed"}`
        );
      }
    } finally {
      await proofSubstrate.close?.();
    }
  } else if (skipLedgerAnchor) {
    missingEvidence.push("acceptance-ledger-anchor:explicitly-skipped");
  } else {
    missingEvidence.push("acceptance-ledger-anchor:plan-receipt-preflight-not-ready");
  }

  const requirementEvidence = reducePlatformAcceptanceRequirementEvidence({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    results,
    reportEvidence,
    aggregateFacts: {
      ledgerAnchorReady: Boolean(ledgerAnchor.ledgerEventId) && ledgerAnchor.verification?.ok === true,
      receiptPreflightReady: planReceiptPreflightReady &&
        finalPlanReceiptPreflight?.planReceiptSetDigest === planReceiptPreflight.planReceiptSetDigest,
      commandDagReady: executedSchedule.valid === true && results.length === PLATFORM_ACCEPTANCE_COMMANDS.length,
      inventoryReady: RELEASE_EVIDENCE_INVENTORY.length === ACCEPTANCE_REQUIRED_REPORTS.length,
      privacyReady: childReportLeakScan === true
    }
  });
  for (const node of requirementEvidence.nodes) {
    if (!node.ready) missingEvidence.push(`requirement-evidence:${node.requirement}`);
  }

  const reducedAcceptanceCriteria = acceptanceCriteria(results, reportEvidence, missingReports);
  const aggregateReadinessFinal = createAggregateReleaseEvidenceReadiness({
    allCommandsExecuted: results.length === PLATFORM_ACCEPTANCE_COMMANDS.length,
    failedCommandCount: failedCommandIds.length,
    failedCommands: failedCommandIds,
    missingEvidenceCount: missingEvidence.length,
    missingEvidence,
    reportLeakScan: childReportLeakScan
  });
  const finalState = aggregateReadinessFinal.releaseReady === true
    ? "accepted"
    : classifyFinalState({
      failedCommands: [
        ...failedCommandIds,
        ...invalidReports.map((reportPath) => `invalid-report:${reportPath}`)
      ],
      missingEvidence
    });
  const finishedAt = new Date();
  const report = {
    schemaVersion: "v0.0.1:acceptance:platform-report-2",
    status: finalState,
    selectedProfile,
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verifier: "tools/server-scripts/verify-platform-acceptance.mjs",
    algorithm: {
      commandExecutionMode: "dag-parallel-full-aggregation",
      commandExecution: "Run LicoMesh acceptance commands through a DAG with parallel downstream-gateway, upstream-gateway, and platform-capability layers, respecting dependencies and resource locks.",
      evidenceReduction: "Validate every Core acceptance-required report against the exact required-report schema, verifier, timestamp, leak-scan, ready-field, and reducer registry, then bind every checked Core capability criterion to a command that passed in this same DAG run. Client implementations, cryptographic evidence, platform adoption, and product receipts are not inputs; verifier-health failures and Core-actionable gaps remain release failures.",
      finalRegression: "Run private deployment open platform E2E only after the required upstream/downstream/platform acceptance dependencies pass."
    },
    stateMachine: {
      ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
      currentState: finalState,
      event: aggregateReadinessFinal.releaseReady === true
        ? "all_acceptance_criteria_ready"
        : failedCommandIds.length > 0 || invalidReports.length > 0
          ? "command_or_report_failed"
          : "missing_required_core_evidence"
    },
    commandSchedule: Object.fromEntries(
      Object.entries(executedSchedule).filter(([key]) => key !== "maxParallel")
    ),
    commands: results.map((result) => ({
      id: result.id,
      label: result.label,
      acceptanceLayer: PLATFORM_ACCEPTANCE_COMMANDS.find((item) => item.id === result.id)?.acceptanceLayer || "",
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      durationMs: result.durationMs,
      report: result.report || "",
      dependsOn: result.dependsOn || [],
      resourceLocks: result.resourceLocks || [],
      blockedExitCodes: result.blockedExitCodes || [],
      exclusive: result.exclusive === true
    })),
    acceptanceLayers: PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map((layer) => layerStatus(layer, results)),
    acceptanceCriteria: reducedAcceptanceCriteria,
    requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
    releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
    releaseEvidenceInventoryDigest: RELEASE_EVIDENCE_INVENTORY_DIGEST,
    requirementEvidence,
    planReceiptPreflight,
    finalPlanReceiptPreflight,
    reportEvidence,
    capabilityEvidenceExecution,
    blockedCommandValidation: blockedResultValidation,
    ledgerAnchor: {
      ledgerEventId: ledgerAnchor.ledgerEventId || "",
      envelopeId: ledgerAnchor.envelopeId || "",
      factId: ledgerAnchor.factId || "",
      workspaceId: ledgerAnchor.workspaceId || "",
      recordedAt: ledgerAnchor.recordedAt || "",
      reportDigestCount: Number(ledgerAnchor.reportDigestCount || 0),
      reportDigests: ledgerAnchor.reportDigests || [],
      evidenceContext: ledgerAnchor.evidenceContext || null,
      error: ledgerAnchor.error || "",
      verification: ledgerAnchor.verification || null,
      skipped: skipLedgerAnchor
    },
    summary: {
      commandCount: PLATFORM_ACCEPTANCE_COMMANDS.length,
      executedCommandCount: results.length,
      allCommandsExecuted: results.length === PLATFORM_ACCEPTANCE_COMMANDS.length,
      failedCommandCount: failedCommandIds.length,
      failedCommands: failedCommandIds,
      blockedCommandCount: blockedResultValidation.validBlockedCommandIds.length,
      blockedCommands: blockedResultValidation.validBlockedCommandIds,
      capabilityEvidenceExecutionReady: capabilityEvidenceExecution.ready,
      capabilityEvidenceExecutionFailureCount: capabilityEvidenceExecution.reasons.length,
      capabilityEvidenceExecutionFailures: capabilityEvidenceExecution.reasons,
      missingReportCount: missingReports.length,
      missingReports,
      invalidReportCount: invalidReports.length,
      invalidReports,
      missingEvidenceCount: missingEvidence.length,
      missingEvidence,
      requiredReportCount: ACCEPTANCE_REQUIRED_REPORTS.length,
      requirementCount: requirementEvidence.requirementCount,
      readyRequirementCount: requirementEvidence.readyCount,
      requirementEvidenceReady: requirementEvidence.ready,
      requiredReportSpecSourceOfTruth: REQUIRED_REPORT_SPEC_COVERAGE.sourceOfTruth,
      acceptanceReadinessSourceOfTruth: aggregateReadinessFinal.sourceOfTruth,
      acceptanceReadinessReasons: aggregateReadinessFinal.reasons,
      ledgerEventId: ledgerAnchor.ledgerEventId || "",
      ledgerAnchorReady: Boolean(ledgerAnchor.ledgerEventId) && ledgerAnchor.verification?.ok === true,
      releaseReady: aggregateReadinessFinal.releaseReady === true,
      reportLeakScan: childReportLeakScan
    }
  };

  await writeReport(report);
  console.log(`[platform-acceptance] status=${finalState} releaseReady=${report.summary.releaseReady} failed=${failedCommandIds.length} blocked=${blockedResultValidation.validBlockedCommandIds.length} missingEvidence=${missingEvidence.length} ledgerEventId=${report.summary.ledgerEventId || "none"} report=${REPORT_PATH}`);
  if (aggregateReadinessFinal.releaseReady !== true) {
    process.exitCode = finalState === "blocked" ? 2 : 1;
  }
}

async function runAcceptanceOrchestrator(selectedProfile) {
  return withAcceptanceExecutionLease(repoRoot, async () => {
    const paths = await createAcceptanceGenerationWorkspace(repoRoot);
    try {
      const result = await runAcceptanceGenerationWorker({
        repoRoot,
        workspace: paths.workspace,
        args: [
          "tools/server-scripts/verify-platform-acceptance.mjs",
          "--profile",
          selectedProfile
        ]
      });
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
        return;
      }
      await publishAcceptanceGeneration({
        repoRoot,
        paths,
        requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
        aggregateReportPath: REPORT_PATH,
        releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
      });
      console.log(
        `[platform-acceptance] generation=${paths.id} published=${ACCEPTANCE_GENERATION_POINTER}`
      );
    } finally {
      await removeAcceptanceGenerationWorkspace(paths);
    }
  });
}

async function main() {
  const { planOnly, selectedProfile } = parseArgs(process.argv.slice(2));
  if (planOnly || process.env.LICO_ACCEPTANCE_GENERATION_WORKER === "1") {
    await runAcceptanceWorker();
    return;
  }
  await runAcceptanceOrchestrator(selectedProfile);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(async (error) => {
    const generationWorker = process.env.LICO_ACCEPTANCE_GENERATION_WORKER === "1";
    if (!generationWorker) {
      console.error(sanitizeError(error));
      process.exit(1);
    }
    let selectedProfile;
    try {
      ({ selectedProfile } = parseArgs(process.argv.slice(2)));
    } catch {
      console.error(sanitizeError(error));
      process.exit(1);
    }
    const now = new Date();
    const planReceiptBlocked = error instanceof PlatformAcceptancePlanReceiptError &&
      error.classification === "blocked";
    const safeFailure = error instanceof PlatformAcceptancePlanReceiptError
      ? error.code
      : sanitizeError(error);
    const report = {
      schemaVersion: "v0.0.1:acceptance:platform-report-2",
      status: planReceiptBlocked ? "blocked" : "failed",
      selectedProfile,
      generatedAt: now.toISOString(),
      verifier: "tools/server-scripts/verify-platform-acceptance.mjs",
      stateMachine: {
        ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
        currentState: planReceiptBlocked ? "blocked" : "failed",
        event: planReceiptBlocked ? "missing_required_core_evidence" : "command_or_report_failed"
      },
      summary: {
        releaseReady: false,
        failedCommandCount: planReceiptBlocked ? 0 : 1,
        failedCommands: planReceiptBlocked ? [] : ["platform-acceptance"],
        missingEvidenceCount: 1,
        missingEvidence: [`platform-acceptance:${safeFailure}`],
        // Unexecuted privacy evidence is not a detected leak.
        privacyEvidenceExecuted: false,
        reportLeakScan: null
      }
    };
    try {
      await writeReport(report);
    } catch {
      // Preserve the original failure path.
    }
    console.error(safeFailure);
    process.exit(planReceiptBlocked ? 2 : 1);
  });
}
