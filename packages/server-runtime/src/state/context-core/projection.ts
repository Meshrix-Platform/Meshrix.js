import {
  asArray,
  asObject,
  compactText,
  estimateTokens,
  normalizeStringArray,
  normalizeText,
} from "./validation.ts";
import type {
  ContextProfile,
  EvidenceSource,
  NormalizedEvidence,
  RuntimeRecord,
  ScoreBreakdown,
} from "./types.ts";

interface EvidenceCitation {
  evidenceId: string;
  title: unknown;
  sourceLocator: unknown;
}

export function workspaceSnapshot(workspaceState: RuntimeRecord = {}) {
  const submissions = asArray<EvidenceSource>(workspaceState.submissions)
    .filter(
      (item) =>
        typeof item.status === "string" &&
        ["accepted", "proposed", "needs_review"].includes(item.status),
    )
    .slice(0, 80);
  const artifacts = asArray<EvidenceSource>(workspaceState.artifacts).slice(
    0,
    20,
  );
  const issues = asArray<EvidenceSource>(workspaceState.issues)
    .filter((item) => item.status !== "resolved")
    .slice(0, 30);
  return {
    workspace: workspaceState.workspace || null,
    submissions: submissions.map((item) => ({
      type: item.type,
      status: item.status,
      confidence: item.confidence,
      summary:
        item.payload?.claim ||
        item.payload?.summary ||
        item.payload?.title ||
        "",
      evidenceRefs: item.evidenceRefs || [],
    })),
    artifacts: artifacts.map((item) => ({
      artifactId: item.artifactId,
      level: item.level,
      title: item.title,
      status: item.status,
      revision: item.revision,
    })),
    issues: issues.map((item) => ({
      issueId: item.issueId,
      type: item.type,
      severity: item.severity,
      title: item.title,
    })),
  };
}

export function citationsFromEvidence(
  evidenceItems: unknown = [],
): EvidenceCitation[] {
  return [
    ...new Map<string, EvidenceCitation>(
      asArray<EvidenceSource>(evidenceItems)
        .map((item): [string, EvidenceCitation] => {
          const evidenceId = String(
            item.evidenceId || item.id || item.ref || "",
          ).trim();
          return [
            evidenceId,
            {
              evidenceId,
              title: item.title || item.claim || "",
              sourceLocator:
                item.sourceLocator || item.source || item.hierarchy || null,
            },
          ];
        })
        .filter(([key]) => Boolean(key)),
    ).values(),
  ];
}

export function tokenize(value: unknown): string[] {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((item) => item.length >= 2)
    .slice(0, 80);
}

export function queryRelevanceScore(
  queryTokens: readonly string[] = [],
  text?: unknown,
): number {
  if (!queryTokens.length) {
    return 0;
  }
  const haystack = normalizeText(text).toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return Math.min(1, hits / Math.max(1, queryTokens.length));
}

export function evidenceIdOf(item: EvidenceSource = {}): string {
  return String(
    item.evidenceId || item.id || item.ref || item.evidence_id || "",
  ).trim();
}

export function evidenceIdAliasesOf(item: EvidenceSource = {}): string[] {
  return [
    item.evidenceId,
    item.id,
    item.ref,
    item.evidence_id,
    item.original?.evidenceId,
    item.original?.id,
    item.original?.ref,
    item.original?.evidence_id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function evidenceMatchesAny(
  item: EvidenceSource = {},
  evidenceIds: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (!evidenceIds.size) {
    return false;
  }
  return evidenceIdAliasesOf(item).some((id) => evidenceIds.has(id));
}

export function sourceLocatorOf(item: EvidenceSource = {}): unknown {
  return (
    item.sourceLocator ||
    item.source ||
    item.hierarchy ||
    item.path ||
    item.url ||
    null
  );
}

export function evidenceTextOf(item: EvidenceSource = {}): string {
  return [
    item.title,
    item.claim,
    item.summary,
    item.snippet,
    item.text,
    item.content,
    item.description,
  ]
    .map((value) => String(value || ""))
    .filter(Boolean)
    .join("\n");
}

export function timestampScore(item: EvidenceSource = {}): number {
  const value =
    item.createdAt ||
    item.updatedAt ||
    item.timestamp ||
    item.date ||
    item.serverUpdatedAt;
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - time) / 86400000);
  return Number(Math.exp(-ageDays / 90).toFixed(6));
}

export function hierarchyScore(item: EvidenceSource = {}): number {
  const level = String(
    item.hierarchyLevel || item.level || item.kind || item.type || "",
  ).toLowerCase();
  if (/(collection|document|section)/.test(level)) {
    return 1;
  }
  if (/(block|evidence|asset|chunk)/.test(level)) {
    return 0.65;
  }
  return 0.5;
}

