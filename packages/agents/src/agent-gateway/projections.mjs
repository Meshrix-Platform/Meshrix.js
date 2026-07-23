import {
  asArray,
  asPlainObject,
  redactSecretText,
  safeJsonParse,
  textFromContent,
  truncateText
} from "./shared.mjs";

function sanitizePayload(value, depth = 0) {
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
    return value.map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
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

function summarizeMessages(messages = []) {
  return asArray(messages).map((message, index) => {
    const value = asPlainObject(message);
    const contentText = textFromContent(value.content, { includeReasoning: true });
    const reasoningText = textFromContent(value.reasoning_content ?? value.reasoning, {
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
        .map((call) => String(call?.function?.name || call?.name || "").trim())
        .filter(Boolean),
      toolCallIds: asArray(value.tool_calls)
        .map((call) => String(call?.id || call?.tool_call_id || "").trim())
        .filter(Boolean),
      toolCallId: value.tool_call_id ? String(value.tool_call_id) : ""
    };
  });
}

function publicGatewayCompactionResult(compaction = null) {
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

function summarizeTools(tools = []) {
  return asArray(tools).map((tool, index) => {
    const fn = asPlainObject(tool?.function);
    return {
      index,
      type: String(tool?.type || ""),
      name: String(fn.name || tool?.name || ""),
      descriptionLength: String(fn.description || "").length,
      parameterKeys: Object.keys(asPlainObject(fn.parameters?.properties))
    };
  });
}

function summarizeAgentGatewayPayload(payload = {}) {
  const value = asPlainObject(payload);
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

function summarizeDeepSeekPayload(payload = {}) {
  const value = asPlainObject(payload);
  return {
    model: String(value.model || ""),
    stream: value.stream === true,
    messages: summarizeMessages(value.messages),
    tools: summarizeTools(value.tools),
    toolChoice: sanitizePayload(value.tool_choice),
    parameters: sanitizePayload(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !["model", "messages", "stream", "tools", "tool_choice"].includes(key)
        )
      )
    )
  };
}

function summarizeGatewayResult(result = {}) {
  const answerText = String(result.answer || result.text || "");
  const reasoningText = asArray(result.chunks?.reasoning).join("");
  return {
    ok: result.ok === true,
    answerLength: answerText.length,
    answerPreview: truncateText(answerText.replace(/\s+/g, " ").trim(), 500),
    hasReasoningContent: Boolean(reasoningText),
    reasoningLength: reasoningText.length,
    toolCalls: asArray(result.toolCalls || result.tool_calls)
      .map((call, index) => normalizeGatewayToolCall(call, index))
      .filter(Boolean)
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: sanitizePayload(safeJsonParse(call.function.arguments) || call.function.arguments || {})
      })),
    dialogId: String(result.dialogId || ""),
    finish: result.finish === true,
    payload: sanitizePayload(result.payload || {})
  };
}

function normalizeGatewayToolCall(call = {}, index = 0) {
  if (!call || typeof call !== "object") {
    return null;
  }
  const fn = asPlainObject(call.function || call.function_call);
  const name = String(call.name || fn.name || "").trim();
  if (!name) {
    return null;
  }
  const args = fn.arguments ?? call.arguments ?? {};
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

function toolCallsFromMessage(message = {}) {
  const calls = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const normalized = normalizeGatewayToolCall(call, calls.length);
    if (normalized) {
      calls.push(normalized);
    }
  }
  if (message.function_call) {
    const normalized = normalizeGatewayToolCall(message.function_call, calls.length);
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
