import type { AuthenticatedContext, Subscription, SubscriptionEvent } from "@meshrix/contracts/gateway";
import { createId, digest } from "../utils.ts";

interface Listener {
  readonly id: string;
  readonly partition: string;
  readonly kinds: ReadonlySet<SubscriptionEvent["type"]>;
  readonly queue: Array<{ readonly event: SubscriptionEvent; readonly bytes: number }>;
  readonly waiters: ((result: IteratorResult<SubscriptionEvent>) => void)[];
  queuedBytes: number;
  closed: boolean;
}

export interface SubscriptionHubOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

function eventBytes(event: SubscriptionEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class SubscriptionHub {
  readonly #listeners = new Map<string, Listener>();
  readonly #maxEvents: number;
  readonly #maxBytes: number;

  constructor(options: SubscriptionHubOptions = {}) {
    this.#maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 64));
    this.#maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 1024 * 1024));
  }

  subscribe(context: AuthenticatedContext, kinds: readonly SubscriptionEvent["type"][] = []): Subscription {
    const listener: Listener = {
      id: createId("sub"),
      partition: digest({ tenant: context.tenant, principal: context.principal, grant: context.grant }),
      kinds: new Set(kinds),
      queue: [],
      waiters: [],
      queuedBytes: 0,
      closed: false
    };
    this.#listeners.set(listener.id, listener);
    const close = (): void => {
      if (listener.closed) return;
      listener.closed = true;
      this.#listeners.delete(listener.id);
      for (const waiter of listener.waiters.splice(0)) waiter({ done: true, value: undefined });
      listener.queue.length = 0;
      listener.queuedBytes = 0;
    };
    const events: AsyncIterable<SubscriptionEvent> = {
      [Symbol.asyncIterator]: (): AsyncIterator<SubscriptionEvent> => ({
        next: (): Promise<IteratorResult<SubscriptionEvent>> => {
          if (listener.queue.length > 0) {
            const entry = listener.queue.shift() as { readonly event: SubscriptionEvent; readonly bytes: number };
            listener.queuedBytes = Math.max(0, listener.queuedBytes - entry.bytes);
            return Promise.resolve({ done: false, value: entry.event });
          }
          if (listener.closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => listener.waiters.push(resolve));
        },
        return: async (): Promise<IteratorResult<SubscriptionEvent>> => { close(); return { done: true, value: undefined }; }
      })
    };
    return Object.freeze({ id: listener.id, events, close });
  }

  publish(context: AuthenticatedContext, event: SubscriptionEvent): void {
    const partition = digest({ tenant: context.tenant, principal: context.principal, grant: context.grant });
    const bytes = eventBytes(event);
    for (const listener of this.#listeners.values()) {
      if (listener.closed || listener.partition !== partition || listener.kinds.size > 0 && !listener.kinds.has(event.type)) continue;
      if (bytes > this.#maxBytes) {
        listener.closed = true;
        for (const pending of listener.waiters.splice(0)) pending({ done: true, value: undefined });
        this.#listeners.delete(listener.id);
        listener.queue.length = 0;
        listener.queuedBytes = 0;
        continue;
      }
      const waiter = listener.waiters.shift();
      if (waiter) { waiter({ done: false, value: event }); continue; }
      if (listener.queue.length >= this.#maxEvents || listener.queuedBytes + bytes > this.#maxBytes) {
        // A directory invalidation can be coalesced; state-bearing events are
        // never silently dropped and therefore close the slow subscriber.
        if (event.type.endsWith("list_changed")) {
          const existing = listener.queue.findIndex((queued) => queued.event.type === event.type);
          if (existing >= 0) {
            const previous = listener.queue[existing];
            listener.queue[existing] = { event, bytes };
            listener.queuedBytes = Math.max(0, listener.queuedBytes - previous.bytes + bytes);
            if (listener.queuedBytes > this.#maxBytes) {
              listener.closed = true;
              listener.queue.length = 0;
              listener.queuedBytes = 0;
              for (const pending of listener.waiters.splice(0)) pending({ done: true, value: undefined });
              this.#listeners.delete(listener.id);
            }
          } else if (listener.queue.length < this.#maxEvents && listener.queuedBytes + bytes <= this.#maxBytes) {
            listener.queue.push({ event, bytes });
            listener.queuedBytes += bytes;
          } else {
            listener.closed = true;
            listener.queue.length = 0;
            listener.queuedBytes = 0;
            for (const pending of listener.waiters.splice(0)) pending({ done: true, value: undefined });
            this.#listeners.delete(listener.id);
          }
        } else {
          listener.closed = true;
          listener.queue.length = 0;
          listener.queuedBytes = 0;
          for (const pending of listener.waiters.splice(0)) pending({ done: true, value: undefined });
          this.#listeners.delete(listener.id);
        }
        continue;
      }
      listener.queue.push({ event, bytes });
      listener.queuedBytes += bytes;
    }
  }

  close(): void {
    for (const listener of [...this.#listeners.values()]) {
      listener.closed = true;
      for (const waiter of listener.waiters.splice(0)) waiter({ done: true, value: undefined });
      listener.queue.length = 0;
      listener.queuedBytes = 0;
    }
    this.#listeners.clear();
  }
}

export function createSubscriptionHub(options: SubscriptionHubOptions = {}): SubscriptionHub {
  return new SubscriptionHub(options);
}
