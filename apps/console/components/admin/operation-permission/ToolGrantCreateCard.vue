<script setup lang="ts">
import { computed } from "vue";
import { useOperationPermissionViewContext } from "../../../composables/operationPermissionViewContext";
import { toolRiskLabel } from "../../../composables/console-tool-display-utils";
import ScopeSelector from "../../ScopeSelector.vue";

const {
  busyKey,
  copyIssuedToolToken,
  createGrant,
  issuedToolToken,
  newGrantLabel,
  newGrantScopes,
  newGrantToolsets,
  toggleNewGrantToolset,
  operationPermissionToolsets,
  toolScopes,
} = useOperationPermissionViewContext();

const grantableToolsets = computed(() =>
  operationPermissionToolsets.value.filter((item) => item.grantable !== false),
);
const selectedScopeCount = computed(() => newGrantScopes.value.length);
const selectedToolsetCount = computed(() => newGrantToolsets.value.length);
</script>

<template>
  <article class="surface-card permission-create-card permission-token-create-card">
    <div class="section-header">
      <div>
        <h3>创建工具令牌</h3>
        <p>给外部智能体或网关客户端创建一条可轮换、可撤销的工具授权。</p>
      </div>
      <div class="section-tags">
        <span>范围 {{ selectedScopeCount }}</span>
        <span>工具集 {{ selectedToolsetCount }}</span>
      </div>
    </div>

    <form class="permission-form permission-token-create-form" @submit.prevent="createGrant">
      <label class="module-field">
        <span>授权名称</span>
        <input v-model="newGrantLabel" autocomplete="off" placeholder="例如：Codex 本地维护令牌" />
      </label>

      <button class="tool-button" type="submit" :disabled="busyKey === 'grant:create'">
        {{ busyKey === "grant:create" ? "创建中" : "创建授权" }}
      </button>

      <section class="permission-token-config-section">
        <div class="permission-token-config-heading">
          <span>授权范围</span>
          <small>已选 {{ selectedScopeCount }}</small>
        </div>
        <ScopeSelector
          v-model="newGrantScopes"
          :scopes="toolScopes"
          compact
        />
      </section>

      <section class="permission-token-config-section">
        <div class="permission-token-config-heading">
          <span>工具集</span>
          <small>已选 {{ selectedToolsetCount }}</small>
        </div>
        <div class="scope-grid compact-scope-grid">
          <button
            v-for="toolset in grantableToolsets"
            :key="toolset.id"
            class="scope-chip"
            :class="{ active: newGrantToolsets.includes(toolset.id) }"
            type="button"
            @click="toggleNewGrantToolset(toolset.id)"
          >
            <strong>{{ toolset.label }}</strong>
            <span>{{ toolRiskLabel(toolset.maxRisk) }}</span>
          </button>
        </div>
      </section>
    </form>

    <div v-if="issuedToolToken" class="token-panel">
      <div>
        <strong>新令牌只显示一次</strong>
        <p>{{ issuedToolToken }}</p>
      </div>
      <button class="tool-button tool-button-ghost" type="button" @click="copyIssuedToolToken">
        复制
      </button>
    </div>
  </article>
</template>
