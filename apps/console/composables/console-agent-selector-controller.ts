import { computed } from "vue";
import type {
  AgentSelectorOption,
  ServerConsoleState,
} from "../lib/types";
import type { GatewayAssistantFormState } from "./console-gateway-assistant-utils";

type ReadonlyValue<T> = {
  readonly value: T;
};

type WritableValue<T> = {
  value: T;
};

export type AgentSelectorUiOption = AgentSelectorOption & {
  enabled: boolean;
  disabledReason: string;
};

type ConsoleAgentSelectorControllerOptions = {
  gatewayAssistantForm: ReadonlyValue<GatewayAssistantFormState>;
  agentModelOptionLabelCache: WritableValue<Record<string, string>>;
  consoleState: ReadonlyValue<ServerConsoleState | null>;
};

export function normalizeAgentSelectorOption(option: AgentSelectorOption): AgentSelectorUiOption {
  return {
    ...option,
    value: option.agentUid || option.value,
    enabled: option.selectable,
    disabledReason: option.reason || "",
  };
}

export function inactiveAgentModelOption(value?: string): AgentSelectorUiOption {
  return {
    value: String(value || "").trim(),
    agentUid: String(value || "").trim(),
    label: "已移除的智能体",
    provider: "",
    model: "",
    moduleIds: [],
    capabilities: [],
    status: "unconfigured",
    enabled: false,
    selectable: false,
    disabledReason: "已从智能体列表删除",
    reason: "已从智能体列表删除",
  };
}

export function selectedAgentFromOptions(
  options: AgentSelectorUiOption[],
  value?: string,
): AgentSelectorUiOption {
  const selectedValue = String(value || "").trim();
  if (!selectedValue) {
    return {
      value: "",
      agentUid: "",
      label: "未选择智能体",
      provider: "",
      model: "",
      moduleIds: [],
      capabilities: [],
      status: "unconfigured",
      enabled: false,
      selectable: false,
      disabledReason: "未分配",
      reason: "未分配",
    };
  }
  return options.find((item) => item.value === selectedValue) || inactiveAgentModelOption(selectedValue);
}

export function createConsoleAgentSelectorController(
  options: ConsoleAgentSelectorControllerOptions,
) {
  const agentSelectorOptions = computed<AgentSelectorUiOption[]>(() =>
    (options.consoleState.value?.agentSelector?.options || []).map(normalizeAgentSelectorOption),
  );

  function agentOptionsForModule(moduleId: string) {
    return agentSelectorOptions.value.filter((option) =>
      option.moduleIds.includes("*") || option.moduleIds.includes(moduleId),
    );
  }

  const gatewayAssistantAgentOptions = computed(() => agentOptionsForModule("agentTools"));

  const agentModelOptionValueSet = computed(
    () => new Set(agentSelectorOptions.value.map((item) => item.value)),
  );

  function hasAgentModelOption(value?: string) {
    const normalized = String(value || "").trim();
    return Boolean(normalized && agentModelOptionValueSet.value.has(normalized));
  }

  function validAgentModelAlias(value?: string) {
    const normalized = String(value || "").trim();
    return hasAgentModelOption(normalized) ? normalized : "";
  }

  function currentAgentModelOptionLabel(value?: string) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    return agentSelectorOptions.value.find((item) => item.value === normalized)?.label ||
      options.agentModelOptionLabelCache.value[normalized] ||
      "";
  }

  function cacheAgentModelOptionLabels(items: Array<{ value: string; label?: string }>) {
    const next: Record<string, string> = {};
    for (const item of items) {
      const value = String(item.value || "").trim();
      const label = String(item.label || "").trim();
      if (value && label) {
        next[value] = label;
      }
    }
    options.agentModelOptionLabelCache.value = next;
  }

  const selectedGatewayAssistantModel = computed(() =>
    selectedAgentFromOptions(gatewayAssistantAgentOptions.value, options.gatewayAssistantForm.value.modelAlias),
  );

  return {
    gatewayAssistantAgentOptions,
    agentModelOptionValueSet,
    agentOptionsForModule,
    agentSelectorOptions,
    cacheAgentModelOptionLabels,
    currentAgentModelOptionLabel,
    hasAgentModelOption,
    inactiveAgentModelOption,
    normalizeAgentSelectorOption,
    selectedGatewayAssistantModel,
    selectedAgentFromOptions,
    validAgentModelAlias,
  };
}
