import { computed, ref, type Ref } from "vue";
import {
  getContextProfiles,
  listContextBuildRecords,
  previewContextPack,
  runContextEvaluation,
} from "../lib/context-compiler-client";
import { downloadTextFile } from "./console-browser-effects";
import { formatMachineDate } from "./console-format-utils";
import { asRecord } from "./console-model-utils";

type ConsoleContextCompilerControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  selectedContextProfileId: () => string;
  setBusy: (key: string) => void;
};

export type ContextProfileFormValue = number | "";

export type ContextProfileForm = {
  profileId: string;
  label: string;
  contextWindowTokens: ContextProfileFormValue;
  referenceBudget: ContextProfileFormValue;
  historyBudget: ContextProfileFormValue;
  recentTurnBudget: ContextProfileFormValue;
  operatorGuidanceRatio: ContextProfileFormValue;
};

function optionalFormNumber(value: unknown): ContextProfileFormValue {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const number: any = Number(value);
  return Number.isFinite(number) ? number : "";
}

function optionalRowNumber(value: unknown): number | null {
  const number: any = optionalFormNumber(value);
  return number === "" ? null : number;
}

function hasConfiguredValue(value: unknown) : any {
  return value !== undefined && value !== null && value !== "";
}

export function createContextProfileForm(
  profile: Record<string, unknown> = {},
): ContextProfileForm {
  const budgetPolicy: any = asRecord(profile.budgetPolicy) || {};
  return {
    profileId: String(profile.profileId ?? ""),
    label: String(profile.label ?? ""),
    contextWindowTokens: optionalFormNumber(profile.contextWindowTokens),
    referenceBudget: optionalFormNumber(profile.referenceBudget),
    historyBudget: optionalFormNumber(profile.historyBudget),
    recentTurnBudget: optionalFormNumber(profile.recentTurnBudget),
    operatorGuidanceRatio: optionalFormNumber(budgetPolicy.operatorGuidanceRatio),
  };
}

export function createContextProfileCandidateTemplate(): Record<string, unknown> {
  const contextWindowTokens: any = 128_000;
  return {
    contextWindowTokens,
    outputReserveTokens: 8_192,
    toolReserveTokens: 8_192,
    fixedMemoryBudget: 4_096,
    referenceBudget: 40_960,
    historyBudget: 32_768,
    recentTurnBudget: 20_480,
    budgetPolicy: {
      fixedMemoryRatio: 0.04,
      operatorGuidanceRatio: 0.08,
      referenceRatio: 0.36,
      historyRatio: 0.26,
      recentTurnRatio: 0.18,
      toolStateRatio: 0.08,
    },
    rankingWeights: {
      queryRelevance: 0.36,
      recency: 0.12,
      evidenceConfidence: 0.18,
      humanExpertBoost: 0.2,
      toolFreshness: 0.06,
      hierarchyLevel: 0.08,
    },
    protectedEvidenceFields: ["who", "what", "when", "amount", "conflict", "confidence"],
    placementPolicy: {
      criticalEvidenceHeadCount: 8,
      evidenceTailChecklist: true,
      repeatTaskInTail: true,
    },
    modelCompression: {
      enabled: false,
      alias: "",
      maxInputTokens: 0,
      maxOutputTokens: 0,
      fallback: "",
    },
    compactionPolicy: {
      enabled: true,
      strategy: { id: "deterministic-extractive", params: {} },
      summaryReserveTokens: 8_000,
      reservedBufferTokens: 16_000,
      warningBufferTokens: 24_000,
      hardBufferTokens: 2_048,
      hardThresholdRatio: 0.98,
      recentMessageProtectionCount: 12,
      recentTurnProtectionCount: 6,
      maxConsecutiveFailures: 3,
      ptlRetryLimit: 0,
      ptlHeadTrimRatio: 0.2,
      modelMaxInputTokens: 0,
      modelMaxOutputTokens: 0,
      deterministicTargetRatio: 0.25,
      reinjectionBudgetTokens: 2_000,
      maxToolResultTokens: 900,
      maxAttachmentTokens: 600,
      allowAttachmentDehydration: true,
      persistSessionMemory: true,
      persistBoundaries: true,
      microCompaction: true,
    },
    compression: {
      enabled: true,
      threshold: 0.6,
      targetRatio: 0.3,
      protectLastNTurns: 8,
      summaryMaxTokens: 8_000,
      strategy: "deterministic-extractive",
    },
  };
}

