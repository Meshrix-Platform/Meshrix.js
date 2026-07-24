import { fetchWithPinnedDns } from "@meshrix/foundation/security/outbound-egress-policy";
import {
  MAX_AGENT_GATEWAY_RESPONSE_BYTES,
  asArray,
  asPlainObject,
  safeJsonParse,
  textFromContent
} from "./shared.mjs";
import { normalizeModelTokenHeader } from "../agent-configs/credential-binding.mjs";
import { toolCallsFromMessage } from "./projections.mjs";

function gatewayResponseTooLargeError(label, maxBytes = MAX_AGENT_GATEWAY_RESPONSE_BYTES) {
  const error = new Error(`${label} exceeded the ${maxBytes} byte response limit.`);
  error.code = "agent_gateway_response_too_large";
  error.maxBytes = maxBytes;
  return error;
}

async function readGatewayResponseTextWithLimit(response, {
  label = "Agent gateway upstream response",
  maxBytes = MAX_AGENT_GATEWAY_RESPONSE_BYTES
} = {}) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try {
      await response.body?.cancel?.();
    } catch {
      // The bounded failure is sufficient for the caller.
    }
    throw gatewayResponseTooLargeError(label, maxBytes);
  }
  if (!response.body?.getReader) {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (Buffer.byteLength(String(text || "")) > maxBytes) {
        throw gatewayResponseTooLargeError(label, maxBytes);
      }
      return String(text || "");
    }
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size-limit error.
        }
        throw gatewayResponseTooLargeError(label, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readGatewayErrorDetails(response, label) {
  try {
    return await readGatewayResponseTextWithLimit(response, { label });
  } catch (error) {
    if (error?.code === "agent_gateway_response_too_large") {
      return error.message;
    }
    return "";
  }
}

function byteLengthOfChunk(chunk) {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }
  return chunk?.byteLength || Buffer.byteLength(String(chunk || ""));
}

async function fetchConfiguredModelService({
  config = {},
  init = {},
  fetchImpl = fetch,
  lookup
} = {}) {
  return fetchWithPinnedDns({
    url: config.url,
    label: `agent-gateway.${config.provider || "agent-gateway"}.${config.alias || "default"}`,
    policies: {
      egress: {
        allowLocalForConfiguredModelService: true
      }
    },
    init,
    fetchImpl,
    ...(lookup ? { lookup } : {})
  });
}

async function closeConfiguredModelFetch(pinnedFetch = null) {
  try {
    await pinnedFetch?.close?.();
  } catch {
    // Closing a per-call dispatcher is best-effort cleanup.
  }
}

function createHeaders(config) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (config.token) {
    const tokenHeader = normalizeModelTokenHeader(config.tokenHeader);
    if (!tokenHeader) {
      throw new Error("Agent gateway tokenHeader must be configured when a token is present.");
    }
    headers[tokenHeader] = `${config.tokenPrefix || ""}${config.token}`;
  }
  return headers;
}

function choiceTextFromJson(json) {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  return choices
    .map((choice) => {
      const message = asPlainObject(choice?.message);
      const delta = asPlainObject(choice?.delta);
      return (
        textFromContent(message.content) ||
        textFromContent(delta.content) ||
        textFromContent(choice?.text)
      );
    })
    .join("");
}

function contentFromEvent(event) {
  const data = asPlainObject(event?.data);
  return textFromContent(data.content);
}

function createAgentStreamAccumulator() {
  const events = [];
  const answerParts = [];
  const textParts = [];
  const rawTextParts = [];
  let dialogId = "";
  let finish = false;

  function push(event) {
    if (!event || typeof event !== "object") {
      return;
    }
    const type = String(event.type || "");
    const content = contentFromEvent(event);
    events.push({
      type,
      content,
      nodeId: event?.data?.nodeId || null,
      riskDescription: event?.data?.riskDescription || null,
      finish: event.finish === true
    });
    if (type === "answer") {
      answerParts.push(content);
    } else if (type === "text") {
      textParts.push(content);
    } else if (type === "dialogId") {
      dialogId = content;
    } else if (type === "finish" || event.finish === true) {
      finish = true;
    } else if (type === "rawData" && content) {
      const raw = safeJsonParse(content);
      if (raw && raw.text !== undefined && raw.text !== null) {
        rawTextParts.push(String(raw.text));
      }
    }
  }

  function result() {
    const answer =
      answerParts.length > 0
        ? answerParts.join("")
        : textParts.length > 0
          ? textParts.join("")
          : rawTextParts.join("");
    return {
      answer,
      text: answer,
      dialogId,
      finish,
      events,
      chunks: {
        answer: answerParts,
        text: textParts,
        rawText: rawTextParts
      }
    };
  }

  return { push, result };
}

