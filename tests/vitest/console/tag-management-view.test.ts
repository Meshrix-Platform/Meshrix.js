// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

const tagManagementMock = vi.hoisted(() => ({ current: null as any }));

vi.mock("../../../apps/console/composables/console-tag-management-controller", () => ({
  tagManagementArchiveOptions: [
    { value: false, label: "仅显示当前标签" },
    { value: true, label: "包含归档标签" },
  ],
  tagManagementKindOptions: [{ value: "", label: "全部类型" }],
  tagManagementStatusOptions: [{ value: "", label: "全部状态" }],
  useTagManagementConsole: () => tagManagementMock.current,
}));

import TagManagementView from "../../../apps/console/views/admin/TagManagementView.vue";

describe("tag management filters", () => {
  it("uses the shared log-style filter card and compact counters", () => {
    tagManagementMock.current = {
      archiveSelectedTag: vi.fn(),
      auditItems: ref([]),
      editor: ref({}),
      error: ref(""),
      includeArchived: ref(true),
      kindFilter: ref(""),
      loading: ref(false),
      parentTagOptions: ref([]),
      projections: ref([]),
      rebuildProjections: vi.fn(),
      refreshTagManagement: vi.fn(),
      restoreSelectedTag: vi.fn(),
      saveEditor: vi.fn(),
      saving: ref(false),
      selectTag: vi.fn(),
      selectedProjection: ref(null),
      selectedProjectionPayload: ref("{}"),
      selectedTag: ref(null),
      selectedTagId: ref(""),
      startNewTag: vi.fn(),
      status: ref(""),
      statusFilter: ref(""),
      tagStats: ref({ total: 12, active: 9, archived: 3, projections: 4, audit: 7 }),
      treeRows: ref([]),
    };

    const wrapper = mount(TagManagementView, {
      global: {
        stubs: {
          ConsoleInlineAlert: true,
          OptionBar: { props: ["label"], template: "<label class='option-bar-stub'>{{ label }}</label>" },
          TagAuditList: true,
          TagEditorForm: true,
          TagProjectionCard: true,
          TagTreePanel: true,
        },
      },
    });

    expect(wrapper.find(".tag-management-control-panel.surface-card").exists()).toBe(true);
    expect(wrapper.find(".tag-management-filters.filter-control-grid").exists()).toBe(true);
    expect(wrapper.findAll(".option-bar-stub").map((field) => field.text())).toEqual([
      "类型",
      "状态",
      "显示范围",
    ]);
    expect(wrapper.findAll(".section-tags span").map((counter) => counter.text())).toEqual([
      "全部 12",
      "启用 9",
      "归档 3",
      "投影 4",
      "审计 7",
    ]);
    expect(wrapper.find(".tag-management-summary").exists()).toBe(false);
    expect(wrapper.text()).toContain("新建标签");
    expect(wrapper.findAll("button").some((button) => button.text() === "刷新")).toBe(false);
  });
});
