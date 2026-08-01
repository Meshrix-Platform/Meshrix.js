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

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

export async function loadCurrentPlanReceiptBinding({
  repoRoot,
  planDirectory,
  dependencyMap,
  finalNodeId,
  planProfile,
}: Record<string, any> = {}) : Promise<any> {
  requireCondition(repoRoot && planDirectory, "Current Plan receipt lookup requires repoRoot and planDirectory");
  requireCondition(
    (typeof finalNodeId === "string" && finalNodeId.length > 0) !==
      (typeof planProfile === "string" && planProfile.length > 0),
    "Current Plan receipt lookup requires exactly one of finalNodeId or planProfile",
  );
  const planRoot: any = path.join(repoRoot, "docs", "plans");
  const resolvedPlan: any = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const currentDependencyMap: any = dependencyMap || JSON.parse(await fs.readFile(
    path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
    "utf8"
  ));
  assertCurrentDependencyMapShape(currentDependencyMap);
  const mapPlan: any = currentDependencyMap.plans.find((plan?: any) : any => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain Plan ${planDirectory}`);
  const finalBinding: any = finalNodeId
    ? finalValidationBinding(mapPlan, finalNodeId)
    : finalValidationBindingForProfile(mapPlan, planProfile);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, planDirectory),
    fs.readFile(path.join(resolvedPlan.planPath, "Checkpoints.json"), "utf8")
  ]);
  const finalNode: any = JSON.parse(checkpointsText).find((node?: any) : any => node.id === finalBinding.node_id);
  requireCondition(finalNode, `Plan ${planDirectory} has no mapped final node`);
  const context: any = planReceiptBuildContext({
    repoRoot,
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    dependencyMap: currentDependencyMap
  });
  const receipt: any = acceptedFinalReceipt(mapPlan, finalBinding.node_id);
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
    candidateDigest: receipt.candidate_digest,
    sourceRevision: receipt.source_revision,
    repositoryRevision: receipt.repository_revision,
    repositoryTreeDigest: receipt.repository_tree_digest,
    proofProvider: receipt.proof_anchor.provider,
    proofVerified: receipt.proof_anchor.verified === true,
    privacySafe: receipt.privacy_safe === true
  });
}
