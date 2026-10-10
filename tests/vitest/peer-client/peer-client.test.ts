import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFilePeerCryptoStore,
  createInMemoryPeerCryptoStore,
  createPeerIdentity,
  loadPeerIdentity,
  peerIdentityBinding,
  repinPeerIdentity,
  type PeerCryptoStore,
  type PeerIdentity
} from "@meshrix/peer-crypto";
import {
  createFilePeerClientStore,
  createInMemoryPeerClientStore,
  isPeerClientError,
  PeerClient,
  staticPeerDirectory,
  type PeerClientStore,
  type PeerInboundMessage
} from "@meshrix/peer-client";

import { FakePeerRelay, FAKE_ROUTE, FAKE_TENANT, type FakePeerTransport } from "./fake-relay.ts";

/**
 * End-to-end coverage of the durable peer client over a faithful in-memory
 * relay: all 13 wire kinds run with real mailbox semantics and real
 * X3DH+ratchet crypto between two device identities — nothing is mocked
 * below the session channel.
 */

const ALICE_PEER = "peer.alice.1";
const BOB_PEER = "peer.bob.1";
const ALICE_DEV = "dev.alice";
const BOB_DEV = "dev.bob";

interface EventLog {
  inbound: PeerInboundMessage[];
  sendState: { messageId: string; state: string; position: number | null }[];
  conflict: { messageId: string }[];
  unrecorded: { messageId: string }[];
  lostRange: { fromSeq: number; toSeq: number; cause: string; messageIds: readonly string[] | null }[];
  requiresRePair: { peerId: string; source: string }[];
  bundleRefused: { refusal: string }[];
  retentionPolicy: { mailboxMaxItems: number }[];
  ackRefused: { messageId: string; refusal: string }[];
  decryptFailure: { messageId: string; code: string }[];
  dispatchFailed: { messageId: string; error: string }[];
  error: { code: string }[];
}

