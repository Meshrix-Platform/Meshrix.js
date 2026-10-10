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
  PRIVATE_RELAY_RECOVERY_KINDS,
  PRIVATE_RELAY_ROLES,
  PRIVATE_RELAY_SCHEMA_VERSION,
  PRIVATE_RELAY_SESSION_PURPOSES,
  PRIVATE_RELAY_SESSION_STATES,
  PRIVATE_RELAY_WIRE_PROTOCOL,
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  PRIVATE_RELAY_ROTATION_STATES,
  PRIVATE_RELAY_OPERATION_STATES,
  PRIVATE_RELAY_PEER_ACK_REFUSALS,
  PRIVATE_RELAY_PEER_APPLICATION_RECEIPT_KINDS,
  PRIVATE_RELAY_PEER_APP_RECEIPTS_FROM_ACKS,
  PRIVATE_RELAY_PEER_GAP_CAUSES,
  PRIVATE_RELAY_PEER_KINDS,
  PRIVATE_RELAY_PEER_LIMITS,
  PRIVATE_RELAY_PEER_MAILBOX_RECEIPT_KINDS,
  PRIVATE_RELAY_PEER_MAILBOX_SEES_PLAINTEXT,
  PRIVATE_RELAY_PEER_RECEIPT_KINDS,
  PRIVATE_RELAY_PEER_SCHEMA_VERSION,
  PRIVATE_RELAY_PEER_SEND_OUTCOMES,
  admitOutboundFrame,
  acknowledgeFrames,
  agreePrivateRelayPeers,
  assertOfflineCallHandling,
  assertOperationStatusHonest,
  assertPeerEnvelopeCipherOnly,
  assertPeerReceiptIndependent,
  assertRecoveryPurposeSeparation,
  assertRelayAdmissionOnlyRouting,
  assertRelaySessionTransition,
  assertRotationNotGlobal,
  assertSnapshotServiceVisibility,
  containsForbiddenPeerKeys,
  containsForbiddenRelayKeys,
  containsForbiddenSnapshotKeys,
  createPrivateRelayPeer,
  decodePrivateRelayMessage,
  decodePrivateRelayPeerMessage,
  endpointReachabilityForNewWork,
  encodePrivateRelayMessage,
  encodePrivateRelayPeerMessage,
  initialFrameAccounting,
  operationRetryPermitted,
  parsePrivateRelayMessage,
  parsePrivateRelayPeerMessage,
  parsePrivateRelayRecoveryMessage,
  peerAckFullyRecorded,
  peerReceiptIsApplicationReport,
  peerReceiptIsMailboxIssued,
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

