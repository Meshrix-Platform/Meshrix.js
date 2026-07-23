import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomic } from "../../../packages/foundation/src/storage/private-file-atomic.mjs";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.mjs";
import { assertNoSensitiveReportLeak } from "./sensitive-report-scan.mjs";
import { verifyAcceptanceEvidenceAnchor } from "./platform-acceptance-ledger-anchor.mjs";
import {
  PLATFORM_ACCEPTANCE_STATE_MACHINE,
  requirePlatformAcceptanceProfile
} from "./platform-acceptance-contract.mjs";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./platform-acceptance-command-catalog.mjs";
import { acceptanceCriteria, layerStatus } from "./platform-acceptance-reducer.mjs";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE
} from "./platform-acceptance-requirement-evidence.mjs";
import {
  PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH,
  PLATFORM_ACCEPTANCE_GENERATION_ROOT
} from "./platform-acceptance-report-catalog.mjs";

export const ACCEPTANCE_GENERATION_SCHEMA = "licomesh.platform-acceptance-generation.v1";
export const ACCEPTANCE_GENERATION_POINTER_SCHEMA = "licomesh.platform-acceptance-generation-pointer.v1";
export const ACCEPTANCE_GENERATION_ROOT = PLATFORM_ACCEPTANCE_GENERATION_ROOT;
export const ACCEPTANCE_GENERATION_POINTER = PLATFORM_ACCEPTANCE_GENERATION_POINTER_PATH;
export const ACCEPTANCE_EXECUTION_LEASE_SCHEMA = "licomesh.platform-acceptance-execution-lease.v1";
export const ACCEPTANCE_GENERATION_BUDGETS = Object.freeze({
  maxEntries: 256,
  maxEntryBytes: 32 * 1024 * 1024,
  maxGenerationBytes: 256 * 1024 * 1024,
  maxRetainedGenerations: 8,
  publicationLockTimeoutMs: 5_000,
  stalePublicationLockMs: 5 * 60 * 1000
});

