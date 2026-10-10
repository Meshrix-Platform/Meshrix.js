/**
 * Invite-only admission: no open registration exists — a new device enters
 * a route only through a signed invitation ticket minted offline by the
 * operator. Verification is stateless at the worker edge (forgeries die
 * before any Durable Object), and the spend is transaction-bound inside
 * the directory so a ticket can never over-issue beyond its minted uses.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { importInviteSigningKey, issueInviteTicket } from "../src/invite.ts";
import { ADMIN_TOKEN, INVITE_PRIVATE_KEY_PKCS8, RELAY_ORIGIN, ROUTE_1, TENANT_A, WsClient } from "./helpers.ts";

const ORIGINAL_PUBLIC_KEY = env.RELAY_INVITE_PUBLIC_KEY;
let issuerKey: Promise<CryptoKey> | null = null;

function signingKey(): Promise<CryptoKey> {
  issuerKey ??= importInviteSigningKey(INVITE_PRIVATE_KEY_PKCS8);
  return issuerKey;
}

afterEach(() => {
  env.RELAY_INVITE_PUBLIC_KEY = ORIGINAL_PUBLIC_KEY;
});

async function mint(overrides: Record<string, unknown> = {}, key?: CryptoKey): Promise<string> {
  return issueInviteTicket(key ?? await signingKey(), {
    tenantId: TENANT_A,
    routeId: `route.invite.${Math.random().toString(36).slice(2, 8)}`,
    role: "entry",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as never);
}

function redeem(invite: string, deviceId: string, ip = "198.51.100.5"): Promise<Response> {
  return SELF.fetch(`${RELAY_ORIGIN}/invite/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ invite, deviceId }),
  });
}

describe("invite-only join surface", () => {
  it("serves the join page without any registration affordance", async () => {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/join`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("/invite/redeem");
    expect(html).not.toMatch(/sign up|register|create account/iu);
  });

  it("rejects a forged invitation at the edge before object work", async () => {
    const response = await redeem("inv2.Zm9yZ2Vk.forgedforgedforgedforged1", "dev.x.1");
    expect(response.status).toBe(401);
    expect((await response.json() as { error?: string }).error).toBe("invite_invalid");

    // A ticket signed by a DIFFERENT Ed25519 key — real signature, wrong
    // authority — is just as dead. The relay holds a verification key,
    // so minting requires the issuer's private key, not relay access.
    const foreign = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]) as CryptoKeyPair;
    const foreignMint = await mint({}, foreign.privateKey);
    expect((await redeem(foreignMint, "dev.x.1b")).status).toBe(401);
  });

  it("rejects expired invitations", async () => {
    const invite = await mint({ expiresAt: Date.now() - 1000 });
    expect((await redeem(invite, "dev.x.2")).status).toBe(401);
  });

  it("redeems a real invite into a working credential, then spends it", async () => {
    const invite = await mint({ routeId: "route.invite.single" });
    const first = await redeem(invite, "dev.invite.1");
    expect(first.status).toBe(200);
    const body = await first.json() as { credential?: string; tenantId?: string; role?: string };
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.role).toBe("entry");
    expect(body.credential!.split(".")).toHaveLength(2); // ticketed session credential

    // The minted credential actually opens a session — full loop.
    const { status, ws } = await WsClient.tryConnect(TENANT_A, "route.invite.single", body.credential!);
    expect(status).toBe(101);
    ws?.close();

    // Second redemption of the same single-use ticket is refused.
    const replay = await redeem(invite, "dev.invite.other");
    expect(replay.status).toBe(410);
    expect((await replay.json() as { error?: string }).error).toBe("invite_spent");
  });

  it("is single-use by slot semantics: a second device gets 410, same-device retry gets 409", async () => {
    const invite = await mint({ routeId: "route.invite.multi" });
    expect((await redeem(invite, "dev.multi.1")).status).toBe(200);
    expect((await redeem(invite, "dev.multi.1")).status).toBe(409); // already_redeemed
    expect((await redeem(invite, "dev.multi.2")).status).toBe(410); // invite_spent — one slot, one mint
  });

  it("rejects redemption entirely when no verification key is configured", async () => {
    delete env.RELAY_INVITE_PUBLIC_KEY;
    const response = await redeem("inv2.anything.anythinganythinganything1", "dev.x.4");
    expect(response.status).toBe(401);
  });

  it("an invite is not a session credential and a credential is not an invite", async () => {
    const invite = await mint({ routeId: "route.invite.xdom" });
    const { status: wsStatus } = await WsClient.tryConnect(TENANT_A, "route.invite.xdom", invite);
    expect(wsStatus).toBe(401); // session ticket domain rejects it
    const enrolled = await redeem(invite, "dev.xdom.1");
    const credential = (await enrolled.json() as { credential: string }).credential;
    expect((await redeem(credential, "dev.xdom.2")).status).toBe(401); // invite domain rejects it
  });
});
