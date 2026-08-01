// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EMPTY_MODEL_LIBRARY_ACTION,
  useAgentModelOptionBarController,
  type AgentModelOptionBarProps,
} from "../../../apps/console/composables/agentModelOptionBarController";

const navigateBrowserHashRouteMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../apps/console/lib/browser-window", () : any => ({
  navigateBrowserHashRoute: navigateBrowserHashRouteMock,
}));

function createController(props: Partial<AgentModelOptionBarProps> = {}) : any {
  const emit: any = vi.fn();
  const controller: any = useAgentModelOptionBarController({
    modelValue: "",
    options: [],
    showDisabledReason: true,
    emptyLibraryActionIcon: "+",
    emptyLibraryLabel: "配置模型",
    emptyLibraryRoute: "/admin/agent-config",
    ...props,
  }, emit as any);

  return {
    controller,
    emit,
  };
}

function changeEvent(value: string) : any {
  const select: any = document.createElement("select");
  const option: any = document.createElement("option");
  option.value = value;
  select.appendChild(option);
  select.value = value;
  return new Event("change", {
    bubbles: true,
  });
}

function changeEventWithTarget(value: string) : any {
  const event: any = changeEvent(value);
  Object.defineProperty(event, "target", {
    configurable: true,
    value: { value },
  });
  return event;
}

describe("agent model option bar controller behavior", () : any => {
  beforeEach(() : any => {
    navigateBrowserHashRouteMock.mockClear();
  });

  it("normalizes options, removes duplicate or empty values, and appends disabled reasons", () : any => {
    const { controller } = createController({
      modelValue: "agent-a",
      options: [
        { agentUid: "agent-a", value: "legacy-a", label: "Agent A", selectable: true },
        { value: "agent-a", label: "Duplicate Agent A" },
        { value: "", label: "No value" },
        { value: "agent-b", label: "Agent B", selectable: false, reason: "未授权" },
        { value: "agent-c", label: "Agent C", enabled: false },
        { value: "agent-d", label: "Agent D", disabled: true, disabledReason: "离线" },
      ],
    });

    expect(controller.hasConfiguredOptions.value).toBe(true);
    expect(controller.selectValue.value).toBe("agent-a");
    expect(controller.selectOptions.value).toEqual([
      { value: "agent-a", label: "Agent A", disabled: false },
      { value: "agent-b", label: "Agent B（未授权）", disabled: true },
      { value: "agent-c", label: "Agent C（不可用）", disabled: true },
      { value: "agent-d", label: "Agent D（离线）", disabled: true },
    ]);
  });

  it("emits model updates for normal selection changes", () : any => {
    const { controller, emit } = createController({
      options: [
        { value: "agent-a", label: "Agent A" },
      ],
    });

    controller.handleChange(changeEventWithTarget("agent-a"));

    expect(emit).toHaveBeenCalledWith("update:modelValue", "agent-a");
    expect(emit).toHaveBeenCalledWith("change", "agent-a");
    expect(navigateBrowserHashRouteMock).not.toHaveBeenCalled();
  });

  it("navigates to model library when the empty-library action is selected or clicked", () : any => {
    const { controller, emit } = createController({
      options: [],
      emptyLibraryActionIcon: "⚙",
      emptyLibraryLabel: "前往配置",
      emptyLibraryRoute: "/admin/models",
    });

    expect(controller.hasConfiguredOptions.value).toBe(false);
    expect(controller.selectValue.value).toBe(EMPTY_MODEL_LIBRARY_ACTION);
    expect(controller.emptyLibraryActionLabel.value).toBe("⚙ 前往配置");

    controller.handleChange(changeEventWithTarget(EMPTY_MODEL_LIBRARY_ACTION));
    controller.handleSelectClick();

    expect(navigateBrowserHashRouteMock).toHaveBeenCalledTimes(2);
    expect(navigateBrowserHashRouteMock).toHaveBeenCalledWith("/admin/models", "/admin/agent-config");
    expect(emit).not.toHaveBeenCalled();
  });

  it("handles empty-library keyboard activation and ignores unrelated keys", () : any => {
    const { controller } = createController({
      options: [],
      emptyLibraryRoute: " ",
    });
    const enter: any = new KeyboardEvent("keydown", { key: "Enter" });
    const space: any = new KeyboardEvent("keydown", { key: " " });
    const escape: any = new KeyboardEvent("keydown", { key: "Escape" });
    vi.spyOn(enter, "preventDefault");
    vi.spyOn(space, "preventDefault");
    vi.spyOn(escape, "preventDefault");

    controller.handleSelectKeydown(enter);
    controller.handleSelectKeydown(space);
    controller.handleSelectKeydown(escape);

    expect(enter.preventDefault).toHaveBeenCalled();
    expect(space.preventDefault).toHaveBeenCalled();
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(navigateBrowserHashRouteMock).not.toHaveBeenCalled();
  });

  it("does not navigate on click or keyboard when configured options exist", () : any => {
    const { controller } = createController({
      options: [{ value: "agent-a", label: "Agent A" }],
    });
    const enter: any = new KeyboardEvent("keydown", { key: "Enter" });
    vi.spyOn(enter, "preventDefault");

    controller.handleSelectClick();
    controller.handleSelectKeydown(enter);

    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(navigateBrowserHashRouteMock).not.toHaveBeenCalled();
  });
});
