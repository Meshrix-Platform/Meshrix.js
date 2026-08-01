export const DEPENDENCY_MAP_SCHEMA_VERSION: any = 3;
export const ENTERPRISE_SINGLE_NODE_PROFILE: any = "enterprise-single-node";
export const PLAN_PROFILES: readonly any[] = Object.freeze([ENTERPRISE_SINGLE_NODE_PROFILE]);
export const PLAN_PROFILE_SET: any = new Set<any>(PLAN_PROFILES);

export const PLAN_SHARED_STATE_AUTHORITY: Readonly<Record<string, any>> = Object.freeze({
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

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

function isRecord(value?: any) : any {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizePlanProfiles(value?: any, message: any = "Plan profiles are invalid") : any {
  requireCondition(Array.isArray(value) && value.length > 0, message);
  const profiles: any = value.map((profile?: any) : any => {
    requireCondition(typeof profile === "string" && PLAN_PROFILE_SET.has(profile), message);
    return profile;
  });
  requireCondition(new Set<any>(profiles).size === profiles.length, message);
  return [...profiles].sort();
}

export function profilesEqual(left?: any, right?: any) : any {
  try {
    return JSON.stringify(normalizePlanProfiles(left)) === JSON.stringify(normalizePlanProfiles(right));
  } catch {
    return false;
  }
}

export function profilesContain(container?: any, subset?: any) : any {
  const available: any = new Set<any>(normalizePlanProfiles(container));
  return normalizePlanProfiles(subset).every((profile?: any) : any => available.has(profile));
}

export function assertCurrentDependencyMapShape(dependencyMap?: any) : any {
  requireCondition(
    isRecord(dependencyMap) &&
      dependencyMap.schema_version === DEPENDENCY_MAP_SCHEMA_VERSION &&
      Array.isArray(dependencyMap.plans),
    "DependencyMap schema version is not current",
  );
  for (const plan of dependencyMap.plans) {
    requireCondition(isRecord(plan), "DependencyMap Plan entry is malformed");
    requireCondition(Array.isArray(plan.final_validations) && plan.final_validations.length > 0,
      "Plan final-validations are missing");
    requireCondition(Array.isArray(plan.parent_integrations), "Plan parent integrations are missing");
    requireCondition(
      isRecord(plan.accepted_final_receipts) && !Array.isArray(plan.accepted_final_receipts),
      "Plan accepted final receipts must be keyed by final node",
    );
  }
  return dependencyMap;
}

export function finalValidationBindings(mapPlan?: any) : any {
  requireCondition(isRecord(mapPlan) && Array.isArray(mapPlan.final_validations),
    "Plan final-validations are missing");
  const nodeIds: any = new Set<any>();
  const claimedProfiles: any = new Set<any>();
  return mapPlan.final_validations.map((binding?: any) : any => {
    requireCondition(
      isRecord(binding) && typeof binding.node_id === "string" && binding.node_id.length > 0,
      "Plan final-validation binding is malformed",
    );
    requireCondition(!nodeIds.has(binding.node_id), "Plan has a duplicate final-validation node");
    nodeIds.add(binding.node_id);
    const profiles: any = normalizePlanProfiles(binding.profiles, "Plan final-validation profiles are invalid");
    for (const profile of profiles) {
      requireCondition(!claimedProfiles.has(profile), "Plan profile has multiple final-validation owners");
      claimedProfiles.add(profile);
    }
    return Object.freeze({ node_id: binding.node_id, profiles: Object.freeze(profiles) });
  });
}

export function finalValidationBinding(mapPlan?: any, finalNodeId?: any) : any {
  const binding: any = finalValidationBindings(mapPlan).find((candidate?: any) : any => candidate.node_id === finalNodeId);
  requireCondition(binding, "Final node identity is mismatched");
  return binding;
}

export function finalValidationBindingForProfile(mapPlan?: any, profile?: any) : any {
  normalizePlanProfiles([profile], "Plan profile is invalid");
  const matches: any = finalValidationBindings(mapPlan)
    .filter((binding?: any) : any => binding.profiles.includes(profile));
  requireCondition(matches.length === 1, "Plan profile does not have exactly one final-validation owner");
  return matches[0];
}

export function parentIntegrationBinding(mapPlan?: any, finalNodeId?: any) : any {
  requireCondition(Array.isArray(mapPlan?.parent_integrations), "Plan parent integrations are missing");
  const matches: any = mapPlan.parent_integrations.filter(
    (binding?: any) : any => isRecord(binding) && binding.child_final_node_id === finalNodeId,
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
  const finalBinding: any = finalValidationBinding(mapPlan, finalNodeId);
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

export function acceptedFinalReceipt(mapPlan?: any, finalNodeId?: any) : any {
  requireCondition(isRecord(mapPlan?.accepted_final_receipts),
    "Plan accepted final receipts must be keyed by final node");
  return mapPlan.accepted_final_receipts[finalNodeId];
}

export function setAcceptedFinalReceipt(mapPlan?: any, finalNodeId?: any, receipt?: any) : any {
  finalValidationBinding(mapPlan, finalNodeId);
  requireCondition(isRecord(mapPlan.accepted_final_receipts),
    "Plan accepted final receipts must be keyed by final node");
  mapPlan.accepted_final_receipts[finalNodeId] = receipt;
}

export function acceptedFinalReceiptEntries(mapPlan?: any) : any {
  const bindings: any = finalValidationBindings(mapPlan);
  requireCondition(isRecord(mapPlan.accepted_final_receipts),
    "Plan accepted final receipts must be keyed by final node");
  const known: any = new Set<any>(bindings.map((binding?: any) : any => binding.node_id));
  requireCondition(
    Object.keys(mapPlan.accepted_final_receipts).every((nodeId?: any) : any => known.has(nodeId)),
    "Plan accepted final receipts contain an unknown final node",
  );
  return bindings.map((binding?: any) : any => ({
    binding,
    receipt: mapPlan.accepted_final_receipts[binding.node_id],
  }));
}

export function planReceiptKey(plan?: any, nodeId?: any, kind: any = "final_validation") : any {
  return `${plan}\u0000${nodeId}\u0000${kind}`;
}
