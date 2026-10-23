import crypto from "node:crypto";

import { createAdmissionController } from "./admission.mjs";
import { createClientAuthenticator, normalizeClients } from "./auth.mjs";
import {
  addNanos,
  amountToNanos,
  microsToAmount,
  mulNanos,
  nanosToMicrosCeil,
  validateCurrency
} from "./fixed-point.mjs";
import { createLedger } from "./ledger.mjs";
import { createFileStore } from "./persistence.mjs";
import { acquireDataRootOwnership } from "./data-root-ownership.mjs";
import { createProviderEgress } from "./providers.mjs";
import {
  resolveModel,
  validateManagedModel,
  validateManagedProvider,
  validatePricingRevision
} from "./routing.mjs";
import { stableError } from "./stable-errors.mjs";

const STATE_SCHEMA_VERSION = "v0.0.1:model-gateway:state-1";
const DEFAULT_REQUESTED_OUTPUT_TOKENS = 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
// Largest tool-use system-prompt overhead in Anthropic's published model/choice table as of 2026-10-08.
const ANTHROPIC_CLIENT_TOOL_OVERHEAD_TOKENS = 804;
const OPENAI_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "seed",
  "user",
  "functions",
  "function_call",
  "prediction"
]);
const OPENAI_MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "function_call",
  "refusal"
]);
const ANTHROPIC_REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "system",
  "stream",
  "messages",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "metadata"
]);
const ANTHROPIC_MESSAGE_FIELDS = new Set(["role", "content"]);
const OPENAI_TOOL_CALL_MESSAGE_FIELDS = new Set(["id", "type", "function"]);
const OPENAI_TOOL_CHOICE_FUNCTION_FIELDS = new Set(["name"]);
const ANTHROPIC_TOOL_CHOICE_FIELDS = new Set(["type", "name", "disable_parallel_tool_use"]);
const ANTHROPIC_TEXT_BLOCK_FIELDS = new Set(["type", "text"]);
const ANTHROPIC_TOOL_USE_BLOCK_FIELDS = new Set(["type", "id", "name", "input"]);
const ANTHROPIC_TOOL_RESULT_BLOCK_FIELDS = new Set(["type", "tool_use_id", "content", "is_error"]);
const ANTHROPIC_THINKING_BLOCK_FIELDS = new Set(["type", "thinking", "signature"]);
const ANTHROPIC_REDACTED_THINKING_BLOCK_FIELDS = new Set(["type", "data"]);
const DEFAULT_BOUNDS = Object.freeze({
  maxRatePerSecond: 100,
  maxInputTokenBudget: 1_000_000,
  maxRequestedOutputTokenBudget: 200_000,
  maxTotalTokenQuota: 10_000_000,
  maxConcurrentCalls: 64,
  maxCostQuotaMicros: 100_000_000,
  maxGlobalConcurrentCalls: 256,
  maxSubjectConcurrentCalls: 64,
  maxGlobalRequestBytes: 64 * 1024 * 1024,
  maxSubjectRequestBytes: 16 * 1024 * 1024,
  maxLedgerSettledEntries: 512,
  maxLedgerPendingEntries: 1024,
  maxAggregateResponseBufferBytes: 512 * 1024 * 1024,
  maxSubjectRequestRatePerSecond: 100,
  maxGlobalRequestRatePerSecond: 400,
  maxLedgerResponseBytes: 16 * 1024 * 1024,
  currency: "USD"
});

