<script setup lang="ts">
import OptionBar from "@meshrix/ui-console/option-bar";
import FeatureToggle from "../FeatureToggle.vue";
import ConsoleEmptyState from "../ConsoleEmptyState.vue";
import { formatCompactDate } from "@meshrix/ui-console/console-format-utils";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

const {
  authAudit,
  authRoleOptionBarOptions,
  authSessions,
  authUsers,
  isBusy,
  canAdminAuth,
  oidcAllowedDomainsText,
  oidcDraft,
  oidcRoleMappingText,
  revokeConsoleSession,
  saveOidcConfig,
  updateConsoleUser,
  updateConsoleUserRole,
} = useServerConsoleShellContext();
</script>

<template>
  <section class="drawer-panel">
    <div class="panel-header">
      <h4>用户与执行日志</h4>
      <p>用户创建和密码修改仅允许在服务端命令行执行。</p>
    </div>

    <template v-if="canAdminAuth">
      <section class="module-panel">
        <div class="module-panel-heading">
          <strong>控制台用户</strong>
          <span>{{ authUsers.length }} 个账号</span>
        </div>
        <div class="job-table compact-job-table drawer-auth-table auth-user-table">
          <div class="job-table-header auth-user-row">
            <span>用户</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          <div v-for="user in authUsers" :key="user.userId" class="job-row auth-user-row">
            <span class="auth-user-identity">
              <strong class="auth-user-role-label">{{ user.roleLabel || user.roleId || user.displayName }}</strong>
              <span class="auth-user-name">{{ user.username }}</span>
            </span>
            <span class="auth-user-status-pill" :data-enabled="user.enabled">
              {{ user.enabled ? "可用" : "不可用" }}
            </span>
            <div class="auth-user-actions">
              <OptionBar
                class="auth-user-role-control"
                :model-value="user.roleId"
                :options="authRoleOptionBarOptions"
                @change="updateConsoleUserRole(user, String($event))"
              />
              <FeatureToggle
                :disabled="isBusy(`auth:user:${user.userId}`)"
                :aria-busy="isBusy(`auth:user:${user.userId}`)"
                :model-value="user.enabled"
                :aria-label="user.enabled ? `停用用户 ${user.username}` : `启用用户 ${user.username}`"
                @update:model-value="updateConsoleUser(user, { enabled: $event })"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="module-panel">
        <div class="module-panel-heading">
          <strong>OIDC 配置</strong>
          <span>{{ oidcDraft.enabled ? "已启用" : "未启用" }}</span>
        </div>
        <div class="form-grid compact-form-grid">
          <FeatureToggle
            v-model="oidcDraft.enabled"
            label="启用"
            :aria-label="oidcDraft.enabled ? '停用 OIDC' : '启用 OIDC'"
          />
          <label>
            <span>Issuer</span>
            <input v-model="oidcDraft.issuer" autocomplete="off" />
          </label>
          <label>
            <span>Client ID</span>
            <input v-model="oidcDraft.clientId" autocomplete="off" />
          </label>
          <label>
            <span>Client Secret</span>
            <input v-model="oidcDraft.clientSecret" type="password" autocomplete="off" placeholder="只写不读" />
          </label>
          <label>
            <span>Redirect URI</span>
            <input v-model="oidcDraft.redirectUri" autocomplete="off" />
          </label>
        </div>
        <label class="json-editor">
          <span>Allowed Domains</span>
          <textarea v-model="oidcAllowedDomainsText" rows="3"></textarea>
        </label>
        <label class="json-editor">
          <span>Role Mapping JSON</span>
          <textarea v-model="oidcRoleMappingText" rows="4" spellcheck="false"></textarea>
        </label>
        <button
          class="tool-button"
          type="button"
          :disabled="isBusy('auth:oidc')"
          :aria-busy="isBusy('auth:oidc')"
          @click="saveOidcConfig"
        >
          {{ isBusy("auth:oidc") ? "保存中" : "保存 OIDC" }}
        </button>
      </section>

      <section class="module-panel">
        <div class="module-panel-heading">
          <strong>会话与操作记录</strong>
          <span>{{ authSessions.length }} 个会话 / {{ authAudit.length }} 条记录</span>
        </div>
        <div class="job-table compact-job-table drawer-auth-table">
          <div class="job-table-header">
            <span>会话</span>
            <span>用户</span>
            <span>操作</span>
          </div>
          <div v-for="session in authSessions" :key="String(session.sessionId)" class="job-row">
            <span>{{ session.sessionId }}</span>
            <span>{{ session.username }} / {{ session.roleId }}</span>
            <button
              class="table-action"
              type="button"
              :disabled="isBusy(`auth:session:${session.sessionId}`)"
              :aria-busy="isBusy(`auth:session:${session.sessionId}`)"
              @click="revokeConsoleSession(String(session.sessionId))"
            >
              撤销
            </button>
          </div>
        </div>
        <div class="job-table compact-job-table audit-table">
          <div class="job-table-header">
            <span>时间</span>
            <span>操作</span>
            <span>结果</span>
          </div>
          <div v-for="item in authAudit" :key="item.auditId" class="job-row">
            <span>{{ formatCompactDate(item.createdAt) }}</span>
            <span>{{ item.username || "system" }} / {{ item.operationId || item.action }}</span>
            <span>{{ item.status }} {{ item.error }}</span>
          </div>
        </div>
      </section>
    </template>

    <ConsoleEmptyState
      v-else
      title="权限不足"
      description="需要 auth:admin 权限才能管理用户、OIDC、会话和操作记录。"
    />
  </section>
</template>

<style scoped>
.auth-user-table .auth-user-row {
  grid-template-columns: minmax(0, 1.1fr) max-content minmax(112px, 0.75fr);
  align-items: center;
  gap: var(--space-2);
}

.auth-user-identity {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  overflow-wrap: anywhere;
}

.auth-user-role-label {
  color: var(--text-primary);
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
  line-height: 1.25;
}

.auth-user-name {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.35;
}

.auth-user-status-pill {
  display: inline-flex;
  width: fit-content;
  min-height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  line-height: 1;
  white-space: nowrap;
}

.auth-user-status-pill[data-enabled="true"] {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success);
}

.auth-user-status-pill[data-enabled="false"] {
  color: var(--text-disabled);
}

.auth-user-actions {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}

@media (max-width: 720px) {
  .auth-user-table .auth-user-row {
    grid-template-columns: 1fr;
  }
}
</style>
