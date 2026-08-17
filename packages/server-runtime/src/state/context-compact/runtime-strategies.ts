import { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
import { asArray, asObject, estimateContextTokens, normalizeStrategyId, redactCompactionValue } from "./validation.ts";
import type { CompactionPolicy } from "./validation.ts";
import {
  buildDeterministicSummary,
  buildModelPrompt,
  compactToBudget,
  createApiRoundSelectionIndex,
  modelInputForAttempt,
  parseModelSummary,
  prepareWorkbenchMessages,
  workbenchInputForAttempt
} from "./projection.ts";
import type { ApiRoundSelectionIndex, WorkbenchInputResult } from "./projection.ts";
import type { NormalizedMessage } from "./graph.ts";
import { createContextCompactionStrategyAdapter, normalizeStrategyOutput } from "./strategies.ts";
import type { ContextCompactionStrategyAdapter, NormalizedStrategyOutput } from "./strategies.ts";

export interface ContextCompactionStrategyContext extends Record<string, unknown> {
  input: Record<string, unknown>;
  profile: Record<string, unknown>;
  policy: CompactionPolicy;
  budget: Record<string, unknown>;
  sessionId: string;
  source: string;
  createdAt: string;
  messages: NormalizedMessage[];
  sourceTokens: number;
  triggerReason: string;
  state: Record<string, unknown>;
  circuitOpen: boolean;
  compactedMessages: NormalizedMessage[];
  keptOriginal: NormalizedMessage[];
  runtimeState: Record<string, unknown>;
  compactedRange: Record<string, unknown>;
  targetTokens: number;
  sourceHash: string;
}

export interface BuiltinStrategyAdapterOptions {
  strategies?: unknown[];
  compactionStrategies?: unknown[];
  modelCompressor?: unknown;
  latestSessionMemory?: unknown;
  resetFailureState?: unknown;
  registerModelFailure?: unknown;
}

interface ModelCompressorOptions {
  profile: Record<string, unknown>;
  policy: CompactionPolicy;
  messages: NormalizedMessage[];
  runtimeState: Record<string, unknown>;
  targetTokens: number;
  prompt: string;
}

interface ModelAttemptRecord extends Record<string, unknown> {
  attempt: number;
  messageCount: number;
  promptTokens: number;
  error?: string;
}

interface ModelAssistedSummaryResult extends Record<string, unknown> {
  ok: true;
  summary: string;
  structured: unknown;
  attempts: ModelAttemptRecord[];
}

export function createBuiltinStrategyAdapters({
  strategies = [],
  compactionStrategies = [],
  modelCompressor = null,
  latestSessionMemory,
  resetFailureState,
  registerModelFailure
}: BuiltinStrategyAdapterOptions = {}) : Map<string, ContextCompactionStrategyAdapter> {
  const compress = modelCompressor as ((options: ModelCompressorOptions) => unknown | Promise<unknown>) | null;
  const latestMemory = latestSessionMemory as (input: Record<string, unknown>) => unknown | Promise<unknown>;
  const resetFailures = resetFailureState as () => unknown | Promise<unknown>;
  const registerFailure = registerModelFailure as (policy?: unknown) => unknown | Promise<unknown>;

  async function modelAssistedSummary({
    profile,
    policy,
    messages,
    runtimeState,
    targetTokens,
    compactedRange,
    inputForAttempt = null
  }: {
    profile: Record<string, unknown>;
    policy: CompactionPolicy;
    messages: NormalizedMessage[];
    runtimeState: Record<string, unknown>;
    targetTokens: number;
    compactedRange: Record<string, unknown>;
    inputForAttempt?: ((messages: NormalizedMessage[], attempt: number, policy: CompactionPolicy, selectionIndex: ApiRoundSelectionIndex) => NormalizedMessage[] | WorkbenchInputResult) | null;
  }) : Promise<ModelAssistedSummaryResult> {
    const attempts: ModelAttemptRecord[] = [];
    const selectionIndex: ApiRoundSelectionIndex = createApiRoundSelectionIndex(messages);
    const maxAttempts: number = Math.max(1, Number(policy.ptlRetryLimit || 0) + 1);
    for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
      const selected: NormalizedMessage[] | WorkbenchInputResult = typeof inputForAttempt === "function"
        ? inputForAttempt(messages, attempt, policy, selectionIndex)
        : modelInputForAttempt(messages, attempt, Number(policy.modelMaxInputTokens || 0), selectionIndex);
      const attemptMessages: NormalizedMessage[] = Array.isArray(selected) ? selected : selected.messages;
      const prompt: string = buildModelPrompt({
        messages: attemptMessages,
        runtimeState,
        targetTokens,
        compactedRange
      });
      const attemptMetadata: Record<string, unknown> = Array.isArray(selected)
        ? {}
        : asObject(selected.metadata);
      attempts.push({
        attempt,
        messageCount: attemptMessages.length,
        promptTokens: estimateContextTokens(prompt),
        ...attemptMetadata
      });
      try {
        const response: unknown = await compress!({
          profile,
          policy,
          messages: attemptMessages,
          runtimeState,
          targetTokens,
          prompt
        });
        const parsed = parseModelSummary(response);
        return {
          ok: true,
          summary: compactToBudget(parsed.summary, targetTokens),
          structured: redactCompactionValue(parsed.structured),
          attempts
        };
      } catch (error: unknown) {
        attempts[attempt].error = error instanceof Error ? error.message : "model_compaction_failed";
      }
    }
    throw new Error(attempts.at(-1)?.error || "model_compaction_failed");
  }

  function modelCompressionConfigured(context: ContextCompactionStrategyContext) : boolean {
    if (asObject(context.profile.modelCompression).enabled !== true) return false;
    return typeof modelCompressor === "function";
  }

  function requireDeterministicFallback(context: ContextCompactionStrategyContext, reason: string) : void {
    if (asObject(context.profile.modelCompression).fallback !== "deterministic-extractive") {
      throw new Error(reason);
    }
  }

  async function runDeterministicStrategy(context: Record<string, unknown>) : Promise<NormalizedStrategyOutput> {
    const ctx = context as ContextCompactionStrategyContext;
    return normalizeStrategyOutput(
      {
        executionMode: "deterministic-extractive",
        summaryResult: buildDeterministicSummary({
          messages: ctx.compactedMessages,
          runtimeState: ctx.runtimeState,
          targetTokens: ctx.targetTokens,
          compactedRange: ctx.compactedRange
        })
      },
      context,
      "deterministic-extractive"
    );
  }

  async function runModelAssistedStrategy(context: Record<string, unknown>) : Promise<NormalizedStrategyOutput> {
    const ctx = context as ContextCompactionStrategyContext;
    const degradedReasons: string[] = [];
    const modelEvents: Record<string, unknown>[] = [];
    if (ctx.circuitOpen) {
      requireDeterministicFallback(ctx, "model_circuit_breaker_open");
      degradedReasons.push("model_circuit_breaker_open");
      return {
        ...(await runDeterministicStrategy(context)),
        degradedReasons,
        modelEvents
      };
    }

    const modelAllowed: boolean = modelCompressionConfigured(ctx);
    if (!modelAllowed) {
      requireDeterministicFallback(ctx, "model_compaction_not_configured");
      return runDeterministicStrategy(context);
    }

    try {
      const modelSummary: ModelAssistedSummaryResult = await modelAssistedSummary({
        profile: ctx.profile,
        policy: ctx.policy,
        messages: ctx.compactedMessages,
        runtimeState: ctx.runtimeState,
        targetTokens: ctx.targetTokens,
        compactedRange: ctx.compactedRange
      });
      modelEvents.push({
        used: true,
        degraded: false,
        attempts: modelSummary.attempts
      });
      await resetFailures();
      return normalizeStrategyOutput(
        {
          executionMode: "model-assisted",
          summaryResult: modelSummary,
          modelEvents
        },
        context,
        "model-assisted"
      );
    } catch (error: unknown) {
      const nextState: Record<string, unknown> = asObject(await registerFailure(ctx.policy));
      requireDeterministicFallback(
        ctx,
        error instanceof Error ? error.message : "model_compaction_failed"
      );
      degradedReasons.push(error instanceof Error ? error.message : "model_compaction_failed");
      modelEvents.push({
        used: false,
        degraded: true,
        error: error instanceof Error ? error.message : "model_compaction_failed",
        modelFailureCount: nextState.modelFailureCount
      });
      return {
        ...(await runDeterministicStrategy(context)),
        degradedReasons,
        modelEvents
      };
    }
  }

  async function runWorkbenchReconstructionStrategy(context: Record<string, unknown>) : Promise<NormalizedStrategyOutput> {
    const ctx = context as ContextCompactionStrategyContext;
    const prepared = prepareWorkbenchMessages(ctx.compactedMessages, ctx.policy);
    const preprocessingEvents: Record<string, unknown>[] = [{
      type: "payload_dehydration",
      strippedBlockCount: prepared.strippedBlockCount,
      dehydratedAttachmentCount: prepared.dehydratedAttachmentCount,
      originalTokens: prepared.originalTokens,
      preparedTokens: prepared.preparedTokens,
      savedTokens: prepared.savedTokens
    }];
    const preparedContext: Record<string, unknown> = {
      ...context,
      compactedMessages: prepared.messages
    };
    const degradedReasons: string[] = [];
    const modelEvents: Record<string, unknown>[] = [];
    if (ctx.circuitOpen) {
      requireDeterministicFallback(ctx, "model_circuit_breaker_open");
      degradedReasons.push("model_circuit_breaker_open");
      return {
        ...(await normalizeStrategyOutput(
          {
            executionMode: "workbench-deterministic",
            summaryResult: buildDeterministicSummary({
              messages: prepared.messages,
              runtimeState: ctx.runtimeState,
              targetTokens: ctx.targetTokens,
              compactedRange: ctx.compactedRange
            }),
            preprocessingEvents
          },
          preparedContext,
          "workbench-deterministic"
        )),
        degradedReasons,
        modelEvents,
        preprocessingEvents
      };
    }

    const modelAllowed: boolean = modelCompressionConfigured(ctx);
    if (!modelAllowed) {
      requireDeterministicFallback(ctx, "model_compaction_not_configured");
      return normalizeStrategyOutput(
        {
          executionMode: "workbench-deterministic",
          summaryResult: buildDeterministicSummary({
            messages: prepared.messages,
            runtimeState: ctx.runtimeState,
            targetTokens: ctx.targetTokens,
            compactedRange: ctx.compactedRange
          }),
          degradedReasons: ["model_compaction_not_configured"],
          preprocessingEvents
        },
        preparedContext,
        "workbench-deterministic"
      );
    }

    try {
      const modelSummary: ModelAssistedSummaryResult = await modelAssistedSummary({
        profile: ctx.profile,
        policy: ctx.policy,
        messages: prepared.messages,
        runtimeState: ctx.runtimeState,
        targetTokens: ctx.targetTokens,
        compactedRange: ctx.compactedRange,
        inputForAttempt: (messages: NormalizedMessage[], attempt: number, policy: CompactionPolicy, selectionIndex: ApiRoundSelectionIndex) : NormalizedMessage[] | WorkbenchInputResult =>
          workbenchInputForAttempt(
            messages,
            attempt,
            Number(policy.modelMaxInputTokens || 0),
            Number(policy.ptlHeadTrimRatio || 0),
            selectionIndex
          )
      });
      modelEvents.push({
        used: true,
        degraded: false,
        promptCacheCompatible: true,
        attempts: modelSummary.attempts
      });
      await resetFailures();
      return normalizeStrategyOutput(
        {
          executionMode: "workbench-reconstruction",
          summaryResult: modelSummary,
          modelEvents,
          preprocessingEvents
        },
        preparedContext,
        "workbench-reconstruction"
      );
    } catch (error: unknown) {
      const nextState: Record<string, unknown> = asObject(await registerFailure(ctx.policy));
      requireDeterministicFallback(
        ctx,
        error instanceof Error ? error.message : "model_compaction_failed"
      );
      degradedReasons.push(error instanceof Error ? error.message : "model_compaction_failed");
      modelEvents.push({
        used: false,
        degraded: true,
        error: error instanceof Error ? error.message : "model_compaction_failed",
        modelFailureCount: nextState.modelFailureCount
      });
      return normalizeStrategyOutput(
        {
          executionMode: "workbench-deterministic",
          summaryResult: buildDeterministicSummary({
            messages: prepared.messages,
            runtimeState: ctx.runtimeState,
            targetTokens: ctx.targetTokens,
            compactedRange: ctx.compactedRange
          }),
          degradedReasons,
          modelEvents,
          preprocessingEvents
        },
        preparedContext,
        "workbench-deterministic"
      );
    }
  }

  async function runSessionMemoryFirstStrategy(context: Record<string, unknown>) : Promise<NormalizedStrategyOutput> {
    const ctx = context as ContextCompactionStrategyContext;
    const memoryEvents: Record<string, unknown>[] = [];
    if (ctx.sessionId && asObject(ctx.input).useSessionMemory !== false) {
      const memory: unknown = await latestMemory({
        sessionId: ctx.sessionId,
        profileId: ctx.profile.profileId || "",
        sourceHash: ctx.sourceHash
      });
      const memoryRecord: Record<string, unknown> = asObject(memory);
      if (memoryRecord.summary) {
        memoryEvents.push({ used: true, memoryId: memoryRecord.memoryId, sourceHash: ctx.sourceHash });
        return normalizeStrategyOutput(
          {
            executionMode: "session-memory",
            summaryResult: {
              summary: memoryRecord.summary,
              structured: memoryRecord.structured || {},
              memoryId: memoryRecord.memoryId
            },
            memoryEvents
          },
          context,
          "session-memory"
        );
      }

      const latestMemoryResult: unknown = await latestMemory({
        sessionId: ctx.sessionId,
        profileId: ctx.profile.profileId || ""
      });
      const latestRecord: Record<string, unknown> = asObject(latestMemoryResult);
      if (latestRecord.summary) {
        memoryEvents.push({
          used: false,
          memoryId: latestRecord.memoryId,
          reason: latestRecord.sourceHash ? "source_hash_mismatch" : "source_hash_missing",
          expectedSourceHash: ctx.sourceHash,
          actualSourceHash: latestRecord.sourceHash || ""
        });
      }
    }

    const fallback: NormalizedStrategyOutput = await runModelAssistedStrategy(context);
    return {
      ...fallback,
      memoryEvents: [
        ...memoryEvents,
        ...asArray(fallback.memoryEvents)
      ]
    };
  }

  const strategyAdapters: Map<string, ContextCompactionStrategyAdapter> = new Map<string, ContextCompactionStrategyAdapter>([
    ["deterministic-extractive", {
      adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      id: "deterministic-extractive",
      label: "Deterministic extractive context summary",
      run: runDeterministicStrategy
    }],
    ["workbench-reconstruction", {
      adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      id: "workbench-reconstruction",
      label: "Model-assisted compaction with payload dehydration and workbench state reinjection",
      run: runWorkbenchReconstructionStrategy
    }],
    ["model-assisted", {
      adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      id: "model-assisted",
      label: "Model-assisted summary with deterministic local summary",
      run: runModelAssistedStrategy
    }],
    ["session-memory-first", {
      adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      id: "session-memory-first",
      label: "Session memory first with model-assisted fallback",
      run: runSessionMemoryFirstStrategy
    }]
  ]);

  for (const adapter of [...asArray(strategies), ...asArray(compactionStrategies)]) {
    const source: Record<string, unknown> = asObject(adapter);
    const normalized: ContextCompactionStrategyAdapter = source.adapterProtocolVersion === CONTEXT_COMPACTION_PROTOCOL_VERSION
      ? source as unknown as ContextCompactionStrategyAdapter
      : createContextCompactionStrategyAdapter(source);
    strategyAdapters.set(normalizeStrategyId(normalized.id), normalized);
  }

  return strategyAdapters;
}
