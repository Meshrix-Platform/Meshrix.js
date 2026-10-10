import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_WIRE_PROTOCOL
} from "@meshrix/contracts/private-relay";
import {
  createEndpointIdentityStore,
  createInnerTlsClient,
  createRelayFrameDuplex,
  spkiSha256Base64Url
} from "@meshrix/gateway/private-endpoint";
import { createFrame } from "@meshrix/contracts/private-relay";
import { createInnerRequestChannel } from "@meshrix/entry-transport";
import type { Gateway } from "@meshrix/contracts/gateway";

import { checkPrivateEndpoint, servePrivateEndpointProfile, type PrivateEndpointSurface } from "../../../../apps/mcp-gateway-installer/src/private-endpoint/profile.ts";
import { RelayWebSocketTransport } from "../../../../apps/mcp-gateway-installer/src/private-endpoint/transport.ts";

// ---------------------------------------------------------------------------
// Minimal RFC 6455 server: enough for a real undici WebSocket client to do the
// upgrade, exchange masked/unmasked text frames, and close cleanly.
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface TestWsConn {
  readonly request: IncomingMessage;
  /** Send one text frame. */
  send(data: string): void;
  /** Send a close frame; the socket ends once the client answers. */
  close(code?: number, reason?: string): void;
  /** Destroy the underlying socket without a close handshake. */
  destroy(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsConnection(socket: Socket, request: IncomingMessage): TestWsConn {
  let messageHandler: (data: string) => void = () => {};
  let closeHandler: () => void = () => {};
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] | undefined;
  let closed = false;

  const finishClose = () => {
    if (closed) return;
    closed = true;
    closeHandler();
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
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
      const maskBytes = masked ? 4 : 0;
      if (buffer.length < offset + maskBytes + length) return;
      let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) unmasked[index] = (payload[index] as number) ^ (mask[index & 3] as number);
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + maskBytes + length);

      if (opcode === 8) {
        if (!closed) socket.write(encodeServerFrame(8, payload));
        socket.end();
        finishClose();
        return;
      }
      if (opcode === 9) { socket.write(encodeServerFrame(10, payload)); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) {
        // Continuation frame.
        fragments?.push(payload);
        if (fin && fragments) {
          messageHandler(Buffer.concat(fragments).toString("utf8"));
          fragments = undefined;
        }
        continue;
      }
      if (!fin) { fragments = [payload]; continue; }
      if (opcode === 1) messageHandler(payload.toString("utf8"));
      // Binary frames are not part of this wire profile; ignore them.
    }
  });
  socket.on("close", finishClose);
  socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });

  return {
    request,
    send(data: string) {
      if (!closed) socket.write(encodeServerFrame(1, Buffer.from(data, "utf8")));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      const reasonBytes = Buffer.from(reason, "utf8");
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      try { socket.write(encodeServerFrame(8, payload)); } catch { /* gone */ }
      // End shortly after offering the close frame; tests never need a long tail.
      setTimeout(() => { try { socket.end(); } catch { /* gone */ } }, 10).unref();
    },
    destroy() {
      closed = true;
      socket.destroy();
      finishClose();
    },
    onMessage(handler) { messageHandler = handler; },
    onClose(handler) { closeHandler = handler; }
  };
}

interface WsServer {
  readonly url: string;
  readonly connections: TestWsConn[];
  close(): Promise<void>;
}

