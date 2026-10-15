import {
  createPeerBundle,
  createPeerBundlePublished,
  createPeerForwarded,
  createPeerPresence,
  parsePeerBundleFetch,
  parsePeerBundlePublish,
  parsePeerDeliveryAck,
  parsePeerSend,
  parsePrivateRelayPeerMessage,
  type PeerPresence,
  type PeerDeliveryAck,
  type PeerSend,
  type PrekeyBundlePublication
} from "@meshrix/contracts/private-relay";
import type { PeerClientTransport } from "@meshrix/peer-client";

export const FAKE_TENANT = "tenant.test";
export const FAKE_ROUTE = "route.test";

interface FakeChannel {
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  handler: ((message: Record<string, unknown>) => void) | null;
}

interface FakeRoute {
  readonly tenantId: string;
  readonly routeId: string;
  readonly pairs: Map<string, string>;
}

type AckForwardRefusal =
  | { readonly count: number; readonly outcome: "refused"; readonly refusal: "authority_stale" | "rate_limited" }
  | { readonly count: number; readonly outcome: "backpressured"; readonly refusal: null };

function routeKey(tenantId: string, routeId: string): string {
  return JSON.stringify([tenantId, routeId]);
}

function channelKey(tenantId: string, routeId: string, deviceId: string): string {
  return JSON.stringify([tenantId, routeId, deviceId]);
}

/**
 * In-memory online-only relay double. It stores public prekey bundles but
 * never retains or pages business messages. Sends are delivered only to a
 * currently admitted counterpart; clients own every retry and durable copy.
 */
export class FakePeerRelay {
  readonly sendAttempts: PeerSend[] = [];
  readonly deliveryAckAttempts: PeerDeliveryAck[] = [];
  readonly #routes = new Map<string, FakeRoute>();
  readonly #channels = new Map<string, FakeChannel>();
  readonly #bundles = new Map<string, PrekeyBundlePublication>();
  readonly #dropAcks = new Map<string, number>();
  readonly #refuseAcks = new Map<string, AckForwardRefusal>();
  readonly #backpressureSends = new Map<string, number>();
  #nextSession = 1;

  pair(tenantId: string, routeId: string, deviceA: string, deviceB: string): void {
    const route = this.#route(tenantId, routeId);
    route.pairs.set(deviceA, deviceB);
    route.pairs.set(deviceB, deviceA);
    this.#publishPresence(route);
  }

  unpair(tenantId: string, routeId: string): void {
    const route = this.#routes.get(routeKey(tenantId, routeId));
    if (!route) return;
    route.pairs.clear();
  }

  attach(input: { tenantId: string; routeId: string; deviceId: string }): FakePeerTransport {
    const key = channelKey(input.tenantId, input.routeId, input.deviceId);
    const channel: FakeChannel = {
      ...input,
      sessionId: `session.${this.#nextSession++}`,
      handler: null
    };
    this.#channels.set(key, channel);
    const route = this.#routes.get(routeKey(input.tenantId, input.routeId));
    if (route) this.#publishPresence(route);
    return new FakePeerTransport(this, channel);
  }

  detach(deviceId: string, routeId = FAKE_ROUTE, tenantId = FAKE_TENANT): void {
    const key = channelKey(tenantId, routeId, deviceId);
    const channel = this.#channels.get(key);
    if (!channel) return;
    this.#channels.delete(key);
    const route = this.#routes.get(routeKey(tenantId, routeId));
    if (route) this.#publishPresence(route);
  }

  dropNextDeliveryAcks(senderDeviceId: string, count = 1): void {
    this.#dropAcks.set(senderDeviceId, (this.#dropAcks.get(senderDeviceId) ?? 0) + count);
  }

