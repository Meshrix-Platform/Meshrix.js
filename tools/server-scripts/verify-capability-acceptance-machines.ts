#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyMachineDefinition } from "../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.ts";
import { loadPluginRegistry } from "../../packages/foundation/src/module-system/plugin-registry.ts";
import { resolveFeatureRuntime } from "../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.ts";
import { reduceCapabilityCheckpoints } from "./capability-acceptance-checkpoint-reducer.ts";
import { assertNoLeak } from "./lib/report-evidence-safety.ts";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./verify-platform-acceptance.ts";
import {
  applyPluginRuntimeCapabilityFailures,
  collectPluginRuntimeOwnershipFailures,
  reducePluginRuntimeCapabilityBindings
} from "./lib/plugin-runtime-capability-bindings.ts";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const CHECKPOINT_ROOT: any = path.join(ROOT, "tools/registry/capability-acceptance-checkpoints");
const REGISTRY_PATH: any = path.join(ROOT, "tools/registry/capability-acceptance.registry.json");
const DEFINITION_ROOT: any = path.join(
  ROOT,
  "packages/foundation/src/workflow/state-machine/definitions/acceptance"
);
const REPORT_PATH: any = path.join(ROOT, "build/reports/capability-acceptance-machines.json");
const REPORT_SCHEMA_VERSION: any = "v0.0.1:acceptance:capability-machines-report-7";
const VERIFIER: any = "tools/server-scripts/verify-capability-acceptance-machines.ts";
const LEGAL_BLOCKER_KINDS: any = new Set<any>(["external-evidence"]);
const LEGAL_RELEASE_SCOPES: any = new Set<any>(["core-release", "optional-support-matrix"]);
const LEGAL_CAPABILITY_CLASSES: any = new Set<any>(["core", "detachable-core", "external-plugin"]);

export const CAPABILITY_EVIDENCE_COMMAND_AUTHORITY: any = new Map<any, any>(
  PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => [command.id, Object.freeze({
    acceptanceCommandId: command.id,
    ownedReports: Object.freeze([...(command.ownedReports || [])])
  })])
);

function toPosixRelative(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath?: any) : any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function capabilityIds() : any {
  return fs.readdirSync(CHECKPOINT_ROOT)
    .filter((name?: any) : any => name.endsWith(".json"))
    .map((name?: any) : any => path.join(CHECKPOINT_ROOT, name))
    .filter((entry?: any) : any => fs.statSync(entry).isFile())
    .map((entry?: any) : any => path.basename(entry, ".json"))
    .sort();
}

function loadAcceptanceRegistry() : any {
  const registry: any = readJson(REGISTRY_PATH);
  if (!Array.isArray(registry.entries)) {
    throw new Error("Capability acceptance registry entries must be an array.");
  }
  return registry;
}

function addFinding(findings?: any, capabilityId?: any, code?: any, message?: any, filePath: any = "", details: Record<string, any> = {}) : any {
  findings.push({
    capabilityId,
    code,
    message,
    path: filePath ? toPosixRelative(filePath) : "",
    ...details
  });
}

