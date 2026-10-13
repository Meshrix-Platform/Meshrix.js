import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AccountEndpointAuthorityClient } from "../../../packages/gateway/src/private-endpoint/account-authority-client.ts";

function client(fetchImpl: typeof fetch): AccountEndpointAuthorityClient {
  const keys = generateKeyPairSync("ed25519");
  return new AccountEndpointAuthorityClient({
    origin: "https://account.example.test",
    tenantId: "tenant.account-client.test",
    routeId: "route.account-client.test",
    deviceId: "device.account-client.test",
    signingKey: keys.privateKey,
    fetch: fetchImpl
  });
}

describe("account authority response bounds", () => {
  it("cancels an oversized streamed body and releases its reader", async () => {
    let cancelled = false;
    let chunks = 0;
    let body: ReadableStream<Uint8Array>;
    body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(65));
      },
      cancel() { cancelled = true; }
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn(async () => response);

    await expect(client(fetchImpl).currentDeviceAuthorization("peer.account-client.test"))
      .rejects.toMatchObject({ code: "account_authority_response_invalid" });
    expect(chunks).toBeLessThan(32);
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("rejects an oversized declared body before reading it", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const response = {
      headers: new Headers({ "content-length": String(1024 * 1024 + 1) }),
      body: { cancel, getReader },
      ok: true
    } as unknown as Response;

    await expect(client(vi.fn(async () => response)).currentDeviceAuthorization("peer.account-client.test"))
      .rejects.toMatchObject({ code: "account_authority_response_invalid" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
  });
});
