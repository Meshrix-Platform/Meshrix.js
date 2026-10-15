import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_API_ROUTES, type AccountActionTarget, type AccountAuthorityBinding, type AccountManagedRouteBinding } from "@meshrix/contracts/account";
import {
  PRIVATE_RELAY_LIMITS,
  createRouteStatus,
  createSessionAdmitted,
  createSessionClose,
  createSessionRejected,
  createSessionRestored
} from "@meshrix/contracts/private-relay";
import { createEndpointIdentityStore, createFileEndpointIdentityDurablePort } from "@meshrix/gateway/private-endpoint";
import {
  PeerClient,
  createInMemoryPeerClientStore,
  peerIdentityPublicDescriptor,
  staticPeerDirectory
} from "@meshrix/peer-client";
import {
  createFilePeerCryptoStore,
  createInMemoryPeerCryptoStore,
  createPeerIdentity,
  loadPeerIdentity,
  type PeerIdentity
} from "@meshrix/peer-crypto";
import { isPeerSchemaMessage, type WssRelayTransport } from "@meshrix/entry-transport";
import type { CustodyAdapter } from "@meshrix/entry";

import { NODE_RUNTIME_VERSION, nodeRuntimeTarget } from "../../../apps/entry-gui/tools/node-runtime.mjs";
import { parseReleaseServiceInputs } from "../../../apps/entry-gui/tools/release-service-config.mjs";
import { PersonalEndpointRuntime } from "../../../apps/entry-gui/src/main/personal-endpoint.ts";
import { normalizeRelayBase, relayHttpBase, relaySessionUrl } from "../../../apps/entry-gui/src/main/relay-address.ts";
import { ENTRY_SERVICE_CONFIG_SCHEMA, parseEntryServiceConfig } from "../../../apps/entry-gui/src/main/service-config.ts";
import { FakePeerRelay } from "../peer-client/fake-relay.ts";

const ACCOUNT: AccountAuthorityBinding = Object.freeze({ accountId: "account.personal.fixture", authEpoch: 4 });
const ENTRY_DEVICE_ID = "device.entry.fixture";
const RELAY_ORIGIN = "wss://relay.example.test";
const ACCOUNT_ORIGIN = "https://account.example.test";
const dirs: string[] = [];
const SESSION_LIMITS = Object.freeze({
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
});

describe("installed relay service addresses", () => {
  it("packages the same public host with the required relay prefix", () => {
    expect(parseReleaseServiceInputs({
      accountOrigin: "https://meshrix.example.invalid/",
      relayService: "wss://meshrix.example.invalid/relay/"
    })).toEqual({
      accountOrigin: "https://meshrix.example.invalid",
      relayService: "wss://meshrix.example.invalid/relay"
    });
    expect(() => parseReleaseServiceInputs({
      accountOrigin: "https://account.example.invalid",
      relayService: "wss://relay.example.invalid/relay"
    })).toThrow(/one HTTPS\/WSS public host/u);
  });

  it("preserves the public relay path for sessions and HTTP vault calls", () => {
    const relay = normalizeRelayBase("wss://meshrix.example.invalid/relay/");

    expect(relay.toString()).toBe("wss://meshrix.example.invalid/relay");
    expect(relaySessionUrl(relay, "tenant.entry.test", "route.entry.test"))
      .toBe("wss://meshrix.example.invalid/relay/session/tenant.entry.test/route.entry.test");
    expect(relayHttpBase(relay)).toBe("https://meshrix.example.invalid/relay");
    expect(parseEntryServiceConfig({
      schemaVersion: ENTRY_SERVICE_CONFIG_SCHEMA,
      accountOrigin: "https://meshrix.example.invalid",
      relayService: "wss://meshrix.example.invalid/relay/"
    }).relayService).toBe("wss://meshrix.example.invalid/relay");
  });

  it("rejects relay prefixes that can alter path routing", () => {
    expect(() => normalizeRelayBase("wss://meshrix.example.invalid/relay/%2fprivate"))
      .toThrowError(expect.objectContaining({ code: "private_endpoint_relay_invalid" }));
    expect(() => parseEntryServiceConfig({
      schemaVersion: ENTRY_SERVICE_CONFIG_SCHEMA,
      accountOrigin: "https://meshrix.example.invalid",
      relayService: "wss://meshrix.example.invalid/relay?route=/private"
    })).toThrowError(expect.objectContaining({ code: "service_config_invalid" }));
  });
});

