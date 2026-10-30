import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountDeviceAuthorizationClient } from "../../../../packages/gateway/src/private-endpoint/account-authority-client.ts";
import type { AccountActionTarget } from "@meshrix/contracts/account";
const canned1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const canned2 = "unit-test-fresh-nonce";
const canned3 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";




const binding = { accountId: "account.unit.test", authEpoch: 4 };
const target: AccountActionTarget = {
  tenantId: "personal:account.unit.test",
  routeId: "route.unit.test",
  deviceId: "entry.unit.test",
  devicePublicKey: canned1,
  grantRef: "grant.unit.test",
  scopes: ["peer:message"],
};

const cannedFresh = "unit-test-fresh-nonce";

function client(fetcher: typeof fetch) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new AccountDeviceAuthorizationClient({
    origin: "https://account.example.test",
    tenantId: target.tenantId,
    routeId: target.routeId,
    deviceId: "endpoint.unit.test",
    signingKey: privateKey,
    fetch: fetcher,
    nonceFactory: () => cannedFresh,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("account device authorization client", () => {
  it("accepts only the exact active account, route target, and peer-message scope", async () => {
    const current = client(async (input, init) => {
      expect(String(input)).toBe("https://account.example.test/api/account/device/current-binding");
      const request = JSON.parse(String(init?.body)) as { peerDeviceId: string; proof: Record<string, unknown> };
      expect(request.peerDeviceId).toBe(target.deviceId);
      expect(request.proof).toMatchObject({
        tenantId: target.tenantId,
        routeId: target.routeId,
        deviceId: "endpoint.unit.test",
        purpose: "current_binding",
        peerDeviceId: target.deviceId,
        nonce: canned2,
      });
      return jsonResponse({ account: binding, target, authorizedScopes: ["peer:message"] });
    });
    await expect(current.check({
      peerDeviceId: target.deviceId,
      binding,
      authorizedTargets: [target],
      scope: "peer:message",
    })).resolves.toMatchObject({ state: "current", response: { account: binding, target } });

    const changedTargetClient = client(async () => jsonResponse({
      account: binding,
      target: { ...target, devicePublicKey: canned3 },
      authorizedScopes: ["peer:message"],
    }));
    await expect(changedTargetClient.check({ peerDeviceId: target.deviceId, binding, authorizedTargets: [target] }))
      .resolves.toEqual({ state: "revoked" });

    const excessScopeClient = client(async () => jsonResponse({
      account: binding,
      target,
      authorizedScopes: ["peer:message", "peer:admin"],
    }));
    await expect(excessScopeClient.check({ peerDeviceId: target.deviceId, binding, authorizedTargets: [target] }))
      .resolves.toEqual({ state: "revoked" });
  });

  it("preserves authority outcomes so temporary failures defer and revoked grants fail closed", async () => {
    const cases: Array<{ status: number; body: unknown; expected: string }> = [
      { status: 404, body: { error: { code: "not_found" } }, expected: "revoked" },
      { status: 403, body: { error: { code: "forbidden" } }, expected: "denied" },
      { status: 503, body: { error: { code: "temporarily_unavailable" } }, expected: "unavailable" },
    ];
    for (const sample of cases) {
      const authority = client(async () => jsonResponse(sample.body, sample.status));
      await expect(authority.check({ peerDeviceId: target.deviceId, binding, authorizedTargets: [target] }))
        .resolves.toEqual({ state: sample.expected });
    }

    const outage = client(async () => { throw new TypeError("network unavailable"); });
    await expect(outage.check({ peerDeviceId: target.deviceId, binding, authorizedTargets: [target] }))
      .resolves.toEqual({ state: "unavailable" });

    const malformed = client(async () => new Response("not-json", { status: 200 }));
    await expect(malformed.check({ peerDeviceId: target.deviceId, binding, authorizedTargets: [target] }))
      .resolves.toEqual({ state: "unavailable" });
  });
});
