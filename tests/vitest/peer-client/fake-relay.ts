import {
  createPeerAccepted,
  createPeerAcked,
  createPeerBundle,
  createPeerBundlePublished,
  createPeerMessages,
  createPeerRetentionPolicy,
  createPeerStatus,
  parsePrivateRelayPeerMessage,
  PRIVATE_RELAY_PEER_LIMITS
} from "@meshrix/contracts/private-relay";
import type {
  PeerEnvelope,
  PeerReceipt,
  PrekeyBundlePublication
} from "@meshrix/contracts/private-relay";
import type { PeerClientTransport } from "@meshrix/peer-client";

/**
 * In-memory fake of the private-relay session channel + per-recipient
 * mailbox partition. It answers all 13 peer wire kinds with the same
 * semantics as `MailboxDO`/`RelaySessionDO`:
 *
 * - durable monotonic positions per (route, device) partition
 * - sender-scoped idempotency: same id + same envelope → `duplicate` with
 *   the stored receipt replayed; same id + different bytes → `conflict`
 * - peer-fetch pages with `more`/`nextAfterSeq` and non-overlapping gap
 *   tombstones; push wakeup delivers a live page to attached recipients
 * - peer-ack recorded/refused coverage (message_unknown, position_mismatch,
 *   authority_stale, revoked); reports[] recorded verbatim as agent receipts
 * - peer-receipt → peer-status projection of the sender's idempotency
 *   binding and every recorded receipt
 * - bundle publish revision rules and pairing/revocation re-checks
 * - drops (no response) where the real mailbox drops: unpaired or revoked
 *   senders, revoked fetch owners, mismatched routing
 */

export const FAKE_TENANT = "tenant.test";
export const FAKE_ROUTE = "route.test";

interface StoredMessage {
  position: number;
  senderDeviceId: string;
  messageId: string;
  envelope: PeerEnvelope;
  receivedAtMs: number;
}

interface IdemRecord {
  position: number;
  envelopeKey: string;
}

interface GapRecord {
  fromSeq: number;
  toSeq: number;
  cause: "expired" | "capacity_truncated";
  messageIds: readonly string[] | null;
}

interface FakePartition {
  routeId: string;
  deviceId: string;
  position: number;
  cursor: number;
  messages: Map<number, StoredMessage>;
  idem: Map<string, IdemRecord>;
  byid: Map<string, { position: number; senderDeviceId: string }>;
  receipts: Map<string, PeerReceipt>;
  gaps: GapRecord[];
  bundle: PrekeyBundlePublication | null;
  revoked: boolean;
  maxAdmissionGeneration: number;
}

interface FakeRoute {
  tenantId: string;
  routeId: string;
  devices: Set<string>;
  /** Explicit device pairing — the directory authority view. */
  pairs: Map<string, string>;
}

interface FakeChannel {
  tenantId: string;
  routeId: string;
  deviceId: string;
  admissionGeneration: number;
  mailboxPushSeq: number;
  dropResponses: number;
  handler: ((message: Record<string, unknown>) => void) | null;
}

function receiptKey(position: number, kind: string): string {
  return `${position}:${kind}`;
}

export class FakePeerRelay {
  readonly policy = Object.freeze({
    mailboxCapacityBytes: 67_108_864,
    mailboxRetentionMs: 2_592_000_000,
    mailboxMaxItems: 10_000
  });

  readonly #routes = new Map<string, FakeRoute>();
  readonly #partitions = new Map<string, FakePartition>();
  readonly #channels = new Map<string, FakeChannel>();
  readonly #revoked = new Set<string>();

  pair(tenantId: string, routeId: string, deviceA: string, deviceB: string): void {
    const route = this.#route(tenantId, routeId);
    route.devices.add(deviceA);
    route.devices.add(deviceB);
    route.pairs.set(deviceA, deviceB);
    route.pairs.set(deviceB, deviceA);
  }

  unpair(routeId: string): void {
    this.#routes.get(routeId)?.pairs.clear();
  }

  /** Owner-side revocation: drops fetches, refuses acks/publishes, closes the channel. */
  revokeDevice(deviceId: string): void {
    this.#revoked.add(deviceId);
    this.#channels.delete(deviceId);
    for (const partition of this.#partitions.values()) {
      if (partition.deviceId === deviceId) partition.revoked = true;
    }
  }