interface Device {
  peerId: string;
  deviceId: string;
  cryptoStore: PeerCryptoStore;
  clientStore: ReturnType<typeof createInMemoryPeerClientStore> | PeerClientStore;
  identity: PeerIdentity;
  transport: FakePeerTransport;
  client: PeerClient;
  events: EventLog;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function freshEvents(): EventLog {
  return {
    inbound: [], sendState: [], conflict: [], unrecorded: [], lostRange: [],
    requiresRePair: [], bundleRefused: [], retentionPolicy: [], ackRefused: [],
    decryptFailure: [], dispatchFailed: [], error: []
  };
}

function wireEvents(client: PeerClient, events: EventLog): void {
  client.on("inbound", (event) => events.inbound.push(event));
  client.on("sendState", (event) => events.sendState.push({ messageId: event.messageId, state: event.state, position: event.position }));
  client.on("conflict", (event) => events.conflict.push(event));
  client.on("unrecorded", (event) => events.unrecorded.push(event));
  client.on("lostRange", (event) => events.lostRange.push(event));
  client.on("requiresRePair", (event) => events.requiresRePair.push(event));
  client.on("bundleRefused", (event) => events.bundleRefused.push(event));
  client.on("retentionPolicy", (event) => events.retentionPolicy.push({ mailboxMaxItems: event.mailboxMaxItems }));
  client.on("ackRefused", (event) => events.ackRefused.push(event));
  client.on("decryptFailure", (event) => events.decryptFailure.push(event));
  client.on("dispatchFailed", (event) => events.dispatchFailed.push(event));
  client.on("error", (event) => events.error.push({ code: event.code }));
}

async function makeDevice(relay: FakePeerRelay, input: {
  peerId: string;
  deviceId: string;
  cryptoStore?: PeerCryptoStore;
  clientStore?: PeerClientStore;
  identity?: PeerIdentity;
  directory?: ReturnType<typeof staticPeerDirectory>;
  pageSize?: number;
  maxSendAttempts?: number;
  admissionGeneration?: number;
  prekeyPool?: { oneTimeCount: number; kyberCount: number };
}): Promise<Device> {
  const cryptoStore = input.cryptoStore ?? createInMemoryPeerCryptoStore();
  const identity = input.identity ?? await createPeerIdentity({
    localStore: cryptoStore,
    peerId: input.peerId,
    prekeyPool: input.prekeyPool
  });
  const clientStore = input.clientStore ?? createInMemoryPeerClientStore();
  const transport = relay.attach({
    tenantId: FAKE_TENANT,
    routeId: FAKE_ROUTE,
    deviceId: input.deviceId,
    admissionGeneration: input.admissionGeneration
  });
  const client = new PeerClient({
    identity,
    cryptoStore,
    clientStore,
    transport,
    route: { tenantId: FAKE_TENANT, routeId: FAKE_ROUTE, deviceId: input.deviceId },
    directory: input.directory,
    pageSize: input.pageSize,
    maxSendAttempts: input.maxSendAttempts,
    requestTimeoutMs: 300
  });
  const events = freshEvents();
  wireEvents(client, events);
  return { peerId: identity.peerId, deviceId: input.deviceId, cryptoStore, clientStore, identity, transport, client, events };
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      expect(await check(), "timed out waiting for condition").toBe(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function pairedDevices(relay: FakePeerRelay, options: { bobPublishes?: boolean } = {}) {
  relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
  const alice = await makeDevice(relay, {
    peerId: ALICE_PEER,
    deviceId: ALICE_DEV,
    directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER })
  });
  const bob = await makeDevice(relay, {
    peerId: BOB_PEER,
    deviceId: BOB_DEV,
    directory: staticPeerDirectory({ [ALICE_DEV]: ALICE_PEER })
  });
  await alice.client.publishBundle();
  if (options.bobPublishes !== false) await bob.client.publishBundle();
  return { alice, bob };
}

describe("peer-client outbox", () => {
  it("sends first message as prekey, session-type once the peer answers", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);

    const first = await alice.client.sendMessage(BOB_DEV, "hello one");
    expect(first.state).toBe("accepted");
    expect(first.position).toBe(1);
    // X3DH/PQXDH first contact: the crypto envelope is prekey-typed and the
    // wire headers carry the negotiated prekey material ids.
    expect(first.envelope.headers.messageType).toBe("prekey");
    expect(first.envelope.headers.signedPrekeyId).toBeTruthy();
    expect(first.receipts.some((receipt) => receipt.kind === "accepted" && receipt.source === "mailbox")).toBe(true);

    // The initiator stays prekey-typed until the responder answers — the
    // ratchet is only confirmed by an inbound message on that session.
    await eventually(async () => (await bob.client.inbox.list()).length === 1);
    const reply = await bob.client.sendMessage(ALICE_DEV, "ack");
    expect(reply.state).toBe("accepted");
    await eventually(async () => (await alice.client.inbox.list()).length === 1);

    const second = await alice.client.sendMessage(BOB_DEV, "hello two");
    expect(second.state).toBe("accepted");
    expect(second.position).toBe(2);
    expect(second.envelope.headers.messageType).toBe("session");
    expect(second.envelope.headers.senderBundleId).toBe(first.envelope.headers.senderBundleId);
    expect(alice.events.sendState.filter((event) => event.state === "accepted").length).toBe(2);
  });

  it("reconciles a lost peer-accepted reply through peer-status", async () => {
    const relay = new FakePeerRelay();
    const { alice } = await pairedDevices(relay);
    const warm = await alice.client.sendMessage(BOB_DEV, "warm up"); // session exists — drops land on send/status, not bundle-fetch
    expect(warm.state).toBe("accepted");
    relay.dropNextResponses(ALICE_DEV, 2); // lose the accepted reply AND the drive-time reconcile answer

    const entry = await alice.client.sendMessage(BOB_DEV, "lost reply");
    expect(entry.state).toBe("pending");
    expect(entry.position).toBeNull();

    await alice.client.reconcile();
    const reconciled = await alice.client.outbox.entry(entry.messageId);
    // Position + accepted receipt are recovered honestly; the state may already
    // have advanced to `received` because bob's page ack raced the reconcile.
    expect(["accepted", "received"]).toContain(reconciled?.state);
    expect(reconciled?.position).toBe(2);
    expect(reconciled?.receipts.some((receipt) => receipt.kind === "accepted")).toBe(true);
  });

