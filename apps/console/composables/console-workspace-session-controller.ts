import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { HistorySessionPanelItem } from "../types/app";
import type {
  WsSession,
  WsSessionContext,
  WsSessionDetail,
} from "../types/workspaces";
import { errorMessage } from "@meshrix/ui-console/error-message";
import * as workspacesClient from "../lib/workspaces-client";

type WorkspaceSessionControllerOptions = {
  sessions: Ref<WsSession[]>;
  selectedId: Ref<string>;
  /** Scoped to the workspace namespace so unrelated work never disables this list. */
  isBusyPrefix: (prefix: string) => boolean;
  localError: Ref<string>;
  formatCompactDate: (value: string) => string;
  setBusy: (key: string) => void;
  clearBusy: (key: string) => void;
  reloadWorkspaceList: () => Promise<void>;
};

function sessionLatestTimestamp(session: WsSession) : any {
  return String(session.lastEvent?.createdAt || session.updatedAt || session.createdAt || "");
}

export function useWorkspaceSessionController(options: WorkspaceSessionControllerOptions) : any {
  const selectedSessionId: any = ref("");
  const selectedSession: any = ref<WsSessionDetail | null>(null);
  const sessionContextData: any = ref<WsSessionContext | null>(null);

  const orderedSessions: any = computed(() : any =>
    [...options.sessions.value].sort((left?: any, right?: any) : any => {
      const timeCompare: any = sessionLatestTimestamp(right).localeCompare(sessionLatestTimestamp(left));
      if (timeCompare !== 0) return timeCompare;
      return String(right.sessionId || "").localeCompare(String(left.sessionId || ""));
    }),
  );

  const sessionItems: any = computed<HistorySessionPanelItem[]>(() : any =>
    orderedSessions.value.map((session?: any) : any => ({
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
      disabled: options.isBusyPrefix("ws:"),
      actionLabel: "分叉",
      actionAriaLabel: `从 ${session.title || session.sessionId} 分叉`,
    })),
  );

  async function selectSession(id: string) : Promise<any> {
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
    finally { options.clearBusy("ws:session"); }
  }

  async function forkSession(id: string) : Promise<any> {
    if (!id) return;
    options.setBusy("ws:fork");
    options.localError.value = "";
    try {
      const result: any = await workspacesClient.forkWorkspaceSession(id);
      await options.reloadWorkspaceList();
      if (result.session?.sessionId) {
        await selectSession(result.session.sessionId);
      }
    } catch (e: unknown) { options.localError.value = errorMessage(e); }
    finally { options.clearBusy("ws:fork"); }
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
