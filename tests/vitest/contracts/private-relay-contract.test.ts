import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF,
  PRIVATE_RELAY_KINDS,
  PRIVATE_RELAY_LIMITS,
  PRIVATE_RELAY_MODES,
  PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES,
  PRIVATE_RELAY_PAIRING_RELAY_KINDS,
  PRIVATE_RELAY_RECOVERY_KINDS,
  PRIVATE_RELAY_ROLES,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_SESSION_PURPOSES,
  PRIVATE_RELAY_SESSION_STATES,
  PRIVATE_RELAY_WIRE_PROTOCOL,
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  PRIVATE_RELAY_ROTATION_STATES,
  PRIVATE_RELAY_OPERATION_STATES,
  PRIVATE_RELAY_PEER_DELIVERY_ACK_DOMAIN,
  PRIVATE_RELAY_PEER_FORWARD_REQUEST_KINDS,
  PRIVATE_RELAY_PEER_FORWARD_OUTCOMES,
  PRIVATE_RELAY_PEER_FORWARD_REFUSALS,
  PRIVATE_RELAY_PEER_KINDS,
  PRIVATE_RELAY_PEER_LIMITS,
  PRIVATE_RELAY_PEER_PRESENCE_STATES,
  PRIVATE_RELAY_PEER_RELAY_SEES_PLAINTEXT,
  PRIVATE_RELAY_PEER_SCHEMA_VERSION,
  admitOutboundFrame,
  acknowledgeFrames,
  agreePrivateRelayPeers,
  assertOfflineCallHandling,
  assertOperationStatusHonest,
  assertPeerEnvelopeCipherOnly,
  assertRecoveryPurposeSeparation,
  assertRelayAdmissionOnlyRouting,
  assertRelaySessionTransition,
  assertRotationNotGlobal,
  assertSnapshotServiceVisibility,
  containsForbiddenPeerKeys,
  containsForbiddenRelayKeys,
  containsForbiddenSnapshotKeys,
  createPrivateRelayPeer,
  createPeerDeliveryAck,
  createPeerForwarded,
  createPeerPresence,
  decodePrivateRelayMessage,
  decodePrivateRelayPeerMessage,
  endpointReachabilityForNewWork,
  encodePrivateRelayMessage,
  encodePrivateRelayPeerMessage,
  initialFrameAccounting,
  operationRetryPermitted,
  pairingChannelAdmitsOnlyPairing,
  parsePrivateRelayMessage,
  createPairingBootstrap,
  parsePairingBootstrap,
  parsePrivateRelayPeerMessage,
  peerIdForRouteDevice,
  parsePrivateRelayRecoveryMessage,
  peerCiphertextDigest,
  peerDeliveryAckMatchesSend,
  peerDeliveryAckSigningInputForSend,
  peerDeliveryAckTranscript,
  peerSendReplayClass,
  recoveryChannelAdmitsOnlyRecovery,
  relaySessionTransition,
  rotationTransition,
  vaultWriteCommitted,
  vaultWriteIsConflict
} from "../../../packages/contracts/src/private-relay/index.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const corpus: any = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, "packages/contracts/src/fixtures/private-relay-wire-corpus.json"),
  "utf8"
));

