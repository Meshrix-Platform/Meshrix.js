import { browserWindow } from "./browser-window";

export type BrowserDownloadOptions = {
  rel?: string;
  revokeDelayMs?: number;
};

function browserDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

export function triggerBrowserDownload(
  blob: Blob,
  fileName: string,
  options: BrowserDownloadOptions = {},
): void {
  const doc = browserDocument();
  const browser = doc?.defaultView || browserWindow();
  if (!doc || !browser) {
    throw new Error("浏览器下载环境不可用。");
  }

  const objectUrl = URL.createObjectURL(blob);
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
      browser.setTimeout(() => URL.revokeObjectURL(objectUrl), revokeDelayMs);
    } else {
      URL.revokeObjectURL(objectUrl);
    }
  }
}
