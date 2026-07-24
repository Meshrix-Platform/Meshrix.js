#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyMachineDefinition } from "../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.mjs";
import { loadPluginRegistry } from "../../packages/foundation/src/module-system/plugin-registry.mjs";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.mjs";
import { reduceCapabilityCheckpoints } from "./capability-acceptance-checkpoint-reducer.mjs";
import { assertNoLeak } from "./lib/report-evidence-safety.mjs";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./verify-platform-acceptance.mjs";
import {
  applyPluginRuntimeCapabilityFailures,
  collectPluginRuntimeOwnershipFailures,
  reducePluginRuntimeCapabilityBindings
} from "./lib/plugin-runtime-capability-bindings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CHECKPOINT_ROOT = path.join(ROOT, "tools/registry/capability-acceptance-checkpoints");
const REGISTRY_PATH = path.join(ROOT, "tools/registry/capability-acceptance.registry.json");
const DEFINITION_ROOT = path.join(
  ROOT,
  "packages/foundation/src/workflow/state-machine/definitions/acceptance"
);
const REPORT_PATH = path.join(ROOT, "build/reports/capability-acceptance-machines.json");
const REPORT_SCHEMA_VERSION = "v0.0.1:acceptance:capability-machines-report-7";
const VERIFIER = "tools/server-scripts/verify-capability-acceptance-machines.mjs";
const LEGAL_BLOCKER_KINDS = new Set(["external-evidence"]);
const LEGAL_RELEASE_SCOPES = new Set(["core-release", "optional-support-matrix"]);

export const CAPABILITY_EVIDENCE_COMMAND_AUTHORITY = new Map(
  PLATFORM_ACCEPTANCE_COMMANDS.map((command) => [command.id, Object.freeze({
    acceptanceCommandId: command.id,
    ownedReports: Object.freeze([...(command.ownedReports || [])])
  })])
);

function toPosixRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function capabilityIds() {
  return fs.readdirSync(CHECKPOINT_ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(CHECKPOINT_ROOT, name))
    .filter((entry) => fs.statSync(entry).isFile())
    .map((entry) => path.basename(entry, ".json"))
    .sort();
}

function loadAcceptanceRegistry() {
  const registry = readJson(REGISTRY_PATH);
  if (!Array.isArray(registry.entries)) {
    throw new Error("Capability acceptance registry entries must be an array.");
  }
  return registry;
}

function addFinding(findings, capabilityId, code, message, filePath = "", details = {}) {
  findings.push({
    capabilityId,
    code,
    message,
    path: filePath ? toPosixRelative(filePath) : "",
    ...details
  });
}

