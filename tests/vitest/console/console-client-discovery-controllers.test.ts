import { nextTick, ref } from "vue";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createConsoleClientController } from "../../../apps/console/composables/console-client-controller";
import { createConsoleDiscoveryController } from "../../../apps/console/composables/console-discovery-controller";

const discoveryClientMock = vi.hoisted(() => ({
  saveDiscoveryConfig: vi.fn(),
}));
const browserEffectsMock = vi.hoisted(() => ({
  downloadTextFile: vi.fn(),
}));

vi.mock("../../../apps/console/lib/discovery-client", () => ({
  saveDiscoveryConfig: discoveryClientMock.saveDiscoveryConfig,
}));
vi.mock("../../../apps/console/composables/console-browser-effects", () => ({
  downloadTextFile: browserEffectsMock.downloadTextFile,
}));

function client(overrides: Record<string, unknown>) {
  return {
    clientId: "client-a",
    clientLabel: "Alpha Client",
    hostname: "alpha.local",
    platform: "darwin",
    currentServiceUrl: "http://alpha",
    connectionMethod: "Discovery",
    connectionDetail: "LAN",
    connectionKind: "discovery",
    alignmentState: "aligned",
    lastSeenAt: "2026-06-04T10:00:00.000Z",
    ...overrides,
  } as any;
}

describe("console client controller behavior", () => {
  beforeEach(() => {
    browserEffectsMock.downloadTextFile.mockClear();
  });

  it("sorts clients, derives latest/displayed clients, and counts attention states", () => {
    const consoleState = ref<any>({
      clients: {
        summary: {
          outdatedCount: 1,
          drainingCount: 2,
          bootstrapOnlyCount: 3,
          offlineCount: 4,
          unknownCount: 5,
        },
        items: [
          client({ clientId: "old", lastSeenAt: "2026-06-04T09:00:00.000Z" }),
          client({ clientId: "new", lastSeenAt: "2026-06-04T11:00:00.000Z" }),
          client({ clientId: "bad-date", lastSeenAt: "not-a-date" }),
        ],
      },
    });
    const controller = createConsoleClientController({ consoleState });

    expect(controller.filteredClients.value.map((item) => item.clientId)).toEqual([
      "new",
      "old",
      "bad-date",
    ]);
    expect(controller.latestClient.value?.clientId).toBe("new");
    expect(controller.displayedClients.value).toHaveLength(3);
    expect(controller.attentionClientCount.value).toBe(15);
    expect(controller.clientStateFilterOptionBarOptions.value[0]).toEqual({
      value: "all",
      label: "所有状态",
    });

    consoleState.value = { clients: { items: [] } };
    expect(controller.attentionClientCount.value).toBe(0);
    expect(controller.latestClient.value).toBeNull();
  });

  it("filters clients by alignment state and search terms across display fields", () => {
    const consoleState = ref<any>({
      clients: {
        summary: {},
        items: [
          client({ clientId: "alpha", clientLabel: "Alpha", alignmentState: "aligned" }),
          client({
            clientId: "beta",
            clientLabel: "Beta",
            hostname: "edge-host",
            alignmentState: "offline",
            connectionKind: "mcp-plugin",
            connectionStatusLabel: "已配对",
          }),
          client({
            clientId: "gamma",
            clientLabel: "Gamma",
            currentServiceUrl: "http://service.example",
            alignmentState: "outdated",
          }),
        ],
      },
    });
    const controller = createConsoleClientController({ consoleState });

    controller.clientStateFilter.value = "offline";
    expect(controller.filteredClientList.value.map((item) => item.clientId)).toEqual(["beta"]);

    controller.clientStateFilter.value = "all";
    controller.clientSearchQuery.value = "edge";
    expect(controller.filteredClientList.value.map((item) => item.clientId)).toEqual(["beta"]);

    controller.clientSearchQuery.value = "已配对";
    expect(controller.filteredClientList.value.map((item) => item.clientId)).toEqual(["beta"]);

    controller.clientSearchQuery.value = "待对齐";
    expect(controller.filteredClientList.value.map((item) => item.clientId)).toEqual(["gamma"]);

    controller.clientSearchQuery.value = "service.example";
    expect(controller.filteredClientList.value.map((item) => item.clientId)).toEqual(["gamma"]);
  });

  it("exports an operational inventory without client identity or endpoint fields", () => {
    const consoleState = ref<any>({
      clients: {
        summary: { totalCount: 1, alignedCount: 1 },
        items: [
          client({
            clientId: "private-client-id",
            clientLabel: "Private Label",
            hostname: "private-host.invalid",
            bootstrapUrl: "https://bootstrap.private.invalid",
            currentServiceUrl: "https://current.private.invalid",
            desiredServiceUrl: "https://desired.private.invalid",
            currentJobServiceUrl: "https://jobs.private.invalid",
            sourceGrantId: "private-grant-id",
            appVersion: "1.2.3",
            configVersion: "cfg-1",
            busy: false,
          }),
        ],
      },
    });
    const controller = createConsoleClientController({ consoleState });

    controller.exportClients();

    expect(browserEffectsMock.downloadTextFile).toHaveBeenCalledTimes(1);
    const [fileName, content, contentType] = browserEffectsMock.downloadTextFile.mock.calls[0];
    const payload = JSON.parse(content);
    expect(fileName).toMatch(/^meshrix-clients-.*\.json$/);
    expect(contentType).toBe("application/json;charset=utf-8");
    expect(payload.privacy.redacted).toBe(true);
    expect(payload.clients).toEqual([
      expect.objectContaining({
        clientRef: "client-1",
        appVersion: "1.2.3",
        configVersion: "cfg-1",
        alignmentState: "aligned",
      }),
    ]);
    expect(content).not.toContain("private-client-id");
    expect(content).not.toContain("Private Label");
    expect(content).not.toContain("private-host.invalid");
    expect(content).not.toContain("private-grant-id");
  });
});

