// @vitest-environment jsdom
import { ref } from "vue";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  confirmConsoleAction,
  copyConsoleText,
  copyConsoleTextWithFeedback,
  copyTextToClipboard,
  createConsoleTargetHighlightController,
  downloadTextFile,
  notifyConsoleAction,
  scrollDataAttributeElementIntoView,
  scrollElementIntoViewById,
  showFloatingElementFeedback,
} from "../../../apps/console/composables/console-browser-effects";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";
import {
  clearConsoleToasts,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";

const triggerBrowserDownloadMock = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/console/lib/browser-downloads", () => ({
  triggerBrowserDownload: triggerBrowserDownloadMock,
}));

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
const originalExecCommand = document.execCommand;
const originalRequestAnimationFrame = window.requestAnimationFrame;

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  triggerBrowserDownloadMock.mockReset();
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  if (originalClipboard) {
    Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(window.navigator, "clipboard");
  }
  document.execCommand = originalExecCommand;
  window.requestAnimationFrame = originalRequestAnimationFrame;
});

describe("console browser effects", () => {
  it("routes confirms through the dialog host and notifications through toasts", async () => {
    await expect(confirmConsoleAction("delete it?")).resolves.toBe(false);
    await expect(confirmConsoleAction("delete it?", { defaultValue: true })).resolves.toBe(true);

    registerConsoleConfirmHost();
    const pending = confirmConsoleAction("delete it?");
    settleConsoleConfirm(true);
    await expect(pending).resolves.toBe(true);
    unregisterConsoleConfirmHost();

    notifyConsoleAction("done", { tone: "success" });
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("done");
    expect(toasts[0].tone).toBe("success");
    clearConsoleToasts();
  });

  it("scrolls elements by id and exact data attribute", () => {
    document.body.innerHTML = `
      <section id="target"></section>
      <div data-config-target="alpha"></div>
      <div data-config-target="beta"></div>
    `;
    const idTarget = document.getElementById("target") as HTMLElement;
    const dataTarget = document.querySelector('[data-config-target="beta"]') as HTMLElement;
    idTarget.scrollIntoView = vi.fn();
    dataTarget.scrollIntoView = vi.fn();

    expect(scrollElementIntoViewById("missing")).toBe(false);
    expect(scrollElementIntoViewById("target", { block: "end" })).toBe(true);
    expect(idTarget.scrollIntoView).toHaveBeenCalledWith({ block: "end" });

    expect(scrollDataAttributeElementIntoView("data-config-target", "missing")).toBe(false);
    expect(scrollDataAttributeElementIntoView("bad attr", "beta")).toBe(false);
    expect(scrollDataAttributeElementIntoView("data-config-target", "beta", { block: "center" })).toBe(true);
    expect(dataTarget.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("shows floating feedback and removes it after timers", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      top: 20,
      width: 40,
      height: 10,
      bottom: 30,
      right: 50,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect));

    expect(showFloatingElementFeedback(button, "Copied", { visibleMs: 10 })).toBe(true);

    const bubble = document.querySelector(".lico-copy-bubble") as HTMLElement;
    expect(bubble.textContent).toBe("Copied");
    expect(bubble.style.left).toBe("30px");
    expect(bubble.style.top).toBe("20px");
    expect(bubble.style.opacity).toBe("1");

    vi.advanceTimersByTime(10);
    expect(bubble.style.opacity).toBe("0");
    vi.advanceTimersByTime(200);
    expect(document.querySelector(".lico-copy-bubble")).toBeNull();
  });

  it("copies text through clipboard and falls back to execCommand", async () => {
    const writeText = installClipboard();

    await expect(copyConsoleText("hello")).resolves.toBe(true);
    await expect(copyConsoleText("")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith("hello");

    Reflect.deleteProperty(window.navigator, "clipboard");
    const execSpy = vi.fn(() => true);
    document.execCommand = execSpy as typeof document.execCommand;

    await copyTextToClipboard("fallback");

    expect(execSpy).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("downloads text files and copies with target feedback", async () => {
    const writeText = installClipboard();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 20,
      height: 10,
      bottom: 10,
      right: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));

    downloadTextFile("report.txt", "hello", "text/plain");
    expect(triggerBrowserDownloadMock).toHaveBeenCalledWith(expect.any(Blob), "report.txt");
    const blob = triggerBrowserDownloadMock.mock.calls[0][0] as Blob;
    await expect(blob.text()).resolves.toBe("hello");

    await expect(copyConsoleTextWithFeedback(new Event("click"), "no target")).resolves.toBe(true);
    await expect(copyConsoleTextWithFeedback(new Event("click", { bubbles: true }), "")).resolves.toBe(false);
    await expect(copyConsoleTextWithFeedback({ currentTarget: button } as unknown as Event, "copy me", {
      message: "Copied",
    })).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(document.querySelector(".lico-copy-bubble")?.textContent).toBe("Copied");
  });

  it("scrolls and highlights config targets with timer cleanup", async () => {
    document.body.innerHTML = `
      <div data-config-target="agent-settings">
        <button>Focusable</button>
      </div>
    `;
    const root = document.querySelector("[data-config-target]") as HTMLElement;
    root.scrollIntoView = vi.fn();
    const highlightedTarget = ref("");
    const controller = createConsoleTargetHighlightController({
      highlightedTarget,
      highlightDurationMs: 25,
    });

    expect(controller.configTargetElement("missing")).toBeNull();
    expect(controller.configTargetElement("agent-settings")).toBe(root);

    await controller.scrollToConfigTarget("agent-settings");

    expect(highlightedTarget.value).toBe("agent-settings");
    expect(root.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    expect(document.activeElement?.textContent).toBe("Focusable");

    vi.advanceTimersByTime(25);
    expect(highlightedTarget.value).toBe("");

    highlightedTarget.value = "agent-settings";
    await controller.scrollToConfigTarget("missing");
    controller.clearConfigTargetHighlight();
    vi.advanceTimersByTime(25);
    expect(highlightedTarget.value).toBe("missing");
  });

  it("handles missing browser globals without throwing", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

    try {
      await expect(confirmConsoleAction("delete it?", { defaultValue: true })).resolves.toBe(true);
      expect(scrollElementIntoViewById("missing")).toBe(false);
      await expect(copyTextToClipboard("no browser")).rejects.toThrow("剪贴板环境不可用。");
      await expect(copyConsoleText("no browser")).rejects.toThrow("剪贴板环境不可用。");

      const highlightedTarget = ref("");
      const controller = createConsoleTargetHighlightController({ highlightedTarget });
      await controller.scrollToConfigTarget("missing-target");
      expect(highlightedTarget.value).toBe("missing-target");
      expect(controller.configTargetElement("missing-target")).toBeNull();
      controller.clearConfigTargetHighlight();

      expect(showFloatingElementFeedback({
        ownerDocument: {
          defaultView: null,
        },
      } as unknown as Element)).toBe(false);
    } finally {
      vi.stubGlobal("window", originalWindow);
      vi.stubGlobal("document", originalDocument);
    }
  });
});
