export function ruleAuthoringStatusLabel(status: unknown) {
  const value = String(status || "");
  if (value === "pending_human_confirmation") return "待人类确认";
  if (value === "no_rule_needed") return "未触发规则";
  if (value === "gate_failed") return "门禁未通过";
  if (value === "template_unavailable") return "模板不可用";
  if (value === "invalid_input") return "输入无效";
  if (value === "runtime_unavailable") return "运行时不可用";
  if (value === "published") return "已发布";
  return value || "未知";
}
