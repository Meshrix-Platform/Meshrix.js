import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomic } from "../../../packages/foundation/src/storage/private-file-atomic.ts";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { assertNoSensitiveReportLeak } from "./sensitive-report-scan.ts";
import { verifyAcceptanceEvidenceAnchor } from "./platform-acceptance-ledger-anchor.ts";
import {
  PLATFORM_ACCEPTANCE_REPORT_SCHEMA,
  PLATFORM_ACCEPTANCE_STATE_MACHINE,
  requirePlatformAcceptanceProfile
} from "./platform-acceptance-contract.ts";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./platform-acceptance-command-catalog.ts";
import { acceptanceCriteria, layerStatus } from "./platform-acceptance-reducer.ts";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE
} from "./platform-acceptance-requirement-evidence.ts";
import {
  PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH,
  PLATFORM_ACCEPTANCE_GENERATION_ROOT
} from "./platform-acceptance-report-catalog.ts";
import { validateReleaseCandidateIdentity } from "../verify-release-candidate-identity.ts";

export const ACCEPTANCE_GENERATION_SCHEMA: any = "v0.0.1:meshrix:platform-acceptance-generation-2";
export const ACCEPTED_CANDIDATE_RECEIPT_SCHEMA: any = "v0.0.1:meshrix:accepted-candidate-receipt-1";
export const ACCEPTANCE_GENERATION_POINTER_SCHEMA: any = "v0.0.1:meshrix:platform-acceptance-generation-pointer-2";
export const ACCEPTANCE_GENERATION_ROOT: any = PLATFORM_ACCEPTANCE_GENERATION_ROOT;
export const ACCEPTANCE_GENERATION_POINTER: any = PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH;
export const ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT: any = `${ACCEPTANCE_GENERATION_ROOT}/failures`;
export const ACCEPTANCE_EXECUTION_LEASE_SCHEMA: any = "v0.0.1:meshrix:platform-acceptance-execution-lease-1";
export const ACCEPTANCE_FAILURE_ENVELOPE_SCHEMA: any = "v0.0.1:meshrix:platform-acceptance-failure-envelope-1";
export const ACCEPTANCE_GENERATION_BUDGETS: Readonly<Record<string, any>> = Object.freeze({
  maxEntries: 256,
  maxEntryBytes: 32 * 1024 * 1024,
  maxGenerationBytes: 256 * 1024 * 1024,
  maxRetainedGenerations: 8,
  maxRetainedFailures: 8
});

function normalizedLogicalPath(value?: any) : any {
  const logicalPath: any = String(value || "").trim().split(path.sep).join("/");
  if (!logicalPath || path.posix.isAbsolute(logicalPath)) {
    throw new Error(`Acceptance generation path must be repository-relative: ${logicalPath || "<empty>"}`);
  }
  const normalized: any = path.posix.normalize(logicalPath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Acceptance generation path escapes its root: ${logicalPath}`);
  }
  return normalized;
}

async function assertPathHasNoSymlinkComponents(root?: any, logicalPath?: any, finalKind?: any) : Promise<any> {
  const normalized: any = normalizedLogicalPath(logicalPath);
  let current: any = path.resolve(root);
  let stats: any;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Acceptance generation path contains a symbolic link: ${normalized}`);
    }
  }
  if ((finalKind === "file" && !stats?.isFile()) || (finalKind === "directory" && !stats?.isDirectory())) {
    throw new Error(`Acceptance generation path has an invalid final type: ${normalized}`);
  }
  return current;
}

function generationId() : any {
  const timestamp: any = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return `${timestamp}-${crypto.randomBytes(12).toString("hex")}`;
}