export function validateContextProfileForm(form: ContextProfileForm) : any {
  if (!form.profileId.trim()) {
    return "请填写 Profile ID。";
  }

  const numberFields: Array<{
    label: string;
    min: number;
    max?: number;
    value: ContextProfileFormValue;
  }> = [
    { label: "窗口总量", min: 4096, value: form.contextWindowTokens },
    { label: "参考分配", min: 0, value: form.referenceBudget },
    { label: "历史分配", min: 0, value: form.historyBudget },
    { label: "最近轮次", min: 0, value: form.recentTurnBudget },
    { label: "人工介入权重", min: 0, max: 1, value: form.operatorGuidanceRatio },
  ];
  for (const field of numberFields) {
    if (field.value === "") {
      return `请填写${field.label}。`;
    }
    if (!Number.isFinite(field.value) || field.value < field.min ||
      (field.max !== undefined && field.value > field.max)) {
      return `${field.label}超出允许范围。`;
    }
  }
  return "";
}

function assignOptionalNumber(
  target: Record<string, unknown>,
  key: string,
  value: ContextProfileFormValue,
) : any {
  if (value === "") {
    delete target[key];
    return;
  }
  target[key] = value;
}

export function buildContextProfileFromForm(
  form: ContextProfileForm,
  original: Record<string, unknown> = {},
) : any {
  const profile: Record<string, unknown> = {
    ...original,
    profileId: form.profileId.trim(),
  };
  const label: any = form.label.trim();
  if (label) {
    profile.label = label;
  } else {
    delete profile.label;
  }
  assignOptionalNumber(profile, "contextWindowTokens", form.contextWindowTokens);
  assignOptionalNumber(profile, "referenceBudget", form.referenceBudget);
  assignOptionalNumber(profile, "historyBudget", form.historyBudget);
  assignOptionalNumber(profile, "recentTurnBudget", form.recentTurnBudget);

  const budgetPolicy: Record<string, any> = { ...(asRecord(original.budgetPolicy) || {}) };
  assignOptionalNumber(budgetPolicy, "operatorGuidanceRatio", form.operatorGuidanceRatio);
  if (Object.keys(budgetPolicy).length) {
    profile.budgetPolicy = budgetPolicy;
  } else {
    delete profile.budgetPolicy;
  }
  return profile;
}

function parseRequiredEvidenceIds(value: string) : any {
  return value
    .split(/[,，\s]+/)
    .map((item?: any) : any => item.trim())
    .filter(Boolean);
}

