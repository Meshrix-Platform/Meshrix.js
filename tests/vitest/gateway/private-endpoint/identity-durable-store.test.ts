import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileEndpointIdentityDurablePort, EndpointIdentityStore } from "../../../../packages/gateway/src/private-endpoint/index.ts";

describe("endpoint pairing identity persistence", () => {
  it("retains the exact authenticated Signal descriptor and rejects a descriptor for another route device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-endpoint-identity-"));
    try {
      const path = join(directory, "identity.json");
      const account = { accountId: "account.identity.test", authEpoch: 1 };
      const tenantId = "tenant.identity.test";
      const routeId = "route.identity.test";
      const deviceId = "device.entry.identity.test";
      const peerId = `peer:${tenantId}:${routeId}:${deviceId}`;
      const target = {
        tenantId, routeId, deviceId,
        devicePublicKey: Buffer.alloc(32, 7).toString("base64url"),
        grantRef: "grant.identity.test",
        scopes: ["agent.read"],
      };
      const entryPeerIdentity = {
        peerId, signalDeviceId: 1, registrationId: 23,
        identityKey: Buffer.alloc(33, 9).toString("base64url"),
      };
      const identity = new EndpointIdentityStore(createFileEndpointIdentityDurablePort(path));
      identity.enrollAccountDevice({ account, target, mode: "personal", entryPeerIdentity });
      const permitIds = ["_" + "B".repeat(41) + "A", "-" + "B".repeat(41) + "A"];
      permitIds.forEach((permitId, index) => identity.savePairingOperation({
        bootstrapId: `bootstrap.permit.${index}`,
        entrySessionId: `entry.session.permit.${index}`,
        inviteId: `invite.permit.${index}`,
        challengeId: `challenge.permit.${index}`,
        nonce: `nonce.permit.${index}`,
        account,
        target,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        operationId: `operation.permit.${index}`,
        permitId,
        state: "enrolled"
      }));

      const restored = new EndpointIdentityStore(createFileEndpointIdentityDurablePort(path));
      expect(restored.device(deviceId)?.entryPeerIdentity).toEqual(entryPeerIdentity);
      expect(restored.pairingOperation("bootstrap.permit.0")?.permitId).toBe(permitIds[0]);
      expect(restored.pairingOperation("bootstrap.permit.1")?.permitId).toBe(permitIds[1]);
      expect(() => restored.enrollAccountDevice({
        account,
        target: { ...target, grantRef: "grant.identity.other" },
        mode: "personal",
        entryPeerIdentity: { ...entryPeerIdentity, peerId: "peer:other:route:device" },
      })).toThrow(expect.objectContaining({ code: "account_peer_identity_invalid" }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
