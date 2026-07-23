import fs from "node:fs/promises";
import path from "node:path";

import { assertPlanReceiptProofAnchorCurrent, assertReceiptCurrent } from "./plan-final-receipt.mjs";
import {
  loadPlanAuthorityText,
  planReceiptBuildContext,
  resolveContainedPlanDirectory
} from "./plan-receipt-context.mjs";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function loadCurrentPlanReceiptBinding({
  repoRoot,
  planDirectory,
  dependencyMap,
  selectedProfile
} = {}) {
  requireCondition(repoRoot && planDirectory, "Current Plan receipt lookup requires repoRoot and planDirectory");
  requireCondition(selectedProfile, "Current Plan receipt lookup requires selectedProfile");
  const planRoot = path.join(repoRoot, "docs", "plan");
  const resolvedPlan = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const currentDependencyMap = dependencyMap || JSON.parse(await fs.readFile(
    path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
    "utf8"
  ));
  const mapPlan = currentDependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain Plan ${planDirectory}`);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, planDirectory),
    fs.readFile(path.join(resolvedPlan.planPath, "Checkpoints.json"), "utf8")
  ]);
  const finalNode = JSON.parse(checkpointsText).find((node) => node.id === mapPlan.final_validation_node_id);
  requireCondition(finalNode, `Plan ${planDirectory} has no mapped final node`);
  const context = planReceiptBuildContext({
    repoRoot,
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    selectedProfile,
    dependencyMap: currentDependencyMap
  });
  assertReceiptCurrent(mapPlan.accepted_final_receipt, context);
  const receipt = mapPlan.accepted_final_receipt;
  await assertPlanReceiptProofAnchorCurrent({ repoRoot, receipt });
  return Object.freeze({
    plan: planDirectory,
    finalNodeId: receipt.final_node_id,
    platform: receipt.platform,
    selectedProfile: receipt.selected_profile,
    requirements: Object.freeze([...receipt.requirements]),
    receiptDigest: receipt.receipt_digest,
    checkpointDigest: receipt.checkpoint_digest,
    sourceRevision: receipt.source_revision,
    repositoryRevision: receipt.repository_revision,
    repositoryTreeDigest: receipt.repository_tree_digest,
    proofProvider: receipt.proof_anchor.provider,
    proofVerified: receipt.proof_anchor.verified === true,
    privacySafe: receipt.privacy_safe === true
  });
}
