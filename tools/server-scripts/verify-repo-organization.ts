#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ORGANIZATION_AUDIT_POLICY
} from "../registry/architecture-layout-facade.ts";
import { assertNoLeak } from "./lib/report-evidence-safety.ts";
import { analyzeSourceOrganization } from "./lib/repo-organization-ast-advisory.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "repo-organization.json");
const ignoredPathParts: any = REPO_ORGANIZATION_AUDIT_POLICY.ignoredPathParts;
const requiredFiles: any = REPO_ORGANIZATION_AUDIT_POLICY.requiredFiles;
const sourceFileOrganizationPolicy: any = REPO_ORGANIZATION_AUDIT_POLICY.sourceFileOrganization;
const runnableEntrypointPolicy: any = REPO_ORGANIZATION_AUDIT_POLICY.runnableEntrypointOwnership;
const currentResiduePolicy: any = REPO_ORGANIZATION_AUDIT_POLICY.currentResidue;

function toPosix(filePath?: any) : any {
  return String(filePath || "").split(path.sep).join("/");
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function walkReferenceFiles(relativeRoot?: any) : Promise<any> {
  const entries: any = await fs.readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }).catch(() : any => []);
  const files: any[] = [];
  for (const entry of entries) {
    const relativePath: any = toPosix(path.join(relativeRoot, entry.name));
    if (ignoredPathParts.some((part?: any) : any => `/${relativePath}/`.includes(part))) continue;
    if (entry.isDirectory()) {
      files.push(...await walkReferenceFiles(relativePath));
    } else if (/\.(?:cjs|js|mjs|sh|ts|tsx|vue|ya?ml)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

async function walkModuleManifests(relativeRoot?: any) : Promise<any> {
  const entries: any = await fs.readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }).catch(() : any => []);
  const files: any[] = [];
  for (const entry of entries) {
    const relativePath: any = toPosix(path.join(relativeRoot, entry.name));
    if (ignoredPathParts.some((part?: any) : any => `/${relativePath}/`.includes(part))) continue;
    if (entry.isDirectory()) {
      files.push(...await walkModuleManifests(relativePath));
    } else if (entry.name === "module.json" || entry.name === "manifest.module.json") {
      files.push(relativePath);
    }
  }
  return files;
}

async function collectRunnableEntrypoints() : Promise<any> {
  const entrypoints: any[] = [];
  const extensions: any = new Set<any>(runnableEntrypointPolicy.extensions);
  for (const root of runnableEntrypointPolicy.roots) {
    const entries: any = await fs.readdir(path.join(repoRoot, root.path), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
      entrypoints.push({
        file: toPosix(path.join(root.path, entry.name)),
        owner: root.owner,
        ownedBy: new Set<any>()
      });
    }
  }
  return entrypoints.sort((left?: any, right?: any) : any => left.file.localeCompare(right.file));
}

function packageScriptTargets(packageJson?: any, entrypoints?: any) : any {
  const targetsByScript: any = new Map<any, any>();
  for (const [scriptName, command] of (Object.entries(packageJson.scripts || {}) as [string, any][])) {
    const targets: any = entrypoints
      .filter((entrypoint?: any) : any => String(command || "").includes(entrypoint.file))
      .map((entrypoint?: any) : any => entrypoint.file);
    targetsByScript.set(scriptName, targets);
    for (const target of targets) {
      entrypoints.find((entrypoint?: any) : any => entrypoint.file === target)?.ownedBy.add(`npm:${scriptName}`);
    }
  }
  for (const [binName, target] of (Object.entries(packageJson.bin || {}) as [string, any][])) {
    entrypoints.find((entrypoint?: any) : any => entrypoint.file === toPosix(target))?.ownedBy.add(`bin:${binName}`);
  }
  return targetsByScript;
}

function propagateNpmOwners(source?: any, ownerPrefix?: any, targetsByScript?: any, entrypoints?: any) : any {
  for (const match of String(source || "").matchAll(/\bnpm\s+run\s+([a-zA-Z0-9:_-]+)/gu)) {
    for (const target of targetsByScript.get(match[1]) || []) {
      entrypoints.find((entrypoint?: any) : any => entrypoint.file === target)?.ownedBy.add(`${ownerPrefix}:npm:${match[1]}`);
    }
  }
}

