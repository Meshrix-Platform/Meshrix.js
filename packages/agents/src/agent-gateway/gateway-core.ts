import crypto from "node:crypto";
import {
  inspectModelRouting,
  runModelRouting,
  shouldUseModelRouting
} from "./model-routing/index.ts";
import { assertModelAssistedEgressAllowed } from "./model-egress-policy.ts";
import {
  asArray,
  asPlainObject,
  asStringList,
  safeUrlSummary,
  textFromContent,
} from "./shared.ts";
import { appendAgentGatewayAudit } from "./audit.ts";
import {
  publicGatewayCompactionResult,
  summarizeAgentGatewayPayload,
  summarizeGatewayResult
} from "./projections.ts";
import {
  buildAgentGatewayPayload,
  resolveAgentGatewayConfig,
  resolveAgentGatewayRegistry,
  withModuleAgentProfileInput
} from "./policy-validation.ts";
import {
  closeConfiguredModelFetch,
  createHeaders,
  fetchConfiguredModelService,
  readGatewayErrorDetails,
  readJsonOrTextResponse,
  readStreamResponse
} from "./transport-helpers.ts";
import {
  callDeepSeekGateway,
  callOpenAiCompatibleGateway
} from "./model-transport.ts";
import {
  agentGatewayError,
  agentGatewayHttpError,
  normalizeAgentGatewayError
} from "./errors.ts";

function estimateGatewayTokens(value?: any) : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount: any = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount: any = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

function gatewayMessageText(message: Record<string, any> = {}) : any {
  return textFromContent(message.content ?? message.text ?? message.summary ?? "", {
    includeReasoning: true
  }) || JSON.stringify(message.content ?? message.text ?? "");
}