function estimateInputTokens(protocol, requestBody) {
  // Count every accepted request field in UTF-8 bytes. A chars/4 heuristic
  // undercounts CJK, emoji, tool schemas, system prompts, and other billed
  // request metadata that the native APIs accept.
  const serializedBytes = Buffer.byteLength(JSON.stringify(requestBody), "utf8");
  const anthropicToolPromptOverhead = protocol === "anthropic" &&
    Array.isArray(requestBody.tools) && requestBody.tools.length > 0
    ? ANTHROPIC_CLIENT_TOOL_OVERHEAD_TOKENS
    : 0;
  return Math.max(1, serializedBytes + anthropicToolPromptOverhead);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record, fields) {
  return isPlainRecord(record) && Object.keys(record).every((key) => fields.has(key));
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some((header) => header.toLowerCase() === name);
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((header) => header.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function validateMeteredHeaders(protocol, headers, requestId) {
  const unsupported = protocol === "anthropic"
    ? ["anthropic-beta"]
    : ["openai-organization", "openai-project"];
  if (unsupported.some((name) => hasHeader(headers, name))) {
    return stableError("invalid_request", "provider billing and feature headers are controlled by the service", requestId);
  }
  if (protocol === "openai") {
    const requestIdValue = headerValue(headers, "x-client-request-id");
    if (requestIdValue !== undefined &&
        (typeof requestIdValue !== "string" || requestIdValue.length > 512 || /[^\x20-\x7e]/u.test(requestIdValue))) {
      return stableError("invalid_request", "x-client-request-id must contain at most 512 printable ASCII characters", requestId);
    }
  }
  return null;
}

const OPENAI_FUNCTION_FIELDS = new Set(["name", "description", "parameters", "strict"]);
const OPENAI_TOOL_FIELDS = new Set(["type", "function"]);
const OPENAI_TOOL_CHOICE_FIELDS = new Set(["type", "function"]);
const ANTHROPIC_TOOL_FIELDS = new Set(["type", "name", "description", "input_schema"]);
const OPENAI_FUNCTION_CALL_FIELDS = new Set(["name", "arguments"]);

function validOpenAiCallMessage(value) {
  return hasOnlyKeys(value, OPENAI_TOOL_CALL_MESSAGE_FIELDS) &&
    typeof value.id === "string" && value.id.length > 0 &&
    value.type === "function" &&
    hasOnlyKeys(value.function, OPENAI_FUNCTION_CALL_FIELDS) &&
    typeof value.function.name === "string" && value.function.name.length > 0 &&
    typeof value.function.arguments === "string";
}

function validOpenAiMessage(message) {
  if (!hasOnlyKeys(message, OPENAI_MESSAGE_FIELDS) ||
      !["system", "developer", "user", "assistant", "tool", "function"].includes(message.role)) return false;
  if (typeof message.content !== "string") {
    const hasToolCall = (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
      message.function_call !== undefined;
    if (message.role !== "assistant" || message.content !== null || !hasToolCall) return false;
  }
  if (message.name !== undefined && typeof message.name !== "string") return false;
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") return false;
  if (message.refusal !== undefined && typeof message.refusal !== "string") return false;
  if (message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.some((call) => !validOpenAiCallMessage(call)))) return false;
  if (message.function_call !== undefined &&
      (!hasOnlyKeys(message.function_call, OPENAI_FUNCTION_CALL_FIELDS) ||
       typeof message.function_call.name !== "string" ||
       typeof message.function_call.arguments !== "string")) return false;
  return true;
}

function validPrediction(value) {
  if (!hasOnlyKeys(value, new Set(["type", "content"])) || value.type !== "content") return false;
  if (typeof value.content === "string") return true;
  return Array.isArray(value.content) && value.content.every((part) =>
    hasOnlyKeys(part, new Set(["type", "text"])) && part.type === "text" && typeof part.text === "string");
}

function validOpenAiFunction(value) {
  return hasOnlyKeys(value, OPENAI_FUNCTION_FIELDS) &&
    typeof value.name === "string" && value.name.length > 0 &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.strict === undefined || typeof value.strict === "boolean") &&
    (value.parameters === undefined || isPlainRecord(value.parameters));
}

function validOpenAiFunctionCall(value) {
  return typeof value === "string"
    ? value === "auto" || value === "none"
    : hasOnlyKeys(value, new Set(["name"])) && typeof value.name === "string" && value.name.length > 0;
}

function validOpenAiToolChoice(value) {
  if (typeof value === "string") return ["auto", "none", "required"].includes(value);
  return hasOnlyKeys(value, OPENAI_TOOL_CHOICE_FIELDS) &&
    value.type === "function" &&
    hasOnlyKeys(value.function, OPENAI_TOOL_CHOICE_FUNCTION_FIELDS) &&
    typeof value.function.name === "string" && value.function.name.length > 0;
}

function validAnthropicToolChoice(value) {
  if (!hasOnlyKeys(value, ANTHROPIC_TOOL_CHOICE_FIELDS)) return false;
  if (!["auto", "any", "tool"].includes(value.type)) return false;
  if (value.type === "tool") {
    if (typeof value.name !== "string" || value.name.length === 0) return false;
  } else if (value.name !== undefined) {
    return false;
  }
  return value.disable_parallel_tool_use === undefined || typeof value.disable_parallel_tool_use === "boolean";
}

function validAnthropicThinking(value) {
  if (!hasOnlyKeys(value, new Set(["type", "budget_tokens", "display"]))) return false;
  if (!["enabled", "adaptive", "disabled", "between_tools"].includes(value.type)) return false;
  if (value.budget_tokens !== undefined && (!Number.isSafeInteger(value.budget_tokens) || value.budget_tokens < 1)) return false;
  if (value.display !== undefined && !["summarized", "omitted"].includes(value.display)) return false;
  return true;
}

function validAnthropicOutputConfig(value) {
  if (!hasOnlyKeys(value, new Set(["effort", "format"]))) return false;
  if (value.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.effort)) return false;
  if (value.format !== undefined &&
      (!hasOnlyKeys(value.format, new Set(["type", "schema"])) ||
       value.format.type !== "json_schema" || !isPlainRecord(value.format.schema))) return false;
  return true;
}

function validAnthropicTextBlock(block) {
  return hasOnlyKeys(block, ANTHROPIC_TEXT_BLOCK_FIELDS) &&
    block.type === "text" && typeof block.text === "string";
}

function validAnthropicToolUseBlock(block) {
  return hasOnlyKeys(block, ANTHROPIC_TOOL_USE_BLOCK_FIELDS) &&
    block.type === "tool_use" && typeof block.id === "string" && block.id.length > 0 &&
    typeof block.name === "string" && block.name.length > 0 && isPlainRecord(block.input);
}

