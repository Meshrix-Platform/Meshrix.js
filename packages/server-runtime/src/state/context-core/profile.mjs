import { computeCompactionBudget, normalizeCompactionPolicy } from "../context-compact/index.mjs";
import { asArray, asObject, normalizeStringArray, normalizeText } from "./validation.mjs";

function optionalNumber(value, min, max, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`context_profile_config_invalid:${field}`);
  }
  return number;
}

function optionalRatio(value, field) {
  return optionalNumber(value, 0, 1, field);
}

function optionalBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

export function sortContextProfiles(profiles = []) {
  return [...profiles].sort((left, right) => {
    const leftTokens = Number(left.contextWindowTokens);
    const rightTokens = Number(right.contextWindowTokens);
    const tokenCompare = (Number.isFinite(leftTokens) ? leftTokens : 0) -
      (Number.isFinite(rightTokens) ? rightTokens : 0);
    if (tokenCompare !== 0) return tokenCompare;
    return String(left.profileId || "").localeCompare(String(right.profileId || ""));
  });
}

export function normalizeProfile(profile = {}) {
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
    contextWindowTokens: optionalNumber(source.contextWindowTokens, 4096, 2_000_000, "contextWindowTokens"),
    outputReserveTokens: optionalNumber(source.outputReserveTokens, 0, 200_000, "outputReserveTokens"),
    toolReserveTokens: optionalNumber(source.toolReserveTokens, 0, 200_000, "toolReserveTokens"),
    fixedMemoryBudget: optionalNumber(source.fixedMemoryBudget, 0, 100_000, "fixedMemoryBudget"),
    referenceBudget: optionalNumber(source.referenceBudget, 0, 1_000_000, "referenceBudget"),
    historyBudget: optionalNumber(source.historyBudget, 0, 1_000_000, "historyBudget"),
    recentTurnBudget: optionalNumber(source.recentTurnBudget, 0, 1_000_000, "recentTurnBudget"),
    budgetPolicy: {
      fixedMemoryRatio: optionalRatio(budgetPolicy.fixedMemoryRatio, "budgetPolicy.fixedMemoryRatio"),
      operatorGuidanceRatio: optionalRatio(budgetPolicy.operatorGuidanceRatio, "budgetPolicy.operatorGuidanceRatio"),
      referenceRatio: optionalRatio(budgetPolicy.referenceRatio, "budgetPolicy.referenceRatio"),
      historyRatio: optionalRatio(budgetPolicy.historyRatio, "budgetPolicy.historyRatio"),
      recentTurnRatio: optionalRatio(budgetPolicy.recentTurnRatio, "budgetPolicy.recentTurnRatio"),
      toolStateRatio: optionalRatio(budgetPolicy.toolStateRatio, "budgetPolicy.toolStateRatio")
    },
    rankingWeights: {
      queryRelevance: optionalRatio(rankingWeights.queryRelevance, "rankingWeights.queryRelevance"),
      recency: optionalRatio(rankingWeights.recency, "rankingWeights.recency"),
      evidenceConfidence: optionalRatio(rankingWeights.evidenceConfidence, "rankingWeights.evidenceConfidence"),
      humanExpertBoost: optionalRatio(rankingWeights.humanExpertBoost, "rankingWeights.humanExpertBoost"),
      toolFreshness: optionalRatio(rankingWeights.toolFreshness, "rankingWeights.toolFreshness"),
      hierarchyLevel: optionalRatio(rankingWeights.hierarchyLevel, "rankingWeights.hierarchyLevel")
    },
    protectedEvidenceFields: normalizeStringArray(source.protectedEvidenceFields),
    placementPolicy: {
      criticalEvidenceHeadCount: optionalNumber(placementPolicy.criticalEvidenceHeadCount, 0, 50, "placementPolicy.criticalEvidenceHeadCount"),
      evidenceTailChecklist: optionalBoolean(placementPolicy.evidenceTailChecklist),
      repeatTaskInTail: optionalBoolean(placementPolicy.repeatTaskInTail)
    },
    modelCompression: {
      enabled: optionalBoolean(modelCompression.enabled),
      alias: normalizeText(modelCompression.alias),
      maxInputTokens: optionalNumber(modelCompression.maxInputTokens, 0, 2_000_000, "modelCompression.maxInputTokens"),
      maxOutputTokens: optionalNumber(modelCompression.maxOutputTokens, 0, 200_000, "modelCompression.maxOutputTokens"),
      fallback: normalizeText(modelCompression.fallback)
    },
    compactionPolicy: normalizeCompactionPolicy(source, source.compactionPolicy),
    compression: {
      enabled: optionalBoolean(compression.enabled),
      mode: normalizeText(compression.mode),
      threshold: optionalRatio(compression.threshold, "compression.threshold"),
      targetRatio: optionalRatio(compression.targetRatio, "compression.targetRatio"),
      protectLastNTurns: optionalNumber(compression.protectLastNTurns, 0, 200, "compression.protectLastNTurns"),
      summaryMaxTokens: optionalNumber(compression.summaryMaxTokens, 0, 200_000, "compression.summaryMaxTokens"),
      strategy: normalizeText(compression.strategy)
    }
  };
}

