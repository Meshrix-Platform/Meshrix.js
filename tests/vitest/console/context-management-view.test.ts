// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ContextManagementView from "../../../apps/console/views/admin/ContextManagementView.vue";

const shellContextMock = vi.hoisted(() => ({
  current: null as unknown,
}));
const contextCompilerClientMock = vi.hoisted(() => ({
  saveContextProfiles: vi.fn(),
}));

vi.mock("../../../apps/console/composables/serverConsoleShellContext", () => ({
  useServerConsoleShellContext: () => shellContextMock.current,
}));
vi.mock("../../../apps/console/lib/context-compiler-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/context-compiler-client")>(),
  saveContextProfiles: contextCompilerClientMock.saveContextProfiles,
}));

function profileRow(profile: Record<string, unknown>) {
  return {
    profileId: String(profile.profileId || ""),
    label: String(profile.label || ""),
    contextWindowTokens: null,
    compressionMode: "",
    strategy: "",
    referenceBudget: null,
    historyBudget: null,
    recentTurnBudget: null,
    operatorGuidanceRatio: null,
    protectedEvidenceFields: [],
    modelCompressionAlias: "",
    modelCompressionConfigured: false,
    modelCompressionEnabled: false,
  };
}

function mountView(profiles: Record<string, unknown>[]) {
  const contextProfilesResponse = ref<Record<string, unknown>>({ profiles });
  const refreshContextCompiler = vi.fn(async () => undefined);
  shellContextMock.current = {
    busyKey: ref(""),
    contextBuildRecordRows: ref([]),
    contextEvaluationResult: ref(null),
    contextPreviewRequiredEvidence: ref(""),
    contextPreviewResult: ref(null),
    contextPreviewTask: ref(""),
    contextProfileRows: computed(() => profiles.map(profileRow)),
    contextProfilesResponse,
    exportContextBuildRecords: vi.fn(),
    highlightedConfigTarget: ref(""),
    previewContextCompiler: vi.fn(),
    refreshContextCompiler,
    runContextReplayEvaluation: vi.fn(),
  };
  return {
    contextProfilesResponse,
    refreshContextCompiler,
    wrapper: mount(ContextManagementView, {
      global: {
        stubs: {
          ConfigFoldCard: true,
        },
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shellContextMock.current = null;
  contextCompilerClientMock.saveContextProfiles.mockImplementation(async (payload) => payload);
});

describe("ContextManagementView configuration truthfulness", () => {
  it("keeps explicit profile IDs visible and rejects sparse profiles without filling defaults", async () => {
    const { wrapper } = mountView([
      { profileId: "profile-alpha" },
      { profileId: "profile-beta" },
    ]);

    expect(wrapper.text()).toContain("profile-alpha");
    expect(wrapper.text()).toContain("profile-beta");
    expect(wrapper.text()).not.toContain("deterministic");
    expect(wrapper.text()).not.toContain("默认规则");

    await wrapper.find(".context-profile-item .table-action").trigger("click");
    const inputs = wrapper.findAll(".meshrix-modal input");
    expect(inputs.map((input) => input.element.value)).toEqual([
      "profile-alpha",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    await wrapper.find("form.meshrix-modal").trigger("submit");
    await flushPromises();

    expect(contextCompilerClientMock.saveContextProfiles).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("请填写窗口总量。");
  });

  it("applies the candidate template only after the user opens the add form", async () => {
    const { wrapper } = mountView([]);

    expect(wrapper.find(".meshrix-modal").exists()).toBe(false);
    await wrapper.find(".section-actions button").trigger("click");

    const inputs = wrapper.findAll(".meshrix-modal input");
    expect(inputs.map((input) => input.element.value)).toEqual([
      "",
      "",
      "128000",
      "40960",
      "32768",
      "20480",
      "0.08",
    ]);
    await inputs[0].setValue("new-profile");
    await wrapper.find("form.meshrix-modal").trigger("submit");
    await flushPromises();

    const payload = contextCompilerClientMock.saveContextProfiles.mock.calls[0][0];
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]).toMatchObject({
      profileId: "new-profile",
      contextWindowTokens: 128_000,
      compression: {
        strategy: "deterministic-extractive",
      },
      compactionPolicy: {
        strategy: { id: "deterministic-extractive", params: {} },
      },
    });
    expect(payload.profiles[0]).not.toHaveProperty("label");
    expect(payload.profiles[0]).not.toHaveProperty("modelAlias");
  });
});
