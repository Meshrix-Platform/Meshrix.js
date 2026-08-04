// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerBrowserDownload } from "@meshrix/ui-console/browser-downloads";

const objectUrl: any = "blob:meshrix-download";
let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
let originalDocumentDescriptor: PropertyDescriptor | undefined;

beforeEach(() : any => {
  vi.useFakeTimers();
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  URL.createObjectURL = vi.fn(() : any => objectUrl);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() : any => {
  URL.createObjectURL = originalCreateObjectURL!;
  URL.revokeObjectURL = originalRevokeObjectURL!;
  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser downloads behavior", () : any => {
  it("creates an invisible anchor, clicks it, removes it, and revokes later", () : any => {
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy: any = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) : any {
      clicked.push(this);
    });
    const blob: any = new Blob(["hello"], { type: "text/plain" });

    triggerBrowserDownload(blob, "report.txt", { rel: "noopener", revokeDelayMs: 500 });

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clicked[0]).toMatchObject({
      download: "report.txt",
      href: objectUrl,
      rel: "noopener",
    });
    expect(clicked[0].style.display).toBe("none");
    expect(document.body.contains(clicked[0])).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("uses default rel and revokes immediately when revoke delay is zero", () : any => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) : any {
      clicked.push(this);
    });

    triggerBrowserDownload(new Blob(["{}"], { type: "application/json" }), "data.json", {
      revokeDelayMs: 0,
    });

    expect(clicked[0].rel).toBe("noreferrer");
    expect(clicked[0].download).toBe("data.json");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("removes the anchor and revokes when click throws", () : any => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() : any => {
      throw new Error("click blocked");
    });

    expect(() : any => triggerBrowserDownload(new Blob(["x"]), "x.txt", { revokeDelayMs: 0 })).toThrow("click blocked");
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("throws when no browser document is available", () : any => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: undefined,
    });

    expect(() : any => triggerBrowserDownload(new Blob(["x"]), "x.txt")).toThrow("浏览器下载环境不可用。");
  });
});