function relativeImportTargets(source?: any, sourceFile?: any) : any {
  const specifiers: any = new Set<any>();
  const patterns: any[] = [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu
  ];
  for (const pattern of patterns) {
    for (const match of String(source || "").matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers].map((specifier?: any) : any => toPosix(path.relative(
    repoRoot,
    path.resolve(repoRoot, path.dirname(sourceFile), specifier)
  )));
}

function executableSourceText(source?: any) : any {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

const sourceEntrypointPatternCache: any = new Map<any, any>();

function sourceOwnsEntrypoint(executableSource?: any, entrypointFile?: any) : any {
  if (executableSource.includes(entrypointFile)) return true;
  let constructedPathOrCommand: any = sourceEntrypointPatternCache.get(entrypointFile);
  if (!constructedPathOrCommand) {
    const baseName: any = escapeRegex(path.basename(entrypointFile));
    constructedPathOrCommand = new RegExp(
      `(?:path\\.(?:join|resolve)\\([^\\n;]*|\\b(?:command|entrypoint|file|script)\\s*:\\s*)["']${baseName}["']`,
      "u"
    );
    sourceEntrypointPatternCache.set(entrypointFile, constructedPathOrCommand);
  }
  return constructedPathOrCommand.test(executableSource);
}

async function collectRunnableEntrypointOwnership() : Promise<any> {
  const entrypoints: any = await collectRunnableEntrypoints();
  const byFile: any = new Map<any, any>(entrypoints.map((entrypoint?: any) : any => [entrypoint.file, entrypoint]));
  const packageJson: any = await readJson(runnableEntrypointPolicy.packageManifestPath);
  const targetsByScript: any = packageScriptTargets(packageJson, entrypoints);

  const workflowFiles: any = await walkReferenceFiles(runnableEntrypointPolicy.workflowRoot);
  for (const workflowFile of workflowFiles) {
    const source: any = await fs.readFile(path.join(repoRoot, workflowFile), "utf8");
    for (const entrypoint of entrypoints) {
      if (source.includes(entrypoint.file)) entrypoint.ownedBy.add(`workflow:${workflowFile}`);
    }
    propagateNpmOwners(source, `workflow:${workflowFile}`, targetsByScript, entrypoints);
  }

  const testRegistry: any = await readJson(runnableEntrypointPolicy.testRegistryPath);
  for (const suite of testRegistry.suites || []) {
    const command: any = [suite.command, ...(suite.args || [])].join(" ");
    for (const entrypoint of entrypoints) {
      if (command.includes(entrypoint.file)) entrypoint.ownedBy.add(`test-suite:${suite.id}`);
    }
    propagateNpmOwners(command, `test-suite:${suite.id}`, targetsByScript, entrypoints);
  }

  const referenceFiles: any = (await Promise.all(
    runnableEntrypointPolicy.sourceReferenceRoots.map(walkReferenceFiles)
  )).flat();
  for (const sourceFile of referenceFiles) {
    const source: any = await fs.readFile(path.join(repoRoot, sourceFile), "utf8").catch(() : any => "");
    const executableSource: any = executableSourceText(source);
    for (const entrypoint of entrypoints) {
      if (sourceFile !== entrypoint.file && sourceOwnsEntrypoint(executableSource, entrypoint.file)) {
        entrypoint.ownedBy.add(`source:${sourceFile}`);
      }
    }
    for (const target of relativeImportTargets(source, sourceFile)) {
      byFile.get(target)?.ownedBy.add(`import:${sourceFile}`);
    }
  }

  const moduleManifestFiles: any = (await Promise.all(
    runnableEntrypointPolicy.sourceReferenceRoots.map(walkModuleManifests)
  )).flat();
  for (const manifestFile of moduleManifestFiles) {
    const source: any = await fs.readFile(path.join(repoRoot, manifestFile), "utf8").catch(() : any => "");
    for (const entrypoint of entrypoints) {
      if (source.includes(entrypoint.file)) entrypoint.ownedBy.add(`module-manifest:${manifestFile}`);
    }
  }

  return entrypoints.map((entrypoint?: any) : any => ({
    file: entrypoint.file,
    owner: entrypoint.owner,
    ownedBy: [...entrypoint.ownedBy].sort()
  }));
}

function escapeRegex(value?: any) : any {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourceFileOrganizationPolicyReport(policy: Record<string, any> = {}) : any {
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
    machineEnforcedRules: policy.machineEnforcedRuleIds.map((id?: any) : any => ({ id, releaseBlocking: true })),
    delegatedGateIds: [...policy.delegatedGateIds],
    reviewOnlySignals: policy.reviewOnlySignalIds.map((id?: any) : any => ({
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

function verifySourceFileOrganizationPolicy(policy: Record<string, any> = {}) : any {
  assert.equal(policy.lineCountGate.status, "disabled", "source file line-count gate must remain disabled");
  assert.equal(policy.lineCountGate.threshold, null, "source file line-count gate must not define a threshold");
  assert.equal(policy.lineCountGate.releaseBlocking, false, "source file line-count gate must remain non-blocking");
  assert.equal(policy.astAdvisory.releaseBlocking, false, "source organization AST analysis must remain advisory");
  assert.ok(policy.canonicalDocument, "source file organization policy must cite its canonical document");
  return true;
}

function collectCurrentResidueFindings({ testFiles = [], operationDefinitionFiles = [] }: Record<string, any> = {}) : any {
  const stageMarkerPattern: any = new RegExp(
    `(?:^|[-_.])(?:${currentResiduePolicy.testStageMarkers.map(escapeRegex).join("|")})(?=[-_.]|$)`,
    "u"
  );
  const numericOperationDefinitionPattern: any = /operation-definitions(?:[-_.](?:part|chunk|segment))?[-_.]?\d+(?=[-_.]|$)/u;
  const residue: any[] = [];
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

function verifyCurrentResidueContract() : any {
  assert.deepEqual(
    collectCurrentResidueFindings({
      testFiles: ["tests/vitest/server/current-runtime-behavior.test.ts"],
      operationDefinitionFiles: ["packages/contracts/src/operations/runtime-operation-definitions.ts"]
    }),
    [],
    "current residue policy must accept semantic current-boundary names"
  );
  const negative: any = collectCurrentResidueFindings({
    testFiles: currentResiduePolicy.testStageMarkers
      .map((marker?: any) : any => `tests/vitest/server/runtime-${marker}.test.ts`),
    operationDefinitionFiles: ["packages/contracts/src/operations/runtime-operation-definitions-7.ts"]
  });
  assert.deepEqual(
    negative.map((finding?: any) : any => finding.code).sort(),
    [
      "operation_definition_uses_numeric_partition",
      ...currentResiduePolicy.testStageMarkers.map(() : any => "test_filename_uses_stage_marker")
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
const findings: any[] = [];

const missingRequiredFiles: any[] = [];
for (const relativePath of requiredFiles) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
  } catch {
    missingRequiredFiles.push(relativePath);
  }
}

const currentResidueSelfTest: any = verifyCurrentResidueContract();
const policyContractVerified: any = verifySourceFileOrganizationPolicy(sourceFileOrganizationPolicy);
const factSourceAuthorityRegistry: any = await readJson(sourceFileOrganizationPolicy.astAdvisory.factSourceAuthorityPath);
const sourceProjectionPaths: any[] = [...new Set<any>((factSourceAuthorityRegistry.authorities || [])
  .flatMap((authority?: any) : any => authority.projectionPaths || []))];
const sourceOrganizationAnalysis: any = await analyzeSourceOrganization({
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
const testFiles: any = (await Promise.all(currentResiduePolicy.testRoots.map(walkReferenceFiles)))
  .flat()
  .filter((file?: any) : any => /\.(?:cjs|js|mjs|ts|tsx)$/u.test(file));
const operationDefinitionFiles: any = (await Promise.all(currentResiduePolicy.operationDefinitionRoots.map(walkReferenceFiles)))
  .flat()
  .filter((file?: any) : any => /operation-definitions.*\.(?:cjs|js|mjs|ts)$/u.test(path.basename(file)));
const currentResidueFindings: any = collectCurrentResidueFindings({ testFiles, operationDefinitionFiles });
findings.push(...currentResidueFindings);

const runnableEntrypoints: any = await collectRunnableEntrypointOwnership();
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

const runnableEntrypointResidueCount: any = runnableEntrypoints.filter((entrypoint?: any) : any => entrypoint.ownedBy.length === 0).length;
const testStageResidueCount: any = currentResidueFindings.filter((finding?: any) : any => finding.code === "test_filename_uses_stage_marker").length;
const numericOperationDefinitionResidueCount: any = currentResidueFindings.filter((finding?: any) : any => finding.code === "operation_definition_uses_numeric_partition").length;
const architectureResidueFindingCount: any = runnableEntrypointResidueCount + currentResidueFindings.length;

const warningCount: any = findings.filter((finding?: any) : any => finding.severity === "warning").length;
const releaseBlockingWarningCount: any = findings.filter((finding?: any) : any =>
  finding.severity === "warning" && finding.releaseBlocking === true
).length;
const errorCount: any = findings.filter((finding?: any) : any => finding.severity === "error").length + missingRequiredFiles.length;
const releaseBlockingSourceFindingCount: any = findings.filter((finding?: any) : any =>
  finding.severity === "error" || finding.releaseBlocking === true
).length;
const releaseBlockingFindingCount: any = releaseBlockingSourceFindingCount + missingRequiredFiles.length;
const policy: any = sourceFileOrganizationPolicyReport(sourceFileOrganizationPolicy);
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:repository:organization-report-4",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-repo-organization.ts",
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
