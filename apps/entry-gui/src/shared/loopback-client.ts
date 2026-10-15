/**
 * Loopback API client — the renderer-side (and test-side) transport for the
 * installed entry product. Talks to the Node backend service over
 * `http://127.0.0.1:<ephemeral>` with the canonical profile owner's bearer token.
 *
 * The token travels ONLY in the `Authorization` header — never in a URL
 * (so it cannot land in access logs, browser history or error reports) and
 * never in the window title. Invoke bodies may carry deliberate secrets
 * (`recovery.importText`), so request bodies are never logged either.
 *
 * Runs anywhere `fetch` exists: inside the Tauri webview, under the vite dev
 * server, and in the Node vitest environment (Node >= 22 provides fetch).
 */
import {
  GUI_API_INVOKE_ROUTE,
  GUI_API_STATE_ROUTE,
  type GuiIpcEnvelope,
  type GuiIpcResult,
  type GuiOp,
  type GuiStatePollRequest,
  type GuiStatePush
} from "./ipc-contract.ts";
import type { GuiState } from "./gui-state.ts";

export interface GuiBridgeConfig {
  /** `http://127.0.0.1:<port>` — loopback origin only, no trailing slash. */
  readonly baseUrl: string;
  /** Current profile-owner token delivered over the private native bridge. */
  readonly token: string;
}

export function guiBridgeConfig(input: { readonly port: number; readonly token: string }): GuiBridgeConfig {
  return { baseUrl: `http://127.0.0.1:${input.port}`, token: input.token };
}

function transportError(code: string, message: string): GuiIpcResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Typed client for the closed op set. `invoke` never throws — transport
 * failures fold into the `GuiIpcResult` error channel so the store handles
 * them uniformly with product errors.
 */
export class GuiLoopbackClient {
  readonly #config: GuiBridgeConfig;

  constructor(config: GuiBridgeConfig) {
    this.#config = config;
  }

  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  async invoke<T = unknown>(op: GuiOp, args?: unknown, signal?: AbortSignal): Promise<GuiIpcResult<T>> {
    const envelope: GuiIpcEnvelope = { op, ...(args === undefined ? {} : { args }) };
    let response: Response;
    try {
      response = await fetch(`${this.#config.baseUrl}${GUI_API_INVOKE_ROUTE}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(envelope),
        signal: signal ?? null
      });
    } catch (error) {
      return transportError("transport_unreachable", `The entry service could not be reached (${(error as Error).message}).`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return transportError("transport_protocol_error", `The entry service answered HTTP ${response.status} with a non-JSON body.`);
    }
    const result = body as GuiIpcResult<T> | null;
    if (!result || typeof result.ok !== "boolean") {
      return transportError("transport_protocol_error", `The entry service answered HTTP ${response.status} with a malformed result.`);
    }
    return result;
  }

  /**
   * Server-held long-poll: each request waits until the service publishes a
   * snapshot newer than `after` (or the server-side poll window lapses and
   * returns the latest). The loop reconnects with a short backoff on transport
   * failure — a restarting service is not a rendered error.
   */
  subscribeState(
    callback: (state: GuiState) => void,
    options: { readonly retryDelayMs?: number; readonly onError?: (message: string) => void } = {}
  ): () => void {
    const retryDelayMs = Math.max(50, options.retryDelayMs ?? 750);
    const abort = new AbortController();
    let lastSeq = 0;
    void (async () => {
      while (!abort.signal.aborted) {
        const request: GuiStatePollRequest = { after: lastSeq };
        let response: Response;
        try {
          response = await fetch(`${this.#config.baseUrl}${GUI_API_STATE_ROUTE}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#config.token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(request),
            signal: abort.signal
          });
        } catch {
          if (abort.signal.aborted) return;
          options.onError?.("entry service unreachable; retrying");
          await delay(retryDelayMs, abort.signal);
          continue;
        }
        if (!response.ok) {
          options.onError?.(`state channel answered HTTP ${response.status}; retrying`);
          await delay(retryDelayMs, abort.signal);
          continue;
        }
        let push: GuiStatePush<GuiState>;
        try {
          push = (await response.json()) as GuiStatePush<GuiState>;
        } catch {
          await delay(retryDelayMs, abort.signal);
          continue;
        }
        if (push && typeof push.seq === "number" && push.state) {
          lastSeq = push.seq;
          callback(push.state);
        }
      }
    })().catch(() => undefined);
    return () => abort.abort();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
