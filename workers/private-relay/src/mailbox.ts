/**
 * MailboxDO — the per-recipient durable peer mailbox partition.
 *
 * One Durable Object instance per (tenantId, routeId, deviceId) enrolled
 * recipient slot. It stores opaque Signal-family ciphertext envelopes,
 * monotonically increasing positions, sender-scoped idempotency bindings and
 * typed receipts. All admission flows through the authenticated session
 * channel: RelaySessionDO forwards a peer wire message together with the
 * credential-bound session identity (deviceId/routeId/tenantId +
 * revocationRevision + admissionGeneration), and this object re-validates
 * the binding and route pairing against the tenant directory authority —
 * it never self-authenticates a caller.
 *
 * Storage is transactional KV over SQLite (new_sqlite_classes migration):
 * - `meta`                        partition meta (position/cursor/bytes/flags)
 * - `msg:<position12>`            stored envelope record
 * - `idem:<sender>:<messageId>`   sender-scoped idempotency binding
 * - `byid:<messageId>`            recipient-side message lookup index
 * - `rcpt:<position12>:<kind>`    one receipt record per receipt kind
 * - `gap:<fromSeq12>`             truncation tombstones (never silent)
 * - `bundle`                      the owner's published prekey bundle
 *
 * Position-ordered keys make cursor reads indexed range scans; mutations
 * commit inside storage transactions; a single alarm expires the oldest
 * envelope only while data exists. Stored objects carry opaque envelopes,
 * ids, digests and counters only — never plaintext or semantic material.
 */

import { DurableObject } from "cloudflare:workers";

import type { PrivateRelayEnv } from "./env.ts";
import { mailboxPolicyFromEnv } from "./env.ts";
import type { MailboxRetentionPolicyValues } from "./env.ts";
import { jsonResponse, readBoundedJson } from "./http.ts";
import { directoryObjectName, sha256Hex } from "./ids.ts";
import { RelayCounters } from "./metrics.ts";
import {
  PRIVATE_RELAY_PEER_LIMITS,
  containsForbiddenPeerKeys,
  createPeerAccepted,
  createPeerAcked,
  createPeerBundle,
  createPeerBundlePublished,
  createPeerMessages,
  createPeerStatus,
  parsePeerAck,
  parsePeerBundleFetch,
  parsePeerBundlePublish,
  parsePeerFetch,
  parsePeerReceiptQuery,
  parsePeerSend,
} from "../../../packages/contracts/src/private-relay/index.ts";
import type {
  MailboxAck,
  MailboxFetch,
  MailboxSend,
  PeerEnvelope,
  PeerReceipt,
  PrekeyBundlePublication,
} from "../../../packages/contracts/src/private-relay/index.ts";

const META_KEY = "meta";
const MSG_PREFIX = "msg:";
const IDEM_PREFIX = "idem:";
const BYID_PREFIX = "byid:";
const RCPT_PREFIX = "rcpt:";
const GAP_PREFIX = "gap:";
const BUNDLE_KEY = "bundle";

/** Positions pad to 12 digits so KV key order equals numeric order. */
function posKey(position: number): string {
  return position.toString().padStart(12, "0");
}

/** Stored tombstone bound; overflow merges the oldest adjacent records. */
const MAX_GAP_RECORDS = 256;
/** Page size for eviction/expiry scans (bottom-up, early-exit). */
const SCAN_PAGE = 64;
/** Upper bound on expirations handled per alarm run before re-arming. */
const EXPIRE_BATCH_MAX = 512;

export interface MailboxAdmission {
  tenantId: string;
  routeId: string;
  /** Authenticated caller identity, bound to the session credential. */
  deviceId: string;
  role: "entry" | "endpoint";
  revocationRevision: number;
  admissionGeneration: number;
  sessionId: string;
}

interface MailboxMeta {
  tenantId: string;
  routeId: string;
  /** Partition owner — derived from the object name at creation. */
  deviceId: string;
  /** Last assigned durable position (monotonic, never rewinds). */
  position: number;
  /** Highest position the recipient recorded as `received`. */
  cursor: number;
  bytesUsed: number;
  itemCount: number;
  /** Owner-side revocation flag pushed by the router. */
  revoked: boolean;
  revokedAt: string | null;
  revocationRevision: number;
  /** Newest admission generation observed from the owner's sessions. */
  maxAdmissionGeneration: number;
  createdAt: string;
}

interface StoredMessage {
  position: number;
  senderDeviceId: string;
  messageId: string;
  envelope: PeerEnvelope;
  receivedAtMs: number;
  sizeBytes: number;
}

interface IdemRecord {
  position: number;
  envelopeHash: string;
}

interface ByidRecord {
  position: number;
  senderDeviceId: string;
}

interface GapRecord {
  fromSeq: number;
  toSeq: number;
  cause: "expired" | "capacity_truncated";
  messageIds: readonly string[] | null;
}

