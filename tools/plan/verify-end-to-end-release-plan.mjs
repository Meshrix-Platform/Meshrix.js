#!/usr/bin/env node

import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptedFinalReceiptEntries,
  assertCurrentDependencyMapShape,
  finalValidationBindings,
  PLAN_PROFILES,
} from "./plan-dependency-map.mjs";
import {
  assertPlanReceiptProofAnchorsCurrent,
  assertReceiptPlanCurrent,
} from "./plan-final-receipt.mjs";
import {
  evaluatePlanExecutionEligibility,
  PlanExecutionPolicyError,
} from "./plan-execution-eligibility.mjs";
import {
  loadPlanAuthorityText,
  planReceiptBuildContext,
} from "./plan-receipt-context.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const EXTERNAL_SOURCE_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(.+)$/u;
const EXTERNAL_SOURCE_AUTHORITIES = new Map([
  ["LicoLand/Lico-Dev", [/^skills\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/.+$/u, /^workflows\/catalog\.json$/u]],
  ["LicoMesh/licomesh-plugins", [/^AGENTS\.md$/u, /^plugins(?:\/.+)?$/u]],
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function contained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedRelativeSource(source, message) {
  requireCondition(
    typeof source === "string" && source.length > 0 && !/[\\\u0000-\u001f\u007f]/u.test(source),
    message,
  );
  requireCondition(!path.posix.isAbsolute(source), message);
  const segments = source.split("/");
  requireCondition(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
      path.posix.normalize(source) === source,
    message,
  );
  return source;
}

async function validateManifestSource(repoRoot, source) {
  requireCondition(typeof source === "string", "Manifest source must be a string");
  requireCondition(!source.includes("://"), "Manifest source URI is not authoritative");
  const external = EXTERNAL_SOURCE_PATTERN.exec(source);
  if (external) {
    const [, authority, declaredPath] = external;
    const patterns = EXTERNAL_SOURCE_AUTHORITIES.get(authority);
    requireCondition(patterns, "Manifest external source authority is not allowed");
    const normalized = normalizedRelativeSource(declaredPath, "Manifest external source path is unsafe");
    requireCondition(patterns.some((pattern) => pattern.test(normalized)),
      "Manifest external source is outside its authority");
    return;
  }
  requireCondition(!source.includes(":"), "Manifest local source path is unsafe");
  const normalized = normalizedRelativeSource(source, "Manifest local source path is unsafe");
  requireCondition(
    normalized.startsWith("docs/plans/") || normalized.startsWith("tools/plan/") ||
      normalized.startsWith("tools/server-scripts/") || normalized.startsWith("tools/verifiers/") ||
      normalized.startsWith("tests/"),
    "Manifest local source is outside the planning or verification surface",
  );
  const resolved = path.resolve(repoRoot, normalized);
  requireCondition(contained(repoRoot, resolved), "Manifest local source escapes the repository");
  let realRoot;
  let realSource;
  try {
    [realRoot, realSource] = await Promise.all([fs.realpath(repoRoot), fs.realpath(resolved)]);
  } catch {
    throw new Error("Manifest local source does not exist");
  }
  requireCondition(contained(realRoot, realSource), "Manifest local source escapes the repository");
}

function resolvedPaths({ repoRoot = defaultRepoRoot, planRoot, reportPath } = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedPlanRoot = path.resolve(planRoot ?? path.join(resolvedRepoRoot, "docs", "plans"));
  return {
    repoRoot: resolvedRepoRoot,
    planRoot: resolvedPlanRoot,
    reportPath: path.resolve(
      reportPath ?? path.join(resolvedRepoRoot, "build", "reports", "end-to-end-release-plan.json"),
    ),
    manifestPath: path.join(resolvedPlanRoot, "Manifest.json"),
    dependencyMapPath: path.join(resolvedPlanRoot, "end-to-end-release", "DependencyMap.json"),
  };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function admissionProjection(admission) {
  return {
    candidate_count: admission.candidateCount,
    eligible_count: admission.eligible.length,
    deferred_count: admission.deferred.length,
    deferred_reason_counts: admission.deferredReasonCounts,
  };
}

export async function verifyEndToEndReleasePlan(options = {}) {
  const {
    repoRoot,
    planRoot,
    reportPath,
    manifestPath,
    dependencyMapPath,
  } = resolvedPaths(options);
  const requireCompletedReceipts = options.requireCompletedReceipts !== false;
  const writeReport = options.writeReport !== false;
  const [manifestText, dependencyMapText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(dependencyMapPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const dependencyMap = JSON.parse(dependencyMapText);
  requireCondition(Array.isArray(manifest) && manifest.length > 0, "Manifest must be a non-empty array");
  assertCurrentDependencyMapShape(dependencyMap);

  const manifestDirectories = new Set();
  const checkpoints = new Map();
  for (const manifestPlan of manifest) {
    requireCondition(
      typeof manifestPlan?.directory === "string" && manifestPlan.directory.length > 0 &&
        !manifestDirectories.has(manifestPlan.directory),
      "Manifest contains a missing or duplicate Plan directory",
    );
    manifestDirectories.add(manifestPlan.directory);
    requireCondition(
      manifestPlan.checkpoints === `${manifestPlan.directory}/Checkpoints.json`,
      "Manifest checkpoint path does not match its Plan directory",
    );
    await Promise.all((manifestPlan.source_files ?? []).map((source) =>
      validateManifestSource(repoRoot, source)));
    checkpoints.set(
      manifestPlan.directory,
      await readJson(path.join(planRoot, manifestPlan.checkpoints)),
    );
  }

  const rootPlans = dependencyMap.plans.filter((plan) => plan.parent === null);
  requireCondition(
    rootPlans.length === 1 && rootPlans[0].directory === "end-to-end-release",
    "DependencyMap must have exactly one current release root",
  );

  const admissions = {};
  for (const hostPlatform of ["macos", "windows", "linux"]) {
    admissions[hostPlatform] = {};
    for (const profile of PLAN_PROFILES) {
      admissions[hostPlatform][profile] = admissionProjection(evaluatePlanExecutionEligibility({
        manifest,
        dependencyMap,
        checkpoints,
        hostPlatform,
        selectedProfile: profile,
        requireAcceptedFinalReceipts: requireCompletedReceipts,
      }));
    }
  }

  const receiptsForProof = [];
  let completedFinalCount = 0;
  let acceptedReceiptCount = 0;
  for (const mapPlan of dependencyMap.plans) {
    const nodes = checkpoints.get(mapPlan.directory);
    requireCondition(Array.isArray(nodes), "DependencyMap Plan checkpoints are missing");
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const binding of finalValidationBindings(mapPlan)) {
      const finalNode = nodesById.get(binding.node_id);
      requireCondition(finalNode?.role === "final_validation",
        "DependencyMap final-validation binding does not own a final node");
    }
    for (const { binding, receipt } of acceptedFinalReceiptEntries(mapPlan)) {
      const finalNode = nodesById.get(binding.node_id);
      if (finalNode.status !== "completed") {
        requireCondition(receipt === undefined,
          "Incomplete Plan final retains an accepted final receipt");
        continue;
      }
      completedFinalCount += 1;
      if (!requireCompletedReceipts) continue;
      requireCondition(receipt, "Completed Plan final is missing its accepted final receipt");
      const [planText, checkpointsText] = await Promise.all([
        loadPlanAuthorityText(planRoot, mapPlan.directory),
        fs.readFile(path.join(planRoot, mapPlan.directory, "Checkpoints.json"), "utf8"),
      ]);
      assertReceiptPlanCurrent(receipt, planReceiptBuildContext({
        repoRoot,
        planDirectory: mapPlan.directory,
        mapPlan,
        planText,
        checkpointsText,
        finalNode,
        dependencyMap,
      }));
      acceptedReceiptCount += 1;
      receiptsForProof.push(receipt);
    }
  }
  if (requireCompletedReceipts) {
    await assertPlanReceiptProofAnchorsCurrent({ repoRoot, receipts: receiptsForProof });
  }

  const graph = evaluatePlanExecutionEligibility({
    manifest,
    dependencyMap,
    checkpoints,
    hostPlatform: process.platform,
    requireAcceptedFinalReceipts: requireCompletedReceipts,
  }).graph;
  const report = {
    schema_version: "licomesh.end-to-end-release-plan-proof.v3",
    accepted: true,
    dependency_map_schema_version: dependencyMap.schema_version,
    plan_count: graph.planCount,
    checkpoint_node_count: graph.nodeCount,
    graph_edge_count: graph.edgeCount,
    profile_count: PLAN_PROFILES.length,
    completed_final_count: completedFinalCount,
    accepted_receipt_count: acceptedReceiptCount,
    execution_admission_by_platform_and_profile: admissions,
    manifest_sha256: digest(manifestText),
    dependency_map_sha256: digest(dependencyMapText),
  };
  if (writeReport) await atomicWriteJson(reportPath, report);
  return report;
}

function fixtureNode({ id, role, prerequisites, next }) {
  return {
    id,
    status: "pending",
    role,
    prerequisites,
    next,
    platform: "any",
    commit: { repository: ".git" },
  };
}

function generatedMutationFixture() {
  const directory = "end-to-end-release";
  const implementationId = randomUUID();
  const finalId = randomUUID();
  return {
    manifest: [{
      id: randomUUID(),
      status: "pending",
      title: "Generated mutation fixture",
      directory,
      source_files: [],
      goal: "Generated project graph fixture.",
      description: "Generated fixture; no historical Plan dependency.",
      checkpoints: `${directory}/Checkpoints.json`,
    }],
    dependencyMap: {
      schema_version: 3,
      profiles: [...PLAN_PROFILES],
      plans: [{
        directory,
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: finalId, profiles: [...PLAN_PROFILES] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      }],
    },
    checkpoints: [
      fixtureNode({ id: implementationId, role: "implementation", prerequisites: [], next: [finalId] }),
      fixtureNode({ id: finalId, role: "final_validation", prerequisites: [implementationId], next: [] }),
    ],
  };
}

async function writeGeneratedFixture(planRoot, fixture) {
  const planPath = path.join(planRoot, "end-to-end-release");
  await fs.mkdir(planPath, { recursive: true });
  await fs.writeFile(path.join(planRoot, "Manifest.json"), `${JSON.stringify(fixture.manifest)}\n`, "utf8");
  await fs.writeFile(path.join(planPath, "DependencyMap.json"),
    `${JSON.stringify(fixture.dependencyMap)}\n`, "utf8");
  await fs.writeFile(path.join(planPath, "Checkpoints.json"),
    `${JSON.stringify(fixture.checkpoints)}\n`, "utf8");
  for (const name of ["Requirements.md", "Evidence.md", "Architecture.md", "Validation.md"]) {
    await fs.writeFile(path.join(planPath, name), `# Generated ${name}\n`, "utf8");
  }
}

export async function runEndToEndReleasePlanMutationTests({ repoRoot = defaultRepoRoot } = {}) {
  const cases = [
    ["superseded-schema", (fixture) => { fixture.dependencyMap.schema_version = 2; }],
    ["legacy-single-final-field", (fixture) => {
      fixture.dependencyMap.plans[0].final_validation_node_id =
        fixture.dependencyMap.plans[0].final_validations[0].node_id;
    }],
    ["duplicate-profile-final-owner", (fixture) => {
      fixture.dependencyMap.plans[0].final_validations.push({
        ...fixture.dependencyMap.plans[0].final_validations[0],
      });
    }],
    ["unknown-profile", (fixture) => {
      fixture.dependencyMap.plans[0].final_validations[0].profiles = ["unknown"];
    }],
    ["incomplete-final-retains-receipt", (fixture) => {
      const finalId = fixture.dependencyMap.plans[0].final_validations[0].node_id;
      fixture.dependencyMap.plans[0].accepted_final_receipts[finalId] = {};
    }],
    ["local-cycle", (fixture) => {
      fixture.checkpoints[0].prerequisites = [fixture.checkpoints[1].id];
      fixture.checkpoints[1].next = [fixture.checkpoints[0].id];
    }],
  ];
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "licomesh-generated-plan-mutations-"));
  const results = [];
  try {
    for (const [name, mutate] of cases) {
      const fixture = generatedMutationFixture();
      mutate(fixture);
      const planRoot = path.join(workRoot, name);
      await writeGeneratedFixture(planRoot, fixture);
      let rejected = false;
      try {
        await verifyEndToEndReleasePlan({
          repoRoot,
          planRoot,
          writeReport: false,
          requireCompletedReceipts: false,
        });
      } catch {
        rejected = true;
      }
      requireCondition(rejected, `Generated mutation was not rejected: ${name}`);
      results.push({ name, rejected: true });
    }
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
  return {
    accepted: true,
    fixture_kind: "generated",
    mutation_case_count: results.length,
    cases: results,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test-mutations")) {
    requireCondition(argv.length === 1, "Plan verifier received unsupported arguments");
    process.stdout.write(`${JSON.stringify(await runEndToEndReleasePlanMutationTests())}\n`);
    return;
  }
  const structuralOnly = argv.includes("--structural-only");
  requireCondition(argv.length === (structuralOnly ? 1 : 0),
    "Plan verifier received unsupported arguments");
  process.stdout.write(`${JSON.stringify(await verifyEndToEndReleasePlan({
    requireCompletedReceipts: !structuralOnly,
    writeReport: !structuralOnly,
  }))}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error) => {
    const code = error instanceof PlanExecutionPolicyError ? error.code : "verification_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
