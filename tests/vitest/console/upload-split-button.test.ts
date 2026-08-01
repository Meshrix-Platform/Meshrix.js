// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dismissControllerMock: any = vi.hoisted(() : any => ({
  calls: [] as Array<{
    active: { value: boolean };
    onDismiss: () => void;
    root: { value: HTMLElement | null };
  }>,
}));

vi.mock("../../../apps/console/composables/console-document-dismiss-controller", () : any => ({
  useConsoleDocumentDismissController: (options: {
    active: { value: boolean };
    onDismiss: () => void;
    root: { value: HTMLElement | null };
  }) : any => {
    dismissControllerMock.calls.push(options);
    return {
      handleDocumentKeydown: vi.fn(),
      handleDocumentPointerDown: vi.fn(),
    };
  },
}));

vi.mock("../../../apps/console/components/BrowseSelectButton.vue", () : any => ({
  default: defineComponent({
    name: "BrowseSelectButton",
    props: {
      buttonClass: String,
      buttonText: String,
      disabled: Boolean,
      kind: String,
      multiple: Boolean,
    },
    emits: ["select"],
    setup(props: any, { emit, slots }: Record<string, any>) : any {
      function handleClick() : any {
        if (props.disabled) {
          return;
        }
        if (props.kind === "local-files") {
          emit("select", [
            new File(["main"], "main.txt", { type: "text/plain" }),
          ]);
          return;
        }
        if (props.kind === "local-directory") {
          emit("select", [
            new File(["folder"], "folder.txt", { type: "text/plain" }),
          ]);
        }
      }

      return () : any =>
        h(
          "button",
          {
            class: ["browse-select-button-stub", props.buttonClass, props.kind],
            type: "button",
            disabled: !!props.disabled,
            "data-kind": props.kind,
            "data-multiple": String(!!props.multiple),
            onClick: handleClick,
          },
          slots.default?.() ?? props.buttonText,
        );
    },
  }),
}));

import UploadSplitButton from "../../../apps/console/components/upload/UploadSplitButton.vue";

const mountedWrappers: VueWrapper[] = [];

function mountUploadSplitButton(props: Record<string, unknown> = {}) : any {
  const wrapper: any = mount(UploadSplitButton, {
    attachTo: document.body,
    props,
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

async function flush() : Promise<any> {
  await nextTick();
  await nextTick();
}

afterEach(() : any => {
  while (mountedWrappers.length > 0) {
    mountedWrappers.pop()?.unmount();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

beforeEach(() : any => {
  dismissControllerMock.calls.length = 0;
});

describe("UploadSplitButton behavior", () : any => {
  it("emits file selection, toggles the menu, closes after folder selection, and reacts to dismiss", async () : Promise<any> => {
    const wrapper: any = mountUploadSplitButton();
    const mainButton: any = wrapper.get(".browse-select-button-stub[data-kind=\"local-files\"]");
    const arrowButton: any = wrapper.get(".upload-split-arrow");

    await mainButton.trigger("click");
    expect(wrapper.emitted("select")?.[0]?.[0]).toHaveLength(1);
    expect((wrapper.emitted("select")?.[0]?.[0] as File[])[0].name).toBe("main.txt");

    expect(arrowButton.attributes("aria-expanded")).toBe("false");
    await arrowButton.trigger("click");
    await flush();

    expect(arrowButton.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get(".upload-split-menu").attributes("role")).toBe("menu");

    await arrowButton.trigger("click");
    await flush();

    expect(wrapper.find(".upload-split-menu").exists()).toBe(false);
    expect(arrowButton.attributes("aria-expanded")).toBe("false");

    await arrowButton.trigger("click");
    await flush();

    const folderButton: any = wrapper.get(".browse-select-button-stub[data-kind=\"local-directory\"]");
    await folderButton.trigger("click");
    await flush();

    expect(wrapper.find(".upload-split-menu").exists()).toBe(false);
    expect((wrapper.emitted("select")?.[1]?.[0] as File[])[0].name).toBe("folder.txt");

    await arrowButton.trigger("click");
    await flush();

    expect(dismissControllerMock.calls).toHaveLength(1);
    expect(dismissControllerMock.calls[0].active.value).toBe(true);
    expect(dismissControllerMock.calls[0].root.value).toBe(wrapper.get(".upload-split-button").element);

    dismissControllerMock.calls[0].onDismiss();
    await flush();

    expect(wrapper.find(".upload-split-menu").exists()).toBe(false);
    expect(arrowButton.attributes("aria-expanded")).toBe("false");
  });

  it("keeps both controls inert when disabled", async () : Promise<any> => {
    const wrapper: any = mountUploadSplitButton({ disabled: true });
    const mainButton: any = wrapper.get(".browse-select-button-stub[data-kind=\"local-files\"]");
    const arrowButton: any = wrapper.get(".upload-split-arrow");

    expect(mainButton.attributes("disabled")).toBeDefined();
    expect(arrowButton.attributes("disabled")).toBeDefined();

    await mainButton.trigger("click");
    arrowButton.element.click();
    await flush();

    expect(wrapper.emitted("select")).toBeUndefined();
    expect(wrapper.find(".upload-split-menu").exists()).toBe(false);
    expect(arrowButton.attributes("aria-expanded")).toBe("false");
  });
});