function isUnsupportedSyncError(error?: any) : any {
  return process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

async function syncPathIfSupported(targetPath?: any) : Promise<any> {
  const handle: any = await fs.open(targetPath, "r").catch((error?: any) : any => {
    if (isUnsupportedSyncError(error)) return null;
    throw error;
  });
  try {
    await handle?.sync();
  } catch (error: any) {
    if (!isUnsupportedSyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function generationPaths(repoRoot?: any, id: any = generationId(), workspace: any = "", baseGenerationId: any = "") : any {
  const root: any = path.join(repoRoot, ACCEPTANCE_GENERATION_ROOT);
  return {
    id,
    baseGenerationId,
    root,
    workspace,
    stagedGeneration: path.join(root, "staging", id),
    committedGeneration: path.join(root, "generations", id),
    pointer: path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER)
  };
}

function failureDiagnosticPaths(repoRoot?: any, id?: any) : any {
  const diagnosticId: any = String(id || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(diagnosticId)) {
    throw new Error("Acceptance failure diagnostic generation id is invalid");
  }
  const root: any = path.join(repoRoot, ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT);
  return {
    id: diagnosticId,
    root,
    staged: path.join(root, `.staging-${diagnosticId}`),
    committed: path.join(root, diagnosticId)
  };
}

async function currentGenerationId(pointerPath?: any) : Promise<any> {
  try {
    const pointer: any = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    if (pointer?.schemaVersion !== ACCEPTANCE_GENERATION_POINTER_SCHEMA ||
        !String(pointer.generationId || "").trim()) {
      throw new Error("Acceptance generation pointer is invalid");
    }
    return String(pointer.generationId);
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function processIsAlive(pid?: any) : any {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export async function withAcceptanceExecutionLease(repoRoot?: any, action?: any) : Promise<any> {
  if (typeof action !== "function") throw new TypeError("Acceptance execution lease action is required");
  const root: any = path.join(repoRoot, ACCEPTANCE_GENERATION_ROOT);
  const leasePath: any = path.join(root, "execution.lock");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const token: any = crypto.randomBytes(24).toString("hex");
  let handle: any;
  for (let attempt: any = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(leasePath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: ACCEPTANCE_EXECUTION_LEASE_SCHEMA,
        pid: process.pid,
        token
      })}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error: any) {
      await handle?.close().catch(() : any => {});
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      const [existingText, stats] = await Promise.all([
        fs.readFile(leasePath, "utf8").catch(() : any => ""),
        fs.stat(leasePath).catch(() : any => null)
      ]);
      let existing: any = null;
      try {
        existing = JSON.parse(existingText);
      } catch {
        existing = null;
      }
      if (existing?.schemaVersion === ACCEPTANCE_EXECUTION_LEASE_SCHEMA &&
          processIsAlive(Number(existing.pid))) {
        const leaseError: Error & Record<string, any> = new Error("Platform acceptance execution lease is already held");
        leaseError.code = "platform_acceptance_execution_lease_held";
        throw leaseError;
      }
      if (!existing && stats && Date.now() - stats.mtimeMs < 5_000) {
        const leaseError: Error & Record<string, any> = new Error("Platform acceptance execution lease is being acquired");
        leaseError.code = "platform_acceptance_execution_lease_held";
        throw leaseError;
      }
      await fs.rm(leasePath, { force: true });
    }
  }
  if (!handle) throw new Error("Platform acceptance execution lease could not be acquired");
  await handle.close();
  try {
    return await action();
  } finally {
    const current: any = await fs.readFile(leasePath, "utf8").then(JSON.parse).catch(() : any => null);
    if (current?.token === token) await fs.rm(leasePath, { force: true });
  }
}

const WORKSPACE_PACKAGE_SCOPE: any = "@meshrix";

async function linkWorkspaceNodeModules(repoRoot?: any, workspace?: any) : Promise<any> {
  const sourceRoot: any = path.join(repoRoot, "node_modules");
  const targetRoot: any = path.join(workspace, "node_modules");
  const localPackages: any = path.join(workspace, "packages");
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const entries: any = await fs.readdir(sourceRoot);
  for (const entry of entries) {
    if (entry === WORKSPACE_PACKAGE_SCOPE) continue;
    await fs.symlink(path.join(sourceRoot, entry), path.join(targetRoot, entry), "junction");
  }
  const scopeSource: any = path.join(sourceRoot, WORKSPACE_PACKAGE_SCOPE);
  const scopeTarget: any = path.join(targetRoot, WORKSPACE_PACKAGE_SCOPE);
  await fs.mkdir(scopeTarget, { recursive: true, mode: 0o700 });
  const scopeEntries: any = await fs.readdir(scopeSource).catch((error?: any) : any => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const localEntries: any = await fs.readdir(localPackages).catch(() : any => []);
  const localNames: any = new Set<any>(localEntries);
  await Promise.all(scopeEntries.map(async (entry?: any) : Promise<any> => {
    const localPackage: any = path.join(localPackages, entry);
    const stats: any = localNames.has(entry) ? await fs.stat(localPackage).catch(() : any => null) : null;
    const source: any = stats?.isDirectory() ? localPackage : path.join(scopeSource, entry);
    await fs.symlink(source, path.join(scopeTarget, entry), "junction");
  }));
}

function resolveCandidateCommit(repoRoot?: any, candidate: any = "HEAD") : any {
  const requested: any = String(candidate || "HEAD").trim();
  if (requested !== "HEAD" && !/^[a-f0-9]{40}$/u.test(requested)) {
    throw new Error("Acceptance generation requires an explicit full candidate commit");
  }
  const resolved: any = spawnSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  const sourceRevision: any = String(resolved.stdout || "").trim();
  if (resolved.status !== 0 || !/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error("Acceptance generation candidate commit is unavailable");
  }
  return sourceRevision;
}

export async function createAcceptanceGenerationWorkspace(repoRoot?: any, {
  authorityRoot = repoRoot,
  id,
  sourceRevision = "HEAD"
}: Record<string, any> = {}) : Promise<any> {
  const selectedId: any = id || generationId();
  const candidateCommit: any = resolveCandidateCommit(repoRoot, sourceRevision);
  const workspaceRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), `meshrix-acceptance-${selectedId}-`));
  const workspace: any = path.join(workspaceRoot, "candidate");
  const baseGenerationId: any = await currentGenerationId(
    path.join(authorityRoot, ACCEPTANCE_GENERATION_POINTER)
  );
  const paths: any = {
    ...generationPaths(authorityRoot, selectedId, workspace, baseGenerationId),
    authorityRoot,
    repoRoot,
    sourceRevision: candidateCommit,
    workspaceRoot
  };
  try {
    const added: any = spawnSync("git", [
      "worktree", "add", "--quiet", "--detach", paths.workspace, candidateCommit
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true
    });
    if (added.status !== 0) throw new Error("Acceptance generation candidate worktree creation failed");
    const dependencyRoot: any = path.join(repoRoot, "node_modules");
    const stats: any = await fs.stat(dependencyRoot);
    if (!stats.isDirectory()) throw new Error("not a directory");
    await linkWorkspaceNodeModules(repoRoot, paths.workspace);
  } catch (error: any) {
    spawnSync("git", ["worktree", "remove", "--force", paths.workspace], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true
    });
    await fs.rm(paths.workspaceRoot, { recursive: true, force: true });
    if (error?.message === "not a directory" || error?.code === "ENOENT") {
      throw new Error("Acceptance generation requires the repository dependency runtime");
    }
    throw error;
  }
  return paths;
}

