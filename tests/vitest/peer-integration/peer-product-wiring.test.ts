/**
 * Peer-messaging product wiring: the REAL entry product service
 * (`EntryProductService` + `EntryPeerRuntime`) and the REAL endpoint peer
 * runtime (`EndpointPeerRuntime`) exchange Signal-encrypted traffic through
 * the online-only `FakePeerRelay`. Client stores own exact ciphertext,
 * inbox history and signed delivery receipts; the relay retains no business
 * messages or receipt rows.
 *
 * Covered at the product surface (not the client layer, which
 * `peer.client` already proves):
 *   - authenticated personal pairings enable Peer without a manual config flag;
 *   - session admission gates the peer channel and preserves accepted local
 *     work across a dead generation;
 *   - bilateral encrypted sends settle only with recipient-signed receipts;
 *   - record-only dispatch honesty and out-of-band safety-number parity;
 *   - paired-peer refusal before first-contact ciphertext is accepted;
 *   - local disconnect retains the owned per-connection history; unpaired
 *     peers are refused by the online relay boundary.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_WIRE_PROTOCOL,
  peerIdForRouteDevice
} from "@meshrix/contracts/private-relay";
import {
  FileCustodyAdapter,
  enrollDeviceIdentity
} from "@meshrix/entry";
import {
  isPeerSchemaMessage
} from "@meshrix/entry-transport";
import { peerIdentityPublicDescriptor } from "@meshrix/peer-client";
import { createFilePeerCryptoStore, createPeerIdentity } from "@meshrix/peer-crypto";
import {
  EntryProductService
} from "@meshrix/entry-gui";

import { EndpointPeerRuntime } from "../../../apps/mcp-gateway-installer/src/private-endpoint/peer.ts";
import { EntryPeerRuntime, peerStoreDirFor } from "../../../apps/entry-gui/src/main/peer.ts";
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

function allInboxRows<T>(view: { readonly entries: readonly T[]; readonly pendingEntries: readonly T[] }): T[] {
  return [...view.entries, ...view.pendingEntries];
}

/* ------------------------------------------------------------------ */
/* Session harness: admits forward sessions and carries peer-schema     */
/* messages to the online fake relay; non-peer kinds answer like Relay.  */
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
  ready: Promise<void> = Promise.resolve();
  #rejectReady: ((error: Error) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  /** False while the link is severed — sends throw like a dead socket. */
  alive = true;
  #closed = false;
  #holdNextInboundKind: string | null = null;
  #heldInbound: Record<string, unknown> | null = null;
  #rejectNextOpenRevision: number | null = null;
  #sessionId: string | null = null;
  readonly #relay: FakePeerRelay;
  readonly #deviceId: string;
  #peerChannel: ReturnType<FakePeerRelay["attach"]> | null = null;

  constructor(relay: FakePeerRelay, deviceId: string) {
    this.#relay = relay;
    this.#deviceId = deviceId;
  }

  #attachPeerChannel(): void {
    this.#peerChannel = this.#relay.attach({ tenantId: TENANT, routeId: ROUTE, deviceId: this.#deviceId });
    // Establish the fake relay leg only after the owning session is admitted,
    // so exact-peer presence cannot be lost before the product handler exists.
    this.#peerChannel.onMessage((message) => this.deliverToApp(message));
  }

  get closed(): boolean {
    return this.#closed;
  }

  deferOpening(): void {
    this.ready = new Promise<void>((_resolve, reject) => { this.#rejectReady = reject; });
  }

  failOpening(): void {
    this.alive = false;
    this.#rejectReady?.(Object.assign(new Error("fixture_socket_open_failed"), { code: "entry_transport_open_failed" }));
    this.#rejectReady = null;
    this.onSocketClose?.(1006, "", false);
  }

  get heldInboundKind(): string | null {
    return this.#heldInbound === null ? null : String(this.#heldInbound.kind ?? "");
  }

  holdNextInboundKind(kind: string): void {
    this.#holdNextInboundKind = kind;
  }

  rejectNextOpenWithRevision(revision: number): void {
    this.#rejectNextOpenRevision = revision;
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (!this.alive || this.#closed) throw Object.assign(new Error("transport_dead"), { code: "transport_dead" });
    this.sent.push(message as Record<string, unknown>);
    const kind = String(message.kind ?? "");
    if (kind === "session-open") {
      const admission = (message as { admission?: Record<string, unknown> }).admission ?? {};
      const sessionId = `sess.harness.${this.sent.length}`;
      const expectedRevocationRevision = this.#rejectNextOpenRevision;
      if (expectedRevocationRevision !== null) {
        this.#rejectNextOpenRevision = null;
        queueMicrotask(() => {
          this.deliverToApp({
            schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
            wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
            kind: "session-rejected",
            reason: "stale_revocation_revision",
            expectedRevocationRevision,
            retryable: true
          });
          this.close();
        });
        return;
      }
      this.#sessionId = sessionId;
      queueMicrotask(() => this.deliverToApp({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-admitted",
        sessionId,
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
      const sessionId = `sess.harness.restored.${this.sent.length}`;
      this.#sessionId = sessionId;
      queueMicrotask(() => this.deliverToApp({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-restored",
        sessionId,
        reconnectGeneration: (message as { reconnectGeneration?: unknown }).reconnectGeneration,
        gaps: [],
        limits: { ...LIMITS },
        cursors: { toEndpoint: 0, toEntry: 0 }
      }));
      return;
    }
    if (kind === "session-close") {
      const socket = this;
      const sessionId = this.#sessionId;
      if (sessionId === null) return;
      queueMicrotask(() => {
        socket.deliverToApp({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-close",
          sessionId,
          reason: "normal",
          finalCursors: { toEndpoint: 0, toEntry: 0 }
        });
      });
      return;
    }
    // Peer-schema kinds are forwarded only to the currently attached peer;
    // the attempt outcome arrives on this channel asynchronously.
    if (isPeerSchemaMessage(message)) {
      if (!this.#peerChannel) throw Object.assign(new Error("peer_channel_not_admitted"), { code: "peer_channel_not_admitted" });
      void this.#peerChannel.send(message as Record<string, unknown>);
    }
  }

  deliverToApp(message: Record<string, unknown>): void {
    if (!this.alive || this.#closed) return;
    if (message.kind === "session-admitted" || message.kind === "session-restored") this.#attachPeerChannel();
    if (this.#holdNextInboundKind === message.kind) {
      this.#holdNextInboundKind = null;
      this.#heldInbound = message;
      return;
    }
    this.onMessage?.(message);
  }

  /** Sever the socket like a dead link — sends throw, app learns via drop. */
  killLink(): void {
    this.alive = false;
    // A response buffered by the old socket is lost with that transport; it
    // must not be delivered to the newly admitted generation.
    this.#heldInbound = null;
    this.#relay.detach(this.#deviceId, ROUTE, TENANT);
    this.#peerChannel = null;
    this.onSocketDrop?.();
  }

  /** Relay terminal frame closes the transport before any socket-close callback. */
  terminateWithSessionClose(reason: "capacity_exceeded" | "idle_timeout"): void {
    const sessionId = this.#sessionId;
    if (sessionId === null) throw new Error("session_not_admitted");
    this.deliverToApp({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-close",
      sessionId,
      reason,
      finalCursors: { toEndpoint: 0, toEntry: 0 }
    });
    this.close();
  }

  /** Socket back; the owning session sends session-reconnect on top. */
  async reopen(): Promise<void> {
    this.alive = true;
  }

  close(): void {
    this.#closed = true;
    this.alive = false;
    this.#relay.detach(this.#deviceId, ROUTE, TENANT);
    this.#peerChannel = null;
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
  #sessionId: string | null = null;
  readonly #transport: PeerHarnessTransport;
  #admitWaiter: (() => void) | null = null;
  #admitReject: ((error: Error) => void) | null = null;
  #admission: {
    tenantId: string;
    deviceId: string;
    routeId: string;
    role: string;
    mode: string;
    admissionGeneration: number;
    revocationRevision: number;
  } = {
    tenantId: TENANT,
    deviceId: ENTRY_DEVICE,
    routeId: ROUTE,
    role: "entry",
    mode: "personal",
    admissionGeneration: 1,
    revocationRevision: 0
  };

  constructor(transport: PeerHarnessTransport) {
    this.#transport = transport;
  }

  setAdmission(admission: {
    tenantId: string;
    deviceId: string;
    routeId: string;
    role: string;
    mode: string;
    admissionGeneration: number;
    revocationRevision: number;
  }): void {
    this.#admission = { ...admission };
  }

  get revocationRevision(): number {
    return this.#admission.revocationRevision;
  }

  async connect(): Promise<void> {
    // Match EntryRelaySession: preserve and await the original socket readiness.
    await this.#transport.ready;
    this.state = "open_sent";
    this.#transport.send({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-open",
      purpose: "forward",
      admission: this.#admission,
      clientNonce: "nonce.harness.1"
    });
    return new Promise((resolve, reject) => { this.#admitWaiter = resolve; this.#admitReject = reject; });
  }

  reconnect(): void {
    this.#transport.send({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-reconnect",
      previousSessionId: "sess.harness.1",
      admission: this.#admission,
      lastAcknowledged: { toEndpoint: 0, toEntry: 0 },
      reconnectGeneration: 2,
      clientNonce: "nonce.harness.2"
    });
  }

  handleMessage(message: unknown): string | null {
    const kind = (message as { kind?: unknown })?.kind;
    if (kind === "session-admitted" || kind === "session-restored") {
      const sessionId = (message as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string") return null;
      this.#sessionId = sessionId;
      this.state = "admitted";
      this.routeState = "reachable";
      this.acceptsNewWork = true;
      this.#admitWaiter?.();
      this.#admitWaiter = null;
      this.#admitReject = null;
      return String(kind);
    }
    if (kind === "session-rejected") {
      this.state = "rejected";
      this.acceptsNewWork = false;
      this.#admitReject?.(new Error("session-rejected"));
      this.#admitWaiter = null;
      this.#admitReject = null;
      return "session-rejected";
    }
    if (kind === "session-close") {
      const sessionId = (message as { sessionId?: unknown }).sessionId;
      if (this.#sessionId === null || sessionId !== this.#sessionId) return null;
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
    this.#transport.close();
  }
}

/* ------------------------------------------------------------------ */
/* Fixture: an authenticated pairing result + custody material.          */
/* ------------------------------------------------------------------ */

interface Fixture {
  service: EntryProductService;
  dir: string;
  relay: FakePeerRelay;
  harness: PeerHarnessTransport;
  harnesses: PeerHarnessTransport[];
  session: PeerFakeSession;
  sessions: PeerFakeSession[];
  endpoint: EndpointPeerRuntime;
  endpointLive: { live: boolean };
  reconnectEndpoint(): void;
}

async function writeSeedConfig(dir: string, endpointPeerIdentity: ReturnType<typeof peerIdentityPublicDescriptor>): Promise<void> {
  const accountId = "account.wire.1";
  const authEpoch = 1;
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
      endpointDeviceId: ENDPOINT_DEVICE,
      endpointPeerIdentity,
      endpointSpkiPin: "spki.wire.endpoint",
      relayService: "https://relay.wire.invalid",
      vaultId: null,
      deviceId: ENTRY_DEVICE,
      deviceFingerprint: "fp.wire.entry",
      capabilityGrantRef: "grantref.wire.1",
      accountBinding: { accountId, authEpoch },
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
    account: { desktopDeviceId: "desktop.wire.1", accountId, authEpoch, sessionCredentialRef: null }
  };
  await writeFile(path.join(dir, "entry-gui.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function makeFixture(options: {
  dispatch?: (message: { messageId: string }) => Promise<"accepted_by_agent" | "rejected">;
  freshTransportPerRefresh?: boolean;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "peer-wiring-"));
  dirs.push(dir);

  const relay = new FakePeerRelay();
  relay.pair(TENANT, ROUTE, ENTRY_DEVICE, ENDPOINT_DEVICE);

  const harness = new PeerHarnessTransport(relay, ENTRY_DEVICE);
  const session = new PeerFakeSession(harness);
  const harnesses = [harness];
  const sessions = [session];
  let currentHarness = harness;
  let transportFactoryCalls = 0;
  let sessionFactoryCalls = 0;

  const custody = new FileCustodyAdapter({ dataDir: dir, wrapSecret: randomBytes(32) });
  await enrollDeviceIdentity({ custody, deviceId: ENTRY_DEVICE });
  await custody.storeSecret({ ref: RELAY_CRED_REF, secret: new TextEncoder().encode("cred.wire.test") });

  // The endpoint counterparty: the REAL endpoint runtime on its own file
  // stores, attached to the same in-memory online route.
  const endpointDir = path.join(dir, "endpoint-peer");
  const endpointRoute = { tenantId: TENANT, routeId: ROUTE, deviceId: ENDPOINT_DEVICE };
  const entryRoute = { tenantId: TENANT, routeId: ROUTE, deviceId: ENTRY_DEVICE };
  const endpointPeerId = peerIdForRouteDevice(endpointRoute);
  const entryPeerId = peerIdForRouteDevice(entryRoute);
  if (!endpointPeerId || !entryPeerId) throw new Error("peer_wiring_route_identity_invalid");
  const endpointIdentity = await createPeerIdentity({
    localStore: createFilePeerCryptoStore(path.join(endpointDir, "crypto")),
    peerId: endpointPeerId
  });
  const entryStoreDir = peerStoreDirFor(dir, CONNECTION_ID);
  const entryIdentity = await createPeerIdentity({
    localStore: createFilePeerCryptoStore(path.join(entryStoreDir, "crypto")),
    peerId: entryPeerId
  });
  const entryDescriptor = peerIdentityPublicDescriptor(entryIdentity);
  await writeSeedConfig(dir, peerIdentityPublicDescriptor(endpointIdentity));
  let endpointChannel = relay.attach({ tenantId: TENANT, routeId: ROUTE, deviceId: ENDPOINT_DEVICE });
  const endpointLive = { live: false };
  const endpoint = await EndpointPeerRuntime.create({
    peer: { storageDir: endpointDir },
    route: endpointRoute,
    send: (message) => { void endpointChannel.send(message); },
    sessionLive: () => endpointLive.live,
    resolvePeerIdentity: (peerDeviceId) => peerDeviceId === ENTRY_DEVICE ? entryDescriptor : null,
    ...(options.dispatch ? { dispatch: options.dispatch } : {})
  });
  endpointChannel.onMessage((message) => endpoint.handleInbound(message));

  const service = new EntryProductService({
    dataDir: dir,
    appVersion: "9.9.9",
    appExePath: "meshrix-entry-test",
    custody,
    sessionFactory: (sessionOptions) => {
      if (!options.freshTransportPerRefresh || sessionFactoryCalls++ === 0) {
        session.setAdmission(sessionOptions.admission);
        return session;
      }
      const next = new PeerFakeSession(currentHarness);
      next.setAdmission(sessionOptions.admission);
      sessions.push(next);
      return next;
    },
    transportFactory: () => {
      if (!options.freshTransportPerRefresh || transportFactoryCalls++ === 0) return harness;
      currentHarness = new PeerHarnessTransport(relay, ENTRY_DEVICE);
      harnesses.push(currentHarness);
      return currentHarness;
    },
    connectTimeoutMs: 400
  });
  liveServices.push(service);
  const reconnectEndpoint = () => {
    endpoint.onSessionDown();
    relay.detach(ENDPOINT_DEVICE, ROUTE, TENANT);
    endpointChannel = relay.attach({ tenantId: TENANT, routeId: ROUTE, deviceId: ENDPOINT_DEVICE });
    endpointChannel.onMessage((message) => endpoint.handleInbound(message));
    endpointLive.live = true;
    endpoint.onSessionLive();
  };
  return { service, dir, relay, harness, harnesses, session, sessions, endpoint, endpointLive, reconnectEndpoint };
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

async function startWithAutomaticRestore(fixture: Fixture): Promise<void> {
  await fixture.service.start();
  await waitFor(() => fixture.sessions.at(-1)?.state === "admitted");
  fixture.endpointLive.live = true;
  fixture.endpoint.onSessionLive();
  await waitFor(async () => (await fixture.endpoint.client.localBundle())?.revision === 1);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("entry peer ops — personal profile and admission gate", () => {
  it("enables Peer for an authenticated personal pairing without a manual config flag", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);
    const result = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(result.ok).toBe(true);
    expect((result as { value: { peerId: string } }).value.peerId).toBe(`peer:${TENANT}:${ROUTE}:${ENTRY_DEVICE}`);
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

  it("single-flights parallel route refresh and ignores a delayed old socket close", async () => {
    const fixture = await makeFixture({ freshTransportPerRefresh: true });
    await fixture.service.start();

    let releaseCreate!: () => void;
    let enterFirstCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const firstCreateEntered = new Promise<void>((resolve) => { enterFirstCreate = resolve; });
    let createCount = 0;
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      createCount += 1;
      if (createCount === 1) {
        enterFirstCreate();
        await createGate;
      }
      return createRuntime(options);
    });

    try {
      const firstRefresh = fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      await firstCreateEntered;
      // The second call starts while the first runtime creation is held at a
      // deterministic barrier, reproducing startup-restore/pair-finalize overlap.
      const secondRefresh = fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      releaseCreate();
      const [first, second] = await Promise.all([firstRefresh, secondRefresh]);
      expect(first.ok && second.ok).toBe(true);
      expect(createCount).toBe(1);

      const activeBefore = fixture.harnesses.filter((transport) => !transport.closed);
      expect(activeBefore).toHaveLength(1);
      const oldTransport = activeBefore[0]!;
      const delayedOldClose = oldTransport.onSocketDrop;
      expect(delayedOldClose).toBeTypeOf("function");

      const refreshed = await fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      expect(refreshed.ok).toBe(true);
      const currentSession = fixture.sessions.at(-1)!;
      await waitFor(() => currentSession.state === "admitted");
      const activeAfter = fixture.harnesses.filter((transport) => !transport.closed);
      expect(activeAfter).toHaveLength(1);
      expect(activeAfter[0]).not.toBe(oldTransport);

      fixture.endpointLive.live = true;
      fixture.endpoint.onSessionLive();
      await waitFor(async () => (await fixture.endpoint.client.localBundle())?.revision === 1);

      delayedOldClose!();
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      expect(status.ok).toBe(true);
      expect((status as { value: { sessionLive: boolean } }).value.sessionLive).toBe(true);
      const sent = await fixture.service.dispatch("peer.send", {
        connectionId: CONNECTION_ID,
        peerDeviceId: ENDPOINT_DEVICE,
        text: "late-close-gate-check"
      });
      expect(sent.ok).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("rejects a pending bundle control on the real socket-drop hook and resumes the same client after admission", async () => {
    const fixture = await makeFixture();
    const runtimes: EntryPeerRuntime[] = [];
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      const runtime = await createRuntime(options);
      runtimes.push(runtime);
      return runtime;
    });

    try {
      // Let the relay process the first bundle publication but withhold its
      // control response, leaving the actual product-owned client request in
      // flight when the transport closes.
      fixture.harness.holdNextInboundKind("peer-bundle-published");
      await fixture.service.start();
      const refreshed = await fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      expect(refreshed.ok).toBe(true);
      await waitFor(() => fixture.session.state === "admitted"
        && fixture.harness.heldInboundKind === "peer-bundle-published");
      expect(fixture.harness.sent.filter((message) => message.kind === "peer-bundle-publish")).toHaveLength(1);
      expect(runtimes).toHaveLength(1);

      // killLink invokes EntryProductService's attached onSocketDrop callback,
      // which reaches EntryPeerRuntime.onSessionClosed and PeerClient.transportLost.
      fixture.harness.killLink();
      await waitFor(() => fixture.session.state === "closed");
      expect(fixture.harness.heldInboundKind).toBeNull();
      await waitFor(async () => {
        const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
        return status.ok && (status as { value: { events: { kind: string }[] } }).value.events
          .some((event) => event.kind === "bundle_publish_failed");
      });

      await fixture.harness.reopen();
      fixture.session.reconnect();
      await waitFor(() => fixture.session.state === "admitted");
      await waitFor(async () => ((await runtimes[0]!.client.localBundle())?.revision ?? 0) > 0);

      expect(runtimes).toHaveLength(1);
      expect(fixture.harness.sent.filter((message) => message.kind === "peer-bundle-publish").length).toBeGreaterThanOrEqual(2);
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      expect(status.ok).toBe(true);
      expect((status as { value: { sessionLive: boolean; localBundle: { revision: number } | null } }).value).toMatchObject({
        sessionLive: true,
        localBundle: { revision: expect.any(Number) }
      });
    } finally {
      createSpy.mockRestore();
    }
  });

  it("rejects a pending bundle control when explicit refresh retires its session and resumes the same client", async () => {
    const fixture = await makeFixture({ freshTransportPerRefresh: true });
    const runtimes: EntryPeerRuntime[] = [];
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      const runtime = await createRuntime(options);
      runtimes.push(runtime);
      return runtime;
    });

    try {
      fixture.harness.holdNextInboundKind("peer-bundle-published");
      await fixture.service.start();
      const firstRefresh = await fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      expect(firstRefresh.ok).toBe(true);
      await waitFor(() => fixture.sessions[0]?.state === "admitted"
        && fixture.harness.heldInboundKind === "peer-bundle-published");
      expect(runtimes).toHaveLength(1);

      // Retiring a still-live session must reject its outstanding Peer control
      // request before the old generation callback is fenced out. The route
      // keeps its Peer client and resumes publication over the replacement.
      const secondRefresh = await fixture.service.dispatch("connection.refresh", { connectionId: CONNECTION_ID });
      expect(secondRefresh.ok).toBe(true);
      const currentSession = fixture.sessions.at(-1)!;
      const currentTransport = fixture.harnesses.at(-1)!;
      await waitFor(() => currentSession.state === "admitted"
        && currentTransport.sent.some((message) => message.kind === "peer-bundle-publish"));
      await waitFor(async () => ((await runtimes[0]!.client.localBundle())?.revision ?? 0) > 0);
      await waitFor(async () => {
        const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
        return status.ok && (status as { value: { events: { kind: string }[] } }).value.events
          .some((event) => event.kind === "bundle_publish_failed");
      });

      expect(fixture.harness.closed).toBe(true);
      expect(fixture.harness.heldInboundKind).toBe("peer-bundle-published");
      expect(currentTransport).not.toBe(fixture.harness);
      expect(runtimes).toHaveLength(1);
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      expect(status.ok).toBe(true);
      expect((status as { value: { sessionLive: boolean; localBundle: { revision: number } | null } }).value).toMatchObject({
        sessionLive: true,
        localBundle: { revision: expect.any(Number) }
      });
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("entry relay recovery", () => {
  it("recovers when socket readiness fails before delayed Peer initialization installs close handlers", async () => {
    const fixture = await makeFixture({ freshTransportPerRefresh: true });
    fixture.harness.deferOpening();
    const originalReadyFailure = fixture.harness.ready.catch((error: unknown) => error);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    const runtimes: EntryPeerRuntime[] = [];
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      await gate;
      const runtime = await createRuntime(options);
      runtimes.push(runtime);
      return runtime;
    });
    try {
      await fixture.service.start();
      await waitFor(() => createSpy.mock.calls.length === 1);
      expect(fixture.harness.onSocketClose).toBeUndefined();
      fixture.harness.failOpening();
      expect(await originalReadyFailure).toMatchObject({ code: "entry_transport_open_failed" });
      release();
      await waitFor(() => fixture.sessions.length === 2 && fixture.sessions[1]?.state === "admitted");
      await waitFor(async () => ((await runtimes[0]?.client.localBundle())?.revision ?? 0) > 0);
      expect(fixture.harness.closed).toBe(true);
      expect(fixture.harness.sent).toHaveLength(0);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(runtimes).toHaveLength(1);
    } finally {
      release();
      await fixture.service.stop();
      createSpy.mockRestore();
    }
  });

  it("drains delayed local Peer initialization on stop without activating an already admitted session", async () => {
    const fixture = await makeFixture({ freshTransportPerRefresh: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    let closedRuntime = false;
    let admissionCalls = 0;
    let createCalls = 0;
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      if (++createCalls === 1) throw new Error("fixture_initial_store_unavailable");
      await gate;
      const runtime = await createRuntime(options);
      const admitted = runtime.onSessionAdmitted.bind(runtime);
      vi.spyOn(runtime, "onSessionAdmitted").mockImplementation(() => {
        admissionCalls += 1;
        return admitted();
      });
      const close = runtime.close.bind(runtime);
      vi.spyOn(runtime, "close").mockImplementation(async () => {
        await close();
        closedRuntime = true;
      });
      return runtime;
    });
    try {
      await fixture.service.start();
      await waitFor(() => fixture.session.state === "admitted");
      const status = fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      await waitFor(() => createSpy.mock.calls.length === 2);
      let stopped = false;
      const stopping = fixture.service.stop().then(() => { stopped = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await stopping;
      await status;
      expect(closedRuntime).toBe(true);
      expect(fixture.harness.closed).toBe(true);
      expect(fixture.harness.sent.some((message) => String(message.kind).startsWith("peer-"))).toBe(false);
      expect(admissionCalls).toBe(0);
      expect(fixture.harnesses).toHaveLength(1);
      expect(createSpy).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await fixture.service.stop();
      createSpy.mockRestore();
    }
  });

  it("retries a relay-provided stale revision without waiting for a socket-close callback", async () => {
    const fixture = await makeFixture({ freshTransportPerRefresh: true });
    fixture.harness.rejectNextOpenWithRevision(3);
    await fixture.service.start();

    await waitFor(() => fixture.sessions.length > 1 && fixture.sessions.at(-1)?.state === "admitted");
    expect(fixture.session.state).toBe("closed");
    expect(fixture.sessions.at(-1)?.revocationRevision).toBe(3);
    expect(fixture.harnesses.at(-1)?.sent.find((message) => message.kind === "session-open")?.admission)
      .toMatchObject({ revocationRevision: 3 });
  });

  it("reconnects after a capacity close and replays the same pending ciphertext through the same Peer runtime", async () => {
    let dispatches = 0;
    const fixture = await makeFixture({
      freshTransportPerRefresh: true,
      dispatch: async () => {
        dispatches += 1;
        return "accepted_by_agent";
      }
    });
    const runtimes: EntryPeerRuntime[] = [];
    const createRuntime = EntryPeerRuntime.create.bind(EntryPeerRuntime);
    const createSpy = vi.spyOn(EntryPeerRuntime, "create").mockImplementation(async (options) => {
      const runtime = await createRuntime(options);
      runtimes.push(runtime);
      return runtime;
    });

    try {
      await startWithAutomaticRestore(fixture);
      fixture.relay.dropNextDeliveryAcks(ENTRY_DEVICE, 1);
      const sent = await fixture.service.dispatch("peer.send", {
        connectionId: CONNECTION_ID,
        peerDeviceId: ENDPOINT_DEVICE,
        text: "recover-after-capacity-close",
        messageId: "msg.wire.capacity-recovery.1"
      });
      expect(sent.ok).toBe(true);
      await waitFor(() => dispatches === 1 && fixture.relay.deliveryAckAttempts.length === 1);
      expect((sent as { value: { state: string } }).value.state).toBe("pending");

      fixture.harness.terminateWithSessionClose("capacity_exceeded");
      await waitFor(() => fixture.sessions.length > 1 && fixture.sessions.at(-1)?.state === "admitted");
      await waitFor(async () => {
        const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
        return status.ok && (status as { value: { outbox: { messageId: string; state: string }[] } }).value.outbox
          .some((entry) => entry.messageId === "msg.wire.capacity-recovery.1" && entry.state === "delivered");
      });

      const attempts = fixture.relay.sendAttempts.filter((attempt) => attempt.messageId === "msg.wire.capacity-recovery.1");
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(attempts.every((attempt) => JSON.stringify(attempt.envelope) === JSON.stringify(attempts[0]?.envelope))).toBe(true);
      expect(fixture.relay.deliveryAckAttempts.length).toBeGreaterThanOrEqual(2);
      expect(dispatches).toBe(1);
      expect(runtimes).toHaveLength(1);
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("peer exchange over the shared session channel", () => {
  it("routes encrypted messages both ways and settles only from the recipient-signed ACK", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(status.ok).toBe(true);
    expect((status as { value: { localBundle: { revision: number } | null } }).value.localBundle?.revision).toBe(1);
    expect((await fixture.endpoint.status()).sessionLive).toBe(true);

    const sent = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID,
      peerDeviceId: ENDPOINT_DEVICE,
      text: "request:run-diagnostics",
      messageId: "msg.wire.request.1"
    });
    expect(sent.ok).toBe(true);
    expect((sent as { value: { state: string } }).value.state).toBe("pending");

    await waitFor(async () => allInboxRows(await fixture.endpoint.inbox()).length === 1);
    const endpointInbox = await fixture.endpoint.inbox();
    const endpointRows = allInboxRows(endpointInbox);
    expect(endpointRows[0]?.text).toBe("request:run-diagnostics");
    expect(endpointRows[0]?.senderDeviceId).toBe(ENTRY_DEVICE);
    expect(endpointRows[0]?.dispatch).toBe("pending");

    await waitFor(async () => {
      const current = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      if (!current.ok) return false;
      const row = (current as { value: { outbox: { messageId: string; state: string; deliveryAck: { signature: string } | null }[] } }).value.outbox
        .find((entry) => entry.messageId === "msg.wire.request.1");
      return row?.state === "delivered" && row.deliveryAck !== null;
    });
    const settled = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    const request = (settled as { value: { outbox: { messageId: string; deliveryAck: { signature: string } | null }[] } }).value.outbox
      .find((entry) => entry.messageId === "msg.wire.request.1");
    expect(request?.deliveryAck?.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);

    const reply = await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "result:ok" });
    await waitFor(async () => {
      const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
      return inbox.ok && (inbox as { value: { entries: { messageId: string; text: string | null; transportReceived: boolean }[] } }).value.entries
        .some((entry) => entry.messageId === reply.messageId && entry.text === "result:ok" && entry.transportReceived);
    });

    const entrySafety = await fixture.service.dispatch("peer.pairSafety", { connectionId: CONNECTION_ID, peerDeviceId: ENDPOINT_DEVICE });
    const endpointSafety = await fixture.endpoint.pairSafety(ENTRY_DEVICE);
    expect((entrySafety as { value: { safetyNumber: string | null } }).value.safetyNumber).toBeTruthy();
    expect((entrySafety as { value: { safetyNumber: string | null } }).value.safetyNumber).toBe(endpointSafety.safetyNumber);
  });
});

describe("peer reliability at the product boundary", () => {
  it("retains an accepted ciphertext while offline and retries the same identity after reconnect", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);

    fixture.relay.dropNextDeliveryAcks(ENTRY_DEVICE, 1);
    const accepted = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID,
      peerDeviceId: ENDPOINT_DEVICE,
      text: "accepted-before-link-loss",
      messageId: "msg.wire.offline.1"
    });
    expect(accepted.ok).toBe(true);
    expect((accepted as { value: { messageId: string; state: string } }).value).toMatchObject({
      messageId: "msg.wire.offline.1",
      state: "pending"
    });
    await waitFor(async () => allInboxRows(await fixture.endpoint.inbox()).some((entry) => entry.messageId === "msg.wire.offline.1"));
    await waitFor(() => fixture.relay.deliveryAckAttempts.length === 1);
    const original = fixture.relay.sendAttempts.find((message) => message.messageId === "msg.wire.offline.1");
    expect(original).toBeDefined();

    fixture.harness.killLink();
    await waitFor(() => fixture.session.state === "closed");
    const stillPending = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(stillPending.ok).toBe(true);
    expect((stillPending as { value: { pendingOutbox: { messageId: string; state: string }[] } }).value.pendingOutbox)
      .toContainEqual(expect.objectContaining({ messageId: "msg.wire.offline.1", state: "pending" }));

    await fixture.harness.reopen();
    fixture.session.reconnect();
    await waitFor(() => fixture.session.state === "admitted");
    await waitFor(async () => allInboxRows(await fixture.endpoint.inbox()).some((entry) => entry.messageId === "msg.wire.offline.1"));
    await waitFor(async () => {
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      return status.ok && (status as { value: { outbox: { messageId: string; state: string }[] } }).value.outbox
        .some((entry) => entry.messageId === "msg.wire.offline.1" && entry.state === "delivered");
    });

    const sends = fixture.relay.sendAttempts.filter((message) => message.messageId === "msg.wire.offline.1");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends.every((message) => JSON.stringify(message.envelope) === JSON.stringify(original?.envelope))).toBe(true);
    expect(fixture.relay.deliveryAckAttempts.length).toBeGreaterThanOrEqual(2);
    expect(allInboxRows(await fixture.endpoint.inbox()).filter((entry) => entry.messageId === "msg.wire.offline.1")).toHaveLength(1);
  });

  it("replays the stored signed ACK after recipient reconnect without repeating paid dispatch", async () => {
    let dispatches = 0;
    const fixture = await makeFixture({
      dispatch: async () => {
        dispatches += 1;
        return "accepted_by_agent";
      }
    });
    await startAndAdmit(fixture);
    fixture.relay.dropNextDeliveryAcks(ENTRY_DEVICE, 2);

    const sent = await fixture.service.dispatch("peer.send", {
      connectionId: CONNECTION_ID,
      peerDeviceId: ENDPOINT_DEVICE,
      text: "paid-work-once",
      messageId: "msg.wire.paid.1"
    });
    expect(sent.ok).toBe(true);
    await waitFor(() => dispatches === 1 && fixture.relay.deliveryAckAttempts.length === 1);
    expect((sent as { value: { state: string } }).value.state).toBe("pending");

    fixture.reconnectEndpoint();
    await waitFor(async () => {
      const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
      return status.ok && (status as { value: { outbox: { messageId: string; state: string }[] } }).value.outbox
        .some((entry) => entry.messageId === "msg.wire.paid.1" && entry.state === "delivered");
    });

    const sends = fixture.relay.sendAttempts.filter((message) => message.messageId === "msg.wire.paid.1");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends.every((message) => JSON.stringify(message.envelope) === JSON.stringify(sends[0]?.envelope))).toBe(true);
    expect(fixture.relay.deliveryAckAttempts.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(fixture.relay.deliveryAckAttempts[0])).toBe(JSON.stringify(fixture.relay.deliveryAckAttempts.at(-1)));
    expect(dispatches).toBe(1);
    expect((await fixture.endpoint.inbox()).entries.filter((entry) => entry.messageId === "msg.wire.paid.1")).toHaveLength(1);
  });
});

describe("peer store ownership", () => {
  it("disconnect closes the live route but retains local inbox history", async () => {
    const fixture = await makeFixture();
    await startAndAdmit(fixture);
    const storeDir = peerStoreDirFor(fixture.dir, CONNECTION_ID);
    await stat(storeDir);
    await fixture.endpoint.sendMessage({ peerDeviceId: ENTRY_DEVICE, text: "retained-history" });
    await waitFor(async () => {
      const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
      return inbox.ok && (inbox as { value: { entries: { text: string | null }[] } }).value.entries
        .some((entry) => entry.text === "retained-history");
    });

    const disconnected = await fixture.service.dispatch("connection.disconnect", { connectionId: CONNECTION_ID });
    expect(disconnected.ok).toBe(true);
    await stat(storeDir);
    const status = await fixture.service.dispatch("peer.status", { connectionId: CONNECTION_ID });
    expect(status.ok).toBe(true);
    expect((status as { value: { sessionLive: boolean } }).value.sessionLive).toBe(false);
    const inbox = await fixture.service.dispatch("peer.inbox", { connectionId: CONNECTION_ID });
    expect((inbox as { value: { entries: { text: string | null }[] } }).value.entries
      .some((entry) => entry.text === "retained-history")).toBe(true);
  });
});
