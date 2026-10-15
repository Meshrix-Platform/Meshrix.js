import { describe, expect, it } from "vitest";

import { parsePairingInvite } from "@meshrix/entry";
import {
  EntryPairingCompletionRelayChannel,
  EntryPairingRelayChannel,
  type PairingRelayBootstrap
} from "@meshrix/entry-transport";

const INVITE = parsePairingInvite({
  schemaVersion: "v0.0.1:entry:pairing-invite-2",
  kind: "entry-pairing-invite",
  inviteId: "invite.test.1",
  endpointRouteId: "route.test.1",
  tenantId: "tenant.test.1",
  mode: "personal",
  endpointDeviceId: "device.endpoint.1",
  endpointPrincipalRef: "principal.endpoint.1",
  endpointSpkiPin: "spki.endpoint.pin",
  endpointPinRef: "spki.endpoint.pin",
  relayService: "https://relay.meshrix.invalid",
  vaultId: "vault.test.1",
  recoveryAuthority: null,
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  pairingToken: "invite.token.never-in-url"
})!;

const BOOTSTRAP: PairingRelayBootstrap = {
  bootstrapId: "bootstrap.test.1",
  relayAdmission: "relay.admission.opaque.token.value",
  account: { accountId: "account.test.1", authEpoch: 2 },
  tenantId: "tenant.test.1",
  routeId: "route.test.1",
  endpointDeviceId: "device.endpoint.1",
  endpointPinRef: "spki.endpoint.pin",
  entryDeviceId: "device.entry.1",
  role: "entry",
  mode: "personal",
  admissionGeneration: 3,
  revocationRevision: 4,
  expiresAt: "2099-01-01T00:00:00.000Z"
};

describe("restricted pairing relay channel", () => {
  it("keeps the relay bearer in the WSS authorization header and pins the invite endpoint", () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const channel = new EntryPairingRelayChannel({
      relaySessionUrl: "wss://relay.meshrix.invalid/session/tenant.test.1/route.test.1",
      bootstrap: BOOTSTRAP,
      invite: INVITE,
      innerTls: { key: "private-key-pem", cert: "client-cert-pem", pinnedPeerSpki: [INVITE.endpointPinRef] },
      transportFactory: (input) => {
        captured = input;
        return { send: () => undefined, close: () => undefined };
      }
    });
    channel.close();

    expect(captured?.url).toContain("/session/tenant.test.1/route.test.1");
    expect(captured?.url).not.toContain(BOOTSTRAP.relayAdmission);
    expect(captured?.url).not.toContain(INVITE.pairingToken);
    expect(captured?.headers.authorization).toBe(`Bearer ${BOOTSTRAP.relayAdmission}`);
  });

  it("allows only exact completion replay on a fresh forward session after bootstrap expiry", () => {
    const completion = {
      invite: INVITE,
      challengeId: "challenge.saved.1",
      deviceId: BOOTSTRAP.entryDeviceId,
      devicePublicKey: "A".repeat(43),
      signature: "A".repeat(86),
      account: BOOTSTRAP.account,
      permitId: "_" + "E".repeat(41) + "A",
      purpose: "pair_device" as const,
      target: {
        tenantId: INVITE.tenantId,
        routeId: INVITE.endpointRouteId,
        deviceId: BOOTSTRAP.entryDeviceId,
        devicePublicKey: "A".repeat(43),
        grantRef: "grant.saved.1",
        scopes: ["mcp:invoke"]
      },
      entryPeerIdentity: null,
      operationId: "operation.saved.1"
    };
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const expiredBootstrap = { ...BOOTSTRAP, expiresAt: "2020-01-01T00:00:00.000Z" };
    const channel = new EntryPairingCompletionRelayChannel({
      relaySessionUrl: "wss://relay.meshrix.invalid/session/tenant.test.1/route.test.1",
      bootstrap: expiredBootstrap,
      completion,
      innerTls: { key: "private-key-pem", cert: "client-cert-pem", pinnedPeerSpki: [INVITE.endpointPinRef] },
      transportFactory: (input) => {
        captured = input;
        return { send: () => undefined, close: () => undefined };
      }
    });
    channel.close();

    expect(captured?.url).toContain("/session/tenant.test.1/route.test.1");
    expect(captured?.url).not.toContain(BOOTSTRAP.relayAdmission);
    expect(captured?.url).not.toContain(INVITE.pairingToken);
    expect(captured?.headers.authorization).toBe(`Bearer ${BOOTSTRAP.relayAdmission}`);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(channel))).toEqual(
      expect.arrayContaining(["connect", "replayCompletion", "close"])
    );
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(channel))).not.toContain("beginPairing");
  });

  it("rejects a bootstrap pinned to another endpoint before opening transport", () => {
    let opened = false;
    expect(() => new EntryPairingRelayChannel({
      relaySessionUrl: "wss://relay.meshrix.invalid/session/tenant.test.1/route.test.1",
      bootstrap: { ...BOOTSTRAP, endpointDeviceId: "device.other.1" },
      invite: INVITE,
      innerTls: { key: "private-key-pem", cert: "client-cert-pem", pinnedPeerSpki: [INVITE.endpointPinRef] },
      transportFactory: () => {
        opened = true;
        return { send: () => undefined, close: () => undefined };
      }
    })).toThrowError(expect.objectContaining({ code: "account_bootstrap_invalid" }));
    expect(opened).toBe(false);
  });
});
