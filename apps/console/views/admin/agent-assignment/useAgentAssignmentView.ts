import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { AgentOption } from "../../../composables/agentModelOptionBarController";
import type { AgentSelectorUiOption } from "../../../composables/console-agent-selector-controller";
import type { IntelligentModuleDefinition } from "../../../composables/console-defaults";
import type { ModuleModelAssignmentSelectOption } from "../../../composables/console-option-bar-controller";
import { useServerConsoleShellContext } from "../../../composables/serverConsoleShellContext";
import type { AgentModelConfig, ModelProbeResponse } from "../../../lib/types";
import type { OptionBarOption } from "../../../types/app";

type DefaultAgentKey =
  | "gatewayReviewModelAlias"
  | "ruleAuthoringModelAlias"
  | "reviewFusionModelAlias";

const BATCH_PLACEHOLDER_VALUE = "__lico_agent_assignment_batch_placeholder__";

type AssignmentProbeFailure = {
  key: string;
  label: string;
  message: string;
};

type AssignmentProbeTarget = {
  key: string;
  label: string;
  entry: AgentModelConfig | null;
  usageLabels: string[];
};

type AssignmentOption = AgentOption | AgentSelectorUiOption;

type CapabilityAssignment = {
  id: string;
  title: string;
  description: string;
  value: string;
  options: AssignmentOption[];
  update: (value: string) => void;
};