function verifyCapability(entry, pluginRuntimeReduction) {
  const findings = [];
  const capabilityId = entry.capabilityId;
  const releaseScope = String(entry.releaseScope || "").trim();
  const machineId = `acceptance.${capabilityId}`;
  const checkpointPath = path.join(CHECKPOINT_ROOT, `${capabilityId}.json`);
  const definitionPath = path.join(DEFINITION_ROOT, `${capabilityId}.json`);

  if (entry.checkpointPath !== toPosixRelative(checkpointPath)) {
    addFinding(findings, capabilityId, "registry-checkpoint-path-mismatch", "Registry checkpointPath must match the tracked capability checkpoint authority.", REGISTRY_PATH);
  }
  if (entry.acceptanceMachineId !== machineId) {
    addFinding(findings, capabilityId, "registry-machine-id-mismatch", `Registry acceptanceMachineId must be ${machineId}`, REGISTRY_PATH);
  }
  if (entry.definitionPath !== toPosixRelative(definitionPath)) {
    addFinding(findings, capabilityId, "registry-definition-path-mismatch", "Registry definitionPath must match the generated definition.", REGISTRY_PATH);
  }
  if (entry.verifier !== VERIFIER) {
    addFinding(findings, capabilityId, "registry-verifier-mismatch", `Registry verifier must be ${VERIFIER}`, REGISTRY_PATH);
  }
  if (entry.reportPath !== "build/reports/capability-acceptance-machines.json") {
    addFinding(findings, capabilityId, "registry-report-path-mismatch", "Registry reportPath must match the verifier report.", REGISTRY_PATH);
  }
  if (entry.platformReducerCommand !== "npm run verify:acceptance") {
    addFinding(findings, capabilityId, "registry-platform-reducer-mismatch", "Registry platformReducerCommand must identify npm run verify:acceptance as the external platform authority.", REGISTRY_PATH);
  }
  if (!LEGAL_RELEASE_SCOPES.has(releaseScope)) {
    addFinding(
      findings,
      capabilityId,
      "registry-release-scope-invalid",
      "Registry releaseScope must classify the capability as core-release or optional-support-matrix.",
      REGISTRY_PATH
    );
  }

  let checkpoints = null;
  try {
    checkpoints = readJson(checkpointPath);
  } catch (error) {
    addFinding(
      findings,
      capabilityId,
      "checkpoints-unreadable",
      `Capability checkpoints are unreadable: ${error?.code || "read-failed"}.`,
      checkpointPath
    );
  }
  const checkpointReduction = applyPluginRuntimeCapabilityFailures(
    reduceCapabilityCheckpoints(checkpoints, {
      evidenceCommandAuthority: CAPABILITY_EVIDENCE_COMMAND_AUTHORITY
    }),
    checkpoints,
    pluginRuntimeReduction.blockersByCapability[capabilityId] || []
  );
  if (checkpointReduction.blocked === true && !(checkpointReduction.blockers || []).every((blocker) =>
    LEGAL_BLOCKER_KINDS.has(String(blocker?.kind || "").trim())
  )) {
    addFinding(
      findings,
      capabilityId,
      "capability-blocker-kind-invalid",
      "A blocked capability may contain only canonical external-evidence blockers.",
      checkpointPath
    );
  }
  for (const checkpointFinding of checkpointReduction.findings) {
    addFinding(
      findings,
      capabilityId,
      checkpointFinding.code,
      checkpointFinding.message,
      checkpointPath,
      {
        checkpointId: checkpointFinding.checkpointId,
        role: checkpointFinding.role,
        prerequisiteId: checkpointFinding.prerequisiteId,
        criterionIndex: checkpointFinding.criterionIndex,
        criterionText: checkpointFinding.criterionText,
        findingCategory: checkpointFinding.category
      }
    );
  }

  let machineReport = {};
  let definition = {};
  if (!fs.existsSync(definitionPath)) {
    addFinding(findings, capabilityId, "definition-missing", `Missing acceptance definition for ${machineId}`, definitionPath);
  } else {
    try {
      definition = readJson(definitionPath);
      machineReport = verifyMachineDefinition(definition, {
        throwOnError: false,
        relativePath: toPosixRelative(definitionPath)
      });
    } catch (error) {
      addFinding(
        findings,
        capabilityId,
        "definition-unreadable",
        `Acceptance definition is unreadable: ${error?.code || "read-failed"}.`,
        definitionPath
      );
    }
  }

  if (fs.existsSync(definitionPath) && machineReport.ok !== true) {
    addFinding(findings, capabilityId, "definition-verification-failed", `Acceptance definition failed C3 verification for ${machineId}`, definitionPath);
  }
  if (definition.machineId !== machineId) {
    addFinding(findings, capabilityId, "machine-id-mismatch", `Expected machineId ${machineId}`, definitionPath);
  }
  if (definition.entityType !== "capability_acceptance") {
    addFinding(findings, capabilityId, "entity-type-mismatch", "Acceptance definition must use entityType capability_acceptance", definitionPath);
  }
  if (definition.acceptance?.capabilityId !== capabilityId) {
    addFinding(findings, capabilityId, "acceptance-capability-mismatch", "Definition acceptance metadata must match the capability id", definitionPath);
  }
  if (definition.acceptance?.registryPath !== toPosixRelative(REGISTRY_PATH)) {
    addFinding(findings, capabilityId, "registry-path-mismatch", "Definition acceptance metadata must point at the capability acceptance registry", definitionPath);
  }
  if (definition.acceptance?.checkpointPath !== toPosixRelative(checkpointPath)) {
    addFinding(findings, capabilityId, "checkpoint-path-mismatch", "Definition acceptance metadata must point at the capability checkpoints", definitionPath);
  }
  if (definition.acceptance?.platformReducerCommand !== "npm run verify:acceptance") {
    addFinding(findings, capabilityId, "platform-reducer-mismatch", "Definition must identify npm run verify:acceptance as the external platform reducer", definitionPath);
  }
  const readyForReleaseReduction = checkpointReduction.readyForReleaseReduction === true &&
    findings.length === 0;
  const blocked = !readyForReleaseReduction &&
    findings.length === 0 &&
    checkpointReduction.blocked === true;
  const reasons = [...new Set([
    ...checkpointReduction.reasons,
    ...findings.map((finding) => finding.code)
  ])];

  return {
    capabilityId,
    releaseScope,
    machineId,
    definitionPath: toPosixRelative(definitionPath),
    checkpointPath: toPosixRelative(checkpointPath),
    currentState: readyForReleaseReduction ? "verified" : blocked ? "blocked" : "failed",
    readyForReleaseReduction,
    blocked,
    failureKind: findings.length > 0 && !checkpointReduction.failureKind
      ? "capability-definition-invalid"
      : checkpointReduction.failureKind,
    checkpointReductionSourceOfTruth: checkpointReduction.sourceOfTruth,
    pluginRuntimeReductionSourceOfTruth: checkpointReduction.pluginRuntimeReductionSourceOfTruth || "",
    pluginRuntimeBlockerCount: Number(checkpointReduction.pluginRuntimeBlockerCount || 0),
    checkpointCount: checkpointReduction.checkpointCount,
    completedCheckpointCount: checkpointReduction.completedCheckpointCount,
    openCheckpoints: checkpointReduction.openCheckpoints,
    uncheckedCriteria: checkpointReduction.uncheckedCriteria,
    blockers: checkpointReduction.blockers,
    evidenceBindings: checkpointReduction.evidenceBindings || [],
    reasons,
    machineCompletenessLevel: machineReport.completenessLevel || "",
    stateCount: machineReport.stateCount || 0,
    eventCount: machineReport.eventCount || 0,
    matrixCellCount: machineReport.matrixCellCount || 0,
    findings
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function finalizeCapabilityAcceptanceReport(report, scan = assertNoLeak) {
  if (!report?.summary || typeof report.summary !== "object") {
    throw new TypeError("Capability acceptance report summary is required.");
  }
  report.summary.reportLeakScan = false;
  scan(report, "capability acceptance machines report");
  report.summary.reportLeakScan = true;
  scan(report, "capability acceptance machines report");
  return report;
}

export function reduceCapabilityBlockers(capabilities = []) {
  const blockersByKey = new Map();
  for (const capability of capabilities) {
    for (const blocker of capability.blockers || []) {
      const key = `${capability.capabilityId}:${blocker.code}`;
      const checkpointRefs = Array.isArray(blocker.checkpointRefs)
        ? blocker.checkpointRefs.map((ref) => ({
            checkpointId: ref.checkpointId,
            role: ref.role,
            criterionIndex: ref.criterionIndex
          }))
        : [{
            checkpointId: blocker.checkpointId,
            role: blocker.role,
            criterionIndex: blocker.criterionIndex
          }];
      const existing = blockersByKey.get(key);
      if (existing) {
        for (const checkpointRef of checkpointRefs) {
          if (!existing.checkpointRefs.some((ref) =>
            ref.checkpointId === checkpointRef.checkpointId &&
            ref.role === checkpointRef.role &&
            ref.criterionIndex === checkpointRef.criterionIndex
          )) {
            existing.checkpointRefs.push(checkpointRef);
          }
        }
        continue;
      }
      const {
        checkpointId: _checkpointId,
        role: _role,
        criterionIndex: _criterionIndex,
        checkpointRefs: _checkpointRefs,
        ...shared
      } = blocker;
      blockersByKey.set(key, {
        capabilityId: capability.capabilityId,
        ...shared,
        checkpointRefs
      });
    }
  }
  return [...blockersByKey.values()];
}

export function reduceCapabilityEvidenceBindings(capabilities = []) {
  const bindings = new Map();
  for (const capability of capabilities) {
    for (const binding of capability.evidenceBindings || []) {
      const normalized = {
        capabilityId: capability.capabilityId,
        acceptanceCommandId: String(binding.acceptanceCommandId || "").trim(),
        report: String(binding.report || "").trim(),
        checkpointId: String(binding.checkpointId || "").trim(),
        role: String(binding.role || "").trim(),
        criterionIndex: Number.isInteger(binding.criterionIndex) ? binding.criterionIndex : null,
        evidenceIndex: Number.isInteger(binding.evidenceIndex) ? binding.evidenceIndex : null
      };
      const key = JSON.stringify(normalized);
      if (!bindings.has(key)) bindings.set(key, normalized);
    }
  }
  return [...bindings.values()];
}

export function capabilityAcceptanceExitCode(report = {}) {
  if (report.readyForReleaseReduction === true && report.currentState === "verified") {
    return 0;
  }
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const legallyBlocked = report.currentState === "blocked" &&
    report.blocked === true &&
    Array.isArray(report.findings) && report.findings.length === 0 &&
    Number(report.summary?.failedCapabilityCount || 0) === 0 &&
    blockers.length > 0 &&
    blockers.every((blocker) => LEGAL_BLOCKER_KINDS.has(String(blocker?.kind || "").trim()));
  return legallyBlocked ? 2 : 1;
}

export async function runCapabilityAcceptanceVerifier() {
  const generatedAt = new Date().toISOString();
  const registry = loadAcceptanceRegistry();
  const idsFromCheckpointAuthorities = new Set(capabilityIds());
  const idsFromRegistry = new Set();
  const registryFindings = [];
  for (const entry of registry.entries) {
    if (!entry?.capabilityId) {
      registryFindings.push({
        capabilityId: "",
        code: "registry-capability-id-missing",
        message: "Registry entry is missing capabilityId.",
        path: toPosixRelative(REGISTRY_PATH)
      });
      continue;
    }
    if (idsFromRegistry.has(entry.capabilityId)) {
      registryFindings.push({
        capabilityId: entry.capabilityId,
        code: "registry-capability-id-duplicate",
        message: `Duplicate registry entry for ${entry.capabilityId}.`,
        path: toPosixRelative(REGISTRY_PATH)
      });
    }
    idsFromRegistry.add(entry.capabilityId);
  }
  for (const capabilityId of idsFromCheckpointAuthorities) {
    if (!idsFromRegistry.has(capabilityId)) {
      registryFindings.push({
        capabilityId,
        code: "registry-entry-missing",
        message: `Registry is missing ${capabilityId}.`,
        path: toPosixRelative(REGISTRY_PATH)
      });
    }
  }
  for (const capabilityId of idsFromRegistry) {
    if (!idsFromCheckpointAuthorities.has(capabilityId)) {
      registryFindings.push({
        capabilityId,
        code: "registry-entry-orphan",
        message: `Registry entry has no tracked checkpoint authority: ${capabilityId}.`,
        path: toPosixRelative(REGISTRY_PATH)
      });
    }
  }
  if (registry.entryCount !== registry.entries.length) {
    registryFindings.push({
      capabilityId: "",
      code: "registry-entry-count-mismatch",
      message: "Registry entryCount must match entries length.",
      path: toPosixRelative(REGISTRY_PATH)
    });
  }
  let pluginRuntimeReduction = {
    sourceOfTruth: "",
    pluginIds: [],
    unownedPluginIds: [],
    blockersByCapability: {},
    findings: []
  };
  let pluginArtifactFixture = null;
  try {
    pluginArtifactFixture = await stagePluginArtifactVerificationFixture({ sourcePluginRoot: path.join(ROOT, "plugins") });
    const pluginRegistry = await loadPluginRegistry({ artifactAuthority: pluginArtifactFixture.authority });
    const pluginIds = pluginRegistry.listPlugins().map((plugin) => plugin.id);
    const pluginOwnershipFailures = await collectPluginRuntimeOwnershipFailures(pluginRegistry, { repoRoot: ROOT });
    pluginRuntimeReduction = reducePluginRuntimeCapabilityBindings({
      pluginIds,
      blockers: pluginOwnershipFailures,
      capabilityEntries: registry.entries
    });
    for (const finding of pluginRuntimeReduction.findings) {
      registryFindings.push({
        capabilityId: finding.capabilityId,
        code: finding.code,
        message: finding.message,
        path: toPosixRelative(REGISTRY_PATH),
        findingCategory: finding.category,
        pluginId: finding.pluginId
      });
    }
  } catch {
    registryFindings.push({
      capabilityId: "plugin-runtime-and-module-system",
      code: "plugin-runtime-ownership-source-unreadable",
      message: "The plugin runtime ownership authority could not be reduced.",
      path: toPosixRelative(REGISTRY_PATH),
      findingCategory: "plugin-runtime-capability-binding"
    });
  } finally {
    await pluginArtifactFixture?.close();
  }
  const capabilities = registry.entries
    .filter((entry) => entry?.capabilityId)
    .map((entry) => verifyCapability(entry, pluginRuntimeReduction));
  const findings = [
    ...registryFindings,
    ...capabilities.flatMap((capability) => capability.findings || [])
  ];
  const duplicateMachineIds = capabilities
    .map((capability) => capability.machineId)
    .filter((machineId, index, list) => list.indexOf(machineId) !== index);
  for (const machineId of duplicateMachineIds) {
    findings.push({
      capabilityId: "",
      code: "duplicate-machine-id",
      message: `Duplicate acceptance machine id ${machineId}`,
      path: ""
    });
  }
  const releaseRequiredCapabilities = capabilities.filter((capability) =>
    capability.releaseScope === "core-release"
  );
  const optionalSupportMatrixCapabilities = capabilities.filter((capability) =>
    capability.releaseScope === "optional-support-matrix"
  );
  const readyForReleaseReduction = findings.length === 0 &&
    capabilities.length === registry.entries.length &&
    releaseRequiredCapabilities.every((capability) => capability.readyForReleaseReduction === true);
  const currentStateCounts = capabilities.reduce((counts, capability) => {
    counts[capability.currentState] = (counts[capability.currentState] || 0) + 1;
    return counts;
  }, {});
  const openCheckpointCount = capabilities.reduce(
    (count, capability) => count + (capability.openCheckpoints?.length || 0),
    0
  );
  const uncheckedCriteriaCount = capabilities.reduce(
    (count, capability) => count + (capability.uncheckedCriteria?.length || 0),
    0
  );
  const blockers = reduceCapabilityBlockers(capabilities);
  const evidenceBindings = reduceCapabilityEvidenceBindings(releaseRequiredCapabilities);
  const optionalEvidenceBindings = reduceCapabilityEvidenceBindings(optionalSupportMatrixCapabilities);
  const blockedCapabilityCount = capabilities.filter((capability) => capability.blocked === true).length;
  const failedCapabilityCount = capabilities.filter((capability) => capability.currentState === "failed").length;
  const currentState = readyForReleaseReduction
    ? "verified"
    : findings.length === 0 && blockedCapabilityCount > 0 && failedCapabilityCount === 0
      ? "blocked"
      : "failed";
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    generatedAt,
    currentState,
    readyForReleaseReduction,
    blocked: currentState === "blocked",
    capabilities,
    blockers,
    evidenceBindings,
    optionalEvidenceBindings,
    pluginRuntimeOwnership: {
      sourceOfTruth: pluginRuntimeReduction.sourceOfTruth,
      pluginIds: pluginRuntimeReduction.pluginIds,
      unownedPluginIds: pluginRuntimeReduction.unownedPluginIds,
      affectedCapabilityIds: capabilities
        .filter((capability) => capability.pluginRuntimeBlockerCount > 0)
        .map((capability) => capability.capabilityId)
    },
    registry: {
      path: toPosixRelative(REGISTRY_PATH),
      entryCount: registry.entries.length
    },
    findings,
    summary: {
      readyForReleaseReduction,
      blocked: currentState === "blocked",
      reportLeakScan: false,
      capabilityCount: capabilities.length,
      releaseRequiredCapabilityCount: releaseRequiredCapabilities.length,
      optionalSupportMatrixCapabilityCount: optionalSupportMatrixCapabilities.length,
      readyForReleaseReductionCount: capabilities.filter((capability) => capability.readyForReleaseReduction === true).length,
      releaseRequiredReadyCount: releaseRequiredCapabilities
        .filter((capability) => capability.readyForReleaseReduction === true).length,
      releaseRequiredNotReadyCount: releaseRequiredCapabilities
        .filter((capability) => capability.readyForReleaseReduction !== true).length,
      optionalSupportMatrixNotReadyCount: optionalSupportMatrixCapabilities
        .filter((capability) => capability.readyForReleaseReduction !== true).length,
      blockedCapabilityCount,
      failedCapabilityCount,
      notReadyCapabilityCount: capabilities.filter((capability) => capability.readyForReleaseReduction !== true).length,
      currentStateCounts,
      openCheckpointCount,
      uncheckedCriteriaCount,
      blockerCount: blockers.length,
      evidenceBindingCount: evidenceBindings.length,
      optionalEvidenceBindingCount: optionalEvidenceBindings.length,
      externalBlockerCount: blockers.filter((blocker) => blocker.kind === "external-evidence").length,
      pluginRuntimeBlockerCount: blockers.filter((blocker) => blocker.kind === "local-implementation").length,
      pluginRuntimeAffectedPluginCount: new Set(
        blockers.flatMap((blocker) => blocker.kind === "local-implementation" ? blocker.pluginIds || [] : [])
      ).size,
      invalidCheckpointGraphFindingCount: findings.filter((finding) =>
        ["checkpoint-graph", "checkpoint-structure", "checkpoint-role"].includes(finding.findingCategory)
      ).length,
      failedCount: findings.length,
      acceptanceDefinitionCount: capabilities.filter((capability) => capability.definitionPath).length
    }
  };
  writeReport(finalizeCapabilityAcceptanceReport(report));
  if (!readyForReleaseReduction) {
    console.error(
      `[capability-acceptance] readyForReleaseReduction=false capabilities=${capabilities.length} ` +
      `failedCapabilities=${report.summary.failedCapabilityCount} blockedCapabilities=${report.summary.blockedCapabilityCount} ` +
      `openCheckpoints=${openCheckpointCount} ` +
      `uncheckedCriteria=${uncheckedCriteriaCount} findings=${findings.length} report=${toPosixRelative(REPORT_PATH)}`
    );
    for (const capability of capabilities.filter((item) => item.readyForReleaseReduction !== true)) {
      console.error(
        `- ${capability.capabilityId}: currentState=${capability.currentState} ` +
        `openCheckpoints=${capability.openCheckpoints.length} ` +
        `uncheckedCriteria=${capability.uncheckedCriteria.length}`
      );
    }
    return report;
  }
  console.log(
    `[capability-acceptance] readyForReleaseReduction=true capabilities=${capabilities.length} ` +
    `report=${toPosixRelative(REPORT_PATH)}`
  );
  return report;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const report = await runCapabilityAcceptanceVerifier();
  process.exitCode = capabilityAcceptanceExitCode(report);
}
