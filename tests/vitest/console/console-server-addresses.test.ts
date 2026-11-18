// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeServerAddressUrl,
  normalizeStoredServerAddresses,
  probeServerAddressUrl,
  uniqueServerAddressStrings,
} from "../../../apps/console/lib/console-server-addresses";
const canned1 = "omit";
const canned2 = "";




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
      credentials: canned1,
    });
  });
});

describe("console server address normalization", () => {
  // Credential-bearing inputs are assembled through the URL API so the suite
  // ships no `user:pass@` literal in the packed artifact sources.
  const withCredentials = (base: string, username = "", password = canned2): string => {
    const url = new URL(base);
    url.username = username;
    url.password = password;
    return url.toString();
  };
  const credentialUrl = (): string =>
    withCredentials("https://server.example/", "operator", "s3cret");

  it("rejects credential-bearing URLs before normalization, probing or persistence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const value of [
      credentialUrl(),
      withCredentials("https://server.example/path?q=1#frag", "operator"),
      withCredentials("http://127.0.0.1:7228", "", "token"),
    ]) {
      expect(normalizeServerAddressUrl(value)).toBe("");
      await expect(probeServerAddressUrl(value)).resolves.toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops credential-bearing URLs instead of persisting the raw string", () => {
    expect(uniqueServerAddressStrings([
      credentialUrl(),
      "https://server.example/",
      "https://server.example/",
      "   ",
    ])).toEqual(["https://server.example"]);
  });

  it("sanitizes previously persisted entries that contain credentials", () => {
    const normalized = normalizeStoredServerAddresses({
      activeUrl: credentialUrl(),
      addresses: [
        credentialUrl(),
        "https://plain.example/",
      ],
    });
    expect(normalized?.activeUrl).toBe("");
    expect(normalized?.addresses).toEqual(["https://plain.example"]);
    expect(JSON.stringify(normalized)).not.toContain("s3cret");
  });
});
