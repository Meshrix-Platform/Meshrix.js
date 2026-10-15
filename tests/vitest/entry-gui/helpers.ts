/**
 * Test doubles for the entry-gui suite.
 *
 * `RelayHub`/`MemoryRelayTransport` mirror the in-memory relay semantics used
 * by the entry-transport suite, extended with purpose-aware routing so a
 * `recover_device` session and a `forward` session can share one route
 * without cross-delivering frames (the real relay isolates them per session).
 * Recovery-channel kinds flow entry-recovery ↔ endpoint; lifecycle/frame
 * kinds flow entry-forward ↔ endpoint only.
 *
 * `FakePairingChannel` binds the endpoint admin surface: pairing challenge →
 * proof → enrollment with relay counters, best-effort remote revocation, and
 * the fresh-device `recoveryAccess` provisioning seam. The proof signature is
 * verified with the real `verifyEd25519` so client transcript bugs cannot
 * hide behind a stub.
 */
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_WIRE_PROTOCOL,
  createRotationState,
  parsePrivateRelayRecoveryMessage
} from "@meshrix/contracts/private-relay";
import type { EndpointIdentityStore } from "@meshrix/gateway/private-endpoint";
import type { RelayTransportPort } from "@meshrix/gateway/private-endpoint";
import { EntryConfigStore } from "@meshrix/entry-gui";
import {
  entryError,
  pairingProofTranscript,
  parsePairingInvite,
  verifyEd25519,
  type PairingInvite,
  type CustodyAdapter
} from "@meshrix/entry";
import type { PairingChannelLike } from "@meshrix/entry-gui";
import { ACCOUNT_API_ROUTES, type AccountActionTarget } from "@meshrix/contracts/account";
import type { PairingEndpointPort, PairingCompletionRequest, PairingCompletionReceipt } from "@meshrix/entry";

export const TENANT = "tenant.gui.1";
export const ROUTE = "route.gui.1";
export const PRINCIPAL = "prin.gui.1";
export const VAULT_ID = "vault.gui.1";
export const PAIRING_SERVICE = "https://endpoint.gui.invalid";
export const GUI_TEST_ACCOUNT = Object.freeze({ accountId: "account.gui.1", authEpoch: 1 });
export const GUI_TEST_ACCOUNT_SESSION_REF = "entry-gui.account.session";
export const GUI_TEST_RELAY_ADMISSION = "relay.credential.test.for.entry.gui";

/** Mark a durable fake store as an available test OS key store for auth-flow tests. */
export function testOsCustody(backing: CustodyAdapter): CustodyAdapter {
  return {
    kind: "test-os-custody",
    available: () => backing.available(),
    storeSecret: (input) => backing.storeSecret(input),
    loadSecret: (input) => backing.loadSecret(input),
    deleteSecret: (input) => backing.deleteSecret(input)
  };
}

export async function seedGuiTestAccount(dataDir: string, custody: CustodyAdapter): Promise<void> {
  const store = new EntryConfigStore({ dataDir });
  await store.load();
  await custody.storeSecret({
    ref: GUI_TEST_ACCOUNT_SESSION_REF,
    secret: new TextEncoder().encode("desktop-session-credential-for-entry-gui-test")
  });
  await store.update((draft) => ({
    ...draft,
    account: {
      desktopDeviceId: "device.desktop.gui.1",
      accountId: GUI_TEST_ACCOUNT.accountId,
      authEpoch: GUI_TEST_ACCOUNT.authEpoch,
      sessionCredentialRef: GUI_TEST_ACCOUNT_SESSION_REF
    }
  }));
}

const LIMITS = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
};

export type WireMessage = Record<string, unknown>;

/**
 * Kinds that travel on a recover_device-purpose session. Operation
 * query/status ride the forward channel — the recovery purpose admits only
 * recovery kinds (see `recoveryChannelAdmitsOnlyRecovery`).
 */
const RECOVERY_KINDS = new Set([
  "recovery-request",
  "recovery-challenge",
  "recovery-proof",
  "recovery-result",
  "rotation-begin",
  "rotation-state"
]);

