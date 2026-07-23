<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch } from "vue";
import "./ConsoleSideNavDirectory.css";
import { formatCompactDate } from "../../../composables/console-format-utils";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import type { HistorySessionPanelItem } from "../../../types/app";
import type { McpAuthorizationRequest } from "../../../lib/authorization-governance-client";
import type { OperationPermissionPendingOperation } from "../../../lib/operation-permission-client";
import type { WsWorkspace } from "../../../types/workspaces";

defineOptions({ name: "ConsoleSideNavDirectory" });

type DirectoryItem = HistorySessionPanelItem & {
  anchorId?: string;
  badges?: DirectoryBadge[];
  statusKey?: string;
};

type DirectoryBadge = {
  label: string;
  title?: string;
  tone?: "success" | "warning" | "danger" | "info" | "muted" | "neutral";
};

const {
  activeSideNavDirectory,
  approvalFlowConsole,
  returnToPrimarySideNav,
  setSideNavDirectoryWidth,
  showSideNavDirectory,
  sideNavDirectoryMinWidth,
  sideNavDirectoryWidth,
  workspacesConsole,
} = useConsoleSideNavContext();

const directoryTitle = computed(() => {
  if (activeSideNavDirectory.value === "approval") return "待办事项";
  if (activeSideNavDirectory.value === "workspaces") return "工作空间";
  return "";
});

const directoryToggleLabel = computed(() => showSideNavDirectory.value ? "收起索引栏" : "展开索引栏");

const workspaceItems = computed<DirectoryItem[]>(() =>
  workspacesConsole.workspaces.value.map((workspace: WsWorkspace) => ({
    id: workspace.workspaceId,
    title: workspace.title || workspace.workspaceId.slice(0, 12),
    active: workspacesConsole.selectedId.value === workspace.workspaceId,
    badges: [
      activeBadge(workspacesConsole.selectedId.value === workspace.workspaceId),
      statusBadge(workspace.status),
      timeBadge(workspace.updatedAt),
    ].filter(Boolean) as DirectoryBadge[],
    anchorId: `workspace-${workspace.workspaceId}`,
  })),
);

const pendingApprovalItems = computed<DirectoryItem[]>(() =>
  approvalItems().filter((item) => item.statusKey === "pending"),
);

const approvalHistoryItems = computed<DirectoryItem[]>(() =>
  approvalItems().filter((item) => item.statusKey !== "pending"),
);

watch(
  activeSideNavDirectory,
  (directory) => {
    if (directory === "approval") {
      void Promise.all([
        approvalFlowConsole.refreshMcpAuthorizationRequests(),
        approvalFlowConsole.refreshOperationPermissionPendingOperations(),
      ]);
    }
    if (directory === "workspaces") {
      void workspacesConsole.load();
    }
  },
  { immediate: true },
);

function authorizationStatusLabel(status: unknown) {
  if (status === "pending") return "待审批";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  if (status === "completed") return "已完成";
  if (status === "expired") return "已过期";
  if (status === "failed") return "失败";
  return String(status || "未知状态");
}

function approvalItems() {
  const authorizationItems = approvalFlowConsole.mcpAuthorizationRequests.value.map((request: McpAuthorizationRequest) => ({
    id: `authorization:${request.requestId}`,
    title: request.clientName || request.requestId,
    badges: [
      { label: "MCP", tone: "info" },
      { label: authorizationStatusLabel(request.status), tone: statusTone(request.status) },
      timeBadge(recordTimestamp(request)),
    ].filter(Boolean) as DirectoryBadge[],
    statusKey: String(request.status || ""),
    anchorId: `approval-authorization:${request.requestId}`,
  }));
  const pendingOperationItems = approvalFlowConsole.operationPermissionPendingOperations.value.map((
    operation: OperationPermissionPendingOperation,
  ) => ({
    id: `pending-operation:${operation.pendingOperationId}`,
    title: operation.toolId || operation.operationId || operation.pendingOperationId,
    badges: [
      { label: "OP", tone: "info" },
      { label: authorizationStatusLabel(operation.status), tone: statusTone(operation.status) },
      operation.risk ? { label: String(operation.risk), tone: "neutral" } : null,
      timeBadge(recordTimestamp(operation)),
    ].filter(Boolean) as DirectoryBadge[],
    statusKey: String(operation.status || ""),
    anchorId: `approval-pendingOperation:${operation.pendingOperationId}`,
  }));
  return [...authorizationItems, ...pendingOperationItems];
}

