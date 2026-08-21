// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const triggerBrowserDownloadMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../packages/ui-console/src/browser-downloads", () : any => ({
  triggerBrowserDownload: triggerBrowserDownloadMock,
}));

type BridgeHttpModule = typeof import("@meshrix/ui-console/bridge-http");

const originalFetch: any = globalThis.fetch;

async function loadBridgeHttp(): Promise<BridgeHttpModule> {
  vi.resetModules();
  return import("@meshrix/ui-console/bridge-http");
}

function jsonResponse(payload: unknown, init: ResponseInit = {}) : any {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function textResponse(text: string, init: ResponseInit = {}) : any {
  return new Response(text, {
    status: init.status || 200,
    headers: init.headers,
  });
}

function fetchMock() : any {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() : any => {
  triggerBrowserDownloadMock.mockReset();
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() : any => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("bridge-http JSON helpers", () : any => {
  it("sends JSON requests, safety headers, and carries CSRF tokens forward", async () : Promise<any> => {
    const { deleteJson, getJson, postJson, putBinaryJson } = await loadBridgeHttp();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrfToken: "token-1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, session: { csrfToken: "token-2" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(postJson("/api/auth/login", { user: "owner" }, { safetyConfirm: true })).resolves.toEqual({
      ok: true,
      csrfToken: "token-1",
    });
    const postCall: any = fetchMock().mock.calls[0];
    expect(postCall[0]).toBe("/api/auth/login");
    expect(postCall[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ user: "owner" }),
      credentials: "same-origin",
    });
    expect(postCall[1].headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-meshrix-safety-confirm": "true",
    });
    expect(postCall[1].headers["x-meshrix-csrf"]).toBeUndefined();

    await getJson("/api/session");
    expect(fetchMock().mock.calls[1][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "x-meshrix-csrf": "token-1",
      },
    });

    await deleteJson("/api/sessions/old", { safetyConfirm: true });
    expect(fetchMock().mock.calls[2][1].headers).toMatchObject({
      Accept: "application/json",
      "x-meshrix-csrf": "token-1",
      "x-meshrix-safety-confirm": "true",
    });

    const blob: any = new Blob(["abc"], { type: "application/octet-stream" });
    await putBinaryJson("/api/upload", blob);
    expect(fetchMock().mock.calls[3][1]).toMatchObject({
      method: "PUT",
      body: blob,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "x-meshrix-csrf": "token-2",
      },
    });
  });

  it("uses GET when postJson has no payload", async () : Promise<any> => {
    const { postJson } = await loadBridgeHttp();
    fetchMock().mockResolvedValueOnce(jsonResponse({ subscribed: true }));

    await expect(postJson("/api/events")).resolves.toEqual({ subscribed: true });

    expect(fetchMock()).toHaveBeenCalledWith("/api/events", expect.objectContaining({
      method: "GET",
      body: undefined,
      headers: { Accept: "application/json" },
    }));
  });

  it("reports HTTP and malformed JSON responses with useful messages", async () : Promise<any> => {
    const { deleteJson, getJson, putBinaryJson } = await loadBridgeHttp();

    fetchMock().mockResolvedValueOnce(jsonResponse({ error: "bad request" }, { status: 400 }));
    await expect(getJson("/api/error")).rejects.toThrow("bad request");

    fetchMock().mockResolvedValueOnce(textResponse("plain failure", { status: 500 }));
    await expect(getJson("/api/plain-error")).rejects.toThrow("plain failure");

    fetchMock().mockResolvedValueOnce(textResponse("", {
      headers: { "content-type": "application/json" },
    }));
    await expect(getJson("/api/empty")).rejects.toThrow("接口没有返回 JSON：/api/empty");

    fetchMock().mockResolvedValueOnce(textResponse("<html>login</html>", {
      headers: { "content-type": "text/html" },
    }));
    await expect(getJson("/api/html")).rejects.toThrow("接口返回了 HTML 而不是 JSON：/api/html");

    fetchMock().mockResolvedValueOnce(textResponse("{not-json", {
      headers: { "content-type": "application/json" },
    }));
    await expect(getJson("/api/broken")).rejects.toThrow("接口返回的 JSON 无法解析：/api/broken");

    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "delete-csrf" }))
      .mockResolvedValueOnce(jsonResponse({ message: "delete blocked" }, { status: 403 }));
    await expect(deleteJson("/api/delete-blocked")).rejects.toThrow("delete blocked");

    fetchMock().mockResolvedValueOnce(textResponse("binary rejected", { status: 415 }));
    await expect(putBinaryJson("/api/upload-bad", new Blob(["bad"]))).rejects.toThrow("binary rejected");
  });
});