async function startWsServer(onConnection: (conn: TestWsConn) => void): Promise<WsServer> {
  const connections: TestWsConn[] = [];
  const server = createHttpServer();
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const conn = wsConnection(socket, request);
    connections.push(conn);
    // A closed conn must leave the roster — otherwise peer selection keeps
    // forwarding live traffic into a dead socket and the run goes silent.
    conn.onClose(() => {
      const index = connections.indexOf(conn);
      if (index >= 0) connections.splice(index, 1);
    });
    onConnection(conn);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    connections,
    async close() {
      for (const conn of connections) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

// ---------------------------------------------------------------------------
// Scripted relay: admits sessions, restores reconnects, forwards channel
// traffic to the peer connection, and can be told to reject or drop.
// ---------------------------------------------------------------------------

const RELAY_LIMIT_FIELDS = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
};

interface RelayHooks {
  /** Return value replaces the default admit when provided. */
  onSessionOpen?: (conn: TestWsConn, message: Record<string, unknown>) => void;
  onSessionReconnect?: (conn: TestWsConn, message: Record<string, unknown>) => void;
  onAny?: (conn: TestWsConn, message: Record<string, unknown>) => void;
}

interface FakeRelay extends WsServer {
  /** Every parsed inbound message, in arrival order. */
  readonly seen: { conn: TestWsConn; message: Record<string, unknown> }[];
  /** First connection is the endpoint under test; additional conns are peers. */
  peer(conn: TestWsConn): TestWsConn | undefined;
}

async function startFakeRelay(hooks: RelayHooks = {}): Promise<FakeRelay> {
  const seen: FakeRelay["seen"] = [];
  const connRoles = new Map<TestWsConn, string>();
  // Route-level sequence cursors persist across session replacement exactly
  // like the real DO — they force a fresh session to continue numbering.
  const routeCursors = { toEndpoint: 0, toEntry: 0 };
  const base = await startWsServer((conn) => {
    conn.onMessage((data) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(data) as Record<string, unknown>; } catch { conn.close(4000, "bad_json"); return; }
      seen.push({ conn, message });
      hooks.onAny?.(conn, message);
      const kind = message.kind;
      if (kind === "session-open") {
        if (hooks.onSessionOpen) { hooks.onSessionOpen(conn, message); return; }
        const admission = message.admission as Record<string, unknown>;
        connRoles.set(conn, String(admission?.role));
        conn.send(JSON.stringify({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-admitted",
          sessionId: `sess.${seen.length}`,
          purpose: message.purpose,
          admittedGeneration: admission?.admissionGeneration,
          revocationRevision: admission?.revocationRevision,
          routeState: "reachable",
          limits: { ...RELAY_LIMIT_FIELDS },
          reconnectGeneration: 1,
          cursors: { ...routeCursors },
          serverNonce: "sn.relay.fixture.00000001"
        }));
        return;
      }
      if (kind === "session-reconnect") {
        if (hooks.onSessionReconnect) { hooks.onSessionReconnect(conn, message); return; }
        conn.send(JSON.stringify({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-restored",
          sessionId: `sess.restored.${seen.length}`,
          reconnectGeneration: message.reconnectGeneration,
          gaps: [],
          limits: { ...RELAY_LIMIT_FIELDS },
          cursors: { ...routeCursors }
        }));
        return;
      }
      if (kind === "session-close") { conn.close(1000, "ack"); return; }
      if (kind === "frame") {
        const direction = connRoles.get(conn) === "entry" ? "toEndpoint" : "toEntry";
        routeCursors[direction] = Math.max(routeCursors[direction], Number(message.seq) || 0);
      }
      // Channel traffic (frames, recovery, operation status) is forwarded to the peer verbatim.
      const other = base.connections.find((candidate) => candidate !== conn);
      other?.send(data);
    });
  });
  return {
    ...base,
    seen,
    peer(conn) { return base.connections.find((candidate) => candidate !== conn); }
  };
}

// ---------------------------------------------------------------------------
// Config fixtures and helpers.
// ---------------------------------------------------------------------------

const CREDENTIAL_ENV = "MESHRIX_TEST_PRIVATE_RELAY_CREDENTIAL";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

interface Fixture {
  readonly dir: string;
  readonly configPath: string;
  readonly endpointKey: string;
  readonly endpointCert: string;
  /** Entry-side TLS material — the paired identity this endpoint pins. */
  readonly entryKey: string;
  readonly entryCert: string;
  readonly pairedIdentityKey: string;
  readonly pairedIdentityFingerprint: string;
}

