import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_SCHEMA_VERSION,
  endpointReachabilityForNewWork
} from "@meshrix/contracts/private-relay";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  EndpointIdentityStore,
  GatewayOperationRecoveryService,
  PrivateRelaySession,
  RecoveryAuthorityService,
  createEndpointIdentityStore,
  createOperationRecoveryService,
  createPrivateGatewayEndpoint,
  createPrivateRelaySession,
  createRecoveryAuthorityService,
  createRelayFrameDuplex,
  createInnerTlsEndpoint,
  createInnerTlsClient,
  spkiSha256Base64Url
} from "@meshrix/gateway/private-endpoint";
import type { RelayTransportPort } from "@meshrix/gateway/private-endpoint";
const canned1 = "sn.test.session.0001nonce";
const canned2 = "pk_test_endpoint_1";
const canned3 = "fp.test.endpoint.1";
const canned4 = "rckey.pr.1";
const canned5 = "pk_test_endpoint_2";
const canned6 = "fp.test.endpoint.2";
const canned7 = "pk_old";
const canned8 = "rckey.pr.2";
const canned9 = "pk_new";
const canned10 = "3";
const canned11 = "pk_rc";
const canned12 = "pk_fresh_pub";
const canned13 = "pk_fresh_other";
const canned14 = "pk_impostor";
const canned15 = "pk_race_pub";
const canned16 = "fp.race.1";




const ADMISSION = {
  tenantId: "tenant.pr.1",
  deviceId: "dev.pr.entry.1",
  routeId: "route.pr.1",
  role: "endpoint",
  mode: "personal",
  admissionGeneration: 7,
  revocationRevision: 12
};

class FakeTransport implements RelayTransportPort {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  send(message: Record<string, unknown>) { this.sent.push(message); }
  close() { this.closed = true; }
  last() { return this.sent[this.sent.length - 1]; }
}

const RELAY_LIMIT_FIELDS = {
  maxFramePayloadBytes: PRIVATE_RELAY_LIMITS.maxFramePayloadBytes,
  maxOutstandingBytes: PRIVATE_RELAY_LIMITS.maxOutstandingBytes,
  maxBufferedFrames: PRIVATE_RELAY_LIMITS.maxBufferedFrames,
  maxMessageRatePerSecond: PRIVATE_RELAY_LIMITS.maxMessageRatePerSecond
};

function admittedMessage(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION,
    wireProtocol: "meshrix-private-relay/0",
    kind: "session-admitted",
    sessionId: "sess.test.1",
    purpose: "forward",
    admittedGeneration: 7,
    revocationRevision: 12,
    routeState: "reachable",
    limits: { ...RELAY_LIMIT_FIELDS },
    reconnectGeneration: 1,
    cursors: { toEndpoint: 0, toEntry: 0 },
    serverNonce: canned1,
    ...overrides
  };
}

function makeDevice(overrides: Partial<ReturnType<EndpointIdentityStore["device"]> extends infer R ? R : never> & Record<string, unknown> = {}) {
  const store = createEndpointIdentityStore();
  const record = store.enroll({
    deviceId: "dev.pr.entry.1",
    routeId: "route.pr.1",
    tenantId: "tenant.pr.1",
    trustBinding: {
      schemaVersion: "v0.0.1:private-relay:recovery-1",
      kind: "endpoint-trust-binding",
      pairedIdentityKey: canned2,
      pairedIdentityFingerprint: canned3,
      mode: "personal",
      role: "endpoint",
      trustGeneration: 3,
      endpointPrincipalRef: "prin.pr.1",
      capabilityGrantRef: "grantref.pr.1",
      boundRecoveryKeyId: canned4,
      ...overrides
    }
  });
  return { store, record };
}

function ed25519() {
  return generateKeyPairSync("ed25519");
}

