<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useUpstreamGatewayView } from "./upstream-gateway/useUpstreamGatewayView";
import {
  readinessStateLabelKey,
  useServiceReadiness,
} from "./upstream-gateway/useServiceReadiness";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import { consoleMessages, currentConsoleLocale } from "../../i18n/console";

const { canAccessAdminView } = useServerConsoleShellContext();

const {
  audit,
  error,
  gatewayAuditStatus,
  gatewayAuditTime,
  gatewayStateClass,
  loading,
  metrics,
  refreshGateway,
  selectedOperation,
  selectedService,
  selectedServiceId,
  services,
  status,
} = useUpstreamGatewayView();

const { readinessStages } = useServiceReadiness({ services, audit, selectedService });
// REQ-004 keyed dictionary: readiness strip labels resolve here, both locales.
const readinessMessages = computed(() => consoleMessages[currentConsoleLocale.value].readiness);

function stageLabel(key: string): string {
  return readinessMessages.value[key] || key;
}

function stateLabel(state: string): string {
  return readinessMessages.value[readinessStateLabelKey(state as any)] || state;
}
</script>

<template>
  <section class="upstream-gateway-layout">
    <header class="gateway-toolbar">
      <span>服务 {{ services.length }}</span>
      <span>转发 {{ metrics.totalForwardCount || 0 }}</span>
      <span>失败 {{ metrics.totalFailureCount || 0 }}</span>
      <button
        class="table-action gateway-refresh-action"
        type="button"
        :disabled="loading"
        :aria-busy="loading"
        @click="refreshGateway"
      >
        {{ loading ? "刷新中" : "刷新" }}
      </button>
    </header>

    <ConsoleInlineAlert v-if="error" tone="danger">
      {{ error }}
      <template #action>
        <button
          class="table-action"
          type="button"
          :disabled="loading"
          :aria-busy="loading"
          @click="refreshGateway"
        >
          {{ loading ? "重试中" : "重试" }}
        </button>
      </template>
    </ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" tone="success">{{ status }}</ConsoleInlineAlert>

    <main class="gateway-grid">
      <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>上游服务</h3>
            </div>
          </div>
        <button
          v-for="service in services"
          :key="service.serviceId"
          class="service-row"
          :class="{ active: selectedService?.serviceId === service.serviceId }"
          type="button"
          @click="selectedServiceId = service.serviceId"
        >
          <span>
            <strong>{{ service.label || service.serviceId }}</strong>
            <small>{{ service.serviceId }}</small>
          </span>
          <span class="gateway-state-dot" :class="gatewayStateClass(service.disabled)" :aria-label="service.disabled ? 'disabled' : 'active'" />
        </button>
        <ConsoleEmptyState
          v-if="!services.length && !loading"
          compact
          title="暂无上游服务"
          description="发布一个上游服务后，这里会显示它的运行时快照。"
        >
          <template v-if="canAccessAdminView('upstreamServicePublish')" #action>
            <RouterLink class="table-action" to="/admin/publish-upstream-service">
              发布服务
            </RouterLink>
          </template>
        </ConsoleEmptyState>
      </section>

      <section class="gateway-stack">
        <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>{{ selectedService?.label || "未选择服务" }}</h3>
              <p>{{ selectedService?.baseUrl || "external_services.*" }}</p>
            </div>
            <div class="gateway-service-actions">
              <span class="gateway-state">{{ selectedOperation?.operationKey || "none" }}</span>
              <RouterLink
                v-if="selectedService && canAccessAdminView('upstreamServicePublish')"
                class="table-action"
                :to="{ path: '/admin/publish-upstream-service', query: { serviceId: selectedService.serviceId } }"
              >
                管理发布
              </RouterLink>
            </div>
          </div>
          <div v-if="selectedService" class="gateway-readiness">
            <span class="gateway-readiness-heading">{{ readinessMessages.title }}</span>
            <div class="gateway-readiness-strip" role="group" :aria-label="readinessMessages.title">
              <template v-for="stage in readinessStages" :key="stage.id">
                <RouterLink
                  v-if="stage.link"
                  class="gateway-readiness-segment"
                  :data-state="stage.state"
                  :to="stage.link"
                  :aria-label="`${stageLabel(stage.label)} ${stateLabel(stage.state)}`"
                  :title="stateLabel(stage.state)"
                >
                  <span class="gateway-readiness-bar" aria-hidden="true" />
                  <small>{{ stageLabel(stage.label) }}</small>
                </RouterLink>
                <div
                  v-else
                  class="gateway-readiness-segment"
                  :data-state="stage.state"
                  :aria-label="`${stageLabel(stage.label)} ${stateLabel(stage.state)}`"
                  :title="stateLabel(stage.state)"
                >
                  <span class="gateway-readiness-bar" aria-hidden="true" />
                  <small>{{ stageLabel(stage.label) }}</small>
                </div>
              </template>
            </div>
          </div>
          <table class="gateway-table">
            <thead>
              <tr>
                <th>operation</th>
                <th>method</th>
                <th>path</th>
                <th>risk</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="operation in selectedService?.operations || []" :key="operation.operationKey">
                <td>{{ operation.operationKey }}</td>
                <td>{{ operation.method }}</td>
                <td>{{ operation.path }}</td>
                <td><span class="gateway-state">{{ operation.risk }}</span></td>
              </tr>
            </tbody>
          </table>
          <ConsoleEmptyState
            v-if="!(selectedService?.operations || []).length"
            compact
            title="暂无操作"
            :description="selectedService ? '在发布流程中添加工具路径后，这里会列出该服务的操作。' : ''"
          >
            <template v-if="selectedService && canAccessAdminView('upstreamServicePublish')" #action>
              <RouterLink
                class="table-action"
                :to="{ path: '/admin/publish-upstream-service', query: { serviceId: selectedService.serviceId } }"
              >
                添加工具路径
              </RouterLink>
            </template>
          </ConsoleEmptyState>
        </section>

        <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>发布来源</h3>
              <p>受治理的上游服务清单</p>
            </div>
          </div>
          <p class="empty-copy">
            此处显示已通过服务发布流程接受并加载的运行时快照。创建操作请在“发布服务”页面完成；更新、停用、重新发布和移除可通过上方“管理发布”进入。
          </p>
        </section>

        <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>审计</h3>
              <p>{{ audit.length }} 条</p>
            </div>
          </div>
          <table class="gateway-table">
            <thead>
              <tr>
                <th>事件</th>
                <th>服务</th>
                <th>结果</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in audit.slice(0, 8)" :key="item.auditId">
                <td>{{ item.eventType }}</td>
                <td>{{ item.serviceId }}</td>
                <td>{{ gatewayAuditStatus(item) }}</td>
                <td>{{ gatewayAuditTime(item) }}</td>
              </tr>
            </tbody>
          </table>
          <ConsoleEmptyState v-if="!audit.length && !loading" compact title="暂无审计事件" />
        </section>

      </section>
    </main>
  </section>
