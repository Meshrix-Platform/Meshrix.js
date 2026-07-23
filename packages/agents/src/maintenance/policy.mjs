import { maxRisk, normalizeRisk, riskRank } from "./config.mjs";

export function computePlanRisk(plan = {}) {
  return maxRisk(
    normalizeRisk(plan.risk),
    ...(Array.isArray(plan.steps) ? plan.steps.map((step) => step.risk) : [])
  );
}

export function planHashableShape(plan = {}) {
  return {
    intent: String(plan.intent || ""),
    summary: String(plan.summary || ""),
    risk: computePlanRisk(plan),
    steps: Array.isArray(plan.steps)
      ? plan.steps.map((step) => ({
          toolId: String(step.toolId || ""),
          input: step.input && typeof step.input === "object" ? step.input : {},
          risk: normalizeRisk(step.risk),
          reason: String(step.reason || "")
        }))
      : []
  };
}

export function evaluateMaintenancePlanPolicy({ plan = {}, config = {} } = {}) {
  const risk = computePlanRisk(plan);
  if (risk === "destructive") {
    return {
      ok: false,
      risk,
      requiresApproval: true,
      reason: "destructive 风险工具默认禁止由维护智能体执行。"
    };
  }

  const autoApproveRisk = normalizeRisk(config.autoApproveRisk || "safe_write", "safe_write");
  const requiresApproval =
    Boolean(plan.requiresApproval) || riskRank(risk) > riskRank(autoApproveRisk);

  return {
    ok: true,
    risk,
    requiresApproval,
    reason: requiresApproval
      ? plan.approvalReason || `${risk} 风险计划需要管理员批准。`
      : ""
  };
}

export function ensurePlanAllowed({ plan = {}, config = {} } = {}) {
  const policy = evaluateMaintenancePlanPolicy({ plan, config });
  if (!policy.ok) {
    throw new Error(policy.reason || "维护计划被策略拒绝。");
  }
  return policy;
}
