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
      },
    });
    expect(fetchMock().mock.calls[1][1].headers["x-meshrix-csrf"]).toBeUndefined();

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

  it("uses status-only errors and keeps malformed response details out of client errors", async () : Promise<any> => {
    const { deleteJson, getJson, putBinaryJson } = await loadBridgeHttp();

    fetchMock().mockResolvedValueOnce(jsonResponse({ error: "bad request" }, { status: 400 }));
    await expect(getJson("/api/error")).rejects.toThrow("Request failed: 400");

    fetchMock().mockResolvedValueOnce(textResponse("plain failure", { status: 500 }));
    await expect(getJson("/api/plain-error")).rejects.toThrow("Request failed: 500");

    fetchMock().mockResolvedValueOnce(jsonResponse({ error: "Authentication required." }, { status: 401 }));
    await expect(getJson("/api/plugin-bridge")).rejects.toThrow("Request failed: 401");

    fetchMock().mockResolvedValueOnce(jsonResponse({ error: "provider-private-response" }, { status: 502 }));
    const providerError: any = await getJson("/api/upstream").catch((error?: any) : any => error);
    expect(providerError.message).toBe("Request failed: 502");
    expect(providerError.message).not.toContain("provider-private-response");

    fetchMock().mockResolvedValueOnce(textResponse("{malformed", {
      status: 502,
      headers: { "content-type": "application/json" },
    }));
    await expect(getJson("/api/malformed-error")).rejects.toThrow("Request failed: 502");

    let bodyCancelled = false;
    let bodyRead = false;
    const unusedErrorBody = new ReadableStream<Uint8Array>({
      pull() : void {
        bodyRead = true;
      },
      cancel() : void {
        bodyCancelled = true;
      },
    }, { highWaterMark: 0 });
    fetchMock().mockResolvedValueOnce(new Response(unusedErrorBody, {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    await expect(getJson("/api/unused-error-body")).rejects.toThrow("Request failed: 500");
    expect(bodyCancelled).toBe(true);
    expect(bodyRead).toBe(false);

    fetchMock().mockResolvedValueOnce(textResponse("", {
      headers: { "content-type": "application/json" },
    }));
    await expect(getJson("/api/private/path?token=secret")).rejects.toThrow("接口没有返回 JSON。");

    fetchMock().mockResolvedValueOnce(textResponse("<html>account-secret</html>", {
      headers: { "content-type": "text/html" },
    }));
    await expect(getJson("/api/html")).rejects.toThrow("接口返回了 HTML 页面");

    fetchMock().mockResolvedValueOnce(textResponse('{"credential":"secret"', {
      headers: { "content-type": "application/json" },
    }));
    const malformedError: any = await getJson("/api/broken").catch((error?: any) : any => error);
    expect(malformedError.message).toBe("接口返回的 JSON 无法解析。");
    expect(malformedError.message).not.toContain("secret");

    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "delete-csrf" }))
      .mockResolvedValueOnce(jsonResponse({ message: "delete blocked" }, { status: 403 }));
    await expect(deleteJson("/api/delete-blocked")).rejects.toThrow("Request failed: 403");

    fetchMock().mockResolvedValueOnce(textResponse("binary rejected", { status: 415 }));
    await expect(putBinaryJson("/api/upload-bad", new Blob(["bad"]))).rejects.toThrow("Request failed: 415");
  });
});

describe("bridge-http downloadFile", () : any => {
  it("does not send a cached CSRF token on a read-only download", async () : Promise<any> => {
    const { downloadFile, getJson } = await loadBridgeHttp();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "private-token" }))
      .mockResolvedValueOnce(new Response("file", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));

    await getJson("/api/auth/session");
    await downloadFile("/api/files/export");

    expect(fetchMock().mock.calls[1][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "*/*" },
    });
    expect(fetchMock().mock.calls[1][1].headers["x-meshrix-csrf"]).toBeUndefined();
  });

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
    await expect(downloadFile("/api/files/missing")).rejects.toThrow("下载失败：404");

    fetchMock().mockResolvedValueOnce(textResponse("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    await expect(downloadFile("/api/files/export")).rejects.toThrow("下载接口返回了 HTML 页面");
    expect(triggerBrowserDownloadMock).toHaveBeenCalledTimes(0);
  });
});
