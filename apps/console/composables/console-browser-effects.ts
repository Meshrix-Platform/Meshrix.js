import { nextTick, type Ref } from "vue";
import { triggerBrowserDownload } from "@meshrix/ui-console/browser-downloads";
import { browserWindow } from "@meshrix/ui-console/browser-window";
import {
  hasConsoleConfirmHost,
  requestConsoleConfirm,
  type ConsoleConfirmTone,
} from "./console-confirm-controller";
import { pushConsoleToast, type ConsoleToastTone } from "./console-toast-controller";

const interactiveTargetSelector: any = "button,input,textarea,select,a[href],[tabindex]";

export function confirmConsoleAction(
  message: string,
  options: {
    defaultValue?: boolean;
    title?: string;
    tone?: ConsoleConfirmTone;
    confirmLabel?: string;
    cancelLabel?: string;
    requireText?: string;
  } = {},
): Promise<boolean> {
  if (!browserWindow() || !hasConsoleConfirmHost()) {
    return Promise.resolve(options.defaultValue ?? false);
  }
  return requestConsoleConfirm({
    message,
    title: options.title,
    tone: options.tone,
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel,
    requireText: options.requireText,
  });
}

export function notifyConsoleAction(
  message: string,
  options: { tone?: ConsoleToastTone; title?: string } = {},
) : any {
  pushConsoleToast({ tone: options.tone ?? "info", title: options.title, message });
}

export function scrollElementIntoViewById(
  elementId: string,
  options: ScrollIntoViewOptions = { behavior: "smooth", block: "start" },
) : any {
  if (typeof document === "undefined") {
    return false;
  }
  const element: any = document.getElementById(elementId);
  if (!element) {
    return false;
  }
  element.scrollIntoView(options);
  return true;
}

function browserDocument() : any {
  return browserWindow()?.document || (typeof document === "undefined" ? null : document);
}

export function scrollDataAttributeElementIntoView(
  attributeName: string,
  attributeValue: string,
  options: ScrollIntoViewOptions = { behavior: "smooth", block: "nearest" },
) : any {
  const normalizedName: any = String(attributeName || "").trim();
  if (!/^[a-zA-Z_][\w:.-]*$/.test(normalizedName)) {
    return false;
  }
  const doc: any = browserDocument();
  if (!doc) {
    return false;
  }
  const element: any = Array.from(doc.querySelectorAll(`[${normalizedName}]`) as NodeListOf<HTMLElement>)
    .find((candidate?: any) : any => candidate.getAttribute(normalizedName) === attributeValue);
  if (!element) {
    return false;
  }
  element.scrollIntoView(options);
  return true;
}

function eventTargetElement(event: Event) : any {
  const target: any = event.currentTarget || event.target;
  return target instanceof Element ? target : null;
}

export function showFloatingElementFeedback(
  target: Element,
  message: any = "已复制",
  options: { className?: string; visibleMs?: number } = {},
) : any {
  const doc: any = target.ownerDocument || document;
  const browser: any = doc.defaultView || browserWindow();
  if (!browser) {
    return false;
  }
  const rect: any = target.getBoundingClientRect();
  const bubble: any = doc.createElement("div");
  bubble.textContent = message;
  bubble.className = options.className || "meshrix-copy-bubble";
  bubble.style.left = `${rect.left + rect.width / 2}px`;
  bubble.style.top = `${rect.top}px`;
  doc.body.appendChild(bubble);

  void bubble.offsetWidth;

  browser.requestAnimationFrame(() : any => {
    bubble.style.transform = "translate(-50%, -30px) scale(1.1)";
    bubble.style.opacity = "1";
  });

  browser.setTimeout(() : any => {
    bubble.style.opacity = "0";
    bubble.style.transform = "translate(-50%, -40px) scale(0.9)";
    browser.setTimeout(() : any => bubble.remove(), 200);
  }, options.visibleMs ?? 600);
  return true;
}

export async function copyConsoleText(text: string) : Promise<any> {
  if (!text) {
    return false;
  }
  await copyTextToClipboard(text);
  return true;
}

export async function copyTextToClipboard(content: string) : Promise<any> {
  const browser: any = browserWindow();
  const doc: any = browser?.document || (typeof document === "undefined" ? null : document);
  if (!browser || !doc) {
    throw new Error("剪贴板环境不可用。");
  }
  if (browser.navigator.clipboard?.writeText) {
    await browser.navigator.clipboard.writeText(content);
    return;
  }
  const textArea: any = doc.createElement("textarea");
  textArea.value = content;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  doc.body.appendChild(textArea);
  try {
    textArea.select();
    doc.execCommand("copy");
  } finally {
    textArea.remove();
  }
}

export function downloadTextFile(
  fileName: string,
  content: string,
  contentType: any = "text/plain;charset=utf-8",
) : any {
  triggerBrowserDownload(new Blob([content], { type: contentType }), fileName);
}

export async function copyConsoleTextWithFeedback(
  event: Event,
  text: string,
  options: { message?: string } = {},
) : Promise<any> {
  const copied: any = await copyConsoleText(text);
  if (!copied) {
    return false;
  }
  const target: any = eventTargetElement(event);
  if (target) {
    showFloatingElementFeedback(target, options.message || "已复制");
  }
  return true;
}

async function waitForNextFrame() : Promise<any> {
  const browser: any = browserWindow();
  if (!browser) {
    return;
  }
  await new Promise<void>((resolve?: any) : any => {
    browser.requestAnimationFrame(() : any => resolve());
  });
}

function focusFirstInteractiveTarget(root: HTMLElement) : any {
  const focusTarget: any = root.matches(interactiveTargetSelector)
    ? root
    : root.querySelector<HTMLElement>(interactiveTargetSelector);
  focusTarget?.focus?.({ preventScroll: true });
}

export function createConsoleTargetHighlightController(
  options: {
    highlightedTarget: Ref<string>;
    highlightDurationMs?: number;
  },
) : any {
  let highlightTimer: number | null = null;

  function clearConfigTargetHighlight() : any {
    const browser: any = browserWindow();
    if (browser && highlightTimer) {
      browser.clearTimeout(highlightTimer);
    }
    highlightTimer = null;
  }

  function configTargetElement(targetId: string) : any {
    if (typeof document === "undefined") {
      return null;
    }
    return (
      Array.from(document.querySelectorAll<HTMLElement>("[data-config-target]"))
        .find((element?: any) : any => element.dataset.configTarget === targetId) || null
    );
  }

  async function scrollToConfigTarget(targetId: string) : Promise<any> {
    options.highlightedTarget.value = targetId;
    await nextTick();
    await waitForNextFrame();
    const target: any = configTargetElement(targetId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      focusFirstInteractiveTarget(target);
    }
    clearConfigTargetHighlight();
    const browser: any = browserWindow();
    if (!browser) {
      return;
    }
    highlightTimer = browser.setTimeout(() : any => {
      if (options.highlightedTarget.value === targetId) {
        options.highlightedTarget.value = "";
      }
      highlightTimer = null;
    }, options.highlightDurationMs ?? 2400);
  }

  return {
    clearConfigTargetHighlight,
    configTargetElement,
    scrollToConfigTarget,
  };
}