  /** Attach a live session channel; mirrors relay-session mailboxPushSeq=0. */
  attach(input: { tenantId: string; routeId: string; deviceId: string; admissionGeneration?: number }): FakePeerTransport {
    const channel: FakeChannel = {
      tenantId: input.tenantId,
      routeId: input.routeId,
      deviceId: input.deviceId,
      admissionGeneration: input.admissionGeneration ?? 1,
      mailboxPushSeq: 0,
      dropResponses: 0,
      handler: null
    };
    this.#channels.set(input.deviceId, channel);
    this.#partition(input.routeId, input.deviceId);
    return new FakePeerTransport(this, channel);
  }

  detach(deviceId: string): void {
    this.#channels.delete(deviceId);
  }

  /** The next `count` request responses on this channel never arrive (stored work still happens). */
  dropNextResponses(deviceId: string, count: number): void {
    const channel = this.#channels.get(deviceId);
    if (channel) channel.dropResponses += count;
  }

  /** Deliver a replayed mailbox page to a device's live channel (lagging-channel redelivery). */
  async replayPage(deviceId: string, afterSeq: number): Promise<void> {
    const channel = this.#channels.get(deviceId);
    if (!channel) return;
    const partition = this.#partition(channel.routeId, deviceId);
    const page = this.#buildPage(partition, afterSeq, PRIVATE_RELAY_PEER_LIMITS.maxPageMessages);
    const handler = channel.handler;
    queueMicrotask(() => handler?.(page as Record<string, unknown>));
  }

  /** Test inspection: the raw partition behind a device. */
  partitionOf(routeId: string, deviceId: string): FakePartition {
    return this.#partition(routeId, deviceId);
  }

  /** Truncate stored positions, writing tombstones like the expiry/capacity paths do. */
  truncate(routeId: string, deviceId: string, positions: readonly number[], cause: "expired" | "capacity_truncated"): void {
    const partition = this.#partition(routeId, deviceId);
    const sorted = [...positions].sort((left, right) => left - right);
    let runStart = -1;
    let runEnd = -1;
    let runIds: string[] = [];
    const flush = (): void => {
      if (runStart < 0) return;
      this.#writeGap(partition, runStart, runEnd, cause, runIds.length <= PRIVATE_RELAY_PEER_LIMITS.maxGapMessageIds ? runIds : null);
      runStart = -1;
      runEnd = -1;
      runIds = [];
    };
    for (const position of sorted) {
      const record = partition.messages.get(position);
      if (!record) continue;
      partition.messages.delete(position);
      partition.idem.delete(`${record.senderDeviceId}:${record.messageId}`);
      partition.byid.delete(record.messageId);
      for (const key of [...partition.receipts.keys()]) {
        if (key.startsWith(`${position}:`)) partition.receipts.delete(key);
      }
      if (position === runEnd + 1) {
        runEnd = position;
        runIds.push(record.messageId);
      } else {
        flush();
        runStart = position;
        runEnd = position;
        runIds = [record.messageId];
      }
    }
    flush();
  }

  /** Test hook: corrupt the ciphertext of one stored position (tamper evidence). */
  tamperEnvelope(routeId: string, deviceId: string, position: number): void {
    const partition = this.#partition(routeId, deviceId);
    const record = partition.messages.get(position);
    if (!record) return;
    const ciphertext = record.envelope.ciphertext;
    const flipped = `${ciphertext.slice(0, -2)}${ciphertext.endsWith("A") ? "B" : "A"}x`;
    partition.messages.set(position, {
      ...record,
      envelope: Object.freeze({ ...record.envelope, ciphertext: flipped })
    });
  }