describe("bridge-http downloadFile", () : any => {
  it("downloads blobs and derives sanitized filenames from content-disposition", async () : Promise<any> => {
    const { downloadFile } = await loadBridgeHttp();
    fetchMock().mockResolvedValueOnce(new Response("id,name\n1,Ada", {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": "attachment; filename*=UTF-8''report%20one%2Fbad.csv",
      },
    }));

    await expect(downloadFile("/api/export/raw.csv")).resolves.toEqual({
      fileName: "report one_bad.csv",
      contentType: "text/csv",
      byteLength: 13,
    });
    expect(fetchMock()).toHaveBeenCalledWith("/api/export/raw.csv", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "*/*" },
    }));
    expect(triggerBrowserDownloadMock).toHaveBeenCalledOnce();
    const [downloadedBlob, downloadedFileName]: any[] = triggerBrowserDownloadMock.mock.calls[0];
    expect(downloadedFileName).toBe("report one_bad.csv");
    expect(downloadedBlob).toMatchObject({ size: 13, type: "text/csv" });
    await expect(downloadedBlob.text()).resolves.toBe("id,name\n1,Ada");
  });

  it("allows explicit filenames and falls back to URL segments", async () : Promise<any> => {
    const { downloadFile } = await loadBridgeHttp();
    fetchMock()
      .mockResolvedValueOnce(new Response("abc", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }))
      .mockResolvedValueOnce(new Response("xyz", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));

    await expect(downloadFile("/api/files/not-used.bin", { fileName: "bad/name?.txt" })).resolves.toMatchObject({
      fileName: "bad_name_.txt",
      byteLength: 3,
    });
    await expect(downloadFile("/api/files/%E6%8A%A5%E5%91%8A.pdf?download=1")).resolves.toMatchObject({
      fileName: "报告.pdf",
      byteLength: 3,
    });
  });

  it("uses plain content-disposition filenames and tolerates malformed encoded names", async () : Promise<any> => {
    const { downloadFile } = await loadBridgeHttp();
    fetchMock()
      .mockResolvedValueOnce(new Response("plain", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=\"quoted\\\\\\\"bad:name.txt\"",
        },
      }))
      .mockResolvedValueOnce(new Response("encoded", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename*=UTF-8''%E0%A4%A",
        },
      }));

    await expect(downloadFile("/api/files/plain")).resolves.toMatchObject({
      fileName: "quoted_bad_name.txt",
      byteLength: 5,
    });
    await expect(downloadFile("/api/files/encoded")).resolves.toMatchObject({
      fileName: "%E0%A4%A",
      byteLength: 7,
    });
  });

  it("rejects failed and HTML download responses", async () : Promise<any> => {
    const { downloadFile } = await loadBridgeHttp();

    fetchMock().mockResolvedValueOnce(jsonResponse({ message: "not found" }, { status: 404 }));
    await expect(downloadFile("/api/files/missing")).rejects.toThrow("not found");

    fetchMock().mockResolvedValueOnce(textResponse("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    await expect(downloadFile("/api/files/export")).rejects.toThrow("下载接口返回了 HTML 页面");
    expect(triggerBrowserDownloadMock).toHaveBeenCalledTimes(0);
  });
});
