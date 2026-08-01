import {
  asArray,
  asObject,
  estimateContextTokens,
  normalizeCompactionPolicy,
  redactEmbeddedPayloads
} from "./validation.ts";

export function messageText(message: Record<string, any> = {}) : any {
  const content: any = message.content ?? message.text ?? message.summary ?? "";
  const blockText: any = asArray(message.blocks)
    .map((block?: any) : any => block?.text || block?.content || block?.input || block?.name || "")
    .filter(Boolean)
    .join("\n");
  const attachmentText: any = asArray(message.attachments)
    .map((item?: any) : any => `${item.name || item.fileName || item.path || item.url || ""} ${item.summary || item.text || ""}`)
    .filter(Boolean)
    .join("\n");
  if (Array.isArray(content)) {
    return [content.map((item?: any) : any => item?.text || item?.content || JSON.stringify(item)).join("\n"), blockText, attachmentText]
      .filter(Boolean)
      .map(redactEmbeddedPayloads)
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    return [JSON.stringify(content), blockText, attachmentText].filter(Boolean).map(redactEmbeddedPayloads).join("\n");
  }
  return [content, blockText, attachmentText].filter(Boolean).map(redactEmbeddedPayloads).join("\n");
}

export function normalizeMessage(message: Record<string, any> = {}, index: any = 0) : any {
  const id: any = String(message.id || message.messageId || message.uuid || `message-${index + 1}`);
  const role: any = String(message.role || message.type || "user").toLowerCase();
  const text: any = messageText(message);
  const apiRoundId: any = String(
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

export function normalizeMessages(messages: any = []) : any {
  return asArray(messages).map(normalizeMessage);
}

export function normalizeConversationInput(input: Record<string, any> = {}) : any {
  if (Array.isArray(input.messages)) {
    return normalizeMessages(input.messages);
  }
  if (Array.isArray(input.transcript)) {
    return normalizeMessages(input.transcript);
  }
  const messages: any[] = [];
  if (input.history || input.compressedHistory) {
    messages.push({
      id: "history",
      role: "system",
      apiRoundId: "history",
      content: input.history || input.compressedHistory
    });
  }
  for (const [index, turn] of asArray(input.recentTurns).entries()) {
    messages.push({
      ...turn,
      id: turn.id || turn.messageId || `recent-${index + 1}`,
      apiRoundId: turn.apiRoundId || turn.roundId || `recent-round-${Math.floor(index / 2) + 1}`
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

export function toolUseIds(message: Record<string, any> = {}) : any {
  const ids: any[] = [];
  if (message.toolUseId || message.tool_use_id || message.toolCallId) {
    ids.push(message.toolUseId || message.tool_use_id || message.toolCallId);
  }
  for (const call of asArray(message.toolCalls || message.tool_calls)) {
    ids.push(call.id || call.toolUseId || call.tool_use_id || call.callId);
  }
  for (const block of asArray(message.blocks)) {
    if (block?.type === "tool_use" || block?.type === "tool_call") {
      ids.push(block.id || block.toolUseId || block.tool_use_id || block.callId);
    }
  }
  return ids.map((id?: any) : any => String(id || "").trim()).filter(Boolean);
}

export function toolResultIds(message: Record<string, any> = {}) : any {
  const ids: any[] = [];
  if (message.toolUseId || message.tool_use_id || message.toolCallId) {
    ids.push(message.toolUseId || message.tool_use_id || message.toolCallId);
  }
  for (const result of asArray(message.toolResults || message.tool_results)) {
    ids.push(result.toolUseId || result.tool_use_id || result.id || result.callId);
  }
  for (const block of asArray(message.blocks)) {
    if (block?.type === "tool_result") {
      ids.push(block.toolUseId || block.tool_use_id || block.id || block.callId);
    }
  }
  return ids.map((id?: any) : any => String(id || "").trim()).filter(Boolean);
}

export function buildMessageGraph(messages: any = []) : any {
  const normalized: any = normalizeMessages(messages);
  const toolGroups: any = new Map<any, any>();
  const apiRoundGroups: any = new Map<any, any>();
  const assistantMessageGroups: any = new Map<any, any>();
  for (const message of normalized) {
    if (!apiRoundGroups.has(message.apiRoundId)) {
      apiRoundGroups.set(message.apiRoundId, []);
    }
    apiRoundGroups.get(message.apiRoundId).push(message.index);

    if (message.role === "assistant" && message.id) {
      if (!assistantMessageGroups.has(message.id)) {
        assistantMessageGroups.set(message.id, []);
      }
      assistantMessageGroups.get(message.id).push(message.index);
    }

    for (const id of toolUseIds(message)) {
      const group: any = toolGroups.get(id) || { id, uses: [], results: [] };
      group.uses.push(message.index);
      toolGroups.set(id, group);
    }
    if (message.role === "tool" || message.type === "tool_result" || asArray(message.blocks).some((block?: any) : any => block?.type === "tool_result")) {
      for (const id of toolResultIds(message)) {
        const group: any = toolGroups.get(id) || { id, uses: [], results: [] };
        group.results.push(message.index);
        toolGroups.set(id, group);
      }
    }
  }
  return {
    messages: normalized,
    toolGroups: [...toolGroups.values()],
    apiRoundGroups: [...apiRoundGroups.entries()].map(([id, indexes]: any[]) : any => ({ id, indexes })),
    assistantMessageGroups: [...assistantMessageGroups.entries()].map(([id, indexes]: any[]) : any => ({ id, indexes }))
  };
}

function groupCrossesCut(indexes: any = [], cutIndex?: any) : any {
  if (indexes.length < 2) {
    return false;
  }
  return indexes.some((index?: any) : any => index < cutIndex) && indexes.some((index?: any) : any => index >= cutIndex);
}

function adjustCutPointForGraph(graph?: any, proposedCutIndex?: any) : any {
  let cutIndex: any = Math.max(0, Math.min(proposedCutIndex, graph.messages.length));
  let changed: any = true;
  const adjustments: any[] = [];
  while (changed) {
    changed = false;
    for (const group of graph.toolGroups) {
      const indexes: any = [...group.uses, ...group.results].filter(Number.isInteger);
      if (groupCrossesCut(indexes, cutIndex)) {
        const nextCut: any = Math.min(...indexes);
        if (nextCut < cutIndex) {
          adjustments.push({ reason: "tool_chain_protection", id: group.id, from: cutIndex, to: nextCut });
          cutIndex = nextCut;
          changed = true;
        }
      }
    }
    for (const group of graph.apiRoundGroups) {
      if (groupCrossesCut(group.indexes, cutIndex)) {
        const nextCut: any = Math.min(...group.indexes);
        if (nextCut < cutIndex) {
          adjustments.push({ reason: "api_round_protection", id: group.id, from: cutIndex, to: nextCut });
          cutIndex = nextCut;
          changed = true;
        }
      }
    }
    for (const group of graph.assistantMessageGroups) {
      if (groupCrossesCut(group.indexes, cutIndex)) {
        const nextCut: any = Math.min(...group.indexes);
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

export function chooseCompactionCutPoint(messages: any = [], { profile = {}, policyPatch = {} }: Record<string, any> = {}) : any {
  const graph: any = buildMessageGraph(messages);
  const policy: any = normalizeCompactionPolicy(profile, policyPatch);
  const protectedTurnGroups: any = graph.apiRoundGroups.slice(-policy.recentTurnProtectionCount);
  const protectedTurnStart: any = protectedTurnGroups.length
    ? Math.min(...protectedTurnGroups.flatMap((group?: any) : any => group.indexes))
    : graph.messages.length;
  const protectedByTurns: any = graph.messages.length - protectedTurnStart;
  const protectedTail: any = Math.min(
    Math.max(policy.recentMessageProtectionCount, protectedByTurns),
    graph.messages.length
  );
  const proposedCutIndex: any = Math.max(0, graph.messages.length - protectedTail);
  const adjusted: any = adjustCutPointForGraph(graph, proposedCutIndex);
  return {
    ...adjusted,
    proposedCutIndex,
    protectedTail,
    compactedCount: adjusted.cutIndex,
    keptCount: Math.max(0, graph.messages.length - adjusted.cutIndex)
  };
}
