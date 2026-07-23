import fs from "node:fs/promises";
import path from "node:path";

import { loadCurrentPlanReceiptBinding } from "../../plan/current-plan-receipt.mjs";
import { verifyEndToEndReleasePlan } from "../../plan/verify-end-to-end-release-plan.mjs";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { requirePlatformAcceptanceProfile } from "./platform-acceptance-contract.mjs";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  normalizePlanProfiles,
} from "../../plan/plan-dependency-map.mjs";

const RELEASE_ACCEPTANCE_PLAN = "end-to-end-release/release-acceptance";
const ACCEPTANCE_TO_PLAN_PROFILE = Object.freeze({ core: "local" });

export class PlatformAcceptancePlanReceiptError extends Error {
  constructor(code, classification = "blocked") {
    super(code);
    this.name = "PlatformAcceptancePlanReceiptError";
    this.code = code;
    this.classification = classification;
  }
}

function requireStructure(condition, code) {
  if (!condition) throw new PlatformAcceptancePlanReceiptError(code, "failed");
}

function requireReady(condition, code) {
  if (!condition) throw new PlatformAcceptancePlanReceiptError(code, "blocked");
}

export function requiredPlatformAcceptancePlanReceipts(dependencyMap, planProfile = "local") {
  try {
    assertCurrentDependencyMapShape(dependencyMap);
    normalizePlanProfiles([planProfile]);
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-map-missing", "failed");
  }
  const plansByDirectory = new Map();
  for (const plan of dependencyMap.plans) {
    requireStructure(
      typeof plan?.directory === "string" && !plansByDirectory.has(plan.directory),
      "plan-receipt-map-plan-invalid",
    );
    plansByDirectory.set(plan.directory, plan);
  }

  const releaseAcceptance = plansByDirectory.get(RELEASE_ACCEPTANCE_PLAN);
  requireStructure(releaseAcceptance, "plan-receipt-consumer-missing");
  const references = releaseAcceptance.prerequisite_receipts?.filter((reference) =>
    Array.isArray(reference?.profiles) && reference.profiles.includes(planProfile));
  requireStructure(
    Array.isArray(references) && references.length > 0,
    "plan-receipt-requirements-empty",
  );

  const keys = new Set();
  return references.map((reference) => {
    requireStructure(reference?.kind === "final_validation", "plan-receipt-kind-invalid");
    const provider = plansByDirectory.get(reference.plan);
    requireStructure(provider, "plan-receipt-provider-unknown");
    requireStructure(reference.plan !== RELEASE_ACCEPTANCE_PLAN, "plan-receipt-consumer-cycle");
    let finalBinding;
    try {
      finalBinding = finalValidationBinding(provider, reference.node_id);
    } catch {
      throw new PlatformAcceptancePlanReceiptError("plan-receipt-final-node-mismatch", "failed");
    }
    requireStructure(
      finalBinding.profiles.includes(planProfile) &&
        normalizePlanProfiles(reference.profiles).includes(planProfile),
      "plan-receipt-profile-declaration-mismatch",
    );
    requireReady(acceptedFinalReceipt(provider, reference.node_id), "required-plan-receipt-missing");
    const key = `${reference.plan}\u0000${reference.node_id}`;
    requireStructure(!keys.has(key), "plan-receipt-requirement-duplicate");
    keys.add(key);
    return Object.freeze({
      plan: reference.plan,
      finalNodeId: reference.node_id,
      planProfile,
    });
  });
}

export async function verifyPlatformAcceptancePlanReceipts({
  repoRoot,
  selectedProfile,
  dependencyMap,
  verifyPlan = verifyEndToEndReleasePlan,
  loadBinding = loadCurrentPlanReceiptBinding,
} = {}) {
  requireStructure(repoRoot, "plan-receipt-repo-root-missing");
  try {
    selectedProfile = requirePlatformAcceptanceProfile(selectedProfile);
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-profile-invalid", "failed");
  }
  const planProfile = ACCEPTANCE_TO_PLAN_PROFILE[selectedProfile];
  requireStructure(planProfile, "plan-receipt-profile-unmapped");
  const currentDependencyMap = dependencyMap || JSON.parse(await fs.readFile(
    path.join(repoRoot, "docs/plans/end-to-end-release/DependencyMap.json"),
    "utf8",
  ));

  try {
    await verifyPlan({ repoRoot, writeReport: false, requireCompletedReceipts: false });
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-dag-invalid", "failed");
  }
  const requiredReceipts = requiredPlatformAcceptancePlanReceipts(currentDependencyMap, planProfile);
  const bindings = [];
  for (const required of requiredReceipts) {
    let binding;
    try {
      binding = await loadBinding({
        repoRoot,
        planDirectory: required.plan,
        dependencyMap: currentDependencyMap,
        finalNodeId: required.finalNodeId,
      });
    } catch {
      throw new PlatformAcceptancePlanReceiptError("required-plan-receipt-stale", "blocked");
    }
    requireReady(
      binding?.finalNodeId === required.finalNodeId && binding?.proofVerified === true,
      "required-plan-receipt-unverified",
    );
    requireReady(
      Array.isArray(binding?.profiles) && binding.profiles.includes(planProfile),
      "required-plan-receipt-profile-mismatch",
    );
    requireReady(typeof binding?.platform === "string" && binding.platform.length > 0, "required-plan-receipt-platform-missing");
    requireReady(Array.isArray(binding?.requirements) && binding.requirements.length > 0, "required-plan-receipt-requirements-missing");
    requireReady(binding?.privacySafe === true, "required-plan-receipt-privacy-unsafe");
    bindings.push(Object.freeze({
      plan: required.plan,
      finalNodeId: binding.finalNodeId,
      platform: binding.platform,
      profiles: Object.freeze([...binding.profiles]),
      requirements: Object.freeze([...binding.requirements]),
      receiptDigest: binding.receiptDigest,
      checkpointDigest: binding.checkpointDigest,
      sourceRevision: binding.sourceRevision,
      repositoryRevision: binding.repositoryRevision,
      repositoryTreeDigest: binding.repositoryTreeDigest,
      proofProvider: binding.proofProvider,
      proofVerified: true,
      privacySafe: true,
    }));
  }
  bindings.sort((left, right) => left.plan.localeCompare(right.plan));
  try {
    await verifyPlan({ repoRoot, writeReport: false, requireCompletedReceipts: true });
  } catch {
    throw new PlatformAcceptancePlanReceiptError("completed-plan-receipt-stale", "blocked");
  }
  return Object.freeze({
    schemaVersion: "licomesh.platform-acceptance-plan-receipts.v1",
    releaseAcceptancePlan: RELEASE_ACCEPTANCE_PLAN,
    selectedProfile,
    planProfile,
    requiredReceiptCount: requiredReceipts.length,
    bindings,
    planReceiptSetDigest: reportPayloadDigest({ bindings }),
  });
}