describe("private endpoint identity store", () => {
  it("enrolls devices and admits matching relay admissions", () => {
    const { store, record } = makeDevice();
    expect(record.deviceId).toBe("dev.pr.entry.1");
    const decision = store.admit({ ...ADMISSION });
    expect(decision.admitted).toBe(true);
    expect(decision.device?.principalRef).toBe("prin.pr.1");
  });

  it("refuses cross-tenant, wrong mode, wrong role, stale generation and revoked devices distinctly", () => {
    const { store } = makeDevice();
    expect(store.admit({ ...ADMISSION, tenantId: "other" }).refusal).toBe("cross_tenant");
    expect(store.admit({ ...ADMISSION, mode: "enterprise" }).refusal).toBe("mode_mismatch");
    expect(store.admit({ ...ADMISSION, role: "entry" }).refusal).toBe("role_mismatch");
    expect(store.admit({ ...ADMISSION, admissionGeneration: 0 }).refusal).toBe("stale_generation");
    expect(store.admit({ ...ADMISSION, deviceId: "nope" }).refusal).toBe("unknown_device");
    // Bump the tenant revocation revision, then a peer still claiming an older
    // revision is stale even though it is not itself revoked.
    store.enroll({
      deviceId: "dev.pr.entry.2",
      routeId: "route.pr.1",
      tenantId: "tenant.pr.1",
      trustBinding: {
        schemaVersion: "v0.0.1:private-relay:recovery-1",
        kind: "endpoint-trust-binding",
        pairedIdentityKey: canned5,
        pairedIdentityFingerprint: canned6,
        mode: "personal",
        role: "endpoint",
        trustGeneration: 3,
        endpointPrincipalRef: "prin.pr.1",
        capabilityGrantRef: "grantref.pr.1",
        boundRecoveryKeyId: null
      }
    });
    store.revoke("dev.pr.entry.1");
    expect(store.admit({ ...ADMISSION }).refusal).toBe("revoked");
    expect(store.admit({ ...ADMISSION, deviceId: "dev.pr.entry.2", revocationRevision: 0 }).refusal).toBe("stale_revocation_revision");
    expect(store.admit({ ...ADMISSION, deviceId: "dev.pr.entry.2" }).admitted).toBe(true);
  });

  it("rejects fingerprint collisions across devices", () => {
    const { store } = makeDevice();
    expect(() => store.enroll({
      deviceId: "dev.other",
      routeId: "route.pr.1",
      tenantId: "tenant.pr.1",
      trustBinding: {
        schemaVersion: "v0.0.1:private-relay:recovery-1",
        kind: "endpoint-trust-binding",
        pairedIdentityKey: canned2,
        pairedIdentityFingerprint: canned3,
        mode: "personal",
        role: "entry",
        trustGeneration: 3,
        endpointPrincipalRef: "prin.pr.1",
        capabilityGrantRef: "grantref.pr.1",
        boundRecoveryKeyId: null
      }
    })).toThrow(/fingerprint already belongs/);
  });

  it("carries account bindings only while the paired key is unchanged", () => {
    const { store } = makeDevice();
    store.bindAccountEndpoint({
      deviceId: "dev.pr.entry.1",
      account: { accountId: "acct.pr.1", authEpoch: 1 }
    });
    const trustBinding = (key: string, fp: string) => ({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "endpoint-trust-binding",
      pairedIdentityKey: key, pairedIdentityFingerprint: fp,
      mode: "personal", role: "endpoint", trustGeneration: 4,
      endpointPrincipalRef: "prin.pr.1", capabilityGrantRef: "grantref.pr.1",
      boundRecoveryKeyId: null
    });
    const sameKey = store.enroll({
      deviceId: "dev.pr.entry.1", routeId: "route.pr.1", tenantId: "tenant.pr.1",
      trustBinding: trustBinding("pk_test_endpoint_1", "fp.test.endpoint.1")
    });
    expect(sameKey.accountBinding?.accountId).toBe("acct.pr.1");
    const changedKey = store.enroll({
      deviceId: "dev.pr.entry.1", routeId: "route.pr.1", tenantId: "tenant.pr.1",
      trustBinding: trustBinding("pk_rotated", "fp.rotated")
    });
    expect(changedKey.accountBinding).toBeUndefined();
    expect(store.device("dev.pr.entry.1")?.accountBinding).toBeUndefined();
  });

  it("stages recovery rotation only when the candidate generation advances", () => {
    const { store } = makeDevice();
    store.enrollRecoveryAuthority({ recoveryKeyId: canned4, principalRef: "prin.pr.1", publicKey: canned7, generation: 3 });
    expect(store.stageRecoveryRotation({
      recoveryKeyId: canned4, candidateKeyId: canned8, candidatePublicKey: canned9,
      principalRef: "prin.pr.1", currentGeneration: 3, candidateGeneration: 3
    }).accepted).toBe(false);
    expect(store.stageRecoveryRotation({
      recoveryKeyId: canned4, candidateKeyId: canned8, candidatePublicKey: canned9,
      principalRef: "prin.pr.1", currentGeneration: 3, candidateGeneration: 4
    }).accepted).toBe(true);
    expect(store.recoveryAuthority("rckey.pr.1")?.state).toBe("rotating");
    expect(store.recoveryAuthority("rckey.pr.2")?.state).toBe("active");
    store.completeRecoveryRotation("rckey.pr.1");
    expect(store.recoveryAuthority("rckey.pr.1")?.state).toBe("superseded");
  });
});

