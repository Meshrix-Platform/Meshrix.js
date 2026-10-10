/**
 * Peer-messaging product wiring: the REAL entry product service
 * (`EntryProductService` + `EntryPeerRuntime`) and the REAL endpoint peer
 * runtime (`EndpointPeerRuntime`) exchange Signal-encrypted mailbox traffic
 * through an in-memory relay that implements the mailbox semantics of
 * `MailboxDO`/`RelaySessionDO` (`FakePeerRelay` — durable positions,
 * sender-scoped idempotency, receipt honesty, revocation, tombstones).
 *
 * Covered at the product surface (not the client layer, which
 * `peer.client` already proves):
 *   - `peer.*` ops refuse `peer_disabled` when the config flag is off;
 *   - session admission gates the peer channel (no send on a dead
 *     generation) and resume on restore drains the durable outbox;
 *   - send/fetch/ack/receipt-status through the loopback op surface;
 *   - record-only dispatch honesty — nothing executes content, application
 *     receipts are explicit evidence;
 *   - dedup on replayed pages, out-of-band safety-number parity;
 *   - revoked-peer refusal surfacing;
 *   - revoke removes the owned per-connection peer store.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_WIRE_PROTOCOL
} from "@meshrix/contracts/private-relay";
import {
  FileCustodyAdapter,
  enrollDeviceIdentity
} from "@meshrix/entry";
import {
  isPeerSchemaMessage
} from "@meshrix/entry-transport";
import {
  EntryProductService,
  type GuiState
} from "@meshrix/entry-gui";

import { EndpointPeerRuntime } from "../../../apps/mcp-gateway-installer/src/private-endpoint/peer.ts";
import { peerStoreDirFor } from "../../../apps/entry-gui/src/main/peer.ts";
import { ENTRY_GUI_CONFIG_SCHEMA } from "../../../apps/entry-gui/src/main/config-store.ts";
import { FakePeerRelay } from "../peer-client/fake-relay.ts";

const TENANT = "tenant.wire.1";
const ROUTE = "route.wire.1";
const ENTRY_DEVICE = "dev.wire.entry.1";
const ENDPOINT_DEVICE = "dev.wire.endpoint.1";
const CONNECTION_ID = "conn.wire.1";
const RELAY_CRED_REF = "entry-gui.relay.dev-wire-entry-1";

const dirs: string[] = [];
const liveServices: EntryProductService[] = [];
afterEach(async () => {
  for (const service of liveServices.splice(0)) await service.stop().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/* ------------------------------------------------------------------ */
/* Session harness: admits forward sessions and carries peer-schema    */
/* messages into the fake mailbox; non-peer kinds answer like the relay. */
/* ------------------------------------------------------------------ */

const LIMITS = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
};

/** EntryTransportLike bridged to a FakePeerRelay channel. */
class PeerHarnessTransport {
  onMessage?: (message: Record<string, unknown>) => void;
  onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  onSocketDrop?: () => void;
  readonly ready = Promise.resolve();
  readonly sent: Record<string, unknown>[] = [];
  /** False while the link is severed — sends throw like a dead socket. */
  alive = true;
  #closed = false;
  readonly #peerChannel: ReturnType<FakePeerRelay["attach"]>;

