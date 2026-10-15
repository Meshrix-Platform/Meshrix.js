/**
 * Real-loop integration for the installed entry product.
 *
 * The product service under test is the real `EntryProductService`; the relay
 * is the purpose-aware in-memory hub; the transports are the real
 * `EntryRelaySession`/`EntryRecoveryChannel` drivers; the vault keeps the
 * real `FakeVault` wire semantics (proof verification, CAS, nonce single
 * use); the endpoint keeps the real `EndpointIdentityStore` +
 * `RecoveryAuthorityService` and a real pinned inner-TLS endpoint over the
 * relay frame pump.
 *
 * Covered end-to-end:
 *   - pairing enrollment lands the device in the endpoint identity store and
 *     the pinned inner channel establishes (the endpoint trust anchor is the
 *     invite's SPKI pin);
 *   - recovery setup commits a real encrypted snapshot into the vault;
 *   - fresh-install recovery on a second custody/config context restores the
 *     connection using only the user-held recovery text, and the fresh
 *     device's pinned mutual-TLS channel establishes (mTLS rebind);
 *   - account-managed recovery-key rotation preserves the active snapshot
 *     until the exact writer replacement receives fresh account approval;
 *   - endpoint silence/transport drop is reported honestly (unreachable /
 *     pending — never fabricated);
 *   - a device the endpoint never enrolled cannot establish the inner
 *     channel (normal calls stay unreachable before fresh enrollment);
 *   - vault write failures surface as backup_unreadable, never as success.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { parsePrivateRelayRecoveryMessage, parseRecoveryProof, parseRecoveryRequest } from "@meshrix/contracts/private-relay";
import type { EndpointDeviceRecord, EndpointIdentityStore, RelayFrameDuplex, InnerTlsChannel, RecoverySigner } from "@meshrix/gateway/private-endpoint";
import {
  PrivateRelaySession,
  createEndpointIdentityStore,
  createInnerTlsEndpoint,
  createRelayFrameDuplex,
  createRecoveryAuthorityService,
  pinnedPeerSpkiCandidates
} from "@meshrix/gateway/private-endpoint";
import { EntryRecoveryChannel, EntryRelaySession } from "@meshrix/entry-transport";
import {
  FileCustodyAdapter,
  deriveRecoveryMaterial,
  encodePairingInvite,
  pairingProofTranscript,
  parseRecoveryText,
  rawPublicKeyBase64Url,
  signEd25519,
  verifyEd25519,
  type CustodyAdapter,
  type PairingCompletionRequest,
  type PairingCompletionReceipt,
  type PairingEndpointPort,
  type PairingInvite,
  type RecoveryMaterial,
  type VaultTransport
} from "@meshrix/entry";
import {
  EntryProductService,
  assertGuiStateSecretFree,
  custodyDeviceSigner,
  issueDeviceCertificate,
  type GuiState,
  type PairingChannelLike
} from "@meshrix/entry-gui";

import { FakeVault } from "../entry/helpers.ts";
import {
  MemoryRelayTransport,
  RelayHub,
  PRINCIPAL,
  ROUTE,
  TENANT,
  VAULT_ID,
  GUI_TEST_ACCOUNT,
  inviteFixture,
  pairingAccountFetch,
  serviceConfigFixture,
  seedGuiTestAccount,
  testOsCustody,
  waitFor,
  type WireMessage
} from "./helpers.ts";

const dirs: string[] = [];
const liveServices: EntryProductService[] = [];
afterEach(async () => {
  for (const service of liveServices.splice(0)) await service.stop().catch(() => undefined);
  // Fire-and-forget refreshes/publishes settle on the in-memory hub quickly;
  // give them a tick so no write chases a removed directory.
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const ENDPOINT_DEVICE_ID = "dev.endpoint.1";

/* ------------------------------------------------------------------ */
/* Endpoint host — real session driver + real recovery authority + real */
/* inner-TLS endpoint over the relay frame pump.                        */
/* ------------------------------------------------------------------ */

interface EndpointTls {
  readonly keyPem: string;
  readonly certPem: string;
  readonly spkiPin: string;
}

