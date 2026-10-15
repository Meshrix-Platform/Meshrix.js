// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { probeServerAddressUrl } from "../../../apps/console/lib/console-server-addresses";

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
