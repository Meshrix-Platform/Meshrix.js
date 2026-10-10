/**
 * Loopback API server — the trusted backend's only window-facing surface.
 *
 * Bound exclusively to `127.0.0.1` on an ephemeral port. Every request
 * carries `Authorization: Bearer <per-launch token>`; the token is compared
 * via SHA-256 + timingSafeEqual and appears in no URL, log line or title.
 * The token is minted by the Tauri shell per launch, handed to this service
 * through env (`MESHRIX_ENTRY_SERVICE_TOKEN`) and to the webview through the
 * `meshrix_bridge_config` Tauri command — the two never meet except here.
 *
 * Routes (the closed op set lives in `shared/ipc-contract.ts`):
 *   POST /meshrix-entry        {op,args} → GuiIpcResult    (invoke)
 *   POST /meshrix-entry:state  {after}   → GuiStatePush    (long-poll)
 *
 * CORS is a browser-preflight courtesy, not the security boundary: only the
 * Tauri webview origins and loopback dev origins are echoed back, and every
 * route still demands the bearer token. `Access-Control-Allow-Private-
 * Network` answers Chrome-style private-network preflights for the same
 * narrow origin set.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { GuiState } from "../shared/gui-state.ts";
import {
  GUI_API_INVOKE_ROUTE,
  GUI_API_STATE_ROUTE,
  isGuiOp,
  type GuiIpcEnvelope,
  type GuiIpcResult,
  type GuiStatePollRequest,
  type GuiStatePush
} from "../shared/ipc-contract.ts";

/** The surface the server needs — implemented by `EntryProductService`. */
export interface EntryGuiServiceApi {
  dispatch(op: GuiIpcEnvelope["op"], args?: unknown): Promise<GuiIpcResult<unknown>>;
  subscribe(listener: (state: GuiState) => void): () => void;
  snapshot(): GuiState;
}

export interface EntryGuiLoopbackServerOptions {
  readonly service: EntryGuiServiceApi;
  /** Per-launch bearer token — required, non-empty. */
  readonly token: string;
  /** Loopback only; anything else is refused at construction. */
  readonly host?: string;
  /** `0` (default) picks an ephemeral port, reported via `port`/`origin` after listen(). */
  readonly port?: number;
  /** How long a state poll stays open waiting for a newer snapshot. */
  readonly pollTimeoutMs?: number;
  /** Upper bound on request bodies — envelopes are small; secrets ride here, not URLs. */
  readonly maxBodyBytes?: number;
}

export interface EntryGuiLoopbackServer {
  /** Actual bound port — meaningful only after `listen()` resolves. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` once listening. */
  readonly origin: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const MAX_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Origins allowed to receive CORS preflights — Tauri webviews + loopback dev servers. */
const ALLOWED_ORIGIN = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost(?::\d+)?|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)$/u;

export function createEntryGuiLoopbackServer(options: EntryGuiLoopbackServerOptions): EntryGuiLoopbackServer {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to bind the entry GUI API to non-loopback host "${host}".`);
  }
  if (typeof options.token !== "string" || options.token.length < 16) {
    throw new Error("The entry GUI API requires a per-launch bearer token (>= 16 chars).");
  }
  const expectedAuth = `Bearer ${options.token}`;
  const expectedAuthHash = createHash("sha256").update(expectedAuth).digest();
  const pollTimeoutMs = Math.min(Math.max(1_000, options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS), MAX_POLL_TIMEOUT_MS);
  const maxBodyBytes = Math.max(1_024, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

  // The snapshot captured at construction counts as seq 1, so a first poll
  // with `after: 0` (a renderer that just loaded) answers immediately instead
  // of blocking for a fresh emission that may never come.
  let latestSeq = 1;
  let latestState: GuiState = options.service.snapshot();
  const waiters = new Set<{ after: number; resolve: (push: GuiStatePush<GuiState>) => void; timer: NodeJS.Timeout }>();

  const unsubscribe = options.service.subscribe((state) => {
    latestSeq += 1;
    latestState = state;
    const push: GuiStatePush<GuiState> = { seq: latestSeq, state };
    for (const waiter of [...waiters]) {
      if (latestSeq > waiter.after) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(push);
      }
    }
  });

  function authenticated(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const provided = createHash("sha256").update(header).digest();
    return timingSafeEqual(provided, expectedAuthHash);
  }

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin === "string" && ALLOWED_ORIGIN.test(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-private-network", "true");
    res.setHeader("access-control-max-age", "600");
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBodyBytes) {
          reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("request body is not valid JSON"), { statusCode: 400 }));
        }
      });
      req.on("error", reject);
      req.on("aborted", () => reject(Object.assign(new Error("request aborted"), { statusCode: 400 })));
    });
  }

  async function handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, (error as { statusCode?: number }).statusCode ?? 400, {
        ok: false,
        error: { code: "transport_request_invalid", message: (error as Error).message }
      } satisfies GuiIpcResult);
      return;
    }
    const envelope = body as GuiIpcEnvelope | null;
    if (!envelope || typeof envelope !== "object" || !isGuiOp(envelope.op)) {
      sendJson(res, 200, {
        ok: false,
        error: { code: "ipc_op_denied", message: "Unknown or malformed GUI operation." }
      } satisfies GuiIpcResult);
      return;
    }
    sendJson(res, 200, await options.service.dispatch(envelope.op, envelope.args));
  }

  async function handleStatePoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, (error as { statusCode?: number }).statusCode ?? 400, {
        ok: false,
        error: { code: "transport_request_invalid", message: (error as Error).message }
      } satisfies GuiIpcResult);
      return;
    }
    const after = Math.max(0, Number((body as GuiStatePollRequest | undefined)?.after ?? 0)) || 0;
    if (latestSeq > after) {
      sendJson(res, 200, { seq: latestSeq, state: latestState } satisfies GuiStatePush<GuiState>);
      return;
    }
    const push = await new Promise<GuiStatePush<GuiState>>((resolve) => {
      const waiter = {
        after,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          resolve({ seq: latestSeq, state: latestState });
        }, pollTimeoutMs)
      };
      waiters.add(waiter);
      req.once("close", () => {
        if (waiters.delete(waiter)) {
          clearTimeout(waiter.timer);
          resolve({ seq: latestSeq, state: latestState });
        }
      });
    });
    sendJson(res, 200, push);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!authenticated(req)) {
        sendJson(res, 401, { ok: false, error: { code: "transport_unauthorized", message: "Missing or invalid bearer token." } });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: { code: "transport_method_invalid", message: "POST only." } });
        return;
      }
      const route = (req.url ?? "").split("?")[0];
      if (route === GUI_API_INVOKE_ROUTE) {
        await handleInvoke(req, res);
        return;
      }
      if (route === GUI_API_STATE_ROUTE) {
        await handleStatePoll(req, res);
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: "transport_route_unknown", message: "Unknown route." } });
    })().catch((error: unknown) => {
      // Last-resort guard: a handler defect must not hang the renderer.
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: "transport_internal", message: "The entry service failed while answering." } });
      } else if (!res.writableEnded) {
        res.end();
      }
      void error;
    });
  });

  let boundPort = 0;
  return {
    get port() {
      return boundPort;
    },
    get origin() {
      return `http://${host}:${boundPort}`;
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      boundPort = (server.address() as AddressInfo).port;
    },
    async close() {
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({ seq: latestSeq, state: latestState });
      }
      unsubscribe();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
