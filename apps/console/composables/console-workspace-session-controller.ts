import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { HistorySessionPanelItem } from "../types/app";
import type {
  WsSession,
  WsSessionContext,
  WsSessionDetail,
} from "../types/workspaces";
import { errorMessage } from "@lico/ui-console/error-message";
import * as workspacesClient from "../lib/workspaces-client";

type WorkspaceSessionControllerOptions = {
  sessions: Ref<WsSession[]>;
  selectedId: Ref<string>;
  busyKey: ComputedRef<string>;
  localError: Ref<string>;
  formatCompactDate: (value: string) => string;
  setBusy: (key: string) => void;
  clearBusy: () => void;
  reloadWorkspaceList: () => Promise<void>;
};

function sessionLatestTimestamp(session: WsSession) {
  return String(session.lastEvent?.createdAt || session.updatedAt || session.createdAt || "");
}

export function useWorkspaceSessionController(options: WorkspaceSessionControllerOptions) {
  const selectedSessionId = ref("");
  const selectedSession = ref<WsSessionDetail | null>(null);
  const sessionContextData = ref<WsSessionContext | null>(null);

  const orderedSessions = computed(() =>
    [...options.sessions.value].sort((left, right) => {
      const timeCompare = sessionLatestTimestamp(right).localeCompare(sessionLatestTimestamp(left));
      if (timeCompare !== 0) return timeCompare;
      return String(right.sessionId || "").localeCompare(String(left.sessionId || ""));
    }),
  );

  const sessionItems = computed<HistorySessionPanelItem[]>(() =>
    orderedSessions.value.map((session) => ({
      id: session.sessionId,
      title: session.title || session.sessionId.slice(0, 12),
      meta: [
        session.workspace?.title || session.workspaceId.slice(0, 12),
        `${session.eventCount || 0} 事件`,
        session.parentSessionId ? `分支 ${session.branchIndex || 1}` : "主线",
        options.formatCompactDate(sessionLatestTimestamp(session)),
	      ].filter(Boolean).join("，"),
      preview: session.lastEvent?.summary || session.objective || "暂无会话事件",
      active: selectedSessionId.value === session.sessionId,
      disabled: !!options.busyKey.value,
      actionLabel: "分叉",
      actionAriaLabel: `从 ${session.title || session.sessionId} 分叉`,
    })),
  );

  async function selectSession(id: string) {
    if (!id) return;
    options.setBusy("ws:session");
    options.localError.value = "";
    try {
      const { sessionData, context } = await workspacesClient.getWorkspaceSessionBundle(id);
      selectedSessionId.value = id;
      selectedSession.value = sessionData;
      sessionContextData.value = context;
      if (context.workspaceId && options.selectedId.value !== context.workspaceId) {
        options.selectedId.value = context.workspaceId;
      }
    } catch (e: unknown) { options.localError.value = errorMessage(e); }
    finally { options.clearBusy(); }
  }

  async function forkSession(id: string) {
    if (!id) return;
    options.setBusy("ws:fork");
    options.localError.value = "";
    try {
      const result = await workspacesClient.forkWorkspaceSession(id);
      await options.reloadWorkspaceList();
      if (result.session?.sessionId) {
        await selectSession(result.session.sessionId);
      }
    } catch (e: unknown) { options.localError.value = errorMessage(e); }
    finally { options.clearBusy(); }
  }

  return {
    selectedSessionId,
    selectedSession,
    sessionContextData,
    sessionItems,
    selectSession,
    forkSession,
  };
}
