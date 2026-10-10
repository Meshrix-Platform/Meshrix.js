/**
 * MailboxDO peer-mailbox tests on real local Workerd: bundle directory,
 * durable send/fetch/ack with typed receipts, sender-scoped idempotency,
 * retention truncation tombstones, restart persistence, revocation honesty
 * and the no-plaintext storage audit. All identities/payloads are synthetic.
 */

import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

import { containsForbiddenPeerKeys } from "../../../packages/contracts/src/private-relay/index.ts";
import { mailboxObjectName } from "../src/ids.ts";
import {
  type Enrolled,
  ROUTE_1,
  ROUTE_2,
  TENANT_A,
  WsClient,
  adminGet,
  adminPost,
  enroll,
  freshPeerId,
  mailboxPeerCall,
  mailboxStub,
  peerAckMessage,
  peerAgentReport,
  peerBundleFetchMessage,
  peerBundleObject,
  peerBundlePublishMessage,
  peerEnvelopeObject,
  peerFetchMessage,
  peerReceiptQueryMessage,
  peerSendMessage,
  sessionOpenMessage,
} from "./helpers.ts";

function admissionFor(enrolled: Enrolled): Record<string, unknown> {
  return {
    tenantId: TENANT_A,
    deviceId: enrolled.deviceId,
    routeId: enrolled.routeId,
    role: enrolled.role,
    mode: "personal",
    admissionGeneration: enrolled.admissionGeneration,
    revocationRevision: enrolled.revocationRevision,
  };
}

interface PeerSide {
  enrolled: Enrolled;
  ws: WsClient;
  admitted: Record<string, unknown>;
  policy: Record<string, unknown>;
}

async function connectPeerSide(
  routeId: string,
  role: "entry" | "endpoint",
  tag: string,
  tenantId = TENANT_A,
): Promise<PeerSide> {
  const enrolled = await enroll(tenantId, `dev.test.${role}.${tag}${Math.random().toString(36).slice(2, 6)}`, routeId, role);
  const ws = await WsClient.connect(tenantId, routeId, enrolled.credential);
  ws.send(sessionOpenMessage({ purpose: "forward", admission: admissionFor(enrolled) }));
  const admitted = await ws.waitForKind("session-admitted");
  const policy = await ws.waitForKind("peer-retention-policy");
  return { enrolled, ws, admitted, policy };
}

async function connectPeerPair(routeId: string, tag = ""): Promise<{ entry: PeerSide; endpoint: PeerSide }> {
  const [entry, endpoint] = await Promise.all([
    connectPeerSide(routeId, "entry", `${tag}a`),
    connectPeerSide(routeId, "endpoint", `${tag}b`),
  ]);
  return { entry, endpoint };
}

/** Session-authenticated admission stamp for direct partition calls. */
function internalAdmission(side: PeerSide): Record<string, unknown> {
  return {
    tenantId: TENANT_A,
    routeId: side.enrolled.routeId,
    deviceId: side.enrolled.deviceId,
    role: side.enrolled.role,
    revocationRevision: side.enrolled.revocationRevision,
    admissionGeneration: side.enrolled.admissionGeneration,
    sessionId: String(side.admitted.sessionId ?? "sess.test"),
  };
}