function requireConfiguredNumber(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number) || number < min || number > max) {
    throw new Error(`context_profile_config_required:${field}`);
  }
  return number;
}

function requireConfiguredBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`context_profile_config_required:${field}`);
  }
}

export function assertContextProfileComplete(profile = {}) {
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
    ["recentTurnBudget", 0, 1_000_000]
  ]) {
    requireConfiguredNumber(profile[field], field, min, max);
  }
  for (const field of [
    "fixedMemoryRatio",
    "operatorGuidanceRatio",
    "referenceRatio",
    "historyRatio",
    "recentTurnRatio",
    "toolStateRatio"
  ]) {
    requireConfiguredNumber(profile.budgetPolicy?.[field], `budgetPolicy.${field}`, 0, 1);
  }
  for (const field of [
    "queryRelevance",
    "recency",
    "evidenceConfidence",
    "humanExpertBoost",
    "toolFreshness",
    "hierarchyLevel"
  ]) {
    requireConfiguredNumber(profile.rankingWeights?.[field], `rankingWeights.${field}`, 0, 1);
  }
  requireConfiguredNumber(
    profile.placementPolicy?.criticalEvidenceHeadCount,
    "placementPolicy.criticalEvidenceHeadCount",
    0,
    50
  );
  requireConfiguredBoolean(profile.placementPolicy?.evidenceTailChecklist, "placementPolicy.evidenceTailChecklist");
  requireConfiguredBoolean(profile.placementPolicy?.repeatTaskInTail, "placementPolicy.repeatTaskInTail");
  requireConfiguredBoolean(profile.modelCompression?.enabled, "modelCompression.enabled");
  requireConfiguredBoolean(profile.compression?.enabled, "compression.enabled");
  for (const [field, min, max] of [
    ["threshold", 0, 1],
    ["targetRatio", 0, 1],
    ["protectLastNTurns", 0, 200],
    ["summaryMaxTokens", 1, 200_000]
  ]) {
    requireConfiguredNumber(profile.compression?.[field], `compression.${field}`, min, max);
  }
  if (profile.compression?.strategy !== "deterministic-extractive") {
    throw new Error("context_profile_config_invalid:compression.strategy");
  }
  if (profile.modelCompression?.enabled === true) {
    if (!profile.modelCompression.alias) {
      throw new Error("context_profile_config_required:modelCompression.alias");
    }
    requireConfiguredNumber(profile.modelCompression.maxInputTokens, "modelCompression.maxInputTokens", 1, 2_000_000);
    requireConfiguredNumber(profile.modelCompression.maxOutputTokens, "modelCompression.maxOutputTokens", 1, 200_000);
    requireConfiguredNumber(profile.compactionPolicy?.modelMaxInputTokens, "compactionPolicy.modelMaxInputTokens", 1, 2_000_000);
    requireConfiguredNumber(profile.compactionPolicy?.modelMaxOutputTokens, "compactionPolicy.modelMaxOutputTokens", 1, 200_000);
    if (!profile.modelCompression.fallback) {
      throw new Error("context_profile_config_required:modelCompression.fallback");
    }
    if (!["model-assisted", "workbench-reconstruction", "session-memory-first"].includes(profile.compression.mode)) {
      throw new Error("context_profile_config_required:compression.mode");
    }
  }
  computeCompactionBudget(profile);
  return profile;
}

export function normalizeProfiles(profiles) {
  const byId = new Map();
  for (const value of asArray(profiles)) {
    const profile = normalizeProfile(value);
    assertContextProfileComplete(profile);
    if (byId.has(profile.profileId)) {
      throw new Error(`context_profile_config_duplicate:${profile.profileId}`);
    }
    byId.set(profile.profileId, profile);
  }
  return sortContextProfiles([...byId.values()]);
}
