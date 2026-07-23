import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContextProfileFromForm,
  createConsoleContextCompilerController,
  createContextProfileCandidateTemplate,
  createContextProfileForm,
  validateContextProfileForm,
} from "../../../apps/console/composables/console-context-compiler-controller";

const contextCompilerClientMock = vi.hoisted(() => ({
  getContextProfiles: vi.fn(),
  listContextBuildRecords: vi.fn(),
  previewContextPack: vi.fn(),
  runContextEvaluation: vi.fn(),
}));

vi.mock("../../../apps/console/lib/context-compiler-client", () => contextCompilerClientMock);
vi.mock("../../../apps/console/composables/console-browser-effects", () => ({
  downloadTextFile: vi.fn(),
}));

function createHarness() {
  let selectedContextProfileId = "";
  const error = ref("");
  const setBusy = vi.fn();
  const clearAllBusy = vi.fn();
  const controller = createConsoleContextCompilerController({
    clearAllBusy,
    error,
    selectedContextProfileId: () => selectedContextProfileId,
    setBusy,
  });
  return {
    clearAllBusy,
    controller,
    error,
    selectProfile: (profileId: string) => {
      selectedContextProfileId = profileId;
    },
    setBusy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  contextCompilerClientMock.getContextProfiles.mockResolvedValue({ profiles: [] });
  contextCompilerClientMock.listContextBuildRecords.mockResolvedValue({ records: [] });
  contextCompilerClientMock.previewContextPack.mockResolvedValue({ contextPack: {} });
  contextCompilerClientMock.runContextEvaluation.mockResolvedValue({ results: [] });
});

describe("console context profile truthfulness", () => {
  it("keeps an untouched form empty and only exposes defaults through the add candidate", () => {
    expect(createContextProfileForm()).toEqual({
      profileId: "",
      label: "",
      contextWindowTokens: "",
      referenceBudget: "",
      historyBudget: "",
      recentTurnBudget: "",
      operatorGuidanceRatio: "",
    });

    const candidate = createContextProfileCandidateTemplate();
    expect(candidate).toMatchObject({
      contextWindowTokens: 128_000,
      referenceBudget: 40_000,
      historyBudget: 32_000,
      recentTurnBudget: 20_000,
      budgetPolicy: {
        fixedMemoryRatio: 0.04,
        operatorGuidanceRatio: 0.08,
        referenceRatio: 0.36,
        historyRatio: 0.26,
        recentTurnRatio: 0.18,
        toolStateRatio: 0.08,
      },
      compactionPolicy: {
        strategy: { id: "deterministic-extractive", params: {} },
      },
      compression: { strategy: "deterministic-extractive" },
    });
    expect(candidate).not.toHaveProperty("profileId");
    expect(candidate).not.toHaveProperty("label");
    expect(candidate).not.toHaveProperty("modelAlias");
  });

  it("does not synthesize label, model, numeric, or compression values while editing", () => {
    const original = {
      profileId: "sparse-profile",
      modelAlias: "",
      compression: {
        enabled: null,
        mode: "",
        strategy: "",
      },
    };
    const form = createContextProfileForm(original);

    expect(form).toEqual({
      profileId: "sparse-profile",
      label: "",
      contextWindowTokens: "",
      referenceBudget: "",
      historyBudget: "",
      recentTurnBudget: "",
      operatorGuidanceRatio: "",
    });
    expect(validateContextProfileForm(form)).toBe("请填写窗口总量。");
    expect(buildContextProfileFromForm(form, original)).toEqual(original);

    const newForm = createContextProfileForm();
    newForm.profileId = "empty-profile";
    expect(buildContextProfileFromForm(newForm)).toEqual({ profileId: "empty-profile" });
  });

  it("projects missing profile fields as missing instead of deterministic or zero defaults", async () => {
    contextCompilerClientMock.getContextProfiles.mockResolvedValue({
      profiles: [
        { profileId: "profile-beta" },
        { profileId: "profile-alpha" },
      ],
    });
    const { controller } = createHarness();

    await controller.refreshContextCompiler();

    expect(controller.contextProfileRows.value.map((profile) => profile.profileId)).toEqual([
      "profile-alpha",
      "profile-beta",
    ]);
    expect(controller.contextProfileRows.value[0]).toMatchObject({
      label: "",
      contextWindowTokens: null,
      referenceBudget: null,
      historyBudget: null,
      recentTurnBudget: null,
      operatorGuidanceRatio: null,
      compressionMode: "",
      strategy: "",
      modelCompressionConfigured: false,
    });
  });
});

describe("console context preview truthfulness", () => {
  it("starts empty and does not send preview or evaluation requests without a selected profile", async () => {
    const { controller, error, setBusy, clearAllBusy } = createHarness();

    expect(controller.contextPreviewTask.value).toBe("");
    expect(controller.contextPreviewPayload()).toEqual({
      contextProfileId: "",
      inputSource: "server-console-context-preview",
      taskBrief: "",
      requiredEvidenceIds: [],
      retrievedEvidence: [],
    });

    await controller.previewContextCompiler();
    await controller.runContextReplayEvaluation();

    expect(contextCompilerClientMock.previewContextPack).not.toHaveBeenCalled();
    expect(contextCompilerClientMock.runContextEvaluation).not.toHaveBeenCalled();
    expect(contextCompilerClientMock.getContextProfiles).not.toHaveBeenCalled();
    expect(contextCompilerClientMock.listContextBuildRecords).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(clearAllBusy).not.toHaveBeenCalled();
    expect(error.value).toBe("请先选择上下文配置。");
  });

  it("sends only the selected profile and user-entered task and evidence identifiers", async () => {
    const { controller, selectProfile } = createHarness();
    selectProfile(" profile-a ");
    controller.contextPreviewTask.value = "  inspect supplied evidence  ";
    controller.contextPreviewRequiredEvidence.value = "evidence-a, evidence-b";

    await controller.previewContextCompiler();

    expect(contextCompilerClientMock.previewContextPack).toHaveBeenCalledWith({
      contextProfileId: "profile-a",
      inputSource: "server-console-context-preview",
      taskBrief: "inspect supplied evidence",
      requiredEvidenceIds: ["evidence-a", "evidence-b"],
      retrievedEvidence: [],
    });
    const previewPayload = contextCompilerClientMock.previewContextPack.mock.calls[0][0];
    expect(previewPayload).not.toHaveProperty("systemMemory");
    expect(previewPayload).not.toHaveProperty("operatorGuidance");
    expect(previewPayload).not.toHaveProperty("history");
    expect(previewPayload).not.toHaveProperty("recentTurns");
    expect(previewPayload).not.toHaveProperty("toolState");

    controller.contextPreviewRequiredEvidence.value = "";
    await controller.runContextReplayEvaluation();

    const evaluationPayload = contextCompilerClientMock.runContextEvaluation.mock.calls[0][0];
    expect(evaluationPayload.profiles).toEqual(["profile-a"]);
    expect(evaluationPayload.cases).toHaveLength(1);
    expect(evaluationPayload.cases[0]).toMatchObject({
      contextProfileId: "profile-a",
      taskBrief: "inspect supplied evidence",
      requiredEvidenceIds: [],
      retrievedEvidence: [],
    });
    expect(JSON.stringify(evaluationPayload)).not.toContain("preview-evidence");
  });
});
