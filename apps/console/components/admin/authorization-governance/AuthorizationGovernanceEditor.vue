<script setup lang="ts">
import { useAuthorizationGovernanceCardContext } from "../../../composables/authorizationGovernanceCardContext";

const {
  authorizationGovernanceEditorBody,
  authorizationGovernanceEditorKind,
  authorizationGovernanceEditorKinds,
  authorizationGovernanceEditorStatus,
  authorizationGovernanceSaving,
  resetAuthorizationGovernanceEditor,
  saveAuthorizationGovernanceEditor,
} = useAuthorizationGovernanceCardContext();
</script>

<template>
  <div class="authorization-governance-editor">
    <label>
      <span>对象</span>
      <select v-model="authorizationGovernanceEditorKind">
        <option
          v-for="kind in authorizationGovernanceEditorKinds"
          :key="kind.value"
          :value="kind.value"
        >
          {{ kind.label }}
        </option>
      </select>
    </label>
    <label class="governance-editor-body">
      <span>配置</span>
      <textarea v-model="authorizationGovernanceEditorBody" spellcheck="false" />
    </label>
    <div class="source-actions">
      <button class="tool-button tool-button-ghost" type="button" @click="resetAuthorizationGovernanceEditor">
        重置模板
      </button>
      <button class="tool-button" type="button" :disabled="authorizationGovernanceSaving" @click="saveAuthorizationGovernanceEditor">
        {{ authorizationGovernanceSaving ? "保存中" : "保存配置" }}
      </button>
      <span v-if="authorizationGovernanceEditorStatus" class="governance-editor-status">
        {{ authorizationGovernanceEditorStatus }}
      </span>
    </div>
  </div>
</template>