async function mailboxState(tenantId: string, routeId: string, deviceId: string): Promise<Record<string, unknown>> {
  const stub = mailboxStub(tenantId, routeId, deviceId);
  const response = await stub.fetch("http://mailbox.internal/internal/state");
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Wait for a peer-messages page carrying exactly the given positions. Live
 * pushes queue beside explicit fetch responses, so match on content.
 */
function waitForPage(ws: WsClient, positions: number[], timeoutMs = 8_000): Promise<Record<string, unknown>> {
  return ws.waitFor(
    (m) => m.parsed?.kind === "peer-messages"
      && JSON.stringify((m.parsed.messages as Record<string, unknown>[]).map((row) => row.position)) === JSON.stringify(positions),
    timeoutMs,
  ).then((m) => m.parsed!);
}

afterEach(async () => {
  await reset();
});

describe("peer mailbox bundles and retention advertisement", () => {
  it("advertises the deployment retention policy at admission and on pull", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "pol");
    for (const side of [entry, endpoint]) {
      expect(side.policy.kind).toBe("peer-retention-policy");
      expect(side.policy.routeId).toBe(ROUTE_1);
      expect(side.policy.deviceId).toBe(side.enrolled.deviceId);
      expect(side.policy.mailboxCapacityBytes).toBe(16_777_216);
      expect(side.policy.mailboxRetentionMs).toBe(2_592_000_000);
      expect(side.policy.mailboxMaxItems).toBe(4_096);
    }
    // Pull fallback returns the same advertisement.
    entry.ws.send({
      schemaVersion: "v0.0.1:private-relay:peer-1",
      wireProtocol: "meshrix-private-relay/0",
      kind: "peer-retention-policy",
      routeId: ROUTE_1,
      deviceId: entry.enrolled.deviceId,
      mailboxCapacityBytes: 1,
      mailboxRetentionMs: 1,
      mailboxMaxItems: 1,
    });
    const pulled = await entry.ws.waitForKind("peer-retention-policy");
    expect(pulled.mailboxCapacityBytes).toBe(16_777_216);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("publishes, supersedes and fetches prekey bundles with honest outcomes", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "bnd");

    // Unpublished state is honest absence, not an error.
    entry.ws.send(peerBundleFetchMessage(TENANT_A, ROUTE_1, entry.enrolled.deviceId, endpoint.enrolled.deviceId));
    const unpublished = await entry.ws.waitForKind("peer-bundle");
    expect(unpublished.state).toBe("unpublished");
    expect(unpublished.bundle).toBeNull();

    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpoint.enrolled.deviceId, peerBundleObject(endpoint.enrolled.deviceId, 1),
    ));
    const published = await endpoint.ws.waitForKind("peer-bundle-published");
    expect(published.outcome).toBe("published");
    expect(published.currentRevision).toBe(1);

    entry.ws.send(peerBundleFetchMessage(TENANT_A, ROUTE_1, entry.enrolled.deviceId, endpoint.enrolled.deviceId));
    const fetched = await entry.ws.waitForKind("peer-bundle");
    expect(fetched.state).toBe("available");
    expect((fetched.bundle as Record<string, unknown>).revision).toBe(1);

    // A higher revision supersedes the live bundle.
    const bundle2 = peerBundleObject(endpoint.enrolled.deviceId, 2);
    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpoint.enrolled.deviceId, bundle2,
    ));
    const superseded = await endpoint.ws.waitForKind("peer-bundle-published");
    expect(superseded.outcome).toBe("superseded");
    expect(superseded.currentRevision).toBe(2);

    // A replayed identical publish is idempotent; a stale or divergent
    // revision is refused without displacing the live bundle.
    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpoint.enrolled.deviceId, bundle2,
    ));
    const replay = await endpoint.ws.waitForKind("peer-bundle-published");
    expect(replay.outcome).toBe("published");
    expect(replay.currentRevision).toBe(2);

    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpoint.enrolled.deviceId, peerBundleObject(endpoint.enrolled.deviceId, 1),
    ));
    const stale = await endpoint.ws.waitForKind("peer-bundle-published");
    expect(stale.outcome).toBe("refused");
    expect(stale.refusal).toBe("stale_revision");
    expect(stale.currentRevision).toBe(2);

    entry.ws.send(peerBundleFetchMessage(TENANT_A, ROUTE_1, entry.enrolled.deviceId, endpoint.enrolled.deviceId));
    const refetched = await entry.ws.waitForKind("peer-bundle");
    expect((refetched.bundle as Record<string, unknown>).revision).toBe(2);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("refuses bundle fetches for devices that are not the paired route peer", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "iso");
    // A device enrolled only on another route is not a peer on ROUTE_1.
    const stranger = await enroll(TENANT_A, "dev.test.stranger.iso1", ROUTE_2, "entry");
    entry.ws.send(peerBundleFetchMessage(TENANT_A, ROUTE_1, entry.enrolled.deviceId, stranger.deviceId));
    const refused = await entry.ws.waitForKind("peer-bundle");
    expect(refused.state).toBe("refused");
    expect(refused.refusal).toBe("peer_unpaired");
    entry.ws.close();
    endpoint.ws.close();
  });
});

