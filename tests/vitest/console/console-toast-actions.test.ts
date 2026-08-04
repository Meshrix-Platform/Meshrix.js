// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, nextTick, ref } from "vue";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createMemoryHistory, createRouter } from "vue-router";
import ConsoleToastHost from "../../../apps/console/components/ConsoleToastHost.vue";
import PublishServiceForm from "../../../apps/console/views/admin/upstream-service-publish/PublishServiceForm.vue";
import {
  clearConsoleToasts,
  pushConsoleToast,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";
import { createConsoleMaintenanceAgentController } from "../../../apps/console/composables/console-maintenance-agent-controller";
import { createConsoleModelRepositoryController } from "../../../apps/console/composables/console-model-repository-controller";
import {
  registerConsoleConfirmHost,
  settleAllConsoleConfirms,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";

const maintenanceAgentClientMock: any = vi.hoisted(() : any => ({
  approveMaintenanceAgentRun: vi.fn(),
  cancelMaintenanceAgentRun: vi.fn(),
  chatMaintenanceAgent: vi.fn(),
  getMaintenanceAgentConfig: vi.fn(),
  listMaintenanceAgentRuns: vi.fn(),
  saveMaintenanceAgentConfig: vi.fn(),
  startMaintenanceAgentRun: vi.fn(),
}));

const agentSettingsClientMock: any = vi.hoisted(() : any => ({
  saveSettings: vi.fn(),
}));

vi.mock("../../../apps/console/lib/maintenance-agent-client", () : any => maintenanceAgentClientMock);
vi.mock("../../../apps/console/lib/agent-settings-client", () : any => agentSettingsClientMock);

function toastCopy() : any {
  return consoleMessages[currentConsoleLocale.value].toast;
}

beforeEach(() : any => {
  registerConsoleConfirmHost();
  document.body.innerHTML = "";
});

afterEach(() : any => {
  settleAllConsoleConfirms(false);
  unregisterConsoleConfirmHost();
  clearConsoleToasts();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("toast tone timeouts", () : any => {
  beforeEach(() : any => {
    vi.useFakeTimers();
  });

  afterEach(() : any => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps danger toasts open by default while info and success auto-dismiss", () : any => {
    const { toasts } = useConsoleToasts();
    pushConsoleToast({ message: "note", tone: "info" });
    pushConsoleToast({ message: "done", tone: "success" });
    pushConsoleToast({ message: "broken", tone: "danger" });

    vi.advanceTimersByTime(4200);
    expect(toasts.map((toast?: any) : any => toast.message)).toEqual(["broken"]);

    vi.advanceTimersByTime(60_000);
    expect(toasts.map((toast?: any) : any => toast.message)).toEqual(["broken"]);
  });

  it("still honors an explicit danger timeout", () : any => {
    const { toasts } = useConsoleToasts();
    pushConsoleToast({ message: "broken", tone: "danger", timeoutMs: 1200 });

    vi.advanceTimersByTime(1200);
    expect(toasts).toHaveLength(0);
  });
});

describe("toast action", () : any => {
  it("renders the action, invokes run, and dismisses the toast on success", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleToastHost);
    const run: any = vi.fn();
    pushConsoleToast({ message: "row removed", action: { label: "Undo", run } });
    await nextTick();

    const actionButton: any = document.body.querySelector(".console-toast-action") as HTMLButtonElement;
    expect(actionButton?.textContent).toBe("Undo");
    actionButton.click();
    await nextTick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(useConsoleToasts().toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps the toast open and surfaces a danger toast when run throws", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleToastHost);
    pushConsoleToast({
      message: "row removed",
      action: {
        label: "Undo",
        run: (): void => {
          throw new Error("restore failed");
        },
      },
    });
    await nextTick();

    const actionButton: any = document.body.querySelector(".console-toast-action") as HTMLButtonElement;
    actionButton.click();
    await nextTick();

    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(2);
    expect(toasts[0].message).toBe("row removed");
    expect(toasts[1].tone).toBe("danger");
    expect(toasts[1].title).toBe(toastCopy().actionFailed);
    expect(toasts[1].message).toBe("restore failed");
    wrapper.unmount();
  });
});

describe("undo adoption on the two reversible draft operations", () : any => {
  function publishFormWithOperation() : any {
    return {
      operationKey: "",
      method: "",
      path: "",
      risk: "",
      requestRepresentationMode: "",
      requestMaxBytes: "",
      requestMediaTypes: "",
      responseRepresentationMode: "",
      responseMaxBytes: "",
      responseMediaTypes: "",
      tags: [],
      savedCredentialOptions: [],
      operations: [
        {
          operationKey: "list-items",
          method: "GET",
          path: "/api/items",
          risk: "read_only",
          payloadTransport: { request: { mode: "structured_json" } },
        },
      ],
    };
  }

  it("offers undo when a publish draft tool path is removed and restores it in place", async () : Promise<any> => {
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { template: "<div />" } }],
    });
    await router.push("/?publish.tab=operations");
    await router.isReady();
    const form: any = publishFormWithOperation();
    const wrapper: any = mount(PublishServiceForm, {
      props: { form },
      global: { plugins: [router] },
    });
    await nextTick();

    const removeButton: any = wrapper.find(".inline-remove");
    expect(removeButton.exists()).toBe(true);
    await removeButton.trigger("click");

    expect(form.operations).toHaveLength(0);
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(toastCopy().toolPathRemoved);
    expect(toasts[0].action?.label).toBe(toastCopy().undo);

    toasts[0].action.run();
    expect(form.operations).toHaveLength(1);
    expect(form.operations[0].operationKey).toBe("list-items");
    wrapper.unmount();
  });

  function createMaintenanceController() : any {
    return createConsoleMaintenanceAgentController({
      canReadMaintenanceAgent: computed(() : any => true),
      clearBusy: () : any => undefined,
      consoleState: ref(null),
      error: ref(""),
      modelEntryStatusKey: (entry?: any) : any => String(entry?.uid || ""),
      setBusy: () : any => undefined,
      visibleModelEntries: computed(() : any => []),
    });
  }

  it("offers undo when a maintenance schedule row is removed pre-save and restores it at its index", async () : Promise<any> => {
    const controller: any = createMaintenanceController();
    controller.maintenanceAgentConfig.value = {
      schedules: [
        { id: "schedule-a", label: "A", enabled: false, runbook: "rb-a", intervalMinutes: 60, nextRunAt: "" },
        { id: "schedule-b", label: "B", enabled: false, runbook: "rb-b", intervalMinutes: 60, nextRunAt: "" },
        { id: "schedule-c", label: "C", enabled: false, runbook: "rb-c", intervalMinutes: 60, nextRunAt: "" },
      ],
    };

    // REQ-010 guards the click with a confirm; REQ-005's undo covers the
    // pre-save local window after the confirmed removal.
    const pendingRemoval: any = controller.removeMaintenanceAgentSchedule("schedule-b");
    settleConsoleConfirm(true);
    await pendingRemoval;

    expect(controller.maintenanceAgentConfig.value.schedules.map((row?: any) : any => row.id))
      .toEqual(["schedule-a", "schedule-c"]);
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(toastCopy().scheduleRemoved);
    expect(toasts[0].action?.label).toBe(toastCopy().undo);

    toasts[0].action.run();
    expect(controller.maintenanceAgentConfig.value.schedules.map((row?: any) : any => row.id))
      .toEqual(["schedule-a", "schedule-b", "schedule-c"]);
  });

  it("offers no undo when the schedule id is unknown", () : any => {
    const controller: any = createMaintenanceController();
    controller.maintenanceAgentConfig.value = { schedules: [] };

    controller.removeMaintenanceAgentSchedule("missing");
    expect(useConsoleToasts().toasts).toHaveLength(0);
  });

  it("limits the undo label to the two reversible draft sites (never governed server effects)", () : any => {
    // Source scan: import.meta.url is not a file URL under the jsdom
    // environment, so anchor on the repo root vitest runs from.
    const consoleRoot: any = resolve(process.cwd(), "apps/console");
    const sourceFiles: string[] = readdirSync(consoleRoot, { recursive: true })
      .map((entry: any) : any => String(entry))
      .filter((entry: string) : any => entry.endsWith(".ts") || entry.endsWith(".vue"));
    const undoConsumers: string[] = sourceFiles.filter((entry: string) : any =>
      readFileSync(`${consoleRoot}/${entry}`, "utf8").includes("toast.undo"),
    );
    expect(undoConsumers.sort()).toEqual([
      "composables/console-maintenance-agent-controller.ts",
      "views/admin/upstream-service-publish/PublishServiceForm.vue",
    ]);
  });
});