interface RoutePeerResult {
  ok: boolean;
  reason?: string;
  peerDeviceId: string | null;
  peerRevoked?: boolean;
  deviceRevoked?: boolean;
}

type PeerOutcome =
  | { kind: "respond"; response: Record<string, unknown> }
  | { kind: "drop" };

export class MailboxDO extends DurableObject<PrivateRelayEnv> {
  private meta: MailboxMeta | null = null;
  private counters = new RelayCounters();

  constructor(ctx: DurableObjectState, env: PrivateRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.counters.count("storageReads", 2);
      const [meta, counters] = await Promise.all([
        ctx.storage.get<MailboxMeta>(META_KEY),
        ctx.storage.get("counters"),
      ]);
      if (meta) this.meta = meta;
      if (counters) this.counters = new RelayCounters(counters as Record<string, number>);
    });
  }

  private partitionFromName(): { tenantId: string; routeId: string; deviceId: string } {
    const name = this.ctx.id.name ?? "";
    const match = name.match(/^mailbox:([^/]+)\/([^/]+)\/([^/]+)$/u);
    return {
      tenantId: match?.[1] ?? "tenant.unknown",
      routeId: match?.[2] ?? "route.unknown",
      deviceId: match?.[3] ?? "dev.unknown",
    };
  }

  private freshMeta(): MailboxMeta {
    const partition = this.partitionFromName();
    return {
      tenantId: partition.tenantId,
      routeId: partition.routeId,
      deviceId: partition.deviceId,
      position: 0,
      cursor: 0,
      bytesUsed: 0,
      itemCount: 0,
      revoked: false,
      revokedAt: null,
      revocationRevision: 0,
      maxAdmissionGeneration: 0,
      createdAt: new Date().toISOString(),
    };
  }

  private async requireMeta(): Promise<MailboxMeta> {
    if (!this.meta) {
      this.meta = this.freshMeta();
      this.counters.count("storageWrites");
      await this.ctx.storage.put(META_KEY, this.meta);
    }
    return this.meta;
  }

  private policy(): MailboxRetentionPolicyValues {
    return mailboxPolicyFromEnv(this.env);
  }

  private async flushCounters(): Promise<void> {
    this.counters.count("storageWrites");
    await this.counters.flush((key, value) => this.ctx.storage.put(key, value));
  }

  // ------------------------------------------------------------------
  // HTTP surface (session reach-in, router revocation push, counters)
  // ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    this.counters.count("httpRequests");
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/internal/peer") {
        return await this.handlePeerRequest(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/apply-revocation") {
        return await this.handleApplyRevocation(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/counters") {
        return jsonResponse({ counters: this.counters.snapshot() });
      }
      if (request.method === "GET" && url.pathname === "/internal/state") {
        const meta = await this.requireMeta();
        this.counters.count("storageReads");
        const bundle = await this.ctx.storage.get<PrekeyBundlePublication>(BUNDLE_KEY);
        return jsonResponse({
          tenantId: meta.tenantId,
          routeId: meta.routeId,
          deviceId: meta.deviceId,
          position: meta.position,
          cursor: meta.cursor,
          itemCount: meta.itemCount,
          bytesUsed: meta.bytesUsed,
          revoked: meta.revoked,
          revocationRevision: meta.revocationRevision,
          bundleRevision: bundle?.revision ?? 0,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    } finally {
      await this.flushCounters();
    }
  }

  /**
   * Revocation push from the router: marks the partition owner revoked or
   * records the tenant revision. The wire carries no refused outcome for
   * `peer-send`/`peer-fetch`, so owner-side ops answer honestly wherever the
   * contract gives a refusal carrier (bundles, acks) and drop otherwise.
   */
  private async handleApplyRevocation(request: Request): Promise<Response> {
    const body = await readBoundedJson(request, 8_192) as Record<string, unknown> | null;
    if (!body || typeof body.revocationRevision !== "number") {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const meta = await this.requireMeta();
    const targetDevice = typeof body.deviceId === "string" ? body.deviceId : null;
    const routeRevoked = body.routeRevoked === true;
    meta.revocationRevision = Math.max(meta.revocationRevision, body.revocationRevision);
    if ((routeRevoked || targetDevice === meta.deviceId) && !meta.revoked) {
      meta.revoked = true;
      meta.revokedAt = new Date().toISOString();
    }
    this.counters.count("storageWrites");
    await this.ctx.storage.put(META_KEY, meta);
    return jsonResponse({ revoked: meta.revoked, revocationRevision: meta.revocationRevision });
  }

  // ------------------------------------------------------------------
  // /internal/peer — request/response dispatch for the session channel
  // ------------------------------------------------------------------

  private async handlePeerRequest(request: Request): Promise<Response> {
    const body = await readBoundedJson(request, 8 * 1024 * 1024) as {
      admission?: MailboxAdmission;
      message?: Record<string, unknown>;
    } | null;
    const admission = body?.admission;
    const message = body?.message;
    if (!admission || !message || typeof message.kind !== "string") {
      return jsonResponse({ ok: false, error: "invalid_body" }, 400);
    }
    const partition = this.partitionFromName();
    // The stamped session identity must bind this partition's tenant/route,
    // and the wire message must claim the same caller the credential proved.
    // Checked before any durable write so forged or misrouted requests can
    // never conjure a phantom partition.
    if (admission.tenantId !== partition.tenantId
      || admission.routeId !== partition.routeId
      || (message as { tenantId?: string }).tenantId !== admission.tenantId
      || (message as { routeId?: string }).routeId !== admission.routeId
      || (message as { deviceId?: string }).deviceId !== admission.deviceId) {
      this.counters.count("mailboxRefusals");
      return jsonResponse({ ok: true, drop: true });
    }
    // Owner-directed ops (fetch/ack/publish) materialize the caller's own
    // partition — legitimate by admission. Cross-device ops (send, bundle
    // fetch, receipt query) defer creation until pairing is proven so an
    // unpaired or forged target never conjures a phantom partition.
    const ownerOp = admission.deviceId === partition.deviceId;
    let meta: MailboxMeta | null = null;
    if (ownerOp) {
      meta = await this.requireMeta();
      // Owner sessions re-admitting with a newer generation record the
      // latest authority; an older generation's acks are honestly stale.
      if (admission.admissionGeneration > meta.maxAdmissionGeneration) {
        meta.maxAdmissionGeneration = admission.admissionGeneration;
        this.counters.count("storageWrites");
        await this.ctx.storage.put(META_KEY, meta);
      }
    }

    let outcome: PeerOutcome;
    switch (message.kind) {
      case "peer-send": {
        const parsed = parsePeerSend(message);
        outcome = parsed ? await this.handleSend(admission, parsed) : { kind: "drop" };
        break;
      }
      case "peer-fetch": {
        const parsed = parsePeerFetch(message);
        outcome = parsed && meta ? await this.handleFetch(admission, parsed, meta) : { kind: "drop" };
        break;
      }
      case "peer-ack": {
        const parsed = parsePeerAck(message);
        outcome = parsed && meta ? await this.handleAck(admission, parsed, meta) : { kind: "drop" };
        break;
      }
      case "peer-receipt": {
        const parsed = parsePeerReceiptQuery(message);
        outcome = parsed ? await this.handleReceiptQuery(admission, parsed, partition) : { kind: "drop" };
        break;
      }
      case "peer-bundle-publish": {
        const parsed = parsePeerBundlePublish(message);
        outcome = parsed && meta ? await this.handleBundlePublish(admission, parsed, meta) : { kind: "drop" };
        break;
      }
      case "peer-bundle-fetch": {
        const parsed = parsePeerBundleFetch(message);
        outcome = parsed ? await this.handleBundleFetch(admission, parsed, partition) : { kind: "drop" };
        break;
      }
      default:
        outcome = { kind: "drop" };
        break;
    }
    if (outcome.kind === "drop") {
      return jsonResponse({ ok: true, drop: true });
    }
    return jsonResponse({ ok: true, response: outcome.response });
  }

  /**
   * Directory reach-in: resolves the partition owner's paired peer on this
   * route and whether either side is currently revoked. Cached nowhere —
   * pairing/revocation is re-read per op so a revocation push that has not
   * reached this object yet is still honoured at the authority.
   */
  private async routePeer(): Promise<RoutePeerResult> {
    const partition = this.partitionFromName();
    this.counters.count("directoryChecks");
    const directory = this.env.RELAY_DIRECTORY.get(
      this.env.RELAY_DIRECTORY.idFromName(directoryObjectName(partition.tenantId)),
    );
    const response = await directory.fetch("http://directory/internal/route-peer", {
      method: "POST",
      body: JSON.stringify({ routeId: partition.routeId, deviceId: partition.deviceId }),
    });
    const result = await response.json() as RoutePeerResult;
    return { ...result, ok: result.ok === true };
  }

  // ------------------------------------------------------------------
  // peer-send → peer-accepted
  // ------------------------------------------------------------------

  private async handleSend(admission: MailboxAdmission, send: MailboxSend): Promise<PeerOutcome> {
    const partition = this.partitionFromName();
    if (partition.deviceId !== send.peerDeviceId) {
      // Session routed to the wrong partition — refuse honestly by drop.
      this.counters.count("mailboxRefusals");
      return { kind: "drop" };
    }
    // The sender must be the owner's currently paired route peer. An
    // unpaired or revoked sender gets no receipt — the sender reconciles
    // the unrecorded messageId through peer-status instead of a false ack.
    // Checked before meta creation so unpaired sends never conjure a
    // phantom partition.
    const peer = await this.routePeer();
    if (!peer.ok || peer.peerDeviceId !== send.deviceId || peer.peerRevoked === true) {
      this.counters.count("mailboxRefusals");
      return { kind: "drop" };
    }
    const policy = this.policy();
    const sizeBytes = this.messageSizeBytes(send);
    const envelopeHash = await sha256Hex(JSON.stringify(send.envelope));
    const idemKey = `${IDEM_PREFIX}${send.deviceId}:${send.messageId}`;
    const now = Date.now();

    let committedMeta: MailboxMeta | null = null;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const storedMeta = (await txn.get<MailboxMeta>(META_KEY)) ?? this.meta ?? this.freshMeta();
      committedMeta = storedMeta;
      const idem = await txn.get<IdemRecord>(idemKey);
      if (idem) {
        if (idem.envelopeHash === envelopeHash) {
          // Sender-scoped replay of the first write: replay the stored
          // accepted receipt verbatim — never a second position.
          const receipt = await txn.get<PeerReceipt>(`${RCPT_PREFIX}${posKey(idem.position)}accepted`);
          return { kind: "duplicate" as const, position: idem.position, receipt };
        }
        // Same scope, different envelope bytes: typed conflict, no receipt.
        return { kind: "conflict" as const, position: idem.position };
      }

      // Capacity truncation: evict the oldest live envelopes until the new
      // one fits; every evicted position gains an observable tombstone.
      const evicted: StoredMessage[] = [];
      let evictedBytes = 0;
      const overflowing = (): boolean =>
        storedMeta.itemCount - evicted.length + 1 > policy.mailboxMaxItems
        || storedMeta.bytesUsed - evictedBytes + sizeBytes > policy.mailboxCapacityBytes;
      if (overflowing()) {
        let startAfter: string | undefined;
        scan: while (overflowing()) {
          const page = await txn.list<StoredMessage>({ prefix: MSG_PREFIX, startAfter, limit: SCAN_PAGE });
          if (page.size === 0) break;
          let lastKey = "";
          for (const [key, record] of page) {
            lastKey = key;
            if (!overflowing()) break scan;
            evicted.push(record);
            evictedBytes += record.sizeBytes;
          }
          startAfter = lastKey;
          if (page.size < SCAN_PAGE) break;
        }
      }
      if (overflowing()) {
        // A single envelope exceeds the deployment capacity; the send is
        // never stored rather than dishonestly reported accepted.
        return { kind: "drop" as const };
      }
      if (evicted.length > 0) {
        await this.recordTruncation(txn, storedMeta, evicted, "capacity_truncated");
      }

      const position = storedMeta.position + 1;
      storedMeta.position = position;
      storedMeta.bytesUsed += sizeBytes;
      storedMeta.itemCount += 1;
      const record: StoredMessage = {
        position,
        senderDeviceId: send.deviceId,
        messageId: send.messageId,
        envelope: send.envelope,
        receivedAtMs: now,
        sizeBytes,
      };
      const receipt: PeerReceipt = {
        kind: "accepted",
        source: "mailbox",
        messageId: send.messageId,
        position,
        detail: null,
      };
      this.counters.count("storageWrites", 5);
      await txn.put(`${MSG_PREFIX}${posKey(position)}`, record);
      await txn.put(idemKey, { position, envelopeHash } satisfies IdemRecord);
      await txn.put(`${BYID_PREFIX}${send.messageId}`, { position, senderDeviceId: send.deviceId } satisfies ByidRecord);
      await txn.put(`${RCPT_PREFIX}${posKey(position)}accepted`, receipt);
      await txn.put(META_KEY, storedMeta);
      // One scheduled cleanup alarm while data exists: the oldest envelope
      // expires first since positions correlate with receivedAtMs.
      const oldest = await txn.list<StoredMessage>({ prefix: MSG_PREFIX, limit: 1 });
      const first = oldest.values().next().value as StoredMessage | undefined;
      if (first) {
        await txn.setAlarm(first.receivedAtMs + policy.mailboxRetentionMs);
      }
      return { kind: "accepted" as const, position, receipt };
    });
    if (committedMeta) this.meta = committedMeta;

    if (result.kind === "drop" || (result.kind === "duplicate" && !result.receipt)) {
      // A replay whose stored accepted receipt is gone cannot be honestly
      // reissued — the idempotency binding and the receipt share a fate.
      this.counters.count("mailboxRefusals");
      return { kind: "drop" };
    }
    this.counters.count(result.kind === "accepted" ? "mailboxAccepted" : result.kind === "duplicate" ? "mailboxDuplicate" : "mailboxConflict");
    const response = createPeerAccepted({
      routeId: send.routeId,
      deviceId: send.deviceId,
      peerDeviceId: send.peerDeviceId,
      messageId: send.messageId,
      outcome: result.kind,
      position: result.position,
      receipt: result.kind === "conflict" ? null : result.receipt ?? null,
    }) as Record<string, unknown>;
    return { kind: "respond", response };
  }

  // ------------------------------------------------------------------
  // peer-fetch → peer-messages
  // ------------------------------------------------------------------

  private async handleFetch(admission: MailboxAdmission, fetch: MailboxFetch, meta: MailboxMeta): Promise<PeerOutcome> {
    if (meta.revoked) {
      // A revoked owner is closed at the session layer and the wire has no
      // fetch refusal carrier — drop rather than answer dishonestly.
      this.counters.count("mailboxRefusals");
      return { kind: "drop" };
    }
    this.counters.count("mailboxFetched");
    const startKey = `${MSG_PREFIX}${posKey(fetch.afterSeq + 1)}`;
    this.counters.count("storageReads", 3);
    const listed = await this.ctx.storage.list<StoredMessage>({
      prefix: MSG_PREFIX,
      start: startKey,
      limit: fetch.limit + 1,
    });
    const rows = [...listed.values()].slice(0, fetch.limit);
    const more = listed.size > fetch.limit;
    const coverageEnd = more ? rows[rows.length - 1].position : meta.position;

    // Gaps: the single tombstone that may straddle afterSeq (records never
    // overlap, so at most one does), plus every tombstone inside the page's
    // covered range — the cursor never advances silently past lost data.
    const gaps: GapRecord[] = [];
    const straddle = await this.ctx.storage.list<GapRecord>({
      prefix: GAP_PREFIX,
      end: `${GAP_PREFIX}${posKey(fetch.afterSeq + 1)}`,
      reverse: true,
      limit: 1,
    });
    for (const gap of straddle.values()) {
      if (gap.toSeq > fetch.afterSeq) gaps.push(gap);
    }
    if (coverageEnd > fetch.afterSeq) {
      const ranged = await this.ctx.storage.list<GapRecord>({
        prefix: GAP_PREFIX,
        start: `${GAP_PREFIX}${posKey(fetch.afterSeq + 1)}`,
        end: `${GAP_PREFIX}${posKey(coverageEnd + 1)}`,
        limit: PRIVATE_RELAY_PEER_LIMITS.maxGaps,
      });
      for (const gap of ranged.values()) {
        if (gap.toSeq > fetch.afterSeq && gaps.length < PRIVATE_RELAY_PEER_LIMITS.maxGaps) gaps.push(gap);
      }
    }
    const nextAfterSeq = more
      ? rows[rows.length - 1].position
      : Math.max(meta.position, fetch.afterSeq);
    const messages = rows.map((record) => ({
      position: record.position,
      senderDeviceId: record.senderDeviceId,
      messageId: record.messageId,
      envelope: record.envelope,
    }));
    const response = createPeerMessages({
      routeId: meta.routeId,
      deviceId: meta.deviceId,
      messages,
      nextAfterSeq,
      more,
      gaps: gaps.map((gap) => ({
        fromSeq: gap.fromSeq,
        toSeq: gap.toSeq,
        cause: gap.cause,
        messageIds: gap.messageIds === null ? null : [...gap.messageIds],
      })),
    }) as Record<string, unknown>;
    return { kind: "respond", response };
  }

  // ------------------------------------------------------------------
  // peer-ack → peer-acked
  // ------------------------------------------------------------------

  private async handleAck(admission: MailboxAdmission, ack: MailboxAck, meta: MailboxMeta): Promise<PeerOutcome> {
    const refuseAll = (refusal: string): PeerOutcome => {
      this.counters.count("mailboxRefusals");
      const seen = new Set<string>();
      const refused = [...ack.received.map((entry) => entry.messageId), ...ack.reports.map((entry) => entry.messageId)]
        .filter((messageId) => (seen.has(messageId) ? false : (seen.add(messageId), true)))
        .map((messageId) => ({ messageId, refusal }));
      const response = createPeerAcked({
        routeId: meta.routeId, deviceId: meta.deviceId, recorded: [], refused,
      }) as Record<string, unknown>;
      return { kind: "respond", response };
    };
    if (meta.revoked) return refuseAll("revoked");
    if (admission.admissionGeneration < meta.maxAdmissionGeneration) {
      return refuseAll("authority_stale");
    }

    const recorded: PeerReceipt[] = [];
    const refused: { messageId: string; refusal: string }[] = [];
    let committedMeta: MailboxMeta | null = null;
    await this.ctx.storage.transaction(async (txn) => {
      const storedMeta = (await txn.get<MailboxMeta>(META_KEY)) ?? meta;
      committedMeta = storedMeta;
      const resolve = async (messageId: string, position: number): Promise<ByidRecord | "message_unknown" | "position_mismatch"> => {
        const byid = await txn.get<ByidRecord>(`${BYID_PREFIX}${messageId}`);
        if (byid) return byid.position === position ? byid : "position_mismatch";
        // Index miss: confirm against the stored position before refusing.
        const stored = await txn.get<StoredMessage>(`${MSG_PREFIX}${posKey(position)}`);
        if (stored && stored.messageId === messageId) {
          return { position, senderDeviceId: stored.senderDeviceId };
        }
        return "message_unknown";
      };
      let cursor = storedMeta.cursor;
      for (const entry of ack.received) {
        const resolved = await resolve(entry.messageId, entry.position);
        if (resolved === "message_unknown" || resolved === "position_mismatch") {
          refused.push({ messageId: entry.messageId, refusal: resolved });
          continue;
        }
        const receipt: PeerReceipt = {
          kind: "received",
          source: "recipient",
          messageId: entry.messageId,
          position: resolved.position,
          detail: null,
        };
        this.counters.count("storageWrites");
        await txn.put(`${RCPT_PREFIX}${posKey(resolved.position)}received`, receipt);
        recorded.push(receipt);
        cursor = Math.max(cursor, resolved.position);
      }
      for (const report of ack.reports) {
        const resolved = await resolve(report.messageId, report.position);
        if (resolved === "message_unknown" || resolved === "position_mismatch") {
          refused.push({ messageId: report.messageId, refusal: resolved });
          continue;
        }
        // Application reports are recorded verbatim with source:"agent" —
        // independent evidence, never derived from the acknowledgement.
        const receipt: PeerReceipt = {
          kind: report.kind,
          source: "agent",
          messageId: report.messageId,
          position: resolved.position,
          detail: report.detail,
        };
        this.counters.count("storageWrites");
        await txn.put(`${RCPT_PREFIX}${posKey(resolved.position)}${report.kind}`, receipt);
        recorded.push(receipt);
      }
      if (cursor !== storedMeta.cursor) {
        storedMeta.cursor = cursor;
        this.counters.count("storageWrites");
        await txn.put(META_KEY, storedMeta);
      }
    });
    if (committedMeta) this.meta = committedMeta;
    this.counters.count("mailboxAcked");
    const response = createPeerAcked({
      routeId: meta.routeId,
      deviceId: meta.deviceId,
      recorded,
      refused,
    }) as Record<string, unknown>;
    return { kind: "respond", response };
  }

  // ------------------------------------------------------------------
  // peer-receipt → peer-status
  // ------------------------------------------------------------------

  private async handleReceiptQuery(
    admission: MailboxAdmission,
    query: ReturnType<typeof parsePeerReceiptQuery> & object,
    partition: { tenantId: string; routeId: string; deviceId: string },
  ): Promise<PeerOutcome> {
    const statuses: { messageId: string; position: number; receipts: PeerReceipt[] }[] = [];
    const peer = await this.routePeer();
    const callerIsPeer = peer.ok === true && peer.peerDeviceId === admission.deviceId && peer.peerRevoked !== true;
    for (const messageId of query.messageIds.slice(0, PRIVATE_RELAY_PEER_LIMITS.maxReceiptQueries)) {
      if (!callerIsPeer) {
        // Unknown senders learn only "unknown" — no partition data leaks.
        statuses.push({ messageId, position: 0, receipts: [] });
        continue;
      }
      this.counters.count("storageReads", 2);
      const idem = await this.ctx.storage.get<IdemRecord>(`${IDEM_PREFIX}${admission.deviceId}:${messageId}`);
      if (!idem) {
        statuses.push({ messageId, position: 0, receipts: [] });
        continue;
      }
      const receiptRows = await this.ctx.storage.list<PeerReceipt>({
        prefix: `${RCPT_PREFIX}${posKey(idem.position)}`,
        limit: PRIVATE_RELAY_PEER_LIMITS.maxReceiptsPerStatus,
      });
      statuses.push({ messageId, position: idem.position, receipts: [...receiptRows.values()] });
    }
    const response = createPeerStatus({
      routeId: partition.routeId,
      deviceId: admission.deviceId,
      statuses,
    }) as Record<string, unknown>;
    return { kind: "respond", response };
  }

  // ------------------------------------------------------------------
  // peer-bundle-publish → peer-bundle-published
  // ------------------------------------------------------------------

  private async handleBundlePublish(
    admission: MailboxAdmission,
    publish: ReturnType<typeof parsePeerBundlePublish> & object,
    meta: MailboxMeta,
  ): Promise<PeerOutcome> {
    const respond = (outcome: string, currentRevision: number, refusal: string | null): PeerOutcome => {
      const response = createPeerBundlePublished({
        routeId: meta.routeId,
        deviceId: meta.deviceId,
        bundleId: publish.bundle.bundleId,
        outcome,
        currentRevision,
        refusal,
      }) as Record<string, unknown>;
      return { kind: "respond", response };
    };
    this.counters.count("storageReads");
    const stored = await this.ctx.storage.get<PrekeyBundlePublication>(BUNDLE_KEY);
    const currentRevision = stored?.revision ?? 0;
    if (meta.revoked) {
      this.counters.count("mailboxRefusals");
      return respond("refused", currentRevision, "revoked");
    }
    if (publish.bundle.revision < currentRevision) {
      this.counters.count("mailboxRefusals");
      return respond("refused", currentRevision, "stale_revision");
    }
    if (publish.bundle.revision === currentRevision) {
      // Same revision: an identical replay is idempotent; divergent content
      // at a consumed revision refuses honestly.
      if (JSON.stringify(stored) === JSON.stringify(publish.bundle)) {
        return respond("published", currentRevision, null);
      }
      this.counters.count("mailboxRefusals");
      return respond("refused", currentRevision, "stale_revision");
    }
    this.counters.count("storageWrites");
    await this.ctx.storage.put(BUNDLE_KEY, publish.bundle);
    this.counters.count("mailboxBundlesPublished");
    return respond(stored ? "superseded" : "published", publish.bundle.revision, null);
  }

  // ------------------------------------------------------------------
  // peer-bundle-fetch → peer-bundle
  // ------------------------------------------------------------------

  private async handleBundleFetch(
    admission: MailboxAdmission,
    fetch: ReturnType<typeof parsePeerBundleFetch> & object,
    partition: { tenantId: string; routeId: string; deviceId: string },
  ): Promise<PeerOutcome> {
    const respond = (state: string, bundle: PrekeyBundlePublication | null, refusal: string | null): PeerOutcome => {
      const response = createPeerBundle({
        routeId: partition.routeId,
        deviceId: partition.deviceId,
        state,
        bundle,
        refusal,
      }) as Record<string, unknown>;
      return { kind: "respond", response };
    };
    if (partition.deviceId !== fetch.peerDeviceId) {
      this.counters.count("mailboxRefusals");
      return { kind: "drop" };
    }
    // A device may fetch only the bundle of its paired route peer: pairing
    // and both sides' revocation are re-read at the directory authority on
    // every fetch, before any partition state is touched.
    const peer = await this.routePeer();
    if (!peer.ok || peer.peerDeviceId !== admission.deviceId || peer.peerRevoked === true) {
      this.counters.count("mailboxRefusals");
      return respond("refused", null, "peer_unpaired");
    }
    if (peer.deviceRevoked === true) {
      this.counters.count("mailboxRefusals");
      return respond("refused", null, "revoked");
    }
    this.counters.count("mailboxBundlesFetched");
    this.counters.count("storageReads");
    const stored = await this.ctx.storage.get<PrekeyBundlePublication>(BUNDLE_KEY);
    return stored
      ? respond("available", stored, null)
      : respond("unpublished", null, null);
  }

  // ------------------------------------------------------------------
  // Truncation, tombstones and the expiry alarm
  // ------------------------------------------------------------------

  /**
   * Delete stored message records and write observable tombstones inside the
   * caller's transaction. Runs are contiguous in live order so they merge
   * into a single adjoining same-cause tombstone.
   */
  private async recordTruncation(
    txn: DurableObjectTransaction,
    meta: MailboxMeta,
    records: StoredMessage[],
    cause: "expired" | "capacity_truncated",
  ): Promise<void> {
    const deleteKeys: string[] = [];
    let runStart = -1;
    let runEnd = -1;
    let runIds: string[] = [];
    const flushRun = async (): Promise<void> => {
      if (runStart < 0) return;
      const messageIds = runIds.length <= PRIVATE_RELAY_PEER_LIMITS.maxGapMessageIds ? runIds : null;
      await this.writeGap(txn, runStart, runEnd, cause, messageIds);
      runStart = -1;
      runEnd = -1;
      runIds = [];
    };
    for (const record of records) {
      deleteKeys.push(
        `${MSG_PREFIX}${posKey(record.position)}`,
        `${IDEM_PREFIX}${record.senderDeviceId}:${record.messageId}`,
        `${BYID_PREFIX}${record.messageId}`,
      );
      this.counters.count("storageReads");
      const receipts = await txn.list<PeerReceipt>({ prefix: `${RCPT_PREFIX}${posKey(record.position)}` });
      for (const key of receipts.keys()) deleteKeys.push(key);
      meta.bytesUsed -= record.sizeBytes;
      meta.itemCount -= 1;
      if (record.position === runEnd + 1) {
        runEnd = record.position;
        runIds.push(record.messageId);
      } else {
        await flushRun();
        runStart = record.position;
        runEnd = record.position;
        runIds = [record.messageId];
      }
    }
    await flushRun();
    this.counters.count("storageDeletes", deleteKeys.length);
    await txn.delete(deleteKeys);
  }

  /**
   * Append a tombstone for [fromSeq..toSeq], extending the newest record
   * when it is adjacent and same-cause so contiguous truncation stays one
   * tombstone. Storage stays bounded: past MAX_GAP_RECORDS the oldest
   * adjacent pair merges (the loss remains observable; the merged range
   * keeps the newer record's cause and drops enumerated ids).
   */
  private async writeGap(
    txn: DurableObjectTransaction,
    fromSeq: number,
    toSeq: number,
    cause: "expired" | "capacity_truncated",
    messageIds: readonly string[] | null,
  ): Promise<void> {
    const last = await txn.list<GapRecord>({ prefix: GAP_PREFIX, reverse: true, limit: 1 });
    const first = last.values().next().value as GapRecord | undefined;
    const lastKey = last.keys().next().value as string | undefined;
    this.counters.count("storageWrites");
    if (first && lastKey && first.cause === cause && first.toSeq === fromSeq - 1) {
      const merged = first.messageIds === null
        || messageIds === null
        || first.messageIds.length + messageIds.length > PRIVATE_RELAY_PEER_LIMITS.maxGapMessageIds
        ? null
        : [...first.messageIds, ...messageIds];
      await txn.put(lastKey, { fromSeq: first.fromSeq, toSeq, cause, messageIds: merged });
    } else {
      await txn.put(`${GAP_PREFIX}${posKey(fromSeq)}`, { fromSeq, toSeq, cause, messageIds });
    }
    const all = await txn.list<GapRecord>({ prefix: GAP_PREFIX });
    let overflow = all.size - MAX_GAP_RECORDS;
    if (overflow <= 0) return;
    const entries = [...all.entries()];
    for (let i = 0; i + 1 < entries.length && overflow > 0; i += 2) {
      const [, older] = entries[i];
      const [newerKey, newer] = entries[i + 1];
      this.counters.count("storageWrites");
      this.counters.count("storageDeletes");
      await txn.put(newerKey, { fromSeq: older.fromSeq, toSeq: newer.toSeq, cause: newer.cause, messageIds: null });
      await txn.delete(entries[i][0]);
      overflow -= 1;
    }
  }

  /**
   * Expire envelopes past retention, oldest first, writing `expired`
   * tombstones for every lost range. Bounded per run; re-arms immediately
   * when more expired rows may remain, and otherwise schedules itself only
   * while unexpired data exists.
   */
  async alarm(): Promise<void> {
    this.counters.count("alarmRuns");
    await this.flushCounters();
    const policy = this.policy();
    const now = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const meta = await txn.get<MailboxMeta>(META_KEY);
      if (!meta || meta.itemCount === 0) return;
      this.meta = meta;
      const expired: StoredMessage[] = [];
      let startAfter: string | undefined;
      let exhausted = false;
      let nextOldest: StoredMessage | undefined;
      scan: for (;;) {
        const page = await txn.list<StoredMessage>({ prefix: MSG_PREFIX, startAfter, limit: SCAN_PAGE });
        if (page.size === 0) { exhausted = true; break; }
        let lastKey = "";
        for (const [key, record] of page) {
          lastKey = key;
          if (record.receivedAtMs + policy.mailboxRetentionMs <= now) {
            if (expired.length >= EXPIRE_BATCH_MAX) break scan;
            expired.push(record);
          } else {
            nextOldest = record;
            break scan;
          }
        }
        startAfter = lastKey;
        if (page.size < SCAN_PAGE) { exhausted = true; break; }
      }
      if (expired.length > 0) {
        await this.recordTruncation(txn, meta, expired, "expired");
        this.counters.count("mailboxExpired", expired.length);
      }
      this.counters.count("storageWrites");
      await txn.put(META_KEY, meta);
      if (meta.itemCount > 0) {
        if (nextOldest) {
          await txn.setAlarm(nextOldest.receivedAtMs + policy.mailboxRetentionMs);
        } else if (!exhausted) {
          // Hit the per-run bound — continue draining without a gap.
          await txn.setAlarm(now + 1);
        } else {
          const oldest = await txn.list<StoredMessage>({ prefix: MSG_PREFIX, limit: 1 });
          const first = oldest.values().next().value as StoredMessage | undefined;
          if (first) await txn.setAlarm(first.receivedAtMs + policy.mailboxRetentionMs);
        }
      }
    });
  }

  private messageSizeBytes(send: MailboxSend): number {
    // The stored shape's serialized size — a conservative byte accounting
    // that never undercounts the envelope footprint.
    return JSON.stringify({
      senderDeviceId: send.deviceId,
      messageId: send.messageId,
      envelope: send.envelope,
    }).length;
  }

  /**
   * No-plaintext audit hook for tests: every stored value must satisfy the
   * contract's forbidden-key boundary.
   */
  __testStoredObjectsSafe(values: unknown[]): boolean {
    return values.every((value) => !containsForbiddenPeerKeys(value));
  }
}
