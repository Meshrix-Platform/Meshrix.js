// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ConsoleConfirmDialog from "../../../apps/console/components/ConsoleConfirmDialog.vue";
import ConsoleToastHost from "../../../apps/console/components/ConsoleToastHost.vue";
import {
  hasConsoleConfirmHost,
  requestConsoleConfirm,
  settleAllConsoleConfirms,
  settleConsoleConfirm,
} from "../../../apps/console/composables/console-confirm-controller";
import {
  clearConsoleToasts,
  CONSOLE_TOAST_LIMIT,
  dismissConsoleToast,
  pushConsoleToast,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";

beforeEach(() : any => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() : any => {
  clearConsoleToasts();
  settleAllConsoleConfirms(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("console toast controller", () : any => {
  it("pushes toasts and auto-dismisses them after the tone timeout", () : any => {
    const { toasts } = useConsoleToasts();

    pushConsoleToast({ message: "已保存", tone: "success" });
    // Explicit timeout: the danger default is now pinned open (timeoutMs 0),
    // so this test opts into the timed path it verifies.
    pushConsoleToast({ message: "保存失败", tone: "danger", timeoutMs: 6500 });

    expect(toasts.map((toast?: any) : any => toast.message)).toEqual(["已保存", "保存失败"]);

    vi.advanceTimersByTime(3600);
    expect(toasts.map((toast?: any) : any => toast.message)).toEqual(["保存失败"]);

    vi.advanceTimersByTime(6500 - 3600);
    expect(toasts).toHaveLength(0);
  });

  it("caps the stack at the toast limit and drops the oldest entries", () : any => {
    const { toasts } = useConsoleToasts();

    for (let index: any = 1; index <= CONSOLE_TOAST_LIMIT + 2; index += 1) {
      pushConsoleToast({ message: `m${index}` });
    }

    expect(toasts).toHaveLength(CONSOLE_TOAST_LIMIT);
    expect(toasts[0].message).toBe("m3");

    dismissConsoleToast(toasts[0].id);
    expect(toasts.map((toast?: any) : any => toast.message)).toEqual(["m4", "m5", "m6", "m7"]);
  });

  it("ignores empty messages", () : any => {
    const { toasts } = useConsoleToasts();
    pushConsoleToast({ message: "  " });
    expect(toasts).toHaveLength(0);
  });
});

describe("console confirm controller", () : any => {
  it("resolves false when no dialog host is mounted", async () : Promise<any> => {
    expect(hasConsoleConfirmHost()).toBe(false);
    await expect(requestConsoleConfirm({ message: "继续？" })).resolves.toBe(false);
  });

  it("queues multiple requests and settles them in order", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleConfirmDialog);
    expect(hasConsoleConfirmHost()).toBe(true);

    const first: any = requestConsoleConfirm({ message: "第一步" });
    const second: any = requestConsoleConfirm({ message: "第二步" });
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("第一步");

    settleConsoleConfirm(true);
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("第二步");

    settleConsoleConfirm(false);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    wrapper.unmount();
    expect(hasConsoleConfirmHost()).toBe(false);
  });
});

describe("ConsoleConfirmDialog", () : any => {
  it("renders the pending request with danger tone and resolves the cancel choice", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleConfirmDialog);
    const pending: any = requestConsoleConfirm({
      title: "删除任务",
      message: "确认删除该任务？",
      tone: "danger",
      confirmLabel: "删除",
    });
    await wrapper.vm.$nextTick();

    const dialog: any = document.body.querySelector(".console-confirm-dialog");
    expect(dialog?.classList.contains("tone-danger")).toBe(true);
    expect(dialog?.getAttribute("role")).toBe("alertdialog");
    expect(document.body.querySelector(".console-confirm-title")?.textContent).toBe("删除任务");
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("确认删除该任务？");

    const cancelButton: any = document.body.querySelector(".console-confirm-actions .tool-button-ghost") as HTMLButtonElement;
    cancelButton.click();
    await expect(pending).resolves.toBe(false);
    wrapper.unmount();
  });

  it("keeps confirm disabled until the required text matches", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleConfirmDialog);
    const pending: any = requestConsoleConfirm({ message: "高危操作", requireText: "DELETE" });
    await wrapper.vm.$nextTick();

    const confirmButton: any = document.body.querySelector(".console-confirm-button") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    const input: any = document.body.querySelector(".console-confirm-require input") as HTMLInputElement;
    input.value = "DELETE";
    input.dispatchEvent(new Event("input"));
    await wrapper.vm.$nextTick();
    expect(confirmButton.disabled).toBe(false);

    confirmButton.click();
    await expect(pending).resolves.toBe(true);
    wrapper.unmount();
  });

  it("traps keyboard focus and restores the invoking control after close", async () : Promise<any> => {
    const invokingButton: any = document.createElement("button");
    document.body.append(invokingButton);
    invokingButton.focus();

    const wrapper: any = mount(ConsoleConfirmDialog);
    const pending: any = requestConsoleConfirm({ message: "确认操作？", tone: "danger" });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const cancelButton: any = document.body.querySelector(
      ".console-confirm-actions .tool-button-ghost",
    ) as HTMLButtonElement;
    const confirmButton: any = document.body.querySelector(
      ".console-confirm-button",
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(cancelButton);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(confirmButton);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(cancelButton);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(pending).resolves.toBe(false);
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(invokingButton);
    wrapper.unmount();
  });

  it("does not let a repeated click settle the next queued confirmation", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleConfirmDialog);
    const first: any = requestConsoleConfirm({ message: "第一步" });
    const second: any = requestConsoleConfirm({ message: "第二步" });
    await wrapper.vm.$nextTick();

    const confirmButton: any = document.body.querySelector(
      ".console-confirm-button",
    ) as HTMLButtonElement;
    confirmButton.click();
    confirmButton.click();
    await expect(first).resolves.toBe(true);
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("第二步");

    const cancelButton: any = document.body.querySelector(
      ".console-confirm-actions .tool-button-ghost",
    ) as HTMLButtonElement;
    cancelButton.click();
    await expect(second).resolves.toBe(false);
    wrapper.unmount();
  });
});

describe("ConsoleToastHost", () : any => {
  it("renders pushed toasts and dismisses them from the close button", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleToastHost);

    pushConsoleToast({ title: "工作树", message: "同步完成", tone: "success" });
    await wrapper.vm.$nextTick();

    const toast: any = document.body.querySelector(".console-toast");
    expect(toast?.classList.contains("tone-success")).toBe(true);
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.textContent).toContain("同步完成");

    const closeButton: any = document.body.querySelector(".console-toast-close") as HTMLButtonElement;
    closeButton.click();
    expect(useConsoleToasts().toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it("marks danger toasts with the alert role", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleToastHost);
    pushConsoleToast({ message: "连接失败", tone: "danger" });
    await wrapper.vm.$nextTick();

    const toast: any = document.body.querySelector(".console-toast");
    expect(toast?.getAttribute("role")).toBe("alert");
    wrapper.unmount();
  });
});
