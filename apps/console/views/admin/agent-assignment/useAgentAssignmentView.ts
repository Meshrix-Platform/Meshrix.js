import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { AgentOption } from "../../../composables/agentModelOptionBarController";
import type { AgentSelectorUiOption } from "../../../composables/console-agent-selector-controller";
import type { IntelligentModuleDefinition } from "../../../composables/console-defaults";
import type { ModuleModelAssignmentSelectOption } from "../../../composables/console-option-bar-controller";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";
import type { AgentModelConfig, ModelProbeResponse } from "../../../lib/types";
import type { OptionBarOption } from "../../../types/app";

type DefaultAgentKey =
  | "gatewayReviewModelAlias"
  | "ruleAuthoringModelAlias"
  | "reviewFusionModelAlias";

const BATCH_PLACEHOLDER_VALUE: any = "__meshrix_agent_assignment_batch_placeholder__";

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

export function useAgentAssignmentView() : any {
  const {
    gatewayAssistantAgentOptions,
    gatewayAssistantForm,
    agentSelectorOptions,
    isBusy,
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
  const moduleDefinitions: any = intelligentModuleDefinitions as IntelligentModuleDefinition[];
  const selectOptionsForModule: any = moduleModelAssignmentSelectOptions as (
    moduleId: string,
  ) => ModuleModelAssignmentSelectOption[];
  const route: any = useRoute();
  const routeHighlightedConfigTarget: any = ref("");
  let routeHighlightTimer: number | null = null;
  const activeProbeScope: any = ref<"" | "capability" | "module">("");
  const capabilityProbeFailures: any = ref<AssignmentProbeFailure[]>([]);
  const moduleProbeFailures: any = ref<AssignmentProbeFailure[]>([]);
  const agentAssignmentSaving: any = computed(() : any => isBusy("settings") || Boolean(activeProbeScope.value));
  const capabilitySaveButtonText: any = computed(() : any => {
    if (activeProbeScope.value === "capability") {
      return "检测中";
    }
    return isBusy("settings") ? "保存中" : "保存";
  });
  const moduleSaveButtonText: any = computed(() : any => {
    if (activeProbeScope.value === "module") {
      return "检测中";
    }
    return isBusy("settings") ? "保存中" : "保存";
  });

  const routeConfigTarget: any = computed(() : any => {
    const rawTarget: any = route.query.configTarget;
    const target: any = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
    return String(target || "").trim();
  });

  const activeHighlightedConfigTarget: any = computed(() : any =>
    String(highlightedConfigTarget.value || routeHighlightedConfigTarget.value || "").trim(),
  );

  function configTargetIsHighlighted(targetId: string) : any {
    return activeHighlightedConfigTarget.value === targetId;
  }

  function clearRouteConfigHighlightTimer() : any {
    if (typeof window !== "undefined" && routeHighlightTimer) {
      window.clearTimeout(routeHighlightTimer);
    }
    routeHighlightTimer = null;
  }

  function configTargetElement(targetId: string) : any {
    if (typeof document === "undefined") {
      return null;
    }
    return (
      Array.from(document.querySelectorAll<HTMLElement>("[data-config-target]"))
        .find((element?: any) : any => element.dataset.configTarget === targetId) || null
    );
  }

  async function waitForNextFrame() : Promise<any> {
    if (typeof window === "undefined") {
      return;
    }
    await new Promise<void>((resolve?: any) : any => {
      window.requestAnimationFrame(() : any => resolve());
    });
  }

  async function revealRouteConfigTarget(targetId: string) : Promise<any> {
    const target: any = String(targetId || "").trim();
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
    routeHighlightTimer = window.setTimeout(() : any => {
      if (routeHighlightedConfigTarget.value === target) {
        routeHighlightedConfigTarget.value = "";
      }
      routeHighlightTimer = null;
    }, 4000);
  }

  watch(
    routeConfigTarget,
    (target?: any) : any => {
      void revealRouteConfigTarget(target);
    },
    { immediate: true },
  );

  function defaultAgentValue(key: DefaultAgentKey, fallback: any = "") : any {
    return String(settingsDraft.value.gatewayAssistantDefaults?.[key] || fallback || "").trim();
  }

  function setDefaultAgentValue(key: DefaultAgentKey, value: string) : any {
    capabilityProbeFailures.value = [];
    const modelAlias: any = String(value || "").trim();
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

  function selectedOptionStatus(options: Array<{ value?: unknown; enabled?: boolean }>, value: string) : any {
    const modelAlias: any = String(value || "").trim();
    if (!modelAlias) {
      return { label: "未分配", tone: "warning" };
    }
    const option: any = options.find((item?: any) : any => String(item.value || "").trim() === modelAlias);
    if (!option?.enabled) {
      return { label: "不可用", tone: "danger" };
    }
    return { label: "已分配", tone: "success" };
  }

  function optionValue(option: { value?: unknown }) : any {
    return String(option.value || "").trim();
  }

  function optionLabel(option: { value?: unknown; label?: string }) : any {
    return String(option.label || optionValue(option)).trim();
  }

  function optionIsEnabled(option: { enabled?: boolean; disabled?: boolean }) : any {
    return option.enabled !== false && option.disabled !== true;
  }

  const capabilityAssignments: any = computed<CapabilityAssignment[]>(() : any => [
    {
      id: "gateway-assistant-agent",
      title: "网关审计智能体",
      description: "网关审计默认智能体，负责规划工具调用、打开证据并生成回答。",
      value: defaultAgentValue("gatewayReviewModelAlias", gatewayAssistantForm.value.modelAlias),
      options: gatewayAssistantAgentOptions.value as AssignmentOption[],
      update: (value: string) : any => setDefaultAgentValue("gatewayReviewModelAlias", value),
    },
    {
      id: "rule-authoring-agent",
      title: "创建规则智能体",
      description: "规则生成对话模式的默认智能体，用于根据需求生成规则草稿。",
      value: defaultAgentValue("ruleAuthoringModelAlias", ruleAuthoringForm.value.modelAlias),
      options: ruleAuthoringModelOptions.value as AssignmentOption[],
      update: (value: string) : any => setDefaultAgentValue("ruleAuthoringModelAlias", value),
    },
    {
      id: "approval-flow-agent",
      title: "审批合并智能体",
      description: "审批流审批合并默认智能体，用于合并多路审计证据和结构化结果。",
      value: defaultAgentValue("reviewFusionModelAlias"),
      options: agentSelectorOptions.value as AssignmentOption[],
      update: (value: string) : any => setDefaultAgentValue("reviewFusionModelAlias", value),
    },
  ]);

  const assignedCapabilityCount: any = computed(() : any =>
    capabilityAssignments.value.filter((item?: any) : any => String(item.value || "").trim()).length,
  );

  const capabilityBatchValue: any = computed(() : any => {
    const values: any = capabilityAssignments.value.map((item?: any) : any => String(item.value || "").trim());
    const firstValue: any = values[0] || "";
    return firstValue && values.every((value?: any) : any => value === firstValue) ? firstValue : "";
  });

  const capabilityBatchOptions: any = computed(() : any => {
    const assignments: any = capabilityAssignments.value;
    if (!assignments.length) {
      return [];
    }
    const optionMaps: any = assignments.map((assignment?: any) : any =>
      new Map<any, any>(
        assignment.options
          .filter((option?: any) : any => optionValue(option) && optionIsEnabled(option))
          .map((option?: any) : any => [optionValue(option), option]),
      ),
    );
    const firstOptions: any = assignments[0]?.options || [];
    return firstOptions
      .filter((option?: any) : any => {
        const value: any = optionValue(option);
        return Boolean(value && optionMaps.every((optionMap?: any) : any => optionMap.has(value)));
      })
      .map((option?: any) : any => ({
        value: optionValue(option),
        label: optionLabel(option),
      }));
  });

  const capabilityBatchSelectValue: any = computed(() : any => capabilityBatchValue.value || BATCH_PLACEHOLDER_VALUE);
  const capabilityBatchSelectOptions: any = computed(() : any => [
    { value: BATCH_PLACEHOLDER_VALUE, label: "选择智能体", disabled: true },
    { value: "", label: "清空分配" },
    ...capabilityBatchOptions.value,
  ]);

  function applyCapabilityBatch(value: string | number | boolean | Array<string | number | boolean>) : any {
    const nextValue: any = Array.isArray(value) ? value[0] : value;
    const modelAlias: any = String(nextValue || "").trim();
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
      ...selectOptionsForModule(moduleId).map((option?: any) : any => ({
        value: option.value,
        label: option.label,
        disabled: !option.enabled,
      })),
    ];
  }

  const moduleBatchValue: any = computed(() : any => {
    const values: any = moduleDefinitions.map((moduleDefinition?: any) : any => moduleModelRef(moduleDefinition.id));
    const firstValue: any = values[0] || "";
    return firstValue && values.every((value?: any) : any => value === firstValue) ? firstValue : "";
  });

  const moduleBatchOptions: any = computed(() : any => {
    const moduleIds: any = moduleDefinitions.map((moduleDefinition?: any) : any => moduleDefinition.id);
    if (!moduleIds.length) {
      return [];
    }
    const optionMaps: any = moduleIds.map((moduleId?: any) : any =>
      new Map<any, any>(
        selectOptionsForModule(moduleId)
          .filter((option?: any) : any => option.value && option.enabled)
          .map((option?: any) : any => [String(option.value || "").trim(), option]),
      ),
    );
    return selectOptionsForModule(moduleIds[0] || "")
      .filter((option?: any) : any => {
        const value: any = String(option.value || "").trim();
        return Boolean(value && option.enabled && optionMaps.every((optionMap?: any) : any => optionMap.has(value)));
      })
      .map((option?: any) : any => ({
        value: String(option.value || "").trim(),
        label: option.label,
      }));
  });

  const moduleBatchSelectValue: any = computed(() : any => moduleBatchValue.value || BATCH_PLACEHOLDER_VALUE);
  const moduleBatchSelectOptions: any = computed(() : any => [
    { value: BATCH_PLACEHOLDER_VALUE, label: "选择智能体", disabled: true },
    { value: "", label: "清空分配" },
    ...moduleBatchOptions.value,
  ]);

  function applyModuleBatch(value: string | number | boolean | Array<string | number | boolean>) : any {
    moduleProbeFailures.value = [];
    const nextValue: any = Array.isArray(value) ? value[0] : value;
    const refValue: any = String(nextValue || "").trim();
    if (refValue === BATCH_PLACEHOLDER_VALUE) {
      return;
    }
    for (const moduleDefinition of moduleDefinitions) {
      setModuleModelRef(moduleDefinition.id, refValue);
    }
  }

  function updateModuleEnabled(moduleId: string, enabled: boolean) : any {
    moduleProbeFailures.value = [];
    setModuleNeedsIntelligence(moduleId, enabled);
    if (!enabled) {
      setModuleModelRef(moduleId, "");
    }
  }

  function updateModuleModelRef(moduleId: string, value: string) : any {
    moduleProbeFailures.value = [];
    setModuleModelRef(moduleId, value);
  }

  function moduleStatus(moduleId: string) : any {
    if (!moduleNeedsIntelligence(moduleId)) {
      return { label: "已关闭", tone: "neutral" };
    }
    return moduleModelRef(moduleId)
      ? { label: "已分配", tone: "success" }
      : { label: "未分配", tone: "warning" };
  }

  function moduleRequirementLabel(alertRequired?: boolean) : any {
    return alertRequired === false ? "可选" : "建议分配";
  }

  function modelEntryIdentityValues(entry: AgentModelConfig) : any {
    return [
      modelEntryStatusKey(entry),
      entry.uid,
      entry.instanceId,
      entry.alias,
    ]
      .map((item?: any) : any => String(item || "").trim())
      .filter(Boolean);
  }

  function modelEntryDisplayLabel(entry: AgentModelConfig) : any {
    const name: any = String(entry.label || entry.agentName || entry.alias || modelEntryStatusKey(entry)).trim();
    const modelName: any = String(entry.model || entry.engine || "").trim();
    return modelName && modelName !== name ? `${name} · ${modelName}` : name;
  }

  function resolveModelEntry(value: string) : any {
    const normalized: any = String(value || "").trim();
    if (!normalized) {
      return null;
    }
    const directMatch: any = (visibleModelEntries.value as AgentModelConfig[]).find((entry?: any) : any =>
      modelEntryIdentityValues(entry).includes(normalized),
    );
    if (directMatch) {
      return directMatch;
    }
    const parsed: any = parseModelRef(normalized);
    if (!parsed.provider && !parsed.model) {
      return null;
    }
    return (visibleModelEntries.value as AgentModelConfig[]).find((entry?: any) : any =>
      String(entry.provider || "").trim() === parsed.provider &&
        modelEntryIdentityValues(entry).includes(parsed.model),
    ) || null;
  }

  function addProbeTarget(
    targets: Map<string, AssignmentProbeTarget>,
    value: string,
    usageLabel: string,
    fallbackLabel: string,
  ) : any {
    const normalized: any = String(value || "").trim();
    if (!normalized) {
      return;
    }
    const entry: any = resolveModelEntry(normalized);
    const key: any = entry ? modelEntryStatusKey(entry) : normalized;
    const current: any = targets.get(key);
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

  function formatProbeFailure(target: AssignmentProbeTarget, result?: ModelProbeResponse | null, fallback: any = "") : any {
    const usageText: any = target.usageLabels.length ? `（用于：${target.usageLabels.join("、")}）` : "";
    return {
      key: target.key,
      label: `${target.label}${usageText}`,
      message: String(result?.message || fallback || "模型连通性检测失败。").trim(),
    };
  }

  async function probeAssignmentTargets(targets: AssignmentProbeTarget[]) : Promise<any> {
    const failures: AssignmentProbeFailure[] = [];
    await Promise.all(targets.map(async (target?: any) : Promise<any> => {
      if (!target.entry) {
        failures.push(formatProbeFailure(target, null, "未找到对应的大模型配置。"));
        return;
      }
      try {
        const result: any = await runModelEntryProbe(target.entry);
        if (!result.ok) {
          failures.push(formatProbeFailure(target, result));
        }
      } catch (nextError: any) {
        const message: any = nextError instanceof Error ? nextError.message : "模型连通性检测失败。";
        failures.push(formatProbeFailure(target, null, message));
      }
    }));
    return failures.sort((left?: any, right?: any) : any => left.label.localeCompare(right.label, "zh-CN"));
  }

  async function saveAssignmentsAfterProbe(
    scope: "capability" | "module",
    targets: AssignmentProbeTarget[],
    failureRef: typeof capabilityProbeFailures,
  ) : Promise<any> {
    if (activeProbeScope.value || isBusy("settings")) {
      return;
    }
    activeProbeScope.value = scope;
    failureRef.value = [];
    error.value = "";
    try {
      const failures: any = await probeAssignmentTargets(targets);
      if (failures.length) {
        failureRef.value = failures;
        error.value = `智能体分配保存前连通性检测失败：${failures.map((item?: any) : any => item.label).join("、")}`;
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

  function capabilityProbeTargets() : any {
    const targets: any = new Map<string, AssignmentProbeTarget>();
    for (const assignment of capabilityAssignments.value) {
      const value: any = String(assignment.value || "").trim();
      if (!value) {
        continue;
      }
      const label: any = optionLabel(assignment.options.find((option?: any) : any => optionValue(option) === value) || { value });
      addProbeTarget(targets, value, assignment.title, label);
    }
    return [...targets.values()];
  }

  function moduleProbeTargets() : any {
    const targets: any = new Map<string, AssignmentProbeTarget>();
    for (const moduleDefinition of moduleDefinitions) {
      if (!moduleNeedsIntelligence(moduleDefinition.id)) {
        continue;
      }
      const value: any = moduleModelRef(moduleDefinition.id);
      if (!value) {
        continue;
      }
      const option: any = moduleAssignmentOptions(moduleDefinition.id).find((item?: any) : any => String(item.value || "").trim() === value);
      addProbeTarget(targets, value, moduleDefinition.label, String(option?.label || value).trim());
    }
    return [...targets.values()];
  }

  async function saveCapabilityAssignments() : Promise<any> {
    await saveAssignmentsAfterProbe("capability", capabilityProbeTargets(), capabilityProbeFailures);
  }

  async function saveModuleAssignments() : Promise<any> {
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
