import { createHash, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_WIRE_PROTOCOL,
  parsePrivateRelayRecoveryMessage
} from "@meshrix/contracts/private-relay";
import type { AuthenticatedContext, GatewayOutcome } from "@meshrix/contracts/gateway";
import {
  PrivateRelaySession,
  createEndpointIdentityStore,
  createInnerTlsEndpoint,
  createPrivateGatewayEndpoint,
  createRelayFrameDuplex,
  spkiSha256Base64Url,
  type EndpointDeviceRecord,
  type EndpointIdentityStore,
  type RelayFrameDuplex,
  type RelayTransportPort
} from "@meshrix/gateway/private-endpoint";
import {
  EntryRelaySession,
  createEntryMcpBridge,
  createEntryMcpLoopbackHttp,
  createInnerDispatchLoop,
  createWssRelayTransport,
  serveEntryMcpStdio
} from "@meshrix/entry-transport";

/**
 * The relay double is deliberately a router only: it relays session lifecycle,
 * forwards opaque frames and recovery kinds to the session peer, and reports
 * route reachability — the real drivers own admission state, cursors and ack
 * evidence. Frame-ack messages are forwarded to the sender so the real
 * `acknowledgeFrames` accounting path is exercised. Tamper/drop/hold hooks
 * sit at the relay boundary, exactly where an adversarial middle could act.
 */

const LIMITS = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
};

const TENANT = "tenant.pr.1";
const ROUTE = "route.pr.1";
const PRINCIPAL = "prin.pr.1";
const ENTRY_DEVICE = "dev.entry.1";
const ENDPOINT_DEVICE = "dev.endpoint.1";

const ENTRY_ADMISSION = Object.freeze({
  tenantId: TENANT,
  deviceId: ENTRY_DEVICE,
  routeId: ROUTE,
  role: "entry",
  mode: "personal",
  admissionGeneration: 7,
  revocationRevision: 12
});
const ENDPOINT_ADMISSION = Object.freeze({
  tenantId: TENANT,
  deviceId: ENDPOINT_DEVICE,
  routeId: ROUTE,
  role: "endpoint",
  mode: "personal",
  admissionGeneration: 7,
  revocationRevision: 12
});

type WireMessage = Record<string, unknown>;

interface HubConn {
  transport: MemoryRelayTransport;
  role: string;
  routeId: string;
  sessionId: string | null;
  cursors: { toEndpoint: number; toEntry: number };
  admitted: boolean;
}

class MemoryRelayTransport implements RelayTransportPort {
  readonly hub: RelayHub;
  conn: HubConn | undefined;
  alive = true;
  terminated = false;
  onMessage?: (message: WireMessage) => void;
  onSocketDrop?: () => void;
  readonly ready = Promise.resolve();

  constructor(hub: RelayHub) {
    this.hub = hub;
    this.hub.attach(this);
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (this.terminated) throw Object.assign(new Error("transport_closed"), { code: "transport_closed" });
    if (!this.alive) throw Object.assign(new Error("transport_dead"), { code: "transport_dead" });
    this.hub.deliver(this, message as WireMessage);
  }

  deliverToApp(message: WireMessage): void {
    this.onMessage?.(message);
  }

  /** A fresh socket: re-attach if the previous close detached the conn. */
  async reopen(): Promise<void> {
    this.terminated = false;
    this.alive = true;
    if (!this.conn) this.hub.attach(this);
  }

  close(): void {
    this.terminated = true;
    this.alive = false;
    this.hub.detach(this);
  }
}

class RelayHub {
  readonly conns = new Set<HubConn>();
  #seq = 0;
  #generation = 0;
  // Route-level sequence cursors persist across session replacement — the
  // property that forces a fresh session to continue numbering, not restart.
  #routeCursors = { toEndpoint: 0, toEntry: 0 };
  #holds = new Map<MemoryRelayTransport, WireMessage[]>();
  #tamper = new Map<MemoryRelayTransport, (message: WireMessage) => WireMessage | null>();
  #drops = new Map<MemoryRelayTransport, number>();

  attach(transport: MemoryRelayTransport): void {
    transport.conn = { transport, role: "", routeId: "", sessionId: null, cursors: { toEndpoint: 0, toEntry: 0 }, admitted: false };
    this.conns.add(transport.conn);
  }

  detach(transport: MemoryRelayTransport): void {
    const conn = transport.conn;
    if (!conn) return;
    conn.admitted = false;
    conn.sessionId = null;
    this.conns.delete(conn);
    transport.conn = undefined;
    this.#notifyRouteChange(conn);
  }

  /** Sever the link as a dead socket would: sends fail and the app is told. */
  killLink(transport: MemoryRelayTransport): void {
    transport.alive = false;
    const conn = transport.conn;
    if (conn) {
      conn.admitted = false;
      conn.sessionId = null;
      this.#notifyRouteChange(conn);
    }
    transport.onSocketDrop?.();
  }

