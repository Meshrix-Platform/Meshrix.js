import fs from "node:fs/promises";
import path from "node:path";

import { assertPlanReceiptProofAnchorCurrent, assertReceiptCurrent } from "./plan-final-receipt.ts";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  finalValidationBindingForProfile,
} from "./plan-dependency-map.ts";
import {
  loadPlanAuthorityText,
  planReceiptBuildContext,
  resolveContainedPlanDirectory
} from "./plan-receipt-context.ts";
import { type DependencyMap, type PlanProfile, isFinalCheckpointNode } from "./plan-types.ts";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function loadCurrentPlanReceiptBinding({
  repoRoot,
  planDirectory,
  dependencyMap,
  finalNodeId,
  planProfile,
}: {
  repoRoot?: string;
  planDirectory?: string;
  dependencyMap?: DependencyMap;
  finalNodeId?: string;
  planProfile?: PlanProfile;
} = {}) {
  requireCondition(typeof repoRoot === "string" && typeof planDirectory === "string", "Current Plan receipt lookup requires repoRoot and planDirectory");
  requireCondition(
    (typeof finalNodeId === "string" && finalNodeId.length > 0) !==
      (typeof planProfile === "string" && planProfile.length > 0),
    "Current Plan receipt lookup requires exactly one of finalNodeId or planProfile",
  );
  const planRoot  = path.join(repoRoot, "docs", "plans");
  const resolvedPlan  = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const currentDependencyMap = assertCurrentDependencyMapShape(dependencyMap || JSON.parse(await fs.readFile(
    path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
    "utf8"
  )));
  const mapPlan = currentDependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain Plan ${planDirectory}`);
  const finalBinding  = finalNodeId
    ? finalValidationBinding(mapPlan, finalNodeId)
    : finalValidationBindingForProfile(mapPlan, planProfile);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, planDirectory),
    fs.readFile(path.join(resolvedPlan.planPath, "Checkpoints.json"), "utf8")
  ]);
  const checkpoints: unknown = JSON.parse(checkpointsText);
  requireCondition(Array.isArray(checkpoints), `Plan ${planDirectory} checkpoints are malformed`);
  const finalNode: unknown = checkpoints.find((node: unknown) => isFinalCheckpointNode(node) && node.id === finalBinding.node_id);
  requireCondition(isFinalCheckpointNode(finalNode), `Plan ${planDirectory} has no mapped final node`);
  const context  = planReceiptBuildContext({
    repoRoot,
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    dependencyMap: currentDependencyMap
  });
  const receipt  = acceptedFinalReceipt(mapPlan, finalBinding.node_id);
  assertReceiptCurrent(receipt, context);
  await assertPlanReceiptProofAnchorCurrent({ repoRoot, receipt });
  requireCondition(receipt.proof_anchor, "Accepted final receipt proof anchor is missing");
  return Object.freeze({
    plan: planDirectory,
    finalNodeId: receipt.final_node_id,
    platform: receipt.platform,
    profiles: Object.freeze([...receipt.profiles]),
    requirements: Object.freeze([...receipt.requirements]),
    receiptDigest: receipt.receipt_digest,
    checkpointDigest: receipt.checkpoint_digest,
    candidateDigest: receipt.candidate_digest,
    sourceRevision: receipt.source_revision,
    repositoryRevision: receipt.repository_revision,
    repositoryTreeDigest: receipt.repository_tree_digest,
    proofProvider: receipt.proof_anchor.provider,
    proofVerified: receipt.proof_anchor.verified === true,
    privacySafe: receipt.privacy_safe === true
  });
}
