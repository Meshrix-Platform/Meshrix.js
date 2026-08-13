// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardView from "../../../apps/console/views/DashboardView.vue";
import { setConsoleLocaleState } from "../../../apps/console/i18n/console";

const shellContextMock: any = vi.hoisted(() : any => ({ current: null as any }));
const approvalFlowMock: any = vi.hoisted(() : any => ({ current: null as any }));

vi.mock("#meshrix/console/server-console-shell-context", async () : Promise<any> => {
  const { namespaceServerConsoleShell } = await import("../../../tests/vitest/console/console-shell-test-utils");
  return {
    useServerConsoleShellContext: () : any => namespaceServerConsoleShell(shellContextMock.current),
  };
});

vi.mock(
  "../../../apps/console/composables/console-approval-flow-view-controller",
  () : any => ({
    useApprovalFlowViewController: () : any => approvalFlowMock.current,
  }),
);

const RouterLinkStub: any = defineComponent({
  name: "RouterLink",
  props: {
    to: {
      type: [String, Object],
      required: true,
    },
  },
  setup(props: any, { slots }: Record<string, any>) : any {
    return () : any =>
      h("a", { "data-router-to": JSON.stringify(props.to) }, slots.default?.());
  },
});

beforeEach(() : any => {
  document.documentElement.lang = "zh-CN";
  setConsoleLocaleState("zh-CN");
  shellContextMock.current = {
    isBusy: () => false,
    consoleState: ref({
      clients: { summary: { offlineCount: 0, totalCount: 0 } },
      features: { plugins: { effectivePlugins: [], loadedPlugins: [] } },
      jobs: { summary: { completedCount: 0, queuedCount: 0, runningCount: 0 } },
      storage: { objectCount: 0, objectFileCount: 0 },
    }),
    dashboardAlertInboxId: vi.fn(),
    dashboardAlerts: ref([]),
    dismissDashboardAlert: vi.fn(),
    openDashboardAlert: vi.fn(),
  };
  approvalFlowMock.current = {
    approvalFlowCards: ref([
      {
        key: "pendingOperation:request-a",
        kind: "pendingOperation",
        tone: "warning",
        label: "Operation Permission 审批",
        title: "Governed operation",
        summary: "Review this request in the approval decision center.",
        meta: ["待决定", "等待审批"],
        pendingOperation: {
          pendingOperationId: "request-a",
          status: "pending",
        },
      },
    ]),
  };
});

describe("Dashboard approval entry", () : any => {
  it("shows status context and routes to the decision center without direct approval actions", () : any => {
    const wrapper: any = mount(DashboardView, {
      global: {
        stubs: {
          DashboardPluginCard: true,
          RouterLink: RouterLinkStub,
          StatusPill: true,
        },
      },
    });

    expect(wrapper.text()).toContain("Operation Permission 审批");
    expect(wrapper.find('[data-action="open-approval-center"]').exists()).toBe(
      true,
    );
    expect(
      wrapper
        .get('[data-action="open-approval-center"]')
        .attributes("data-router-to"),
    ).toBe('"/approval"');
    expect(wrapper.find('[data-action="mcp-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="mcp-reject"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="operation-approve"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-action="operation-reject"]').exists()).toBe(
      false,
    );
  });

  it("uses the effective document locale for the approval-center entry", () : any => {
    document.documentElement.lang = "en";
    const wrapper: any = mount(DashboardView, {
      global: {
        stubs: {
          DashboardPluginCard: true,
          RouterLink: RouterLinkStub,
          StatusPill: true,
        },
      },
    });

    expect(
      wrapper.get('[data-action="open-approval-center"]').text(),
    ).toContain("Open Approval Decision Center");
  });
});
