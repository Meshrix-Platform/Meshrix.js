import fs from "node:fs/promises";
import path from "node:path";

import { assertPlanReceiptProofAnchorCurrent, assertReceiptCurrent } from "./plan-final-receipt.mjs";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  finalValidationBindingForProfile,
} from "./plan-dependency-map.mjs";
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
  finalNodeId,
  planProfile,
} = {}) {
  requireCondition(repoRoot && planDirectory, "Current Plan receipt lookup requires repoRoot and planDirectory");
  requireCondition(
    (typeof finalNodeId === "string" && finalNodeId.length > 0) !==
      (typeof planProfile === "string" && planProfile.length > 0),
    "Current Plan receipt lookup requires exactly one of finalNodeId or planProfile",
  );
  const planRoot = path.join(repoRoot, "docs", "plans");
  const resolvedPlan = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const currentDependencyMap = dependencyMap || JSON.parse(await fs.readFile(
    path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
    "utf8"
  ));
  assertCurrentDependencyMapShape(currentDependencyMap);
  const mapPlan = currentDependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain Plan ${planDirectory}`);
  const finalBinding = finalNodeId
    ? finalValidationBinding(mapPlan, finalNodeId)
    : finalValidationBindingForProfile(mapPlan, planProfile);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, planDirectory),
    fs.readFile(path.join(resolvedPlan.planPath, "Checkpoints.json"), "utf8")
  ]);
  const finalNode = JSON.parse(checkpointsText).find((node) => node.id === finalBinding.node_id);
  requireCondition(finalNode, `Plan ${planDirectory} has no mapped final node`);
  const context = planReceiptBuildContext({
    repoRoot,
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    dependencyMap: currentDependencyMap
  });
  const receipt = acceptedFinalReceipt(mapPlan, finalBinding.node_id);
  assertReceiptCurrent(receipt, context);
  await assertPlanReceiptProofAnchorCurrent({ repoRoot, receipt });
  return Object.freeze({
    plan: planDirectory,
    finalNodeId: receipt.final_node_id,
    platform: receipt.platform,
    profiles: Object.freeze([...receipt.profiles]),
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
