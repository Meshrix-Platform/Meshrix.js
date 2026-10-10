/**
 * Renderer-side bridge — re-pointed from the Electron contextBridge onto the
 * loopback API the Node sidecar service exposes (`shared/loopback-client.ts`).
 *
 * Configuration resolution order:
 *   1. The packaged app: `window.__TAURI__.core.invoke("meshrix_bridge_config")`
 *      returns `{port, token}` minted by the Rust shell for this launch;
 *   2. Dev/test injection: `window.__MESHRIX_ENTRY_BRIDGE__ = {baseUrl, token}`;
 *   3. The vite dev server env: `VITE_ENTRY_SERVICE_URL` + `VITE_ENTRY_SERVICE_TOKEN`.
 *
 * The bearer token is held in this module's memory only — it never appears in
 * a URL, log or the window title; requests carry it in `Authorization`.
 */
import type { GuiState } from "../shared/gui-state.ts";
import type { GuiIpcResult, GuiOp } from "../shared/ipc-contract.ts";
import {
  guiBridgeConfig,
  GuiLoopbackClient,
  type GuiBridgeConfig
} from "../shared/loopback-client.ts";

declare global {
  interface Window {
    /** Injected by the Tauri shell (`withGlobalTauri`) in the packaged app. */
    __TAURI__?: {
      core?: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
    };
    /** Manual dev/test hook — set before the renderer bundle loads. */
    __MESHRIX_ENTRY_BRIDGE__?: GuiBridgeConfig;
  }
}

let clientPromise: Promise<GuiLoopbackClient | null> | null = null;

/**
 * State subscriptions registered while the bridge is unresolved — re-attached
 * the next time `client()` resolves to a real transport, so a slow sidecar
 * cold-start cannot strand the store on a dead subscription.
 */
const pendingSubscribers = new Set<(state: GuiState) => void>();
const liveSubscriptions = new Map<(state: GuiState) => void, () => void>();

function envBridgeConfig(): GuiBridgeConfig | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_ENTRY_SERVICE_URL;
  const token = env?.VITE_ENTRY_SERVICE_TOKEN;
  return url && token ? { baseUrl: url, token } : null;
}

async function resolveBridgeConfig(): Promise<GuiBridgeConfig | null> {
  if (typeof window === "undefined") return null;
  if (window.__MESHRIX_ENTRY_BRIDGE__) return window.__MESHRIX_ENTRY_BRIDGE__;
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (typeof tauriInvoke === "function") {
    try {
      const config = await tauriInvoke.call(window.__TAURI__!.core, "meshrix_bridge_config");
      const parsed = config as { port?: unknown; token?: unknown } | null;
      if (parsed && typeof parsed.port === "number" && typeof parsed.token === "string") {
        return guiBridgeConfig({ port: parsed.port, token: parsed.token });
      }
    } catch {
      // The command exists only inside the shell; fall through to env config.
    }
  }
  return envBridgeConfig();
}

function client(): Promise<GuiLoopbackClient | null> {
  clientPromise ??= resolveBridgeConfig()
    .then(
      (config) => (config ? new GuiLoopbackClient(config) : null),
      () => null
    )
    .then((resolved) => {
      // A sidecar slower than the command's wait window (or a transient spawn
      // failure) must not disable the bridge for the session — clear the
      // memoized failure so the next invoke/onState asks again. Only a real
      // config is cached.
      if (resolved === null) {
        clientPromise = null;
        return null;
      }
      for (const subscriber of [...pendingSubscribers]) {
        pendingSubscribers.delete(subscriber);
        liveSubscriptions.set(subscriber, resolved.subscribeState(subscriber));
      }
      return resolved;
    });
  return clientPromise;
}

/**
 * Whether a bridge source is configured. A true result means the transport is
 * plausible, not that the service is reachable — `invoke` reports reachability
 * honestly through its result channel.
 */
export function bridgeAvailable(): boolean {
  return typeof window !== "undefined"
    && (typeof window.__TAURI__?.core?.invoke === "function"
      || window.__MESHRIX_ENTRY_BRIDGE__ !== undefined
      || envBridgeConfig() !== null);
}

export async function invoke<T = unknown>(op: GuiOp, args?: unknown): Promise<GuiIpcResult<T>> {
  const resolved = await client();
  if (!resolved) {
    return { ok: false, error: { code: "bridge_unavailable", message: "The trusted bridge is not configured; run inside the packaged app or provide VITE_ENTRY_SERVICE_URL/TOKEN." } };
  }
  return resolved.invoke<T>(op, args);
}

export function onState(callback: (state: GuiState) => void): () => void {
  let closed = false;
  void client().then((resolved) => {
    if (closed) return;
    if (!resolved) {
      // Park until a later resolution attaches it (see `client()` above).
      pendingSubscribers.add(callback);
      return;
    }
    liveSubscriptions.set(callback, resolved.subscribeState(callback));
  });
  return () => {
    closed = true;
    pendingSubscribers.delete(callback);
    liveSubscriptions.get(callback)?.();
    liveSubscriptions.delete(callback);
  };
}