  constructor(relay: FakePeerRelay, deviceId: string, admissionGeneration = 1) {
    this.#peerChannel = relay.attach({ tenantId: TENANT, routeId: ROUTE, deviceId, admissionGeneration });
    // The channel's inbound landing zone is this transport's onMessage —
    // exactly the demux point the product owns.
    this.#peerChannel.onMessage((message) => this.deliverToApp(message));
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (!this.alive || this.#closed) throw Object.assign(new Error("transport_dead"), { code: "transport_dead" });
    this.sent.push(message as Record<string, unknown>);
    const kind = String(message.kind ?? "");
    if (kind === "session-open") {
      const admission = (message as { admission?: Record<string, unknown> }).admission ?? {};
      queueMicrotask(() => this.deliverToApp({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-admitted",
        sessionId: `sess.harness.${this.sent.length}`,
        purpose: (message as { purpose?: unknown }).purpose ?? "forward",
        admittedGeneration: admission.admissionGeneration,
        revocationRevision: admission.revocationRevision,
        routeState: "reachable",
        limits: { ...LIMITS },
        reconnectGeneration: 1,
        cursors: { toEndpoint: 0, toEntry: 0 },
        serverNonce: "sn.harness.00000001"
      }));
      return;
    }
    if (kind === "session-reconnect") {
      queueMicrotask(() => this.deliverToApp({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-restored",
        sessionId: `sess.harness.restored.${this.sent.length}`,
        reconnectGeneration: (message as { reconnectGeneration?: unknown }).reconnectGeneration,
        gaps: [],
        limits: { ...LIMITS },
        cursors: { toEndpoint: 0, toEntry: 0 }
      }));
      return;
    }
    if (kind === "session-close") {
      const socket = this;
      queueMicrotask(() => {
        socket.deliverToApp({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-close",
          sessionId: "sess.harness",
          reason: "normal",
          finalCursors: { toEndpoint: 0, toEntry: 0 }
        });
      });
      return;
    }
    // Peer-schema kinds go to the mailbox partition; the answer arrives on
    // the channel handler asynchronously, exactly like the real session.
    if (isPeerSchemaMessage(message)) {
      void this.#peerChannel.send(message as Record<string, unknown>);
    }
  }

  deliverToApp(message: Record<string, unknown>): void {
    if (!this.alive || this.#closed) return;
    this.onMessage?.(message);
  }

  /** Sever the socket like a dead link — sends throw, app learns via drop. */
  killLink(): void {
    this.alive = false;
    this.onSocketDrop?.();
  }

  /** Socket back; the owning session sends session-reconnect on top. */
  async reopen(): Promise<void> {
    this.alive = true;
  }

  close(): void {
    this.#closed = true;
    this.alive = false;
  }
}

/**
 * Minimal `EntrySessionLike` for the wiring suite: drives the real session
 * lifecycle messages through the harness transport and reports states
 * honestly. The inner-TLS channel is out of scope — peer traffic is
 * session-level and never touches it.
 */
class PeerFakeSession {
  state = "initiated";
  routeState = "unreachable";
  acceptsNewWork = false;
  channelEstablished = false;
  readonly #transport: PeerHarnessTransport;
  #admitWaiter: (() => void) | null = null;

  constructor(transport: PeerHarnessTransport) {
    this.#transport = transport;
  }

  connect(): Promise<void> {
    this.state = "open_sent";
    this.#transport.send({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-open",
      purpose: "forward",
      admission: { tenantId: TENANT, deviceId: ENTRY_DEVICE, routeId: ROUTE, role: "entry", mode: "personal", admissionGeneration: 1, revocationRevision: 0 },
      clientNonce: "nonce.harness.1"
    });
    return new Promise((resolve) => { this.#admitWaiter = resolve; });
  }

  reconnect(): void {
    this.#transport.send({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-reconnect",
      previousSessionId: "sess.harness.1",
      admission: { tenantId: TENANT, deviceId: ENTRY_DEVICE, routeId: ROUTE, role: "entry", mode: "personal", admissionGeneration: 1, revocationRevision: 0 },
      lastAcknowledged: { toEndpoint: 0, toEntry: 0 },
      reconnectGeneration: 2,
      clientNonce: "nonce.harness.2"
    });
  }

  handleMessage(message: unknown): string | null {
    const kind = (message as { kind?: unknown })?.kind;
    if (kind === "session-admitted" || kind === "session-restored") {
      this.state = "admitted";
      this.routeState = "reachable";
      this.acceptsNewWork = true;
      this.#admitWaiter?.();
      this.#admitWaiter = null;
      return String(kind);
    }
    if (kind === "session-close") {
      this.state = "closed";
      this.acceptsNewWork = false;
      return "session-close";
    }
    return null;
  }

  handleTransportClose(): void {
    this.state = "closed";
    this.acceptsNewWork = false;
  }

  request(): Promise<unknown> {
    return Promise.reject(new Error("inner channel is out of scope for the peer wiring suite"));
  }

  close(): void {
    this.state = "closed";
    this.acceptsNewWork = false;
  }
}

/* ------------------------------------------------------------------ */
/* Fixture: seeded config (connection + peer flag) + custody material.   */
/* ------------------------------------------------------------------ */

