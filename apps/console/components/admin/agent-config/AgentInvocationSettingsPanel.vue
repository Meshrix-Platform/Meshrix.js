<script setup lang="ts">
import { useServerConsoleShellContext } from "../../../composables/serverConsoleShellContext";
import JsonConfigFileEditor from "../../JsonConfigFileEditor.vue";
import AgentConfigInvocationToggle from "./AgentConfigInvocationToggle.vue";

const {
  isBusy,
  saveSettings,
  settingsDraft,
} = useServerConsoleShellContext();

async function saveLocalCommandTemplates(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("本地命令模板必须是 JSON 数组。");
  }
  settingsDraft.value.agentToolExecution.local.commands = value as typeof settingsDraft.value.agentToolExecution.local.commands;
  await saveSettings();
}

async function saveFunctionCallSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("function call schema 必须是 JSON 对象。");
  }
  settingsDraft.value.agentToolExecution.functionCallSchema = value as Record<string, unknown>;
  await saveSettings();
}
</script>

<template>
  <article class="surface-card">
    <form class="drawer-panel" @submit.prevent="saveSettings">
      <div class="section-header">
        <div>
          <h3>调用框架</h3>
        </div>
      </div>
      <section class="settings-sub-card invocation-remote-card">
        <div class="settings-sub-card-header">
          <h4>远程调用</h4>
        </div>
        <div class="invocation-toggle-row">
          <AgentConfigInvocationToggle
            v-model="settingsDraft.agentToolExecution.http.enabled"
            label="HTTP 调用"
          />
        </div>
        <div class="form-grid compact-form-grid invocation-config-grid">
          <label>
            <span>HTTP 允许 Host（逗号分隔）</span>
            <input
              :value="settingsDraft.agentToolExecution.http.allowedHosts.join(', ')"
              @input="settingsDraft.agentToolExecution.http.allowedHosts = String(($event.target as HTMLInputElement).value || '').split(',').map((item) => item.trim()).filter(Boolean)"
            />
          </label>
          <label>
            <span>HTTP Timeout(ms)</span>
            <input v-model.number="settingsDraft.agentToolExecution.http.timeoutMs" type="number" min="1000" step="1000" />
          </label>
          <label>
            <span>HTTP 最大响应字节</span>
            <input v-model.number="settingsDraft.agentToolExecution.http.maxResponseBytes" type="number" min="1024" step="1024" />
          </label>
        </div>
      </section>
      <section class="settings-sub-card invocation-local-card">
        <div class="settings-sub-card-header">
          <h4>本地调用</h4>
        </div>
        <div class="invocation-toggle-row">
          <AgentConfigInvocationToggle
            v-model="settingsDraft.agentToolExecution.local.enabled"
            label="CLI 调用"
          />
        </div>
        <div class="form-grid compact-form-grid invocation-config-grid">
          <label>
            <span>命令 Timeout(ms)</span>
            <input v-model.number="settingsDraft.agentToolExecution.local.timeoutMs" type="number" min="1000" step="1000" />
          </label>
          <label>
            <span>命令最大输出字节</span>
            <input v-model.number="settingsDraft.agentToolExecution.local.maxOutputBytes" type="number" min="1024" step="1024" />
          </label>
        </div>
        <JsonConfigFileEditor
          title="本地命令模板 JSON"
          file-key="operation-permission/execution.json#agentToolExecution.local.commands"
          :model-value="settingsDraft.agentToolExecution.local.commands"
          :on-save="saveLocalCommandTemplates"
          open
          :rows="12"
        />
      </section>
      <JsonConfigFileEditor
        title="function call schema"
        file-key="operation-permission/execution.json#agentToolExecution.functionCallSchema"
        :model-value="settingsDraft.agentToolExecution.functionCallSchema || {}"
        :on-save="saveFunctionCallSchema"
        :rows="12"
      />
      <div class="source-actions">
        <button class="tool-button" type="submit" :disabled="isBusy('settings')">
          {{ isBusy("settings") ? "保存中" : "保存工具调用配置" }}
        </button>
      </div>
    </form>
  </article>
</template>