  holdDeliveryAcks(senderDeviceId: string): () => void {
    this.#dropAcks.set(senderDeviceId, Number.POSITIVE_INFINITY);
    return () => { this.#dropAcks.delete(senderDeviceId); };
  }

  refuseNextDeliveryAcks(
    senderDeviceId: string,
    count = 1,
    refusal: "authority_stale" | "rate_limited" = "authority_stale"
  ): void {
    this.#refuseAcks.set(senderDeviceId, { count, outcome: "refused", refusal });
  }

  backpressureNextDeliveryAcks(senderDeviceId: string, count = 1): void {
    this.#refuseAcks.set(senderDeviceId, { count, outcome: "backpressured", refusal: null });
  }

  backpressureNextPeerSends(recipientDeviceId: string, count = 1): void {
    this.#backpressureSends.set(recipientDeviceId, count);
  }

  inject(deviceId: string, value: Record<string, unknown>, routeId = FAKE_ROUTE, tenantId = FAKE_TENANT): void {
    const channel = this.#channels.get(channelKey(tenantId, routeId, deviceId));
    if (channel) this.#deliver(channel, value);
  }

  isCurrent(channel: FakeChannel): boolean {
    return this.#channels.get(channelKey(channel.tenantId, channel.routeId, channel.deviceId)) === channel;
  }

  async dispatch(channel: FakeChannel, raw: Record<string, unknown>): Promise<void> {
    if (!this.isCurrent(channel)) throw new Error("The fake relay session is no longer admitted.");
    const parsed = parsePrivateRelayPeerMessage(raw);
    if (!parsed) throw new Error("The fake relay received an invalid peer message.");
    const message = parsed as Record<string, unknown>;
    switch (message.kind) {
      case "peer-bundle-publish": {
        const publish = parsePeerBundlePublish(message);
        if (!publish || publish.tenantId !== channel.tenantId || publish.routeId !== channel.routeId
          || publish.deviceId !== channel.deviceId) return;
        const key = channelKey(channel.tenantId, channel.routeId, channel.deviceId);
        const prior = this.#bundles.get(key);
        const currentRevision = prior?.revision ?? 0;
        let outcome: "published" | "superseded" | "refused";
        let refusal: "stale_revision" | null = null;
        if (publish.bundle.revision < currentRevision) {
          outcome = "refused";
          refusal = "stale_revision";
        } else if (publish.bundle.revision === currentRevision && prior
          && JSON.stringify(prior) === JSON.stringify(publish.bundle)) {
          outcome = "published";
        } else if (publish.bundle.revision <= currentRevision) {
          outcome = "refused";
          refusal = "stale_revision";
        } else {
          this.#bundles.set(key, publish.bundle);
          outcome = prior ? "superseded" : "published";
        }
        this.#deliver(channel, createPeerBundlePublished({
          routeId: channel.routeId,
          deviceId: channel.deviceId,
          bundleId: publish.bundle.bundleId,
          outcome,
          currentRevision: outcome === "refused" ? currentRevision : publish.bundle.revision,
          refusal
        }) as Record<string, unknown>);
        return;
      }
      case "peer-bundle-fetch": {
        const fetch = parsePeerBundleFetch(message);
        if (!fetch || fetch.tenantId !== channel.tenantId || fetch.routeId !== channel.routeId
          || fetch.deviceId !== channel.deviceId) return;
        const route = this.#routes.get(routeKey(channel.tenantId, channel.routeId));
        const paired = route?.pairs.get(channel.deviceId) === fetch.peerDeviceId;
        const bundle = this.#bundles.get(channelKey(channel.tenantId, channel.routeId, fetch.peerDeviceId)) ?? null;
        const response = paired
          ? createPeerBundle({ routeId: channel.routeId, deviceId: fetch.peerDeviceId,
            state: bundle ? "available" : "unpublished", bundle, refusal: null })
          : createPeerBundle({ routeId: channel.routeId, deviceId: fetch.peerDeviceId,
            state: "refused", bundle: null, refusal: "peer_unpaired" });
        this.#deliver(channel, response as Record<string, unknown>);
        return;
      }
      case "peer-send": {
        const send = parsePeerSend(message);
        if (!send || send.tenantId !== channel.tenantId || send.routeId !== channel.routeId
          || send.senderDeviceId !== channel.deviceId) return;
        this.sendAttempts.push(send);
        const route = this.#routes.get(routeKey(channel.tenantId, channel.routeId));
        const paired = route?.pairs.get(channel.deviceId) === send.recipientDeviceId;
        const recipient = this.#channels.get(channelKey(channel.tenantId, channel.routeId, send.recipientDeviceId));
        if (!paired) {
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId, routeId: channel.routeId,
            requestKind: "peer-send",
            sourceDeviceId: channel.deviceId, targetDeviceId: send.recipientDeviceId,
            messageId: send.messageId, outcome: "refused", refusal: "peer_unpaired"
          }) as Record<string, unknown>);
          return;
        }
        if (!recipient) {
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId, routeId: channel.routeId,
            requestKind: "peer-send",
            sourceDeviceId: channel.deviceId, targetDeviceId: send.recipientDeviceId,
            messageId: send.messageId, outcome: "endpoint_unreachable", refusal: null
          }) as Record<string, unknown>);
          return;
        }
        const backpressured = this.#backpressureSends.get(send.recipientDeviceId) ?? 0;
        if (backpressured > 0) {
          if (backpressured === 1) this.#backpressureSends.delete(send.recipientDeviceId);
          else this.#backpressureSends.set(send.recipientDeviceId, backpressured - 1);
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId,
            routeId: channel.routeId,
            requestKind: "peer-send",
            sourceDeviceId: channel.deviceId,
            targetDeviceId: send.recipientDeviceId,
            messageId: send.messageId,
            outcome: "backpressured",
            refusal: null
          }) as Record<string, unknown>);
          return;
        }
        this.#deliver(recipient, send as unknown as Record<string, unknown>);
        this.#deliver(channel, createPeerForwarded({
          tenantId: channel.tenantId, routeId: channel.routeId,
          requestKind: "peer-send",
          sourceDeviceId: channel.deviceId, targetDeviceId: send.recipientDeviceId,
          messageId: send.messageId, outcome: "forwarded", refusal: null
        }) as Record<string, unknown>);
        return;
      }
      case "peer-delivery-ack": {
        const ack = parsePeerDeliveryAck(message);
        if (!ack || ack.tenantId !== channel.tenantId || ack.routeId !== channel.routeId
          || ack.recipientDeviceId !== channel.deviceId) return;
        this.deliveryAckAttempts.push(ack);
        const route = this.#routes.get(routeKey(channel.tenantId, channel.routeId));
        if (route?.pairs.get(channel.deviceId) !== ack.senderDeviceId) return;
        const refusal = this.#refuseAcks.get(ack.senderDeviceId);
        if (refusal && refusal.count > 0) {
          if (refusal.count === 1) this.#refuseAcks.delete(ack.senderDeviceId);
          else this.#refuseAcks.set(ack.senderDeviceId, { ...refusal, count: refusal.count - 1 });
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId,
            routeId: channel.routeId,
            requestKind: "peer-delivery-ack",
            sourceDeviceId: channel.deviceId,
            targetDeviceId: ack.senderDeviceId,
            messageId: ack.messageId,
            outcome: refusal.outcome,
            refusal: refusal.refusal
          }) as Record<string, unknown>);
          return;
        }
        const remaining = this.#dropAcks.get(ack.senderDeviceId) ?? 0;
        if (remaining > 0) {
          if (remaining === 1) this.#dropAcks.delete(ack.senderDeviceId);
          else this.#dropAcks.set(ack.senderDeviceId, remaining - 1);
          return;
        }
        const sender = this.#channels.get(channelKey(channel.tenantId, channel.routeId, ack.senderDeviceId));
        if (sender) {
          this.#deliver(sender, ack as unknown as Record<string, unknown>);
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId,
            routeId: channel.routeId,
            requestKind: "peer-delivery-ack",
            sourceDeviceId: channel.deviceId,
            targetDeviceId: ack.senderDeviceId,
            messageId: ack.messageId,
            outcome: "forwarded",
            refusal: null
          }) as Record<string, unknown>);
        } else {
          this.#deliver(channel, createPeerForwarded({
            tenantId: channel.tenantId,
            routeId: channel.routeId,
            requestKind: "peer-delivery-ack",
            sourceDeviceId: channel.deviceId,
            targetDeviceId: ack.senderDeviceId,
            messageId: ack.messageId,
            outcome: "endpoint_unreachable",
            refusal: null
          }) as Record<string, unknown>);
        }
        return;
      }
      default:
        return;
    }
  }

  #route(tenantId: string, routeId: string): FakeRoute {
    const key = routeKey(tenantId, routeId);
    let route = this.#routes.get(key);
    if (!route) {
      route = { tenantId, routeId, pairs: new Map() };
      this.#routes.set(key, route);
    }
    return route;
  }

  #publishPresence(route: FakeRoute): void {
    for (const channel of this.#channels.values()) {
      if (channel.tenantId !== route.tenantId || channel.routeId !== route.routeId) continue;
      const peerDeviceId = route.pairs.get(channel.deviceId);
      if (!peerDeviceId) continue;
      const peer = this.#channels.get(channelKey(route.tenantId, route.routeId, peerDeviceId));
      const presence: PeerPresence = createPeerPresence({
        tenantId: route.tenantId,
        routeId: route.routeId,
        deviceId: channel.deviceId,
        peerDeviceId,
        state: peer ? "reachable" : "unreachable",
        sessionId: peer?.sessionId ?? null
      });
      this.#deliver(channel, presence as unknown as Record<string, unknown>);
    }
  }

  #deliver(channel: FakeChannel, message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.isCurrent(channel)) channel.handler?.(message);
    });
  }
}

export class FakePeerTransport implements PeerClientTransport {
  readonly #relay: FakePeerRelay;
  readonly #channel: FakeChannel;

  constructor(relay: FakePeerRelay, channel: FakeChannel) {
    this.#relay = relay;
    this.#channel = channel;
  }

  async send(message: Record<string, unknown>): Promise<void> {
    await this.#relay.dispatch(this.#channel, message);
  }

  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.#channel.handler = handler;
  }
}
