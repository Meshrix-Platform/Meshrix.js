import type {
  PeerApplicationAddress,
  PeerApplicationInbound,
  PeerApplicationPeerPort,
  PeerApplicationRouteAuthority,
  PeerApplicationSendState
} from "@meshrix/peer-client";
import type { PeerClient, PeerDispatchHandler, PeerInboundOutcome } from "@meshrix/peer-client";

export interface ApplicationPeerRouteBinding {
  readonly tenantId: string;
  readonly routeId: string;
  readonly localDeviceId: string;
  readonly client: PeerClient;
  allowsPeer(peerDeviceId: string): boolean | Promise<boolean>;
  /** Distinguishes a revoked binding from temporary authority unavailability. */
  resolvePeerAuthority?(peerDeviceId: string): Promise<"current" | "unavailable" | "revoked">;
  isReachable(peerDeviceId: string): boolean | Promise<boolean>;
  subscribe(handler: PeerDispatchHandler): () => void;
}

export type ApplicationPeerAuthorityResolver = (
  address: PeerApplicationAddress
) => Promise<PeerApplicationRouteAuthority>;

interface RegisteredRoute {
  readonly binding: ApplicationPeerRouteBinding;
  readonly unsubscribe: () => void;
}

function routeKey(address: Pick<PeerApplicationAddress, "tenantId" | "routeId" | "localDeviceId">): string {
  return JSON.stringify([address.tenantId, address.routeId, address.localDeviceId]);
}

function addressMatches(left: PeerApplicationAddress, right: PeerApplicationAddress): boolean {
  return left.tenantId === right.tenantId
    && left.routeId === right.routeId
    && left.localDeviceId === right.localDeviceId
    && left.peerDeviceId === right.peerDeviceId;
}

/**
 * One profile-level Peer application port over the exact, enrolled PeerClient
 * routes. It never searches by peer id or falls back to another route.
 */
export class EntryApplicationPeerRouter implements PeerApplicationPeerPort {
  readonly #routes = new Map<string, RegisteredRoute>();
  readonly #inbound = new Set<(delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>>();
  readonly #authorityResolver: ApplicationPeerAuthorityResolver | undefined;
  readonly #authorityObservers = new Map<string, {
    readonly address: PeerApplicationAddress;
    delayMs: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  readonly #authorityListeners = new Set<(address: PeerApplicationAddress, state: PeerApplicationRouteAuthority) => void>();
  #disposed = false;

  constructor(options: { readonly resolvePeerAuthority?: ApplicationPeerAuthorityResolver } = {}) {
    this.#authorityResolver = options.resolvePeerAuthority;
  }