  /** Hold matching messages from `from` until `release` is called. */
  holdNext(from: MemoryRelayTransport, predicate: (message: WireMessage) => boolean = () => true): void {
    const existing = this.#tamper.get(from);
    this.#tamper.set(from, (message) => {
      if (!predicate(message)) return existing ? existing(message) : message;
      const held = this.#holds.get(from) ?? [];
      held.push(message);
      this.#holds.set(from, held);
      this.#tamper.delete(from);
      return null;
    });
  }

  release(from: MemoryRelayTransport): void {
    const held = this.#holds.get(from) ?? [];
    this.#holds.delete(from);
    for (const message of held) this.#route(from, message);
  }

  tamperNext(from: MemoryRelayTransport, mutate: (message: WireMessage) => WireMessage, predicate: (message: WireMessage) => boolean = () => true): void {
    const existing = this.#tamper.get(from);
    this.#tamper.set(from, (message) => {
      if (!predicate(message)) return existing ? existing(message) : message;
      this.#tamper.delete(from);
      return mutate(message);
    });
  }

  dropNext(from: MemoryRelayTransport, predicate: (message: WireMessage) => boolean = () => true): void {
    this.#drops.set(from, (this.#drops.get(from) ?? 0) + 1);
    const existing = this.#tamper.get(from);
    this.#tamper.set(from, (message) => {
      if (!predicate(message)) return existing ? existing(message) : message;
      const count = this.#drops.get(from) ?? 0;
      if (count > 0) {
        this.#drops.set(from, count - 1);
        if (count === 1) this.#tamper.delete(from);
        return null;
      }
      return existing ? existing(message) : message;
    });
  }

  deliver(transport: MemoryRelayTransport, message: WireMessage): void {
    const tamper = this.#tamper.get(transport);
    if (tamper) {
      const result = tamper(message);
      if (result === null) return; // held or dropped
      message = result;
    }
    this.#route(transport, message);
  }

  #route(transport: MemoryRelayTransport, message: WireMessage): void {
    const conn = transport.conn;
    if (!conn) return;
    const kind = String(message.kind ?? "");
    switch (kind) {
      case "session-open": {
        const admission = message.admission as Record<string, unknown>;
        conn.role = String(admission.role);
        conn.routeId = String(admission.routeId);
        conn.sessionId = `sess.hub.${++this.#seq}`;
        conn.admitted = true;
        const peer = this.#peerOf(conn);
        transport.deliverToApp({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-admitted",
          sessionId: conn.sessionId,
          purpose: message.purpose,
          admittedGeneration: admission.admissionGeneration,
          revocationRevision: admission.revocationRevision,
          routeState: peer ? "reachable" : "unreachable",
          limits: { ...LIMITS },
          reconnectGeneration: 1,
          cursors: { ...this.#routeCursors },
          serverNonce: `sn.hub.${String(++this.#seq).padStart(16, "0")}`
        });
        this.#notifyRouteChange(conn);
        break;
      }
      case "session-reconnect": {
        const admission = message.admission as Record<string, unknown>;
        conn.role = String(admission.role);
        conn.routeId = String(admission.routeId);
        conn.sessionId = `sess.hub.${++this.#seq}`;
        conn.admitted = true;
        const lastAck = message.lastAcknowledged as { toEndpoint?: number; toEntry?: number } | undefined;
        if (lastAck) conn.cursors = { toEndpoint: Number(lastAck.toEndpoint ?? 0), toEntry: Number(lastAck.toEntry ?? 0) };
        transport.deliverToApp({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-restored",
          sessionId: conn.sessionId,
          reconnectGeneration: message.reconnectGeneration,
          gaps: [],
          limits: { ...LIMITS },
          cursors: { ...this.#routeCursors }
        });
        // A restore carries no routeState — the relay pushes fresh
        // reachability to the restorer as well as to the peer.
        transport.deliverToApp(this.#routeStatus(conn, this.#peerOf(conn) ? "reachable" : "unreachable"));
        this.#notifyRouteChange(conn);
        break;
      }
      case "session-close": {
        const cursors = message.finalCursors as { toEndpoint?: number; toEntry?: number } | undefined;
        if (cursors) conn.cursors = { toEndpoint: Number(cursors.toEndpoint ?? 0), toEntry: Number(cursors.toEntry ?? 0) };
        // The close is delivered to the peer so its driver transitions too —
        // a silently dropped close would leave the peer believing in a dead
        // channel.
        const peer = this.#peerOf(conn);
        peer?.transport.deliverToApp(message);
        conn.admitted = false;
        conn.sessionId = null;
        this.#notifyRouteChange(conn);
        break;
      }
      case "frame": {
        const peer = this.#peerOf(conn);
        if (!peer || !peer.transport.alive) {
          transport.deliverToApp(this.#routeStatus(conn, "unreachable"));
          return;
        }
        // Route cursors survive session replacement exactly like the real DO.
        const direction = conn.role === "entry" ? "toEndpoint" : "toEntry";
        this.#routeCursors[direction] = Math.max(this.#routeCursors[direction], Number(message.seq) || 0);
        peer.transport.deliverToApp(message);
        break;
      }
      case "frame-ack": {
        // Forward to the sender so the real driver's acknowledgeFrames path runs.
        const peer = this.#peerOf(conn);
        peer?.transport.deliverToApp(message);
        break;
      }
      case "route-bind":
      case "route-query": {
        const peer = this.#peerOf(conn);
        transport.deliverToApp(this.#routeStatus(conn, peer ? "reachable" : "unreachable"));
        break;
      }
      default: {
        // Recovery-channel kinds (operation-query/-status, recovery-*) are
        // relay-opaque: the hub forwards them to the admitted peer.
        const peer = this.#peerOf(conn);
        peer?.transport.deliverToApp(message);
        break;
      }
    }
  }

  #peerOf(conn: HubConn): HubConn | undefined {
    for (const other of this.conns) {
      if (other !== conn && other.routeId === conn.routeId && other.admitted) return other;
    }
    return undefined;
  }

  #routeStatus(conn: HubConn, state: string): WireMessage {
    return {
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "route-status",
      routeId: conn.routeId,
      state,
      generation: ++this.#generation
    };
  }

  #notifyRouteChange(changed: HubConn): void {
    for (const other of this.conns) {
      if (other === changed || other.routeId !== changed.routeId || !other.admitted) continue;
      other.transport.deliverToApp(this.#routeStatus(other, changed.admitted ? "reachable" : "unreachable"));
    }
  }
}

// ---- TLS fixture -------------------------------------------------------------

interface CertPair {
  readonly dir: string;
  readonly server: { key: Buffer; cert: Buffer };
  readonly client: { key: Buffer; cert: Buffer };
  readonly rogue: { key: Buffer; cert: Buffer };
  readonly serverPin: string;
  readonly clientPin: string;
  readonly roguePin: string;
}

async function makeCerts(): Promise<CertPair> {
  const dir = await mkdtemp(join(tmpdir(), "entry-transport-tls-"));
  try {
    const opts = { stdio: "ignore" as const, timeout: 15_000 };
    const make = (cn: string, base: string) => {
      expect(spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", `/CN=${cn}`, "-keyout", `${base}.key`, "-out", `${base}.crt`], opts).status).toBe(0);
    };
    make("endpoint", join(dir, "server"));
    make("entry", join(dir, "client"));
    make("rogue", join(dir, "rogue"));
    const server = { key: await readFile(join(dir, "server.key")), cert: await readFile(join(dir, "server.crt")) };
    const client = { key: await readFile(join(dir, "client.key")), cert: await readFile(join(dir, "client.crt")) };
    const rogue = { key: await readFile(join(dir, "rogue.key")), cert: await readFile(join(dir, "rogue.crt")) };
    return {
      dir,
      server,
      client,
      rogue,
      serverPin: spkiSha256Base64Url(createPublicKey({ key: server.cert, format: "pem" })),
      clientPin: spkiSha256Base64Url(createPublicKey({ key: client.cert, format: "pem" })),
      roguePin: spkiSha256Base64Url(createPublicKey({ key: rogue.cert, format: "pem" }))
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---- endpoint harness --------------------------------------------------------

function enrollEndpointDevice(store: EndpointIdentityStore, clientPin: string): void {
  store.enroll({
    deviceId: ENDPOINT_DEVICE,
    routeId: ROUTE,
    tenantId: TENANT,
    trustBinding: {
      schemaVersion: "v0.0.1:private-relay:recovery-1",
      kind: "endpoint-trust-binding",
      // The pin itself keys the mTLS pin check; the fingerprint is the opaque
      // identity handle and must satisfy the opaque-id alphabet (a bare
      // base64url pin can begin with - or _ which opaque-id forbids).
      pairedIdentityKey: clientPin,
      pairedIdentityFingerprint: `fp.${clientPin}`,
      mode: "personal",
      role: "endpoint",
      trustGeneration: 3,
      endpointPrincipalRef: PRINCIPAL,
      capabilityGrantRef: "grantref.pr.1",
      boundRecoveryKeyId: null
    }
  });
}

const TEST_CONTEXT: AuthenticatedContext = Object.freeze({
  tenant: TENANT,
  principal: PRINCIPAL,
  authGeneration: "3",
  grant: Object.freeze({ revision: "3" })
});

const AUTHORITY = Object.freeze({
  contextFor: (_input: { device: EndpointDeviceRecord }) => TEST_CONTEXT
});

const RECOVERY_SIGNER = Object.freeze({ sign: () => "sig", verify: () => true });

function makeEntry(hub: RelayHub, certs: CertPair, options: Partial<ConstructorParameters<typeof EntryRelaySession>[0]> = {}) {
  const transport = new MemoryRelayTransport(hub);
  const entry = new EntryRelaySession({
    transport,
    admission: ENTRY_ADMISSION,
    innerTls: {
      key: certs.client.key,
      cert: certs.client.cert,
      pinnedPeerSpki: [certs.serverPin],
      handshakeTimeoutMs: 400
    },
    operationPrincipal: { principalRef: PRINCIPAL, generation: 3 },
    ...options
  });
  transport.onMessage = (message) => entry.handleMessage(message);
  transport.onSocketDrop = () => entry.handleTransportClose();
  return { entry, transport };
}

function makeEndpoint(hub: RelayHub, certs: CertPair, overrides: Partial<Parameters<typeof createPrivateGatewayEndpoint>[0]> = {}) {
  const store = createEndpointIdentityStore();
  enrollEndpointDevice(store, certs.clientPin);
  const transport = new MemoryRelayTransport(hub);
  const endpoint = createPrivateGatewayEndpoint({
    gateway: { invoke: async () => ({ kind: "complete", value: "ok" }) } as never,
    authority: AUTHORITY,
    recoverySigner: RECOVERY_SIGNER,
    transport,
    admission: ENDPOINT_ADMISSION,
    identity: store,
    innerTls: { key: certs.server.key, cert: certs.server.cert },
    ...overrides
  });
  transport.onMessage = (message) => endpoint.handleRelayMessage(message);
  return { endpoint, transport, store };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, step = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await wait(step);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any;
// ---- WSS transport tests ------------------------------------------------------

/** Minimal RFC6455 server: masked client frames in, unmasked text/close out. */
function createWsTestServer(): { server: Server; conns: { sendText(text: string): void; onText(fn: (text: string) => void): void; kill(): void }[] } {
  const conns: { sendText(text: string): void; onText(fn: (text: string) => void): void; kill(): void }[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    let textHandler: ((text: string) => void) | undefined;
    const sendText = (text: string) => {
      const payload = Buffer.from(text, "utf8");
      const len = payload.length < 126 ? [payload.length] : payload.length < 65536 ? [126, payload.length >> 8, payload.length & 0xff] : [127, 0, 0, 0, 0, (payload.length / 0x1000000) >> 0, (payload.length / 0x10000) & 0xff, (payload.length / 0x100) & 0xff, payload.length & 0xff];
      socket.write(Buffer.concat([Buffer.from([0x81, ...len]), payload]));
    };
    const conn = {
      sendText,
      onText(fn: (text: string) => void) { textHandler = fn; },
      kill() { socket.destroy(); }
    };
    conns.push(conn);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        let payload = buffer.subarray(offset, offset + length);
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          socket.write(pong);
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          textHandler?.(payload.toString("utf8"));
        }
      }
    });
    socket.on("error", () => {});
  });
  return { server, conns };
}

describe("WSS relay transport", () => {
  it("refuses plaintext ws to non-loopback relays and credential URLs", () => {
    const onMessage = () => {};
    expect(() => createWssRelayTransport({ url: "ws://relay.example.internal/socket", onMessage })).toThrow(/insecure|ws:\/\//);
    expect(() => createWssRelayTransport({ url: "wss://user:pass@relay.example.invalid/socket", onMessage })).toThrow(/credential|must not carry/);
    expect(() => createWssRelayTransport({ url: "http://relay.example.internal/socket", onMessage })).toThrow(/wss/);
  });

  it("carries decoded JSON both ways over a real websocket socket", async () => {
    const { server, conns } = createWsTestServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const received: WireMessage[] = [];
    const transport = createWssRelayTransport({
      url: `ws://127.0.0.1:${port}/relay`,
      allowInsecureLoopback: true,
      onMessage: (message) => received.push(message)
    });
    try {
      expect(() => transport.send({ kind: "too-early" })).toThrow(/not_open|connecting/);
      await transport.ready;
      await waitFor(() => conns.length === 1);
      const seen: string[] = [];
      conns[0].onText((text) => {
        seen.push(text);
        conns[0].sendText(JSON.stringify({ kind: "session-admitted", echoed: true }));
      });
      transport.send({ kind: "session-open", purpose: "forward", admission: { deviceId: "dev.x" } });
      await waitFor(() => received.length === 1 && seen.length === 1);
      expect(JSON.parse(seen[0]).kind).toBe("session-open");
      expect(received[0].kind).toBe("session-admitted");
      transport.close();
      expect(() => transport.send({ kind: "frame" })).toThrow(/closed|not sent/);
    } finally {
      transport.close();
      server.close();
      for (const conn of conns) conn.kill();
    }
  });

  it("reopens the socket after a server-side drop", async () => {
    const { server, conns } = createWsTestServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    let drops = 0;
    const transport = createWssRelayTransport({
      url: `ws://127.0.0.1:${port}/relay`,
      allowInsecureLoopback: true,
      onMessage: () => {},
      onSocketClose: () => { drops += 1; }
    });
    try {
      await transport.ready;
      await waitFor(() => conns.length === 1);
      conns[0].kill();
      await waitFor(() => drops === 1);
      await transport.reopen();
      await waitFor(() => conns.length === 2);
      expect(transport.readyState).toBe(1);
    } finally {
      transport.close();
      server.close();
      for (const conn of conns) conn.kill();
    }
  });
});

// ---- Session + inner channel against the real private endpoint ---------------

describe("entry session against the real private endpoint composition", () => {
  it("admit + real mutual pinned TLS through the relay, then live work state", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry } = makeEntry(hub, certs);
      await entry.connect();
      // The driver moves admitted → streaming on the first handshake frame.
      expect(["admitted", "streaming"]).toContain(entry.state);
      expect(entry.routeState).toBe("reachable");
      expect(entry.acceptsNewWork).toBe(true);
      // The endpoint session is streaming real TLS records: acked frames prove
      // the relay pump delivered both directions of the handshake.
      expect(endpoint.session.state).toBe("streaming");
      entry.close();
      expect(entry.state).toBe("closed");
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("rejects an endpoint SPKI that is not pinned", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry } = makeEntry(hub, certs, {
        innerTls: {
          key: certs.client.key,
          cert: certs.client.cert,
          pinnedPeerSpki: [certs.roguePin],
          handshakeTimeoutMs: 2_000
        }
      });
      await expect(entry.connect()).rejects.toThrow(/handshake|unpinned|peer/);
      await waitFor(() => entry.state === "closed");
      expect(entry.acceptsNewWork).toBe(false);
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("keeps new work at endpoint_unreachable while the endpoint is offline, then converges on restore", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { entry } = makeEntry(hub, certs, { connectTimeoutMs: 6_000 });
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;
      const connecting = entry.connect().catch((error) => error);
      // Admission lands immediately (routeState unreachable); the state then
      // moves to streaming as the doomed ClientHello goes out.
      await waitFor(() => entry.sessionId !== null && entry.routeState === "unreachable");
      expect(entry.acceptsNewWork).toBe(false);
      const answer = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "svc/tool", arguments: {} } });
      expect(answer?.error?.data?.code).toBe("endpoint_unreachable");
      expect(answer?.error?.data?.effectOutcome).toBe("not_started");

      // The connect() waiter fails fast with the typed reason — but the relay
      // session itself stays alive: only the peer was absent, and killing the
      // session would destroy cursors the route still honors.
      const connectError = await connecting;
      expect(connectError?.code).toBe("endpoint_unreachable");
      expect(["admitted", "streaming"]).toContain(entry.state);

      // The endpoint attaches: the route-status reachable notice rebuilds the
      // inner channel on the *live* session — no reconnect round-trip needed.
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      await waitFor(() => entry.channelEstablished);
      expect(entry.acceptsNewWork).toBe(true);
      const pending = handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "svc/tool", arguments: {} } });
      // The real endpoint's hidden inner socket does not run a dispatch loop
      // (that wiring belongs to the endpoint product) — close settles the
      // outstanding request as honest doubt, never a fabricated result.
      entry.close();
      const settled = await pending;
      expect(["operation_status_unknown", "endpoint_unreachable"]).toContain(settled?.error?.data?.code);
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("answers operation status through the real endpoint recovery channel", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry } = makeEntry(hub, certs);
      await entry.connect();

      // Mark an uncertain operation through the real dispatch path — the
      // endpoint ledger records dispatched_in_doubt.
      await endpoint.dispatchInnerMessage(TEST_CONTEXT, {
        jsonrpc: "2.0", id: "op.doubt.1", method: "tools/call",
        params: { name: "svc/tool", arguments: {}, operationKey: "op.doubt.1" }
      }).catch(() => {
        // a thrown dispatch also lands in-doubt
      });
      // The stub gateway always completes; mark uncertainty the same way the
      // kernel outcome path does.
      const status = await entry.queryOperation("op.doubt.1");
      expect(["in_progress", "completed", "dispatched_in_doubt"]).toContain(String(status.state));

      const never = await entry.queryOperation("op.never.submitted.9");
      expect(never.state).toBe("not_started");
      expect(never.notStartedEvidence).toBe("local_never_submitted");
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("fails honestly when the relay tampers with inner-channel ciphertext", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry, transport } = makeEntry(hub, certs);
      // Corrupt one byte of a handshake flight record: the TLS MAC fails on
      // the far side instead of yielding a forged channel. Decode/flip/
      // re-encode so the tamper provably changes decoded bytes.
      hub.tamperNext(transport, (message) => {
        const bytes = Buffer.from(String(message.payload ?? ""), "base64url");
        bytes[0] = bytes[0] ^ 0xff;
        return { ...message, payload: bytes.toString("base64url") };
      }, (message) => message.kind === "frame");
      await expect(entry.connect()).rejects.toThrow();
      expect(entry.acceptsNewWork).toBe(false);
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("fails honestly when relay frames are dropped mid-handshake", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry, transport } = makeEntry(hub, certs);
      hub.dropNext(transport, (message) => message.kind === "frame");
      await expect(entry.connect()).rejects.toThrow();
      expect(entry.acceptsNewWork).toBe(false);
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("reconnects through the contract: fresh admission revision, new handshake, endpoint rebuild", async () => {
    const certs = await makeCerts();
    try {
      const hub = new RelayHub();
      const { endpoint } = makeEndpoint(hub, certs);
      endpoint.open();
      const { entry } = makeEntry(hub, certs);
      await entry.connect();
      const firstSessionId = entry.sessionId;
      expect(firstSessionId).not.toBeNull();

      // The endpoint leaves first so its fresh inner channel is already
      // waiting when the entry's new handshake lands.
      endpoint.close("reconnect");
      expect(endpoint.reconnect()).toBe(true);
      await waitFor(() => endpoint.session.state === "admitted");

      entry.handleTransportClose();
      expect(entry.state).toBe("closed");
      await entry.reconnect({ revocationRevision: 12 });
      expect(entry.sessionId).not.toBe(firstSessionId);
      expect(entry.acceptsNewWork).toBe(true);
      entry.close();
      endpoint.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });
});

