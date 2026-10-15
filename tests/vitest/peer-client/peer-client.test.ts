import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPeerDeliveryAck,
  createPeerSend,
  parsePeerSend,
  peerDeliveryAckSigningInputForSend,
  peerDeliveryAckTranscript,
  peerIdForRouteDevice,
  PRIVATE_RELAY_PEER_LIMITS
} from "@meshrix/contracts/private-relay";
import {
  base64urlDecode,
  base64urlEncode,
  createInMemoryPeerCryptoStore,
  createPeerIdentity,
  peerIdentityBinding,
  signPeerIdentityMessage,
  type PeerCryptoStore,
  type PeerIdentity
} from "@meshrix/peer-crypto";
import {
  InMemoryPeerClientStore,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES,
  PeerClient,
  peerIdentityPublicDescriptor,
  staticPeerDirectory,
  type PeerClientStore,
  type PeerInboundMessage,
  type PeerInboundOutcome
} from "@meshrix/peer-client";

import { FakePeerRelay, FAKE_ROUTE, FAKE_TENANT } from "./fake-relay.ts";

const ALICE_DEV = "dev.alice";
const BOB_DEV = "dev.bob";

interface Device {
  readonly identity: PeerIdentity;
  readonly deviceId: string;
  readonly cryptoStore: PeerCryptoStore;
  readonly clientStore: PeerClientStore;
  readonly client: PeerClient;
  readonly errors: string[];
}

function peerId(deviceId: string): string {
  const value = peerIdForRouteDevice({ tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId });
  if (!value) throw new Error("Test route tuple did not produce a peer id.");
  return value;
}

function makeClient(
  relay: FakePeerRelay,
  input: {
    identity: PeerIdentity;
    deviceId: string;
    cryptoStore: PeerCryptoStore;
    clientStore: PeerClientStore;
    peerIdentity: PeerIdentity;
    dispatch?: (message: PeerInboundMessage) => PeerInboundOutcome | Promise<PeerInboundOutcome>;
  }
): Device {
  const client = new TrackedPeerClient({
    identity: input.identity,
    cryptoStore: input.cryptoStore,
    clientStore: input.clientStore,
    transport: relay.attach({ tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: input.deviceId }),
    route: { tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: input.deviceId },
    directory: staticPeerDirectory({ [input.peerIdentity.peerId === peerId(ALICE_DEV) ? ALICE_DEV : BOB_DEV]: peerIdentityPublicDescriptor(input.peerIdentity) }),
    dispatch: input.dispatch
  });
  const device: Device = {
    identity: input.identity,
    deviceId: input.deviceId,
    cryptoStore: input.cryptoStore,
    clientStore: input.clientStore,
    client,
    errors: []
  };
  client.on("error", (event) => device.errors.push(event.code));
  return device;
}

async function pairedDevices(options: {
  readonly aliceClientStore?: PeerClientStore;
  readonly bobClientStore?: PeerClientStore;
  readonly aliceDispatch?: (message: PeerInboundMessage) => PeerInboundOutcome | Promise<PeerInboundOutcome>;
  readonly bobDispatch?: (message: PeerInboundMessage) => PeerInboundOutcome | Promise<PeerInboundOutcome>;
} = {}): Promise<{ readonly relay: FakePeerRelay; readonly alice: Device; readonly bob: Device }> {
  const relay = new FakePeerRelay();
  relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
  const aliceCryptoStore = createInMemoryPeerCryptoStore();
  const bobCryptoStore = createInMemoryPeerCryptoStore();
  const aliceIdentity = await createPeerIdentity({
    localStore: aliceCryptoStore,
    peerId: peerId(ALICE_DEV),
    prekeyPool: { oneTimeCount: 2, kyberCount: 2 }
  });
  const bobIdentity = await createPeerIdentity({
    localStore: bobCryptoStore,
    peerId: peerId(BOB_DEV),
    prekeyPool: { oneTimeCount: 2, kyberCount: 2 }
  });
  const alice = makeClient(relay, {
    identity: aliceIdentity,
    deviceId: ALICE_DEV,
    cryptoStore: aliceCryptoStore,
    clientStore: options.aliceClientStore ?? new InMemoryPeerClientStore(),
    peerIdentity: bobIdentity,
    dispatch: options.aliceDispatch
  });
  const bob = makeClient(relay, {
    identity: bobIdentity,
    deviceId: BOB_DEV,
    cryptoStore: bobCryptoStore,
    clientStore: options.bobClientStore ?? new InMemoryPeerClientStore(),
    peerIdentity: aliceIdentity,
    dispatch: options.bobDispatch
  });
  await alice.client.publishBundle();
  await bob.client.publishBundle();
  return { relay, alice, bob };
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(await check(), "condition did not settle").toBe(true);
}

