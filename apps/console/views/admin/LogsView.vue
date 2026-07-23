<script setup lang="ts">
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue';
import { useServerConsoleShellContext } from '../../composables/serverConsoleShellContext';
import { formatMachineDate } from '../../composables/console-format-utils';
import DataTable from '../../components/DataTable.vue';
import OptionBar from "@lico/ui-console/option-bar";
import StatusPill from '../../components/StatusPill.vue';
const {
  adminView,
  busyKey,
  currentView,
  error,
  exportSystemLogRows,
  filteredSystemLogRows,
  goToSystemLogNextPage,
  goToSystemLogPreviousPage,
  handleSystemLogTableScroll,
  isAuthenticated,
  systemLogColumnWidths,
  systemLogCurrentPage,
  systemLogDisplayStatusLabel,
  systemLogFilters,
  systemLogKindOptionBarOptions,
  systemLogPageCount,
  systemLogPageRange,
  systemLogPageSize,
  systemLogPageSizeOptionBarOptions,
  systemLogPageTotal,
  systemLogStatusOptionBarOptions,
  systemLogTableShellRef,
  monitorAlertSummary,
  paginatedSystemLogRows,
  workQueueSummary,
  serverLogRows,
} = useServerConsoleShellContext();

function handleHeaderDragend(newWidth: number, oldWidth: number, column: any) {
  const key = column.property;
  if (key && key in systemLogColumnWidths.value) {
    systemLogColumnWidths.value[key as keyof typeof systemLogColumnWidths.value] = newWidth;
  }
}

</script>

<template>
          <section id="system-logs" class="surface-card system-log-report">
            <div class="section-header">
              <div>
                <h3>日志记录</h3>
                <p>汇总服务端上传、任务队列、任务、进程、报警、认证和工具调用日志。</p>
              </div>
              <div class="section-tags">
                <span>总计 {{ serverLogRows.length }}</span>
                <span>筛选 {{ filteredSystemLogRows.length }}</span>
                <span>本页 {{ paginatedSystemLogRows.length }}</span>
                <span>队列 {{ workQueueSummary.total }}</span>
                <span>报警 {{ monitorAlertSummary.visibleCount || monitorAlertSummary.activeCount }}</span>
              </div>
            </div>
            <div class="system-log-filters">
              <label class="system-log-filter-field">
                <span>模糊匹配</span>
                <input v-model="systemLogFilters.fuzzy" type="search" placeholder="任意关键词" />
              </label>
              <OptionBar
                v-model="systemLogFilters.kind"
                label="类型"
                :options="systemLogKindOptionBarOptions"
              />
              <OptionBar
                v-model="systemLogFilters.status"
                label="状态"
                :options="systemLogStatusOptionBarOptions"
              />
              <label class="system-log-filter-field">
                <span>开始日期</span>
                <input v-model="systemLogFilters.from" type="date" />
              </label>
              <label class="system-log-filter-field">
                <span>结束日期</span>
                <input v-model="systemLogFilters.to" type="date" />
              </label>
            </div>
            <div class="source-actions system-log-actions">
              <button class="tool-button" type="button" @click="exportSystemLogRows">
                导出 CSV
              </button>
            </div>
            <div ref="systemLogTableShellRef" class="system-log-table-shell">
              <DataTable
                :data="paginatedSystemLogRows"
                row-key="logId"
                empty-text="暂无系统日志"
                @scroll="handleSystemLogTableScroll"
                @header-dragend="handleHeaderDragend"
              >
                <el-table-column prop="kind" label="类型" :min-width="systemLogColumnWidths.kind">
                  <template #default="{ row }">
                    <span class="system-log-kind">{{ row.kindLabel }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="target" label="对象" :min-width="systemLogColumnWidths.target">
                  <template #default="{ row }">
                    <div class="system-log-target">
                      <span class="mono-compact" :title="row.logId">{{ row.logId }}</span>
                      <small>{{ row.target }}</small>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column prop="time" label="时间" :min-width="systemLogColumnWidths.time">
                  <template #default="{ row }">
                    <span class="system-log-time" :title="formatMachineDate(row.occurredAt, 'full')">
                      {{ formatMachineDate(row.occurredAt, 'full') }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="status" label="状态" :min-width="systemLogColumnWidths.status">
                  <template #default="{ row }">
                    <span class="system-log-status">
                      <StatusPill :tone="row.tone" :label="systemLogDisplayStatusLabel(row)" />
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="progress" label="进度" :min-width="systemLogColumnWidths.progress">
                  <template #default="{ row }">
                    <span class="system-log-progress">
                      {{ Math.round(Number(row.progressPercent || 0)) }}%
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="stage" label="阶段" :min-width="systemLogColumnWidths.stage">
                  <template #default="{ row }">
                    <span class="system-log-stage">{{ row.stage }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="detail" label="详情" :min-width="systemLogColumnWidths.detail">
                  <template #default="{ row }">
                    <span class="system-log-detail-text" :title="row.detail">{{ row.detail }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="error" label="错误" :min-width="systemLogColumnWidths.error">
                  <template #default="{ row }">
                    <span class="system-log-error">{{ row.error }}</span>
                  </template>
                </el-table-column>
              </DataTable>
            </div>
            <div class="system-log-pagination" v-if="systemLogPageTotal > 0">
              <div class="system-log-page-size-control">
                <OptionBar
                  v-model="systemLogPageSize"
                  class="system-log-page-size"
                  :options="systemLogPageSizeOptionBarOptions"
                />
              </div>
              <div
                class="system-log-page-indicator"
                :title="`${systemLogPageRange.start}-${systemLogPageRange.end} / ${systemLogPageTotal}`"
              >
                <strong>{{ systemLogCurrentPage }} / {{ systemLogPageCount }}</strong>
              </div>
              <div class="system-log-pagination-controls">
                <button
                  class="tool-button tool-button-ghost system-log-page-button"
                  type="button"
                  :disabled="systemLogCurrentPage <= 1"
                  @click="goToSystemLogPreviousPage"
                >
                  <span class="system-log-page-icon" aria-hidden="true"><ArrowLeft /></span>
                  <span>上一页</span>
                </button>
                <button
                  class="tool-button tool-button-ghost system-log-page-button"
                  type="button"
                  :disabled="systemLogCurrentPage >= systemLogPageCount"
                  @click="goToSystemLogNextPage"
                >
                  <span>下一页</span>
                  <span class="system-log-page-icon" aria-hidden="true"><ArrowRight /></span>
                </button>
              </div>
            </div>
          </section>
</template>
