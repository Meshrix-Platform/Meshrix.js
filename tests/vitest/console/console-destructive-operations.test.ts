// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computed, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));

const authClientMocks: any = vi.hoisted(() : any => ({
  revokeAuthSession: vi.fn(),
}));

vi.mock("../../../apps/console/lib/auth-client", () : any => ({
  getAuthOidc: vi.fn(),
  getAuthSession: vi.fn(),
  listAuthAudit: vi.fn(),
  listAuthSessions: vi.fn(),
  listAuthUsers: vi.fn(),
  loginAuth: vi.fn(),
  logoutAuth: vi.fn(),
  revokeAuthSession: authClientMocks.revokeAuthSession,
  saveAuthOidc: vi.fn(),
  updateAuthUser: vi.fn(),
}));

const settingsClientMocks: any = vi.hoisted(() : any => ({
  saveSettings: vi.fn(),
}));

vi.mock("../../../apps/console/lib/agent-settings-client", () : any => ({
  saveSettings: settingsClientMocks.saveSettings,
}));

const shellContext: any = vi.hoisted(() : any => ({} as any));

vi.mock("@meshrix/ui-console/server-console-shell-context", () : any => ({
  useServerConsoleShellContext: () : any => shellContext,
}));

import ConsoleServiceDiscoveryPanel from "../../../apps/console/components/shell/ConsoleServiceDiscoveryPanel.vue";
import { createConsoleAuthController } from "../../../apps/console/composables/console-auth-controller";
import {
  registerConsoleConfirmHost,
  settleAllConsoleConfirms,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
  useConsoleConfirmState,
} from "../../../apps/console/composables/console-confirm-controller";
import {
  CONSOLE_DESTRUCTIVE_OPERATIONS,
  getDestructiveOperation,
  requestDestructiveConfirm,
} from "../../../apps/console/composables/console-destructive-operation-registry";
import { createConsoleMaintenanceAgentController } from "../../../apps/console/composables/console-maintenance-agent-controller";
import { createConsoleModelRepositoryController } from "../../../apps/console/composables/console-model-repository-controller";
import {
  clearConsoleToasts,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";
import { SERVER_ADDRESS_STORAGE_KEY } from "../../../apps/console/lib/console-server-addresses";

const EXPECTED_OPERATION_IDS: any = [
  "auth.session.revoke",
  "model-repository.provider.remove",
  "maintenance-agent.schedule.remove",
  "service-discovery.address.remove",
  "publish.service.disable",
  "publish.service.republish",
  "publish.service.remove",
];

function resolveDottedMessage(root: any, dottedKey: string) : any {
  let node: any = root;
  for (const segment of dottedKey.split(".")) {
    node = node?.[segment];
  }
  return typeof node === "string" ? node : "";
}

function listConsoleSourceFiles(dir: string) : any {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath: any = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listConsoleSourceFiles(fullPath));
    } else if (/\.(ts|vue)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

beforeEach(() : any => {
  registerConsoleConfirmHost();
});

afterEach(() : any => {
  settleAllConsoleConfirms(false);
  unregisterConsoleConfirmHost();
  clearConsoleToasts();
  window.localStorage.removeItem(SERVER_ADDRESS_STORAGE_KEY);
});

describe("console destructive operation registry", () : any => {
  it("exports exactly the frozen id set, each entry frozen with tone/consequence and no requireText", () : any => {
    expect(CONSOLE_DESTRUCTIVE_OPERATIONS.map((operation: any) : any => operation.id)).toEqual(
      EXPECTED_OPERATION_IDS,
    );
    expect(Object.isFrozen(CONSOLE_DESTRUCTIVE_OPERATIONS)).toBe(true);
    for (const operation of CONSOLE_DESTRUCTIVE_OPERATIONS) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(["neutral", "warning", "danger"]).toContain(operation.tone);
      expect(operation.consequence).toMatch(/^destructive\.consequence\.[a-zA-Z]+$/);
      expect(operation.requireText).toBeUndefined();
    }
  });

  it("resolves consequence copy with a resource placeholder in both locales", () : any => {
    for (const operation of CONSOLE_DESTRUCTIVE_OPERATIONS) {
      for (const locale of ["zh-CN", "en"]) {
        const copy: any = resolveDottedMessage(consoleMessages[locale], operation.consequence);
        expect(copy, `${operation.id} / ${locale}`).toBeTruthy();
        expect(copy, `${operation.id} / ${locale}`).toContain("{resource}");
      }
    }
  });

  it("looks up operations by id and returns undefined for unregistered ids", () : any => {
    expect(getDestructiveOperation("auth.session.revoke")?.tone).toBe("danger");
    expect(getDestructiveOperation("service-discovery.address.remove")?.tone).toBe("danger");
    expect(getDestructiveOperation("publish.service.disable")?.tone).toBe("danger");
    expect(getDestructiveOperation("publish.service.remove")?.tone).toBe("danger");
    expect(getDestructiveOperation("model-repository.provider.remove")?.tone).toBe("warning");
    expect(getDestructiveOperation("maintenance-agent.schedule.remove")?.tone).toBe("warning");
    expect(getDestructiveOperation("publish.service.republish")?.tone).toBe("warning");
    expect(getDestructiveOperation("unknown.id")).toBeUndefined();
  });

  it("resolves false without a dialog host", async () : Promise<any> => {
    unregisterConsoleConfirmHost();
    await expect(
      requestDestructiveConfirm("auth.session.revoke", { resource: "session-1" }),
    ).resolves.toBe(false);
  });

  it("builds a consequence-stating confirm request and honors the decision", async () : Promise<any> => {
    const { currentConfirm } = useConsoleConfirmState();

    const declined: any = requestDestructiveConfirm("auth.session.revoke", { resource: "session-9" });
    expect(currentConfirm.value?.tone).toBe("danger");
    expect(currentConfirm.value?.message).toContain("session-9");
    expect(currentConfirm.value?.title).toBeTruthy();
    expect(currentConfirm.value?.confirmLabel).toBeTruthy();
    expect(currentConfirm.value?.requireText).toBeUndefined();
    settleConsoleConfirm(false);
    await expect(declined).resolves.toBe(false);

    const accepted: any = requestDestructiveConfirm("service-discovery.address.remove", {
      resource: "https://b.example.com",
    });
    expect(currentConfirm.value?.message).toContain("https://b.example.com");
    settleConsoleConfirm(true);
    await expect(accepted).resolves.toBe(true);
  });

  it("maps the audit-level warning tone to the dialog neutral tone", async () : Promise<any> => {
    const { currentConfirm } = useConsoleConfirmState();
    const pending: any = requestDestructiveConfirm("model-repository.provider.remove", {
      resource: "OpenAI",
    });
    expect(currentConfirm.value?.tone).toBe("neutral");
    settleConsoleConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("throws for unregistered ids instead of confirming unguarded", () : any => {
    expect(() : any => requestDestructiveConfirm("bogus.id" as any, { resource: "x" })).toThrow(
      /Unregistered destructive operation/,
    );
  });

  it("keeps typed confirmation (requireText) at the existing two sites console-wide", () : any => {
    const consoleRoot: any = path.resolve(__dirname, "../../../apps/console");
    const sites: string[] = [];
    for (const file of listConsoleSourceFiles(consoleRoot)) {
      const text: any = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/requireText:\s*([^,\n}]+)/g)) {
        const value: any = String(match[1] || "").trim();
        // Pass-throughs of an optional request field are not typed-confirmation policy sites.
        if (value === "options.requireText" || value === "operation.requireText") {
          continue;
        }
        sites.push(`${path.relative(consoleRoot, file).split(path.sep).join("/")} -> ${value}`);
      }
    }
    expect(sites.sort()).toEqual([
      "composables/console-api-key-distribution-controller.ts -> record.workloadDisplayName",
      "composables/console-workspace-management-controller.ts -> \"DELETE\"",
    ]);
  });
});