async function inboxEntry(device: Device, messageId: string, senderDeviceId: string) {
  return device.client.inbox.entry(device.client.inbox.identity(messageId, senderDeviceId));
}

const clientsForCleanup = new Set<PeerClient>();

class TrackedPeerClient extends PeerClient {
  constructor(...options: ConstructorParameters<typeof PeerClient>) {
    super(...options);
    clientsForCleanup.add(this);
  }
}

afterEach(async () => {
  await Promise.all([...clientsForCleanup].map((client) => client.dispose()));
  clientsForCleanup.clear();
  vi.restoreAllMocks();
});

describe("peer-client online durable delivery", () => {
  it("makes every dispose caller wait for queued durable initialization", async () => {
    const cryptoStore = createInMemoryPeerCryptoStore();
    const identity = await createPeerIdentity({ localStore: cryptoStore, peerId: peerId(ALICE_DEV) });
    const clientStore = new InMemoryPeerClientStore();
    const prepare = clientStore.prepareRoute.bind(clientStore);
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(clientStore, "prepareRoute").mockImplementation(async (route) => {
      entered();
      await gate;
      return prepare(route);
    });
    const send = vi.fn();
    const client = new TrackedPeerClient({ identity, cryptoStore, clientStore, transport: { send },
      route: { tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: ALICE_DEV } });
    const preparing = client.prepareLocalState();
    await entering;
    let completed = 0;
    const first = client.dispose().then(() => { completed += 1; });
    const second = client.dispose().then(() => { completed += 1; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(0);
    } finally {
      release();
      await Promise.all([preparing, first, second]);
    }
    expect(completed).toBe(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("prepares route-local state without sending relay traffic or dispatching business messages", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const cryptoStore = createInMemoryPeerCryptoStore();
    const remoteCryptoStore = createInMemoryPeerCryptoStore();
    const identity = await createPeerIdentity({
      localStore: cryptoStore,
      peerId: peerId(ALICE_DEV),
      prekeyPool: { oneTimeCount: 2, kyberCount: 2 }
    });
    const remoteIdentity = await createPeerIdentity({
      localStore: remoteCryptoStore,
      peerId: peerId(BOB_DEV),
      prekeyPool: { oneTimeCount: 2, kyberCount: 2 }
    });
    const clientStore = new InMemoryPeerClientStore();
    const prepareRoute = vi.spyOn(clientStore, "prepareRoute");
    const transport = relay.attach({ tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: ALICE_DEV });
    const send = vi.spyOn(transport, "send");
    let dispatchCalls = 0;
    const client = new TrackedPeerClient({
      identity,
      cryptoStore,
      clientStore,
      transport,
      route: { tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: ALICE_DEV },
      directory: staticPeerDirectory({ [BOB_DEV]: peerIdentityPublicDescriptor(remoteIdentity) }),
      dispatch: () => { dispatchCalls += 1; return "accepted_by_agent"; }
    });

    await client.prepareLocalState();
    await client.prepareLocalState();

    expect(prepareRoute).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(dispatchCalls).toBe(0);
  });

  it("uses a Signal-signed durable receipt and retries the exact ciphertext after a lost ACK", async () => {
    let dispatchCalls = 0;
    const { relay, alice, bob } = await pairedDevices({
      bobDispatch: async () => { dispatchCalls += 1; return "accepted_by_agent"; }
    });
    relay.dropNextDeliveryAcks(ALICE_DEV);

    const sent = await alice.client.sendMessage(BOB_DEV, "offline mailbox is unnecessary");
    await eventually(async () => (await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch === "accepted_by_agent");
    const firstReceipt = (await inboxEntry(bob, sent.messageId, ALICE_DEV))?.deliveryAck;
    expect(firstReceipt?.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("pending");

    await eventually(async () => (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "delivered");
    const attempts = relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].envelope).toEqual(attempts[0].envelope);
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.deliveryAck).toEqual(firstReceipt);
    expect(dispatchCalls).toBe(1);
  });

  it("commits transport receipt independently and preserves deferred application dispatch", async () => {
    const { alice, bob } = await pairedDevices({ bobDispatch: () => "deferred" });
    const sent = await alice.client.sendMessage(BOB_DEV, "durable before dispatch");
    await eventually(async () => (await inboxEntry(bob, sent.messageId, ALICE_DEV))?.deliveryAck !== null);
    await eventually(async () => (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "delivered");
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("pending");

    let replayed = 0;
    bob.client.onInboundMessage(async (message) => {
      expect(message.messageId).toBe(sent.messageId);
      replayed += 1;
      return "accepted_by_agent";
    });
    await bob.client.retryPendingDispatch();
    expect(replayed).toBe(1);
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("delivered");
  });

  it.each(["authority_stale", "backpressured"] as const)(
    "retries a durable signed ACK after %s without reconnect or application redispatch",
    async (temporaryFailure) => {
      let dispatchCalls = 0;
      const { relay, alice, bob } = await pairedDevices({
        bobDispatch: () => { dispatchCalls += 1; return "accepted_by_agent"; }
      });
      if (temporaryFailure === "authority_stale") relay.refuseNextDeliveryAcks(ALICE_DEV);
      else relay.backpressureNextDeliveryAcks(ALICE_DEV);

      const sent = await alice.client.sendMessage(BOB_DEV, "receipt survives temporary authority loss", {
        messageId: "msg.authority.stale.ack"
      });
      await eventually(async () => relay.deliveryAckAttempts.length === 1
        && (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "pending");
      const committedAck = (await inboxEntry(bob, sent.messageId, ALICE_DEV))?.deliveryAck;
      expect(committedAck).not.toBeNull();
      expect(dispatchCalls).toBe(1);
      expect(alice.client.presence(BOB_DEV)?.state).toBe("reachable");
      expect(bob.client.presence(ALICE_DEV)?.state).toBe("reachable");

      await vi.waitFor(async () => {
        expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("delivered");
      }, { timeout: 5_000, interval: 10 });

      expect(relay.deliveryAckAttempts.length).toBeGreaterThanOrEqual(2);
      expect(relay.deliveryAckAttempts[0]).toEqual(committedAck);
      expect(relay.deliveryAckAttempts[1]).toEqual(committedAck);
      expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.deliveryAck).toEqual(committedAck);
      expect(dispatchCalls).toBe(1);
      expect(alice.client.presence(BOB_DEV)?.state).toBe("reachable");
      expect(bob.client.presence(ALICE_DEV)?.state).toBe("reachable");
    }
  );

  it("retries the same sender-owned ciphertext after transient peer-send backpressure", async () => {
    let dispatchCalls = 0;
    const { relay, alice, bob } = await pairedDevices({
      bobDispatch: () => { dispatchCalls += 1; return "accepted_by_agent"; }
    });
    relay.backpressureNextPeerSends(BOB_DEV);

    const sent = await alice.client.sendMessage(BOB_DEV, "preserve sender custody through backpressure", {
      messageId: "msg.peer.send.backpressure"
    });
    await eventually(async () => (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.lastForwarded?.outcome === "backpressured");
    const exactEnvelope = sent.envelope;
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("pending");

    await vi.waitFor(async () => {
      expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("delivered");
    }, { timeout: 5_000, interval: 10 });

    const attempts = relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].envelope).toEqual(exactEnvelope);
    expect(attempts[1].envelope).toEqual(exactEnvelope);
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
    expect(dispatchCalls).toBe(1);
  });

  it("keeps transport and crypto progress independent from a slow application handler", async () => {
    let markDispatchStarted!: () => void;
    let releaseDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const { alice, bob } = await pairedDevices({
      bobDispatch: async () => {
        markDispatchStarted();
        await release;
        return "accepted_by_agent";
      }
    });

    const first = await alice.client.sendMessage(BOB_DEV, "application may take time");
    await dispatchStarted;
    await eventually(async () => (await alice.client.outbox.entry(first.messageId, BOB_DEV))?.state === "delivered");

    const reply = await bob.client.sendMessage(ALICE_DEV, "transport remains available");
    await eventually(async () => (await bob.client.outbox.entry(reply.messageId, ALICE_DEV))?.state === "delivered");

    releaseDispatch();
    await eventually(async () => (await inboxEntry(bob, first.messageId, ALICE_DEV))?.dispatch === "accepted_by_agent");
  });

  it("rejects forged signed receipts and does not ACK Signal duplicates under a new tuple", async () => {
    const { relay, alice, bob } = await pairedDevices({ bobDispatch: () => "accepted_by_agent" });
    relay.dropNextDeliveryAcks(ALICE_DEV);
    const first = await alice.client.sendMessage(BOB_DEV, "first session message");
    await eventually(async () => (await inboxEntry(bob, first.messageId, ALICE_DEV))?.deliveryAck != null);
    await alice.client.resume();
    await eventually(async () => (await alice.client.outbox.entry(first.messageId, BOB_DEV))?.state === "delivered");

    const reply = await bob.client.sendMessage(ALICE_DEV, "confirm initiator ratchet");
    await eventually(async () => (await inboxEntry(alice, reply.messageId, BOB_DEV))?.deliveryAck != null);

    const sessionSend = await alice.client.sendMessage(BOB_DEV, "established-session message");
    await eventually(async () => (await inboxEntry(bob, sessionSend.messageId, ALICE_DEV))?.deliveryAck != null);
    const originalWire = relay.sendAttempts.find((entry) => entry.messageId === sessionSend.messageId);
    expect(originalWire).toBeDefined();

    const firstWire = relay.sendAttempts.find((entry) => entry.messageId === first.messageId);
    const conflictingTuple = createPeerSend({ ...originalWire!, envelope: firstWire!.envelope });
    relay.inject(BOB_DEV, conflictingTuple as unknown as Record<string, unknown>);
    await eventually(() => bob.errors.includes("peer_client_conflict"));

    const duplicateUnderNewId = createPeerSend({ ...originalWire!, messageId: "msg.replayed.as.new" });
    relay.inject(BOB_DEV, duplicateUnderNewId as unknown as Record<string, unknown>);
    await eventually(async () => (await inboxEntry(bob, "msg.replayed.as.new", ALICE_DEV)) !== null);
    const skipped = await inboxEntry(bob, "msg.replayed.as.new", ALICE_DEV);
    expect(skipped?.decryptError).toBe("peer_duplicate_message");
    expect(skipped?.plaintext).toBeNull();
    expect(skipped?.deliveryAck).toBeNull();

    const releaseAcks = relay.holdDeliveryAcks(ALICE_DEV);
    const unsettled = await alice.client.sendMessage(BOB_DEV, "receipt signature must be pinned");
    await eventually(async () => (await inboxEntry(bob, unsettled.messageId, ALICE_DEV))?.deliveryAck != null);
    await bob.client.resume(); // A legitimate retry remains withheld during the forgery check.
    const pendingEntry = await alice.client.outbox.entry(unsettled.messageId, BOB_DEV);
    expect(pendingEntry?.state).toBe("pending");
    const wireSend = createPeerSend({
      tenantId: FAKE_TENANT,
      routeId: FAKE_ROUTE,
      senderDeviceId: ALICE_DEV,
      recipientDeviceId: BOB_DEV,
      messageId: unsettled.messageId,
      envelope: pendingEntry!.envelope
    });
    const signingInput = await peerDeliveryAckSigningInputForSend(wireSend);
    expect(signingInput).not.toBeNull();
    const attackerStore = createInMemoryPeerCryptoStore();
    const attacker = await createPeerIdentity({ localStore: attackerStore, peerId: "peer.attacker" });
    const signature = signPeerIdentityMessage(attacker, Buffer.from(peerDeliveryAckTranscript(signingInput!), "utf8"));
    const forged = createPeerDeliveryAck({ ...signingInput!, signature: base64urlEncode(signature) });
    relay.inject(ALICE_DEV, forged as unknown as Record<string, unknown>);
    await eventually(() => alice.errors.includes("peer_client_invalid_delivery_ack"));
    expect((await alice.client.outbox.entry(unsettled.messageId, BOB_DEV))?.state).toBe("pending");
    expect((await peerIdentityBinding(alice.cryptoStore, peerId(BOB_DEV)))?.state).toBe("active");
    releaseAcks();
    await bob.client.resume();
    await eventually(async () => (await alice.client.outbox.entry(unsettled.messageId, BOB_DEV))?.state === "delivered");
  });

  it("keeps new offline sends in local custody and retries the same envelope when the peer returns", async () => {
    const { relay, alice, bob } = await pairedDevices();
    relay.detach(BOB_DEV);
    const sent = await alice.client.sendMessage(BOB_DEV, "peer returns later", { messageId: "msg.offline.retry" });
    expect(sent.state).toBe("pending");
    const storedEnvelope = sent.envelope;
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("pending");
    expect(relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId)).toHaveLength(1);

    const replacement = makeClient(relay, {
      identity: bob.identity,
      deviceId: BOB_DEV,
      cryptoStore: bob.cryptoStore,
      clientStore: bob.clientStore,
      peerIdentity: alice.identity
    });
    await replacement.client.resume();
    await eventually(async () => (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "delivered");
    const attempts = relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].envelope).toEqual(storedEnvelope);
    expect((await inboxEntry(replacement, sent.messageId, ALICE_DEV))?.plaintext).not.toBeNull();
  });

  it("does not resend an unconfirmed envelope every time a later message is acknowledged", async () => {
    const { relay, alice, bob } = await pairedDevices();
    relay.dropNextDeliveryAcks(ALICE_DEV);

    const first = await alice.client.sendMessage(BOB_DEV, "first receipt is lost");
    await eventually(async () => (await inboxEntry(bob, first.messageId, ALICE_DEV))?.deliveryAck !== null);
    expect((await alice.client.outbox.entry(first.messageId, BOB_DEV))?.state).toBe("pending");
    const later = await alice.client.sendMessage(BOB_DEV, "a later message can still settle");
    await eventually(async () => (await alice.client.outbox.entry(later.messageId, BOB_DEV))?.state === "delivered");

    expect(relay.sendAttempts.filter((entry) => entry.messageId === first.messageId)).toHaveLength(1);
    await alice.client.resume();
    await eventually(async () => (await alice.client.outbox.entry(first.messageId, BOB_DEV))?.state === "delivered");
    const firstAttempts = relay.sendAttempts.filter((entry) => entry.messageId === first.messageId);
    expect(firstAttempts).toHaveLength(2);
    expect(firstAttempts[1].envelope).toEqual(firstAttempts[0].envelope);
  });

  it("recovers a send WAL after outbox persistence fails without encrypting the message twice", async () => {
    class FailFirstOutboxWrite extends InMemoryPeerClientStore {
      #fail = true;

      override async saveOutboxEntry(entry: Parameters<InMemoryPeerClientStore["saveOutboxEntry"]>[0]): Promise<void> {
        if (this.#fail) {
          this.#fail = false;
          throw new Error("simulated interruption before outbox commit");
        }
        await super.saveOutboxEntry(entry);
      }
    }

    const { relay, alice, bob } = await pairedDevices({ aliceClientStore: new FailFirstOutboxWrite() });
    await expect(alice.client.sendMessage(BOB_DEV, "commit exact envelope once", { messageId: "msg.wal.once" }))
      .rejects.toThrow("simulated interruption");
    await alice.client.resume();
    await eventually(async () => (await alice.client.outbox.entry("msg.wal.once", BOB_DEV))?.state === "delivered");
    const recovered = await alice.client.outbox.entry("msg.wal.once", BOB_DEV);
    expect(recovered?.envelope).toBeDefined();
    await alice.client.sendMessage(BOB_DEV, "commit exact envelope once", { messageId: "msg.wal.once" });
    expect(relay.sendAttempts.filter((entry) => entry.messageId === "msg.wal.once")).toHaveLength(1);
    expect((await inboxEntry(bob, "msg.wal.once", ALICE_DEV))?.dispatch).toBe("pending");
  });

  it("backs off before receive WAL commit on local capacity pressure and retries exact ciphertext", async () => {
    class BackpressureOnce extends InMemoryPeerClientStore {
      #reject = true;

      override async assertAvailableCapacity(additionalBytes: number): Promise<void> {
        expect(additionalBytes).toBeGreaterThan(0);
        if (this.#reject) {
          this.#reject = false;
          throw Object.assign(new Error("not enough local storage"), { code: "private_storage_capacity" });
        }
      }
    }

    let dispatchCalls = 0;
    const { relay, alice, bob } = await pairedDevices({
      bobClientStore: new BackpressureOnce(),
      bobDispatch: () => { dispatchCalls += 1; return "accepted_by_agent"; }
    });
    const sent = await alice.client.sendMessage(BOB_DEV, "retry after local storage is available", { messageId: "msg.capacity.retry" });
    await eventually(() => bob.errors.includes("peer_client_backpressured"));
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))).toBeNull();
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("pending");
    expect(dispatchCalls).toBe(0);

    await eventually(async () => (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "delivered");
    const attempts = relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].envelope).toEqual(attempts[0].envelope);
    expect(dispatchCalls).toBe(1);
  });

  it("fits the exact UTF-8 producer cap inside relay ciphertext for fresh PQXDH and established messages", async () => {
    const { relay, alice, bob } = await pairedDevices();
    const plaintext = "你".repeat(10_922) + "ab";
    expect(Buffer.byteLength(plaintext, "utf8")).toBe(PEER_CLIENT_MAX_PLAINTEXT_BYTES);
    const maxMessageId = "m".repeat(127);

    const first = await alice.client.sendMessage(BOB_DEV, plaintext, { messageId: maxMessageId });
    const firstWire = relay.sendAttempts.find((entry) => entry.messageId === maxMessageId);
    expect(firstWire?.envelope.headers.messageType).toBe("prekey");
    expect(parsePeerSend(firstWire)).not.toBeNull();
    const firstEnvelopeBytes = base64urlDecode(first.envelope.ciphertext, PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    expect(firstEnvelopeBytes).not.toBeNull();
    expect(firstEnvelopeBytes!.byteLength).toBeLessThanOrEqual(PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    await eventually(async () => (await inboxEntry(bob, maxMessageId, ALICE_DEV))?.deliveryAck !== null);

    const response = await bob.client.sendMessage(ALICE_DEV, "confirm ratchet");
    await eventually(async () => (await inboxEntry(alice, response.messageId, BOB_DEV))?.deliveryAck !== null);
    const steady = await alice.client.sendMessage(BOB_DEV, plaintext, { messageId: "m".repeat(126) + "n" });
    const steadyWire = relay.sendAttempts.find((entry) => entry.messageId === steady.messageId);
    expect(steadyWire?.envelope.headers.messageType).toBe("session");
    expect(parsePeerSend(steadyWire)).not.toBeNull();
    const steadyEnvelopeBytes = base64urlDecode(steady.envelope.ciphertext, PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    expect(steadyEnvelopeBytes).not.toBeNull();
    expect(steadyEnvelopeBytes!.byteLength).toBeLessThanOrEqual(PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes);
    await eventually(async () => (await inboxEntry(bob, steady.messageId, ALICE_DEV))?.deliveryAck !== null);
  });
  it("rejects a lost bundle request and recovers on the same client", async () => {
    const { relay, alice } = await pairedDevices();
    let fetchStarted!: () => void;
    const requested = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const dispatch = relay.dispatch.bind(relay);
    const intercepted = vi.spyOn(relay, "dispatch").mockImplementation(async (channel, message) => {
      if (message.kind === "peer-bundle-fetch") {
        fetchStarted();
        return;
      }
      await dispatch(channel, message);
    });
    const blocked = alice.client.sendMessage(BOB_DEV, "recover unfinished control", { messageId: "msg.control.recover" });
    const rejection = expect(blocked).rejects.toMatchObject({ code: "peer_client_transport" });
    await requested;
    alice.client.transportLost();
    await rejection;
    expect(await alice.client.outbox.entry("msg.control.recover", BOB_DEV)).toBeNull();
    intercepted.mockRestore();
    await alice.client.resume();
    await alice.client.sendMessage(BOB_DEV, "recover unfinished control", { messageId: "msg.control.recover" });
    await eventually(async () => (await alice.client.outbox.entry("msg.control.recover", BOB_DEV))?.state === "delivered");
    expect(relay.sendAttempts.filter((entry) => entry.messageId === "msg.control.recover")).toHaveLength(1);
  });

  it("does not dispatch a stale pending page after the durable entry has already committed", async () => {
    let dispatchStarted!: () => void;
    let releaseDispatch!: () => void;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let calls = 0;
    const { alice, bob } = await pairedDevices({
      bobDispatch: async () => {
        calls += 1;
        dispatchStarted();
        await release;
        return "accepted_by_agent";
      }
    });
    const sent = await alice.client.sendMessage(BOB_DEV, "one committed application call");
    await started;
    let pageCaptured!: () => void;
    let releasePage!: () => void;
    const captured = new Promise<void>((resolve) => { pageCaptured = resolve; });
    const pageRelease = new Promise<void>((resolve) => { releasePage = resolve; });
    const originalPage = bob.client.inbox.pendingDispatchPage.bind(bob.client.inbox);
    vi.spyOn(bob.client.inbox, "pendingDispatchPage").mockImplementationOnce(async (...args) => {
      const page = await originalPage(...args);
      pageCaptured();
      await pageRelease;
      return page;
    });
    const retry = bob.client.retryPendingDispatch();
    await captured;
    bob.client.transportLost();
    releaseDispatch();
    await eventually(async () => (await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch === "accepted_by_agent");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releasePage();
    await retry;
    expect(calls).toBe(1);
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
  });

  it("retries deferred durable dispatch after signed delivery without new traffic or reconnect", async () => {
    let dispatchCalls = 0;
    const { relay, alice, bob } = await pairedDevices({
      bobDispatch: () => {
        dispatchCalls += 1;
        return dispatchCalls === 1 ? { kind: "deferred" as const } : "accepted_by_agent";
      }
    });
    const sent = await alice.client.sendMessage(BOB_DEV, "retry only the durable application obligation");
    await eventually(async () => {
      const received = await inboxEntry(bob, sent.messageId, ALICE_DEV);
      return received?.deliveryAck !== null && received?.deliveryAck !== undefined
        && (await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state === "delivered";
    });
    expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("pending");
    expect(dispatchCalls).toBe(1);
    await vi.waitFor(async () => {
      expect((await inboxEntry(bob, sent.messageId, ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
    }, { timeout: 5_000, interval: 10 });
    expect(dispatchCalls).toBe(2);
    expect((await alice.client.outbox.entry(sent.messageId, BOB_DEV))?.state).toBe("delivered");
    expect(relay.sendAttempts.filter((entry) => entry.messageId === sent.messageId)).toHaveLength(1);
  });

  it("retries other pending work while a healthy handler is still running without overlapping sweeps", async () => {
    let slowCalls = 0;
    let deferredCalls = 0;
    let triggerCalls = 0;
    let slowStarted!: () => void;
    const slowCallStarted = new Promise<void>((resolve) => { slowStarted = resolve; });
    const neverSettles = new Promise<PeerInboundOutcome>(() => undefined);
    const { alice, bob } = await pairedDevices({
      bobDispatch: (message) => {
        if (message.messageId === "msg.slow") {
          slowCalls += 1;
          slowStarted();
          return neverSettles;
        }
        if (message.messageId === "msg.deferred") {
          deferredCalls += 1;
          return deferredCalls === 1 ? { kind: "deferred" as const } : "accepted_by_agent";
        }
        if (message.messageId === "msg.retry-trigger") {
          triggerCalls += 1;
          return triggerCalls === 1 ? { kind: "deferred" as const } : "accepted_by_agent";
        }
        return "accepted_by_agent";
      }
    });

    await alice.client.sendMessage(BOB_DEV, "hold one healthy dispatch", { messageId: "msg.slow" });
    await slowCallStarted;

    let pageReadCount = 0;
    let activePageReads = 0;
    let maximumActivePageReads = 0;
    let firstTimerPageStarted!: () => void;
    let releaseFirstTimerPage!: () => void;
    const timerPageStarted = new Promise<void>((resolve) => { firstTimerPageStarted = resolve; });
    const timerPageRelease = new Promise<void>((resolve) => { releaseFirstTimerPage = resolve; });
    const originalPendingPage = bob.client.inbox.pendingDispatchPage.bind(bob.client.inbox);
    vi.spyOn(bob.client.inbox, "pendingDispatchPage").mockImplementation(async (...args) => {
      pageReadCount += 1;
      activePageReads += 1;
      maximumActivePageReads = Math.max(maximumActivePageReads, activePageReads);
      try {
        if (pageReadCount === 1) {
          firstTimerPageStarted();
          await timerPageRelease;
        }
        return await originalPendingPage(...args);
      } finally {
        activePageReads -= 1;
      }
    });

    await alice.client.sendMessage(BOB_DEV, "defer until recovery", { messageId: "msg.deferred" });
    await vi.waitFor(() => expect(deferredCalls).toBe(1), { timeout: 5_000, interval: 10 });
    await timerPageStarted;

    await alice.client.sendMessage(BOB_DEV, "request another deferred retry", { messageId: "msg.retry-trigger" });
    await vi.waitFor(() => expect(triggerCalls).toBe(1), { timeout: 5_000, interval: 10 });
    // Cross the next exponential retry delay while the first page remains held.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100));

    expect(pageReadCount).toBe(1);
    expect(maximumActivePageReads).toBe(1);
    releaseFirstTimerPage();

    await vi.waitFor(async () => {
      expect((await inboxEntry(bob, "msg.deferred", ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
      expect((await inboxEntry(bob, "msg.retry-trigger", ALICE_DEV))?.dispatch).toBe("accepted_by_agent");
    }, { timeout: 5_000, interval: 10 });
    expect((await inboxEntry(bob, "msg.slow", ALICE_DEV))?.dispatch).toBe("pending");
    expect(slowCalls).toBe(1);
    expect(deferredCalls).toBe(2);
    expect(triggerCalls).toBe(2);
  }, 10_000);

});
