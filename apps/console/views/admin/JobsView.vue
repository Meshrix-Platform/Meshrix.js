<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useServerConsoleShellContext } from '../../composables/serverConsoleShellContext';
import { jobStatusLabels } from '../../composables/console-defaults';
import { formatCompactDate, jobStatusTone } from '../../composables/console-format-utils';
import { jobElapsed } from '../../composables/console-job-display-utils';
import { queueLifecycleLabel } from '../../composables/console-status-utils';
import {
  drainWorkQueue,
  inspectWorkQueue,
  pauseWorkQueue,
  resumeWorkQueue,
} from '../../lib/jobs-client';
import StatusPill from '../../components/StatusPill.vue';
import ConsoleEmptyState from '../../components/ConsoleEmptyState.vue';
import ConsoleInlineAlert from '../../components/ConsoleInlineAlert.vue';
const {
  busyKey,
  consoleState,
  cancelJob,
  deleteJob,
  workQueueRows,
  workQueueSummary,
  workQueueObservationState,
  recentJobs,
} = useServerConsoleShellContext();

const workQueueBusy = ref('');
const workQueueError = ref('');
const workQueueState = ref<any | null>(null);

const workQueueEnabled = computed(() => workQueueState.value?.enabled === true);
const workQueueDescription = computed(() => workQueueState.value?.description?.queue || null);
const workQueueStateCounts = computed(() => workQueueState.value?.stateCounts || []);
const workQueueItems = computed(() => workQueueState.value?.items || []);

async function refreshWorkQueue() {
  workQueueError.value = '';
  try {
    workQueueState.value = await inspectWorkQueue(100);
  } catch (error) {
    workQueueError.value = error instanceof Error ? error.message : '读取基础队列失败。';
  }
}

async function runWorkQueueAction(action: 'pause' | 'resume' | 'drain') {
  workQueueBusy.value = action;
  workQueueError.value = '';
  try {
    if (action === 'pause') await pauseWorkQueue();
    if (action === 'resume') await resumeWorkQueue();
    if (action === 'drain') await drainWorkQueue();
    await refreshWorkQueue();
  } catch (error) {
    workQueueError.value = error instanceof Error ? error.message : '队列操作失败。';
  } finally {
    workQueueBusy.value = '';
  }
}

onMounted(() => {
  void refreshWorkQueue();
});
</script>