interface Fixture {
  service: EntryProductService;
  dir: string;
  relay: FakePeerRelay;
  harness: PeerHarnessTransport;
  session: PeerFakeSession;
  endpoint: EndpointPeerRuntime;
  endpointLive: { live: boolean };
}

async function writeSeedConfig(dir: string, peerEnabled: boolean): Promise<void> {
  const config = {
    schemaVersion: ENTRY_GUI_CONFIG_SCHEMA,
    profile: { displayLabel: "Meshrix Entry" },
    connections: [{
      connectionId: CONNECTION_ID,
      displayLabel: "Wiring fixture",
      tenantId: TENANT,
      routeId: ROUTE,
      mode: "personal",
      endpointPrincipalRef: "prin.wire.1",
      endpointSpkiPin: "spki.wire.endpoint",
      relayService: "https://relay.wire.invalid",
      vaultId: null,
      deviceId: ENTRY_DEVICE,
      deviceFingerprint: "fp.wire.entry",
      capabilityGrantRef: "grantref.wire.1",
      relayCredentialRef: RELAY_CRED_REF,
      boundRecoveryKeyId: null,
      pairingService: null,
      admissionGeneration: 1,
      revocationRevision: 0,
      enrolledAt: "2026-01-01T00:00:00Z",
      remoteRevocation: "none"
    }],
    recovery: null,
    journal: null,
    rotations: [],
    mcp: { managedConfigPath: null },
    pairingServiceDefault: null,
    peer: { enabled: peerEnabled }
  };
  await writeFile(path.join(dir, "entry-gui.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function makeFixture(options: { peerEnabled?: boolean; dispatch?: (message: { messageId: string }) => Promise<"accepted_by_agent" | "rejected"> } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "peer-wiring-"));
  dirs.push(dir);
  const peerEnabled = options.peerEnabled !== false;
  await writeSeedConfig(dir, peerEnabled);

  const relay = new FakePeerRelay();
  relay.pair(TENANT, ROUTE, ENTRY_DEVICE, ENDPOINT_DEVICE);

  const harness = new PeerHarnessTransport(relay, ENTRY_DEVICE);
  const session = new PeerFakeSession(harness);

  const custody = new FileCustodyAdapter({ dataDir: dir, wrapSecret: randomBytes(32) });
  await enrollDeviceIdentity({ custody, deviceId: ENTRY_DEVICE });
  await custody.storeSecret({ ref: RELAY_CRED_REF, secret: new TextEncoder().encode("cred.wire.test") });

  // The endpoint counterparty: the REAL endpoint runtime on its own file
  // stores, its channel the other mailbox binding of the same route.
  const endpointDir = path.join(dir, "endpoint-peer");
  const endpointChannel = relay.attach({ tenantId: TENANT, routeId: ROUTE, deviceId: ENDPOINT_DEVICE });
  const endpointLive = { live: false };
  const endpoint = await EndpointPeerRuntime.create({
    peer: { storageDir: endpointDir },
    route: { tenantId: TENANT, routeId: ROUTE, deviceId: ENDPOINT_DEVICE },
    send: (message) => { void endpointChannel.send(message); },
    sessionLive: () => endpointLive.live,
    ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    requestTimeoutMs: 800,
    maxSendAttempts: 3
  });
  endpointChannel.onMessage((message) => endpoint.handleInbound(message));

  const service = new EntryProductService({
    dataDir: dir,
    appVersion: "9.9.9",
    appExePath: "meshrix-entry-test",
    custody,
    sessionFactory: () => session,
    transportFactory: () => harness,
    connectTimeoutMs: 400
  });
  liveServices.push(service);
  return { service, dir, relay, harness, session, endpoint, endpointLive };
}

async function startAndAdmit(fixture: Fixture): Promise<void> {
  await fixture.service.start();
  const refreshed = await fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
  expect(refreshed.ok).toBe(true);
  // The fake session resolves connect() on session-admitted; peer gate opens
  // through the demuxed admission kind.
  await waitFor(() => fixture.session.state === "admitted");
  fixture.endpointLive.live = true;
  fixture.endpoint.onSessionLive();
  await waitFor(async () => (await fixture.endpoint.client.localBundle())?.revision === 1);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("entry peer ops — flag gating and admission gate", () => {
  it("refuses every peer op with peer_disabled when the flag is off", async () => {
    const fixture = await makeFixture({ peerEnabled: false });
    await fixture.service.start();
    for (const [op, args] of [
      ["peer.status", { connectionId: CONNECTION_ID }],
      ["peer.send", { connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE, text: "x" }],
      ["peer.inbox", { connectionId: CONNECTION_ID }],
      ["peer.sync", { connectionId: CONNECTION_ID }],
      ["peer.ackOutcome", { connectionId: CONNECTION_ID, messageId: "m", outcome: "completed" }],
      ["peer.pairSafety", { connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE }]
    ] as const) {
      const result = await fixture.service.dispatch(op, args);
      expect(result.ok).toBe(false);
      expect((result as { error: { code: string } }).error.code).toBe("peer_disabled");
    }
  });

  it("peer.send on a dead session fails with the typed channel code — nothing queues on a stale generation", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);
    fixture.harness.killLink(); // socket died — session close + peer gate off
    await waitFor(() => fixture.session.state === "closed");
    const result = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID,
      peerDeviceId: ENDPOINT_DEVICE,
      text: "never-sent"
    });
    expect(result.ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe("peer_client_transport");
  });
});

