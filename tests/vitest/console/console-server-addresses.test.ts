// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeServerAddressUrl,
  normalizeStoredServerAddresses,
  probeServerAddressUrl,
  uniqueServerAddressStrings,
} from "../../../apps/console/lib/console-server-addresses";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("console server address probe", () => {
  it("uses one credentialless bootstrap read without imposing a client deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeServerAddressUrl("https://server.example/path")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://server.example/api/bootstrap", {
      method: "GET",
      headers: { Accept: "application/json" },
      mode: "cors",
      credentials: "omit",
    });
  });
});

describe("console server address normalization", () => {
  it("rejects credential-bearing URLs before normalization, probing or persistence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const value of [
      "https://operator:s3cret@server.example/",
      "https://operator@server.example/path?q=1#frag",
      "http://:token@127.0.0.1:7228",
    ]) {
      expect(normalizeServerAddressUrl(value)).toBe("");
      await expect(probeServerAddressUrl(value)).resolves.toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops credential-bearing URLs instead of persisting the raw string", () => {
    const credentialUrl = "https://operator:s3cret@server.example/";
    expect(uniqueServerAddressStrings([
      credentialUrl,
      "https://server.example/",
      "https://server.example/",
      "   ",
    ])).toEqual(["https://server.example"]);
  });

  it("sanitizes previously persisted entries that contain credentials", () => {
    const normalized = normalizeStoredServerAddresses({
      activeUrl: "https://operator:s3cret@server.example/",
      addresses: [
        "https://operator:s3cret@server.example/",
        "https://plain.example/",
      ],
    });
    expect(normalized?.activeUrl).toBe("");
    expect(normalized?.addresses).toEqual(["https://plain.example"]);
    expect(JSON.stringify(normalized)).not.toContain("s3cret");
  });
});