<template>
  <section id="jobs" class="surface-card jobs-card">
    <div class="section-header">
      <div>
        <h3>队列状态</h3>
      </div>
      <div class="section-tags">
        <span>队列 {{ workQueueSummary.total }}</span>
        <span>活跃 {{ workQueueSummary.active }}</span>
        <span>中断 {{ workQueueSummary.interrupted }}</span>
        <span>恢复 {{ workQueueSummary.recovered }}</span>
        <span>观察样本 {{ workQueueObservationState?.itemCount || 0 }}</span>
        <span>失败 {{ workQueueObservationState?.statusCounts?.failed || 0 }}</span>
      </div>
    </div>

    <section class="queue-status-section">
      <div class="section-header compact-section-header">
        <div>
          <h4>基础队列</h4>
        </div>
        <div class="section-tags">
          <span>{{ workQueueEnabled ? '已启用' : '未启用' }}</span>
          <span>{{ workQueueDescription?.storeKind || 'sqlite' }}</span>
          <span>飞行 {{ workQueueDescription?.execution?.inFlight || 0 }}</span>
          <span>额度 {{ workQueueDescription?.execution?.availableCapacity || 0 }}</span>
        </div>
      </div>
      <ConsoleInlineAlert v-if="workQueueError" tone="danger">{{ workQueueError }}</ConsoleInlineAlert>
      <div class="queue-toolbar">
        <div class="queue-action-row">
          <button class="table-action" type="button" :disabled="Boolean(workQueueBusy)" @click="refreshWorkQueue">
            刷新
          </button>
          <button class="table-action" type="button" :disabled="Boolean(workQueueBusy) || !workQueueEnabled" @click="runWorkQueueAction('pause')">
            {{ workQueueBusy === 'pause' ? '暂停中' : '暂停' }}
          </button>
          <button class="table-action" type="button" :disabled="Boolean(workQueueBusy) || !workQueueEnabled" @click="runWorkQueueAction('resume')">
            {{ workQueueBusy === 'resume' ? '恢复中' : '恢复' }}
          </button>
          <button class="table-action" type="button" :disabled="Boolean(workQueueBusy) || !workQueueEnabled" @click="runWorkQueueAction('drain')">
            {{ workQueueBusy === 'drain' ? '排空中' : '排空' }}
          </button>
        </div>
        <div class="section-tags queue-state-counts">
          <span v-for="entry in workQueueStateCounts" :key="entry.state">{{ entry.state }} {{ entry.count }}</span>
          <span>样本 {{ workQueueItems.length }}</span>
        </div>
      </div>
    </section>

    <section class="queue-status-section">
      <div class="job-table compact-job-table work-queue-table">
        <div class="job-table-header">
          <span>队列</span>
          <span>来源</span>
          <span>状态</span>
          <span>心跳 / 更新时间</span>
          <span>说明</span>
        </div>
        <div
          v-for="row in workQueueRows"
          :key="row.rowId"
          class="job-row"
        >
          <span>
            <strong>{{ row.label }}</strong>
            <small>{{ row.queueId }}</small>
          </span>
          <span>
            <strong>{{ row.sourceLabel }}</strong>
            <small>{{ row.kind }} · {{ row.ownerId || "无 owner" }}</small>
          </span>
          <StatusPill :tone="row.tone" :label="queueLifecycleLabel(row.lifecycleStatus || row.status)" />
          <span>
            <strong>{{ formatCompactDate(row.lastHeartbeatAt || row.updatedAt || row.startedAt) }}</strong>
            <small>{{ row.updatedAt ? `更新 ${formatCompactDate(row.updatedAt)}` : "无更新时间" }}</small>
          </span>
          <span>
            <strong>{{ row.phase || row.status }}</strong>
            <small>{{ row.detail }}</small>
          </span>
        </div>
      </div>
      <ConsoleEmptyState v-if="workQueueRows.length === 0" data-ui="empty-state" title="暂无队列记录" description="当前没有导入、智能巡检或队列监控记录。" />
    </section>
  </section>

  <section class="surface-card jobs-card">
    <div class="section-header">
      <div>
        <h3>任务记录</h3>
      </div>
      <div class="section-tags">
        <span>总计 {{ consoleState?.jobs?.summary?.totalCount || 0 }}</span>
        <span>完成 {{ consoleState?.jobs?.summary?.completedCount || 0 }}</span>
        <span>失败 {{ consoleState?.jobs?.summary?.failedCount || 0 }}</span>
      </div>
    </div>
    <div class="table-shell">
      <table class="jobs-table">
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>队列 ID</th>
            <th>状态</th>
            <th>进度</th>
            <th>耗时</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="recentJobs.length > 0">
          <tr v-for="item in recentJobs" :key="item.id">
            <td>
              <div class="primary-cell">
                <strong>{{ item.id }}</strong>
                <span>{{ item.stage }}</span>
              </div>
            </td>
            <td>
              <span class="url-badge">{{ item.queueId || "未登记" }}</span>
            </td>
            <td>
              <StatusPill :tone="jobStatusTone(item.status)" :label="jobStatusLabels[item.status]" />
            </td>
            <td class="progress-cell">
              <div class="progress-track">
                <div
                  class="progress-fill"
                  :style="{ width: `${item.progressPercent}%` }"
                />
              </div>
              <span>{{ item.progressPercent }}%</span>
            </td>
            <td>
              <div class="time-cell">
                <strong>{{ jobElapsed(item) }}</strong>
                <span>{{ formatCompactDate(item.updatedAt) }}</span>
              </div>
            </td>
            <td>
              <button
                v-if="['queued', 'running'].includes(item.status)"
                class="table-action"
                type="button"
                :disabled="busyKey === `job:${item.id}`"
                @click="cancelJob(item.id)"
              >
                取消
              </button>
              <button
                class="table-action"
                type="button"
                :disabled="busyKey === `job:${item.id}`"
                @click="deleteJob(item.id)"
              >
                {{ busyKey === `job:${item.id}` ? "处理中" : "删除" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <ConsoleEmptyState v-if="recentJobs.length === 0" title="暂无任务记录" description="当前筛选条件下没有匹配任务。" />
    </div>
  </section>
</template>