describe("relay session driver", () => {
  it("opens, admits and reports reachability", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    expect(session.open()).toBe(true);
    expect(transport.last()?.kind).toBe("session-open");
    session.handleMessage(admittedMessage());
    expect(session.state).toBe("admitted");
    expect(session.acceptsNewWork).toBe(true);
    expect(endpointReachabilityForNewWork("unreachable")).toBe("endpoint_unreachable");
  });

  it("refuses session-opens after rejection and enforces bounded frame accounting", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    session.open();
    session.handleMessage({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION, wireProtocol: "meshrix-private-relay/0",
      kind: "session-rejected", reason: "stale_revocation_revision",
      expectedRevocationRevision: 13, retryable: true
    });
    expect(session.state).toBe("rejected");
    expect(session.sendPayload("AAAA")).toEqual({ accepted: false, reason: "not_streaming" });
  });

  it("backpressures when the bounded frame window is full", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    session.open();
    session.handleMessage(admittedMessage({
      limits: { ...RELAY_LIMIT_FIELDS, maxOutstandingBytes: 4, maxBufferedFrames: 1 }
    }));
    const payload = "AAAA"; // 3 bytes decoded
    expect(session.sendPayload(payload).accepted).toBe(true);
    const second = session.sendPayload(payload);
    expect(second.accepted).toBe(false);
  });

  it("reconnects with fresh cursors and authorization recheck", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    session.open();
    session.handleMessage(admittedMessage());
    session.close("reconnect");
    expect(session.state).toBe("closed");
    expect(session.reconnect({ revocationRevision: 13 })).toBe(true);
    const reconnectMsg = transport.last();
    expect(reconnectMsg?.kind).toBe("session-reconnect");
    expect((reconnectMsg?.admission as Record<string, unknown>)?.revocationRevision).toBe(13);
  });

  const inboundFrame = (seq: number) => ({
    schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION, wireProtocol: "meshrix-private-relay/0",
    kind: "frame", sessionId: "sess.test.1", routeId: "route.pr.1",
    seq, messageId: `msg.in.${seq}`, payload: "AAAA", final: false
  });

  it("withholds frame acks until the inner channel durably accepts the bytes", () => {
    const transport = new FakeTransport();
    const delivered: string[] = [];
    let accepts = false;
    const session = createPrivateRelaySession({
      transport, admission: ADMISSION,
      handlers: { onFrame: (payload) => (accepts ? (delivered.push(payload), true) : false) }
    });
    session.open();
    session.handleMessage(admittedMessage());

    session.handleMessage(inboundFrame(1));
    expect(delivered).toEqual([]);
    expect(transport.sent.some((m) => m.kind === "frame-ack")).toBe(false);

    // Inner channel drained — the queued frame is delivered and only then acked.
    accepts = true;
    expect(session.flushInbound()).toBe(1);
    expect(delivered).toEqual(["AAAA"]);
    const ack = transport.sent.find((m) => m.kind === "frame-ack");
    expect(ack?.upToSeq).toBe(1);

    // Retransmit of a delivered seq is acked idempotently, not re-delivered.
    session.handleMessage(inboundFrame(1));
    expect(delivered).toEqual(["AAAA"]);
  });

  it("continues outbound numbering from the route cursors in session-admitted", () => {
    // Route cursors outlive sessions: a fresh session resuming at seq 1 is
    // indistinguishable from a replay and the relay drops it silently — the
    // exact failure observed when a second entry session replaced the first.
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    session.open();
    session.handleMessage(admittedMessage({ cursors: { toEndpoint: 5, toEntry: 41 } }));
    expect(session.sendPayload("AAAA").accepted).toBe(true);
    // Endpoint role writes the toEntry direction.
    expect(transport.sent.find((m) => m.kind === "frame")?.seq).toBe(42);
  });

  it("numbers an entry-role outbound stream from the toEndpoint cursor", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({
      transport, admission: { ...ADMISSION, role: "entry" }
    });
    session.open();
    session.handleMessage(admittedMessage({ cursors: { toEndpoint: 17, toEntry: 3 } }));
    expect(session.sendPayload("AAAA").accepted).toBe(true);
    expect(transport.sent.find((m) => m.kind === "frame")?.seq).toBe(18);
  });

  it("dedups entry-role inbound against the toEntry cursor, not toEndpoint", () => {
    const transport = new FakeTransport();
    const delivered: string[] = [];
    const session = createPrivateRelaySession({
      transport, admission: { ...ADMISSION, role: "entry" },
      handlers: { onFrame: (payload) => (delivered.push(payload), true) }
    });
    session.open();
    session.handleMessage(admittedMessage({ cursors: { toEndpoint: 0, toEntry: 7 } }));
    // seq 5 already delivered under the entry role's inbound direction —
    // a replay is acked idempotently, not re-delivered.
    session.handleMessage({ ...inboundFrame(5), sessionId: "sess.peer.1" });
    expect(delivered).toEqual([]);
    expect(transport.sent.find((m) => m.kind === "frame-ack")?.upToSeq).toBe(5);
    session.handleMessage({ ...inboundFrame(8), sessionId: "sess.peer.1" });
    expect(delivered).toEqual(["AAAA"]);
    expect(transport.sent.filter((m) => m.kind === "frame-ack").at(-1)?.upToSeq).toBe(8);
  });

  it("drops withheld inbound frames when the peer session is replaced", () => {
    const transport = new FakeTransport();
    const seenPeers: string[] = [];
    let accepts = false;
    const session = createPrivateRelaySession({
      transport, admission: ADMISSION,
      handlers: { onFrame: (_payload, _messageId, sessionId) => (seenPeers.push(sessionId), accepts) }
    });
    session.open();
    session.handleMessage(admittedMessage());
    session.handleMessage(inboundFrame(1)); // queued — channel not accepting
    expect(seenPeers).toEqual(["sess.test.1"]);
    // A replaced peer session's bytes must not queue behind dead ones: feeding
    // the old session's TLS records into a rebuilt channel would corrupt it.
    session.handleMessage({ ...inboundFrame(2), sessionId: "sess.test.2" });
    expect(seenPeers).toEqual(["sess.test.1", "sess.test.2"]);
    accepts = true;
    expect(session.flushInbound()).toBe(1);
    // Only the new session's frame delivers; the old one stays un-acked.
    expect(transport.sent.find((m) => m.kind === "frame-ack")?.upToSeq).toBe(2);
  });

  it("ends the session with a typed failure when the bounded inbound queue is exhausted", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({
      transport, admission: ADMISSION,
      handlers: { onFrame: () => false }
    });
    session.open();
    session.handleMessage(admittedMessage({ limits: { ...RELAY_LIMIT_FIELDS, maxBufferedFrames: 1 } }));

    session.handleMessage(inboundFrame(1)); // queued behind the blocked channel
    session.handleMessage(inboundFrame(2)); // queue full — typed close, cursors preserved
    const close = transport.sent.find((m) => m.kind === "session-close");
    expect(close?.reason).toBe("capacity_exceeded");
    expect(transport.closed).toBe(true);
    expect(session.state).toBe("closed");
  });

  it("acks a frame larger than the stream high-water mark exactly once", () => {
    const transport = new FakeTransport();
    const pump = createRelayFrameDuplex({ sendFrame: () => true });
    const delivered: string[] = [];
    const session = createPrivateRelaySession({
      transport, admission: ADMISSION,
      handlers: { onFrame: (payload) => (pump.feed(payload) ? (delivered.push(payload), true) : false) }
    });
    session.open();
    session.handleMessage(admittedMessage());

    // 64 KiB decoded >> the default ~16 KiB readable high-water mark; push()
    // returns false as a backpressure hint but the bytes are still queued.
    const big = Buffer.alloc(64 * 1024, 0x41).toString("base64url");
    session.handleMessage({ ...inboundFrame(7), payload: big });
    expect(delivered).toEqual([big]);
    expect(transport.sent.find((m) => m.kind === "frame-ack")?.upToSeq).toBe(7);
    expect(pump.readableLength).toBe(64 * 1024);
  });

  it("closes with a wire-valid reason by default and normalizes invalid ones", () => {
    const transport = new FakeTransport();
    const session = createPrivateRelaySession({ transport, admission: ADMISSION });
    session.open();
    session.handleMessage(admittedMessage());
    expect(session.close()).toBe(true);
    expect(transport.sent.find((m) => m.kind === "session-close")?.reason).toBe("normal");

    const transport2 = new FakeTransport();
    const session2 = createPrivateRelaySession({ transport: transport2, admission: ADMISSION });
    session2.open();
    session2.handleMessage(admittedMessage());
    session2.close("bogus" as never);
    expect(transport2.sent.find((m) => m.kind === "session-close")?.reason).toBe("protocol_error");
  });
});

