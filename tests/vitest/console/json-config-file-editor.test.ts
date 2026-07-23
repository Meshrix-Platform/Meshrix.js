// @vitest-environment jsdom
import { defineComponent, h, nextTick } from "vue";
import { mount, VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import JsonConfigFileEditor from "../../../apps/console/components/JsonConfigFileEditor.vue";

const mounted: VueWrapper[] = [];

const ConfigFoldCardStub = defineComponent({
  name: "ConfigFoldCard",
  props: {
    title: String,
    subtitle: String,
    open: Boolean,
  },
  setup(props, { slots }) {
    return () => h("section", {
      class: "config-fold-card-stub",
      "data-title": props.title,
      "data-subtitle": props.subtitle,
      "data-open": String(Boolean(props.open)),
    }, slots.default?.());
  },
});

function mountEditor(props: Record<string, unknown> = {}) {
  const wrapper = mount(JsonConfigFileEditor, {
    attachTo: document.body,
    props: {
      title: "Runtime config",
      fileKey: `file-${Math.random()}`,
      modelValue: { enabled: true },
      ...props,
    },
    global: {
      stubs: {
        ConfigFoldCard: ConfigFoldCardStub,
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

function actionButtons(wrapper: VueWrapper) {
  return wrapper.findAll("button");
}

afterEach(() => {
  while (mounted.length) {
    mounted.pop()?.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("JsonConfigFileEditor", () => {
  it("renders formatted JSON, forwards fold-card props and commits parsed changes", async () => {
    const onSave = vi.fn(async () => undefined);
    const wrapper = mountEditor({
      title: "Agent config",
      subtitle: "agent-tools.json",
      fileKey: "json-editor-save",
      modelValue: { enabled: true, count: 1 },
      open: true,
      rows: 6,
      cancelLabel: "Discard",
      saveLabel: "Apply",
      onSave,
    });

    expect(wrapper.find(".config-fold-card-stub").attributes()).toMatchObject({
      "data-title": "Agent config",
      "data-subtitle": "agent-tools.json",
      "data-open": "true",
    });
    const textarea = wrapper.get("textarea");
    expect(textarea.attributes("rows")).toBe("6");
    expect((textarea.element as HTMLTextAreaElement).value).toContain("\"enabled\": true");
    expect(actionButtons(wrapper)[0].text()).toBe("Discard");
    expect(actionButtons(wrapper)[1].text()).toBe("Apply");
    expect(actionButtons(wrapper)[1].attributes("disabled")).toBeDefined();

    await textarea.setValue("{\"enabled\":false,\"count\":2}");
    expect(actionButtons(wrapper)[1].attributes("disabled")).toBeUndefined();
    await actionButtons(wrapper)[1].trigger("click");

    expect(onSave).toHaveBeenCalledWith({ enabled: false, count: 2 }, "{\"enabled\":false,\"count\":2}");
    expect(wrapper.emitted("save")?.[0]).toEqual([
      { enabled: false, count: 2 },
      JSON.stringify({ enabled: false, count: 2 }, null, 2),
    ]);
    expect((textarea.element as HTMLTextAreaElement).value).toContain("\"count\": 2");
    expect(actionButtons(wrapper)[1].attributes("disabled")).toBeDefined();
  });

  it("reports parse and save errors without losing dirty text", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("write failed");
    });
    const wrapper = mountEditor({
      fileKey: "json-editor-errors",
      modelValue: { enabled: true },
      onSave,
    });
    const textarea = wrapper.get("textarea");
    const save = () => actionButtons(wrapper)[1];

    await textarea.setValue("{not json");
    await save().trigger("click");

    expect(wrapper.text()).toContain("Expected property name");
    expect(wrapper.emitted("parseError")?.[0]?.[0]).toContain("Expected property name");
    expect(onSave).not.toHaveBeenCalled();

    await textarea.setValue("{\"enabled\":false}");
    await save().trigger("click");

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("write failed");
    expect(wrapper.emitted("parseError")?.[1]).toEqual(["write failed"]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("{\"enabled\":false}");
  });

  it("cancels dirty edits and ignores readonly or clean commits", async () => {
    const onSave = vi.fn();
    const wrapper = mountEditor({
      fileKey: "json-editor-cancel",
      modelValue: { enabled: true },
      readonly: true,
      onSave,
    });
    const textarea = wrapper.get("textarea");
    const [cancelButton, saveButton] = actionButtons(wrapper);

    expect(textarea.attributes("readonly")).toBeDefined();
    await textarea.setValue("{\"enabled\":false}");
    expect(cancelButton.attributes("disabled")).toBeDefined();
    expect(saveButton.attributes("disabled")).toBeDefined();
    await saveButton.trigger("click");
    expect(onSave).not.toHaveBeenCalled();

    await wrapper.setProps({ readonly: false });
    expect(cancelButton.attributes("disabled")).toBeUndefined();
    await cancelButton.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect((textarea.element as HTMLTextAreaElement).value).toContain("\"enabled\": true");
    expect(cancelButton.attributes("disabled")).toBeDefined();
  });

  it("keeps singleton editor state per file key and only replaces clean drafts from new props", async () => {
    const first = mountEditor({
      fileKey: "json-editor-singleton",
      modelValue: { version: 1 },
    });
    await first.get("textarea").setValue("{\"version\":2}");

    const second = mountEditor({
      fileKey: "json-editor-singleton",
      modelValue: { version: 10 },
    });
    expect((second.get("textarea").element as HTMLTextAreaElement).value).toBe("{\"version\":2}");

    await second.setProps({ modelValue: { version: 20 } });
    await nextTick();
    expect((second.get("textarea").element as HTMLTextAreaElement).value).toBe("{\"version\":2}");

    await actionButtons(second)[0].trigger("click");
    expect((second.get("textarea").element as HTMLTextAreaElement).value).toContain("\"version\": 1");

    await second.setProps({ modelValue: { version: 30 } });
    await nextTick();
    expect((second.get("textarea").element as HTMLTextAreaElement).value).toContain("\"version\": 30");

    const stringEditor = mountEditor({
      fileKey: "json-editor-string",
      modelValue: "{\"raw\":true}",
    });
    expect((stringEditor.get("textarea").element as HTMLTextAreaElement).value).toBe("{\"raw\":true}");
  });
});
