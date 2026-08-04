<script setup lang="ts">
import { computed, useSlots, type ComputedRef } from "vue";
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

// Accessible form-field primitive. Keeps the console's label-wrapping field
// markup (`<label><span>…</span><input …></label>`) so adoption does not force
// restyling, and wires the full label/for/id/aria contract around it.
//
// One control per field: the default slot must hold exactly ONE root control
// element, and the consumer applies the provided slot props to it
// (`v-slot="field"` + `v-bind="field"`). The control then receives the
// id/aria attrs by v-bind fallthrough — vnodes are never cloned.

const props = withDefaults(defineProps<{
  fieldId: string;
  label: string;
  required?: boolean;
  error?: string;
  help?: string;
}>(), {
  required: false,
  error: "",
  help: "",
});

// Ids are deterministic (`console-field-<fieldId>` with `-error`/`-help`
// suffixes); a missing or blank fieldId breaks every association below, so
// fail fast instead of rendering a silently unwired control.
if (!props.fieldId || !props.fieldId.trim()) {
  throw new Error("ConsoleFormField requires a non-empty fieldId prop.");
}

const slots = useSlots();

const msg: ComputedRef<any> = computed(() : any => consoleMessages[currentConsoleLocale.value]);

const errorId: string = `console-field-${props.fieldId}-error`;
const helpId: string = `console-field-${props.fieldId}-help`;

const hasError: ComputedRef<boolean> = computed(
  () : boolean => Boolean(props.error.trim()) || Boolean(slots.error),
);
const hasHelp: ComputedRef<boolean> = computed(
  () : boolean => Boolean(props.help.trim()) || Boolean(slots.help),
);

// Union order is stable (error first, then help) and the attribute stays
// absent when neither region renders, so the control never references a
// missing node.
const ariaDescribedby: ComputedRef<string | undefined> = computed(() : string | undefined => {
  const ids: string[] = [];
  if (hasError.value) {
    ids.push(errorId);
  }
  if (hasHelp.value) {
    ids.push(helpId);
  }
  return ids.length > 0 ? ids.join(" ") : undefined;
});

const controlAttrs: ComputedRef<Record<string, string | undefined>> = computed(
  () : Record<string, string | undefined> => ({
    id: props.fieldId,
    // aria-invalid is emitted only while an error is shown.
    "aria-invalid": hasError.value ? "true" : undefined,
    "aria-required": props.required ? "true" : undefined,
    "aria-describedby": ariaDescribedby.value,
  }),
);
</script>

<template>
  <label class="console-form-field" :for="fieldId">
    <span class="console-form-field-label">
      <span class="console-form-field-label-text">{{ label }}</span>
      <span
        v-if="required"
        class="console-form-field-required-marker"
        aria-hidden="true"
      >*</span>
      <span v-if="required" class="console-form-field-visually-hidden">{{ msg.formField.required }}</span>
    </span>
    <slot v-bind="controlAttrs" />
    <span
      v-if="hasError"
      :id="errorId"
      class="console-form-field-error"
      role="alert"
    >
      <slot name="error" :message="error">{{ error }}</slot>
    </span>
    <span
      v-if="hasHelp"
      :id="helpId"
      class="console-form-field-help"
    >
      <slot name="help">{{ help }}</slot>
    </span>
  </label>
</template>

<style scoped>
.console-form-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.console-form-field-label {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
}

.console-form-field-required-marker {
  color: var(--danger);
}

.console-form-field-error {
  color: var(--danger);
  font-size: var(--text-xs);
}

.console-form-field-help {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

/* Screen-reader-only text without raw px values: absolutely positioned and
   clipped to a zero-area region, so it stays in the accessibility tree. */
.console-form-field-visually-hidden {
  position: absolute;
  overflow: hidden;
  white-space: nowrap;
  clip-path: inset(50%);
}
</style>
