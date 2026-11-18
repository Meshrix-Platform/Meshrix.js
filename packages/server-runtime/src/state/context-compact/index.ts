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
import type { CompactionPolicy } from "./validation.ts";
import { buildMessageGraph, chooseCompactionCutPoint, normalizeConversationInput } from "./graph.ts";
import type { CompactionCutPoint, MessageGraph, NormalizedMessage } from "./graph.ts";
import {
  buildCompactionQualityReport,
  buildReinjectionPayload,
  compactToBudget,
  microCompactMessages
} from "./projection.ts";
import type { MicroCompactionResult, QualityReport, ReinjectionPayload } from "./projection.ts";
import { createBuiltinStrategyAdapters } from "./runtime-strategies.ts";
import type { ContextCompactionStrategyAdapter } from "./strategies.ts";
import { publicStrategyConfig } from "./strategies.ts";
import type { ListedCompactionStrategy, NormalizedStrategyOutput, StrategyConfigSummary } from "./strategies.ts";
import { appendJsonl, publicRecordFromResult, readJson, readJsonlTail, writeJson } from "./storage.ts";
import {
  CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES,
  conversationPayload,
  conversationPayloadBytes,
  createContextCompactionExecutionLane
} from "./execution-lane.ts";
import type { ContextCompactionExecutionLane } from "./execution-lane.ts";

export { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
export {
  computeCompactionBudget,
  estimateContextTokens,
  normalizeCompactionPolicy,
  redactCompactionValue
} from "./validation.ts";
export { buildMessageGraph, chooseCompactionCutPoint } from "./graph.ts";
export { createContextCompactionStrategyAdapter, listContextCompactionStrategies } from "./strategies.ts";

const AGENT_MEMORY_PORT_METHODS: readonly string[] = Object.freeze([
  "latestSessionMemory",
  "appendSessionMemory",
  "listSessionMemory",
  "clearSessionMemory"
]);

interface AgentMemoryPort {
  sessionMemoryPath: string;
  latestSessionMemory(input: Record<string, unknown>): unknown;
  appendSessionMemory(input: Record<string, unknown>): unknown;
  listSessionMemory(input: Record<string, unknown>): unknown;
  clearSessionMemory(input: Record<string, unknown>): unknown;
}

function assertAgentMemoryPort(agentMemory?: unknown) : AgentMemoryPort {
  const source: Record<string, unknown> = asObject(agentMemory);
  if (typeof source.sessionMemoryPath !== "string" ||
      AGENT_MEMORY_PORT_METHODS.some((method: string) : boolean => typeof source[method] !== "function")) {
    throw new TypeError("Context compaction requires an explicit AgentMemory port.");
  }
  return agentMemory as AgentMemoryPort;
}

export interface ContextCompactionRuntimeOptions {
  userDataPath: string;
  modelCompressor?: unknown;
  agentMemory?: unknown;
  strategies?: unknown[];
  compactionStrategies?: unknown[];
}

interface CompactionState {
  protocolVersion: string;
  modelFailureCount: number;
  autoFailureCount: number;
  circuitOpenUntil: string;
  updatedAt: string;
}

export interface CompactionTokenReport extends Record<string, unknown> {
  sourceTokens: number;
  effectiveWindowTokens: number;
  warningThresholdTokens: number;
  autoCompactThresholdTokens: number;
  hardThresholdTokens: number;
  summaryTokens: number;
  keptTokens: number;
  reinjectionTokens: number;
  savingsRatio: number;
}

export interface CompactionCircuitBreakerReport {
  open: boolean;
  modelFailureCount: number;
  autoFailureCount: number;
  openUntil: string;
}

export interface CompactionResult extends Record<string, unknown> {
  protocolVersion: string;
  status: string;
  source: string;
  sessionId: string;
  profileId: string;
  triggerReason: string;
  shouldCompact: boolean;
  compacted: boolean;
  strategy: unknown;
  executionMode: string;
  degraded: boolean;
  createdAt: string;
  tokenReport: CompactionTokenReport;
  circuitBreaker: CompactionCircuitBreakerReport;
}

export interface ListRecordsResult {
  protocolVersion: string;
  path: string;
  records: unknown[];
}

export interface ListBoundariesResult {
  protocolVersion: string;
  path: string;
  boundaries: unknown[];
}

export interface ListStrategiesResult {
  protocolVersion: string;
  strategies: ListedCompactionStrategy[];
}

export interface ResumeTranscriptResult {
  protocolVersion: string;
  resumed: boolean;
  boundary?: Record<string, unknown>;
  messages: Record<string, unknown>[];
  skippedMessageCount?: number;
}

export interface ContextCompactionRuntime {
  protocolVersion: string;
  rootPath: string;
  recordsPath: string;
  boundariesPath: string;
  sessionMemoryPath: string;
  agentMemory: AgentMemoryPort;
  statePath: string;
  computeBudget: typeof computeCompactionBudget;
  normalizePolicy: typeof normalizeCompactionPolicy;
  chooseCutPoint: typeof chooseCompactionCutPoint;
  buildMessageGraph: typeof buildMessageGraph;
  preview(input?: Record<string, unknown>): Promise<CompactionResult & { preview: boolean }>;
  run(input?: Record<string, unknown>): Promise<CompactionResult>;
  maybeCompact(input?: Record<string, unknown>): Promise<CompactionResult>;
  listRecords(input?: Record<string, unknown>): Promise<ListRecordsResult>;
  listBoundaries(input?: Record<string, unknown>): Promise<ListBoundariesResult>;
  listStrategies(): ListStrategiesResult;
  listSessionMemory(input?: Record<string, unknown>): Promise<unknown>;
  clearSessionMemory(input?: Record<string, unknown>): Promise<unknown>;
  latestSessionMemory(input?: Record<string, unknown>): Promise<unknown>;
  resumeTranscript(input?: Record<string, unknown>): ResumeTranscriptResult;
  close(): Promise<void>;
  estimateTokens: (value?: unknown) => number;
  redactValue: (value?: unknown, depth?: number) => unknown;
}

export function createContextCompactionRuntime({
  userDataPath,
  modelCompressor = null,
  agentMemory = null,
  strategies = [],
  compactionStrategies = []
}: ContextCompactionRuntimeOptions) : ContextCompactionRuntime {
  const rootPath: string = path.join(userDataPath, "context-core");
  const recordsPath: string = path.join(rootPath, "context-compaction-records.jsonl");
  const boundariesPath: string = path.join(rootPath, "context-compaction-boundaries.jsonl");
  const memoryStore: AgentMemoryPort = assertAgentMemoryPort(agentMemory);
  const sessionMemoryPath: string = memoryStore.sessionMemoryPath;
  const statePath: string = path.join(rootPath, "context-compaction-state.json");
  let executionLane: ContextCompactionExecutionLane | null = null;

  async function normalizeAdmittedConversation(input: Record<string, unknown> = {}) : Promise<NormalizedMessage[]> {
    const bytes: number = conversationPayloadBytes(input);
    if (bytes <= CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES) return normalizeConversationInput(input);
    executionLane = executionLane || createContextCompactionExecutionLane();
    return executionLane.normalize(conversationPayload(input), { bytes }) as Promise<NormalizedMessage[]>;
  }

  async function getState() : Promise<CompactionState> {
    const state: Record<string, unknown> = asObject(await readJson(statePath, {}));
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      modelFailureCount: Math.max(0, Number(state.modelFailureCount || 0)),
      autoFailureCount: Math.max(0, Number(state.autoFailureCount || 0)),
      circuitOpenUntil: String(state.circuitOpenUntil || ""),
      updatedAt: String(state.updatedAt || "")
    };
  }

  async function saveState(patch: Record<string, unknown> = {}) : Promise<Record<string, unknown>> {
    const state: Record<string, unknown> = {
      ...(await getState()),
      ...patch,
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      updatedAt: nowIso()
    };
    await writeJson(statePath, state);
    return state;
  }

  async function resetFailureState() : Promise<Record<string, unknown>> {
    return saveState({ modelFailureCount: 0, autoFailureCount: 0, circuitOpenUntil: "" });
  }

  async function registerModelFailure(policy: CompactionPolicy) : Promise<Record<string, unknown>> {
    const state: CompactionState = await getState();
    const modelFailureCount: number = state.modelFailureCount + 1;
    const circuitOpenUntil: string = modelFailureCount >= Number(policy.maxConsecutiveFailures || 0)
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ modelFailureCount, circuitOpenUntil });
  }

  async function registerAutoFailure(policy: CompactionPolicy) : Promise<Record<string, unknown>> {
    const state: CompactionState = await getState();
    const autoFailureCount: number = state.autoFailureCount + 1;
    const circuitOpenUntil: string = autoFailureCount >= Number(policy.maxConsecutiveFailures || 0)
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : state.circuitOpenUntil;
    return saveState({ autoFailureCount, circuitOpenUntil });
  }

  async function latestSessionMemory({ sessionId = "", profileId = "", sourceHash = "" }: Record<string, unknown> = {}) : Promise<unknown> {
    return memoryStore.latestSessionMemory({ sessionId, profileId, sourceHash });
  }

  async function appendSessionMemory(entry: Record<string, unknown> = {}) : Promise<unknown> {
    return memoryStore.appendSessionMemory({
      ...entry,
      sourceProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION
    });
  }

  async function listSessionMemory(input: Record<string, unknown> = {}) : Promise<unknown> {
    return memoryStore.listSessionMemory(input);
  }

  async function clearSessionMemory(input: Record<string, unknown> = {}) : Promise<unknown> {
    const result: unknown = await memoryStore.clearSessionMemory(input);
    await resetFailureState();
    return result;
  }

  const strategyAdapters: Map<string, ContextCompactionStrategyAdapter> = createBuiltinStrategyAdapters({
    strategies,
    compactionStrategies,
    modelCompressor,
    latestSessionMemory,
    resetFailureState,
    registerModelFailure
  });

  function resolveStrategyAdapter(policy: Record<string, unknown> = {}) : ContextCompactionStrategyAdapter {
    const strategyId: string = normalizeStrategyId(asObject(policy.strategy).id);
    const adapter: ContextCompactionStrategyAdapter | undefined = strategyAdapters.get(strategyId);
    if (!adapter) {
      throw new Error(`context_compaction_strategy_unknown:${strategyId}`);
    }
    return adapter;
  }

  async function runConfiguredStrategy(context: Record<string, unknown> = {}) : Promise<NormalizedStrategyOutput & { strategy: StrategyConfigSummary & { id: string; label: string } }> {
    const adapter: ContextCompactionStrategyAdapter = resolveStrategyAdapter(asObject(context.policy));
    const result: NormalizedStrategyOutput = await adapter.run(context);
    return {
      ...result,
      strategy: {
        ...publicStrategyConfig(asObject(context.policy)),
        id: adapter.id,
        label: adapter.label || adapter.id
      }
    };
  }

  async function compactMessages(input: Record<string, unknown> = {}) : Promise<CompactionResult> {
    const profile: Record<string, unknown> = asObject(input.profile);
    const policy: CompactionPolicy = normalizeCompactionPolicy(profile, asObject(input.compactionPolicy));
    const budget = computeCompactionBudget(profile, policy);
    const sessionId: string = String(input.sessionId || input.conversationId || input.threadId || "").trim();
    const source: string = String(input.source || input.inputSource || "runtime");
    const createdAt: string = nowIso();
    const messages: NormalizedMessage[] = await normalizeAdmittedConversation(input);
    const sourceTokens: number = messages.reduce(
      (total: number, message: NormalizedMessage) : number => total + Math.max(1, Number(message.tokenEstimate) || 0),
      0
    );
    const graph: MessageGraph = buildMessageGraph(messages);
    const triggerReason: string =
      sourceTokens >= budget.hardThresholdTokens
        ? "hard_threshold"
        : sourceTokens >= budget.autoCompactThresholdTokens
          ? "auto_threshold"
          : sourceTokens >= budget.warningThresholdTokens
            ? "warning_threshold"
            : "within_budget";
    const force: boolean = input.force === true || input.manual === true;
    const shouldCompact: boolean = force || (policy.enabled === true && sourceTokens >= budget.autoCompactThresholdTokens);
    const state: CompactionState = await getState();
    const circuitOpen: boolean = Boolean(state.circuitOpenUntil && Date.parse(state.circuitOpenUntil) > Date.now());

    if (!shouldCompact) {
      return {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        status: "skipped",
        source,
        sessionId,
        profileId: String(profile.profileId || ""),
        triggerReason,
        shouldCompact: false,
        compacted: false,
        degraded: false,
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
          open: circuitOpen,
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
      const cutPoint: CompactionCutPoint = chooseCompactionCutPoint(messages, { profile, policyPatch: policy });
      const compactedMessages: NormalizedMessage[] = graph.messages.slice(0, cutPoint.cutIndex);
      const keptOriginal: NormalizedMessage[] = graph.messages.slice(cutPoint.cutIndex);
      const runtimeState: Record<string, unknown> = {
        ...asObject(input.runtimeState),
        taskBrief: input.taskBrief || input.task || input.query || asObject(input.runtimeState).taskBrief || "",
        activePlan: input.activePlan || input.plan || asObject(input.runtimeState).activePlan || null,
        gatewayReference:
          input.gatewayReference ||
          asObject(input.runtimeState).gatewayReference ||
          ""
      };
      const compactedRange: Record<string, unknown> = {
        startIndex: compactedMessages[0]?.index ?? 0,
        endIndex: compactedMessages.at(-1)?.index ?? -1,
        startMessageId: compactedMessages[0]?.id || "",
        endMessageId: compactedMessages.at(-1)?.id || "",
        compactedMessageCount: compactedMessages.length
      };
      const targetTokens: number = Math.min(
        Number(policy.summaryReserveTokens || 0),
        Math.floor(Math.max(sourceTokens, 1) * Number(policy.deterministicTargetRatio || 0))
      );
      if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
        throw new Error("context_profile_config_required:compactionPolicy.deterministicTargetRatio");
      }
      const sourceHash: string = hashValue({
        sessionId,
        profileId: profile.profileId || "",
        compactedRange,
        messageIds: compactedMessages.map((message: NormalizedMessage) : string => message.id),
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
      const executionMode: string = strategyResult.executionMode || "deterministic-extractive";
      const summaryResult = strategyResult.summaryResult;
      const degradedReasons: unknown[] = [...asArray(strategyResult.degradedReasons)];
      const modelEvents: unknown[] = [...asArray(strategyResult.modelEvents)];
      const memoryEvents: unknown[] = [...asArray(strategyResult.memoryEvents)];
      const preprocessingEvents: unknown[] = [...asArray(strategyResult.preprocessingEvents)];
      const strategy: unknown = strategyResult.strategy || publicStrategyConfig(policy);

      const reinjection: ReinjectionPayload = buildReinjectionPayload({
        input,
        runtimeState,
        policy
      });
      if (reinjection.degraded) {
        degradedReasons.push("reinjection_budget_exceeded");
      }

      const micro: MicroCompactionResult = microCompactMessages(keptOriginal, {
        policy,
        activeToolUseIds: asArray(input.activeToolUseIds || asObject(input.runtimeState).activeToolUseIds)
      });
      const messagesToKeep: NormalizedMessage[] = micro.messages;
      const summary: string = redactText(summaryResult.summary || "");
      const summaryTokens: number = estimateContextTokens(summary);
      const keptTokens: number = messagesToKeep.reduce(
        (total: number, message: NormalizedMessage) : number => total + Math.max(1, Number(message.tokenEstimate) || 0),
        0
      );
      const reinjectionTokens: number = reinjection.usedTokens;
      const finalTokens: number = summaryTokens + keptTokens + reinjectionTokens;
      const compactedSourceTokens: number = compactedMessages.reduce(
        (total: number, message: NormalizedMessage) : number => total + Math.max(1, Number(message.tokenEstimate) || 0),
        0
      );
      const tokenReport: CompactionTokenReport = {
        sourceTokens,
        effectiveWindowTokens: budget.effectiveWindowTokens,
        warningThresholdTokens: budget.warningThresholdTokens,
        autoCompactThresholdTokens: budget.autoCompactThresholdTokens,
        hardThresholdTokens: budget.hardThresholdTokens,
        compactedSourceTokens,
        summaryTokens,
        keptTokens,
        reinjectionTokens,
        finalTokens,
        savedTokens: Math.max(0, sourceTokens - finalTokens),
        savingsRatio: Number((Math.max(0, sourceTokens - finalTokens) / Math.max(1, sourceTokens)).toFixed(6))
      };
      const qualityReport: QualityReport = buildCompactionQualityReport({
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
      const boundary: Record<string, unknown> = {
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
      const boundaryMessage: Record<string, unknown> = {
        id: boundary.boundaryId,
        role: "system",
        type: "compact_boundary",
        content: summary,
        boundary,
        reinjection
      };
      const result: CompactionResult = {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        recordId: `context_compaction_${crypto.randomUUID()}`,
        status: "completed",
        source,
        sessionId,
        profileId: String(profile.profileId || ""),
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
          open: circuitOpen,
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
    } catch (error: unknown) {
      const nextState: Record<string, unknown> = await registerAutoFailure(policy);
      const failed: Record<string, unknown> = {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        recordId: `context_compaction_${crypto.randomUUID()}`,
        status: "failed",
        source,
        sessionId,
        profileId: String(profile.profileId || ""),
        triggerReason,
        shouldCompact: true,
        compacted: false,
        degraded: true,
        strategy: publicStrategyConfig(policy),
        executionMode: "",
        error: error instanceof Error ? redactText(error.message) : "context_compaction_failed",
        circuitBreaker: {
          open: Boolean(nextState.circuitOpenUntil && Date.parse(String(nextState.circuitOpenUntil)) > Date.now()),
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

  async function preview(input: Record<string, unknown> = {}) : Promise<CompactionResult & { preview: boolean }> {
    const result: CompactionResult = await compactMessages({
      ...input,
      persist: false,
      force: input.force === true || input.manual === true
    });
    return {
      ...result,
      preview: true
    };
  }

  async function run(input: Record<string, unknown> = {}) : Promise<CompactionResult> {
    return compactMessages({
      ...input,
      force: input.force !== false
    });
  }

  async function maybeCompact(input: Record<string, unknown> = {}) : Promise<CompactionResult> {
    return compactMessages(input);
  }

  async function listRecords(input: Record<string, unknown> = {}) : Promise<ListRecordsResult> {
    const records: unknown[] = await readJsonlTail(recordsPath, Number(input.limit) || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: recordsPath,
      records
    };
  }

  async function listBoundaries(input: Record<string, unknown> = {}) : Promise<ListBoundariesResult> {
    const records: unknown[] = await readJsonlTail(boundariesPath, Number(input.limit) || 50);
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      path: boundariesPath,
      boundaries: records
    };
  }

  function listStrategies() : ListStrategiesResult {
    const builtinIds: Set<string> = new Set<string>(BUILTIN_COMPACTION_STRATEGIES.map((item) : string => item.id));
    return {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      strategies: [...strategyAdapters.values()].map((adapter: ContextCompactionStrategyAdapter) : ListedCompactionStrategy => ({
        id: adapter.id,
        label: adapter.label || adapter.id,
        custom: !builtinIds.has(adapter.id)
      }))
    };
  }

  function resumeTranscript(input: Record<string, unknown> = {}) : ResumeTranscriptResult {
    const messages: NormalizedMessage[] = normalizeConversationInput(input);
    let boundaryIndex: number = -1;
    for (let index: number = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].type === "compact_boundary" || asObject(messages[index].boundary).type === "compact_boundary") {
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
    const boundary: Record<string, unknown> = asObject(messages[boundaryIndex].boundary);
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
    async close() : Promise<void> {
      await executionLane?.close?.();
      executionLane = null;
    },
    estimateTokens: estimateContextTokens,
    redactValue: redactCompactionValue
  };
}

export default createContextCompactionRuntime;
