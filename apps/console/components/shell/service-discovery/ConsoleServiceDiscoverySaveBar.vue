<script setup lang="ts">
defineOptions({ name: "ConsoleServiceDiscoverySaveBar" });

withDefaults(
  defineProps<{
    saving?: boolean;
    saveLabel?: string;
    savingLabel?: string;
    message?: string;
  }>(),
  {
    saving: false,
    saveLabel: "",
    savingLabel: "",
    message: "",
  },
);
</script>

<template>
  <button
    class="tool-button"
    type="submit"
    :disabled="saving"
  >
    {{ saving ? savingLabel : saveLabel }}
  </button>
  <p v-if="message" class="server-address-save-message">
    {{ message }}
  </p>
</template>

<style scoped>
.server-address-save-message {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
</style>
