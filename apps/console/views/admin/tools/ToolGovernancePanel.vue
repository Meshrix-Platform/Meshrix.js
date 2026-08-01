<script setup lang="ts">
import { jsonPreview } from "../../../composables/console-format-utils";
import type {
  OperationPermissionGrant,
  OperationPermissionProfile,
} from "../../../lib/operation-permission-client";
import type { OptionBarOption } from "../../../types/app";

withDefaults(
  defineProps<{
    profiles?: OperationPermissionProfile[];
    grants?: OperationPermissionGrant[];
    toolOptions?: OptionBarOption[];
    profileOptions?: OptionBarOption[];
    busyKey?: string;
    previewResult?: Record<string, unknown> | null;
  }>(),
  {
    profiles: () => [],
    grants: () => [],
    toolOptions: () => [],
    profileOptions: () => [],
    busyKey: "",
    previewResult: null,
  },
);

const emit = defineEmits<{
  preview: [];
}>();

const policyPreviewToolId = defineModel<string>("policyPreviewToolId", { required: true });
const policyPreviewProfileId = defineModel<string>("policyPreviewProfileId", { required: true });
const policyPreviewGrantId = defineModel<string>("policyPreviewGrantId", { required: true });
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>工具治理</h3>
        <p>选择工具、智能体档案与授权后预演策略评估；评估只读，不改变任何授权。</p>
      </div>
      <div class="section-tags">
        <span>档案 {{ profiles.length }}</span>
        <span>授权 {{ grants.length }}</span>
      </div>
    </div>

    <div class="form-grid compact-form-grid">
      <label>
        <span>工具</span>
        <select v-model="policyPreviewToolId">
          <option v-if="!toolOptions.length" value="" disabled>暂无可选工具</option>
          <option
            v-for="option in toolOptions"
            :key="String(option.value)"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
      <label>
        <span>智能体档案</span>
        <select v-model="policyPreviewProfileId">
          <option v-if="!profileOptions.length" value="" disabled>暂无可选档案</option>
          <option
            v-for="option in profileOptions"
            :key="String(option.value)"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
      <label>
        <span>授权 ID</span>
        <input v-model="policyPreviewGrantId" autocomplete="off" placeholder="留空时使用模拟授权" />
      </label>
    </div>
    <div class="source-actions">
      <button
        class="tool-button"
        type="button"
        :disabled="busyKey === 'tool-policy-preview'"
        @click="emit('preview')"
      >
        {{ busyKey === "tool-policy-preview" ? "评估中" : "评估策略" }}
      </button>
    </div>
    <pre v-if="previewResult">{{ jsonPreview(previewResult) }}</pre>
  </article>
</template>