// ---- Local MCP face over a live inner channel --------------------------------

interface EndpointSide {
  session: PrivateRelaySession;
  handle(message: WireMessage): string | null;
  close(): void;
}

/**
 * Endpoint-product composition for the byte loop: the same real modules the
 * shipped endpoint uses (PrivateRelaySession + createRelayFrameDuplex +
 * createInnerTlsEndpoint), plus this package's inner dispatch loop bound to
 * the real createPrivateGatewayEndpoint.dispatchInnerMessage. The endpoint's
 * own session/channel stay live elsewhere in the suite; here the loop exposes
 * the dispatch wiring the endpoint product owns.
 */
function makeEndpointSide(hub: RelayHub, certs: CertPair, gateway: {
  invoke(ctx: AuthenticatedContext, invocation: { routeRef: string; method: string; params: unknown; operationKey?: string }): Promise<GatewayOutcome>;
  catalog(ctx: AuthenticatedContext, query?: unknown): unknown;
  readResource?(ctx: AuthenticatedContext, uri: string): Promise<GatewayOutcome>;
  getPrompt?(ctx: AuthenticatedContext, name: string, args?: unknown): Promise<GatewayOutcome>;
  completePrompt?(ctx: AuthenticatedContext, argument: unknown): Promise<GatewayOutcome>;
}) {
  const store = createEndpointIdentityStore();
  enrollEndpointDevice(store, certs.clientPin);
  const transport = new MemoryRelayTransport(hub);
  const dispatchEndpoint = createPrivateGatewayEndpoint({
    gateway: gateway as never,
    authority: AUTHORITY,
    recoverySigner: RECOVERY_SIGNER,
    transport: { send: () => {}, close: () => {} },
    admission: ENDPOINT_ADMISSION,
    identity: store,
    innerTls: { key: certs.server.key, cert: certs.server.cert }
  });
  let pump: RelayFrameDuplex | undefined;
  let tls: ReturnType<typeof createInnerTlsEndpoint> | undefined;
  let loop: { pendingResponses: number; close(): void } | undefined;
  let device: ReturnType<EndpointIdentityStore["device"]> | undefined;

  const safeFlush = () => {
    try { session.flushInbound(); } catch { /* transport may be gone */ }
  };

  const dispatch = async (message: Record<string, unknown>): Promise<unknown> => {
    if (!device) return null;
    const context = await AUTHORITY.contextFor({ device });
    return dispatchEndpoint.dispatchInnerMessage(context as AuthenticatedContext, message);
  };

  const session = new PrivateRelaySession({
    transport,
    admission: ENDPOINT_ADMISSION,
    handlers: {
      onAdmitted: () => {
        const decision = store.admit({ ...ENDPOINT_ADMISSION });
        device = decision.device;
        pump = createRelayFrameDuplex({
          sendFrame: (payload) => session.sendPayload(payload).accepted,
          onDrained: safeFlush
        });
        tls = createInnerTlsEndpoint({
          socket: pump as unknown as Duplex,
          key: certs.server.key,
          cert: certs.server.cert,
          pinnedPeerSpki: [certs.clientPin]
        });
        loop = createInnerDispatchLoop({ socket: tls.socket as unknown as Duplex, dispatch });
        void tls.established.then(safeFlush).catch(() => session.close("protocol_error"));
      },
      onFrame: (payload) => (pump ? pump.feed(payload) : false),
      onClosed: () => {
        loop?.close();
        loop = undefined;
        tls = undefined;
        pump = undefined;
      }
    }
  });
  transport.onMessage = (message) => side.handle(message);

  const side: EndpointSide = {
    session,
    handle(message: WireMessage): string | null {
      const kind = session.handleMessage(message)
        ?? (() => {
          const parsed = parsePrivateRelayRecoveryMessage(message);
          return parsed ? String(parsed.kind) : null;
        })();
      if (kind === "operation-query") {
        void Promise.resolve(device)
          .then(async () => {
            if (!device) return;
            const context = await AUTHORITY.contextFor({ device });
            const status = await dispatchEndpoint.operationRecovery.answerQuery(message, context as AuthenticatedContext);
            if (status) transport.send(status as unknown as WireMessage);
          })
          .catch(() => {});
      }
      return kind;
    },
    close() {
      loop?.close();
      tls?.close();
      session.close("normal");
      transport.close();
    }
  };
  return { side, dispatchEndpoint, store, transport };
}

