import fs from "node:fs/promises";
import path from "node:path";

import { loadCurrentPlanReceiptBinding } from "../../plan/current-plan-receipt.ts";
import { verifyEndToEndReleasePlan } from "../../plan/verify-end-to-end-release-plan.ts";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { requirePlatformAcceptanceProfile } from "./platform-acceptance-contract.ts";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  normalizePlanProfiles,
} from "../../plan/plan-dependency-map.ts";

const RELEASE_ACCEPTANCE_PLAN: any = "end-to-end-release/functional-release-acceptance";
const ACCEPTANCE_TO_PLAN_PROFILE: Readonly<Record<string, any>> = Object.freeze({
  "enterprise-single-node": "enterprise-single-node",
});
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;

export class PlatformAcceptancePlanReceiptError extends Error {
  classification: any;
  code: any;
  name: any;
  constructor(code?: any, classification: any = "blocked") {
    super(code);
    this.name = "PlatformAcceptancePlanReceiptError";
    this.code = code;
    this.classification = classification;
  }
}

function requireStructure(condition?: any, code?: any) : any {
  if (!condition) throw new PlatformAcceptancePlanReceiptError(code, "failed");
}

function requireReady(condition?: any, code?: any) : any {
  if (!condition) throw new PlatformAcceptancePlanReceiptError(code, "failed");
}

export function requiredPlatformAcceptancePlanReceipts(
  dependencyMap?: any,
  planProfile: any = "enterprise-single-node",
) : any {
  try {
    assertCurrentDependencyMapShape(dependencyMap);
    normalizePlanProfiles([planProfile]);
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-map-missing", "failed");
  }
  const plansByDirectory: any = new Map<any, any>();
  for (const plan of dependencyMap.plans) {
    requireStructure(
      typeof plan?.directory === "string" && !plansByDirectory.has(plan.directory),
      "plan-receipt-map-plan-invalid",
    );
    plansByDirectory.set(plan.directory, plan);
  }

  const releaseAcceptance: any = plansByDirectory.get(RELEASE_ACCEPTANCE_PLAN);
  requireStructure(releaseAcceptance, "plan-receipt-consumer-missing");
  const references: any = releaseAcceptance.prerequisite_receipts?.filter((reference?: any) : any =>
    Array.isArray(reference?.profiles) && reference.profiles.includes(planProfile));
  requireStructure(
    Array.isArray(references) && references.length > 0,
    "plan-receipt-requirements-empty",
  );

  const keys: any = new Set<any>();
  return references.map((reference?: any) : any => {
    requireStructure(reference?.kind === "final_validation", "plan-receipt-kind-invalid");
    const provider: any = plansByDirectory.get(reference.plan);
    requireStructure(provider, "plan-receipt-provider-unknown");
    requireStructure(reference.plan !== RELEASE_ACCEPTANCE_PLAN, "plan-receipt-consumer-cycle");
    let finalBinding: any;
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
    const key: any = `${reference.plan}\u0000${reference.node_id}`;
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
}: Record<string, any> = {}) : Promise<any> {
  requireStructure(repoRoot, "plan-receipt-repo-root-missing");
  try {
    selectedProfile = requirePlatformAcceptanceProfile(selectedProfile);
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-profile-invalid", "failed");
  }
  const planProfile: any = ACCEPTANCE_TO_PLAN_PROFILE[selectedProfile];
  requireStructure(planProfile, "plan-receipt-profile-unmapped");
  const currentDependencyMap: any = dependencyMap || JSON.parse(await fs.readFile(
    path.join(repoRoot, "docs/plans/end-to-end-release/DependencyMap.json"),
    "utf8",
  ));

  try {
    await verifyPlan({ repoRoot, writeReport: false, requireCompletedReceipts: false });
  } catch {
    throw new PlatformAcceptancePlanReceiptError("plan-receipt-dag-invalid", "failed");
  }
  const requiredReceipts: any = requiredPlatformAcceptancePlanReceipts(currentDependencyMap, planProfile);
  const bindings: any[] = [];
  for (const required of requiredReceipts) {
    let binding: any;
    try {
      binding = await loadBinding({
        repoRoot,
        planDirectory: required.plan,
        dependencyMap: currentDependencyMap,
        finalNodeId: required.finalNodeId,
      });
    } catch {
      throw new PlatformAcceptancePlanReceiptError("required-plan-receipt-stale", "failed");
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
    requireReady(
      SHA256_PATTERN.test(String(binding?.candidateDigest || "")),
      "required-plan-receipt-candidate-missing",
    );
    requireReady(binding?.privacySafe === true, "required-plan-receipt-privacy-unsafe");
    bindings.push(Object.freeze({
      plan: required.plan,
      finalNodeId: binding.finalNodeId,
      platform: binding.platform,
      profiles: Object.freeze([...binding.profiles]),
      requirements: Object.freeze([...binding.requirements]),
      receiptDigest: binding.receiptDigest,
      checkpointDigest: binding.checkpointDigest,
      candidateDigest: binding.candidateDigest,
      sourceRevision: binding.sourceRevision,
      repositoryRevision: binding.repositoryRevision,
      repositoryTreeDigest: binding.repositoryTreeDigest,
      proofProvider: binding.proofProvider,
      proofVerified: true,
      privacySafe: true,
    }));
  }
  const candidateBinding: any = bindings[0];
  requireReady(
    bindings.every((binding?: any) : any => binding.candidateDigest === candidateBinding.candidateDigest),
    "required-plan-receipt-candidate-mismatch",
  );
  requireReady(
    bindings.every((binding?: any) : any =>
      binding.sourceRevision === candidateBinding.sourceRevision &&
      binding.repositoryRevision === candidateBinding.repositoryRevision),
    "required-plan-receipt-source-mismatch",
  );
  requireReady(
    bindings.every((binding?: any) : any =>
      binding.repositoryTreeDigest === candidateBinding.repositoryTreeDigest),
    "required-plan-receipt-tree-mismatch",
  );
  bindings.sort((left?: any, right?: any) : any => left.plan.localeCompare(right.plan));
  try {
    await verifyPlan({ repoRoot, writeReport: false, requireCompletedReceipts: true });
  } catch {
    throw new PlatformAcceptancePlanReceiptError("completed-plan-receipt-stale", "failed");
  }
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:platform-acceptance-plan-receipts-1",
    releaseAcceptancePlan: RELEASE_ACCEPTANCE_PLAN,
    selectedProfile,
    planProfile,
    requiredReceiptCount: requiredReceipts.length,
    bindings,
    planReceiptSetDigest: reportPayloadDigest({ bindings }),
  });
}