describe("operation recovery", () => {
  const ctx = Object.freeze({ tenant: "tenant.pr.1", principal: "prin.pr.1", authGeneration: canned10, grant: Object.freeze({ revision: "3" }) });

  it("answers not_started only with honest evidence and keeps unknown outcomes explicit", async () => {
    const recovery = createOperationRecoveryService();
    const query = (operationId: string) => ({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "operation-query",
      operationId, principalRef: "prin.pr.1", generation: 3
    });
    const never = await recovery.answerQuery(query("op.never"), ctx);
    expect(never?.state).toBe("not_started");
    expect(never?.notStartedEvidence).toBe("local_never_submitted");

    recovery.markReceived("op.refused", { principalRef: "prin.pr.1", generation: 3 });
    recovery.markRefused("op.refused");
    const refused = await recovery.answerQuery(query("op.refused"), ctx);
    expect(refused?.state).toBe("not_started");
    expect(refused?.notStartedEvidence).toBe("endpoint_refused_pre_dispatch");

    recovery.markReceived("op.doubt", { principalRef: "prin.pr.1", generation: 3 });
    recovery.markDispatched("op.doubt", "permit_1");
    recovery.markUncertain("op.doubt");
    const doubt = await recovery.answerQuery(query("op.doubt"), ctx);
    expect(doubt?.state).toBe("dispatched_in_doubt");
  });

  it("reports completed vs completed_result_unavailable truthfully", async () => {
    const recovery = createOperationRecoveryService();
    const query = (operationId: string) => ({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "operation-query",
      operationId, principalRef: "prin.pr.1", generation: 3
    });
    recovery.markReceived("op.done", { principalRef: "prin.pr.1", generation: 3 });
    recovery.markDispatched("op.done", "permit_2");
    recovery.markSettled("op.done", "complete", true);
    const done = await recovery.answerQuery(query("op.done"), ctx);
    expect(done?.state).toBe("completed");
    expect(done?.resultAvailability).toBe("available");

    recovery.markReceived("op.gone", { principalRef: "prin.pr.1", generation: 3 });
    recovery.markDispatched("op.gone", "permit_3");
    recovery.markSettled("op.gone", "complete", false);
    const gone = await recovery.answerQuery(query("op.gone"), ctx);
    expect(gone?.state).toBe("completed_result_unavailable");
  });

  it("answers dispatched_in_doubt for evicted records, never not_started", async () => {
    const recovery = createOperationRecoveryService({ maxOperations: 1 });
    const query = (operationId: string) => ({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "operation-query",
      operationId, principalRef: "prin.pr.1", generation: 3
    });
    recovery.markReceived("op.old", { principalRef: "prin.pr.1", generation: 3 });
    recovery.markDispatched("op.old", "permit_old");
    recovery.markSettled("op.old", "complete", true);
    // Recording a new operation beyond the cap evicts the settled record.
    recovery.markReceived("op.new", { principalRef: "prin.pr.1", generation: 3 });
    const status = await recovery.answerQuery(query("op.old"), ctx);
    expect(status?.state).toBe("dispatched_in_doubt");
    const fresh = await recovery.answerQuery(query("op.never.seen"), ctx);
    expect(fresh?.state).toBe("not_started");
  });

  it("hides another principal's operations behind status_unavailable", async () => {
    const recovery = createOperationRecoveryService();
    recovery.markReceived("op.x", { principalRef: "other", generation: 3 });
    recovery.markDispatched("op.x", "permit_9");
    const status = await recovery.answerQuery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "operation-query",
      operationId: "op.x", principalRef: "prin.pr.1", generation: 3
    }, ctx);
    expect(status?.state).toBe("status_unavailable");
  });
});