export function confidenceScore(item: EvidenceSource = {}): number {
  const confidence = Number(
    item.confidence ?? item.score ?? item.combinedScore ?? 0,
  );
  if (!Number.isFinite(confidence)) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(1, confidence > 1 ? confidence / 100 : confidence),
  );
}

export function humanExpertScore(item: EvidenceSource = {}): number {
  const context = asObject(item.context);
  if (
    item.humanExpert ||
    item.gold ||
    item.humanConfirmed ||
    context.gold ||
    context.humanExpert
  ) {
    return 1;
  }
  return 0;
}

export function extractProtectedFacts(
  item: EvidenceSource = {},
): RuntimeRecord {
  const text = evidenceTextOf(item);
  const amountMatches =
    text.match(
      /(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?\s*(?:美元|美金|人民币|元|GBP|USD|EUR|CNY|%|percent)?/gi,
    ) || [];
  const dateMatches =
    text.match(
      /\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/gi,
    ) || [];
  const conflict = /冲突|矛盾|不一致|conflict|contradict/i.test(text);
  return {
    who: item.who || item.sender || item.author || item.owner || "",
    what: item.what || item.claim || item.title || "",
    when: item.when || dateMatches.slice(0, 4),
    amount: item.amount || amountMatches.slice(0, 6),
    conflict,
    confidence: item.confidence ?? item.score ?? null,
  };
}

function configuredProtectedFacts(
  item: EvidenceSource,
  profile: ContextProfile,
): RuntimeRecord {
  const configured = new Set<string>(
    normalizeStringArray(profile?.protectedEvidenceFields),
  );
  const facts = extractProtectedFacts(item);
  return Object.fromEntries(
    Object.entries(facts).filter(([field]) => configured.has(field)),
  );
}

export function normalizeEvidenceItem(
  item: EvidenceSource = {},
  {
    queryTokens = [],
    profile,
  }: { queryTokens?: string[]; profile: ContextProfile },
): NormalizedEvidence {
  const evidenceId = evidenceIdOf(item);
  const text = evidenceTextOf(item);
  const snippet = compactText(
    item.snippet || item.text || item.summary || item.claim || "",
    180,
  );
  const components: ScoreBreakdown = {
    queryRelevance: queryRelevanceScore(queryTokens, text),
    recency: timestampScore(item),
    evidenceConfidence: confidenceScore(item),
    humanExpertBoost: humanExpertScore(item),
    toolFreshness: item.toolFreshness || item.fromLatestTool ? 1 : 0,
    hierarchyLevel: hierarchyScore(item),
  };
  const weights = profile.rankingWeights;
  const score = (
    Object.entries(components) as Array<[keyof typeof weights, number]>
  ).reduce(
    (total, [key, value]) => total + value * Number(weights[key] || 0),
    0,
  );
  return {
    evidenceId,
    title: String(item.title || item.claim || evidenceId || "untitled").slice(
      0,
      180,
    ),
    sourceLocator: sourceLocatorOf(item),
    snippet,
    protectedFacts: configuredProtectedFacts(item, profile),
    confidence: confidenceScore(item),
    humanConfirmed: humanExpertScore(item) > 0,
    hierarchyLevel: item.hierarchyLevel || item.level || item.kind || "",
    score: Number(score.toFixed(6)),
    scoreBreakdown: components,
    original: item,
  };
}

export function selectByBudget<T extends RuntimeRecord>(
  items: readonly T[] | unknown = [],
  budget: unknown = 0,
  stringify: (item: T) => string = (item) => JSON.stringify(item),
) {
  const selected: T[] = [];
  const dropped: Array<{
    item: T;
    tokens: number;
    reason: "budget_exceeded";
  }> = [];
  let used = 0;
  const safeBudget = Math.max(0, Number(budget) || 0);
  for (const item of asArray<T>(items)) {
    const tokens = estimateTokens(stringify(item));
    if (used + tokens > safeBudget) {
      dropped.push({ item, tokens, reason: "budget_exceeded" });
      continue;
    }
    selected.push(item);
    used += tokens;
    if (used >= safeBudget) {
      continue;
    }
  }
  return {
    selected,
    dropped,
    usedTokens: used,
    droppedCount: dropped.length,
  };
}

export function selectRecentTurnsByBudget(
  items: readonly RuntimeRecord[] | unknown = [],
  budget: unknown = 0,
  protectedCount: unknown = 0,
  stringify: (item: RuntimeRecord) => string = (item) => JSON.stringify(item),
) {
  const source = asArray<RuntimeRecord>(items);
  const safeBudget = Math.max(0, Number(budget) || 0);
  const safeProtectedCount = Math.max(
    0,
    Math.min(source.length, Number(protectedCount) || 0),
  );
  const protectedStart = source.length - safeProtectedCount;
  const selectedIndexes = new Set<number>();
  let usedTokens = 0;
  for (let index = protectedStart; index < source.length; index += 1) {
    selectedIndexes.add(index);
    usedTokens += estimateTokens(stringify(source[index]));
  }
  for (let index = protectedStart - 1; index >= 0; index -= 1) {
    const tokens = estimateTokens(stringify(source[index]));
    if (usedTokens + tokens > safeBudget) continue;
    selectedIndexes.add(index);
    usedTokens += tokens;
  }
  const selected = source.filter((_, index) => selectedIndexes.has(index));
  const dropped = source
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !selectedIndexes.has(index))
    .map(({ item }) => ({
      item,
      tokens: estimateTokens(stringify(item)),
      reason: "budget_exceeded" as const,
    }));
  return {
    selected,
    dropped,
    usedTokens,
    droppedCount: dropped.length,
    protectedCount: safeProtectedCount,
    protectedBudgetOverrun: usedTokens > safeBudget && safeProtectedCount > 0,
  };
}

