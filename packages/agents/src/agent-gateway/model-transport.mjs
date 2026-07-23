import crypto from "node:crypto";
import {
  asArray,
  asPlainObject,
  asStringList,
  redactSecretText,
  safeJsonParse,
  safeUrlSummary,
  textFromContent,
  truncateText
} from "./shared.mjs";
import { appendAgentGatewayAudit } from "./audit.mjs";
import {
  normalizeGatewayToolCall,
  summarizeDeepSeekPayload,
  summarizeGatewayResult,
  toolCallsFromMessage
} from "./projections.mjs";
import {
  closeConfiguredModelFetch,
  createHeaders,
  fetchConfiguredModelService,
  gatewayResponseTooLargeError,
  readGatewayErrorDetails,
  readGatewayResponseTextWithLimit,
  byteLengthOfChunk
} from "./transport-helpers.mjs";
function reasoningTextFromMessage(message = {}, delta = {}) {
  return [
    message.reasoning_content,
    delta.reasoning_content,
    message.reasoning,
    delta.reasoning,
    message.reasoning_details,
    delta.reasoning_details,
    message.thinking,
    delta.thinking
  ]
    .map((item) => textFromContent(item, { includeReasoning: true }))
    .join("");
}

const DEEPSEEK_PARAMETER_KEYS = new Set([
  "frequency_penalty",
  "logprobs",
  "max_tokens",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "temperature",
  "thinking",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p"
]);

const OPENAI_COMPATIBLE_PARAMETER_KEYS = new Set([
  ...DEEPSEEK_PARAMETER_KEYS,
  "best_of",
  "chat_template_kwargs",
  "echo",
  "guided_choice",
  "guided_decoding_backend",
  "guided_grammar",
  "guided_json",
  "guided_regex",
  "ignore_eos",
  "include_stop_str_in_output",
  "min_p",
  "min_tokens",
  "n",
  "parallel_tool_calls",
  "repetition_penalty",
  "skip_special_tokens",
  "spaces_between_special_tokens",
  "stream_options",
  "top_k",
  "use_beam_search"
]);

const CHAT_COMPLETIONS_RESERVED_KEYS = new Set(["model", "messages"]);

function normalizeDeepSeekMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const role = String(message.role || "").trim();
      if (!role) {
        return null;
      }
      const normalized = {
        role,
        content:
          message.content === undefined || message.content === null
            ? ""
            : message.content
      };
      const reasoningContent =
        message.reasoning_content === undefined || message.reasoning_content === null
          ? message.reasoning
          : message.reasoning_content;
      if (reasoningContent !== undefined && reasoningContent !== null) {
        normalized.reasoning_content = textFromContent(reasoningContent, {
          includeReasoning: true
        });
      }
      if (message.tool_calls !== undefined && message.tool_calls !== null) {
        normalized.tool_calls = message.tool_calls;
      }
      if (message.tool_call_id !== undefined && message.tool_call_id !== null) {
        normalized.tool_call_id = String(message.tool_call_id);
      }
      if (message.name !== undefined && message.name !== null) {
        normalized.name = String(message.name);
      }
      return normalized;
    })
    .filter(Boolean);
}

function resolveDeepSeekModel(input = {}, config = {}) {
  if (config.modelFieldPresent === true && !String(config.model || config.engine || "").trim()) {
    return "";
  }
  const candidates = [
    input.engine,
    input.model,
    config.engine,
    config.model
  ];
  for (const candidate of candidates) {
    const model = String(candidate || "").trim();
    if (!model || model === config.alias || model === config.provider) {
      continue;
    }
    return model;
  }
  return "";
}

function normalizeLicoThinkingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["enabled", "disabled"].includes(mode) ? mode : "";
}

