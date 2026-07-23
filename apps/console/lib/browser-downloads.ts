import { browserWindow } from "./browser-window";

type BrowserDownloadOptions = {
  rel?: string;
  revokeDelayMs?: number;
};

function browserDocument() {
  return typeof document === "undefined" ? null : document;
}

export function triggerBrowserDownload(
  blob: Blob,
  fileName: string,
  options: BrowserDownloadOptions = {},
) {
  const doc = browserDocument();
  const browser = doc?.defaultView || browserWindow();
  if (!doc || !browser) {
    throw new Error("浏览器下载环境不可用。");
  }

  const objectUrl = browser.URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  const revokeDelayMs = options.revokeDelayMs ?? 30_000;
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = options.rel || "noreferrer";
  anchor.style.display = "none";

  try {
    doc.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    if (revokeDelayMs > 0) {
      browser.setTimeout(() => browser.URL.revokeObjectURL(objectUrl), revokeDelayMs);
    } else {
      browser.URL.revokeObjectURL(objectUrl);
    }
  }
}