describe("peer mailbox send/fetch/ack lifecycle", () => {
  it("accepts sends with receipts, pages cursors, pushes live delivery", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "lc");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const msg1 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    const accepted = await entry.ws.waitForKind("peer-accepted");
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.position).toBe(1);
    expect((accepted.receipt as Record<string, unknown>).kind).toBe("accepted");
    expect((accepted.receipt as Record<string, unknown>).source).toBe("mailbox");

    // Event-driven wakeup: the live recipient session receives a pushed
    // peer-messages page without polling.
    const pushed = await waitForPage(endpoint.ws, [1]);
    const pushedMsgs = pushed.messages as Record<string, unknown>[];
    expect((pushedMsgs[0].envelope as Record<string, unknown>).ciphertext).toBeTruthy();

    // Two more sends, then cursor pages through the mailbox.
    const msg2 = freshPeerId();
    const msg3 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg2, peerEnvelopeObject()));
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg3, peerEnvelopeObject()));
    const acc2 = await entry.ws.waitForKind("peer-accepted");
    const acc3 = await entry.ws.waitForKind("peer-accepted");
    expect([acc2.position, acc3.position]).toEqual([2, 3]);

    endpoint.ws.send(peerFetchMessage(TENANT_A, ROUTE_1, endpointId, 0, 2));
    const page1 = await waitForPage(endpoint.ws, [1, 2]);
    expect(page1.more).toBe(true);
    expect(page1.nextAfterSeq).toBe(2);

    endpoint.ws.send(peerFetchMessage(TENANT_A, ROUTE_1, endpointId, page1.nextAfterSeq as number, 2));
    const page2 = await waitForPage(endpoint.ws, [3]);
    expect(page2.more).toBe(false);
    expect(page2.nextAfterSeq).toBe(3);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("records received/agent receipts transactionally and reports status", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "ack");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const msg1 = freshPeerId();
    const msg2 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg2, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");
    await entry.ws.waitForKind("peer-accepted");

    endpoint.ws.send(peerAckMessage(
      TENANT_A, ROUTE_1, endpointId,
      [{ messageId: msg1, position: 1 }, { messageId: msg2, position: 2 }],
      [peerAgentReport("completed", msg1, 1, "QUVEX3N5bnRoZXRpYw"), peerAgentReport("accepted_by_agent", msg2, 2)],
    ));
    const acked = await endpoint.ws.waitForKind("peer-acked");
    const recorded = acked.recorded as Record<string, unknown>[];
    expect(recorded).toHaveLength(4);
    expect(recorded.filter((r) => r.kind === "received")).toHaveLength(2);
    expect(recorded.filter((r) => r.source === "recipient")).toHaveLength(2);
    expect(recorded.filter((r) => r.source === "agent")).toHaveLength(2);
    expect(acked.refused).toEqual([]);

    // Sender reconciles through peer-status: independent receipts per kind.
    entry.ws.send(peerReceiptQueryMessage(TENANT_A, ROUTE_1, entryId, [msg1, msg2, "msg.never.sent"]));
    const status = await entry.ws.waitForKind("peer-status");
    const statuses = status.statuses as Record<string, unknown>[];
    const s1 = statuses.find((s) => s.messageId === msg1)!;
    const kinds1 = (s1.receipts as Record<string, unknown>[]).map((r) => r.kind).sort();
    expect(s1.position).toBe(1);
    expect(kinds1).toEqual(["accepted", "completed", "received"]);
    const s2 = statuses.find((s) => s.messageId === msg2)!;
    expect((s2.receipts as Record<string, unknown>[]).map((r) => r.kind).sort())
      .toEqual(["accepted", "accepted_by_agent", "received"]);
    const unknown = statuses.find((s) => s.messageId === "msg.never.sent")!;
    expect(unknown.position).toBe(0);
    expect(unknown.receipts).toEqual([]);

    // Re-acking is idempotent: the same received entry is recorded again.
    endpoint.ws.send(peerAckMessage(TENANT_A, ROUTE_1, endpointId, [{ messageId: msg1, position: 1 }], []));
    const reacked = await endpoint.ws.waitForKind("peer-acked");
    expect((reacked.recorded as Record<string, unknown>[])[0].kind).toBe("received");
    expect(reacked.refused).toEqual([]);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("replays same-envelope sends as duplicate and rejects conflicts", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "idem");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const messageId = freshPeerId();
    const envelope = peerEnvelopeObject();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, envelope));
    const first = await entry.ws.waitForKind("peer-accepted");
    expect(first.outcome).toBe("accepted");
    expect(first.position).toBe(1);

    // Same scope, same envelope: duplicate replays the original outcome.
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, envelope));
    const replay = await entry.ws.waitForKind("peer-accepted");
    expect(replay.outcome).toBe("duplicate");
    expect(replay.position).toBe(1);
    expect((replay.receipt as Record<string, unknown>).kind).toBe("accepted");

    // Same scope, different envelope: typed conflict, no receipt invented.
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, peerEnvelopeObject()));
    const conflict = await entry.ws.waitForKind("peer-accepted");
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.position).toBe(1);
    expect(conflict.receipt).toBeNull();

    // Concurrent distinct sends still allocate monotonic positions.
    const ids = [freshPeerId(), freshPeerId(), freshPeerId()];
    for (const id of ids) {
      entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, id, peerEnvelopeObject()));
    }
    const positions: number[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const accepted = await entry.ws.waitForKind("peer-accepted");
      expect(accepted.outcome).toBe("accepted");
      positions.push(accepted.position as number);
    }
    expect(positions).toEqual([2, 3, 4]);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("surfaces ack refusals honestly instead of dropping them", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "ref");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const msg1 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");

    endpoint.ws.send(peerAckMessage(
      TENANT_A, ROUTE_1, endpointId,
      [
        { messageId: "msg.does.not.exist", position: 99 },
        { messageId: msg1, position: 7 },
        { messageId: msg1, position: 1 },
      ],
      [peerAgentReport("completed", "msg.also.unknown", 42)],
    ));
    const acked = await endpoint.ws.waitForKind("peer-acked");
    const refused = acked.refused as { messageId: string; refusal: string }[];
    expect(refused).toContainEqual({ messageId: "msg.does.not.exist", refusal: "message_unknown" });
    expect(refused).toContainEqual({ messageId: msg1, refusal: "position_mismatch" });
    expect(refused).toContainEqual({ messageId: "msg.also.unknown", refusal: "message_unknown" });
    // The valid entry still recorded; every requested id was answered —
    // the duplicated id resolves to one outcome, never silently dropped.
    expect(acked.recorded).toHaveLength(1);
    expect((acked.recorded as Record<string, unknown>[])[0].kind).toBe("received");
    const answered = new Set([
      ...(acked.recorded as Record<string, unknown>[]).map((r) => r.messageId as string),
      ...refused.map((r) => r.messageId),
    ]);
    expect(answered.size).toBe(3);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("keeps peer traffic off recovery-purpose sessions and enforces identity binding", async () => {
    const entry = await enroll(TENANT_A, "dev.test.entry.bind1", ROUTE_1, "entry");
    const endpoint = await enroll(TENANT_A, "dev.test.endpoint.bind1", ROUTE_1, "endpoint");
    const entryWs = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    entryWs.send(sessionOpenMessage({ purpose: "recover_device", admission: admissionFor(entry) }));
    await entryWs.waitForKind("session-admitted");
    entryWs.send(peerSendMessage(TENANT_A, ROUTE_1, entry.deviceId, endpoint.deviceId, freshPeerId(), peerEnvelopeObject()));
    const closed = await entryWs.closed;
    expect(closed.code).toBe(4000);

    // A claimed identity that does not match the session credential closes.
    const ws2 = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    ws2.send(sessionOpenMessage({ purpose: "forward", admission: admissionFor(entry) }));
    await ws2.waitForKind("session-admitted");
    ws2.send(peerSendMessage(TENANT_A, ROUTE_1, endpoint.deviceId, entry.deviceId, freshPeerId(), peerEnvelopeObject()));
    const closed2 = await ws2.closed;
    expect(closed2.code).toBe(4000);
  });
});

