<script setup lang="ts">
import { ref } from "vue";
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import ConfigFoldCard from "../../ConfigFoldCard.vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import { useOpsMonitorViewContext } from "../../../composables/opsMonitorViewContext";

import { currentConsoleLocale, localizeConsoleText } from "../../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const {
  acknowledgeMonitorAlert = async () => undefined,
  isBusy = () => false,
  canAdminMaintenanceAgent = ref(false),
  formatCompactDate = (value: unknown) => String(value || ""),
  monitorAlertConfigText = ref(""),
  monitorAlertDetailBullets = () => [],
  monitorAlertHistoryRows = ref([]),
  monitorAlertMergeKey = (alert: { alertId?: string }) => alert.alertId || "",
  monitorAlertSeverityLabel = (severity: string) => severity || "unknown",
  monitorAlertSeverityTone = () => "neutral",
  monitorAlertState = ref({ status: "" }),
  monitorAlertSummary = ref({ criticalCount: 0 }),
  saveMonitorAlertConfig = async () => undefined,
  shouldIncludeMonitorAlertLifecycle = () => false,
  visibleMonitorAlerts = ref([]),
} = useOpsMonitorViewContext();

const monitorAlertStatusLabels: Record<string, string> = {
  healthy: "正常",
  alerting: "报警中",
  unconfigured: "未配置",
};

function monitorAlertStateStatusLabel(status: unknown) {
  const key = String(status || "").trim();
  return monitorAlertStatusLabels[key] || key || "未读取";
}
</script>

<template>
  <article class="surface-card" style="display: flex; flex-direction: column; gap: 16px;">
    <div class="section-header">
      <div>
        <h3>监控报警</h3>
      </div>
      <div class="section-tags">
        <span>{{ monitorAlertStateStatusLabel(monitorAlertState?.status) }}</span>
        <span>可见 {{ visibleMonitorAlerts.length }}</span>
        <span>严重 {{ monitorAlertSummary.criticalCount }}</span>
        <span>历史 {{ monitorAlertHistoryRows.length }}</span>
      </div>
    </div>
    <div v-if="visibleMonitorAlerts.length" class="job-table compact-job-table monitor-alert-table monitor-alert-active-table">
      <div class="job-table-header">
        <span>级别</span>
        <span>报警</span>
        <span>状态</span>
      </div>
      <div
        v-for="alert in visibleMonitorAlerts"
        :key="monitorAlertMergeKey(alert)"
        class="job-row"
      >
        <StatusPill
          class="monitor-alert-severity-pill"
          :tone="monitorAlertSeverityTone(alert.severity)"
          :label="localizeStatusPillLabel(monitorAlertSeverityLabel(alert.severity))"
        />
        <div class="monitor-alert-detail">
          <strong>{{ alert.title }}</strong>
          <ul class="monitor-alert-detail-list">
            <li
              v-for="(bullet, bulletIndex) in monitorAlertDetailBullets(alert, shouldIncludeMonitorAlertLifecycle(alert))"
              :key="`${alert.alertId}:${bullet.label}:${bulletIndex}`"
            >
              <span>{{ bullet.label }}：</span>
              <span>{{ bullet.text }}</span>
            </li>
          </ul>
        </div>
        <span>
          {{ formatCompactDate(alert.resolvedAt || alert.lastSeenAt || alert.firstSeenAt) }}
          <button
            v-if="alert.ackRequired && !alert.acknowledgedAt"
            class="tool-button tool-button-ghost"
            type="button"
            :disabled="isBusy(`monitor-alert:ack:${alert.alertId}`)"
            :aria-busy="isBusy(`monitor-alert:ack:${alert.alertId}`)"
            @click="acknowledgeMonitorAlert(alert.alertId)"
          >
            {{ isBusy(`monitor-alert:ack:${alert.alertId}`) ? "确认中" : "确认关闭" }}
          </button>
        </span>
      </div>
    </div>
    <ConsoleEmptyState v-if="visibleMonitorAlerts.length === 0" title="暂无当前报警" />
    <ConfigFoldCard
      title="历史记录"
      :subtitle="`${monitorAlertHistoryRows.length} 条`"
      open
    >
      <div v-if="monitorAlertHistoryRows.length" class="job-table compact-job-table monitor-alert-table monitor-alert-history-table">
        <div class="job-table-header">
          <span>级别</span>
          <span>报警</span>
          <span>状态</span>
        </div>
        <div
          v-for="alert in monitorAlertHistoryRows"
          :key="monitorAlertMergeKey(alert)"
          class="job-row"
        >
          <StatusPill
            class="monitor-alert-severity-pill"
            :tone="monitorAlertSeverityTone(alert.severity)"
            :label="localizeStatusPillLabel(monitorAlertSeverityLabel(alert.severity))"
          />
          <div class="monitor-alert-detail">
            <strong>{{ alert.title }}</strong>
            <ul class="monitor-alert-detail-list">
              <li
                v-for="(bullet, bulletIndex) in monitorAlertDetailBullets(alert, shouldIncludeMonitorAlertLifecycle(alert))"
                :key="`${alert.alertId}:${bullet.label}:${bulletIndex}`"
              >
                <span>{{ bullet.label }}：</span>
                <span>{{ bullet.text }}</span>
              </li>
            </ul>
          </div>
          <span>
            {{ formatCompactDate(alert.resolvedAt || alert.lastSeenAt || alert.firstSeenAt) }}
            <button
              v-if="alert.ackRequired && !alert.acknowledgedAt"
              class="tool-button tool-button-ghost"
              type="button"
              :disabled="isBusy(`monitor-alert:ack:${alert.alertId}`)"
              :aria-busy="isBusy(`monitor-alert:ack:${alert.alertId}`)"
              @click="acknowledgeMonitorAlert(alert.alertId)"
            >
              {{ isBusy(`monitor-alert:ack:${alert.alertId}`) ? "确认中" : "确认关闭" }}
            </button>
          </span>
        </div>
      </div>
      <ConsoleEmptyState v-if="monitorAlertHistoryRows.length === 0" title="暂无历史记录" />
    </ConfigFoldCard>
    <ConfigFoldCard title="报警报文配置 JSON" open>
      <div class="monitor-alert-config-editor json-editor">
        <textarea
          v-model="monitorAlertConfigText"
          rows="14"
          spellcheck="false"
          aria-label="报警报文配置 JSON"
        />
        <div class="monitor-alert-config-actions">
          <button
            class="primary-action"
            type="button"
            :disabled="!canAdminMaintenanceAgent || isBusy('monitor-alerts:save')"
            :aria-busy="isBusy('monitor-alerts:save')"
            @click="saveMonitorAlertConfig"
          >
            {{ isBusy("monitor-alerts:save") ? "保存中" : "保存报警配置" }}
          </button>
        </div>
      </div>
    </ConfigFoldCard>
  </article>
</template>
