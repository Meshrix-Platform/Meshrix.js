export interface StateMachineGuardDefinition {
  guardId: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  contextRequired: readonly string[];
  runtimeMode?: "staticOnly" | "declaredOnly";
}

export const STATE_MACHINE_GUARDS: Readonly<Record<string, StateMachineGuardDefinition>> = Object.freeze({
  require_p0_passed_or_waived: {
    guardId: "require_p0_passed_or_waived",
    description:
      "All P0 production readiness scopes must be passed or explicitly waived.",
    riskLevel: "high",
    contextRequired: ["readinessReport"]
  },

  require_baseline_v0_1_scopes_resolved: {
    guardId: "require_baseline_v0_1_scopes_resolved",
    description:
      "All baseline v0.1 scopes must be passed; out-of-baseline scopes must be explicitly classified.",
    riskLevel: "medium",
    contextRequired: ["readinessReport", "scopeRegistry"]
  },

  require_architect_approval: {
    guardId: "require_architect_approval",
    description:
      "Requires explicit human architect approval. Used for waiver approval decisions.",
    riskLevel: "high",
    contextRequired: ["approvalRecord"]
  },

  require_approval: {
    guardId: "require_approval",
    description: "Generic approval guard requiring a valid approval record.",
    riskLevel: "medium",
    contextRequired: ["approvalRecord"]
  },

  require_adoption_policy: {
    guardId: "require_adoption_policy",
    description:
      "Adoption must comply with contribution adoption policy rules.",
    riskLevel: "medium",
    contextRequired: ["adoptionPolicy"]
  },

  require_admin: {
    guardId: "require_admin",
    description: "Operation requires admin-level authorization.",
    riskLevel: "high",
    contextRequired: ["subjectPermissions"]
  },

  policyAllowed: {
    guardId: "policyAllowed",
    description: "Policy Engine must return an allow decision.",
    riskLevel: "high",
    contextRequired: ["policyDecision"]
  },

  appendOnly: {
    guardId: "appendOnly",
    description: "Operation must not delete or overwrite existing records.",
    riskLevel: "high",
    contextRequired: ["existingState"]
  },

  treeExists: {
    guardId: "treeExists",
    description: "Target checkpoint tree must exist before operating.",
    riskLevel: "low",
    contextRequired: ["treeState"]
  },

  nodeExists: {
    guardId: "nodeExists",
    description: "Target checkpoint node must exist before operating.",
    riskLevel: "low",
    contextRequired: ["nodeState"]
  },

  previewGenerated: {
    guardId: "previewGenerated",
    description: "Restore preview must be generated before applying.",
    riskLevel: "low",
    contextRequired: ["previewState"]
  },

  noApprovalRequired: {
    guardId: "noApprovalRequired",
    description:
      "Explicitly signals no approval is needed for this transition path.",
    riskLevel: "low",
    contextRequired: [],
    runtimeMode: "staticOnly"
  },

  approvalApproved: {
    guardId: "approvalApproved",
    description: "An approval record must exist in approved state.",
    riskLevel: "medium",
    contextRequired: ["approvalRecord"]
  },

  require_policy: {
    guardId: "require_policy",
    description: "Policy check must be performed and allow.",
    riskLevel: "high",
    contextRequired: ["policyDecision"]
  },

  require_ledger: {
    guardId: "require_ledger",
    description:
      "Operation ledger entry must exist in started or completed state.",
    riskLevel: "high",
    contextRequired: ["operationRecord"]
  },

  require_audit: {
    guardId: "require_audit",
    description: "Audit record must be present for this transition.",
    riskLevel: "medium",
    contextRequired: ["auditRecord"]
  }
});

export function guardExists(guardId?: unknown): boolean {
  return typeof guardId === "string" && guardId in STATE_MACHINE_GUARDS;
}

export function getGuard(guardId?: unknown): StateMachineGuardDefinition | null {
  return typeof guardId === "string" ? STATE_MACHINE_GUARDS[guardId] || null : null;
}

export function listAllGuardIds(): string[] {
  return Object.keys(STATE_MACHINE_GUARDS);
}

export function isGuardRuntimeSafe(guardId?: unknown): boolean {
  const guard = getGuard(guardId);
  if (!guard) return false;
  return guard.runtimeMode !== "staticOnly" && guard.runtimeMode !== "declaredOnly";
}

export function listAllRuntimeGuardIds(): string[] {
  return Object.entries(STATE_MACHINE_GUARDS)
    .filter(([, guard]) => guard.runtimeMode !== "staticOnly" && guard.runtimeMode !== "declaredOnly")
    .map(([id]) => id);
}

export function isStaticOnlyGuard(guardId?: unknown): boolean {
  const guard = getGuard(guardId);
  return guard?.runtimeMode === "staticOnly";
}