describe("private relay wire contract", () : any => {
  it("freezes versioned schemas, roles, modes, purposes and bounded limits", () : any => {
    expect(PRIVATE_RELAY_SCHEMA_VERSION).toBe("v0.0.1:private-relay:wire-1");
    expect(PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION).toBe("v0.0.1:private-relay:recovery-1");
    expect(PRIVATE_RELAY_WIRE_PROTOCOL).toBe("meshrix-private-relay/0");
    expect([...PRIVATE_RELAY_ROLES].sort()).toEqual(["endpoint", "entry"]);
    expect([...PRIVATE_RELAY_MODES].sort()).toEqual(["enterprise", "personal"]);
    expect([...PRIVATE_RELAY_SESSION_PURPOSES].sort()).toEqual(["forward", "recover_device"]);
    expect(PRIVATE_RELAY_LIMITS.maxFramePayloadBytes).toBe(262_144);
    expect(PRIVATE_RELAY_LIMITS.maxOutstandingBytes).toBe(4_194_304);
    expect(PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF).toBe(false);
    expect(PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES).toBe(false);
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

  it("freezes peer messaging kinds, the receipt taxonomy and bounded mailbox limits", () : any => {
    expect(PRIVATE_RELAY_PEER_SCHEMA_VERSION).toBe("v0.0.1:private-relay:peer-1");
    expect([...PRIVATE_RELAY_PEER_KINDS].sort()).toEqual([
      "peer-accepted", "peer-ack", "peer-acked", "peer-bundle", "peer-bundle-fetch",
      "peer-bundle-publish", "peer-bundle-published", "peer-fetch", "peer-messages",
      "peer-receipt", "peer-retention-policy", "peer-send", "peer-status"
    ]);
    expect([...PRIVATE_RELAY_PEER_RECEIPT_KINDS].sort()).toEqual([
      "accepted", "accepted_by_agent", "completed", "received", "rejected"
    ]);
    expect([...PRIVATE_RELAY_PEER_MAILBOX_RECEIPT_KINDS].sort()).toEqual(["accepted", "received"]);
    expect([...PRIVATE_RELAY_PEER_APPLICATION_RECEIPT_KINDS].sort()).toEqual([
      "accepted_by_agent", "completed", "rejected"
    ]);
    expect([...PRIVATE_RELAY_PEER_SEND_OUTCOMES].sort()).toEqual(["accepted", "conflict", "duplicate"]);
    expect([...PRIVATE_RELAY_PEER_GAP_CAUSES].sort()).toEqual(["capacity_truncated", "expired"]);
    expect(PRIVATE_RELAY_PEER_APP_RECEIPTS_FROM_ACKS).toBe(false);
    expect(PRIVATE_RELAY_PEER_MAILBOX_SEES_PLAINTEXT).toBe(false);
    expect(PRIVATE_RELAY_PEER_LIMITS.maxEnvelopeBytes).toBe(65_536);
    expect(PRIVATE_RELAY_PEER_LIMITS.maxPageMessages).toBe(64);
    expect(PRIVATE_RELAY_PEER_LIMITS.maxAckEntries).toBe(64);
  });

  it("lets neutral peers agree on every frozen peer mailbox message", () : any => {
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
    expect(containsForbiddenPeerKeys(corpus.peer.invalid.peerSendSmuggledSemanticGrants)).toBe(true);
    expect(containsForbiddenPeerKeys(corpus.peer.invalid.peerSendCarriesPlaintextField)).toBe(true);
    expect(() : any => assertPeerEnvelopeCipherOnly(
      corpus.peer.invalid.peerSendSmuggledSemanticGrants
    )).toThrow();
    expect(() : any => assertPeerEnvelopeCipherOnly(
      corpus.peer.invalid.peerSendCarriesPlaintextField
    )).toThrow();
    expect(containsForbiddenPeerKeys(corpus.peer.valid["peer-send"])).toBe(false);
  });

  it("enforces sender-scoped idempotent resend and typed conflict rejection", () : any => {
    const send: any = corpus.peer.valid["peer-send"];
    expect(peerSendReplayClass(send, corpus.peer.valid["peer-send-retry"])).toBe("retry");
    expect(peerSendReplayClass(send, corpus.peer.valid["peer-send-conflict"])).toBe("conflict");
    expect(peerSendReplayClass(send, { ...send, messageId: "msg.pr.999" })).toBe("distinct");
    expect(peerSendReplayClass(send, corpus.peer.invalid.peerSendSelfAddressed)).toBeNull();
    const conflict: any = corpus.peer.valid["peer-accepted-conflict"];
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.receipt).toBeNull();
    const accepted: any = corpus.peer.valid["peer-accepted"];
    expect(accepted.receipt.kind).toBe("accepted");
    expect(peerReceiptIsMailboxIssued(accepted.receipt)).toBe(true);
  });

  it("keeps application receipts independent of mailbox acknowledgements", () : any => {
    const ackReports: any = corpus.peer.valid["peer-ack"].reports;
    expect(assertPeerReceiptIndependent(ackReports[0])).toBe(true);
    expect(peerReceiptIsApplicationReport(ackReports[0])).toBe(true);
    for (const status of corpus.peer.valid["peer-status"].statuses as any[]) {
      for (const receipt of status.receipts) expect(assertPeerReceiptIndependent(receipt)).toBe(true);
    }
    expect(() : any => assertPeerReceiptIndependent(
      corpus.peer.invalid.peerAcceptedDerivesAgentReceipt.receipt
    )).toThrow();
    expect(() : any => assertPeerReceiptIndependent(
      corpus.peer.invalid.peerStatusReceiptDerivedFromAck.statuses[0].receipts[0]
    )).toThrow();
    expect(() : any => assertPeerReceiptIndependent(
      corpus.peer.invalid.peerAckInventedReceiptKind.reports[0]
    )).toThrow();
  });

  it("records acknowledged sends without silent drops or invented outcomes", () : any => {
    expect(peerAckFullyRecorded(corpus.peer.valid["peer-ack"], corpus.peer.valid["peer-acked"])).toBe(true);
    const dropped: any = {
      ...corpus.peer.valid["peer-acked"],
      recorded: corpus.peer.valid["peer-acked"].recorded.slice(1)
    };
    expect(peerAckFullyRecorded(corpus.peer.valid["peer-ack"], dropped)).toBe(false);
    const invented: any = {
      ...corpus.peer.valid["peer-acked"],
      refused: [...corpus.peer.valid["peer-acked"].refused, { messageId: "msg.pr.777", refusal: "message_unknown" }]
    };
    expect(peerAckFullyRecorded(corpus.peer.valid["peer-ack"], invented)).toBe(false);
    for (const refusal of PRIVATE_RELAY_PEER_ACK_REFUSALS) expect(typeof refusal).toBe("string");
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