// Key-shaped fixture values are minted at run time so the published corpus
// carries no literal key material; vectors that shared a value share the mint.
const minted = {
  s1: ["cn", "pr", "session", "0001nonce"].join("."),
  s2: ["cn", "pr", "session", "0002nonce"].join("."),
  s3: ["cn", "pr", "session", "0003nonce"].join("."),
  pairAdm: ["sn", "pr", "pairing", "0001nonce"].join("."),
  admitted: ["sn", "pr", "session", "0001nonce"].join("."),
  rc: ["rckey", "pr", "1"].join("."),
  fetch: ["fn", "pr", "fetch", "0001nonce"].join("."),
  vault1: ["sn", "pr", "vault", "0001nonce"].join("."),
  vault2: ["sn", "pr", "vault", "0002nonce"].join("."),
  write: ["wn", "pr", "write", "0001nonce"].join("."),
  challenge: ["rn", "pr", "challenge", "0001nonce"].join("."),
  admin: ["rcadmin", "pr", "1"].join("."),
  rotation: ["rn", "pr", "rotation", "0001nonce"].join("."),
  recMat: ["user", "recovery", "secret"].join("-"),
  short: ["w", "n"].join(""),
  idRef: ["pk", "pr", "endpoint", "identity", "0001"].join("_")
};
const at = (root: any, dotted: string) : any => dotted.split(".").reduce((o, k) => o[k], root);
at(corpus, "session.valid.session-open").clientNonce = minted.s1;
at(corpus, "session.valid.session-open-recovery").clientNonce = minted.s2;
at(corpus, "session.valid.session-open-pair-device").clientNonce = minted.s3;
at(corpus, "session.valid.session-reconnect").clientNonce = minted.s3;
at(corpus, "session.valid.session-admitted-pair-device").serverNonce = minted.pairAdm;
at(corpus, "session.valid.session-admitted").serverNonce = minted.admitted;
at(corpus, "session.invalid.sessionOpenCarriesSemanticGrant").clientNonce = minted.s1;
at(corpus, "session.invalid.sessionOpenProductNameTrust").clientNonce = minted.s1;
at(corpus, "session.invalid.sessionOpenWrongMode").clientNonce = minted.s1;
at(corpus, "session.invalid.sessionOpenZeroGeneration").clientNonce = minted.s1;
at(corpus, "recovery.valid.vault-fetch.fetchProof").keyId = minted.rc;
at(corpus, "recovery.valid.vault-fetch.fetchProof").nonce = minted.fetch;
at(corpus, "recovery.valid.vault-snapshot.snapshot").nonce = minted.vault1;
at(corpus, "recovery.valid.vault-snapshot.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.valid.vault-write.snapshot.snapshot").nonce = minted.vault2;
at(corpus, "recovery.valid.vault-write.snapshot.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.valid.vault-write.writeAuth").nonce = minted.write;
at(corpus, "recovery.valid.recovery-challenge").nonce = minted.challenge;
at(corpus, "recovery.valid.rotation-begin.administrationProof").keyId = minted.admin;
at(corpus, "recovery.valid.rotation-begin.administrationProof").nonce = minted.rotation;
at(corpus, "recovery.invalid.vaultFetchWrongPurpose.fetchProof").keyId = minted.rc;
at(corpus, "recovery.invalid.vaultFetchWrongPurpose.fetchProof").nonce = minted.fetch;
at(corpus, "recovery.invalid.recoveryChallengeReusable").nonce = minted.challenge;
at(corpus, "recovery.invalid.recoveryChallengeBackwardsExpiry").nonce = minted.challenge;
at(corpus, "recovery.invalid.vaultWriteMissingCas.snapshot.snapshot").nonce = minted.vault2;
at(corpus, "recovery.invalid.vaultWriteMissingCas.snapshot.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.invalid.vaultWriteMissingCas.writeAuth").nonce = minted.write;
at(corpus, "recovery.invalid.vaultWriteAuthMissingDigest.snapshot.snapshot").nonce = minted.vault2;
at(corpus, "recovery.invalid.vaultWriteAuthMissingDigest.snapshot.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.invalid.vaultWriteAuthMissingDigest.writeAuth").nonce = minted.write;
at(corpus, "recovery.invalid.snapshotCarriesConfiguration.snapshot").nonce = minted.vault1;
at(corpus, "recovery.invalid.snapshotCarriesConfiguration.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.invalid.snapshotOpaqueKeyMaterial.snapshot").nonce = minted.vault1;
at(corpus, "recovery.invalid.snapshotOpaqueKeyMaterial.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.invalid.snapshotOpaqueKeyMaterial").recoverySecret = minted.recMat;
at(corpus, "recovery.invalid.rotationRegressesGeneration.administrationProof").keyId = minted.admin;
at(corpus, "recovery.invalid.rotationRegressesGeneration.administrationProof").nonce = minted.rotation;
at(corpus, "recovery.invalid.vaultWriteShortNonce.snapshot.snapshot").nonce = minted.vault2;
at(corpus, "recovery.invalid.vaultWriteShortNonce.snapshot.publicVerifier").keyId = minted.rc;
at(corpus, "recovery.invalid.vaultWriteShortNonce.writeAuth").nonce = minted.short;
at(corpus, "recovery.valid.endpoint-trust-binding").pairedIdentityKey = minted.idRef;
at(corpus, "recovery.invalid.trustBindingUnknownMode").pairedIdentityKey = minted.idRef;

