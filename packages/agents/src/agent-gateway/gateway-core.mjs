import crypto from "node:crypto";
import {
  inspectModelRouting,
  runModelRouting,
  shouldUseModelRouting
} from "./model-routing/index.mjs";
import { assertModelAssistedEgressAllowed } from "./model-egress-policy.mjs";
import {
  asArray,
  asPlainObject,
  asStringList,
  redactSecretText,
  safeUrlSummary,
  textFromContent,
  truncateText
} from "./shared.mjs";
import { appendAgentGatewayAudit } from "./audit.mjs";
import {
  publicGatewayCompactionResult,
  summarizeAgentGatewayPayload,
  summarizeGatewayResult
} from "./projections.mjs";
import {
  buildAgentGatewayPayload,
  resolveAgentGatewayConfig,
  resolveAgentGatewayRegistry,
  withModuleAgentProfileInput
} from "./policy-validation.mjs";
import {
  closeConfiguredModelFetch,
  createHeaders,
  fetchConfiguredModelService,
  readGatewayErrorDetails,
  readJsonOrTextResponse,
  readStreamResponse
} from "./transport-helpers.mjs";
import {
  callDeepSeekGateway,
  callOpenAiCompatibleGateway
} from "./model-transport.mjs";

function estimateGatewayTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

function gatewayMessageText(message = {}) {
  return textFromContent(message.content ?? message.text ?? message.summary ?? "", {
    includeReasoning: true
  }) || JSON.stringify(message.content ?? message.text ?? "");
}

function toCompactionMessages(input = {}) {
  if (Array.isArray(input.transcript)) {
    return input.transcript;
  }
  if (Array.isArray(input.messages)) {
    return input.messages;
  }
  const messages = [];
  if (input.history || input.compressedHistory) {
    messages.push({
      id: "gateway-history",
      role: "system",
      apiRoundId: "gateway-history",
      content: input.history || input.compressedHistory
    });
  }
  for (const [index, turn] of asArray(input.recentTurns).entries()) {
    messages.push({
      ...asPlainObject(turn),
      id: turn?.id || turn?.messageId || `gateway-turn-${index + 1}`,
      apiRoundId: turn?.apiRoundId || turn?.roundId || `gateway-turn-round-${Math.floor(index / 2) + 1}`
    });
  }
  const question = String(input.question || input.query || "").trim();
  if (question) {
    messages.push({
      id: "gateway-current-question",
      role: "user",
      apiRoundId: "gateway-current",
      content: question
    });
  }
  return messages;
}

function shouldCompactAgentGatewayInput(input = {}, messages = []) {
  if (input.contextCompaction === false || input.skipContextCompaction === true) {
    return false;
  }
  const options = asPlainObject(input.contextCompaction);
  if (options.force === true || input.forceContextCompaction === true) {
    return true;
  }
  if (Array.isArray(input.messages) || Array.isArray(input.transcript)) {
    return true;
  }
  if (input.history || input.compressedHistory || asArray(input.recentTurns).length) {
    return true;
  }
  return estimateGatewayTokens(messages) > Number(options.autoThresholdTokens || 12000);
}

function compactedMessagesForGateway(result = {}) {
  const summary = String(result.summary || result.boundaryMessage?.content || "").trim();
  const messages = [];
  if (summary) {
    messages.push({
      role: "system",
      content: [
        "LicoMesh context compaction summary follows. It is auxiliary memory, not canonical evidence.",
        summary
      ].join("\n")
    });
  }
  for (const item of asArray(result.reinjection?.items)) {
    messages.push({
      role: "system",
      content: `Reinjected runtime state (${item.key}): ${JSON.stringify(item.value)}`
    });
  }
  for (const message of asArray(result.messagesToKeep).slice(-24)) {
    messages.push({
      role: ["system", "assistant", "user", "tool"].includes(String(message.role || ""))
        ? String(message.role)
        : "user",
      content: gatewayMessageText(message)
    });
  }
  return messages;
}

