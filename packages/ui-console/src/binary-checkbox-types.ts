export type BinaryCheckboxProps = {
  modelValue: boolean;
  label: string;
  disabled?: boolean;
  readonly?: boolean;
};

export type BinaryCheckboxEmits = {
  "update:modelValue": [value: boolean];
  change: [value: boolean];
};
