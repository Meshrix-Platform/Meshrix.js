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

const ElButtonStub: any = defineComponent({
  name: "ElButton",
  props: {
    disabled: Boolean,
    loading: Boolean,
    plain: Boolean,
    size: String,
    type: String,
  },
  emits: ["click"],
  setup(props: any, { emit, slots, attrs }: Record<string, any>) : any {
    return () : any =>
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
          onClick: () : any => {
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

function mountButton(props: Record<string, unknown> = {}) : any {
  const wrapper: any = mount(BrowseSelectButton, {
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
    getFile: vi.fn(async () : Promise<any> => file),
  };
}

function createDirectoryHandle(name: string, entries: DirectoryEntry[]): BrowserDirectoryHandle {
  return {
    kind: "directory",
    name,
    values: async function* () : AsyncGenerator<any, any, any> {
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
    entries: async function* () : AsyncGenerator<any, any, any> {
      for (const entry of entries) {
        yield [entry.name, entry];
      }
    },
  };
}

async function flushAsyncWork() : Promise<any> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() : any => {
  while (mountedWrappers.length) {
    mountedWrappers.pop()?.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowseSelectButton", () : any => {
  it("renders the expected button text and forwards loading state", async () : Promise<any> => {
    const remote: any = mountButton({
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

  it("emits browse for remote kinds and ignores disabled clicks", async () : Promise<any> => {
    const remote: any = mountButton({ kind: "server-directory" });

    await remote.get("button").trigger("click");

    expect(remote.emitted("browse")?.[0]).toEqual([]);

    const disabled: any = mountButton({ kind: "server-file", disabled: true });

    await disabled.get("button").trigger("click");

    expect(disabled.emitted("browse")).toBeUndefined();
  });

  it("opens the native file input and emits selected files", async () : Promise<any> => {
    const wrapper: any = mountButton({
      kind: "local-files",
      accept: ".md,.txt",
      multiple: false,
    });
    const input: any = wrapper.get("input[type=\"file\"]");
    const clickSpy: any = vi.spyOn(input.element, "click").mockImplementation(() : any => undefined);
    const file: any = new File(["alpha"], "alpha.txt", {
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

  it("opens a local directory picker and emits the directory plus collected files", async () : Promise<any> => {
    const firstFile: any = new File(["first"], "first.md", { type: "text/markdown" });
    const nestedFile: any = new File(["second"], "second.md", { type: "text/markdown" });
    const nestedDirectory: any = createDirectoryHandle("nested", [
      createFileHandle("second.md", nestedFile),
    ]);
    const rootDirectory: any = createDirectoryHandle("project", [
      createFileHandle("first.md", firstFile),
      nestedDirectory,
    ]);
    const picker: any = vi.fn(async () : Promise<any> => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper: any = mountButton({ kind: "local-directory" });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();
    await flushAsyncWork();

    expect(picker).toHaveBeenCalledWith({ mode: "read" });
    expect(wrapper.emitted("directory")?.[0]).toEqual([{ name: "project", path: "project" }]);

    const selection: any = wrapper.emitted("select")?.[0]?.[0] as File[];
    expect(selection).toHaveLength(2);
    expect(selection.map((file?: any) : any => file.name)).toEqual(["first.md", "second.md"]);
    expect((selection[0] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/first.md");
    expect((selection[1] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/nested/second.md");
  });

  it("collects directory picker entries and clones files when relative path assignment fails", async () : Promise<any> => {
    const firstFile: any = new File(["first"], "first.md", { type: "text/markdown" });
    const defineProperty: any = Object.defineProperty;
    vi.spyOn(Object, "defineProperty").mockImplementation((target?: any, property?: any, descriptor?: any) : any => {
      if (target === firstFile && property === "webkitRelativePath") {
        throw new TypeError("readonly relative path");
      }
      return defineProperty(target, property, descriptor);
    });
    const rootDirectory: any = createEntriesDirectoryHandle("project", [
      createFileHandle("first.md", firstFile),
      { kind: "directory", name: "empty" },
    ]);
    const picker: any = vi.fn(async () : Promise<any> => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper: any = mountButton({ kind: "local-directory" });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();
    await flushAsyncWork();

    const selection: any = wrapper.emitted("select")?.[0]?.[0] as File[];
    expect(selection).toHaveLength(1);
    expect(selection[0]).not.toBe(firstFile);
    expect((selection[0] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe("project/first.md");
  });

  it("falls back to the native directory input when the picker API is unavailable", async () : Promise<any> => {
    vi.stubGlobal("showDirectoryPicker", undefined);
    vi.spyOn(Date, "now").mockReturnValue(12345);

    const wrapper: any = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });
    const input: any = wrapper.get("input[type=\"file\"]");
    const clickSpy: any = vi.spyOn(input.element, "click").mockImplementation(() : any => undefined);

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

  it("emits only the directory handle metadata when directory path mode uses the picker", async () : Promise<any> => {
    const rootDirectory: any = createDirectoryHandle("project", [
      createFileHandle("first.md", new File(["first"], "first.md")),
    ]);
    const picker: any = vi.fn(async () : Promise<any> => rootDirectory);

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper: any = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(wrapper.emitted("directory")?.[0]).toEqual([{ name: "project", path: "project" }]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("cancels directory picking without emitting anything", async () : Promise<any> => {
    const picker: any = vi.fn(async () : Promise<any> => {
      throw new DOMException("User aborted", "AbortError");
    });

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper: any = mountButton({ kind: "local-directory" });
    const input: any = wrapper.get("input[type=\"file\"]");
    const clickSpy: any = vi.spyOn(input.element, "click").mockImplementation(() : any => undefined);

    await wrapper.get("button").trigger("click");
    await flushAsyncWork();

    expect(clickSpy).not.toHaveBeenCalled();
    expect(wrapper.emitted("directory")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("falls back to the file input when directory selection errors and still parses path mode", async () : Promise<any> => {
    const picker: any = vi.fn(async () : Promise<any> => {
      throw new Error("picker failed");
    });

    vi.stubGlobal("showDirectoryPicker", picker);

    const wrapper: any = mountButton({
      kind: "local-directory",
      directoryMode: "path",
    });
    const input: any = wrapper.get("input[type=\"file\"]");
    const clickSpy: any = vi.spyOn(input.element, "click").mockImplementation(() : any => undefined);
    const file: any = new File(["payload"], "index.md", { type: "text/markdown" });

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
