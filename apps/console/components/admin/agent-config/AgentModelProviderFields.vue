<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";

defineProps<{
  entry: AgentModelConfig;
}>();

function clearCredential(entry: AgentModelConfig) {
  entry.apiKey = "";
  entry.apiKeyConfigured = false;
  entry.token = "";
  entry.tokenConfigured = false;
}
</script>

<template>
  <div class="form-grid compact-form-grid">
    <label>
      <span>Base URL</span>
      <input v-model="entry.baseUrl" autocomplete="off" />
    </label>
    <label>
      <span>{{ entry.provider === "local-model" ? "API Key（可选）" : "API Key" }}</span>
      <input
        v-model="entry.apiKey"
        type="password"
        autocomplete="off"
        :placeholder="entry.apiKeyConfigured ? '已配置；输入新值可替换，取消已配置状态可清除' : ''"
      />
      <button
        v-if="entry.apiKeyConfigured || entry.tokenConfigured"
        class="tool-button tool-button-ghost compact-action"
        type="button"
        @click="clearCredential(entry)"
      >
        清除已保存凭据
      </button>
    </label>
    <label>
      <span>凭据请求头</span>
      <input v-model="entry.tokenHeader" autocomplete="off" placeholder="例如 Authorization" />
    </label>
    <label>
      <span>凭据前缀</span>
      <input v-model="entry.tokenPrefix" autocomplete="off" placeholder="例如 Bearer " />
    </label>
    <label>
      <span>Timeout (ms)</span>
      <input v-model.number="entry.timeoutMs" type="number" min="1" step="1000" />
    </label>
  </div>
</template>
