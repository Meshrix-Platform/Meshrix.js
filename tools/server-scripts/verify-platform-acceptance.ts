#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_ACCEPTANCE_REPORT_PATH,
  PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST
} from "./lib/platform-acceptance-report-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
  PLATFORM_ACCEPTANCE_STATE_MACHINE,
  commandExecutable,
  commandLine,
  normalizedParallelism,
  parsePlatformAcceptanceArgs as parseArgs,
  requirePlatformAcceptanceProfile
} from "./lib/platform-acceptance-contract.ts";
export {
  PLATFORM_ACCEPTANCE_PARALLELISM,
  PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
  PLATFORM_ACCEPTANCE_STATE_MACHINE
} from "./lib/platform-acceptance-contract.ts";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  REQUIRED_REPORT_SPEC_COVERAGE
} from "./lib/platform-acceptance-command-catalog.ts";
export {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS,
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS
} from "./lib/platform-acceptance-command-catalog.ts";
import {
  acceptanceCriteria,
  aggregateChildReportLeakScan,
  failedEvidenceStateCommandIds,
  layerStatus,
  reduceCapabilityEvidenceExecution,
  reduceReleaseEvidenceStates,
  validateBlockedCommandResults
} from "./lib/platform-acceptance-reducer.ts";
import {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./lib/platform-acceptance-ledger-anchor.ts";
export {
  aggregateChildReportLeakScan,
  failedEvidenceStateCommandIds,
  layerStatus,
  reduceCapabilityEvidenceExecution,
  reduceReleaseEvidenceStates,
  validateBlockedCommandResults
} from "./lib/platform-acceptance-reducer.ts";
export {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./lib/platform-acceptance-ledger-anchor.ts";
import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "./lib/release-evidence-readiness.ts";
import {
  assertNoSensitiveReportLeak,
  sanitizeSensitiveError
} from "./lib/sensitive-report-scan.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";
import { reportPayloadDigest } from "../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  ACCEPTANCE_GENERATION_POINTER,
  createAcceptanceGenerationWorkspace,
  publishAcceptanceGeneration,
  publishAcceptanceFailureDiagnostic,
  removeAcceptanceGenerationWorkspace,
  runAcceptanceGenerationWorker,
  withAcceptanceExecutionLease
} from "./lib/platform-acceptance-generation-store.ts";
import {
  createReleaseCommandSchedule,
  runReleaseCommandDag
} from "./lib/release-command-dag-runner.ts";
import {
  createCurrentRunReportDriftAudit,
  snapshotJsonReportFiles
} from "./lib/release-evidence-freshness.ts";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest,
  stampReleaseReportProvenance
} from "./lib/release-report-provenance.ts";
import { currentSourceTreeDigest } from "./lib/source-tree-digest.ts";
import { createReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE,
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  reducePlatformAcceptanceRequirementEvidence
} from "./lib/platform-acceptance-requirement-evidence.ts";

const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const authorityRoot: any = process.env.MESHRIX_ACCEPTANCE_AUTHORITY_ROOT
  ? path.resolve(process.env.MESHRIX_ACCEPTANCE_AUTHORITY_ROOT)
  : repoRoot;
const REPORT_PATH: any = PLATFORM_ACCEPTANCE_REPORT_PATH;
const RELEASE_EVIDENCE_INVENTORY: any = createReleaseEvidenceInventory({
  commands: PLATFORM_ACCEPTANCE_COMMANDS,
  requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
});
const RELEASE_EVIDENCE_INVENTORY_DIGEST: any = releaseEvidenceInventoryDigest(
  RELEASE_EVIDENCE_INVENTORY
);

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

function redactedTail(value: any = "") : any {
  return sanitizeError(String(value || ""));
}

function sanitizeError(error?: any) : any {
  return sanitizeSensitiveError(error).replaceAll("[redacted-path]", "<local-path>");
}