  it("retries a pending send with the same id and envelope; duplicate is success", async () => {
    const relay = new FakePeerRelay();
    const { alice } = await pairedDevices(relay);
    const warm = await alice.client.sendMessage(BOB_DEV, "warm up");
    expect(warm.state).toBe("accepted");
    relay.dropNextResponses(ALICE_DEV, 2);

    const entry = await alice.client.sendMessage(BOB_DEV, "retry me");
    expect(entry.state).toBe("pending");

    await alice.client.resume(); // reconnect path: retry same id + same envelope bytes
    const retried = await alice.client.outbox.entry(entry.messageId);
    expect(["accepted", "received"]).toContain(retried?.state);
    expect(retried?.position).toBe(2);
    expect(retried?.attempts).toBe(2);
    // The mailbox stored exactly one envelope — duplicate replayed the position.
    expect(relay.partitionOf(FAKE_ROUTE, BOB_DEV).position).toBe(2);
  });

  it("surfaces a sender-scope conflict honestly and never retries it", async () => {
    const relay = new FakePeerRelay();
    const { alice } = await pairedDevices(relay);

    const first = await alice.client.sendMessage(BOB_DEV, "original");
    expect(first.state).toBe("accepted");

    // A second writer sharing the device identity reuses the messageId with
    // different envelope bytes — the wire's typed conflict class.
    const rival = await makeDevice(relay, {
      peerId: ALICE_PEER,
      deviceId: ALICE_DEV,
      cryptoStore: alice.cryptoStore,
      identity: alice.identity,
      directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER })
    });
    const conflicted = await rival.client.sendMessage(BOB_DEV, "different bytes", { messageId: first.messageId });
    expect(conflicted.state).toBe("conflict");
    expect(rival.events.conflict.map((event) => event.messageId)).toContain(first.messageId);

    await expect(rival.client.sendMessage(BOB_DEV, "again", { messageId: first.messageId }))
      .rejects.toSatisfy((error) => isPeerClientError(error, "peer_client_state"));
    await rival.client.reconcile();
    expect((await rival.client.outbox.entry(first.messageId))?.state).toBe("conflict");
  });

  it("surfaces unrecorded when the mailbox drops sends past the attempt bound", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const alice = await makeDevice(relay, {
      peerId: ALICE_PEER, deviceId: ALICE_DEV,
      directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER }),
      maxSendAttempts: 2
    });
    const bob = await makeDevice(relay, { peerId: BOB_PEER, deviceId: BOB_DEV });
    await alice.client.publishBundle();
    await bob.client.publishBundle();
    const session = await alice.client.sendMessage(BOB_DEV, "paired send");
    expect(session.state).toBe("accepted");

    relay.unpair(FAKE_ROUTE);
    const stuck = await alice.client.sendMessage(BOB_DEV, "nobody home", { messageId: "msg.stuck.1" });
    expect(stuck.state).toBe("pending");
    await alice.client.resume();
    const resolved = await alice.client.outbox.entry("msg.stuck.1");
    expect(resolved?.state).toBe("unrecorded");
    expect(alice.events.unrecorded.map((event) => event.messageId)).toContain("msg.stuck.1");
  });

  it("fails a first send honestly when the peer never published a bundle", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const alice = await makeDevice(relay, {
      peerId: ALICE_PEER, deviceId: ALICE_DEV,
      directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER })
    });
    await makeDevice(relay, { peerId: BOB_PEER, deviceId: BOB_DEV }); // never publishes
    await expect(alice.client.sendMessage(BOB_DEV, "cannot initiate"))
      .rejects.toSatisfy((error) => isPeerClientError(error, "peer_client_bundle_unavailable"));
  });
});

