import { BUILTIN_COMPACTION_STRATEGIES, CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
import type { CompactionStrategyDescriptor } from "./constants.ts";
import {
  asArray,
  asObject,
  estimateContextTokens,
  normalizeStrategyId,
  redactCompactionValue,
  redactText
} from "./validation.ts";
import type { CompactionPolicy } from "./validation.ts";
import { compactToBudget } from "./projection.ts";

export interface StrategyConfigSummary {
  id: string;
  paramKeys: string[];
}

export interface NormalizedStrategySummaryResult {
  [key: string]: unknown;
  summary: string;
  structured: unknown;
}

export interface NormalizedStrategyOutput {
  [key: string]: unknown;
  executionMode: string;
  summaryResult: NormalizedStrategySummaryResult;
  degradedReasons: unknown[];
  modelEvents: unknown[];
  memoryEvents: unknown[];
  preprocessingEvents: unknown[];
  adapter: unknown;
}

export interface StandardStrategyInput {
  protocolVersion: string;
  strategy: {
    id: string;
    params: unknown;
  };
  sessionId: string;
  source: string;
  profileId: string;
  budget: Record<string, unknown>;
  triggerReason: string;
  sourceTokens: number;
  targetTokens: number;
  sourceHash: string;
  compactedRange: Record<string, unknown>;
  runtimeState: unknown;
  messages: unknown[];
  compactedMessages: unknown[];
  keptMessages: unknown[];
  helpers: {
    estimateTokens: (value?: unknown) => number;
    compactToBudget: (text?: unknown, targetTokens?: unknown) => string;
    redactText: (value?: unknown) => string;
    redactValue: (value?: unknown, depth?: number) => unknown;
  };
}

export interface ContextCompactionStrategyAdapter {
  adapterProtocolVersion: string;
  id: string;
  label: string;
  run(context?: Record<string, unknown>): Promise<NormalizedStrategyOutput>;
}

export interface ContextCompactionStrategyAdapterOptions {
  id?: unknown;
  label?: unknown;
  inputAdapter?: ((context: Record<string, unknown>) => unknown) | null;
  run?: unknown;
  outputAdapter?: ((output: unknown, context: Record<string, unknown>, input: unknown) => unknown | Promise<unknown>) | null;
}

export interface ListedCompactionStrategy extends CompactionStrategyDescriptor {
  custom?: boolean;
}

export function publicStrategyConfig(policy: CompactionPolicy | Record<string, unknown> = {}) : StrategyConfigSummary {
  const strategy: Record<string, unknown> = asObject(asObject(policy).strategy);
  const params: Record<string, unknown> = asObject(strategy.params);
  return {
    id: String(strategy.id || "").trim(),
    paramKeys: Object.keys(params).sort()
  };
}

export function normalizeStrategyOutput(raw: unknown = {}, context: Record<string, unknown> = {}, fallbackStrategy = "") : NormalizedStrategyOutput {
  const output: Record<string, unknown> = asObject(raw);
  const summaryResult: Record<string, unknown> = asObject(output.summaryResult);
  const summary: string = String(
    summaryResult.summary ||
      output.summary ||
      output.text ||
      output.content ||
      asObject(output.result).summary ||
      asObject(output.result).text ||
      ""
  ).trim();
  if (!summary) {
    throw new Error("context_compaction_strategy_summary_missing");
  }
  const targetTokens: number = Number(context.targetTokens ?? asObject(context.policy).summaryReserveTokens);
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
    throw new Error("context_profile_config_required:compactionPolicy.summaryReserveTokens");
  }
  return {
    executionMode: String(
      output.executionMode ||
        output.mode ||
        output.strategy ||
        fallbackStrategy ||
        (asObject(context.policy).strategy as Record<string, unknown>)?.id ||
        "custom"
    ),
    summaryResult: {
      ...summaryResult,
      summary: compactToBudget(summary, targetTokens),
      structured: redactCompactionValue(
        summaryResult.structured ||
          output.structured ||
          output.data ||
          asObject(output.result).structured ||
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

export function standardStrategyInput(context: Record<string, unknown> = {}) : StandardStrategyInput {
  const policy: Record<string, unknown> = asObject(context.policy);
  const strategy: Record<string, unknown> = asObject(policy.strategy);
  return {
    protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    strategy: {
      id: String(strategy.id || "").trim(),
      params: redactCompactionValue(asObject(strategy.params))
    },
    sessionId: String(context.sessionId || ""),
    source: String(context.source || ""),
    profileId: String(asObject(context.profile).profileId || ""),
    budget: asObject(context.budget),
    triggerReason: String(context.triggerReason || ""),
    sourceTokens: Number(context.sourceTokens || 0),
    targetTokens: Number(context.targetTokens || 0),
    sourceHash: String(context.sourceHash || ""),
    compactedRange: asObject(context.compactedRange),
    runtimeState: redactCompactionValue(context.runtimeState || {}),
    messages: asArray(context.messages),
    compactedMessages: asArray(context.compactedMessages),
    keptMessages: asArray(context.keptOriginal),
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
}: ContextCompactionStrategyAdapterOptions = {}) : ContextCompactionStrategyAdapter {
  const rawId: string = String(id || "").trim();
  if (!rawId) {
    throw new Error("context_compaction_strategy_id_required");
  }
  const normalizedId: string = normalizeStrategyId(rawId);
  const runStrategy = typeof run === "function"
    ? run as (input: unknown, context: Record<string, unknown>) => unknown | Promise<unknown>
    : null;
  if (!runStrategy) {
    throw new Error(`context_compaction_strategy_run_required:${normalizedId}`);
  }
  return Object.freeze({
    adapterProtocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    id: normalizedId,
    label: String(label || normalizedId),
    async run(context: Record<string, unknown> = {}) : Promise<NormalizedStrategyOutput> {
      const strategyInput: unknown = typeof inputAdapter === "function" ? inputAdapter(context) : standardStrategyInput(context);
      const rawOutput: unknown = await runStrategy(strategyInput, context);
      const output: unknown = typeof outputAdapter === "function"
        ? await outputAdapter(rawOutput, context, strategyInput)
        : rawOutput;
      return normalizeStrategyOutput(output, context, normalizedId);
    }
  });
}

export function listContextCompactionStrategies(extraStrategies: unknown = []) : ListedCompactionStrategy[] {
  const custom: ListedCompactionStrategy[] = asArray(extraStrategies)
    .map((item?: unknown) : string => typeof item === "string" ? item : String(asObject(item).id || ""))
    .filter(Boolean)
    .map((id: string) : ListedCompactionStrategy => Object.freeze({
      id: normalizeStrategyId(id),
      label: String(id),
      custom: true
    }));
  const byId: Map<string, ListedCompactionStrategy> = new Map<string, ListedCompactionStrategy>();
  for (const strategy of [...BUILTIN_COMPACTION_STRATEGIES, ...custom]) {
    byId.set(strategy.id, strategy);
  }
  return [...byId.values()];
}
