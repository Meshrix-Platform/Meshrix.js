// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

const mocks: any = vi.hoisted(() : any => ({
  getGatewayChannels: vi.fn(),
  selectGatewayChannel: vi.fn(),
  shellContext: null as any,
}));

vi.mock("../../../apps/console/lib/gateway-channel-client", () : any => ({
  getGatewayChannels: mocks.getGatewayChannels,
  selectGatewayChannel: mocks.selectGatewayChannel,
}));
vi.mock("#meshrix/console/server-console-shell-context", () : any => ({
  useServerConsoleShellContext: () : any => mocks.shellContext,
}));

import { useModulesViewConsole } from "../../../apps/console/composables/console-modules-view-controller";

const initialState: any = {
  ok: true,
  available: {
    downstream: ["meshrix.built-in.downstream"],
    upstream: ["meshrix.built-in.upstream", "external-gateway.test.upstream"],
  },
  selections: {
    downstream: { channelId: "meshrix.built-in.downstream", generation: 1, source: "default" },
    upstream: { channelId: "meshrix.built-in.upstream", generation: 7, source: "default" },
  },
};
const selectedState: any = {
  ...initialState,
  selections: {
    ...initialState.selections,
    upstream: { channelId: "external-gateway.test.upstream", generation: 8, source: "console" },
  },
};

beforeEach(() : any => {
  vi.clearAllMocks();
  mocks.shellContext = {
    access: { canBrowseServerPaths: false },
    modules: {
      disableMountModule: vi.fn(),
      enableMountModule: vi.fn(),
      enabledMountCount: 0,
      moduleGroups: [],
      mountDraft: {},
      openMountPathPicker: vi.fn(),
      reloadModules: vi.fn(),
      saveMountModules: vi.fn(),
      totalMountCount: 0,
    },
    runtime: { isBusy: vi.fn(), consoleState: null },
  };
  mocks.getGatewayChannels.mockResolvedValue(initialState);
  mocks.selectGatewayChannel.mockResolvedValue(selectedState);
});

describe("module gateway channel requests", () : any => {
  it("uses the selection response instead of issuing a follow-up GET", async () : Promise<any> => {
    let view: ReturnType<typeof useModulesViewConsole> | null = null;
    const Harness: any = defineComponent({
      setup() : any {
        view = useModulesViewConsole();
        return () : any => h("div");
      },
    });
    const wrapper = mount(Harness);
    await flushPromises();
    await nextTick();

    expect(mocks.getGatewayChannels).toHaveBeenCalledTimes(1);
    expect(view?.gatewayChannels.upstream.generation.value).toBe(7);
    view!.gatewayChannels.upstream.draft.value = "external-gateway.test.upstream";
    await view!.gatewayChannels.upstream.select({
      direction: "upstream",
      channelId: view!.gatewayChannels.upstream.draft.value,
      expectedGeneration: view!.gatewayChannels.upstream.generation.value,
    });

    expect(mocks.selectGatewayChannel).toHaveBeenCalledWith({
      direction: "upstream",
      channelId: "external-gateway.test.upstream",
      expectedGeneration: 7,
    });
    expect(mocks.getGatewayChannels).toHaveBeenCalledTimes(1);
    expect(view!.gatewayChannels.upstream.selected.value).toBe("external-gateway.test.upstream");
    expect(view!.gatewayChannels.upstream.generation.value).toBe(8);

    wrapper.unmount();
  });
});