function normalizedLogicalPath(value) {
  const logicalPath = String(value || "").trim().split(path.sep).join("/");
  if (!logicalPath || path.posix.isAbsolute(logicalPath)) {
    throw new Error(`Acceptance generation path must be repository-relative: ${logicalPath || "<empty>"}`);
  }
  const normalized = path.posix.normalize(logicalPath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Acceptance generation path escapes its root: ${logicalPath}`);
  }
  return normalized;
}

async function assertPathHasNoSymlinkComponents(root, logicalPath, finalKind) {
  const normalized = normalizedLogicalPath(logicalPath);
  let current = path.resolve(root);
  let stats;
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

function generationId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return `${timestamp}-${crypto.randomBytes(12).toString("hex")}`;
}

function isUnsupportedSyncError(error) {
  return process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

async function syncPathIfSupported(targetPath) {
  const handle = await fs.open(targetPath, "r").catch((error) => {
    if (isUnsupportedSyncError(error)) return null;
    throw error;
  });
  try {
    await handle?.sync();
  } catch (error) {
    if (!isUnsupportedSyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function generationPaths(repoRoot, id = generationId(), workspace = "", baseGenerationId = "") {
  const root = path.join(repoRoot, ACCEPTANCE_GENERATION_ROOT);
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

async function currentGenerationId(pointerPath) {
  try {
    const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    if (pointer?.schemaVersion !== ACCEPTANCE_GENERATION_POINTER_SCHEMA ||
        !String(pointer.generationId || "").trim()) {
      throw new Error("Acceptance generation pointer is invalid");
    }
    return String(pointer.generationId);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function withAcceptanceExecutionLease(repoRoot, action) {
  if (typeof action !== "function") throw new TypeError("Acceptance execution lease action is required");
  const root = path.join(repoRoot, ACCEPTANCE_GENERATION_ROOT);
  const leasePath = path.join(root, "execution.lock");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString("hex");
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(leasePath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: ACCEPTANCE_EXECUTION_LEASE_SCHEMA,
        pid: process.pid,
        token
      })}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      const [existingText, stats] = await Promise.all([
        fs.readFile(leasePath, "utf8").catch(() => ""),
        fs.stat(leasePath).catch(() => null)
      ]);
      let existing = null;
      try {
        existing = JSON.parse(existingText);
      } catch {
        existing = null;
      }
      if (existing?.schemaVersion === ACCEPTANCE_EXECUTION_LEASE_SCHEMA &&
          processIsAlive(Number(existing.pid))) {
        const leaseError = new Error("Platform acceptance execution lease is already held");
        leaseError.code = "platform_acceptance_execution_lease_held";
        throw leaseError;
      }
      if (!existing && stats && Date.now() - stats.mtimeMs < 5_000) {
        const leaseError = new Error("Platform acceptance execution lease is being acquired");
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
    const current = await fs.readFile(leasePath, "utf8").then(JSON.parse).catch(() => null);
    if (current?.token === token) await fs.rm(leasePath, { force: true });
  }
}

async function withPublicationLock(root, action) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, "publication.lock");
  const startedAt = Date.now();
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      try {
        return await action();
      } finally {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ACCEPTANCE_GENERATION_BUDGETS.stalePublicationLockMs) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= ACCEPTANCE_GENERATION_BUDGETS.publicationLockTimeoutMs) {
        throw new Error("Acceptance generation publication lock timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function workspaceCopyFilter(repoRoot) {
  const excludedTopLevel = new Set([".git", "node_modules"]);
  const allowedBuildPrefixes = ["build/plan-proof-ledger"];
  return (sourcePath) => {
    const relativePath = path.relative(repoRoot, sourcePath);
    if (!relativePath) return true;
    const normalized = relativePath.split(path.sep).join("/");
    const [firstSegment] = relativePath.split(path.sep);
    if (excludedTopLevel.has(firstSegment)) return false;
    if (firstSegment === "build") {
      if (normalized === "build") return true;
      return allowedBuildPrefixes.some((prefix) =>
        normalized === prefix || normalized.startsWith(`${prefix}/`));
    }
    return true;
  };
}

const WORKSPACE_PACKAGE_SCOPE = "@lico";

async function linkWorkspaceNodeModules(repoRoot, workspace) {
  const sourceRoot = path.join(repoRoot, "node_modules");
  const targetRoot = path.join(workspace, "node_modules");
  const localPackages = path.join(workspace, "packages");
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(sourceRoot);
  for (const entry of entries) {
    if (entry === WORKSPACE_PACKAGE_SCOPE) continue;
    await fs.symlink(path.join(sourceRoot, entry), path.join(targetRoot, entry), "junction");
  }
  const scopeSource = path.join(sourceRoot, WORKSPACE_PACKAGE_SCOPE);
  const scopeTarget = path.join(targetRoot, WORKSPACE_PACKAGE_SCOPE);
  await fs.mkdir(scopeTarget, { recursive: true, mode: 0o700 });
  const scopeEntries = await fs.readdir(scopeSource).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const localEntries = await fs.readdir(localPackages).catch(() => []);
  const localNames = new Set(localEntries);
  await Promise.all(scopeEntries.map(async (entry) => {
    const localPackage = path.join(localPackages, entry);
    const stats = localNames.has(entry) ? await fs.stat(localPackage).catch(() => null) : null;
    const source = stats?.isDirectory() ? localPackage : path.join(scopeSource, entry);
    await fs.symlink(source, path.join(scopeTarget, entry), "junction");
  }));
}

export async function createAcceptanceGenerationWorkspace(repoRoot, { id } = {}) {
  const selectedId = id || generationId();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `lico-acceptance-${selectedId}-`));
  const baseGenerationId = await currentGenerationId(
    path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER)
  );
  const paths = generationPaths(repoRoot, selectedId, workspace, baseGenerationId);
  try {
    await fs.cp(repoRoot, paths.workspace, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: workspaceCopyFilter(repoRoot)
    });
    const dependencyRoot = path.join(repoRoot, "node_modules");
    const stats = await fs.stat(dependencyRoot);
    if (!stats.isDirectory()) throw new Error("not a directory");
    await linkWorkspaceNodeModules(repoRoot, paths.workspace);
    await fs.symlink(path.join(repoRoot, ".git"), path.join(paths.workspace, ".git"), "junction");
  } catch (error) {
    await fs.rm(paths.workspace, { recursive: true, force: true });
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
  args = ["tools/server-scripts/verify-platform-acceptance.mjs"],
  env = process.env,
  stdio = "inherit"
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: {
        ...env,
        GIT_DIR: path.join(repoRoot, ".git"),
        GIT_WORK_TREE: workspace,
        LICO_ACCEPTANCE_PROOF_LEDGER_DIR: path.join(repoRoot, "build", "acceptance-proof-ledger"),
        LICO_ACCEPTANCE_GENERATION_WORKER: "1"
      },
      stdio,
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        exitCode: Number.isInteger(code) ? code : 1,
        signal: signal || ""
      });
    });
  });
}

async function sha256File(filePath) {
  const content = await fs.readFile(filePath);
  return {
    byteLength: content.byteLength,
    sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
}

async function copyGenerationEntry(workspace, stagedGeneration, logicalPath) {
  const normalized = normalizedLogicalPath(logicalPath);
  const sourcePath = path.join(workspace, ...normalized.split("/"));
  const targetPath = path.join(stagedGeneration, ...normalized.split("/"));
  const stats = await fs.lstat(sourcePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Acceptance generation entry is not a regular file: ${normalized}`);
  }
  if (stats.size > ACCEPTANCE_GENERATION_BUDGETS.maxEntryBytes) {
    throw new Error(`Acceptance generation entry exceeds its byte budget: ${normalized}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  await syncPathIfSupported(targetPath);
  const digest = await sha256File(targetPath);
  return { path: normalized, ...digest };
}

async function validateOwnedReport(workspace, inventoryEntry) {
  const reportPath = normalizedLogicalPath(inventoryEntry?.reportPath);
  const raw = await fs.readFile(path.join(workspace, ...reportPath.split("/")), "utf8");
  let report;
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
  const provenance = report.releaseEvidenceProvenance;
  const payload = Object.fromEntries(Object.entries(report)
    .filter(([key]) => key !== "releaseEvidenceProvenance"));
  if (!provenance || provenance.schemaVersion !== inventoryEntry.provenanceSchemaVersion ||
      provenance.commandId !== inventoryEntry.ownerCommandId ||
      provenance.producer !== inventoryEntry.producer ||
      provenance.reportPayloadDigest !== reportPayloadDigest(payload) ||
      !Number.isFinite(Date.parse(provenance.recordedAt))) {
    throw new Error(`Acceptance generation report provenance is invalid: ${reportPath}`);
  }
  assertNoSensitiveReportLeak(raw, `acceptance generation report ${reportPath}`);
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireAggregate(condition, code) {
  if (!condition) throw new Error(`Acceptance generation aggregate contract is invalid: ${code}`);
}

function validateReceiptPreflight(preflight, selectedProfile) {
  requireAggregate(preflight?.selectedProfile === selectedProfile, "receipt-profile-mismatch");
  requireAggregate(SHA256_DIGEST.test(String(preflight?.planReceiptSetDigest || "")), "receipt-set-digest-invalid");
  requireAggregate(Number.isInteger(preflight?.requiredReceiptCount) && preflight.requiredReceiptCount > 0,
    "receipt-count-invalid");
  requireAggregate(Array.isArray(preflight?.bindings) &&
    preflight.bindings.length === preflight.requiredReceiptCount, "receipt-bindings-invalid");
}

function validateCommandAndRequirementEvidence(aggregateReport) {
  const commandIds = aggregateReport.commands.map((command) => command?.id);
  requireAggregate(
    sameValues(commandIds, PLATFORM_ACCEPTANCE_COMMANDS.map((command) => command.id)),
    "command-catalog-binding"
  );
  for (let index = 0; index < PLATFORM_ACCEPTANCE_COMMANDS.length; index += 1) {
    const expected = PLATFORM_ACCEPTANCE_COMMANDS[index];
    const actual = aggregateReport.commands[index];
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
  const nodes = aggregateReport.requirementEvidence?.nodes;
  requireAggregate(
    sameValues(nodes?.map((node) => node?.requirement), PLATFORM_ACCEPTANCE_REQUIREMENTS),
    "requirement-label-binding"
  );
  const commandById = new Map(PLATFORM_ACCEPTANCE_COMMANDS.map((command) => [command.id, command]));
  for (const node of nodes) {
    const expected = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[node.requirement];
    const expectedReportPaths = [...new Set(expected.commandIds.flatMap(
      (commandId) => commandById.get(commandId)?.ownedReports || []
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

async function verifyAggregateLedgerAnchor({ aggregateReport, repoRoot }) {
  const anchor = aggregateReport.ledgerAnchor;
  const proofSubstrate = createOperationProofSubstrate({
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
} = {}) {
  requireAggregate(aggregateReport?.schemaVersion === "v0.0.1:acceptance:platform-report-2", "schema");
  requireAggregate(aggregateReport?.verifier === "tools/server-scripts/verify-platform-acceptance.mjs", "verifier");
  const selectedProfile = requirePlatformAcceptanceProfile(aggregateReport?.selectedProfile);
  requireAggregate(aggregateReport.status === "accepted", "status");
  requireAggregate(aggregateReport.stateMachine?.currentState === "accepted" &&
    aggregateReport.stateMachine?.event === "all_acceptance_criteria_ready", "terminal-state");
  const { currentState: _currentState, event: _event, ...stateMachineContract } = aggregateReport.stateMachine;
  requireAggregate(sameValues(stateMachineContract, PLATFORM_ACCEPTANCE_STATE_MACHINE), "state-machine-contract");
  requireAggregate(aggregateReport.commandSchedule?.valid === true, "command-schedule");
  requireAggregate(Array.isArray(aggregateReport.commands) && aggregateReport.commands.length > 0 &&
    aggregateReport.commands.every((command) => command?.status === "passed"), "command-results");
  validateCommandAndRequirementEvidence(aggregateReport);
  requireAggregate(Array.isArray(aggregateReport.acceptanceLayers) &&
    aggregateReport.acceptanceLayers.every((layer) => layer?.status === "passed") &&
    sameValues(
      aggregateReport.acceptanceLayers,
      PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map((layer) => layerStatus(layer, aggregateReport.commands))
    ), "acceptance-layers");
  const expectedCriteriaShape = acceptanceCriteria([], {}, [], PLATFORM_ACCEPTANCE_COMMANDS)
    .map(({ id, label }) => ({ id, label }));
  requireAggregate(Array.isArray(aggregateReport.acceptanceCriteria) &&
    aggregateReport.acceptanceCriteria.length > 0 &&
    aggregateReport.acceptanceCriteria.every((criterion) => criterion?.ready === true) &&
    sameValues(
      aggregateReport.acceptanceCriteria.map(({ id, label }) => ({ id, label })),
      expectedCriteriaShape
    ), "acceptance-criteria");
  requireAggregate(sameValues(aggregateReport.requiredReports, requiredReports), "required-reports");
  requireAggregate(sameValues(aggregateReport.releaseEvidenceInventory, releaseEvidenceInventory), "report-inventory");
  const inventoryDigest = reportPayloadDigest({ inventory: releaseEvidenceInventory });
  requireAggregate(aggregateReport.releaseEvidenceInventoryDigest === inventoryDigest, "report-inventory-digest");
  validateReceiptPreflight(aggregateReport.planReceiptPreflight, selectedProfile);
  validateReceiptPreflight(aggregateReport.finalPlanReceiptPreflight, selectedProfile);
  requireAggregate(
    aggregateReport.planReceiptPreflight.planReceiptSetDigest ===
      aggregateReport.finalPlanReceiptPreflight.planReceiptSetDigest,
    "receipt-set-drift"
  );
  requireAggregate(aggregateReport.capabilityEvidenceExecution?.ready === true, "capability-evidence");
  requireAggregate(aggregateReport.requirementEvidence?.ready === true &&
    aggregateReport.requirementEvidence?.requirementCount === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    aggregateReport.requirementEvidence?.readyCount === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    Array.isArray(aggregateReport.requirementEvidence?.nodes) &&
    aggregateReport.requirementEvidence.nodes.length === PLATFORM_ACCEPTANCE_REQUIREMENTS.length &&
    aggregateReport.requirementEvidence.nodes.every((node) => node?.ready === true),
    "requirement-evidence");
  requireAggregate(
    Array.isArray(aggregateReport.blockedCommandValidation?.validBlockedCommandIds) &&
      aggregateReport.blockedCommandValidation.validBlockedCommandIds.length === 0 &&
      Array.isArray(aggregateReport.blockedCommandValidation?.invalidBlockedCommandIds) &&
      aggregateReport.blockedCommandValidation.invalidBlockedCommandIds.length === 0,
    "blocked-command-validation"
  );
  const evidence = aggregateReport.reportEvidence;
  requireAggregate(evidence && typeof evidence === "object" &&
    sameValues(Object.keys(evidence).sort(), [...requiredReports].sort()) &&
    Object.values(evidence).every((entry) => entry?.releaseReady === true &&
      entry?.validationPassed === true && entry?.reportLeakScan === true), "report-evidence");
  const summary = aggregateReport.summary;
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
  const anchor = aggregateReport.ledgerAnchor;
  requireAggregate(anchor?.error === "" && anchor?.skipped === false &&
    anchor?.verification?.ok === true && anchor?.reportDigestCount === requiredReports.length &&
    Array.isArray(anchor?.reportDigests) && anchor.reportDigests.length === requiredReports.length,
    "ledger-anchor-shape");
  requireAggregate(anchor.evidenceContext?.selectedProfile === selectedProfile &&
    anchor.evidenceContext?.ownedReportsInventoryDigest === inventoryDigest &&
    anchor.evidenceContext?.planReceiptSetDigest === aggregateReport.planReceiptPreflight.planReceiptSetDigest &&
    anchor.evidenceContext?.privacySafe === true, "ledger-context");
  const verification = await verifyLedgerAnchor({ aggregateReport, repoRoot });
  requireAggregate(verification?.ok === true, "ledger-anchor-verification");
  return Object.freeze({ selectedProfile, inventoryDigest });
}

async function pruneCommittedGenerations(paths) {
  const generationsRoot = path.dirname(paths.committedGeneration);
  const entries = (await fs.readdir(generationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
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
}) {
  if (!Array.isArray(releaseEvidenceInventory) || releaseEvidenceInventory.length === 0) {
    throw new Error("Acceptance generation requires a release evidence inventory");
  }
  if (releaseEvidenceInventory.length > ACCEPTANCE_GENERATION_BUDGETS.maxEntries) {
    throw new Error("Acceptance generation report inventory exceeds its entry budget");
  }
  const inventoryPaths = releaseEvidenceInventory.map((entry) => normalizedLogicalPath(entry?.reportPath));
  if (
    new Set(inventoryPaths).size !== inventoryPaths.length ||
    JSON.stringify([...inventoryPaths].sort()) !== JSON.stringify(
      [...(Array.isArray(requiredReports) ? requiredReports : [])].map(normalizedLogicalPath).sort()
    )
  ) {
    throw new Error("Acceptance generation inventory does not match required reports");
  }
  const logicalPaths = [...new Set([
    ...(Array.isArray(requiredReports) ? requiredReports : []),
    aggregateReportPath
  ].map(normalizedLogicalPath))].sort();
  if (logicalPaths.length === 0) {
    throw new Error("Acceptance generation has no report entries");
  }
  const aggregateLogicalPath = normalizedLogicalPath(aggregateReportPath);
  const aggregateReport = JSON.parse(await fs.readFile(
    path.join(paths.workspace, ...aggregateLogicalPath.split("/")),
    "utf8"
  ));
  const aggregateBinding = await validateAcceptedAggregateReport({
    aggregateReport,
    releaseEvidenceInventory,
    requiredReports,
    repoRoot,
    verifyLedgerAnchor
  });
  assertNoSensitiveReportLeak(aggregateReport, "acceptance generation aggregate report");
  for (const inventoryEntry of releaseEvidenceInventory) {
    await validateOwnedReport(paths.workspace, inventoryEntry);
  }

  await fs.mkdir(path.dirname(paths.stagedGeneration), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(paths.committedGeneration), { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.stagedGeneration, { recursive: false, mode: 0o700 });
  let committed = false;
  let published = false;
  try {
    const entries = [];
    for (const logicalPath of logicalPaths) {
      entries.push(await copyGenerationEntry(paths.workspace, paths.stagedGeneration, logicalPath));
    }
    const generationBytes = entries.reduce((total, entry) => total + Number(entry.byteLength || 0), 0);
    if (generationBytes > ACCEPTANCE_GENERATION_BUDGETS.maxGenerationBytes) {
      throw new Error("Acceptance generation exceeds its total byte budget");
    }

    const manifest = {
      schemaVersion: ACCEPTANCE_GENERATION_SCHEMA,
      generationId: paths.id,
      createdAt: new Date().toISOString(),
      aggregateReport: aggregateLogicalPath,
      selectedProfile: aggregateBinding.selectedProfile,
      planReceiptSetDigest: aggregateReport.planReceiptPreflight.planReceiptSetDigest,
      ledgerEventId: aggregateReport.ledgerAnchor.ledgerEventId,
      releaseEvidenceInventory,
      releaseEvidenceInventoryDigest: reportPayloadDigest({ inventory: releaseEvidenceInventory }),
      entries
    };
    await writePrivateFileAtomic(
      path.join(paths.stagedGeneration, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const manifestDigest = await sha256File(path.join(paths.stagedGeneration, "manifest.json"));
    await syncPathIfSupported(paths.stagedGeneration);
    await fs.rename(paths.stagedGeneration, paths.committedGeneration);
    committed = true;
    await syncPathIfSupported(path.dirname(paths.committedGeneration));

    const pointer = {
      schemaVersion: ACCEPTANCE_GENERATION_POINTER_SCHEMA,
      generationId: paths.id,
      generation: path.relative(repoRoot, paths.committedGeneration).split(path.sep).join("/"),
      manifest: "manifest.json",
      manifestSha256: manifestDigest.sha256
    };
    await withPublicationLock(paths.root, async () => {
      const currentId = await currentGenerationId(paths.pointer);
      if (currentId !== String(paths.baseGenerationId || "")) {
        throw new Error("Acceptance generation publication fence rejected a stale run");
      }
      await writePrivateFileAtomic(paths.pointer, `${JSON.stringify(pointer, null, 2)}\n`);
      await syncPathIfSupported(path.dirname(paths.pointer));
      published = true;
      await pruneCommittedGenerations(paths);
    });
    return { manifest, pointer };
  } catch (error) {
    await fs.rm(paths.stagedGeneration, { recursive: true, force: true });
    if (committed && !published) {
      await fs.rm(paths.committedGeneration, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function resolveCurrentAcceptanceGeneration(repoRoot, {
  verifyLedgerAnchor = verifyAggregateLedgerAnchor
} = {}) {
  const pointerPath = path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER);
  await assertPathHasNoSymlinkComponents(repoRoot, ACCEPTANCE_GENERATION_POINTER, "file");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  if (pointer?.schemaVersion !== ACCEPTANCE_GENERATION_POINTER_SCHEMA) {
    throw new Error("Acceptance generation pointer schema is invalid");
  }
  const generation = normalizedLogicalPath(pointer.generation);
  const requiredPrefix = `${ACCEPTANCE_GENERATION_ROOT}/generations/`;
  if (!generation.startsWith(requiredPrefix) || pointer.manifest !== "manifest.json") {
    throw new Error("Acceptance generation pointer target is invalid");
  }
  const generationRoot = path.join(repoRoot, ...generation.split("/"));
  await assertPathHasNoSymlinkComponents(repoRoot, generation, "directory");
  const manifestPath = path.join(generationRoot, normalizedLogicalPath(pointer.manifest));
  await assertPathHasNoSymlinkComponents(generationRoot, pointer.manifest, "file");
  const manifestDigest = await sha256File(manifestPath);
  if (!/^[a-f0-9]{64}$/u.test(String(pointer.manifestSha256 || "")) ||
      manifestDigest.sha256 !== pointer.manifestSha256) {
    throw new Error("Acceptance generation manifest digest does not match its pointer");
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== ACCEPTANCE_GENERATION_SCHEMA || manifest.generationId !== pointer.generationId) {
    throw new Error("Acceptance generation manifest does not match its pointer");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Acceptance generation manifest has no entries");
  }
  try {
    requirePlatformAcceptanceProfile(manifest.selectedProfile);
  } catch {
    throw new Error("Acceptance generation manifest profile is invalid");
  }
  if (!SHA256_DIGEST.test(String(manifest.planReceiptSetDigest || "")) ||
      !String(manifest.ledgerEventId || "").trim()) {
    throw new Error("Acceptance generation manifest acceptance binding is invalid");
  }
  if (
    !Array.isArray(manifest.releaseEvidenceInventory) ||
    manifest.releaseEvidenceInventory.length === 0 ||
    manifest.releaseEvidenceInventoryDigest !== reportPayloadDigest({
      inventory: manifest.releaseEvidenceInventory
    })
  ) {
    throw new Error("Acceptance generation release evidence inventory is invalid");
  }
  for (const inventoryEntry of manifest.releaseEvidenceInventory) {
    for (const field of [
      "reportPath",
      "ownerCommandId",
      "producer",
      "reportSchemaVersion",
      "timestampField",
      "reducer",
      "provenanceSchemaVersion"
    ]) {
      if (!String(inventoryEntry?.[field] || "").trim()) {
        throw new Error(`Acceptance generation inventory field is missing: ${field}`);
      }
    }
    if (
      inventoryEntry.reportLeakScanField !== null &&
      !String(inventoryEntry.reportLeakScanField || "").trim()
    ) {
      throw new Error("Acceptance generation inventory leak-scan field is invalid");
    }
  }
  const manifestEntryPaths = manifest.entries.map((entry) => normalizedLogicalPath(entry?.path)).sort();
  const inventoryEntryPaths = [
    ...manifest.releaseEvidenceInventory.map((entry) => normalizedLogicalPath(entry?.reportPath)),
    normalizedLogicalPath(manifest.aggregateReport)
  ].sort();
  if (
    new Set(manifestEntryPaths).size !== manifestEntryPaths.length ||
    JSON.stringify(manifestEntryPaths) !== JSON.stringify(inventoryEntryPaths)
  ) {
    throw new Error("Acceptance generation entries do not match its release evidence inventory");
  }
  for (const entry of manifest.entries) {
    const logicalPath = normalizedLogicalPath(entry?.path);
    await assertPathHasNoSymlinkComponents(generationRoot, logicalPath, "file");
    const reportPath = path.join(generationRoot, ...logicalPath.split("/"));
    const stats = await fs.lstat(reportPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Acceptance generation entry is not a regular file: ${logicalPath}`);
    }
    const digest = await sha256File(reportPath);
    if (digest.sha256 !== entry.sha256 || digest.byteLength !== entry.byteLength) {
      throw new Error(`Acceptance generation entry digest mismatch: ${logicalPath}`);
    }
  }
  for (const inventoryEntry of manifest.releaseEvidenceInventory) {
    await validateOwnedReport(generationRoot, inventoryEntry);
  }
  const aggregateLogicalPath = normalizedLogicalPath(manifest.aggregateReport);
  const aggregateReport = JSON.parse(await fs.readFile(
    path.join(generationRoot, ...aggregateLogicalPath.split("/")),
    "utf8"
  ));
  const aggregateBinding = await validateAcceptedAggregateReport({
    aggregateReport,
    releaseEvidenceInventory: manifest.releaseEvidenceInventory,
    requiredReports: manifest.releaseEvidenceInventory.map((entry) => entry.reportPath),
    repoRoot,
    verifyLedgerAnchor
  });
  assertNoSensitiveReportLeak(aggregateReport, "resolved acceptance generation aggregate report");
  if (
    aggregateBinding.selectedProfile !== manifest.selectedProfile ||
    aggregateReport.planReceiptPreflight.planReceiptSetDigest !== manifest.planReceiptSetDigest ||
    aggregateReport.ledgerAnchor.ledgerEventId !== manifest.ledgerEventId
  ) {
    throw new Error("Acceptance generation manifest does not bind its aggregate report");
  }
  return { pointer, manifest, generationRoot };
}

export async function removeAcceptanceGenerationWorkspace(paths) {
  await fs.rm(paths.workspace, { recursive: true, force: true });
}