  async dispatch(channel: FakeChannel, raw: unknown): Promise<void> {
    const parsed = parsePrivateRelayPeerMessage(raw);
    if (!parsed) return;
    const kind = (parsed as { readonly kind: string }).kind;
    // The session layer binds routeId/deviceId (and tenantId) to admission.
    if ((parsed as { routeId?: string }).routeId !== channel.routeId
      || (parsed as { deviceId?: string }).deviceId !== channel.deviceId
      || (kind !== "peer-retention-policy" && (parsed as { tenantId?: string }).tenantId !== channel.tenantId)) {
      return;
    }
    if (kind === "peer-retention-policy") {
      this.#answer(channel, createPeerRetentionPolicy({
        routeId: channel.routeId,
        deviceId: channel.deviceId,
        ...this.policy
      }) as Record<string, unknown>);
      return;
    }
    // Owner ops track the newest admission generation before dispatch.
    const ownerOp = kind === "peer-fetch" || kind === "peer-ack" || kind === "peer-bundle-publish";
    if (ownerOp) {
      const partition = this.#partition(channel.routeId, channel.deviceId);
      partition.maxAdmissionGeneration = Math.max(partition.maxAdmissionGeneration, channel.admissionGeneration);
    }
    switch (kind) {
      case "peer-bundle-publish":
        this.#bundlePublish(channel, parsed as never);
        return;
      case "peer-bundle-fetch":
        this.#bundleFetch(channel, parsed as never);
        return;
      case "peer-send":
        this.#send(channel, parsed as never);
        return;
      case "peer-fetch":
        this.#fetch(channel, parsed as never);
        return;
      case "peer-ack":
        this.#ack(channel, parsed as never);
        return;
      case "peer-receipt":
        this.#receiptQuery(channel, parsed as never);
        return;
      default:
        return;
    }
  }

  #route(tenantId: string, routeId: string): FakeRoute {
    let route = this.#routes.get(routeId);
    if (!route) {
      route = { tenantId, routeId, devices: new Set(), pairs: new Map() };
      this.#routes.set(routeId, route);
    }
    return route;
  }

  #peerOf(routeId: string, deviceId: string): string | null {
    return this.#routes.get(routeId)?.pairs.get(deviceId) ?? null;
  }

  #partition(routeId: string, deviceId: string): FakePartition {
    const key = `${routeId}/${deviceId}`;
    let partition = this.#partitions.get(key);
    if (!partition) {
      partition = {
        routeId,
        deviceId,
        position: 0,
        cursor: 0,
        messages: new Map(),
        idem: new Map(),
        byid: new Map(),
        receipts: new Map(),
        gaps: [],
        bundle: null,
        revoked: this.#revoked.has(deviceId),
        maxAdmissionGeneration: 0
      };
      this.#partitions.set(key, partition);
    }
    return partition;
  }

  #answer(channel: FakeChannel, response: Record<string, unknown>): void {
    if (channel.dropResponses > 0) {
      channel.dropResponses -= 1;
      return;
    }
    const handler = channel.handler;
    queueMicrotask(() => handler?.(response));
  }

  /** Push wakeup: a committed send pages the recipient's live channel. */
  #wakeup(channel: FakeChannel, routeId: string, recipientDeviceId: string): void {
    const target = this.#channels.get(recipientDeviceId);
    if (!target || target === channel) return;
    const partition = this.#partition(routeId, recipientDeviceId);
    const page = this.#buildPage(partition, target.mailboxPushSeq, PRIVATE_RELAY_PEER_LIMITS.maxPageMessages);
    const delivered = (page.messages as unknown[]).length > 0 || (page.gaps as unknown[]).length > 0;
    if (!delivered) return;
    target.mailboxPushSeq = Math.max(target.mailboxPushSeq, page.nextAfterSeq as number);
    const handler = target.handler;
    queueMicrotask(() => handler?.(page as Record<string, unknown>));
  }

  #send(channel: FakeChannel, send: {
    tenantId: string; routeId: string; deviceId: string; peerDeviceId: string; messageId: string; envelope: PeerEnvelope;
  }): void {
    const route = this.#routes.get(send.routeId);
    if (!route || !route.devices.has(send.peerDeviceId)) return;
    const partition = this.#partition(send.routeId, send.peerDeviceId);
    // Sender must be the recipient's paired peer and not revoked.
    if (this.#peerOf(send.routeId, send.peerDeviceId) !== send.deviceId || this.#revoked.has(send.deviceId)) {
      return;
    }
    const idemKey = `${send.deviceId}:${send.messageId}`;
    const envelopeKey = JSON.stringify(send.envelope);
    const idem = partition.idem.get(idemKey);
    if (idem) {
      if (idem.envelopeKey !== envelopeKey) {
        this.#answer(channel, createPeerAccepted({
          routeId: send.routeId, deviceId: send.deviceId, peerDeviceId: send.peerDeviceId,
          messageId: send.messageId, outcome: "conflict", position: idem.position, receipt: null
        }) as Record<string, unknown>);
        return;
      }
      const receipt = partition.receipts.get(receiptKey(idem.position, "accepted"));
      if (!receipt) return;
      this.#answer(channel, createPeerAccepted({
        routeId: send.routeId, deviceId: send.deviceId, peerDeviceId: send.peerDeviceId,
        messageId: send.messageId, outcome: "duplicate", position: idem.position, receipt
      }) as Record<string, unknown>);
      return;
    }
    const position = partition.position + 1;
    partition.position = position;
    partition.messages.set(position, {
      position,
      senderDeviceId: send.deviceId,
      messageId: send.messageId,
      envelope: send.envelope,
      receivedAtMs: Date.now()
    });
    partition.idem.set(idemKey, { position, envelopeKey });
    partition.byid.set(send.messageId, { position, senderDeviceId: send.deviceId });
    const receipt: PeerReceipt = Object.freeze({
      kind: "accepted", source: "mailbox", messageId: send.messageId, position, detail: null
    });
    partition.receipts.set(receiptKey(position, "accepted"), receipt);
    this.#answer(channel, createPeerAccepted({
      routeId: send.routeId, deviceId: send.deviceId, peerDeviceId: send.peerDeviceId,
      messageId: send.messageId, outcome: "accepted", position, receipt
    }) as Record<string, unknown>);
    this.#wakeup(channel, send.routeId, send.peerDeviceId);
  }

  #buildPage(partition: FakePartition, afterSeq: number, limit: number) {
    const rows = [...partition.messages.values()]
      .filter((record) => record.position > afterSeq)
      .sort((left, right) => left.position - right.position);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const coverageEnd = more && page.length > 0 ? page[page.length - 1].position : Math.max(partition.position, afterSeq);
    const gaps = partition.gaps
      .filter((gap) => gap.toSeq > afterSeq && gap.fromSeq <= coverageEnd)
      .map((gap) => ({ fromSeq: gap.fromSeq, toSeq: gap.toSeq, cause: gap.cause, messageIds: gap.messageIds === null ? null : [...gap.messageIds] }));
    const nextAfterSeq = more && page.length > 0 ? page[page.length - 1].position : Math.max(partition.position, afterSeq);
    return createPeerMessages({
      routeId: partition.routeId,
      deviceId: partition.deviceId,
      messages: page.map((record) => ({
        position: record.position,
        senderDeviceId: record.senderDeviceId,
        messageId: record.messageId,
        envelope: record.envelope
      })),
      nextAfterSeq,
      more,
      gaps
    });
  }

  #fetch(channel: FakeChannel, fetch: { afterSeq: number; limit: number }): void {
    const partition = this.#partition(channel.routeId, channel.deviceId);
    if (partition.revoked) return; // revoked owner: the wire has no fetch refusal — drop.
    this.#answer(channel, this.#buildPage(partition, fetch.afterSeq, fetch.limit) as Record<string, unknown>);
  }

  #ack(channel: FakeChannel, ack: {
    received: readonly { messageId: string; position: number }[];
    reports: readonly PeerReceipt[];
  }): void {
    const partition = this.#partition(channel.routeId, channel.deviceId);
    const refuseAll = (refusal: string): void => {
      const seen = new Set<string>();
      const refused = [...ack.received.map((entry) => entry.messageId), ...ack.reports.map((entry) => entry.messageId)]
        .filter((messageId) => (seen.has(messageId) ? false : (seen.add(messageId), true)))
        .map((messageId) => ({ messageId, refusal }));
      this.#answer(channel, createPeerAcked({
        routeId: partition.routeId, deviceId: partition.deviceId, recorded: [], refused
      }) as Record<string, unknown>);
    };
    if (partition.revoked) return refuseAll("revoked");
    if (channel.admissionGeneration < partition.maxAdmissionGeneration) return refuseAll("authority_stale");
    const recorded: PeerReceipt[] = [];
    const refused: { messageId: string; refusal: string }[] = [];
    const resolve = (messageId: string, position: number): { position: number } | "message_unknown" | "position_mismatch" => {
      const byid = partition.byid.get(messageId);
      if (byid) return byid.position === position ? byid : "position_mismatch";
      const stored = partition.messages.get(position);
      if (stored && stored.messageId === messageId) return { position };
      return "message_unknown";
    };
    for (const entry of ack.received) {
      const resolved = resolve(entry.messageId, entry.position);
      if (resolved === "message_unknown" || resolved === "position_mismatch") {
        refused.push({ messageId: entry.messageId, refusal: resolved });
        continue;
      }
      const receipt: PeerReceipt = Object.freeze({
        kind: "received", source: "recipient", messageId: entry.messageId, position: resolved.position, detail: null
      });
      partition.receipts.set(receiptKey(resolved.position, "received"), receipt);
      partition.cursor = Math.max(partition.cursor, resolved.position);
      recorded.push(receipt);
    }
    for (const report of ack.reports) {
      const resolved = resolve(report.messageId, report.position);
      if (resolved === "message_unknown" || resolved === "position_mismatch") {
        refused.push({ messageId: report.messageId, refusal: resolved });
        continue;
      }
      const receipt: PeerReceipt = Object.freeze({
        kind: report.kind, source: "agent", messageId: report.messageId, position: resolved.position, detail: report.detail
      });
      partition.receipts.set(receiptKey(resolved.position, report.kind), receipt);
      recorded.push(receipt);
    }
    this.#answer(channel, createPeerAcked({
      routeId: partition.routeId, deviceId: partition.deviceId, recorded, refused
    }) as Record<string, unknown>);
  }

  #receiptQuery(channel: FakeChannel, query: { messageIds: readonly string[] }): void {
    const route = this.#routes.get(channel.routeId);
    const peerDeviceId = route ? this.#peerOf(channel.routeId, channel.deviceId) : null;
    const statuses = query.messageIds.slice(0, PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries).map((messageId) => {
      if (!peerDeviceId || this.#revoked.has(channel.deviceId)) {
        return { messageId, position: 0, receipts: [] };
      }
      const partition = this.#partition(channel.routeId, peerDeviceId);
      const idem = partition.idem.get(`${channel.deviceId}:${messageId}`);
      if (!idem) return { messageId, position: 0, receipts: [] };
      const receipts = [...partition.receipts.entries()]
        .filter(([key]) => key.startsWith(`${idem.position}:`))
        .map(([, receipt]) => receipt)
        .slice(0, PRIVATE_RELAY_PEER_LIMITS.maxReceiptsPerStatus);
      return { messageId, position: idem.position, receipts };
    });
    this.#answer(channel, createPeerStatus({
      routeId: channel.routeId, deviceId: channel.deviceId, statuses
    }) as Record<string, unknown>);
  }

  #bundlePublish(channel: FakeChannel, publish: { bundle: PrekeyBundlePublication }): void {
    const partition = this.#partition(channel.routeId, channel.deviceId);
    const stored = partition.bundle;
    const currentRevision = stored?.revision ?? 0;
    const respond = (outcome: string, revision: number, refusal: string | null): void => {
      this.#answer(channel, createPeerBundlePublished({
        routeId: partition.routeId, deviceId: partition.deviceId,
        bundleId: publish.bundle.bundleId, outcome, currentRevision: revision, refusal
      }) as Record<string, unknown>);
    };
    if (partition.revoked) return respond("refused", currentRevision, "revoked");
    if (publish.bundle.revision < currentRevision) return respond("refused", currentRevision, "stale_revision");
    if (publish.bundle.revision === currentRevision) {
      return JSON.stringify(stored) === JSON.stringify(publish.bundle)
        ? respond("published", currentRevision, null)
        : respond("refused", currentRevision, "stale_revision");
    }
    partition.bundle = publish.bundle;
    return respond(stored ? "superseded" : "published", publish.bundle.revision, null);
  }

  #bundleFetch(channel: FakeChannel, fetch: { peerDeviceId: string }): void {
    const partition = this.#partition(channel.routeId, fetch.peerDeviceId);
    const respond = (state: string, bundle: PrekeyBundlePublication | null, refusal: string | null): void => {
      this.#answer(channel, createPeerBundle({
        routeId: partition.routeId, deviceId: fetch.peerDeviceId, state, bundle, refusal
      }) as Record<string, unknown>);
    };
    const route = this.#routes.get(channel.routeId);
    if (!route || !route.devices.has(fetch.peerDeviceId)
      || this.#peerOf(channel.routeId, fetch.peerDeviceId) !== channel.deviceId
      || this.#revoked.has(channel.deviceId)) {
      return respond("refused", null, "peer_unpaired");
    }
    if (this.#revoked.has(fetch.peerDeviceId) || partition.revoked) {
      return respond("refused", null, "revoked");
    }
    return partition.bundle
      ? respond("available", partition.bundle, null)
      : respond("unpublished", null, null);
  }

  #writeGap(partition: FakePartition, fromSeq: number, toSeq: number, cause: "expired" | "capacity_truncated", messageIds: readonly string[] | null): void {
    const last = partition.gaps[partition.gaps.length - 1];
    if (last && last.cause === cause && last.toSeq === fromSeq - 1) {
      const merged = last.messageIds === null || messageIds === null
        || last.messageIds.length + messageIds.length > PRIVATE_RELAY_PEER_LIMITS.maxGapMessageIds
        ? null
        : [...last.messageIds, ...messageIds];
      last.toSeq = toSeq;
      last.messageIds = merged;
      return;
    }
    partition.gaps.push({ fromSeq, toSeq, cause, messageIds });
  }
}

export class FakePeerTransport implements PeerClientTransport {
  readonly #relay: FakePeerRelay;
  readonly channel: FakeChannel;

  constructor(relay: FakePeerRelay, channel: FakeChannel) {
    this.#relay = relay;
    this.channel = channel;
  }

  async send(message: Record<string, unknown>): Promise<void> {
    await this.#relay.dispatch(this.channel, message);
  }

  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.channel.handler = handler;
  }
}
