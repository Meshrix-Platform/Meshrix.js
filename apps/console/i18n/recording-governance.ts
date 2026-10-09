import { currentConsoleLocale, resolveEffectiveConsoleLocale } from "./console-locale-state";

type LocalizedName = Readonly<{ zh: string; en: string }>;

export const RECORDING_GOVERNANCE_CATEGORIES: readonly string[] = Object.freeze([
  "content",
  "diagnostics",
  "execution_history",
  "governance_history",
  "usage"
]);

const categoryNames: Readonly<Record<string, LocalizedName>> = Object.freeze({
  content: { zh: "内容", en: "Content" },
  diagnostics: { zh: "诊断", en: "Diagnostics" },
  execution_history: { zh: "执行历史", en: "Execution history" },
  governance_history: { zh: "治理历史", en: "Governance history" },
  usage: { zh: "用量", en: "Usage" }
});

const obligationNames: Readonly<Record<string, LocalizedName>> = Object.freeze({
  optional: { zh: "可选记录", en: "Optional recording" },
  required_before_effect: { zh: "生效前必需", en: "Required before effect" }
});

const pendingReasonNames: Readonly<Record<string, LocalizedName>> = Object.freeze({
  category_disabled: { zh: "类别已停用", en: "Category disabled" },
  sink_write_failed: { zh: "汇集写入失败", en: "Sink write failed" },
  sink_unavailable: { zh: "汇集不可用", en: "Sink unavailable" },
  capacity_exceeded: { zh: "容量超限", en: "Capacity exceeded" }
});

function pick(value: LocalizedName | undefined, fallback: string): string {
  if (!value) return fallback;
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? value.en : value.zh;
}

export function recordingGovernanceText(zh: string, en: string): string {
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? en : zh;
}

export function recordingCategoryName(category: string): string {
  return pick(categoryNames[category], category || "—");
}

export function recordingObligationName(obligation: string): string {
  return pick(obligationNames[obligation], obligation || "—");
}

export function recordingPendingReasonName(reason: string): string {
  return pick(pendingReasonNames[reason], reason || "—");
}
