import path from "node:path";
import crypto from "node:crypto";
import { BUILTIN_COMPACTION_STRATEGIES, CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
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
} from "./validation.ts";
import { buildMessageGraph, chooseCompactionCutPoint, normalizeConversationInput } from "./graph.ts";
import {
  buildCompactionQualityReport,
  buildReinjectionPayload,
  compactToBudget,
  microCompactMessages
} from "./projection.ts";
import { createBuiltinStrategyAdapters } from "./runtime-strategies.ts";
import { publicStrategyConfig } from "./strategies.ts";
import { appendJsonl, publicRecordFromResult, readJson, readJsonlTail, writeJson } from "./storage.ts";
import {
  CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES,
  conversationPayload,
  conversationPayloadBytes,
  createContextCompactionExecutionLane
} from "./execution-lane.ts";

export { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
export {
  computeCompactionBudget,
  estimateContextTokens,
  normalizeCompactionPolicy,
  redactCompactionValue
} from "./validation.ts";
export { buildMessageGraph, chooseCompactionCutPoint } from "./graph.ts";
export { createContextCompactionStrategyAdapter, listContextCompactionStrategies } from "./strategies.ts";

const AGENT_MEMORY_PORT_METHODS: readonly any[] = Object.freeze([
  "latestSessionMemory",
  "appendSessionMemory",
  "listSessionMemory",
  "clearSessionMemory"
]);

function assertAgentMemoryPort(agentMemory?: any) : any {
  if (!agentMemory || typeof agentMemory.sessionMemoryPath !== "string" ||
      AGENT_MEMORY_PORT_METHODS.some((method?: any) : any => typeof agentMemory[method] !== "function")) {
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
}: Record<string, any>) : any {
  const rootPath: any = path.join(userDataPath, "context-core");
  const recordsPath: any = path.join(rootPath, "context-compaction-records.jsonl");
  const boundariesPath: any = path.join(rootPath, "context-compaction-boundaries.jsonl");
  const memoryStore: any = assertAgentMemoryPort(agentMemory);
  const sessionMemoryPath: any = memoryStore.sessionMemoryPath;
  const statePath: any = path.join(rootPath, "context-compaction-state.json");
  let executionLane: any = null;

  async function normalizeAdmittedConversation(input: Record<string, any> = {}) : Promise<any> {
    const bytes: number = conversationPayloadBytes(input);
    if (bytes <= CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES) return normalizeConversationInput(input);
    executionLane ||= createContextCompactionExecutionLane();
    return executionLane.normalize(conversationPayload(input), { bytes });
  }

  async function getState() : Promise<any> {
    const state: any = await readJson(statePath, {});
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      modelFailureCount: Math.max(0, Number(state.modelFailureCount || 0)),
      autoFailureCount: Math.max(0, Number(state.autoFailureCount || 0)),
      circuitOpenUntil: state.circuitOpenUntil || "",
      updatedAt: state.updatedAt || ""
    };
  }

  async function saveState(patch: Record<string, any> = {}) : Promise<any> {
    const state: Record<string, any> = {
      ...(await getState()),
      ...patch,
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      updatedAt: nowIso()
    };
    await writeJson(statePath, state);
    return state;
  }

  async function resetFailureState() : Promise<any> {
    return saveState({ modelFailureCount: 0, autoFailureCount: 0, circuitOpenUntil: "" });
  }

  async function registerModelFailure(policy?: any) : Promise<any> {
    const state: any = await getState();
    const modelFailureCount: any = state.modelFailureCount + 1;
    const circuitOpenUntil: any = modelFailureCount >= policy.maxConsecutiveFailures
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ modelFailureCount, circuitOpenUntil });
  }

  async function registerAutoFailure(policy?: any) : Promise<any> {
    const state: any = await getState();
    const autoFailureCount: any = state.autoFailureCount + 1;
    const circuitOpenUntil: any = autoFailureCount >= policy.maxConsecutiveFailures
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ autoFailureCount, circuitOpenUntil });
  }

  async function latestSessionMemory({ sessionId = "", profileId = "", sourceHash = "" }: Record<string, any> = {}) : Promise<any> {
    return memoryStore.latestSessionMemory({ sessionId, profileId, sourceHash });
  }

  async function appendSessionMemory(entry: Record<string, any> = {}) : Promise<any> {
    return memoryStore.appendSessionMemory({
      ...entry,
      sourceProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION
    });
  }

  async function listSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    return memoryStore.listSessionMemory(input);
  }

  async function clearSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    const result: any = await memoryStore.clearSessionMemory(input);
    await resetFailureState();
    return result;
  }

  const strategyAdapters: any = createBuiltinStrategyAdapters({
    strategies,
    compactionStrategies,
    modelCompressor,
    agentGatewayCall,
    latestSessionMemory,
    resetFailureState,
    registerModelFailure
  });

  function resolveStrategyAdapter(policy: Record<string, any> = {}) : any {
    const strategyId: any = normalizeStrategyId(policy.strategy?.id);
    const adapter: any = strategyAdapters.get(strategyId);
    if (!adapter) {
      throw new Error(`context_compaction_strategy_unknown:${strategyId}`);
    }
    return adapter;
  }

  async function runConfiguredStrategy(context: Record<string, any> = {}) : Promise<any> {
    const adapter: any = resolveStrategyAdapter(context.policy);
    const result: any = await adapter.run(context);
    return {
      ...result,
      strategy: {
        ...publicStrategyConfig(context.policy),
        id: adapter.id,
        label: adapter.label || adapter.id
      }
    };
  }

  async function compactMessages(input: Record<string, any> = {}) : Promise<any> {
    const profile: any = asObject(input.profile);
    const policy: any = normalizeCompactionPolicy(profile, input.compactionPolicy);
    const budget: any = computeCompactionBudget(profile, policy);
    const sessionId: any = String(input.sessionId || input.conversationId || input.threadId || "").trim();
    const source: any = String(input.source || input.inputSource || "runtime");
    const createdAt: any = nowIso();
    const messages: any = await normalizeAdmittedConversation(input);
    const sourceTokens: any = messages.reduce(
      (total?: any, message?: any) : any => total + Math.max(1, Number(message.tokenEstimate) || 0),
      0
    );
    const graph: any = buildMessageGraph(messages);
    const triggerReason: any =
      sourceTokens >= budget.hardThresholdTokens
        ? "hard_threshold"
        : sourceTokens >= budget.autoCompactThresholdTokens
          ? "auto_threshold"
          : sourceTokens >= budget.warningThresholdTokens
            ? "warning_threshold"
            : "within_budget";
    const force: any = input.force === true || input.manual === true;
    const shouldCompact: any = force || (policy.enabled === true && sourceTokens >= budget.autoCompactThresholdTokens);
    const state: any = await getState();
    const circuitOpen: any = state.circuitOpenUntil && Date.parse(state.circuitOpenUntil) > Date.now();

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
      const cutPoint: any = chooseCompactionCutPoint(messages, { profile, policyPatch: policy });
      const compactedMessages: any = graph.messages.slice(0, cutPoint.cutIndex);
      const keptOriginal: any = graph.messages.slice(cutPoint.cutIndex);
      const runtimeState: Record<string, any> = {
        ...asObject(input.runtimeState),
        taskBrief: input.taskBrief || input.task || input.query || input.runtimeState?.taskBrief || "",
        activePlan: input.activePlan || input.plan || input.runtimeState?.activePlan || null,
        gatewayReference:
          input.gatewayReference ||
          input.runtimeState?.gatewayReference ||
          ""
      };
      const compactedRange: Record<string, any> = {
        startIndex: compactedMessages[0]?.index ?? 0,
        endIndex: compactedMessages.at(-1)?.index ?? -1,
        startMessageId: compactedMessages[0]?.id || "",
        endMessageId: compactedMessages.at(-1)?.id || "",
        compactedMessageCount: compactedMessages.length
      };
      const targetTokens: any = Math.min(
        policy.summaryReserveTokens,
        Math.floor(Math.max(sourceTokens, 1) * policy.deterministicTargetRatio)
      );
      if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
        throw new Error("context_profile_config_required:compactionPolicy.deterministicTargetRatio");
      }
      const sourceHash: any = hashValue({
        sessionId,
        profileId: profile.profileId || "",
        compactedRange,
        messageIds: compactedMessages.map((message?: any) : any => message.id),
        sourceTokens,
        taskBrief: runtimeState.taskBrief || "",
        activePlan: runtimeState.activePlan || null,
        gatewayReference: runtimeState.gatewayReference || ""
      });

      const strategyResult: any = await runConfiguredStrategy({
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
      const executionMode: any = strategyResult.executionMode || "deterministic-extractive";
      const summaryResult: any = strategyResult.summaryResult;
      const degradedReasons: any[] = [...asArray(strategyResult.degradedReasons)];
      const modelEvents: any[] = [...asArray(strategyResult.modelEvents)];
      const memoryEvents: any[] = [...asArray(strategyResult.memoryEvents)];
      const preprocessingEvents: any[] = [...asArray(strategyResult.preprocessingEvents)];
      const strategy: any = strategyResult.strategy || publicStrategyConfig(policy);

      const reinjection: any = buildReinjectionPayload({
        input,
        runtimeState,
        policy
      });
      if (reinjection.degraded) {
        degradedReasons.push("reinjection_budget_exceeded");
      }

      const micro: any = microCompactMessages(keptOriginal, {
        policy,
        activeToolUseIds: input.activeToolUseIds || input.runtimeState?.activeToolUseIds || []
      });
      const messagesToKeep: any = micro.messages;
      const summary: any = redactText(summaryResult.summary || "");
      const summaryTokens: any = estimateContextTokens(summary);
      const keptTokens: any = messagesToKeep.reduce(
        (total?: any, message?: any) : any => total + Math.max(1, Number(message.tokenEstimate) || 0),
        0
      );
      const reinjectionTokens: any = reinjection.usedTokens;
      const finalTokens: any = summaryTokens + keptTokens + reinjectionTokens;
      const tokenReport: Record<string, any> = {
        sourceTokens,
        effectiveWindowTokens: budget.effectiveWindowTokens,
        warningThresholdTokens: budget.warningThresholdTokens,
        autoCompactThresholdTokens: budget.autoCompactThresholdTokens,
        hardThresholdTokens: budget.hardThresholdTokens,
        compactedSourceTokens: compactedMessages.reduce(
          (total?: any, message?: any) : any => total + Math.max(1, Number(message.tokenEstimate) || 0),
          0
        ),
        summaryTokens,
        keptTokens,
        reinjectionTokens,
        finalTokens,
        savedTokens: Math.max(0, sourceTokens - finalTokens),
        savingsRatio: Number((Math.max(0, sourceTokens - finalTokens) / Math.max(1, sourceTokens)).toFixed(6))
      };
      const qualityReport: any = buildCompactionQualityReport({
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
      const boundary: Record<string, any> = {
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
      const boundaryMessage: Record<string, any> = {
        id: boundary.boundaryId,
        role: "system",
        type: "compact_boundary",
        content: summary,
        boundary,
        reinjection
      };
      const result: Record<string, any> = {
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
    } catch (error: any) {
      const nextState: any = await registerAutoFailure(policy);
      const failed: Record<string, any> = {
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

  async function preview(input: Record<string, any> = {}) : Promise<any> {
    const result: any = await compactMessages({
      ...input,
      persist: false,
      force: input.force === true || input.manual === true
    });
    return {
      ...result,
      preview: true
    };
  }

  async function run(input: Record<string, any> = {}) : Promise<any> {
    return compactMessages({
      ...input,
      force: input.force !== false
    });
  }

  async function maybeCompact(input: Record<string, any> = {}) : Promise<any> {
    return compactMessages(input);
  }

  async function listRecords(input: Record<string, any> = {}) : Promise<any> {
    const records: any = await readJsonlTail(recordsPath, input.limit || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: recordsPath,
      records
    };
  }

  async function listBoundaries(input: Record<string, any> = {}) : Promise<any> {
    const records: any = await readJsonlTail(boundariesPath, input.limit || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: boundariesPath,
      boundaries: records
    };
  }

  function listStrategies() : any {
    const builtinIds: any = new Set<any>(BUILTIN_COMPACTION_STRATEGIES.map((item?: any) : any => item.id));
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      strategies: [...strategyAdapters.values()].map((adapter?: any) : any => ({
        id: adapter.id,
        label: adapter.label || adapter.id,
        custom: !builtinIds.has(adapter.id)
      }))
    };
  }

  function resumeTranscript(input: Record<string, any> = {}) : any {
    const messages: any = normalizeConversationInput(input);
    let boundaryIndex: any = -1;
    for (let index: any = messages.length - 1; index >= 0; index -= 1) {
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
    const boundary: any = messages[boundaryIndex].boundary || {};
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
    async close() : Promise<any> {
      await executionLane?.close?.();
      executionLane = null;
    },
    estimateTokens: estimateContextTokens,
    redactValue: redactCompactionValue
  };
}

export default createContextCompactionRuntime;
