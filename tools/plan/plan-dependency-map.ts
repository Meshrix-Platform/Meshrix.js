import {
  type DependencyMap,
  type DependencyMapPlan,
  type FinalValidationBinding,
  type JsonRecord,
  type ParentIntegrationBinding,
  type PlanProfile,
  isJsonRecord,
} from "./plan-types.ts";

export const DEPENDENCY_MAP_SCHEMA_VERSION  = 3;
export const ENTERPRISE_SINGLE_NODE_PROFILE  = "enterprise-single-node";
export const PLAN_PROFILES: readonly PlanProfile[] = Object.freeze([ENTERPRISE_SINGLE_NODE_PROFILE]);
export const PLAN_PROFILE_SET = new Set<PlanProfile>(PLAN_PROFILES);

export const PLAN_SHARED_STATE_AUTHORITY = Object.freeze({
  id: "plan-shared-state-authority",
  authority: Object.freeze({
    dependencyMap: "end-to-end-release/DependencyMap.json",
    checkpointOwner: "per-plan Checkpoints.json",
  }),
  transactional: Object.freeze({
    writeMode: "atomic-rename",
    receiptBinding: "final-node-key",
  }),
  releaseScope: Object.freeze({
    profileIsolation: "exact-receipt-match",
    crossProfilePromotion: "forbidden",
    supportedProfile: ENTERPRISE_SINGLE_NODE_PROFILE,
  }),
  migration: Object.freeze({
    supersededPaths: "removed-in-same-closure",
  }),
});

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isDependencyMapPlan(value: unknown): value is DependencyMapPlan {
  return isJsonRecord(value) &&
    typeof value.directory === "string" &&
    (typeof value.parent === "string" || value.parent === null) &&
    Array.isArray(value.children) &&
    Array.isArray(value.final_validations) &&
    Array.isArray(value.parent_integrations) &&
    Array.isArray(value.prerequisite_receipts) &&
    isJsonRecord(value.accepted_final_receipts);
}

export function normalizePlanProfiles(value: unknown, message = "Plan profiles are invalid"): PlanProfile[] {
  requireCondition(Array.isArray(value) && value.length > 0, message);
  const profiles = value.map((profile): PlanProfile => {
    requireCondition(profile === ENTERPRISE_SINGLE_NODE_PROFILE, message);
    return profile;
  });
  requireCondition(new Set(profiles).size === profiles.length, message);
  return [...profiles].sort();
}

export function profilesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizePlanProfiles(left)) === JSON.stringify(normalizePlanProfiles(right));
  } catch {
    return false;
  }
}

export function profilesContain(container: unknown, subset: unknown): boolean {
  const available = new Set<PlanProfile>(normalizePlanProfiles(container));
  return normalizePlanProfiles(subset).every((profile) => available.has(profile));
}

export function assertCurrentDependencyMapShape(dependencyMap: unknown): DependencyMap {
  requireCondition(
    isJsonRecord(dependencyMap) &&
      dependencyMap.schema_version === DEPENDENCY_MAP_SCHEMA_VERSION &&
      Array.isArray(dependencyMap.plans),
    "DependencyMap schema version is not current",
  );
  const plans: DependencyMapPlan[] = [];
  for (const plan of dependencyMap.plans) {
    requireCondition(isDependencyMapPlan(plan), "DependencyMap Plan entry is malformed");
    requireCondition(Array.isArray(plan.final_validations) && plan.final_validations.length > 0,
      "Plan final-validations are missing");
    requireCondition(Array.isArray(plan.parent_integrations), "Plan parent integrations are missing");
    requireCondition(
      isJsonRecord(plan.accepted_final_receipts),
      "Plan accepted final receipts must be keyed by final node",
    );
    plans.push(plan);
  }
  return { ...dependencyMap, schema_version: DEPENDENCY_MAP_SCHEMA_VERSION, plans };
}

