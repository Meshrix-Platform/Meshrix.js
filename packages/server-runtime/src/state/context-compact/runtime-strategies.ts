import { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
import { asArray, asObject, estimateContextTokens, normalizeStrategyId, redactCompactionValue } from "./validation.ts";
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
import { createContextCompactionStrategyAdapter, normalizeStrategyOutput } from "./strategies.ts";

export function createBuiltinStrategyAdapters({
  strategies = [],
  compactionStrategies = [],
  modelCompressor = null,
  agentGatewayCall = null,
  latestSessionMemory,
  resetFailureState,
  registerModelFailure
}: Record<string, any> = {}) : any {
  async function modelAssistedSummary({
    profile,
    policy,
    messages,
    runtimeState,
    targetTokens,
    compactedRange,
    inputForAttempt = null
  }: Record<string, any>) : Promise<any> {
    const attempts: any[] = [];
    const selectionIndex: any = createApiRoundSelectionIndex(messages);
    const compressionAlias: any = String(profile.modelCompression?.alias || "").trim();
    const maxAttempts: any = Math.max(1, policy.ptlRetryLimit + 1);
    for (let attempt: any = 0; attempt < maxAttempts; attempt += 1) {
      const selected: any = typeof inputForAttempt === "function"
        ? inputForAttempt(messages, attempt, policy, selectionIndex)
        : modelInputForAttempt(messages, attempt, policy.modelMaxInputTokens, selectionIndex);
      const attemptMessages: any = Array.isArray(selected) ? selected : asArray(selected.messages);
      const prompt: any = buildModelPrompt({
        messages: attemptMessages,
        runtimeState,
        targetTokens,
        compactedRange
      });
      attempts.push({
        attempt,
        messageCount: attemptMessages.length,
        promptTokens: estimateContextTokens(prompt),
        ...asObject(selected.metadata)
      });
      try {
        const response: any = typeof modelCompressor === "function"
          ? await modelCompressor({
              profile,
              policy,
              messages: attemptMessages,
              runtimeState,
              targetTokens,
              prompt
          })
          : await agentGatewayCall?.({
              alias: compressionAlias,
              modelAlias: compressionAlias,
              question: prompt,
              parameters: {
                temperature: 0,
                max_tokens: Math.min(policy.modelMaxOutputTokens, targetTokens),
                stream: false,
                tool_choice: "none"
              }
            });
        const parsed: any = parseModelSummary(response);
        return {
          ok: true,
          summary: compactToBudget(parsed.summary, targetTokens),
          structured: redactCompactionValue(parsed.structured),
          attempts
        };
      } catch (error: any) {
        attempts[attempt].error = error instanceof Error ? error.message : "model_compaction_failed";
      }
    }
    throw new Error(attempts.at(-1)?.error || "model_compaction_failed");
  }

  function modelCompressionConfigured(context?: any) : any {
    if (context.profile.modelCompression?.enabled !== true) return false;
    return typeof modelCompressor === "function" || (
      typeof agentGatewayCall === "function" &&
      Boolean(String(context.profile.modelCompression?.alias || "").trim())
    );
  }

  function requireDeterministicFallback(context?: any, reason?: any) : any {
    if (context.profile.modelCompression?.fallback !== "deterministic-extractive") {
      throw new Error(reason);
    }
  }

  async function runDeterministicStrategy(context?: any) : Promise<any> {
    return normalizeStrategyOutput(
      {
        executionMode: "deterministic-extractive",
        summaryResult: buildDeterministicSummary({
          messages: context.compactedMessages,
          runtimeState: context.runtimeState,
          targetTokens: context.targetTokens,
          compactedRange: context.compactedRange
        })
      },
      context,
      "deterministic-extractive"
    );
  }

  async function runModelAssistedStrategy(context?: any) : Promise<any> {
    const degradedReasons: any[] = [];
    const modelEvents: any[] = [];
    if (context.circuitOpen) {
      requireDeterministicFallback(context, "model_circuit_breaker_open");
      degradedReasons.push("model_circuit_breaker_open");
      return {
        ...(await runDeterministicStrategy(context)),
        degradedReasons,
        modelEvents
      };
    }

    const modelAllowed: any =
      modelCompressionConfigured(context);
    if (!modelAllowed) {
      requireDeterministicFallback(context, "model_compaction_not_configured");
      return runDeterministicStrategy(context);
    }

    try {
      const modelSummary: any = await modelAssistedSummary({
        profile: context.profile,
        policy: context.policy,
        messages: context.compactedMessages,
        runtimeState: context.runtimeState,
        targetTokens: context.targetTokens,
        compactedRange: context.compactedRange
      });
      modelEvents.push({
        used: true,
        degraded: false,
        attempts: modelSummary.attempts
      });
      await resetFailureState();
      return normalizeStrategyOutput(
        {
          executionMode: "model-assisted",
          summaryResult: modelSummary,
          modelEvents
        },
        context,
        "model-assisted"
      );
    } catch (error: any) {
      const nextState: any = await registerModelFailure(context.policy);
      requireDeterministicFallback(
        context,
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

  async function runWorkbenchReconstructionStrategy(context?: any) : Promise<any> {
    const prepared: any = prepareWorkbenchMessages(context.compactedMessages, context.policy);
    const preprocessingEvents: any[] = [{
      type: "payload_dehydration",
      strippedBlockCount: prepared.strippedBlockCount,
      dehydratedAttachmentCount: prepared.dehydratedAttachmentCount,
      originalTokens: prepared.originalTokens,
      preparedTokens: prepared.preparedTokens,
      savedTokens: prepared.savedTokens
    }];
    const preparedContext: Record<string, any> = {
      ...context,
      compactedMessages: prepared.messages
    };
    const degradedReasons: any[] = [];
    const modelEvents: any[] = [];
    if (context.circuitOpen) {
      requireDeterministicFallback(context, "model_circuit_breaker_open");
      degradedReasons.push("model_circuit_breaker_open");
      return {
        ...(await normalizeStrategyOutput(
          {
            executionMode: "workbench-deterministic",
            summaryResult: buildDeterministicSummary({
              messages: prepared.messages,
              runtimeState: context.runtimeState,
              targetTokens: context.targetTokens,
              compactedRange: context.compactedRange
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

    const modelAllowed: any =
      modelCompressionConfigured(context);
    if (!modelAllowed) {
      requireDeterministicFallback(context, "model_compaction_not_configured");
      return normalizeStrategyOutput(
        {
          executionMode: "workbench-deterministic",
          summaryResult: buildDeterministicSummary({
            messages: prepared.messages,
            runtimeState: context.runtimeState,
            targetTokens: context.targetTokens,
            compactedRange: context.compactedRange
          }),
          degradedReasons: ["model_compaction_not_configured"],
          preprocessingEvents
        },
        preparedContext,
        "workbench-deterministic"
      );
    }

    try {
      const modelSummary: any = await modelAssistedSummary({
        profile: context.profile,
        policy: context.policy,
        messages: prepared.messages,
        runtimeState: context.runtimeState,
        targetTokens: context.targetTokens,
        compactedRange: context.compactedRange,
        inputForAttempt: (messages?: any, attempt?: any, policy?: any, selectionIndex?: any) : any =>
          workbenchInputForAttempt(
            messages,
            attempt,
            policy.modelMaxInputTokens,
            policy.ptlHeadTrimRatio,
            selectionIndex
          )
      });
      modelEvents.push({
        used: true,
        degraded: false,
        promptCacheCompatible: true,
        attempts: modelSummary.attempts
      });
      await resetFailureState();
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
    } catch (error: any) {
      const nextState: any = await registerModelFailure(context.policy);
      requireDeterministicFallback(
        context,
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
            runtimeState: context.runtimeState,
            targetTokens: context.targetTokens,
            compactedRange: context.compactedRange
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

  async function runSessionMemoryFirstStrategy(context?: any) : Promise<any> {
    const memoryEvents: any[] = [];
    if (context.sessionId && context.input.useSessionMemory !== false) {
      const memory: any = await latestSessionMemory({
        sessionId: context.sessionId,
        profileId: context.profile.profileId || "",
        sourceHash: context.sourceHash
      });
      if (memory?.summary) {
        memoryEvents.push({ used: true, memoryId: memory.memoryId, sourceHash: context.sourceHash });
        return normalizeStrategyOutput(
          {
            executionMode: "session-memory",
            summaryResult: {
              summary: memory.summary,
              structured: memory.structured || {},
              memoryId: memory.memoryId
            },
            memoryEvents
          },
          context,
          "session-memory"
        );
      }

      const latestMemory: any = await latestSessionMemory({
        sessionId: context.sessionId,
        profileId: context.profile.profileId || ""
      });
      if (latestMemory?.summary) {
        memoryEvents.push({
          used: false,
          memoryId: latestMemory.memoryId,
          reason: latestMemory.sourceHash ? "source_hash_mismatch" : "source_hash_missing",
          expectedSourceHash: context.sourceHash,
          actualSourceHash: latestMemory.sourceHash || ""
        });
      }
    }

    const fallback: any = await runModelAssistedStrategy(context);
    return {
      ...fallback,
      memoryEvents: [
        ...memoryEvents,
        ...asArray(fallback.memoryEvents)
      ]
    };
  }

  const strategyAdapters: any = new Map<any, any>([
    ["deterministic-extractive", {
      id: "deterministic-extractive",
      label: "Deterministic extractive context summary",
      run: runDeterministicStrategy
    }],
    ["workbench-reconstruction", {
      id: "workbench-reconstruction",
      label: "Model-assisted compaction with payload dehydration and workbench state reinjection",
      run: runWorkbenchReconstructionStrategy
    }],
    ["model-assisted", {
      id: "model-assisted",
      label: "Model-assisted summary with deterministic local summary",
      run: runModelAssistedStrategy
    }],
    ["session-memory-first", {
      id: "session-memory-first",
      label: "Session memory first with model-assisted fallback",
      run: runSessionMemoryFirstStrategy
    }]
  ]);

  for (const adapter of [...asArray(strategies), ...asArray(compactionStrategies)]) {
    const normalized: any = adapter?.adapterProtocolVersion === CONTEXT_COMPACTION_PROTOCOL_VERSION
      ? adapter
      : createContextCompactionStrategyAdapter(adapter);
    strategyAdapters.set(normalizeStrategyId(normalized.id), normalized);
  }

  return strategyAdapters;
}