  register(binding: ApplicationPeerRouteBinding): () => void {
    const key = routeKey(binding);
    const current = this.#routes.get(key);
    if (current) {
      if (current.binding.client === binding.client) return () => this.unregister(binding);
      throw new Error("A different PeerClient already owns this exact local route.");
    }
    const unsubscribe = binding.subscribe((message) => this.#dispatch(binding, message));
    this.#routes.set(key, { binding, unsubscribe });
    return () => this.unregister(binding);
  }

  unregister(binding: ApplicationPeerRouteBinding): void {
    const key = routeKey(binding);
    const current = this.#routes.get(key);
    if (current?.binding !== binding) return;
    current.unsubscribe();
    this.#routes.delete(key);
  }

  onInboundMessage(handler: (delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>): () => void {
    this.#inbound.add(handler);
    return () => this.#inbound.delete(handler);
  }

  async isPeerReachable(address: PeerApplicationAddress): Promise<boolean> {
    const binding = this.#resolve(address);
    return Boolean(binding && await binding.allowsPeer(address.peerDeviceId)
      && await binding.isReachable(address.peerDeviceId));
  }

  async resolvePeerAuthority(address: PeerApplicationAddress): Promise<"current" | "unavailable" | "revoked"> {
    const state = await this.#queryPeerAuthority(address);
    if (state === "unavailable") this.#observeAuthority(address);
    else this.#settleAuthority(address, state);
    return state;
  }

  onAuthorityResolved(handler: (address: PeerApplicationAddress, state: PeerApplicationRouteAuthority) => void): () => void {
    this.#authorityListeners.add(handler);
    return () => this.#authorityListeners.delete(handler);
  }

  clearAuthorityObservation(address: PeerApplicationAddress): void {
    const key = JSON.stringify(address);
    const observation = this.#authorityObservers.get(key);
    if (!observation) return;
    if (observation.timer) clearTimeout(observation.timer);
    this.#authorityObservers.delete(key);
  }

  dispose(): void {
    this.#disposed = true;
    for (const observation of this.#authorityObservers.values()) {
      if (observation.timer) clearTimeout(observation.timer);
    }
    this.#authorityObservers.clear();
    this.#authorityListeners.clear();
  }

  async #queryPeerAuthority(address: PeerApplicationAddress): Promise<PeerApplicationRouteAuthority> {
    try {
      if (this.#authorityResolver) return await this.#authorityResolver(address);
      const binding = this.#resolve(address);
      if (binding?.resolvePeerAuthority) return await binding.resolvePeerAuthority(address.peerDeviceId);
      if (binding) return await binding.allowsPeer(address.peerDeviceId) ? "current" : "revoked";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  #observeAuthority(address: PeerApplicationAddress): void {
    if (this.#disposed) return;
    const key = JSON.stringify(address);
    if (this.#authorityObservers.has(key)) return;
    const observation = { address: Object.freeze({ ...address }), delayMs: 1_000, timer: null as ReturnType<typeof setTimeout> | null };
    this.#authorityObservers.set(key, observation);
    const check = async () => {
      if (this.#disposed || this.#authorityObservers.get(key) !== observation) return;
      observation.timer = null;
      const state = await this.#queryPeerAuthority(address);
      if (this.#disposed || this.#authorityObservers.get(key) !== observation) return;
      if (state === "unavailable") {
        observation.delayMs = Math.min(observation.delayMs * 2, 30_000);
        observation.timer = setTimeout(() => { void check(); }, observation.delayMs);
        return;
      }
      this.#settleAuthority(address, state);
    };
    observation.timer = setTimeout(() => { void check(); }, observation.delayMs);
  }

  #settleAuthority(address: PeerApplicationAddress, state: PeerApplicationRouteAuthority): void {
    const key = JSON.stringify(address);
    const observation = this.#authorityObservers.get(key);
    if (!observation) return;
    if (observation.timer) clearTimeout(observation.timer);
    this.#authorityObservers.delete(key);
    for (const handler of this.#authorityListeners) handler(observation.address, state);
  }

  async sendMessage(address: PeerApplicationAddress, plaintext: Uint8Array, options: { readonly messageId: string }) {
    const binding = this.#resolve(address);
    if (!binding || !await binding.allowsPeer(address.peerDeviceId)) {
      throw Object.assign(new Error("The exact paired route is no longer available."), { code: "peer_route_unavailable" });
    }
    return binding.client.sendMessage(address.peerDeviceId, plaintext, options);
  }

  async getSendState(address: PeerApplicationAddress, messageId: string): Promise<PeerApplicationSendState | null> {
    const binding = this.#resolve(address);
    if (!binding || !await binding.allowsPeer(address.peerDeviceId)) return null;
    const entry = await binding.client.outbox.entry(messageId, address.peerDeviceId);
    return entry?.recipientDeviceId === address.peerDeviceId ? entry.state : null;
  }

  async retryPendingInbound(address: PeerApplicationAddress): Promise<void> {
    const binding = this.#resolve(address);
    if (!binding) return;
    await binding.client.retryPendingDispatch();
  }

  #resolve(address: PeerApplicationAddress): ApplicationPeerRouteBinding | null {
    const binding = this.#routes.get(routeKey(address))?.binding;
    if (!binding) return null;
    return binding.tenantId === address.tenantId
      && binding.routeId === address.routeId
      && binding.localDeviceId === address.localDeviceId
      ? binding
      : null;
  }

  async #dispatch(binding: ApplicationPeerRouteBinding, message: Parameters<PeerDispatchHandler>[0]): Promise<PeerInboundOutcome> {
    const address: PeerApplicationAddress = Object.freeze({
      tenantId: binding.tenantId,
      routeId: binding.routeId,
      localDeviceId: binding.localDeviceId,
      peerDeviceId: message.senderDeviceId
    });
    if (!await binding.allowsPeer(address.peerDeviceId)) return { kind: "rejected" };
    const delivery = Object.freeze({ address, message });
    for (const handler of this.#inbound) return await handler(delivery);
    return { kind: "deferred" };
  }
}

export function sameApplicationAddress(left: PeerApplicationAddress, right: PeerApplicationAddress): boolean {
  return addressMatches(left, right);
}
