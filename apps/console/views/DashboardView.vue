<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import StatusPill from "@meshrix/ui-console/status-pill";
import DashboardPluginCard from "../components/dashboard/DashboardPluginCard.vue";
import {
  useApprovalFlowViewController,
  type ApprovalFlowCard,
} from "../composables/console-approval-flow-view-controller";
import {
  currentConsoleLocale,
  localizeConsoleText,
  resolveEffectiveConsoleLocale,
} from "../i18n/console";
import type { DashboardAlert } from "../types/app";

const {
  dashboardAlertInboxId,
  dashboardAlerts,
  dismissDashboardAlert,
  openDashboardAlert,
} = useServerConsoleShellContext().dashboard;
const {
  isBusy,
  consoleState,
} = useServerConsoleShellContext().runtime;

const approvalFlow = useApprovalFlowViewController();
const { approvalFlowCards } = approvalFlow;
const dashboardLocale = computed(() =>
  resolveEffectiveConsoleLocale(currentConsoleLocale.value),
);

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const clientTotalCount = computed(
  () => consoleState.value?.clients?.summary?.totalCount || 0,
);
const clientOfflineCount = computed(
  () => consoleState.value?.clients?.summary?.offlineCount || 0,
);
const clientOnlineCount = computed(() =>
  Math.max(0, clientTotalCount.value - clientOfflineCount.value),
);
const approvalFlowCount = computed(() => approvalFlowCards.value.length);
const dashboardAlertCount = computed(() => dashboardAlerts.value.length);
const dashboardPlugins = computed(() => {
  const plugins = consoleState.value?.features?.plugins;
  const effectiveIds = new Set(
    (plugins?.effectivePlugins || []).map((plugin: any) => plugin.id),
  );
  return (plugins?.loadedPlugins || []).map((plugin: any) => ({
    ...plugin,
    effective: effectiveIds.has(plugin.id),
  }));
});

type DashboardTodoItem =
  | {
      key: string;
      kind: "alert";
      tone: DashboardAlert["tone"];
      label: string;
      title: string;
      summary: string;
      meta: string[];
      alert: DashboardAlert;
    }
  | {
      key: string;
      kind: "approval";
      tone: string;
      label: string;
      title: string;
      summary: string;
      meta: string[];
      card: ApprovalFlowCard;
    };

function alertSourceLabel() {
  return "运维待办";
}

function alertTodoMeta(alertItem: DashboardAlert) {
  return [
    alertItem.status,
    alertSourceLabel(),
    alertItem.live === false ? "待确认" : "",
  ].filter(Boolean);
}

const dashboardTodoItems = computed<DashboardTodoItem[]>(() => [
  ...dashboardAlerts.value.map((alertItem: any) => ({
    key: `alert:${dashboardAlertInboxId(alertItem)}`,
    kind: "alert" as const,
    tone: alertItem.tone,
    label: alertItem.category,
    title: alertItem.title,
    summary: alertItem.detail,
    meta: alertTodoMeta(alertItem),
    alert: alertItem,
  })),
  ...approvalFlowCards.value.map((card: any) => ({
    key: `approval:${card.key}`,
    kind: "approval" as const,
    tone: card.tone,
    label: card.label,
    title: card.title,
    summary: card.summary,
    meta: card.meta,
    card,
  })),
]);