function mintEndpointTls(): { keyPair: ReturnType<typeof generateKeyPairSync>; tls: EndpointTls } {
  const keyPair = generateKeyPairSync("ed25519");
  const rawPublic = new Uint8Array(Buffer.from(rawPublicKeyBase64Url(keyPair.publicKey), "base64url"));
  const cert = issueDeviceCertificate({
    publicKeyRaw: rawPublic,
    sign: custodyDeviceSigner(keyPair.privateKey),
    subject: "meshrix-endpoint test"
  });
  return {
    keyPair,
    tls: {
      keyPem: String(keyPair.privateKey.export({ format: "pem", type: "pkcs8" })),
      certPem: cert.certPem,
      spkiPin: cert.spkiPin
    }
  };
}

function recoverySignerOf(keyPair: ReturnType<typeof generateKeyPairSync>): RecoverySigner {
  return {
    sign: (transcript) => signEd25519(keyPair.privateKey, typeof transcript === "string" ? transcript : JSON.stringify(transcript)),
    verify: ({ publicKey, signature, transcript }) =>
      verifyEd25519({ publicKey, signature, transcript: String(transcript) })
  };
}

/**
 * The endpoint's relay session host: mirrors the production
 * `handleRelayMessage`/`ensureInnerChannel` wiring — session kinds go to the
 * driver, recovery kinds to the real authority, frames pump the inner TLS
 * socket. The inner channel is rebuilt lazily on the first inbound frame so
 * a freshly enrolled device binds fresh pins without a stale socket.
 */
class EndpointHost {
  readonly hub: RelayHub;
  readonly identity: EndpointIdentityStore;
  readonly authority: ReturnType<typeof createRecoveryAuthorityService>;
  readonly tls: EndpointTls;
  readonly transport: MemoryRelayTransport;
  readonly session: PrivateRelaySession;
  /** Every inner channel that completed a pinned handshake (peer SPKI pin). */
  readonly establishedPeers: string[] = [];
  /** Inner channel failures — pin rejection, handshake timeout, teardown. */
  readonly innerFailures: unknown[] = [];
  /** Every wire kind the endpoint surface observed — diagnosable silence. */
  readonly received: string[] = [];
  #endpointDevice: EndpointDeviceRecord | undefined;
  #pump: RelayFrameDuplex | null = null;
  #channel: InnerTlsChannel | null = null;

  constructor(input: { hub: RelayHub; identity: EndpointIdentityStore; tls: EndpointTls; keyPair: ReturnType<typeof generateKeyPairSync> }) {
    this.hub = input.hub;
    this.identity = input.identity;
    this.tls = input.tls;
    this.authority = createRecoveryAuthorityService({
      identity: input.identity,
      signer: recoverySignerOf(input.keyPair)
    });
    this.transport = new MemoryRelayTransport(this.hub);
    this.transport.onMessage = (message) => this.#dispatch(message);
    this.transport.onSocketClose = () => {};
    this.transport.onSocketDrop = () => {};
    this.session = new PrivateRelaySession({
      transport: this.transport,
      admission: {
        tenantId: TENANT,
        deviceId: ENDPOINT_DEVICE_ID,
        routeId: ROUTE,
        role: "endpoint",
        mode: "personal",
        admissionGeneration: 1,
        revocationRevision: 0
      },
      handlers: {
        onFrame: (payload) => {
          this.#ensureInnerChannel();
          return this.#pump?.feed(payload) ?? false;
        },
        onRouteStatus: (_routeId, state) => {
          if (state !== "reachable") this.#teardownInnerChannel();
        },
        onClosed: () => {
          this.#teardownInnerChannel();
          // The peer session ended — reopen the endpoint side so a later
          // session generation can admit (session-restored).
          void this.#resurrect();
        }
      }
    });
  }

  get endpointDevice(): EndpointDeviceRecord | undefined {
    return this.#endpointDevice;
  }

  open(): void {
    this.session.open();
  }

