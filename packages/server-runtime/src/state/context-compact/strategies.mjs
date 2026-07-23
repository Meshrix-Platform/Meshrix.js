import { BUILTIN_COMPACTION_STRATEGIES, CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.mjs";
import {
  asArray,
  asObject,
  estimateContextTokens,
  normalizeStrategyId,
  redactCompactionValue,
  redactText
} from "./validation.mjs";
import { compactToBudget } from "./projection.mjs";

export function publicStrategyConfig(policy = {}) {
  const strategy = asObject(policy.strategy);
  const params = asObject(strategy.params);
  return {
    id: String(strategy.id || "").trim(),
    paramKeys: Object.keys(params).sort()
  };
}

export function normalizeStrategyOutput(raw = {}, context = {}, fallbackStrategy = "") {
  const output = asObject(raw);
  const summaryResult = asObject(output.summaryResult);
  const summary = String(
    summaryResult.summary ||
      output.summary ||
      output.text ||
      output.content ||
      output.result?.summary ||
      output.result?.text ||
      ""
  ).trim();
  if (!summary) {
    throw new Error("context_compaction_strategy_summary_missing");
  }
  const targetTokens = Number(context.targetTokens ?? context.policy?.summaryReserveTokens);
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
    throw new Error("context_profile_config_required:compactionPolicy.summaryReserveTokens");
  }
  return {
    executionMode: String(
      output.executionMode ||
        output.mode ||
        output.strategy ||
        fallbackStrategy ||
        context.policy?.strategy?.id ||
        "custom"
    ),
    summaryResult: {
      ...summaryResult,
      summary: compactToBudget(summary, targetTokens),
      structured: redactCompactionValue(
        summaryResult.structured ||
          output.structured ||
          output.data ||
          output.result?.structured ||
          {}
      )
    },
    degradedReasons: asArray(output.degradedReasons),
    modelEvents: asArray(output.modelEvents),
    memoryEvents: asArray(output.memoryEvents),
    preprocessingEvents: asArray(output.preprocessingEvents),
    adapter: output.adapter || null
  };
}

export function standardStrategyInput(context = {}) {
  const policy = asObject(context.policy);
  const strategy = asObject(policy.strategy);
  return {
    protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    strategy: {
      id: String(strategy.id || "").trim(),
      params: redactCompactionValue(asObject(strategy.params))
    },
    sessionId: context.sessionId || "",
    source: context.source || "",
    profileId: context.profile?.profileId || "",
    budget: context.budget || {},
    triggerReason: context.triggerReason || "",
    sourceTokens: context.sourceTokens || 0,
    targetTokens: context.targetTokens || 0,
    sourceHash: context.sourceHash || "",
    compactedRange: context.compactedRange || {},
    runtimeState: redactCompactionValue(context.runtimeState || {}),
    messages: context.messages || [],
    compactedMessages: context.compactedMessages || [],
    keptMessages: context.keptOriginal || [],
    helpers: Object.freeze({
      estimateTokens: estimateContextTokens,
      compactToBudget,
      redactText,
      redactValue: redactCompactionValue
    })
  };
}

export function createContextCompactionStrategyAdapter({
  id,
  label = "",
  inputAdapter = null,
  run,
  outputAdapter = null
} = {}) {
  const rawId = String(id || "").trim();
  if (!rawId) {
    throw new Error("context_compaction_strategy_id_required");
  }
  const normalizedId = normalizeStrategyId(rawId);
  if (typeof run !== "function") {
    throw new Error(`context_compaction_strategy_run_required:${normalizedId}`);
  }
  return Object.freeze({
    adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    id: normalizedId,
    label: String(label || normalizedId),
    async run(context = {}) {
      const strategyInput = typeof inputAdapter === "function" ? inputAdapter(context) : standardStrategyInput(context);
      const rawOutput = await run(strategyInput, context);
      const output = typeof outputAdapter === "function"
        ? await outputAdapter(rawOutput, context, strategyInput)
        : rawOutput;
      return normalizeStrategyOutput(output, context, normalizedId);
    }
  });
}

export function listContextCompactionStrategies(extraStrategies = []) {
  const custom = asArray(extraStrategies)
    .map((item) => typeof item === "string" ? item : item?.id)
    .filter(Boolean)
    .map((id) => Object.freeze({
      id: normalizeStrategyId(id),
      label: String(id),
      custom: true
    }));
  const byId = new Map();
  for (const strategy of [...BUILTIN_COMPACTION_STRATEGIES, ...custom]) {
    byId.set(strategy.id, strategy);
  }
  return [...byId.values()];
}
