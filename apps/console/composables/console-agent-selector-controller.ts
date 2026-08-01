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
  const selectedValue: any = String(value || "").trim();
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
  return options.find((item?: any) : any => item.value === selectedValue) || inactiveAgentModelOption(selectedValue);
}

export function createConsoleAgentSelectorController(
  options: ConsoleAgentSelectorControllerOptions,
) : any {
  const agentSelectorOptions: any = computed<AgentSelectorUiOption[]>(() : any =>
    (options.consoleState.value?.agentSelector?.options || []).map(normalizeAgentSelectorOption),
  );

  function agentOptionsForModule(moduleId: string) : any {
    return agentSelectorOptions.value.filter((option?: any) : any =>
      option.moduleIds.includes("*") || option.moduleIds.includes(moduleId),
    );
  }

  const gatewayAssistantAgentOptions: any = computed(() : any => agentOptionsForModule("agentTools"));

  const agentModelOptionValueSet: any = computed(
    () : any => new Set<any>(agentSelectorOptions.value.map((item?: any) : any => item.value)),
  );

  function hasAgentModelOption(value?: string) : any {
    const normalized: any = String(value || "").trim();
    return Boolean(normalized && agentModelOptionValueSet.value.has(normalized));
  }

  function validAgentModelAlias(value?: string) : any {
    const normalized: any = String(value || "").trim();
    return hasAgentModelOption(normalized) ? normalized : "";
  }

  function currentAgentModelOptionLabel(value?: string) : any {
    const normalized: any = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    return agentSelectorOptions.value.find((item?: any) : any => item.value === normalized)?.label ||
      options.agentModelOptionLabelCache.value[normalized] ||
      "";
  }

  function cacheAgentModelOptionLabels(items: Array<{ value: string; label?: string }>) : any {
    const next: Record<string, string> = {};
    for (const item of items) {
      const value: any = String(item.value || "").trim();
      const label: any = String(item.label || "").trim();
      if (value && label) {
        next[value] = label;
      }
    }
    options.agentModelOptionLabelCache.value = next;
  }

  const selectedGatewayAssistantModel: any = computed(() : any =>
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
