import path from "node:path";
import crypto from "node:crypto";
import {
  CONTEXT_COMPACTION_PROTOCOL_VERSION,
  createContextCompactionRuntime,
} from "../context-compact/index.ts";
import {
  asArray,
  asObject,
  compactText,
  estimateTokens,
  hashText,
  normalizeStringArray,
} from "./validation.ts";
import { assertContextProfileComplete, normalizeProfiles } from "./profile.ts";
import {
  citationsFromEvidence,
  collectProtectedEvidenceIds,
  computeBudgets,
  criticalEvidenceIndex,
  evidenceIdOf,
  normalizeEvidenceItem,
  normalizeExpertGuidance,
  normalizeMemoryBlocks,
  sectionTokenReport,
  selectByBudget,
  selectEvidenceByBudget,
  selectRecentTurnsByBudget,
  summarizeToolState,
  tokenize,
  workspaceSnapshot,
} from "./projection.ts";
import { createContextCoreStorage } from "./storage.ts";
import type {
  ContextProfile,
  EvidenceSource,
  ExpertGuidance,
  NormalizedEvidence,
  RuntimeRecord,
} from "./types.ts";

interface ModelCompressionResult extends RuntimeRecord {
  used: boolean;
  degraded: boolean;
  summary: string;
  error: string;
}

interface ModelCompressorResponse extends RuntimeRecord {
  summary?: unknown;
  answer?: unknown;
  text?: unknown;
}

type ModelCompressor = (
  input: RuntimeRecord,
) => ModelCompressorResponse | Promise<ModelCompressorResponse>;