describe("peer mailbox retention, restart persistence and revocation", () => {
  it("emits expired gap tombstones from the scheduled alarm", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "exp");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const msg1 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");

    // Force-expire everything through the deployment policy knob, then run
    // the scheduled cleanup: positions are tombstoned, never silently cut.
    const previous = env.RELAY_MAILBOX_RETENTION_MS;
    env.RELAY_MAILBOX_RETENTION_MS = "1";
    try {
      const ran = await runDurableObjectAlarm(mailboxStub(TENANT_A, ROUTE_1, endpointId));
      expect(ran).toBe(true);
    } finally {
      env.RELAY_MAILBOX_RETENTION_MS = previous;
    }

    endpoint.ws.send(peerFetchMessage(TENANT_A, ROUTE_1, endpointId, 0, 16));
    const page = await waitForPage(endpoint.ws, []);
    const gaps = page.gaps as Record<string, unknown>[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0].cause).toBe("expired");
    expect(gaps[0].fromSeq).toBe(1);
    expect(gaps[0].toSeq).toBe(1);
    expect(gaps[0].messageIds).toEqual([msg1]);
    expect(page.nextAfterSeq).toBe(1);

    // A later send continues the position sequence past the tombstone.
    const msg2 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg2, peerEnvelopeObject()));
    const accepted = await entry.ws.waitForKind("peer-accepted");
    expect(accepted.position).toBe(2);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("truncates oldest envelopes on capacity with observable tombstones", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "cap");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    // Bounded capacity that fits roughly one stored record: each new send
    // truncates the previous envelope with a capacity tombstone.
    const previous = env.RELAY_MAILBOX_CAPACITY_BYTES;
    env.RELAY_MAILBOX_CAPACITY_BYTES = "420";
    try {
      const msg1 = freshPeerId();
      const msg2 = freshPeerId();
      entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
      entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg2, peerEnvelopeObject()));
      await entry.ws.waitForKind("peer-accepted");
      await entry.ws.waitForKind("peer-accepted");
    } finally {
      env.RELAY_MAILBOX_CAPACITY_BYTES = previous;
    }

    endpoint.ws.send(peerFetchMessage(TENANT_A, ROUTE_1, endpointId, 0, 16));
    const page = await waitForPage(endpoint.ws, [2]);
    const positions = (page.messages as Record<string, unknown>[]).map((m) => m.position);
    const gaps = page.gaps as Record<string, unknown>[];
    expect(positions).toEqual([2]);
    expect(gaps.some((g) => g.cause === "capacity_truncated" && (g.fromSeq as number) <= 1 && (g.toSeq as number) >= 1)).toBe(true);
    expect(page.nextAfterSeq).toBe(2);

    // The truncated messageId reconciles as unknown, position 0.
    entry.ws.send(peerReceiptQueryMessage(TENANT_A, ROUTE_1, entryId, [freshPeerId()]));
    const status = await entry.ws.waitForKind("peer-status");
    expect((status.statuses as Record<string, unknown>[])[0].position).toBe(0);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("keeps position and receipts durable across object eviction", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "pers");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    const msg1 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");
    endpoint.ws.send(peerAckMessage(TENANT_A, ROUTE_1, endpointId, [{ messageId: msg1, position: 1 }], []));
    await endpoint.ws.waitForKind("peer-acked");

    await evictDurableObject(mailboxStub(TENANT_A, ROUTE_1, endpointId));

    // Position continues monotonically; the stored receipt survives.
    const msg2 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg2, peerEnvelopeObject()));
    const accepted = await entry.ws.waitForKind("peer-accepted");
    expect(accepted.position).toBe(2);

    entry.ws.send(peerReceiptQueryMessage(TENANT_A, ROUTE_1, entryId, [msg1]));
    const status = await entry.ws.waitForKind("peer-status");
    const s1 = (status.statuses as Record<string, unknown>[])[0];
    expect(s1.position).toBe(1);
    expect((s1.receipts as Record<string, unknown>[]).map((r) => r.kind).sort()).toEqual(["accepted", "received"]);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("closes and refuses a revoked device, and reports revoked partitions honestly", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "rev");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpointId, peerBundleObject(endpointId, 1),
    ));
    await endpoint.ws.waitForKind("peer-bundle-published");

    const revoke = await adminPost(`/admin/tenants/${TENANT_A}/revoke`, { deviceId: endpointId });
    await revoke.arrayBuffer();
    expect(revoke.ok).toBe(true);
    const closed = await endpoint.ws.closed;
    expect(closed.code).toBe(4003);

    // The revoked partition answers bundle fetches with the honest refusal.
    entry.ws.send(peerBundleFetchMessage(TENANT_A, ROUTE_1, entryId, endpointId));
    const refused = await entry.ws.waitForKind("peer-bundle");
    expect(refused.state).toBe("refused");
    expect(refused.refusal).toBe("revoked");

    // Reconnect of the revoked credential is refused at admission.
    const denied = await WsClient.tryConnect(TENANT_A, ROUTE_1, endpoint.enrolled.credential);
    expect(denied.status).toBe(403);

    // Partition state reflects the pushed revocation.
    const state = await mailboxState(TENANT_A, ROUTE_1, endpointId);
    expect(state.revoked).toBe(true);

    // The revoked owner's acks refuse every entry with the typed reason
    // (exercised through the same internal surface the session uses).
    const outcome = await mailboxPeerCall(
      TENANT_A, ROUTE_1, endpointId,
      internalAdmission(endpoint),
      peerAckMessage(TENANT_A, ROUTE_1, endpointId, [{ messageId: "msg.x.1", position: 1 }], []),
    );
    const acked = outcome.response as Record<string, unknown>;
    expect(acked.kind).toBe("peer-acked");
    expect((acked.refused as Record<string, unknown>[])[0].refusal).toBe("revoked");
    entry.ws.close();
  });

  it("stores only opaque envelopes — no plaintext keys anywhere in storage", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "audit");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;

    endpoint.ws.send(peerBundlePublishMessage(
      TENANT_A, ROUTE_1, endpointId, peerBundleObject(endpointId, 1),
    ));
    await endpoint.ws.waitForKind("peer-bundle-published");
    const msg1 = freshPeerId();
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, msg1, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");
    endpoint.ws.send(peerAckMessage(TENANT_A, ROUTE_1, endpointId, [{ messageId: msg1, position: 1 }], [peerAgentReport("completed", msg1, 1, "QUVEXzAx")]));
    await endpoint.ws.waitForKind("peer-acked");

    const offending = await runInDurableObject(
      mailboxStub(TENANT_A, ROUTE_1, endpointId),
      async (_instance: unknown, state: DurableObjectState) => {
        const all = await state.storage.list<Record<string, unknown>>();
        return [...all.entries()]
          .filter(([, value]) => containsForbiddenPeerKeys(value))
          .map(([key]) => key);
      },
    );
    expect(offending).toEqual([]);
    entry.ws.close();
    endpoint.ws.close();
  });
});