describe("peer-client inbox + dispatch", () => {
  it("delivers end-to-end: decrypt, dispatch, received + agent receipts upstream", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    bob.client.onInboundMessage(async (message) => {
      expect(text(message.plaintext)).toBe("secret work");
      return "accepted_by_agent";
    });

    const entry = await alice.client.sendMessage(BOB_DEV, "secret work");
    await eventually(() => bob.events.inbound.length === 1);
    expect(bob.events.inbound[0].messageId).toBe(entry.messageId);
    expect(bob.events.inbound[0].senderPeerId).toBe(ALICE_PEER);
    expect(bob.events.inbound[0].senderDeviceId).toBe(ALICE_DEV);

    await alice.client.reconcile();
    const final = await alice.client.outbox.entry(entry.messageId);
    expect(final?.state).toBe("accepted_by_agent");
    expect(final?.receipts.map((receipt) => receipt.kind)).toEqual(
      expect.arrayContaining(["accepted", "received", "accepted_by_agent"])
    );
  });

  it("keeps entries pending without a handler, still acks received, then drains on attach", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);

    await alice.client.sendMessage(BOB_DEV, "queued work");
    await eventually(async () => (await bob.client.inbox.list()).length === 1);
    expect((await bob.client.inbox.list())[0].dispatch).toBe("pending");

    await alice.client.reconcile();
    expect((await alice.client.outbox.list())[0].state).toBe("received");

    const delivered: string[] = [];
    bob.client.onInboundMessage(async (message) => {
      delivered.push(text(message.plaintext));
      return "accepted_by_agent";
    });
    await eventually(() => delivered.length === 1);
    expect(delivered).toEqual(["queued work"]);
    await alice.client.reconcile();
    expect((await alice.client.outbox.list())[0].state).toBe("accepted_by_agent");
  });

  it("dedups redelivery: an identical page never re-decrypts or re-dispatches", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    let dispatched = 0;
    bob.client.onInboundMessage(async () => {
      dispatched += 1;
      return "accepted_by_agent";
    });
    await alice.client.sendMessage(BOB_DEV, "one");
    await alice.client.sendMessage(BOB_DEV, "two");
    await eventually(() => dispatched === 2);

    // A lagging channel replays the whole backlog page — dedup must hold.
    await relay.replayPage(BOB_DEV, 0);
    await eventually(() => dispatched === 2, 2_000); // settle: no third dispatch may appear
    expect(dispatched).toBe(2);
    expect((await bob.client.inbox.list()).length).toBe(2);
  });

  it("resumes from the durable cursor: only unseen positions dispatch", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    const dispatched: string[] = [];
    bob.client.onInboundMessage(async (message) => {
      dispatched.push(text(message.plaintext));
      return "accepted_by_agent";
    });
    await alice.client.sendMessage(BOB_DEV, "before restart 1");
    await alice.client.sendMessage(BOB_DEV, "before restart 2");
    await eventually(() => dispatched.length === 2);

    // Restart the client over the same durable stores.
    const restarted = await makeDevice(relay, {
      peerId: BOB_PEER,
      deviceId: BOB_DEV,
      cryptoStore: bob.cryptoStore,
      clientStore: bob.clientStore,
      identity: bob.identity
    });
    restarted.client.onInboundMessage(async (message) => {
      dispatched.push(text(message.plaintext));
      return "rejected";
    });
    await alice.client.sendMessage(BOB_DEV, "after restart");
    await restarted.client.resume();

    expect(dispatched).toEqual(["before restart 1", "before restart 2", "after restart"]);
    expect(await restarted.client.inbox.cursor()).toBe(3);
  });

  it("surfaces gap tombstones as lost-range events and advances the cursor", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    relay.detach(BOB_DEV); // offline: nothing pushes, bob will fetch later
    await alice.client.sendMessage(BOB_DEV, "lost one");
    await alice.client.sendMessage(BOB_DEV, "lost two");
    await alice.client.sendMessage(BOB_DEV, "survivor");
    relay.truncate(FAKE_ROUTE, BOB_DEV, [1, 2], "expired");

    const dispatched: string[] = [];
    bob.client.onInboundMessage(async (message) => {
      dispatched.push(text(message.plaintext));
      return "accepted_by_agent";
    });
    await bob.client.sync();

    expect(dispatched).toEqual(["survivor"]);
    expect(bob.events.lostRange.length).toBe(1);
    expect(bob.events.lostRange[0].fromSeq).toBe(1);
    expect(bob.events.lostRange[0].toSeq).toBe(2);
    expect(bob.events.lostRange[0].cause).toBe("expired");
    expect(bob.events.lostRange[0].messageIds?.length).toBe(2);
    expect(await bob.client.inbox.cursor()).toBe(3);
    expect((await bob.client.inbox.gaps()).length).toBe(1);
  });

  it("honors paged fetches with more=true across three pages", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    relay.detach(BOB_DEV);
    for (let index = 1; index <= 5; index += 1) {
      await alice.client.sendMessage(BOB_DEV, `paged ${index}`);
    }
    const bob2 = await makeDevice(relay, {
      peerId: BOB_PEER, deviceId: BOB_DEV,
      cryptoStore: bob.cryptoStore, clientStore: bob.clientStore, identity: bob.identity,
      pageSize: 2
    });
    const dispatched: string[] = [];
    bob2.client.onInboundMessage(async (message) => {
      dispatched.push(text(message.plaintext));
      return "accepted_by_agent";
    });
    await bob2.client.sync();
    expect(dispatched).toEqual(["paged 1", "paged 2", "paged 3", "paged 4", "paged 5"]);
    expect(await bob2.client.inbox.cursor()).toBe(5);
  });

  it("records undecryptable input as evidence, still acks, never fabricates plaintext", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    relay.detach(BOB_DEV);
    const entry = await alice.client.sendMessage(BOB_DEV, "tamper target");
    relay.tamperEnvelope(FAKE_ROUTE, BOB_DEV, entry.position ?? 1);
    let dispatched = 0;
    bob.client.onInboundMessage(async () => {
      dispatched += 1;
      return "accepted_by_agent";
    });
    await bob.client.sync();

    expect(dispatched).toBe(0);
    const stored = await bob.client.inbox.list();
    expect(stored.length).toBe(1);
    expect(stored[0].plaintext).toBeNull();
    expect(stored[0].decryptError).toBeTruthy();
    expect(bob.events.decryptFailure.length).toBe(1);
    await alice.client.reconcile();
    expect((await alice.client.outbox.list())[0].state).toBe("received");
  });
});