function applyLicoThinkingMode(parameters = {}, config = {}, input = {}) {
  const mode = normalizeLicoThinkingMode(parameters.lico_thinking_mode);
  delete parameters.lico_thinking_mode;
  if (!mode) {
    return parameters;
  }
  const model = resolveDeepSeekModel(input, config);
  const isQwenCompatible =
    String(config.provider || "").trim() === "local-model" ||
    /qwen/i.test(model);
  if (isQwenCompatible) {
    parameters.chat_template_kwargs = {
      ...asPlainObject(parameters.chat_template_kwargs),
      enable_thinking: mode === "enabled"
    };
    return parameters;
  }
  if (parameters.thinking === undefined || parameters.thinking === null) {
    parameters.thinking = { type: mode };
  }
  return parameters;
}

function buildChatMessages(input = {}, config = {}, parameters = {}) {
  const messages = normalizeDeepSeekMessages(input.messages);
  const configuredSystemPrompt = String(
    input.systemPrompt || config.systemPrompt || parameters.systemPrompt || ""
  ).trim();
  if (messages.length === 0) {
    if (configuredSystemPrompt) {
      messages.push({ role: "system", content: configuredSystemPrompt });
    }
    messages.push({
      role: "user",
      content: String(input.question || input.query || "").trim()
    });
  } else if (configuredSystemPrompt) {
    messages.unshift({ role: "system", content: configuredSystemPrompt });
  }
  return messages;
}

function buildDeepSeekRequest(input = {}, config = {}) {
  const parameters = {
    ...asPlainObject(config.parameters),
    ...asPlainObject(input.parameters)
  };
  applyLicoThinkingMode(parameters, config, input);
  const messages = buildChatMessages(input, config, parameters);
  delete parameters.systemPrompt;

  const model = resolveDeepSeekModel(input, config);
  if (!model) {
    throw new Error("DeepSeek 模型 ID 为空，不能发起模型调用。");
  }

  const body = {
    model,
    messages,
    stream: input.stream === true || parameters.stream === true
  };

  for (const [key, value] of Object.entries(parameters)) {
    if (DEEPSEEK_PARAMETER_KEYS.has(key) && value !== undefined && value !== null) {
      body[key] = value;
    }
  }

  return body;
}

function buildOpenAiCompatibleRequest(input = {}, config = {}) {
  const configParameters = asPlainObject(config.parameters);
  const inputParameters = asPlainObject(input.parameters);
  const parameters = {
    ...configParameters,
    ...inputParameters
  };
  applyLicoThinkingMode(parameters, config, input);
  const extraBody = {
    ...asPlainObject(configParameters.extra_body),
    ...asPlainObject(inputParameters.extra_body)
  };
  const messages = buildChatMessages(input, config, parameters);
  delete parameters.systemPrompt;
  delete parameters.extra_body;

  const model = resolveDeepSeekModel(input, config);
  if (!model) {
    throw new Error(`${config.label || config.provider || "OpenAI-compatible"} model ID is required.`);
  }

  const body = {
    model,
    messages,
    stream: input.stream === true || parameters.stream === true
  };

  for (const [key, value] of Object.entries(extraBody)) {
    if (
      !CHAT_COMPLETIONS_RESERVED_KEYS.has(key) &&
      value !== undefined &&
      value !== null
    ) {
      body[key] = value;
    }
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (OPENAI_COMPATIBLE_PARAMETER_KEYS.has(key) && value !== undefined && value !== null) {
      body[key] = value;
    }
  }

  return body;
}

function deepSeekEvent(type, content, extra = {}) {
  return {
    type,
    content,
    nodeId: extra.nodeId || null,
    riskDescription: null,
    finish: extra.finish === true
  };
}

