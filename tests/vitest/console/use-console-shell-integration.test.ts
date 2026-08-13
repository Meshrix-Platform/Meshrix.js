// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import {
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router";
import { useServerConsoleShell } from "../../../apps/console/composables/useServerConsoleShell";
import { useConsoleShellPreferences } from "../../../apps/console/composables/console-shell-preferences";
import { emptyDiscovery, emptySettings } from "../../../apps/console/composables/console-defaults";
import {
  routeAccessPolicyForAdminView,
  routeAccessPolicyForView,
} from "../../../apps/console/router/route-access-policy.ts";
import type {
  ConsoleAuthSummary,
  EventSubscriptionResponse,
  ProtocolEvent,
  ServerConsoleState,
  SplitJob,
} from "../../../apps/console/lib/types";

const authClientMock: any = vi.hoisted(() : any => ({
  getAuthSession: vi.fn(),
  getAuthOidc: vi.fn(),
  listAuthAudit: vi.fn(),
  listAuthSessions: vi.fn(),
  listAuthUsers: vi.fn(),
  loginAuth: vi.fn(),
  logoutAuth: vi.fn(),
  revokeAuthSession: vi.fn(),
  saveAuthOidc: vi.fn(),
  updateAuthUser: vi.fn(),
}));
const consoleStateClientMock: any = vi.hoisted(() : any => ({
  getServerConsoleState: vi.fn(),
}));
const serverEventsClientMock: any = vi.hoisted(() : any => ({
  subscribeEvents: vi.fn(),
}));
const contextCompilerClientMock: any = vi.hoisted(() : any => ({
  getContextProfiles: vi.fn(),
  listContextBuildRecords: vi.fn(),
  previewContextPack: vi.fn(),
  runContextEvaluation: vi.fn(),
}));
const appearancePresetClientMock: any = vi.hoisted(() : any => ({
  fetchServerAppearancePresetConfigs: vi.fn(),
  importServerAppearancePresetText: vi.fn(),
}));

vi.mock("../../../apps/console/lib/auth-client", () : any => authClientMock);
vi.mock("../../../apps/console/lib/console-state-client", () : any => consoleStateClientMock);
vi.mock("../../../apps/console/lib/server-events-client", () : any => serverEventsClientMock);
vi.mock("../../../apps/console/lib/context-compiler-client", () : any => contextCompilerClientMock);
vi.mock("../../../apps/console/lib/appearance-presets-client", () : any => appearancePresetClientMock);

const TestRoute: any = defineComponent({
  name: "TestRoute",
  setup: () : any => () : any => h("div"),
});

type ConsoleShell = ReturnType<typeof useServerConsoleShell>;

function makeAuthSummary(): ConsoleAuthSummary {
  return {
    enabled: true,
    bootstrap: {
      required: false,
      tokenPrefix: "",
      tokenFilePath: "",
    },
    session: {
      authenticated: true,
      csrfToken: "test-csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        userId: "test-user",
        username: "operator",
        displayName: "Operator",
        roleId: "viewer",
        roleLabel: "Viewer",
        scopes: ["console:read"],
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastLoginAt: "2026-01-01T00:00:00.000Z",
      },
    },
    roles: [],
    oidc: {
      enabled: false,
      issuer: "",
      clientId: "",
      clientSecretConfigured: false,
      redirectUri: "",
      allowedDomains: [],
      roleMapping: {},
      updatedAt: "",
    },
  };
}

