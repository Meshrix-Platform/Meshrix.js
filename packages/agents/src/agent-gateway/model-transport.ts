import crypto from "node:crypto";
import {
  MAX_AGENT_GATEWAY_RESPONSE_BYTES,
  asArray,
  asPlainObject,
  asStringList,
  safeJsonParse,
  safeUrlSummary,
  textFromContent,
} from "./shared.ts";
import { appendAgentGatewayAudit } from "./audit.ts";
import {
  normalizeGatewayToolCall,
  summarizeDeepSeekPayload,
  summarizeGatewayResult,
  toolCallsFromMessage
} from "./projections.ts";
import {
  closeConfiguredModelFetch,
  createHeaders,
  fetchConfiguredModelService,
  gatewayResponseTooLargeError,
  readGatewayErrorDetails,
  readGatewayResponseTextWithLimit,
  byteLengthOfChunk
} from "./transport-helpers.ts";
import {
  agentGatewayError,
  agentGatewayHttpError,
  normalizeAgentGatewayError
} from "./errors.ts";
function reasoningTextFromMessage(message: Record<string, any> = {}, delta: Record<string, any> = {}) : any {
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
    .map((item?: any) : any => textFromContent(item, { includeReasoning: true }))
    .join("");
}

const DEEPSEEK_PARAMETER_KEYS: any = new Set<any>([
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

const OPENAI_COMPATIBLE_PARAMETER_KEYS: any = new Set<any>([
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

const CHAT_COMPLETIONS_RESERVED_KEYS: any = new Set<any>(["model", "messages"]);

function normalizeDeepSeekMessages(value?: any) : any {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((message?: any) : any => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const role: any = String(message.role || "").trim();
      if (!role) {
        return null;
      }
      const normalized: Record<string, any> = {
        role,
        content:
          message.content === undefined || message.content === null
            ? ""
            : message.content
      };
      const reasoningContent: any =
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

function resolveDeepSeekModel(input: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  if (config.modelFieldPresent === true && !String(config.model || config.engine || "").trim()) {
    return "";
  }
  const candidates: any[] = [
    input.engine,
    input.model,
    config.engine,
    config.model
  ];
  for (const candidate of candidates) {
    const model: any = String(candidate || "").trim();
    if (!model || model === config.alias || model === config.provider) {
      continue;
    }
    return model;
  }
  return "";
}

function normalizeMeshrixThinkingMode(value?: any) : any {
  const mode: any = String(value || "").trim().toLowerCase();
  return ["enabled", "disabled"].includes(mode) ? mode : "";
}

function applyMeshrixThinkingMode(parameters: Record<string, any> = {}, config: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  const mode: any = normalizeMeshrixThinkingMode(parameters.meshrix_thinking_mode);
  delete parameters.meshrix_thinking_mode;
  if (!mode) {
    return parameters;
  }
  const model: any = resolveDeepSeekModel(input, config);
  const isQwenCompatible: any =
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

function buildChatMessages(input: Record<string, any> = {}, config: Record<string, any> = {}, parameters: Record<string, any> = {}) : any {
  const messages: any = normalizeDeepSeekMessages(input.messages);
  const configuredSystemPrompt: any = String(
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

function buildDeepSeekRequest(input: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  const parameters: Record<string, any> = {
    ...asPlainObject(config.parameters),
    ...asPlainObject(input.parameters)
  };
  applyMeshrixThinkingMode(parameters, config, input);
  const messages: any = buildChatMessages(input, config, parameters);
  delete parameters.systemPrompt;

  const model: any = resolveDeepSeekModel(input, config);
  if (!model) {
    throw agentGatewayError("agent_gateway_not_configured");
  }

  const body: Record<string, any> = {
    model,
    messages,
    stream: input.stream === true || parameters.stream === true
  };

  for (const [key, value] of (Object.entries(parameters) as [string, any][])) {
    if (DEEPSEEK_PARAMETER_KEYS.has(key) && value !== undefined && value !== null) {
      body[key] = value;
    }
  }

  return body;
}

function buildOpenAiCompatibleRequest(input: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  const configParameters: any = asPlainObject(config.parameters);
  const inputParameters: any = asPlainObject(input.parameters);
  const parameters: Record<string, any> = {
    ...configParameters,
    ...inputParameters
  };
  applyMeshrixThinkingMode(parameters, config, input);
  const extraBody: Record<string, any> = {
    ...asPlainObject(configParameters.extra_body),
    ...asPlainObject(inputParameters.extra_body)
  };
  const messages: any = buildChatMessages(input, config, parameters);
  delete parameters.systemPrompt;
  delete parameters.extra_body;

  const model: any = resolveDeepSeekModel(input, config);
  if (!model) {
    throw agentGatewayError("agent_gateway_not_configured");
  }

  const body: Record<string, any> = {
    model,
    messages,
    stream: input.stream === true || parameters.stream === true
  };

  for (const [key, value] of (Object.entries(extraBody) as [string, any][])) {
    if (
      !CHAT_COMPLETIONS_RESERVED_KEYS.has(key) &&
      value !== undefined &&
      value !== null
    ) {
      body[key] = value;
    }
  }

  for (const [key, value] of (Object.entries(parameters) as [string, any][])) {
    if (OPENAI_COMPATIBLE_PARAMETER_KEYS.has(key) && value !== undefined && value !== null) {
      body[key] = value;
    }
  }

  return body;
}

function deepSeekEvent(type?: any, content?: any, extra: Record<string, any> = {}) : any {
  return {
    type,
    content,
    nodeId: extra.nodeId || null,
    riskDescription: null,
    finish: extra.finish === true
  };
}

function parseDeepSeekJsonPayload(json?: any) : any {
  const choices: any = Array.isArray(json?.choices) ? json.choices : [];
  const answerParts: any[] = [];
  const reasoningParts: any[] = [];
  const toolCalls: any[] = [];
  let finish: any = false;
  for (const choice of choices) {
    const message: any = asPlainObject(choice?.message);
    const delta: any = asPlainObject(choice?.delta);
    const content: any =
      message.content === undefined || message.content === null
        ? delta.content
        : message.content;
    const answerText: any = textFromContent(content);
    if (answerText) {
      answerParts.push(answerText);
    }
    const reasoningText: any = reasoningTextFromMessage(message, delta);
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
  const answer: any = answerParts.join("");
  return {
    answer,
    text: answer,
    dialogId: String(json?.id || ""),
    finish: finish || Boolean(json?.id),
    events: [
      ...reasoningParts.map((content?: any) : any => deepSeekEvent("reasoning", content)),
      ...answerParts.map((content?: any) : any => deepSeekEvent("answer", content, { finish }))
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

async function readDeepSeekJsonResponse(response?: any) : Promise<any> {
  const text: any = await readGatewayResponseTextWithLimit(response, { label: "DeepSeek response" });
  if (text.includes("data:")) {
    return parseDeepSeekStreamText(text);
  }
  const json: any = safeJsonParse(text);
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

export function parseDeepSeekStreamText(streamText?: any) : any {
  const answerParts: any[] = [];
  const reasoningParts: any[] = [];
  const toolCallParts: Map<number, any> = new Map<number, any>();
  const events: any[] = [];
  let dialogId: any = "";
  let finish: any = false;
  let model: any = "";

  const mergeToolCallDelta: any = (call: Record<string, any> = {}, fallbackIndex: any = 0) : any => {
    if (!call || typeof call !== "object") {
      return;
    }
    const index: any = Number.isInteger(call.index) ? call.index : fallbackIndex;
    const current: any =
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
    const fn: any = asPlainObject(call.function || call.function_call);
    if (fn.name !== undefined && fn.name !== null) {
      current.function.name = String(fn.name);
    }
    if (fn.arguments !== undefined && fn.arguments !== null) {
      current.function.arguments += String(fn.arguments);
    }
    toolCallParts.set(index, current);
  };

  for (const rawLine of String(streamText || "").split(/\r?\n/)) {
    const line: any = rawLine.trim();
    if (!line || !line.startsWith("data:")) {
      continue;
    }
    const payloadText: any = line.slice("data:".length).trim();
    if (!payloadText) {
      continue;
    }
    if (payloadText === "[DONE]") {
      finish = true;
      continue;
    }
    const payload: any = safeJsonParse(payloadText);
    if (!payload) {
      continue;
    }
    dialogId = dialogId || String(payload.id || "");
    model = model || String(payload.model || "");
    const choices: any = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta: any = asPlainObject(choice.delta);
      const reasoningText: any = reasoningTextFromMessage({}, delta);
      if (reasoningText) {
        const content: any = reasoningText;
        reasoningParts.push(content);
        events.push(deepSeekEvent("reasoning", content));
      }
      const answerText: any = textFromContent(delta.content);
      if (answerText) {
        const content: any = answerText;
        answerParts.push(content);
        events.push(deepSeekEvent("answer", content));
      }
      asArray(delta.tool_calls).forEach((call?: any, index?: any) : any => {
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
  const answer: any = answerParts.join("");
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
      .sort((left: [number, any], right: [number, any]) : any => left[0] - right[0])
      .map((entry: [number, any], index: number) : any => normalizeGatewayToolCall(entry[1], index))
      .filter(Boolean),
    payload: {
      id: dialogId,
      model
    }
  };
}

async function readDeepSeekStreamResponse(response?: any) : Promise<any> {
  const decoder: any = new TextDecoder();
  let pending: any = "";
  let streamText: any = "";
  let totalBytes: any = 0;
  for await (const chunk of response.body) {
    totalBytes += byteLengthOfChunk(chunk);
    if (totalBytes > MAX_AGENT_GATEWAY_RESPONSE_BYTES) {
      throw gatewayResponseTooLargeError("DeepSeek stream response");
    }
    pending += decoder.decode(chunk, { stream: true });
    let lineEndIndex: any = pending.indexOf("\n");
    while (lineEndIndex >= 0) {
      const rawLine: any = pending.slice(0, lineEndIndex).replace(/\r$/, "");
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
}: Record<string, any> = {}) : Promise<any> {
  if (!config.token) {
    throw agentGatewayError("agent_gateway_credential_missing");
  }
  const question: any = String(input.question || input.query || "").trim();
  if (!question && !Array.isArray(input.messages)) {
    throw agentGatewayError("agent_gateway_invalid_input");
  }
  const payload: any = buildDeepSeekRequest(input, config);
  const request: Record<string, any> = {
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
  const auditCallId: any = crypto.randomUUID();
  const upstreamTarget: any = safeUrlSummary(config.url);
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
  const abortController: any = new AbortController();
  const timeout: any = setTimeout(() : any => abortController.abort(), config.timeoutMs);
  let response: any;
  let pinnedFetch: any = null;
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
  } catch (error: any) {
    const failure: any = normalizeAgentGatewayError(error);
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
        errorCode: failure.code
      }
    });
    throw failure;
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (!response.ok) {
      await readGatewayErrorDetails(response, "DeepSeek error response");
      const failure: any = agentGatewayHttpError(response.status);
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
          errorCode: failure.code
        }
      });
      throw failure;
    }

    const contentType: any = String(response.headers.get("content-type") || "");
    const parsed: any =
      /text\/event-stream/i.test(contentType) && response.body
        ? await readDeepSeekStreamResponse(response)
        : await readDeepSeekJsonResponse(response);
    const result: Record<string, any> = {
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
}: Record<string, any> = {}) : Promise<any> {
  const provider: any = config.provider || "openai-compatible";
  if (provider !== "local-model" && !config.token) {
    throw agentGatewayError("agent_gateway_credential_missing");
  }
  const question: any = String(input.question || input.query || "").trim();
  if (!question && !Array.isArray(input.messages)) {
    throw agentGatewayError("agent_gateway_invalid_input");
  }
  const payload: any = buildOpenAiCompatibleRequest(input, config);
  const request: Record<string, any> = {
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
  const auditCallId: any = crypto.randomUUID();
  const upstreamTarget: any = safeUrlSummary(config.url);
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
  const abortController: any = new AbortController();
  const timeout: any = setTimeout(() : any => abortController.abort(), config.timeoutMs);
  let response: any;
  let pinnedFetch: any = null;
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
  } catch (error: any) {
    const failure: any = normalizeAgentGatewayError(error);
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
        errorCode: failure.code
      }
    });
    throw failure;
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (!response.ok) {
      await readGatewayErrorDetails(response, `${config.label || provider} error response`);
      const failure: any = agentGatewayHttpError(response.status);
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
          errorCode: failure.code
        }
      });
      throw failure;
    }

    const contentType: any = String(response.headers.get("content-type") || "");
    const parsed: any =
      /text\/event-stream/i.test(contentType) && response.body
        ? await readDeepSeekStreamResponse(response)
        : await readDeepSeekJsonResponse(response);
    const result: Record<string, any> = {
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
