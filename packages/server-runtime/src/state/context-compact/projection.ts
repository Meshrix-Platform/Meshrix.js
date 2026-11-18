import {
  asArray,
  asObject,
  clampNumber,
  estimateContextTokens,
  findSensitiveCompactionLeaks,
  hashValue,
  normalizeText,
  redactCompactionValue,
  redactEmbeddedPayloads,
  redactText
} from "./validation.ts";
import type { CompactionPolicy } from "./validation.ts";
import { normalizeMessage, toolResultIds, toolUseIds } from "./graph.ts";
import type { NormalizedMessage } from "./graph.ts";

interface ScoredLine {
  line: string;
  index: number;
  score: number;
}

export interface StructuredFacts {
  constraints: string[];
  decisions: string[];
  risks: string[];
  todos: string[];
  evidenceRefs: string[];
  fileRefs: string[];
  dates: string[];
  amounts: string[];
  gatewayRefs: string[];
}

export interface RequiredAnchor {
  id: string;
  text: string;
}

export interface QualityReport {
  protocolVersion: string;
  requiredAnchorCount: number;
  retainedAnchorCount: number;
  missingAnchorCount: number;
  retentionRatio: number;
  minimumRetentionRatio: number;
  missingAnchors: RequiredAnchor[];
  retainedAnchors: RequiredAnchor[];
  secretLeakCount: number;
  compressionSavingsRatio: number;
  passed: boolean;
}

export interface DeterministicSummary {
  summary: string;
  structured: unknown;
}

export interface ModelSummary {
  summary: string;
  structured: Record<string, unknown>;
}

export interface ApiRoundGroup {
  apiRoundId: string;
  messages: NormalizedMessage[];
  start: number;
  end: number;
  totalTokens: number;
}

export interface ApiRoundSelectionIndex {
  groups: ApiRoundGroup[];
  suffixTokens: number[];
}

export interface SelectedApiRoundSuffix {
  startGroupIndex: number;
  totalTokens: number;
  messages: NormalizedMessage[];
}

export interface WorkbenchInputResult {
  messages: NormalizedMessage[];
  metadata: {
    droppedGroupCount: number;
    trimRatio: number;
    inputTokens: number;
  };
}

export interface ReinjectionItem {
  key: string;
  value: unknown;
  tokens: number;
  priority: number;
}

export interface ReinjectionDroppedItem {
  key: string;
  reason: string;
  tokens: number;
}

export interface ReinjectionPayload {
  items: ReinjectionItem[];
  usedTokens: number;
  dropped: ReinjectionDroppedItem[];
  degraded: boolean;
  budgetTokens: number;
}

export interface DehydratedAttachment {
  type: string;
  name: string;
  ref: string;
  checksum: string;
  summary: string;
  dehydrated: true;
}

export interface DehydratedContentBlock {
  type: "dehydrated_payload";
  originalType: string;
  name: string;
  ref: string;
  checksum: string;
  summary: string;
  dehydrated: true;
}

export interface StrippedMessageResult {
  message: NormalizedMessage;
  strippedBlockCount: number;
  dehydratedAttachmentCount: number;
}

export interface WorkbenchPreparation {
  messages: NormalizedMessage[];
  strippedBlockCount: number;
  dehydratedAttachmentCount: number;
  changedCount: number;
  originalTokens: number;
  preparedTokens: number;
  savedTokens: number;
}

export interface SummarizedToolResult {
  [key: string]: unknown;
  content: string;
  text: string;
  dehydrated: true;
  tokenEstimate: number;
}

export interface MicroCompactionResult {
  messages: NormalizedMessage[];
  changedCount: number;
  dehydratedAttachments: DehydratedAttachment[];
}

export function extractMatches(text: unknown, regex: RegExp, limit = 20) : string[] {
  return [...new Set<string>(
    (String(text || "").match(regex) || []).map((item: string) : string => item.trim()).filter(Boolean)
  )].slice(0, limit);
}

