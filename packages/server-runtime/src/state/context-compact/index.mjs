import path from "node:path";
import crypto from "node:crypto";
import { BUILTIN_COMPACTION_STRATEGIES, CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.mjs";
import {
  asArray,
  asObject,
  computeCompactionBudget,
  estimateContextTokens,
  hashValue,
  normalizeCompactionPolicy,
  normalizeStrategyId,
  nowIso,
  redactCompactionValue,
  redactText
} from "./validation.mjs";
import { buildMessageGraph, chooseCompactionCutPoint, normalizeConversationInput } from "./graph.mjs";
import {
  buildCompactionQualityReport,
  buildReinjectionPayload,
  compactToBudget,
  microCompactMessages
} from "./projection.mjs";
import { createBuiltinStrategyAdapters } from "./runtime-strategies.mjs";
import { publicStrategyConfig } from "./strategies.mjs";
import { appendJsonl, publicRecordFromResult, readJson, readJsonlTail, writeJson } from "./storage.mjs";

export { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.mjs";
export {
  computeCompactionBudget,
  estimateContextTokens,
  normalizeCompactionPolicy,
  redactCompactionValue
} from "./validation.mjs";
export { buildMessageGraph, chooseCompactionCutPoint } from "./graph.mjs";
export { createContextCompactionStrategyAdapter, listContextCompactionStrategies } from "./strategies.mjs";

const AGENT_MEMORY_PORT_METHODS = Object.freeze([
  "latestSessionMemory",
  "appendSessionMemory",
  "listSessionMemory",
  "clearSessionMemory"
]);

function assertAgentMemoryPort(agentMemory) {
  if (!agentMemory || typeof agentMemory.sessionMemoryPath !== "string" ||
      AGENT_MEMORY_PORT_METHODS.some((method) => typeof agentMemory[method] !== "function")) {
    throw new TypeError("Context compaction requires an explicit AgentMemory port.");
  }
  return agentMemory;
}

export function createContextCompactionRuntime({
  userDataPath,
  agentGatewayCall = null,
  modelCompressor = null,
  agentMemory = null,
  strategies = [],
  compactionStrategies = []
}) {
  const rootPath = path.join(userDataPath, "context-core");
  const recordsPath = path.join(rootPath, "context-compaction-records.jsonl");
  const boundariesPath = path.join(rootPath, "context-compaction-boundaries.jsonl");
  const memoryStore = assertAgentMemoryPort(agentMemory);
  const sessionMemoryPath = memoryStore.sessionMemoryPath;
  const statePath = path.join(rootPath, "context-compaction-state.json");

  async function getState() {
    const state = await readJson(statePath, {});
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      modelFailureCount: Math.max(0, Number(state.modelFailureCount || 0)),
      autoFailureCount: Math.max(0, Number(state.autoFailureCount || 0)),
      circuitOpenUntil: state.circuitOpenUntil || "",
      updatedAt: state.updatedAt || ""
    };
  }

  async function saveState(patch = {}) {
    const state = {
      ...(await getState()),
      ...patch,
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      updatedAt: nowIso()
    };
    await writeJson(statePath, state);
    return state;
  }

  async function resetFailureState() {
    return saveState({ modelFailureCount: 0, autoFailureCount: 0, circuitOpenUntil: "" });
  }

  async function registerModelFailure(policy) {
    const state = await getState();
    const modelFailureCount = state.modelFailureCount + 1;
    const circuitOpenUntil = modelFailureCount >= policy.maxConsecutiveFailures
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ modelFailureCount, circuitOpenUntil });
  }

  async function registerAutoFailure(policy) {
    const state = await getState();
    const autoFailureCount = state.autoFailureCount + 1;
    const circuitOpenUntil = autoFailureCount >= policy.maxConsecutiveFailures
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ autoFailureCount, circuitOpenUntil });
  }

  async function latestSessionMemory({ sessionId = "", profileId = "", sourceHash = "" } = {}) {
    return memoryStore.latestSessionMemory({ sessionId, profileId, sourceHash });
  }

  async function appendSessionMemory(entry = {}) {
    return memoryStore.appendSessionMemory({
      ...entry,
      sourceProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION
    });
  }

  async function listSessionMemory(input = {}) {
    return memoryStore.listSessionMemory(input);
  }

  async function clearSessionMemory(input = {}) {
    const result = await memoryStore.clearSessionMemory(input);
    await resetFailureState();
    return result;
  }

  const strategyAdapters = createBuiltinStrategyAdapters({
    strategies,
    compactionStrategies,
    modelCompressor,
    agentGatewayCall,
    latestSessionMemory,
    resetFailureState,
    registerModelFailure
  });

  function resolveStrategyAdapter(policy = {}) {
    const strategyId = normalizeStrategyId(policy.strategy?.id);
    const adapter = strategyAdapters.get(strategyId);
    if (!adapter) {
      throw new Error(`context_compaction_strategy_unknown:${strategyId}`);
    }
    return adapter;
  }

  async function runConfiguredStrategy(context = {}) {
    const adapter = resolveStrategyAdapter(context.policy);
    const result = await adapter.run(context);
    return {
      ...result,
      strategy: {
        ...publicStrategyConfig(context.policy),
        id: adapter.id,
        label: adapter.label || adapter.id
      }
    };
  }

  async function compactMessages(input = {}) {
    const profile = asObject(input.profile);
    const policy = normalizeCompactionPolicy(profile, input.compactionPolicy);
    const budget = computeCompactionBudget(profile, policy);
    const sessionId = String(input.sessionId || input.conversationId || input.threadId || "").trim();
    const source = String(input.source || input.inputSource || "runtime");
    const createdAt = nowIso();
    const messages = normalizeConversationInput(input);
    const sourceTokens = estimateContextTokens(messages.map((message) => message.text).join("\n"));
    const graph = buildMessageGraph(messages);
    const triggerReason =
      sourceTokens >= budget.hardThresholdTokens
        ? "hard_threshold"
        : sourceTokens >= budget.autoCompactThresholdTokens
          ? "auto_threshold"
          : sourceTokens >= budget.warningThresholdTokens
            ? "warning_threshold"
            : "within_budget";
    const force = input.force === true || input.manual === true;
    const shouldCompact = force || (policy.enabled === true && sourceTokens >= budget.autoCompactThresholdTokens);
    const state = await getState();
    const circuitOpen = state.circuitOpenUntil && Date.parse(state.circuitOpenUntil) > Date.now();

    if (!shouldCompact) {
      return {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        status: "skipped",
        source,
        sessionId,
        profileId: profile.profileId || "",
        triggerReason,
        shouldCompact: false,
        compacted: false,
        strategy: publicStrategyConfig(policy),
        executionMode: "",
        createdAt,
        tokenReport: {
          sourceTokens,
          effectiveWindowTokens: budget.effectiveWindowTokens,
          warningThresholdTokens: budget.warningThresholdTokens,
          autoCompactThresholdTokens: budget.autoCompactThresholdTokens,
          hardThresholdTokens: budget.hardThresholdTokens,
          summaryTokens: 0,
          keptTokens: sourceTokens,
          reinjectionTokens: 0,
          savingsRatio: 0
        },
        circuitBreaker: {
          open: Boolean(circuitOpen),
          modelFailureCount: state.modelFailureCount,
          autoFailureCount: state.autoFailureCount,
          openUntil: state.circuitOpenUntil
        }
      };
    }

    if (input.persist !== false && policy.persistSessionMemory === true && !sessionId) {
      throw new Error("context_compaction_session_id_required");
    }

    try {
      const cutPoint = chooseCompactionCutPoint(messages, { profile, policyPatch: policy });
      const compactedMessages = graph.messages.slice(0, cutPoint.cutIndex);
      const keptOriginal = graph.messages.slice(cutPoint.cutIndex);
      const runtimeState = {
        ...asObject(input.runtimeState),
        taskBrief: input.taskBrief || input.task || input.query || input.runtimeState?.taskBrief || "",
        activePlan: input.activePlan || input.plan || input.runtimeState?.activePlan || null,
        gatewayReference:
          input.gatewayReference ||
          input.runtimeState?.gatewayReference ||
          ""
      };
      const compactedRange = {
        startIndex: compactedMessages[0]?.index ?? 0,
        endIndex: compactedMessages.at(-1)?.index ?? -1,
        startMessageId: compactedMessages[0]?.id || "",
        endMessageId: compactedMessages.at(-1)?.id || "",
        compactedMessageCount: compactedMessages.length
      };
      const targetTokens = Math.min(
        policy.summaryReserveTokens,
        Math.floor(Math.max(sourceTokens, 1) * policy.deterministicTargetRatio)
      );
      if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
        throw new Error("context_profile_config_required:compactionPolicy.deterministicTargetRatio");
      }
      const sourceHash = hashValue({
        sessionId,
        profileId: profile.profileId || "",
        compactedRange,
        messageIds: compactedMessages.map((message) => message.id),
        sourceTokens,
        taskBrief: runtimeState.taskBrief || "",
        activePlan: runtimeState.activePlan || null,
        gatewayReference: runtimeState.gatewayReference || ""
      });

      const strategyResult = await runConfiguredStrategy({
        input,
        profile,
        policy,
        budget,
        sessionId,
        source,
        createdAt,
        messages,
        graph,
        sourceTokens,
        triggerReason,
        state,
        circuitOpen,
        cutPoint,
        compactedMessages,
        keptOriginal,
        runtimeState,
        compactedRange,
        targetTokens,
        sourceHash
      });
      const executionMode = strategyResult.executionMode || "deterministic-extractive";
      const summaryResult = strategyResult.summaryResult;
      const degradedReasons = [...asArray(strategyResult.degradedReasons)];
      const modelEvents = [...asArray(strategyResult.modelEvents)];
      const memoryEvents = [...asArray(strategyResult.memoryEvents)];
      const preprocessingEvents = [...asArray(strategyResult.preprocessingEvents)];
      const strategy = strategyResult.strategy || publicStrategyConfig(policy);

      const reinjection = buildReinjectionPayload({
        input,
        runtimeState,
        policy
      });
      if (reinjection.degraded) {
        degradedReasons.push("reinjection_budget_exceeded");
      }

      const micro = microCompactMessages(keptOriginal, {
        policy,
        activeToolUseIds: input.activeToolUseIds || input.runtimeState?.activeToolUseIds || []
      });
      const messagesToKeep = micro.messages;
      const summary = redactText(summaryResult.summary || "");
      const summaryTokens = estimateContextTokens(summary);
      const keptTokens = estimateContextTokens(messagesToKeep.map((message) => message.text || message.content || "").join("\n"));
      const reinjectionTokens = reinjection.usedTokens;
      const finalTokens = summaryTokens + keptTokens + reinjectionTokens;
      const tokenReport = {
        sourceTokens,
        effectiveWindowTokens: budget.effectiveWindowTokens,
        warningThresholdTokens: budget.warningThresholdTokens,
        autoCompactThresholdTokens: budget.autoCompactThresholdTokens,
        hardThresholdTokens: budget.hardThresholdTokens,
        compactedSourceTokens: estimateContextTokens(compactedMessages.map((message) => message.text).join("\n")),
        summaryTokens,
        keptTokens,
        reinjectionTokens,
        finalTokens,
        savedTokens: Math.max(0, sourceTokens - finalTokens),
        savingsRatio: Number((Math.max(0, sourceTokens - finalTokens) / Math.max(1, sourceTokens)).toFixed(6))
      };
      const qualityReport = buildCompactionQualityReport({
        input,
        runtimeState,
        summary,
        messagesToKeep,
        reinjection,
        tokenReport
      });
      if (!qualityReport.passed) {
        degradedReasons.push(
          qualityReport.missingAnchorCount > 0
            ? "required_anchor_loss"
            : "compaction_quality_failed"
        );
      }
      const boundary = {
        type: "compact_boundary",
        boundaryId: `context_boundary_${crypto.randomUUID()}`,
        profileId: profile.profileId || "",
        sessionId,
        sourceRange: compactedRange,
        lastOriginalMessageId: compactedMessages.at(-1)?.id || "",
        summaryChecksum: hashValue(summary),
        preservedTailCount: messagesToKeep.length,
        tokenReport,
        qualityReport,
        strategy,
        executionMode,
        degraded: degradedReasons.length > 0,
        createdAt
      };
      const boundaryMessage = {
        id: boundary.boundaryId,
        role: "system",
        type: "compact_boundary",
        content: summary,
        boundary,
        reinjection
      };
      const result = {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        recordId: `context_compaction_${crypto.randomUUID()}`,
        status: "completed",
        source,
        sessionId,
        profileId: profile.profileId || "",
        triggerReason,
        shouldCompact: true,
        compacted: true,
        strategy,
        executionMode,
        degraded: degradedReasons.length > 0,
        degradedReasons,
        modelEvents,
        memoryEvents,
        preprocessingEvents,
        cutPoint,
        boundary,
        boundaryMessage,
        summary,
        structuredSummary: summaryResult.structured || {},
        reinjection,
        messagesToKeep,
        attachmentsToReinject: micro.dehydratedAttachments,
        microCompaction: {
          changedCount: micro.changedCount,
          dehydratedAttachmentCount: micro.dehydratedAttachments.length
        },
        circuitBreaker: {
          open: Boolean(circuitOpen),
          modelFailureCount: (await getState()).modelFailureCount,
          autoFailureCount: (await getState()).autoFailureCount,
          openUntil: (await getState()).circuitOpenUntil
        },
        tokenReport,
        qualityReport,
        createdAt
      };

      if (input.persist !== false) {
        await appendJsonl(recordsPath, publicRecordFromResult(result));
        if (policy.persistBoundaries === true) {
          await appendJsonl(boundariesPath, {
            ...boundary,
            summaryChecksum: hashValue(summary),
            contentPreview: compactToBudget(summary, 260)
          });
        }
        if (policy.persistSessionMemory === true) {
          await appendSessionMemory({
            sessionId,
            profileId: profile.profileId || "",
            boundaryId: boundary.boundaryId,
            sourceHash,
            summary,
            structured: summaryResult.structured || {},
            summaryChecksum: boundary.summaryChecksum,
            sourceRange: compactedRange,
            createdAt
          });
        }
      }
      return result;
    } catch (error) {
      const nextState = await registerAutoFailure(policy);
      const failed = {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        recordId: `context_compaction_${crypto.randomUUID()}`,
        status: "failed",
        source,
        sessionId,
        profileId: profile.profileId || "",
        triggerReason,
        shouldCompact: true,
        compacted: false,
        degraded: true,
        strategy: publicStrategyConfig(policy),
        executionMode: "",
        error: error instanceof Error ? redactText(error.message) : "context_compaction_failed",
        circuitBreaker: {
          open: Boolean(nextState.circuitOpenUntil && Date.parse(nextState.circuitOpenUntil) > Date.now()),
          modelFailureCount: nextState.modelFailureCount,
          autoFailureCount: nextState.autoFailureCount,
          openUntil: nextState.circuitOpenUntil
        },
        createdAt
      };
      if (input.persist !== false) {
        await appendJsonl(recordsPath, publicRecordFromResult(failed));
      }
      throw error;
    }
  }

  async function preview(input = {}) {
    const result = await compactMessages({
      ...input,
      persist: false,
      force: input.force === true || input.manual === true
    });
    return {
      ...result,
      preview: true
    };
  }

  async function run(input = {}) {
    return compactMessages({
      ...input,
      force: input.force !== false
    });
  }

  async function maybeCompact(input = {}) {
    return compactMessages(input);
  }

  async function listRecords(input = {}) {
    const records = await readJsonlTail(recordsPath, input.limit || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: recordsPath,
      records
    };
  }

  async function listBoundaries(input = {}) {
    const records = await readJsonlTail(boundariesPath, input.limit || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: boundariesPath,
      boundaries: records
    };
  }

  function listStrategies() {
    const builtinIds = new Set(BUILTIN_COMPACTION_STRATEGIES.map((item) => item.id));
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      strategies: [...strategyAdapters.values()].map((adapter) => ({
        id: adapter.id,
        label: adapter.label || adapter.id,
        custom: !builtinIds.has(adapter.id)
      }))
    };
  }

  function resumeTranscript(input = {}) {
    const messages = normalizeConversationInput(input);
    let boundaryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].type === "compact_boundary" || messages[index].boundary?.type === "compact_boundary") {
        boundaryIndex = index;
        break;
      }
    }
    if (boundaryIndex < 0) {
      return {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        resumed: false,
        messages
      };
    }
    const boundary = messages[boundaryIndex].boundary || {};
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      resumed: true,
      boundary,
      messages: [
        {
          id: boundary.boundaryId || messages[boundaryIndex].id,
          role: "system",
          type: "compact_boundary",
          content: messages[boundaryIndex].content || messages[boundaryIndex].text || "",
          boundary
        },
        ...messages.slice(boundaryIndex + 1)
      ],
      skippedMessageCount: boundaryIndex
    };
  }

  return {
    protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    rootPath,
    recordsPath,
    boundariesPath,
    sessionMemoryPath,
    agentMemory: memoryStore,
    statePath,
    computeBudget: computeCompactionBudget,
    normalizePolicy: normalizeCompactionPolicy,
    chooseCutPoint: chooseCompactionCutPoint,
    buildMessageGraph,
    preview,
    run,
    maybeCompact,
    listRecords,
    listBoundaries,
    listStrategies,
    listSessionMemory,
    clearSessionMemory,
    latestSessionMemory,
    resumeTranscript,
    estimateTokens: estimateContextTokens,
    redactValue: redactCompactionValue
  };
}

export default createContextCompactionRuntime;