function verifyCapability(entry?: any, pluginRuntimeReduction?: any, activeFeatureIds?: any) : any {
  const findings: any[] = [];
  const capabilityId: any = entry.capabilityId;
  const releaseScope: any = String(entry.releaseScope || "").trim();
  const capabilityClass: any = String(entry.capabilityClass || "").trim();
  const activationFeatureId: any = String(entry.activationFeatureId || "").trim();
  const governedEvidenceCommandIds: any = Array.isArray(entry.governedEvidenceCommandIds)
    ? [...new Set<any>(entry.governedEvidenceCommandIds.map((value?: any) : any => String(value || "").trim()).filter(Boolean))]
    : [];
  const enabled: any = capabilityClass === "core" ||
    (capabilityClass === "detachable-core" && activeFeatureIds.has(activationFeatureId));
  const effectiveReleaseScope: any = enabled && capabilityClass !== "external-plugin"
    ? "core-release"
    : "optional-support-matrix";
  const machineId: any = `acceptance.${capabilityId}`;
  const checkpointPath: any = path.join(CHECKPOINT_ROOT, `${capabilityId}.json`);
  const definitionPath: any = path.join(DEFINITION_ROOT, `${capabilityId}.json`);

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
  if (!LEGAL_CAPABILITY_CLASSES.has(capabilityClass)) {
    addFinding(findings, capabilityId, "registry-capability-class-invalid", "Registry capabilityClass must be core, detachable-core, or external-plugin.", REGISTRY_PATH);
  } else if (capabilityClass === "core" && (releaseScope !== "core-release" || activationFeatureId)) {
    addFinding(findings, capabilityId, "registry-core-capability-boundary-invalid", "Core capabilities must be release required and must not declare a detachable activation feature.", REGISTRY_PATH);
  } else if (capabilityClass === "detachable-core" && (releaseScope !== "optional-support-matrix" || !activationFeatureId)) {
    addFinding(findings, capabilityId, "registry-detachable-capability-boundary-invalid", "Detachable Core capabilities must declare an activation feature and an optional default release scope.", REGISTRY_PATH);
  } else if (capabilityClass === "external-plugin" && releaseScope !== "optional-support-matrix") {
    addFinding(findings, capabilityId, "registry-external-plugin-boundary-invalid", "External plugin capabilities cannot be Core release requirements while unselected.", REGISTRY_PATH);
  }
  if (capabilityClass === "detachable-core" && governedEvidenceCommandIds.length === 0) {
    addFinding(findings, capabilityId, "registry-detachable-governance-evidence-missing", "Detachable Core capabilities must declare governed evidence commands.", REGISTRY_PATH);
  }
  for (const commandId of governedEvidenceCommandIds) {
    if (!CAPABILITY_EVIDENCE_COMMAND_AUTHORITY.has(commandId)) {
      addFinding(findings, capabilityId, "registry-governance-evidence-command-unknown", "A governed evidence command is not owned by the platform acceptance catalog.", REGISTRY_PATH, { acceptanceCommandId: commandId });
    }
  }

  let checkpoints: any = null;
  try {
    checkpoints = readJson(checkpointPath);
  } catch (error: any) {
    addFinding(
      findings,
      capabilityId,
      "checkpoints-unreadable",
      `Capability checkpoints are unreadable: ${error?.code || "read-failed"}.`,
      checkpointPath
    );
  }
  const checkpointReduction: any = applyPluginRuntimeCapabilityFailures(
    reduceCapabilityCheckpoints(checkpoints, {
      evidenceCommandAuthority: CAPABILITY_EVIDENCE_COMMAND_AUTHORITY
    }),
    checkpoints,
    pluginRuntimeReduction.blockersByCapability[capabilityId] || []
  );
  if (checkpointReduction.blocked === true && !(checkpointReduction.blockers || []).every((blocker?: any) : any =>
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
  for (const checkpointFinding of enabled ? checkpointReduction.findings : []) {
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
  if (enabled && capabilityClass === "detachable-core") {
    const boundCommandIds: any = new Set<any>((checkpointReduction.evidenceBindings || [])
      .map((binding?: any) : any => String(binding.acceptanceCommandId || "").trim()));
    for (const commandId of governedEvidenceCommandIds) {
      if (!boundCommandIds.has(commandId)) {
        addFinding(findings, capabilityId, "enabled-detachable-governance-evidence-unbound", "An enabled detachable Core capability must bind every declared governed evidence command.", checkpointPath, { acceptanceCommandId: commandId });
      }
    }
  }
  const boundCommandIds: any = new Set<any>((checkpointReduction.evidenceBindings || [])
    .map((binding?: any) : any => String(binding.acceptanceCommandId || "").trim()));
  const governedEvidenceBindingCount: any = governedEvidenceCommandIds
    .filter((commandId?: any) : any => boundCommandIds.has(commandId)).length;

  let machineReport: Record<string, any> = {};
  let definition: Record<string, any> = {};
  if (!fs.existsSync(definitionPath)) {
    addFinding(findings, capabilityId, "definition-missing", `Missing acceptance definition for ${machineId}`, definitionPath);
  } else {
    try {
      definition = readJson(definitionPath);
      machineReport = verifyMachineDefinition(definition, {
        throwOnError: false,
        relativePath: toPosixRelative(definitionPath)
      });
    } catch (error: any) {
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
  const readyForReleaseReduction: any = checkpointReduction.readyForReleaseReduction === true &&
    findings.length === 0 &&
    enabled;
  const blocked: any = !readyForReleaseReduction &&
    findings.length === 0 &&
    checkpointReduction.blocked === true;
  const reasons: any[] = [...new Set<any>([
    ...checkpointReduction.reasons,
    ...findings.map((finding?: any) : any => finding.code)
  ])];

  return {
    capabilityId,
    capabilityClass,
    enabled,
    activationFeatureId,
    governedEvidenceCommandIds,
    functionalEvidenceBindingCount: enabled ? (checkpointReduction.evidenceBindings || []).length : 0,
    governedEvidenceBindingCount: enabled ? governedEvidenceBindingCount : 0,
    governedEvidenceComplete: enabled && capabilityClass === "detachable-core"
      ? governedEvidenceBindingCount === governedEvidenceCommandIds.length
      : null,
    declaredReleaseScope: releaseScope,
    releaseScope: effectiveReleaseScope,
    machineId,
    definitionPath: toPosixRelative(definitionPath),
    checkpointPath: toPosixRelative(checkpointPath),
    currentState: !enabled && findings.length === 0 ? "disabled" : readyForReleaseReduction ? "verified" : blocked ? "blocked" : "failed",
    readyForReleaseReduction,
    blocked: enabled && blocked,
    failureKind: findings.length > 0 && !checkpointReduction.failureKind
      ? "capability-definition-invalid"
      : checkpointReduction.failureKind,
    checkpointReductionSourceOfTruth: checkpointReduction.sourceOfTruth,
    pluginRuntimeReductionSourceOfTruth: checkpointReduction.pluginRuntimeReductionSourceOfTruth || "",
    pluginRuntimeBlockerCount: enabled ? Number(checkpointReduction.pluginRuntimeBlockerCount || 0) : 0,
    checkpointCount: checkpointReduction.checkpointCount,
    completedCheckpointCount: checkpointReduction.completedCheckpointCount,
    openCheckpoints: checkpointReduction.openCheckpoints,
    uncheckedCriteria: checkpointReduction.uncheckedCriteria,
    blockers: enabled ? checkpointReduction.blockers : [],
    evidenceBindings: enabled ? checkpointReduction.evidenceBindings || [] : [],
    reasons,
    machineCompletenessLevel: machineReport.completenessLevel || "",
    stateCount: machineReport.stateCount || 0,
    eventCount: machineReport.eventCount || 0,
    matrixCellCount: machineReport.matrixCellCount || 0,
    findings
  };
}

function writeReport(report?: any) : any {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function finalizeCapabilityAcceptanceReport(report?: any, scan: any = assertNoLeak) : any {
  if (!report?.summary || typeof report.summary !== "object") {
    throw new TypeError("Capability acceptance report summary is required.");
  }
  report.summary.reportLeakScan = false;
  scan(report, "capability acceptance machines report");
  report.summary.reportLeakScan = true;
  scan(report, "capability acceptance machines report");
  return report;
}

export function reduceCapabilityBlockers(capabilities: any = []) : any {
  const blockersByKey: any = new Map<any, any>();
  for (const capability of capabilities) {
    for (const blocker of capability.blockers || []) {
      const key: any = `${capability.capabilityId}:${blocker.code}`;
      const checkpointRefs: any = Array.isArray(blocker.checkpointRefs)
        ? blocker.checkpointRefs.map((ref?: any) : any => ({
            checkpointId: ref.checkpointId,
            role: ref.role,
            criterionIndex: ref.criterionIndex
          }))
        : [{
            checkpointId: blocker.checkpointId,
            role: blocker.role,
            criterionIndex: blocker.criterionIndex
          }];
      const existing: any = blockersByKey.get(key);
      if (existing) {
        for (const checkpointRef of checkpointRefs) {
          if (!existing.checkpointRefs.some((ref?: any) : any =>
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

export function reduceCapabilityEvidenceBindings(capabilities: any = []) : any {
  const bindings: any = new Map<any, any>();
  for (const capability of capabilities) {
    for (const binding of capability.evidenceBindings || []) {
      const normalized: Record<string, any> = {
        capabilityId: capability.capabilityId,
        acceptanceCommandId: String(binding.acceptanceCommandId || "").trim(),
        report: String(binding.report || "").trim(),
        checkpointId: String(binding.checkpointId || "").trim(),
        role: String(binding.role || "").trim(),
        criterionIndex: Number.isInteger(binding.criterionIndex) ? binding.criterionIndex : null,
        evidenceIndex: Number.isInteger(binding.evidenceIndex) ? binding.evidenceIndex : null
      };
      const key: any = JSON.stringify(normalized);
      if (!bindings.has(key)) bindings.set(key, normalized);
    }
  }
  return [...bindings.values()];
}

export function capabilityAcceptanceExitCode(report: Record<string, any> = {}) : any {
  if (report.readyForReleaseReduction === true && report.currentState === "verified") {
    return 0;
  }
  const blockers: any = Array.isArray(report.blockers) ? report.blockers : [];
  const legallyBlocked: any = report.currentState === "blocked" &&
    report.blocked === true &&
    Array.isArray(report.findings) && report.findings.length === 0 &&
    Number(report.summary?.failedCapabilityCount || 0) === 0 &&
    blockers.length > 0 &&
    blockers.every((blocker?: any) : any => LEGAL_BLOCKER_KINDS.has(String(blocker?.kind || "").trim()));
  return legallyBlocked ? 2 : 1;
}

export async function runCapabilityAcceptanceVerifier() : Promise<any> {
  const generatedAt: any = new Date().toISOString();
  const registry: any = loadAcceptanceRegistry();
  const activeFeatureIds: any = new Set<any>(resolveFeatureRuntime({
    edition: "core",
    now: new Date("2026-07-01T00:00:00.000Z")
  }).activeFeatureIds);
  const idsFromCheckpointAuthorities: any = new Set<any>(capabilityIds());
  const idsFromRegistry: any = new Set<any>();
  const registryFindings: any[] = [];
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
  let pluginRuntimeReduction: Record<string, any> = {
    sourceOfTruth: "",
    pluginIds: [],
    unownedPluginIds: [],
    blockersByCapability: {},
    findings: []
  };
  let pluginArtifactFixture: any = null;
  try {
    pluginArtifactFixture = await stagePluginArtifactVerificationFixture({ sourcePluginRoot: path.join(ROOT, "plugins") });
    const pluginRegistry: any = await loadPluginRegistry({ artifactAuthority: pluginArtifactFixture.authority });
    const pluginIds: any = pluginRegistry.listPlugins().map((plugin?: any) : any => plugin.id);
    const pluginOwnershipFailures: any = await collectPluginRuntimeOwnershipFailures(pluginRegistry, { repoRoot: ROOT });
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
  const capabilities: any = registry.entries
    .filter((entry?: any) : any => entry?.capabilityId)
    .map((entry?: any) : any => verifyCapability(entry, pluginRuntimeReduction, activeFeatureIds));
  const findings: any[] = [
    ...registryFindings,
    ...capabilities.flatMap((capability?: any) : any => capability.findings || [])
  ];
  const duplicateMachineIds: any = capabilities
    .map((capability?: any) : any => capability.machineId)
    .filter((machineId?: any, index?: any, list?: any) : any => list.indexOf(machineId) !== index);
  for (const machineId of duplicateMachineIds) {
    findings.push({
      capabilityId: "",
      code: "duplicate-machine-id",
      message: `Duplicate acceptance machine id ${machineId}`,
      path: ""
    });
  }
  const releaseRequiredCapabilities: any = capabilities.filter((capability?: any) : any =>
    capability.releaseScope === "core-release"
  );
  const optionalSupportMatrixCapabilities: any = capabilities.filter((capability?: any) : any =>
    capability.releaseScope === "optional-support-matrix"
  );
  const readyForReleaseReduction: any = findings.length === 0 &&
    capabilities.length === registry.entries.length &&
    releaseRequiredCapabilities.every((capability?: any) : any => capability.readyForReleaseReduction === true);
  const currentStateCounts: any = capabilities.reduce((counts?: any, capability?: any) : any => {
    counts[capability.currentState] = (counts[capability.currentState] || 0) + 1;
    return counts;
  }, {});
  const openCheckpointCount: any = capabilities.reduce(
    (count?: any, capability?: any) : any => count + (capability.openCheckpoints?.length || 0),
    0
  );
  const uncheckedCriteriaCount: any = capabilities.reduce(
    (count?: any, capability?: any) : any => count + (capability.uncheckedCriteria?.length || 0),
    0
  );
  const blockers: any = reduceCapabilityBlockers(capabilities);
  const evidenceBindings: any = reduceCapabilityEvidenceBindings(releaseRequiredCapabilities);
  const optionalEvidenceBindings: any = reduceCapabilityEvidenceBindings(optionalSupportMatrixCapabilities);
  const blockedCapabilityCount: any = capabilities.filter((capability?: any) : any => capability.blocked === true).length;
  const failedCapabilityCount: any = capabilities.filter((capability?: any) : any => capability.currentState === "failed").length;
  const currentState: any = readyForReleaseReduction
    ? "verified"
    : findings.length === 0 && blockedCapabilityCount > 0 && failedCapabilityCount === 0
      ? "blocked"
      : "failed";
  const report: Record<string, any> = {
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
        .filter((capability?: any) : any => capability.pluginRuntimeBlockerCount > 0)
        .map((capability?: any) : any => capability.capabilityId)
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
      readyForReleaseReductionCount: capabilities.filter((capability?: any) : any => capability.readyForReleaseReduction === true).length,
      releaseRequiredReadyCount: releaseRequiredCapabilities
        .filter((capability?: any) : any => capability.readyForReleaseReduction === true).length,
      releaseRequiredNotReadyCount: releaseRequiredCapabilities
        .filter((capability?: any) : any => capability.readyForReleaseReduction !== true).length,
      optionalSupportMatrixNotReadyCount: optionalSupportMatrixCapabilities
        .filter((capability?: any) : any => capability.readyForReleaseReduction !== true).length,
      disabledCapabilityCount: capabilities.filter((capability?: any) : any => capability.currentState === "disabled").length,
      blockedCapabilityCount,
      failedCapabilityCount,
      notReadyCapabilityCount: capabilities.filter((capability?: any) : any => capability.readyForReleaseReduction !== true).length,
      currentStateCounts,
      openCheckpointCount,
      uncheckedCriteriaCount,
      blockerCount: blockers.length,
      evidenceBindingCount: evidenceBindings.length,
      optionalEvidenceBindingCount: optionalEvidenceBindings.length,
      externalBlockerCount: blockers.filter((blocker?: any) : any => blocker.kind === "external-evidence").length,
      pluginRuntimeBlockerCount: blockers.filter((blocker?: any) : any => blocker.kind === "local-implementation").length,
      pluginRuntimeAffectedPluginCount: new Set<any>(
        blockers.flatMap((blocker?: any) : any => blocker.kind === "local-implementation" ? blocker.pluginIds || [] : [])
      ).size,
      invalidCheckpointGraphFindingCount: findings.filter((finding?: any) : any =>
        ["checkpoint-graph", "checkpoint-structure", "checkpoint-role"].includes(finding.findingCategory)
      ).length,
      failedCount: findings.length,
      acceptanceDefinitionCount: capabilities.filter((capability?: any) : any => capability.definitionPath).length
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
    for (const capability of capabilities.filter((item?: any) : any => item.readyForReleaseReduction !== true)) {
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

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const report: any = await runCapabilityAcceptanceVerifier();
  process.exitCode = capabilityAcceptanceExitCode(report);
}
