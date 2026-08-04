import { computed, reactive, type ComputedRef } from "vue";

// Keyed per-field error store for ONE form instance. Field names are the
// single source of truth: ConsoleFormField renders the `error` prop fed by
// fieldError(name), and form-level projections (submit gating, tab badges)
// read `errors` and `hasErrors`. Nothing global — create one store per form.

export type ConsoleFormValidation = {
  errors: Record<string, string>;
  setFieldError: (field: string, message: string) => void;
  clearFieldError: (field: string) => void;
  fieldError: (field: string) => string;
  hasErrors: ComputedRef<boolean>;
};

export function createConsoleFormValidation(): ConsoleFormValidation {
  const errors: Record<string, string> = reactive({});

  function setFieldError(field: string, message: string): void {
    errors[field] = message;
  }

  function clearFieldError(field: string): void {
    // Clearing a field that has no error is a deliberate no-op.
    delete errors[field];
  }

  function fieldError(field: string): string {
    return errors[field] || "";
  }

  const hasErrors: ComputedRef<boolean> = computed(
    () : boolean => Object.keys(errors).length > 0,
  );

  return {
    errors,
    setFieldError,
    clearFieldError,
    fieldError,
    hasErrors,
  };
}
