import { computed } from "vue";
import { navigateBrowserHashRoute } from "@meshrix/ui-console/browser-window";

export type AgentOptionValue = string | number | boolean;

export type AgentOption = {
  agentUid?: string;
  value?: AgentOptionValue;
  label?: string;
  selectable?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  reason?: string;
  disabledReason?: string;
  status?: string;
};

export type AgentModelOptionBarProps = {
  modelValue?: AgentOptionValue;
  options: AgentOption[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  includeEmpty?: boolean;
  emptyLabel?: string;
  showDisabledReason?: boolean;
  filterable?: boolean;
  teleported?: boolean;
  persistent?: boolean;
  popperClass?: string;
  clearable?: boolean;
  size?: string;
  emptyLibraryLabel?: string;
  emptyLibraryRoute?: string;
  emptyLibraryActionIcon?: string;
};

export type AgentModelOptionBarEmits = {
  (event: "update:modelValue", value: AgentOptionValue): void;
  (event: "change", value: AgentOptionValue): void;
};

export const EMPTY_MODEL_LIBRARY_ACTION: any = "__meshrix_empty_model_library_action__";

function normalizedValue(option: AgentOption) : any {
  return option.agentUid ?? option.value ?? "";
}

function optionDisabled(option: AgentOption) : any {
  return option.disabled === true || option.selectable === false || option.enabled === false;
}

export function useAgentModelOptionBarController(
  props: Readonly<AgentModelOptionBarProps>,
  emit: AgentModelOptionBarEmits,
) : any {
  function normalizedLabel(option: AgentOption) : any {
    const label: any = String(option.label || normalizedValue(option) || "").trim();
    if (!props.showDisabledReason || !optionDisabled(option)) {
      return label;
    }
    const reason: any = String(option.reason || option.disabledReason || "").trim();
    return reason ? `${label}（${reason}）` : `${label}（不可用）`;
  }

  const selectOptions: any = computed(() : any => {
    const seen: any = new Set<string>();
    return (props.options || [])
      .map((option?: any) : any => ({
        value: normalizedValue(option),
        label: normalizedLabel(option),
        disabled: optionDisabled(option),
      }))
      .filter((option?: any) : any => {
        const key: any = String(option.value || "").trim();
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  });

  const hasConfiguredOptions: any = computed(() : any => selectOptions.value.length > 0);
  const selectValue: any = computed(() : any =>
    hasConfiguredOptions.value ? String(props.modelValue ?? "") : EMPTY_MODEL_LIBRARY_ACTION,
  );
  const emptyLibraryActionLabel: any = computed(() : any =>
    [props.emptyLibraryActionIcon, props.emptyLibraryLabel]
      .map((item?: any) : any => String(item || "").trim())
      .filter(Boolean)
      .join(" "),
  );

  function emitValue(value: AgentOptionValue) : any {
    emit("update:modelValue", value);
    emit("change", value);
  }

  function navigateToModelLibrary() : any {
    const route: any = String(props.emptyLibraryRoute || "/admin/agent-config").trim();
    if (!route) return;
    navigateBrowserHashRoute(route, "/admin/agent-config");
  }

  function handleChange(event: Event) : any {
    const value: any = (event.target as HTMLSelectElement | null)?.value || "";
    if (value === EMPTY_MODEL_LIBRARY_ACTION) {
      navigateToModelLibrary();
      return;
    }
    emitValue(value);
  }

  function handleSelectClick() : any {
    if (!hasConfiguredOptions.value) {
      navigateToModelLibrary();
    }
  }

  function handleSelectKeydown(event: KeyboardEvent) : any {
    if (!hasConfiguredOptions.value && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      navigateToModelLibrary();
    }
  }

  return {
    emptyLibraryActionLabel,
    handleChange,
    handleSelectClick,
    handleSelectKeydown,
    hasConfiguredOptions,
    selectOptions,
    selectValue,
  };
}