function parseDeepSeekJsonPayload(json) {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const answerParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  let finish = false;
  for (const choice of choices) {
    const message = asPlainObject(choice?.message);
    const delta = asPlainObject(choice?.delta);
    const content =
      message.content === undefined || message.content === null
        ? delta.content
        : message.content;
    const answerText = textFromContent(content);
    if (answerText) {
      answerParts.push(answerText);
    }
    const reasoningText = reasoningTextFromMessage(message, delta);
    if (reasoningText) {
      reasoningParts.push(reasoningText);
    }
    for (const call of toolCallsFromMessage(message)) {
      toolCalls.push(call);
    }
    if (choice?.finish_reason) {
      finish = true;
    }
  }
  const answer = answerParts.join("");
  return {
    answer,
    text: answer,
    dialogId: String(json?.id || ""),
    finish: finish || Boolean(json?.id),
    events: [
      ...reasoningParts.map((content) => deepSeekEvent("reasoning", content)),
      ...answerParts.map((content) => deepSeekEvent("answer", content, { finish }))
    ],
    chunks: {
      answer: answerParts,
      reasoning: reasoningParts
    },
    toolCalls,
    payload: {
      id: json?.id || "",
      model: json?.model || "",
      usage: json?.usage || null
    }
  };
}

async function readDeepSeekJsonResponse(response) {
  const text = await readGatewayResponseTextWithLimit(response, { label: "DeepSeek response" });
  if (text.includes("data:")) {
    return parseDeepSeekStreamText(text);
  }
  const json = safeJsonParse(text);
  if (!json) {
    return {
      answer: text,
      text,
      dialogId: "",
      finish: true,
      events: [],
      payload: text
    };
  }
  return parseDeepSeekJsonPayload(json);
}

export function parseDeepSeekStreamText(streamText) {
  const answerParts = [];
  const reasoningParts = [];
  const toolCallParts = new Map();
  const events = [];
  let dialogId = "";
  let finish = false;
  let model = "";

  const mergeToolCallDelta = (call = {}, fallbackIndex = 0) => {
    if (!call || typeof call !== "object") {
      return;
    }
    const index = Number.isInteger(call.index) ? call.index : fallbackIndex;
    const current =
      toolCallParts.get(index) || {
        id: "",
        type: "function",
        function: {
          name: "",
          arguments: ""
        }
      };
    if (call.id !== undefined && call.id !== null) {
      current.id = String(call.id);
    }
    if (call.type !== undefined && call.type !== null) {
      current.type = String(call.type || "function") || "function";
    }
    const fn = asPlainObject(call.function || call.function_call);
    if (fn.name !== undefined && fn.name !== null) {
      current.function.name = String(fn.name);
    }
    if (fn.arguments !== undefined && fn.arguments !== null) {
      current.function.arguments += String(fn.arguments);
    }
    toolCallParts.set(index, current);
  };

  for (const rawLine of String(streamText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("data:")) {
      continue;
    }
    const payloadText = line.slice("data:".length).trim();
    if (!payloadText) {
      continue;
    }
    if (payloadText === "[DONE]") {
      finish = true;
      continue;
    }
    const payload = safeJsonParse(payloadText);
    if (!payload) {
      continue;
    }
    dialogId = dialogId || String(payload.id || "");
    model = model || String(payload.model || "");
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta = asPlainObject(choice.delta);
      const reasoningText = reasoningTextFromMessage({}, delta);
      if (reasoningText) {
        const content = reasoningText;
        reasoningParts.push(content);
        events.push(deepSeekEvent("reasoning", content));
      }
      const answerText = textFromContent(delta.content);
      if (answerText) {
        const content = answerText;
        answerParts.push(content);
        events.push(deepSeekEvent("answer", content));
      }
      asArray(delta.tool_calls).forEach((call, index) => {
        mergeToolCallDelta(call, index);
      });
      if (delta.function_call) {
        mergeToolCallDelta({ index: 0, function: delta.function_call }, 0);
      }
      if (choice.finish_reason) {
        finish = true;
      }
    }
  }
  const answer = answerParts.join("");
  return {
    answer,
    text: answer,
    dialogId,
    finish,
    events,
    chunks: {
      answer: answerParts,
      reasoning: reasoningParts
    },
    toolCalls: Array.from(toolCallParts.entries())
      .sort(([left], [right]) => left - right)
      .map(([, call], index) => normalizeGatewayToolCall(call, index))
      .filter(Boolean),
    payload: {
      id: dialogId,
      model
    }
  };
}

