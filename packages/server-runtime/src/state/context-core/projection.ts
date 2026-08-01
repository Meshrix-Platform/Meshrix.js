import {
  asArray,
  asObject,
  compactText,
  estimateTokens,
  normalizeStringArray,
  normalizeText
} from "./validation.ts";

export function workspaceSnapshot(workspaceState: Record<string, any> = {}) : any {
  const submissions: any = asArray(workspaceState.submissions)
    .filter((item?: any) : any => ["accepted", "proposed", "needs_review"].includes(item.status))
    .slice(0, 80);
  const artifacts: any = asArray(workspaceState.artifacts).slice(0, 20);
  const issues: any = asArray(workspaceState.issues).filter((item?: any) : any => item.status !== "resolved").slice(0, 30);
  return {
    workspace: workspaceState.workspace || null,
    submissions: submissions.map((item?: any) : any => ({
      type: item.type,
      status: item.status,
      confidence: item.confidence,
      summary: item.payload?.claim || item.payload?.summary || item.payload?.title || "",
      evidenceRefs: item.evidenceRefs || []
    })),
    artifacts: artifacts.map((item?: any) : any => ({
      artifactId: item.artifactId,
      level: item.level,
      title: item.title,
      status: item.status,
      revision: item.revision
    })),
    issues: issues.map((item?: any) : any => ({
      issueId: item.issueId,
      type: item.type,
      severity: item.severity,
      title: item.title
    }))
  };
}

export function citationsFromEvidence(evidenceItems: any = []) : any {
  return [
    ...new Map<any, any>(
      asArray(evidenceItems)
        .map((item?: any) : any => [
          item.evidenceId || item.id || item.ref || "",
          {
            evidenceId: item.evidenceId || item.id || item.ref || "",
            title: item.title || item.claim || "",
            sourceLocator: item.sourceLocator || item.source || item.hierarchy || null
          }
        ])
        .filter(([key]: any[]) : any => key)
    ).values()
  ];
}

export function tokenize(value?: any) : any {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((item?: any) : any => item.length >= 2)
    .slice(0, 80);
}

export function queryRelevanceScore(queryTokens?: any, text?: any) : any {
  if (!queryTokens.length) {
    return 0;
  }
  const haystack: any = normalizeText(text).toLowerCase();
  let hits: any = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return Math.min(1, hits / Math.max(1, queryTokens.length));
}

export function evidenceIdOf(item: Record<string, any> = {}) : any {
  return String(item.evidenceId || item.id || item.ref || item.evidence_id || "").trim();
}

export function evidenceIdAliasesOf(item: Record<string, any> = {}) : any {
  return [
    item.evidenceId,
    item.id,
    item.ref,
    item.evidence_id,
    item.original?.evidenceId,
    item.original?.id,
    item.original?.ref,
    item.original?.evidence_id
  ].map((value?: any) : any => String(value || "").trim()).filter(Boolean);
}

export function evidenceMatchesAny(item: Record<string, any> = {}, evidenceIds: any = new Set<any>()) : any {
  if (!evidenceIds.size) {
    return false;
  }
  return evidenceIdAliasesOf(item).some((id?: any) : any => evidenceIds.has(id));
}

export function sourceLocatorOf(item: Record<string, any> = {}) : any {
  return item.sourceLocator || item.source || item.hierarchy || item.path || item.url || null;
}

export function evidenceTextOf(item: Record<string, any> = {}) : any {
  return [
    item.title,
    item.claim,
    item.summary,
    item.snippet,
    item.text,
    item.content,
    item.description
  ].map((value?: any) : any => String(value || "")).filter(Boolean).join("\n");
}

export function timestampScore(item: Record<string, any> = {}) : any {
  const value: any = item.createdAt || item.updatedAt || item.timestamp || item.date || item.serverUpdatedAt;
  const time: any = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) {
    return 0;
  }
  const ageDays: any = Math.max(0, (Date.now() - time) / 86400000);
  return Number(Math.exp(-ageDays / 90).toFixed(6));
}

export function hierarchyScore(item: Record<string, any> = {}) : any {
  const level: any = String(item.hierarchyLevel || item.level || item.kind || item.type || "").toLowerCase();
  if (/(collection|document|section)/.test(level)) {
    return 1;
  }
  if (/(block|evidence|asset|chunk)/.test(level)) {
    return 0.65;
  }
  return 0.5;
}

