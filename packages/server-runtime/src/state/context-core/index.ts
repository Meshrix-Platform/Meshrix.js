import path from "node:path";
import crypto from "node:crypto";
import {
  CONTEXT_COMPACTION_PROTOCOL_VERSION,
  createContextCompactionRuntime
} from "../context-compact/index.ts";
import {
  asArray,
  asObject,
  compactText,
  estimateTokens,
  hashText,
  normalizeStringArray
} from "./validation.ts";
import { assertContextProfileComplete, normalizeProfiles } from "./profile.ts";
import {
  citationsFromEvidence,
  collectProtectedEvidenceIds,
  computeBudgets,
  criticalEvidenceIndex,
  normalizeEvidenceItem,
  normalizeExpertGuidance,
  normalizeMemoryBlocks,
  sectionTokenReport,
  selectByBudget,
  selectEvidenceByBudget,
  selectRecentTurnsByBudget,
  summarizeToolState,
  tokenize,
  workspaceSnapshot
} from "./projection.ts";
import { createContextCoreStorage } from "./storage.ts";

export const CONTEXT_RUNTIME_PROTOCOL_VERSION: any = "v0.0.1:agent:context-1";
export { estimateTokens } from "./validation.ts";

export function createContextRuntime({
  userDataPath,
  modelCompressor = null,
  agentGatewayCall = null,
  agentMemory = null,
  strategies = [],
  compactionStrategies = []
}: Record<string, any>) : any {
  const rootPath: any = path.join(userDataPath, "context-core");
  const profilesPath: any = path.join(rootPath, "context-profiles.json");
  const buildRecordsPath: any = path.join(rootPath, "context-build-records.jsonl");
  const evaluationRunsPath: any = path.join(rootPath, "context-evaluation-runs.jsonl");
  const compactionRuntime: any = createContextCompactionRuntime({
    userDataPath,
    modelCompressor,
    agentGatewayCall,
    agentMemory,
    strategies,
    compactionStrategies
  });
  const storage: any = createContextCoreStorage({
    profilesPath,
    buildRecordsPath,
    evaluationRunsPath,
    protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
    normalizeProfiles
  });
  const {
    readProfiles,
    listProfiles,
    saveProfiles,
    listBuildRecords,
    writeBuildRecord,
    appendEvaluationRun
  } = storage;

  async function resolveProfile(input: Record<string, any> = {}) : Promise<any> {
    const profiles: any = await readProfiles();
    const explicitTarget: any = String(input.contextProfileId || "").trim();
    const target: any = explicitTarget;
    if (!target) {
      throw new Error("contextProfileId is required; no context profile is configured for this request.");
    }
    const profile: any = profiles.find((profile?: any) : any => profile.profileId === target);
    if (!profile) {
      throw new Error(`Configured context profile was not found: ${target}`);
    }
    return assertContextProfileComplete(profile);
  }

  async function compact(input: Record<string, any> = {}) : Promise<any> {
    const profile: any = await resolveProfile(input);
    if (Array.isArray(input.messages) || Array.isArray(input.transcript) || input.runtimeState || input.force === true) {
      return compactionRuntime.run({
        ...input,
        profile
      });
    }
    const requestedTarget: any = input.targetTokens === undefined || input.targetTokens === null || input.targetTokens === ""
      ? Number(profile.compression.summaryMaxTokens)
      : Number(input.targetTokens);
    if (!Number.isFinite(requestedTarget) || requestedTarget <= 0) {
      throw new Error(`Configured context profile is incomplete: ${profile.profileId}:compression.summaryMaxTokens`);
    }
    const configuredMaximum: any = Number(profile.compression.summaryMaxTokens);
    if (!Number.isFinite(configuredMaximum) || configuredMaximum <= 0) {
      throw new Error(`Configured context profile is incomplete: ${profile.profileId}:compression.summaryMaxTokens`);
    }
    const targetTokens: any = Math.min(requestedTarget, configuredMaximum);
    const sourceText: any = String(input.text || input.content || "");
    const summary: any = compactText(sourceText, targetTokens);
    return {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      profileId: profile.profileId,
      strategy: profile.compression.strategy,
      sourceTokens: estimateTokens(sourceText),
      summaryTokens: estimateTokens(summary),
      summary
    };
  }

  async function previewCompaction(input: Record<string, any> = {}) : Promise<any> {
    const profile: any = await resolveProfile(input);
    return compactionRuntime.preview({
      ...input,
      profile
    });
  }

  async function runCompaction(input: Record<string, any> = {}) : Promise<any> {
    const profile: any = await resolveProfile(input);
    return compactionRuntime.run({
      ...input,
      profile
    });
  }

  async function listCompactionRecords(input: Record<string, any> = {}) : Promise<any> {
    return compactionRuntime.listRecords(input);
  }

  async function listCompactionStrategies() : Promise<any> {
    return compactionRuntime.listStrategies();
  }

  async function listSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    return compactionRuntime.listSessionMemory(input);
  }

  async function clearSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    return compactionRuntime.clearSessionMemory(input);
  }

  async function modelCompressText({ profile, text, targetTokens, kind, citations = [] }: Record<string, any>) : Promise<any> {
    const sourceText: any = String(text || "");
    const compressionAlias: any = String(profile.modelCompression.alias || "").trim();
    const maxInputTokens: any = Number(profile.modelCompression.maxInputTokens);
    const modelInputText: any = compactText(sourceText, maxInputTokens);
    if (
      !sourceText ||
      profile.modelCompression.enabled !== true ||
      !compressionAlias ||
      Number(profile.modelCompression.maxOutputTokens || 0) <= 0 ||
      !["model-assisted", "workbench-reconstruction", "session-memory-first"].includes(profile.compression.mode)
    ) {
      return {
        used: false,
        degraded: false,
        summary: compactText(sourceText, targetTokens),
        error: ""
      };
    }
    try {
      const prompt: any = [
        "你是 Meshrix 本地上下文压缩器。只压缩上下文，不新增事实。",
        "必须保留 evidenceId、文件路径、日期、金额、冲突和人类专家意见。",
        "如果输入中存在引用编号，输出必须保留原编号。",
        `压缩对象：${kind}`,
        `目标 token：${targetTokens}`,
        citations.length ? `必须保护的引用：${citations.join(", ")}` : "",
        "",
        modelInputText
      ].filter(Boolean).join("\n");
      const response: any = typeof modelCompressor === "function"
        ? await modelCompressor({
            profile,
            kind,
            text: modelInputText,
            targetTokens,
            citations,
            prompt
          })
        : await agentGatewayCall?.({
            alias: compressionAlias,
            modelAlias: compressionAlias,
            question: prompt,
            parameters: {
              temperature: 0,
              max_tokens: Math.min(profile.modelCompression.maxOutputTokens, targetTokens),
              stream: false,
              tool_choice: "none"
            }
          });
      const summary: any = String(response?.summary || response?.answer || response?.text || "").trim();
      if (!summary) {
        throw new Error("模型压缩没有返回摘要。");
      }
      return {
        used: true,
        degraded: false,
        summary: compactText(summary, targetTokens),
        error: ""
      };
    } catch (error: any) {
      if (profile.modelCompression.fallback !== "deterministic-extractive") {
        throw error;
      }
      return {
        used: false,
        degraded: true,
        summary: compactText(sourceText, targetTokens),
        error: error instanceof Error ? error.message : "model_compression_failed"
      };
    }
  }

  function compactionMessagesFromAssembleInput(input: Record<string, any> = {}) : any {
    if (Array.isArray(input.messages) || Array.isArray(input.transcript)) {
      return input.messages || input.transcript;
    }
    const messages: any[] = [];
    if (input.history || input.compressedHistory) {
      messages.push({
        id: "history",
        role: "system",
        apiRoundId: "history",
        content: input.history || input.compressedHistory
      });
    }
    for (const [index, turn] of asArray(input.recentTurns).entries()) {
      messages.push({
        ...turn,
        id: turn.id || turn.messageId || `recent-${index + 1}`,
        apiRoundId: turn.apiRoundId || turn.roundId || `recent-round-${Math.floor(index / 2) + 1}`
      });
    }
    if (input.toolState && Object.keys(asObject(input.toolState)).length) {
      messages.push({
        id: "tool-state",
        role: "tool",
        apiRoundId: "tool-state",
        content: input.toolState
      });
    }
    return messages;
  }

  async function assemble(input: Record<string, any> = {}) : Promise<any> {
    const profile: any = await resolveProfile(input);
    const budgets: any = computeBudgets(profile);
    const taskBrief: any = String(input.taskBrief || input.task || input.query || "").trim();
    const queryTokens: any = tokenize(taskBrief);
    const sharedSnapshot: any = workspaceSnapshot(input.workspaceState || {});
    const privateText: any = String(input.privateSummary || input.privateState?.summary || "");
    const memoryBlocks: any = normalizeMemoryBlocks(input, budgets.fixedMemory);
    const expertGuidance: any = selectByBudget(
      normalizeExpertGuidance(input),
      budgets.expertGuidance,
      (item?: any) : any => `${item.label}\n${item.instruction}\n${item.reason}\n${item.evidenceRefs?.join(",") || ""}`
    );
    const protectedEvidenceIds: any = collectProtectedEvidenceIds(input, expertGuidance.selected);
    const normalizedEvidence: any = asArray(input.retrievedEvidence || input.evidence || [])
      .map((item?: any) : any => normalizeEvidenceItem(item, { queryTokens, profile }))
      .sort((left?: any, right?: any) : any => right.score - left.score);
    const selectedEvidence: any = selectEvidenceByBudget(
      normalizedEvidence,
      budgets.reference,
      protectedEvidenceIds,
      (item?: any) : any => [
        item.evidenceId,
        item.title,
        item.snippet,
        JSON.stringify(item.protectedFacts),
        JSON.stringify(item.sourceLocator)
      ].join("\n")
    );
    const evidencePack: any = selectedEvidence.selected.map((item?: any) : any => ({
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
      scoreBreakdown: item.scoreBreakdown
    }));
    const recentTurns: any = selectRecentTurnsByBudget(
      input.recentTurns || [],
      budgets.recentTurns,
      profile.compression.protectLastNTurns
    );
    let compressedHistory: any = compactText(
      String(input.history || input.compressedHistory || ""),
      budgets.history
    );
    const privateSummary: any = compactText(
      privateText || JSON.stringify(input.privateState || {}),
      budgets.history
    );
    const modelCompressionEvents: any[] = [];
    const protectedCitationIds: any = [
      ...protectedEvidenceIds,
      ...selectedEvidence.selected.map((item?: any) : any => item.evidenceId),
      ...expertGuidance.selected.flatMap((item?: any) : any => item.evidenceRefs || [])
    ].filter(Boolean);
    const historyCompression: any = await modelCompressText({
      profile,
      text: compressedHistory,
      targetTokens: budgets.history,
      kind: "history",
      citations: protectedCitationIds
    });
    compressedHistory = historyCompression.summary;
    if (historyCompression.used || historyCompression.degraded) {
      modelCompressionEvents.push({ kind: "history", ...historyCompression, summary: undefined });
    }
    let toolStateSummary: any = summarizeToolState(asObject(input.toolState), budgets.toolState);
    const toolCompression: any = await modelCompressText({
      profile,
      text: toolStateSummary.compactText,
      targetTokens: budgets.toolState,
      kind: "tool_state",
      citations: protectedCitationIds
    });
    toolStateSummary = {
      ...toolStateSummary,
      compactText: toolCompression.summary
    };
    if (toolCompression.used || toolCompression.degraded) {
      modelCompressionEvents.push({ kind: "tool_state", ...toolCompression, summary: undefined });
    }
    const compactionMessages: any = compactionMessagesFromAssembleInput(input);
    let runtimeCompaction: Record<string, any> = {
      protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
      status: "skipped",
      compacted: false,
      triggerReason: "no_messages"
    };
    if (compactionMessages.length) {
      const compactionSessionId: any = String(
        input.sessionId || input.conversationId || input.threadId || ""
      ).trim();
      try {
        runtimeCompaction = await compactionRuntime.maybeCompact({
          profile,
          messages: compactionMessages,
          sessionId: compactionSessionId,
          inputSource: input.inputSource || "context-core",
          taskBrief,
          runtimeState: {
            ...(asObject(input.runtimeState)),
            taskBrief,
            activePlan: input.activePlan || input.plan || input.runtimeState?.activePlan || null,
            enabledTools: input.enabledTools || input.tools || input.runtimeState?.enabledTools || [],
            currentFiles: input.currentFiles || input.runtimeState?.currentFiles || [],
            gatewayReference:
              input.gatewayReference ||
              input.runtimeState?.gatewayReference ||
              ""
          },
          useSessionMemory: Boolean(compactionSessionId) && input.useSessionMemory !== false,
          persist: Boolean(compactionSessionId) && input.record !== false && input.persistCompaction !== false
        });
        if (runtimeCompaction.compacted && runtimeCompaction.summary) {
          compressedHistory = compactText(
            [
              runtimeCompaction.summary,
              compressedHistory
            ].filter(Boolean).join("\n\n"),
            budgets.history
          );
        }
      } catch (error: any) {
        runtimeCompaction = {
          protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
          status: "failed",
          compacted: false,
          degraded: true,
          error: error instanceof Error ? error.message : "context_compaction_failed"
        };
      }
    }
    const pack: Record<string, any> = {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      profileId: profile.profileId,
      workspaceContext: input.workspaceContext || null,
      workspaceGeneration: input.workspaceContext?.currentGeneration || null,
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
        head: ["taskBrief", "memoryBlocks", "expertGuidance", "criticalEvidenceIndex"],
        body: ["evidencePack", "toolStateSummary", "compressedHistory"],
        tail: profile.placementPolicy.evidenceTailChecklist === true
          ? ["recentTurns", "tailChecklist"]
          : ["recentTurns"]
      },
      tailChecklist: {
        taskBrief: profile.placementPolicy.repeatTaskInTail === true ? taskBrief : "",
        evidenceIds: evidencePack.map((item?: any) : any => item.evidenceId).filter(Boolean),
        requiredEvidenceIds: protectedEvidenceIds,
        rules: profile.placementPolicy.evidenceTailChecklist === true
          ? [
              "Use evidenceId citations exactly as supplied.",
              "Do not treat compressed summaries as canonical evidence.",
              "If required evidence is missing, say so and call tools when allowed."
            ]
          : []
      },
      contextBuildRecordId: ""
    };
    const sourceTokens: any = estimateTokens({
      taskBrief,
      systemMemory: input.systemMemory || input.memory || "",
      expertGuidance: input.expertGuidance || input.humanFeedback || input.feedback || [],
      retrievedEvidence: input.retrievedEvidence || input.evidence || [],
      history: input.history || input.compressedHistory || "",
      recentTurns: input.recentTurns || [],
      toolState: input.toolState || {}
    });
    let totalTokens: any = estimateTokens(pack);
    let compressed: any = false;
    const usableTokens: any = Math.max(
      0,
      profile.contextWindowTokens - profile.outputReserveTokens - profile.toolReserveTokens
    );
    const thresholdTokens: any = Math.floor(profile.contextWindowTokens * profile.compression.threshold);
    let compressionDroppedReferenceIds: any[] = [];
    if (profile.compression.enabled === true && totalTokens > thresholdTokens) {
      pack.compressedHistory = compactText(compressedHistory, Math.floor(profile.historyBudget * profile.compression.targetRatio));
      pack.privateSummary = compactText(privateSummary, Math.floor(profile.historyBudget * profile.compression.targetRatio));
      const nextReferenceBudget: any = Math.max(0, Math.floor(budgets.reference * profile.compression.targetRatio));
      const nextReference: any = selectEvidenceByBudget(pack.evidencePack, nextReferenceBudget, protectedEvidenceIds);
      pack.evidencePack = nextReference.selected;
      compressionDroppedReferenceIds = nextReference.dropped.map((entry?: any) : any => entry.item.evidenceId).filter(Boolean);
      pack.retrievedReferences = nextReference.selected;
      pack.criticalEvidenceIndex = criticalEvidenceIndex(pack.evidencePack, profile);
      pack.citations = citationsFromEvidence(pack.evidencePack);
      pack.tailChecklist.evidenceIds = pack.evidencePack.map((item?: any) : any => item.evidenceId).filter(Boolean);
      totalTokens = estimateTokens(pack);
      compressed = true;
    }
    const sectionTokens: any = sectionTokenReport(pack);
    const droppedEvidenceIds: any = selectedEvidence.dropped
      .map((entry?: any) : any => entry.item.evidenceId)
      .filter(Boolean)
      .concat(compressionDroppedReferenceIds);
    const record: Record<string, any> = {
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
        tokenReport: runtimeCompaction.tokenReport || null
      },
      triggerReason: compressed ? "threshold_exceeded" : "within_budget",
      sourceTokens,
      totalTokens,
      sectionTokens,
      budgets,
      preservedEvidenceIds: pack.evidencePack.map((item?: any) : any => item.evidenceId).filter(Boolean),
      droppedEvidenceIds,
      droppedReferenceCount: droppedEvidenceIds.length,
      droppedRecentTurnCount: recentTurns.droppedCount,
      protectedRecentTurnCount: recentTurns.protectedCount,
      protectedRecentTurnBudgetOverrun: recentTurns.protectedBudgetOverrun,
      droppedExpertGuidanceCount: expertGuidance.droppedCount,
      protectedEvidenceIds,
      protectedEvidenceCount: selectedEvidence.protectedEvidenceCount,
      protectedEvidenceBudgetOverrun: selectedEvidence.protectedEvidenceBudgetOverrun,
      humanExpertGuidanceCount: pack.expertGuidance.length,
      protectedEvidenceFields: profile.protectedEvidenceFields
    };
    pack.contextBuildRecordId = record.recordId;
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
        used: modelCompressionEvents.some((event?: any) : any => event.used),
        degraded: modelCompressionEvents.some((event?: any) : any => event.degraded),
        fallback: profile.modelCompression.fallback,
        events: modelCompressionEvents
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
        circuitBreaker: runtimeCompaction.circuitBreaker || null
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
      protectedEvidenceBudgetOverrun: selectedEvidence.protectedEvidenceBudgetOverrun,
      outputReserveTokens: profile.outputReserveTokens,
      toolReserveTokens: profile.toolReserveTokens
    };
    if (input.record !== false) {
      await writeBuildRecord(record);
    }
    return pack;
  }

  async function preview(input: Record<string, any> = {}) : Promise<any> {
    const pack: any = await assemble({
      ...input,
      inputSource: input.inputSource || "preview"
    });
    return {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      contextPack: pack,
      budgetReport: pack.budgetReport
    };
  }

  async function runEvaluation(input: Record<string, any> = {}) : Promise<any> {
    const requestedProfiles: any = asArray(input.profiles);
    const profiles: any = requestedProfiles.length
      ? requestedProfiles
      : input.contextProfileId
        ? [input.contextProfileId]
        : [];
    if (profiles.length === 0) {
      throw new Error("contextProfileId or profiles is required for context evaluation.");
    }
    const cases: any = asArray(input.cases).length ? asArray(input.cases) : [];
    const startedAt: any = new Date().toISOString();
    const results: any[] = [];
    for (const profileRef of profiles) {
      const contextProfileId: any = typeof profileRef === "string" ? profileRef : profileRef.profileId;
      for (const testCase of cases) {
        const pack: any = await assemble({
          ...testCase,
          contextProfileId,
          inputSource: "context-evaluation"
        });
        const retained: any = new Set<any>([
          ...asArray(pack.evidencePack).map((item?: any) : any => item.evidenceId),
          ...asArray(pack.citations).map((item?: any) : any => item.evidenceId)
        ].filter(Boolean));
        const required: any = normalizeStringArray(testCase.requiredEvidenceIds);
        const hitCount: any = required.filter((id?: any) : any => retained.has(id)).length;
        results.push({
          caseId: testCase.caseId || testCase.id || hashText(testCase.taskBrief || testCase.query || JSON.stringify(testCase)),
          profileId: pack.profileId,
          requiredEvidenceIds: required,
          retainedEvidenceIds: [...retained],
          requiredEvidenceRecall: required.length ? Number((hitCount / required.length).toFixed(6)) : 1,
          totalTokens: pack.budgetReport.totalTokens,
          compressed: pack.budgetReport.compressed,
          contextBuildRecordId: pack.contextBuildRecordId
        });
      }
    }
    const run: Record<string, any> = {
      protocolVersion: CONTEXT_RUNTIME_PROTOCOL_VERSION,
      runId: input.runId || `context-eval-${crypto.randomUUID?.() || hashText(startedAt)}`,
      startedAt,
      completedAt: new Date().toISOString(),
      caseCount: cases.length,
      profileCount: profiles.length,
      metrics: {
        averageRequiredEvidenceRecall: results.length
          ? Number((results.reduce((total?: any, item?: any) : any => total + item.requiredEvidenceRecall, 0) / results.length).toFixed(6))
          : 1,
        averageTokens: results.length
          ? Math.round(results.reduce((total?: any, item?: any) : any => total + item.totalTokens, 0) / results.length)
          : 0
      },
      results
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
    estimateTokens
  };
}

export default createContextRuntime;