describe("auth session revoke confirm", () : any => {
  beforeEach(() : any => {
    authClientMocks.revokeAuthSession.mockReset();
    authClientMocks.revokeAuthSession.mockResolvedValue(undefined);
  });

  function createController() : any {
    const setBusy: any = vi.fn();
    const clearBusy: any = vi.fn();
    const controller: any = createConsoleAuthController({
      consoleState: ref(null),
      error: ref(""),
      clearBusy,
      refreshState: vi.fn(async () : Promise<any> => undefined),
      resetServerEventCursor: vi.fn(),
      setBusy,
      startServerEventSubscription: vi.fn(),
      stopServerEventSubscription: vi.fn(),
    });
    return { controller, setBusy, clearBusy };
  }

  it("requires a consequence-stating confirm before revoking a session", async () : Promise<any> => {
    const { controller, setBusy, clearBusy } = createController();
    const { currentConfirm } = useConsoleConfirmState();

    const declined: any = controller.revokeConsoleSession("session-1");
    expect(currentConfirm.value?.message).toContain("session-1");
    expect(authClientMocks.revokeAuthSession).not.toHaveBeenCalled();
    settleConsoleConfirm(false);
    await declined;
    expect(authClientMocks.revokeAuthSession).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();

    const accepted: any = controller.revokeConsoleSession("session-1");
    expect(currentConfirm.value?.message).toContain("session-1");
    settleConsoleConfirm(true);
    await accepted;
    expect(authClientMocks.revokeAuthSession).toHaveBeenCalledTimes(1);
    expect(authClientMocks.revokeAuthSession).toHaveBeenCalledWith("session-1");
    expect(setBusy).toHaveBeenCalledWith("auth:session:session-1");
    expect(clearBusy).toHaveBeenCalledWith("auth:session:session-1");
  });
});

