import fs from "node:fs/promises";
import path from "node:path";

import { loadCurrentPlanReceiptBinding } from "../../plan/current-plan-receipt.ts";
import { verifyPlanEvidenceCurrent } from "../../plan/plan-evidence-verifier.ts";
import { verifyEndToEndReleasePlan } from "../../plan/verify-end-to-end-release-plan.ts";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { requirePlatformAcceptanceProfile } from "./platform-acceptance-contract.ts";
import { ACCEPTANCE_REQUIRED_REPORTS } from "./platform-acceptance-command-catalog.ts";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  normalizePlanProfiles,
} from "../../plan/plan-dependency-map.ts";

const RELEASE_ACCEPTANCE_PLAN: any = "end-to-end-release";
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

function completedPrerequisiteFrontier(checkpoints: any[], finalNode: any): any[] {
  const byId: any = new Map<any, any>(checkpoints.map((node?: any) : any => [node?.id, node]));
  const direct: any[] = (finalNode?.prerequisites || []).map((nodeId?: any) : any => byId.get(nodeId));
  requireStructure(direct.length > 0 && direct.every(Boolean), "release-prerequisite-set-mismatch");
  if (direct.every((node?: any) : any => node.status === "completed")) return direct;

  const ancestorsById: any = new Map<any, any>();
  function ancestors(nodeId?: any) : any {
    if (ancestorsById.has(nodeId)) return ancestorsById.get(nodeId);
    const collected: any = new Set<any>([nodeId]);
    ancestorsById.set(nodeId, collected);
    const node: any = byId.get(nodeId);
    for (const prerequisiteId of node?.prerequisites || []) {
      for (const ancestorId of ancestors(prerequisiteId)) collected.add(ancestorId);
    }
    return collected;
  }

  const common: any = [...ancestors(direct[0].id)].filter((nodeId?: any) : any =>
    direct.slice(1).every((node?: any) : any => ancestors(node.id).has(nodeId)) &&
    byId.get(nodeId)?.status === "completed");
  const frontier: any[] = common
    .filter((nodeId?: any) : any => !common.some((otherId?: any) : any =>
      otherId !== nodeId && ancestors(otherId).has(nodeId)))
    .map((nodeId?: any) : any => byId.get(nodeId));
  requireReady(frontier.length > 0, "release-prerequisite-incomplete");
  return frontier;
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
  requireStructure(Array.isArray(references), "plan-receipt-requirements-invalid");

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
  loadCandidate,
  loadCheckpoints,
  verifyCheckpointEvidence = (input: Record<string, any> = {}) : Promise<any> =>
    verifyPlanEvidenceCurrent({
      ...input,
      disallowedFilePaths: ACCEPTANCE_REQUIRED_REPORTS
    }),
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
  async function bindCurrentFinalReceipt(planDirectory: any, finalNodeId: any): Promise<any> {
    let binding: any;
    try {
      binding = await loadBinding({
        repoRoot,
        planDirectory,
        dependencyMap: currentDependencyMap,
        finalNodeId,
      });
    } catch {
      throw new PlatformAcceptancePlanReceiptError("required-plan-receipt-stale", "failed");
    }
    requireReady(
      binding?.finalNodeId === finalNodeId && binding?.proofVerified === true,
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
    return Object.freeze({
      plan: planDirectory,
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
    });
  }
  for (const required of requiredReceipts) {
    bindings.push(await bindCurrentFinalReceipt(required.plan, required.finalNodeId));
  }
  const checkpointBindings: any[] = [];
  let identityCandidate: any = null;
  if (requiredReceipts.length === 0) {
    const releasePlan: any = currentDependencyMap.plans.find((entry?: any) : any =>
      entry.directory === RELEASE_ACCEPTANCE_PLAN);
    const releaseFinal: any = finalValidationBinding(releasePlan, releasePlan.final_validations[0].node_id);
    requireStructure(releaseFinal.profiles.includes(planProfile), "release-final-profile-mismatch");
    const checkpointLoader: any = loadCheckpoints ?? (async () : Promise<any> => JSON.parse(await fs.readFile(
      path.join(repoRoot, "docs/plans/end-to-end-release/Checkpoints.json"),
      "utf8",
    )));
    const checkpoints: any = await checkpointLoader({ repoRoot });
    requireStructure(Array.isArray(checkpoints), "release-checkpoints-invalid");
    const finalNode: any = checkpoints.find((entry?: any) : any => entry.id === releaseFinal.node_id);
    requireStructure(finalNode?.role === "final_validation", "release-final-node-missing");
    if (finalNode.status === "completed") {
      const completedBinding: any = await bindCurrentFinalReceipt(RELEASE_ACCEPTANCE_PLAN, finalNode.id);
      try {
        await verifyCheckpointEvidence({ repoRoot, finalNode });
      } catch {
        throw new PlatformAcceptancePlanReceiptError("release-prerequisite-evidence-stale", "failed");
      }
      bindings.push(completedBinding);
    } else {
      requireReady(finalNode.status === "pending", "release-final-not-pending");
      identityCandidate = await (loadCandidate ?? (async () : Promise<any> => {
        const { createReleaseCandidateIdentity } = await import("../verify-release-candidate-identity.ts");
        return createReleaseCandidateIdentity({ repoRoot });
      }))({ repoRoot });
      const pendingCandidateDigest: any = identityCandidate?.candidate_digest;
      requireReady(SHA256_PATTERN.test(String(pendingCandidateDigest || "")), "release-candidate-missing");
      requireReady(/^[a-f0-9]{40}$/u.test(String(identityCandidate?.source_revision || "")), "release-candidate-source-missing");
      const prerequisites: any[] = completedPrerequisiteFrontier(checkpoints, finalNode);
      for (const node of prerequisites) {
        requireReady(node.status === "completed", "release-prerequisite-incomplete");
        if (node.candidate_digest !== undefined && node.candidate_digest !== null) {
          requireReady(node.candidate_digest === pendingCandidateDigest, "release-prerequisite-candidate-mismatch");
        }
        if (node.commit?.delivered !== undefined && node.commit?.delivered !== null) {
          requireReady(node.commit.delivered === identityCandidate.source_revision, "release-prerequisite-source-mismatch");
        }
        requireReady(
          Array.isArray(node.acceptance_criteria) && node.acceptance_criteria.length > 0 &&
            node.acceptance_criteria.every((criterion?: any) : any => criterion.checked === true),
          "release-prerequisite-criteria-incomplete",
        );
        try {
          await verifyCheckpointEvidence({ repoRoot, finalNode: node });
        } catch {
          throw new PlatformAcceptancePlanReceiptError("release-prerequisite-evidence-stale", "failed");
        }
        checkpointBindings.push(Object.freeze({
          nodeId: node.id,
          code: node.code,
          candidateDigest: pendingCandidateDigest,
          sourceRevision: identityCandidate.source_revision,
          checkpointDigest: reportPayloadDigest(node),
          privacySafe: true,
        }));
      }
      checkpointBindings.sort((left?: any, right?: any) : any => left.code.localeCompare(right.code));
    }
  }
  const candidateBinding: any = bindings[0];
  if (candidateBinding) {
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
  }
  let candidate: any = candidateBinding ? {
    candidate_digest: candidateBinding.candidateDigest,
    source_revision: /^[a-f0-9]{40}$/u.test(String(candidateBinding.repositoryRevision || ""))
      ? candidateBinding.repositoryRevision
      : candidateBinding.sourceRevision,
  } : identityCandidate;
  if (!candidate) {
    const candidateLoader: any = loadCandidate ?? (async () : Promise<any> => {
      const { createReleaseCandidateIdentity } = await import("../verify-release-candidate-identity.ts");
      return createReleaseCandidateIdentity({ repoRoot });
    });
    candidate = await candidateLoader({ repoRoot });
  }
  const candidateDigest: any = candidate?.candidate_digest;
  requireReady(SHA256_PATTERN.test(String(candidateDigest || "")), "release-candidate-missing");
  requireReady(/^[a-f0-9]{40}$/u.test(String(candidate?.source_revision || "")), "release-candidate-source-missing");
  bindings.sort((left?: any, right?: any) : any => left.plan.localeCompare(right.plan));
  try {
    await verifyPlan({ repoRoot, writeReport: false, requireCompletedReceipts: false });
  } catch {
    throw new PlatformAcceptancePlanReceiptError("completed-plan-receipt-stale", "failed");
  }
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:platform-acceptance-plan-receipts-1",
    releaseAcceptancePlan: RELEASE_ACCEPTANCE_PLAN,
    selectedProfile,
    planProfile,
    candidateDigest,
    requiredReceiptCount: requiredReceipts.length,
    requiredCheckpointCount: checkpointBindings.length,
    bindings,
    checkpointBindings,
    planReceiptSetDigest: reportPayloadDigest({ candidateDigest, bindings, checkpointBindings }),
  });
}
