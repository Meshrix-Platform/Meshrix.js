import { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.mjs";
import { asArray, asObject, estimateContextTokens, normalizeStrategyId, redactCompactionValue } from "./validation.mjs";
import {
  buildDeterministicSummary,
  buildModelPrompt,
  compactToBudget,
  modelInputForAttempt,
  parseModelSummary,
  prepareWorkbenchMessages,
  workbenchInputForAttempt
} from "./projection.mjs";
import { createContextCompactionStrategyAdapter, normalizeStrategyOutput } from "./strategies.mjs";

export function createBuiltinStrategyAdapters({
  strategies = [],
  compactionStrategies = [],
  modelCompressor = null,
  agentGatewayCall = null,
  latestSessionMemory,
  resetFailureState,
  registerModelFailure
} = {}) {
  async function modelAssistedSummary({
    profile,
    policy,
    messages,
    runtimeState,
    targetTokens,
    compactedRange,
    inputForAttempt = null
  }) {
    const attempts = [];
    const compressionAlias = String(profile.modelCompression?.alias || "").trim();
    const maxAttempts = Math.max(1, policy.ptlRetryLimit + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = typeof inputForAttempt === "function"
        ? inputForAttempt(messages, attempt, policy)
        : modelInputForAttempt(messages, attempt, policy.modelMaxInputTokens);
      const attemptMessages = Array.isArray(selected) ? selected : asArray(selected.messages);
      const prompt = buildModelPrompt({
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
        const response = typeof modelCompressor === "function"
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
        const parsed = parseModelSummary(response);
        return {
          ok: true,
          summary: compactToBudget(parsed.summary, targetTokens),
          structured: redactCompactionValue(parsed.structured),
          attempts
        };
      } catch (error) {
        attempts[attempt].error = error instanceof Error ? error.message : "model_compaction_failed";
      }
    }
    throw new Error(attempts.at(-1)?.error || "model_compaction_failed");
  }

  function modelCompressionConfigured(context) {
    if (context.profile.modelCompression?.enabled !== true) return false;
    return typeof modelCompressor === "function" || (
      typeof agentGatewayCall === "function" &&
      Boolean(String(context.profile.modelCompression?.alias || "").trim())
    );
  }

  function requireDeterministicFallback(context, reason) {
    if (context.profile.modelCompression?.fallback !== "deterministic-extractive") {
      throw new Error(reason);
    }
  }

  async function runDeterministicStrategy(context) {
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

  async function runModelAssistedStrategy(context) {
    const degradedReasons = [];
    const modelEvents = [];
    if (context.circuitOpen) {
      requireDeterministicFallback(context, "model_circuit_breaker_open");
      degradedReasons.push("model_circuit_breaker_open");
      return {
        ...(await runDeterministicStrategy(context)),
        degradedReasons,
        modelEvents
      };
    }

    const modelAllowed =
      modelCompressionConfigured(context);
    if (!modelAllowed) {
      requireDeterministicFallback(context, "model_compaction_not_configured");
      return runDeterministicStrategy(context);
    }

    try {
      const modelSummary = await modelAssistedSummary({
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
    } catch (error) {
      const nextState = await registerModelFailure(context.policy);
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

  async function runWorkbenchReconstructionStrategy(context) {
    const prepared = prepareWorkbenchMessages(context.compactedMessages, context.policy);
    const preprocessingEvents = [{
      type: "payload_dehydration",
      strippedBlockCount: prepared.strippedBlockCount,
      dehydratedAttachmentCount: prepared.dehydratedAttachmentCount,
      originalTokens: prepared.originalTokens,
      preparedTokens: prepared.preparedTokens,
      savedTokens: prepared.savedTokens
    }];
    const preparedContext = {
      ...context,
      compactedMessages: prepared.messages
    };
    const degradedReasons = [];
    const modelEvents = [];
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

    const modelAllowed =
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
      const modelSummary = await modelAssistedSummary({
        profile: context.profile,
        policy: context.policy,
        messages: prepared.messages,
        runtimeState: context.runtimeState,
        targetTokens: context.targetTokens,
        compactedRange: context.compactedRange,
        inputForAttempt: (messages, attempt, policy) =>
          workbenchInputForAttempt(messages, attempt, policy.modelMaxInputTokens, policy.ptlHeadTrimRatio)
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
    } catch (error) {
      const nextState = await registerModelFailure(context.policy);
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

  async function runSessionMemoryFirstStrategy(context) {
    const memoryEvents = [];
    if (context.sessionId && context.input.useSessionMemory !== false) {
      const memory = await latestSessionMemory({
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

      const latestMemory = await latestSessionMemory({
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

    const fallback = await runModelAssistedStrategy(context);
    return {
      ...fallback,
      memoryEvents: [
        ...memoryEvents,
        ...asArray(fallback.memoryEvents)
      ]
    };
  }

  const strategyAdapters = new Map([
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
    const normalized = adapter?.adapterProtocolVersion === CONTEXT_COMPACTION_PROTOCOL_VERSION
      ? adapter
      : createContextCompactionStrategyAdapter(adapter);
    strategyAdapters.set(normalizeStrategyId(normalized.id), normalized);
  }

  return strategyAdapters;
}