export function selectImportantLines(text?: unknown, limit = 8) : string[] {
  const lines: string[] = String(text || "")
    .split(/\r?\n|(?<=[。！？.!?])\s+/u)
    .map((line: string) : string => normalizeText(line))
    .filter(Boolean);
  const heap: ScoredLine[] = [];
  const boundedLimit: number = Math.max(0, Math.floor(Number(limit) || 0));
  const betterThan = (left: ScoredLine, right: ScoredLine) : boolean =>
    left.score > right.score || (left.score === right.score && left.index < right.index);
  const worseThan = (left: ScoredLine, right: ScoredLine) : boolean => betterThan(right, left);
  const siftUp = (start: number) : void => {
    let index: number = start;
    while (index > 0) {
      const parent: number = Math.floor((index - 1) / 2);
      if (!worseThan(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  };
  const siftDown = () : void => {
    let index: number = 0;
    while (true) {
      const left: number = index * 2 + 1;
      const right: number = left + 1;
      let worst: number = index;
      if (left < heap.length && worseThan(heap[left], heap[worst])) worst = left;
      if (right < heap.length && worseThan(heap[right], heap[worst])) worst = right;
      if (worst === index) break;
      [heap[index], heap[worst]] = [heap[worst], heap[index]];
      index = worst;
    }
  };
  for (const [index, line] of lines.entries()) {
    const item: ScoredLine = {
      line,
      index,
      score:
      /(must|should|never|cannot|todo|fixme|risk|error|failed|decision|approved|evidence|source|scope|rollback|version|必须|不能|不得|风险|错误|失败|决定|证据|来源|审批|版本|回滚)/i.test(line)
        ? 3
        : /(\/[\w./-]+|[A-Za-z]:\\|[A-Z][A-Za-z0-9_/-]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md)|\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b)/.test(line)
          ? 2
          : 1
    };
    if (boundedLimit === 0) continue;
    if (heap.length < boundedLimit) {
      heap.push(item);
      siftUp(heap.length - 1);
    } else if (betterThan(item, heap[0])) {
      heap[0] = item;
      siftDown();
    }
  }
  return heap
    .sort((left: ScoredLine, right: ScoredLine) : number => left.index - right.index)
    .map((item: ScoredLine) : string => item.line);
}

export function compactToBudget(text?: unknown, targetTokens?: unknown) : string {
  const safeTarget: number = Math.max(0, Number(targetTokens || 0));
  const source: string = redactText(String(text || "").trim());
  if (safeTarget === 0) {
    return "";
  }
  if (!source || estimateContextTokens(source) <= safeTarget) {
    return source;
  }
  const lines: string[] = selectImportantLines(source, Math.max(6, Math.floor(safeTarget / 90)));
  let output: string = lines.join("\n");
  while (estimateContextTokens(output) > safeTarget && output.length > 80) {
    output = output.slice(0, Math.floor(output.length * 0.85)).trim();
  }
  return output || source.slice(0, safeTarget * 4);
}

export function collectStructuredFacts(messages: NormalizedMessage[] = [], runtimeState: Record<string, unknown> = {}) : StructuredFacts {
  const joined: string = messages.map((message: NormalizedMessage) : string => `${message.role}: ${message.text}`).join("\n");
  return {
    constraints: extractMatches(
      joined,
      /(?:must|should|never|cannot|do not|必须|不能|不得|需要|确保)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    decisions: extractMatches(
      joined,
      /(?:decision|decided|approved|rejected|决定|已确认|已批准|已拒绝)[^。！？.!?\n]{0,220}/gi,
      18
    ),
    risks: extractMatches(
      joined,
      /(?:risk|error|failed|failure|blocked|warning|风险|错误|失败|阻塞|告警)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    todos: extractMatches(
      joined,
      /(?:todo|fixme|pending|next|follow[- ]?up|待办|未完成|下一步|待审批)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    evidenceRefs: extractMatches(
      joined,
      /\b(?:ev|evidence|source|doc|chunk|record|audit|run|job|pkg|version)[-_:#]?[A-Za-z0-9_.:-]{2,80}\b/gi,
      40
    ),
    fileRefs: extractMatches(
      joined,
      /(?:[A-Za-z]:\\[^\s"'<>]+|\/[^\s"'<>]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md|yaml|yml)|\b[\w./-]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md|yaml|yml)\b)/g,
      32
    ).map(redactText),
    dates: extractMatches(joined, /\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/g, 20),
    amounts: extractMatches(joined, /(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?\s*(?:美元|美金|人民币|元|GBP|USD|EUR|CNY|%|percent)?/gi, 20),
    gatewayRefs: [
      runtimeState.gatewayReference,
      runtimeState.gatewayPolicyVersion,
      runtimeState.gatewaySourceId
    ].map((item?: unknown) : string => String(item || "").trim()).filter(Boolean)
  };
}

export function normalizeRequiredAnchors(input: Record<string, unknown> = {}, runtimeState: Record<string, unknown> = {}) : RequiredAnchor[] {
  const rawAnchors: unknown[] = [
    ...asArray(input.requiredAnchors),
    ...asArray(input.requiredFacts),
    ...asArray(input.protectedAnchors),
    ...asArray(asObject(input.compactionQuality).requiredAnchors),
    ...asArray(runtimeState.requiredAnchors)
  ];
  const seen: Set<string> = new Set<string>();
  return rawAnchors
    .map((anchor?: unknown) : RequiredAnchor | null => {
      const source: Record<string, unknown> = typeof anchor === "string"
        ? { text: anchor }
        : asObject(anchor);
      const text: string = normalizeText(source.text || source.value || source.anchor || source.id || "");
      if (!text) {
        return null;
      }
      const id: string = normalizeText(source.id || source.key || text).slice(0, 120);
      const key: string = `${id}\u001f${text}`.toLowerCase();
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        id,
        text: compactToBudget(text, 120)
      };
    })
    .filter((anchor: RequiredAnchor | null) : anchor is RequiredAnchor => anchor !== null)
    .slice(0, 100);
}

export function retainedTextForQuality({
  summary = "",
  messagesToKeep = [],
  reinjection = {}
}: { summary?: string; messagesToKeep?: unknown[]; reinjection?: Record<string, unknown> } = {}) : string {
  return [
    summary,
    ...asArray(messagesToKeep).map((message?: unknown) : string =>
      typeof message === "string" ? message : String(asObject(message).text || asObject(message).content || JSON.stringify(message))
    ),
    ...asArray(reinjection.items).map((item?: unknown) : string => {
      const source = asObject(item);
      return typeof source.value === "string" ? source.value : JSON.stringify(source.value ?? "");
    })
  ].join("\n");
}

export function buildCompactionQualityReport({
  input = {},
  runtimeState = {},
  summary = "",
  messagesToKeep = [],
  reinjection = {},
  tokenReport = null
}: {
  input?: Record<string, unknown>;
  runtimeState?: Record<string, unknown>;
  summary?: string;
  messagesToKeep?: unknown[];
  reinjection?: unknown;
  tokenReport?: Record<string, unknown> | null;
} = {}) : QualityReport {
  const requiredAnchors: RequiredAnchor[] = normalizeRequiredAnchors(input, runtimeState);
  const retainedRawText: string = retainedTextForQuality({ summary, messagesToKeep, reinjection: asObject(reinjection) });
  const retainedText: string = normalizeText(retainedRawText).toLowerCase();
  const retained: RequiredAnchor[] = [];
  const missing: RequiredAnchor[] = [];
  for (const anchor of requiredAnchors) {
    const matched: boolean = Boolean(anchor.text && retainedText.includes(normalizeText(anchor.text).toLowerCase()));
    (matched ? retained : missing).push(anchor);
  }
  const secretMatches: string[] = findSensitiveCompactionLeaks(retainedRawText);
  const minimumRetentionRatio: number = clampNumber(
    asObject(input.compactionQuality).minimumRetentionRatio,
    1,
    0,
    1
  );
  const retentionRatio: number = requiredAnchors.length
    ? Number((retained.length / requiredAnchors.length).toFixed(6))
    : 1;
  return {
    protocolVersion: "v0.0.1:agent:context-compaction-quality-1",
    requiredAnchorCount: requiredAnchors.length,
    retainedAnchorCount: retained.length,
    missingAnchorCount: missing.length,
    retentionRatio,
    minimumRetentionRatio,
    missingAnchors: missing.slice(0, 20),
    retainedAnchors: retained.slice(0, 20),
    secretLeakCount: secretMatches.length,
    compressionSavingsRatio: Number(asObject(tokenReport).savingsRatio || 0),
    passed: retentionRatio >= minimumRetentionRatio && secretMatches.length === 0
  };
}

interface MessageSummaryNote {
  id: string;
  role: string;
  apiRoundId: string;
  toolIds: string[];
  summary: string;
}

export function buildDeterministicSummary({
  messages = [],
  runtimeState = {},
  targetTokens,
  compactedRange = {}
}: {
  messages?: NormalizedMessage[];
  runtimeState?: Record<string, unknown>;
  targetTokens?: unknown;
  compactedRange?: Record<string, unknown>;
}) : DeterministicSummary {
  const facts: StructuredFacts = collectStructuredFacts(messages, runtimeState);
  const messageSummaries: MessageSummaryNote[] = messages.slice(-60).map((message: NormalizedMessage) : MessageSummaryNote => {
    const lines: string[] = selectImportantLines(message.text, 4);
    const toolIds: string[] = [...toolUseIds(message), ...toolResultIds(message)];
    return {
      id: message.id,
      role: message.role,
      apiRoundId: message.apiRoundId,
      toolIds,
      summary: compactToBudget(lines.join("\n") || message.text, 180)
    };
  }).filter((item: MessageSummaryNote) : boolean => Boolean(item.summary || item.toolIds.length > 0));
  const structured: Record<string, unknown> = {
    kind: "context_compaction_summary",
    sourceRange: compactedRange,
    taskBrief: runtimeState.taskBrief || runtimeState.task || "",
    activePlan: runtimeState.activePlan || null,
    facts,
    messages: messageSummaries
  };
  const summary: string = [
    "Context compaction summary. This is auxiliary memory, not canonical evidence.",
    `Source range: ${compactedRange.startMessageId || ""}..${compactedRange.endMessageId || ""}`,
    runtimeState.taskBrief ? `Current task: ${runtimeState.taskBrief}` : "",
    facts.constraints.length ? `Constraints:\n- ${facts.constraints.map(redactText).join("\n- ")}` : "",
    facts.decisions.length ? `Decisions:\n- ${facts.decisions.map(redactText).join("\n- ")}` : "",
    facts.risks.length ? `Risks/errors:\n- ${facts.risks.map(redactText).join("\n- ")}` : "",
    facts.todos.length ? `Open items:\n- ${facts.todos.map(redactText).join("\n- ")}` : "",
    facts.evidenceRefs.length ? `Evidence/source refs: ${facts.evidenceRefs.join(", ")}` : "",
    facts.fileRefs.length ? `File refs: ${facts.fileRefs.join(", ")}` : "",
    facts.gatewayRefs.length ? `Gateway refs: ${facts.gatewayRefs.join(", ")}` : "",
    "Message notes:",
    ...messageSummaries.slice(-24).map((item: MessageSummaryNote) : string => `- [${item.role} ${item.id}] ${item.summary}`)
  ].filter(Boolean).join("\n");
  return {
    summary: compactToBudget(summary, targetTokens),
    structured: redactCompactionValue(structured)
  };
}

export function parseModelSummary(value?: unknown) : ModelSummary {
  const container: Record<string, unknown> = value && typeof value === "object" ? asObject(value) : {};
  const text: string = String(container.summary || container.answer || container.text || value || "").trim();
  if (!text) {
    throw new Error("model_compaction_empty");
  }
  const fenced: string | undefined = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate: string = fenced || text.match(/\{[\s\S]*\}/)?.[0] || "";
  if (!candidate) {
    throw new Error("model_compaction_json_missing");
  }
  const parsed: unknown = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model_compaction_schema_invalid");
  }
  const parsedRecord: Record<string, unknown> = parsed as Record<string, unknown>;
  if (typeof parsedRecord.summary !== "string" || !parsedRecord.summary.trim()) {
    throw new Error("model_compaction_summary_missing");
  }
  return {
    summary: parsedRecord.summary,
    structured: parsedRecord
  };
}

export function messagesByApiRound(messages: NormalizedMessage[] = []) : ApiRoundGroup[] {
  const groups: ApiRoundGroup[] = [];
  let current: ApiRoundGroup | null = null;
  for (const [messageIndex, message] of messages.entries()) {
    if (!current || current.apiRoundId !== message.apiRoundId) {
      current = {
        apiRoundId: message.apiRoundId,
        messages: [],
        start: messageIndex,
        end: -1,
        totalTokens: 0
      };
      groups.push(current);
    }
    current.messages.push(message);
    current.end = current.start + current.messages.length;
    current.totalTokens += Math.max(1, Number(message.tokenEstimate) || estimateContextTokens(message.text || ""));
  }
  return groups;
}

export function createApiRoundSelectionIndex(messages: NormalizedMessage[] = []) : ApiRoundSelectionIndex {
  const groups: ApiRoundGroup[] = messagesByApiRound(messages);
  const suffixTokens: number[] = Array.from({ length: groups.length + 1 }, () : number => 0);
  for (let index: number = groups.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = suffixTokens[index + 1] + Math.max(0, Number(groups[index].totalTokens) || 0);
  }
  return Object.freeze({ groups, suffixTokens });
}

function selectApiRoundSuffix(selectionIndex: ApiRoundSelectionIndex, maxInputTokens = 0, minimumGroupIndex = 0) : SelectedApiRoundSuffix {
  const groups: ApiRoundGroup[] = selectionIndex.groups;
  const suffixTokens: number[] = selectionIndex.suffixTokens;
  let low: number = Math.max(0, Math.min(groups.length, Number(minimumGroupIndex) || 0));
  let high: number = groups.length;
  while (low < high) {
    const middle: number = low + Math.floor((high - low) / 2);
    if (suffixTokens[middle] <= maxInputTokens) high = middle;
    else low = middle + 1;
  }
  return {
    startGroupIndex: low,
    totalTokens: suffixTokens[low],
    messages: low < groups.length ? groups.slice(low).flatMap((group: ApiRoundGroup) : NormalizedMessage[] => group.messages) : []
  };
}

export function modelInputForAttempt(
  messages: NormalizedMessage[] = [],
  attempt = 0,
  maxInputTokens = 0,
  selectionIndex: ApiRoundSelectionIndex | null = null
) : NormalizedMessage[] {
  if (!Number.isFinite(Number(maxInputTokens)) || Number(maxInputTokens) <= 0) {
    return [];
  }
  const index: ApiRoundSelectionIndex = selectionIndex || createApiRoundSelectionIndex(messages);
  const groups: ApiRoundGroup[] = index.groups;
  return selectApiRoundSuffix(index, maxInputTokens, Math.min(Math.max(0, Number(attempt) || 0), Math.max(0, groups.length - 1))).messages;
}

export function workbenchInputForAttempt(
  messages: NormalizedMessage[] = [],
  attempt = 0,
  maxInputTokens = 0,
  trimRatio = 0,
  selectionIndex: ApiRoundSelectionIndex | null = null
) : WorkbenchInputResult {
  const index: ApiRoundSelectionIndex = selectionIndex || createApiRoundSelectionIndex(messages);
  const groups: ApiRoundGroup[] = index.groups;
  if (!Number.isFinite(Number(maxInputTokens)) || Number(maxInputTokens) <= 0) {
    return {
      messages: [],
      metadata: { droppedGroupCount: groups.length, trimRatio, inputTokens: 0 }
    };
  }
  let minimumGroupIndex: number = 0;
  if (attempt > 0 && groups.length > 1) {
    minimumGroupIndex = Math.min(
      groups.length - 1,
      Math.max(1, Math.ceil(groups.length * trimRatio * attempt))
    );
  }
  const selectedSuffix: SelectedApiRoundSuffix = selectApiRoundSuffix(index, maxInputTokens, minimumGroupIndex);
  const selected: NormalizedMessage[] = selectedSuffix.messages;
  return {
    messages: selected,
    metadata: {
      droppedGroupCount: selectedSuffix.startGroupIndex,
      trimRatio,
      inputTokens: selectedSuffix.totalTokens
    }
  };
}

export function buildModelPrompt({ messages, runtimeState, targetTokens, compactedRange }: {
  messages: NormalizedMessage[];
  runtimeState: Record<string, unknown>;
  targetTokens: number;
  compactedRange: Record<string, unknown>;
}) : string {
  const payload: Record<string, unknown>[] = messages.map((message: NormalizedMessage) : Record<string, unknown> => ({
    id: message.id,
    role: message.role,
    apiRoundId: message.apiRoundId,
    text: redactText(message.text),
    toolUseIds: toolUseIds(message),
    toolResultIds: toolResultIds(message)
  }));
  return [
    "You are Meshrix.js ContextCompactionRuntime.",
    "Compress context only. Do not invent facts. The output is auxiliary memory, not canonical evidence.",
    "Preserve user constraints, decisions, errors, TODOs, evidence/source ids, dates, amounts, file refs, tool call ids, and gateway references.",
    "Return strict JSON with keys: summary, constraints, decisions, risks, todos, evidenceRefs, fileRefs, gatewayRefs.",
    `Target tokens: ${targetTokens}`,
    `Source range: ${compactedRange.startMessageId || ""}..${compactedRange.endMessageId || ""}`,
    runtimeState.taskBrief ? `Current task: ${redactText(runtimeState.taskBrief)}` : "",
    JSON.stringify(payload)
  ].filter(Boolean).join("\n");
}

interface ReinjectionCandidate {
  key: string;
  value: unknown;
  priority: number;
}

export function buildReinjectionPayload({ input = {}, runtimeState = {}, policy }: {
  input?: Record<string, unknown>;
  runtimeState?: Record<string, unknown>;
  policy: CompactionPolicy;
}) : ReinjectionPayload {
  const source: Record<string, unknown> = {
    ...asObject(input.runtimeState),
    ...runtimeState
  };
  const candidates: ReinjectionCandidate[] = [
    { key: "taskBrief", value: redactCompactionValue(source.taskBrief || input.taskBrief || input.task || input.query || ""), priority: 100 },
    { key: "activePlan", value: redactCompactionValue(source.activePlan || input.activePlan || input.plan || ""), priority: 95 },
    { key: "activeSkill", value: redactCompactionValue(source.activeSkill || input.activeSkill || ""), priority: 88 },
    { key: "activeToolUseIds", value: redactCompactionValue(source.activeToolUseIds || input.activeToolUseIds || ""), priority: 84 },
    { key: "openToolCalls", value: redactCompactionValue(source.openToolCalls || input.openToolCalls || ""), priority: 82 },
    { key: "enabledTools", value: redactCompactionValue(source.enabledTools || input.enabledTools || input.tools || ""), priority: 80 },
    { key: "operationCatalog", value: redactCompactionValue(source.operationCatalog || input.operationCatalog || ""), priority: 75 },
    { key: "currentFiles", value: redactCompactionValue(source.currentFiles || input.currentFiles || ""), priority: 70 },
    { key: "fileAttachments", value: redactCompactionValue(source.fileAttachments || input.fileAttachments || ""), priority: 68 },
    { key: "gatewayReference", value: redactCompactionValue(source.gatewayReference || input.gatewayReference || ""), priority: 65 },
    { key: "mcpServers", value: redactCompactionValue(source.mcpServers || input.mcpServers || ""), priority: 64 },
    { key: "deferredToolDeltas", value: redactCompactionValue(source.deferredToolDeltas || input.deferredToolDeltas || ""), priority: 62 },
    { key: "maintenanceRun", value: redactCompactionValue(source.maintenanceRun || input.maintenanceRun || ""), priority: 60 },
    { key: "recentError", value: redactCompactionValue(source.recentError || input.recentError || ""), priority: 55 },
    { key: "worktreeState", value: redactCompactionValue(source.worktreeState || input.worktreeState || ""), priority: 54 },
    { key: "userConstraints", value: redactCompactionValue(source.userConstraints || input.userConstraints || ""), priority: 50 }
  ]
    .filter((item: ReinjectionCandidate) : boolean => Boolean(item.value && estimateContextTokens(item.value) > 1));

  const selected: ReinjectionItem[] = [];
  const dropped: ReinjectionDroppedItem[] = [];
  let usedTokens: number = 0;
  for (const item of candidates.sort((left: ReinjectionCandidate, right: ReinjectionCandidate) : number => right.priority - left.priority)) {
    const tokens: number = estimateContextTokens(item.value);
    if (usedTokens + tokens > Number(policy.reinjectionBudgetTokens || 0)) {
      dropped.push({ key: item.key, reason: "reinjection_budget_exceeded", tokens });
      continue;
    }
    selected.push({ key: item.key, value: item.value, tokens, priority: item.priority });
    usedTokens += tokens;
  }
  return {
    items: selected,
    usedTokens,
    dropped,
    degraded: dropped.length > 0,
    budgetTokens: Number(policy.reinjectionBudgetTokens || 0)
  };
}

export function dehydrateAttachment(attachment: Record<string, unknown> = {}, policy: CompactionPolicy) : DehydratedAttachment {
  const ref: unknown = attachment.ref || attachment.artifactRef || attachment.path || attachment.url || attachment.name || attachment.fileName || "";
  const summary: string = compactToBudget(
    attachment.summary || attachment.text || attachment.description || JSON.stringify(attachment),
    Number(policy.maxAttachmentTokens || 0)
  );
  return {
    type: String(attachment.type || attachment.mediaType || "attachment"),
    name: String(attachment.name || attachment.fileName || ""),
    ref: redactText(String(ref || "")),
    checksum: String(attachment.checksum || attachment.sha256 || hashValue({ ref, summary }, 16)),
    summary,
    dehydrated: true
  };
}

export function isHeavyContentBlock(value: Record<string, unknown> = {}) : boolean {
  const block: Record<string, unknown> = asObject(value);
  const type: string = String(block.type || block.mediaType || block.kind || "").toLowerCase();
  return /image|document|attachment|binary|pdf|audio|video/.test(type) ||
    Boolean(block.data || block.dataBase64 || block.base64 || block.bytes || block.buffer);
}

export function dehydrateContentBlock(block: Record<string, unknown> = {}, policy: CompactionPolicy) : DehydratedContentBlock {
  const source: Record<string, unknown> = asObject(block);
  const ref: unknown = source.ref || source.path || source.url || source.name || source.fileName || "";
  const originalType: string = String(source.type || source.mediaType || source.kind || "attachment");
  const summary: string = compactToBudget(
    source.summary || source.text || source.description || source.title || JSON.stringify({
      type: originalType,
      name: source.name || source.fileName || "",
      ref
    }),
    Number(policy.maxAttachmentTokens || 0)
  );
  return {
    type: "dehydrated_payload",
    originalType,
    name: String(source.name || source.fileName || ""),
    ref: redactText(String(ref || "")),
    checksum: String(source.checksum || source.sha256 || hashValue({ originalType, ref, summary }, 16)),
    summary,
    dehydrated: true
  };
}

export function stripHeavyPayloadsFromMessage(message: Record<string, unknown> = {}, policy: CompactionPolicy) : StrippedMessageResult {
  let strippedBlockCount: number = 0;
  let dehydratedAttachmentCount: number = 0;
  const next: Record<string, unknown> = {
    ...message,
    text: redactEmbeddedPayloads(message.text || "")
  };

  if (Array.isArray(message.content)) {
    next.content = message.content.map((item?: unknown) : unknown => {
      if (isHeavyContentBlock(asObject(item))) {
        strippedBlockCount += 1;
        return dehydrateContentBlock(asObject(item), policy);
      }
      if (typeof item === "string") {
        return redactEmbeddedPayloads(item);
      }
      const source = asObject(item);
      if (Object.keys(source).length > 0) {
        return {
          ...source,
          text: source.text ? redactEmbeddedPayloads(String(source.text)) : source.text,
          content: typeof source.content === "string" ? redactEmbeddedPayloads(source.content) : source.content
        };
      }
      return item;
    });
  } else if (typeof message.content === "string") {
    next.content = redactEmbeddedPayloads(message.content);
  } else if (isHeavyContentBlock(asObject(message.content))) {
    strippedBlockCount += 1;
    next.content = dehydrateContentBlock(asObject(message.content), policy);
  }

  if (Array.isArray(message.blocks)) {
    next.blocks = message.blocks.map((block?: unknown) : unknown => {
      if (isHeavyContentBlock(asObject(block))) {
        strippedBlockCount += 1;
        return dehydrateContentBlock(asObject(block), policy);
      }
      const source = asObject(block);
      if (Object.keys(source).length > 0) {
        return {
          ...source,
          text: source.text ? redactEmbeddedPayloads(String(source.text)) : source.text,
          content: typeof source.content === "string" ? redactEmbeddedPayloads(source.content) : source.content
        };
      }
      return block;
    });
  }

  if (Array.isArray(message.attachments)) {
    next.attachments = message.attachments.map((attachment?: unknown) : unknown => {
      if (isHeavyContentBlock(asObject(attachment)) || estimateContextTokens(attachment) > Number(policy.maxAttachmentTokens || 0)) {
        dehydratedAttachmentCount += 1;
        return dehydrateAttachment(asObject(attachment), policy);
      }
      return attachment;
    });
  }

  const normalized: NormalizedMessage = normalizeMessage(next, Number(message.index || 0));
  return {
    message: {
      ...normalized,
      index: Number(message.index ?? normalized.index),
      apiRoundId: String(message.apiRoundId ?? normalized.apiRoundId),
      id: String(message.id ?? normalized.id)
    },
    strippedBlockCount,
    dehydratedAttachmentCount
  };
}

export function prepareWorkbenchMessages(messages: NormalizedMessage[] = [], policy: CompactionPolicy) : WorkbenchPreparation {
  const prepared: NormalizedMessage[] = [];
  let strippedBlockCount: number = 0;
  let dehydratedAttachmentCount: number = 0;
  for (const message of messages) {
    const result: StrippedMessageResult = stripHeavyPayloadsFromMessage(message, policy);
    strippedBlockCount += result.strippedBlockCount;
    dehydratedAttachmentCount += result.dehydratedAttachmentCount;
    prepared.push(result.message);
  }
  const originalTokens: number = messages.reduce((total: number, message: NormalizedMessage) : number => total + Math.max(1, Number(message.tokenEstimate) || 0), 0);
  const preparedTokens: number = prepared.reduce((total: number, message: NormalizedMessage) : number => total + Math.max(1, Number(message.tokenEstimate) || 0), 0);
  return {
    messages: prepared,
    strippedBlockCount,
    dehydratedAttachmentCount,
    changedCount: strippedBlockCount + dehydratedAttachmentCount,
    originalTokens,
    preparedTokens,
    savedTokens: Math.max(0, originalTokens - preparedTokens)
  };
}

export function summarizeToolResult(message: Record<string, unknown> = {}, policy: CompactionPolicy) : NormalizedMessage {
  const text: string = compactToBudget(message.text || "", Number(policy.maxToolResultTokens || 0));
  return {
    ...normalizeMessage({
      ...message,
      content: `[tool_result dehydrated: ${text}]`,
      text,
      dehydrated: true,
      originalTokenEstimate: message.tokenEstimate
    }, Number(message.index || 0)),
    tokenEstimate: Math.min(Number(message.tokenEstimate), Number(policy.maxToolResultTokens || 0))
  };
}

export function microCompactMessages(
  messages: NormalizedMessage[] = [],
  { policy, activeToolUseIds = [] }: { policy?: CompactionPolicy; activeToolUseIds?: unknown[] } = {}
) : MicroCompactionResult {
  if (!policy?.microCompaction) {
    return {
      messages,
      changedCount: 0,
      dehydratedAttachments: []
    };
  }
  const activeSet: Set<string> = new Set<string>(asArray(activeToolUseIds).map((item?: unknown) : string => String(item)));
  const protectedStart: number = Math.max(0, messages.length - Number(policy.recentMessageProtectionCount || 0));
  const dehydratedAttachments: DehydratedAttachment[] = [];
  const compacted: NormalizedMessage[] = messages.map((message: NormalizedMessage, index: number) : NormalizedMessage => {
    let next: NormalizedMessage = message;
    const messageToolIds: string[] = [...toolUseIds(message), ...toolResultIds(message)];
    const isProtected: boolean = index >= protectedStart ||
      messageToolIds.some((id: string) : boolean => activeSet.has(id)) ||
      (/error|failed|failure|异常|失败/i.test(message.text) && index >= Math.max(0, messages.length - Number(policy.recentMessageProtectionCount || 0) * 2));

    if (!isProtected && (message.role === "tool" || message.type === "tool_result") && message.tokenEstimate > Number(policy.maxToolResultTokens || 0)) {
      next = summarizeToolResult(message, policy);
    }

    if (policy.allowAttachmentDehydration && asArray(next.attachments).length) {
      const attachments: unknown[] = asArray(next.attachments).map((attachment?: unknown) : unknown => {
        const tokens: number = estimateContextTokens(attachment);
        if (tokens <= Number(policy.maxAttachmentTokens || 0)) {
          return attachment;
        }
        const dehydrated: DehydratedAttachment = dehydrateAttachment(asObject(attachment), policy);
        dehydratedAttachments.push(dehydrated);
        return dehydrated;
      });
      next = {
        ...next,
        attachments
      };
    }
    return next;
  });
  const changedCount: number = compacted.filter((message: NormalizedMessage, index: number) : boolean => message !== messages[index]).length;
  return {
    messages: compacted,
    changedCount,
    dehydratedAttachments
  };
}
