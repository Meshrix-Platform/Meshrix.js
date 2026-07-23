// @vitest-environment jsdom
import { defineComponent, h, nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrowseSelectButton from "../../../apps/console/components/BrowseSelectButton.vue";

type DirectoryEntry = BrowserDirectoryHandle | BrowserFileHandle;

type BrowserDirectoryHandle = {
  kind: "directory";
  name: string;
  values?: () => AsyncIterable<DirectoryEntry>;
  entries?: () => AsyncIterable<[string, DirectoryEntry]>;
};

type BrowserFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

const mountedWrappers: VueWrapper[] = [];

const ElButtonStub = defineComponent({
  name: "ElButton",
  props: {
    disabled: Boolean,
    loading: Boolean,
    plain: Boolean,
    size: String,
    type: String,
  },
  emits: ["click"],
  setup(props, { emit, slots, attrs }) {
    return () =>
      h(
        "button",
        {
          class: ["el-button-stub", attrs.class],
          type: "button",
          disabled: !!props.disabled,
          "data-loading": String(!!props.loading),
          "data-plain": String(!!props.plain),
          "data-size": String(props.size || ""),
          "data-type": String(props.type || ""),
          onClick: () => {
            if (props.disabled) {
              return;
            }
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

function mountButton(props: Record<string, unknown> = {}) {
  const wrapper = mount(BrowseSelectButton, {
    attachTo: document.body,
    props: {
      kind: "server-file",
      ...props,
    },
    global: {
      stubs: {
        "el-button": ElButtonStub,
      },
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

function createFileHandle(name: string, file: File): BrowserFileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => file),
  };
}

function createDirectoryHandle(name: string, entries: DirectoryEntry[]): BrowserDirectoryHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      for (const entry of entries) {
        yield entry;
      }
    },
  };
}

function createEntriesDirectoryHandle(name: string, entries: DirectoryEntry[]): BrowserDirectoryHandle {
  return {
    kind: "directory",
    name,
    entries: async function* () {
      for (const entry of entries) {
        yield [entry.name, entry];
      }
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  while (mountedWrappers.length) {
    mountedWrappers.pop()?.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowseSelectButton", () => {
  it("renders the expected button text and forwards loading state", async () => {
    const remote = mountButton({
      kind: "server-file",
      buttonText: "浏览网关目录",
      loading: true,
    });

    expect(remote.get("button").text()).toBe("浏览网关目录");
    expect(remote.get("button").attributes("data-loading")).toBe("true");
    expect(remote.get("button").attributes("disabled")).toBeUndefined();
    await remote.get("button").trigger("click");
    expect(remote.emitted("browse")).toBeUndefined();
  });

  it("emits browse for remote kinds and ignores disabled clicks", async () => {
    const remote = mountButton({ kind: "server-directory" });

    await remote.get("button").trigger("click");

    expect(remote.emitted("browse")?.[0]).toEqual([]);

    const disabled = mountButton({ kind: "server-file", disabled: true });

    await disabled.get("button").trigger("click");

    expect(disabled.emitted("browse")).toBeUndefined();
  });

  it("opens the native file input and emits selected files", async () => {
    const wrapper = mountButton({
      kind: "local-files",
      accept: ".md,.txt",
      multiple: false,
    });
    const input = wrapper.get("input[type=\"file\"]");
    const clickSpy = vi.spyOn(input.element, "click").mockImplementation(() => undefined);
    const file = new File(["alpha"], "alpha.txt", {
      type: "text/plain",
      lastModified: 123,
    });

    await wrapper.get("button").trigger("click");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(input.attributes("accept")).toBe(".md,.txt");
    expect(input.attributes("multiple")).toBeUndefined();

    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [file],
    });

    await input.trigger("change");

    expect(wrapper.emitted("select")?.[0]).toEqual([[file]]);
    expect(wrapper.emitted("directory")).toBeUndefined();
  });

  it("opens a local directory picker and emits the directory plus collected files", async () => {
    const firstFile = new File(["first"], "first.md", { type: "text/markdown" });
    const nestedFile = new File(["second"], "second.md", { type: "text/markdown" });
    const nestedDirectory = createDirectoryHandle("nested", [
      createFileHandle("second.md", nestedFile),
    ]);
    const rootDirectory = createDirectoryHandle("project", [
      createFileHandle("first.md", firstFile),
      nestedDirectory,
    ]);
    const picker = vi.fn(async () => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper = mountButton({ kind: "local-directory" });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();
    await flushAsyncWork();

    expect(picker).toHaveBeenCalledWith({ mode: "read" });
    expect(wrapper.emitted("directory")?.[0]).toEqual([{ name: "project", path: "project" }]);

    const selection = wrapper.emitted("select")?.[0]?.[0] as File[];
    expect(selection).toHaveLength(2);
    expect(selection.map((file) => file.name)).toEqual(["first.md", "second.md"]);
    expect((selection[0] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/first.md");
    expect((selection[1] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/nested/second.md");
  });

  it("collects directory picker entries and clones files when relative path assignment fails", async () => {
    const firstFile = new File(["first"], "first.md", { type: "text/markdown" });
    const defineProperty = Object.defineProperty;
    vi.spyOn(Object, "defineProperty").mockImplementation((target, property, descriptor) => {
      if (target === firstFile && property === "webkitRelativePath") {
        throw new TypeError("readonly relative path");
      }
      return defineProperty(target, property, descriptor);
    });
    const rootDirectory = createEntriesDirectoryHandle("project", [
      createFileHandle("first.md", firstFile),
      { kind: "directory", name: "empty" },
    ]);
    const picker = vi.fn(async () => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper = mountButton({ kind: "local-directory" });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();
    await flushAsyncWork();

    const selection = wrapper.emitted("select")?.[0]?.[0] as File[];
    expect(selection).toHaveLength(1);
    expect(selection[0]).not.toBe(firstFile);
    expect((selection[0] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/first.md");
  });

  it("falls back to the native directory input when the picker API is unavailable", async () => {
    vi.stubGlobal("showDirectoryPicker", undefined);
    vi.spyOn(Date, "now").mockReturnValue(12345);

    const wrapper = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });
    const input = wrapper.get("input[type=\"file\"]");
    const clickSpy = vi.spyOn(input.element, "click").mockImplementation(() => undefined);

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(clickSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [],
    });
    await input.trigger("change");

    expect(wrapper.emitted("directory")?.[0]).toEqual([
      { name: "本地文件夹", path: "local-directory-12345" },
    ]);
  });

  it("emits only the directory handle metadata when directory path mode uses the picker", async () => {
    const rootDirectory = createDirectoryHandle("project", [
      createFileHandle("first.md", new File(["first"], "first.md")),
    ]);
    const picker = vi.fn(async () => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(wrapper.emitted("directory")?.[0]).toEqual([{ name: "project", path: "project" }]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("cancels directory picking without emitting anything", async () => {
    const picker = vi.fn(async () => {
      throw new DOMException("User aborted", "AbortError");
    });

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper = mountButton({ kind: "local-directory" });
    const input = wrapper.get("input[type=\"file\"]");
    const clickSpy = vi.spyOn(input.element, "click").mockImplementation(() => undefined);

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(clickSpy).not.toHaveBeenCalled();
    expect(wrapper.emitted("directory")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("falls back to the file input when directory selection errors and still parses path mode", async () => {
    const picker = vi.fn(async () => {
      throw new Error("picker failed");
    });

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });
    const input = wrapper.get("input[type=\"file\"]");
    const clickSpy = vi.spyOn(input.element, "click").mockImplementation(() => undefined);
    const file = new File(["payload"], "index.md", { type: "text/markdown" });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(clickSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: "project/docs/index.md",
    });
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [file],
    });

    await input.trigger("change");

    expect(wrapper.emitted("directory")?.[0]).toEqual([{ name: "project", path: "project" }]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });
});
