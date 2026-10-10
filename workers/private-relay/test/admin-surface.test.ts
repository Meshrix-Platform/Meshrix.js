/**
 * `/admin/*` control-plane exposure is a deployment choice — closed unless
 * the deployment explicitly opens it. `off` (unset/unknown) returns 404 so
 * a public route carries no admin surface at all; `local` is the private
 * bearer-gated shape (the committed [vars] default these tests run under);
 * `access` additionally demands a verified Access JWT (RS256 signature
 * against the team JWKS, matching issuer/audience, unexpired) — header
 * presence alone is forgeable and gets 404 like everything else.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_TOKEN, RELAY_ORIGIN, TENANT_A } from "./helpers.ts";

const ORIGINAL_SURFACE = env.RELAY_ADMIN_SURFACE;

afterEach(() => {
  env.RELAY_ADMIN_SURFACE = ORIGINAL_SURFACE;
});

function adminRequest(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${RELAY_ORIGIN}/admin/tenants/${TENANT_A}/directory`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...headers },
  });
}

describe("admin control-plane surface gating", () => {
  it("off mode answers 404 even with a valid bearer — the surface does not exist", async () => {
    env.RELAY_ADMIN_SURFACE = "off";
    const response = await adminRequest();
    expect(response.status).toBe(404);
    expect((await response.json() as { error?: string }).error).toBe("not_found");
  });

  it("unset is fail-closed: removing the var also answers 404", async () => {
    delete env.RELAY_ADMIN_SURFACE;
    const response = await adminRequest();
    expect(response.status).toBe(404);
  });

  it("unknown values are fail-closed too", async () => {
    env.RELAY_ADMIN_SURFACE = "public";
    const response = await adminRequest();
    expect(response.status).toBe(404);
  });

  it("local mode keeps the bearer-gated surface for private deployments", async () => {
    env.RELAY_ADMIN_SURFACE = "local";
    const response = await adminRequest();
    expect(response.status).toBe(200);
    const unauthorized = await SELF.fetch(`${RELAY_ORIGIN}/admin/tenants/${TENANT_A}/directory`);
    expect(unauthorized.status).toBe(401);
  });

  it("access mode hides the surface without the Access JWT header (workers.dev bypass)", async () => {
    env.RELAY_ADMIN_SURFACE = "access";
    const direct = await adminRequest();
    expect(direct.status).toBe(404);
  });

  it("access mode verifies the JWT itself: self-attached headers get 404, never the bearer check", async () => {
    // The audit finding: header *presence* is forgeable on routes that
    // never traverse an Access policy. Verification now requires a real
    // RS256 signature + issuer + audience — a self-attached garbage header
    // dies at the JWT check before the bearer is ever consulted.
    env.RELAY_ADMIN_SURFACE = "access";
    const headerOnly = await SELF.fetch(`${RELAY_ORIGIN}/admin/tenants/${TENANT_A}/directory`, {
      headers: { "cf-access-jwt-assertion": "edge-verified-jwt" },
    });
    expect(headerOnly.status).toBe(404);
    const gated = await adminRequest({ "cf-access-jwt-assertion": "edge-verified-jwt" });
    expect(gated.status).toBe(404);
  });

  it("the gate does not affect liveness or the session data plane", async () => {
    env.RELAY_ADMIN_SURFACE = "off";
    const healthz = await SELF.fetch(`${RELAY_ORIGIN}/healthz`);
    expect(healthz.status).toBe(200);
    const sessionProbe = await SELF.fetch(`${RELAY_ORIGIN}/session/${TENANT_A}/route.x`, {
      headers: { upgrade: "websocket" },
    });
    expect(sessionProbe.status).not.toBe(404);
  });
});