describe("peer-client receipts + reports", () => {
  it("reports a completed outcome through reports[] as independent agent evidence", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    bob.client.onInboundMessage(async () => "accepted_by_agent");
    const entry = await alice.client.sendMessage(BOB_DEV, "finish me");
    await eventually(() => bob.events.inbound.length === 1);

    await bob.client.reportOutcome(entry.messageId, "completed", new TextEncoder().encode("done"));
    await alice.client.reconcile();
    const final = await alice.client.outbox.entry(entry.messageId);
    expect(final?.state).toBe("completed");
    const completed = final?.receipts.find((receipt) => receipt.kind === "completed");
    expect(completed?.source).toBe("agent");
    expect(completed?.detail).toBeTruthy();
  });

  it("surfaces ack refusals with typed reasons", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    bob.client.onInboundMessage(async () => "accepted_by_agent");
    const entry = await alice.client.sendMessage(BOB_DEV, "expire before report");
    await eventually(() => bob.events.inbound.length === 1);
    relay.truncate(FAKE_ROUTE, BOB_DEV, [entry.position ?? 1], "expired");

    await bob.client.reportOutcome(entry.messageId, "completed");
    await eventually(() => bob.events.ackRefused.length >= 1);
    expect(bob.events.ackRefused[0].refusal).toBe("message_unknown");
  });

  it("survives a restart with queued reports: redelivery dedups, report still lands", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    let dispatched = 0;
    bob.client.onInboundMessage(async () => {
      dispatched += 1;
      return "accepted_by_agent";
    });
    relay.dropNextResponses(BOB_DEV, 1); // the page's peer-ack reply is lost
    const entry = await alice.client.sendMessage(BOB_DEV, "report survives");
    await eventually(() => dispatched === 1);
    await eventually(() => bob.events.error.length >= 1); // the ack timeout surfaced honestly

    // Crash-like restart: cursor stayed back, the queued report stayed durable.
    const restarted = await makeDevice(relay, {
      peerId: BOB_PEER, deviceId: BOB_DEV,
      cryptoStore: bob.cryptoStore, clientStore: bob.clientStore, identity: bob.identity
    });
    restarted.client.onInboundMessage(async () => {
      dispatched += 1;
      return "rejected";
    });
    await restarted.client.resume();
    expect(dispatched).toBe(1); // dedup: no second exposure of committed work

    await alice.client.reconcile();
    const final = await alice.client.outbox.entry(entry.messageId);
    expect(final?.state).toBe("accepted_by_agent");
  });
});

