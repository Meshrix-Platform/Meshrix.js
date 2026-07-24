<script setup lang="ts">
import { useUpstreamGatewayView } from "./upstream-gateway/useUpstreamGatewayView";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";

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
</script>

<template>
  <section class="upstream-gateway-layout">
    <header class="gateway-toolbar">
      <button class="table-action" type="button" :disabled="loading" @click="refreshGateway">
        {{ loading ? "刷新中" : "刷新" }}
      </button>
      <span>服务 {{ services.length }}</span>
      <span>转发 {{ metrics.totalForwardCount || 0 }}</span>
      <span>失败 {{ metrics.totalFailureCount || 0 }}</span>
    </header>

    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
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
        <ConsoleEmptyState v-if="!services.length" compact title="暂无上游服务" />
      </section>

      <section class="gateway-stack">
        <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>{{ selectedService?.label || "未选择服务" }}</h3>
              <p>{{ selectedService?.baseUrl || "external_services.*" }}</p>
            </div>
            <span class="gateway-state">{{ selectedOperation?.operationKey || "none" }}</span>
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
          <ConsoleEmptyState v-if="!(selectedService?.operations || []).length" compact title="暂无操作" />
        </section>

        <section class="gateway-panel">
          <div class="section-header">
            <div>
              <h3>发布来源</h3>
              <p>受治理的上游服务清单</p>
            </div>
          </div>
          <p class="empty-copy">
            此处显示已通过服务发布流程接受并加载的运行时快照。创建、更新、停用、重新发布和移除操作请在“上游服务发布”页面完成。
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
          <ConsoleEmptyState v-if="!audit.length" compact title="暂无审计事件" />
        </section>

      </section>
    </main>
  </section>
</template>

<style scoped>
.upstream-gateway-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
}

.gateway-toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.gateway-grid {
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
}

.gateway-stack {
  display: grid;
  gap: 14px;
}

.gateway-panel {
  border: 1px solid var(--border-subtle, #d5dce8);
  border-radius: 8px;
  padding: 14px;
}

.section-header {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section-header h3,
.section-header p {
  margin: 0;
}

.section-header h3 {
  font-size: 15px;
}

.section-header p,
.empty-copy,
.gateway-form-grid span,
.gateway-forward-body span {
  color: var(--text-muted, #64748b);
  font-size: 12px;
}

.service-row {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  padding: 9px;
  text-align: left;
  width: 100%;
}

.service-row.active,
.service-row:hover {
  background: var(--surface-subtle, #f1f5f9);
}

.service-row strong,
.service-row small {
  display: block;
}

.service-row small {
  color: var(--text-muted, #64748b);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.gateway-state {
  background: var(--surface-subtle, #eef2f7);
  border-radius: 999px;
  color: var(--text-muted, #475569);
  font-size: 12px;
  padding: 3px 8px;
}

.gateway-state-dot {
  border-radius: 999px;
  display: inline-block;
  height: 10px;
  width: 10px;
}

.gateway-state-dot.active {
  background: #16a34a;
}

.gateway-state-dot.disabled {
  background: #94a3b8;
}

.gateway-table {
  border-collapse: collapse;
  width: 100%;
}

.gateway-table th,
.gateway-table td {
  border-bottom: 1px solid var(--border-subtle, #e2e8f0);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.gateway-table th {
  color: var(--text-muted, #64748b);
  font-size: 12px;
  font-weight: 600;
}

.gateway-form-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gateway-form-grid label,
.gateway-forward-body {
  display: grid;
  gap: 4px;
}

.gateway-form-grid input,
.gateway-form-grid select,
.gateway-forward-body textarea {
  border: 1px solid var(--border-subtle, #d5dce8);
  border-radius: 6px;
  min-height: 34px;
  padding: 7px 9px;
}

.gateway-actions button,
.table-action,
.tool-button {
  border: 1px solid var(--border-subtle, #cbd5e1);
  border-radius: 6px;
  min-height: 32px;
  padding: 6px 10px;
}

.tool-button {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}

pre {
  background: var(--surface-subtle, #f8fafc);
  border-radius: 6px;
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: 10px;
}

@media (max-width: 880px) {
  .gateway-grid,
  .gateway-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