export function useAgentAssignmentView() {
  const {
    gatewayAssistantAgentOptions,
    gatewayAssistantForm,
    agentSelectorOptions,
    busyKey,
    error,
    highlightedConfigTarget,
    intelligentModuleDefinitions,
    modelEntryStatusKey,
    moduleModelAssignmentSelectOptions,
    moduleModelAssignmentStats,
    moduleModelRef,
    moduleNeedsIntelligence,
    parseModelRef,
    ruleAuthoringForm,
    ruleAuthoringModelOptions,
    runModelEntryProbe,
    saveSettings,
    setModuleModelRef,
    setModuleNeedsIntelligence,
    settingsDraft,
    visibleModelEntries,
  } = useServerConsoleShellContext();
  const moduleDefinitions = intelligentModuleDefinitions as IntelligentModuleDefinition[];
  const selectOptionsForModule = moduleModelAssignmentSelectOptions as (
    moduleId: string,
  ) => ModuleModelAssignmentSelectOption[];
  const route = useRoute();
  const routeHighlightedConfigTarget = ref("");
  let routeHighlightTimer: number | null = null;
  const activeProbeScope = ref<"" | "capability" | "module">("");
  const capabilityProbeFailures = ref<AssignmentProbeFailure[]>([]);
  const moduleProbeFailures = ref<AssignmentProbeFailure[]>([]);
  const agentAssignmentSaving = computed(() => busyKey.value === "settings" || Boolean(activeProbeScope.value));
  const capabilitySaveButtonText = computed(() => {
    if (activeProbeScope.value === "capability") {
      return "检测中";
    }
    return busyKey.value === "settings" ? "保存中" : "保存";
  });
  const moduleSaveButtonText = computed(() => {
    if (activeProbeScope.value === "module") {
      return "检测中";
    }
    return busyKey.value === "settings" ? "保存中" : "保存";
  });

  const routeConfigTarget = computed(() => {
    const rawTarget = route.query.configTarget;
    const target = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
    return String(target || "").trim();
  });

  const activeHighlightedConfigTarget = computed(() =>
    String(highlightedConfigTarget.value || routeHighlightedConfigTarget.value || "").trim(),
  );

  function configTargetIsHighlighted(targetId: string) {
    return activeHighlightedConfigTarget.value === targetId;
  }

  function clearRouteConfigHighlightTimer() {
    if (typeof window !== "undefined" && routeHighlightTimer) {
      window.clearTimeout(routeHighlightTimer);
    }
    routeHighlightTimer = null;
  }

  function configTargetElement(targetId: string) {
    if (typeof document === "undefined") {
      return null;
    }
    return (
      Array.from(document.querySelectorAll<HTMLElement>("[data-config-target]"))
        .find((element) => element.dataset.configTarget === targetId) || null
    );
  }

  async function waitForNextFrame() {
    if (typeof window === "undefined") {
      return;
    }
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  async function revealRouteConfigTarget(targetId: string) {
    const target = String(targetId || "").trim();
    if (!target) {
      return;
    }
    clearRouteConfigHighlightTimer();
    routeHighlightedConfigTarget.value = target;
    await nextTick();
    await waitForNextFrame();
    configTargetElement(target)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    if (typeof window === "undefined") {
      return;
    }
    routeHighlightTimer = window.setTimeout(() => {
      if (routeHighlightedConfigTarget.value === target) {
        routeHighlightedConfigTarget.value = "";
      }
      routeHighlightTimer = null;
    }, 4000);
  }

  watch(
    routeConfigTarget,
    (target) => {
      void revealRouteConfigTarget(target);
    },
    { immediate: true },
  );

  function defaultAgentValue(key: DefaultAgentKey, fallback = "") {
    return String(settingsDraft.value.gatewayAssistantDefaults?.[key] || fallback || "").trim();
  }

  function setDefaultAgentValue(key: DefaultAgentKey, value: string) {
    capabilityProbeFailures.value = [];
    const modelAlias = String(value || "").trim();
    settingsDraft.value.gatewayAssistantDefaults = {
      ...settingsDraft.value.gatewayAssistantDefaults,
      [key]: modelAlias,
    };
    if (key === "gatewayReviewModelAlias") {
      gatewayAssistantForm.value.modelAlias = modelAlias;
    } else if (key === "ruleAuthoringModelAlias") {
      ruleAuthoringForm.value.modelAlias = modelAlias;
    }
  }

  function selectedOptionStatus(options: Array<{ value?: unknown; enabled?: boolean }>, value: string) {
    const modelAlias = String(value || "").trim();
    if (!modelAlias) {
      return { label: "未分配", tone: "warning" };
    }
    const option = options.find((item) => String(item.value || "").trim() === modelAlias);
    if (!option?.enabled) {
      return { label: "不可用", tone: "danger" };
    }
    return { label: "已分配", tone: "success" };
  }

  function optionValue(option: { value?: unknown }) {
    return String(option.value || "").trim();
  }

  function optionLabel(option: { value?: unknown; label?: string }) {
    return String(option.label || optionValue(option)).trim();
  }

  function optionIsEnabled(option: { enabled?: boolean; disabled?: boolean }) {
    return option.enabled !== false && option.disabled !== true;
  }

  const capabilityAssignments = computed<CapabilityAssignment[]>(() => [
    {
      id: "gateway-assistant-agent",
      title: "网关审计智能体",
      description: "网关审计默认智能体，负责规划工具调用、打开证据并生成回答。",
      value: defaultAgentValue("gatewayReviewModelAlias", gatewayAssistantForm.value.modelAlias),
      options: gatewayAssistantAgentOptions.value as AssignmentOption[],
      update: (value: string) => setDefaultAgentValue("gatewayReviewModelAlias", value),
    },
    {
      id: "rule-authoring-agent",
      title: "创建规则智能体",
      description: "规则生成对话模式的默认智能体，用于根据需求生成规则草稿。",
      value: defaultAgentValue("ruleAuthoringModelAlias", ruleAuthoringForm.value.modelAlias),
      options: ruleAuthoringModelOptions.value as AssignmentOption[],
      update: (value: string) => setDefaultAgentValue("ruleAuthoringModelAlias", value),
    },
    {
      id: "approval-flow-agent",
      title: "审批合并智能体",
      description: "审批流审批合并默认智能体，用于合并多路审计证据和结构化结果。",
      value: defaultAgentValue("reviewFusionModelAlias"),
      options: agentSelectorOptions.value as AssignmentOption[],
      update: (value: string) => setDefaultAgentValue("reviewFusionModelAlias", value),
    },
  ]);

  const assignedCapabilityCount = computed(() =>
    capabilityAssignments.value.filter((item) => String(item.value || "").trim()).length,
  );

  const capabilityBatchValue = computed(() => {
    const values = capabilityAssignments.value.map((item) => String(item.value || "").trim());
    const firstValue = values[0] || "";
    return firstValue && values.every((value) => value === firstValue) ? firstValue : "";
  });

  const capabilityBatchOptions = computed(() => {
    const assignments = capabilityAssignments.value;
    if (!assignments.length) {
      return [];
    }
    const optionMaps = assignments.map((assignment) =>
      new Map(
        assignment.options
          .filter((option) => optionValue(option) && optionIsEnabled(option))
          .map((option) => [optionValue(option), option]),
      ),
    );
    const firstOptions = assignments[0]?.options || [];
    return firstOptions
      .filter((option) => {
        const value = optionValue(option);
        return Boolean(value && optionMaps.every((optionMap) => optionMap.has(value)));
      })
      .map((option) => ({
        value: optionValue(option),
        label: optionLabel(option),
      }));
  });

  const capabilityBatchSelectValue = computed(() => capabilityBatchValue.value || BATCH_PLACEHOLDER_VALUE);
  const capabilityBatchSelectOptions = computed(() => [
    { value: BATCH_PLACEHOLDER_VALUE, label: "选择智能体", disabled: true },
    { value: "", label: "清空分配" },
    ...capabilityBatchOptions.value,
  ]);

  function applyCapabilityBatch(value: string | number | boolean | Array<string | number | boolean>) {
    const nextValue = Array.isArray(value) ? value[0] : value;
    const modelAlias = String(nextValue || "").trim();
    if (modelAlias === BATCH_PLACEHOLDER_VALUE) {
      return;
    }
    for (const assignment of capabilityAssignments.value) {
      assignment.update(modelAlias);
    }
  }

  function moduleAssignmentOptions(moduleId: string): OptionBarOption[] {
    return [
      { value: "", label: "未分配" },
      ...selectOptionsForModule(moduleId).map((option) => ({
        value: option.value,
        label: option.label,
        disabled: !option.enabled,
      })),
    ];
  }

  const moduleBatchValue = computed(() => {
    const values = moduleDefinitions.map((moduleDefinition) => moduleModelRef(moduleDefinition.id));
    const firstValue = values[0] || "";
    return firstValue && values.every((value) => value === firstValue) ? firstValue : "";
  });

  const moduleBatchOptions = computed(() => {
    const moduleIds = moduleDefinitions.map((moduleDefinition) => moduleDefinition.id);
    if (!moduleIds.length) {
      return [];
    }
    const optionMaps = moduleIds.map((moduleId) =>
      new Map(
        selectOptionsForModule(moduleId)
          .filter((option) => option.value && option.enabled)
          .map((option) => [String(option.value || "").trim(), option]),
      ),
    );
    return selectOptionsForModule(moduleIds[0] || "")
      .filter((option) => {
        const value = String(option.value || "").trim();
        return Boolean(value && option.enabled && optionMaps.every((optionMap) => optionMap.has(value)));
      })
      .map((option) => ({
        value: String(option.value || "").trim(),
        label: option.label,
      }));
  });

  const moduleBatchSelectValue = computed(() => moduleBatchValue.value || BATCH_PLACEHOLDER_VALUE);
  const moduleBatchSelectOptions = computed(() => [
    { value: BATCH_PLACEHOLDER_VALUE, label: "选择智能体", disabled: true },
    { value: "", label: "清空分配" },
    ...moduleBatchOptions.value,
  ]);

  function applyModuleBatch(value: string | number | boolean | Array<string | number | boolean>) {
    moduleProbeFailures.value = [];
    const nextValue = Array.isArray(value) ? value[0] : value;
    const refValue = String(nextValue || "").trim();
    if (refValue === BATCH_PLACEHOLDER_VALUE) {
      return;
    }
    for (const moduleDefinition of moduleDefinitions) {
      setModuleModelRef(moduleDefinition.id, refValue);
    }
  }

  function updateModuleEnabled(moduleId: string, enabled: boolean) {
    moduleProbeFailures.value = [];
    setModuleNeedsIntelligence(moduleId, enabled);
    if (!enabled) {
      setModuleModelRef(moduleId, "");
    }
  }

  function updateModuleModelRef(moduleId: string, value: string) {
    moduleProbeFailures.value = [];
    setModuleModelRef(moduleId, value);
  }

  function moduleStatus(moduleId: string) {
    if (!moduleNeedsIntelligence(moduleId)) {
      return { label: "已关闭", tone: "neutral" };
    }
    return moduleModelRef(moduleId)
      ? { label: "已分配", tone: "success" }
      : { label: "未分配", tone: "warning" };
  }

  function moduleRequirementLabel(alertRequired?: boolean) {
    return alertRequired === false ? "可选" : "建议分配";
  }

  function modelEntryIdentityValues(entry: AgentModelConfig) {
    return [
      modelEntryStatusKey(entry),
      entry.uid,
      entry.instanceId,
      entry.alias,
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  function modelEntryDisplayLabel(entry: AgentModelConfig) {
    const name = String(entry.label || entry.agentName || entry.alias || modelEntryStatusKey(entry)).trim();
    const modelName = String(entry.model || entry.engine || "").trim();
    return modelName && modelName !== name ? `${name} · ${modelName}` : name;
  }

  function resolveModelEntry(value: string) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return null;
    }
    const directMatch = (visibleModelEntries.value as AgentModelConfig[]).find((entry) =>
      modelEntryIdentityValues(entry).includes(normalized),
    );
    if (directMatch) {
      return directMatch;
    }
    const parsed = parseModelRef(normalized);
    if (!parsed.provider && !parsed.model) {
      return null;
    }
    return (visibleModelEntries.value as AgentModelConfig[]).find((entry) =>
      String(entry.provider || "").trim() === parsed.provider &&
        modelEntryIdentityValues(entry).includes(parsed.model),
    ) || null;
  }

  function addProbeTarget(
    targets: Map<string, AssignmentProbeTarget>,
    value: string,
    usageLabel: string,
    fallbackLabel: string,
  ) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return;
    }
    const entry = resolveModelEntry(normalized);
    const key = entry ? modelEntryStatusKey(entry) : normalized;
    const current = targets.get(key);
    if (current) {
      if (!current.usageLabels.includes(usageLabel)) {
        current.usageLabels.push(usageLabel);
      }
      return;
    }
    targets.set(key, {
      key,
      label: entry ? modelEntryDisplayLabel(entry) : fallbackLabel || normalized,
      entry,
      usageLabels: [usageLabel],
    });
  }

  function formatProbeFailure(target: AssignmentProbeTarget, result?: ModelProbeResponse | null, fallback = "") {
    const usageText = target.usageLabels.length ? `（用于：${target.usageLabels.join("、")}）` : "";
    return {
      key: target.key,
      label: `${target.label}${usageText}`,
      message: String(result?.message || fallback || "模型连通性检测失败。").trim(),
    };
  }

  async function probeAssignmentTargets(targets: AssignmentProbeTarget[]) {
    const failures: AssignmentProbeFailure[] = [];
    await Promise.all(targets.map(async (target) => {
      if (!target.entry) {
        failures.push(formatProbeFailure(target, null, "未找到对应的大模型配置。"));
        return;
      }
      try {
        const result = await runModelEntryProbe(target.entry);
        if (!result.ok) {
          failures.push(formatProbeFailure(target, result));
        }
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "模型连通性检测失败。";
        failures.push(formatProbeFailure(target, null, message));
      }
    }));
    return failures.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  }

  async function saveAssignmentsAfterProbe(
    scope: "capability" | "module",
    targets: AssignmentProbeTarget[],
    failureRef: typeof capabilityProbeFailures,
  ) {
    if (activeProbeScope.value || busyKey.value === "settings") {
      return;
    }
    activeProbeScope.value = scope;
    failureRef.value = [];
    error.value = "";
    try {
      const failures = await probeAssignmentTargets(targets);
      if (failures.length) {
        failureRef.value = failures;
        error.value = `智能体分配保存前连通性检测失败：${failures.map((item) => item.label).join("、")}`;
        return;
      }
      activeProbeScope.value = "";
      await saveSettings();
    } finally {
      if (activeProbeScope.value === scope) {
        activeProbeScope.value = "";
      }
    }
  }

  function capabilityProbeTargets() {
    const targets = new Map<string, AssignmentProbeTarget>();
    for (const assignment of capabilityAssignments.value) {
      const value = String(assignment.value || "").trim();
      if (!value) {
        continue;
      }
      const label = optionLabel(assignment.options.find((option) => optionValue(option) === value) || { value });
      addProbeTarget(targets, value, assignment.title, label);
    }
    return [...targets.values()];
  }

  function moduleProbeTargets() {
    const targets = new Map<string, AssignmentProbeTarget>();
    for (const moduleDefinition of moduleDefinitions) {
      if (!moduleNeedsIntelligence(moduleDefinition.id)) {
        continue;
      }
      const value = moduleModelRef(moduleDefinition.id);
      if (!value) {
        continue;
      }
      const option = moduleAssignmentOptions(moduleDefinition.id).find((item) => String(item.value || "").trim() === value);
      addProbeTarget(targets, value, moduleDefinition.label, String(option?.label || value).trim());
    }
    return [...targets.values()];
  }

  async function saveCapabilityAssignments() {
    await saveAssignmentsAfterProbe("capability", capabilityProbeTargets(), capabilityProbeFailures);
  }

  async function saveModuleAssignments() {
    await saveAssignmentsAfterProbe("module", moduleProbeTargets(), moduleProbeFailures);
  }

  return {
    agentAssignmentSaving,
    assignedCapabilityCount,
    capabilityAssignments,
    capabilityBatchSelectOptions,
    capabilityBatchSelectValue,
    capabilityProbeFailures,
    capabilitySaveButtonText,
    configTargetIsHighlighted,
    intelligentModuleDefinitions: moduleDefinitions,
    moduleAssignmentOptions,
    moduleBatchSelectOptions,
    moduleBatchSelectValue,
    moduleModelAssignmentStats,
    moduleModelRef,
    moduleNeedsIntelligence,
    moduleProbeFailures,
    moduleRequirementLabel,
    moduleSaveButtonText,
    moduleStatus,
    applyCapabilityBatch,
    applyModuleBatch,
    saveCapabilityAssignments,
    saveModuleAssignments,
    selectedOptionStatus,
    updateModuleEnabled,
    updateModuleModelRef,
  };
}