export function createConsoleContextCompilerController(
  options: ConsoleContextCompilerControllerOptions,
) : any {
  const contextProfilesResponse: any = ref<Record<string, unknown> | null>(null);
  const contextBuildRecordsResponse: any = ref<Record<string, unknown> | null>(null);
  const contextPreviewTask: any = ref("");
  const contextPreviewRequiredEvidence: any = ref("");
  const contextPreviewResult: any = ref<Record<string, unknown> | null>(null);
  const contextEvaluationResult: any = ref<Record<string, unknown> | null>(null);

  const contextProfileRows: any = computed(() : any =>
    ((asRecord(contextProfilesResponse.value)?.profiles || []) as Array<Record<string, unknown>>)
      .filter(Boolean)
      .map((profile?: any) : any => {
        const compression: any = asRecord(profile.compression) || {};
        const budgetPolicy: any = asRecord(profile.budgetPolicy) || {};
        const modelCompression: any = asRecord(profile.modelCompression) || {};
        return {
          profileId: String(profile.profileId ?? ""),
          label: String(profile.label ?? ""),
          contextWindowTokens: optionalRowNumber(profile.contextWindowTokens),
          compressionMode: String(compression.mode ?? ""),
          strategy: String(compression.strategy ?? ""),
          referenceBudget: optionalRowNumber(profile.referenceBudget),
          historyBudget: optionalRowNumber(profile.historyBudget),
          recentTurnBudget: optionalRowNumber(profile.recentTurnBudget),
          operatorGuidanceRatio: optionalRowNumber(budgetPolicy.operatorGuidanceRatio),
          protectedEvidenceFields: Array.isArray(profile.protectedEvidenceFields)
            ? profile.protectedEvidenceFields.map((item?: any) : any => String(item))
            : [],
          modelCompressionAlias: String(modelCompression.alias ?? ""),
          modelCompressionConfigured: (Object.values(modelCompression) as any[]).some(hasConfiguredValue),
          modelCompressionEnabled: modelCompression.enabled === true,
        };
      })
      .sort((left?: any, right?: any) : any => {
        if (left.contextWindowTokens !== null && right.contextWindowTokens !== null) {
          const tokenCompare: any = left.contextWindowTokens - right.contextWindowTokens;
          if (tokenCompare !== 0) return tokenCompare;
        } else if (left.contextWindowTokens === null && right.contextWindowTokens !== null) {
          return 1;
        } else if (left.contextWindowTokens !== null && right.contextWindowTokens === null) {
          return -1;
        }
        return left.profileId.localeCompare(right.profileId);
      }),
  );

  const contextBuildRecordRows: any = computed(() : any =>
    ((asRecord(contextBuildRecordsResponse.value)?.records || []) as Array<Record<string, unknown>>).map((record?: any) : any => ({
      recordId: String(record.recordId || ""),
      createdAt: String(record.createdAt || ""),
      profileId: String(record.profileId || ""),
      totalTokens: Number(record.totalTokens || 0),
      sourceTokens: Number(record.sourceTokens || 0),
      triggerReason: String(record.triggerReason || ""),
      compressionMode: String(record.compressionMode || ""),
      preservedEvidenceIds: ((record.preservedEvidenceIds || []) as unknown[]).map((item?: any) : any => String(item)),
      droppedReferenceCount: Number(record.droppedReferenceCount || 0),
      humanOperatorGuidanceCount: Number(record.humanExpertGuidanceCount || 0),
    })),
  );

  async function refreshContextCompiler(optionsOverride: { silent?: boolean } = {}) : Promise<any> {
    const showBusy: any = !optionsOverride.silent;
    if (showBusy) {
      options.setBusy("context:refresh");
    }
    try {
      const [profiles, records] = await Promise.all([
        getContextProfiles(),
        listContextBuildRecords(20),
      ]);
      contextProfilesResponse.value = profiles;
      contextBuildRecordsResponse.value = records;
    } catch (nextError: any) {
      if (!optionsOverride.silent) {
        options.error.value =
          nextError instanceof Error ? nextError.message : "加载上下文编译器状态失败。";
      }
    } finally {
      if (showBusy) {
        options.clearBusy("context:refresh");
      }
    }
  }

  function contextPreviewPayload(
    contextProfileId: any = options.selectedContextProfileId().trim(),
  ) : any {
    const requiredEvidenceIds: any = parseRequiredEvidenceIds(contextPreviewRequiredEvidence.value);
    return {
      contextProfileId,
      inputSource: "server-console-context-preview",
      taskBrief: contextPreviewTask.value.trim(),
      requiredEvidenceIds,
      retrievedEvidence: [],
    };
  }

  async function previewContextCompiler() : Promise<any> {
    const contextProfileId: any = options.selectedContextProfileId().trim();
    if (!contextProfileId) {
      options.error.value = "请先选择上下文配置。";
      return;
    }
    options.setBusy("context:preview");
    options.error.value = "";
    try {
      contextPreviewResult.value = await previewContextPack(contextPreviewPayload(contextProfileId));
      await refreshContextCompiler({ silent: true });
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "上下文预览失败。";
    } finally {
      options.clearBusy("context:preview");
    }
  }

  async function runContextReplayEvaluation() : Promise<any> {
    const contextProfileId: any = options.selectedContextProfileId().trim();
    if (!contextProfileId) {
      options.error.value = "请先选择上下文配置。";
      return;
    }
    options.setBusy("context:evaluation");
    options.error.value = "";
    try {
      const payload: any = contextPreviewPayload(contextProfileId);
      const requiredEvidenceIds: any = parseRequiredEvidenceIds(contextPreviewRequiredEvidence.value);
      contextEvaluationResult.value = await runContextEvaluation({
        profiles: [contextProfileId],
        cases: [
          {
            caseId: `console-preview-${Date.now()}`,
            ...payload,
            requiredEvidenceIds,
          },
        ],
      });
      await refreshContextCompiler({ silent: true });
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "上下文 replay 评估失败。";
    } finally {
      options.clearBusy("context:evaluation");
    }
  }

  function exportContextBuildRecords() : any {
    const payload: any = contextBuildRecordsResponse.value || { records: [] };
    downloadTextFile(
      `context-build-records-${formatMachineDate(new Date().toISOString(), "full").replace(/[: ]/g, "-")}.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  }

  return {
    contextBuildRecordRows,
    contextBuildRecordsResponse,
    contextEvaluationResult,
    contextPreviewPayload,
    contextPreviewRequiredEvidence,
    contextPreviewResult,
    contextPreviewTask,
    contextProfileRows,
    contextProfilesResponse,
    exportContextBuildRecords,
    previewContextCompiler,
    refreshContextCompiler,
    runContextReplayEvaluation,
  };
}
