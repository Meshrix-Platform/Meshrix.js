<script setup lang="ts">
defineOptions({ name: "ConsoleServiceIdentityFields" });

withDefaults(
  defineProps<{
    serviceIdLabel?: string;
    serviceIdValue?: string;
    serviceLabelLabel?: string;
    serviceLabelValue?: string;
  }>(),
  {
    serviceIdLabel: "",
    serviceIdValue: "",
    serviceLabelLabel: "",
    serviceLabelValue: "",
  },
);
</script>

<template>
  <div class="form-grid">
    <label>
      <span>{{ serviceIdLabel }}</span>
      <input :value="serviceIdValue" autocomplete="off" readonly />
    </label>
    <label>
      <span>{{ serviceLabelLabel }}</span>
      <input :value="serviceLabelValue" autocomplete="off" readonly />
    </label>
  </div>
</template>