export function confidenceScore(item: Record<string, any> = {}) : any {
  const confidence: any = Number(item.confidence ?? item.score ?? item.combinedScore ?? 0);
  if (!Number.isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence));
}

export function humanExpertScore(item: Record<string, any> = {}) : any {
  if (item.humanExpert || item.gold || item.humanConfirmed || item.context?.gold || item.context?.humanExpert) {
    return 1;
  }
  return 0;
}

export function extractProtectedFacts(item: Record<string, any> = {}) : any {
  const text: any = evidenceTextOf(item);
  const amountMatches: any = text.match(/(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?\s*(?:美元|美金|人民币|元|GBP|USD|EUR|CNY|%|percent)?/gi) || [];
  const dateMatches: any = text.match(/\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/gi) || [];
  const conflict: any = /冲突|矛盾|不一致|conflict|contradict/i.test(text);
  return {
    who: item.who || item.sender || item.author || item.owner || "",
    what: item.what || item.claim || item.title || "",
    when: item.when || dateMatches.slice(0, 4),
    amount: item.amount || amountMatches.slice(0, 6),
    conflict,
    confidence: item.confidence ?? item.score ?? null
  };
}

function configuredProtectedFacts(item?: any, profile?: any) : any {
  const configured: any = new Set<any>(normalizeStringArray(profile?.protectedEvidenceFields));
  const facts: any = extractProtectedFacts(item);
  return Object.fromEntries((Object.entries(facts) as [string, any][]).filter(([field]: any[]) : any => configured.has(field)));
}

export function normalizeEvidenceItem(item: Record<string, any> = {}, { queryTokens = [], profile }: Record<string, any> = {}) : any {
  const evidenceId: any = evidenceIdOf(item);
  const text: any = evidenceTextOf(item);
  const snippet: any = compactText(item.snippet || item.text || item.summary || item.claim || "", 180);
  const components: Record<string, any> = {
    queryRelevance: queryRelevanceScore(queryTokens, text),
    recency: timestampScore(item),
    evidenceConfidence: confidenceScore(item),
    humanExpertBoost: humanExpertScore(item),
    toolFreshness: item.toolFreshness || item.fromLatestTool ? 1 : 0,
    hierarchyLevel: hierarchyScore(item)
  };
  const weights: any = profile.rankingWeights;
  const score: any = (Object.entries(components) as [string, any][]).reduce(
    (total: any, [key, value]: any[]) : any => total + Number(value || 0) * Number(weights[key] || 0),
    0
  );
  return {
    evidenceId,
    title: String(item.title || item.claim || evidenceId || "untitled").slice(0, 180),
    sourceLocator: sourceLocatorOf(item),
    snippet,
    protectedFacts: configuredProtectedFacts(item, profile),
    confidence: confidenceScore(item),
    humanConfirmed: humanExpertScore(item) > 0,
    hierarchyLevel: item.hierarchyLevel || item.level || item.kind || "",
    score: Number(score.toFixed(6)),
    scoreBreakdown: components,
    original: item
  };
}

export function selectByBudget(items?: any, budget?: any, stringify: any = (item?: any) : any => JSON.stringify(item)) : any {
  const selected: any[] = [];
  const dropped: any[] = [];
  let used: any = 0;
  for (const item of asArray(items)) {
    const tokens: any = estimateTokens(stringify(item));
    if (used + tokens > Math.max(0, Number(budget) || 0)) {
      dropped.push({ item, tokens, reason: "budget_exceeded" });
      continue;
    }
    selected.push(item);
    used += tokens;
    if (used >= budget) {
      continue;
    }
  }
  return {
    selected,
    dropped,
    usedTokens: used,
    droppedCount: dropped.length
  };
}

export function selectRecentTurnsByBudget(
  items?: any,
  budget?: any,
  protectedCount: any = 0,
  stringify: any = (item?: any) : any => JSON.stringify(item)
) : any {
  const source: any = asArray(items);
  const safeBudget: any = Math.max(0, Number(budget) || 0);
  const safeProtectedCount: any = Math.max(0, Math.min(source.length, Number(protectedCount) || 0));
  const protectedStart: any = source.length - safeProtectedCount;
  const selectedIndexes: any = new Set<any>();
  let usedTokens: any = 0;
  for (let index: any = protectedStart; index < source.length; index += 1) {
    selectedIndexes.add(index);
    usedTokens += estimateTokens(stringify(source[index]));
  }
  for (let index: any = protectedStart - 1; index >= 0; index -= 1) {
    const tokens: any = estimateTokens(stringify(source[index]));
    if (usedTokens + tokens > safeBudget) continue;
    selectedIndexes.add(index);
    usedTokens += tokens;
  }
  const selected: any = source.filter((_?: any, index?: any) : any => selectedIndexes.has(index));
  const dropped: any = source
    .map((item?: any, index?: any) : any => ({ item, index }))
    .filter(({ index }: Record<string, any>) : any => !selectedIndexes.has(index))
    .map(({ item }: Record<string, any>) : any => ({ item, tokens: estimateTokens(stringify(item)), reason: "budget_exceeded" }));
  return {
    selected,
    dropped,
    usedTokens,
    droppedCount: dropped.length,
    protectedCount: safeProtectedCount,
    protectedBudgetOverrun: usedTokens > safeBudget && safeProtectedCount > 0
  };
}

export function collectProtectedEvidenceIds(input: Record<string, any> = {}, expertGuidanceItems: any = []) : any {
  return normalizeStringArray([
    ...asArray(input.requiredEvidenceIds),
    ...asArray(input.requiredEvidenceRefs),
    ...asArray(input.protectedEvidenceIds),
    ...asArray(input.mustKeepEvidenceIds),
    ...asArray(input.evidenceRefs),
    ...asArray(input.citations).map((item?: any) : any => typeof item === "string" ? item : item?.evidenceId),
    ...asArray(expertGuidanceItems).flatMap((item?: any) : any => item.evidenceRefs || [])
  ]);
}

export function selectEvidenceByBudget(items?: any, budget?: any, protectedEvidenceIds: any = [], stringify: any = (item?: any) : any => JSON.stringify(item)) : any {
  const protectedSet: any = new Set<any>(protectedEvidenceIds);
  const selected: any[] = [];
  const dropped: any[] = [];
  const selectedKeys: any = new Set<any>();
  let used: any = 0;

  for (const item of asArray(items)) {
    if (!evidenceMatchesAny(item, protectedSet)) {
      continue;
    }
    const key: any = evidenceIdOf(item) || JSON.stringify(item);
    if (selectedKeys.has(key)) {
      continue;
    }
    const tokens: any = estimateTokens(stringify(item));
    selected.push({
      ...item,
      protectedEvidence: true,
      protectionReason: "required_evidence"
    });
    selectedKeys.add(key);
    used += tokens;
  }

  for (const item of asArray(items)) {
    const key: any = evidenceIdOf(item) || JSON.stringify(item);
    if (selectedKeys.has(key)) {
      continue;
    }
    const tokens: any = estimateTokens(stringify(item));
    if (used + tokens > Math.max(0, Number(budget) || 0)) {
      dropped.push({ item, tokens, reason: "budget_exceeded" });
      continue;
    }
    selected.push(item);
    selectedKeys.add(key);
    used += tokens;
    if (used >= budget) {
      continue;
    }
  }

  return {
    selected,
    dropped,
    usedTokens: used,
    droppedCount: dropped.length,
    protectedEvidenceIds: selected
      .filter((item?: any) : any => item.protectedEvidence)
      .map((item?: any) : any => item.evidenceId)
      .filter(Boolean),
    protectedEvidenceCount: selected.filter((item?: any) : any => item.protectedEvidence).length,
    protectedEvidenceBudgetOverrun: used > budget && selected.some((item?: any) : any => item.protectedEvidence)
  };
}

export function normalizeExpertGuidance(input: Record<string, any> = {}) : any {
  return [
    ...asArray(input.expertGuidance),
    ...asArray(input.humanFeedback),
    ...asArray(input.feedback).filter((item?: any) : any => item?.context?.gold || item?.context?.humanExpert)
  ].map((item?: any, index?: any) : any => {
    const context: any = asObject(item.context);
    const selected: any = asObject(item.selectedOption || context.selectedOption);
    return {
      guidanceId: String(item.guidanceId || item.feedbackId || item.id || `expert-${index + 1}`),
      query: String(item.query || context.query || item.sourceQuery || ""),
      label: String(item.label || selected.label || item.selectedLabel || ""),
      instruction: String(item.instruction || selected.followUpQuestion || item.followUpQuestion || item.summary || ""),
      reason: String(item.reason || context.reason || ""),
      evidenceRefs: normalizeStringArray(item.evidenceRefs || context.evidenceRefs),
      createdAt: item.createdAt || context.createdAt || ""
    };
  }).filter((item?: any) : any => item.label || item.instruction || item.evidenceRefs.length);
}

export function normalizeMemoryBlocks(input: Record<string, any> = {}, budget: any = 0) : any {
  const blocks: any = [
    ...asArray(input.memoryBlocks),
    input.systemMemory || input.memory
      ? { blockId: "system-memory", label: "System Memory", content: input.systemMemory || input.memory }
      : null
  ].filter(Boolean).map((item?: any, index?: any) : any => ({
    blockId: String(item.blockId || item.id || `memory-${index + 1}`),
    label: String(item.label || item.title || item.type || "Memory"),
    content: compactText(item.content || item.text || item.summary || item.value || "", budget)
  })).filter((item?: any) : any => item.content);
  return blocks;
}

export function summarizeToolState(toolState: Record<string, any> = {}, budget: any = 0) : any {
  const previous: any = asArray(toolState.previousToolResults).slice(-8).map((item?: any) : any => ({
    tool: item.tool || item.name || "",
    ok: item.ok !== false,
    arguments: item.arguments || undefined,
    count: item.count ?? item.resultCount ?? undefined,
    evidenceId: item.evidenceId || item.evidence?.evidenceId || "",
    error: item.error || ""
  }));
  const summary: Record<string, any> = {
    iteration: toolState.iteration || "",
    activeTool: toolState.activeTool || "",
    previousToolResults: previous,
    pending: toolState.pending || []
  };
  return {
    ...summary,
    compactText: compactText(JSON.stringify(summary), budget)
  };
}

export function computeBudgets(profile?: any) : any {
  const usableTokens: any = Math.max(
    0,
    profile.contextWindowTokens - profile.outputReserveTokens - profile.toolReserveTokens
  );
  const policy: any = profile.budgetPolicy;
  const proposed: Record<string, any> = {
    fixedMemory: Math.min(profile.fixedMemoryBudget, Math.floor(usableTokens * policy.fixedMemoryRatio)),
    expertGuidance: Math.floor(usableTokens * policy.operatorGuidanceRatio),
    reference: Math.min(profile.referenceBudget, Math.floor(usableTokens * policy.referenceRatio)),
    history: Math.min(profile.historyBudget, Math.floor(usableTokens * policy.historyRatio)),
    recentTurns: Math.min(profile.recentTurnBudget, Math.floor(usableTokens * policy.recentTurnRatio)),
    toolState: Math.floor(usableTokens * policy.toolStateRatio)
  };
  return {
    usableTokens,
    fixedMemory: Math.max(0, proposed.fixedMemory),
    expertGuidance: Math.max(0, proposed.expertGuidance),
    reference: Math.max(0, proposed.reference),
    history: Math.max(0, proposed.history),
    recentTurns: Math.max(0, proposed.recentTurns),
    toolState: Math.max(0, proposed.toolState)
  };
}

export function criticalEvidenceIndex(evidencePack: any = [], profile?: any) : any {
  return evidencePack
    .slice(0, profile.placementPolicy.criticalEvidenceHeadCount)
    .map((item?: any, index?: any) : any => ({
      rank: index + 1,
      evidenceId: item.evidenceId,
      title: item.title,
      sourceLocator: item.sourceLocator,
      protectedFacts: item.protectedFacts,
      score: item.score
    }));
}

export function sectionTokenReport(pack: Record<string, any> = {}) : any {
  return {
    memoryBlocks: estimateTokens(pack.memoryBlocks || []),
    expertGuidance: estimateTokens(pack.expertGuidance || []),
    criticalEvidenceIndex: estimateTokens(pack.criticalEvidenceIndex || []),
    evidencePack: estimateTokens(pack.evidencePack || []),
    toolStateSummary: estimateTokens(pack.toolStateSummary || {}),
    compressedHistory: estimateTokens(pack.compressedHistory || ""),
    recentTurns: estimateTokens(pack.recentTurns || []),
    tailChecklist: estimateTokens(pack.tailChecklist || {})
  };
}