export function finalValidationBindings(mapPlan: unknown): FinalValidationBinding[] {
  requireCondition(isDependencyMapPlan(mapPlan),
    "Plan final-validations are missing");
  const nodeIds = new Set<string>();
  const claimedProfiles = new Set<PlanProfile>();
  return mapPlan.final_validations.map((binding): FinalValidationBinding => {
    requireCondition(
      isJsonRecord(binding) && typeof binding.node_id === "string" && binding.node_id.length > 0,
      "Plan final-validation binding is malformed",
    );
    requireCondition(!nodeIds.has(binding.node_id), "Plan has a duplicate final-validation node");
    nodeIds.add(binding.node_id);
    const profiles  = normalizePlanProfiles(binding.profiles, "Plan final-validation profiles are invalid");
    for (const profile of profiles) {
      requireCondition(!claimedProfiles.has(profile), "Plan profile has multiple final-validation owners");
      claimedProfiles.add(profile);
    }
    return Object.freeze({ node_id: binding.node_id, profiles: Object.freeze(profiles) });
  });
}

export function finalValidationBinding(mapPlan: unknown, finalNodeId: unknown): FinalValidationBinding {
  const binding = finalValidationBindings(mapPlan).find((candidate) => candidate.node_id === finalNodeId);
  requireCondition(binding, "Final node identity is mismatched");
  return binding;
}

export function finalValidationBindingForProfile(mapPlan: unknown, profile: unknown): FinalValidationBinding {
  const [normalizedProfile] = normalizePlanProfiles([profile], "Plan profile is invalid");
  const matches  = finalValidationBindings(mapPlan)
    .filter((binding) => binding.profiles.includes(normalizedProfile));
  requireCondition(matches.length === 1, "Plan profile does not have exactly one final-validation owner");
  return matches[0];
}

export function parentIntegrationBinding(mapPlan: unknown, finalNodeId: unknown): ParentIntegrationBinding | null {
  requireCondition(isDependencyMapPlan(mapPlan) && typeof finalNodeId === "string", "Plan parent integrations are missing");
  const matches  = mapPlan.parent_integrations.filter(
    (binding) => isJsonRecord(binding) && binding.child_final_node_id === finalNodeId,
  );
  requireCondition(matches.length <= 1, "Plan final has duplicate parent integrations");
  if (mapPlan.parent === null) {
    requireCondition(matches.length === 0, "Root Plan must not declare parent integrations");
    return null;
  }
  requireCondition(matches.length === 1, "Plan final is missing its parent integration");
  const [binding] = matches;
  requireCondition(typeof binding.parent_node_id === "string" && binding.parent_node_id.length > 0,
    "Plan parent integration node is malformed");
  const finalBinding  = finalValidationBinding(mapPlan, finalNodeId);
  requireCondition(
    profilesEqual(binding.profiles, finalBinding.profiles),
    "Plan parent integration profiles do not match its child final",
  );
  return Object.freeze({
    child_final_node_id: finalNodeId,
    parent_node_id: binding.parent_node_id,
    profiles: Object.freeze(normalizePlanProfiles(binding.profiles)),
  });
}

export function acceptedFinalReceipt(mapPlan: unknown, finalNodeId: unknown): JsonRecord | null | undefined {
  requireCondition(isDependencyMapPlan(mapPlan) && typeof finalNodeId === "string",
    "Plan accepted final receipts must be keyed by final node");
  return mapPlan.accepted_final_receipts[finalNodeId];
}

export function setAcceptedFinalReceipt(mapPlan: unknown, finalNodeId: unknown, receipt: JsonRecord | null): void {
  finalValidationBinding(mapPlan, finalNodeId);
  requireCondition(isDependencyMapPlan(mapPlan) && typeof finalNodeId === "string",
    "Plan accepted final receipts must be keyed by final node");
  mapPlan.accepted_final_receipts[finalNodeId] = receipt;
}

export function acceptedFinalReceiptEntries(mapPlan: unknown): Array<{
  binding: FinalValidationBinding;
  receipt: JsonRecord | null | undefined;
}> {
  const bindings  = finalValidationBindings(mapPlan);
  requireCondition(isDependencyMapPlan(mapPlan),
    "Plan accepted final receipts must be keyed by final node");
  const known = new Set(bindings.map((binding) => binding.node_id));
  requireCondition(
    Object.keys(mapPlan.accepted_final_receipts).every((nodeId) => known.has(nodeId)),
    "Plan accepted final receipts contain an unknown final node",
  );
  return bindings.map((binding) => ({
    binding,
    receipt: mapPlan.accepted_final_receipts[binding.node_id],
  }));
}

export function planReceiptKey(plan: unknown, nodeId: unknown, kind = "final_validation"): string {
  return `${plan}\u0000${nodeId}\u0000${kind}`;
}
