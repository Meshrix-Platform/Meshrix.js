export interface ServiceEvent {
  readonly type: string;
  readonly revision: string;
  readonly payload?: unknown;
}

export interface ServiceEventPort {
  publish(event: ServiceEvent): void | Promise<void>;
  subscribe(listener: (event: ServiceEvent) => void | Promise<void>): () => void;
}

export function createServiceEventPort(): ServiceEventPort {
  const listeners = new Set<(event: ServiceEvent) => void | Promise<void>>();
  return Object.freeze({
    publish(event: ServiceEvent): void {
      for (const listener of listeners) void listener(event);
    },
    subscribe(listener: (event: ServiceEvent) => void | Promise<void>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

/** Maps optional service-owned events to the gateway's generic event port. */
export function createServiceEventAdapter(input: { readonly source: ServiceEventPort; readonly onEvent: (event: ServiceEvent) => void | Promise<void> }): () => void {
  return input.source.subscribe((event) => input.onEvent(event));
}