describe("peer-client trust + lifecycle", () => {
  it("blocks delivery on peer_identity_changed until an explicit re-pin", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    bob.client.onInboundMessage(async () => "accepted_by_agent");
    const delivered = await alice.client.sendMessage(BOB_DEV, "trusted");
    expect(delivered.state).toBe("accepted");
    await eventually(() => bob.events.inbound.length === 1);

    // Bob reinstalls: same peerId, fresh identity key, new bundle revision.
    const bobNewStore = createInMemoryPeerCryptoStore();
    const bobNewIdentity = await createPeerIdentity({ localStore: bobNewStore, peerId: BOB_PEER });
    const bobNew = await makeDevice(relay, {
      peerId: BOB_PEER, deviceId: BOB_DEV,
      cryptoStore: bobNewStore, identity: bobNewIdentity
    });
    await bobNew.client.publishBundle();
    const received: string[] = [];
    alice.client.onInboundMessage(async (message) => {
      received.push(text(message.plaintext));
      return "accepted_by_agent";
    });

    await bobNew.client.sendMessage(ALICE_DEV, "new keys, same peer");
    await eventually(() => alice.events.requiresRePair.length === 1);
    expect(alice.events.requiresRePair[0].peerId).toBe(BOB_PEER);
    expect(received.length).toBe(0); // blocked: never dispatched, never auto-repaired
    const failed = await alice.client.inbox.list();
    expect(failed.some((entry) => entry.decryptError === "peer_identity_changed")).toBe(true);

    // Explicit re-pair is the only way through — on BOTH ends. Alice accepts
    // bob's new key; bob re-establishes trust for alice at a new generation,
    // which sweeps his stale ratchet so the next send re-initiates X3DH.
    await alice.client.repinPeer(BOB_PEER, bobNewIdentity.publicKey.serialize());
    await repinPeerIdentity(bobNew.cryptoStore, ALICE_PEER, alice.identity.publicKey.serialize());
    await bobNew.client.sendMessage(ALICE_DEV, "after re-pair");
    await eventually(() => received.length === 1);
    expect(received).toEqual(["after re-pair"]);
  });

  it("replenishes the prekey pool once and publishes on retry", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const alice = await makeDevice(relay, {
      peerId: ALICE_PEER, deviceId: ALICE_DEV,
      prekeyPool: { oneTimeCount: 1, kyberCount: 1 }
    });
    const first = await alice.client.publishBundle();
    expect(first.outcome).toBe("published");
    const second = await alice.client.publishBundle(); // pool drained → replenish → retry
    expect(second.outcome).toBe("superseded");
    expect(second.revision).toBe(2);
  });

  it("refuses bundle publication honestly after revocation", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const alice = await makeDevice(relay, { peerId: ALICE_PEER, deviceId: ALICE_DEV });
    relay.revokeDevice(ALICE_DEV);
    await expect(alice.client.publishBundle())
      .rejects.toSatisfy((error) => isPeerClientError(error, "peer_client_bundle_unavailable"));
    expect(alice.events.bundleRefused.map((event) => event.refusal)).toContain("revoked");
  });

  it("resumes sessions and durable state from file stores across a restart", async () => {
    const relay = new FakePeerRelay();
    relay.pair(FAKE_TENANT, FAKE_ROUTE, ALICE_DEV, BOB_DEV);
    const dir = await mkdtemp(join(tmpdir(), "peer-client-"));
    tempDirs.push(dir);
    const cryptoStore = createFilePeerCryptoStore(join(dir, "crypto"));
    const clientStore = createFilePeerClientStore(join(dir, "client"));
    const identity = await createPeerIdentity({ localStore: cryptoStore, peerId: ALICE_PEER });

    const alice = await makeDevice(relay, {
      peerId: ALICE_PEER, deviceId: ALICE_DEV,
      cryptoStore, clientStore, identity,
      directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER })
    });
    const bob = await makeDevice(relay, { peerId: BOB_PEER, deviceId: BOB_DEV });
    bob.client.onInboundMessage(async () => "accepted_by_agent");
    await alice.client.publishBundle();
    await bob.client.publishBundle();
    const first = await alice.client.sendMessage(BOB_DEV, "before restart");
    expect(first.envelope.headers.messageType).toBe("prekey");
    await eventually(async () => (await bob.client.inbox.list()).length === 1);
    await bob.client.sendMessage(ALICE_DEV, "ack"); // confirms alice's ratchet: later sends are session-typed
    await eventually(async () => (await alice.client.inbox.list()).length === 1);

    // Restart over the same durable state: identity, session, outbox all resume.
    const reloaded = await loadPeerIdentity(cryptoStore);
    expect(reloaded?.peerId).toBe(ALICE_PEER);
    const alice2 = await makeDevice(relay, {
      peerId: ALICE_PEER, deviceId: ALICE_DEV,
      cryptoStore, clientStore, identity: reloaded ?? undefined,
      directory: staticPeerDirectory({ [BOB_DEV]: BOB_PEER })
    });
    await alice2.client.resume();
    const persisted = await alice2.client.outbox.entry(first.messageId);
    expect(persisted?.state).toBe("accepted_by_agent");

    const second = await alice2.client.sendMessage(BOB_DEV, "after restart");
    expect(second.envelope.headers.messageType).toBe("session"); // ratchet resumed, no new handshake
    await eventually(() => bob.events.inbound.length === 2);
    expect(text(bob.events.inbound[1].plaintext)).toBe("after restart");
  });

  it("exposes the peer safety number for out-of-band verification", async () => {
    const relay = new FakePeerRelay();
    const { alice, bob } = await pairedDevices(relay);
    await alice.client.sendMessage(BOB_DEV, "verify me");
    const number = await alice.client.peerSafetyNumberFor(BOB_PEER);
    expect(number).toBeTruthy();
    const binding = await peerIdentityBinding(alice.cryptoStore, BOB_PEER);
    expect(binding?.state).toBe("active");
    // Bob pins alice only on first decrypt — no pin exists before the message lands.
    expect(await bob.client.peerSafetyNumberFor(ALICE_PEER)).toBeNull();
    await eventually(async () => (await bob.client.inbox.list()).length === 1);
    expect(await bob.client.peerSafetyNumberFor(ALICE_PEER)).toBeTruthy();
  });

  it("serves the retention policy advertisement on push and pull", async () => {
    const relay = new FakePeerRelay();
    const { alice } = await pairedDevices(relay);
    const pulled = await alice.client.fetchRetentionPolicy();
    expect(pulled.mailboxMaxItems).toBe(relay.policy.mailboxMaxItems);
    expect(alice.events.retentionPolicy.length).toBe(1);
    expect((await alice.client.retentionPolicy())?.mailboxCapacityBytes).toBe(relay.policy.mailboxCapacityBytes);
  });
});
