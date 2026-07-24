// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

const shellState = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
}));

vi.mock("../../../apps/console/composables/serverConsoleShellContext", () => ({
  useServerConsoleShellContext: () => shellState.context,
}));

import ServerPathPickerDialog from "../../../apps/console/components/shell/ServerPathPickerDialog.vue";

function createPathPicker(overrides: Record<string, unknown> = {}) {
  return reactive({
    open: true,
    title: "选择文件",
    mode: "file",
    value: "/workspace",
    extensions: [".md", ".txt"],
    includeHidden: false,
    loading: false,
    error: "",
    closeOnSelect: false,
    response: {
      currentPath: "/workspace/docs",
      parentPath: "/workspace",
      truncated: true,
      roots: [
        { label: "Home", path: "/private/user" },
        { label: "Tmp", path: "/tmp" },
      ],
      entries: [
        {
          name: "notes",
          path: "/workspace/docs/notes",
          type: "directory",
          browsable: true,
          selectable: false,
        },
        {
          name: "readme.md",
          path: "/workspace/docs/readme.md",
          type: "file",
          browsable: false,
          selectable: true,
          byteSize: 128,
          modifiedAt: "2026-06-04T00:00:00.000Z",
        },
      ],
    },
    ...overrides,
  });
}

function mountDialog(pathPicker = createPathPicker()) {
  const context = {
    closeServerPathPicker: vi.fn(),
    confirmServerPathPicker: vi.fn(),
    openPathEntry: vi.fn(),
    pathEntryMeta: vi.fn((entry: { type: string; byteSize?: number }) =>
      entry.type === "file" ? `${entry.byteSize || 0} B / date` : ""),
    pathPicker,
    pathPickerModeLabel: vi.fn((mode: string) => (mode === "file" ? "文件" : "目录")),
    refreshServerPathBrowser: vi.fn(),
    selectServerPath: vi.fn(),
  };
  shellState.context = context;
  return {
    context,
    pathPicker,
    wrapper: mount(ServerPathPickerDialog, {
      global: {
        stubs: {
          BinaryCheckbox: {
            props: ["modelValue", "label"],
            emits: ["update:modelValue", "change"],
            methods: {
              onChange(event: Event) {
                this.$emit("update:modelValue", (event.target as HTMLInputElement).checked);
                this.$emit("change");
              },
            },
            template: `
              <label class="binary-checkbox-stub">
                <input
                  type="checkbox"
                  :checked="modelValue"
                  @change="onChange"
                />
                {{ label }}
              </label>
            `,
          },
        },
      },
    }),
  };
}

describe("ServerPathPickerDialog behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellState.context = {};
  });

  it("renders a populated picker and delegates mouse and keyboard actions", async () => {
    const { context, wrapper } = mountDialog();

    expect(wrapper.find('[role="dialog"]').attributes("aria-label")).toBe("选择文件");
    expect(wrapper.text()).toContain("选择服务端可访问的文件路径");
    expect(wrapper.find("input[readonly]").element.getAttribute("value")).toBe("/workspace/docs");
    expect(wrapper.text()).toContain("只显示可选文件类型：.md, .txt");
    expect(wrapper.text()).toContain("当前目录内容较多，只显示前 600 项。");
    expect(wrapper.text()).toContain("128 B / date");
    expect(context.pathPickerModeLabel).toHaveBeenCalledWith("file");
    expect(context.pathEntryMeta).toHaveBeenCalled();

    await wrapper.find(".path-picker-close-button").trigger("click");
    expect(context.closeServerPathPicker).toHaveBeenCalledTimes(1);

    const rootButtons = wrapper.findAll(".path-picker-roots button");
    await rootButtons[0].trigger("click");
    expect(context.refreshServerPathBrowser).toHaveBeenCalledWith("/private/user");

    const toolbarButtons = wrapper.findAll(".path-picker-toolbar button");
    await toolbarButtons[0].trigger("click");
    expect(context.refreshServerPathBrowser).toHaveBeenCalledWith("/workspace");
    await toolbarButtons[1].trigger("click");
    expect(context.refreshServerPathBrowser).toHaveBeenCalledWith();

    await wrapper.find(".binary-checkbox-stub input").trigger("change");
    expect(context.refreshServerPathBrowser).toHaveBeenCalledWith();

    const browsable = wrapper.find(".path-picker-entry-main.is-browsable");
    await browsable.trigger("click");
    await browsable.trigger("keydown.enter");
    await browsable.trigger("keydown.space");
    expect(context.openPathEntry).toHaveBeenCalledTimes(3);
    expect(context.openPathEntry).toHaveBeenCalledWith(expect.objectContaining({ path: "/workspace/docs/notes" }));

    await wrapper.find(".path-picker-entry-actions button").trigger("click");
    expect(context.selectServerPath).toHaveBeenCalledWith("/workspace/docs/readme.md");

    const footerButtons = wrapper.findAll(".path-picker-footer button");
    await footerButtons[0].trigger("click");
    await footerButtons[1].trigger("click");
    expect(context.confirmServerPathPicker).toHaveBeenCalledTimes(1);
    expect(context.closeServerPathPicker).toHaveBeenCalledTimes(2);

    await wrapper.find(".path-picker-backdrop").trigger("click");
    expect(context.closeServerPathPicker).toHaveBeenCalledTimes(3);
  });

  it("renders empty, loading, error, disabled parent, and closed branches", () => {
    const emptyPicker = createPathPicker({
      mode: "directory",
      extensions: [],
      loading: false,
      error: "读取失败",
      closeOnSelect: true,
      response: {
        currentPath: "",
        parentPath: "",
        truncated: false,
        roots: [],
        entries: [],
      },
    });
    const { wrapper } = mountDialog(emptyPicker);

    expect(wrapper.text()).toContain("选择服务端可访问的目录路径");
    expect(wrapper.text()).toContain("读取失败");
    expect(wrapper.text()).toContain("没有可显示的项目");
    expect(wrapper.find(".path-picker-toolbar button").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".path-picker-footer button").text()).toBe("取消");
    expect(wrapper.find(".path-picker-footer button").text()).not.toBe("确认");

    const loadingPicker = createPathPicker({
      loading: true,
      response: {
        currentPath: "",
        parentPath: "",
        truncated: false,
        roots: [],
        entries: [],
      },
    });
    const loading = mountDialog(loadingPicker).wrapper;
    expect(loading.text()).toContain("正在读取目录");

    const closed = mountDialog(createPathPicker({ open: false })).wrapper;
    expect(closed.find('[role="dialog"]').exists()).toBe(false);
  });
});
