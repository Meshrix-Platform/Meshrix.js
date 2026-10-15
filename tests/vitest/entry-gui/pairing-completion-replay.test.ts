import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACCOUNT_API_ROUTES } from "@meshrix/contracts/account";
import {
  encodePairingInvite,
  type CustodyAdapter,
  type PairingCompletionRequest,
  type PairingEndpointPort,
  type PairingCompletionReceipt,
  type PairingInvite
} from "@meshrix/entry";
import {
  EntryProductService,
  type PairingCompletionRelayChannelFactoryInput,
  type PairingRelayChannelFactoryInput
} from "@meshrix/entry-gui";

import { inviteFixture, serviceConfigFixture } from "./helpers.ts";

const ACCOUNT_ORIGIN = "https://account.meshrix.invalid";
const ACCOUNT = { accountId: "account.pair-replay.1", authEpoch: 7 } as const;
const LOGIN_CREDENTIAL = "desktop-session-credential-for-pairing-replay";
const RELAY_ADMISSION = "opaque-entry-relay-admission-for-pairing-replay";
const PERMIT = "-" + "B".repeat(41) + "A";
const dirs: string[] = [];
const services: EntryProductService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

class MemoryOsCustody implements CustodyAdapter {
  readonly kind = "test-os-custody";
  readonly #values = new Map<string, Uint8Array>();
  beforeDelete: ((ref: string) => Promise<void>) | null = null;

