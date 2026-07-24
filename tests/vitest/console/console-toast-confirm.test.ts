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

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  clearConsoleToasts();
  settleAllConsoleConfirms(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("console toast controller", () => {
  it("pushes toasts and auto-dismisses them after the tone timeout", () => {
    const { toasts } = useConsoleToasts();

    pushConsoleToast({ message: "已保存", tone: "success" });
    pushConsoleToast({ message: "保存失败", tone: "danger" });

    expect(toasts.map((toast) => toast.message)).toEqual(["已保存", "保存失败"]);

    vi.advanceTimersByTime(3600);
    expect(toasts.map((toast) => toast.message)).toEqual(["保存失败"]);

    vi.advanceTimersByTime(6500 - 3600);
    expect(toasts).toHaveLength(0);
  });

  it("caps the stack at the toast limit and drops the oldest entries", () => {
    const { toasts } = useConsoleToasts();

    for (let index = 1; index <= CONSOLE_TOAST_LIMIT + 2; index += 1) {
      pushConsoleToast({ message: `m${index}` });
    }

    expect(toasts).toHaveLength(CONSOLE_TOAST_LIMIT);
    expect(toasts[0].message).toBe("m3");

    dismissConsoleToast(toasts[0].id);
    expect(toasts.map((toast) => toast.message)).toEqual(["m4", "m5", "m6", "m7"]);
  });

  it("ignores empty messages", () => {
    const { toasts } = useConsoleToasts();
    pushConsoleToast({ message: "  " });
    expect(toasts).toHaveLength(0);
  });
});

describe("console confirm controller", () => {
  it("resolves false when no dialog host is mounted", async () => {
    expect(hasConsoleConfirmHost()).toBe(false);
    await expect(requestConsoleConfirm({ message: "继续？" })).resolves.toBe(false);
  });

  it("queues multiple requests and settles them in order", async () => {
    const wrapper = mount(ConsoleConfirmDialog);
    expect(hasConsoleConfirmHost()).toBe(true);

    const first = requestConsoleConfirm({ message: "第一步" });
    const second = requestConsoleConfirm({ message: "第二步" });
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

describe("ConsoleConfirmDialog", () => {
  it("renders the pending request with danger tone and resolves the cancel choice", async () => {
    const wrapper = mount(ConsoleConfirmDialog);
    const pending = requestConsoleConfirm({
      title: "删除任务",
      message: "确认删除该任务？",
      tone: "danger",
      confirmLabel: "删除",
    });
    await wrapper.vm.$nextTick();

    const dialog = document.body.querySelector(".console-confirm-dialog");
    expect(dialog?.classList.contains("tone-danger")).toBe(true);
    expect(dialog?.getAttribute("role")).toBe("alertdialog");
    expect(document.body.querySelector(".console-confirm-title")?.textContent).toBe("删除任务");
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("确认删除该任务？");

    const cancelButton = document.body.querySelector(".console-confirm-actions .tool-button-ghost") as HTMLButtonElement;
    cancelButton.click();
    await expect(pending).resolves.toBe(false);
    wrapper.unmount();
  });

  it("keeps confirm disabled until the required text matches", async () => {
    const wrapper = mount(ConsoleConfirmDialog);
    const pending = requestConsoleConfirm({ message: "高危操作", requireText: "DELETE" });
    await wrapper.vm.$nextTick();

    const confirmButton = document.body.querySelector(".console-confirm-button") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    const input = document.body.querySelector(".console-confirm-require input") as HTMLInputElement;
    input.value = "DELETE";
    input.dispatchEvent(new Event("input"));
    await wrapper.vm.$nextTick();
    expect(confirmButton.disabled).toBe(false);

    confirmButton.click();
    await expect(pending).resolves.toBe(true);
    wrapper.unmount();
  });

  it("traps keyboard focus and restores the invoking control after close", async () => {
    const invokingButton = document.createElement("button");
    document.body.append(invokingButton);
    invokingButton.focus();

    const wrapper = mount(ConsoleConfirmDialog);
    const pending = requestConsoleConfirm({ message: "确认操作？", tone: "danger" });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const cancelButton = document.body.querySelector(
      ".console-confirm-actions .tool-button-ghost",
    ) as HTMLButtonElement;
    const confirmButton = document.body.querySelector(
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

  it("does not let a repeated click settle the next queued confirmation", async () => {
    const wrapper = mount(ConsoleConfirmDialog);
    const first = requestConsoleConfirm({ message: "第一步" });
    const second = requestConsoleConfirm({ message: "第二步" });
    await wrapper.vm.$nextTick();

    const confirmButton = document.body.querySelector(
      ".console-confirm-button",
    ) as HTMLButtonElement;
    confirmButton.click();
    confirmButton.click();
    await expect(first).resolves.toBe(true);
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".console-confirm-message")?.textContent).toBe("第二步");

    const cancelButton = document.body.querySelector(
      ".console-confirm-actions .tool-button-ghost",
    ) as HTMLButtonElement;
    cancelButton.click();
    await expect(second).resolves.toBe(false);
    wrapper.unmount();
  });
});

describe("ConsoleToastHost", () => {
  it("renders pushed toasts and dismisses them from the close button", async () => {
    const wrapper = mount(ConsoleToastHost);

    pushConsoleToast({ title: "工作树", message: "同步完成", tone: "success" });
    await wrapper.vm.$nextTick();

    const toast = document.body.querySelector(".console-toast");
    expect(toast?.classList.contains("tone-success")).toBe(true);
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.textContent).toContain("同步完成");

    const closeButton = document.body.querySelector(".console-toast-close") as HTMLButtonElement;
    closeButton.click();
    expect(useConsoleToasts().toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it("marks danger toasts with the alert role", async () => {
    const wrapper = mount(ConsoleToastHost);
    pushConsoleToast({ message: "连接失败", tone: "danger" });
    await wrapper.vm.$nextTick();

    const toast = document.body.querySelector(".console-toast");
    expect(toast?.getAttribute("role")).toBe("alert");
    wrapper.unmount();
  });
});
