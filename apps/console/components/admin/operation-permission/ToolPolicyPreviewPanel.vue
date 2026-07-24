<script setup lang="ts">
import { useOperationPermissionViewContext } from "../../../composables/operationPermissionViewContext";
import { jsonPreview } from "../../../composables/console-format-utils";
import OptionBar from "@meshrix/ui-console/option-bar";

const {
  busyKey,
  policyPreviewGrantId,
  policyPreviewProfileId,
  policyPreviewProfileOptionBarOptions,
  policyPreviewResult,
  policyPreviewToolId,
  policyPreviewToolOptionBarOptions,
  previewToolPolicy,
} = useOperationPermissionViewContext();
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>策略裁决预览</h3>
      </div>
    </div>
    <div class="form-grid compact-form-grid">
      <OptionBar
        v-model="policyPreviewToolId"
        label="工具"
        :options="policyPreviewToolOptionBarOptions"
      />
      <OptionBar
        v-model="policyPreviewProfileId"
        label="智能体档案"
        :options="policyPreviewProfileOptionBarOptions"
      />
      <label>
        <span>授权 ID</span>
        <input v-model="policyPreviewGrantId" autocomplete="off" placeholder="留空时使用当前工具的模拟授权" />
      </label>
    </div>
    <div class="source-actions">
      <button
        class="tool-button"
        type="button"
        :disabled="busyKey === 'tool-policy-preview'"
        @click="previewToolPolicy"
      >
        {{ busyKey === "tool-policy-preview" ? "评估中" : "评估策略" }}
      </button>
    </div>
    <pre v-if="policyPreviewResult">{{ jsonPreview(policyPreviewResult) }}</pre>
  </article>
</template>
