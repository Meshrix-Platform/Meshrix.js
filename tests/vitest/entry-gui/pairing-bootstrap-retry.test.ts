import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACCOUNT_API_ROUTES } from "@meshrix/contracts/account";
import { encodePairingInvite, type CustodyAdapter, type PairingEndpointPort } from "@meshrix/entry";
import { EntryProductService, type PairingRelayChannelFactoryInput } from "@meshrix/entry-gui";

import { inviteFixture, serviceConfigFixture } from "./helpers.ts";

const ACCOUNT_ORIGIN = "https://account.meshrix.invalid";
const ACCOUNT = { accountId: "account.retry.1", authEpoch: 4 } as const;
const dirs: string[] = [];
const services: EntryProductService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

class MemoryOsCustody implements CustodyAdapter {
  readonly kind = "test-os-custody";
  readonly #values = new Map<string, Uint8Array>();

  async available(): Promise<boolean> { return true; }
  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    this.#values.set(input.ref, input.secret.slice());
  }
  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    return this.#values.get(input.ref)?.slice() ?? null;
  }
  async deleteSecret(input: { ref: string }): Promise<void> { this.#values.delete(input.ref); }
}

class PairingChannel implements PairingEndpointPort {
  connected = false;
  closed = false;
  readonly beginInputs: Parameters<PairingEndpointPort["beginPairing"]>[0][] = [];

  async connect(): Promise<void> { this.connected = true; }
  close(): void { this.closed = true; }

  async beginPairing(input: Parameters<PairingEndpointPort["beginPairing"]>[0]) {
    this.beginInputs.push(input);
    return {
      outcome: "challenge" as const,
      challengeId: "challenge.retry.1",
      nonce: "nonce.retry.1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: ACCOUNT,
      target: {
        tenantId: input.invite.tenantId,
        routeId: input.invite.endpointRouteId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        grantRef: "grant.pending.retry.1",
        scopes: ["mcp:invoke"]
      }
    };
  }

  async completePairing(): ReturnType<PairingEndpointPort["completePairing"]> {
    return { outcome: "refused", refusal: "unused in retry test" };
  }
}

describe("restricted pairing bootstrap retry", () => {
  it("rejects unavailable team invites before browser login, bootstrap or relay admission", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-team-unavailable-"));
    dirs.push(dir);
    let accountCalls = 0;
    let channelCalls = 0;
    const service = new EntryProductService({ dataDir: dir, custody: new MemoryOsCustody(),
      serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN),
      accountFetch: async () => { accountCalls += 1; throw new Error("unexpected synthetic account call"); },
      pairingRelayChannelFactory: () => { channelCalls += 1; return new PairingChannel(); } });
    services.push(service);
    await service.start();
    await expect(service.submitPairingInvite({ inviteText: encodePairingInvite({ ...inviteFixture(), mode: "enterprise" }) }))
      .rejects.toThrowError(expect.objectContaining({ code: "team_not_available" }));
    expect(accountCalls).toBe(0);
    expect(channelCalls).toBe(0);
  });

  it("reuses the exact signed bootstrap and fresh device identity after the first response is lost", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-bootstrap-retry-"));
    dirs.push(dir);
    let transactionId = "";
    const bootstrapBodies: Record<string, unknown>[] = [];
    let loseFirstBootstrapResponse = true;
    const fetchAccount: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
        transactionId = "txn.retry.login";
        return Response.json({
          transactionId,
          browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=${transactionId}`
        });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transactionId))) {
        return Response.json({
          state: "complete",
          purpose: "login",
          account: ACCOUNT,
          deviceSessionCredential: "desktop-session-credential-for-retry-test",
          permitId: null,
          target: null
        });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transactionId))) {
        return Response.json({ acknowledged: true });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopPairingBootstrap) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bootstrapBodies.push(body);
        if (loseFirstBootstrapResponse) {
          loseFirstBootstrapResponse = false;
          // The authority committed the request, but the response was lost.
          throw new TypeError("socket closed after server commit");
        }
        return Response.json({
          bootstrapId: "bootstrap.retry.1",
          account: ACCOUNT,
          tenantId: body.tenantId,
          routeId: body.routeId,
          entryDeviceId: body.entryDeviceId,
          endpointDeviceId: "dev.endpoint.gui.1",
          endpointPinRef: body.endpointPinRef,
          role: "entry",
          mode: body.mode,
          admissionGeneration: 8,
          revocationRevision: 3,
          relayAdmission: "opaque-pair-device-relay-admission-retry",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      }
      throw new Error(`Unexpected account route ${url.pathname}`);
    };

    const channelOptions: PairingRelayChannelFactoryInput[] = [];
    const channels: PairingChannel[] = [];
    const service = new EntryProductService({
      dataDir: dir,
      custody: new MemoryOsCustody(),
      serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN),
      accountFetch: fetchAccount,
      pairingRelayChannelFactory: (options) => {
        channelOptions.push(options);
        const channel = new PairingChannel();
        channels.push(channel);
        return channel;
      }
    });
    services.push(service);
    await service.start();
    await service.submitPairingInvite({ inviteText: encodePairingInvite(inviteFixture()) });

    await expect(service.continuePairing()).rejects.toThrowError(
      expect.objectContaining({ code: "account_service_unreachable" })
    );
    expect(service.snapshot().account.state).toBe("authenticated");
    expect(bootstrapBodies).toHaveLength(1);
    expect(channelOptions).toHaveLength(0);

    const firstSignedRequest = bootstrapBodies[0];
    await service.continuePairing();

    expect(bootstrapBodies).toHaveLength(2);
    expect(bootstrapBodies[1]).toEqual(firstSignedRequest);
    expect(channelOptions).toHaveLength(1);
    expect(channelOptions[0]?.bootstrap.entryDeviceId).toBe(firstSignedRequest?.entryDeviceId);
    expect(channels[0]?.beginInputs[0]?.deviceId).toBe(firstSignedRequest?.entryDeviceId);
    expect(channels[0]?.beginInputs[0]?.devicePublicKey).toBe(firstSignedRequest?.entryDevicePublicKey);
    expect(service.snapshot().pairing.phase).toBe("challenge_issued");
    expect(channels[0]?.connected).toBe(true);
  });
});
