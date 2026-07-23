#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ORGANIZATION_AUDIT_POLICY
} from "../registry/architecture-layout-facade.mjs";
import { assertNoLeak } from "./lib/report-evidence-safety.mjs";
import { analyzeSourceOrganization } from "./lib/repo-organization-ast-advisory.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "repo-organization.json");
const ignoredPathParts = REPO_ORGANIZATION_AUDIT_POLICY.ignoredPathParts;
const requiredFiles = REPO_ORGANIZATION_AUDIT_POLICY.requiredFiles;
const sourceFileOrganizationPolicy = REPO_ORGANIZATION_AUDIT_POLICY.sourceFileOrganization;
const runnableEntrypointPolicy = REPO_ORGANIZATION_AUDIT_POLICY.runnableEntrypointOwnership;
const currentResiduePolicy = REPO_ORGANIZATION_AUDIT_POLICY.currentResidue;

function toPosix(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function walkReferenceFiles(relativeRoot) {
  const entries = await fs.readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relativePath = toPosix(path.join(relativeRoot, entry.name));
    if (ignoredPathParts.some((part) => `/${relativePath}/`.includes(part))) continue;
    if (entry.isDirectory()) {
      files.push(...await walkReferenceFiles(relativePath));
    } else if (/\.(?:cjs|js|mjs|sh|ts|tsx|vue|ya?ml)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

async function walkModuleManifests(relativeRoot) {
  const entries = await fs.readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relativePath = toPosix(path.join(relativeRoot, entry.name));
    if (ignoredPathParts.some((part) => `/${relativePath}/`.includes(part))) continue;
    if (entry.isDirectory()) {
      files.push(...await walkModuleManifests(relativePath));
    } else if (entry.name === "module.json" || entry.name === "manifest.module.json") {
      files.push(relativePath);
    }
  }
  return files;
}

async function collectRunnableEntrypoints() {
  const entrypoints = [];
  const extensions = new Set(runnableEntrypointPolicy.extensions);
  for (const root of runnableEntrypointPolicy.roots) {
    const entries = await fs.readdir(path.join(repoRoot, root.path), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
      entrypoints.push({
        file: toPosix(path.join(root.path, entry.name)),
        owner: root.owner,
        ownedBy: new Set()
      });
    }
  }
  return entrypoints.sort((left, right) => left.file.localeCompare(right.file));
}

function packageScriptTargets(packageJson, entrypoints) {
  const targetsByScript = new Map();
  for (const [scriptName, command] of Object.entries(packageJson.scripts || {})) {
    const targets = entrypoints
      .filter((entrypoint) => String(command || "").includes(entrypoint.file))
      .map((entrypoint) => entrypoint.file);
    targetsByScript.set(scriptName, targets);
    for (const target of targets) {
      entrypoints.find((entrypoint) => entrypoint.file === target)?.ownedBy.add(`npm:${scriptName}`);
    }
  }
  for (const [binName, target] of Object.entries(packageJson.bin || {})) {
    entrypoints.find((entrypoint) => entrypoint.file === toPosix(target))?.ownedBy.add(`bin:${binName}`);
  }
  return targetsByScript;
}

function propagateNpmOwners(source, ownerPrefix, targetsByScript, entrypoints) {
  for (const match of String(source || "").matchAll(/\bnpm\s+run\s+([a-zA-Z0-9:_-]+)/gu)) {
    for (const target of targetsByScript.get(match[1]) || []) {
      entrypoints.find((entrypoint) => entrypoint.file === target)?.ownedBy.add(`${ownerPrefix}:npm:${match[1]}`);
    }
  }
}

function relativeImportTargets(source, sourceFile) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu
  ];
  for (const pattern of patterns) {
    for (const match of String(source || "").matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers].map((specifier) => toPosix(path.relative(
    repoRoot,
    path.resolve(repoRoot, path.dirname(sourceFile), specifier)
  )));
}

function executableSourceText(source) {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

const sourceEntrypointPatternCache = new Map();

function sourceOwnsEntrypoint(executableSource, entrypointFile) {
  if (executableSource.includes(entrypointFile)) return true;
  let constructedPathOrCommand = sourceEntrypointPatternCache.get(entrypointFile);
  if (!constructedPathOrCommand) {
    const baseName = escapeRegex(path.basename(entrypointFile));
    constructedPathOrCommand = new RegExp(
      `(?:path\\.(?:join|resolve)\\([^\\n;]*|\\b(?:command|entrypoint|file|script)\\s*:\\s*)["']${baseName}["']`,
      "u"
    );
    sourceEntrypointPatternCache.set(entrypointFile, constructedPathOrCommand);
  }
  return constructedPathOrCommand.test(executableSource);
}

async function collectRunnableEntrypointOwnership() {
  const entrypoints = await collectRunnableEntrypoints();
  const byFile = new Map(entrypoints.map((entrypoint) => [entrypoint.file, entrypoint]));
  const packageJson = await readJson(runnableEntrypointPolicy.packageManifestPath);
  const targetsByScript = packageScriptTargets(packageJson, entrypoints);

  const workflowFiles = await walkReferenceFiles(runnableEntrypointPolicy.workflowRoot);
  for (const workflowFile of workflowFiles) {
    const source = await fs.readFile(path.join(repoRoot, workflowFile), "utf8");
    for (const entrypoint of entrypoints) {
      if (source.includes(entrypoint.file)) entrypoint.ownedBy.add(`workflow:${workflowFile}`);
    }
    propagateNpmOwners(source, `workflow:${workflowFile}`, targetsByScript, entrypoints);
  }

  const testRegistry = await readJson(runnableEntrypointPolicy.testRegistryPath);
  for (const suite of testRegistry.suites || []) {
    const command = [suite.command, ...(suite.args || [])].join(" ");
    for (const entrypoint of entrypoints) {
      if (command.includes(entrypoint.file)) entrypoint.ownedBy.add(`test-suite:${suite.id}`);
    }
    propagateNpmOwners(command, `test-suite:${suite.id}`, targetsByScript, entrypoints);
  }

  const referenceFiles = (await Promise.all(
    runnableEntrypointPolicy.sourceReferenceRoots.map(walkReferenceFiles)
  )).flat();
  for (const sourceFile of referenceFiles) {
    const source = await fs.readFile(path.join(repoRoot, sourceFile), "utf8").catch(() => "");
    const executableSource = executableSourceText(source);
    for (const entrypoint of entrypoints) {
      if (sourceFile !== entrypoint.file && sourceOwnsEntrypoint(executableSource, entrypoint.file)) {
        entrypoint.ownedBy.add(`source:${sourceFile}`);
      }
    }
    for (const target of relativeImportTargets(source, sourceFile)) {
      byFile.get(target)?.ownedBy.add(`import:${sourceFile}`);
    }
  }

  const moduleManifestFiles = (await Promise.all(
    runnableEntrypointPolicy.sourceReferenceRoots.map(walkModuleManifests)
  )).flat();
  for (const manifestFile of moduleManifestFiles) {
    const source = await fs.readFile(path.join(repoRoot, manifestFile), "utf8").catch(() => "");
    for (const entrypoint of entrypoints) {
      if (source.includes(entrypoint.file)) entrypoint.ownedBy.add(`module-manifest:${manifestFile}`);
    }
  }

  return entrypoints.map((entrypoint) => ({
    file: entrypoint.file,
    owner: entrypoint.owner,
    ownedBy: [...entrypoint.ownedBy].sort()
  }));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourceFileOrganizationPolicyReport(policy = {}) {
  return {
    sourceOfTruth: "tools/registry/repo-layout.registry.json#repoOrganizationAudit.sourceFileOrganization",
    canonicalDocument: policy.canonicalDocument,
    lineCountGate: {
      status: policy.lineCountGate.status,
      threshold: policy.lineCountGate.threshold,
      releaseBlocking: policy.lineCountGate.releaseBlocking,
      statement: "No numeric source-file line-count ceiling is used as an acceptance criterion."
    },
    decisionBasis: [...policy.decisionBasis],
    machineEnforcedRules: policy.machineEnforcedRuleIds.map((id) => ({ id, releaseBlocking: true })),
    delegatedGateIds: [...policy.delegatedGateIds],
    reviewOnlySignals: policy.reviewOnlySignalIds.map((id) => ({
      id,
      collectedByThisReport: false,
      releaseBlocking: false
    })),
    astAdvisory: {
      mode: "advisory",
      releaseBlocking: policy.astAdvisory.releaseBlocking,
      statement: "AST analysis identifies review candidates and mechanical-split cautions; it cannot prove that a file must or cannot be split."
    }
  };
}

function verifySourceFileOrganizationPolicy(policy = {}) {
  assert.equal(policy.lineCountGate.status, "disabled", "source file line-count gate must remain disabled");
  assert.equal(policy.lineCountGate.threshold, null, "source file line-count gate must not define a threshold");
  assert.equal(policy.lineCountGate.releaseBlocking, false, "source file line-count gate must remain non-blocking");
  assert.equal(policy.astAdvisory.releaseBlocking, false, "source organization AST analysis must remain advisory");
  assert.ok(policy.canonicalDocument, "source file organization policy must cite its canonical document");
  return true;
}

function collectCurrentResidueFindings({ testFiles = [], operationDefinitionFiles = [] } = {}) {
  const stageMarkerPattern = new RegExp(
    `(?:^|[-_.])(?:${currentResiduePolicy.testStageMarkers.map(escapeRegex).join("|")})(?=[-_.]|$)`,
    "u"
  );
  const numericOperationDefinitionPattern = /operation-definitions(?:[-_.](?:part|chunk|segment))?[-_.]?\d+(?=[-_.]|$)/u;
  const residue = [];
  for (const file of testFiles) {
    if (!stageMarkerPattern.test(path.basename(file).toLowerCase())) continue;
    residue.push({
      severity: "error",
      code: "test_filename_uses_stage_marker",
      file,
      message: "Test filenames must describe the current behavior boundary rather than an implementation stage."
    });
  }
  for (const file of operationDefinitionFiles) {
    if (!numericOperationDefinitionPattern.test(path.basename(file).toLowerCase())) continue;
    residue.push({
      severity: "error",
      code: "operation_definition_uses_numeric_partition",
      file,
      message: "Operation definition files must be partitioned by semantic ownership rather than a numeric shard."
    });
  }
  return residue;
}

function verifyCurrentResidueContract() {
  assert.deepEqual(
    collectCurrentResidueFindings({
      testFiles: ["tests/vitest/server/current-runtime-behavior.test.mjs"],
      operationDefinitionFiles: ["packages/contracts/src/operations/runtime-operation-definitions.mjs"]
    }),
    [],
    "current residue policy must accept semantic current-boundary names"
  );
  const negative = collectCurrentResidueFindings({
    testFiles: currentResiduePolicy.testStageMarkers
      .map((marker) => `tests/vitest/server/runtime-${marker}.test.mjs`),
    operationDefinitionFiles: ["packages/contracts/src/operations/runtime-operation-definitions-7.mjs"]
  });
  assert.deepEqual(
    negative.map((finding) => finding.code).sort(),
    [
      "operation_definition_uses_numeric_partition",
      ...currentResiduePolicy.testStageMarkers.map(() => "test_filename_uses_stage_marker")
    ].sort(),
    "current residue policy must reject stage-named tests and numeric operation definition shards"
  );
  return {
    passed: true,
    positiveCaseCount: 2,
    negativeCaseCount: currentResiduePolicy.testStageMarkers.length + 1
  };
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const findings = [];

const missingRequiredFiles = [];
for (const relativePath of requiredFiles) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
  } catch {
    missingRequiredFiles.push(relativePath);
  }
}

const currentResidueSelfTest = verifyCurrentResidueContract();
const policyContractVerified = verifySourceFileOrganizationPolicy(sourceFileOrganizationPolicy);
const factSourceAuthorityRegistry = await readJson(sourceFileOrganizationPolicy.astAdvisory.factSourceAuthorityPath);
const sourceProjectionPaths = [...new Set((factSourceAuthorityRegistry.authorities || [])
  .flatMap((authority) => authority.projectionPaths || []))];
const sourceOrganizationAnalysis = await analyzeSourceOrganization({
  repoRoot,
  analysisRoots: sourceFileOrganizationPolicy.astAdvisory.analysisRoots,
  extensions: sourceFileOrganizationPolicy.astAdvisory.extensions,
  ignoredPathParts,
  excludedPaths: sourceProjectionPaths
});
assert.equal(
  sourceOrganizationAnalysis.summary.discoveredFileCount,
  sourceOrganizationAnalysis.summary.analyzedFileCount +
    sourceOrganizationAnalysis.summary.unsupportedFileCount +
    sourceOrganizationAnalysis.summary.parseFailureCount,
  "source organization advisory coverage must account for every discovered source file"
);
const testFiles = (await Promise.all(currentResiduePolicy.testRoots.map(walkReferenceFiles)))
  .flat()
  .filter((file) => /\.(?:cjs|js|mjs|ts|tsx)$/u.test(file));
const operationDefinitionFiles = (await Promise.all(currentResiduePolicy.operationDefinitionRoots.map(walkReferenceFiles)))
  .flat()
  .filter((file) => /operation-definitions.*\.(?:cjs|js|mjs|ts)$/u.test(path.basename(file)));
const currentResidueFindings = collectCurrentResidueFindings({ testFiles, operationDefinitionFiles });
findings.push(...currentResidueFindings);

const runnableEntrypoints = await collectRunnableEntrypointOwnership();
for (const entrypoint of runnableEntrypoints) {
  if (entrypoint.ownedBy.length > 0) continue;
  findings.push({
    severity: "error",
    code: "runnable_entrypoint_without_current_owner",
    file: entrypoint.file,
    owner: entrypoint.owner,
    message: "Top-level runnable source must be owned by a current npm/bin command, workflow, test suite, source command, or import."
  });
}

const runnableEntrypointResidueCount = runnableEntrypoints.filter((entrypoint) => entrypoint.ownedBy.length === 0).length;
const testStageResidueCount = currentResidueFindings.filter((finding) => finding.code === "test_filename_uses_stage_marker").length;
const numericOperationDefinitionResidueCount = currentResidueFindings.filter((finding) => finding.code === "operation_definition_uses_numeric_partition").length;
const architectureResidueFindingCount = runnableEntrypointResidueCount + currentResidueFindings.length;

const warningCount = findings.filter((finding) => finding.severity === "warning").length;
const releaseBlockingWarningCount = findings.filter((finding) =>
  finding.severity === "warning" && finding.releaseBlocking === true
).length;
const errorCount = findings.filter((finding) => finding.severity === "error").length + missingRequiredFiles.length;
const releaseBlockingSourceFindingCount = findings.filter((finding) =>
  finding.severity === "error" || finding.releaseBlocking === true
).length;
const releaseBlockingFindingCount = releaseBlockingSourceFindingCount + missingRequiredFiles.length;
const policy = sourceFileOrganizationPolicyReport(sourceFileOrganizationPolicy);
const report = {
  schemaVersion: "v0.0.1:repository:organization-report-4",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-repo-organization.mjs",
  summary: {
    releaseReady: releaseBlockingFindingCount === 0,
    reportLeakScan: false,
    policyContractVerified,
    lineCountGateStatus: policy.lineCountGate.status,
    machineEnforcedRuleCount: policy.machineEnforcedRules.length,
    reviewOnlySignalCount: policy.reviewOnlySignals.length,
    sourceOrganizationDiscoveredFileCount: sourceOrganizationAnalysis.summary.discoveredFileCount,
    sourceOrganizationAnalyzedFileCount: sourceOrganizationAnalysis.summary.analyzedFileCount,
    sourceOrganizationUnsupportedFileCount: sourceOrganizationAnalysis.summary.unsupportedFileCount,
    sourceOrganizationParseFailureCount: sourceOrganizationAnalysis.summary.parseFailureCount,
    sourceOrganizationSplitCandidateCount: sourceOrganizationAnalysis.summary.splitCandidateCount,
    sourceOrganizationMechanicalSplitCautionCount: sourceOrganizationAnalysis.summary.mechanicalSplitCautionCount,
    findingCount: findings.length,
    advisoryFindingCount: findings.length - releaseBlockingSourceFindingCount,
    releaseBlockingFindingCount,
    errorCount,
    warningCount,
    advisoryWarningCount: warningCount - releaseBlockingWarningCount,
    releaseBlockingWarningCount,
    missingRequiredFileCount: missingRequiredFiles.length,
    runnableEntrypointCount: runnableEntrypoints.length,
    ownedRunnableEntrypointCount: runnableEntrypoints.length - runnableEntrypointResidueCount,
    architectureResidueFindingCount,
    testStageResidueCount,
    numericOperationDefinitionResidueCount
  },
  missingRequiredFiles,
  policy,
  sourceOrganizationAnalysis,
  currentResidueSelfTest,
  runnableEntrypoints,
  findings
};

assert.equal(JSON.stringify(report).includes(repoRoot), false, "repo organization report leaked repo path");
assertNoLeak(report, "repo organization report");
report.summary.reportLeakScan = true;
assertNoLeak(report, "repo organization report");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `[repo-organization] source-file-policy lineCountGate=${policy.lineCountGate.status}` +
  ` astMode=${sourceOrganizationAnalysis.mode}` +
  ` candidates=${sourceOrganizationAnalysis.summary.splitCandidateCount}` +
  ` cautions=${sourceOrganizationAnalysis.summary.mechanicalSplitCautionCount}`
);
if (errorCount > 0) {
  console.error(`[repo-organization] failed blockingFindings=${errorCount}`);
  process.exitCode = 1;
} else {
  console.log("[repo-organization] ok");
}