export function collectProtectedEvidenceIds(
  input: RuntimeRecord = {},
  expertGuidanceItems: readonly EvidenceSource[] | unknown = [],
): string[] {
  return normalizeStringArray([
    ...asArray(input.requiredEvidenceIds),
    ...asArray(input.requiredEvidenceRefs),
    ...asArray(input.protectedEvidenceIds),
    ...asArray(input.mustKeepEvidenceIds),
    ...asArray(input.evidenceRefs),
    ...asArray<EvidenceSource | string>(input.citations).map((item) =>
      typeof item === "string" ? item : item.evidenceId,
    ),
    ...asArray<EvidenceSource>(expertGuidanceItems).flatMap((item) =>
      normalizeStringArray(item.evidenceRefs),
    ),
  ]);
}

export function selectEvidenceByBudget(
  items: readonly NormalizedEvidence[] | unknown = [],
  budget: unknown = 0,
  protectedEvidenceIds: readonly string[] = [],
  stringify: (item: NormalizedEvidence) => string = (item) =>
    JSON.stringify(item),
) {
  const protectedSet = new Set<string>(protectedEvidenceIds);
  const selected: NormalizedEvidence[] = [];
  const dropped: Array<{
    item: NormalizedEvidence;
    tokens: number;
    reason: "budget_exceeded";
  }> = [];
  const selectedKeys = new Set<string>();
  let used = 0;

  const safeBudget = Math.max(0, Number(budget) || 0);
  for (const item of asArray<NormalizedEvidence>(items)) {
    if (!evidenceMatchesAny(item, protectedSet)) {
      continue;
    }
    const key = evidenceIdOf(item) || JSON.stringify(item);
    if (selectedKeys.has(key)) {
      continue;
    }
    const tokens = estimateTokens(stringify(item));
    selected.push({
      ...item,
      protectedEvidence: true,
      protectionReason: "required_evidence",
    });
    selectedKeys.add(key);
    used += tokens;
  }

  for (const item of asArray<NormalizedEvidence>(items)) {
    const key = evidenceIdOf(item) || JSON.stringify(item);
    if (selectedKeys.has(key)) {
      continue;
    }
    const tokens = estimateTokens(stringify(item));
    if (used + tokens > safeBudget) {
      dropped.push({ item, tokens, reason: "budget_exceeded" });
      continue;
    }
    selected.push(item);
    selectedKeys.add(key);
    used += tokens;
    if (used >= safeBudget) {
      continue;
    }
  }

  return {
    selected,
    dropped,
    usedTokens: used,
    droppedCount: dropped.length,
    protectedEvidenceIds: selected
      .filter((item) => item.protectedEvidence)
      .map((item) => item.evidenceId)
      .filter(Boolean),
    protectedEvidenceCount: selected.filter((item) => item.protectedEvidence)
      .length,
    protectedEvidenceBudgetOverrun:
      used > safeBudget && selected.some((item) => item.protectedEvidence),
  };
}

export function normalizeExpertGuidance(input: RuntimeRecord = {}) {
  return [
    ...asArray<EvidenceSource>(input.expertGuidance),
    ...asArray<EvidenceSource>(input.humanFeedback),
    ...asArray<EvidenceSource>(input.feedback).filter((item) => {
      const context = asObject(item.context);
      return Boolean(context.gold || context.humanExpert);
    }),
  ]
    .map((item, index) => {
      const context = asObject(item.context);
      const selected = asObject(item.selectedOption || context.selectedOption);
      return {
        guidanceId: String(
          item.guidanceId ||
            item.feedbackId ||
            item.id ||
            `expert-${index + 1}`,
        ),
        query: String(item.query || context.query || item.sourceQuery || ""),
        label: String(item.label || selected.label || item.selectedLabel || ""),
        instruction: String(
          item.instruction ||
            selected.followUpQuestion ||
            item.followUpQuestion ||
            item.summary ||
            "",
        ),
        reason: String(item.reason || context.reason || ""),
        evidenceRefs: normalizeStringArray(
          item.evidenceRefs || context.evidenceRefs,
        ),
        createdAt: item.createdAt || context.createdAt || "",
      };
    })
    .filter(
      (item) => item.label || item.instruction || item.evidenceRefs.length,
    );
}