describe("console discovery controller behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createDiscoveryHarness() {
    let applyingRemoteDrafts = false;
    const error = ref("previous error");
    const refreshState = vi.fn(async () => undefined);
    const setBusy = vi.fn();
    const clearAllBusy = vi.fn();
    const controller = createConsoleDiscoveryController({
      applyRemoteConsoleDraftUpdate: (update) => {
        applyingRemoteDrafts = true;
        update();
        applyingRemoteDrafts = false;
      },
      clearAllBusy,
      error,
      isApplyingRemoteConsoleDrafts: () => applyingRemoteDrafts,
      refreshState,
      remoteDraftEquals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      setBusy,
    });

    return {
      clearAllBusy,
      controller,
      error,
      refreshState,
      setBusy,
    };
  }

  it("replaces drafts from server, marks clean by default, and tracks local dirty edits", async () => {
    const { controller } = createDiscoveryHarness();

    controller.replaceDiscoveryDraftFromServer({
      serverId: "server-1",
      serverLabel: "Server One",
      mode: "active",
    });
    expect(controller.discoveryDraft.value.serverId).toBe("server-1");
    expect(controller.discoveryDraftDirty.value).toBe(false);

    controller.discoveryDraft.value.serverLabel = "Local Edit";
    await nextTick();
    expect(controller.discoveryDraftDirty.value).toBe(true);

    controller.replaceDiscoveryDraftFromServer({
      serverId: "server-2",
      serverLabel: "Server Two",
      mode: "passive",
    }, { markClean: false });
    expect(controller.discoveryDraft.value.serverId).toBe("server-2");
    expect(controller.discoveryDraftDirty.value).toBe(true);

    controller.replaceDiscoveryDraftFromServer({
      serverId: "server-2",
      serverLabel: "Server Two",
      mode: "passive",
    });
    expect(controller.discoveryDraftDirty.value).toBe(false);
  });

  it("saves discovery config, refreshes state, and handles failures", async () => {
    discoveryClientMock.saveDiscoveryConfig.mockResolvedValue({});
    const success = createDiscoveryHarness();
    success.controller.discoveryDraft.value.serverId = "server-ok";
    await nextTick();

    await success.controller.saveDiscovery();

    expect(success.setBusy).toHaveBeenCalledWith("discovery");
    expect(discoveryClientMock.saveDiscoveryConfig).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "server-ok" }),
    );
    expect(success.controller.discoveryDraftDirty.value).toBe(false);
    expect(success.refreshState).toHaveBeenCalledWith({ forceDrafts: false });
    expect(success.clearAllBusy).not.toHaveBeenCalled();
    expect(success.error.value).toBe("");

    discoveryClientMock.saveDiscoveryConfig.mockRejectedValue(new Error("save failed"));
    const failure = createDiscoveryHarness();
    await failure.controller.saveDiscovery();

    expect(failure.error.value).toBe("save failed");
    expect(failure.clearAllBusy).toHaveBeenCalledTimes(1);
    expect(failure.refreshState).not.toHaveBeenCalled();
  });
});
