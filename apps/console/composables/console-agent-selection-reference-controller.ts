import { ref, watch } from "vue";
import type { SystemLogRow } from "../types/app";

export const AGENT_SELECTION_REFERENCE_LOG_LIMIT: any = 80;

type AgentSelectionReferenceState = "empty" | "available" | "removed";

type AgentSelectionReferenceSnapshot = {
  alias: string;
  state: AgentSelectionReferenceState;
};

type AgentSelectionOptionLike = {
  enabled: boolean;
  label?: string;
  selectable: boolean;
};

export function createConsoleAgentSelectionReferenceController() : any {
  const agentSelectionReferenceLogs: any = ref<SystemLogRow[]>([]);
  const agentSelectionReferenceStates: any = ref<Record<string, AgentSelectionReferenceSnapshot>>({});

  function normalizeAgentSelectionAlias(value?: string) : any {
    return String(value || "").trim();
  }

  function emitAgentSelectionReferenceLog(params: {
    context: string;
    contextLabel: string;
    alias: string;
    stage: "lost" | "restored";
    reason: string;
  }) : any {
    const now: any = new Date().toISOString();
    const statusLabel: any = params.stage === "lost" ? "引用丢失" : "引用恢复";
    const tone: SystemLogRow["tone"] = params.stage === "lost" ? "warning" : "success";
    const logId: any = `${params.context}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const row: SystemLogRow = {
      logId,
      kindLabel: "智能体引用",
      displayId: "ref",
      target: `${params.contextLabel}（${params.alias}）`,
      status: params.stage === "lost" ? "missing" : "available",
      statusLabel,
      tone,
      stage: params.reason,
      occurredAt: now,
      createdAt: now,
      progressPercent: 100,
      detail: params.reason,
      error: params.stage === "lost" ? params.reason : "",
    };
    console.warn("[agent-selection-ref]", params.context, params.stage, params.alias, params.reason);
    agentSelectionReferenceLogs.value = [row, ...agentSelectionReferenceLogs.value].slice(
      0,
      AGENT_SELECTION_REFERENCE_LOG_LIMIT,
    );
  }

  function trackAgentSelectionReference(
    context: string,
    contextLabel: string,
    alias: string,
    selectedOption: AgentSelectionOptionLike,
  ) : any {
    const normalizedAlias: any = normalizeAgentSelectionAlias(alias);
    const nextState: AgentSelectionReferenceState = normalizedAlias
      ? selectedOption.selectable
        ? "available"
        : "removed"
      : "empty";
    const previous: any = agentSelectionReferenceStates.value[context] || { alias: "", state: "empty" };
    if (previous.alias === normalizedAlias && previous.state === nextState) {
      return;
    }
    if (normalizedAlias && previous.state === "available" && nextState === "removed") {
      emitAgentSelectionReferenceLog({
        context,
        contextLabel,
        alias: normalizedAlias,
        stage: "lost",
        reason: `${normalizedAlias} 不在当前列表，显示为“已移除的智能体”。`,
      });
    } else if (normalizedAlias && previous.state === "removed" && nextState === "available") {
      emitAgentSelectionReferenceLog({
        context,
        contextLabel,
        alias: normalizedAlias,
        stage: "restored",
        reason: `${normalizedAlias} 已重新出现在列表，空引用已恢复。`,
      });
    } else if (normalizedAlias && previous.state === "empty" && nextState === "removed") {
      emitAgentSelectionReferenceLog({
        context,
        contextLabel,
        alias: normalizedAlias,
        stage: "lost",
        reason: `${normalizedAlias} 初始加载时未匹配到可用列表，页面显示“已移除的智能体”。`,
      });
    }
    agentSelectionReferenceStates.value = {
      ...agentSelectionReferenceStates.value,
      [context]: { alias: normalizedAlias, state: nextState },
    };
  }

  function watchAgentSelectionReference(
    context: string,
    contextLabel: string,
    getAlias: () => string,
    getSelection: () => AgentSelectionOptionLike,
  ) : any {
    watch(
      () : any => [
        normalizeAgentSelectionAlias(getAlias()),
        getSelection().enabled,
        getSelection().selectable,
        getSelection().label,
      ],
      () : any => {
        const alias: any = normalizeAgentSelectionAlias(getAlias());
        trackAgentSelectionReference(context, contextLabel, alias, getSelection());
      },
      { immediate: true },
    );
  }

  return {
    agentSelectionReferenceLogs,
    agentSelectionReferenceStates,
    emitAgentSelectionReferenceLog,
    normalizeAgentSelectionAlias,
    trackAgentSelectionReference,
    watchAgentSelectionReference,
  };
}