export async function runAcceptanceGenerationWorker({
  repoRoot,
  workspace,
  executable = process.execPath,
  args = ["tools/server-scripts/verify-platform-acceptance.ts"],
  env = process.env,
  proofLedgerRoot = repoRoot,
  stdio = "inherit"
}: Record<string, any>) : Promise<any> {
  return new Promise((resolve?: any) : any => {
    const child: any = spawn(executable, args, {
      cwd: workspace,
      env: {
        ...env,
        MESHRIX_ACCEPTANCE_REPOSITORY_ROOT: repoRoot,
        MESHRIX_ACCEPTANCE_PROOF_LEDGER_DIR: path.join(proofLedgerRoot, "build", "acceptance-proof-ledger"),
        MESHRIX_ACCEPTANCE_GENERATION_WORKER: "1"
      },
      stdio,
      windowsHide: true
    });
    let settled: any = false;
    const finish: any = (result?: any) : any => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () : any => finish({ exitCode: 1, signal: "", errorCode: "acceptance_worker_spawn_failed" }));
    child.once("exit", (code?: any, signal?: any) : any => {
      finish({
        exitCode: Number.isInteger(code) ? code : 1,
        signal: signal || "",
        errorCode: signal ? "acceptance_worker_signalled" : "acceptance_worker_failed"
      });
    });
  });
}

