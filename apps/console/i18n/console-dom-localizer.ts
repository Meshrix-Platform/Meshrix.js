import { localizeConsoleText, type ConsoleLocale } from "./console";

export type ConsoleDomLocalizer = {
  refresh: () => void;
  disconnect: () => void;
};

function emptyConsoleDomLocalizer(): ConsoleDomLocalizer {
  return {
    refresh() : any {},
    disconnect() : any {},
  };
}

function shouldSkipConsoleLocalizeElement(element: Element | null) : any {
  if (!element) {
    return false;
  }
  const tagName: any = element.tagName.toLowerCase();
  if (["script", "style", "pre", "code"].includes(tagName)) {
    return true;
  }
  return Boolean(
    element.closest(
      "[data-i18n-skip], pre, code, .json-config-file-editor, .markdown-body, .agent-answer, .evidence-readable-body",
    ),
  );
}

function shouldSkipConsoleLocalizeText(element: Element | null) : any {
  if (!element) {
    return true;
  }
  const tagName: any = element.tagName.toLowerCase();
  if (["script", "style", "textarea", "pre", "code"].includes(tagName)) {
    return true;
  }
  return Boolean(
    element.closest(
      "[data-i18n-skip], textarea, pre, code, .json-config-file-editor, .markdown-body, .agent-answer, .evidence-readable-body",
    ),
  );
}

function localizeConsoleElementAttributes(element: Element, locale: ConsoleLocale) : any {
  for (const attr of ["placeholder", "title", "aria-label", "alt", "data-tooltip", "data-label"]) {
    const current: any = element.getAttribute(attr);
    if (!current) {
      continue;
    }
    const localized: any = localizeConsoleText(current, locale);
    if (localized !== current) {
      element.setAttribute(attr, localized);
    }
  }
}

function localizeConsoleNode(root: Node, locale: ConsoleLocale) : any {
  if (root.nodeType === Node.TEXT_NODE) {
    const parent: any = root.parentElement;
    if (shouldSkipConsoleLocalizeText(parent)) {
      return;
    }
    const current: any = root.nodeValue || "";
    const localized: any = localizeConsoleText(current, locale);
    if (localized !== current) {
      root.nodeValue = localized;
    }
    return;
  }

  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
    return;
  }

  const rootElement: any = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : null;
  if (shouldSkipConsoleLocalizeElement(rootElement)) {
    return;
  }
  if (rootElement) {
    localizeConsoleElementAttributes(rootElement, locale);
  }

  const walker: any = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node?: any) : any {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return shouldSkipConsoleLocalizeElement(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
        const parent: any = node.parentElement;
        return shouldSkipConsoleLocalizeText(parent)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let node: any = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      localizeConsoleElementAttributes(node as Element, locale);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const current: any = node.nodeValue || "";
      const localized: any = localizeConsoleText(current, locale);
      if (localized !== current) {
        node.nodeValue = localized;
      }
    }
    node = walker.nextNode();
  }
}

export function installConsoleDomLocalizer(getLocale: () => ConsoleLocale): ConsoleDomLocalizer {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return emptyConsoleDomLocalizer();
  }

  let refreshing: any = false;
  const refresh: any = () : any => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    window.requestAnimationFrame(() : any => {
      try {
        localizeConsoleNode(document.body, getLocale());
      } finally {
        refreshing = false;
      }
    });
  };

  const observer: any = new MutationObserver((mutations?: any) : any => {
    if (refreshing) {
      return;
    }
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        localizeConsoleNode(mutation.target, getLocale());
        continue;
      }
      if (mutation.type === "attributes") {
        localizeConsoleNode(mutation.target, getLocale());
        continue;
      }
      mutation.addedNodes.forEach((node?: any) : any => localizeConsoleNode(node, getLocale()));
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["placeholder", "title", "aria-label", "alt", "data-tooltip", "data-label"],
  });
  refresh();

  return {
    refresh,
    disconnect() : any {
      observer.disconnect();
    },
  };
}
