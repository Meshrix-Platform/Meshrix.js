import {
  asArray,
  asObject,
  estimateContextTokens,
  normalizeCompactionPolicy,
  redactEmbeddedPayloads
} from "./validation.ts";
import type { CompactionPolicy } from "./validation.ts";

export interface NormalizedMessage {
  [key: string]: unknown;
  id: string;
  role: string;
  apiRoundId: string;
  index: number;
  text: string;
  tokenEstimate: number;
}

export interface MessageIndexGroup {
  id: string;
  indexes: number[];
}

export interface ToolUseGroup {
  id: string;
  uses: number[];
  results: number[];
}

export interface MessageGraph {
  messages: NormalizedMessage[];
  toolGroups: ToolUseGroup[];
  apiRoundGroups: MessageIndexGroup[];
  assistantMessageGroups: MessageIndexGroup[];
}

export interface CutPointAdjustment {
  reason: string;
  id: string;
  from: number;
  to: number;
}

export interface CompactionCutPoint {
  cutIndex: number;
  adjustments: CutPointAdjustment[];
  proposedCutIndex: number;
  protectedTail: number;
  compactedCount: number;
  keptCount: number;
}

function blockTextOf(value?: unknown) : string {
  const source = asObject(value);
  return String(source.text || source.content || source.input || source.name || "");
}

function attachmentTextOf(value?: unknown) : string {
  const source = asObject(value);
  return `${source.name || source.fileName || source.path || source.url || ""} ${source.summary || source.text || ""}`;
}

export function messageText(message: Record<string, unknown> = {}) : string {
  const content: unknown = message.content ?? message.text ?? message.summary ?? "";
  const blockText: string = asArray(message.blocks)
    .map((block?: unknown) : string => blockTextOf(block))
    .filter(Boolean)
    .join("\n");
  const attachmentText: string = asArray(message.attachments)
    .map((item?: unknown) : string => attachmentTextOf(item))
    .filter(Boolean)
    .join("\n");
  if (Array.isArray(content)) {
    return [content.map((item?: unknown) : string => {
      const source = asObject(item);
      return String(source.text || source.content || JSON.stringify(item));
    }).join("\n"), blockText, attachmentText]
      .filter(Boolean)
      .map(redactEmbeddedPayloads)
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    return [JSON.stringify(content), blockText, attachmentText].filter(Boolean).map(redactEmbeddedPayloads).join("\n");
  }
  return [content, blockText, attachmentText].filter(Boolean).map(redactEmbeddedPayloads).join("\n");
}

export function normalizeMessage(message: Record<string, unknown> = {}, index = 0) : NormalizedMessage {
  const id: string = String(message.id || message.messageId || message.uuid || `message-${index + 1}`);
  const role: string = String(message.role || message.type || "user").toLowerCase();
  const text: string = messageText(message);
  const apiRoundId: string = String(
    message.apiRoundId ||
    message.roundId ||
    message.requestId ||
    message.conversationTurnId ||
    `round-${Math.max(1, Math.floor(index / 2) + 1)}`
  );
  return {
    ...message,
    id,
    role,
    apiRoundId,
    index,
    text,
    tokenEstimate: estimateContextTokens({ role, text, blocks: message.blocks || [], attachments: message.attachments || [] })
  };
}

export function normalizeMessages(messages: unknown = []) : NormalizedMessage[] {
  return asArray(messages).map((message?: unknown, index?: number) : NormalizedMessage => normalizeMessage(asObject(message), index || 0));
}

export function normalizeConversationInput(input: Record<string, unknown> = {}) : NormalizedMessage[] {
  if (Array.isArray(input.messages)) {
    return normalizeMessages(input.messages);
  }
  if (Array.isArray(input.transcript)) {
    return normalizeMessages(input.transcript);
  }
  const messages: Record<string, unknown>[] = [];
  if (input.history || input.compressedHistory) {
    messages.push({
      id: "history",
      role: "system",
      apiRoundId: "history",
      content: input.history || input.compressedHistory
    });
  }
  for (const [index, turn] of asArray(input.recentTurns).entries()) {
    const source = asObject(turn);
    messages.push({
      ...source,
      id: source.id || source.messageId || `recent-${index + 1}`,
      apiRoundId: source.apiRoundId || source.roundId || `recent-round-${Math.floor(index / 2) + 1}`
    });
  }
  if (input.toolState && Object.keys(asObject(input.toolState)).length) {
    messages.push({
      id: "tool-state",
      role: "tool",
      apiRoundId: "tool-state",
      content: input.toolState
    });
  }
  return normalizeMessages(messages);
}

export function toolUseIds(message: Record<string, unknown> = {}) : string[] {
  const ids: unknown[] = [];
  if (message.toolUseId || message.tool_use_id || message.toolCallId) {
    ids.push(message.toolUseId || message.tool_use_id || message.toolCallId);
  }
  for (const call of asArray(message.toolCalls || message.tool_calls)) {
    const source = asObject(call);
    ids.push(source.id || source.toolUseId || source.tool_use_id || source.callId);
  }
  for (const block of asArray(message.blocks)) {
    const source = asObject(block);
    if (source.type === "tool_use" || source.type === "tool_call") {
      ids.push(source.id || source.toolUseId || source.tool_use_id || source.callId);
    }
  }
  return ids.map((id?: unknown) : string => String(id || "").trim()).filter(Boolean);
}