function makeConsoleState(marker: string, jobs: SplitJob[] = []): ServerConsoleState {
  return {
    server: {
      url: `https://${marker}.example.invalid`,
      userDataPath: "[redacted]",
      distPath: "[redacted]",
      hostname: "test-host",
    },
    runtime: {
      profile: "test",
      cwd: "[redacted]",
      mountModules: {},
      mountRouting: {
        kindRoutes: {},
        extensionRoutes: {},
        mediaTypeRoutes: {},
      },
      mountGeneration: 1,
      mounts: [],
    },
    settings: {
      path: "[redacted]",
      value: JSON.parse(JSON.stringify(emptySettings)),
    },
    discovery: {
      value: {
        ...emptyDiscovery,
        serverId: `server-${marker}`,
        serverLabel: marker,
      },
      bootstrap: {
        ok: true,
        ...emptyDiscovery,
        serverId: `server-${marker}`,
        serverLabel: marker,
        alignmentRequired: false,
      },
    },
    storage: {
      objectCount: 0,
    },
    jobs: {
      summary: {
        totalCount: jobs.length,
        queuedCount: jobs.filter((job?: any) : any => job.status === "queued").length,
        runningCount: jobs.filter((job?: any) : any => job.status === "running").length,
        completedCount: jobs.filter((job?: any) : any => job.status === "completed").length,
        failedCount: jobs.filter((job?: any) : any => job.status === "failed").length,
      },
      items: jobs,
    },
    clients: {
      summary: {
        totalCount: 0,
        alignedCount: 0,
        outdatedCount: 0,
        drainingCount: 0,
        bootstrapOnlyCount: 0,
        offlineCount: 0,
        unknownCount: 0,
      },
      items: [],
    },
    features: {
      schemaVersion: "v0.0.1:schema:definition-1",
      edition: "test",
      activeFeatureIds: ["admin.logs-observability"],
      disabledFeatureIds: [],
    },
  };
}

function makeJob(id: string): SplitJob {
  return {
    id,
    status: "running",
    createdAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T01:01:00.000Z",
    progressPercent: 50,
    stage: "parsing",
  };
}

function makeJobEvent(job: SplitJob): ProtocolEvent {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    offset: 1,
    id: "event-1",
    topic: "jobs.job",
    type: "jobs.updated",
    publisher: "server",
    publishedAt: "2026-07-10T01:01:00.000Z",
    payload: { job },
  };
}

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/welcome",
        component: TestRoute,
        meta: { public: true, accessPolicy: routeAccessPolicyForView("welcome") },
      },
      {
        path: "/",
        component: TestRoute,
        meta: { viewId: "dashboard", accessPolicy: routeAccessPolicyForView("dashboard") },
      },
      {
        path: "/admin/modules",
        component: TestRoute,
        meta: {
          viewId: "admin",
          adminView: "modules",
          accessPolicy: routeAccessPolicyForAdminView("modules"),
        },
      },
    ],
  });
}

async function waitForCondition(predicate: () => boolean, message: string) : Promise<any> {
  for (let attempt: any = 0; attempt < 30; attempt += 1) {
    await flushPromises();
    if (predicate()) {
      return;
    }
    await new Promise((resolve?: any) : any => window.setTimeout(resolve, 0));
  }
  throw new Error(message);
}

let wrapper: VueWrapper | null = null;

beforeEach(() : any => {
  vi.clearAllMocks();
  window.localStorage.clear();
  authClientMock.getAuthSession.mockResolvedValue(makeAuthSummary());
  contextCompilerClientMock.getContextProfiles.mockResolvedValue({ profiles: [] });
  contextCompilerClientMock.listContextBuildRecords.mockResolvedValue({ records: [] });
  appearancePresetClientMock.fetchServerAppearancePresetConfigs.mockResolvedValue({
    configs: [],
    errors: [],
  });
});