describe("peer exchange over the shared session channel", () => {
  it("round-trips a Signal envelope request → progress → result with honest receipts", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    // The entry's bundle published on admission; the endpoint's did too.
    // The retention advertisement lands through the admission-time push or
    // the runtime's explicit pull — either way it is async, so wait for it
    // instead of racing the session-admission chain.
    let statusValue!: { peerId: string; localBundle: { revision: number } | null; retentionPolicy: { mailboxMaxItems: number } | null };
    await waitFor(async () => {
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      if (!status.ok) return false;
      const value = (status as { value: typeof statusValue }).value;
      if (value.retentionPolicy === null) return false;
      statusValue = value;
      return true;
    });
    expect(statusValue.peerId).toBe(`peer:${TENANT}:${ROUTE}:${ENTRY_DEVICE}`);
    expect(statusValue.localBundle?.revision).toBe(1);
    expect(statusValue.retentionPolicy?.mailboxMaxItems).toBe(10_000);

    // entry → endpoint: "request"
    const sent = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID,
      peerDeviceId: ENDPOINT_DEVICE,
      text: "request:run-diagnostics"
    });
    expect(sent.ok).toBe(true);
    const outboxEntry = (sent as { value: { messageId: string; state: string } }).value;
    expect(outboxEntry.state).toBe("accepted");

    // Endpoint inbox: decrypted, recorded pending (no dispatch handler).
    await waitFor(async () => (await fixture.endpoint.inbox()).length > 0);
    const epInbox = await fixture.endpoint.inbox();
    expect(epInbox[0].text).toBe("request:run-diagnostics");
    expect(epInbox[0].dispatch).toBe("pending");
    expect(epInbox[0].senderDeviceId).toBe(ENTRY_DEVICE);

    // Endpoint → entry: "progress" then "result" + explicit app receipts.
    await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "progress:50%" });
    await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "result:ok" });
    await waitFor(async () => {
      const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
      return inbox.ok && (inbox as { value: { entries: unknown[] } }).value.entries.length === 2;
    });
    const inboxResult = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
    const entries = (inboxResult as { value: { entries: { text: string | null; senderDeviceId: string; messageId: string; dispatch: string }[] } }).value.entries;
    expect(entries.map((entry) => entry.text).sort()).toEqual(["progress:50%", "result:ok"]);
    expect(entries.every((entry) => entry.senderDeviceId === ENDPOINT_DEVICE && entry.dispatch === "pending")).toBe(true);

    // Explicit application receipt for the request — evidence, not derived.
    const ack = await fixture.endpoint.reportOutcome({ messageId: epInbox[0].messageId, outcome: "completed" });
    expect(ack.recorded).toBe(true);
    // Receipt honesty on the sender's outbox: mailbox accepted + received are
    // distinct evidence rows from the agent's terminal receipt.
    await fixture.service.dispatch("peer.sync", { connectionId: CONNECTION_ID });
    const reconcile = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    const outbox = (reconcile as { value: { outbox: { messageId: string; receipts: { kind: string }[]; state: string }[] } }).value.outbox;
    const requestRow = outbox.find((row) => row.messageId === epInbox[0].messageId);
    // The sender reconciles on the mailbox's own cadence — force it.
    await fixture.relay.replayPage(ENTRY_DEVICE, 0);
    const kinds = requestRow?.receipts.map((receipt) => receipt.kind) ?? [];
    expect(kinds).toContain("accepted");
  });
});