async function prepareAgentGatewayInputWithCompaction({
  input = {},
  contextRuntime = null,
  source = "agent-gateway"
} = {}) {
  if (!contextRuntime || typeof contextRuntime.runCompaction !== "function") {
    return { input, compaction: null };
  }
  const messages = toCompactionMessages(input);
  if (!messages.length || !shouldCompactAgentGatewayInput(input, messages)) {
    return { input, compaction: null };
  }
  const question = String(input.question || input.query || "").trim();
  const options = asPlainObject(input.contextCompaction);
  const compaction = await contextRuntime.runCompaction({
    contextProfileId:
      input.contextProfileId ||
      input.compactionProfileId ||
      options.contextProfileId ||
      options.profileId ||
      input.modelAlias ||
      input.alias ||
      "",
    sessionId: input.sessionId || input.conversationId || input.threadId || "",
    messages,
    taskBrief: question || input.taskBrief || input.intent || "",
    runtimeState: {
      ...asPlainObject(input.runtimeState),
      taskBrief: question || input.taskBrief || input.intent || "",
      enabledTools: input.pluginList || input.tools || input.runtimeState?.enabledTools || [],
      operationCatalog: input.operationCatalog || input.runtimeState?.operationCatalog || [],
      activePlan: input.activePlan || input.plan || input.runtimeState?.activePlan || null,
      userConstraints: input.userConstraints || input.runtimeState?.userConstraints || []
    },
    inputSource: source,
    force: options.force === true || input.forceContextCompaction === true,
    compactionPolicy: {
      ...asPlainObject(options.policy),
      recentMessageProtectionCount:
        options.recentMessageProtectionCount === undefined && options.force === true
          ? 1
          : options.recentMessageProtectionCount,
      recentTurnProtectionCount:
        options.recentTurnProtectionCount === undefined && options.force === true
          ? 1
          : options.recentTurnProtectionCount
    },
    persist: options.persist !== false,
    useSessionMemory: options.useSessionMemory !== false,
    modelAssisted: options.modelAssisted === true
  });
  if (!compaction?.compacted) {
    return { input, compaction };
  }
  const gatewayMessages = compactedMessagesForGateway(compaction);
  const compactedQuestion = [
    "LicoMesh compacted prior context before this agent call.",
    `Boundary: ${compaction.boundary?.boundaryId || ""}`,
    compaction.summary || "",
    compaction.reinjection?.items?.length
      ? `Runtime state: ${JSON.stringify(compaction.reinjection.items.map((item) => ({
          key: item.key,
          value: item.value
        })))}`
      : "",
    question ? `Current question:\n${question}` : ""
  ].filter(Boolean).join("\n\n");
  return {
    input: {
      ...input,
      question: compactedQuestion,
      query: input.query && !input.question ? compactedQuestion : input.query,
      messages: Array.isArray(input.messages) ? gatewayMessages : input.messages,
      contextCompaction: false,
      contextCompactionResult: {
        compacted: true,
        boundaryId: compaction.boundary?.boundaryId || "",
        strategy: compaction.strategy || "",
        tokenReport: compaction.tokenReport || null
      }
    },
    compaction
  };
}