async function readDeepSeekStreamResponse(response) {
  const decoder = new TextDecoder();
  let pending = "";
  let streamText = "";
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += byteLengthOfChunk(chunk);
    if (totalBytes > MAX_AGENT_GATEWAY_RESPONSE_BYTES) {
      throw gatewayResponseTooLargeError("DeepSeek stream response");
    }
    pending += decoder.decode(chunk, { stream: true });
    let lineEndIndex = pending.indexOf("\n");
    while (lineEndIndex >= 0) {
      const rawLine = pending.slice(0, lineEndIndex).replace(/\r$/, "");
      pending = pending.slice(lineEndIndex + 1);
      streamText += `${rawLine}\n`;
      lineEndIndex = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) {
    streamText += pending;
  }
  return parseDeepSeekStreamText(streamText);
}

async function callDeepSeekGateway({
  config,
  input = {},
  fetchImpl = fetch,
  userDataPath = "",
  lookup
} = {}) {
  if (!config.token) {
    throw new Error("DeepSeek API Key 未配置。");
  }
  const question = String(input.question || input.query || "").trim();
  if (!question && !Array.isArray(input.messages)) {
    throw new Error("question 不能为空。");
  }
  const payload = buildDeepSeekRequest(input, config);
  const request = {
    agentName: String(input.agentName || config.agentName || "").trim(),
    pluginList: asStringList(input.pluginList ?? config.pluginList),
    question,
    sessionId: String(input.sessionId || "").trim(),
    userId: String(input.userId || "").trim(),
    projectId: String(input.projectId || "").trim(),
    engine: payload.model,
    parameters: {
      ...asPlainObject(config.parameters),
      ...asPlainObject(input.parameters)
    }
  };
  const auditCallId = crypto.randomUUID();
  const upstreamTarget = safeUrlSummary(config.url);
  await appendAgentGatewayAudit({
    userDataPath,
    event: {
      event: "request_started",
      callId: auditCallId,
      provider: "deepseek",
      alias: config.alias,
      model: payload.model,
      upstreamTarget,
      timeoutMs: config.timeoutMs,
      request: summarizeDeepSeekPayload(payload)
    }
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);
  let response;
  let pinnedFetch = null;
  try {
    pinnedFetch = await fetchConfiguredModelService({
      config,
      fetchImpl,
      lookup,
      init: {
        method: "POST",
        headers: createHeaders(config),
        body: JSON.stringify(payload),
        signal: abortController.signal
      }
    });
    response = pinnedFetch.response;
  } catch (error) {
    await appendAgentGatewayAudit({
      userDataPath,
      event: {
        event: "request_failed",
        callId: auditCallId,
        provider: "deepseek",
        alias: config.alias,
        model: payload.model,
        upstreamTarget,
        errorStage: "transport",
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (!response.ok) {
      const details = await readGatewayErrorDetails(response, "DeepSeek error response");
      const publicDetails = truncateText(redactSecretText(details), 8000);
      await appendAgentGatewayAudit({
        userDataPath,
        event: {
          event: "request_failed",
          callId: auditCallId,
          provider: "deepseek",
          alias: config.alias,
          model: payload.model,
          upstreamTarget,
          errorStage: "http",
          status: response.status,
          contentType: String(response.headers.get("content-type") || ""),
          error: publicDetails
        }
      });
      throw new Error(`DeepSeek 调用失败：${response.status}${publicDetails ? ` ${publicDetails}` : ""}`.trim());
    }

    const contentType = String(response.headers.get("content-type") || "");
    const parsed =
      /text\/event-stream/i.test(contentType) && response.body
        ? await readDeepSeekStreamResponse(response)
        : await readDeepSeekJsonResponse(response);
    const result = {
      ok: true,
      request: {
        ...request,
        engine: payload.model
      },
      upstream: {
        provider: "deepseek",
        status: response.status,
        contentType,
        model: payload.model
      },
      ...parsed
    };
    await appendAgentGatewayAudit({
      userDataPath,
      event: {
        event: "request_completed",
        callId: auditCallId,
        provider: "deepseek",
        alias: config.alias,
        model: payload.model,
        upstreamTarget,
        status: response.status,
        contentType,
        response: summarizeGatewayResult(result)
      }
    });
    return result;
  } finally {
    await closeConfiguredModelFetch(pinnedFetch);
  }
}

async function callOpenAiCompatibleGateway({
  config,
  input = {},
  fetchImpl = fetch,
  userDataPath = "",
  lookup
} = {}) {
  const provider = config.provider || "openai-compatible";
  if (provider !== "local-model" && !config.token) {
    throw new Error(`${config.label || provider} API Key 未配置。`);
  }
  const question = String(input.question || input.query || "").trim();
  if (!question && !Array.isArray(input.messages)) {
    throw new Error("question 不能为空。");
  }
  const payload = buildOpenAiCompatibleRequest(input, config);
  const request = {
    agentName: String(input.agentName || config.agentName || "").trim(),
    pluginList: asStringList(input.pluginList ?? config.pluginList),
    question,
    sessionId: String(input.sessionId || "").trim(),
    userId: String(input.userId || "").trim(),
    projectId: String(input.projectId || "").trim(),
    engine: payload.model,
    parameters: {
      ...asPlainObject(config.parameters),
      ...asPlainObject(input.parameters)
    }
  };
  const auditCallId = crypto.randomUUID();
  const upstreamTarget = safeUrlSummary(config.url);
  await appendAgentGatewayAudit({
    userDataPath,
    event: {
      event: "request_started",
      callId: auditCallId,
      provider,
      alias: config.alias,
      model: payload.model,
      upstreamTarget,
      timeoutMs: config.timeoutMs,
      request: summarizeDeepSeekPayload(payload)
    }
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);
  let response;
  let pinnedFetch = null;
  try {
    pinnedFetch = await fetchConfiguredModelService({
      config,
      fetchImpl,
      lookup,
      init: {
        method: "POST",
        headers: createHeaders(config),
        body: JSON.stringify(payload),
        signal: abortController.signal
      }
    });
    response = pinnedFetch.response;
  } catch (error) {
    await appendAgentGatewayAudit({
      userDataPath,
      event: {
        event: "request_failed",
        callId: auditCallId,
        provider,
        alias: config.alias,
        model: payload.model,
        upstreamTarget,
        errorStage: "transport",
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (!response.ok) {
      const details = await readGatewayErrorDetails(response, `${config.label || provider} error response`);
      const publicDetails = truncateText(redactSecretText(details), 8000);
      await appendAgentGatewayAudit({
        userDataPath,
        event: {
          event: "request_failed",
          callId: auditCallId,
          provider,
          alias: config.alias,
          model: payload.model,
          upstreamTarget,
          errorStage: "http",
          status: response.status,
          contentType: String(response.headers.get("content-type") || ""),
          error: publicDetails
        }
      });
      throw new Error(`${config.label || provider} 调用失败：${response.status}${publicDetails ? ` ${publicDetails}` : ""}`.trim());
    }

    const contentType = String(response.headers.get("content-type") || "");
    const parsed =
      /text\/event-stream/i.test(contentType) && response.body
        ? await readDeepSeekStreamResponse(response)
        : await readDeepSeekJsonResponse(response);
    const result = {
      ok: true,
      request: {
        ...request,
        engine: payload.model
      },
      upstream: {
        provider,
        status: response.status,
        contentType,
        model: payload.model
      },
      ...parsed
    };
    await appendAgentGatewayAudit({
      userDataPath,
      event: {
        event: "request_completed",
        callId: auditCallId,
        provider,
        alias: config.alias,
        model: payload.model,
        upstreamTarget,
        status: response.status,
        contentType,
        response: summarizeGatewayResult(result)
      }
    });
    return result;
  } finally {
    await closeConfiguredModelFetch(pinnedFetch);
  }
}

export { callDeepSeekGateway, callOpenAiCompatibleGateway };