</template>

<style scoped>
.upstream-gateway-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}

.gateway-toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2-5);
}

.gateway-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
}

.gateway-stack {
  display: grid;
  gap: var(--space-3-5);
}

.gateway-service-actions {
  align-items: center;
  display: flex;
  gap: var(--space-2-5);
}

.gateway-panel {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-3-5);
}

.section-header {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.section-header h3,
.section-header p {
  margin: 0;
}

.section-header h3 {
  font-size: var(--text-xl);
}

.section-header p,
.empty-copy,
.gateway-form-grid span,
.gateway-forward-body span {
  color: var(--text-muted);
  font-size: var(--text-md);
}

.service-row {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  padding: var(--space-2-5);
  text-align: left;
  width: 100%;
}

.service-row.active,
.service-row:hover {
  background: var(--bg-subtle);
}

.service-row strong,
.service-row small {
  display: block;
}

.service-row small {
  color: var(--text-muted);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.gateway-state {
  background: var(--bg-subtle);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  font-size: var(--text-md);
  padding: var(--space-0-5) var(--space-2);
}

.gateway-state-dot {
  border-radius: var(--radius-full);
  display: inline-block;
  height: 10px;
  width: 10px;
}

.gateway-state-dot.active {
  background: var(--success);
}

.gateway-state-dot.disabled {
  background: var(--text-muted);
}

.gateway-table {
  border-collapse: collapse;
  width: 100%;
}

.gateway-table th,
.gateway-table td {
  border-bottom: 1px solid var(--border-subtle);
  padding: var(--space-2) var(--space-2-5);
  text-align: left;
  vertical-align: top;
}

.gateway-table th {
  color: var(--text-muted);
  font-size: var(--text-md);
  font-weight: 600;
}

.gateway-form-grid {
  display: grid;
  gap: var(--space-2-5);
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gateway-form-grid label,
.gateway-forward-body {
  display: grid;
  gap: var(--space-1);
}

.gateway-form-grid input,
.gateway-form-grid select,
.gateway-forward-body textarea {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  min-height: 34px;
  padding: var(--space-2) var(--space-2-5);
}

.gateway-actions button,
.table-action,
.tool-button {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  min-height: 32px;
  padding: var(--space-1-5) var(--space-2-5);
}

.tool-button {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-brand);
}

pre {
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: var(--space-2-5);
}

.gateway-readiness {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-3-5);
}

.gateway-readiness-heading {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.gateway-readiness-strip {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.gateway-readiness-segment {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.gateway-readiness-bar {
  background: var(--border-subtle);
  border-radius: var(--radius-full);
  display: block;
  height: 8px;
}

.gateway-readiness-segment[data-state="done"] .gateway-readiness-bar {
  background: var(--success);
}

.gateway-readiness-segment small {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
  line-height: 1.25;
  overflow-wrap: anywhere;
  text-align: center;
}

.gateway-readiness-segment[data-state="done"] small {
  color: var(--success);
}

@media (max-width: 880px) {
  .gateway-grid,
  .gateway-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