async function executeAgentGatewayCandidate({
  settings = {},
  input = {},
  fetchImpl = fetch,
  userDataPath = "",
  egressLookup,
  dryRun = false
} = {}) {
  const config = resolveAgentGatewayConfig(settings, input);
  const moduleProfileLayer = withModuleAgentProfileInput(settings, input, config);
  const effectiveInput = moduleProfileLayer.input;
  if (!String(effectiveInput.question || effectiveInput.query || "").trim()) {
    throw new Error("question 不能为空。");
  }
  if (!config.url) {
    throw new Error(
      config.alias || config.provider
        ? `智能体 URL 未配置：${config.alias || config.provider}`
        : "必须显式选择已配置的智能体或模型别名。"
    );
  }
  if (!Number.isFinite(Number(config.timeoutMs)) || Number(config.timeoutMs) <= 0) {
    throw new Error(`智能体超时未配置：${config.alias || config.provider}`);
  }
  if (config.token && !String(config.tokenHeader || "").trim()) {
    throw new Error(`智能体凭据请求头未配置：${config.alias || config.provider}`);
  }
  if (dryRun) {
    return { config, input: effectiveInput, result: null };
  }
  if (config.provider === "deepseek") {
    const result = await callDeepSeekGateway({ config, input: effectiveInput, fetchImpl, userDataPath, lookup: egressLookup });
    return { config, input: effectiveInput, result };
  }
  if (["openai", "openrouter", "copilot", "local-model"].includes(config.provider)) {
    const result = await callOpenAiCompatibleGateway({ config, input: effectiveInput, fetchImpl, userDataPath, lookup: egressLookup });
    return { config, input: effectiveInput, result };
  }
  const payload = buildAgentGatewayPayload(effectiveInput, settings);

  const auditCallId = crypto.randomUUID();
  const upstreamTarget = safeUrlSummary(config.url);
  await appendAgentGatewayAudit({
    userDataPath,
    event: {
      event: "request_started",
      callId: auditCallId,
      provider: config.provider || "agent-gateway",
      alias: config.alias,
      model: config.model || config.alias,
      upstreamTarget,
      timeoutMs: config.timeoutMs,
      request: summarizeAgentGatewayPayload(payload)
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
      lookup: egressLookup,
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
        provider: config.provider || "agent-gateway",
        alias: config.alias,
        model: config.model || config.alias,
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
      const details = await readGatewayErrorDetails(response, "Agent gateway error response");
      const publicDetails = truncateText(redactSecretText(details), 8000);
      await appendAgentGatewayAudit({
        userDataPath,
        event: {
          event: "request_failed",
          callId: auditCallId,
          provider: config.provider || "agent-gateway",
          alias: config.alias,
          model: config.model || config.alias,
          upstreamTarget,
          errorStage: "http",
          status: response.status,
          contentType: String(response.headers.get("content-type") || ""),
          error: publicDetails
        }
      });
      throw new Error(`智能体调用失败：${response.status}${publicDetails ? ` ${publicDetails}` : ""}`.trim());
    }

    const contentType = String(response.headers.get("content-type") || "");
    const isStream =
      /text\/event-stream/i.test(contentType) ||
      /application\/x-ndjson/i.test(contentType);
    const parsed = isStream && response.body
      ? await readStreamResponse(response)
      : await readJsonOrTextResponse(response);

    const result = {
      ok: true,
      request: payload,
      upstream: {
        status: response.status,
        contentType
      },
      ...parsed
    };
    await appendAgentGatewayAudit({
      userDataPath,
      event: {
        event: "request_completed",
        callId: auditCallId,
        provider: config.provider || "agent-gateway",
        alias: config.alias,
        model: config.model || config.alias,
        upstreamTarget,
        status: response.status,
        contentType,
        response: summarizeGatewayResult(result)
      }
    });
    return { config, input: effectiveInput, result };
  } finally {
    await closeConfiguredModelFetch(pinnedFetch);
  }
}

export async function callAgentGateway({
  settings = {},
  input = {},
  fetchImpl = fetch,
  userDataPath = "",
  contextRuntime = null,
  contextCompactionSource = "agent_gateway.call",
  egressLookup
} = {}) {
  const modelEgressDecision = assertModelAssistedEgressAllowed({
    source: contextCompactionSource,
    contextCompactionSource
  });
  const modelEgressSource = modelEgressDecision.matchedSource;
  const prepared = await prepareAgentGatewayInputWithCompaction({
    input,
    contextRuntime,
    source: modelEgressSource
  });
  let effectiveInput = prepared.input;
  const contextCompaction = publicGatewayCompactionResult(prepared.compaction);
  const withRuntimeMetadata = (result = {}) => contextCompaction
    ? { ...result, contextCompaction }
    : result;
  if (shouldUseModelRouting(effectiveInput, settings)) {
    const routingInput = {
      settings,
      input: effectiveInput,
      userDataPath,
      registry: resolveAgentGatewayRegistry(settings),
      executeCandidate: ({ input: candidateInput, dryRun }) =>
        executeAgentGatewayCandidate({
          settings,
          input: candidateInput,
          fetchImpl,
          userDataPath,
          egressLookup,
          dryRun
        })
    };
    const routed = await runModelRouting(routingInput);
    return withRuntimeMetadata({
      ...routed.result,
      modelRouting: routed.routing
    });
  }
  const executed = await executeAgentGatewayCandidate({
    settings,
    input: effectiveInput,
    fetchImpl,
    userDataPath,
    egressLookup
  });
  return withRuntimeMetadata(executed.result);
}

export async function inspectAgentModelRouting({ userDataPath = "", limit = 50 } = {}) {
  return inspectModelRouting({ userDataPath, limit });
}