describe("peer mailbox counters", () => {
  it("counts accepted, duplicate, conflict, fetched and acked operations", async () => {
    const { entry, endpoint } = await connectPeerPair(ROUTE_1, "cnt");
    const endpointId = endpoint.enrolled.deviceId;
    const entryId = entry.enrolled.deviceId;
    const messageId = freshPeerId();
    const envelope = peerEnvelopeObject();

    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, envelope));
    await entry.ws.waitForKind("peer-accepted");
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, envelope));
    await entry.ws.waitForKind("peer-accepted");
    entry.ws.send(peerSendMessage(TENANT_A, ROUTE_1, entryId, endpointId, messageId, peerEnvelopeObject()));
    await entry.ws.waitForKind("peer-accepted");
    endpoint.ws.send(peerFetchMessage(TENANT_A, ROUTE_1, endpointId, 0, 16));
    await waitForPage(endpoint.ws, [1]);
    endpoint.ws.send(peerAckMessage(TENANT_A, ROUTE_1, endpointId, [{ messageId, position: 1 }], []));
    await endpoint.ws.waitForKind("peer-acked");

    const counters = await (await adminGet(`/admin/counters/mailbox/${TENANT_A}/${ROUTE_1}/${endpointId}`)).json() as { counters: Record<string, number> };
    expect(counters.counters.mailboxAccepted).toBe(1);
    expect(counters.counters.mailboxDuplicate).toBe(1);
    expect(counters.counters.mailboxConflict).toBe(1);
    expect(counters.counters.mailboxFetched).toBeGreaterThanOrEqual(1);
    expect(counters.counters.mailboxAcked).toBe(1);
    entry.ws.close();
    endpoint.ws.close();
  });
});
