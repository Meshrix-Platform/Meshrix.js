import {
  computeCompactionBudget,
  normalizeCompactionPolicy,
} from "../context-compact/index.ts";
import {
  asArray,
  asObject,
  normalizeStringArray,
  normalizeText,
} from "./validation.ts";
import type { ContextProfile, RuntimeRecord } from "./types.ts";

function optionalNumber(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`context_profile_config_invalid:${field}`);
  }
  return number;
}

function optionalRatio(value: unknown, field: string): number | null {
  return optionalNumber(value, 0, 1, field);
}

function optionalBoolean(value?: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

export function sortContextProfiles<
  T extends { contextWindowTokens: unknown; profileId: unknown },
>(profiles: readonly T[] = []): T[] {
  return [...profiles].sort((left, right) => {
    const leftTokens = Number(left.contextWindowTokens);
    const rightTokens = Number(right.contextWindowTokens);
    const tokenCompare =
      (Number.isFinite(leftTokens) ? leftTokens : 0) -
      (Number.isFinite(rightTokens) ? rightTokens : 0);
    if (tokenCompare !== 0) return tokenCompare;
    return String(left.profileId || "").localeCompare(
      String(right.profileId || ""),
    );
  });
}

export function normalizeProfile(profile: unknown = {}) {
  const source = asObject(profile);
  const budgetPolicy = asObject(source.budgetPolicy);
  const rankingWeights = asObject(source.rankingWeights);
  const placementPolicy = asObject(source.placementPolicy);
  const modelCompression = asObject(source.modelCompression);
  const compression = asObject(source.compression);

  return {
    profileId: normalizeText(source.profileId),
    label: normalizeText(source.label),
    modelAlias: normalizeText(source.modelAlias),
    contextWindowTokens: optionalNumber(
      source.contextWindowTokens,
      4096,
      2_000_000,
      "contextWindowTokens",
    ),
    outputReserveTokens: optionalNumber(
      source.outputReserveTokens,
      0,
      200_000,
      "outputReserveTokens",
    ),
    toolReserveTokens: optionalNumber(
      source.toolReserveTokens,
      0,
      200_000,
      "toolReserveTokens",
    ),
    fixedMemoryBudget: optionalNumber(
      source.fixedMemoryBudget,
      0,
      100_000,
      "fixedMemoryBudget",
    ),
    referenceBudget: optionalNumber(
      source.referenceBudget,
      0,
      1_000_000,
      "referenceBudget",
    ),
    historyBudget: optionalNumber(
      source.historyBudget,
      0,
      1_000_000,
      "historyBudget",
    ),
    recentTurnBudget: optionalNumber(
      source.recentTurnBudget,
      0,
      1_000_000,
      "recentTurnBudget",
    ),
    budgetPolicy: {
      fixedMemoryRatio: optionalRatio(
        budgetPolicy.fixedMemoryRatio,
        "budgetPolicy.fixedMemoryRatio",
      ),
      operatorGuidanceRatio: optionalRatio(
        budgetPolicy.operatorGuidanceRatio,
        "budgetPolicy.operatorGuidanceRatio",
      ),
      referenceRatio: optionalRatio(
        budgetPolicy.referenceRatio,
        "budgetPolicy.referenceRatio",
      ),
      historyRatio: optionalRatio(
        budgetPolicy.historyRatio,
        "budgetPolicy.historyRatio",
      ),
      recentTurnRatio: optionalRatio(
        budgetPolicy.recentTurnRatio,
        "budgetPolicy.recentTurnRatio",
      ),
      toolStateRatio: optionalRatio(
        budgetPolicy.toolStateRatio,
        "budgetPolicy.toolStateRatio",
      ),
    },
    rankingWeights: {
      queryRelevance: optionalRatio(
        rankingWeights.queryRelevance,
        "rankingWeights.queryRelevance",
      ),
      recency: optionalRatio(rankingWeights.recency, "rankingWeights.recency"),
      evidenceConfidence: optionalRatio(
        rankingWeights.evidenceConfidence,
        "rankingWeights.evidenceConfidence",
      ),
      humanExpertBoost: optionalRatio(
        rankingWeights.humanExpertBoost,
        "rankingWeights.humanExpertBoost",
      ),
      toolFreshness: optionalRatio(
        rankingWeights.toolFreshness,
        "rankingWeights.toolFreshness",
      ),
      hierarchyLevel: optionalRatio(
        rankingWeights.hierarchyLevel,
        "rankingWeights.hierarchyLevel",
      ),
    },
    protectedEvidenceFields: normalizeStringArray(
      source.protectedEvidenceFields,
    ),
    placementPolicy: {
      criticalEvidenceHeadCount: optionalNumber(
        placementPolicy.criticalEvidenceHeadCount,
        0,
        50,
        "placementPolicy.criticalEvidenceHeadCount",
      ),
      evidenceTailChecklist: optionalBoolean(
        placementPolicy.evidenceTailChecklist,
      ),
      repeatTaskInTail: optionalBoolean(placementPolicy.repeatTaskInTail),
    },
    modelCompression: {
      enabled: optionalBoolean(modelCompression.enabled),
      alias: normalizeText(modelCompression.alias),
      maxInputTokens: optionalNumber(
        modelCompression.maxInputTokens,
        0,
        2_000_000,
        "modelCompression.maxInputTokens",
      ),
      maxOutputTokens: optionalNumber(
        modelCompression.maxOutputTokens,
        0,
        200_000,
        "modelCompression.maxOutputTokens",
      ),
      fallback: normalizeText(modelCompression.fallback),
    },
    compactionPolicy: normalizeCompactionPolicy(
      source,
      asObject(source.compactionPolicy),
    ),
    compression: {
      enabled: optionalBoolean(compression.enabled),
      mode: normalizeText(compression.mode),
      threshold: optionalRatio(compression.threshold, "compression.threshold"),
      targetRatio: optionalRatio(
        compression.targetRatio,
        "compression.targetRatio",
      ),
      protectLastNTurns: optionalNumber(
        compression.protectLastNTurns,
        0,
        200,
        "compression.protectLastNTurns",
      ),
      summaryMaxTokens: optionalNumber(
        compression.summaryMaxTokens,
        0,
        200_000,
        "compression.summaryMaxTokens",
      ),
      strategy: normalizeText(compression.strategy),
    },
  };
}

function requireConfiguredNumber(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const number = Number(value);
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    !Number.isFinite(number) ||
    number < min ||
    number > max
  ) {
    throw new Error(`context_profile_config_required:${field}`);
  }
  return number;
}