async function scrollToAnchor(anchorId?: string) {
  if (!anchorId) return;
  await nextTick();
  window.requestAnimationFrame(() => {
    document.getElementById(anchorId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

function selectWorkspaceItem(item: DirectoryItem) {
  workspacesConsole.panel.value = "list";
  workspacesConsole.selectedId.value = item.id;
  void scrollToAnchor(item.anchorId);
}

function activeBadge(active?: boolean): DirectoryBadge {
  return active
    ? { label: "当前", tone: "success" }
    : { label: "未选中", tone: "muted" };
}

function timeBadge(value = ""): DirectoryBadge | null {
  return value ? { label: formatCompactDate(value), title: "最后更新", tone: "neutral" } : null;
}

function statusBadge(status: unknown): DirectoryBadge | null {
  const value = String(status || "").trim();
  return value ? { label: statusLabel(value), tone: statusTone(value) } : null;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "活跃",
    approved: "已批准",
    completed: "完成",
    error: "异常",
    failed: "失败",
    idle: "空闲",
    partial: "部分监听",
    pending: "待处理",
    queued: "排队中",
    rejected: "已拒绝",
    resolved: "已处理",
    running: "运行中",
    stopped: "停止",
    syncing: "同步中",
    watching: "监听中",
  };
  return labels[status] || status;
}

function statusTone(status: unknown): DirectoryBadge["tone"] {
  const value = String(status || "");
  if (["active", "approved", "completed", "resolved", "watching"].includes(value)) return "success";
  if (["pending", "partial", "queued", "syncing", "running"].includes(value)) return "warning";
  if (["error", "failed", "rejected"].includes(value)) return "danger";
  if (["idle", "stopped"].includes(value)) return "muted";
  return "neutral";
}

function recordTimestamp(record: Record<string, unknown>) {
  return String(record.updatedAt || record.createdAt || record.requestedAt || record.resolvedAt || "");
}

let stopResizeListeners: (() => void) | null = null;

function stopDirectoryResize() {
  stopResizeListeners?.();
  stopResizeListeners = null;
  document.body.classList.remove("is-resizing-side-nav-directory");
}

function startDirectoryResize(event: PointerEvent) {
  if (!showSideNavDirectory.value || event.button !== 0) {
    return;
  }
  event.preventDefault();
  stopDirectoryResize();

  const target = event.currentTarget as HTMLElement | null;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startWidth = sideNavDirectoryWidth.value;

  target?.setPointerCapture?.(pointerId);
  document.body.classList.add("is-resizing-side-nav-directory");

  const handlePointerMove = (moveEvent: PointerEvent) => {
    setSideNavDirectoryWidth(startWidth + moveEvent.clientX - startX);
  };
  const handlePointerUp = () => {
    target?.releasePointerCapture?.(pointerId);
    stopDirectoryResize();
  };

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp, { once: true });
  window.addEventListener("pointercancel", handlePointerUp, { once: true });

  stopResizeListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };
}

function handleResizeKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  setSideNavDirectoryWidth(sideNavDirectoryWidth.value + (event.key === "ArrowRight" ? 16 : -16));
}

onBeforeUnmount(stopDirectoryResize);
</script>

<template>
  <div class="side-nav-directory" :class="{ 'is-collapsed': !showSideNavDirectory }">
    <header v-if="showSideNavDirectory" class="side-nav-directory-header">
      <button
        class="side-nav-directory-back"
        type="button"
        :aria-label="directoryToggleLabel"
        :title="directoryToggleLabel"
        @click="returnToPrimarySideNav"
      >
        <svg class="side-link-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
      </button>
      <div>
        <h2>{{ directoryTitle }}</h2>
      </div>
    </header>

    <div v-if="showSideNavDirectory" class="side-nav-directory-content">
      <template v-if="activeSideNavDirectory === 'approval'">
        <section class="side-nav-directory-section">
          <ul class="side-nav-directory-list">
            <li
              v-for="item in pendingApprovalItems"
              :key="item.id"
              class="side-nav-directory-item"
            >
              <button class="side-nav-directory-item-main" type="button" @click="scrollToAnchor(item.anchorId)">
                <span class="side-nav-directory-item-title">{{ item.title }}</span>
                <span v-if="item.badges?.length" class="side-nav-directory-item-badges">
                  <span v-for="badge in item.badges" :key="`${item.id}:${badge.label}`" class="side-nav-directory-status-pill" :data-tone="badge.tone || 'neutral'" :title="badge.title">{{ badge.label }}</span>
                </span>
              </button>
            </li>
            <li v-if="!pendingApprovalItems.length" class="side-nav-directory-empty">暂无待处理事项</li>
          </ul>
        </section>
        <section class="side-nav-directory-section">
          <p class="side-nav-directory-section-title">历史记录</p>
          <ul class="side-nav-directory-list">
            <li
              v-for="item in approvalHistoryItems"
              :key="item.id"
              class="side-nav-directory-item"
            >
              <button class="side-nav-directory-item-main" type="button" @click="scrollToAnchor(item.anchorId)">
                <span class="side-nav-directory-item-title">{{ item.title }}</span>
                <span v-if="item.badges?.length" class="side-nav-directory-item-badges">
                  <span v-for="badge in item.badges" :key="`${item.id}:${badge.label}`" class="side-nav-directory-status-pill" :data-tone="badge.tone || 'neutral'" :title="badge.title">{{ badge.label }}</span>
                </span>
              </button>
            </li>
            <li v-if="!approvalHistoryItems.length" class="side-nav-directory-empty">暂无历史记录</li>
          </ul>
        </section>
      </template>

      <section v-else-if="activeSideNavDirectory === 'workspaces'" class="side-nav-directory-section">
        <ul class="side-nav-directory-list">
          <li
            v-for="item in workspaceItems"
            :key="item.id"
            class="side-nav-directory-item"
            :data-active="item.active"
          >
            <button class="side-nav-directory-item-main" type="button" @click="selectWorkspaceItem(item)">
              <span class="side-nav-directory-item-title">{{ item.title }}</span>
              <span v-if="item.badges?.length" class="side-nav-directory-item-badges">
                <span v-for="badge in item.badges" :key="`${item.id}:${badge.label}`" class="side-nav-directory-status-pill" :data-tone="badge.tone || 'neutral'" :title="badge.title">{{ badge.label }}</span>
              </span>
            </button>
          </li>
          <li v-if="!workspaceItems.length" class="side-nav-directory-empty">暂无工作空间</li>
        </ul>
      </section>
    </div>
    <div
      v-if="showSideNavDirectory"
      class="side-nav-directory-resize"
      role="separator"
      aria-orientation="vertical"
      :aria-valuemin="sideNavDirectoryMinWidth"
      :aria-valuenow="sideNavDirectoryWidth"
      tabindex="0"
      title="拖拽调整索引栏宽度"
      @pointerdown="startDirectoryResize"
      @keydown="handleResizeKeydown"
    ></div>
  </div>
</template>
