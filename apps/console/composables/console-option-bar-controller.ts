import { computed, type ComputedRef, type Ref } from "vue";
import type { ConsoleAuthSummary } from "../lib/auth-types";
import type { OptionBarOption, OptionBarValue } from "../types/app";

type ModelProviderOption = {
  id: OptionBarValue;
  label: string;
};

type ModuleModelAssignmentOption = {
  ref: string;
  label: string;
  provider: string;
  enabled: boolean;
};

type ConsoleOptionBarControllerOptions = {
  addableModelProviders: ComputedRef<readonly ModelProviderOption[]>;
  authState: Ref<ConsoleAuthSummary | null>;
  moduleModelAssignmentOptions: (moduleId: string) => ModuleModelAssignmentOption[];
  providerLabel: (provider: string) => string;
};

export type ModuleModelAssignmentSelectOption = OptionBarOption & {
  enabled: boolean;
  disabledReason: string;
};

export function createConsoleOptionBarController(
  options: ConsoleOptionBarControllerOptions,
) : any {
  const enabledBooleanOptionBarOptions: OptionBarOption[] = [
    { value: true, label: "开启" },
    { value: false, label: "关闭" },
  ];
  const plannerModeOptionBarOptions: OptionBarOption[] = [
    { value: "fixed_runbook", label: "fixed_runbook" },
    { value: "gateway", label: "gateway" },
  ];
  const autoApproveRiskOptionBarOptions: OptionBarOption[] = [
    { value: "safe_write", label: "safe_write" },
    { value: "read_only", label: "read_only" },
  ];
  const moduleAccessModeOptionBarOptions: OptionBarOption[] = [
    { value: "all", label: "默认公开给所有功能" },
    { value: "selected", label: "仅公开给选定功能" },
  ];
  const addableModelProviderOptionBarOptions: any = computed<OptionBarOption[]>(() : any =>
    options.addableModelProviders.value.map((provider?: any) : any => ({
      value: provider.id,
      label: provider.label,
    })),
  );
  const authRoleOptionBarOptions: any = computed<OptionBarOption[]>(() : any =>
    (options.authState.value?.roles || []).map((role?: any) : any => ({
      value: role.roleId,
      label: role.label,
    })),
  );

  function moduleModelAssignmentSelectOptions(
    moduleId: string,
  ): ModuleModelAssignmentSelectOption[] {
    return options.moduleModelAssignmentOptions(moduleId).map((model?: any) : any => ({
      value: model.ref,
      label: `${model.label} / ${options.providerLabel(model.provider)}`,
      enabled: model.enabled,
      disabledReason: "未配置",
    }));
  }

  return {
    addableModelProviderOptionBarOptions,
    authRoleOptionBarOptions,
    autoApproveRiskOptionBarOptions,
    enabledBooleanOptionBarOptions,
    moduleAccessModeOptionBarOptions,
    moduleModelAssignmentSelectOptions,
    plannerModeOptionBarOptions,
  };
}