describe("model repository provider remove confirm", () : any => {
  const entry: any = { uid: "agent-1", provider: "openai", label: "OpenAI agent" };

  beforeEach(() : any => {
    settingsClientMocks.saveSettings.mockReset();
    settingsClientMocks.saveSettings.mockResolvedValue({});
  });

  function createController() : any {
    const settingsDraft: any = ref<any>({
      modelLibraryAgents: [entry],
      modelLibraryEntries: ["openai"],
    });
    const setBusy: any = vi.fn();
    const replaceSettingsDraftFromServer: any = vi.fn();
    const controller: any = createConsoleModelRepositoryController({
      clearBusy: vi.fn(),
      error: ref(""),
      modelEntryBindingSummary: () : any => "",
      modelEntryIsBound: () : any => false,
      modelEntryStatusKey: (item: any) : any => item.uid,
      modelLibraryExpandedCards: ref<Record<string, boolean>>({}),
      normalizeModelEntry: (value: any) : any => value,
      providerLabel: (provider: any) : any => String(provider),
      replaceSettingsDraftFromServer,
      selectedModelProvider: ref("openai"),
      setBusy,
      settingsDraft,
      settingsPayloadForSave: () : any => settingsDraft.value,
      visibleModelEntries: computed(() : any => settingsDraft.value.modelLibraryAgents),
      visibleModelProviders: computed(() : any => settingsDraft.value.modelLibraryEntries),
    });
    return { controller, settingsDraft, setBusy, replaceSettingsDraftFromServer };
  }

  it("requires a consequence-stating confirm before removing a provider", async () : Promise<any> => {
    const { controller, settingsDraft, setBusy, replaceSettingsDraftFromServer } = createController();
    const { currentConfirm } = useConsoleConfirmState();

    const declined: any = controller.removeModelProvider(entry);
    expect(currentConfirm.value?.message).toContain("OpenAI agent");
    expect(settingsClientMocks.saveSettings).not.toHaveBeenCalled();
    settleConsoleConfirm(false);
    await declined;
    expect(settingsClientMocks.saveSettings).not.toHaveBeenCalled();
    expect(settingsDraft.value.modelLibraryAgents).toHaveLength(1);
    expect(setBusy).not.toHaveBeenCalled();

    const accepted: any = controller.removeModelProvider(entry);
    settleConsoleConfirm(true);
    await accepted;
    expect(settingsClientMocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(settingsDraft.value.modelLibraryAgents).toHaveLength(0);
    expect(replaceSettingsDraftFromServer).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenCalledWith("model-remove:agent-1");
  });
});

describe("maintenance agent schedule remove confirm", () : any => {
  function createController() : any {
    const controller: any = createConsoleMaintenanceAgentController({
      canReadMaintenanceAgent: computed(() : any => false),
      clearBusy: vi.fn(),
      consoleState: ref(null),
      error: ref(""),
      modelEntryStatusKey: (item: any) : any => item.uid,
      setBusy: vi.fn(),
      visibleModelEntries: computed(() : any => []),
    });
    controller.maintenanceAgentConfig.value = {
      schedules: [
        {
          id: "sch-1",
          label: "Daily scan",
          enabled: true,
          runbook: "rb-1",
          intervalMinutes: 60,
          nextRunAt: "",
        },
      ],
    };
    return controller;
  }

  it("keeps the draft row and shows no toast when the confirm is declined", async () : Promise<any> => {
    const controller: any = createController();
    const { currentConfirm } = useConsoleConfirmState();

    const pending: any = controller.removeMaintenanceAgentSchedule("sch-1");
    expect(currentConfirm.value?.message).toContain("Daily scan");
    expect(controller.maintenanceAgentConfig.value.schedules).toHaveLength(1);
    settleConsoleConfirm(false);
    await pending;

    expect(controller.maintenanceAgentConfig.value.schedules).toHaveLength(1);
    expect(useConsoleToasts().toasts).toHaveLength(0);
  });

  it("removes the row after confirm and preserves the undo toast", async () : Promise<any> => {
    const controller: any = createController();

    const pending: any = controller.removeMaintenanceAgentSchedule("sch-1");
    settleConsoleConfirm(true);
    await pending;

    expect(controller.maintenanceAgentConfig.value.schedules).toHaveLength(0);
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    const messages: any = consoleMessages[currentConsoleLocale.value];
    expect(toasts[0].message).toBe(messages.toast.scheduleRemoved);
    expect(toasts[0].action?.label).toBe(messages.toast.undo);

    toasts[0].action.run();
    expect(
      controller.maintenanceAgentConfig.value.schedules.map((schedule: any) : any => schedule.id),
    ).toEqual(["sch-1"]);
  });
});

describe("service discovery address remove confirm", () : any => {
  beforeEach(() : any => {
    shellContext.isBusy = () : any => false;
    shellContext.consoleState = ref<any>({ server: { url: "https://current.example.com" } });
    shellContext.discoveryDraft = ref<any>({
      serverId: "",
      serverLabel: "",
      activeServiceUrl: "",
      advertisedBaseUrl: "",
      bootstrapBaseUrl: "",
    });
    shellContext.error = ref("");
    shellContext.msg = ref<any>({
      drawer: {
        autoDetected: "Auto detected",
        serviceDiscovery: "Discovery",
        serviceId: "Service ID",
        serviceLabel: "Service Label",
        serverUrl: "Server URL",
        saveDiscovery: "Save",
        saving: "Saving",
      },
    });
    shellContext.serverAvailable = ref(false);
    window.localStorage.setItem(
      SERVER_ADDRESS_STORAGE_KEY,
      JSON.stringify({
        activeUrl: "https://a.example.com",
        addresses: ["https://a.example.com", "https://b.example.com"],
      }),
    );
  });

  function storedAddresses() : any {
    const raw: any = window.localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY);
    return raw ? (JSON.parse(raw).addresses as string[]) : [];
  }

  it("requires a consequence-stating confirm before deleting and persisting", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleServiceDiscoveryPanel);
    const { currentConfirm } = useConsoleConfirmState();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    expect(wrapper.findAll(".server-url-remove-button")).toHaveLength(2);

    // Declined: the row stays and nothing persists.
    await wrapper.findAll(".server-url-remove-button")[0].trigger("click");
    expect(currentConfirm.value?.message).toContain("https://b.example.com");
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    settleConsoleConfirm(false);
    await flushPromises();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    expect(storedAddresses()).toContain("https://b.example.com");

    // Confirmed: the row is deleted and persisted.
    await wrapper.findAll(".server-url-remove-button")[0].trigger("click");
    settleConsoleConfirm(true);
    await flushPromises();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(2);
    expect(storedAddresses()).not.toContain("https://b.example.com");
    wrapper.unmount();
  });
});