async function writeFixture(relayUrl: string, overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pe-profile-"));
  try {
    const keyPath = join(dir, "endpoint.key");
    const certPath = join(dir, "endpoint.crt");
    const entryKeyPath = join(dir, "entry.key");
    const entryCertPath = join(dir, "entry.crt");
    const opts = { stdio: "ignore" as const, timeout: 15_000 };
    if (spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=endpoint", "-keyout", keyPath, "-out", certPath], opts).status !== 0) {
      throw new Error("openssl failed to generate the endpoint TLS fixture");
    }
    // The paired identity is carried in the trust-binding wire contract which
    // bounds key material to 256 bytes — an ed25519 SPKI fits where RSA-2048
    // does not, and ed25519 TLS certificates are first-class in TLS 1.3.
    // opaqueId requires an alphanumeric first character, while a base64url
    // sha256 fingerprint can begin with "-" or "_" (~3% of keys); regenerate
    // the entry identity until the real pin is contract-representable.
    let entryCert = "";
    let entryKey = "";
    let pairedIdentityKey = "";
    let pairedIdentityFingerprint = "";
    for (;;) {
      if (spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "ed25519", "-days", "1", "-subj", "/CN=entry", "-keyout", entryKeyPath, "-out", entryCertPath], opts).status !== 0) {
        throw new Error("openssl failed to generate the entry TLS fixture");
      }
      entryCert = await readFile(entryCertPath, "utf8");
      entryKey = await readFile(entryKeyPath, "utf8");
      const entryPublicKey = createPublicKey({ key: entryCert, format: "pem" });
      pairedIdentityKey = entryPublicKey.export({ format: "der", type: "spki" }).toString("base64url");
      pairedIdentityFingerprint = spkiSha256Base64Url(entryPublicKey);
      if (/^[A-Za-z0-9]/.test(pairedIdentityFingerprint)) break;
    }
    const recovery = generateKeyPairSync("ed25519");
    const recoveryPublicKey = recovery.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

    const gatewayConfigPath = join(dir, "gateway.json");
    await writeFile(gatewayConfigPath, JSON.stringify({
      profile: "local",
      services: [{ serviceId: "up", baseUrl: "http://127.0.0.1:9/mcp" }]
    }));

    const configPath = join(dir, "endpoint.json");
    await writeFile(configPath, JSON.stringify({
      profile: "private-endpoint",
      relay: { url: relayUrl, credential: `env:${CREDENTIAL_ENV}` },
      endpoint: {
        tenantId: "tenant.pr.1",
        deviceId: "dev.pr.endpoint.1",
        routeId: "route.pr.1",
        mode: "personal",
        admissionGeneration: 7,
        revocationRevision: 0,
        pairedIdentityKey,
        pairedIdentityFingerprint,
        trustGeneration: 3,
        endpointPrincipalRef: "prin.pr.1",
        capabilityGrantRef: "grantref.pr.1"
      },
      innerTls: { key: `file:${keyPath}`, cert: `file:${certPath}` },
      recovery: {
        authorities: [{ recoveryKeyId: "rckey.pr.1", principalRef: "prin.pr.1", publicKey: recoveryPublicKey, generation: 3 }]
      },
      gateway: { configPath: gatewayConfigPath },
      reconnect: { initialDelayMs: 20, maxDelayMs: 80 },
      ...overrides
    }));
    return {
      dir,
      configPath,
      endpointKey: await readFile(keyPath, "utf8"),
      endpointCert: await readFile(certPath, "utf8"),
      entryKey,
      entryCert,
      pairedIdentityKey,
      pairedIdentityFingerprint
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function fakeRuntime(overrides: { invoke?: Gateway["invoke"]; catalog?: Gateway["catalog"]; closed?: { count: number } } = {}) {
  const closed = overrides.closed ?? { count: 0 };
  const gateway = {
    invoke: overrides.invoke ?? (async (_context: unknown, invocation: { params?: unknown }) => ({ kind: "complete", value: { echo: invocation.params } })),
    catalog: overrides.catalog ?? (() => Object.freeze({ items: [], nextCursor: null })),
    readResource: async () => null,
    getPrompt: async () => null,
    completePrompt: async () => null,
    close: async () => { closed.count += 1; }
  } as unknown as Gateway;
  return {
    gateway,
    descriptors: [],
    permits: undefined,
    closed
  };
}

function admissionRecord() {
  return {
    tenantId: "tenant.pr.1",
    deviceId: "dev.pr.endpoint.1",
    routeId: "route.pr.1",
    role: "endpoint",
    mode: "personal",
    admissionGeneration: 7,
    revocationRevision: 0
  };
}

function enrolledIdentity(fixture: Fixture, extraDevices: string[] = []) {
  const store = createEndpointIdentityStore();
  for (const deviceId of ["dev.pr.endpoint.1", ...extraDevices]) {
    store.enroll({
      deviceId,
      routeId: "route.pr.1",
      tenantId: "tenant.pr.1",
      trustBinding: {
        schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
        kind: "endpoint-trust-binding",
        pairedIdentityKey: fixture.pairedIdentityKey,
        pairedIdentityFingerprint: `${fixture.pairedIdentityFingerprint}${deviceId === "dev.pr.endpoint.1" ? "" : `.${deviceId}`}`,
        mode: "personal",
        role: "endpoint",
        trustGeneration: 3,
        endpointPrincipalRef: "prin.pr.1",
        capabilityGrantRef: "grantref.pr.1",
        boundRecoveryKeyId: null
      }
    });
  }
  return store;
}

function parseSurfaces(lines: string[]): PrivateEndpointSurface[] {
  return lines.map((line) => JSON.parse(line) as PrivateEndpointSurface);
}

describe("private endpoint profile configuration", () => {
  const saved = process.env[CREDENTIAL_ENV];
  function withCredential<T>(fn: () => Promise<T>): Promise<T> {
    process.env[CREDENTIAL_ENV] = "test-relay-credential";
    return fn().finally(() => {
      if (saved === undefined) delete process.env[CREDENTIAL_ENV];
      else process.env[CREDENTIAL_ENV] = saved;
    });
  }

  it("validates a complete configuration in check mode without connecting", () => withCredential(async () => {
    const fixture = await writeFixture("wss://relay.example.invalid");
    try {
      const result = await checkPrivateEndpoint({ config: fixture.configPath });
      expect(result.profile).toBe("private-endpoint");
      expect(result.health).toBe("ok");
      expect((result.endpoint as { deviceId: string }).deviceId).toBe("dev.pr.endpoint.1");
      expect((result.relay as { secure: boolean }).secure).toBe(true);
      expect(result.recoveryAuthorities).toBe(1);
      expect(JSON.stringify(result)).not.toContain("test-relay-credential");
      expect(JSON.stringify(result)).not.toContain(fixture.endpointKey);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }));

  it("rejects unsafe relay URLs, missing credentials and missing material distinctly", async () => {
    const fixture = await writeFixture("wss://relay.example.invalid");
    try {
      // No credential bound → typed failure before anything else matters.
      await expect(checkPrivateEndpoint({ config: fixture.configPath })).rejects.toMatchObject({ code: "private_endpoint_credential_missing" });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
    await withCredential(async () => {
      const unsafe = await writeFixture("ws://relay.example.invalid");
      try {
        await expect(checkPrivateEndpoint({ config: unsafe.configPath })).rejects.toMatchObject({ code: "private_endpoint_relay_unsafe" });
      } finally {
        await rm(unsafe.dir, { recursive: true, force: true });
      }
      const badRole = await writeFixture("wss://relay.example.invalid");
      try {
        const raw = JSON.parse(await readFile(badRole.configPath, "utf8")) as Record<string, unknown>;
        (raw.endpoint as Record<string, unknown>).role = "entry";
        await writeFile(badRole.configPath, JSON.stringify(raw));
        await expect(checkPrivateEndpoint({ config: badRole.configPath })).rejects.toMatchObject({ code: "private_endpoint_role_invalid" });
      } finally {
        await rm(badRole.dir, { recursive: true, force: true });
      }
      const missingTls = await writeFixture("wss://relay.example.invalid");
      try {
        const raw = JSON.parse(await readFile(missingTls.configPath, "utf8")) as Record<string, unknown>;
        (raw.innerTls as Record<string, unknown>).key = "file:does-not-exist.key";
        await writeFile(missingTls.configPath, JSON.stringify(raw));
        await expect(checkPrivateEndpoint({ config: missingTls.configPath })).rejects.toMatchObject({ code: "private_endpoint_material_missing" });
      } finally {
        await rm(missingTls.dir, { recursive: true, force: true });
      }
      const publicAdmin = await writeFixture("wss://relay.example.invalid", { admin: { listen: { host: "0.0.0.0", port: 9443 } } });
      try {
        await expect(checkPrivateEndpoint({ config: publicAdmin.configPath })).rejects.toMatchObject({ code: "private_endpoint_admin_unsafe" });
      } finally {
        await rm(publicAdmin.dir, { recursive: true, force: true });
      }
    });
  });
});

describe("relay WebSocket transport", () => {
  it("queues the session intent while connecting and flushes it on open", async () => {
    const relay = await startFakeRelay();
    try {
      const transport = new RelayWebSocketTransport({ url: `${relay.url}/session/tenant.pr.1/route.pr.1` });
      const received: Record<string, unknown>[] = [];
      const down: { hadOpened: boolean }[] = [];
      transport.setHandlers({ onMessage: (m) => received.push(m as Record<string, unknown>), onDown: (d) => down.push(d) });
      expect(transport.connect()).toBe(true);
      // Issued before the socket opens — must ride the pending queue.
      transport.send({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-open",
        purpose: "forward",
        admission: admissionRecord(),
        clientNonce: "nonce.test.transport.0001"
      });
      await waitFor(() => transport.state === "open");
      await waitFor(() => relay.seen.some((entry) => entry.message.kind === "session-open"));
      await waitFor(() => received.some((m) => m.kind === "session-admitted"));
      expect(received.find((m) => m.kind === "session-admitted")?.sessionId).toBeTruthy();
      transport.terminate();
      await waitFor(() => down.length > 0);
      // A socket that opened does not retain queue state — close is terminal.
      expect(transport.state).toBe("closed");
    } finally {
      await relay.close();
    }
  });

  it("drops sends on a dead generation and refuses contract-violating messages", async () => {
    const relay = await startFakeRelay();
    try {
      const transport = new RelayWebSocketTransport({ url: relay.url });
      expect(transport.connect()).toBe(true);
      await waitFor(() => transport.state === "open");
      // Not a contract message — never reaches the wire.
      transport.send({ kind: "nonsense", credentials: "leak-me" } as never);
      expect(transport.droppedSends).toBe(1);
      transport.close();
      await waitFor(() => transport.state === "closed");
      // Dead generation: the send is dropped, not queued into the next socket.
      transport.send({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "session-close",
        sessionId: "sess.dead",
        reason: "normal",
        finalCursors: { toEndpoint: 0, toEntry: 0 }
      });
      expect(transport.droppedSends).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(relay.seen.filter((m) => m.message.kind === "session-close")).toHaveLength(0);
      transport.terminate();
    } finally {
      await relay.close();
    }
  });

  it("reports a pre-open failure and retains queued intent for the next attempt", async () => {
    // Port 1 is reserved/unusable — connect refused quickly on loopback.
    const transport = new RelayWebSocketTransport({ url: "ws://127.0.0.1:1/session/x/y" });
    const down: { hadOpened: boolean }[] = [];
    transport.setHandlers({ onDown: (d) => down.push(d) });
    expect(transport.connect()).toBe(true);
    transport.send({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-open",
      purpose: "forward",
      admission: admissionRecord(),
      clientNonce: "nonce.test.transport.0002"
    });
    await waitFor(() => down.length > 0);
    expect(down[0]?.hadOpened).toBe(false);
    // The intent was never transmitted; it survives for the next generation.
    expect(transport.queuedMessages).toBe(1);
    expect(transport.connect()).toBe(true);
    await waitFor(() => down.length > 1);
    transport.terminate();
  });
});

describe("private endpoint profile serve", () => {
  const saved = process.env[CREDENTIAL_ENV];
  function withCredential<T>(fn: () => Promise<T>): Promise<T> {
    process.env[CREDENTIAL_ENV] = "test-relay-credential";
    return fn().finally(() => {
      if (saved === undefined) delete process.env[CREDENTIAL_ENV];
      else process.env[CREDENTIAL_ENV] = saved;
    });
  }

  it("serves: readiness, reachability transitions, protected status query, revocation propagation and signal drain", () => withCredential(async () => {
    const relay = await startFakeRelay();
    const adminPort = await freePort();
    const fixture = await writeFixture(relay.url, { admin: { listen: { host: "127.0.0.1", port: adminPort } } });
    const identity = enrolledIdentity(fixture, ["dev.pr.endpoint.2"]);
    const runtime = fakeRuntime();
    const controller = new AbortController();
    const lines: string[] = [];
    try {
      const run = servePrivateEndpointProfile(fixture.configPath, {
        signal: controller.signal,
        identityStore: identity,
        writeLine: (line) => lines.push(line),
        buildRuntime: async () => runtime
      });

      // Readiness: the profile reaches an admitted, reachable session.
      await waitFor(() => parseSurfaces(lines).some((s) => s.reachability === "reachable"));
      const admitted = parseSurfaces(lines).at(-1) as PrivateEndpointSurface;
      expect(admitted.session).toBe("admitted");
      expect(admitted.transport).toBe("open");
      expect(admitted.acceptsNewWork).toBe(true);
      expect(admitted.sessionId).toBeTruthy();
      expect(admitted.revocationPropagation).toBe("applied");
      expect(admitted.recoveryAuthorities).toEqual([{ recoveryKeyId: "rckey.pr.1", state: "active", generation: 3 }]);
      // No secret material ever appears in operator-facing output.
      expect(lines.join("\n")).not.toContain("test-relay-credential");
      expect(lines.join("\n")).not.toContain("BEGIN PRIVATE KEY");

      // The loopback admin listener exposes the same honest surface directly.
      const status = await fetch(`http://127.0.0.1:${adminPort}/status`).then((response) => response.json() as Promise<Record<string, unknown>>);
      expect(status.reachability).toBe("reachable");
      expect(status.profile).toBe("private-endpoint");

      // Trusted control path: a peer-issued operation-query flows through the
      // opaque relay to the endpoint's recovery service and comes back with
      // honest local evidence — never a fabricated outcome.
      const peer = await connectPeer(relay.url);
      try {
        peer.send(JSON.stringify({
          schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
          kind: "operation-query",
          operationId: "op.never.seen.1",
          principalRef: "prin.pr.1",
          generation: 3
        }));
        await waitFor(() => peer.received.some((m) => m.kind === "operation-status"));
        const status2 = peer.received.find((m) => m.kind === "operation-status") as Record<string, unknown>;
        expect(status2.operationId).toBe("op.never.seen.1");
        expect(status2.state).toBe("not_started");
        expect(status2.notStartedEvidence).toBe("local_never_submitted");
      } finally {
        peer.close();
      }

      // Local revocation is staged immediately; the relay has not acknowledged
      // it, so the surface reports pending — never "applied" off local state.
      identity.revoke("dev.pr.endpoint.2");
      const endpointConn = relay.connections[0] as TestWsConn;
      endpointConn.send(JSON.stringify({
        schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
        wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
        kind: "route-status",
        routeId: "route.pr.1",
        state: "reachable",
        generation: 2
      }));
      await waitFor(() => parseSurfaces(lines).at(-1)?.revocationPropagation === "pending");
      expect(parseSurfaces(lines).at(-1)?.localRevocationRevision).toBe(1);

      // Socket loss is surfaced as unreachable; nothing queues new work.
      endpointConn.destroy();
      await waitFor(() => parseSurfaces(lines).at(-1)?.reachability === "endpoint_unreachable");
      const unreachable = parseSurfaces(lines).at(-1) as PrivateEndpointSurface;
      expect(unreachable.acceptsNewWork).toBe(false);
      expect(unreachable.transport).toBe("closed");

      // The profile reconnects with its preserved cursors — the relay restores
      // the session instead of fabricating a fresh admission.
      await waitFor(() => parseSurfaces(lines).at(-1)?.reachability === "reachable" && parseSurfaces(lines).at(-1)?.session === "admitted" && (parseSurfaces(lines).at(-1)?.reconnectGeneration ?? 0) >= 1, 10_000);
      expect(relay.seen.some((m) => m.message.kind === "session-reconnect")).toBe(true);

      // SIGTERM-equivalent: drain and stop, outcome reported honestly.
      controller.abort();
      const result = await run;
      expect(result.outcome).toBe("stopped");
      expect(runtime.closed.count).toBe(1);
    } finally {
      controller.abort();
      await relay.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }), 30_000);

  it("turns a retryable stale-revision rejection into a fresh admission", () => withCredential(async () => {
    let rejected = false;
    const relay = await startFakeRelay({
      onSessionOpen(conn, message) {
        const admission = message.admission as { revocationRevision?: number };
        if (!rejected) {
          rejected = true;
          conn.send(JSON.stringify({
            schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
            wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
            kind: "session-rejected",
            reason: "stale_revocation_revision",
            expectedRevocationRevision: 13,
            retryable: true
          }));
          conn.close(4000, "rejected");
          return;
        }
        const admitted = {
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-admitted",
          sessionId: `sess.retry.${admission.revocationRevision}`,
          purpose: "forward",
          admittedGeneration: 7,
          revocationRevision: admission.revocationRevision,
          routeState: "reachable",
          limits: { ...RELAY_LIMIT_FIELDS },
          reconnectGeneration: 1,
          cursors: { toEndpoint: 0, toEntry: 0 },
          serverNonce: "sn.relay.fixture.retry001"
        };
        conn.send(JSON.stringify(admitted));
      }
    });
    const fixture = await writeFixture(relay.url);
    const runtime = fakeRuntime();
    const controller = new AbortController();
    const lines: string[] = [];
    try {
      const run = servePrivateEndpointProfile(fixture.configPath, {
        signal: controller.signal,
        identityStore: enrolledIdentity(fixture),
        writeLine: (line) => lines.push(line),
        buildRuntime: async () => runtime
      });
      await waitFor(() => parseSurfaces(lines).some((s) => s.reachability === "reachable"));
      const surface = parseSurfaces(lines).at(-1) as PrivateEndpointSurface;
      expect(surface.sessionId).toBe("sess.retry.13");
      expect(surface.endpointRestarts).toBeGreaterThanOrEqual(1);
      controller.abort();
      expect((await run).outcome).toBe("stopped");
    } finally {
      controller.abort();
      await relay.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }), 30_000);

  it("ends the run honestly on a non-retryable rejection", () => withCredential(async () => {
    const relay = await startFakeRelay({
      onSessionOpen(conn) {
        conn.send(JSON.stringify({
          schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
          wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
          kind: "session-rejected",
          reason: "purpose_denied",
          expectedRevocationRevision: 0,
          retryable: false
        }));
        conn.close(4000, "rejected");
      }
    });
    const fixture = await writeFixture(relay.url);
    const controller = new AbortController();
    try {
      const result = await servePrivateEndpointProfile(fixture.configPath, {
        signal: controller.signal,
        identityStore: enrolledIdentity(fixture),
        writeLine: () => {},
        buildRuntime: async () => fakeRuntime()
      });
      expect(result.outcome).toBe("rejected");
      expect(result.code).toBe("private_endpoint_admission_rejected");
    } finally {
      controller.abort();
      await relay.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }), 30_000);
});

describe("inner channel control routing", () => {
  const saved = process.env[CREDENTIAL_ENV];
  function withCredential<T>(fn: () => Promise<T>): Promise<T> {
    process.env[CREDENTIAL_ENV] = "test-relay-credential";
    return fn().finally(() => {
      if (saved === undefined) delete process.env[CREDENTIAL_ENV];
      else process.env[CREDENTIAL_ENV] = saved;
    });
  }

  // Full path: serve() → session admit → onInnerChannel → shared dispatch
  // loop ↔ entry request channel, all over real WebSocket frames and a real
  // pinned mutual-TLS handshake riding opaque relay frame payloads.
  it("serves inner JSON-RPC end to end through the relay, pinned TLS and dispatch loop", () => withCredential(async () => {
    const relay = await startFakeRelay();
    const fixture = await writeFixture(relay.url);
    const runtime = fakeRuntime({
      invoke: async (_context: unknown, invocation: { operationKey?: string; params?: unknown }) => {
        if (invocation.operationKey === "op.slow") {
          // A healthy in-flight operation takes real time — nothing in the
          // profile may cut it off on a timer.
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { kind: "complete", value: { slow: true } };
        }
        if (invocation.operationKey === "op.refused") {
          return { kind: "failure", code: "policy_denied", message: "denied", status: 403, effectOutcome: "not_started" };
        }
        return { kind: "complete", value: { echo: invocation.params } };
      }
    });
    const controller = new AbortController();
    const lines: string[] = [];
    try {
      const run = servePrivateEndpointProfile(fixture.configPath, {
        signal: controller.signal,
        identityStore: enrolledIdentity(fixture),
        writeLine: (line) => lines.push(line),
        buildRuntime: async () => runtime
      });
      await waitFor(() => parseSurfaces(lines).at(-1)?.reachability === "reachable");
      const sessionId = (parseSurfaces(lines).at(-1) as PrivateEndpointSurface).sessionId as string;
      expect(sessionId).toBeTruthy();

      // Entry side: pinned inner TLS over a frame pump riding the real relay.
      const serverPin = spkiSha256Base64Url(createPublicKey({ key: fixture.endpointCert, format: "pem" }));
      const peer = await connectPeer(relay.url);
      try {
        // The frame's sessionId is the *sender's* session — the relay forwards
        // it verbatim and the endpoint binds its inner channel to it.
        const peerSessionId = String((peer.received.find((m) => m.kind === "session-admitted") as { sessionId: string }).sessionId);
        let seq = 1;
        const pump = createRelayFrameDuplex({
          sendFrame: (payload) => {
            peer.send(JSON.stringify(createFrame({
              sessionId: peerSessionId,
              routeId: "route.pr.1",
              seq: seq,
              messageId: `msg.entry.${seq}`,
              payload
            })));
            seq += 1;
            return true;
          }
        });
        peer.onMessage = (message) => {
          if (message.kind === "frame") pump.feed(String(message.payload));
        };
        const client = createInnerTlsClient({
          socket: pump,
          key: fixture.entryKey,
          cert: fixture.entryCert,
          pinnedPeerSpki: [serverPin],
          handshakeTimeoutMs: 10_000
        });
        // Establishment proves the endpoint's onInnerChannel wiring ran: the
        // dispatch loop is attached to this very channel.
        await client.established;

        const requests = createInnerRequestChannel({ socket: client.socket });
        const echo = await requests.request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "svc/tool", arguments: { a: 1 } } }) as { kind?: string; value?: { echo?: { a?: number } } };
        expect(echo?.kind).toBe("complete");
        expect(echo?.value?.echo?.a).toBe(1);

        const slow = await requests.request({ id: 2, method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.slow" } }) as { kind?: string; value?: { slow?: boolean } };
        expect(slow?.kind).toBe("complete");
        expect(slow?.value?.slow).toBe(true);

        const refused = await requests.request({ id: 3, method: "tools/call", params: { name: "svc/tool", arguments: {}, operationKey: "op.refused" } }) as { kind?: string; code?: string; effectOutcome?: string };
        expect(refused?.kind).toBe("failure");
        expect(refused?.code).toBe("policy_denied");
        expect(refused?.effectOutcome).toBe("not_started");

        // Unknown methods resolve to a null outcome — never fabricated.
        const unknown = await requests.request({ id: 4, method: "meshrix/unknown", params: {} });
        expect(unknown).toBeNull();
        expect(requests.pendingCount).toBe(0);

        client.close();
      } finally {
        peer.close();
      }
      controller.abort();
      expect((await run).outcome).toBe("stopped");
    } finally {
      controller.abort();
      await relay.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }), 30_000);

  // Regression: a second entry session replaces the first while the endpoint's
  // own session stays streaming. The endpoint must rebind its inner channel to
  // the new peer session — silently feeding the new handshake into the dead
  // channel was the observed cross-machine failure.
  it("re-establishes the inner channel for a replaced entry session", () => withCredential(async () => {
    const relay = await startFakeRelay();
    const fixture = await writeFixture(relay.url);
    const runtime = fakeRuntime({
      invoke: async (_context: unknown, invocation: { params?: unknown }) =>
        ({ kind: "complete", value: { echo: invocation.params } })
    });
    const controller = new AbortController();
    const lines: string[] = [];
    const serverPin = spkiSha256Base64Url(createPublicKey({ key: fixture.endpointCert, format: "pem" }));

    const connectEntry = async () => {
      const peer = await connectPeer(relay.url);
      const admitted = peer.received.find((m) => m.kind === "session-admitted") as { sessionId: string; cursors?: { toEndpoint?: number } };
      const peerSessionId = String(admitted.sessionId);
      // Honor the route cursor exactly like the real driver: a fresh session
      // continues numbering past the relay's recorded position.
      let seq = Number(admitted.cursors?.toEndpoint ?? 0) + 1;
      const pump = createRelayFrameDuplex({
        sendFrame: (payload) => {
          peer.send(JSON.stringify(createFrame({
            sessionId: peerSessionId,
            routeId: "route.pr.1",
            seq,
            messageId: `msg.entry.${seq}`,
            payload
          })));
          seq += 1;
          return true;
        }
      });
      peer.onMessage = (message) => {
        if (message.kind === "frame") pump.feed(String(message.payload));
      };
      const client = createInnerTlsClient({
        socket: pump,
        key: fixture.entryKey,
        cert: fixture.entryCert,
        pinnedPeerSpki: [serverPin],
        handshakeTimeoutMs: 10_000
      });
      await client.established;
      return { peer, client, requests: createInnerRequestChannel({ socket: client.socket }) };
    };

    try {
      const run = servePrivateEndpointProfile(fixture.configPath, {
        signal: controller.signal,
        identityStore: enrolledIdentity(fixture),
        writeLine: (line) => lines.push(line),
        buildRuntime: async () => runtime
      });
      await waitFor(() => parseSurfaces(lines).at(-1)?.reachability === "reachable");

      // First entry session: full handshake + a real dispatched call.
      const first = await connectEntry();
      const r1 = await first.requests.request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "svc/tool", arguments: { a: 1 } } }) as { kind?: string; value?: { echo?: { a?: number } } };
      expect(r1?.kind).toBe("complete");
      expect(r1?.value?.echo?.a).toBe(1);
      // The entry session ends silently — the endpoint's own session stays
      // streaming, exactly like the failed cross-machine run.
      first.client.close();
      first.peer.close();

      // Replacement session: handshake must land on a fresh inner channel.
      const second = await connectEntry();
      const r2 = await second.requests.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "svc/tool", arguments: { a: 2 } } }) as { kind?: string; value?: { echo?: { a?: number } } };
      expect(r2?.kind).toBe("complete");
      expect(r2?.value?.echo?.a).toBe(2);
      second.client.close();
      second.peer.close();

      controller.abort();
      expect((await run).outcome).toBe("stopped");
    } finally {
      controller.abort();
      await relay.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }), 30_000);
});

// --- helpers used by the serve suite ----------------------------------------

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface PeerClient {
  readonly received: Record<string, unknown>[];
  /** Optional per-message hook, invoked with every decoded relay message. */
  onMessage: ((message: Record<string, unknown>) => void) | undefined;
  send(data: string): void;
  close(): void;
}

async function connectPeer(url: string): Promise<PeerClient> {
  const { WebSocket } = await import("undici");
  const ws = new WebSocket(url);
  const received: Record<string, unknown>[] = [];
  const client: { onMessage: PeerClient["onMessage"] } = { onMessage: undefined };
  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      received.push(message);
      client.onMessage?.(message);
    } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("peer websocket failed to open")));
  });
  // The peer also opens a session so the relay forwards channel traffic to it.
  ws.send(JSON.stringify({
    schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
    wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
    kind: "session-open",
    purpose: "forward",
    admission: {
      tenantId: "tenant.pr.1",
      deviceId: "dev.pr.entry.9",
      routeId: "route.pr.1",
      role: "entry",
      mode: "personal",
      admissionGeneration: 7,
      revocationRevision: 0
    },
    clientNonce: "nonce.peer.fixture.000001"
  }));
  await waitFor(() => received.some((m) => m.kind === "session-admitted"));
  return {
    received,
    get onMessage() { return client.onMessage; },
    set onMessage(handler) { client.onMessage = handler; },
    send: (data) => ws.send(data),
    close: () => ws.close()
  };
}