export interface HubConn {
  transport: MemoryRelayTransport;
  role: string;
  routeId: string;
  purpose: string;
  sessionId: string | null;
  admitted: boolean;
}

export class MemoryRelayTransport implements RelayTransportPort {
  readonly hub: RelayHub;
  conn: HubConn | undefined;
  alive = true;
  terminated = false;
  onMessage?: (message: WireMessage) => void;
  onSocketDrop?: () => void;
  onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  readonly ready = Promise.resolve();
  readonly sent: WireMessage[] = [];

  constructor(hub: RelayHub) {
    this.hub = hub;
    this.hub.attach(this);
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (this.terminated) throw Object.assign(new Error("transport_closed"), { code: "transport_closed" });
    if (!this.alive) throw Object.assign(new Error("transport_dead"), { code: "transport_dead" });
    this.sent.push(message as WireMessage);
    this.hub.deliver(this, message as WireMessage);
  }

  deliverToApp(message: WireMessage): void {
    this.onMessage?.(message);
  }

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

/**
 * Purpose-aware in-memory relay:
 *  - entry conns (any purpose) always route to the endpoint conn;
 *  - endpoint outbound recovery kinds route to the recover_device conn,
 *    everything else (frames, acks, session lifecycle) to the forward conn;
 *  - a recover_device conn's session-close is session-scoped: it never tears
 *    down the endpoint's forward session.
 */
export class RelayHub {
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
    transport.conn = { transport, role: "", routeId: "", purpose: "", sessionId: null, admitted: false };
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

  /** Hold matching outbound messages until `release` — a silent peer. */
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

