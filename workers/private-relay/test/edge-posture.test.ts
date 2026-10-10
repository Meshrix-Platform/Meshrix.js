/**
 * Public edge posture after the external audit: HTTPS enforcement, uniform
 * security headers, vault pre-instantiation gates (declared length +
 * per-source bound), the vault existence oracle closed by response
 * normalization, and real Cloudflare Access JWT verification for the
 * `"access"` admin surface.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { verifyAccessJwt } from "../src/access.ts";
import { bytesToBase64Url, utf8Bytes } from "../src/ids.ts";
import {
  ADMIN_TOKEN,
  generateVaultKeys,
  provisionVault,
  RELAY_ORIGIN,
  TENANT_A,
  VAULT_1,
  vaultFetchMessage,
} from "./helpers.ts";

const ORIGINAL = {
  surface: env.RELAY_ADMIN_SURFACE,
  team: env.RELAY_ACCESS_TEAM,
  aud: env.RELAY_ACCESS_AUD,
};

afterEach(() => {
  env.RELAY_ADMIN_SURFACE = ORIGINAL.surface;
  env.RELAY_ACCESS_TEAM = ORIGINAL.team;
  env.RELAY_ACCESS_AUD = ORIGINAL.aud;
});

describe("transport enforcement and response hardening", () => {
  it("redirects plaintext edge hits to https before routing", async () => {
    const response = await SELF.fetch("http://relay.meshrix.io/healthz", {
      headers: { "cf-visitor": '{"scheme":"http"}' },
      redirect: "manual",
    });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://relay.meshrix.io/healthz");
  });

  it("answers https edge hits normally and stamps security headers", async () => {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/healthz`, {
      headers: { "cf-visitor": '{"scheme":"https"}' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("vault pre-instantiation gates", () => {
  it("requires a declared Content-Length before paying an instantiation", async () => {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/vault/vault.nolength.1`, {
      method: "POST",
    });
    expect(response.status).toBe(411);
    expect((await response.json() as { error?: string }).error).toBe("length_required");
  });

  it("refuses a declared oversized body at the edge", async () => {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/vault/vault.oversized.1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_700_000), // > RELAY_MAX_VAULT_MESSAGE_BYTES (1 572 864)
    });
    expect(response.status).toBe(413);
    expect((await response.json() as { error?: string }).error).toBe("request_too_large");
  });

  it("closes the existence oracle: unknown vault and bad proof are indistinguishable", async () => {
    const recovery = await generateVaultKeys("rckey.oracle.1");
    const recovery2 = await generateVaultKeys("rckey.oracle.2");
    // Provision VAULT_1 so one probe hits a live vault and one hits nothing.
    await provisionVault(VAULT_1, [], {
      keyId: recovery2.keyId, algorithm: recovery2.algorithm, publicKey: recovery2.publicKey,
    });

    const unknown = await SELF.fetch(`${RELAY_ORIGIN}/vault/vault.unknown.oracle`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.201" },
      body: JSON.stringify(await vaultFetchMessage("vault.unknown.oracle", recovery)),
    });
    const badProof = await SELF.fetch(`${RELAY_ORIGIN}/vault/${VAULT_1}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.202" },
      body: JSON.stringify(await vaultFetchMessage(VAULT_1, recovery)),
    });
    expect(unknown.status).toBe(403);
    expect(badProof.status).toBe(403);
    expect(await unknown.json()).toEqual(await badProof.json());
  });

  it("bounds same-source attempts before object instantiation", async () => {
    const ip = "192.0.2.99";
    let last = 0;
    for (let i = 0; i < 35; i += 1) {
      const response = await SELF.fetch(`${RELAY_ORIGIN}/vault/vault.flood.${i}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ kind: "definitely-not-a-vault-message" }),
      });
      last = response.status;
      await response.arrayBuffer();
    }
    expect(last).toBe(429);
  });
});

describe("Access JWT verification", () => {
  const TEAM = "audit-team";
  const AUD = "audit-aud-tag";

  async function rsaKeys(): Promise<CryptoKeyPair> {
    return await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
  }

  async function signedJwt(
    keys: CryptoKeyPair,
    payload: Record<string, unknown>,
    header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" },
  ): Promise<string> {
    const segment = (value: unknown) => bytesToBase64Url(utf8Bytes(JSON.stringify(value)));
    const signedContent = `${segment(header)}.${segment(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      keys.privateKey,
      utf8Bytes(signedContent) as BufferSource,
    );
    return `${signedContent}.${bytesToBase64Url(new Uint8Array(signature))}`;
  }

  async function jwksFetcher(keys: CryptoKeyPair): Promise<(input: string) => Promise<Response>> {
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey & { kid?: string };
    jwk.kid = "k1";
    jwk.alg = "RS256";
    jwk.use = "sig";
    return () => Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    }));
  }

  function jwtRequest(assertion: string): Request {
    return new Request("https://relay.meshrix.io/admin/tenants/t/directory", {
      headers: { "cf-access-jwt-assertion": assertion },
    });
  }

  it("verifies a properly signed, in-window, matching-audience assertion", async () => {
    const keys = await rsaKeys();
    const assertion = await signedJwt(keys, {
      aud: AUD,
      iss: `https://${TEAM}.cloudflareaccess.com`,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    env.RELAY_ACCESS_TEAM = TEAM;
    env.RELAY_ACCESS_AUD = AUD;
    expect(await verifyAccessJwt(env, jwtRequest(assertion), await jwksFetcher(keys))).toBe(true);
  });

  it("refuses header-presence-only, wrong audience, expired and forged assertions", async () => {
    env.RELAY_ACCESS_TEAM = TEAM;
    env.RELAY_ACCESS_AUD = AUD;
    const keys = await rsaKeys();
    const fetcher = await jwksFetcher(keys);
    const validPayload = {
      aud: AUD,
      iss: `https://${TEAM}.cloudflareaccess.com`,
      exp: Math.floor(Date.now() / 1000) + 300,
    };

    // Presence alone must never pass (the audit finding this fixes).
    expect(await verifyAccessJwt(env, jwtRequest("edge-verified-jwt"), fetcher)).toBe(false);
    // Wrong audience.
    expect(await verifyAccessJwt(
      env,
      jwtRequest(await signedJwt(keys, { ...validPayload, aud: "other-app" })),
      fetcher,
    )).toBe(false);
    // Expired.
    expect(await verifyAccessJwt(
      env,
      jwtRequest(await signedJwt(keys, { ...validPayload, exp: Math.floor(Date.now() / 1000) - 60 })),
      fetcher,
    )).toBe(false);
    // Wrong issuer.
    expect(await verifyAccessJwt(
      env,
      jwtRequest(await signedJwt(keys, { ...validPayload, iss: "https://evil.example" })),
      fetcher,
    )).toBe(false);
    // A signature from a different key.
    const foreign = await rsaKeys();
    expect(await verifyAccessJwt(
      env,
      jwtRequest(await signedJwt(foreign, validPayload)),
      fetcher,
    )).toBe(false);
  });

  it("fails closed when Access configuration is absent", async () => {
    delete env.RELAY_ACCESS_TEAM;
    delete env.RELAY_ACCESS_AUD;
    const keys = await rsaKeys();
    const assertion = await signedJwt(keys, {
      aud: AUD,
      iss: `https://${TEAM}.cloudflareaccess.com`,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(await verifyAccessJwt(env, jwtRequest(assertion), await jwksFetcher(keys))).toBe(false);
  });

  it("access-mode admin stays closed to self-attached headers end-to-end", async () => {
    env.RELAY_ADMIN_SURFACE = "access";
    env.RELAY_ACCESS_TEAM = TEAM;
    env.RELAY_ACCESS_AUD = AUD;
    const response = await SELF.fetch(`${RELAY_ORIGIN}/admin/tenants/${TENANT_A}/directory`, {
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "cf-access-jwt-assertion": "edge-verified-jwt",
      },
    });
    expect(response.status).toBe(404);
  });
});