describe("recovery authority service", () => {
  function harness() {
    const { store } = makeDevice();
    store.enrollRecoveryAuthority({ recoveryKeyId: canned4, principalRef: "prin.pr.1", publicKey: canned11, generation: 3 });
    const keys = ed25519();
    const service = createRecoveryAuthorityService({
      identity: store,
      signer: {
        sign: () => "sig",
        verify: ({ publicKey, signature, transcript }) => {
          const expected = cryptoSign(null, Buffer.from(String(transcript)), keys.privateKey).toString("base64url");
          void publicKey;
          return signature === expected;
        }
      }
    });
    return { store, service, keys };
  }

  function canonicalProofTranscript(fields: Record<string, unknown>) {
    return canonicalJson({
      challengeId: fields.challengeId, endpointRouteId: fields.endpointRouteId,
      principalRef: fields.principalRef, generation: fields.generation,
      freshDeviceId: fields.freshDeviceId, freshDevicePublicKey: fields.freshDevicePublicKey,
      purpose: "recover_device"
    });
  }

  it("issues a single-use challenge and enrolls a proven fresh device", () => {
    const { service, keys } = harness();
    const challenge = service.beginRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    });
    expect(challenge?.kind).toBe("recovery-challenge");
    expect(challenge?.singleUse).toBe(true);

    const transcript = canonicalProofTranscript({
      challengeId: challenge!.challengeId, endpointRouteId: "route.pr.1",
      principalRef: challenge!.principalRef, generation: challenge!.generation,
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    });
    const signature = cryptoSign(null, Buffer.from(transcript), keys.privateKey).toString("base64url");
    const result = service.completeRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-proof",
      purpose: "recover_device", challengeId: challenge!.challengeId,
      endpointRouteId: "route.pr.1", principalRef: challenge!.principalRef,
      generation: challenge!.generation, freshDeviceId: "dev.fresh.9",
      freshDevicePublicKey: canned12, signature
    });
    expect(result?.outcome).toBe("enrolled");
    expect(result?.deviceAdmission?.requiresMutualTlsRebind).toBe(true);
  });

  it("rejects replayed challenges and mismatched possession proofs", () => {
    const { service, keys } = harness();
    const challenge = service.beginRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    })!;
    const transcript = canonicalProofTranscript({
      challengeId: challenge.challengeId, endpointRouteId: "route.pr.1",
      principalRef: challenge.principalRef, generation: challenge.generation,
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    });
    const signature = cryptoSign(null, Buffer.from(transcript), keys.privateKey).toString("base64url");
    const proof = {
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-proof",
      purpose: "recover_device", challengeId: challenge.challengeId,
      endpointRouteId: "route.pr.1", principalRef: challenge.principalRef,
      generation: challenge.generation, freshDeviceId: "dev.fresh.9",
      freshDevicePublicKey: canned12, signature
    };
    expect(service.completeRecovery(proof)?.outcome).toBe("enrolled");
    const replay = service.completeRecovery(proof);
    expect(replay?.outcome).toBe("refused");
    expect(["challenge_expired", "challenge_consumed"]).toContain(replay?.refusal);

    const bad = service.completeRecovery({ ...proof, challengeId: "nope", signature });
    expect(bad?.outcome).toBe("refused");
  });

  it("refuses proofs whose submitted identity fields diverge from the issued challenge", () => {
    const { service, keys } = harness();
    const challenge = service.beginRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    })!;

    function proofWith(mutation: Record<string, unknown>) {
      const merged = {
        challengeId: challenge.challengeId, endpointRouteId: "route.pr.1",
        principalRef: challenge.principalRef, generation: challenge.generation,
        freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12,
        ...mutation
      };
      // Sign over the submitted fields so signature verification itself would
      // pass — only the challenge binding can refuse these proofs.
      const signature = cryptoSign(null, Buffer.from(canonicalProofTranscript(merged)), keys.privateKey).toString("base64url");
      return {
        schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-proof",
        purpose: "recover_device", ...merged, signature
      };
    }

    for (const mutation of [
      { freshDeviceId: "dev.fresh.impostor" },
      { endpointRouteId: "route.pr.other" },
      { principalRef: "prin.pr.other" },
      { generation: challenge.generation + 1 },
      { freshDevicePublicKey: canned13 }
    ]) {
      const result = service.completeRecovery(proofWith(mutation));
      expect(result?.outcome).toBe("refused");
      expect(result?.refusal).toBe("key_possession_mismatch");
    }
  });

  it("refuses recovery over an already-enrolled device identity", () => {
    const { store, service, keys } = harness();
    // A request for an enrolled id never receives a challenge at all; identity
    // changes for live devices belong to the authenticated rotation flow.
    expect(service.beginRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.pr.entry.1", freshDevicePublicKey: canned14
    })).toBeNull();

    // A device enrolled between challenge issuance and proof is refused at
    // completion as well, and its record stays untouched.
    const challenge = service.beginRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.race.1", freshDevicePublicKey: canned15
    })!;
    store.enroll({
      deviceId: "dev.race.1", routeId: "route.pr.1", tenantId: "tenant.pr.1",
      trustBinding: {
        schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "endpoint-trust-binding",
        pairedIdentityKey: canned15, pairedIdentityFingerprint: canned16,
        mode: "personal", role: "entry", trustGeneration: 3,
        endpointPrincipalRef: "prin.pr.1", capabilityGrantRef: "grantref.pr.1",
        boundRecoveryKeyId: null
      }
    });
    const signature = cryptoSign(null, Buffer.from(canonicalProofTranscript({
      challengeId: challenge.challengeId, endpointRouteId: "route.pr.1",
      principalRef: challenge.principalRef, generation: challenge.generation,
      freshDeviceId: "dev.race.1", freshDevicePublicKey: canned15
    })), keys.privateKey).toString("base64url");
    const result = service.completeRecovery({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-proof",
      purpose: "recover_device", challengeId: challenge.challengeId,
      endpointRouteId: "route.pr.1", principalRef: challenge.principalRef,
      generation: challenge.generation, freshDeviceId: "dev.race.1",
      freshDevicePublicKey: canned15, signature
    });
    expect(result?.outcome).toBe("refused");
    expect(result?.refusal).toBe("purpose_mismatch");
    expect(store.device("dev.race.1")?.pairedIdentityFingerprint).toBe("fp.race.1");
  });

  it("admits only recovery kinds on the recovery channel", () => {
    const { service } = harness();
    expect(service.admitsKind("recovery-proof")).toBe(true);
    expect(service.admitsKind("frame")).toBe(false);
    expect(service.admitsKind("operation-query")).toBe(false);
  });
});