async function sha256File(filePath?: any) : Promise<any> {
  const content: any = await fs.readFile(filePath);
  return {
    byteLength: content.byteLength,
    sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
}

async function copyGenerationEntry(workspace?: any, stagedGeneration?: any, logicalPath?: any) : Promise<any> {
  const normalized: any = normalizedLogicalPath(logicalPath);
  const sourcePath: any = path.join(workspace, ...normalized.split("/"));
  const targetPath: any = path.join(stagedGeneration, ...normalized.split("/"));
  const stats: any = await fs.lstat(sourcePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Acceptance generation entry is not a regular file: ${normalized}`);
  }
  if (stats.size > ACCEPTANCE_GENERATION_BUDGETS.maxEntryBytes) {
    throw new Error(`Acceptance generation entry exceeds its byte budget: ${normalized}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  await syncPathIfSupported(targetPath);
  const digest: any = await sha256File(targetPath);
  return { path: normalized, ...digest };
}

async function validateOwnedReport(workspace?: any, inventoryEntry?: any) : Promise<any> {
  const reportPath: any = normalizedLogicalPath(inventoryEntry?.reportPath);
  const raw: any = await fs.readFile(path.join(workspace, ...reportPath.split("/")), "utf8");
  let report: any;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`Acceptance generation report JSON is invalid: ${reportPath}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      report.schemaVersion !== inventoryEntry.reportSchemaVersion ||
      report.verifier !== inventoryEntry.producer) {
    throw new Error(`Acceptance generation report ownership or schema is invalid: ${reportPath}`);
  }
  const provenance: any = report.releaseEvidenceProvenance;
  const payload: any = Object.fromEntries((Object.entries(report) as [string, any][])
    .filter(([key]: any[]) : any => key !== "releaseEvidenceProvenance"));
  if (!provenance || provenance.schemaVersion !== inventoryEntry.provenanceSchemaVersion ||
      provenance.commandId !== inventoryEntry.ownerCommandId ||
      provenance.producer !== inventoryEntry.producer ||
      provenance.reportPayloadDigest !== reportPayloadDigest(payload) ||
      !Number.isFinite(Date.parse(provenance.recordedAt))) {
    throw new Error(`Acceptance generation report provenance is invalid: ${reportPath}`);
  }
  assertNoSensitiveReportLeak(raw, `acceptance generation report ${reportPath}`);
}

const BARE_SHA256_DIGEST: any = /^[a-f0-9]{64}$/u;

function sameValues(left?: any, right?: any) : any {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireAggregate(condition?: any, code?: any) : any {
  if (!condition) throw new Error(`Acceptance generation aggregate contract is invalid: ${code}`);
}

function validateCandidateIdentity(candidate?: any, selectedProfile?: any) : any {
  let validated: any;
  try {
    validated = validateReleaseCandidateIdentity(candidate);
  } catch {
    requireAggregate(false, "candidate-identity-invalid");
  }
  requireAggregate(
    validated.supported_profiles.length === 1 &&
      validated.supported_profiles[0] === selectedProfile,
    "candidate-profile-mismatch"
  );
  return validated;
}

function validateCommandAndRequirementEvidence(aggregateReport?: any) : any {
  const commandIds: any = aggregateReport.commands.map((command?: any) : any => command?.id);
  requireAggregate(
    sameValues(commandIds, PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => command.id)),
    "command-catalog-binding"
  );
  for (let index: any = 0; index < PLATFORM_ACCEPTANCE_COMMANDS.length; index += 1) {
    const expected: any = PLATFORM_ACCEPTANCE_COMMANDS[index];
    const actual: any = aggregateReport.commands[index];
    requireAggregate(
      actual?.label === expected.label &&
      actual?.acceptanceLayer === expected.acceptanceLayer &&
      actual?.report === expected.report &&
      sameValues(actual?.dependsOn, expected.dependsOn) &&
      sameValues(actual?.resourceLocks, expected.resourceLocks) &&
      sameValues(actual?.blockedExitCodes, expected.blockedExitCodes) &&
      actual?.exclusive === expected.exclusive,
      `command-contract:${expected.id}`
    );
  }
  const nodes: any = aggregateReport.requirementEvidence?.nodes;
  requireAggregate(
    sameValues(nodes?.map((node?: any) : any => node?.requirement), PLATFORM_ACCEPTANCE_REQUIREMENTS),
    "requirement-label-binding"
  );
  const commandById: any = new Map<any, any>(PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => [command.id, command]));
  for (const node of nodes) {
    const expected: any = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[node.requirement];
    const expectedReportPaths: any = [...new Set<any>(expected.commandIds.flatMap(
      (commandId?: any) : any => commandById.get(commandId)?.ownedReports || []
    ))].sort();
    requireAggregate(
      node.ready === true &&
      sameValues(node.commandIds, expected.commandIds) &&
      sameValues(node.reportPaths, expectedReportPaths) &&
      sameValues(node.aggregateFacts, expected.aggregateFacts) &&
      Array.isArray(node.reasons) && node.reasons.length === 0,
      `requirement-binding:${node.requirement}`
    );
  }
}

async function verifyAggregateLedgerAnchor({ aggregateReport, repoRoot }: Record<string, any>) : Promise<any> {
  const anchor: any = aggregateReport.ledgerAnchor;
  const proofSubstrate: any = createOperationProofSubstrate({
    dataDir: path.join(repoRoot, "build", "acceptance-proof-ledger")
  });
  try {
    return await verifyAcceptanceEvidenceAnchor({
      proofSubstrate,
      ledgerEventId: anchor.ledgerEventId,
      envelopeId: anchor.envelopeId,
      workspaceId: anchor.workspaceId,
      expectedReportDigests: anchor.reportDigests,
      expectedEvidenceContext: anchor.evidenceContext
    });
  } finally {
    await proofSubstrate.close?.();
  }
}

export async function validateAcceptedAggregateReport({
  aggregateReport,
  releaseEvidenceInventory,
  requiredReports,
  repoRoot,
  verifyLedgerAnchor = verifyAggregateLedgerAnchor
}: Record<string, any> = {}) : Promise<any> {
  requireAggregate(aggregateReport?.schemaVersion === PLATFORM_ACCEPTANCE_REPORT_SCHEMA, "schema");
  requireAggregate(aggregateReport?.verifier === "tools/server-scripts/verify-platform-acceptance.ts", "verifier");
  const selectedProfile: any = requirePlatformAcceptanceProfile(aggregateReport?.selectedProfile);
  requireAggregate(aggregateReport.status === "accepted", "status");
  requireAggregate(aggregateReport.stateMachine?.currentState === "accepted" &&
    aggregateReport.stateMachine?.event === "all_acceptance_criteria_ready", "terminal-state");
  const { currentState: _currentState, event: _event, ...stateMachineContract } = aggregateReport.stateMachine;
  requireAggregate(sameValues(stateMachineContract, PLATFORM_ACCEPTANCE_STATE_MACHINE), "state-machine-contract");
  requireAggregate(aggregateReport.commandSchedule?.valid === true, "command-schedule");
  requireAggregate(Array.isArray(aggregateReport.commands) && aggregateReport.commands.length > 0 &&
    aggregateReport.commands.every((command?: any) : any => command?.status === "passed"), "command-results");
  validateCommandAndRequirementEvidence(aggregateReport);
  requireAggregate(Array.isArray(aggregateReport.acceptanceLayers) &&
    aggregateReport.acceptanceLayers.every((layer?: any) : any => layer?.status === "passed") &&
    sameValues(
      aggregateReport.acceptanceLayers,
      PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map((layer?: any) : any => layerStatus(layer, aggregateReport.commands))
    ), "acceptance-layers");
  const expectedCriteriaShape: any = acceptanceCriteria([], {}, [], PLATFORM_ACCEPTANCE_COMMANDS)
    .map(({ id, label }: Record<string, any>) : any => ({ id, label }));
  requireAggregate(Array.isArray(aggregateReport.acceptanceCriteria) &&
    aggregateReport.acceptanceCriteria.length > 0 &&
    aggregateReport.acceptanceCriteria.every((criterion?: any) : any => criterion?.ready === true) &&
    sameValues(
      aggregateReport.acceptanceCriteria.map(({ id, label }: Record<string, any>) : any => ({ id, label })),
      expectedCriteriaShape
    ), "acceptance-criteria");
  requireAggregate(sameValues(aggregateReport.requiredReports, requiredReports), "required-reports");
  requireAggregate(sameValues(aggregateReport.releaseEvidenceInventory, releaseEvidenceInventory), "report-inventory");
  const inventoryDigest: any = reportPayloadDigest({ inventory: releaseEvidenceInventory });
  requireAggregate(aggregateReport.releaseEvidenceInventoryDigest === inventoryDigest, "report-inventory-digest");
  const candidateIdentity: any = validateCandidateIdentity(aggregateReport.candidateIdentity, selectedProfile);
  const finalCandidateIdentity: any = validateCandidateIdentity(aggregateReport.finalCandidateIdentity, selectedProfile);
  requireAggregate(
    candidateIdentity.candidate_digest === finalCandidateIdentity.candidate_digest &&
      aggregateReport.candidate_digest === candidateIdentity.candidate_digest &&
      aggregateReport.sourceRevision === candidateIdentity.source_revision &&
      aggregateReport.releaseEvidenceInventoryDigest === candidateIdentity.report_inventory_digest,
    "candidate-identity-drift"
  );
  requireAggregate(aggregateReport.capabilityEvidenceExecution?.ready === true, "capability-evidence");
  requireAggregate(aggregateReport.requirementEvidence?.ready === true &&
    aggregateReport.requirementEvidence?.requirementCount === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    aggregateReport.requirementEvidence?.readyCount === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    Array.isArray(aggregateReport.requirementEvidence?.nodes) &&
    aggregateReport.requirementEvidence.nodes.length === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    aggregateReport.requirementEvidence.nodes.every((node?: any) : any => node?.ready === true),
    "requirement-evidence");
  requireAggregate(
    Array.isArray(aggregateReport.blockedCommandValidation?.validBlockedCommandIds) &&
      aggregateReport.blockedCommandValidation.validBlockedCommandIds.length === 0 &&
      Array.isArray(aggregateReport.blockedCommandValidation?.invalidBlockedCommandIds) &&
      aggregateReport.blockedCommandValidation.invalidBlockedCommandIds.length === 0,
    "blocked-command-validation"
  );
  const evidence: any = aggregateReport.reportEvidence;
  requireAggregate(evidence && typeof evidence === "object" &&
    sameValues(Object.keys(evidence).sort(), [...requiredReports].sort()) &&
    (Object.values(evidence) as any[]).every((entry?: any) : any => entry?.releaseReady === true &&
      entry?.validationPassed === true && entry?.reportLeakScan === true), "report-evidence");
  const summary: any = aggregateReport.summary;
  requireAggregate(summary?.releaseReady === true && summary?.reportLeakScan === true &&
    summary?.allCommandsExecuted === true && summary?.ledgerAnchorReady === true &&
    summary?.capabilityEvidenceExecutionReady === true &&
    summary?.requirementEvidenceReady === true, "summary-readiness");
  for (const field of [
    "failedCommandCount",
    "blockedCommandCount",
    "capabilityEvidenceExecutionFailureCount",
    "missingReportCount",
    "invalidReportCount",
    "missingEvidenceCount"
  ]) {
    requireAggregate(summary?.[field] === 0, `summary-${field}`);
  }
  requireAggregate(summary.commandCount === aggregateReport.commands.length &&
    summary.executedCommandCount === aggregateReport.commands.length &&
    summary.requiredReportCount === requiredReports.length, "summary-counts");
  const anchor: any = aggregateReport.ledgerAnchor;
  requireAggregate(anchor?.error === "" && anchor?.skipped === false &&
    anchor?.verification?.ok === true && anchor?.reportDigestCount === requiredReports.length &&
    Array.isArray(anchor?.reportDigests) && anchor.reportDigests.length === requiredReports.length,
    "ledger-anchor-shape");
  requireAggregate(anchor.evidenceContext?.schemaVersion === "v0.0.1:meshrix:acceptance-evidence-anchor-context-2" &&
    anchor.evidenceContext?.selectedProfile === selectedProfile &&
    anchor.evidenceContext?.sourceRevision === candidateIdentity.source_revision &&
    anchor.evidenceContext?.ownedReportsInventoryDigest === inventoryDigest &&
    anchor.evidenceContext?.candidateDigest === candidateIdentity.candidate_digest &&
    anchor.evidenceContext?.privacySafe === true, "ledger-context");
  const verification: any = await verifyLedgerAnchor({ aggregateReport, repoRoot });
  requireAggregate(verification?.ok === true, "ledger-anchor-verification");
  return Object.freeze({ selectedProfile, inventoryDigest });
}

function validateFailedAggregateReport(aggregateReport?: any) : any {
  requireAggregate(aggregateReport && typeof aggregateReport === "object" && !Array.isArray(aggregateReport),
    "failure-object");
  requireAggregate(aggregateReport.schemaVersion === PLATFORM_ACCEPTANCE_REPORT_SCHEMA, "failure-schema");
  requireAggregate(aggregateReport.verifier === "tools/server-scripts/verify-platform-acceptance.ts",
    "failure-verifier");
  requireAggregate(aggregateReport.acceptanceStandard === "functional-completeness" &&
    aggregateReport.claim === "functional-complete", "failure-claim");
  requireAggregate(aggregateReport.status === "failed", "failure-status");
  requireAggregate(Number.isFinite(Date.parse(aggregateReport.generatedAt)), "failure-generated-at");
  const selectedProfile: any = requirePlatformAcceptanceProfile(aggregateReport.selectedProfile);
  requireAggregate(aggregateReport.stateMachine?.currentState === "failed" &&
    aggregateReport.stateMachine?.event === "command_or_report_failed", "failure-terminal-state");
  const { currentState: _currentState, event: _event, ...stateMachineContract } = aggregateReport.stateMachine;
  requireAggregate(sameValues(stateMachineContract, PLATFORM_ACCEPTANCE_STATE_MACHINE),
    "failure-state-machine-contract");
  requireAggregate(aggregateReport.summary && typeof aggregateReport.summary === "object" &&
    !Array.isArray(aggregateReport.summary) && aggregateReport.summary.releaseReady === false,
    "failure-summary");

  if (aggregateReport.candidateIdentity !== undefined) {
    const candidateIdentity: any = validateCandidateIdentity(aggregateReport.candidateIdentity, selectedProfile);
    requireAggregate(aggregateReport.candidate_digest === candidateIdentity.candidate_digest,
      "failure-candidate-digest");
    if (String(aggregateReport.sourceRevision || "")) {
      requireAggregate(aggregateReport.sourceRevision === candidateIdentity.source_revision,
        "failure-source-revision");
    }
    if (aggregateReport.finalCandidateIdentity !== null && aggregateReport.finalCandidateIdentity !== undefined) {
      validateCandidateIdentity(
        aggregateReport.finalCandidateIdentity,
        selectedProfile
      );
    }
  } else {
    requireAggregate(aggregateReport.candidate_digest === undefined &&
      aggregateReport.finalCandidateIdentity === undefined &&
      !String(aggregateReport.sourceRevision || ""), "failure-orphan-candidate-binding");
  }
  return Object.freeze({ selectedProfile });
}

async function readFailedAggregateReport(workspace?: any, aggregateReportPath?: any) : Promise<any> {
  const logicalPath: any = normalizedLogicalPath(aggregateReportPath);
  let sourcePath: any;
  try {
    sourcePath = await assertPathHasNoSymlinkComponents(workspace, logicalPath, "file");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const stats: any = await fs.stat(sourcePath);
  if (stats.size > ACCEPTANCE_GENERATION_BUDGETS.maxEntryBytes) {
    throw new Error("Acceptance failure diagnostic aggregate exceeds its byte budget");
  }
  const raw: any = await fs.readFile(sourcePath, "utf8");
  let aggregateReport: any;
  try {
    aggregateReport = JSON.parse(raw);
  } catch {
    throw new Error("Acceptance failure diagnostic aggregate JSON is invalid");
  }
  validateFailedAggregateReport(aggregateReport);
  assertNoSensitiveReportLeak(raw, "acceptance failure diagnostic aggregate report");
  return Object.freeze({ logicalPath, raw, aggregateReport });
}

function validateWorkerFailureResult(workerResult?: any) : any {
  const exitCode: any = Number(workerResult?.exitCode);
  const signal: any = String(workerResult?.signal || "");
  if (!Number.isInteger(exitCode) || exitCode === 0 || exitCode < 0 || exitCode > 255 ||
      (signal && !/^SIG[A-Z0-9]+$/u.test(signal))) {
    throw new Error("Acceptance failure diagnostic worker result is invalid");
  }
  const errorCode: any = String(workerResult?.errorCode || "").trim();
  if (errorCode && !/^[a-z][a-z0-9_]{0,63}$/u.test(errorCode)) {
    throw new Error("Acceptance failure diagnostic worker error code is invalid");
  }
  return Object.freeze({ exitCode, signal, errorCode });
}

function createFailureEnvelope(paths?: any, workerResult?: any, aggregate?: any) : any {
  const { exitCode, signal, errorCode } = workerResult;
  const candidateIdentity: any = aggregate?.candidateIdentity && typeof aggregate.candidateIdentity === "object"
    ? aggregate.candidateIdentity
    : null;
  const sourceRevision: any = String(candidateIdentity?.source_revision || paths?.sourceRevision || "");
  const candidateDigest: any = String(candidateIdentity?.candidate_digest || aggregate?.candidate_digest || "");
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || (candidateDigest && !BARE_SHA256_DIGEST.test(candidateDigest))) {
    throw new Error("Acceptance failure diagnostic candidate binding is invalid");
  }
  const receipt: Record<string, any> = {
    schemaVersion: ACCEPTANCE_FAILURE_ENVELOPE_SCHEMA,
    generationId: String(paths.id),
    status: "failed",
    sourceRevision,
    candidateDigest,
    selectedProfile: String(aggregate?.selectedProfile || ""),
    phase: aggregate ? "aggregate" : "worker",
    errorCode: errorCode || (aggregate ? "acceptance_aggregate_failed" : signal ? "acceptance_worker_signalled" : "acceptance_worker_failed"),
    exitCode,
    signal,
    aggregatePresent: Boolean(aggregate)
  };
  assertNoSensitiveReportLeak(receipt, "acceptance failure diagnostic worker receipt");
  return Object.freeze(receipt);
}

async function pruneFailureDiagnostics(failureRoot?: any) : Promise<any> {
  const entries: any[] = await fs.readdir(failureRoot, { withFileTypes: true });
  for (const staging of entries.filter((entry?: any) : any =>
    entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(".staging-"))) {
    await fs.rm(path.join(failureRoot, staging.name), { recursive: true, force: true });
  }
  const retained: any[] = entries
    .filter((entry?: any) : any => entry.isDirectory() && !entry.isSymbolicLink() &&
      !entry.name.startsWith(".staging-"))
    .map((entry?: any) : any => entry.name)
    .sort()
    .reverse();
  for (const retired of retained.slice(ACCEPTANCE_GENERATION_BUDGETS.maxRetainedFailures)) {
    await fs.rm(path.join(failureRoot, retired), { recursive: true, force: true });
  }
}

export async function publishAcceptanceFailureDiagnostic({
  repoRoot,
  paths,
  aggregateReportPath,
  workerResult
}: Record<string, any>) : Promise<any> {
  const failurePaths: any = failureDiagnosticPaths(repoRoot, paths?.id);
  const failureResult: any = validateWorkerFailureResult(workerResult);
  const aggregate: any = await readFailedAggregateReport(paths?.workspace, aggregateReportPath);
  if (aggregate?.aggregateReport?.sourceRevision && aggregate.aggregateReport.sourceRevision !== paths.sourceRevision) {
    throw new Error("Acceptance failure diagnostic candidate does not match its worktree");
  }
  const targetName: any = "failure.json";
  const payload: any = `${JSON.stringify(createFailureEnvelope(paths, failureResult, aggregate?.aggregateReport), null, 2)}\n`;

  await fs.mkdir(failurePaths.root, { recursive: true, mode: 0o700 });
  await fs.mkdir(failurePaths.staged, { recursive: false, mode: 0o700 });
  try {
    const targetPath: any = path.join(failurePaths.staged, targetName);
    await writePrivateFileAtomic(targetPath, payload);
    await syncPathIfSupported(failurePaths.staged);
    await fs.rename(failurePaths.staged, failurePaths.committed);
    await syncPathIfSupported(failurePaths.root);
    await pruneFailureDiagnostics(failurePaths.root);
    return Object.freeze({
      generationId: failurePaths.id,
      kind: "failure-envelope",
      path: path.relative(repoRoot, path.join(failurePaths.committed, targetName)).split(path.sep).join("/")
    });
  } catch (error: any) {
    await fs.rm(failurePaths.staged, { recursive: true, force: true });
    throw error;
  }
}

async function pruneCommittedGenerations(paths?: any) : Promise<any> {
  const generationsRoot: any = path.dirname(paths.committedGeneration);
  const entries: any = (await fs.readdir(generationsRoot, { withFileTypes: true }))
    .filter((entry?: any) : any => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry?: any) : any => entry.name)
    .sort()
    .reverse();
  for (const retired of entries.slice(ACCEPTANCE_GENERATION_BUDGETS.maxRetainedGenerations)) {
    await fs.rm(path.join(generationsRoot, retired), { recursive: true, force: true });
  }
}

export async function publishAcceptanceGeneration({
  repoRoot,
  paths,
  requiredReports,
  aggregateReportPath,
  releaseEvidenceInventory,
  verifyLedgerAnchor
}: Record<string, any>) : Promise<any> {
  if (!Array.isArray(releaseEvidenceInventory) || releaseEvidenceInventory.length === 0) {
    throw new Error("Acceptance generation requires a release evidence inventory");
  }
  if (releaseEvidenceInventory.length > ACCEPTANCE_GENERATION_BUDGETS.maxEntries) {
    throw new Error("Acceptance generation report inventory exceeds its entry budget");
  }
  const inventoryPaths: any = releaseEvidenceInventory.map((entry?: any) : any => normalizedLogicalPath(entry?.reportPath));
  if (
    new Set<any>(inventoryPaths).size !== inventoryPaths.length ||
    JSON.stringify([...inventoryPaths].sort()) !== JSON.stringify(
      [...(Array.isArray(requiredReports) ? requiredReports : [])].map(normalizedLogicalPath).sort()
    )
  ) {
    throw new Error("Acceptance generation inventory does not match required reports");
  }
  const logicalPaths: any = [...new Set<any>([
    ...(Array.isArray(requiredReports) ? requiredReports : []),
    aggregateReportPath
  ].map(normalizedLogicalPath))].sort();
  if (logicalPaths.length === 0) {
    throw new Error("Acceptance generation has no report entries");
  }
  const aggregateLogicalPath: any = normalizedLogicalPath(aggregateReportPath);
  const aggregateReport: any = JSON.parse(await fs.readFile(
    path.join(paths.workspace, ...aggregateLogicalPath.split("/")),
    "utf8"
  ));
  const aggregateBinding: any = await validateAcceptedAggregateReport({
    aggregateReport,
    releaseEvidenceInventory,
    requiredReports,
    repoRoot,
    verifyLedgerAnchor
  });
  requireAggregate(
    aggregateReport.sourceRevision === paths.sourceRevision,
    "candidate-worktree-source-revision"
  );
  assertNoSensitiveReportLeak(aggregateReport, "acceptance generation aggregate report");
  for (const inventoryEntry of releaseEvidenceInventory) {
    await validateOwnedReport(paths.workspace, inventoryEntry);
  }

  await fs.mkdir(path.dirname(paths.stagedGeneration), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(paths.committedGeneration), { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.stagedGeneration, { recursive: false, mode: 0o700 });
  let committed: any = false;
  let published: any = false;
  try {
    const entries: any[] = [];
    for (const logicalPath of logicalPaths) {
      entries.push(await copyGenerationEntry(paths.workspace, paths.stagedGeneration, logicalPath));
    }
    const generationBytes: any = entries.reduce((total?: any, entry?: any) : any => total + Number(entry.byteLength || 0), 0);
    if (generationBytes > ACCEPTANCE_GENERATION_BUDGETS.maxGenerationBytes) {
      throw new Error("Acceptance generation exceeds its total byte budget");
    }

    const manifest: Record<string, any> = {
      schemaVersion: ACCEPTANCE_GENERATION_SCHEMA,
      generationId: paths.id,
      createdAt: new Date().toISOString(),
      aggregateReport: aggregateLogicalPath,
      selectedProfile: aggregateBinding.selectedProfile,
      sourceRevision: aggregateReport.sourceRevision,
      candidateDigest: aggregateReport.candidateIdentity.candidate_digest,
      ledgerEventId: aggregateReport.ledgerAnchor.ledgerEventId,
      releaseEvidenceInventory,
      releaseEvidenceInventoryDigest: reportPayloadDigest({ inventory: releaseEvidenceInventory }),
      entries
    };
    await writePrivateFileAtomic(
      path.join(paths.stagedGeneration, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const receipt: Record<string, any> = {
      schemaVersion: ACCEPTED_CANDIDATE_RECEIPT_SCHEMA,
      claim: "functional-complete",
      status: "accepted",
      releaseReady: true,
      generationId: paths.id,
      selectedProfile: aggregateBinding.selectedProfile,
      sourceRevision: aggregateReport.sourceRevision,
      candidateDigest: aggregateReport.candidateIdentity.candidate_digest
    };
    await writePrivateFileAtomic(
      path.join(paths.stagedGeneration, "accepted-candidate.json"),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    const receiptDigest: any = await sha256File(path.join(paths.stagedGeneration, "accepted-candidate.json"));
    await syncPathIfSupported(paths.stagedGeneration);
    await fs.rename(paths.stagedGeneration, paths.committedGeneration);
    committed = true;
    await syncPathIfSupported(path.dirname(paths.committedGeneration));

    const pointer: Record<string, any> = {
      schemaVersion: ACCEPTANCE_GENERATION_POINTER_SCHEMA,
      generationId: paths.id,
      generation: path.relative(repoRoot, paths.committedGeneration).split(path.sep).join("/"),
      receipt: "accepted-candidate.json",
      receiptSha256: receiptDigest.sha256
    };
    const currentId: any = await currentGenerationId(paths.pointer);
    if (currentId !== String(paths.baseGenerationId || "")) {
      throw new Error("Acceptance generation publication fence rejected a stale run");
    }
    await writePrivateFileAtomic(paths.pointer, `${JSON.stringify(pointer, null, 2)}\n`);
    await syncPathIfSupported(path.dirname(paths.pointer));
    published = true;
    await pruneCommittedGenerations(paths);
    return { manifest, pointer, receipt };
  } catch (error: any) {
    await fs.rm(paths.stagedGeneration, { recursive: true, force: true });
    if (committed && !published) {
      await fs.rm(paths.committedGeneration, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function resolveCurrentAcceptedCandidate(repoRoot?: any) : Promise<any> {
  const pointerPath: any = path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER);
  await assertPathHasNoSymlinkComponents(repoRoot, ACCEPTANCE_GENERATION_POINTER, "file");
  const pointer: any = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  if (pointer?.schemaVersion !== ACCEPTANCE_GENERATION_POINTER_SCHEMA) {
    throw new Error("Acceptance generation pointer schema is invalid");
  }
  const generation: any = normalizedLogicalPath(pointer.generation);
  const requiredPrefix: any = `${ACCEPTANCE_GENERATION_ROOT}/generations/`;
  if (!generation.startsWith(requiredPrefix) || pointer.receipt !== "accepted-candidate.json") {
    throw new Error("Acceptance generation pointer target is invalid");
  }
  const generationRoot: any = path.join(repoRoot, ...generation.split("/"));
  await assertPathHasNoSymlinkComponents(repoRoot, generation, "directory");
  const receiptPath: any = path.join(generationRoot, normalizedLogicalPath(pointer.receipt));
  await assertPathHasNoSymlinkComponents(generationRoot, pointer.receipt, "file");
  const receiptDigest: any = await sha256File(receiptPath);
  if (!BARE_SHA256_DIGEST.test(String(pointer.receiptSha256 || "")) ||
      receiptDigest.sha256 !== pointer.receiptSha256) {
    throw new Error("Accepted candidate receipt digest does not match its pointer");
  }
  const receipt: any = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (
    receipt?.schemaVersion !== ACCEPTED_CANDIDATE_RECEIPT_SCHEMA ||
    receipt?.claim !== "functional-complete" ||
    receipt?.status !== "accepted" ||
    receipt?.releaseReady !== true ||
    receipt?.generationId !== pointer.generationId
  ) {
    throw new Error("Accepted candidate receipt is invalid");
  }
  try {
    requirePlatformAcceptanceProfile(receipt.selectedProfile);
  } catch {
    throw new Error("Accepted candidate receipt profile is invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(receipt.sourceRevision || "")) ||
      !BARE_SHA256_DIGEST.test(String(receipt.candidateDigest || ""))) {
    throw new Error("Accepted candidate receipt binding is invalid");
  }
  return { pointer, receipt, generationRoot };
}

export async function removeAcceptanceGenerationWorkspace(paths?: any, { repoRoot = "" }: Record<string, any> = {}) : Promise<any> {
  const ownerRoot: any = String(repoRoot || paths?.repoRoot || "").trim();
  if (ownerRoot && paths?.workspace) {
    const removed: any = spawnSync("git", ["worktree", "remove", "--force", paths.workspace], {
      cwd: ownerRoot,
      encoding: "utf8",
      windowsHide: true
    });
    if (removed.status !== 0) {
      throw new Error("Acceptance generation candidate worktree removal failed");
    }
  }
  await fs.rm(paths?.workspaceRoot || path.dirname(paths.workspace), { recursive: true, force: true });
}
