<script setup lang="ts">
import { computed } from "vue";
import { useOperationPermissionViewContext } from "../../../composables/operationPermissionViewContext";
import { toolsetLabel } from "../../../composables/console-tool-display-utils";
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import FeatureToggle from "../../FeatureToggle.vue";
import ScopeSelector from "../../ScopeSelector.vue";

const {
  busyKey,
  deleteGrant,
  enabledToolGrantCount,
  formatCompactDate,
  grantHasToolset,
  rotateGrant,
  toggleGrantToolset,
  toolGrants,
  operationPermissionToolsets,
  toolScopes,
  updateGrant,
} = useOperationPermissionViewContext();

const grantableToolsets = computed(() =>
  operationPermissionToolsets.value.filter((item) => item.grantable !== false),
);

function grantToolsetLabel(toolsetId: string) {
  return toolsetLabel(toolsetId, operationPermissionToolsets.value);
}

function grantToolsetSummary(toolsetIds?: string[]) {
  const values = (toolsetIds || []).map(grantToolsetLabel);
  if (values.length === 0) {
    return "未声明";
  }
	  return values.slice(0, 3).join("，") + (values.length > 3 ? ` +${values.length - 3}` : "");
}

function grantExceptionCount(grant: { toolAllow?: string[]; toolDeny?: string[] }) {
  return (grant.toolAllow?.length || 0) + (grant.toolDeny?.length || 0);
}
</script>

<template>
  <article class="surface-card permission-list-card">
    <div class="section-header">
      <div>
        <h3>工具令牌</h3>
        <p>先看令牌状态和最近使用；需要修改范围时再展开单条授权。</p>
      </div>
      <div class="section-tags">
        <span>启用 {{ enabledToolGrantCount }}</span>
        <span>总计 {{ toolGrants.length }}</span>
      </div>
    </div>

    <div class="permission-list" v-if="toolGrants.length > 0">
      <article
        v-for="grant in toolGrants"
        :key="grant.id"
        class="permission-card"
        :data-enabled="grant.enabled"
      >
        <div class="permission-token-card-header">
          <label class="module-field">
            <span>名称</span>
            <input v-model="grant.label" autocomplete="off" @change="updateGrant(grant, { label: grant.label })" />
          </label>
          <div class="permission-actions">
            <FeatureToggle
              :model-value="grant.enabled"
              on-label="授权已启用"
              off-label="授权已停用"
              :aria-label="grant.enabled ? '停用授权' : '启用授权'"
              :disabled="busyKey === `grant:${grant.id}`"
              @update:model-value="updateGrant(grant, { enabled: $event })"
            />
            <button class="table-action" type="button" :disabled="busyKey === `grant:${grant.id}`" @click="rotateGrant(grant)">
              轮换
            </button>
            <button class="table-action danger-action" type="button" :disabled="busyKey === `grant:${grant.id}`" @click="deleteGrant(grant)">
              撤销
            </button>
          </div>
        </div>

        <dl class="permission-token-summary">
          <div>
            <dt>令牌</dt>
            <dd>{{ grant.tokenPrefix || "未生成" }}</dd>
          </div>
          <div>
            <dt>最近使用</dt>
            <dd>{{ grant.lastUsedAt ? formatCompactDate(grant.lastUsedAt) : "未使用" }}</dd>
          </div>
          <div>
            <dt>权限范围</dt>
            <dd>{{ grant.scopes.length }}</dd>
          </div>
          <div>
            <dt>工具集</dt>
            <dd>{{ grantToolsetSummary(grant.toolsets) }}</dd>
          </div>
          <div>
            <dt>例外</dt>
            <dd>{{ grantExceptionCount(grant) }}</dd>
          </div>
        </dl>

        <details class="permission-token-config-panel">
          <summary>
            <span>编辑授权范围</span>
            <small>已选 {{ grant.scopes.length }}</small>
          </summary>
          <ScopeSelector
            :model-value="grant.scopes"
            :scopes="toolScopes"
            :disabled="busyKey === `grant:${grant.id}`"
            @update:model-value="(v) => updateGrant(grant, { scopes: v })"
            compact
          />
        </details>

        <details class="permission-token-config-panel">
          <summary>
            <span>编辑工具集</span>
            <small>已选 {{ (grant.toolsets || []).length }}</small>
          </summary>
          <div class="scope-grid compact-scope-grid">
            <button
              v-for="toolset in grantableToolsets"
              :key="toolset.id"
              class="scope-chip"
              :class="{ active: grantHasToolset(grant, toolset.id) }"
              type="button"
              :disabled="busyKey === `grant:${grant.id}`"
              @click="toggleGrantToolset(grant, toolset.id)"
            >
              <strong>{{ toolset.label }}</strong>
            </button>
          </div>
        </details>
      </article>
    </div>

    <ConsoleEmptyState
      v-else
      title="暂无工具授权"
      description="当前后端返回 0 条工具令牌；已有令牌会显示在这里，不会藏在创建表单里。"
    />
  </article>
</template>
