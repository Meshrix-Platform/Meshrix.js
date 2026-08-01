#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../plan/plan-final-receipt.ts";
import { loadCurrentPlanReceiptBinding } from "../plan/current-plan-receipt.ts";
import { finalValidationBindingForProfile } from "../plan/plan-dependency-map.ts";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.ts";
import {
  CONTROLLED_EXECUTION_LEAF_SPECS,
  reduceControlledExecutionConvergence
} from "./lib/controlled-execution-convergence-reducer.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PLAN_DIRECTORY: any = "end-to-end-release/enterprise-single-node";
const REPORT_PATH: any = "build/reports/controlled-execution-convergence-final.json";
const VERIFIER: any = "tools/server-scripts/verify-controlled-execution-convergence.ts";
async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function verifyControlledExecutionConvergence({ repoRoot = REPO_ROOT, writeReport = true }: Record<string, any> = {}) : Promise<any> {
  const dependencyMapPath: any = path.join(repoRoot, "docs/plans/end-to-end-release/DependencyMap.json");
  const manifestPath: any = path.join(repoRoot, "docs/plans/Manifest.json");
  const planPath: any = path.join(repoRoot, "docs/plans", PLAN_DIRECTORY, "Plan.md");
  const checkpointsPath: any = path.join(repoRoot, "docs/plans", PLAN_DIRECTORY, "Checkpoints.json");
  const [dependencyMapText, manifestText, planText, checkpointsText] = await Promise.all([
    fs.readFile(dependencyMapPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(planPath, "utf8"),
    fs.readFile(checkpointsPath, "utf8")
  ]);
  const dependencyMap: any = JSON.parse(dependencyMapText);
  const mapPlan: any = dependencyMap.plans.find((entry?: any) : any => entry.directory === PLAN_DIRECTORY);
  if (!mapPlan) throw new Error("Controlled execution Plan is absent from DependencyMap");
  const finalBinding: any = finalValidationBindingForProfile(mapPlan, "local");
  const finalNode: any = JSON.parse(checkpointsText).find((node?: any) : any => node.id === finalBinding.node_id);
  if (!finalNode) throw new Error("Controlled execution final node is absent");
  const sourceContext: any = createSourceEvidenceContext(repoRoot, { verifier: VERIFIER, commandId: "controlled-execution-convergence-final" });
  const [planReceipt, leafEntries] = await Promise.all([
    loadCurrentPlanReceiptBinding({
      repoRoot,
      planDirectory: PLAN_DIRECTORY,
      dependencyMap,
      finalNodeId: finalBinding.node_id,
    }),
    Promise.all(CONTROLLED_EXECUTION_LEAF_SPECS.map(async (spec?: any) : Promise<any> => [
      spec.key,
      await readJson(path.join(repoRoot, spec.path))
    ]))
  ]);
  const report: any = reduceControlledExecutionConvergence({
    generatedAt: new Date().toISOString(),
    sourceContext,
    planReceipt,
    leafReports: Object.fromEntries(leafEntries),
    plan: {
      directory: PLAN_DIRECTORY,
      finalNodeId: finalNode.id,
      status: finalNode.status,
      requirements: [...finalNode.requirements],
      criteriaChecked: finalNode.acceptance_criteria.every((criterion?: any) : any => criterion.checked === true),
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

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  verifyControlledExecutionConvergence().then((report?: any) : any => {
    process.stdout.write(`[controlled-execution-convergence] ready=${report.summary.controlledExecutionConvergenceReady}\n`);
  }).catch((error?: any) : any => {
    process.stderr.write(`[controlled-execution-convergence] failed=${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