  async available(): Promise<boolean> { return true; }
  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    this.#values.set(input.ref, input.secret.slice());
  }
  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    return this.#values.get(input.ref)?.slice() ?? null;
  }
  async deleteSecret(input: { ref: string }): Promise<void> {
    await this.beforeDelete?.(input.ref);
    this.#values.delete(input.ref);
  }
  refs(): readonly string[] { return [...this.#values.keys()]; }
}

class PairingChannel implements PairingEndpointPort {
  readonly beginInputs: Parameters<PairingEndpointPort["beginPairing"]>[0][] = [];
  readonly completions: PairingCompletionRequest[] = [];
  readonly committed = new Map<string, PairingCompletionRequest>();
  readonly endpointPeerIdentities = new Map<string, NonNullable<PairingCompletionReceipt["endpointPeerIdentity"]>>();
  constructor(readonly checkpointBeforeDispatch?: (completion: PairingCompletionRequest) => Promise<void>) {}

  async connect(): Promise<void> {}
  close(): void {}

  async beginPairing(input: Parameters<PairingEndpointPort["beginPairing"]>[0]) {
    this.beginInputs.push(input);
    return {
      outcome: "challenge" as const,
      challengeId: "challenge.pair-replay.1",
      nonce: "nonce.pair-replay.1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: ACCOUNT,
      target: {
        tenantId: input.invite.tenantId,
        routeId: input.invite.endpointRouteId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        grantRef: "grant.pair-replay.1",
        scopes: ["mcp:invoke"]
      }
    };
  }

  async completePairing(input: PairingCompletionRequest): ReturnType<PairingEndpointPort["completePairing"]> {
    await this.checkpointBeforeDispatch?.(input);
    this.completions.push(structuredClone(input));
    this.committed.set(input.operationId, structuredClone(input));
    this.endpointPeerIdentities.set(input.operationId, {
      peerId: `peer:${input.invite.tenantId}:${input.invite.endpointRouteId}:${input.invite.endpointDeviceId}`,
      signalDeviceId: 1,
      registrationId: 1,
      identityKey: Buffer.alloc(33, 1).toString("base64url")
    });
    throw new TypeError("reply lost after endpoint committed the operation");
  }
}

function futureInvite(now: number): PairingInvite {
  return inviteFixture({
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    pairingToken: "pairing-token-sensitive-test-value"
  });
}

describe("pairing completion checkpoint replay", () => {
  it("keeps an unknown completion across cancel and restart, then replays only the exact operation on an expired bootstrap", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-pairing-replay-"));
    dirs.push(dir);
    const custody = new MemoryOsCustody();
    const initialNow = Date.now();
    const invite = futureInvite(initialNow);
    let transactionNumber = 0;
    const transactions = new Map<string, { purpose: string; actionPurpose?: string; target?: unknown }>();
    const creates: Record<string, unknown>[] = [];
    const bootstrapBodies: Record<string, unknown>[] = [];
    const accountFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        creates.push(structuredClone(body));
        const transactionId = `txn.pair-replay.${++transactionNumber}`;
        transactions.set(transactionId, {
          purpose: String(body.purpose),
          actionPurpose: typeof body.actionPurpose === "string" ? body.actionPurpose : undefined,
          target: body.target
        });
        return Response.json({
          transactionId,
          browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=${transactionId}`
        });
      }
      const poll = [...transactions].find(([transactionId]) =>
        url.pathname === ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transactionId)));
      if (poll) {
        const [, transaction] = poll;
        if (transaction.purpose === "login") {
          return Response.json({
            state: "complete",
            purpose: "login",
            account: ACCOUNT,
            deviceSessionCredential: LOGIN_CREDENTIAL,
            permitId: null,
            target: null
          });
        }
        return Response.json({
          state: "complete",
          purpose: "step_up",
          actionPurpose: transaction.actionPurpose,
          account: ACCOUNT,
          deviceSessionCredential: null,
          permitId: PERMIT,
          target: transaction.target
        });
      }
      const acknowledged = [...transactions.keys()].some((transactionId) =>
        url.pathname === ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transactionId)));
      if (acknowledged) return Response.json({ acknowledged: true });
      if (url.pathname === ACCOUNT_API_ROUTES.desktopPairingBootstrap) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bootstrapBodies.push(structuredClone(body));
        return Response.json({
          bootstrapId: "bootstrap.pair-replay.1",
          account: ACCOUNT,
          tenantId: body.tenantId,
          routeId: body.routeId,
          entryDeviceId: body.entryDeviceId,
          endpointDeviceId: invite.endpointDeviceId,
          endpointPinRef: body.endpointPinRef,
          role: "entry",
          mode: invite.mode,
          admissionGeneration: 11,
          revocationRevision: 19,
          relayAdmission: RELAY_ADMISSION,
          expiresAt: new Date(initialNow + 30 * 60_000).toISOString()
        });
      }
      throw new Error(`Unexpected account route ${url.pathname}`);
    };

    const pairing = new PairingChannel(async (completion) => {
      const configText = await readFile(path.join(dir, "entry-gui.config.json"), "utf8");
      const config = JSON.parse(configText) as { pairingCompletionCheckpointRef: string | null };
      expect(config.pairingCompletionCheckpointRef).toMatch(/^entry-gui\.pairing\.completion\.[a-f0-9]{32}$/u);
      const secret = await custody.loadSecret({ ref: config.pairingCompletionCheckpointRef! });
      expect(secret).not.toBeNull();
      expect((JSON.parse(new TextDecoder().decode(secret!)) as { completion: PairingCompletionRequest }).completion)
        .toEqual(completion);
      expect(configText).not.toContain(invite.pairingToken);
      expect(configText).not.toContain(RELAY_ADMISSION);
      expect(configText).not.toContain(PERMIT);
      expect(configText).not.toContain(completion.signature);
    });
    const provisionalInputs: PairingRelayChannelFactoryInput[] = [];
    const first = new EntryProductService({
      dataDir: dir,
      custody,
      serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN),
      accountFetch,
      now: () => initialNow,
      pairingRelayChannelFactory: (input) => {
        provisionalInputs.push(input);
        return pairing;
      }
    });
    services.push(first);
    const emitted: string[] = [];
    first.subscribe((state) => emitted.push(JSON.stringify(state)));
    await first.start();
    await first.submitPairingInvite({ inviteText: encodePairingInvite(invite) });
    await first.continuePairing(); // Complete login; opens the restricted pairing channel.
    expect(first.snapshot().pairing.phase).toBe("challenge_issued");
    await first.confirmPairing(); // Create the exact step-up browser transaction.
    await first.continuePairing(); // Poll factor result; endpoint commits, reply is lost.

    expect(pairing.completions).toHaveLength(1);
    expect(first.snapshot().pairing.phase).toBe("retry_required");
    const completion = pairing.completions[0]!;
    const checkpointRef = JSON.parse(await readFile(path.join(dir, "entry-gui.config.json"), "utf8"))
      .pairingCompletionCheckpointRef as string;
    expect(custody.refs()).toContain(checkpointRef);
    expect(first.cancelPairing().pairing.phase).toBe("retry_required");
    const stillPending = JSON.parse(await readFile(path.join(dir, "entry-gui.config.json"), "utf8"))
      .pairingCompletionCheckpointRef;
    expect(stillPending).toBe(checkpointRef);
    await expect(first.submitPairingInvite({ inviteText: encodePairingInvite(invite) }))
      .rejects.toThrowError(expect.objectContaining({ code: "pairing_state_invalid" }));
    await first.stop();
    services.splice(services.indexOf(first), 1);
    expect(JSON.parse(await readFile(path.join(dir, "entry-gui.config.json"), "utf8"))
      .pairingCompletionCheckpointRef).toBe(checkpointRef);
    expect(custody.refs()).toContain(checkpointRef);

    const resumedNow = initialNow + 2 * 60 * 60_000;
    const replayInputs: PairingCompletionRelayChannelFactoryInput[] = [];
    const second = new EntryProductService({
      dataDir: dir,
      custody,
      serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN),
      accountFetch,
      now: () => resumedNow,
      pairingRelayChannelFactory: () => {
        throw new Error("completion replay must not create a new restricted bootstrap or challenge");
      },
      pairingCompletionRelayChannelFactory: (input) => {
        replayInputs.push(input);
        return {
          async connect() {},
          async replayCompletion(): Promise<PairingCompletionReceipt> {
            expect(pairing.committed.get(input.completion.operationId)).toEqual(completion);
            return {
              outcome: "enrolled",
              capabilityGrantRef: completion.target.grantRef,
              admissionGeneration: 13,
              revocationRevision: 21,
              endpointPeerIdentity: pairing.endpointPeerIdentities.get(input.completion.operationId) ?? null
            };
          },
          close() {}
        };
      }
    });
    services.push(second);
    let connectionWasDurableBeforeCheckpointClear = false;
    custody.beforeDelete = async (ref) => {
      if (ref !== checkpointRef) return;
      const config = JSON.parse(await readFile(path.join(dir, "entry-gui.config.json"), "utf8")) as {
        connections: { pairingCompletionCheckpointRef?: string | null; relayCredentialRef: string }[];
      };
      const savedConnection = config.connections[0];
      expect(savedConnection?.pairingCompletionCheckpointRef).toBe(checkpointRef);
      expect(await custody.loadSecret({ ref: savedConnection!.relayCredentialRef }))
        .toEqual(new TextEncoder().encode(RELAY_ADMISSION));
      connectionWasDurableBeforeCheckpointClear = true;
    };
    const resumed = await second.start();
    expect(resumed.pairing.phase).toBe("retry_required");
    const done = await second.continuePairing();

    expect(done.pairing.phase).toBe("enrolled");
    expect(done.connections).toHaveLength(1);
    expect(replayInputs).toHaveLength(1);
    expect(replayInputs[0]?.completion).toEqual(completion);
    expect(replayInputs[0]?.bootstrap.bootstrapId).toBe(provisionalInputs[0]?.bootstrap.bootstrapId);
    expect(replayInputs[0]?.bootstrap.relayAdmission).toBe(RELAY_ADMISSION);
    expect(Date.parse(replayInputs[0]!.bootstrap.expiresAt)).toBeLessThan(resumedNow);
    expect(bootstrapBodies).toHaveLength(1);
    expect(creates).toHaveLength(2);
    expect(pairing.beginInputs).toHaveLength(1);
    expect(JSON.stringify(done)).not.toContain(invite.pairingToken);
    expect(JSON.stringify(done)).not.toContain(RELAY_ADMISSION);
    expect(emitted.every((state) => !state.includes(invite.pairingToken) && !state.includes(PERMIT))).toBe(true);

    const finalConfigText = await readFile(path.join(dir, "entry-gui.config.json"), "utf8");
    const finalConfig = JSON.parse(finalConfigText) as {
      pairingCompletionCheckpointRef: string | null;
      connections: { pairingCompletionCheckpointRef?: string | null; relayCredentialRef: string }[];
    };
    expect(finalConfig.pairingCompletionCheckpointRef).toBeNull();
    expect(finalConfig.connections[0]?.pairingCompletionCheckpointRef).toBeNull();
    expect(finalConfigText).not.toContain(invite.pairingToken);
    expect(finalConfigText).not.toContain(RELAY_ADMISSION);
    expect(finalConfigText).not.toContain(PERMIT);
    expect(custody.refs()).not.toContain(checkpointRef);
    expect(connectionWasDurableBeforeCheckpointClear).toBe(true);
    expect(await custody.loadSecret({ ref: finalConfig.connections[0]!.relayCredentialRef })).toEqual(new TextEncoder().encode(RELAY_ADMISSION));
  });
});