  /** Drop matching outbound messages — the sender sees silence. */
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
      if (result === null) return;
      message = result;
    }
    this.#route(transport, message);
  }

  /** Same-route admitted peers of a conn. */
  #peers(conn: HubConn): HubConn[] {
    const out: HubConn[] = [];
    for (const other of this.conns) {
      if (other !== conn && other.routeId === conn.routeId && other.admitted) out.push(other);
    }
    return out;
  }

  /** The conn an outbound message is addressed to, by kind + purpose. */
  #peerFor(conn: HubConn, kind: string): HubConn | undefined {
    const peers = this.#peers(conn);
    if (conn.role === "entry") {
      // Entry conns always talk to the endpoint conn.
      return peers.find((peer) => peer.role === "endpoint");
    }
    // Endpoint outbound: recovery kinds land on the recovery-purpose session.
    return peers.find((peer) =>
      peer.role === "entry" && (RECOVERY_KINDS.has(kind) ? peer.purpose === "recover_device" : peer.purpose === "forward"));
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
        conn.purpose = String(message.purpose ?? "forward");
        // The relay supersedes a same-device session on the same route +
        // purpose: the older conn is closed so frames never split across
        // generations of one device's session.
        const deviceId = String(admission.deviceId ?? "");
        for (const other of this.conns) {
          if (other === conn || !other.admitted) continue;
          if (other.routeId === conn.routeId && other.role === conn.role
            && other.purpose === conn.purpose
            && String((other.lastAdmissionDevice ?? "")) === deviceId) {
            other.admitted = false;
            other.sessionId = null;
            other.transport.deliverToApp(this.#sessionClose());
            this.#notifyRouteChange(other);
          }
        }
        (conn as { lastAdmissionDevice?: string }).lastAdmissionDevice = deviceId;
        conn.sessionId = `sess.hub.${++this.#seq}`;
        conn.admitted = true;
        const peer = conn.role === "endpoint"
          ? this.#peers(conn).find((candidate) => candidate.purpose === "forward")
          : this.#peers(conn).find((candidate) => candidate.role === "endpoint");
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
        conn.purpose = conn.purpose || "forward";
        conn.sessionId = `sess.hub.${++this.#seq}`;
        conn.admitted = true;
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
        this.#notifyRouteChange(conn);
        break;
      }
      case "session-close": {
        // Session-scoped: a recover_device close never reaches the endpoint's
        // forward session; a forward/endpoint close reaches its lifecycle peer.
        const peer = conn.purpose === "recover_device"
          ? this.#peers(conn).find((candidate) => candidate.role === "endpoint" && candidate.purpose === "recover_device")
          : this.#peerFor(conn, kind);
        peer?.transport.deliverToApp(message);
        conn.admitted = false;
        conn.sessionId = null;
        this.#notifyRouteChange(conn);
        break;
      }
      case "frame":
      case "frame-ack":
      case "route-bind":
      case "route-query": {
        // Purpose isolation: frames never leave a recover_device session.
        if (conn.purpose === "recover_device" && (kind === "frame" || kind === "frame-ack")) return;
        const peer = this.#peerFor(conn, kind);
        if (!peer) {
          if (kind === "frame" || kind === "route-bind" || kind === "route-query") {
            transport.deliverToApp(this.#routeStatus(conn, "unreachable"));
          }
          return;
        }
        if (kind === "frame" && !peer.transport.alive) {
          transport.deliverToApp(this.#routeStatus(conn, "unreachable"));
          return;
        }
        // Route cursors survive session replacement exactly like the real DO.
        if (kind === "frame") {
          const direction = conn.role === "entry" ? "toEndpoint" : "toEntry";
          this.#routeCursors[direction] = Math.max(this.#routeCursors[direction], Number(message.seq) || 0);
        }
        peer.transport.deliverToApp(message);
        if (kind === "route-bind" || kind === "route-query") {
          transport.deliverToApp(this.#routeStatus(conn, "reachable"));
        }
        break;
      }
      default: {
        // Purpose isolation: opaque frames can never leave a recover_device
        // session — the relay admits recovery kinds only on that purpose.
        if (conn.purpose === "recover_device" && !RECOVERY_KINDS.has(kind)) return;
        const peer = this.#peerFor(conn, kind);
        peer?.transport.deliverToApp(message);
        break;
      }
    }
  }

  #sessionClose(): WireMessage {
    return {
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
      wireProtocol: PRIVATE_RELAY_WIRE_PROTOCOL,
      kind: "session-close",
      sessionId: "sess.hub.superseded",
      reason: "protocol_error",
      finalCursors: { toEndpoint: 0, toEntry: 0 }
    };
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

  /** Route status moves only for forward-purpose lifecycle changes. */
  #notifyRouteChange(changed: HubConn): void {
    if (changed.purpose === "recover_device") return;
    for (const other of this.conns) {
      if (other === changed || other.routeId !== changed.routeId || !other.admitted || other.purpose === "recover_device") continue;
      other.transport.deliverToApp(this.#routeStatus(other, changed.admitted ? "reachable" : "unreachable"));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Endpoint-side TLS identity: self-signed Ed25519 via the app's own     */
/* minter — the same code path that mints device certificates.          */
/* ------------------------------------------------------------------ */

export interface EndpointIdentity {
  readonly keyPem: string;
  readonly certPem: string;
  /** sha256(SPKI) of the endpoint's inner-TLS certificate — the invite pin. */
  readonly spkiPin: string;
  readonly privateKey: KeyObject;
  readonly publicKeyRaw: string;
}

/** Enroll the endpoint's own device record so admit() binds a device. */
export function enrollEndpointDeviceRecord(store: EndpointIdentityStore, input: {
  deviceId: string;
  tenantId?: string;
  routeId?: string;
  spkiPin: string;
}): void {
  store.enroll({
    deviceId: input.deviceId,
    routeId: input.routeId ?? ROUTE,
    tenantId: input.tenantId ?? TENANT,
    trustBinding: {
      schemaVersion: "v0.0.1:private-relay:recovery-1",
      kind: "endpoint-trust-binding",
      pairedIdentityKey: input.spkiPin,
      pairedIdentityFingerprint: `fp.${input.spkiPin}`,
      mode: "personal",
      role: "endpoint",
      trustGeneration: 1,
      endpointPrincipalRef: PRINCIPAL,
      capabilityGrantRef: "grant.endpoint.1",
      boundRecoveryKeyId: null
    }
  });
}

/** Enroll an entry-side device on the endpoint (as pairing/recovery does). */
export function enrollEntryDeviceRecord(store: EndpointIdentityStore, input: {
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  routeId?: string;
  boundRecoveryKeyId?: string | null;
  trustGeneration?: number;
}): void {
  store.enroll({
    deviceId: input.deviceId,
    routeId: input.routeId ?? ROUTE,
    tenantId: TENANT,
    trustBinding: {
      schemaVersion: "v0.0.1:private-relay:recovery-1",
      kind: "endpoint-trust-binding",
      pairedIdentityKey: input.publicKey,
      pairedIdentityFingerprint: input.fingerprint.startsWith("fp.") ? input.fingerprint : `fp.${input.fingerprint}`,
      mode: "personal",
      role: "entry",
      trustGeneration: input.trustGeneration ?? 1,
      endpointPrincipalRef: PRINCIPAL,
      capabilityGrantRef: "grant.entry.1",
      boundRecoveryKeyId: input.boundRecoveryKeyId ?? null
    }
  });
}

/**
 * Endpoint-side rotation-begin handler: stages the candidate in the real
 * endpoint identity store (stale generations refuse there) and answers with
 * the wire rotation-state. `acknowledge` controls the acked list so the test
 * can leave endpoints honestly pending.
 */
export function endpointRotationResponder(store: EndpointIdentityStore, options: {
  acknowledge?: boolean;
  /** The route this endpoint serves — echoed in the acked/pending lists. */
  routeId?: string;
} = {}) {
  const routeId = options.routeId ?? ROUTE;
  return (message: WireMessage): WireMessage | null => {
    const parsed = parsePrivateRelayRecoveryMessage(message) as (Record<string, unknown> & { kind: string }) | null;
    if (!parsed || parsed.kind !== "rotation-begin") return null;
    const begin = parsed;
    const candidateKeyId = `rckey.${createHash("sha256")
      .update(Buffer.from(String(begin.candidatePublicKey), "base64url"))
      .digest().subarray(0, 16).toString("base64url")}`;
    const staged = store.stageRecoveryRotation({
      recoveryKeyId: String(begin.recoveryKeyId),
      candidateKeyId,
      candidatePublicKey: String(begin.candidatePublicKey),
      principalRef: String(begin.principalRef),
      currentGeneration: Number(begin.currentGeneration),
      candidateGeneration: Number(begin.candidateGeneration)
    });
    const acknowledged = staged.accepted && options.acknowledge !== false ? [routeId] : [];
    return createRotationState({
      rotationId: begin.rotationId,
      state: "acknowledging",
      acknowledged,
      pending: acknowledged.length === 0 ? [routeId] : []
    }) as WireMessage;
  };
}

/* ------------------------------------------------------------------ */
/* Pairing channel double                                               */
/* ------------------------------------------------------------------ */

export interface FakePairingBehavior {
  /** Refuse beginPairing with this code, or simulate silence ("unreachable"). */
  failBegin?: "unreachable" | "refused";
  refuseBegin?: string;
  failComplete?: "unreachable" | "refused";
  refuseComplete?: string;
  grantRef?: string;
  /** Enrollment extras the endpoint issued alongside `enrolled`. */
  relayCredential?: string | null;
  admissionGeneration?: number;
  revocationRevision?: number;
  /** Account authority relay enforcement answer for the exact device revoke. */
  revoked?: boolean;
  throwOnRevoke?: boolean;
  /** recoveryAccess issuance; undefined → surface lacks the seam. */
  recoveryAccess?: {
    deviceId: string;
    relayCredential: string;
    tenantId: string;
    routeId: string;
    admissionGeneration: number;
    revocationRevision: number;
  } | "refused";
}

export class FakePairingChannel implements PairingChannelLike, PairingEndpointPort {
  readonly behavior: FakePairingBehavior;
  readonly pairedTargets = new Map<string, PairingCompletionRequest["target"]>();
  seenChallenge: string | null = null;
  seenProofSignature: string | null = null;
  revokeCalls: string[] = [];
  recoveryAccessCalls: string[] = [];

  constructor(behavior: FakePairingBehavior = {}) {
    this.behavior = behavior;
  }

  async connect(): Promise<void> {}
  close(): void {}

  enrollmentExtras() {
    return {
      relayCredential: this.behavior.relayCredential === undefined ? GUI_TEST_RELAY_ADMISSION : this.behavior.relayCredential,
      admissionGeneration: this.behavior.admissionGeneration ?? 3,
      revocationRevision: this.behavior.revocationRevision ?? 1
    };
  }

  async beginPairing(input: Parameters<PairingEndpointPort["beginPairing"]>[0]): ReturnType<PairingEndpointPort["beginPairing"]> {
    if (this.behavior.failBegin === "unreachable") {
      throw entryError("endpoint_unreachable", "pairing surface offline");
    }
    if (this.behavior.failBegin === "refused" || this.behavior.refuseBegin) {
      return { outcome: "refused" as const, refusal: this.behavior.refuseBegin ?? "invite_token_invalid" };
    }
    this.seenChallenge = `pch.${input.deviceId}`;
    return {
      outcome: "challenge" as const,
      challengeId: this.seenChallenge,
      nonce: "pn.gui.1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: GUI_TEST_ACCOUNT,
      target: {
        tenantId: input.invite.tenantId,
        routeId: input.invite.endpointRouteId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        grantRef: this.behavior.grantRef ?? "grant.staged.1",
        scopes: ["mcp:invoke"]
      }
    };
  }

  async completePairing(input: PairingCompletionRequest): Promise<PairingCompletionReceipt | { outcome: "refused"; refusal: string }> {
    if (this.behavior.failComplete === "unreachable") {
      throw entryError("endpoint_unreachable", "pairing surface lost mid-proof");
    }
    if (this.behavior.failComplete === "refused" || this.behavior.refuseComplete) {
      return { outcome: "refused" as const, refusal: this.behavior.refuseComplete ?? "proof_invalid" };
    }
    const transcript = pairingProofTranscript({
      challengeId: input.challengeId,
      inviteId: input.invite.inviteId,
      endpointRouteId: input.invite.endpointRouteId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      entryPeerIdentity: input.entryPeerIdentity
    });
    this.seenProofSignature = input.signature;
    if (!verifyEd25519({ publicKey: input.devicePublicKey, signature: input.signature, transcript })) {
      return { outcome: "refused" as const, refusal: "proof_invalid" };
    }
    if (input.challengeId !== this.seenChallenge) {
      return { outcome: "refused" as const, refusal: "challenge_mismatch" };
    }
    this.pairedTargets.set(input.deviceId, structuredClone(input.target));
    return {
      outcome: "enrolled",
      capabilityGrantRef: input.target.grantRef,
      admissionGeneration: this.behavior.admissionGeneration ?? 3,
      revocationRevision: this.behavior.revocationRevision ?? 1,
      endpointPeerIdentity: {
        peerId: `peer:${input.invite.tenantId}:${input.invite.endpointRouteId}:${input.invite.endpointDeviceId}`,
        signalDeviceId: 1,
        registrationId: 1,
        identityKey: Buffer.alloc(33, 1).toString("base64url")
      }
    };
  }

  async revokeDevice(input: { deviceId: string }) {
    this.revokeCalls.push(input.deviceId);
    if (this.behavior.throwOnRevoke) {
      throw entryError("endpoint_unreachable", "pairing surface unreachable");
    }
    return { revoked: this.behavior.revoked === true };
  }

  async recoveryAccess(input: { vaultId: string }) {
    this.recoveryAccessCalls.push(input.vaultId);
    const access = this.behavior.recoveryAccess;
    if (!access) {
      throw entryError("endpoint_unreachable", "pairing surface lacks recovery access");
    }
    if (access === "refused") return { outcome: "refused" as const, refusal: "vault_not_found" };
    return { outcome: "issued" as const, ...access };
  }
}

/* ------------------------------------------------------------------ */
/* Session/transport fakes for the IPC-level suite                       */
/* ------------------------------------------------------------------ */

export class FakeSession {
  state = "initiated";
  routeState = "unreachable";
  acceptsNewWork = false;
  channelEstablished = false;
  connected = 0;
  closed = 0;
  readonly onAdmitted: (() => void) | undefined;
  private readonly connectBehavior: "establish" | "fail" | "hang";

  constructor(connectBehavior: "establish" | "fail" | "hang" = "establish") {
    this.connectBehavior = connectBehavior;
  }

  async connect(): Promise<void> {
    this.connected += 1;
    if (this.connectBehavior === "establish") {
      this.state = "streaming";
      this.routeState = "reachable";
      this.acceptsNewWork = true;
      this.channelEstablished = true;
      return;
    }
    if (this.connectBehavior === "fail") {
      this.state = "closed";
      throw new Error("entry_connect_timeout");
    }
    return new Promise(() => {});
  }

  close(): void {
    this.closed += 1;
    this.state = "closed";
    this.acceptsNewWork = false;
    this.channelEstablished = false;
  }

  async request(): Promise<unknown> {
    return null;
  }

  handleMessage(): string | null {
    return null;
  }

  handleTransportClose(): void {
    this.state = "closed";
  }
}

export class FakeTransport {
  onMessage?: (message: WireMessage) => void;
  onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
  onSocketDrop?: () => void;
  readonly ready = Promise.resolve();
  sent: WireMessage[] = [];
  closed = false;

  send(message: Readonly<Record<string, unknown>>): void {
    if (this.closed) throw Object.assign(new Error("transport_closed"), { code: "transport_closed" });
    this.sent.push(message as WireMessage);
  }

  close(): void {
    this.closed = true;
  }
}

/* ------------------------------------------------------------------ */
/* Invite fixture                                                       */
/* ------------------------------------------------------------------ */

export function inviteFixture(overrides: Partial<PairingInvite> = {}): PairingInvite {
  const invite = {
    schemaVersion: "v0.0.1:entry:pairing-invite-2",
    kind: "entry-pairing-invite",
    inviteId: "inv.gui.1",
    endpointRouteId: ROUTE,
    tenantId: TENANT,
    mode: "personal",
    endpointDeviceId: "dev.endpoint.gui.1",
    endpointPrincipalRef: PRINCIPAL,
    endpointSpkiPin: "spki.gui.endpoint.pin",
    endpointPinRef: "spki.gui.endpoint.pin",
    relayService: "https://relay.gui.invalid",
    vaultId: VAULT_ID,
    recoveryAuthority: { keyId: "rckey.gui.1", generation: 1 },
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    pairingToken: "pt.gui.one-time",
    ...overrides
  };
  const parsed = parsePairingInvite(invite);
  if (!parsed) throw new Error("fixture does not satisfy the invite schema");
  return parsed;
}

/** Installed service origins for deterministic GUI composition fixtures. */
export function serviceConfigFixture(accountOrigin = "https://account.gui.invalid") {
  return {
    schemaVersion: "meshrix-entry-service-config-1" as const,
    accountOrigin,
    relayService: "wss://relay.gui.invalid"
  };
}

/** Deterministic account authority for IPC tests that exercise the current pair_device flow. */
export function pairingAccountFetch(options: {
  readonly accountOrigin: string;
  readonly relayAdmission?: string | null;
  readonly resolveDevicePublicKey?: (deviceId: string) => string | null;
  readonly writerGeneration?: (vaultId: string) => number;
  readonly onVaultWriterRotationComplete?: (target: AccountActionTarget) => void;
  readonly revokeEnforcement?: "pending" | "complete";
  readonly failDeviceRevoke?: boolean;
}): typeof fetch {
  const transactions = new Map<string, { purpose: string; actionPurpose?: string; target?: unknown }>();
  const writerTargets = new Map<string, AccountActionTarget>();
  let transactionNumber = 0;
  let bootstrapNumber = 0;
  return async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
      const transactionId = `txn.gui.${++transactionNumber}`;
      transactions.set(transactionId, {
        purpose: String(body.purpose),
        actionPurpose: typeof body.actionPurpose === "string" ? body.actionPurpose : undefined,
        target: body.target
      });
      return Response.json({ transactionId, browserUrl: `${options.accountOrigin}/account?transactionId=${transactionId}` });
    }
    const transactionPoll = [...transactions].find(([transactionId]) =>
      url.pathname === ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transactionId)));
    if (transactionPoll) {
      const [, transaction] = transactionPoll;
      if (transaction.purpose === "login") {
        return Response.json({
          state: "complete", purpose: "login", account: GUI_TEST_ACCOUNT,
          deviceSessionCredential: "desktop-session-credential-for-entry-gui-test",
          permitId: null, target: null
        });
      }
      return Response.json({
        state: "complete", purpose: "step_up", actionPurpose: transaction.actionPurpose,
        account: GUI_TEST_ACCOUNT, deviceSessionCredential: null, permitId: "_" + "C".repeat(41) + "A", target: transaction.target
      });
    }
    if ([...transactions.keys()].some((transactionId) =>
      url.pathname === ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transactionId)))) {
      return Response.json({ acknowledged: true });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.desktopPairingBootstrap) {
      return Response.json({
        bootstrapId: `bootstrap.gui.${++bootstrapNumber}`,
        account: GUI_TEST_ACCOUNT,
        tenantId: body.tenantId,
        routeId: body.routeId,
        entryDeviceId: body.entryDeviceId,
        endpointDeviceId: inviteFixture().endpointDeviceId,
        endpointPinRef: body.endpointPinRef,
        role: "entry",
        mode: body.mode,
        admissionGeneration: 3,
        revocationRevision: 1,
        relayAdmission: options.relayAdmission === null ? "" : options.relayAdmission ?? GUI_TEST_RELAY_ADMISSION,
        expiresAt: "2099-01-01T00:00:00.000Z"
      });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.desktopVaultWriterRotationPrepare) {
      const operationId = String(body.operationId ?? "");
      const vaultId = String(body.vaultId ?? "");
      const deviceProof = body.deviceProof as { tenantId?: unknown; routeId?: unknown; deviceId?: unknown } | undefined;
      const deviceId = typeof deviceProof?.deviceId === "string" ? deviceProof.deviceId : "";
      const devicePublicKey = options.resolveDevicePublicKey?.(deviceId);
      const writers = Array.isArray(body.writers)
        ? body.writers as NonNullable<AccountActionTarget["vaultWriterRotation"]>["writers"]
        : [];
      const recoveryVerifier = body.recoveryVerifier as NonNullable<AccountActionTarget["vaultWriterRotation"]>["recoveryVerifier"];
      if (!devicePublicKey || typeof deviceProof?.tenantId !== "string" || typeof deviceProof.routeId !== "string") {
        return Response.json({ error: "device_not_found" }, { status: 404 });
      }
      const target: AccountActionTarget = {
        tenantId: deviceProof.tenantId,
        routeId: deviceProof.routeId,
        deviceId,
        devicePublicKey,
        grantRef: "grant.writer.gui.1",
        scopes: ["vault:write"],
        vaultWriterRotation: {
          vaultId,
          generation: options.writerGeneration?.(vaultId) ?? 1,
          writers,
          recoveryVerifier
        }
      };
      writerTargets.set(operationId, target);
      return Response.json({ operationId, account: GUI_TEST_ACCOUNT, target, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.desktopVaultWriterRotationComplete) {
      const operationId = String(body.operationId ?? "");
      const target = writerTargets.get(operationId);
      if (!target?.vaultWriterRotation) return Response.json({ error: "operation_not_found" }, { status: 404 });
      options.onVaultWriterRotationComplete?.(target);
      return Response.json({
        state: "complete",
        account: GUI_TEST_ACCOUNT,
        operationId,
        vaultId: target.vaultWriterRotation.vaultId,
        generation: target.vaultWriterRotation.generation
      });
    }
    if (url.pathname === ACCOUNT_API_ROUTES.deviceRevoke) {
      if (options.failDeviceRevoke) throw new TypeError("Synthetic account authority transport loss");
      return Response.json({
        authorityRevoked: true,
        operationId: body.operationId,
        target: "device",
        tenantId: body.tenantId,
        routeId: body.routeId,
        deviceId: body.deviceId,
        enforcement: options.revokeEnforcement ?? "complete"
      });
    }
    throw new Error(`Unexpected synthetic account route ${url.pathname}`);
  };
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 8_000, step = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await wait(step);
  }
}
