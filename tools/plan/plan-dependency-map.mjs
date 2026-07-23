export const DEPENDENCY_MAP_SCHEMA_VERSION = 3;
export const PLAN_PROFILES = Object.freeze(["local", "ha", "scale", "regional-dr"]);
export const PLAN_PROFILE_SET = new Set(PLAN_PROFILES);

const LEGACY_PLAN_FIELDS = Object.freeze([
  "accepted_final_receipt",
  "final_validation_node_id",
  "parent_integration_node_id",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizePlanProfiles(value, message = "Plan profiles are invalid") {
  requireCondition(Array.isArray(value) && value.length > 0, message);
  const profiles = value.map((profile) => {
    requireCondition(typeof profile === "string" && PLAN_PROFILE_SET.has(profile), message);
    return profile;
  });
  requireCondition(new Set(profiles).size === profiles.length, message);
  return [...profiles].sort();
}

export function profilesEqual(left, right) {
  try {
    return JSON.stringify(normalizePlanProfiles(left)) === JSON.stringify(normalizePlanProfiles(right));
  } catch {
    return false;
  }
}

export function profilesContain(container, subset) {
  const available = new Set(normalizePlanProfiles(container));
  return normalizePlanProfiles(subset).every((profile) => available.has(profile));
}

export function assertCurrentDependencyMapShape(dependencyMap) {
  requireCondition(
    isRecord(dependencyMap) &&
      dependencyMap.schema_version === DEPENDENCY_MAP_SCHEMA_VERSION &&
      Array.isArray(dependencyMap.plans),
    "DependencyMap schema version is not current",
  );
  for (const plan of dependencyMap.plans) {
    requireCondition(isRecord(plan), "DependencyMap Plan entry is malformed");
    requireCondition(
      LEGACY_PLAN_FIELDS.every((field) => !Object.hasOwn(plan, field)),
      "DependencyMap retains a superseded single-final field",
    );
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

export function finalValidationBindings(mapPlan) {
  requireCondition(isRecord(mapPlan) && Array.isArray(mapPlan.final_validations),
    "Plan final-validations are missing");
  const nodeIds = new Set();
  const claimedProfiles = new Set();
  return mapPlan.final_validations.map((binding) => {
    requireCondition(
      isRecord(binding) && typeof binding.node_id === "string" && binding.node_id.length > 0,
      "Plan final-validation binding is malformed",
    );
    requireCondition(!nodeIds.has(binding.node_id), "Plan has a duplicate final-validation node");
    nodeIds.add(binding.node_id);
    const profiles = normalizePlanProfiles(binding.profiles, "Plan final-validation profiles are invalid");
    for (const profile of profiles) {
      requireCondition(!claimedProfiles.has(profile), "Plan profile has multiple final-validation owners");
      claimedProfiles.add(profile);
    }
    return Object.freeze({ node_id: binding.node_id, profiles: Object.freeze(profiles) });
  });
}

export function finalValidationBinding(mapPlan, finalNodeId) {
  const binding = finalValidationBindings(mapPlan).find((candidate) => candidate.node_id === finalNodeId);
  requireCondition(binding, "Final node identity is mismatched");
  return binding;
}

export function finalValidationBindingForProfile(mapPlan, profile) {
  normalizePlanProfiles([profile], "Plan profile is invalid");
  const matches = finalValidationBindings(mapPlan)
    .filter((binding) => binding.profiles.includes(profile));
  requireCondition(matches.length === 1, "Plan profile does not have exactly one final-validation owner");
  return matches[0];
}

export function parentIntegrationBinding(mapPlan, finalNodeId) {
  requireCondition(Array.isArray(mapPlan?.parent_integrations), "Plan parent integrations are missing");
  const matches = mapPlan.parent_integrations.filter(
    (binding) => isRecord(binding) && binding.child_final_node_id === finalNodeId,
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
  const finalBinding = finalValidationBinding(mapPlan, finalNodeId);
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

export function acceptedFinalReceipt(mapPlan, finalNodeId) {
  requireCondition(isRecord(mapPlan?.accepted_final_receipts),
    "Plan accepted final receipts must be keyed by final node");
  return mapPlan.accepted_final_receipts[finalNodeId];
}

export function setAcceptedFinalReceipt(mapPlan, finalNodeId, receipt) {
  finalValidationBinding(mapPlan, finalNodeId);
  requireCondition(isRecord(mapPlan.accepted_final_receipts),
    "Plan accepted final receipts must be keyed by final node");
  mapPlan.accepted_final_receipts[finalNodeId] = receipt;
}

export function acceptedFinalReceiptEntries(mapPlan) {
  const bindings = finalValidationBindings(mapPlan);
  requireCondition(isRecord(mapPlan.accepted_final_receipts),
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

export function planReceiptKey(plan, nodeId, kind = "final_validation") {
  return `${plan}\u0000${nodeId}\u0000${kind}`;
}