export function toolResultIds(message: Record<string, unknown> = {}) : string[] {
  const ids: unknown[] = [];
  if (message.toolUseId || message.tool_use_id || message.toolCallId) {
    ids.push(message.toolUseId || message.tool_use_id || message.toolCallId);
  }
  for (const result of asArray(message.toolResults || message.tool_results)) {
    const source = asObject(result);
    ids.push(source.toolUseId || source.tool_use_id || source.id || source.callId);
  }
  for (const block of asArray(message.blocks)) {
    const source = asObject(block);
    if (source.type === "tool_result") {
      ids.push(source.toolUseId || source.tool_use_id || source.id || source.callId);
    }
  }
  return ids.map((id?: unknown) : string => String(id || "").trim()).filter(Boolean);
}

export function buildMessageGraph(messages: unknown = []) : MessageGraph {
  const normalized: NormalizedMessage[] = normalizeMessages(messages);
  const toolGroups = new Map<string, ToolUseGroup>();
  const apiRoundGroups = new Map<string, MessageIndexGroup>();
  const assistantMessageGroups = new Map<string, MessageIndexGroup>();
  for (const message of normalized) {
    if (!apiRoundGroups.has(message.apiRoundId)) {
      apiRoundGroups.set(message.apiRoundId, { id: message.apiRoundId, indexes: [] });
    }
    apiRoundGroups.get(message.apiRoundId)?.indexes.push(message.index);

    if (message.role === "assistant" && message.id) {
      if (!assistantMessageGroups.has(message.id)) {
        assistantMessageGroups.set(message.id, { id: message.id, indexes: [] });
      }
      assistantMessageGroups.get(message.id)?.indexes.push(message.index);
    }

    for (const id of toolUseIds(message)) {
      const group = toolGroups.get(id) || { id, uses: [], results: [] };
      group.uses.push(message.index);
      toolGroups.set(id, group);
    }
    if (message.role === "tool" || message.type === "tool_result" || asArray(message.blocks).some((block?: unknown) : boolean => asObject(block).type === "tool_result")) {
      for (const id of toolResultIds(message)) {
        const group = toolGroups.get(id) || { id, uses: [], results: [] };
        group.results.push(message.index);
        toolGroups.set(id, group);
      }
    }
  }
  return {
    messages: normalized,
    toolGroups: [...toolGroups.values()],
    apiRoundGroups: [...apiRoundGroups.values()],
    assistantMessageGroups: [...assistantMessageGroups.values()]
  };
}

function groupCrossesCut(indexes: number[], cutIndex: number) : boolean {
  if (indexes.length < 2) {
    return false;
  }
  return indexes.some((index: number) : boolean => index < cutIndex) && indexes.some((index: number) : boolean => index >= cutIndex);
}

function adjustCutPointForGraph(graph: MessageGraph, proposedCutIndex: number) : { cutIndex: number; adjustments: CutPointAdjustment[] } {
  let cutIndex: number = Math.max(0, Math.min(proposedCutIndex, graph.messages.length));
  let changed: boolean = true;
  const adjustments: CutPointAdjustment[] = [];
  while (changed) {
    changed = false;
    for (const group of graph.toolGroups) {
      const indexes: number[] = [...group.uses, ...group.results].filter(Number.isInteger);
      if (groupCrossesCut(indexes, cutIndex)) {
        const nextCut: number = Math.min(...indexes);
        if (nextCut < cutIndex) {
          adjustments.push({ reason: "tool_chain_protection", id: group.id, from: cutIndex, to: nextCut });
          cutIndex = nextCut;
          changed = true;
        }
      }
    }
    for (const group of graph.apiRoundGroups) {
      if (groupCrossesCut(group.indexes, cutIndex)) {
        const nextCut: number = Math.min(...group.indexes);
        if (nextCut < cutIndex) {
          adjustments.push({ reason: "api_round_protection", id: group.id, from: cutIndex, to: nextCut });
          cutIndex = nextCut;
          changed = true;
        }
      }
    }
    for (const group of graph.assistantMessageGroups) {
      if (groupCrossesCut(group.indexes, cutIndex)) {
        const nextCut: number = Math.min(...group.indexes);
        if (nextCut < cutIndex) {
          adjustments.push({ reason: "assistant_message_id_protection", id: group.id, from: cutIndex, to: nextCut });
          cutIndex = nextCut;
          changed = true;
        }
      }
    }
  }
  return { cutIndex, adjustments };
}

export function chooseCompactionCutPoint(
  messages: unknown = [],
  { profile = {}, policyPatch = {} }: { profile?: Record<string, unknown>; policyPatch?: CompactionPolicy | Record<string, unknown> } = {}
) : CompactionCutPoint {
  const graph: MessageGraph = buildMessageGraph(messages);
  const policy: CompactionPolicy = normalizeCompactionPolicy(profile, asObject(policyPatch));
  const protectedTurnGroups: MessageIndexGroup[] = graph.apiRoundGroups.slice(-(policy.recentTurnProtectionCount || 0));
  const protectedTurnStart: number = protectedTurnGroups.length
    ? Math.min(...protectedTurnGroups.flatMap((group: MessageIndexGroup) : number[] => group.indexes))
    : graph.messages.length;
  const protectedByTurns: number = graph.messages.length - protectedTurnStart;
  const protectedTail: number = Math.min(
    Math.max(policy.recentMessageProtectionCount || 0, protectedByTurns),
    graph.messages.length
  );
  const proposedCutIndex: number = Math.max(0, graph.messages.length - protectedTail);
  const adjusted = adjustCutPointForGraph(graph, proposedCutIndex);
  return {
    ...adjusted,
    proposedCutIndex,
    protectedTail,
    compactedCount: adjusted.cutIndex,
    keptCount: Math.max(0, graph.messages.length - adjusted.cutIndex)
  };
}
