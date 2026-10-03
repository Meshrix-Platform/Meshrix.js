export type OptionBarValue = string | number | boolean;
export type OptionBarModelValue = OptionBarValue | OptionBarValue[];
export type OptionBarIcon = "moon" | "sun";
export type OptionBarSize = "large" | "default" | "small";

export type OptionBarOption = {
  value: OptionBarValue;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: OptionBarIcon;
  swatches?: string[];
};

export type OptionBarProps = {
  modelValue: OptionBarModelValue;
  options: OptionBarOption[];
  label?: string;
  placeholder?: string;
  multiple?: boolean;
  collapseTags?: boolean;
  collapseTagsTooltip?: boolean;
  filterable?: boolean;
  teleported?: boolean;
  persistent?: boolean;
  popperClass?: string;
  disabled?: boolean;
  clearable?: boolean;
  size?: OptionBarSize;
  /** Values treated as "no selection" by Element Plus; empty strings remain valid option values. */
  emptyValues?: Array<string | number | boolean | null | undefined>;
};

export type OptionBarEmits = {
  "update:modelValue": [value: OptionBarModelValue];
  change: [value: OptionBarModelValue];
};