afterEach(() : any => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

describe("useConsole to useServerConsoleShell integration", () : any => {
  it("loads server appearance presets only after authentication", async () : Promise<any> => {
    const isAuthenticated: any = ref(false);
    const Harness: any = defineComponent({
      name: "ConsoleShellPreferencesHarness",
      setup() : any {
        useConsoleShellPreferences({ isAuthenticated });
        return () : any => h("div");
      },
    });
    wrapper = mount(Harness);

    await flushPromises();
    expect(appearancePresetClientMock.fetchServerAppearancePresetConfigs).not.toHaveBeenCalled();

    isAuthenticated.value = true;
    await nextTick();
    await flushPromises();
    expect(appearancePresetClientMock.fetchServerAppearancePresetConfigs).toHaveBeenCalledTimes(1);
  });

  it("runs real actions, applies refresh and event state, and falls back from a restricted route", async () : Promise<any> => {
    const router: any = createTestRouter();
    await router.push("/admin/modules");
    await router.isReady();

    const initialState: any = makeConsoleState("initial");
    const refreshedState: any = makeConsoleState("refreshed");
    refreshedState.agentSelector = {
      schemaVersion: "v0.0.1:schema:definition-1",
      source: "test",
      updatedAt: "2026-07-10T01:00:00.000Z",
      options: [
        {
          agentUid: "rule-agent",
          value: "rule-agent",
          label: "Rule Agent",
          provider: "test-provider",
          model: "test-model",
          moduleIds: ["agentTools"],
          capabilities: ["agent.invoke"],
          status: "available",
          selectable: true,
        },
      ],
    };
    consoleStateClientMock.getServerConsoleState
      .mockResolvedValueOnce(initialState)
      .mockResolvedValueOnce(refreshedState);

    let resolveEventSubscription!: (response: EventSubscriptionResponse) => void;
    serverEventsClientMock.subscribeEvents
      .mockImplementationOnce(() : any => new Promise<EventSubscriptionResponse>((resolve?: any) : any => {
        resolveEventSubscription = resolve;
      }))
      .mockImplementation(() : any => new Promise<EventSubscriptionResponse>(() : any => {}));

    let shell!: ConsoleShell;
    const Harness: any = defineComponent({
      name: "ConsoleShellHarness",
      setup() : any {
        shell = useServerConsoleShell();
        return () : any => h("div");
      },
    });
    wrapper = mount(Harness, { global: { plugins: [router] } });

    await waitForCondition(
      () : any => shell.runtime.consoleState.value?.server.url === initialState.server.url,
      "console bootstrap did not apply server state",
    );
    await waitForCondition(
      () : any => serverEventsClientMock.subscribeEvents.mock.calls.length === 1,
      "server event subscription did not start",
    );

    expect(shell.runtime.serverAvailable.value).toBe(true);
    expect(shell.access.canAccessRouteMeta(router.currentRoute.value.meta)).toBe(false);
    expect(shell.access.canAccessAdminView("unregistered-admin-view")).toBe(false);
    expect(shell.access.canAccessView("unregistered-view")).toBe(false);
    expect(shell.navigation.firstAccessibleRoutePath()).toBe("/");

    await shell.refresh.refreshState({ silent: true, forceDrafts: true });
    expect(consoleStateClientMock.getServerConsoleState).toHaveBeenCalledTimes(2);
    expect(shell.runtime.consoleState.value?.server.url).toBe(refreshedState.server.url);
    expect(shell.settings.ruleAuthoringModelOptions.value.map((option?: any) : any => option.value)).toContain("rule-agent");

    const eventJob: any = makeJob("event-job");
    resolveEventSubscription({
      cursor: 0,
      nextCursor: 2,
      topics: ["jobs.job"],
      snapshots: [],
      events: [makeJobEvent(eventJob)],
    });
    await waitForCondition(
      () : any => shell.runtime.consoleState.value?.jobs.items.some((job?: any) : any => job.id === eventJob.id) === true,
      "job event did not update shell state",
    );

    shell.monitoring.systemLogFilters.value.fuzzy = eventJob.id;
    await nextTick();
    expect(shell.monitoring.filteredSystemLogRows.value.map((row?: any) : any => row.logId)).toContain(`job:${eventJob.id}`);

    shell.navigation.sideNavCollapsed.value = true;
    shell.navigation.sideNavOpen.value = true;
    expect(shell.navigation.sideNavCollapsed.value).toBe(true);
    expect(shell.navigation.sideNavOpen.value).toBe(true);

    expect(shell.dashboard.dashboardAlerts.value.every((alert?: any) : any => alert.source === "monitor")).toBe(true);

    await expect(shell.navigation.openAdmin("modules")).resolves.toBe(false);
    expect(router.currentRoute.value.fullPath).toBe("/");
  });
});
