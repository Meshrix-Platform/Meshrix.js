import {
  asArray,
  asPlainObject,
  redactSecretText,
  safeJsonParse,
  textFromContent,
  truncateText
} from "./shared.ts";

function sanitizePayload(value?: any, depth: any = 0) : any {
  if (depth > 8) {
    return "[MaxDepth]";
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateText(redactSecretText(value), 4000);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => sanitizePayload(item, depth + 1));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const output: Record<string, any> = {};
  for (const [key, item] of (Object.entries(value) as [string, any][])) {
    const lower: any = key.toLowerCase();
    if (
      lower.includes("apikey") ||
      lower.includes("api_key") ||
      lower === "token" ||
      lower.endsWith("token") ||
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "set-cookie"
    ) {
      output[key] = item ? "[REDACTED]" : "";
      continue;
    }
    output[key] = sanitizePayload(item, depth + 1);
  }
  return output;
}

function summarizeMessages(messages: any = []) : any {
  return asArray(messages).map((message?: any, index?: any) : any => {
    const value: any = asPlainObject(message);
    const contentText: any = textFromContent(value.content, { includeReasoning: true });
    const reasoningText: any = textFromContent(value.reasoning_content ?? value.reasoning, {
      includeReasoning: true
    });
    return {
      index,
      role: String(value.role || ""),
      contentLength: contentText.length,
      contentPreview: truncateText(contentText.replace(/\s+/g, " ").trim(), 500),
      hasReasoningContent: Boolean(reasoningText),
      reasoningLength: reasoningText.length,
      toolCallNames: asArray(value.tool_calls)
        .map((call?: any) : any => String(call?.function?.name || call?.name || "").trim())
        .filter(Boolean),
      toolCallIds: asArray(value.tool_calls)
        .map((call?: any) : any => String(call?.id || call?.tool_call_id || "").trim())
        .filter(Boolean),
      toolCallId: value.tool_call_id ? String(value.tool_call_id) : ""
    };
  });
}

function publicGatewayCompactionResult(compaction: any = null) : any {
  if (!compaction) {
    return null;
  }
  return {
    protocolVersion: compaction.protocolVersion || "",
    status: compaction.status || "",
    compacted: compaction.compacted === true,
    strategy: compaction.strategy || "",
    triggerReason: compaction.triggerReason || "",
    degraded: compaction.degraded === true,
    degradedReasons: compaction.degradedReasons || [],
    boundaryId: compaction.boundary?.boundaryId || "",
    tokenReport: compaction.tokenReport || null
  };
}

function summarizeTools(tools: any = []) : any {
  return asArray(tools).map((tool?: any, index?: any) : any => {
    const fn: any = asPlainObject(tool?.function);
    return {
      index,
      type: String(tool?.type || ""),
      name: String(fn.name || tool?.name || ""),
      descriptionLength: String(fn.description || "").length,
      parameterKeys: Object.keys(asPlainObject(fn.parameters?.properties))
    };
  });
}

function summarizeAgentGatewayPayload(payload: Record<string, any> = {}) : any {
  const value: any = asPlainObject(payload);
  return {
    agentName: String(value.agentName || ""),
    pluginList: asArray(value.pluginList),
    questionLength: String(value.question || "").length,
    questionPreview: truncateText(String(value.question || "").replace(/\s+/g, " ").trim(), 500),
    sessionId: String(value.sessionId || ""),
    userId: String(value.userId || ""),
    projectId: String(value.projectId || ""),
    engine: String(value.engine || ""),
    parameters: sanitizePayload(value.parameters || {})
  };
}

function summarizeDeepSeekPayload(payload: Record<string, any> = {}) : any {
  const value: any = asPlainObject(payload);
  return {
    model: String(value.model || ""),
    stream: value.stream === true,
    messages: summarizeMessages(value.messages),
    tools: summarizeTools(value.tools),
    toolChoice: sanitizePayload(value.tool_choice),
    parameters: sanitizePayload(
      Object.fromEntries(
        (Object.entries(value) as [string, any][]).filter(
          ([key]: any[]) : any => !["model", "messages", "stream", "tools", "tool_choice"].includes(key)
        )
      )
    )
  };
}

function summarizeGatewayResult(result: Record<string, any> = {}) : any {
  const answerText: any = String(result.answer || result.text || "");
  const reasoningText: any = asArray(result.chunks?.reasoning).join("");
  return {
    ok: result.ok === true,
    answerLength: answerText.length,
    answerPreview: truncateText(answerText.replace(/\s+/g, " ").trim(), 500),
    hasReasoningContent: Boolean(reasoningText),
    reasoningLength: reasoningText.length,
    toolCalls: asArray(result.toolCalls || result.tool_calls)
      .map((call?: any, index?: any) : any => normalizeGatewayToolCall(call, index))
      .filter(Boolean)
      .map((call?: any) : any => ({
        id: call.id,
        name: call.function.name,
        arguments: sanitizePayload(safeJsonParse(call.function.arguments) || call.function.arguments || {})
      })),
    dialogId: String(result.dialogId || ""),
    finish: result.finish === true,
    payload: sanitizePayload(result.payload || {})
  };
}

function normalizeGatewayToolCall(call: Record<string, any> = {}, index: any = 0) : any {
  if (!call || typeof call !== "object") {
    return null;
  }
  const fn: any = asPlainObject(call.function || call.function_call);
  const name: any = String(call.name || fn.name || "").trim();
  if (!name) {
    return null;
  }
  const args: any = fn.arguments ?? call.arguments ?? {};
  return {
    id: String(call.id || call.tool_call_id || `tool_call_${index + 1}`),
    type: "function",
    function: {
      name,
      arguments:
        typeof args === "string"
          ? args
          : JSON.stringify(asPlainObject(args))
    }
  };
}

function toolCallsFromMessage(message: Record<string, any> = {}) : any {
  const calls: any[] = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const normalized: any = normalizeGatewayToolCall(call, calls.length);
    if (normalized) {
      calls.push(normalized);
    }
  }
  if (message.function_call) {
    const normalized: any = normalizeGatewayToolCall(message.function_call, calls.length);
    if (normalized) {
      calls.push(normalized);
    }
  }
  return calls;
}

export {
  normalizeGatewayToolCall,
  publicGatewayCompactionResult,
  sanitizePayload,
  summarizeAgentGatewayPayload,
  summarizeDeepSeekPayload,
  summarizeGatewayResult,
  summarizeMessages,
  summarizeTools,
  toolCallsFromMessage
};
