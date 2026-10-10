/**
 * Session-credential tickets bound unauthenticated cost: a forged upgrade
 * must die at the worker edge (401) before any Durable Object is
 * instantiated, while a real ticketed credential still reaches admission.
 * The per-source failure damper additionally throttles sustained forging.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_TOKEN, enroll, RELAY_ORIGIN, ROUTE_1, TENANT_A, WsClient } from "./helpers.ts";

const ORIGINAL_SECRET = env.RELAY_TICKET_SECRET;

afterEach(() => {
  env.RELAY_TICKET_SECRET = ORIGINAL_SECRET;
});

function forgedUpgrade(ip = "198.51.100.77"): Promise<Response> {
  return SELF.fetch(`${RELAY_ORIGIN}/session/${TENANT_A}/${ROUTE_1}`, {
    headers: { upgrade: "websocket", authorization: "Bearer forged.credential", "cf-connecting-ip": ip },
  });
}

describe("session credential tickets", () => {
  it("issues a ticketed credential (token.tag) when the secret is configured", async () => {
    const enrolled = await enroll(TENANT_A, "dev.ticket.1", ROUTE_1, "entry");
    expect(enrolled.credential.split(".")).toHaveLength(2);
    expect(enrolled.credential.split(".")[1]).toMatch(/^[A-Za-z0-9_-]{24}$/u);
  });

  it("rejects a forged upgrade at the edge before any object work", async () => {
    const { status, ws } = await WsClient.tryConnect(TENANT_A, ROUTE_1, "totally.forged-credential");
    expect(status).toBe(401);
    expect(ws).toBeNull();
  });

  it("rejects an upgrade with no bearer at all", async () => {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/session/${TENANT_A}/${ROUTE_1}`, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("still admits a real ticketed credential end-to-end", async () => {
    const enrolled = await enroll(TENANT_A, "dev.ticket.2", "route.ticket.2", "entry");
    const { status, ws } = await WsClient.tryConnect(TENANT_A, "route.ticket.2", enrolled.credential);
    expect(status).toBe(101);
    ws?.close();
  });

  it("throttles a source after sustained pre-check failures", async () => {
    const ip = "203.0.113.9";
    let last = 0;
    for (let i = 0; i < 40; i += 1) {
      last = (await forgedUpgrade(ip)).status;
    }
    expect(last).toBe(429);
  });

  it("issues and accepts bare tokens when the secret is unset (private shape)", async () => {
    delete env.RELAY_TICKET_SECRET;
    const enrolled = await enroll(TENANT_A, "dev.ticket.3", "route.ticket.3", "entry");
    expect(enrolled.credential.split(".")).not.toHaveLength(2);
    const { status, ws } = await WsClient.tryConnect(TENANT_A, "route.ticket.3", enrolled.credential);
    expect(status).toBe(101);
    ws?.close();
  });
});