export function normalizeMemoryBlocks(
  input: RuntimeRecord = {},
  budget: unknown = 0,
) {
  const blocks = [
    ...asArray<EvidenceSource>(input.memoryBlocks),
    input.systemMemory || input.memory
      ? {
          blockId: "system-memory",
          label: "System Memory",
          content: input.systemMemory || input.memory,
        }
      : null,
  ]
    .filter((item): item is EvidenceSource => Boolean(item))
    .map((item, index) => ({
      blockId: String(item.blockId || item.id || `memory-${index + 1}`),
      label: String(item.label || item.title || item.type || "Memory"),
      content: compactText(
        item.content || item.text || item.summary || item.value || "",
        budget,
      ),
    }))
    .filter((item) => item.content);
  return blocks;
}

export function summarizeToolState(
  toolState: RuntimeRecord = {},
  budget: unknown = 0,
) {
  const previous = asArray<EvidenceSource>(toolState.previousToolResults)
    .slice(-8)
    .map((item) => ({
      tool: item.tool || item.name || "",
      ok: item.ok !== false,
      arguments: item.arguments || undefined,
      count: item.count ?? item.resultCount ?? undefined,
      evidenceId: item.evidenceId || item.evidence?.evidenceId || "",
      error: item.error || "",
    }));
  const summary: RuntimeRecord = {
    iteration: toolState.iteration || "",
    activeTool: toolState.activeTool || "",
    previousToolResults: previous,
    pending: toolState.pending || [],
  };
  return {
    ...summary,
    compactText: compactText(JSON.stringify(summary), budget),
  };
}

export function computeBudgets(profile: ContextProfile) {
  const usableTokens = Math.max(
    0,
    profile.contextWindowTokens -
      profile.outputReserveTokens -
      profile.toolReserveTokens,
  );
  const policy = profile.budgetPolicy;
  const proposed = {
    fixedMemory: Math.min(
      profile.fixedMemoryBudget,
      Math.floor(usableTokens * policy.fixedMemoryRatio),
    ),
    expertGuidance: Math.floor(usableTokens * policy.operatorGuidanceRatio),
    reference: Math.min(
      profile.referenceBudget,
      Math.floor(usableTokens * policy.referenceRatio),
    ),
    history: Math.min(
      profile.historyBudget,
      Math.floor(usableTokens * policy.historyRatio),
    ),
    recentTurns: Math.min(
      profile.recentTurnBudget,
      Math.floor(usableTokens * policy.recentTurnRatio),
    ),
    toolState: Math.floor(usableTokens * policy.toolStateRatio),
  };
  return {
    usableTokens,
    fixedMemory: Math.max(0, proposed.fixedMemory),
    expertGuidance: Math.max(0, proposed.expertGuidance),
    reference: Math.max(0, proposed.reference),
    history: Math.max(0, proposed.history),
    recentTurns: Math.max(0, proposed.recentTurns),
    toolState: Math.max(0, proposed.toolState),
  };
}

export function criticalEvidenceIndex(
  evidencePack: readonly NormalizedEvidence[] = [],
  profile: ContextProfile,
) {
  return evidencePack
    .slice(0, profile.placementPolicy.criticalEvidenceHeadCount)
    .map((item, index) => ({
      rank: index + 1,
      evidenceId: item.evidenceId,
      title: item.title,
      sourceLocator: item.sourceLocator,
      protectedFacts: item.protectedFacts,
      score: item.score,
    }));
}

export function sectionTokenReport(pack: RuntimeRecord = {}) {
  return {
    memoryBlocks: estimateTokens(pack.memoryBlocks || []),
    expertGuidance: estimateTokens(pack.expertGuidance || []),
    criticalEvidenceIndex: estimateTokens(pack.criticalEvidenceIndex || []),
    evidencePack: estimateTokens(pack.evidencePack || []),
    toolStateSummary: estimateTokens(pack.toolStateSummary || {}),
    compressedHistory: estimateTokens(pack.compressedHistory || ""),
    recentTurns: estimateTokens(pack.recentTurns || []),
    tailChecklist: estimateTokens(pack.tailChecklist || {}),
  };
}