interface AgentMemory {
  protocolVersion: string;
  rootPath: string;
  sessionMemoryPath: string;
  latestSessionMemory(query?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  appendSessionMemory(entry?: Record<string, unknown>): Promise<Record<string, unknown>>;
  listSessionMemory(query?: Record<string, unknown>): Promise<Record<string, unknown>>;
  clearSessionMemory(query?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface ContextRuntimeOptions {
  userDataPath: string;
  modelCompressor?: ModelCompressor | null;
  agentMemory?: AgentMemory | null;
  strategies?: ContextStrategy[];
  compactionStrategies?: ContextStrategy[];
}

interface ContextStrategy extends RuntimeRecord {
  id: string;
  label?: string;
  run?: (...args: unknown[]) => unknown | Promise<unknown>;
}

interface CompactionRuntime {
  run(input: RuntimeRecord): Promise<RuntimeRecord>;
  preview(input: RuntimeRecord): Promise<RuntimeRecord>;
  maybeCompact(input: RuntimeRecord): Promise<RuntimeCompaction>;
  listRecords(input: RuntimeRecord): Promise<RuntimeRecord>;
  listStrategies(): Promise<RuntimeRecord[]>;
  listSessionMemory(input: RuntimeRecord): Promise<RuntimeRecord>;
  clearSessionMemory(input: RuntimeRecord): Promise<RuntimeRecord>;
}

interface RuntimeCompaction extends RuntimeRecord {
  status: string;
  compacted: boolean;
  summary?: string;
  strategy?: string | RuntimeRecord | null;
  executionMode?: string;
  triggerReason?: string;
  degraded?: boolean;
  degradedReasons?: unknown[];
  boundary?: { boundaryId?: string } | null;
  tokenReport?: RuntimeRecord | null;
  circuitBreaker?: RuntimeRecord | null;
}

interface ContextPack extends RuntimeRecord {
  profileId: string;
  evidencePack: NormalizedEvidence[];
  citations: unknown[];
  expertGuidance: ExpertGuidance[];
  compressedHistory: string;
  privateSummary: string;
  criticalEvidenceIndex: RuntimeRecord[];
  retrievedReferences: NormalizedEvidence[];
  contextBuildRecordId: string;
  tailChecklist: { evidenceIds: string[]; [key: string]: unknown };
  budgetReport?: RuntimeRecord;
}

interface EvaluationResult {
  requiredEvidenceRecall: number;
  totalTokens: number;
  [key: string]: unknown;
}

const COMPACTION_RUNTIME_METHODS = [
  "run",
  "preview",
  "maybeCompact",
  "listRecords",
  "listStrategies",
  "listSessionMemory",
  "clearSessionMemory",
] as const;

function requireCompactionRuntime(value: unknown): CompactionRuntime {
  if (
    !value ||
    typeof value !== "object" ||
    !COMPACTION_RUNTIME_METHODS.every(
      (method) => typeof (value as RuntimeRecord)[method] === "function",
    )
  ) {
    throw new TypeError("Context compaction runtime is incomplete.");
  }
  return value as CompactionRuntime;
}

export const CONTEXT_RUNTIME_PROTOCOL_VERSION = "v0.0.1:agent:context-1";
export { estimateTokens } from "./validation.ts";

export function createContextRuntime({
  userDataPath,
  modelCompressor = null,
  agentMemory = null,
  strategies = [],
  compactionStrategies = [],
}: ContextRuntimeOptions) {
  const rootPath = path.join(userDataPath, "context-core");
  const profilesPath = path.join(rootPath, "context-profiles.json");
  const buildRecordsPath = path.join(rootPath, "context-build-records.jsonl");
  const evaluationRunsPath = path.join(
    rootPath,
    "context-evaluation-runs.jsonl",
  );
  const compactionRuntime = requireCompactionRuntime(
    createContextCompactionRuntime({
      userDataPath,
      modelCompressor,
      agentMemory,
      strategies,
      compactionStrategies,
    }),
  );
  const storage = createContextCoreStorage({
    profilesPath,
    buildRecordsPath,
    evaluationRunsPath,
    protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
    normalizeProfiles,
  });
  const {
    readProfiles,
    listProfiles,
    saveProfiles,
    listBuildRecords,
    writeBuildRecord,
    appendEvaluationRun,
  } = storage;

  async function resolveProfile(
    input: RuntimeRecord = {},
  ): Promise<ContextProfile> {
    const profiles = await readProfiles();
    const explicitTarget = String(input.contextProfileId || "").trim();
    const target = explicitTarget;
    if (!target) {
      throw new Error(
        "contextProfileId is required; no context profile is configured for this request.",
      );
    }
    const profile = profiles.find((profile) => profile.profileId === target);
    if (!profile) {
      throw new Error(`Configured context profile was not found: ${target}`);
    }
    return assertContextProfileComplete(profile);
  }

  async function compact(input: RuntimeRecord = {}): Promise<RuntimeRecord> {
    const profile = await resolveProfile(input);
    if (
      Array.isArray(input.messages) ||
      Array.isArray(input.transcript) ||
      input.runtimeState ||
      input.force === true
    ) {
      return compactionRuntime.run({
        ...input,
        profile,
      });
    }
    const requestedTarget =
      input.targetTokens === undefined ||
      input.targetTokens === null ||
      input.targetTokens === ""
        ? Number(profile.compression.summaryMaxTokens)
        : Number(input.targetTokens);
    if (!Number.isFinite(requestedTarget) || requestedTarget <= 0) {
      throw new Error(
        `Configured context profile is incomplete: ${profile.profileId}:compression.summaryMaxTokens`,
      );
    }
    const configuredMaximum = Number(profile.compression.summaryMaxTokens);
    if (!Number.isFinite(configuredMaximum) || configuredMaximum <= 0) {
      throw new Error(
        `Configured context profile is incomplete: ${profile.profileId}:compression.summaryMaxTokens`,
      );
    }
    const targetTokens = Math.min(requestedTarget, configuredMaximum);
    const sourceText = String(input.text || input.content || "");
    const summary = compactText(sourceText, targetTokens);
    return {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      profileId: profile.profileId,
      strategy: profile.compression.strategy,
      sourceTokens: estimateTokens(sourceText),
      summaryTokens: estimateTokens(summary),
      summary,
    };
  }

  async function previewCompaction(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    const profile = await resolveProfile(input);
    return compactionRuntime.preview({
      ...input,
      profile,
    });
  }

  async function runCompaction(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    const profile = await resolveProfile(input);
    return compactionRuntime.run({
      ...input,
      profile,
    });
  }

  async function listCompactionRecords(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    return compactionRuntime.listRecords(input);
  }

  async function listCompactionStrategies(): Promise<RuntimeRecord[]> {
    return compactionRuntime.listStrategies();
  }

  async function listSessionMemory(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    return compactionRuntime.listSessionMemory(input);
  }

  async function clearSessionMemory(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    return compactionRuntime.clearSessionMemory(input);
  }

  async function modelCompressText({
    profile,
    text,
    targetTokens,
    kind,
    citations = [],
  }: {
    profile: ContextProfile;
    text: unknown;
    targetTokens: number;
    kind: string;
    citations?: string[];
  }): Promise<ModelCompressionResult> {
    const sourceText = String(text || "");
    const maxInputTokens = Number(profile.modelCompression.maxInputTokens);
    const modelInputText = compactText(sourceText, maxInputTokens);
    if (
      !sourceText ||
      profile.modelCompression.enabled !== true ||
      typeof modelCompressor !== "function" ||
      Number(profile.modelCompression.maxOutputTokens || 0) <= 0 ||
      ![
        "model-assisted",
        "workbench-reconstruction",
        "session-memory-first",
      ].includes(profile.compression.mode)
    ) {
      return {
        used: false,
        degraded: false,
        summary: compactText(sourceText, targetTokens),
        error: "",
      };
    }
    try {
      const prompt = [
        "你是 Meshrix.js 本地上下文压缩器。只压缩上下文，不新增事实。",
        "必须保留 evidenceId、文件路径、日期、金额、冲突和人类专家意见。",
        "如果输入中存在引用编号，输出必须保留原编号。",
        `压缩对象：${kind}`,
        `目标 token：${targetTokens}`,
        citations.length ? `必须保护的引用：${citations.join(", ")}` : "",
        "",
        modelInputText,
      ]
        .filter(Boolean)
        .join("\n");
      const response = await modelCompressor({
        profile,
        kind,
        text: modelInputText,
        targetTokens,
        citations,
        prompt,
      });
      const summary = String(
        response?.summary || response?.answer || response?.text || "",
      ).trim();
      if (!summary) {
        throw new Error("模型压缩没有返回摘要。");
      }
      return {
        used: true,
        degraded: false,
        summary: compactText(summary, targetTokens),
        error: "",
      };
    } catch (error: unknown) {
      if (profile.modelCompression.fallback !== "deterministic-extractive") {
        throw error;
      }
      return {
        used: false,
        degraded: true,
        summary: compactText(sourceText, targetTokens),
        error:
          error instanceof Error ? error.message : "model_compression_failed",
      };
    }
  }

  function compactionMessagesFromAssembleInput(
    input: RuntimeRecord = {},
  ): RuntimeRecord[] {
    if (Array.isArray(input.messages) || Array.isArray(input.transcript)) {
      return asArray<RuntimeRecord>(input.messages || input.transcript);
    }
    const messages: RuntimeRecord[] = [];
    if (input.history || input.compressedHistory) {
      messages.push({
        id: "history",
        role: "system",
        apiRoundId: "history",
        content: input.history || input.compressedHistory,
      });
    }
    for (const [index, turn] of asArray<RuntimeRecord>(
      input.recentTurns,
    ).entries()) {
      messages.push({
        ...turn,
        id: turn.id || turn.messageId || `recent-${index + 1}`,
        apiRoundId:
          turn.apiRoundId ||
          turn.roundId ||
          `recent-round-${Math.floor(index / 2) + 1}`,
      });
    }
    if (input.toolState && Object.keys(asObject(input.toolState)).length) {
      messages.push({
        id: "tool-state",
        role: "tool",
        apiRoundId: "tool-state",
        content: input.toolState,
      });
    }
    return messages;
  }

  async function assemble(input: RuntimeRecord = {}): Promise<ContextPack> {
    const profile = await resolveProfile(input);
    const budgets = computeBudgets(profile);
    const taskBrief = String(
      input.taskBrief || input.task || input.query || "",
    ).trim();
    const queryTokens = tokenize(taskBrief);
    const sharedSnapshot = workspaceSnapshot(asObject(input.workspaceState));
    const privateState = asObject(input.privateState);
    const runtimeState = asObject(input.runtimeState);
    const workspaceContext = asObject(input.workspaceContext);
    const privateText = String(
      input.privateSummary || privateState.summary || "",
    );
    const memoryBlocks = normalizeMemoryBlocks(input, budgets.fixedMemory);
    const expertGuidance = selectByBudget<ExpertGuidance>(
      normalizeExpertGuidance(input),
      budgets.expertGuidance,
      (item) =>
        `${item.label}\n${item.instruction}\n${item.reason}\n${item.evidenceRefs?.join(",") || ""}`,
    );
    const protectedEvidenceIds = collectProtectedEvidenceIds(
      input,
      expertGuidance.selected,
    );
    const normalizedEvidence = asArray<EvidenceSource>(
      input.retrievedEvidence || input.evidence || [],
    )
      .map((item) => normalizeEvidenceItem(item, { queryTokens, profile }))
      .sort((left, right) => right.score - left.score);
    const selectedEvidence = selectEvidenceByBudget(
      normalizedEvidence,
      budgets.reference,
      protectedEvidenceIds,
      (item) =>
        [
          item.evidenceId,
          item.title,
          item.snippet,
          JSON.stringify(item.protectedFacts),
          JSON.stringify(item.sourceLocator),
        ].join("\n"),
    );
    const evidencePack = selectedEvidence.selected.map((item) => ({
      evidenceId: item.evidenceId,
      title: item.title,
      sourceLocator: item.sourceLocator,
      snippet: item.snippet,
      protectedFacts: item.protectedFacts,
      confidence: item.confidence,
      humanConfirmed: item.humanConfirmed,
      protectedEvidence: item.protectedEvidence === true,
      protectionReason: item.protectionReason || "",
      hierarchyLevel: item.hierarchyLevel,
      score: item.score,
      scoreBreakdown: item.scoreBreakdown,
    }));
    const recentTurns = selectRecentTurnsByBudget(
      input.recentTurns || [],
      budgets.recentTurns,
      profile.compression.protectLastNTurns,
    );
    let compressedHistory = compactText(
      String(input.history || input.compressedHistory || ""),
      budgets.history,
    );
    const privateSummary = compactText(
      privateText || JSON.stringify(input.privateState || {}),
      budgets.history,
    );
    const modelCompressionEvents: Array<
      RuntimeRecord & { used: boolean; degraded: boolean }
    > = [];
    const protectedCitationIds = [
      ...protectedEvidenceIds,
      ...selectedEvidence.selected.map((item) => item.evidenceId),
      ...expertGuidance.selected.flatMap((item) => item.evidenceRefs || []),
    ].filter(Boolean);
    const historyCompression = await modelCompressText({
      profile,
      text: compressedHistory,
      targetTokens: budgets.history,
      kind: "history",
      citations: protectedCitationIds,
    });
    compressedHistory = historyCompression.summary;
    if (historyCompression.used || historyCompression.degraded) {
      modelCompressionEvents.push({
        kind: "history",
        ...historyCompression,
        summary: undefined,
      });
    }
    let toolStateSummary = summarizeToolState(
      asObject(input.toolState),
      budgets.toolState,
    );
    const toolCompression = await modelCompressText({
      profile,
      text: toolStateSummary.compactText,
      targetTokens: budgets.toolState,
      kind: "tool_state",
      citations: protectedCitationIds,
    });
    toolStateSummary = {
      ...toolStateSummary,
      compactText: toolCompression.summary,
    };
    if (toolCompression.used || toolCompression.degraded) {
      modelCompressionEvents.push({
        kind: "tool_state",
        ...toolCompression,
        summary: undefined,
      });
    }
    const compactionMessages = compactionMessagesFromAssembleInput(input);
    let runtimeCompaction: RuntimeCompaction = {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      status: "skipped",
      compacted: false,
      triggerReason: "no_messages",
    };
    if (compactionMessages.length) {
      const compactionSessionId = String(
        input.sessionId || input.conversationId || input.threadId || "",
      ).trim();
      try {
        runtimeCompaction = await compactionRuntime.maybeCompact({
          profile,
          messages: compactionMessages,
          sessionId: compactionSessionId,
          inputSource: input.inputSource || "context-core",
          taskBrief,
          runtimeState: {
            ...runtimeState,
            taskBrief,
            activePlan:
              input.activePlan || input.plan || runtimeState.activePlan || null,
            enabledTools:
              input.enabledTools ||
              input.tools ||
              runtimeState.enabledTools ||
              [],
            currentFiles: input.currentFiles || runtimeState.currentFiles || [],
            gatewayReference:
              input.gatewayReference || runtimeState.gatewayReference || "",
          },
          useSessionMemory:
            Boolean(compactionSessionId) && input.useSessionMemory !== false,
          persist:
            Boolean(compactionSessionId) &&
            input.record !== false &&
            input.persistCompaction !== false,
        });
        if (runtimeCompaction.compacted && runtimeCompaction.summary) {
          compressedHistory = compactText(
            [runtimeCompaction.summary, compressedHistory]
              .filter(Boolean)
              .join("\n\n"),
            budgets.history,
          );
        }
      } catch (error: unknown) {
        runtimeCompaction = {
          protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
          status: "failed",
          compacted: false,
          degraded: true,
          error:
            error instanceof Error
              ? error.message
              : "context_compaction_failed",
        };
      }
    }
    const pack: ContextPack = {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      profileId: profile.profileId,
      workspaceContext: input.workspaceContext || null,
      workspaceGeneration: workspaceContext.currentGeneration || null,
      roleId: input.roleId || "",
      agentId: input.agentId || "",
      taskBrief,
      memoryBlocks,
      expertGuidance: expertGuidance.selected,
      criticalEvidenceIndex: criticalEvidenceIndex(evidencePack, profile),
      evidencePack,
      protectedEvidenceIds,
      sharedSnapshot,
      privateSummary,
      recentTurns: recentTurns.selected,
      retrievedReferences: evidencePack,
      compressedHistory,
      toolStateSummary,
      toolState: toolStateSummary,
      compaction: runtimeCompaction,
      citations: citationsFromEvidence(evidencePack),
      placement: {
        head: [
          "taskBrief",
          "memoryBlocks",
          "expertGuidance",
          "criticalEvidenceIndex",
        ],
        body: ["evidencePack", "toolStateSummary", "compressedHistory"],
        tail:
          profile.placementPolicy.evidenceTailChecklist === true
            ? ["recentTurns", "tailChecklist"]
            : ["recentTurns"],
      },
      tailChecklist: {
        taskBrief:
          profile.placementPolicy.repeatTaskInTail === true ? taskBrief : "",
        evidenceIds: evidencePack
          .map((item) => item.evidenceId)
          .filter(Boolean),
        requiredEvidenceIds: protectedEvidenceIds,
        rules:
          profile.placementPolicy.evidenceTailChecklist === true
            ? [
                "Use evidenceId citations exactly as supplied.",
                "Do not treat compressed summaries as canonical evidence.",
                "If required evidence is missing, say so and call tools when allowed.",
              ]
            : [],
      },
      contextBuildRecordId: "",
    };
    const sourceTokens = estimateTokens({
      taskBrief,
      systemMemory: input.systemMemory || input.memory || "",
      expertGuidance:
        input.expertGuidance || input.humanFeedback || input.feedback || [],
      retrievedEvidence: input.retrievedEvidence || input.evidence || [],
      history: input.history || input.compressedHistory || "",
      recentTurns: input.recentTurns || [],
      toolState: input.toolState || {},
    });
    let totalTokens = estimateTokens(pack);
    let compressed = false;
    const usableTokens = Math.max(
      0,
      profile.contextWindowTokens -
        profile.outputReserveTokens -
        profile.toolReserveTokens,
    );
    const thresholdTokens = Math.floor(
      profile.contextWindowTokens * profile.compression.threshold,
    );
    let compressionDroppedReferenceIds: string[] = [];
    if (profile.compression.enabled === true && totalTokens > thresholdTokens) {
      pack.compressedHistory = compactText(
        compressedHistory,
        Math.floor(profile.historyBudget * profile.compression.targetRatio),
      );
      pack.privateSummary = compactText(
        privateSummary,
        Math.floor(profile.historyBudget * profile.compression.targetRatio),
      );
      const nextReferenceBudget = Math.max(
        0,
        Math.floor(budgets.reference * profile.compression.targetRatio),
      );
      const nextReference = selectEvidenceByBudget(
        pack.evidencePack,
        nextReferenceBudget,
        protectedEvidenceIds,
      );
      pack.evidencePack = nextReference.selected;
      compressionDroppedReferenceIds = nextReference.dropped
        .map((entry) => entry.item.evidenceId)
        .filter(Boolean);
      pack.retrievedReferences = nextReference.selected;
      pack.criticalEvidenceIndex = criticalEvidenceIndex(
        pack.evidencePack,
        profile,
      );
      pack.citations = citationsFromEvidence(pack.evidencePack);
      pack.tailChecklist.evidenceIds = pack.evidencePack
        .map((item) => item.evidenceId)
        .filter(Boolean);
      totalTokens = estimateTokens(pack);
      compressed = true;
    }
    const sectionTokens = sectionTokenReport(pack);
    const droppedEvidenceIds = selectedEvidence.dropped
      .map((entry) => entry.item.evidenceId)
      .filter(Boolean)
      .concat(compressionDroppedReferenceIds);
    const record: RuntimeRecord = {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      recordId: `context-build-${crypto.randomUUID?.() || hashText(`${Date.now()}-${Math.random()}`)}`,
      createdAt: new Date().toISOString(),
      profileId: profile.profileId,
      inputSource: String(input.inputSource || input.source || "runtime"),
      roleId: pack.roleId,
      agentId: pack.agentId,
      taskBriefPreview: taskBrief.slice(0, 240),
      strategy: profile.compression.strategy,
      compressionMode: profile.compression.mode,
      modelCompressionEvents,
      runtimeCompaction: {
        status: runtimeCompaction.status,
        compacted: runtimeCompaction.compacted === true,
        strategy: runtimeCompaction.strategy || null,
        executionMode: runtimeCompaction.executionMode || "",
        triggerReason: runtimeCompaction.triggerReason || "",
        degraded: runtimeCompaction.degraded === true,
        boundaryId: runtimeCompaction.boundary?.boundaryId || "",
        tokenReport: runtimeCompaction.tokenReport || null,
      },
      triggerReason: compressed ? "threshold_exceeded" : "within_budget",
      sourceTokens,
      totalTokens,
      sectionTokens,
      budgets,
      preservedEvidenceIds: pack.evidencePack
        .map((item) => item.evidenceId)
        .filter(Boolean),
      droppedEvidenceIds,
      droppedReferenceCount: droppedEvidenceIds.length,
      droppedRecentTurnCount: recentTurns.droppedCount,
      protectedRecentTurnCount: recentTurns.protectedCount,
      protectedRecentTurnBudgetOverrun: recentTurns.protectedBudgetOverrun,
      droppedExpertGuidanceCount: expertGuidance.droppedCount,
      protectedEvidenceIds,
      protectedEvidenceCount: selectedEvidence.protectedEvidenceCount,
      protectedEvidenceBudgetOverrun:
        selectedEvidence.protectedEvidenceBudgetOverrun,
      humanExpertGuidanceCount: pack.expertGuidance.length,
      protectedEvidenceFields: profile.protectedEvidenceFields,
    };
    pack.contextBuildRecordId = String(record.recordId || "");
    pack.budgetReport = {
      contextWindowTokens: profile.contextWindowTokens,
      usableTokens,
      totalTokens,
      sourceTokens,
      thresholdTokens,
      compressed,
      compressionMode: profile.compression.mode,
      strategy: profile.compression.strategy,
      modelCompression: {
        enabled: profile.modelCompression.enabled === true,
        alias: profile.modelCompression.alias,
        used: modelCompressionEvents.some((event) => event.used),
        degraded: modelCompressionEvents.some((event) => event.degraded),
        fallback: profile.modelCompression.fallback,
        events: modelCompressionEvents,
      },
      compaction: {
        protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
        enabled: profile.compactionPolicy.enabled,
        status: runtimeCompaction.status,
        compacted: runtimeCompaction.compacted === true,
        strategy: runtimeCompaction.strategy || null,
        executionMode: runtimeCompaction.executionMode || "",
        triggerReason: runtimeCompaction.triggerReason || "",
        degraded: runtimeCompaction.degraded === true,
        degradedReasons: runtimeCompaction.degradedReasons || [],
        boundaryId: runtimeCompaction.boundary?.boundaryId || "",
        tokenReport: runtimeCompaction.tokenReport || null,
        circuitBreaker: runtimeCompaction.circuitBreaker || null,
      },
      budgets,
      sectionTokens,
      contextBuildRecordId: record.recordId,
      droppedReferenceCount: droppedEvidenceIds.length,
      droppedRecentTurnCount: recentTurns.droppedCount,
      protectedRecentTurnCount: recentTurns.protectedCount,
      protectedRecentTurnBudgetOverrun: recentTurns.protectedBudgetOverrun,
      droppedExpertGuidanceCount: expertGuidance.droppedCount,
      protectedEvidenceIds,
      protectedEvidenceCount: selectedEvidence.protectedEvidenceCount,
      protectedEvidenceBudgetOverrun:
        selectedEvidence.protectedEvidenceBudgetOverrun,
      outputReserveTokens: profile.outputReserveTokens,
      toolReserveTokens: profile.toolReserveTokens,
    };
    if (input.record !== false) {
      await writeBuildRecord(record);
    }
    return pack;
  }

  async function preview(input: RuntimeRecord = {}) {
    const pack = await assemble({
      ...input,
      inputSource: input.inputSource || "preview",
    });
    return {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      contextPack: pack,
      budgetReport: pack.budgetReport || {},
    };
  }

  async function runEvaluation(
    input: RuntimeRecord = {},
  ): Promise<RuntimeRecord> {
    const requestedProfiles = asArray<string | RuntimeRecord>(input.profiles);
    const profiles: Array<string | RuntimeRecord> = requestedProfiles.length
      ? requestedProfiles
      : input.contextProfileId
        ? [String(input.contextProfileId)]
        : [];
    if (profiles.length === 0) {
      throw new Error(
        "contextProfileId or profiles is required for context evaluation.",
      );
    }
    const cases = asArray<RuntimeRecord>(input.cases);
    const startedAt = new Date().toISOString();
    const results: EvaluationResult[] = [];
    for (const profileRef of profiles) {
      const contextProfileId =
        typeof profileRef === "string" ? profileRef : profileRef.profileId;
      for (const testCase of cases) {
        const pack = await assemble({
          ...testCase,
          contextProfileId,
          inputSource: "context-evaluation",
        });
        const retained = new Set<string>(
          [
            ...pack.evidencePack.map((item) => item.evidenceId),
            ...asArray<EvidenceSource>(pack.citations).map((item) =>
              evidenceIdOf(item),
            ),
          ].filter(Boolean),
        );
        const required = normalizeStringArray(testCase.requiredEvidenceIds);
        const hitCount = required.filter((id) => retained.has(id)).length;
        results.push({
          caseId:
            testCase.caseId ||
            testCase.id ||
            hashText(
              testCase.taskBrief || testCase.query || JSON.stringify(testCase),
            ),
          profileId: pack.profileId,
          requiredEvidenceIds: required,
          retainedEvidenceIds: [...retained],
          requiredEvidenceRecall: required.length
            ? Number((hitCount / required.length).toFixed(6))
            : 1,
          totalTokens: Number(pack.budgetReport?.totalTokens || 0),
          compressed: pack.budgetReport?.compressed === true,
          contextBuildRecordId: pack.contextBuildRecordId,
        });
      }
    }
    const run: RuntimeRecord = {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      runId:
        input.runId ||
        `context-eval-${crypto.randomUUID?.() || hashText(startedAt)}`,
      startedAt,
      completedAt: new Date().toISOString(),
      caseCount: cases.length,
      profileCount: profiles.length,
      metrics: {
        averageRequiredEvidenceRecall: results.length
          ? Number(
              (
                results.reduce(
                  (total, item) => total + item.requiredEvidenceRecall,
                  0,
                ) / results.length
              ).toFixed(6),
            )
          : 1,
        averageTokens: results.length
          ? Math.round(
              results.reduce((total, item) => total + item.totalTokens, 0) /
                results.length,
            )
          : 0,
      },
      results,
    };
    await appendEvaluationRun(run);
    return run;
  }

  return {
    protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
    rootPath,
    profilesPath,
    buildRecordsPath,
    evaluationRunsPath,
    compactionRuntime,
    listProfiles,
    saveProfiles,
    resolveProfile,
    preview,
    listBuildRecords,
    runEvaluation,
    assemble,
    compact,
    previewCompaction,
    runCompaction,
    listCompactionRecords,
    listCompactionStrategies,
    listSessionMemory,
    clearSessionMemory,
    estimateTokens,
  };
}

export default createContextRuntime;