function validAnthropicToolResultBlock(block) {
  if (!hasOnlyKeys(block, ANTHROPIC_TOOL_RESULT_BLOCK_FIELDS) ||
      block.type !== "tool_result" || typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0 ||
      (block.is_error !== undefined && typeof block.is_error !== "boolean")) return false;
  if (typeof block.content === "string") return true;
  return Array.isArray(block.content) && block.content.length > 0 && block.content.every(validAnthropicTextBlock);
}

function validAnthropicAssistantBlock(block) {
  if (validAnthropicTextBlock(block) || validAnthropicToolUseBlock(block)) return true;
  if (hasOnlyKeys(block, ANTHROPIC_THINKING_BLOCK_FIELDS) &&
      block.type === "thinking" && typeof block.thinking === "string" &&
      typeof block.signature === "string") return true;
  return hasOnlyKeys(block, ANTHROPIC_REDACTED_THINKING_BLOCK_FIELDS) &&
    block.type === "redacted_thinking" && typeof block.data === "string";
}

function validAnthropicMessage(message) {
  if (!hasOnlyKeys(message, ANTHROPIC_MESSAGE_FIELDS) || !["user", "assistant"].includes(message.role)) return false;
  if (typeof message.content === "string") return true;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.role === "assistant"
    ? message.content.every(validAnthropicAssistantBlock)
    : message.content.every((block) => validAnthropicTextBlock(block) || validAnthropicToolResultBlock(block));
}

function optionalFiniteNumberInRange(value, minimum, maximum) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) &&
    value >= minimum && value <= maximum);
}

function validStringList(value, maximumLength = Number.POSITIVE_INFINITY) {
  return Array.isArray(value) && value.length <= maximumLength && value.every((entry) => typeof entry === "string");
}

function validateMeteredRequest(protocol, body, requestId) {
  if (!isPlainRecord(body)) {
    return stableError("invalid_request", "request must be an object in the supported metered format", requestId);
  }

  const allowedFields = protocol === "anthropic" ? ANTHROPIC_REQUEST_FIELDS : OPENAI_REQUEST_FIELDS;
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return stableError("invalid_request", "request contains fields outside the supported token-pricing contract", requestId);
  }

  const messageFields = protocol === "anthropic" ? ANTHROPIC_MESSAGE_FIELDS : OPENAI_MESSAGE_FIELDS;
  if (!Array.isArray(body.messages) || body.messages.length === 0 ||
      body.messages.some((message) => !isPlainRecord(message) ||
      Object.keys(message).some((key) => !messageFields.has(key)) ||
      (protocol === "anthropic"
        ? !validAnthropicMessage(message)
        : !validOpenAiMessage(message)))) {
    return stableError("invalid_request", "message contains fields outside the supported text format", requestId);
  }

  if (protocol === "anthropic") {
    if ((body.stream !== undefined && typeof body.stream !== "boolean") ||
        !optionalFiniteNumberInRange(body.temperature, 0, 1) ||
        !optionalFiniteNumberInRange(body.top_p, 0, 1) ||
        (body.top_k !== undefined && (!Number.isSafeInteger(body.top_k) || body.top_k < 0)) ||
        (body.stop_sequences !== undefined && !validStringList(body.stop_sequences))) {
      return stableError("invalid_request", "Anthropic generation controls are outside the supported text contract", requestId);
    }
    if (body.system !== undefined && typeof body.system !== "string") {
      return stableError("invalid_request", "system must be a text string", requestId);
    }
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) =>
      !hasOnlyKeys(tool, ANTHROPIC_TOOL_FIELDS) ||
      (tool.type !== undefined && tool.type !== "custom") ||
      typeof tool.name !== "string" || tool.name.length === 0 ||
      (tool.description !== undefined && typeof tool.description !== "string") ||
      !isPlainRecord(tool.input_schema)))) {
      return stableError("invalid_request", "only client-executed custom tools without cache controls are supported", requestId);
    }
    if (body.tool_choice !== undefined && !validAnthropicToolChoice(body.tool_choice)) {
      return stableError("invalid_request", "tool_choice must select a supported client-executed custom tool", requestId);
    }
    if (body.metadata !== undefined &&
        (!hasOnlyKeys(body.metadata, new Set(["user_id"])) ||
         (body.metadata.user_id !== undefined &&
          (typeof body.metadata.user_id !== "string" || body.metadata.user_id.length > 512)))) {
      return stableError("invalid_request", "metadata supports only a string user_id", requestId);
    }
    if (body.thinking !== undefined && !validAnthropicThinking(body.thinking)) {
      return stableError("invalid_request", "thinking contains unsupported configuration fields", requestId);
    }
    if (body.output_config !== undefined && !validAnthropicOutputConfig(body.output_config)) {
      return stableError("invalid_request", "output_config contains unsupported configuration fields", requestId);
    }
    return null;
  }

  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) =>
    !hasOnlyKeys(tool, OPENAI_TOOL_FIELDS) || tool.type !== "function" || !validOpenAiFunction(tool.function)))) {
    return stableError("invalid_request", "only client-executed function tools are supported", requestId);
  }
  if (body.tool_choice !== undefined && !validOpenAiToolChoice(body.tool_choice)) {
    return stableError("invalid_request", "only client-executed function tools are supported", requestId);
  }
  if ((body.stream !== undefined && typeof body.stream !== "boolean") ||
      (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") ||
      !optionalFiniteNumberInRange(body.temperature, 0, 2) ||
      !optionalFiniteNumberInRange(body.top_p, 0, 1) ||
      !optionalFiniteNumberInRange(body.presence_penalty, -2, 2) ||
      !optionalFiniteNumberInRange(body.frequency_penalty, -2, 2) ||
      (body.stop !== undefined && !(typeof body.stop === "string" || validStringList(body.stop, 4))) ||
      (body.logit_bias !== undefined && (!isPlainRecord(body.logit_bias) ||
        Object.values(body.logit_bias).some((value) => typeof value !== "number" || !Number.isFinite(value)))) ||
      (body.logprobs !== undefined && typeof body.logprobs !== "boolean") ||
      (body.top_logprobs !== undefined && (!Number.isSafeInteger(body.top_logprobs) || body.top_logprobs < 0 || body.top_logprobs > 20)) ||
      (body.seed !== undefined && !Number.isSafeInteger(body.seed)) ||
      (body.user !== undefined && typeof body.user !== "string")) {
    return stableError("invalid_request", "OpenAI generation controls are outside the supported text contract", requestId);
  }
  if (body.functions !== undefined && (!Array.isArray(body.functions) || body.functions.some((item) => !validOpenAiFunction(item)))) {
    return stableError("invalid_request", "functions must contain client-executed function definitions", requestId);
  }
  if (body.function_call !== undefined && !validOpenAiFunctionCall(body.function_call)) {
    return stableError("invalid_request", "function_call must select a client-executed function", requestId);
  }
  if (body.prediction !== undefined && !validPrediction(body.prediction)) {
    return stableError("invalid_request", "prediction supports text content only", requestId);
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (!hasOnlyKeys(format, new Set(["type", "json_schema"])) || !["text", "json_object", "json_schema"].includes(format.type)) {
      return stableError("invalid_request", "response_format must use a supported text format", requestId);
    }
    if (format.type === "json_schema") {
      const schema = format.json_schema;
      if (!hasOnlyKeys(schema, new Set(["name", "description", "schema", "strict"])) ||
          typeof schema.name !== "string" || schema.name.length === 0 ||
          (schema.description !== undefined && typeof schema.description !== "string") ||
          (schema.strict !== undefined && typeof schema.strict !== "boolean") ||
          !isPlainRecord(schema.schema)) {
        return stableError("invalid_request", "json_schema must contain a named JSON object schema", requestId);
      }
    }
  }
  return null;
}