function parseAgentGatewayStreamText(streamText) {
  const accumulator = createAgentStreamAccumulator();
  for (const rawLine of String(streamText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("data:")) {
      continue;
    }
    const payloadText = line.slice("data:".length).trim();
    if (!payloadText || payloadText === "[DONE]") {
      continue;
    }
    const event = safeJsonParse(payloadText);
    if (event) {
      accumulator.push(event);
    }
  }
  return accumulator.result();
}

async function readStreamResponse(response) {
  const accumulator = createAgentStreamAccumulator();
  const decoder = new TextDecoder();
  let pending = "";
  let totalBytes = 0;

  for await (const chunk of response.body) {
    totalBytes += byteLengthOfChunk(chunk);
    if (totalBytes > MAX_AGENT_GATEWAY_RESPONSE_BYTES) {
      throw gatewayResponseTooLargeError("Agent gateway stream response");
    }
    pending += decoder.decode(chunk, { stream: true });
    let lineEndIndex = pending.indexOf("\n");
    while (lineEndIndex >= 0) {
      const rawLine = pending.slice(0, lineEndIndex).replace(/\r$/, "");
      pending = pending.slice(lineEndIndex + 1);
      const line = rawLine.trim();
      if (line.startsWith("data:")) {
        const payloadText = line.slice("data:".length).trim();
        if (payloadText && payloadText !== "[DONE]") {
          const event = safeJsonParse(payloadText);
          if (event) {
            accumulator.push(event);
          }
        }
      }
      lineEndIndex = pending.indexOf("\n");
    }
  }

  pending += decoder.decode();
  const finalLine = pending.trim();
  if (finalLine.startsWith("data:")) {
    const event = safeJsonParse(finalLine.slice("data:".length).trim());
    if (event) {
      accumulator.push(event);
    }
  }
  return accumulator.result();
}

async function readJsonOrTextResponse(response) {
  const text = await readGatewayResponseTextWithLimit(response);
  if (text.includes("data:")) {
    return parseAgentGatewayStreamText(text);
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
  const data = asPlainObject(json.data);
  const toolCalls = [
    ...asArray(json.toolCalls || json.tool_calls),
    ...asArray(data.toolCalls || data.tool_calls),
    ...asArray(json?.choices).flatMap((choice) => toolCallsFromMessage(asPlainObject(choice?.message))),
    ...asArray(data?.choices).flatMap((choice) => toolCallsFromMessage(asPlainObject(choice?.message)))
  ]
    .map(normalizeGatewayToolCall)
    .filter(Boolean);
  const answer =
    textFromContent(json.answer) ||
    textFromContent(json.text) ||
    textFromContent(json.content) ||
    textFromContent(data.answer) ||
    textFromContent(data.text) ||
    textFromContent(data.content) ||
    choiceTextFromJson(json) ||
    choiceTextFromJson(data);
  return {
    answer,
    text: answer,
    dialogId: String(json.dialogId || json.data?.dialogId || ""),
    finish: json.finish !== false,
    events: [],
    payload: json,
    toolCalls
  };
}

export {
  byteLengthOfChunk,
  closeConfiguredModelFetch,
  createAgentStreamAccumulator,
  createHeaders,
  fetchConfiguredModelService,
  gatewayResponseTooLargeError,
  parseAgentGatewayStreamText,
  readGatewayErrorDetails,
  readGatewayResponseTextWithLimit,
  readJsonOrTextResponse,
  readStreamResponse
};