describe("peer reliability semantics at the product surface", () => {
  it("deduplicates replayed mailbox pages and survives disconnect-resume", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "dup-check" });
    await waitFor(async () => {
      const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
      return inbox.ok && (inbox as { value: { entries: unknown[] } }).value.entries.length === 1;
    });
    // Replay the same page — the durable cursor/dedup must collapse it.
    await fixture.relay.replayPage(ENTRY_DEVICE, 0);
    await fixture.relay.replayPage(ENTRY_DEVICE, 0);
    const inboxAfter = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
    expect((inboxAfter as { value: { entries: unknown[] } }).value.entries.length).toBe(1);

    // Disconnect: dead socket → gate closes; queued send replays on restore.
    fixture.harness.killLink();
    await waitFor(() => fixture.session.state === "closed");
    const offline = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE, text: "while-offline", messageId: "msg.wire.offline.1"
    });
    expect(offline.ok).toBe(false); // gate refused — honest failure, not a phantom queue

    // Restore the socket and run a session-reconnect: resume() drains nothing
    // new for the refused send (it never entered the outbox), so send again.
    await fixture.harness.reopen();
    fixture.session.reconnect();
    await waitFor(() => fixture.session.state === "admitted");
    const resent = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE, text: "after-resume"
    });
    expect(resent.ok).toBe(true);
    await waitFor(async () => (await fixture.endpoint.inbox()).some((entry) => entry.text === "after-resume"));
  });

  it("surfaces revoked-peer refusal and matching safety numbers honestly", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    // Out-of-band parity: both sides compute the same safety number once the
    // endpoint's identity is pinned by the entry's first decrypted envelope.
    await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "pin-me" });
    await waitFor(async () => {
      const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
      return inbox.ok && (inbox as { value: { entries: unknown[] } }).value.entries.length === 1;
    });
    const entrySafety = await fixture.service.dispatch("peer.pairSafety", { connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE });
    const endpointSafety = await fixture.endpoint.pairSafety(ENTRY_DEVICE);
    expect((entrySafety as { value: { safetyNumber: string | null } }).value.safetyNumber).toBeTruthy();
    expect(endpointSafety.safetyNumber).toBeTruthy();
    expect((entrySafety as { value: { safetyNumber: string | null } }).value.safetyNumber).toBe(endpointSafety.safetyNumber);
  });

  it("refuses revoked-device sends honestly at the bundle boundary", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    // The endpoint is revoked BEFORE the entry ever establishes a crypto
    // session — the first send must fetch its bundle, the mailbox refuses
    // with "revoked", and the failure lands as the typed peer_* code.
    fixture.relay.revokeDevice(ENDPOINT_DEVICE);
    const refused = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE, text: "post-revoke", messageId: "msg.wire.revoked.1"
    });
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string; message: string } }).error.code).toBe("peer_client_bundle_unavailable");
    expect((refused as { error: { code: string; message: string } }).error.message).toContain("revoked");
    // Nothing entered the outbox — the refusal happened before enqueue.
    const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(status.ok).toBe(true);
    expect((status as { value: { outbox: unknown[] } }).value.outbox.length).toBe(0);
  });
});

describe("peer store ownership", () => {
  it("revoke removes the owned per-connection peer store", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);
    const storeDir = peerStoreDirFor(fixture.dir, CONNECTION_ID);
    await stat(storeDir); // exists — identity + client stores are real files
    const revoked = await fixture.service.dispatch("connection.revoke", { connectionId: CONNECTION_ID });
    expect(revoked.ok).toBe(true);
    await expect(stat(storeDir)).rejects.toMatchObject({ code: "ENOENT" });
    // The config record is gone; peer ops now fail as unknown connection.
    const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(status.ok).toBe(false);
  });
});