function toCompactionMessages(input: Record<string, any> = {}) : any {
  if (Array.isArray(input.transcript)) {
    return input.transcript;
  }
  if (Array.isArray(input.messages)) {
    return input.messages;
  }
  const messages: any[] = [];
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
  const question: any = String(input.question || input.query || "").trim();
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

function shouldCompactAgentGatewayInput(input: Record<string, any> = {}, messages: any = []) : any {
  if (input.contextCompaction === false || input.skipContextCompaction === true) {
    return false;
  }
  const options: any = asPlainObject(input.contextCompaction);
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

function compactedMessagesForGateway(result: Record<string, any> = {}) : any {
  const summary: any = String(result.summary || result.boundaryMessage?.content || "").trim();
  const messages: any[] = [];
  if (summary) {
    messages.push({
      role: "system",
      content: [
        "Meshrix.js context compaction summary follows. It is auxiliary memory, not canonical evidence.",
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
}: Record<string, any> = {}) : Promise<any> {
  if (!contextRuntime || typeof contextRuntime.runCompaction !== "function") {
    return { input, compaction: null };
  }
  const messages: any = toCompactionMessages(input);
  if (!messages.length || !shouldCompactAgentGatewayInput(input, messages)) {
    return { input, compaction: null };
  }
  const question: any = String(input.question || input.query || "").trim();
  const options: any = asPlainObject(input.contextCompaction);
  const compaction: any = await contextRuntime.runCompaction({
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
  const gatewayMessages: any = compactedMessagesForGateway(compaction);
  const compactedQuestion: any = [
    "Meshrix.js compacted prior context before this agent call.",
    `Boundary: ${compaction.boundary?.boundaryId || ""}`,
    compaction.summary || "",
    compaction.reinjection?.items?.length
      ? `Runtime state: ${JSON.stringify(compaction.reinjection.items.map((item?: any) : any => ({
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
}: Record<string, any> = {}) : Promise<any> {
  const config: any = resolveAgentGatewayConfig(settings, input);
  const moduleProfileLayer: any = withModuleAgentProfileInput(settings, input, config);
  const effectiveInput: any = moduleProfileLayer.input;
  if (!String(effectiveInput.question || effectiveInput.query || "").trim()) {
    throw agentGatewayError("agent_gateway_invalid_input");
  }
  if (!config.url) {
    throw agentGatewayError("agent_gateway_not_configured");
  }
  if (!Number.isFinite(Number(config.timeoutMs)) || Number(config.timeoutMs) <= 0) {
    throw agentGatewayError("agent_gateway_not_configured");
  }
  if (config.token && !String(config.tokenHeader || "").trim()) {
    throw agentGatewayError("agent_gateway_not_configured");
  }
  if (dryRun) {
    return { config, input: effectiveInput, result: null };
  }
  if (config.provider === "deepseek") {
    const result: any = await callDeepSeekGateway({ config, input: effectiveInput, fetchImpl, userDataPath, lookup: egressLookup });
    return { config, input: effectiveInput, result };
  }
  if (["openai", "openrouter", "copilot", "local-model"].includes(config.provider)) {
    const result: any = await callOpenAiCompatibleGateway({ config, input: effectiveInput, fetchImpl, userDataPath, lookup: egressLookup });
    return { config, input: effectiveInput, result };
  }
  const payload: any = buildAgentGatewayPayload(effectiveInput, settings);

  const auditCallId: any = crypto.randomUUID();
  const upstreamTarget: any = safeUrlSummary(config.url);
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
  const abortController: any = new AbortController();
  const timeout: any = setTimeout(() : any => abortController.abort(), config.timeoutMs);
  let response: any;
  let pinnedFetch: any = null;
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
  } catch (error: any) {
    const failure: any = normalizeAgentGatewayError(error);
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
        errorCode: failure.code
      }
    });
    throw failure;
  } finally {
    clearTimeout(timeout);
  }

  try {
    if (!response.ok) {
      await readGatewayErrorDetails(response, "Agent gateway error response");
      const failure: any = agentGatewayHttpError(response.status);
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
          errorCode: failure.code
        }
      });
      throw failure;
    }

    const contentType: any = String(response.headers.get("content-type") || "");
    const isStream: any =
      /text\/event-stream/i.test(contentType) ||
      /application\/x-ndjson/i.test(contentType);
    const parsed: any = isStream && response.body
      ? await readStreamResponse(response)
      : await readJsonOrTextResponse(response);

    const result: Record<string, any> = {
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
}: Record<string, any> = {}) : Promise<any> {
  const modelEgressDecision: any = assertModelAssistedEgressAllowed({
    source: contextCompactionSource,
    contextCompactionSource
  });
  const modelEgressSource: any = modelEgressDecision.matchedSource;
  const prepared: any = await prepareAgentGatewayInputWithCompaction({
    input,
    contextRuntime,
    source: modelEgressSource
  });
  let effectiveInput: any = prepared.input;
  const contextCompaction: any = publicGatewayCompactionResult(prepared.compaction);
  const withRuntimeMetadata: any = (result: Record<string, any> = {}) : any => contextCompaction
    ? { ...result, contextCompaction }
    : result;
  if (shouldUseModelRouting(effectiveInput, settings)) {
    const routingInput: Record<string, any> = {
      settings,
      input: effectiveInput,
      userDataPath,
      registry: resolveAgentGatewayRegistry(settings),
      executeCandidate: ({ input: candidateInput, dryRun }: Record<string, any>) : any =>
        executeAgentGatewayCandidate({
          settings,
          input: candidateInput,
          fetchImpl,
          userDataPath,
          egressLookup,
          dryRun
        })
    };
    const routed: any = await runModelRouting(routingInput);
    return withRuntimeMetadata({
      ...routed.result,
      modelRouting: routed.routing
    });
  }
  const executed: any = await executeAgentGatewayCandidate({
    settings,
    input: effectiveInput,
    fetchImpl,
    userDataPath,
    egressLookup
  });
  return withRuntimeMetadata(executed.result);
}

export async function inspectAgentModelRouting({ userDataPath = "", limit = 50 }: Record<string, any> = {}) : Promise<any> {
  return inspectModelRouting({ userDataPath, limit });
}