async function acceptanceEvidenceContext({ childReportLeakScan, candidateIdentity, selectedProfile }: Record<string, any>) : Promise<any> {
  return Object.freeze({
    sourceRevision: candidateIdentity.source_revision,
    sourceTreeDigest: currentSourceTreeDigest(repoRoot),
    selectedProfile,
    commandDagDigest: reportPayloadDigest({
      commands: PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => ({
        id: command.id,
        dependsOn: command.dependsOn,
        ownedReports: command.ownedReports,
        resourceLocks: command.resourceLocks
      }))
    }),
    ownedReportsInventoryDigest: RELEASE_EVIDENCE_INVENTORY_DIGEST,
    candidateDigest: candidateIdentity.candidate_digest,
    privacySafe: childReportLeakScan === true
  });
}

async function readReportText(relativePath?: any) : Promise<any> {
  try {
    return await fs.readFile(repoPath(relativePath), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeReport(relativePath?: any) : Promise<any> {
  if (!relativePath) return;
  await fs.rm(repoPath(relativePath), { force: true });
}

async function buildReportEvidence(minimumTimestampMs?: any, expectedProvenanceByPath?: any) : Promise<any> {
  const evidence: Record<string, any> = {};
  const missingReports: any[] = [];
  const invalidReports: any[] = [];
  const missingEvidence: any[] = [];
  for (const reportPath of ACCEPTANCE_REQUIRED_REPORTS) {
    const rawReport: any = await readReportText(reportPath);
    if (rawReport === null) {
      missingReports.push(reportPath);
      missingEvidence.push(`report-missing:${reportPath}`);
      continue;
    }
    const readiness: any = createReleaseEvidenceReadiness(reportPath, rawReport, {
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

async function writeReport(report?: any) : Promise<any> {
  assertNoSensitiveReportLeak(report, "platform acceptance report");
  await writePrivateFileAtomic(
    repoPath(REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

export function createPlatformAcceptancePlan(
  schedule: any = createReleaseCommandSchedule(PLATFORM_ACCEPTANCE_COMMANDS),
  { selectedProfile }: Record<string, any> = {}
) : any {
  const generatedAt: any = new Date().toISOString();
  if (schedule?.valid !== true) throw new Error("Platform acceptance command schedule is invalid.");
  selectedProfile = requirePlatformAcceptanceProfile(selectedProfile);
  return {
    schemaVersion: PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
    acceptanceStandard: "functional-completeness",
    claim: "functional-complete",
    status: "planned",
    generatedAt,
    verifier: "tools/server-scripts/verify-platform-acceptance.ts",
    selectedProfile,
    stateMachine: {
      ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
      currentState: "planned",
      event: "build_plan"
    },
    commandSchedule: schedule,
    commands: PLATFORM_ACCEPTANCE_COMMANDS.map((item?: any) : any => ({
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
    candidateIdentity: {
      requiredProfile: selectedProfile,
      requiredKind: "canonical-clean-source-candidate",
      verifier: "tools/server-scripts/verify-release-candidate-identity.ts",
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

async function runAcceptanceWorker() : Promise<any> {
  const { planOnly, selectedProfile } = parseArgs(process.argv.slice(2));
  const schedule: any = createReleaseCommandSchedule(PLATFORM_ACCEPTANCE_COMMANDS);
  if (planOnly) {
    const report: any = createPlatformAcceptancePlan(schedule, { selectedProfile });
    assertNoSensitiveReportLeak(report, "platform acceptance plan");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const candidateIdentity: any = await createReleaseCandidateIdentity({ repoRoot });
  if (!candidateIdentity.supported_profiles.includes(selectedProfile)) {
    throw new Error("release_candidate_profile_mismatch");
  }

  const startedAt: any = new Date();
  const reportTreeBefore: any = await snapshotJsonReportFiles(repoRoot);
  await Promise.all(ACCEPTANCE_REQUIRED_REPORTS.map(removeReport));
  const commandEnv: Record<string, any> = {
    ...process.env,
    MESHRIX_ACCEPTANCE_STARTED_AT_MS: String(startedAt.getTime())
  };
  const { results, schedule: executedSchedule } = await runReleaseCommandDag({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    env: commandEnv,
    logPrefix: "platform-acceptance",
    maxParallel: normalizedParallelism(commandEnv),
    redactTail: redactedTail,
    repoRoot,
    resolveCommand: (item?: any) : any => ({
      executable: commandExecutable(item.command),
      args: item.args,
      displayCommand: commandLine(item)
    }),
    beforeStart: async (item?: any) : Promise<any> => {
      if (item.report) {
        await removeReport(item.report);
      }
    }
  });
  const reportTreeAfter: any = await snapshotJsonReportFiles(repoRoot);
  const reportWriteAudit: any = createCurrentRunReportDriftAudit({
    beforeSnapshot: reportTreeBefore,
    afterSnapshot: reportTreeAfter,
    allowedReports: [...ACCEPTANCE_REQUIRED_REPORTS, ...PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST, REPORT_PATH]
  });

  const expectedProvenanceByPath: any = await stampReleaseReportProvenance({
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

  const blockedResultValidation: any = validateBlockedCommandResults(results, reportEvidence);
  const evidenceStateReduction: any = reduceReleaseEvidenceStates({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    results,
    reportEvidence
  });
  const failedResults: any = results.filter((result?: any) : any => ["failed", "skipped"].includes(result.status));
  const commandFailureIds: any[] = [...new Set<any>([
    ...failedResults.map((result?: any) : any => result.id),
    ...blockedResultValidation.invalidBlockedCommandIds,
    ...(reportWriteAudit.consistent ? [] : ["unregistered-report-write"])
  ])];
  const capabilityReportText: any = await readReportText("build/reports/capability-acceptance-machines.json");
  let capabilityEvidenceBindings: any[] = [];
  if (capabilityReportText !== null) {
    try {
      capabilityEvidenceBindings = JSON.parse(capabilityReportText).evidenceBindings || [];
    } catch {
      capabilityEvidenceBindings = [];
    }
  }
  const capabilityEvidenceExecution: any = reduceCapabilityEvidenceExecution({
    bindings: capabilityEvidenceBindings,
    validBlockedCommandIds: blockedResultValidation.validBlockedCommandIds,
    reportEvidence,
    reportWriteAudit,
    results
  });
  const evidenceFailureCommandIds: any = failedEvidenceStateCommandIds(evidenceStateReduction);
  const failedCommandIds: any[] = [...new Set<any>([
    ...commandFailureIds,
    ...evidenceFailureCommandIds,
    ...(capabilityEvidenceExecution.ready ? [] : ["capability-evidence-execution"])
  ])];
  const missingEvidence: any[] = [
    ...reportMissingEvidence,
    ...blockedResultValidation.validBlockedCommandIds.map((id?: any) : any => `command-blocked:${id}`),
    ...evidenceStateReduction.nodes
      .filter((node?: any) : any => node.state !== "current")
      .map((node?: any) : any => `evidence-state:${node.commandId}:${node.state}`)
  ];
  const childReportLeakScan: any = aggregateChildReportLeakScan({
    requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
    reportEvidence,
    missingReports
  });
  let finalCandidateIdentity: any = null;
  let candidateIdentityReady: any = true;
  try {
    finalCandidateIdentity = await createReleaseCandidateIdentity({ repoRoot });
    if (finalCandidateIdentity.candidate_digest !== candidateIdentity.candidate_digest) {
      candidateIdentityReady = false;
      missingEvidence.push("release-candidate-identity-drift");
    }
  } catch (error: any) {
    candidateIdentityReady = false;
    failedCommandIds.push("release-candidate-identity");
    missingEvidence.push(String(error?.code || "release-candidate-identity-failed"));
  }
  const skipLedgerAnchor: any = String(process.env.MESHRIX_ACCEPTANCE_SKIP_LEDGER_ANCHOR || "").trim() === "1";
  let ledgerAnchor: Record<string, any> = {
    ledgerEventId: "",
    workspaceId: "",
    recordedAt: "",
    reportDigestCount: 0,
    error: skipLedgerAnchor ? "skipped:MESHRIX_ACCEPTANCE_SKIP_LEDGER_ANCHOR=1" : "",
    verification: null
  };
  if (!skipLedgerAnchor && candidateIdentityReady) {
    const { createOperationProofSubstrate } = await import(
      "#meshrix/foundation/proof/proof-substrate/index"
    );
    const acceptanceLedgerDir: any = process.env.MESHRIX_ACCEPTANCE_PROOF_LEDGER_DIR
      ? path.resolve(process.env.MESHRIX_ACCEPTANCE_PROOF_LEDGER_DIR)
      : repoPath("build/acceptance-proof-ledger");
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: acceptanceLedgerDir });
    try {
      const evidenceContext: any = await acceptanceEvidenceContext({
        childReportLeakScan,
        candidateIdentity,
        selectedProfile
      });
      const releaseId: any = String(
        process.env.MESHRIX_ACCEPTANCE_RELEASE_ID ||
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
    missingEvidence.push("acceptance-ledger-anchor:release-candidate-identity-not-ready");
  }

  const requirementEvidence: any = reducePlatformAcceptanceRequirementEvidence({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    results,
    reportEvidence,
    aggregateFacts: {
      ledgerAnchorReady: Boolean(ledgerAnchor.ledgerEventId) && ledgerAnchor.verification?.ok === true,
      candidateIdentityReady: candidateIdentityReady &&
        finalCandidateIdentity?.candidate_digest === candidateIdentity.candidate_digest,
      commandDagReady: executedSchedule.valid === true && results.length === PLATFORM_ACCEPTANCE_COMMANDS.length,
      inventoryReady: RELEASE_EVIDENCE_INVENTORY.length === ACCEPTANCE_REQUIRED_REPORTS.length,
      privacyReady: childReportLeakScan === true
    }
  });
  for (const node of requirementEvidence.nodes) {
    if (!node.ready) missingEvidence.push(`requirement-evidence:${node.requirement}`);
  }

  const reducedAcceptanceCriteria: any = acceptanceCriteria(results, reportEvidence, missingReports);
  const aggregateReadinessFinal: any = createAggregateReleaseEvidenceReadiness({
    allCommandsExecuted: results.length === PLATFORM_ACCEPTANCE_COMMANDS.length,
    failedCommandCount: failedCommandIds.length,
    failedCommands: failedCommandIds,
    missingEvidenceCount: missingEvidence.length,
    missingEvidence,
    reportLeakScan: childReportLeakScan
  });
  const finalState: any = aggregateReadinessFinal.releaseReady === true ? "accepted" : "failed";
  const finishedAt: any = new Date();
  const report: Record<string, any> = {
    schemaVersion: PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
    acceptanceStandard: "functional-completeness",
    claim: "functional-complete",
    candidate_digest: candidateIdentity.candidate_digest,
    status: finalState,
    selectedProfile,
    sourceRevision: ledgerAnchor.evidenceContext?.sourceRevision || "",
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verifier: "tools/server-scripts/verify-platform-acceptance.ts",
    algorithm: {
      commandExecutionMode: "dag-parallel-full-aggregation",
      commandExecution: "Run Meshrix.js acceptance commands through a DAG with parallel downstream-gateway, upstream-gateway, and platform-capability layers, respecting dependencies and resource locks.",
      evidenceReduction: "Validate every Core acceptance-required report against the exact required-report schema, verifier, timestamp, leak-scan, ready-field, and reducer registry, then bind every checked Core capability criterion to a command that passed in this same DAG run. Client implementations, cryptographic evidence, platform adoption, and product receipts are not inputs; verifier-health failures and Core-actionable gaps remain release failures.",
      finalRegression: "Run private deployment internal platform E2E only after the required upstream/downstream/platform acceptance dependencies pass."
    },
    stateMachine: {
      ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
      currentState: finalState,
      event: aggregateReadinessFinal.releaseReady === true
        ? "all_acceptance_criteria_ready"
        : failedCommandIds.length > 0 || invalidReports.length > 0
          ? "command_or_report_failed"
          : "command_or_report_failed"
    },
    commandSchedule: Object.fromEntries(
      (Object.entries(executedSchedule) as [string, any][]).filter(([key]: any[]) : any => key !== "maxParallel")
    ),
    commands: results.map((result?: any) : any => ({
      id: result.id,
      label: result.label,
      acceptanceLayer: PLATFORM_ACCEPTANCE_COMMANDS.find((item?: any) : any => item.id === result.id)?.acceptanceLayer || "",
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      report: result.report || "",
      dependsOn: result.dependsOn || [],
      resourceLocks: result.resourceLocks || [],
      blockedExitCodes: result.blockedExitCodes || [],
      exclusive: result.exclusive === true
    })),
    acceptanceLayers: PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map((layer?: any) : any => layerStatus(layer, results)),
    acceptanceCriteria: reducedAcceptanceCriteria,
    requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
    releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
    releaseEvidenceInventoryDigest: RELEASE_EVIDENCE_INVENTORY_DIGEST,
    requirementEvidence,
    candidateIdentity,
    finalCandidateIdentity,
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
    process.exitCode = 1;
  }
}

async function runAcceptanceOrchestrator(selectedProfile?: any) : Promise<any> {
  return withAcceptanceExecutionLease(authorityRoot, async () : Promise<any> => {
    const paths: any = await createAcceptanceGenerationWorkspace(repoRoot, { authorityRoot });
    try {
      const result: any = await runAcceptanceGenerationWorker({
        repoRoot,
        proofLedgerRoot: authorityRoot,
        workspace: paths.workspace,
        args: [
          "tools/server-scripts/verify-platform-acceptance.ts",
          "--profile",
          selectedProfile
        ]
      });
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
        const diagnostic: any = await publishAcceptanceFailureDiagnostic({
          repoRoot: authorityRoot,
          paths,
          aggregateReportPath: REPORT_PATH,
          workerResult: result
        });
        console.log(`[platform-acceptance] failureDiagnostic=${diagnostic.path}`);
        return;
      }
      await publishAcceptanceGeneration({
        repoRoot: authorityRoot,
        paths,
        requiredReports: ACCEPTANCE_REQUIRED_REPORTS,
        aggregateReportPath: REPORT_PATH,
        releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
      });
      console.log(
        `[platform-acceptance] generation=${paths.id} published=${ACCEPTANCE_GENERATION_POINTER}`
      );
    } finally {
      await removeAcceptanceGenerationWorkspace(paths, { repoRoot });
    }
  });
}

async function main() : Promise<any> {
  const { planOnly, selectedProfile } = parseArgs(process.argv.slice(2));
  if (planOnly || process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER === "1") {
    await runAcceptanceWorker();
    return;
  }
  await runAcceptanceOrchestrator(selectedProfile);
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(async (error?: any) : Promise<any> => {
    const generationWorker: any = process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER === "1";
    if (!generationWorker) {
      console.error(sanitizeError(error));
      process.exit(1);
    }
    let selectedProfile: any;
    try {
      ({ selectedProfile } = parseArgs(process.argv.slice(2)));
    } catch {
      console.error(sanitizeError(error));
      process.exit(1);
    }
    const now: any = new Date();
    const safeFailure: any = String(error?.code || sanitizeError(error));
    const report: Record<string, any> = {
      schemaVersion: PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
      acceptanceStandard: "functional-completeness",
      claim: "functional-complete",
      status: "failed",
      selectedProfile,
      generatedAt: now.toISOString(),
      verifier: "tools/server-scripts/verify-platform-acceptance.ts",
      stateMachine: {
        ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
        currentState: "failed",
        event: "command_or_report_failed"
      },
      summary: {
        releaseReady: false,
        failedCommandCount: 1,
        failedCommands: ["platform-acceptance"],
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
    process.exit(1);
  });
}