function fingerprintPolicy(bounds) {
  return `policy-${crypto.createHash("sha256").update(JSON.stringify(bounds)).digest("hex").slice(0, 16)}`;
}

function validateBounds(bounds) {
  const merged = { ...DEFAULT_BOUNDS, ...bounds };
  for (const [target, source, factor] of [
    ["maxSubjectTotalTokenQuota", "maxTotalTokenQuota", 1],
    ["maxGlobalTotalTokenQuota", "maxTotalTokenQuota", 4],
    ["maxSubjectCostQuotaMicros", "maxCostQuotaMicros", 1],
    ["maxGlobalCostQuotaMicros", "maxCostQuotaMicros", 4],
    ["maxSubjectRatePerSecond", "maxRatePerSecond", 1],
    ["maxGlobalRatePerSecond", "maxRatePerSecond", 4]
  ]) merged[target] = bounds[target] ?? merged[source] * factor;
  for (const key of [
    "maxRatePerSecond",
    "maxInputTokenBudget",
    "maxRequestedOutputTokenBudget",
    "maxTotalTokenQuota",
    "maxConcurrentCalls",
    "maxCostQuotaMicros",
    "maxGlobalConcurrentCalls",
    "maxSubjectConcurrentCalls",
    "maxGlobalRequestBytes",
    "maxSubjectRequestBytes",
    "maxLedgerSettledEntries",
    "maxLedgerResponseBytes",
    "maxLedgerPendingEntries", "maxAggregateResponseBufferBytes", "maxSubjectRequestRatePerSecond", "maxGlobalRequestRatePerSecond", "maxSubjectTotalTokenQuota", "maxGlobalTotalTokenQuota",
    "maxSubjectCostQuotaMicros", "maxGlobalCostQuotaMicros", "maxSubjectRatePerSecond", "maxGlobalRatePerSecond"
  ]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 1) {
      throw new TypeError(`${key} must be a positive integer.`);
    }
  }
  if (!validateCurrency(merged.currency)) {
    throw new TypeError("currency must be a three-letter code.");
  }
  return merged;
}

export async function createModelGatewayApplication(options = {}) {
  const { dataRoot } = options;
  const ownership = await acquireDataRootOwnership(dataRoot);
  try {
    return await createOwnedModelGatewayApplication(options, ownership);
  } catch (error) {
    ownership.close();
    throw error;
  }
}