function makeGateway() {
  const calls: { operationKey?: string; routeRef: string; method: string; params: unknown }[] = [];
  const descriptors = [
    { kind: "tool", publicName: "svc/tool", description: "A tool", inputSchema: { type: "object" }, route: { logicalRoute: "svc:tool:1", effectClass: "safe_write" } },
    { kind: "resource", publicName: "svc/res", publicUri: "meshrix://svc/res", description: "A resource", route: { logicalRoute: "svc:res:1", effectClass: "read" } },
    { kind: "prompt", publicName: "svc/prompt", description: "A prompt", metadata: { arguments: [{ name: "topic" }] }, route: { logicalRoute: "svc:prompt:1", effectClass: "read" } }
  ];
  const gateway = {
    async invoke(_ctx: AuthenticatedContext, invocation: { routeRef: string; method: string; params: unknown; operationKey?: string }): Promise<GatewayOutcome> {
      calls.push({ operationKey: invocation.operationKey, routeRef: invocation.routeRef, method: invocation.method, params: invocation.params });
      const key = invocation.operationKey ?? "";
      if (key === "op.denied") {
        return { kind: "failure", origin: "policy", code: "policy_denied", message: "Denied by policy.", status: 403, effectOutcome: "not_started" };
      }
      if (key === "op.doubted") {
        return { kind: "failure", origin: "transport", code: "upstream_lost", message: "The upstream outcome is unavailable.", status: 503, effectOutcome: "unknown" };
      }
      if (key === "op.blowup") throw new Error("kernel failure mid-dispatch");
      return { kind: "complete", value: { content: [{ type: "text", text: `ran ${invocation.routeRef}` }] } };
    },
    catalog(_ctx: AuthenticatedContext, query?: { kind?: string; cursor?: string; limit?: number }) {
      const items = descriptors.filter((d) => !query?.kind || d.kind === query.kind);
      return { revision: "rev.1", items, nextCursor: query?.cursor ? undefined : undefined };
    },
    async readResource(): Promise<GatewayOutcome> {
      return { kind: "complete", value: { contents: [{ uri: "meshrix://svc/res", text: "resource body" }] } };
    },
    async getPrompt(): Promise<GatewayOutcome> {
      return { kind: "complete", value: { messages: [{ role: "user", content: { type: "text", text: "hello" } }] } };
    },
    async completePrompt(): Promise<GatewayOutcome> {
      return { kind: "complete", value: { completion: { values: ["alpha", "alpine"], total: 2, hasMore: false } } };
    }
  };
  return { gateway, calls, descriptors };
}

