// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
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
import {
  registerConsoleConfirmHost,
  settleAllConsoleConfirms,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";

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

describe("undo adoption on reversible publish drafts", () : any => {
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

  it("limits the undo label to the reversible publish draft site", () : any => {
    // Source scan: import.meta.url is not a file URL under the jsdom
    // environment, so anchor on the repo root vitest runs from.
    const consoleRoot: any = resolve(process.cwd(), "apps/console");
    const sourceFiles: string[] = readdirSync(consoleRoot, { recursive: true })
      .map((entry: any) : any => String(entry))
      .filter((entry: string) : any => entry.endsWith(".ts") || entry.endsWith(".vue"));
    const undoConsumers: string[] = sourceFiles.filter((entry: string) : any =>
      readFileSync(`${consoleRoot}/${entry}`, "utf8").includes("toast.undo"),
    );
    expect(undoConsumers.sort()).toEqual(["views/admin/upstream-service-publish/PublishServiceForm.vue"]);
  });
});