async function createOwnedModelGatewayApplication(options, ownership) {
  const {
    dataRoot,
    clients: envClients = {},
    fetchImpl,
    windowMs = 60_000,
    now = Date.now,
    bounds: boundOptions = {}
  } = options;
  const store = createFileStore(dataRoot);
  const state = await store.readJson("state.json", null) || {
    schemaVersion: STATE_SCHEMA_VERSION,
    clients: {},
    admissionPolicy: null,
    providers: {},
    models: {},
    pricingRevisions: {}
  };
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("Model Gateway state schema version is unsupported.");
  }

  const bounds = validateBounds(boundOptions);
  const policyRevisionRef = fingerprintPolicy(bounds);
  let stateChanged = false;
  if (state.admissionPolicy?.revisionRef !== policyRevisionRef) {
    state.admissionPolicy = { revisionRef: policyRevisionRef, ...bounds };
    stateChanged = true;
  }

  const normalizedClients = normalizeClients(envClients);
  const persistedClients = Object.fromEntries(Object.entries(normalizedClients).map(([clientId, client]) => [
    clientId,
    { subject: client.subject, scopes: [...client.scopes] }
  ]));
  if (JSON.stringify(state.clients) !== JSON.stringify(persistedClients)) {
    state.clients = persistedClients;
    stateChanged = true;
  }

  let persistQueue = Promise.resolve();
  function schedulePersist() {
    persistQueue = persistQueue.catch(() => {}).then(() => store.writeJsonAtomic("state.json", state));
    return persistQueue;
  }

  const migratingLedger = Object.hasOwn(state, "ledger");
  const ledger = createLedger({
    dataRoot, state, bounds, now, windowMs,
    responseCacheBounds: {
      maxEntries: bounds.maxLedgerSettledEntries,
      maxBytes: bounds.maxLedgerResponseBytes
    }
  });
  try {
    if (stateChanged || migratingLedger) await schedulePersist();
  } catch (error) { ledger.close(); throw error; }

  const auth = createClientAuthenticator({ clients: normalizedClients });
  const admission = createAdmissionController({
    policy: { ...bounds, windowMs },
    windowMs,
    now
  });
  const egress = createProviderEgress({ fetchImpl, maxAggregateResponseBufferBytes: bounds.maxAggregateResponseBufferBytes });
  const inflight = new Map();
  const idempotencyClaims = new Map();
  const activeWork = new Set();
  let closing = false;
  let ready = false;

  function shutdownResult(args) {
    const requestId = args[0]?.requestId || args[2] || "";
    return { error: stableError("provider_unavailable", "service is shutting down", requestId) };
  }

  function track(operation) {
    return (...args) => {
      if (closing) return Promise.resolve(shutdownResult(args));
      const task = Promise.resolve().then(() => closing ? shutdownResult(args) : operation(...args));
      activeWork.add(task);
      void task.finally(() => activeWork.delete(task)).catch(() => {});
      return task;
    };
  }

  function partitionKey(client, model, provider) {
    return `${client.subject}|${model.modelId}|${provider.providerId}|${state.admissionPolicy.revisionRef}`;
  }

  function replayCompleted(entry, requestId) {
    if (entry.response === null) {
      const error = stableError("completed_response_unavailable", "call completed; retained accounting is available through its ledger", requestId);
      error.error.service_call_id = entry.callId;
      return { error };
    }
    return { replay: entry.response, callId: entry.callId };
  }

  async function executeCall({
    client,
    protocol,
    model,
    provider,
    pricing,
    body,
    fingerprintBody = body,
    headers,
    idempotencyKey,
    requestId,
    signal,
    estimateInput,
    requestedOutput
  }) {
    let currency;
    let inputRate;
    let outputRate;
    let estimatedCostMicros;
    try {
      currency = pricing.currency;
      if (currency !== bounds.currency ||
          pricing.inputTokenRate?.currency !== currency ||
          pricing.outputTokenRate?.currency !== currency) {
        throw new TypeError("pricing currency is inconsistent with the admission policy.");
      }
      inputRate = amountToNanos(pricing.inputTokenRate);
      outputRate = amountToNanos(pricing.outputTokenRate);
      estimatedCostMicros = nanosToMicrosCeil(addNanos(
        mulNanos(inputRate, estimateInput),
        mulNanos(outputRate, requestedOutput)
      ));
    } catch {
      return { error: stableError("provider_unavailable", "model pricing is invalid for the admission policy", requestId) };
    }
    const key = partitionKey(client, model, provider);
    const requestFingerprint = idempotencyKey
      ? crypto.createHash("sha256").update(JSON.stringify([protocol, fingerprintBody])).digest("hex")
      : null;
    const prior = ledger.findIdempotency(client.subject, idempotencyKey, requestFingerprint);
    if (prior) {
      if (prior.conflict) {
        return { error: stableError("invalid_request", "idempotency key was already used for a different request", requestId) };
      }
      if (prior.entry.state === "settled") {
        return replayCompleted(prior.entry, requestId);
      }
      return { error: stableError("settlement_uncertain", "call is pending or uncertain", requestId) };
    }

    const claimKey = idempotencyKey ? JSON.stringify([client.subject, idempotencyKey]) : null;
    if (claimKey && idempotencyClaims.has(claimKey)) {
      const claimedFingerprint = idempotencyClaims.get(claimKey);
      return {
        error: stableError(
          claimedFingerprint === requestFingerprint ? "settlement_uncertain" : "invalid_request",
          claimedFingerprint === requestFingerprint ? "call is pending or uncertain" : "idempotency key was already used for a different request",
          requestId
        )
      };
    }
    if (claimKey) idempotencyClaims.set(claimKey, requestFingerprint);

    const decision = admission.admit({
      partitionKey: key,
      inputTokens: estimateInput,
      requestedOutputTokens: requestedOutput,
      estimatedCostMicros
    });
    if (!decision.ok) {
      if (claimKey) idempotencyClaims.delete(claimKey);
      return { error: stableError(decision.code, "call denied by admission policy", requestId) };
    }

    let admissionHeld = true;
    let refundAdmission = false;
    let keepInflight = false;
    let callId = null;
    let controller = null;
    try {
      let egressConfig;
      let secrets;
      try {
        egressConfig = await store.readJson("provider-egress.json", {});
        secrets = await store.readJson("secrets.json", {});
      } catch {
        refundAdmission = true;
        return { error: stableError("provider_unavailable", "provider egress is not configured", requestId) };
      }
      const egressEntry = egressConfig[provider.providerId];
      const credential = secrets[provider.providerId];
      if (!egressEntry?.baseUrl || typeof credential !== "string" || credential.length === 0) {
        refundAdmission = true;
        return { error: stableError("provider_unavailable", "provider egress is not configured", requestId) };
      }
      try { egress.validateDestination(egressEntry); }
      catch {
        refundAdmission = true;
        return { error: stableError("provider_unavailable", "provider egress configuration is not admitted", requestId) };
      }
      if (signal?.aborted) {
        refundAdmission = true;
        return { error: stableError("cancelled", "call cancelled", requestId) };
      }
      if (closing) {
        refundAdmission = true;
        return { error: stableError("provider_unavailable", "service is shutting down", requestId) };
      }

      callId = `call_${crypto.randomUUID()}`;
      const created = ledger.create({
        callId,
        principalRef: client.subject,
        idempotencyKey,
        requestFingerprint,
        modelRef: model.modelId,
        pricingRevisionRef: pricing.revisionRef,
        currency,
        reservationRef: `res_${crypto.randomUUID()}`,
        partitionKey: key, inputTokens: estimateInput, requestedOutputTokens: requestedOutput, estimatedCostMicros
      });
      if (created.denied) {
        refundAdmission = true;
        return { error: stableError(created.denied, "call denied by durable aggregate admission", requestId) };
      }
      if (created.duplicate) {
        refundAdmission = true;
        if (created.conflict) {
          return { error: stableError("invalid_request", "idempotency key was already used for a different request", requestId) };
        }
        if (created.entry?.state === "settled") {
          return replayCompleted(created.entry, requestId);
        }
        return { error: stableError("settlement_uncertain", "call is pending or uncertain", requestId) };
      }

      controller = new AbortController();
      inflight.set(callId, controller);
      const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      if (callSignal.aborted) {
        return { error: stableError("cancelled", "call cancelled", requestId) };
      }

      try {
        const result = await egress.call({
          protocol: provider.protocol,
          baseUrl: egressEntry.baseUrl,
          egressPolicy: egressEntry.egressPolicy,
          credential,
          body,
          headers,
          signal: callSignal
        });
        if (result.status >= 200 && result.status < 300) {
          keepInflight = true;
          return { ok: true, callId, body: result.body, release: result.release, inputRate, outputRate, currency, signal: callSignal };
        }
        result.release?.();
      } catch {
        if (callSignal.aborted) return { error: stableError("cancelled", "call cancelled", requestId) };
      }
      return { error: stableError("provider_unavailable", "provider egress failed; settlement is uncertain", requestId) };
    } finally {
      if (callId && !keepInflight) inflight.delete(callId);
      if (admissionHeld) {
        admission.release({ partitionKey: key, reservation: decision.reservation, refund: refundAdmission });
        admissionHeld = false;
      }
      if (claimKey) idempotencyClaims.delete(claimKey);
    }
  }

  async function settle(callId, usage, { inputRate, outputRate, currency }) {
    const inputTokens = usage?.input;
    const outputTokens = usage?.output;
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
        !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      return { settled: false, inputTokens: null, outputTokens: null, amountMicros: null };
    }
    const amountMicros = nanosToMicrosCeil(addNanos(
      mulNanos(inputRate, inputTokens),
      mulNanos(outputRate, outputTokens)
    ));
    const settled = ledger.markSettled(callId, {
      inputTokens,
      outputTokens,
      amount: microsToAmount(currency, amountMicros),
      response: usage?.response
    });
    // The ledger transaction durably commits before the response is returned.
    return { settled: settled.changed, inputTokens, outputTokens, amountMicros };
  }

  async function callOpenAi({ client, body, idempotencyKey, requestId, signal, headers }) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const headerError = validateMeteredHeaders("openai", headers, requestId);
    if (headerError) return { error: headerError };
    if (typeof body?.model !== "string" || body.model.length === 0) {
      return { error: stableError("invalid_request", "model is required", requestId) };
    }
    const requestError = validateMeteredRequest("openai", body, requestId);
    if (requestError) return { error: requestError };
    if (idempotencyKey !== null && idempotencyKey !== undefined && (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(idempotencyKey))) {
      return { error: stableError("invalid_request", "idempotency key must be at most 256 printable characters", requestId) };
    }
    if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) {
      return { error: stableError("invalid_request", "max_tokens must be a positive integer", requestId) };
    }
    if (body.max_completion_tokens !== undefined && (!Number.isSafeInteger(body.max_completion_tokens) || body.max_completion_tokens < 1)) {
      return { error: stableError("invalid_request", "max_completion_tokens must be a positive integer", requestId) };
    }
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
      return { error: stableError("invalid_request", "max_tokens and max_completion_tokens cannot both be set", requestId) };
    }
    if (body.n !== undefined && body.n !== null && (!Number.isSafeInteger(body.n) || body.n < 1 || body.n > 128)) {
      return { error: stableError("invalid_request", "n must be an integer between 1 and 128", requestId) };
    }
    const outputCapPerChoice = body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_REQUESTED_OUTPUT_TOKENS;
    const outputChoiceCount = body.n ?? 1;
    const requestedOutput = outputCapPerChoice * outputChoiceCount;
    if (!Number.isSafeInteger(requestedOutput)) {
      return { error: stableError("invalid_request", "requested output token total is too large", requestId) };
    }
    const resolved = resolveModel(state, body.model);
    if (!resolved) {
      return { error: stableError("model_not_found", `model ${body.model} is unavailable`, requestId) };
    }
    if (!resolved.pricing) {
      return { error: stableError("provider_unavailable", "model has no pricing revision", requestId) };
    }
    const estimateInput = estimateInputTokens("openai", body);
    const providerBody = { ...body };
    if (providerBody.max_completion_tokens === undefined && providerBody.max_tokens === undefined) {
      providerBody.max_completion_tokens = DEFAULT_REQUESTED_OUTPUT_TOKENS;
    }
    if (providerBody.stream === true) providerBody.stream = false;
    const result = await executeCall({
      client,
      protocol: "openai",
      model: resolved.model,
      provider: resolved.provider,
      pricing: resolved.pricing,
      body: providerBody,
      fingerprintBody: body,
      headers,
      idempotencyKey,
      requestId,
      signal,
      estimateInput,
      requestedOutput
    });
    if (result.error) return result;
    if (result.replay) return { status: 200, body: result.replay };
    const usage = result.body?.usage || {};
    const response = { ...result.body, service_call_id: result.callId };
    try {
      await settle(result.callId, {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        response
      }, result);
    } finally {
      inflight.delete(result.callId);
    }
    if (result.signal.aborted) {
      result.release?.();
      return { error: stableError("cancelled", "call cancelled", requestId) };
    }
    return { status: 200, body: response, release: result.release };
  }

  async function callAnthropic({ client, body, idempotencyKey, requestId, signal, headers }) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const headerError = validateMeteredHeaders("anthropic", headers, requestId);
    if (headerError) return { error: headerError };
    if (typeof body?.model !== "string" || body.model.length === 0) {
      return { error: stableError("invalid_request", "model is required", requestId) };
    }
    if (!Number.isSafeInteger(body?.max_tokens) || body.max_tokens < 1) {
      return { error: stableError("invalid_request", "max_tokens is required", requestId) };
    }
    if (idempotencyKey !== null && idempotencyKey !== undefined && (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(idempotencyKey))) {
      return { error: stableError("invalid_request", "idempotency key must be at most 256 printable characters", requestId) };
    }
    const requestError = validateMeteredRequest("anthropic", body, requestId);
    if (requestError) return { error: requestError };
    const resolved = resolveModel(state, body.model);
    if (!resolved) {
      return { error: stableError("model_not_found", `model ${body.model} is unavailable`, requestId) };
    }
    if (!resolved.pricing) {
      return { error: stableError("provider_unavailable", "model has no pricing revision", requestId) };
    }
    const estimateInput = estimateInputTokens("anthropic", body);
    const requestedOutput = body.max_tokens;
    const providerBody = body.stream === true ? { ...body, stream: false } : body;
    const result = await executeCall({
      client,
      protocol: "anthropic",
      model: resolved.model,
      provider: resolved.provider,
      pricing: resolved.pricing,
      body: providerBody,
      fingerprintBody: body,
      headers,
      idempotencyKey,
      requestId,
      signal,
      estimateInput,
      requestedOutput
    });
    if (result.error) return result;
    if (result.replay) return { status: 200, body: result.replay };
    const usage = result.body?.usage || {};
    const response = { ...result.body, service_call_id: result.callId };
    try {
      await settle(result.callId, {
        input: usage.input_tokens,
        output: usage.output_tokens,
        response
      }, result);
    } finally {
      inflight.delete(result.callId);
    }
    if (result.signal.aborted) {
      result.release?.();
      return { error: stableError("cancelled", "call cancelled", requestId) };
    }
    return { status: 200, body: response, release: result.release };
  }

  async function createProvider(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const message = validateManagedProvider(body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.providers[body.providerId] = { providerId: body.providerId, protocol: body.protocol, enabled: body.enabled };
    await schedulePersist();
    return { body: state.providers[body.providerId] };
  }

  async function createModel(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const message = validateManagedModel(state, body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.models[body.modelId] = { modelId: body.modelId, providerRef: body.providerRef, pricingRevisionRef: body.pricingRevisionRef, enabled: body.enabled };
    await schedulePersist();
    return { body: state.models[body.modelId] };
  }

  async function createPricingRevision(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    if (body?.currency !== bounds.currency) {
      return { error: stableError("invalid_request", "pricing currency must match the admission policy currency", requestId) };
    }
    const message = validatePricingRevision(state.pricingRevisions[body?.revisionRef], body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.pricingRevisions[body.revisionRef] = {
      revisionRef: body.revisionRef,
      modelRef: body.modelRef,
      currency: body.currency,
      inputTokenRate: body.inputTokenRate,
      outputTokenRate: body.outputTokenRate,
      immutable: true
    };
    await schedulePersist();
    return { body: state.pricingRevisions[body.revisionRef] };
  }

  // Management (provider/model/pricing) projections are readable only by a
  // management credential. "model:manage" implies read access; "model:read"
  // grants read-only management visibility.
  const MANAGEMENT_READ_SCOPES = Object.freeze(["model:read", "model:manage"]);

  function requireAnyScope(client, scopes, requestId) {
    for (const scope of scopes) {
      if (auth.hasScope(client, scope)) return null;
    }
    return { error: stableError("unauthorized", "insufficient scope", requestId) };
  }

  function listProviders(client, requestId) {
    const denied = requireAnyScope(client, MANAGEMENT_READ_SCOPES, requestId);
    if (denied) return denied;
    return { body: Object.values(state.providers) };
  }

  function listManagedModels(client, requestId) {
    const denied = requireAnyScope(client, MANAGEMENT_READ_SCOPES, requestId);
    if (denied) return denied;
    return { body: Object.values(state.models) };
  }

  function listPricingRevisions(client, requestId) {
    const denied = requireAnyScope(client, MANAGEMENT_READ_SCOPES, requestId);
    if (denied) return denied;
    return { body: Object.values(state.pricingRevisions) };
  }

  async function cancelCall(client, callId, requestId) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const entry = ledger.get(callId);
    if (!entry || entry.principalRef !== client.subject) return { error: stableError("invalid_request", "call not found", requestId) };
    if (entry.state === "settled") return { body: { callId, state: "terminal" } };
    const controller = inflight.get(callId);
    if (controller) {
      controller.abort();
      return { body: { callId, state: "requested" } };
    }
    return { body: { callId, state: entry.state === "in_doubt" ? "in_doubt" : "cancelled" } };
  }

  async function readLedger(client, callId, requestId) {
    if (!auth.hasScope(client, "ledger:read")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const entry = ledger.get(callId);
    if (!entry || entry.principalRef !== client.subject) return { error: stableError("invalid_request", "call not found", requestId) };
    return {
      body: {
        callId: entry.callId,
        modelRef: entry.modelRef,
        pricingRevisionRef: entry.pricingRevisionRef,
        currency: entry.currency,
        reservationRef: entry.reservationRef,
        state: entry.state,
        attempts: entry.attempts,
        amount: entry.amount,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens
      }
    };
  }

  ready = true;

  return {
    health: () => ({ status: "ok" }),
    readiness: () => ({ status: ready ? "ready" : "not_ready" }),
    authenticate: (headers) => auth.authenticate(headers),
    admitRequest: ({ subject, requestBytes }) => admission.admitRequest({ subject, requestBytes }),
    callOpenAi: track(callOpenAi),
    callAnthropic: track(callAnthropic),
    createProvider: track(createProvider),
    createModel: track(createModel),
    createPricingRevision: track(createPricingRevision),
    cancelCall: track(cancelCall),
    readLedger: track(readLedger),
    listProviders,
    listManagedModels,
    listPricingRevisions,
    listModels: () => Object.values(state.models),
    modelDetail: (modelId) => {
      const model = state.models[modelId];
      return model ? { id: model.modelId, object: "model", owned_by: state.providers[model.providerRef]?.providerId || "model-gateway" } : null;
    },
    state,
    store,
    close: async () => {
      closing = true;
      ready = false;
      for (const controller of inflight.values()) controller.abort();
      await Promise.allSettled([...activeWork]);
      const [persisted, egressClosed] = await Promise.allSettled([persistQueue, egress.close()]);
      ledger.close();
      ownership.close();
      if (persisted.status === "rejected") throw persisted.reason;
      if (egressClosed.status === "rejected") throw egressClosed.reason;
    }
  };
}