  #dispatch(message: WireMessage): void {
    this.received.push(String((message as { kind?: unknown }).kind ?? "?"));
    // Identity admission binds `device` before the driver's onAdmitted fires
    // (same ordering contract as the production endpoint).
    const peeked = typeof message === "object" && message !== null ? (message as { kind?: unknown }).kind : undefined;
    if (peeked === "session-admitted") {
      const admitted = this.identity.admit({
        tenantId: TENANT,
        deviceId: ENDPOINT_DEVICE_ID,
        routeId: ROUTE,
        role: "endpoint",
        mode: "personal",
        admissionGeneration: 1,
        revocationRevision: 0
      });
      if (admitted.admitted && admitted.device) this.#endpointDevice = admitted.device;
    }
    const kind = this.session.handleMessage(message)
      ?? (() => {
        const parsed = parsePrivateRelayRecoveryMessage(message);
        return parsed ? String((parsed as { kind: string }).kind) : null;
      })();
    if (!kind) return;
    switch (kind) {
      case "recovery-request": {
        if (!parseRecoveryRequest(message)) return;
        const challenge = this.authority.beginRecovery(message);
        if (challenge) this.transport.send(challenge as Readonly<Record<string, unknown>>);
        return;
      }
      case "recovery-proof": {
        if (!parseRecoveryProof(message)) return;
        const result = this.authority.completeRecovery(message);
        if (result) this.transport.send(result as Readonly<Record<string, unknown>>);
        return;
      }
      default:
        return;
    }
  }

  /** Build the inner TLS endpoint against the CURRENT pin set. */
  #ensureInnerChannel(): void {
    if (this.#channel && !this.#channel.socket.destroyed) return;
    const device = this.#endpointDevice;
    this.#pump?.destroy();
    this.#pump = createRelayFrameDuplex({
      sendFrame: (payload) => this.session.sendPayload(payload).accepted,
      onDrained: () => {
        try { this.session.flushInbound(); } catch { /* dead transport owns the error */ }
      }
    });
    const channel = createInnerTlsEndpoint({
      socket: this.#pump,
      key: this.tls.keyPem,
      cert: this.tls.certPem,
      pinnedPeerSpki: device ? pinnedPeerSpkiCandidates(this.identity, device) : [],
      handshakeTimeoutMs: 5_000
    });
    this.#channel = channel;
    void channel.established
      .then(({ peerSpki }) => {
        if (this.#channel === channel) this.establishedPeers.push(peerSpki);
      })
      .catch((error: unknown) => {
        if (this.#channel === channel) this.innerFailures.push(error);
      });
  }

  #teardownInnerChannel(): void {
    this.#channel?.close();
    this.#channel = null;
    this.#pump?.destroy();
    this.#pump = null;
  }

  async #resurrect(): Promise<void> {
    // The driver calls transport.close() AFTER onClosed returns — defer the
    // reattach one macrotask so the close/detach lands first, like a real
    // endpoint opening a fresh socket only after the old one died.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await this.transport.reopen();
      this.session.reconnect();
    } catch {
      // A dead endpoint conn stays down — callers observe unreachability.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Store-backed pairing/admin surface — the endpoint admin truth.       */
/* ------------------------------------------------------------------ */

class StoreBackedPairingChannel implements PairingChannelLike, PairingEndpointPort {
  readonly #identity: EndpointIdentityStore;
  readonly relayCredential = `rc.test.${randomBytes(32).toString("base64url")}`;
  readonly seenDeviceIds: string[] = [];
  #challengeId: string | null = null;
  #enrolledDeviceId: string | null = null;
  failBegin: "unreachable" | null = null;

  constructor(identity: EndpointIdentityStore) {
    this.#identity = identity;
  }

  async connect(): Promise<void> {}
  close(): void {}

  devicePublicKeyFor(deviceId: string): string | null {
    return this.#identity.device(deviceId)?.pairedIdentityKey ?? null;
  }

  enrollmentExtras() {
    const device = this.#enrolledDeviceId ? this.#identity.device(this.#enrolledDeviceId) : undefined;
    return {
      relayCredential: this.relayCredential,
      admissionGeneration: device?.admissionGeneration ?? 1,
      revocationRevision: this.#identity.revocationRevision(TENANT)
    };
  }

  async beginPairing(input: Parameters<PairingEndpointPort["beginPairing"]>[0]): ReturnType<PairingEndpointPort["beginPairing"]> {
    if (this.failBegin === "unreachable") {
      const { entryError } = await import("@meshrix/entry");
      throw entryError("endpoint_unreachable", "pairing surface offline");
    }
    this.#challengeId = `pch.${input.deviceId}.${randomBytes(4).toString("base64url")}`;
    return {
      outcome: "challenge" as const,
      challengeId: this.#challengeId,
      nonce: `pn.${randomBytes(6).toString("base64url")}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: GUI_TEST_ACCOUNT,
      target: {
        tenantId: input.invite.tenantId,
        routeId: input.invite.endpointRouteId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        grantRef: `grant.${input.deviceId}`,
        scopes: ["mcp:invoke"]
      }
    };
  }

  async completePairing(input: PairingCompletionRequest): Promise<PairingCompletionReceipt | { outcome: "refused"; refusal: string }> {
    if (input.challengeId !== this.#challengeId) {
      return { outcome: "refused" as const, refusal: "challenge_mismatch" };
    }
    const transcript = pairingProofTranscript({
      challengeId: input.challengeId,
      inviteId: input.invite.inviteId,
      endpointRouteId: input.invite.endpointRouteId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      entryPeerIdentity: input.entryPeerIdentity
    });
    if (!verifyEd25519({ publicKey: input.devicePublicKey, signature: input.signature, transcript })) {
      return { outcome: "refused" as const, refusal: "proof_invalid" };
    }
    const record = this.#identity.enrollAccountDevice({
      account: input.account,
      target: input.target,
      mode: input.invite.mode,
      entryPeerIdentity: input.entryPeerIdentity
    });
    this.#enrolledDeviceId = input.deviceId;
    this.seenDeviceIds.push(input.deviceId);
    return {
      outcome: "enrolled",
      capabilityGrantRef: input.target.grantRef,
      admissionGeneration: record.admissionGeneration,
      revocationRevision: this.#identity.revocationRevision(input.invite.tenantId),
      endpointPeerIdentity: {
        peerId: `peer:${input.invite.tenantId}:${input.invite.endpointRouteId}:${input.invite.endpointDeviceId}`,
        signalDeviceId: 1,
        registrationId: 1,
        identityKey: Buffer.alloc(33, 2).toString("base64url")
      }
    };
  }

  async revokeDevice(input: { deviceId: string }) {
    const record = this.#identity.revoke(input.deviceId);
    return { revoked: record?.revoked === true };
  }

  async recoveryAccess(input: { vaultId: string }) {
    void input;
    return {
      outcome: "issued" as const,
      deviceId: `dev.entry.fresh.${randomBytes(6).toString("base64url")}`,
      relayCredential: `rc.fresh.${randomBytes(32).toString("base64url")}`,
      tenantId: TENANT,
      routeId: ROUTE,
      admissionGeneration: 1,
      revocationRevision: this.#identity.revocationRevision(TENANT)
    };
  }
}

/* ------------------------------------------------------------------ */
/* Fixture assembly                                                    */
/* ------------------------------------------------------------------ */

interface EndpointFixture {
  hub: RelayHub;
  identity: EndpointIdentityStore;
  host: EndpointHost;
  tls: EndpointTls;
  pairing: StoreBackedPairingChannel;
}

function makeEndpoint(): EndpointFixture {
  const hub = new RelayHub();
  const identity = createEndpointIdentityStore();
  const { keyPair, tls } = mintEndpointTls();
  // The endpoint's own device record must exist before its session admits.
  identity.enroll({
    deviceId: ENDPOINT_DEVICE_ID,
    routeId: ROUTE,
    tenantId: TENANT,
    trustBinding: {
      schemaVersion: "v0.0.1:private-relay:recovery-1",
      kind: "endpoint-trust-binding",
      pairedIdentityKey: rawPublicKeyBase64Url(keyPair.publicKey),
      pairedIdentityFingerprint: `fp.${tls.spkiPin}`,
      mode: "personal",
      role: "endpoint",
      trustGeneration: 1,
      endpointPrincipalRef: PRINCIPAL,
      capabilityGrantRef: "grant.endpoint.1",
      boundRecoveryKeyId: null
    }
  });
  const host = new EndpointHost({ hub, identity, tls, keyPair });
  host.open();
  expect(host.session.state === "admitted" || host.session.state === "streaming").toBe(true);
  return { hub, identity, host, tls, pairing: new StoreBackedPairingChannel(identity) };
}

interface GuiFixture {
  service: EntryProductService;
  dir: string;
  custody: CustodyAdapter;
  vault: FakeVault;
  endpoint: EndpointFixture;
  emitted: GuiState[];
}

async function makeGuiService(endpoint: EndpointFixture, vault: FakeVault, options: {
  dataDir?: string;
  wrapSecret?: Uint8Array;
} = {}): Promise<GuiFixture> {
  const dir = options.dataDir ?? await mkdtemp(path.join(tmpdir(), "entry-gui-e2e-"));
  dirs.push(dir);
  const fileCustody = new FileCustodyAdapter({ dataDir: dir, wrapSecret: options.wrapSecret ?? randomBytes(32) });
  const custody: CustodyAdapter = testOsCustody(fileCustody);
  await seedGuiTestAccount(dir, custody);
  const emitted: GuiState[] = [];
  const service = new EntryProductService({
    dataDir: dir,
    appVersion: "9.9.9",
    appExePath: "meshrix-entry-test",
    custody,
    serviceConfig: serviceConfigFixture(),
    accountFetch: pairingAccountFetch({
      accountOrigin: "https://account.gui.invalid",
      relayAdmission: endpoint.pairing.relayCredential,
      resolveDevicePublicKey: (deviceId) => endpoint.pairing.devicePublicKeyFor(deviceId),
      writerGeneration: () => vault.current ? vault.generation + 1 : vault.generation,
      onVaultWriterRotationComplete: (target) => {
        const rotation = target.vaultWriterRotation;
        if (!rotation) return;
        vault.recoveryVerifier = rotation.recoveryVerifier;
        vault.writers = [...rotation.writers];
        vault.generation = rotation.generation;
      }
    }),
    pairingChannelFactory: () => endpoint.pairing,
    pairingRelayChannelFactory: () => endpoint.pairing,
    vaultTransportFactory: (): VaultTransport => vault,
    recoveryChannelFactory: (input) => new EntryRecoveryChannel({
      relaySessionUrl: input.relaySessionUrl,
      admission: input.admission,
      headers: input.headers,
      transportFactory: () => new MemoryRelayTransport(endpoint.hub)
    }),
    sessionFactory: (sessionOptions) => new EntryRelaySession(sessionOptions),
    transportFactory: () => new MemoryRelayTransport(endpoint.hub),
    connectTimeoutMs: 4_000
  });
  service.subscribe((state) => {
    assertGuiStateSecretFree(state);
    emitted.push(state);
  });
  liveServices.push(service);
  return { service, dir, custody, vault, endpoint, emitted };
}

function verifierOf(material: RecoveryMaterial) {
  return { keyId: material.signing.keyId, algorithm: "Ed25519" as const, publicKey: material.signing.publicKey };
}
function writerOf(material: RecoveryMaterial) {
  return { keyId: material.writer.keyId, algorithm: "Ed25519" as const, publicKey: material.writer.publicKey };
}

function makeVault(material?: RecoveryMaterial): FakeVault {
  return new FakeVault({
    vaultId: VAULT_ID,
    verifier: material ? verifierOf(material) : { keyId: "rckey.unset", algorithm: "Ed25519", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    writers: material ? [writerOf(material)] : []
  });
}

const INVITE = (spkiPin: string) => encodePairingInvite(inviteFixture({ endpointSpkiPin: spkiPin, endpointPinRef: spkiPin }));

/** Start → submit invite → confirm → wait for the pinned channel. */
async function pairAndConnect(fixture: GuiFixture): Promise<string> {
  await fixture.service.start();
  const submitted = await fixture.service.dispatch("pairing.submitInvite", { inviteText: INVITE(fixture.endpoint.tls.spkiPin) });
  expect(submitted).toMatchObject({ ok: true });
  const authorization = await fixture.service.dispatch("pairing.confirm");
  expect(authorization.ok).toBe(true);
  expect((authorization as { value: GuiState }).value.pairing.phase).toBe("authorization_required");
  const confirmed = await fixture.service.dispatch("pairing.continue");
  expect(confirmed.ok).toBe(true);
  const state = (confirmed as { value: GuiState }).value;
  const connectionId = state.pairing.enrolledConnectionId as string;
  expect(state.pairing.phase, state.pairing.refusal ?? "pairing did not finish").toBe("enrolled");
  expect(connectionId).toBeTruthy();
  await waitFor(() => fixture.service.snapshot().connections[0]?.channelEstablished === true, 8_000);
  return connectionId;
}

/** Full recovery setup: reveal → wire vault+authority → confirm. */
async function setupRecovery(fixture: GuiFixture): Promise<{ recoveryText: string; material: RecoveryMaterial }> {
  const begun = await fixture.service.dispatch("recovery.beginSetup");
  expect(begun.ok).toBe(true);
  const revealed = await fixture.service.dispatch("recovery.revealKey");
  expect(revealed.ok).toBe(true);
  const { recoveryText } = (revealed as { value: { recoveryText: string } }).value;
  const material = deriveRecoveryMaterial(parseRecoveryText(recoveryText).secret);
  fixture.vault.recoveryVerifier = verifierOf(material);
  fixture.vault.writers = [writerOf(material)];
  // The endpoint admin binds the recovery authority for this vault key.
  fixture.endpoint.identity.enrollRecoveryAuthority({
    recoveryKeyId: material.signing.keyId,
    principalRef: PRINCIPAL,
    publicKey: material.signing.publicKey,
    generation: 1
  });
  const saved = await fixture.service.dispatch("recovery.confirmSaved");
  expect(saved.ok).toBe(true);
  const registered = await fixture.service.dispatch("account.checkTransaction");
  expect(registered.ok).toBe(true);
  expect((registered as { value: GuiState }).value.recovery.state).toBe("ready");
  return { recoveryText, material };
}

describe("entry-gui integration — real relay, real vault, real endpoint", () => {
  it("pairs explicitly, lands the device in the endpoint store, and establishes the pinned inner channel", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const gui = await makeGuiService(endpoint, vault);
    const connectionId = await pairAndConnect(gui);

    const state = gui.service.snapshot();
    const connection = state.connections.find((c) => c.connectionId === connectionId)!;
    expect(connection.endpointSpkiPin).toBe(endpoint.tls.spkiPin);
    expect(connection.endpointPrincipalRef).toBe(PRINCIPAL);
    expect(connection.routeState).toBe("reachable");
    expect(connection.acceptsNewWork).toBe(true);
    // The endpoint really enrolled this device.
    const enrolled = endpoint.identity.device(connection.deviceId);
    expect(enrolled).toBeTruthy();
    expect(enrolled!.role).toBe("entry");
    // The inner channel established with the device's cert pinned.
    expect(endpoint.host.establishedPeers.length).toBeGreaterThan(0);
    expect(endpoint.host.establishedPeers[0]).toBe(connection.deviceFingerprint.slice(3));
    await gui.service.stop();
  });

  it("commits a real encrypted recovery snapshot; vault failures surface as backup_unreadable", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const gui = await makeGuiService(endpoint, vault);
    await pairAndConnect(gui);
    const { material } = await setupRecovery(gui);

    expect(vault.current?.revision).toBe(1);
    expect(vault.current?.generation).toBe(1);
    expect(vault.current?.publicVerifier.keyId).toBe(material.signing.keyId);

    // A dropped write response is honest: backup_unreadable, never success.
    // (The vault applies the write before dropping the response — an uncertain
    // commit the reconciler must roll forward, never silently lose.)
    vault.dropNextWriteResponse = true;
    const failed = await gui.service.publishSnapshot();
    expect(failed.recovery.state).toBe("backup_unreadable");
    expect(failed.recovery.backup.lastError).toBeTruthy();
    expect(vault.current?.revision).toBe(2);

    const recovered = await gui.service.publishSnapshot();
    expect(recovered.recovery.state).toBe("ready");
    // The retry reuses the exact pending ciphertext. The vault recognizes the
    // already committed write and reports revision 2 without creating a
    // duplicate snapshot revision.
    expect(recovered.recovery.backup.lastCommittedRevision).toBe(2);
    expect(vault.current?.revision).toBe(2);
    await gui.service.stop();
  });

  it("fresh-install recovery restores the connection with only the recovery text and rebinds pinned mTLS", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const guiA = await makeGuiService(endpoint, vault);
    const connectionIdA = await pairAndConnect(guiA);
    const { recoveryText, material } = await setupRecovery(guiA);
    const deviceIdA = guiA.service.snapshot().connections[0]!.deviceId;
    // The install is lost: sessions close, custody dir is discarded.
    await guiA.service.stop();

    const guiB = await makeGuiService(endpoint, vault);
    await guiB.service.start();
    // Fresh install: the old device identity is not in this custody.
    const stale = await import("@meshrix/entry").then((m) => m.deviceIdentityFromCustody({ custody: guiB.custody, deviceId: deviceIdA }));
    expect(stale).toBeNull();

    const imported = await guiB.service.dispatch("recovery.importText", {
      recoveryText,
      serviceUrl: "https://endpoint.gui.invalid"
    });
    expect(imported.ok).toBe(true);
    const state = (imported as { value: GuiState }).value;
    expect(state.recoveryImport.phase, `detail: ${state.recoveryImport.detail ?? "none"}; endpoint saw [${endpoint.host.received.join(",")}]`).toBe("enrolled");
    expect(state.recovery.state).toBe("ready");
    const fresh = state.connections.find((c) => c.connectionId === state.recoveryImport.enrolledConnectionId)!;
    expect(fresh.deviceId).not.toBe(deviceIdA);
    expect(fresh.boundRecoveryKeyId).toBe(material.signing.keyId);
    expect(fresh.endpointSpkiPin).toBe(endpoint.tls.spkiPin);
    expect(fresh.vaultId).toBe(VAULT_ID);

    // The endpoint enrolled the FRESH device through the recover_device flow.
    const enrolled = endpoint.identity.device(fresh.deviceId);
    expect(enrolled).toBeTruthy();
    expect(enrolled!.boundRecoveryKeyId).toBe(material.signing.keyId);

    // mTLS rebind: the fresh device's cert is pinned and the channel is live.
    await waitFor(() => guiB.service.snapshot().connections[0]?.channelEstablished === true, 8_000);
    const live = guiB.service.snapshot().connections[0]!;
    expect(live.routeState).toBe("reachable");
    expect(live.acceptsNewWork).toBe(true);
    expect(endpoint.host.establishedPeers).toContain(live.deviceFingerprint.slice(3));
    await guiB.service.stop();
  });

  it("rejects a device the endpoint never enrolled — the inner channel stays down", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const gui = await makeGuiService(endpoint, vault);
    await gui.service.start();
    const connectionId = await pairAndConnect(gui);
    await gui.service.stop();

    // A rogue device that was never enrolled tries to open the channel.
    const rogue = generateKeyPairSync("ed25519");
    const rogueRaw = new Uint8Array(Buffer.from(rawPublicKeyBase64Url(rogue.publicKey), "base64url"));
    const rogueCert = issueDeviceCertificate({
      publicKeyRaw: rogueRaw,
      sign: custodyDeviceSigner(rogue.privateKey),
      subject: "meshrix-rogue test"
    });
    const rogueTransport = new MemoryRelayTransport(endpoint.hub);
    const rogueSession = new EntryRelaySession({
      transport: rogueTransport,
      admission: {
        tenantId: TENANT,
        deviceId: "dev.entry.rogue.1",
        routeId: ROUTE,
        role: "entry",
        mode: "personal",
        admissionGeneration: 1,
        revocationRevision: 0
      },
      innerTls: {
        key: String(rogue.privateKey.export({ format: "pem", type: "pkcs8" })),
        cert: rogueCert.certPem,
        pinnedPeerSpki: [endpoint.tls.spkiPin],
        handshakeTimeoutMs: 3_000
      },
      connectTimeoutMs: 3_000
    });
    rogueTransport.onMessage = (message) => { rogueSession.handleMessage(message); };
    rogueTransport.onSocketDrop = () => rogueSession.handleTransportClose();
    rogueTransport.onSocketClose = () => rogueSession.handleTransportClose();
    await expect(rogueSession.connect()).rejects.toBeTruthy();
    expect(rogueSession.channelEstablished).toBe(false);
    expect(rogueSession.acceptsNewWork).toBe(false);
    await expect(rogueSession.request({ jsonrpc: "2.0", id: "1", method: "tools/list" }))
      .rejects.toMatchObject({ code: "endpoint_unreachable" });
    rogueSession.close("normal");
    // The endpoint's purpose admission still rejects non-recovery kinds.
    expect(endpoint.host.authority.admitsKind("frame")).toBe(false);
    expect(endpoint.host.authority.admitsKind("recovery-request")).toBe(true);
    void connectionId;
  });

  it("account-managed recovery rotation preserves the current snapshot until fresh approval", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const gui = await makeGuiService(endpoint, vault);
    await pairAndConnect(gui);
    const { material: incumbent } = await setupRecovery(gui);
    const incumbentSnapshot = vault.current;

    // The personal/account-managed flow creates a local candidate first. It
    // is not published or active until the user saves it and approves the
    // exact writer replacement in the account service.
    const begun = await gui.service.dispatch("recovery.beginRotation");
    expect(begun.ok).toBe(true);
    let state = (begun as { value: GuiState }).value;
    expect(state.recovery.state).toBe("awaiting_save");
    expect(state.recovery.generation).toBe(2);
    expect(state.recovery.rotation).toBeNull();

    const revealed = await gui.service.dispatch("recovery.revealKey");
    expect(revealed.ok).toBe(true);
    const candidateText = (revealed as { value: { recoveryText: string } }).value.recoveryText;
    const candidateMaterial = deriveRecoveryMaterial(parseRecoveryText(candidateText).secret);
    expect(vault.current).toEqual(incumbentSnapshot);
    expect(vault.generation).toBe(1);
    expect(vault.writers.map((writer) => writer.keyId)).toContain(incumbent.writer.keyId);

    const confirmed = await gui.service.dispatch("recovery.confirmSaved");
    expect(confirmed.ok).toBe(true);
    state = (confirmed as { value: GuiState }).value;
    expect(state.recovery.state).toBe("account_authorization_required");
    expect(state.recovery.writerRegistration.state).toBe("authorization_required");
    expect(state.recovery.writerRegistration.candidateGeneration).toBe(2);
    expect(state.account.transactionPurpose).toBe("step_up");
    expect(state.account.actionPurpose).toBe("grant_access");
    expect(vault.current).toEqual(incumbentSnapshot);
    expect(vault.generation).toBe(1);
    expect(vault.writers.map((writer) => writer.keyId)).toContain(incumbent.writer.keyId);
    expect(vault.writers.map((writer) => writer.keyId)).not.toContain(candidateMaterial.writer.keyId);

    const blocked = await gui.service.dispatch("recovery.beginRotation");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("account_transaction_pending");

    const approved = await gui.service.dispatch("account.checkTransaction");
    expect(approved.ok).toBe(true);
    const done = (approved as { value: GuiState }).value;
    expect(done.recovery.state).toBe("ready");
    expect(done.recovery.keyId).toBe(candidateMaterial.signing.keyId);
    expect(done.recovery.generation).toBe(2);
    expect(done.recovery.writerRegistration.state).toBe("complete");
    expect(vault.current?.generation).toBe(2);
    expect(vault.current?.revision).toBe((incumbentSnapshot?.revision ?? 0) + 1);
    await gui.service.stop();
  });

  it("endpoint refusal and silence map to honest outcomes", async () => {
    const endpoint = makeEndpoint();
    const vault = makeVault();
    const gui = await makeGuiService(endpoint, vault);
    await pairAndConnect(gui);
    const { recoveryText } = await setupRecovery(gui);

    // A revoked authority → beginRecovery returns null → silence. Silence is
    // never terminal on its own: the exchange stays honestly "working" until
    // the channel dies (here: service shutdown closes it).
    endpoint.identity.setRecoveryAuthorityState(
      deriveRecoveryMaterial(parseRecoveryText(recoveryText).secret).signing.keyId,
      "revoked"
    );
    const guiB = await makeGuiService(endpoint, vault);
    await guiB.service.start();
    const inflight = guiB.service.dispatch("recovery.importText", {
      recoveryText,
      serviceUrl: "https://endpoint.gui.invalid"
    });
    await waitFor(() => guiB.service.snapshot().recoveryImport.phase === "working", 8_000);
    expect(guiB.service.snapshot().connections).toHaveLength(0);
    await guiB.service.stop();
    const result = await inflight;
    expect(result.ok).toBe(true);
    const state = (result as { value: GuiState }).value;
    expect(["error", "refused"]).toContain(state.recoveryImport.phase);
    expect(state.connections).toHaveLength(0);
  });
});