describe("pinned inner TLS over a neutral duplex", () => {
  async function makeCerts() {
    const dir = await mkdtemp(join(tmpdir(), "pr-tls-"));
    try {
      const srvFile = join(dir, "server.key");
      const serverCrt = join(dir, "server.crt");
      const cliFile = join(dir, "client.key");
      const clientCrt = join(dir, "client.crt");
      const opts = { stdio: "ignore" as const, timeout: 15_000 };
      expect(spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=endpoint", "-keyout", srvFile, "-out", serverCrt], opts).status).toBe(0);
      expect(spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=entry", "-keyout", cliFile, "-out", clientCrt], opts).status).toBe(0);
      const fs = await import("node:fs/promises");
      return {
        dir,
        server: { key: await fs.readFile(srvFile), cert: await fs.readFile(serverCrt) },
        client: { key: await fs.readFile(cliFile), cert: await fs.readFile(clientCrt) }
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  it("establishes mutual TLS only for pinned peer keys", async () => {
    const certs = await makeCerts();
    try {
      const clientPublicKey = createPublicKey({ key: certs.client.cert, format: "pem" });
      const clientPin = spkiSha256Base64Url(clientPublicKey);
      const serverPublicKey = createPublicKey({ key: certs.server.cert, format: "pem" });
      const serverPin = spkiSha256Base64Url(serverPublicKey);

      // Cross-connected duplex pair: bytes written to one end become readable on the other.
      const serverSide = new Duplex({ write(chunk, _e, cb) { clientSide.push(chunk); cb(); }, read() {} });
      const clientSide = new Duplex({ write(chunk, _e, cb) { serverSide.push(chunk); cb(); }, read() {} });

      const endpoint = createInnerTlsEndpoint({
        socket: serverSide,
        key: certs.server.key,
        cert: certs.server.cert,
        pinnedPeerSpki: [clientPin],
        handshakeTimeoutMs: 10_000
      });
      const client = createInnerTlsClient({
        socket: clientSide,
        key: certs.client.key,
        cert: certs.client.cert,
        pinnedPeerSpki: [serverPin],
        handshakeTimeoutMs: 10_000
      });

      const [establishedServer, establishedClient] = await Promise.all([endpoint.established, client.established]);
      expect(establishedServer.peerSpki).toBe(clientPin);
      expect(establishedClient.peerSpki).toBe(serverPin);

      client.socket.write("ping");
      const echoed = await new Promise<Buffer>((resolve) => endpoint.socket.once("data", resolve));
      expect(echoed.toString()).toBe("ping");

      endpoint.close();
      client.close();
    } finally {
      await rm(certs.dir, { recursive: true, force: true });
    }
  });
});

describe("private gateway endpoint composition", () => {
  it("handles recovery requests and operation queries through the transport", async () => {
    const { store } = makeDevice();
    store.enrollRecoveryAuthority({ recoveryKeyId: canned4, principalRef: "prin.pr.1", publicKey: canned11, generation: 3 });
    const transport = new FakeTransport();
    const endpoint = createPrivateGatewayEndpoint({
      gateway: { invoke: async () => ({ kind: "complete", value: "ok" }) } as never,
      authority: { contextFor: () => Object.freeze({ tenant: "tenant.pr.1", principal: "prin.pr.1", authGeneration: canned10, grant: Object.freeze({ revision: "3" }) }) },
      recoverySigner: { sign: () => "sig", verify: () => true },
      transport,
      admission: ADMISSION,
      identity: store,
      innerTls: { key: Buffer.from("k"), cert: Buffer.from("c") }
    });
    endpoint.handleRelayMessage({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "recovery-request",
      purpose: "recover_device", endpointRouteId: "route.pr.1",
      freshDeviceId: "dev.fresh.9", freshDevicePublicKey: canned12
    });
    expect(transport.last()?.kind).toBe("recovery-challenge");
    expect(endpoint.session.state).toBe("initiated");
  });

  it("maps kernel effectOutcome onto honest ledger phases", async () => {
    const { store } = makeDevice();
    const transport = new FakeTransport();
    const ctx = Object.freeze({ tenant: "tenant.pr.1", principal: "prin.pr.1", authGeneration: canned10, grant: Object.freeze({ revision: "3" }) });
    const endpoint = createPrivateGatewayEndpoint({
      gateway: {
        invoke: async (_c: unknown, invocation: { operationKey?: string }) =>
          invocation.operationKey === "op.thrown"
            ? Promise.reject(new Error("kernel blew up mid-dispatch"))
            : Promise.resolve({
                kind: "failure",
                code: "policy_denied",
                message: "denied",
                status: 403,
                effectOutcome: invocation.operationKey === "op.unknown" ? "unknown" : "not_started"
              })
      } as never,
      authority: { contextFor: () => ctx },
      recoverySigner: { sign: () => "sig", verify: () => true },
      transport,
      admission: ADMISSION,
      identity: store,
      innerTls: { key: Buffer.from("k"), cert: Buffer.from("c") }
    });
    const query = (operationId: string) => ({
      schemaVersion: "v0.0.1:private-relay:recovery-1", kind: "operation-query",
      operationId, principalRef: "prin.pr.1", generation: 3
    });
    const call = (operationId: string) => endpoint.dispatchInnerMessage(ctx as never, {
      jsonrpc: "2.0", method: "tools/call", id: operationId,
      params: { name: "svc/tool", arguments: {}, operationKey: operationId }
    });

    await call("op.refused");
    const refused = await endpoint.operationRecovery.answerQuery(query("op.refused"), ctx as never);
    expect(refused?.state).toBe("not_started");
    expect(refused?.notStartedEvidence).toBe("endpoint_refused_pre_dispatch");

    await call("op.unknown");
    const unknown = await endpoint.operationRecovery.answerQuery(query("op.unknown"), ctx as never);
    expect(unknown?.state).toBe("dispatched_in_doubt");

    await expect(call("op.thrown")).rejects.toThrow("kernel blew up");
    const thrown = await endpoint.operationRecovery.answerQuery(query("op.thrown"), ctx as never);
    expect(thrown?.state).toBe("dispatched_in_doubt");
  });

  it("rebuilds the inner channel on session-restored so frames deliver after reconnect", () => {
    const { store } = makeDevice();
    const transport = new FakeTransport();
    const endpoint = createPrivateGatewayEndpoint({
      gateway: { invoke: async () => ({ kind: "complete", value: "ok" }) } as never,
      authority: { contextFor: () => Object.freeze({ tenant: "tenant.pr.1", principal: "prin.pr.1", authGeneration: canned10, grant: Object.freeze({ revision: "3" }) }) },
      recoverySigner: { sign: () => "sig", verify: () => true },
      transport,
      admission: ADMISSION,
      identity: store,
      innerTls: { key: Buffer.from("k"), cert: Buffer.from("c") }
    });
    endpoint.open();
    endpoint.handleRelayMessage(admittedMessage());
    endpoint.close("reconnect");
    expect(endpoint.session.state).toBe("closed");
    expect(endpoint.reconnect()).toBe(true);
    endpoint.handleRelayMessage({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION, wireProtocol: "meshrix-private-relay/0",
      kind: "session-restored", sessionId: "sess.test.2", reconnectGeneration: 1,
      gaps: [], limits: { ...RELAY_LIMIT_FIELDS }, cursors: { toEndpoint: 0, toEntry: 0 }
    });
    expect(endpoint.session.state).toBe("admitted");
    // The rebuilt pump accepts inbound frames again — the ack proves delivery.
    endpoint.handleRelayMessage({
      schemaVersion: PRIVATE_RELAY_SCHEMA_VERSION, wireProtocol: "meshrix-private-relay/0",
      kind: "frame", sessionId: "sess.test.2", routeId: "route.pr.1",
      seq: 1, messageId: "msg.restore.1", payload: "AAAA", final: false
    });
    expect(transport.sent.find((m) => m.kind === "frame-ack")?.upToSeq).toBe(1);
  });
});
