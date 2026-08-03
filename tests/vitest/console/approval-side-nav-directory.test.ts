// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConsoleSideNavDirectory from "../../../apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue";
import { setConsoleLocaleState } from "../../../apps/console/i18n/console";

const sideNavContextMock: any = vi.hoisted(() : any => ({ current: null as any }));

vi.mock(
  "../../../apps/console/composables/consoleSideNavContext",
  () : any => ({
    useConsoleSideNavContext: () : any => sideNavContextMock.current,
  }),
);

beforeEach(() : any => {
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
  setConsoleLocaleState("zh-CN");
});

describe("approval side navigation", () : any => {
  it("loads the all-items projection before scrolling to a historical approval", async () : Promise<any> => {
    const selectApprovalFlowStatus: any = vi.fn(async () : Promise<any> => {});
    const target: any = document.createElement("div");
    target.id = "approval-pendingOperation:history-operation";
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback?: any) : any => {
      callback(0);
      return 1;
    });
    sideNavContextMock.current = {
      activeSideNavDirectory: ref("approval"),
      approvalFlowConsole: {
        operationPermissionPendingOperations: ref([
          {
            pendingOperationId: "history-operation",
            toolId: "upstream.svc_synthetic.convert",
            toolLabel: "Convert document",
            risk: "safe_write",
            status: "completed",
            completedAt: "2026-01-01T00:01:00.000Z",
          },
        ]),
        refreshOperationPermissionPendingOperations: vi.fn(async () : Promise<any> => {}),
        selectApprovalFlowStatus,
      },
      returnToPrimarySideNav: vi.fn(),
      setSideNavDirectoryWidth: vi.fn(),
      showSideNavDirectory: ref(true),
      sideNavDirectoryMinWidth: 220,
      sideNavDirectoryWidth: ref(220),
      workspacesConsole: {
        load: vi.fn(async () : Promise<any> => {}),
        panel: ref("list"),
        selectedId: ref(""),
        workspaces: ref([]),
      },
    };
    const wrapper: any = mount(ConsoleSideNavDirectory);

    expect(wrapper.text()).toContain("已处理");
    expect(wrapper.text()).toContain("Convert document");
    expect(wrapper.text()).toContain("受限写入");

    const historyButton: any = wrapper
      .findAll("button.side-nav-directory-item-main")
      .find((button?: any) : any => button.text().includes("Convert document"));
    expect(historyButton).toBeDefined();
    await historyButton!.trigger("click");
    await flushPromises();

    expect(selectApprovalFlowStatus).toHaveBeenCalledWith("all");
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
  });
});