const dashboardTodoSummary = computed(() => {
  if (dashboardLocale.value === "en") {
    if (!dashboardTodoItems.value.length) {
      return "No pending items for this role.";
    }
    return [
      dashboardAlertCount.value ? `${dashboardAlertCount.value} alerts` : "",
      approvalFlowCount.value ? `${approvalFlowCount.value} approvals` : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (!dashboardTodoItems.value.length) {
    return "当前角色没有待办事项。";
  }
  return [
    dashboardAlertCount.value ? `${dashboardAlertCount.value} 个告警` : "",
    approvalFlowCount.value ? `${approvalFlowCount.value} 个审批` : "",
  ]
    .filter(Boolean)
    .join("，");
});

const dashboardTodoStatusLabel = computed(() => {
  if (dashboardLocale.value === "en") {
    return dashboardTodoItems.value.length
      ? `${dashboardTodoItems.value.length} items`
      : "Cleared";
  }
  return dashboardTodoItems.value.length
    ? `${dashboardTodoItems.value.length} 项`
    : "已清空";
});
const approvalCenterActionLabel = computed(() =>
  dashboardLocale.value === "en"
    ? "Open Approval Decision Center"
    : "进入审批决策中心",
);

function alertBusyKey(alertItem: DashboardAlert) {
  if (alertItem.actionKind === "recover-supervisor") {
    return "background-supervisor:recover";
  }
  return `monitor-alert:ack:${alertItem.alertId}`;
}

function isAlertBusy(alertItem: DashboardAlert) {
  return isBusy(alertBusyKey(alertItem));
}

function isDismissBusy(alertItem: DashboardAlert) {
  return isBusy(`monitor-alert:ack:${alertItem.alertId}`);
}

function dashboardAlertActionLabel(alertItem: DashboardAlert) {
  if (isAlertBusy(alertItem) && alertItem.actionKind === "recover-supervisor") {
    return "拉起中";
  }
  return (
    alertItem.actionLabel ||
    (alertItem.tone === "success" ? "确认恢复" : "查看巡检")
  );
}
</script>

<template>
  <section class="dashboard-view">
    <article class="surface-card dashboard-todo-card">
      <div class="section-header">
        <div>
          <h3>待办事项</h3>
          <p>{{ dashboardTodoSummary }}</p>
        </div>
        <StatusPill
          :tone="dashboardTodoItems.length ? 'warning' : 'success'"
          :label="localizeStatusPillLabel(dashboardTodoStatusLabel)"
        />
      </div>
      <div v-if="dashboardTodoItems.length" class="dashboard-todo-list">
        <article
          v-for="todo in dashboardTodoItems"
          :key="todo.key"
          class="dashboard-todo-item"
          :data-tone="todo.tone"
          :data-kind="todo.kind"
          :data-live="
            todo.kind === 'alert' && todo.alert.live === false
              ? 'false'
              : 'true'
          "
        >
          <header class="dashboard-todo-item-header">
            <div>
              <span class="dashboard-todo-kind">{{ todo.label }}</span>
              <strong>{{ todo.title }}</strong>
            </div>
            <div class="dashboard-todo-meta">
              <span v-for="item in todo.meta" :key="`${todo.key}:${item}`">{{
                item
              }}</span>
            </div>
          </header>
          <p>{{ todo.summary }}</p>
          <div v-if="todo.kind === 'alert'" class="dashboard-todo-actions">
            <button
              class="configuration-alert-action"
              type="button"
              :disabled="isAlertBusy(todo.alert)"
              @click="openDashboardAlert(todo.alert)"
            >
              {{ dashboardAlertActionLabel(todo.alert) }}
            </button>
            <button
              class="configuration-alert-action dashboard-todo-dismiss"
              type="button"
              :disabled="isDismissBusy(todo.alert)"
              @click="dismissDashboardAlert(todo.alert)"
            >
              {{ isDismissBusy(todo.alert) ? "确认中" : "确认关闭" }}
            </button>
          </div>
          <div v-else class="dashboard-todo-actions">
            <RouterLink
              class="configuration-alert-action"
              to="/approval"
              data-action="open-approval-center"
            >
              {{ approvalCenterActionLabel }}
            </RouterLink>
          </div>
        </article>
      </div>
      <div v-else class="configuration-alert-empty dashboard-todo-empty">
        <strong>没有待办事项</strong>
        <span>当前角色没有需要处理的告警或审批事项。</span>
      </div>
    </article>

    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-card-header">
          <span>存储对象</span>
        </div>
        <h3>
          {{ (consoleState?.storage?.objectCount || 0).toLocaleString() }}
        </h3>
        <p>
          {{
            (consoleState?.storage?.objectFileCount || 0).toLocaleString()
          }}
          个对象文件
        </p>
      </article>
      <article class="metric-card">
        <div class="metric-card-header">
          <span>客户端</span>
          <StatusPill
            :tone="clientOnlineCount > 0 ? 'success' : 'neutral'"
            :label="
              localizeStatusPillLabel(clientTotalCount > 0 ? `${clientOnlineCount} 在线` : '无客户端')
            "
            :show-dot="false"
          />
        </div>
        <h3>{{ clientTotalCount }}</h3>
        <p>离线 {{ clientOfflineCount }}</p>
      </article>
      <article class="metric-card">
        <div class="metric-card-header">
          <span>任务队列</span>
          <StatusPill
            :tone="
              (consoleState?.jobs?.summary?.runningCount || 0) > 0
                ? 'running'
                : 'neutral'
            "
            :label="
              localizeStatusPillLabel(
                (consoleState?.jobs?.summary?.runningCount || 0) > 0
                  ? `${consoleState?.jobs?.summary?.runningCount || 0} 运行中`
                  : '空闲'
              )
            "
            :show-dot="false"
          />
        </div>
        <h3>
          {{
            (consoleState?.jobs?.summary?.queuedCount || 0) +
            (consoleState?.jobs?.summary?.runningCount || 0)
          }}
        </h3>
        <p>
          {{
            (consoleState?.jobs?.summary?.completedCount || 0).toLocaleString()
          }}
          已完成
        </p>
      </article>
    </div>

    <DashboardPluginCard :plugins="dashboardPlugins" />
  </section>
</template>

<style scoped>
/* Dismissing an alert is a neutral acknowledgement, not a destructive action. */
.dashboard-todo-dismiss {
  color: var(--text-secondary);
}

.dashboard-todo-dismiss:hover,
.dashboard-todo-dismiss:focus-visible {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
}
</style>