describe("installed Node sidecar pins", () => {
  it("defines checksummed runtime assets for every supported Tauri target", () => {
    expect(NODE_RUNTIME_VERSION).toMatch(/^24\.\d+\.\d+$/u);
    for (const targetTriple of [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "aarch64-pc-windows-msvc",
      "x86_64-pc-windows-msvc",
      "aarch64-unknown-linux-gnu",
      "x86_64-unknown-linux-gnu"
    ]) {
      const runtime = nodeRuntimeTarget(targetTriple);
      expect(runtime.artifact.length).toBeGreaterThan(0);
      expect(runtime.downloadSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(runtime.binarySha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(() => nodeRuntimeTarget("x86_64-unknown-linux-musl")).toThrow(/No pinned Node\.js/u);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function rawEd25519PublicKey(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32).toString("base64url");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function memoryCustody(): CustodyAdapter {
  const values = new Map<string, Uint8Array>();
  return Object.freeze({
    kind: "test-memory",
    async available() { return true; },
    async storeSecret({ ref, secret }: { ref: string; secret: Uint8Array }) { values.set(ref, new Uint8Array(secret)); },
    async loadSecret({ ref }: { ref: string }) { const value = values.get(ref); return value ? new Uint8Array(value) : null; },
    async deleteSecret({ ref }: { ref: string }) { values.delete(ref); }
  });
}

class ControlledRelayTransport implements WssRelayTransport {
  readonly handlers: WssRelayTransport["handlers"] = {};
  readonly ready = Promise.resolve();
  readonly sent: Record<string, unknown>[] = [];
  restoredCount = 0;
  readonly #peerTransport;
  readonly #route: { tenantId: string; routeId: string; deviceId: string };
  #readyState = 1;
  #closed = false;
  #holdNextInboundKind: string | null = null;
  #heldInbound: Record<string, unknown> | null = null;
  deferAdmission = false;

  constructor(relay: FakePeerRelay, route: { tenantId: string; routeId: string; deviceId: string }) {
    this.#route = route;
    this.#peerTransport = relay.attach({ ...route });
    this.#peerTransport.onMessage((message) => {
      if (this.#holdNextInboundKind === message.kind) {
        this.#holdNextInboundKind = null;
        this.#heldInbound = message;
        return;
      }
      this.handlers.onMessage?.(message);
    });
  }

  get readyState(): number { return this.#readyState; }
  get closed(): boolean { return this.#closed; }
  get heldInboundKind(): string | null { return typeof this.#heldInbound?.kind === "string" ? this.#heldInbound.kind : null; }

  holdNextInboundKind(kind: string): void { this.#holdNextInboundKind = kind; }

  send(message: Readonly<Record<string, unknown>>): void {
    const value = { ...message };
    this.sent.push(value);
    if (isPeerSchemaMessage(value)) {
      void this.#peerTransport.send(value);
      return;
    }
    if (value.kind === "session-open") {
      if (this.deferAdmission) return;
      this.admit();
      return;
    }
    if (value.kind === "session-reconnect") {
      setImmediate(() => {
        this.restoredCount += 1;
        this.handlers.onMessage?.(createSessionRestored({
          sessionId: "session.personal.restored",
          reconnectGeneration: value.reconnectGeneration,
          gaps: [],
          limits: SESSION_LIMITS,
          cursors: { toEndpoint: 0, toEntry: 0 }
        }));
        this.handlers.onMessage?.(createRouteStatus({ routeId: this.#route.routeId, state: "reachable", generation: 1 }));
      });
    }
  }

  admit(): void {
    this.handlers.onMessage?.(createSessionAdmitted({
        sessionId: "session.personal.first",
        purpose: "forward",
        admittedGeneration: 1,
        revocationRevision: 0,
        routeState: "reachable",
        limits: SESSION_LIMITS,
        reconnectGeneration: 1,
        cursors: { toEndpoint: 0, toEntry: 0 },
        serverNonce: "fixtureServerNonce"
      }));
  }

  close(): void {
    this.#closed = true;
    this.#readyState = 3;
  }

  async reopen(): Promise<void> {
    if (this.#closed) throw new Error("closed transport cannot reopen");
    this.#readyState = 1;
    this.handlers.onSocketOpen?.();
  }

  drop(): void {
    this.#readyState = 3;
    this.handlers.onSocketClose?.(1006, "synthetic connection loss", false);
  }
}

interface PersonalFixture {
  readonly dir: string;
  readonly runtime: PersonalEndpointRuntime;
  readonly options: Parameters<typeof PersonalEndpointRuntime.create>[0];
  readonly custody: CustodyAdapter;
  readonly relay: FakePeerRelay;
  readonly scheduled: Array<() => void>;
  readonly transports: ControlledRelayTransport[];
  readonly claimPrepareCalls: () => number;
  readonly setManagedRouteUnavailable: (unavailable: boolean) => void;
  readonly account: AccountAuthorityBinding;
  readonly entryTarget: AccountActionTarget;
}

async function makePersonalFixture(fixtureOptions: { readonly deferAdmission?: boolean } = {}): Promise<PersonalFixture> {
  const dir = await mkdtemp(join(tmpdir(), "meshrix-personal-endpoint-"));
  dirs.push(dir);
  const custody = memoryCustody();
  const relay = new FakePeerRelay();
  const scheduled: Array<() => void> = [];
  const transports: ControlledRelayTransport[] = [];
  const desktop = generateKeyPairSync("ed25519");
  let managedRouteUnavailable = false;
  let claimPrepareCalls = 0;
  let managedRoute: AccountManagedRouteBinding | null = null;
  let entryTarget: AccountActionTarget | null = null;
  const entryPublicKey = rawEd25519PublicKey(generateKeyPairSync("ed25519").publicKey);
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(String(request));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.pathname === ACCOUNT_API_ROUTES.deviceEndpointClaimPrepare) {
      claimPrepareCalls += 1;
      const endpointPublicKey = String(body.endpointPublicKey);
      managedRoute = Object.freeze({
        accountId: ACCOUNT.accountId,
        authEpoch: ACCOUNT.authEpoch,
        tenantId: "tenant.personal.fixture",
        routeId: String(body.routeId),
        endpointDeviceId: String(body.endpointDeviceId),
        endpointPublicKey,
        endpointPinRef: String(body.endpointPinRef),
        vaultId: "vault.personal.fixture"
      });
      const target: AccountActionTarget = Object.freeze({
        tenantId: managedRoute.tenantId,
        routeId: managedRoute.routeId,
        deviceId: managedRoute.endpointDeviceId,
        devicePublicKey: endpointPublicKey,
        grantRef: "grant.endpoint.fixture",
        scopes: Object.freeze(["endpoint:claim"])
      });
      return jsonResponse({
        claimId: "claim.personal.fixture",
        account: ACCOUNT,
        vaultId: "vault.personal.fixture",
        target,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.deviceEndpointClaimComplete) {
      if (!managedRoute) throw new Error("claim prepare must precede completion");
      return jsonResponse({
        claimed: true,
        account: ACCOUNT,
        tenantId: managedRoute.tenantId,
        routeId: managedRoute.routeId,
        endpointDeviceId: managedRoute.endpointDeviceId,
        endpointPublicKey: managedRoute.endpointPublicKey,
        endpointPinRef: managedRoute.endpointPinRef,
        vaultId: managedRoute.vaultId,
        mode: "personal",
        relayAdmission: "R".repeat(48),
        admissionGeneration: 1,
        revocationRevision: 0,
        expiresAt: null
      });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.deviceManagedRoute) {
      if (managedRouteUnavailable) return jsonResponse({ error: { code: "account_authority_refused" } }, 503);
      return jsonResponse({ managedRoute });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.deviceCurrentBinding) {
      if (!entryTarget || body.peerDeviceId !== entryTarget.deviceId) return jsonResponse({ error: { code: "not_found" } }, 404);
      return jsonResponse({ account: ACCOUNT, target: entryTarget, authorizedScopes: entryTarget.scopes });
    }
    throw new Error(`unexpected account authority request: ${url.pathname}`);
  };
  let runtime: PersonalEndpointRuntime;
  const options: Parameters<typeof PersonalEndpointRuntime.create>[0] = {
    dataDir: dir,
    custody,
    relayService: RELAY_ORIGIN,
    accountOrigin: ACCOUNT_ORIGIN,
    fetch,
    schedule(callback) { scheduled.push(callback); return callback; },
    cancelSchedule(handle) {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
    createRelayTransport() {
      const endpoint = runtime.endpointIdentity;
      if (!endpoint) throw new Error("endpoint must be enrolled before starting its relay");
      relay.pair(endpoint.tenantId, endpoint.routeId, endpoint.endpointDeviceId, ENTRY_DEVICE_ID);
      const transport = new ControlledRelayTransport(relay, {
        tenantId: endpoint.tenantId,
        routeId: endpoint.routeId,
        deviceId: endpoint.endpointDeviceId
      });
      transport.deferAdmission = fixtureOptions.deferAdmission === true;
      transports.push(transport);
      return transport;
    }
  };
  runtime = await PersonalEndpointRuntime.createAndEnroll(options, {
    account: ACCOUNT,
    accountCredential: "S".repeat(48),
    desktopDeviceId: "device.desktop.fixture",
    desktopPublicKey: rawEd25519PublicKey(desktop.publicKey),
    desktopPrivateKey: desktop.privateKey,
    // Account permits are high-entropy base64url secrets, not opaque IDs;
    // leading '_' and '-' are valid and must survive endpoint enrollment.
    requestFreshStepUp: async ({ account, target }) => ({ account, permitId: "_" + "A".repeat(42), target })
  });
  const endpoint = runtime.endpointIdentity;
  if (!endpoint) throw new Error("endpoint enrollment did not persist its route identity");
  entryTarget = Object.freeze({
    tenantId: endpoint.tenantId,
    routeId: endpoint.routeId,
    deviceId: ENTRY_DEVICE_ID,
    devicePublicKey: entryPublicKey,
    grantRef: "grant.entry.fixture",
    scopes: Object.freeze(["peer:message"])
  });
  return {
    dir,
    runtime,
    options,
    custody,
    relay,
    scheduled,
    transports,
    claimPrepareCalls: () => claimPrepareCalls,
    setManagedRouteUnavailable(value) { managedRouteUnavailable = value; },
    account: ACCOUNT,
    entryTarget
  };
}

function seedPairedEntry(fixture: PersonalFixture, identity: PeerIdentity, target: AccountActionTarget): void {
  const endpoint = fixture.runtime.endpointIdentity!;
  const identityPath = join(fixture.dir, "personal-endpoint", "endpoint-identity.json");
  const store = createEndpointIdentityStore(createFileEndpointIdentityDurablePort(identityPath));
  store.enrollAccountDevice({
    account: fixture.account,
    target,
    mode: "personal",
    entryPeerIdentity: peerIdentityPublicDescriptor(identity)
  });
  fixture.relay.pair(endpoint.tenantId, endpoint.routeId, endpoint.endpointDeviceId, target.deviceId);
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("PersonalEndpointRuntime resilience", () => {
  it("preserves the enrolled route and Signal identity across temporary startup authority loss and restart", async () => {
    const fixture = await makePersonalFixture();
    const endpoint = fixture.runtime.endpointIdentity!;
    const peerStorePath = join(fixture.dir, "personal-endpoint", "peer", endpoint.routeId, "crypto");
    const before = await loadPeerIdentity(createFilePeerCryptoStore(peerStorePath));
    expect(before).not.toBeNull();

    fixture.setManagedRouteUnavailable(true);
    await expect(fixture.runtime.start()).rejects.toMatchObject({ code: "account_authority_unavailable" });
    expect(fixture.runtime.snapshot().state).toBe("unreachable");
    expect(fixture.runtime.endpointIdentity).toEqual(endpoint);

    fixture.setManagedRouteUnavailable(false);
    await fixture.runtime.start();
    await eventually(async () => (await fixture.runtime.peerClient?.localBundle())?.revision === 1);
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    expect(fixture.runtime.snapshot().state).toBe("connected");
    expect(fixture.claimPrepareCalls()).toBe(1);

    await fixture.runtime.stop();
    const restarted = await PersonalEndpointRuntime.create(fixture.options);
    const after = await loadPeerIdentity(createFilePeerCryptoStore(peerStorePath));
    expect(after && peerIdentityPublicDescriptor(after)).toEqual(before && peerIdentityPublicDescriptor(before));
    expect(restarted.endpointIdentity).toEqual(endpoint);
    expect(fixture.claimPrepareCalls()).toBe(1);
    await restarted.stop();
  });

  it("publishes the stable bundle before reporting the first admitted route ready", async () => {
    const fixture = await makePersonalFixture({ deferAdmission: true });
    const endpoint = fixture.runtime.endpointIdentity!;

    await fixture.runtime.start();
    const transport = fixture.transports[0];
    const client = fixture.runtime.peerClient;
    expect(transport).toBeDefined();
    expect(client).not.toBeNull();
    expect(fixture.runtime.snapshot().acceptsNewWork).toBe(false);

    let releasePublication!: () => void;
    let publicationStarted!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const publicationStarting = new Promise<void>((resolve) => { publicationStarted = resolve; });
    const publishBundle = client!.publishBundle.bind(client!);
    const publishBundleSpy = vi.spyOn(client!, "publishBundle").mockImplementation(async () => {
      publicationStarted();
      await publicationGate;
      return publishBundle();
    });
    transport!.admit();
    await publicationStarting;
    expect(publishBundleSpy).toHaveBeenCalledTimes(1);
    expect((await fixture.runtime.peerClient?.localBundle())?.revision ?? 0).toBe(0);
    expect(fixture.runtime.snapshot().acceptsNewWork).toBe(false);
    expect(fixture.runtime.snapshot().state).not.toBe("connected");

    releasePublication();
    await eventually(async () => (await fixture.runtime.peerClient?.localBundle())?.revision === 1);
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    expect(fixture.runtime.snapshot().state).toBe("connected");
    expect(publishBundleSpy).toHaveBeenCalledTimes(1);
    await fixture.runtime.stop();
  });

  it("makes concurrent stop callers wait for the same Peer durable drain", async () => {
    const fixture = await makePersonalFixture();
    await fixture.runtime.start();
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    const client = fixture.runtime.peerClient!;
    const dispose = client.dispose.bind(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(client, "dispose").mockImplementation(async () => { await gate; await dispose(); });
    let completed = 0;
    const first = fixture.runtime.stop().then(() => { completed += 1; });
    const second = fixture.runtime.stop().then(() => { completed += 1; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(completed).toBe(2);
  });

  it("reopens a dropped admitted relay session and restores its route", async () => {
    const fixture = await makePersonalFixture();
    await fixture.runtime.start();
    const endpoint = fixture.runtime.endpointIdentity!;
    await eventually(async () => (await fixture.runtime.peerClient?.localBundle())?.revision === 1);
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    const transport = fixture.transports[0];
    expect(transport).toBeDefined();
    expect(fixture.runtime.snapshot().routeState).toBe("reachable");

    transport!.drop();
    expect(fixture.runtime.snapshot().routeState).toBe("unreachable");
    const reconnect = fixture.scheduled.shift();
    expect(reconnect).toBeTypeOf("function");
    reconnect!();
    await eventually(() => transport!.sent.some((message) => message.kind === "session-reconnect"));
    await eventually(() => transport!.restoredCount === 1);
    await eventually(() => fixture.runtime.snapshot().routeState === "reachable");
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    expect(fixture.runtime.snapshot().relayState).toBe("open");
    expect(fixture.runtime.snapshot().acceptsNewWork).toBe(true);
    expect((await fixture.runtime.peerClient?.localBundle())?.revision).toBe(1);

    // A terminal close from the superseded admission must not tear down the
    // newly restored session on the same reusable transport object.
    transport!.handlers.onMessage?.(createSessionRejected({
      reason: "authority_stale",
      expectedRevocationRevision: 1,
      retryable: true
    }));
    transport!.handlers.onMessage?.(createSessionClose({
      sessionId: "session.personal.first",
      reason: "reconnect",
      finalCursors: { toEndpoint: 0, toEntry: 0 }
    }));
    expect(fixture.runtime.snapshot().acceptsNewWork).toBe(true);
    expect(fixture.runtime.snapshot().routeState).toBe("reachable");
    expect(transport!.readyState).toBe(1);
    await fixture.runtime.stop();
  });

  it("refuses Peer controls before admission and resumes a retryable rejection after socket close", async () => {
    const fixture = await makePersonalFixture({ deferAdmission: true });
    const endpoint = fixture.runtime.endpointIdentity!;
    await fixture.runtime.start();
    const transport = fixture.transports[0]!;
    const client = fixture.runtime.peerClient!;
    const entryChannel = fixture.relay.attach({
      tenantId: endpoint.tenantId,
      routeId: endpoint.routeId,
      deviceId: ENTRY_DEVICE_ID
    });
    entryChannel.onMessage(() => {});
    await eventually(() => client.presence(ENTRY_DEVICE_ID)?.state === "reachable");

    await expect(client.publishBundle()).rejects.toMatchObject({ code: "peer_client_transport" });
    expect(transport.sent.some((message) => message.kind === "peer-bundle-publish")).toBe(false);
    expect(transport.readyState).toBe(1);

    transport.handlers.onMessage?.(createSessionRejected({
      reason: "authority_stale",
      expectedRevocationRevision: 1,
      retryable: true
    }));
    expect(fixture.runtime.snapshot().routeState).toBe("unreachable");
    expect(client.presence(ENTRY_DEVICE_ID)).toBeNull();
    // The retryable rejection clears Peer reachability immediately while
    // preserving the socket until the server's ensuing close event.
    expect(transport.readyState).toBe(1);
    expect(fixture.scheduled).toHaveLength(0);
    transport.drop();
    expect(fixture.scheduled).toHaveLength(1);
    fixture.scheduled.shift()!();
    await eventually(() => transport.sent.filter((message) => message.kind === "session-open").length === 2);
    await fixture.runtime.stop();
    fixture.relay.detach(ENTRY_DEVICE_ID, endpoint.routeId, endpoint.tenantId);
  });

  it("settles pending Peer controls and resumes after a current capacity close", async () => {
    const fixture = await makePersonalFixture();
    const endpoint = fixture.runtime.endpointIdentity!;
    await fixture.runtime.start();
    await eventually(async () => (await fixture.runtime.peerClient?.localBundle())?.revision === 1);
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);

    const transport = fixture.transports[0]!;
    const client = fixture.runtime.peerClient!;
    const entryChannel = fixture.relay.attach({
      tenantId: endpoint.tenantId,
      routeId: endpoint.routeId,
      deviceId: ENTRY_DEVICE_ID
    });
    entryChannel.onMessage(() => {});
    await eventually(() => client.presence(ENTRY_DEVICE_ID)?.state === "reachable");

    transport.holdNextInboundKind("peer-bundle-published");
    const pendingPublish = client.publishBundle();
    const pendingFailure = expect(pendingPublish).rejects.toMatchObject({ code: "peer_client_transport" });
    await eventually(() => transport.heldInboundKind === "peer-bundle-published");

    transport.handlers.onMessage?.(createSessionClose({
      sessionId: "session.personal.first",
      reason: "capacity_exceeded",
      finalCursors: { toEndpoint: 0, toEntry: 0 }
    }));
    await pendingFailure;

    expect(fixture.runtime.snapshot().routeState).toBe("unreachable");
    expect(client.presence(ENTRY_DEVICE_ID)).toBeNull();
    // The close frame retires the session but leaves the transport available
    // for the real socket-close event to enter its normal recovery path.
    expect(transport.readyState).toBe(1);
    transport.drop();
    const reconnect = fixture.scheduled.shift();
    expect(reconnect).toBeTypeOf("function");
    reconnect!();
    await eventually(() => transport.sent.some((message) => message.kind === "session-reconnect"));
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    expect((await client.localBundle())?.revision).toBe(1);
    await fixture.runtime.stop();
    fixture.relay.detach(ENTRY_DEVICE_ID, endpoint.routeId, endpoint.tenantId);
  });

  it("does not reconnect after a nonretryable rejection", async () => {
    const fixture = await makePersonalFixture({ deferAdmission: true });
    await fixture.runtime.start();
    const transport = fixture.transports[0]!;

    transport.handlers.onMessage?.(createSessionRejected({
      reason: "purpose_denied",
      expectedRevocationRevision: 1,
      retryable: false
    }));
    expect(fixture.runtime.snapshot().routeState).toBe("unreachable");
    transport.drop();
    expect(fixture.scheduled).toHaveLength(0);
    await fixture.runtime.stop();
  });

  it("keeps the route not-ready after bundle publication fails and retries on the same admission", async () => {
    const fixture = await makePersonalFixture({ deferAdmission: true });
    const endpoint = fixture.runtime.endpointIdentity!;
    const peerStorePath = join(fixture.dir, "personal-endpoint", "peer", endpoint.routeId, "crypto");

    await fixture.runtime.start();
    const transport = fixture.transports[0];
    const client = fixture.runtime.peerClient;
    expect(transport).toBeDefined();
    expect(client).not.toBeNull();
    const identityBefore = await loadPeerIdentity(createFilePeerCryptoStore(peerStorePath));
    expect(identityBefore).not.toBeNull();
    const publishBundle = vi.spyOn(client!, "publishBundle").mockRejectedValueOnce(new Error("transient publication failure"));

    transport!.admit();
    expect(fixture.runtime.snapshot().acceptsNewWork).toBe(false);
    await eventually(() => fixture.scheduled.length > 0);
    expect(fixture.runtime.snapshot().state).not.toBe("connected");
    expect((await fixture.runtime.peerClient?.localBundle())?.revision ?? 0).toBe(0);
    expect(transport!.restoredCount).toBe(0);
    expect(publishBundle).toHaveBeenCalledTimes(1);

    const retry = fixture.scheduled.shift();
    expect(retry).toBeTypeOf("function");
    retry!();
    await eventually(async () => (await fixture.runtime.peerClient?.localBundle())?.revision === 1);
    await eventually(() => fixture.runtime.snapshot().acceptsNewWork);
    const identityAfter = await loadPeerIdentity(createFilePeerCryptoStore(peerStorePath));
    expect(identityAfter && peerIdentityPublicDescriptor(identityAfter))
      .toEqual(identityBefore && peerIdentityPublicDescriptor(identityBefore));
    expect(publishBundle).toHaveBeenCalledTimes(2);
    expect(transport!.restoredCount).toBe(0);
    expect(fixture.runtime.snapshot().state).toBe("connected");
    await fixture.runtime.stop();
  });

  it("keeps authenticated inbound work pending until an application handler attaches", async () => {
    const fixture = await makePersonalFixture();
    const endpoint = fixture.runtime.endpointIdentity!;
    const entryCryptoStore = createInMemoryPeerCryptoStore();
    const entryIdentity = await createPeerIdentity({
      localStore: entryCryptoStore,
      peerId: `peer:${endpoint.tenantId}:${endpoint.routeId}:${ENTRY_DEVICE_ID}`
    });
    const target = fixture.entryTarget;
    seedPairedEntry(fixture, entryIdentity, target);
    await fixture.runtime.stop();
    const runtime = await PersonalEndpointRuntime.create(fixture.options);
    let entryClient: PeerClient | null = null;
    try {
      await runtime.start();
      await eventually(async () => (await runtime.peerClient?.localBundle())?.revision === 1);
      await eventually(() => runtime.snapshot().acceptsNewWork);
  
      entryClient = new PeerClient({
        identity: entryIdentity,
        cryptoStore: entryCryptoStore,
        clientStore: createInMemoryPeerClientStore(),
        transport: fixture.relay.attach({ tenantId: endpoint.tenantId, routeId: endpoint.routeId, deviceId: ENTRY_DEVICE_ID }),
        route: { tenantId: endpoint.tenantId, routeId: endpoint.routeId, deviceId: ENTRY_DEVICE_ID },
        directory: staticPeerDirectory({ [endpoint.endpointDeviceId]: peerIdentityPublicDescriptor(await loadPeerIdentity(
          createFilePeerCryptoStore(join(fixture.dir, "personal-endpoint", "peer", endpoint.routeId, "crypto"))
        ) as PeerIdentity) })
      });
      const sent = await entryClient.sendMessage(endpoint.endpointDeviceId, "retained until the host is ready");
      await eventually(async () => {
        const page = await runtime.peerClient!.inbox.pendingDispatchPage(0, 32);
        return page.items.length === 1 && page.items[0]?.deliveryAck !== null;
      });
      expect((await runtime.peerClient!.inbox.pendingDispatchPage(0, 32)).items[0]).toMatchObject({
        messageId: sent.messageId,
        dispatch: "pending",
        deliveryAck: expect.objectContaining({ messageId: sent.messageId, signature: expect.any(String) })
      });
  
      let handled = 0;
      const unsubscribe = runtime.onInboundMessage(async ({ message }) => {
        handled += 1;
        expect(new TextDecoder().decode(message.plaintext)).toBe("retained until the host is ready");
        return "accepted_by_agent";
      });
      await eventually(async () => {
        const inbox = runtime.peerClient!.inbox;
        return (await inbox.entry(inbox.identity(sent.messageId, ENTRY_DEVICE_ID)))?.dispatch === "accepted_by_agent";
      });
      await runtime.peerClient!.retryPendingDispatch();
      expect(handled).toBe(1);
      unsubscribe();
  
      const address = { tenantId: endpoint.tenantId, routeId: endpoint.routeId,
        localDeviceId: endpoint.endpointDeviceId, peerDeviceId: ENTRY_DEVICE_ID };
      expect(await runtime.resolvePeerAuthority(address)).toBe("current");
    } finally {
      await runtime.stop();
      await entryClient?.dispose();
    }
  });
});