describe("model repository rollback surfacing", () : any => {
  it("toasts the restored state when the save fails and drafts roll back", async () : Promise<any> => {
    agentSettingsClientMock.saveSettings.mockRejectedValueOnce(new Error("save unavailable"));
    const settingsDraft: any = ref({
      modelLibraryAgents: [{ uid: "agent-1", provider: "provider-a", model: "m" }],
      modelLibraryEntries: ["provider-a"],
    });
    const error: any = ref("");
    const controller: any = createConsoleModelRepositoryController({
      clearBusy: () : any => undefined,
      error,
      modelEntryBindingSummary: () : any => "",
      modelEntryIsBound: () : any => false,
      modelEntryStatusKey: (entry?: any) : any => String(entry?.uid || entry?.provider || ""),
      modelLibraryExpandedCards: ref({}),
      normalizeModelEntry: (entry?: any) : any => entry,
      providerLabel: (provider?: any) : any => String(provider),
      replaceSettingsDraftFromServer: () : any => undefined,
      selectedModelProvider: ref("provider-a"),
      setBusy: () : any => undefined,
      settingsDraft,
      settingsPayloadForSave: () : any => settingsDraft.value,
      visibleModelEntries: computed(() : any => settingsDraft.value.modelLibraryAgents),
      visibleModelProviders: computed(() : any => settingsDraft.value.modelLibraryEntries),
    });

    // REQ-010 confirms the removal first; REQ-005's rollback toast surfaces
    // when the later save fails and drafts restore.
    const pendingRemoval: any = controller.removeModelProvider("provider-a");
    settleConsoleConfirm(true);
    await pendingRemoval;

    expect(error.value).toBe("save unavailable");
    expect(settingsDraft.value.modelLibraryAgents).toHaveLength(1);
    expect(settingsDraft.value.modelLibraryEntries).toEqual(["provider-a"]);
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe("info");
    expect(toasts[0].message).toBe(toastCopy().rollbackRestored);
  });
});