function requireConfiguredBoolean(
  value: unknown,
  field: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`context_profile_config_required:${field}`);
  }
}

export function assertContextProfileComplete(
  profile: RuntimeRecord = {},
): ContextProfile {
  if (!profile.profileId) {
    throw new Error("context_profile_config_required:profileId");
  }
  for (const [field, min, max] of [
    ["contextWindowTokens", 4096, 2_000_000],
    ["outputReserveTokens", 0, 200_000],
    ["toolReserveTokens", 0, 200_000],
    ["fixedMemoryBudget", 0, 100_000],
    ["referenceBudget", 0, 1_000_000],
    ["historyBudget", 0, 1_000_000],
    ["recentTurnBudget", 0, 1_000_000],
  ] as const) {
    requireConfiguredNumber(profile[field], field, min, max);
  }
  const budgetPolicy = asObject(profile.budgetPolicy);
  for (const field of [
    "fixedMemoryRatio",
    "operatorGuidanceRatio",
    "referenceRatio",
    "historyRatio",
    "recentTurnRatio",
    "toolStateRatio",
  ] as const) {
    requireConfiguredNumber(budgetPolicy[field], `budgetPolicy.${field}`, 0, 1);
  }
  const rankingWeights = asObject(profile.rankingWeights);
  for (const field of [
    "queryRelevance",
    "recency",
    "evidenceConfidence",
    "humanExpertBoost",
    "toolFreshness",
    "hierarchyLevel",
  ] as const) {
    requireConfiguredNumber(
      rankingWeights[field],
      `rankingWeights.${field}`,
      0,
      1,
    );
  }
  const placementPolicy = asObject(profile.placementPolicy);
  requireConfiguredNumber(
    placementPolicy.criticalEvidenceHeadCount,
    "placementPolicy.criticalEvidenceHeadCount",
    0,
    50,
  );
  requireConfiguredBoolean(
    placementPolicy.evidenceTailChecklist,
    "placementPolicy.evidenceTailChecklist",
  );
  requireConfiguredBoolean(
    placementPolicy.repeatTaskInTail,
    "placementPolicy.repeatTaskInTail",
  );
  const modelCompression = asObject(profile.modelCompression);
  const compression = asObject(profile.compression);
  const compactionPolicy = asObject(profile.compactionPolicy);
  requireConfiguredBoolean(
    modelCompression.enabled,
    "modelCompression.enabled",
  );
  requireConfiguredBoolean(compression.enabled, "compression.enabled");
  for (const [field, min, max] of [
    ["threshold", 0, 1],
    ["targetRatio", 0, 1],
    ["protectLastNTurns", 0, 200],
    ["summaryMaxTokens", 1, 200_000],
  ] as const) {
    requireConfiguredNumber(
      compression[field],
      `compression.${field}`,
      min,
      max,
    );
  }
  if (compression.strategy !== "deterministic-extractive") {
    throw new Error("context_profile_config_invalid:compression.strategy");
  }
  if (modelCompression.enabled === true) {
    if (!modelCompression.alias) {
      throw new Error("context_profile_config_required:modelCompression.alias");
    }
    requireConfiguredNumber(
      modelCompression.maxInputTokens,
      "modelCompression.maxInputTokens",
      1,
      2_000_000,
    );
    requireConfiguredNumber(
      modelCompression.maxOutputTokens,
      "modelCompression.maxOutputTokens",
      1,
      200_000,
    );
    requireConfiguredNumber(
      compactionPolicy.modelMaxInputTokens,
      "compactionPolicy.modelMaxInputTokens",
      1,
      2_000_000,
    );
    requireConfiguredNumber(
      compactionPolicy.modelMaxOutputTokens,
      "compactionPolicy.modelMaxOutputTokens",
      1,
      200_000,
    );
    if (!modelCompression.fallback) {
      throw new Error(
        "context_profile_config_required:modelCompression.fallback",
      );
    }
    if (
      ![
        "model-assisted",
        "workbench-reconstruction",
        "session-memory-first",
      ].includes(String(compression.mode || ""))
    ) {
      throw new Error("context_profile_config_required:compression.mode");
    }
  }
  computeCompactionBudget(profile);
  return profile as ContextProfile;
}

export function normalizeProfiles(profiles?: unknown): ContextProfile[] {
  const byId = new Map<string, ContextProfile>();
  for (const value of asArray(profiles)) {
    const profile = assertContextProfileComplete(normalizeProfile(value));
    if (byId.has(profile.profileId)) {
      throw new Error(`context_profile_config_duplicate:${profile.profileId}`);
    }
    byId.set(profile.profileId, profile);
  }
  return sortContextProfiles([...byId.values()]);
}
