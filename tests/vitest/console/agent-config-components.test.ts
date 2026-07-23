// @vitest-environment jsdom
import { defineComponent, h, nextTick, reactive, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentInvocationSettingsPanel from "../../../apps/console/components/admin/agent-config/AgentInvocationSettingsPanel.vue";
import AgentModelEntrySummaryActions from "../../../apps/console/components/admin/agent-config/AgentModelEntrySummaryActions.vue";

const shellContext = vi.hoisted(() => ({} as any));
const modelEntryContext = vi.hoisted(() => ({} as any));

vi.mock("../../../apps/console/composables/serverConsoleShellContext", () => ({
  useServerConsoleShellContext: () => shellContext,
}));

vi.mock("../../../apps/console/composables/agentModelEntryCardContext", () => ({
  useAgentModelEntryCardContext: () => modelEntryContext,
}));

const mounted: VueWrapper[] = [];

const InvocationToggleStub = defineComponent({
  name: "AgentConfigInvocationToggle",
  props: {
    label: { type: String, default: "" },
    modelValue: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "button",
        {
          type: "button",
          class: "invocation-toggle-stub",
          "data-enabled": props.modelValue ? "true" : "false",
          onClick: () => emit("update:modelValue", !props.modelValue),
        },
        props.label,
      );
  },
});

const JsonConfigFileEditorStub = defineComponent({
  name: "JsonConfigFileEditor",
  props: {
    title: { type: String, default: "" },
    onSave: { type: Function, required: true },
  },
  setup(props) {
    return () =>
      h("div", { class: "json-editor-stub", "data-title": props.title }, [
        h(
          "button",
          {
            type: "button",
            class: "save-valid-json",
            onClick: () =>
              props.onSave(
                props.title.includes("本地命令模板")
                  ? [{ id: "local-command", command: "echo ok" }]
                  : { type: "object", properties: { prompt: { type: "string" } } },
              ),
          },
          "save valid",
        ),
        h(
          "button",
          {
            type: "button",
            class: "save-invalid-json",
            onClick: () =>
              props.onSave(props.title.includes("本地命令模板") ? { invalid: true } : ["invalid"]),
          },
          "save invalid",
        ),
      ]);
  },
});

function resetShellContext() {
  shellContext.busyKey = ref("");
  shellContext.saveSettings = vi.fn(async () => undefined);
  shellContext.settingsDraft = ref({
    agentToolExecution: {
      http: {
        enabled: false,
        allowedHosts: ["api.local"],
        timeoutMs: 5000,
        maxResponseBytes: 4096,
      },
      local: {
        enabled: true,
        timeoutMs: 3000,
        maxOutputBytes: 8192,
        commands: [{ id: "initial", command: "pwd" }],
      },
      functionCallSchema: {
        type: "object",
      },
    },
  });
}

function resetModelEntryContext() {
  modelEntryContext.busyKey = ref("");
  modelEntryContext.duplicateModelEntry = vi.fn();
  modelEntryContext.exportAgentModelEntryConfig = vi.fn();
  modelEntryContext.modelEntryBindingSummary = vi.fn(() => "任务 A");
  modelEntryContext.modelEntryIsBound = vi.fn(() => false);
  modelEntryContext.modelEntryStatusKey = vi.fn((entry: { id?: string; provider?: string }) => `${entry.provider || "provider"}:${entry.id || "model"}`);
  modelEntryContext.modelProbeResults = ref<Record<string, any>>({});
  modelEntryContext.probeModelEntry = vi.fn();
  modelEntryContext.removeModelProvider = vi.fn();
}