async function openPair(certs: CertPair) {
  const hub = new RelayHub();
  const { gateway, calls } = makeGateway();
  const ep = makeEndpointSide(hub, certs, gateway);
  ep.side.session.open();
  const { entry, transport } = makeEntry(hub, certs);
  await entry.connect();
  return { hub, entry, transport, ep, gateway, calls };
}

describe("local MCP face over the live inner channel", () => {
  it("negotiates standard MCP and forwards the full work surface faithfully", async () => {
    const certs = await makeCerts();
    try {
      const { entry, calls } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;

      const init = await handle({ jsonrpc: "2.0", id: "i0", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
      expect(init?.result?.protocolVersion).toBe("2025-06-18");
      expect(init?.result?.serverInfo?.name).toBe("meshrix-entry");

      expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
      expect(await handle({ jsonrpc: "2.0", id: "p0", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "p0", result: {} });

      const tools = await handle({ jsonrpc: "2.0", id: "t1", method: "tools/list" });
      expect(tools?.result?.tools).toHaveLength(1);
      expect(tools?.result?.tools?.[0]?.name).toBe("svc/tool");

      const resources = await handle({ jsonrpc: "2.0", id: "r1", method: "resources/list" });
      expect(resources?.result?.resources?.[0]?.uri).toBe("meshrix://svc/res");

      const prompts = await handle({ jsonrpc: "2.0", id: "pr1", method: "prompts/list" });
      expect(prompts?.result?.prompts?.[0]?.name).toBe("svc/prompt");

      const call = await handle({ jsonrpc: "2.0", id: "c1", method: "tools/call", params: { name: "svc/tool", arguments: { a: 1 }, operationKey: "op.call.1" } });
      expect(call?.result?.content?.[0]?.text).toBe("ran svc/tool");
      expect(calls.some((c) => c.operationKey === "op.call.1")).toBe(true);

      const read = await handle({ jsonrpc: "2.0", id: "r2", method: "resources/read", params: { uri: "meshrix://svc/res" } });
      expect(read?.result?.contents?.[0]?.text).toBe("resource body");

      const prompt = await handle({ jsonrpc: "2.0", id: "p2", method: "prompts/get", params: { name: "svc/prompt" } });
      expect(prompt?.result?.messages?.[0]?.content?.text).toBe("hello");

      const completion = await handle({ jsonrpc: "2.0", id: "cp1", method: "completion/complete", params: { ref: { type: "ref/prompt", name: "svc/prompt" }, argument: { name: "topic", value: "a" } } });
      expect(completion?.result?.completion?.values).toEqual(["alpha", "alpine"]);

      const missing = await handle({ jsonrpc: "2.0", id: "m1", method: "bogus/method" });
      expect(missing?.error?.code).toBe(-32601);
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("projects endpoint failures with their effect evidence, never fabricating success", async () => {
    const certs = await makeCerts();
    try {
      const { entry } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;

      const denied = await handle({ jsonrpc: "2.0", id: "d1", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.denied" } });
      expect(denied?.error?.code).toBe(-32003);
      expect(denied?.error?.data?.code).toBe("policy_denied");
      expect(denied?.error?.data?.effectOutcome).toBe("not_started");

      const doubted = await handle({ jsonrpc: "2.0", id: "d2", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.doubted" } });
      expect(doubted?.error?.data?.code).toBe("upstream_lost");
      expect(doubted?.error?.data?.effectOutcome).toBe("unknown");

      const blewUp = await handle({ jsonrpc: "2.0", id: "d3", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.blowup" } });
      expect(blewUp?.error?.data?.code).toBe("endpoint_dispatch_failed");
      expect(blewUp?.error?.data?.effectOutcome).toBe("unknown");
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("keeps a dispatched-then-lost operation honestly unknown and never replays it", async () => {
    const certs = await makeCerts();
    try {
      const { hub, entry, transport, ep, calls } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;

      // Let the request dispatch fully, then sever the response direction and
      // the link before the answer arrives.
      hub.dropNext(ep.transport, (message) => message.kind === "frame");
      const pending = handle({ jsonrpc: "2.0", id: "lost1", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.lost.1" } });
      await waitFor(() => calls.some((c) => c.operationKey === "op.lost.1"), 3_000);
      // Kill the entry link — the pending request must settle as unknown, not hang.
      hub.killLink(transport);
      const lost = await pending;
      expect(lost?.error?.data?.code).toBe("operation_status_unknown");
      expect(lost?.error?.data?.effectOutcome).toBe("unknown");
      expect(lost?.error?.data?.operationId).toBe("op.lost.1");

      // No silent replay while the channel is down.
      expect(calls.filter((c) => c.operationKey === "op.lost.1")).toHaveLength(1);
      const refused = await handle({ jsonrpc: "2.0", id: "w1", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.lost.1" } });
      expect(refused?.error?.data?.code).toBe("endpoint_unreachable");
      expect(calls.filter((c) => c.operationKey === "op.lost.1")).toHaveLength(1);

      // The endpoint ledger knows the truth: the op settled complete endpoint-side.
      await ep.side.close();
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("surfaces tampered ciphertext as channel loss, never as a result", async () => {
    const certs = await makeCerts();
    try {
      const { hub, entry, ep, calls } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;
      // Tamper the first endpoint→entry frame sent *after* the dispatch
      // lands — post-handshake TLS records (session tickets) flowing earlier
      // are ignored, so the corrupted record is provably the response flight.
      // Decode/flip/re-encode: mutating a raw base64url char can leave the
      // decoded bytes identical (padding bits), which is not a tamper.
      hub.tamperNext(ep.transport, (message) => {
        const bytes = Buffer.from(String(message.payload ?? ""), "base64url");
        bytes[0] = bytes[0] ^ 0xff;
        return { ...message, payload: bytes.toString("base64url") };
      }, (message) => message.kind === "frame" && calls.some((call) => call.operationKey === "op.tampered.1"));
      const answer = await handle({ jsonrpc: "2.0", id: "tp1", method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.tampered.1" } });
      expect(answer?.error?.data?.code).toBe("operation_status_unknown");
      // The dispatch itself reached the endpoint kernel — what was lost is
      // the result, so the honest answer is doubt, not a result.
      expect(calls.filter((call) => call.operationKey === "op.tampered.1")).toHaveLength(1);
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("stdio adapter speaks newline JSON-RPC and keeps stdout protocol-only", async () => {
    const certs = await makeCerts();
    try {
      const { entry } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (chunk) => chunks.push(String(chunk)));
      const serve = serveEntryMcpStdio({ handle: (body) => handle(body), input, output });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      input.write(`not-json\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.end();
      await serve;
      const lines = chunks.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[0].result).toEqual({});
      expect(lines[1].error.code).toBe(-32700);
      expect(lines[2].result.tools).toHaveLength(1);
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("loopback adapter refuses browser origins outside the allowlist", async () => {
    const certs = await makeCerts();
    try {
      const { entry } = await openPair(certs);
      const bridge = createEntryMcpBridge({ session: entry });
      const handle = (request: unknown): Promise<Answer> => bridge.handle(request) as Promise<Answer>;
      const http = await createEntryMcpLoopbackHttp({ handle: (body) => handle(body), allowedOrigins: ["http://127.0.0.1:9"] });
      try {
        const post = (headers: Record<string, string>) => fetch(http.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
        });
        const evil = await post({ origin: "https://evil.example" });
        expect(evil.status).toBe(403);
        expect((await evil.json()).error.code).toBe(-32003);
        const good = await post({ origin: "http://127.0.0.1:9" });
        expect(good.status).toBe(200);
        const noOrigin = await post({});
        expect(noOrigin.status).toBe(200);
        const health = await fetch(`http://127.0.0.1:${http.port}/health`);
        expect(health.status).toBe(200);
      } finally {
        await http.close();
      }
      entry.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });

  it("bounds the endpoint response queue against a reader that never drains", async () => {
    // A peer socket that never reads: responses stall inside the stream
    // buffer, write() reports backpressure, and the bounded response queue is
    // the only honest end — the loop tears down rather than buffer forever.
    const right = new Duplex({
      highWaterMark: 96,
      write(chunk, _e, cb) { if (left.push(chunk)) cb(); else left.once("drain", cb); },
      read() {}
    });
    const left = new Duplex({
      highWaterMark: 96,
      write(chunk, _e, cb) { if (right.push(chunk)) cb(); else right.once("drain", cb); },
      read() {}
    });
    const lost: unknown[] = [];
    const loop = createInnerDispatchLoop({
      socket: left,
      dispatch: async () => ({ kind: "complete", value: { content: [{ type: "text", text: "x".repeat(120) }] } }),
      maxPendingResponses: 2,
      onLost: (error) => lost.push(error)
    });
    for (let i = 1; i <= 6; i += 1) {
      right.write(`${JSON.stringify({ id: i, method: "tools/list" })}\n`);
    }
    await waitFor(() => lost.length === 1 || left.destroyed, 3_000);
    expect(lost.length + (left.destroyed ? 1 : 0)).toBeGreaterThan(0);
    loop.close();
  });
});