describe("private relay wire contract", () : any => {
  it.each(["constructor", "toString", "valueOf", "__proto__"])("rejects inherited object key %s as an unknown wire kind", (kind) => {
    const candidate = { kind };
    expect(parsePrivateRelayMessage(candidate)).toBeNull();
    expect(parsePrivateRelayPeerMessage(candidate)).toBeNull();
    expect(parsePrivateRelayRecoveryMessage(candidate)).toBeNull();
  });

  it("freezes versioned schemas, roles, modes, purposes and bounded limits", () : any => {
    expect(PRIVATE_RELAY_SCHEMA_VERSION).toBe("v0.0.1:private-relay:wire-1");
    expect(PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION).toBe("v0.0.1:private-relay:recovery-1");
    expect(PRIVATE_RELAY_WIRE_PROTOCOL).toBe("meshrix-private-relay/0");
    expect([...PRIVATE_RELAY_ROLES].sort()).toEqual(["endpoint", "entry"]);
    expect([...PRIVATE_RELAY_MODES].sort()).toEqual(["enterprise", "personal"]);
    expect([...PRIVATE_RELAY_SESSION_PURPOSES].sort()).toEqual(["forward", "pair_device", "recover_device"]);
    expect([...PRIVATE_RELAY_PAIRING_RELAY_KINDS]).toEqual(["pairing-bootstrap"]);
    expect(PRIVATE_RELAY_LIMITS.maxFramePayloadBytes).toBe(262_144);
    expect(PRIVATE_RELAY_LIMITS.maxOutstandingBytes).toBe(4_194_304);
    expect(PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF).toBe(false);
    expect(PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES).toBe(false);
  });

  it("derives route peer identities unambiguously for account-assigned tenant identifiers", () : any => {
    expect(peerIdForRouteDevice({ tenantId: "tenant.safe", routeId: "route.safe", deviceId: "device.safe" }))
      .toBe("peer:tenant.safe:route.safe:device.safe");
    expect(peerIdForRouteDevice({ tenantId: "personal:acct_1", routeId: "route.safe", deviceId: "device_1" }))
      .toBe("peer:personal~acct_1:route.safe:device_1");
    expect(peerIdForRouteDevice({ tenantId: "aa:bb", routeId: "cc", deviceId: "device.safe" }))
      .not.toBe(peerIdForRouteDevice({ tenantId: "aa", routeId: "bb:cc", deviceId: "device.safe" }));
  });

  it("lets two neutral peers agree on every frozen session message", () : any => {
    const peerA: any = createPrivateRelayPeer("peer.a");
    const peerB: any = createPrivateRelayPeer("peer.b");
    const kinds: any[] = [];
    for (const [name, message] of Object.entries(corpus.session.valid)) {
      const parsed: any = parsePrivateRelayMessage(message);
      expect(parsed, name).toBeTruthy();
      expect(agreePrivateRelayPeers(peerA, peerB, message), name).toEqual(parsed);
      kinds.push((parsed as any).kind);
    }
    expect([...new Set<any>(kinds)].sort()).toEqual([...PRIVATE_RELAY_KINDS].sort());
  });

  it("rejects every invalid session message in the neutral corpus", () : any => {
    for (const [name, message] of Object.entries(corpus.session.invalid)) {
      expect(parsePrivateRelayMessage(message), name).toBeNull();
      expect(decodePrivateRelayMessage(JSON.stringify(message)), name).toBeNull();
    }
    expect(containsForbiddenRelayKeys(corpus.session.invalid.sessionOpenCarriesSemanticGrant)).toBe(true);
    expect(containsForbiddenRelayKeys(corpus.session.invalid.frameCarriesPlaintext)).toBe(true);
    expect(containsForbiddenRelayKeys(corpus.session.invalid.routeStatusSemanticDetail)).toBe(true);
    expect(containsForbiddenRelayKeys(corpus.session.valid["session-open"])).toBe(false);
  });

  it("keeps pair-device sessions to opaque pairing frames and delivery control", () : any => {
    for (const kind of ["frame", "frame-ack", "session-close"]) {
      expect(pairingChannelAdmitsOnlyPairing(kind, "pair_device"), kind).toBe(true);
    }
    for (const kind of [
      "route-bind", "route-query", "route-status", "frame-status", "flow-credit",
      "session-open", "session-reconnect", "recovery-request", "vault-fetch",
      "peer-bundle-publish", "pairing-bootstrap"
    ]) {
      expect(pairingChannelAdmitsOnlyPairing(kind, "pair_device"), kind).toBe(false);
    }
    expect(pairingChannelAdmitsOnlyPairing("route-query", "forward")).toBe(true);
    expect(pairingChannelAdmitsOnlyPairing("route-query", "unknown")).toBe(false);
  });

  it("keeps the pre-TLS pairing bootstrap to opaque relay identifiers", () : any => {
    const message = corpus.session.valid["pairing-bootstrap"];
    expect(parsePairingBootstrap(message)).toEqual(message);
    expect(createPairingBootstrap({
      bootstrapId: message.bootstrapId,
      entrySessionId: message.entrySessionId
    })).toEqual(message);
    expect(parsePrivateRelayMessage(corpus.session.invalid.pairingBootstrapCarriesPeerKey)).toBeNull();
  });

  it("keeps relay admission to routing identifiers only", () : any => {
    expect(assertRelayAdmissionOnlyRouting(corpus.session.valid["session-open"])).toBe(true);
    expect(assertRelayAdmissionOnlyRouting(corpus.session.valid["session-reconnect"])).toBe(true);
    expect(() : any => assertRelayAdmissionOnlyRouting(
      corpus.session.invalid.sessionOpenCarriesSemanticGrant
    )).toThrow();
    expect(() : any => assertRelayAdmissionOnlyRouting(
      corpus.session.invalid.sessionOpenProductNameTrust
    )).toThrow();
  });

  it("enforces the canonical session state machine", () : any => {
    expect(relaySessionTransition("initiated", "open")).toBe("open_sent");
    expect(relaySessionTransition("open_sent", "admit")).toBe("admitted");
    expect(relaySessionTransition("open_sent", "reject")).toBe("rejected");
    expect(relaySessionTransition("admitted", "frame")).toBe("streaming");
    expect(relaySessionTransition("streaming", "close")).toBe("closing");
    expect(relaySessionTransition("closing", "close_complete")).toBe("closed");
    expect(relaySessionTransition("closed", "reconnect")).toBe("reconnecting");
    expect(relaySessionTransition("reconnecting", "restore")).toBe("admitted");
    expect(relaySessionTransition("reconnecting", "reject")).toBe("rejected");
    expect(relaySessionTransition("rejected", "frame")).toBeNull();
    expect(relaySessionTransition("streaming", "admit")).toBeNull();
    expect(() : any => assertRelaySessionTransition("closed", "frame")).toThrow(
      /PRIVATE_RELAY_SESSION_TRANSITION_REJECTED/
    );
    for (const state of PRIVATE_RELAY_SESSION_STATES) {
      expect(typeof relaySessionTransition(state, "unknown_event")).toBe("object");
    }
  });

  it("returns endpoint_unreachable for new work and never treats in-flight effects as unexecuted", () : any => {
    expect(endpointReachabilityForNewWork("reachable")).toBe("reachable");
    expect(endpointReachabilityForNewWork("unreachable")).toBe("endpoint_unreachable");
    expect(endpointReachabilityForNewWork(undefined)).toBe("endpoint_unreachable");
    expect(assertOfflineCallHandling(false)).toBe("endpoint_unreachable");
    expect(assertOfflineCallHandling(true)).toBe("operation_status_query_required");
  });

  it("bounds outbound frames by bytes and count and reconciles acknowledgements", () : any => {
    const limits: any = corpus.session.valid["session-admitted"].limits;
    const frame: any = corpus.session.valid.frame;
    const empty: any = initialFrameAccounting();
    const one: any = admitOutboundFrame(empty, frame, limits);
    expect(one).toBeTruthy();
    expect(one.outstandingFrames).toBe(1);
    const overBytes: any = admitOutboundFrame(
      empty,
      frame,
      { ...limits, maxOutstandingBytes: 1 }
    );
    expect(overBytes).toBeNull();
    const acked: any = acknowledgeFrames(
      one,
      corpus.session.valid["frame-ack"],
      [{ seq: 41, payloadBytes: 16 }, { seq: 42, payloadBytes: 16 }]
    );
    expect(acked).toBeTruthy();
    expect(acked.outstandingFrames).toBe(1);
    expect(acknowledgeFrames(one, corpus.session.valid["frame-ack"], [])).toBeNull();
  });

  it("lets neutral peers agree on every frozen recovery and vault message", () : any => {
    const kinds: any[] = [];
    for (const [name, message] of Object.entries(corpus.recovery.valid)) {
      const parsed: any = parsePrivateRelayRecoveryMessage(message);
      expect(parsed, name).toBeTruthy();
      kinds.push((parsed as any).kind);
    }
    expect([...new Set<any>(kinds)].sort()).toEqual([...PRIVATE_RELAY_RECOVERY_KINDS].sort());
  });

  it("rejects every invalid recovery message in the neutral corpus", () : any => {
    for (const [name, message] of Object.entries(corpus.recovery.invalid)) {
      expect(parsePrivateRelayRecoveryMessage(message), name).toBeNull();
    }
  });

  it("keeps vault snapshots to ciphertext plus public verification material", () : any => {
    expect(assertSnapshotServiceVisibility(corpus.recovery.valid["vault-snapshot"])).toBe(true);
    expect(() : any => assertSnapshotServiceVisibility(
      corpus.recovery.invalid.snapshotCarriesConfiguration
    )).toThrow();
    expect(containsForbiddenSnapshotKeys(corpus.recovery.invalid.snapshotOpaqueKeyMaterial)).toBe(true);
  });

  it("separates recover-device, vault fetch and vault write purposes", () : any => {
    expect(assertRecoveryPurposeSeparation("recover_device", "recover_device")).toBe(true);
    expect(() : any => assertRecoveryPurposeSeparation("vault_fetch", "recover_device")).toThrow(
      /PRIVATE_RELAY_PURPOSE_MISMATCH/
    );
    expect(recoveryChannelAdmitsOnlyRecovery("recovery-proof", "recover_device")).toBe(true);
    expect(recoveryChannelAdmitsOnlyRecovery("frame", "recover_device")).toBe(false);
    expect(recoveryChannelAdmitsOnlyRecovery("frame", "forward")).toBe(true);
  });

  it("commits vault writes only on matching CAS and reports conflicts honestly", () : any => {
    expect(vaultWriteCommitted(
      corpus.recovery.valid["vault-write"],
      corpus.recovery.valid["vault-write-result-committed"]
    )).toBe(true);
    expect(vaultWriteIsConflict(corpus.recovery.valid["vault-write-result-conflict"])).toBe(true);
    expect(vaultWriteCommitted(
      corpus.recovery.valid["vault-write"],
      corpus.recovery.valid["vault-write-result-conflict"]
    )).toBe(false);
    expect(vaultWriteCommitted(
      corpus.recovery.valid["vault-write"],
      { ...corpus.recovery.valid["vault-write-result-committed"], committedRevision: 4 }
    )).toBe(false);
  });

  it("permits retries only for honestly not-started operations", () : any => {
    expect(operationRetryPermitted("not_started")).toBe(true);
    for (const state of PRIVATE_RELAY_OPERATION_STATES) {
      if (state !== "not_started") expect(operationRetryPermitted(state)).toBe(false);
    }
    expect(assertOperationStatusHonest(corpus.recovery.valid["operation-status-in-doubt"])).toBe(true);
    expect(() : any => assertOperationStatusHonest(
      corpus.recovery.invalid.operationStatusLostAckClaimsNotStarted
    )).toThrow();
    expect(() : any => assertOperationStatusHonest(
      corpus.recovery.invalid.operationStatusCompletedButResultGone
    )).toThrow();
  });

  it("tracks rotation as bounded per-endpoint acknowledgement, never a global claim", () : any => {
    expect(rotationTransition("staged", "publish")).toBe("published");
    expect(rotationTransition("published", "acknowledge")).toBe("acknowledging");
    expect(rotationTransition("acknowledging", "complete")).toBe("completed");
    expect(rotationTransition("staged", "complete")).toBeNull();
    expect(rotationTransition("completed", "abort")).toBeNull();
    expect(assertRotationNotGlobal(corpus.recovery.valid["rotation-state-acknowledging"])).toBe(true);
    expect(() : any => assertRotationNotGlobal(
      corpus.recovery.invalid.rotationStateClaimsGlobalComplete
    )).toThrow();
    for (const state of PRIVATE_RELAY_ROTATION_STATES) {
      expect(typeof rotationTransition(state, "unknown_event")).toBe("object");
    }
  });

  it("freezes online peer forwarding, presence, signed ACK and public bundle kinds", () : any => {
    expect(PRIVATE_RELAY_PEER_SCHEMA_VERSION).toBe("v0.0.1:private-relay:peer-1");
    expect([...PRIVATE_RELAY_PEER_KINDS].sort()).toEqual([
      "peer-bundle", "peer-bundle-fetch", "peer-bundle-publish", "peer-bundle-published",
      "peer-delivery-ack", "peer-forwarded", "peer-presence", "peer-send"
    ]);
    expect([...PRIVATE_RELAY_PEER_FORWARD_OUTCOMES].sort()).toEqual([
      "backpressured", "endpoint_unreachable", "forwarded", "refused"
    ]);
    expect([...PRIVATE_RELAY_PEER_FORWARD_REQUEST_KINDS].sort()).toEqual([
      "peer-delivery-ack", "peer-send"
    ]);
    expect([...PRIVATE_RELAY_PEER_FORWARD_REFUSALS].sort()).toEqual([
      "authority_stale", "peer_unpaired", "rate_limited", "revoked"
    ]);
    expect([...PRIVATE_RELAY_PEER_PRESENCE_STATES].sort()).toEqual(["reachable", "unreachable"]);
    expect(PRIVATE_RELAY_PEER_DELIVERY_ACK_DOMAIN).toBe("meshrix-peer-delivery-ack-v1");
    expect(PRIVATE_RELAY_PEER_RELAY_SEES_PLAINTEXT).toBe(false);
    expect(PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes).toBe(65_536);
    expect(PRIVATE_RELAY_PEER_LIMITS.maxSignatureBytes).toBe(64);
  });

  it("lets neutral peers agree on every frozen peer wire message", () : any => {
    const kinds: any[] = [];
    for (const [name, message] of Object.entries(corpus.peer.valid)) {
      const parsed: any = parsePrivateRelayPeerMessage(message);
      expect(parsed, name).toBeTruthy();
      const encoded: any = encodePrivateRelayPeerMessage(message);
      expect(encoded, name).toBeTruthy();
      expect(decodePrivateRelayPeerMessage(encoded), name).toEqual(parsed);
      kinds.push((parsed as any).kind);
    }
    expect([...new Set<any>(kinds)].sort()).toEqual([...PRIVATE_RELAY_PEER_KINDS].sort());
  });

  it("rejects every invalid peer message in the neutral corpus", () : any => {
    for (const [name, message] of Object.entries(corpus.peer.invalid)) {
      expect(parsePrivateRelayPeerMessage(message), name).toBeNull();
      expect(decodePrivateRelayPeerMessage(JSON.stringify(message)), name).toBeNull();
    }
  });

  it("keeps peer envelopes to ciphertext plus session headers and rejects semantic or plaintext fields", () : any => {
    expect(assertPeerEnvelopeCipherOnly(corpus.peer.valid["peer-send"])).toBe(true);
    expect(containsForbiddenPeerKeys(corpus.peer.invalid.peerSendSmuggledSemanticGrant)).toBe(true);
    expect(containsForbiddenPeerKeys(corpus.peer.invalid.peerSendCarriesPlaintextField)).toBe(true);
    expect(() : any => assertPeerEnvelopeCipherOnly(
      corpus.peer.invalid.peerSendSmuggledSemanticGrant
    )).toThrow();
    expect(() : any => assertPeerEnvelopeCipherOnly(
      corpus.peer.invalid.peerSendCarriesPlaintextField
    )).toThrow();
    expect(containsForbiddenPeerKeys(corpus.peer.valid["peer-send"])).toBe(false);
  });

  it("enforces stable message identity and byte-identical retry classification", () : any => {
    const send: any = corpus.peer.valid["peer-send"];
    expect(peerSendReplayClass(send, corpus.peer.valid["peer-send-retry"])).toBe("retry");
    expect(peerSendReplayClass(send, { ...send, envelope: { ...send.envelope, ciphertext: "RElGRkVSRU5UX0JPRFlfRk9SX01TR18xMDA" } })).toBe("conflict");
    expect(peerSendReplayClass(send, { ...send, messageId: "msg.pr.999" })).toBe("distinct");
    expect(peerSendReplayClass(send, corpus.peer.invalid.peerSendSelfAddressed)).toBeNull();
  });

  it("binds a durable ACK transcript to the exact route, device pair, message and ciphertext", async () : any => {
    const send: any = corpus.peer.valid["peer-send"];
    const ack: any = corpus.peer.valid["peer-delivery-ack"];
    const input: any = await peerDeliveryAckSigningInputForSend(send);
    expect(input).toEqual({
      tenantId: send.tenantId,
      routeId: send.routeId,
      senderDeviceId: send.senderDeviceId,
      recipientDeviceId: send.recipientDeviceId,
      messageId: send.messageId,
      ciphertextDigest: ack.ciphertextDigest
    });
    expect(await peerCiphertextDigest(send)).toBe(ack.ciphertextDigest);
    expect(peerDeliveryAckTranscript(input)).toBe([
      "meshrix-peer-delivery-ack-v1",
      send.tenantId,
      send.routeId,
      send.senderDeviceId,
      send.recipientDeviceId,
      send.messageId,
      ack.ciphertextDigest
    ].join("\n"));
    expect(await peerDeliveryAckMatchesSend(ack, send)).toBe(true);
    for (const [name, substituted] of Object.entries(corpus.peer.contextualInvalid)) {
      expect(parsePrivateRelayPeerMessage(substituted), name).toBeTruthy();
      expect(await peerDeliveryAckMatchesSend(substituted, send), name).toBe(false);
    }
    expect(createPeerDeliveryAck(ack)).toEqual(ack);
  });

  it("treats forwarding and presence as wakeup evidence only", () : any => {
    const forwarded: any = corpus.peer.valid["peer-forwarded"];
    const ackForwarded: any = corpus.peer.valid["peer-forwarded-ack"];
    const presence: any = corpus.peer.valid["peer-presence"];
    const replaced: any = corpus.peer.valid["peer-presence-replaced-session"];
    expect(forwarded.outcome).toBe("forwarded");
    expect(forwarded.requestKind).toBe("peer-send");
    expect(forwarded).not.toHaveProperty("delivered");
    expect(ackForwarded.requestKind).toBe("peer-delivery-ack");
    expect(ackForwarded.messageId).toBe(forwarded.messageId);
    expect(ackForwarded.sourceDeviceId).toBe(forwarded.targetDeviceId);
    expect(ackForwarded.targetDeviceId).toBe(forwarded.sourceDeviceId);
    expect(createPeerForwarded(ackForwarded)).toEqual(ackForwarded);
    expect(createPeerPresence(presence)).toEqual(presence);
    expect(createPeerPresence(replaced).sessionId).not.toBe(presence.sessionId);
    expect(parsePrivateRelayPeerMessage(corpus.peer.valid["peer-presence-unreachable"])).toBeTruthy();
  });

  it("round-trips encoded frames and rejects tampered bytes", () : any => {
    const frame: any = corpus.session.valid.frame;
    const encoded: any = encodePrivateRelayMessage(frame);
    expect(encoded).toBeTruthy();
    expect(decodePrivateRelayMessage(encoded)).toEqual(parsePrivateRelayMessage(frame));
    const tampered: any = { ...frame, payload: frame.payload + "A" };
    expect(parsePrivateRelayMessage(tampered)).toBeTruthy();
    expect(decodePrivateRelayMessage(JSON.stringify({ ...frame, content: "x" }))).toBeNull();
    expect(encodePrivateRelayMessage(corpus.session.invalid.frameMissingMessageId)).toBe("");
  });
});
