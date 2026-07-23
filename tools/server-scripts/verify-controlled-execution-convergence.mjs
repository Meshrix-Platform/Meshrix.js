#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../plan/plan-final-receipt.mjs";
import { loadCurrentPlanReceiptBinding } from "../plan/current-plan-receipt.mjs";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.mjs";
import {
  CONTROLLED_EXECUTION_LEAF_SPECS,
  reduceControlledExecutionConvergence
} from "./lib/controlled-execution-convergence-reducer.mjs";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PLAN_DIRECTORY = "end-to-end-release/capability-runtime/controlled-execution-convergence";
const REPORT_PATH = "build/reports/controlled-execution-convergence-final.json";
const VERIFIER = "tools/server-scripts/verify-controlled-execution-convergence.mjs";
const PREREQUISITE_PLANS = Object.freeze([
  "end-to-end-release/capability-runtime/execution-sandbox",
  "end-to-end-release/platform-foundation/authorization/operation-permission",
  "end-to-end-release/platform-foundation/authorization/approval-governance",
  "end-to-end-release/platform-foundation/storage-recovery-convergence",
  "end-to-end-release/platform-foundation/job-lifecycle-convergence",
  "end-to-end-release/platform-foundation/runtime-observability-convergence",
  "end-to-end-release/platform-foundation/release-evidence-convergence"
]);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function verifyControlledExecutionConvergence({ repoRoot = REPO_ROOT, writeReport = true } = {}) {
  const dependencyMapPath = path.join(repoRoot, "docs/plans/end-to-end-release/DependencyMap.json");
  const manifestPath = path.join(repoRoot, "docs/plans/Manifest.json");
  const planPath = path.join(repoRoot, "docs/plans", PLAN_DIRECTORY, "Plan.md");
  const checkpointsPath = path.join(repoRoot, "docs/plans", PLAN_DIRECTORY, "Checkpoints.json");
  const [dependencyMapText, manifestText, planText, checkpointsText] = await Promise.all([
    fs.readFile(dependencyMapPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(planPath, "utf8"),
    fs.readFile(checkpointsPath, "utf8")
  ]);
  const dependencyMap = JSON.parse(dependencyMapText);
  const mapPlan = dependencyMap.plans.find((entry) => entry.directory === PLAN_DIRECTORY);
  if (!mapPlan) throw new Error("Controlled execution Plan is absent from DependencyMap");
  const finalNode = JSON.parse(checkpointsText).find((node) => node.id === mapPlan.final_validation_node_id);
  if (!finalNode) throw new Error("Controlled execution final node is absent");
  const sourceContext = createSourceEvidenceContext(repoRoot, { verifier: VERIFIER, commandId: "controlled-execution-convergence-final" });
  const [planReceipt, prerequisiteReceipts, leafEntries] = await Promise.all([
    loadCurrentPlanReceiptBinding({ repoRoot, planDirectory: PLAN_DIRECTORY, dependencyMap, selectedProfile: "core" }),
    Promise.all(PREREQUISITE_PLANS.map((planDirectory) =>
      loadCurrentPlanReceiptBinding({ repoRoot, planDirectory, dependencyMap, selectedProfile: "core" })
    )),
    Promise.all(CONTROLLED_EXECUTION_LEAF_SPECS.map(async (spec) => [
      spec.key,
      await readJson(path.join(repoRoot, spec.path))
    ]))
  ]);
  const report = reduceControlledExecutionConvergence({
    generatedAt: new Date().toISOString(),
    sourceContext,
    planReceipt,
    prerequisiteReceipts,
    leafReports: Object.fromEntries(leafEntries),
    plan: {
      directory: PLAN_DIRECTORY,
      finalNodeId: finalNode.id,
      status: finalNode.status,
      requirements: [...finalNode.requirements],
      criteriaChecked: finalNode.acceptance_criteria.every((criterion) => criterion.checked === true),
      planDigest: digest(planText),
      checkpointDigest: digest(checkpointsText),
      manifestDigest: digest(manifestText),
      dependencyMapDigest: digest(dependencyMapText)
    }
  });
  if (writeReport) {
    await writePrivateFileAtomic(path.join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  verifyControlledExecutionConvergence().then((report) => {
    process.stdout.write(`[controlled-execution-convergence] ready=${report.summary.controlledExecutionConvergenceReady}\n`);
  }).catch((error) => {
    process.stderr.write(`[controlled-execution-convergence] failed=${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