function mountInvocationPanel() {
  const wrapper = mount(AgentInvocationSettingsPanel, {
    global: {
      stubs: {
        AgentConfigInvocationToggle: InvocationToggleStub,
        JsonConfigFileEditor: JsonConfigFileEditorStub,
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

function mountEntryActions(entry: Record<string, unknown>) {
  const wrapper = mount(AgentModelEntrySummaryActions, {
    props: { entry },
  });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetShellContext();
  resetModelEntryContext();
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount();
  }
  vi.restoreAllMocks();
});

describe("agent config components", () => {
  it("saves invocation settings, updates hosts, and validates JSON editor payloads", async () => {
    const wrapper = mountInvocationPanel();

    const hostInput = wrapper.findAll("input").find((input) => input.element.getAttribute("value")?.includes("api.local"));
    expect(hostInput).toBeTruthy();
    await hostInput!.setValue("api.local, tools.local, ");

    await wrapper.find("form").trigger("submit.prevent");
    expect(shellContext.saveSettings).toHaveBeenCalledTimes(1);
    expect(shellContext.settingsDraft.value.agentToolExecution.http.allowedHosts).toEqual([
      "api.local",
      "tools.local",
    ]);

    await wrapper.findAll(".save-valid-json")[0].trigger("click");
    await nextTick();
    expect(shellContext.settingsDraft.value.agentToolExecution.local.commands).toEqual([
      { id: "local-command", command: "echo ok" },
    ]);

    await wrapper.findAll(".save-valid-json")[1].trigger("click");
    await nextTick();
    expect(shellContext.settingsDraft.value.agentToolExecution.functionCallSchema).toEqual({
      type: "object",
      properties: {
        prompt: {
          type: "string",
        },
      },
    });
    expect(shellContext.saveSettings).toHaveBeenCalledTimes(3);

    const localEditor = wrapper.findAllComponents(JsonConfigFileEditorStub)[0];
    const schemaEditor = wrapper.findAllComponents(JsonConfigFileEditorStub)[1];
    await expect(localEditor.props("onSave")({ invalid: true })).rejects.toThrow("本地命令模板必须是 JSON 数组。");
    await expect(schemaEditor.props("onSave")(["invalid"])).rejects.toThrow("function call schema 必须是 JSON 对象。");
  });

  it("renders model entry actions, calls handlers, and shows busy/bound/probe states", async () => {
    const entry = reactive({ provider: "openai", id: "gpt-unit" });
    modelEntryContext.modelProbeResults.value["openai:gpt-unit"] = {
      ok: true,
      statusCode: 200,
      answerSnippet: "pong",
      latencyMs: 42,
    };

    const wrapper = mountEntryActions(entry);

    expect(wrapper.text()).toContain("openai:gpt-unit");
    expect(wrapper.text()).toContain("HTTP 200");
    expect(wrapper.text()).toContain("pong");
    expect(wrapper.text()).toContain("42ms");

    const buttons = wrapper.findAll("button");
    await buttons[0].trigger("click");
    await buttons[1].trigger("click");
    await buttons[2].trigger("click");
    await buttons[3].trigger("click");

    expect(modelEntryContext.probeModelEntry).toHaveBeenCalledWith(entry);
    expect(modelEntryContext.exportAgentModelEntryConfig).toHaveBeenCalledWith(entry);
    expect(modelEntryContext.duplicateModelEntry).toHaveBeenCalledWith(entry);
    expect(modelEntryContext.removeModelProvider).toHaveBeenCalledWith(entry);

    modelEntryContext.busyKey.value = "model-probe:openai:gpt-unit";
    await nextTick();
    expect(buttons[0].attributes("disabled")).toBeDefined();
    expect(buttons[0].text()).toBe("探测中");

    wrapper.unmount();
    mounted.pop();

    modelEntryContext.busyKey.value = "model-remove:openai:gpt-unit";
    modelEntryContext.modelEntryIsBound.mockReturnValue(true);
    const boundWrapper = mountEntryActions(entry);
    const boundRemoveButton = boundWrapper.findAll("button")[3];
    expect(boundRemoveButton.attributes("disabled")).toBeDefined();
    expect(boundRemoveButton.attributes("title")).toBe("已绑定到 任务 A，请先解除引用。");
    expect(boundRemoveButton.text()).toBe("移除中");
  });
});
